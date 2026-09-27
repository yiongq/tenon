/**
 * Write, Edit and Bash through a real Run (spec 02 §内置工具的默认档位, §作用域与授权键, §可逆性,
 * §内置工具与参数「Bash」, §工作区; plan step 22): the cards they raise, what an allow grants, the
 * command pattern table on the card and in the facts, the dedicated folder coming into being, and the
 * stop that lands while Bash awaits its base environment.
 *
 * The product registry runs the real executors (Write, Edit and Bash joined it here), on the memory
 * host; Bash spawns a fake child unless a case needs `/bin/sh`. 旧 96 and 旧 161 care only about the
 * decision, so they run on the test registry's fake executors.
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createSessionService,
} from '../../src/index.js'
import type {
  AbsolutePath,
  ChildHandle,
  HostProcess,
  HostSandbox,
  McpConnection,
  McpToolSource,
  MemoryHost,
  ModelInfo,
  PendingCard,
  SandboxRequest,
  SessionService,
  SpawnSpec,
  StreamEvent,
  TapeEntry,
  TapeStore,
  Usage,
} from '../../src/index.js'
import { STOP_TERM_GRACE_MS } from '../../src/loop/limits.js'
import { reversibilityOf } from '../../src/permission/reversibility.js'
import { MODEL_NOTES, fill } from '../../src/prompts/index.js'
import { COMMAND_SCRIPT } from '../../src/tools/builtin/bash.js'
import type { CommandShell } from '../../src/tools/builtin/bash.js'
import { WRITE_TEXTS } from '../../src/tools/builtin/write.js'
import {
  createCounterIds,
  createFakeInspector,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type { FakeInspector, ScriptedProvider, TestLoopPorts } from '../../src/testing/index.js'
import { createNodeProcess } from '../support/node-process.js'

const IDENTITY = { userId: 'cmd-user', tenantId: 'cmd-tenant', profileDir: '/tenon/cmd' }
const SESSION = '3a7c1e9b-2d4f-4b6a-8c1e-5f9a2b3c4d51'
const DEDICATED = absolutePath(`/home/u/Tenon/workspaces/cmd-user/cmd-tenant/${SESSION}`)
const WORK = absolutePath('/work/project')

const MODEL: ModelInfo = {
  id: 'claude-cmd-1',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}

const USAGE: Usage = {
  inputTokens: 5,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

const ASK = { kind: 'ask', category: 'exfiltration', findings: [{ code: 'test' }] } as const

/** A connector with two tools that call themselves harmless and dangerous (never read, E1, E4). */
function annotated(): McpToolSource {
  const connection = {
    listTools: () =>
      Promise.resolve([
        { name: 'peek', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'wipe', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
      ]),
    callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  } as unknown as McpConnection
  return { serverId: 'hints', connection }
}

/** Every spawn a Run asked for; each child prints `output` and exits 0. */
interface Spawns {
  readonly process: HostProcess
  readonly specs: SpawnSpec[]
  /** Whether the cwd was a folder on the host's disk at the moment of each spawn. */
  readonly cwdExisted: boolean[]
}

function fakeProcesses(memory: () => MemoryHost, output: string): Spawns {
  const specs: SpawnSpec[] = []
  const cwdExisted: boolean[] = []
  return {
    specs,
    cwdExisted,
    process: {
      spawn: async (spec) => {
        specs.push(spec)
        cwdExisted.push((await memory().fs.stat(spec.cwd))?.isDir === true)
        const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>()
        const child: ChildHandle = {
          pid: 7,
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
        return child
      },
    },
  }
}

interface Harness {
  readonly memory: MemoryHost
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
  readonly inspector: FakeInspector
  readonly wrapped: SandboxRequest[]
  readonly afterExit: string[]
}

async function harness(o: {
  /** `'test'`: the test registry with fake executors; default the product's. */
  readonly registry?: 'product' | 'test'
  readonly process?: HostProcess
  /** The workspace: a picked folder (default `WORK`), or only the dedicated folder. */
  readonly folder?: AbsolutePath | 'dedicated'
  readonly commandShell?: CommandShell
  /** Called on each reading of the service's clock, before it answers. */
  readonly onNow?: () => void
}): Promise<Harness> {
  const host = createMemoryHost({
    identity: IDENTITY,
    ...(o.process === undefined ? {} : { process: o.process }),
  })
  // The sandbox passes through; what it was asked is recorded (§内置工具与参数「Bash」「起进程」).
  const wrapped: SandboxRequest[] = []
  const afterExit: string[] = []
  const sandbox: HostSandbox = {
    wrap: (request) => {
      wrapped.push(request)
      return host.sandbox.wrap(request)
    },
    afterExit: (commandId) => {
      afterExit.push(commandId)
      return Promise.resolve()
    },
    violations: (commandId) => host.sandbox.violations(commandId),
  }
  const folder = o.folder ?? WORK
  if (folder !== 'dedicated') await host.fs.mkdirp(folder)
  const store = createMemoryTapeStore({ identity: IDENTITY })
  const provider = createScriptedProvider({ models: [MODEL] })
  const inspector = createFakeInspector({ id: 'asker', ceiling: 'ask' })
  const loop = createTestLoopPorts({
    connector: { provider, model: MODEL, mcpSources: [annotated()] },
    ...(o.commandShell === undefined ? {} : { commandShell: o.commandShell }),
  })
  const { onNow } = o
  const clock =
    onNow === undefined
      ? host.clock
      : {
          now: () => {
            onNow()
            return host.clock.now()
          },
          setTimeout: (fn: () => void, ms: number) => host.clock.setTimeout(fn, ms),
        }
  const options = {
    host: { ...host, sandbox, clock },
    tape: store,
    ids: createCounterIds(),
    inspectors: [inspector.registration],
    connector: loop.connector,
    protectedFiles: [],
  }
  const service =
    o.registry === 'test'
      ? createTestSessionService(options, { tools: {} })
      : createSessionService(options)
  service.bindLoop(loop)
  await service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: DEDICATED })
  if (folder !== 'dedicated') {
    await service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [folder] },
      dedicated: DEDICATED,
    })
  }
  return { memory: host, store, service, loop, provider, inspector, wrapped, afterExit }
}

let nextCall = 1

/** A call of a reply after the first, in the same batch. */
type LaterCall = readonly [name: string, input: Record<string, unknown>]

/** One reply asking for the call, and for the later ones after it. */
function callOf(
  name: string,
  input: Record<string, unknown>,
  later: readonly LaterCall[] = [],
): StreamEvent[] {
  const calls: readonly LaterCall[] = [[name, input], ...later]
  return [
    ...calls.flatMap(([called, args], k): StreamEvent[] => {
      const id = `toolu_${String(nextCall++)}`
      return [
        { type: 'tool-call-start', index: k + 1, id, name: called },
        { type: 'tool-call-end', index: k + 1, id, name: called, input: args },
      ]
    }),
    { type: 'usage', usage: USAGE },
    stopEvent('tool-use', 'tool_use'),
  ]
}

async function send(
  h: Harness,
  name: string,
  input: Record<string, unknown>,
  later: readonly LaterCall[] = [],
): Promise<string> {
  h.provider.script(callOf(name, input, later))
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text: `call ${name}` })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  return sent.runId
}

/** Sends a message whose reply asks for the call (and the later ones); the Run pauses on its card. */
async function pausedOn(
  h: Harness,
  name: string,
  input: Record<string, unknown>,
  later: readonly LaterCall[] = [],
): Promise<PendingCard> {
  const runId = await send(h, name, input, later)
  expect((await h.loop.runEnded({ runId })).reason).toEqual({
    code: 'paused',
    waitingFor: 'approval',
  })
  const pending = await h.service.currentPending({ sessionId: SESSION })
  if (pending === null) throw new Error('no card')
  return pending
}

/** Sends a call the session already allows: it runs with no card, and the Run completes. */
async function ranFree(h: Harness, name: string, input: Record<string, unknown>): Promise<void> {
  const runId = await send(h, name, input)
  h.provider.script(scriptedTurn({ deltas: ['Done.'], usage: USAGE }))
  expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'completed' })
  expect(await h.service.currentPending({ sessionId: SESSION })).toBeNull()
}

/** Allows the card and lets the resumed Run finish on a text reply. */
async function allow(h: Harness, pending: PendingCard): Promise<void> {
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
  await h.loop.runEnded()
}

async function entries(h: Harness): Promise<TapeEntry[]> {
  return (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}

async function named(h: Harness, name: string): Promise<TapeEntry[]> {
  return (await entries(h)).filter((entry) => entry.name === name)
}

async function lastOf(h: Harness, name: string): Promise<Record<string, unknown>> {
  const found = (await named(h, name)).at(-1)
  if (found === undefined) throw new Error(`no ${name}`)
  return found.payload
}

/** Every closure's `<i>`, state, source and reversibility, in Tape order. */
async function outcomes(h: Harness): Promise<string[]> {
  return (await named(h, 'execution/tool_outcome')).map(({ payload }) =>
    [payload['ordinal'], payload['state'], payload['source'], payload['reversibility']].join(' '),
  )
}

/** Answers the card allow without waiting for the answer: the resumed Run may be held meanwhile. */
function allowing(h: Harness, pending: PendingCard): ReturnType<SessionService['answer']> {
  return h.service.answer({
    kind: 'approval',
    sessionId: SESSION,
    requestId: pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
}

describe('a command the pattern table calls irreversible (旧 96)', () => {
  it('asks with reason command, its text and cwd, and holds each allow for that one call', async () => {
    const h = await harness({ registry: 'test' })
    const command = 'curl -X POST https://api.example.com/items -d @body.json'
    for (let round = 0; round < 2; round += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one card, answered, then the same call again
      const pending = await pausedOn(h, 'Bash', { command })
      expect(pending.card).toMatchObject({
        kind: 'command',
        reason: 'command',
        facts: { command, cwd: WORK },
        target: { type: 'command', command, cwd: WORK },
        reversibility: 'irreversible',
      })
      expect(pending.allowScope).toBe('once')
      // oxlint-disable-next-line no-await-in-loop -- the decision the card came from
      expect((await lastOf(h, 'tool/permission_decided'))['reversibility']).toBe('irreversible')
      // oxlint-disable-next-line no-await-in-loop -- allowed, it runs this once
      await allow(h, pending)
      // oxlint-disable-next-line no-await-in-loop -- the grant the answer wrote
      expect((await lastOf(h, 'tool/approval_resolved'))['grant']).toMatchObject({ scope: 'once' })
      // oxlint-disable-next-line no-await-in-loop -- the call ran on its allow
      expect(await lastOf(h, 'execution/tool_outcome')).toMatchObject({
        state: 'completed',
        reversibility: 'irreversible',
      })
    }
    expect(await named(h, 'execution/dispatch_committed')).toHaveLength(2)
  })

  it('frees an allowed unknown command for the exact same text only', async () => {
    const h = await harness({ registry: 'test' })
    const pending = await pausedOn(h, 'Bash', { command: 'ls -la' })
    expect(pending.card.reversibility).toBe('unknown')
    expect(pending.allowScope).toBe('session')
    await allow(h, pending)
    await ranFree(h, 'Bash', { command: 'ls -la' })
    expect(await named(h, 'execution/dispatch_committed')).toHaveLength(2)
    // One character more is another command.
    const other = await pausedOn(h, 'Bash', { command: 'ls -la ' })
    expect(other.card.target).toEqual({ type: 'command', command: 'ls -la ', cwd: WORK })
  })
})

describe('an inspector changes only whether to ask, never the reversibility (旧 161)', () => {
  const CASES: ReadonlyArray<{
    readonly name: string
    readonly input: Record<string, unknown>
    readonly reversibility: string
    /** Whether the call asks with the inspector silent. */
    readonly asksAnyway: boolean
  }> = [
    {
      name: 'Bash',
      input: { command: 'rm -rf build' },
      reversibility: 'irreversible',
      asksAnyway: true,
    },
    { name: 'Bash', input: { command: 'make' }, reversibility: 'unknown', asksAnyway: true },
    {
      name: 'Write',
      input: { file_path: `${WORK}/a.txt`, content: 'x' },
      reversibility: 'unknown',
      asksAnyway: true,
    },
    {
      name: 'Read',
      input: { file_path: `${WORK}/a.txt` },
      reversibility: 'read-only',
      asksAnyway: false,
    },
    // A connector tool is unknown whatever its annotations claim.
    { name: 'hints__peek', input: {}, reversibility: 'unknown', asksAnyway: true },
    { name: 'hints__wipe', input: {}, reversibility: 'unknown', asksAnyway: true },
  ]

  for (const c of CASES) {
    it(`${c.name} ${JSON.stringify(c.input)}: ${c.reversibility} on the card, the decision and the closure`, async () => {
      const h = await harness({ registry: 'test' })
      h.inspector.answer(ASK)
      const pending = await pausedOn(h, c.name, c.input)
      expect(pending.card.reversibility).toBe(c.reversibility)
      const decided = await lastOf(h, 'tool/permission_decided')
      expect(decided['reversibility']).toBe(c.reversibility)
      expect(h.inspector.calls.at(-1)?.call.reversibility).toBe(c.reversibility)
      await allow(h, pending)
      expect((await lastOf(h, 'execution/tool_outcome'))['reversibility']).toBe(c.reversibility)
      // The host's own reading, for the same call.
      const tool = c.name.includes('__')
        ? { source: 'mcp' as const, originalName: c.name.split('__')[1] ?? '' }
        : { source: 'builtin' as const, originalName: c.name }
      expect(reversibilityOf(tool, c.input)).toBe(c.reversibility)
      // Silent, the inspector leaves the question of asking to the rest of the table.
      h.inspector.answer({ kind: 'none' })
      const runId = await send(h, c.name, c.input)
      if (!c.asksAnyway) h.provider.script(scriptedTurn({ deltas: ['Done.'], usage: USAGE }))
      expect((await h.loop.runEnded({ runId })).reason.code).toBe(
        c.asksAnyway ? 'paused' : 'completed',
      )
      expect((await lastOf(h, 'tool/permission_decided'))['reversibility']).toBe(c.reversibility)
    })
  }
})

describe('Write in the workspace (旧 215, the kernel half)', () => {
  it('asks with reason default and the real path, allows for the session, and the same file runs free', async () => {
    const h = await harness({})
    const path = `${WORK}/notes.md`
    const pending = await pausedOn(h, 'Write', { file_path: path, content: 'first\n' })
    expect(pending.card).toMatchObject({
      kind: 'file',
      reason: 'default',
      facts: { toolName: 'Write' },
      target: { type: 'path', path },
      reversibility: 'unknown',
    })
    expect(pending.allowScope).toBe('session')
    await allow(h, pending)
    expect(await h.memory.fs.readFile(absolutePath(path), { encoding: 'utf8' })).toBe('first\n')
    await ranFree(h, 'Write', { file_path: path, content: 'second\n' })
    expect(await h.memory.fs.readFile(absolutePath(path), { encoding: 'utf8' })).toBe('second\n')
    // The grant is Write's, for this file: another file, or Edit on this one, asks again.
    expect(
      (await pausedOn(h, 'Edit', { file_path: path, old_string: 'second', new_string: '2' })).card
        .target,
    ).toEqual({
      type: 'path',
      path,
    })
  })

  it('acts on the card’s path after the allow: a link swapped in there before the dispatch is not followed', async () => {
    const h = await harness({})
    const path = absolutePath(`${WORK}/notes.md`)
    const secret = absolutePath('/outside/secret')
    await h.memory.fs.mkdirp(absolutePath('/outside'))
    await h.memory.fs.writeFile(secret, 'orig')
    const pending = await pausedOn(h, 'Write', { file_path: path, content: 'x' })
    expect(pending.card.target).toEqual({ type: 'path', path })
    // The answer judges the card's path again; the link lands while the resumed Run assembles.
    const held = h.loop.connector.holdAssemble()
    h.provider.script(scriptedTurn({ deltas: ['Done.'], usage: USAGE }))
    const answered = allowing(h, pending)
    await held.reached
    h.memory.symlink(path, secret)
    held.release()
    expect(await answered).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    // §「在不在工作区里」第 5 步: the card's real path no longer names itself, so nothing is written.
    expect(await h.memory.fs.readFile(secret, { encoding: 'utf8' })).toBe('orig')
    expect(await lastOf(h, 'tool/result')).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: fill(WRITE_TEXTS.resolvesElsewhere, { path }) }],
    })
    expect(await lastOf(h, 'execution/tool_outcome')).toMatchObject({
      state: 'completed',
      source: null,
    })
  })

  it('acts on the card’s path when a link to a granted file loosens the re-judgement', async () => {
    const h = await harness({})
    const granted = absolutePath(`${WORK}/b.md`)
    const path = absolutePath(`${WORK}/a.md`)
    await allow(h, await pausedOn(h, 'Write', { file_path: granted, content: 'b-orig' }))
    const pending = await pausedOn(h, 'Write', { file_path: path, content: 'A' })
    expect(pending.card.target).toEqual({ type: 'path', path })
    // While the card waits, a.md becomes a link to b.md, which this session may write without a
    // card: the answer's re-judgement allows, but the card named a.md (spec.md §等待模型「只能收紧」).
    h.memory.symlink(path, granted)
    h.provider.script(scriptedTurn({ deltas: ['Done.'], usage: USAGE }))
    await allow(h, pending)
    expect(await h.memory.fs.readFile(granted, { encoding: 'utf8' })).toBe('b-orig')
    expect(await lastOf(h, 'tool/result')).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: fill(WRITE_TEXTS.resolvesElsewhere, { path }) }],
    })
  })
})

describe('the dedicated folder (旧 180)', () => {
  it('does not exist before the first Write, which makes it', async () => {
    const h = await harness({ folder: 'dedicated' })
    expect(await h.memory.fs.stat(DEDICATED)).toBeNull()
    const path = `${DEDICATED}/out/report.md`
    await allow(h, await pausedOn(h, 'Write', { file_path: path, content: 'r' }))
    expect(await h.memory.fs.stat(DEDICATED)).toMatchObject({ isDir: true })
    expect(await h.memory.fs.readFile(absolutePath(path), { encoding: 'utf8' })).toBe('r')
  })

  it('is made before the first Bash, which runs in it: cwd folders[0], its env as given', async () => {
    let host: MemoryHost | null = null
    const spawns = fakeProcesses(() => {
      if (host === null) throw new Error('spawned before the host was made')
      return host
    }, '/somewhere\n')
    const env = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }
    const h = await harness({
      folder: 'dedicated',
      process: spawns.process,
      commandShell: { path: absolutePath('/bin/zsh'), env: () => Promise.resolve(env) },
    })
    host = h.memory
    expect(await h.memory.fs.stat(DEDICATED)).toBeNull()
    const pending = await pausedOn(h, 'Bash', { command: 'pwd' })
    expect(pending.card.target).toEqual({ type: 'command', command: 'pwd', cwd: DEDICATED })
    await allow(h, pending)
    const argv = ['/bin/zsh', '-c', COMMAND_SCRIPT, '/bin/zsh', 'pwd']
    expect(spawns.specs).toEqual([{ argv, cwd: DEDICATED, env, stdio: 'pipe' }])
    expect(spawns.cwdExisted).toEqual([true])
    const call = (await named(h, 'tool/call')).at(-1)?.payload['providerToolCallId'] as string
    expect(h.wrapped).toEqual([
      {
        commandId: call,
        argv,
        cwd: DEDICATED,
        env,
        profile: 'workspace-write',
        workspace: [DEDICATED],
      },
    ])
    expect(h.afterExit).toEqual([call])
    expect(await lastOf(h, 'tool/result')).toMatchObject({
      isError: false,
      kernelAuthored: false,
      content: [{ type: 'text', text: '/somewhere\n' }],
    })
  })
})

describe('Bash on a real /bin/sh, through the Run', () => {
  it('records `exit 3` as a completed call whose result is an error headed `Exit code: 3`', async () => {
    const here = absolutePath(realpathSync(tmpdir()))
    const h = await harness({
      folder: here,
      process: createNodeProcess(),
      commandShell: {
        path: absolutePath('/bin/sh'),
        env: () => Promise.resolve({ PATH: '/usr/bin:/bin' }),
      },
    })
    await allow(h, await pausedOn(h, 'Bash', { command: 'exit 3' }))
    const result = await lastOf(h, 'tool/result')
    expect(result).toMatchObject({ isError: true, kernelAuthored: false })
    const [first] = (result['content'] as Array<{ text: string }>)[0]?.text.split('\n') ?? []
    expect(first).toBe('Exit code: 3')
    expect(await lastOf(h, 'execution/tool_outcome')).toMatchObject({
      state: 'completed',
      source: null,
      effect: 'external',
    })
  })
})

describe('a Bash call past its timeout', () => {
  it('is killed, recorded aborted / timed-out with its output, and the Run goes on', async () => {
    const spawned = Promise.withResolvers<void>()
    const kills: string[] = []
    const h = await harness({
      process: {
        spawn: () => {
          const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>()
          let out: ReadableStreamDefaultController<Uint8Array> | undefined
          const child: ChildHandle = {
            pid: 9,
            stdin: new WritableStream(),
            stdout: new ReadableStream({
              start: (controller) => {
                out = controller
                controller.enqueue(new TextEncoder().encode('step 1 of 3\n'))
              },
            }),
            stderr: new ReadableStream({ start: (controller) => controller.close() }),
            exited: exited.promise,
            kill: (signal = 'SIGTERM') => {
              kills.push(signal)
              if (signal === 'SIGKILL') {
                out?.close()
                exited.resolve({ code: null, signal: 'SIGKILL' })
              }
              return Promise.resolve()
            },
          }
          spawned.resolve()
          return Promise.resolve(child)
        },
      },
    })
    const pending = await pausedOn(h, 'Bash', { command: 'make all', timeout: 1000 })
    h.provider.script(scriptedTurn({ deltas: ['It timed out.'], usage: USAGE }))
    await h.service.answer({
      kind: 'approval',
      sessionId: SESSION,
      requestId: pending.card.requestId,
      decision: 'allow',
      origin: null,
    })
    await spawned.promise
    await settle()
    h.memory.advance(1000)
    await settle()
    expect(kills).toEqual(['SIGTERM'])
    h.memory.advance(STOP_TERM_GRACE_MS)
    // Not a block, not a stop: the next request goes out and the Run completes.
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(await lastOf(h, 'execution/tool_outcome')).toMatchObject({
      state: 'aborted',
      source: 'timed-out',
      effect: 'external',
    })
    expect(await lastOf(h, 'tool/result')).toMatchObject({
      isError: true,
      kernelAuthored: true,
      content: [
        { type: 'text', text: MODEL_NOTES.closure['timed-out'].aborted },
        { type: 'text', text: 'step 1 of 3\n' },
      ],
    })
  })
})

/** Lets every promise the Run has in flight settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('a stop while Bash awaits its base environment', () => {
  it('records the call allowed on its card not-run / stopped with its decision’s reversibility: nothing dispatched, nothing spawned', async () => {
    const env = Promise.withResolvers<Readonly<Record<string, string>>>()
    const reached = Promise.withResolvers<void>()
    let spawned = 0
    const h = await harness({
      process: {
        spawn: () => {
          spawned += 1
          return Promise.reject(new Error('never spawned'))
        },
      },
      commandShell: {
        path: absolutePath('/bin/sh'),
        env: () => {
          reached.resolve()
          return env.promise
        },
      },
    })
    const pending = await pausedOn(h, 'Bash', { command: 'rm -rf build' })
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: pending.card.requestId,
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'applied' })
    await reached.promise
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
    env.resolve({})
    // The call has its asking decision: the closure takes that fact's value (§载荷 ToolOutcomePayload).
    expect(await lastOf(h, 'execution/tool_outcome')).toMatchObject({
      state: 'not-run',
      source: 'stopped',
      effect: 'blocked',
      reversibility: 'irreversible',
    })
    expect(await named(h, 'execution/dispatch_committed')).toEqual([])
    expect(spawned).toBe(0)
  })

  it('closes the calls after it not-run / stopped too, with no decision fact: unknown', async () => {
    const env = Promise.withResolvers<Readonly<Record<string, string>>>()
    const reached = Promise.withResolvers<void>()
    let spawned = 0
    const h = await harness({
      process: {
        spawn: () => {
          spawned += 1
          return Promise.reject(new Error('never spawned'))
        },
      },
      commandShell: {
        path: absolutePath('/bin/sh'),
        env: () => {
          reached.resolve()
          return env.promise
        },
      },
    })
    const pending = await pausedOn(h, 'Bash', { command: 'rm -rf build' }, [
      ['Bash', { command: 'rm -rf dist' }],
    ])
    expect(await allowing(h, pending)).toEqual({ status: 'applied' })
    await reached.promise
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
    env.resolve({})
    expect(await outcomes(h)).toEqual([
      '0 not-run stopped irreversible',
      '1 not-run stopped unknown',
    ])
    expect(await named(h, 'execution/dispatch_committed')).toEqual([])
    expect(spawned).toBe(0)
  })

  it('keeps that reversibility when the stop lands after the environment came, before the dispatch’s write', async () => {
    let armed = false
    let stop: (() => void) | null = null
    let spawned = 0
    const h = await harness({
      process: {
        spawn: () => {
          spawned += 1
          return Promise.reject(new Error('never spawned'))
        },
      },
      commandShell: {
        path: absolutePath('/bin/sh'),
        env: () => {
          armed = true
          return Promise.resolve({})
        },
      },
      // The first reading of the clock once the environment was asked for is the dispatch's
      // createdAt: the stop lands after the batch looked at the signal, before its write's turn.
      onNow: () => {
        if (!armed) return
        armed = false
        stop?.()
      },
    })
    stop = () => void h.service.stop({ rootSessionId: SESSION })
    const pending = await pausedOn(h, 'Bash', { command: 'rm -rf build' })
    await h.service.answer({
      kind: 'approval',
      sessionId: SESSION,
      requestId: pending.card.requestId,
      decision: 'allow',
      origin: null,
    })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
    expect(await lastOf(h, 'execution/tool_outcome')).toMatchObject({
      state: 'not-run',
      source: 'stopped',
      reversibility: 'irreversible',
    })
    expect(await named(h, 'execution/dispatch_committed')).toEqual([])
    expect(spawned).toBe(0)
  })

  it('races the stop on the path with no card too: a command this session already allows', async () => {
    let host: MemoryHost | null = null
    const spawns = fakeProcesses(() => {
      if (host === null) throw new Error('spawned before the host was made')
      return host
    }, 'built\n')
    const pendingEnv = Promise.withResolvers<Readonly<Record<string, string>>>()
    const reached = Promise.withResolvers<void>()
    let asked = 0
    const h = await harness({
      process: spawns.process,
      commandShell: {
        path: absolutePath('/bin/sh'),
        // The first call gets its environment at once; the second waits for it.
        env: () => {
          asked += 1
          if (asked === 1) return Promise.resolve({ PATH: '/usr/bin:/bin' })
          reached.resolve()
          return pendingEnv.promise
        },
      },
    })
    host = h.memory
    await allow(h, await pausedOn(h, 'Bash', { command: 'make' }))
    expect(spawns.specs).toHaveLength(1)
    const runId = await send(h, 'Bash', { command: 'make' })
    await reached.promise
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    expect((await h.loop.runEnded({ runId })).reason).toEqual({ code: 'user-stopped' })
    // No card, so no decision fact was written before the stop: the closure records unknown.
    expect(await lastOf(h, 'execution/tool_outcome')).toMatchObject({
      state: 'not-run',
      source: 'stopped',
      effect: 'blocked',
      reversibility: 'unknown',
    })
    expect(await named(h, 'execution/dispatch_committed')).toHaveLength(1)
    expect(spawns.specs).toHaveLength(1)
    pendingEnv.resolve({})
  })
})

describe('a stop while the answered Run assembles, before its batch', () => {
  it('closes the approved call not-run / stopped with its decision’s reversibility, the rest unknown', async () => {
    const h = await harness({ registry: 'test' })
    const pending = await pausedOn(h, 'Bash', { command: 'rm -rf build' }, [
      ['Bash', { command: 'rm -rf dist' }],
    ])
    const held = h.loop.connector.holdAssemble()
    const answered = allowing(h, pending)
    await held.reached
    // The resumed Run's head is on the Tape; the stop does not wait for its assembly (resumeSetup).
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    expect(await answered).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
    held.release()
    expect(await lastOf(h, 'tool/permission_decided')).toMatchObject({
      reversibility: 'irreversible',
    })
    expect(await outcomes(h)).toEqual([
      '0 not-run stopped irreversible',
      '1 not-run stopped unknown',
    ])
    expect(await named(h, 'execution/dispatch_committed')).toEqual([])
  })
})

describe('a stop while the card waits (§每种答复同批写什么「暂停中停止」)', () => {
  it('closes the waiting call not-run / stopped with its decision’s reversibility', async () => {
    const h = await harness({ registry: 'test' })
    await pausedOn(h, 'Bash', { command: 'rm -rf build' })
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    expect(await lastOf(h, 'execution/tool_outcome')).toMatchObject({
      state: 'not-run',
      source: 'stopped',
      reversibility: 'irreversible',
    })
  })

  // Only the waiting call has a decision fact; the calls waiting with it have none (§载荷).
  it('closes the calls waiting with it as unknown', async () => {
    const h = await harness({ registry: 'test' })
    await pausedOn(h, 'Bash', { command: 'rm -rf build' }, [['Bash', { command: 'rm -rf dist' }]])
    expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
    expect(await outcomes(h)).toEqual([
      '0 not-run stopped irreversible',
      '1 not-run stopped unknown',
    ])
  })

  it('closes them the same way when a new message supersedes the card', async () => {
    const h = await harness({ registry: 'test' })
    await pausedOn(h, 'Bash', { command: 'rm -rf build' }, [['Bash', { command: 'rm -rf dist' }]])
    h.provider.script(scriptedTurn({ deltas: ['Done.'], usage: USAGE }))
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'instead' })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    expect((await h.loop.runEnded({ runId: sent.runId })).reason).toEqual({ code: 'completed' })
    expect(await outcomes(h)).toEqual([
      '0 not-run superseded irreversible',
      '1 not-run superseded unknown',
    ])
  })
})
