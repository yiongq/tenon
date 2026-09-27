/**
 * Large results written to disk (spec 02 §大响应落盘, §本地持久化布局：只加一行; plan step 24: 旧 57,
 * 旧 188, 02 不变量 34). Real Runs on the memory host: the one check before `tool/result` is written,
 * whatever the tool and whether it failed — the real Grep, a connector's failure, a WebFetch stand-in,
 * the real Bash on a fake child — then what the model is sent afterwards, and the chat profile's Read
 * of the file.
 *
 * WebFetch has no executor until plan step 27, and the test registry's fake one only echoes its
 * input, which the Tape already holds in `tool/call`. So a connector tool, `web__fetch`, stands in:
 * it returns a page the way a fetch would — text, an image, more text — and its result reaches the
 * same check through the same `execute()` as every executed call's.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type {
  AbsolutePath,
  ChildHandle,
  HostFs,
  HostProcess,
  McpConnection,
  McpToolSource,
  MemoryHost,
  ModelInfo,
  PermissionDecidedPayload,
  SessionService,
  StreamEvent,
  TapeEntry,
  TapeStore,
  ToolResultPayload,
  Usage,
} from '../../src/index.js'
import {
  SPILL_PREVIEW_CHARS,
  SPILL_THRESHOLD_CHARS,
  spillFileName,
  spillPreview,
} from '../../src/loop/spill.js'
import { STOP_EXIT_CONFIRM_MS, STOP_TERM_GRACE_MS } from '../../src/loop/limits.js'
import { MODEL_NOTES, fill } from '../../src/prompts/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type { ScriptedProvider, TestLoopPorts } from '../../src/testing/index.js'
import { proxyStore } from './support.js'

const PROFILE = '/tenon/profiles/spill-user/spill-tenant'
const IDENTITY = { userId: 'spill-user', tenantId: 'spill-tenant', profileDir: PROFILE }
const SESSION = '5b1f0c3e-7a2d-4e8f-9c6b-1d2e3f4a5b61'
const OTHER = '5b1f0c3e-7a2d-4e8f-9c6b-1d2e3f4a5b62'
const OUTPUT_ROOT = `${PROFILE}/tool-output`
const DIR = `${OUTPUT_ROOT}/${SESSION}`
const WORK = absolutePath('/work/spill')
const DEDICATED = absolutePath(`/home/u/Tenon/workspaces/spill-user/spill-tenant/${SESSION}`)

const MODEL: ModelInfo = {
  id: 'claude-spill-1',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: true,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}

const USAGE: Usage = {
  inputTokens: 5,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

const IMAGE = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' } as const
const IMAGE_BLOCK = { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' } as const

/**
 * A text of `chars` characters in lines, with `mark` at its very end — past any preview. Each line
 * ends in a character UTF-8 writes in three bytes, so the byte count is not the character count.
 */
function longText(chars: number, mark: string): string {
  const line = `${'x'.repeat(58)}中\n`
  const body = line.repeat(Math.ceil(chars / line.length)).slice(0, chars - mark.length)
  return `${body}${mark}`
}

/** What a connector call returns: its blocks, as the SDK gives them, and whether it failed. */
interface Returned {
  readonly content: readonly unknown[]
  readonly isError?: boolean
}

/** A connector with one tool, answering each call with the next of `queue`. */
function connector(serverId: string, tool: string, queue: Returned[]): McpToolSource {
  const connection = {
    listTools: () => Promise.resolve([{ name: tool, inputSchema: { type: 'object' } }]),
    callTool: () => {
      const next = queue.shift()
      if (next === undefined) throw new Error(`${serverId}__${tool}: nothing queued`)
      return Promise.resolve({ content: [...next.content], isError: next.isError === true })
    },
  } as unknown as McpConnection
  return { serverId, connection }
}

/** Bash's child: prints `output` and exits 0. */
function printing(output: string): HostProcess {
  return {
    spawn: () => {
      const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>()
      const child: ChildHandle = {
        pid: 9,
        stdin: new WritableStream(),
        stdout: new ReadableStream({
          start: (controller) => {
            controller.enqueue(new TextEncoder().encode(output))
            controller.close()
            exited.resolve({ code: 0, signal: null })
          },
        }),
        stderr: new ReadableStream({ start: (controller) => controller.close() }),
        exited: exited.promise,
        kill: () => Promise.resolve(),
      }
      return Promise.resolve(child)
    },
  }
}

/**
 * Bash's child for a stop: prints `output` and keeps its pipe open until it is signalled, then exits
 * on the first signal. `spawned` resolves once it runs.
 */
function holding(output: string, spawned: PromiseWithResolvers<void>): HostProcess {
  return {
    spawn: () => {
      const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>()
      let out: ReadableStreamDefaultController<Uint8Array> | undefined
      let gone = false
      const child: ChildHandle = {
        pid: 10,
        stdin: new WritableStream(),
        stdout: new ReadableStream({
          start: (controller) => {
            out = controller
            controller.enqueue(new TextEncoder().encode(output))
          },
        }),
        stderr: new ReadableStream({ start: (controller) => controller.close() }),
        exited: exited.promise,
        kill: (signal = 'SIGTERM') => {
          if (!gone) {
            gone = true
            out?.close()
            exited.resolve({ code: null, signal })
          }
          return Promise.resolve()
        },
      }
      spawned.resolve()
      return Promise.resolve(child)
    },
  }
}

/** The memory host's fs, except that nothing can be written under `tool-output/` (a full disk). */
function refusingSpills(fs: HostFs): HostFs {
  return {
    readFile: (path, opts) => fs.readFile(path, opts),
    writeFile: (path, data) =>
      path.startsWith(`${OUTPUT_ROOT}/`)
        ? Promise.reject(new Error(`ENOSPC: no space left on device, open '${path}'`))
        : fs.writeFile(path, data),
    stat: (path) => fs.stat(path),
    readdir: (path) => fs.readdir(path),
    mkdirp: (path) => fs.mkdirp(path),
    realpath: (path) => fs.realpath(path),
  }
}

interface Harness {
  readonly memory: MemoryHost
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
  /** What `fx__emit` returns, call by call. */
  readonly emits: Returned[]
  /** What `web__fetch` returns, call by call. */
  readonly pages: Returned[]
  readonly logs: string[]
}

async function harness(
  o: {
    readonly profile?: 'chat' | 'cowork'
    readonly refuseSpills?: boolean
    readonly process?: HostProcess
    /** A restart: the same disk and Tape, a new service with ids that do not repeat. */
    readonly after?: Harness
    /** Runs before each batch the loop appends reaches the store. */
    readonly beforeAppend?: (batch: Parameters<TapeStore['append']>[0], memory: MemoryHost) => void
  } = {},
): Promise<Harness> {
  const memory =
    o.after?.memory ??
    createMemoryHost({
      identity: IDENTITY,
      ...(o.process === undefined ? {} : { process: o.process }),
    })
  const store = o.after?.store ?? createMemoryTapeStore({ identity: IDENTITY })
  const provider = createScriptedProvider({ models: [MODEL] })
  const emits: Returned[] = []
  const pages: Returned[] = []
  const loop = createTestLoopPorts({
    connector: {
      provider,
      model: MODEL,
      mcpSources: [connector('fx', 'emit', emits), connector('web', 'fetch', pages)],
    },
  })
  const logs: string[] = []
  const { beforeAppend } = o
  const service = createTestSessionService(
    {
      host: o.refuseSpills === true ? { ...memory, fs: refusingSpills(memory.fs) } : memory,
      tape:
        beforeAppend === undefined
          ? store
          : proxyStore(store, {
              append: (batch) => {
                beforeAppend(batch, memory)
                return store.append(batch)
              },
            }),
      ids: createCounterIds({ start: o.after === undefined ? 1 : 500 }),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
      log: (line) => logs.push(line),
    },
    {
      tools: { Read: 'real', Grep: 'real', Bash: 'real' },
      // Connector tools run without a card: the cases are about their results.
      userSetting: () => ({ userSetting: 'always-allow' }),
    },
  )
  service.bindLoop(loop)
  if (o.profile === 'cowork') {
    await memory.fs.mkdirp(WORK)
    await service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: DEDICATED })
    await service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [WORK] },
      dedicated: DEDICATED,
    })
  }
  return { memory, store, service, loop, provider, emits, pages, logs }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

type Call = readonly [name: string, input: Record<string, unknown>]

let nextCall = 1

function reply(...calls: readonly Call[]): StreamEvent[] {
  return [
    ...calls.flatMap(([name, input], k): StreamEvent[] => {
      const id = `toolu_${String(nextCall++)}`
      return [
        { type: 'tool-call-start', index: k + 1, id, name },
        { type: 'tool-call-end', index: k + 1, id, name, input },
      ]
    }),
    { type: 'usage', usage: USAGE },
    stopEvent('tool-use', 'tool_use'),
  ]
}

/** One message whose reply makes the calls, then a text reply: the Run completes. */
async function runOnce(h: Harness, text: string, ...calls: readonly Call[]): Promise<void> {
  if (calls.length > 0) h.provider.script(reply(...calls))
  h.provider.script(scriptedTurn({ deltas: ['Done.'], usage: USAGE }))
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  expect((await h.loop.runEnded({ runId: sent.runId })).reason).toEqual({ code: 'completed' })
}

async function entries(h: Harness): Promise<TapeEntry[]> {
  return (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}

/** The results, in Tape order. */
async function results(h: Harness): Promise<ToolResultPayload[]> {
  return (await entries(h))
    .filter((entry) => entry.name === 'tool/result')
    .map((entry) => entry.payload as unknown as ToolResultPayload)
}

/** The last result, and the `(runId, requestSeq)` it is keyed under. */
async function lastResult(
  h: Harness,
): Promise<ToolResultPayload & { readonly runId: string; readonly requestSeq: number }> {
  const found = (await entries(h)).findLast((entry) => entry.name === 'tool/result')
  if (found === undefined) throw new Error('no tool/result')
  return Object.freeze({
    ...(found.payload as unknown as ToolResultPayload),
    runId: String(found.sourceId),
    requestSeq: Number(found.sourceSeq),
  })
}

/** The last call's outcome. */
async function lastOutcome(h: Harness): Promise<Record<string, unknown> | undefined> {
  return (await entries(h)).findLast((entry) => entry.name === 'execution/tool_outcome')?.payload
}

/** The names of the slots a note has, sorted. */
function slotsOf(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1] ?? '').toSorted()
}

/** What every tool_result block of one request carries, in order. */
function sentResults(provider: ScriptedProvider, at: number): unknown[] {
  const body = provider.requests.at(at)?.body as {
    messages: { content: string | { type: string; content?: unknown }[] }[]
  }
  return body.messages
    .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
    .filter((block) => block.type === 'tool_result')
    .map((block) => block.content)
}

/** Every string anywhere in any payload (and meta) of the session's Tape. */
async function payloadStrings(h: Harness): Promise<string[]> {
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) for (const item of value) walk(item)
    else if (typeof value === 'object' && value !== null)
      for (const item of Object.values(value)) walk(item)
  }
  for (const entry of await entries(h)) {
    walk(entry.payload)
    walk(entry.meta)
  }
  return out
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The note the model is sent for a spilled text, filled the way the spec says. */
function noteFor(full: string, file: string): string {
  return fill(MODEL_NOTES.spill, {
    bytes: String(new TextEncoder().encode(full).length),
    path: `${DIR}/${file}`,
    preview: full.slice(0, SPILL_PREVIEW_CHARS),
  })
}

/**
 * What every spilled result must satisfy (旧 57, 旧 188): the whole text on disk, under a bare file
 * name from the call's identity, its size and hash in `spill`; the note and the preview in content,
 * the images after them; neither the whole text nor the path anywhere else on the Tape.
 */
async function expectSpilled(
  h: Harness,
  q: {
    readonly full: string
    readonly mark: string
    readonly isError: boolean
    readonly images?: readonly unknown[]
  },
): Promise<ToolResultPayload> {
  const result = await lastResult(h)
  const { spill } = result
  if (spill === undefined) throw new Error('the result was not spilled')
  expect(spill.file).not.toContain('/')
  expect(spill.file).toBe(
    spillFileName({
      runId: result.runId,
      requestSeq: result.requestSeq,
      ordinal: result.ordinal,
      providerToolCallId: result.providerToolCallId,
    }),
  )
  expect(spill.file).toBe(
    `${result.runId}-${String(result.requestSeq)}-${String(result.ordinal)}.txt`,
  )
  const bytes = h.memory.files.get(`${DIR}/${spill.file}`)
  if (bytes === undefined) throw new Error(`no file ${DIR}/${spill.file}`)
  expect(new TextDecoder().decode(bytes)).toBe(q.full)
  expect(spill.bytes).toBe(bytes.length)
  expect(spill.sha256).toBe(sha256(bytes))
  const note = noteFor(q.full, spill.file)
  expect(result.content).toEqual([{ type: 'text', text: note }, ...(q.images ?? [])])
  expect(result.kernelAuthored).toBe(false)
  expect(result.isError).toBe(q.isError)
  // The path is in the note and nowhere else; the text past the preview is on no payload at all.
  const strings = await payloadStrings(h)
  expect(strings.filter((text) => text.includes(OUTPUT_ROOT))).toEqual([note])
  expect(strings.filter((text) => text.includes(q.mark))).toEqual([])
  return result
}

describe('a result past the threshold is written to disk (旧 57, 旧 188)', () => {
  it('spills a successful Grep: the whole text on disk, only the note and the preview on the Tape', async () => {
    const h = await harness({ profile: 'cowork' })
    // 400 matching lines of 100 characters: about 44,000 characters of Grep output.
    const lines = Array.from(
      { length: 400 },
      (_, i) => `hit ${String(i).padStart(4, '0')} ${'g'.repeat(91)}`,
    )
    lines.push('hit LAST-GREP-LINE')
    await h.memory.fs.writeFile(absolutePath(`${WORK}/big.txt`), `${lines.join('\n')}\n`)
    await runOnce(h, 'grep', ['Grep', { pattern: 'hit', output_mode: 'content', head_limit: 0 }])
    const full = lines.map((line, i) => `${WORK}/big.txt:${String(i + 1)}:${line}`).join('\n')
    expect(full.length).toBeGreaterThan(SPILL_THRESHOLD_CHARS)
    await expectSpilled(h, { full, mark: 'LAST-GREP-LINE', isError: false })
  })

  it('spills a failed result the same way, and keeps it is_error', async () => {
    const h = await harness()
    const full = longText(40_000, 'TRACE-END')
    h.emits.push({ content: [{ type: 'text', text: full }], isError: true })
    await runOnce(h, 'emit', ['fx__emit', {}])
    await expectSpilled(h, { full, mark: 'TRACE-END', isError: true })
    // The failure is the tool's own: the call ran and completed.
    expect(await lastOutcome(h)).toMatchObject({ state: 'completed', source: null })
  })

  it('spills a fetched page: its two texts joined by \\n, the image after the note and not counted', async () => {
    const h = await harness()
    const head = longText(20_000, 'HEAD-END')
    const tail = longText(15_000, 'PAGE-END')
    h.pages.push({ content: [{ type: 'text', text: head }, IMAGE, { type: 'text', text: tail }] })
    await runOnce(h, 'fetch', ['web__fetch', { url: 'https://a.example.com/page' }])
    const result = await expectSpilled(h, {
      full: `${head}\n${tail}`,
      mark: 'PAGE-END',
      isError: false,
      images: [IMAGE_BLOCK],
    })
    // The preview is the head's alone: the image between the two texts is not part of the text.
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/\n\nx{58}中\n/) })
  })

  it('spills a long Bash output (step 22 kept it in memory)', async () => {
    const full = longText(50_000, 'BUILD-LOG-END')
    const h = await harness({ profile: 'cowork', process: printing(full) })
    h.provider.script(reply(['Bash', { command: 'make build' }]))
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'build' })
    if (sent.status !== 'started') throw new Error('not started')
    expect((await h.loop.runEnded({ runId: sent.runId })).reason.code).toBe('paused')
    const pending = await h.service.currentPending({ sessionId: SESSION })
    if (pending === null) throw new Error('no card')
    h.provider.script(scriptedTurn({ deltas: ['Done.'], usage: USAGE }))
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: pending.card.requestId,
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    // Keyed under the request the call was made in, not the Run that resumed it.
    const result = await expectSpilled(h, { full, mark: 'BUILD-LOG-END', isError: false })
    expect(result.spill?.file.startsWith(`${sent.runId}-`)).toBe(true)
  })

  it('spills a stopped command’s output with its stop note: the note leads the file and the preview', async () => {
    const output = longText(45_000, 'HALF-LOG-END')
    const spawned = Promise.withResolvers<void>()
    const h = await harness({ profile: 'cowork', process: holding(output, spawned) })
    h.provider.script(reply(['Bash', { command: 'make all' }]))
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'build' })
    if (sent.status !== 'started') throw new Error('not started')
    expect((await h.loop.runEnded({ runId: sent.runId })).reason.code).toBe('paused')
    const pending = await h.service.currentPending({ sessionId: SESSION })
    if (pending === null) throw new Error('no card')
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: pending.card.requestId,
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'applied' })
    await spawned.promise
    const stopped = h.service.stop({ rootSessionId: SESSION })
    // The kill sequence waits on the host clock: SIGTERM, the grace, then the exit's confirmation.
    await settle()
    h.memory.advance(STOP_TERM_GRACE_MS)
    await settle()
    h.memory.advance(STOP_EXIT_CONFIRM_MS)
    await settle()
    await stopped
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
    expect(await lastOutcome(h)).toMatchObject({ state: 'aborted', source: 'stopped' })
    // The stop note and the output are one text: spilled together, and the note is no longer the
    // whole content, so it is not kernel-authored any more.
    await expectSpilled(h, {
      full: `${MODEL_NOTES.closure.stopped.aborted ?? ''}\n${output}`,
      mark: 'HALF-LOG-END',
      isError: true,
    })
  })

  it('counts text only: an image, however large, never makes a result spill, and the limit is exclusive', async () => {
    const h = await harness()
    const big = { ...IMAGE, data: 'A'.repeat(4 * SPILL_THRESHOLD_CHARS) }
    const exact = 'y'.repeat(SPILL_THRESHOLD_CHARS)
    h.emits.push({ content: [{ type: 'text', text: exact }, big] })
    await runOnce(h, 'emit', ['fx__emit', {}])
    const kept = await lastResult(h)
    expect(kept.spill).toBeUndefined()
    expect(kept.content).toEqual([
      { type: 'text', text: exact },
      { type: 'image', mediaType: 'image/png', data: big.data },
    ])
    expect(await h.memory.fs.stat(absolutePath(DIR))).toBeNull()
    // One character more, and it spills.
    h.emits.push({ content: [{ type: 'text', text: `${exact}z` }] })
    await runOnce(h, 'emit again', ['fx__emit', {}])
    expect((await lastResult(h)).spill?.bytes).toBe(SPILL_THRESHOLD_CHARS + 1)
  })

  it('turns a result whose file cannot be written into is_error, with the preview and no path', async () => {
    const h = await harness({ refuseSpills: true })
    const full = longText(40_000, 'LOST-END')
    h.pages.push({ content: [{ type: 'text', text: full }, IMAGE] })
    await runOnce(h, 'fetch', ['web__fetch', { url: 'https://a.example.com/huge' }])
    const result = await lastResult(h)
    expect(result.spill).toBeUndefined()
    expect(result.isError).toBe(true)
    expect(result.kernelAuthored).toBe(false)
    expect(result.content).toEqual([
      {
        type: 'text',
        text: fill(MODEL_NOTES.spillFailed, { preview: full.slice(0, SPILL_PREVIEW_CHARS) }),
      },
      IMAGE_BLOCK,
    ])
    // The call itself ran: its outcome is a normal one.
    expect(await lastOutcome(h)).toMatchObject({ state: 'completed', source: null })
    // Nothing on disk, nothing of the rest or of the path on the Tape; the error only in the log.
    expect([...h.memory.files.keys()].filter((path) => path.startsWith(OUTPUT_ROOT))).toEqual([])
    const strings = await payloadStrings(h)
    expect(
      strings.filter((text) => text.includes('LOST-END') || text.includes(OUTPUT_ROOT)),
    ).toEqual([])
    expect(h.logs.filter((line) => line.includes('could not be saved'))).toHaveLength(1)
    expect(h.logs.join('\n')).toContain('ENOSPC')
  })
})

describe('the preview', () => {
  it('is the first SPILL_PREVIEW_CHARS characters of the texts joined by \\n', () => {
    expect(spillPreview(['a'.repeat(1500), 'b'.repeat(1500)])).toBe(
      `${'a'.repeat(1500)}\n${'b'.repeat(SPILL_PREVIEW_CHARS - 1501)}`,
    )
    expect(spillPreview(['short'])).toBe('short')
  })

  it('never splits a surrogate pair', () => {
    const cut = `${'a'.repeat(SPILL_PREVIEW_CHARS - 1)}😀${'b'.repeat(40_000)}`
    expect(spillPreview([cut])).toBe('a'.repeat(SPILL_PREVIEW_CHARS - 1))
    const whole = `${'a'.repeat(SPILL_PREVIEW_CHARS - 2)}😀${'b'.repeat(40_000)}`
    expect(spillPreview([whole])).toBe(`${'a'.repeat(SPILL_PREVIEW_CHARS - 2)}😀`)
  })

  it('fills notes that name only their own slots', () => {
    expect(slotsOf(MODEL_NOTES.spill)).toEqual(['bytes', 'path', 'preview'])
    expect(slotsOf(MODEL_NOTES.spillFailed)).toEqual(['preview'])
    // It tells the model how to read the rest: Read, with offset and limit.
    expect(MODEL_NOTES.spill).toMatch(/Read .*offset and limit/)
  })
})

describe('02 不变量 34: the preview, once given, is never cut or dropped later', () => {
  it('sends the stored note byte for byte: next request, a later Run, after a restart, after a code change', async () => {
    const h = await harness()
    const full = longText(40_000, 'KEPT-END')
    h.emits.push({ content: [{ type: 'text', text: full }, IMAGE] })
    await runOnce(h, 'emit', ['fx__emit', {}])
    const stored = (await lastResult(h)).content
    const sent = [{ type: 'text', text: (stored[0] as { text: string }).text }, expect.anything()]
    // The request right after the result, and the next Run's first request.
    expect(sentResults(h.provider, -1)).toEqual([sent])
    await runOnce(h, 'and now?')
    expect(sentResults(h.provider, -1)).toEqual([sent])
    // A restart, with the note's code changed meanwhile: the stored text goes, not a new rendering.
    const notes = MODEL_NOTES as { spill: string }
    const original = notes.spill
    notes.spill = 'Changed after the fact: {bytes} {path} {preview}'
    try {
      const restarted = await harness({ after: h })
      await runOnce(restarted, 'still there?')
      expect(sentResults(restarted.provider, -1)).toEqual([sent])
    } finally {
      notes.spill = original
    }
    // The Tape's content is still what it was, and the file is untouched.
    const kept = await lastResult(h)
    expect(kept.content).toEqual(stored)
    const bytes = h.memory.files.get(`${DIR}/${kept.spill?.file ?? ''}`) ?? new Uint8Array()
    expect(new TextDecoder().decode(bytes)).toBe(full)
  })
})

describe('the chat profile reads its own spill, and only that (旧 57; plan step 24 暂定)', () => {
  it('reads the spilled file with no card, under the threshold and not spilled again; another session’s is blocked', async () => {
    const h = await harness()
    const lines = Array.from({ length: 2000 }, (_, i) => `row ${String(i + 1)} ${'r'.repeat(50)}`)
    const full = lines.join('\n')
    h.emits.push({ content: [{ type: 'text', text: full }] })
    await runOnce(h, 'emit', ['fx__emit', {}])
    const file = (await lastResult(h)).spill?.file
    if (file === undefined) throw new Error('not spilled')
    const other = absolutePath(`${OUTPUT_ROOT}/${OTHER}/r-1-0.txt`)
    await h.memory.fs.mkdirp(absolutePath(`${OUTPUT_ROOT}/${OTHER}`))
    await h.memory.fs.writeFile(other, 'another session’s output\n')
    await runOnce(
      h,
      'read it',
      ['Read', { file_path: `${DIR}/${file}` }],
      ['Read', { file_path: other }],
    )
    const all = await entries(h)
    const decisions = all
      .filter((entry) => entry.name === 'tool/permission_decided')
      .slice(-2)
      .map((entry) => {
        const payload = entry.payload as unknown as PermissionDecidedPayload
        return [payload.record.verdict, payload.record.decidedBy, payload.reversibility]
      })
    expect(decisions).toEqual([
      ['allow', 'protected', 'read-only'],
      ['deny', 'protected', 'read-only'],
    ])
    const [read, blocked] = (await results(h)).slice(-2)
    if (read === undefined || blocked === undefined) throw new Error('two results expected')
    // Read keeps itself under the threshold, so the check never holds for it: no second file.
    expect(read.spill).toBeUndefined()
    expect(read.isError).toBe(false)
    const text = (read.content[0] as { text: string }).text
    expect(text.length).toBeLessThanOrEqual(SPILL_THRESHOLD_CHARS)
    expect(text.startsWith(`1\t${lines[0] ?? ''}\n2\t`)).toBe(true)
    expect(await h.memory.fs.readdir(absolutePath(DIR))).toEqual([file])
    expect(blocked.isError).toBe(true)
    expect(JSON.stringify(blocked.content)).not.toContain('another session’s output')
    // Never a card: nothing reached HostConfirm.
    expect(h.memory.confirmRequests).toEqual([])
  })
})

/** The directory a spill goes to is the host function's, for an id the service hands out. */
describe('where it is written', () => {
  it('is toolOutputDirFor(profileDir, sessionId), made on the first spill, before the result', async () => {
    // Whether the result's file was on disk when its `tool/result` reached the store.
    const onDisk: boolean[] = []
    const h = await harness({
      beforeAppend: (batch, memory) => {
        for (const entry of batch.entries) {
          const spill = entry.name === 'tool/result' ? entry.payload['spill'] : undefined
          if (spill !== undefined)
            onDisk.push(memory.files.has(`${DIR}/${(spill as { file: string }).file}`))
        }
      },
    })
    expect(await h.memory.fs.stat(absolutePath(DIR))).toBeNull()
    h.emits.push({ content: [{ type: 'text', text: longText(31_000, 'M') }] })
    await runOnce(h, 'emit', ['fx__emit', {}])
    expect((await h.memory.fs.stat(absolutePath(DIR)))?.isDir).toBe(true)
    const paths: AbsolutePath[] = [...h.memory.files.keys()]
      .filter((path) => path.startsWith(OUTPUT_ROOT))
      .map((path) => absolutePath(path))
    expect(paths).toEqual([absolutePath(`${DIR}/${(await lastResult(h)).spill?.file ?? ''}`)])
    expect(onDisk).toEqual([true])
  })
})
