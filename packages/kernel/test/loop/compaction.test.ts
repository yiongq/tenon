import type * as RunModule from '../../src/loop/run.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHost, createMemoryTapeStore, compactionThreshold } from '../../src/index.js'
import type { EncodedRequest, ModelInfo, StreamEvent } from '../../src/index.js'
import { encodeOpenAIChat } from '../../src/provider/wire/openai-chat.js'
import { LOCALE_HINT, MODEL_NOTES, fill } from '../../src/prompts/index.js'
import {
  recheckAttempt,
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'

// Deadline is an existing RunDriverContext contract. Inject it only in the selected test so a
// root with historical turns can exercise the same driver's summary path as a time-limited child.
const deadline = vi.hoisted(() => ({ from: null as number | null }))
vi.mock('../../src/loop/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RunModule>()
  return {
    ...actual,
    driveRun: (ctx: Parameters<typeof actual.driveRun>[0]) =>
      actual.driveRun(
        deadline.from === null
          ? ctx
          : {
              ...ctx,
              deadlineMs: 300000,
              elapsed: async () => ctx.host.clock.now() - deadline.from!,
            },
      ),
  }
})
beforeEach(() => {
  deadline.from = null
})

const SESSION = 'b5afcab9-1f3c-4c9b-9df0-f9db36678f92'
const MODEL: ModelInfo = {
  id: 'test-model',
  providerId: 'zhipu',
  contextLimit: 200_000,
  maxOutputTokens: 4096,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}
const usage = (inputTokens = 10) => ({
  inputTokens,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
})
const reply = (text = 'answer', inputTokens = 10) =>
  scriptedTurn({ deltas: [text], usage: usage(inputTokens) })
function harness(model = MODEL, threshold: number | null = 1000, tokenLimit?: number) {
  const logs: string[] = []
  const host = createMemoryHost()
  const store = createMemoryTapeStore({ identity: host.identity })
  const provider = createScriptedProvider({ id: model.providerId, models: [model] })
  const loop = createTestLoopPorts({ connector: { provider, model } })
  const service = createTestSessionService(
    {
      host,
      log: (line) => logs.push(line),
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
      ...(threshold === null ? {} : { compactionThreshold: threshold }),
    },
    { tools: {}, ...(tokenLimit === undefined ? {} : { tokenLimit }) },
  )
  service.bindLoop(loop)
  return { host, store, provider, loop, service, logs }
}
type Harness = ReturnType<typeof harness>
async function send(h: Harness, text = 'question') {
  await h.service.send({ sessionId: SESSION, origin: null, text })
  return h.loop.runEnded()
}
async function entries(h: Harness) {
  return (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
}
async function seed(h: Harness, lastTokens = 2000) {
  for (let i = 0; i < 3; i += 1) {
    h.provider.script(reply(`old${i}`, i === 2 ? lastTokens : 10))
    // oxlint-disable-next-line no-await-in-loop -- successive user turns establish distinct compaction boundaries
    await send(h, `old question ${i}`)
  }
}
function overflow(): StreamEvent[] {
  return [
    { type: 'usage', usage: usage() },
    stopEvent('context-overflow', 'model_context_window_exceeded'),
  ]
}
describe('compaction in a Run', () => {
  it('uses the model threshold, including the small local-model window', () => {
    expect(compactionThreshold({ ...MODEL, contextLimit: 4096 })).toBe(3276)
    expect(compactionThreshold(MODEL)).toBe(150000)
    expect(compactionThreshold({ ...MODEL, contextLimit: 1000000 })).toBe(150000)
  })
  it('summarizes before the first main request, atomically replaces tables, and hides the summary stream', async () => {
    const h = harness()
    await seed(h)
    h.provider.script(reply('PRIVATE_SUMMARY'))
    h.provider.script(reply('visible final'))
    const eventStart = h.loop.recorded.length
    expect((await send(h, 'new question')).reason.code).toBe('completed')
    const facts = await entries(h)
    const anchor = facts.find((e) => e.name === 'compaction/anchor')!
    expect(anchor).toBeDefined()
    // §重建: a boundary cut keeps COMPACT_KEEP_TURNS (2) whole turns before the current one; §摘要请求:
    // it covers through the entry just before them, and stores the summary as sent, wrapped.
    const kept = facts.find(
      (e) => e.name === 'message/user' && JSON.stringify(e.payload).includes('old question 1'),
    )!
    expect(anchor.payload['keepFromEntryId']).toBe(kept.entryId)
    expect(anchor.payload['coversThroughEntryId']).toBe(
      facts.findLast((e) => e.entryId < kept.entryId)?.entryId,
    )
    expect(anchor.payload['summary']).toBe(
      fill(MODEL_NOTES.compactionWrap, { summary: 'PRIVATE_SUMMARY' }),
    )
    const attempts = facts.filter((e) => e.name === 'provider/attempt_completed')
    const summary = attempts.find((e) => e.payload['compaction'] !== undefined)!
    expect(summary.sourceSeq).toBe(1)
    expect(
      (
        await recheckAttempt(h.store, {
          sessionId: SESSION,
          attempt: summary,
          currentModel: () => MODEL,
        })
      ).verdict,
    ).toBe('verified')
    // Invariant 7: every main request keeps the incarnation's frozen system after compaction.
    // Summary requests have a separate prompt and are deliberately outside this comparison.
    const mainAssemblies = attempts
      .filter((attempt) => attempt.payload['compaction'] === undefined)
      .map((attempt) => facts.find((fact) => fact.provenanceKey === attempt.payload['assemblyRef']))
    expect(mainAssemblies.length).toBeGreaterThan(1)
    const originalSystem = mainAssemblies[0]?.payload['systemHash']
    expect(originalSystem).toEqual(expect.any(String))
    expect(mainAssemblies.map((assembly) => assembly?.payload['systemHash'])).toEqual(
      mainAssemblies.map(() => originalSystem),
    )
    expect(attempts.at(-1)?.sourceSeq).toBe(2)
    expect(JSON.stringify(attempts.at(-1)?.payload)).not.toContain('PRIVATE_SUMMARY')
    expect(JSON.stringify(h.loop.recorded.slice(eventStart))).not.toContain('PRIVATE_SUMMARY')
    expect(facts.filter((e) => e.name === 'message/assistant')).toHaveLength(4)
    expect(facts.findLast((e) => e.name === 'view/tool_table')?.payload).toMatchObject({
      generation: 1,
      reason: 'after-compaction',
    })
    const terminal = facts.findLast((e) => e.name === 'execution/run_terminal')!
    expect(terminal.payload['steps']).toBe(0)
    expect(terminal.payload['usage']).toEqual(
      expect.arrayContaining([expect.objectContaining({ outputTokens: 10 })]),
    )
  })
  it('02 不变量 7: keeps the frozen system through a compaction after the interface language changes', async () => {
    const h = harness()
    await seed(h)
    // The next system text would now be assembled in zh-CN; this incarnation's stays en.
    h.loop.setLocale('zh-CN')
    h.provider.script(reply('summary'))
    h.provider.script(reply('after compaction'))
    expect((await send(h, 'new question')).reason.code).toBe('completed')
    h.provider.script(reply('later'))
    expect((await send(h, 'later question')).reason.code).toBe('completed')
    const facts = await entries(h)
    expect(facts.filter((e) => e.name === 'compaction/anchor')).toHaveLength(1)
    const hashes = facts
      .filter((e) => e.name === 'view/assembled')
      .map((e) => e.payload['systemHash'])
    expect(hashes).toHaveLength(6)
    expect(hashes).toEqual(hashes.map(() => hashes[0]))
    const systems = h.provider.requests.map((r) => (r.body as { system?: unknown }).system)
    expect(systems[0]).toEqual(expect.stringContaining(fill(LOCALE_HINT, { locale: 'en' })))
    expect(systems).toEqual(systems.map(() => systems[0]))
    // A new incarnation is where the language changes: its system is assembled in zh-CN.
    await h.service.resetSession(SESSION)
    h.provider.script(reply('fresh'))
    expect((await send(h, 'fresh question')).reason.code).toBe('completed')
    expect((h.provider.requests.at(-1)!.body as { system?: unknown }).system).toEqual(
      expect.stringContaining(fill(LOCALE_HINT, { locale: 'zh-CN' })),
    )
  })
  it('allows only two overflow-compaction-resend cycles and records exactly five requests', async () => {
    const h = harness(MODEL, 100000)
    await seed(h, 10)
    h.provider.script(overflow())
    h.provider.script(reply('summary1'))
    h.provider.script(overflow())
    h.provider.script(reply('summary2'))
    h.provider.script(overflow())
    const before = h.provider.starts
    expect((await send(h)).reason).toEqual({ code: 'context-overflow', compactions: 2 })
    expect(h.provider.starts - before).toBe(5)
    expect((await entries(h)).filter((e) => e.name === 'compaction/anchor')).toHaveLength(2)
  })
  it('does not anchor a truncated summary', async () => {
    const h = harness()
    await seed(h)
    h.provider.script([
      { type: 'text-delta', index: 0, text: 'partial summary' },
      { type: 'usage', usage: usage() },
      stopEvent('max-tokens', 'max_tokens'),
    ])
    expect((await send(h)).reason.code).toBe('provider-error')
    expect((await entries(h)).some((e) => e.name === 'compaction/anchor')).toBe(false)
  })
})

function readCall(tokens = 2000): StreamEvent[] {
  return [
    { type: 'tool-call-start', index: 0, id: 'read1', name: 'Read' },
    {
      type: 'tool-call-end',
      index: 0,
      id: 'read1',
      name: 'Read',
      input: { file_path: `/profiles/user/tenant/tool-output/${SESSION}/file.txt` },
    },
    { type: 'usage', usage: usage(tokens) },
    stopEvent('tool-use', 'tool_use'),
  ]
}
it('02 不变量 9: compacts only older turns mid-turn, then cannot compact the same content again', async () => {
  const h = harness()
  await seed(h, 10)
  h.provider.script(readCall())
  h.provider.script(reply('older turns summary'))
  h.provider.script(readCall())
  h.provider.script(reply('done'))
  expect((await send(h, 'current question')).reason.code).toBe('completed')
  const facts = await entries(h)
  const anchor = facts.find((e) => e.name === 'compaction/anchor')!
  expect(facts.filter((e) => e.name === 'compaction/anchor')).toHaveLength(1)
  const current = facts.find(
    (e) => e.name === 'message/user' && JSON.stringify(e.payload).includes('current question'),
  )!
  expect(anchor.payload['keepFromEntryId']).toBe(current.entryId)
  expect(facts.findLast((e) => e.name === 'execution/run_terminal')?.payload['steps']).toBe(2)
  const summary = h.provider.requests[4]!
  expect(JSON.stringify(summary.body)).not.toContain('current question')
  expect(JSON.stringify(h.provider.requests[5]?.body)).toContain('current question')
  const outputs = facts.filter((e) => e.name === 'tool/result').map((e) => e.payload['content'])
  const body = h.provider.requests[5]!.body as {
    messages: Array<{ content: Array<{ type: string; content?: unknown }> }>
  }
  const replayed = body.messages
    .flatMap((message) => message.content)
    .find((block) => block.type === 'tool_result')
  expect(replayed?.content).toEqual(outputs[0])
})

it('does not compact a prefix-checking model mid-turn, even on overflow, but the next boundary can', async () => {
  const h = harness({ ...MODEL, id: 'claude-opus-5-5' })
  await seed(h, 10)
  h.provider.script(readCall())
  h.provider.script([
    { type: 'usage', usage: usage(2000) },
    stopEvent('context-overflow', 'model_context_window_exceeded'),
  ])
  expect((await send(h)).reason).toEqual({ code: 'context-overflow', compactions: 0 })
  expect((await entries(h)).filter((e) => e.name === 'compaction/anchor')).toEqual([])
  expect(
    (await entries(h)).filter(
      (e) => e.name === 'provider/attempt_completed' && e.payload['compaction'] !== undefined,
    ),
  ).toEqual([])
  h.provider.script(reply('summary'))
  h.provider.script(reply('done'))
  expect((await send(h, 'next boundary')).reason.code).toBe('completed')
  expect((await entries(h)).filter((e) => e.name === 'compaction/anchor')).toHaveLength(1)
})

it('aborts a partial summary without an anchor or visible assistant content', async () => {
  const h = harness()
  await seed(h)
  const stream = h.provider.stream.bind(h.provider)
  h.provider.stream = (encoded, ctx) => {
    const original = stream(encoded, ctx)
    return (async function* () {
      for await (const event of original) {
        yield event
        if (event.type === 'text-delta' && event.text === 'partial')
          await h.service.stop({ rootSessionId: SESSION })
      }
    })()
  }
  h.provider.script(reply('partial'))
  expect((await send(h)).reason.code).toBe('user-stopped')
  const facts = await entries(h)
  expect(facts.some((e) => e.name === 'compaction/anchor')).toBe(false)
  expect(facts.filter((e) => e.name === 'message/assistant')).toHaveLength(3)
  expect(JSON.stringify(h.loop.recorded)).not.toContain('partial')
})

it('ends as stopped with no anchor when the stop reaches the anchor write first', async () => {
  const h = harness()
  await seed(h)
  // A message sent while the summary is out holds the mailbox until the case lets it go, so the
  // anchor's write task waits behind it, past the Run's last look at the signal.
  const gate = Promise.withResolvers<void>()
  const enqueue = h.loop.queue.enqueue.bind(h.loop.queue)
  h.loop.queue.enqueue = async (...args) => {
    await gate.promise
    return enqueue(...args)
  }
  const summarized = Promise.withResolvers<void>()
  let queued: Promise<unknown> | undefined
  const append = h.store.append.bind(h.store)
  h.store.append = async (batch) => {
    const written = await append(batch)
    if (
      batch.entries.some(
        (e) => e.name === 'provider/attempt_completed' && e.payload['compaction'] !== undefined,
      )
    ) {
      queued ??= h.service.send({ sessionId: SESSION, origin: null, text: 'one more thing' })
      summarized.resolve()
    }
    return written
  }
  h.provider.script(reply('summary'))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'new question' })
  await summarized.promise
  await new Promise((resolve) => {
    setTimeout(resolve, 20)
  })
  expect(await h.service.stop({ rootSessionId: SESSION })).toEqual({ stopped: true })
  gate.resolve()
  const ended = await h.loop.runEnded()
  expect(ended.reason).toEqual({ code: 'user-stopped' })
  expect(ended.recorded).toBe(true)
  expect(await queued).toMatchObject({ status: 'queued' })
  const facts = await entries(h)
  expect(facts.some((e) => e.name === 'compaction/anchor')).toBe(false)
  expect(facts.filter((e) => e.name === 'execution/run_terminal')).toHaveLength(
    facts.filter((e) => e.name === 'execution/run_started').length,
  )
  // The summary attempt's usage is still this Run's (H11).
  expect(facts.findLast((e) => e.name === 'execution/run_terminal')?.payload['usage']).toEqual(
    expect.arrayContaining([expect.objectContaining({ requests: 1, outputTokens: 5 })]),
  )
  expect(h.logs).toEqual([])
})

it('does not send an overflow summary after the main attempt exhausts the token limit', async () => {
  const h = harness(MODEL, 100000, 100)
  await seed(h, 10)
  const before = h.provider.starts
  h.provider.script([
    { type: 'usage', usage: usage(101) },
    stopEvent('context-overflow', 'model_context_window_exceeded'),
  ])
  expect((await send(h)).reason).toEqual({ code: 'usage-limit', tokenLimit: 100 })
  expect(h.provider.starts - before).toBe(1)
  expect((await entries(h)).some((e) => e.name === 'compaction/anchor')).toBe(false)
})

it('drops thinking produced after a mid-turn anchor at the next boundary and its tool continuation', async () => {
  const h = harness({ ...MODEL, reasoning: true, thinkingPreservationFormat: 'signed-blocks' })
  await seed(h, 10)
  h.provider.script(readCall())
  h.provider.script(reply('summary'))
  h.provider.script([
    { type: 'thinking-delta', index: 2, text: 'AFTER_ANCHOR_THINKING' },
    { type: 'thinking-signature', index: 2, signature: 'signed-after-anchor' },
    ...readCall(10),
  ])
  h.provider.script(reply('done'))
  await send(h, 'compacted turn')
  expect(JSON.stringify(h.provider.requests.at(-1)?.body)).toContain('AFTER_ANCHOR_THINKING')
  expect(JSON.stringify(h.provider.requests.at(-1)?.body)).toContain('signed-after-anchor')
  h.provider.script(readCall(10))
  h.provider.script(reply('next done'))
  const before = h.provider.starts
  await send(h, 'next boundary')
  expect(h.provider.starts - before).toBe(2)
  expect((await entries(h)).filter((e) => e.name === 'compaction/anchor')).toHaveLength(1)
  for (const request of h.provider.requests.slice(before))
    expect(request.thinkingDecisions).toContainEqual({ action: 'drop', reason: 'compacted' })
  for (const request of h.provider.requests.slice(before)) {
    expect(JSON.stringify(request.body)).not.toContain('AFTER_ANCHOR_THINKING')
    expect(JSON.stringify(request.body)).not.toContain('signed-after-anchor')
  }
})

it('02 不变量 9: keeps the current turn’s thinking through a mid-turn compaction until the next boundary', async () => {
  const h = harness({ ...MODEL, reasoning: true, thinkingPreservationFormat: 'signed-blocks' })
  await seed(h, 10)
  h.provider.script([
    { type: 'thinking-delta', index: 2, text: 'BEFORE_ANCHOR_THINKING' },
    { type: 'thinking-signature', index: 2, signature: 'signed-before-anchor' },
    ...readCall(),
  ])
  h.provider.script(reply('summary'))
  h.provider.script(readCall(10))
  h.provider.script(reply('done'))
  expect((await send(h, 'compacted turn')).reason.code).toBe('completed')
  expect((await entries(h)).filter((e) => e.name === 'compaction/anchor')).toHaveLength(1)
  // Requests 0–2 are the seed, 3 made the call, 4 is the summary; the turn goes on in 5 and 6.
  const after = h.provider.requests.slice(5)
  expect(after).toHaveLength(2)
  for (const request of after) {
    expect(JSON.stringify(request.body)).toContain('BEFORE_ANCHOR_THINKING')
    expect(JSON.stringify(request.body)).toContain('signed-before-anchor')
    expect(request.thinkingDecisions).not.toContainEqual({ action: 'drop', reason: 'compacted' })
  }
  // The next boundary request ends the exception: the block is dropped as compacted.
  h.provider.script(reply('next done'))
  await send(h, 'next boundary')
  const next = h.provider.requests.at(-1)!
  expect(JSON.stringify(next.body)).not.toContain('BEFORE_ANCHOR_THINKING')
  expect(next.thinkingDecisions).toContainEqual({ action: 'drop', reason: 'compacted' })
})

/** The Anthropic body the scripted provider encodes, as far as 02 不变量 8 reads it. */
interface PrefixBody {
  readonly system?: unknown
  readonly tools?: unknown
  readonly messages: readonly { readonly content: unknown }[]
}
function thinkingOf(message: { readonly content: unknown }): string[] {
  if (!Array.isArray(message.content)) return []
  return (message.content as { type: string; signature?: string }[])
    .filter((block) => block.type === 'thinking')
    .map((block) => String(block.signature))
}
/**
 * 02 不变量 8: every thinking block a request carries went out under the prefix it was produced in —
 * the producing request's system, tools and messages, byte for byte, right before it.
 */
function assertThinkingPrefixes(
  requests: readonly EncodedRequest[],
  producedBy: ReadonlyMap<string, number>,
): void {
  for (const [at, request] of requests.entries()) {
    const body = request.body as PrefixBody
    for (const [index, message] of body.messages.entries()) {
      for (const signature of thinkingOf(message)) {
        const producer = producedBy.get(signature)
        if (producer === undefined) throw new Error(`request ${String(at)}: unknown ${signature}`)
        const origin = requests[producer]!.body as PrefixBody
        expect(index, `request ${String(at)}: ${signature} position`).toBe(origin.messages.length)
        expect(JSON.stringify(body.system), `request ${String(at)}: system`).toBe(
          JSON.stringify(origin.system),
        )
        expect(JSON.stringify(body.tools), `request ${String(at)}: tools`).toBe(
          JSON.stringify(origin.tools),
        )
        expect(JSON.stringify(body.messages.slice(0, index)), `request ${String(at)}: prefix`).toBe(
          JSON.stringify(origin.messages),
        )
      }
    }
  }
}
function thinking(tag: string): StreamEvent[] {
  return [
    { type: 'thinking-delta', index: 2, text: `THINKING_${tag}` },
    { type: 'thinking-signature', index: 2, signature: `sig-${tag}` },
  ]
}

it('02 不变量 8: after a boundary compaction, echoes each later thinking block under its own prefix', async () => {
  // A prefix-checking model: no mid-turn compaction, so no window is exempt.
  const h = harness({
    ...MODEL,
    id: 'claude-opus-5-5',
    reasoning: true,
    thinkingPreservationFormat: 'signed-blocks',
  })
  for (let i = 0; i < 3; i += 1) {
    h.provider.script([...thinking(String(i)), ...reply(`old${i}`, i === 2 ? 2000 : 10)])
    // oxlint-disable-next-line no-await-in-loop -- successive user turns establish distinct compaction boundaries
    await send(h, `old question ${i}`)
  }
  // Turn T compacts at its boundary, then thinks and calls; T+1 thinks and calls; T+2 answers.
  h.provider.script(reply('summary'))
  h.provider.script([...thinking('T'), ...readCall(10)])
  h.provider.script(reply('T done'))
  expect((await send(h, 'turn T')).reason.code).toBe('completed')
  h.provider.script([...thinking('U'), ...readCall(10)])
  h.provider.script(reply('U done'))
  expect((await send(h, 'turn T+1')).reason.code).toBe('completed')
  h.provider.script(reply('V done'))
  expect((await send(h, 'turn T+2')).reason.code).toBe('completed')
  expect((await entries(h)).filter((e) => e.name === 'compaction/anchor')).toHaveLength(1)

  const requests = h.provider.requests
  expect(requests).toHaveLength(9)
  assertThinkingPrefixes(
    requests,
    new Map([
      ['sig-0', 0],
      ['sig-1', 1],
      ['sig-2', 2],
      ['sig-T', 4],
      ['sig-U', 6],
    ]),
  )
  const echoes = (signature: string) =>
    requests.flatMap((request, at) =>
      (request.body as PrefixBody).messages.some((m) => thinkingOf(m).includes(signature))
        ? [at]
        : [],
    )
  // The kept tail loses its thinking at the anchor (request 3 is the summary)...
  expect(echoes('sig-1')).toEqual([2])
  expect(echoes('sig-2')).toEqual([])
  // ...and what was written after it goes on being echoed, its prefix unchanged, in later turns.
  expect(echoes('sig-T')).toEqual([5, 6, 7, 8])
  expect(echoes('sig-U')).toEqual([7, 8])
  for (const request of requests.slice(6))
    expect(request.thinkingDecisions.filter((d) => d.action === 'drop')).toHaveLength(2)
})

it('Revisions 32: after a mid-turn anchor, later turns keep the cut at the first boundary', async () => {
  const h = harness({ ...MODEL, reasoning: true, thinkingPreservationFormat: 'signed-blocks' })
  await seed(h, 10)
  // Turn T compacts mid-turn and thinks in the exempt window; T+1 is the first boundary after the
  // anchor and thinks before a tool round; T+2 is the second boundary.
  h.provider.script(readCall())
  h.provider.script(reply('summary'))
  h.provider.script([...thinking('W'), ...readCall(10)])
  h.provider.script(reply('T done'))
  expect((await send(h, 'turn T')).reason.code).toBe('completed')
  h.provider.script([...thinking('B1'), ...readCall(10)])
  h.provider.script(reply('T+1 done'))
  expect((await send(h, 'turn T+1')).reason.code).toBe('completed')
  h.provider.script(reply('T+2 done'))
  expect((await send(h, 'turn T+2')).reason.code).toBe('completed')
  expect((await entries(h)).filter((e) => e.name === 'compaction/anchor')).toHaveLength(1)

  // Requests 0–2 are the seed, 3 made the call, 4 is the summary, 5–6 finish T, 7–8 are T+1.
  const requests = h.provider.requests
  expect(requests).toHaveLength(10)
  assertThinkingPrefixes(
    requests,
    new Map([
      ['sig-W', 5],
      ['sig-B1', 7],
    ]),
  )
  const echoes = (signature: string) =>
    requests.flatMap((request, at) =>
      (request.body as PrefixBody).messages.some((m) => thinkingOf(m).includes(signature))
        ? [at]
        : [],
    )
  // The window's block ends at T+1; T+1's own block goes on at T+2, cut at T+1's run_started.
  expect(echoes('sig-W')).toEqual([6])
  expect(echoes('sig-B1')).toEqual([8, 9])
  for (const request of requests.slice(7))
    expect(request.thinkingDecisions.filter((d) => d.action === 'drop')).toEqual([
      { action: 'drop', reason: 'compacted' },
    ])
})

it('stops while reopening a historical provider whose assembly never resolves', async () => {
  const h = harness()
  await seed(h)
  const model = { ...MODEL, providerId: 'anthropic', id: 'other-model' }
  const other = createScriptedProvider({ id: model.providerId, models: [model] })
  h.loop.connector.use({ provider: other, model })
  await h.service.selectModel({
    sessionId: SESSION,
    origin: null,
    choice: { providerId: model.providerId, modelId: model.id, effort: null },
  })
  const assemble = h.loop.connector.assemble.bind(h.loop.connector)
  const reached = Promise.withResolvers<void>()
  h.loop.connector.assemble = (q) => {
    if (q.choice.providerId === MODEL.providerId) {
      reached.resolve()
      return new Promise(() => {})
    }
    return assemble(q)
  }
  other.script(reply('completed summary'))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'new provider' })
  await reached.promise
  await h.service.stop({ rootSessionId: SESSION })
  expect((await h.loop.runEnded()).reason.code).toBe('user-stopped')
  expect(h.loop.liveLease(SESSION)).toBeNull()
  const facts = await entries(h)
  expect(facts.some((e) => e.name === 'compaction/anchor')).toBe(false)
  expect(
    facts.some((e) => e.name === 'view/tool_table' && e.payload['reason'] === 'after-compaction'),
  ).toBe(false)
  expect(facts.findLast((e) => e.name === 'execution/run_terminal')?.payload['usage']).toEqual(
    expect.arrayContaining([expect.objectContaining({ outputTokens: 5 })]),
  )
})

it('ends the thinking exception on a whole-turn continue without a new message', async () => {
  const h = harness({ ...MODEL, reasoning: true, thinkingPreservationFormat: 'signed-blocks' })
  await seed(h, 10)
  h.provider.script(readCall())
  h.provider.script(reply('summary'))
  h.provider.script([
    { type: 'thinking-delta', index: 2, text: 'OLD_PRIVATE_THINKING' },
    { type: 'thinking-signature', index: 2, signature: 'old-signature' },
    ...readCall(10),
  ])
  h.provider.script([stopEvent('max-tokens', 'max_tokens')])
  expect((await send(h)).reason.code).toBe('output-truncated')
  const before = h.provider.starts
  h.provider.script(readCall(10))
  h.provider.script(reply('continued'))
  await h.service.continueRun({ sessionId: SESSION, origin: null })
  expect((await h.loop.runEnded()).reason.code).toBe('completed')
  expect(h.provider.starts - before).toBe(2)
  for (const request of h.provider.requests.slice(before)) {
    expect(JSON.stringify(request.body)).not.toContain('OLD_PRIVATE_THINKING')
    expect(JSON.stringify(request.body)).not.toContain('old-signature')
  }
})

it('estimates each wire cache accounting and excludes summaries and pre-anchor usage', async () => {
  const { estimateInput, roughTokens } = await import('../../src/loop/compaction.js')
  const h = harness(MODEL, 100000)
  h.provider.script(reply())
  await send(h)
  const fact = (await entries(h)).find((e) => e.name === 'provider/attempt_completed')!
  const request = { model: MODEL, messages: [], maxTokens: 4096 }
  const u = { ...usage(100), outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }
  const anthropic = {
    ...fact,
    payload: { ...fact.payload, usage: u, encoder: { wire: 'anthropic-messages' } },
  }
  const openai = {
    ...anthropic,
    payload: { ...anthropic.payload, encoder: { wire: 'openai-chat' } },
  }
  expect(estimateInput([anthropic], request)).toBe(190)
  expect(estimateInput([openai], request)).toBe(120)
  const summary = {
    ...anthropic,
    entryId: fact.entryId + 1,
    payload: { ...anthropic.payload, compaction: {} },
  }
  expect(estimateInput([openai, summary], request)).toBe(120)
  const anchor = { ...fact, entryId: fact.entryId + 2, name: 'compaction/anchor' }
  expect(estimateInput([openai, summary, anchor], request)).toBe(roughTokens({ messages: [] }))
})

it.each([
  [undefined, {}],
  ['budget', { thinking: { enabled: false } }],
  ['adaptive', { thinking: { enabled: false } }],
  ['adaptive-gated', { thinking: { enabled: false }, effort: 'high' }],
  ['always-on', {}],
  ['effort-only', {}],
] as const)('uses the documented summary thinking mode %s', async (mode, expected) => {
  const { summaryThinking } = await import('../../src/loop/compaction.js')
  expect(
    summaryThinking({
      ...MODEL,
      ...(mode === undefined
        ? {}
        : { thinkingSpec: { mode, defaultOn: true, disableMaxEffort: 'high' } }),
    }),
  ).toEqual(expected)
})

// §摘要请求「思考参数」, the rows a session can pick an effort on (budget and the rows without a
// thinkingSpec list no levels). The row's own levels, defaults and displays are the built-in ones.
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const SHOWN = { displays: ['summarized', 'omitted'], defaultDisplay: 'omitted' } as const
it.each([
  [
    'adaptive',
    { mode: 'adaptive', defaultOn: true, effortLevels: LEVELS, defaultEffort: 'high', ...SHOWN },
    { thinking: { enabled: false } },
    { thinking: { type: 'disabled' } },
  ],
  [
    'adaptive-gated',
    {
      mode: 'adaptive-gated',
      defaultOn: true,
      effortLevels: LEVELS,
      defaultEffort: 'high',
      disableMaxEffort: 'high',
      ...SHOWN,
    },
    { thinking: { enabled: false }, effort: 'high' },
    { thinking: { type: 'disabled' }, output_config: { effort: 'high' } },
  ],
  [
    'always-on',
    { mode: 'always-on', defaultOn: true, effortLevels: LEVELS, defaultEffort: 'medium', ...SHOWN },
    {},
    {},
  ],
  [
    'effort-only',
    {
      mode: 'effort-only',
      defaultOn: true,
      effortLevels: ['low', 'high', 'max'],
      defaultEffort: 'max',
    },
    {},
    {},
  ],
] as const)(
  'does not carry the session effort or display into the summary request on a %s row',
  async (mode, thinkingSpec, snapshot, wire) => {
    const model: ModelInfo = { ...MODEL, reasoning: true, thinkingSpec }
    const h = harness(model)
    // effort-only rows belong to the openai-chat wire; the scripted stream is the same.
    if (mode === 'effort-only') h.provider.encode = (req) => encodeOpenAIChat(req, 'zhipu')
    await h.service.selectModel({
      sessionId: SESSION,
      origin: null,
      choice: { providerId: model.providerId, modelId: model.id, effort: 'low' },
    })
    await seed(h)
    h.provider.script(reply('summary'))
    h.provider.script(reply('done'))
    expect((await send(h, 'new question')).reason.code).toBe('completed')
    const attempts = (await entries(h)).filter((e) => e.name === 'provider/attempt_completed')
    const at = attempts.findIndex((e) => e.payload['compaction'] !== undefined)
    expect(at).toBe(3)
    // The main requests carry the session's effort (and display while thinking is on)...
    const display = mode === 'effort-only' ? {} : { display: 'summarized' }
    for (const main of [attempts[at - 1]!, attempts[at + 1]!])
      expect(main.payload['request']).toMatchObject({ effort: 'low', ...display })
    // ...the summary request carries exactly the row's thinking parameters, and no display.
    expect(attempts[at]!.payload['request']).toEqual({
      systemHash: expect.any(String),
      maxTokens: expect.any(Number),
      dropThinkingBefore: expect.any(Number),
      ...snapshot,
    })
    const body = h.provider.requests[at]!.body as Record<string, unknown>
    expect({
      thinking: body['thinking'],
      output_config: body['output_config'],
      reasoning_effort: body['reasoning_effort'],
    }).toEqual(wire)
  },
)

it('handles a context-overflow error signal as a compactable payload', async () => {
  const h = harness(MODEL, 100000)
  await seed(h, 10)
  h.provider.script([
    {
      type: 'error',
      code: 'context-overflow',
      retryable: false,
      providerCode: 'too_large',
      detail: 'test error',
    },
  ])
  h.provider.script(reply('summary'))
  h.provider.script(reply('done'))
  const before = h.provider.starts
  expect((await send(h)).reason.code).toBe('completed')
  expect(h.provider.starts - before).toBe(3)
})

it('retries one summary payload with shared request identity and usage but no step', async () => {
  const h = harness()
  await seed(h)
  h.provider.retryAdvice = () => ({ maxAttempts: 2, baseDelayMs: 0 })
  const schedule = h.host.clock.setTimeout.bind(h.host.clock)
  h.host.clock.setTimeout = (fn, ms) => {
    if (ms === 0) {
      void Promise.resolve().then(fn)
      return () => {}
    }
    return schedule(fn, ms)
  }
  h.provider.script([
    { type: 'usage', usage: usage() },
    {
      type: 'error',
      code: 'rate-limit',
      retryable: true,
      providerCode: null,
      detail: 'test error',
      retryAfterMs: 0,
    },
  ])
  h.provider.script(reply('summary'))
  h.provider.script(reply('done'))
  expect((await send(h)).reason.code).toBe('completed')
  const facts = await entries(h)
  const summary = facts.filter(
    (e) => e.name === 'provider/attempt_completed' && e.payload['compaction'] !== undefined,
  )
  expect(summary.map((e) => [e.sourceSeq, Number(e.provenanceKey.split(':').at(-1))])).toEqual([
    [1, 1],
    [1, 2],
  ])
  const terminal = facts.findLast((e) => e.name === 'execution/run_terminal')!
  expect(terminal.payload['steps']).toBe(0)
  expect(terminal.payload['usage']).toEqual(
    expect.arrayContaining([expect.objectContaining({ outputTokens: 15 })]),
  )
})

it('atomically refreshes every used provider table and re-admits tools whose policy ban was revoked', async () => {
  const h = harness()
  h.host.setPolicy({
    status: 'current',
    version: 'deny-read',
    snapshot: {
      tools: [{ policyId: 'no-read', serverId: 'builtin', toolName: 'Read', effect: 'deny' }],
    },
  })
  await seed(h, 10)
  const model = { ...MODEL, providerId: 'anthropic', id: 'other-model' }
  const other = createScriptedProvider({ id: model.providerId, models: [model] })
  h.loop.connector.use({ provider: other, model })
  await h.service.selectModel({
    sessionId: SESSION,
    origin: null,
    choice: { providerId: model.providerId, modelId: model.id, effort: null },
  })
  other.script(reply('other answer', 2000))
  await send(h)
  h.loop.connector.use({ provider: h.provider, model: MODEL, models: [MODEL, model] })
  await h.service.selectModel({
    sessionId: SESSION,
    origin: null,
    choice: { providerId: MODEL.providerId, modelId: MODEL.id, effort: null },
  })
  h.host.setPolicy({ status: 'current', version: 'allowed', snapshot: { tools: [] } })
  const batches: string[][] = []
  const append = h.store.append.bind(h.store)
  h.store.append = (batch) => {
    batches.push(batch.entries.map((e) => e.name))
    return append(batch)
  }
  h.provider.script(reply('summary'))
  h.provider.script(reply('done'))
  expect((await send(h)).reason).toEqual({ code: 'completed' })
  const facts = await entries(h)
  const old = facts.filter((e) => e.name === 'view/tool_table' && e.payload['generation'] === 0)
  expect(old).toHaveLength(2)
  for (const table of old)
    expect(table.payload['excluded']).toEqual(
      expect.arrayContaining([expect.objectContaining({ originalName: 'Read', code: 'policy' })]),
    )
  const fresh = facts.filter((e) => e.name === 'view/tool_table' && e.payload['generation'] === 1)
  expect(fresh.map((e) => e.payload['providerId']).toSorted()).toEqual(['anthropic', 'zhipu'])
  for (const table of fresh)
    expect(table.payload['tools']).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Read' })]),
    )
  expect(batches.filter((batch) => batch.includes('compaction/anchor'))).toEqual([
    expect.arrayContaining(['compaction/anchor', 'view/tool_table', 'view/tool_table']),
  ])
})

it.each([
  [3000, false],
  [4000, true],
] as const)(
  'uses the newly selected 4096 window rather than the previous 200k window (%i)',
  async (tokens, compacted) => {
    const h = harness(MODEL, null)
    await seed(h, tokens)
    const small = { ...MODEL, id: 'small-model', contextLimit: 4096 }
    h.loop.connector.use({ provider: h.provider, model: small, models: [MODEL, small] })
    await h.service.selectModel({
      sessionId: SESSION,
      origin: null,
      choice: { providerId: small.providerId, modelId: small.id, effort: null },
    })
    if (compacted) h.provider.script(reply('summary'))
    h.provider.script(reply('done'))
    await send(h, 'x')
    expect((await entries(h)).some((e) => e.name === 'compaction/anchor')).toBe(compacted)
  },
)

it.each([
  [4096, 3262, false],
  [4096, 3264, true],
  [200000, 149986, false],
  [200000, 149988, true],
] as const)(
  'checks one token either side of the %i context threshold (input %i)',
  async (contextLimit, inputTokens, compacted) => {
    const h = harness({ ...MODEL, contextLimit }, null)
    // Final output contributes 5 tokens; the new user content contributes 8 at chars/4.
    // These totals are threshold - 1 and threshold + 1 for each documented window.
    await seed(h, inputTokens)
    if (compacted) h.provider.script(reply('summary'))
    h.provider.script(reply('done'))
    const before = h.provider.starts
    expect((await send(h, 'x')).reason.code).toBe('completed')
    expect(h.provider.starts - before).toBe(compacted ? 2 : 1)
    expect((await entries(h)).some((e) => e.name === 'compaction/anchor')).toBe(compacted)
  },
)

it('does not treat resumed Runs or inserted user messages as new compaction turns', async () => {
  const { compactionCut, turnStarts, isBoundaryRun } = await import('../../src/loop/compaction.js')
  const h = harness(MODEL, 100000)
  await seed(h, 10)
  const facts = await entries(h)
  const before = turnStarts(facts)
  const start = facts.findLast((e) => e.name === 'execution/run_started')!
  const user = facts.findLast((e) => e.name === 'message/user')!
  const after = [
    ...facts,
    {
      ...user,
      entryId: facts.at(-1)!.entryId + 1,
      payload: { ...user.payload, messageId: 'inserted' },
    },
    {
      ...start,
      entryId: facts.at(-1)!.entryId + 2,
      sourceId: 'resumed',
      payload: {
        ...start.payload,
        cause: {
          kind: 'resume',
          pausedRunId: start.sourceId,
          batch: { runId: start.sourceId, requestSeq: 1 },
        },
      },
    },
  ]
  expect(turnStarts(after)).toEqual(before)
  expect(isBoundaryRun(after, 'resumed')).toBe(false)
  expect(compactionCut(after, false)?.keepFromEntryId).toBe(before.at(-1))
})

it.each(['refusal', 'context-overflow'] as const)(
  'preserves terminal %s when over limit and no further request is eligible',
  async (reason) => {
    const h = harness(MODEL, 100000, 100)
    h.provider.script([{ type: 'usage', usage: usage(101) }, stopEvent(reason, reason)])
    const ended = await send(h)
    expect(ended.reason.code).toBe(reason)
    expect(ended.reason).toMatchObject(
      reason === 'context-overflow' ? { code: reason, compactions: 0 } : { code: reason },
    )
    expect(h.provider.starts).toBe(1)
    expect((await entries(h)).some((e) => e.name === 'compaction/anchor')).toBe(false)
  },
)

it('does not attempt to summarize a first-turn overflow with no older content', async () => {
  const h = harness()
  h.provider.script(overflow())
  expect((await send(h)).reason).toEqual({ code: 'context-overflow', compactions: 0 })
  expect(h.provider.starts).toBe(1)
  expect((await entries(h)).some((e) => e.name === 'compaction/anchor')).toBe(false)
})

it('ends summary overflow without an anchor or main resend', async () => {
  const h = harness()
  await seed(h)
  h.provider.script(overflow())
  const before = h.provider.starts
  expect((await send(h)).reason).toEqual({ code: 'context-overflow', compactions: 0 })
  expect(h.provider.starts - before).toBe(1)
  expect((await entries(h)).some((e) => e.name === 'compaction/anchor')).toBe(false)
})

it('exhausts summary retries without an anchor or visible partial content', async () => {
  const h = harness()
  await seed(h)
  h.provider.retryAdvice = () => ({ maxAttempts: 2, baseDelayMs: 0 })
  const schedule = h.host.clock.setTimeout.bind(h.host.clock)
  h.host.clock.setTimeout = (fn, ms) => {
    if (ms === 0) {
      void Promise.resolve().then(fn)
      return () => {}
    }
    return schedule(fn, ms)
  }
  const fail: StreamEvent[] = [
    { type: 'text-delta', index: 0, text: 'hidden partial summary' },
    {
      type: 'error',
      code: 'rate-limit',
      retryable: true,
      providerCode: null,
      detail: 'test error',
      retryAfterMs: 0,
    },
  ]
  h.provider.script(fail)
  h.provider.script(fail)
  const before = h.provider.starts
  expect((await send(h)).reason).toMatchObject({ code: 'provider-error', attempts: 2 })
  expect(h.provider.starts - before).toBe(2)
  const facts = await entries(h)
  expect(facts.some((e) => e.name === 'compaction/anchor')).toBe(false)
  expect(facts.filter((e) => e.name === 'message/assistant')).toHaveLength(3)
  expect(JSON.stringify(h.loop.recorded)).not.toContain('hidden partial summary')
})

it.each(['context-overflow', 'max-tokens', 'rate-limit', 'end-turn'] as const)(
  'preserves summary terminal semantics over the usage cap: %s',
  async (reason) => {
    const h = harness(MODEL, 100000, 100)
    await seed(h, 10)
    h.provider.script(overflow())
    h.provider.retryAdvice = () => ({ maxAttempts: 1, baseDelayMs: 0 })
    h.provider.script([
      { type: 'usage', usage: usage(101) },
      reason === 'rate-limit'
        ? { type: 'error', code: 'rate-limit', retryable: true, providerCode: null, detail: 'test' }
        : stopEvent(reason, reason),
    ])
    const ended = await send(h)
    expect(ended.reason.code).toBe(
      reason === 'context-overflow'
        ? 'context-overflow'
        : reason === 'end-turn'
          ? 'usage-limit'
          : 'provider-error',
    )
    expect(ended.errorCode).toBe(reason === 'rate-limit' ? 'rate-limit' : null)
    expect((await entries(h)).some((e) => e.name === 'compaction/anchor')).toBe(false)
  },
)

it.each(['error', 'stop'] as const)(
  'reports the summary overflow %s as the ending attempt metadata',
  async (signal) => {
    const h = harness()
    await seed(h)
    h.provider.script(
      signal === 'error'
        ? [
            {
              type: 'error',
              code: 'context-overflow',
              retryable: false,
              providerCode: '1261',
              detail: 'too large',
            },
          ]
        : overflow(),
    )
    const ended = await send(h)
    expect(ended.reason).toEqual({ code: 'context-overflow', compactions: 0 })
    expect(ended.errorCode).toBe(signal === 'error' ? 'context-overflow' : null)
    expect(ended.lastStop).toBe(signal === 'error' ? null : 'context-overflow')
  },
)

it('02 不变量 29: sends an overflow summary past the deadline but not the next main payload', async () => {
  const h = harness(MODEL, 100000)
  await seed(h, 10)
  deadline.from = h.host.clock.now()
  let crossed = false
  const stream = h.provider.stream.bind(h.provider)
  h.provider.stream = (encoded, ctx) => {
    const source = stream(encoded, ctx)
    return (async function* () {
      for await (const event of source) {
        yield event
        if (!crossed && event.type === 'text-delta' && event.text === 'cross summary deadline') {
          crossed = true
          h.host.advance(300000)
        }
      }
    })()
  }
  h.provider.script([
    { type: 'text-delta', index: 0, text: 'cross summary deadline' },
    ...overflow(),
  ])
  h.provider.script(reply('summary completed after the deadline'))
  const before = h.provider.starts
  expect((await send(h)).reason).toEqual({ code: 'time-limit', limitMs: 300000 })
  expect(h.provider.starts - before).toBe(2)
  const facts = await entries(h)
  expect(facts.filter((entry) => entry.name === 'compaction/anchor')).toHaveLength(1)
  const attempts = facts.filter((entry) => entry.name === 'provider/attempt_completed').slice(-2)
  expect(attempts[0]!.payload['compaction']).toBeUndefined()
  expect(attempts[1]!.payload['compaction']).toBeDefined()
  expect(attempts.map((attempt) => attempt.sourceSeq)).toEqual([
    expect.any(Number),
    expect.any(Number),
  ])
  expect(attempts[1]!.sourceSeq).toBeGreaterThan(attempts[0]!.sourceSeq!)
  expect(JSON.stringify(h.provider.requests.at(-1)!.body)).toContain('old question 0')
})
