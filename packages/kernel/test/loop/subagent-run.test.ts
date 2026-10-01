import { subagentElapsedFromTape } from '../../src/loop/subagent.js'
import { encodeOpenAIChat } from '../../src/provider/wire/openai-chat.js'
import { SPILL_PREVIEW_CHARS } from '../../src/loop/spill.js'
import type { SessionEvent } from '../../src/loop/events.js'
import { expect, it } from 'vitest'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type { ModelInfo, StreamEvent } from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
const SESSION = '7c4e9a2e-6b3d-4a71-9f52-0c8de7a11b37'
const MODEL: ModelInfo = {
  id: 'child-model',
  providerId: 'anthropic',
  contextLimit: 200000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}
const usage = {
  inputTokens: 9,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}
function call(name: string, input: Record<string, unknown>, id = 'tool1'): StreamEvent[] {
  return [
    { type: 'tool-call-start', index: 0, id, name },
    { type: 'tool-call-end', index: 0, id, name, input },
    { type: 'usage', usage },
    stopEvent('tool-use', 'tool_use'),
  ]
}
function harness(tokenLimit?: number, onEvent?: (event: SessionEvent) => void) {
  const host = createMemoryHost()
  const store = createMemoryTapeStore({ identity: host.identity })
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({
    connector: { provider, model: MODEL },
    ...(onEvent === undefined ? {} : { onEvent }),
  })
  const logs: string[] = []
  const service = createTestSessionService(
    {
      host,
      tape: store,
      ids: createCounterIds(),
      connector: loop.connector,
      inspectors: [],
      protectedFiles: [],
      log: (line) => logs.push(line),
    },
    { tools: { Agent: 'real' }, ...(tokenLimit === undefined ? {} : { tokenLimit }) },
  )
  service.bindLoop(loop)
  return { host, store, provider, loop, service, logs }
}
async function setup(h: ReturnType<typeof harness>) {
  await h.service.selectProfile({
    sessionId: SESSION,
    profile: 'cowork',
    dedicated: absolutePath('/work'),
  })
}
it('runs a child under its parent lease and records one mechanical handoff with separate usage', async () => {
  const h = harness()
  await setup(h)
  h.provider.script(call('Agent', { description: 'check task', prompt: 'do child work' }))
  h.provider.script(scriptedTurn({ deltas: ['child answer'], usage }))
  h.provider.script(scriptedTurn({ deltas: ['parent answer'], usage }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'parent task' })
  const end = await rootEnd(h.loop)
  expect(end.reason).toEqual({ code: 'completed' })
  expect(h.logs).toEqual([])
  expect(h.loop.leaseLog).toHaveLength(1)
  expect(h.loop.liveLease(SESSION)).toBeNull()
  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  const link = parent.find((e) => e.name === 'session/parent_link')!
  expect(link).toBeDefined()
  const childId = (link.payload['child'] as { sessionId: string }).sessionId
  const child = (await h.store.readRange({ sessionId: childId, limit: 1000 })).entries
  expect(child.find((e) => e.name === 'session/profile_set')?.payload).toMatchObject({
    profile: 'cowork',
    subagentOf: { sessionId: SESSION, linkKey: link.provenanceKey },
  })
  expect(child.some((e) => e.name === 'session/workspace_set')).toBe(false)
  const table = child.find((e) => e.name === 'view/tool_table')!.payload['tools'] as {
    name: string
  }[]
  expect(table.some((t) => t.name === 'Agent' || t.name === 'AskUserQuestion')).toBe(false)
  expect(parent.find((e) => e.name === 'tool/result')?.payload['handoff']).toMatchObject({
    outcome: 'completed',
    finalReply: 'child answer',
  })
  expect(parent.findLast((e) => e.name === 'execution/run_terminal')?.payload['usage']).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ origin: 'subagent', requests: 1, inputTokens: 9 }),
    ]),
  )
})

// H9 for everyone (Revisions 31, owner 2026-10-01): a long handoff is the spill file's alone.
it('spills a long handoff: the Agent result and its handoff keep only the start', async () => {
  const h = harness()
  await setup(h)
  const reply = 'child evidence '.repeat(3000)
  h.provider.script(call('Agent', { description: 'review evidence', prompt: 'review the fixture' }))
  h.provider.script(scriptedTurn({ deltas: [reply], usage }))
  h.provider.script(scriptedTurn({ deltas: ['parent answer'], usage }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'delegate review' })
  expect((await rootEnd(h.loop)).reason).toEqual({ code: 'completed' })
  expect(h.logs).toEqual([])

  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  const result = parent.find((entry) => entry.name === 'tool/result' && entry.payload['handoff'])!
  expect(result.payload['handoff']).toMatchObject({
    outcome: 'completed',
    finalReply: reply.slice(0, SPILL_PREVIEW_CHARS),
    preview: 'spilled',
  })
  expect(result.payload['spill']).toMatchObject({
    bytes: expect.any(Number),
    sha256: expect.any(String),
  })
  const content = (result.payload['content'] as { type: string; text?: string }[])
    .map((block) => block.text ?? '')
    .join('')
  expect(content.length).toBeLessThan(SPILL_PREVIEW_CHARS + 500)
  expect(content).toContain('tool-output')
  expect(content).not.toContain(reply.slice(SPILL_PREVIEW_CHARS))

  const spill = result.payload['spill'] as { file: string }
  const spillPath = absolutePath(
    `${h.host.identity.profileDir}/tool-output/${SESSION}/${spill.file}`,
  )
  expect(await h.host.fs.readFile(spillPath, { encoding: 'utf8' })).toBe(reply)
  // No payload of the parent holds the reply; in the child, only its own assistant message does.
  const holding = (entries: readonly { name: string; payload: unknown }[]) =>
    entries.filter((e) => JSON.stringify(e.payload).includes(reply)).map((e) => e.name)
  expect(holding(parent)).toEqual([])
  const childId = (
    parent.find((e) => e.name === 'session/parent_link')!.payload['child'] as { sessionId: string }
  ).sessionId
  const child = (await h.store.readRange({ sessionId: childId, limit: 1000 })).entries
  expect(holding(child)).toEqual(['message/assistant'])
  // The row's expansion reads the same start, live and redrawn.
  const view = {
    outcome: 'completed',
    childEndReason: 'completed',
    childSessionId: childId,
    finalReply: reply.slice(0, SPILL_PREVIEW_CHARS),
    preview: 'spilled',
  }
  expect(
    h.loop.recorded.find((e) => e.type === 'tool-outcome' && e.outcome.handoff !== undefined),
  ).toMatchObject({ outcome: { handoff: view } })
  const rows = await h.service.listMessages({ sessionId: SESSION, limit: 100 })
  expect(rows.flatMap((row) => row.calls ?? []).map((c) => c.outcome?.handoff)).toContainEqual(view)
})

it.each(['allow', 'deny'] as const)(
  'resumes the child on its own lease after %s and then collects in a parent Run',
  async (decision) => {
    const h = harness()
    await setup(h)
    h.provider.script(call('Agent', { description: 'write task', prompt: 'write a file' }))
    h.provider.script(call('Write', { file_path: '/work/a.txt', content: 'hello' }))
    await h.service.send({ sessionId: SESSION, origin: null, text: 'parent task' })
    expect((await rootEnd(h.loop)).reason).toEqual({ code: 'paused', waitingFor: 'subagent' })
    const pending = await h.service.currentPending({ sessionId: SESSION })
    expect(pending?.waitKind).toBe('approval')
    if (pending?.waitKind !== 'approval') throw new Error('card missing')
    expect(pending.card.sessionId).not.toBe(SESSION)
    expect(pending.anchorCallKey).not.toBe(pending.callKey)
    h.provider.script(scriptedTurn({ deltas: ['child done'], usage }))
    h.provider.script(scriptedTurn({ deltas: ['parent done'], usage }))
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: pending.card.sessionId,
        requestId: pending.card.requestId,
        decision,
        origin: null,
      }),
    ).toEqual({ status: 'applied' })
    expect((await rootEnd(h.loop)).reason).toEqual({ code: 'completed' })
    expect(h.logs).toEqual([])
    const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    expect(parent.find((e) => e.name === 'tool/result')?.payload['handoff']).toMatchObject({
      outcome: 'completed',
      finalReply: 'child done',
      calls: [
        {
          toolName: 'Write',
          state: decision === 'allow' ? 'completed' : 'not-run',
          source: decision === 'allow' ? null : 'user-rejected',
        },
      ],
    })
    expect(h.loop.leaseLog).toHaveLength(3)
    expect(h.loop.liveLease(SESSION)).toBeNull()
  },
)

it.each(['stop', 'supersede'] as const)(
  'closes a child approval and parent handoff before %s',
  async (action) => {
    const h = harness()
    await setup(h)
    h.provider.script(call('Agent', { description: 'write task', prompt: 'write' }))
    h.provider.script(call('Write', { file_path: '/work/a', content: 'x' }))
    await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
    await rootEnd(h.loop)
    const stopped = action === 'stop' ? await h.service.stop({ rootSessionId: SESSION }) : null
    expect(stopped).toEqual(action === 'stop' ? { stopped: true } : null)
    if (action !== 'stop') {
      h.provider.script(scriptedTurn({ deltas: ['new answer'] }))
      await h.service.send({ sessionId: SESSION, origin: null, text: 'new request' })
      await rootEnd(h.loop)
    }
    expect(await h.service.currentPending({ sessionId: SESSION })).toBeNull()
    const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    expect(parent.find((e) => e.name === 'tool/result')?.payload['handoff']).toMatchObject({
      outcome: action === 'stop' ? 'aborted' : 'superseded',
      childEndReason: null,
      calls: [{ state: 'not-run', source: action === 'stop' ? 'stopped' : 'superseded' }],
    })
    expect(h.logs).toEqual([])
    expect(h.loop.liveLease(SESSION)).toBeNull()
  },
)

it('recovers a paused child before its parent and preserves the live Agent call', async () => {
  const h = harness()
  await setup(h)
  h.provider.script(call('Agent', { description: 'write task', prompt: 'write' }))
  h.provider.script(call('Write', { file_path: '/work/a', content: 'x' }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
  await rootEnd(h.loop)
  const loop = createTestLoopPorts({ connector: { provider: h.provider, model: MODEL } })
  const service = createTestSessionService(
    {
      host: h.host,
      tape: h.store,
      ids: createCounterIds({ start: 100 }),
      connector: loop.connector,
      inspectors: [],
      protectedFiles: [],
    },
    { tools: { Agent: 'real' } },
  )
  service.bindLoop(loop)
  expect((await service.recover()).errors).toEqual([])
  const pending = await service.currentPending({ sessionId: SESSION })
  if (pending?.waitKind !== 'approval') throw new Error('child card missing after restart')
  expect(pending.card.sessionId).not.toBe(SESSION)
  expect(
    (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries.some(
      (e) => e.name === 'tool/result',
    ),
  ).toBe(false)
  h.provider.script(scriptedTurn({ deltas: ['child resumed'] }))
  h.provider.script(scriptedTurn({ deltas: ['parent resumed'] }))
  await service.answer({
    kind: 'approval',
    sessionId: pending.card.sessionId,
    requestId: pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
  expect((await rootEnd(loop)).reason).toEqual({ code: 'completed' })
  expect(loop.liveLease(SESSION)).toBeNull()
})

async function rootEnd(loop: ReturnType<typeof createTestLoopPorts>) {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- drain child events before root terminal
    const event = await loop.runEnded()
    if (event.sessionId === SESSION) return event
  }
}

it('rechecks stop after a child own-lease completed terminal commits and sends no parent request', async () => {
  const h = harness()
  await setup(h)
  h.provider.script(call('Agent', { description: 'write task', prompt: 'write' }))
  h.provider.script(call('Write', { file_path: '/work/a', content: 'x' }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
  await rootEnd(h.loop)
  const pending = await h.service.currentPending({ sessionId: SESSION })
  if (pending?.waitKind !== 'approval') throw new Error('card missing')
  const append = h.store.append.bind(h.store)
  let stopped = false
  h.store.append = async (batch) => {
    const out = await append(batch)
    if (
      batch.sessionId === pending.card.sessionId &&
      batch.entries.some(
        (e) =>
          e.name === 'execution/run_terminal' &&
          (e.payload['reason'] as { code: string }).code === 'completed',
      )
    ) {
      stopped = (await h.service.stop({ rootSessionId: SESSION })).stopped
    }
    return out
  }
  h.provider.script(scriptedTurn({ deltas: ['committed child answer'], usage }))
  const before = h.provider.starts
  await h.service.answer({
    kind: 'approval',
    sessionId: pending.card.sessionId,
    requestId: pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
  const end = await h.loop.runEnded()
  expect(end.sessionId).toBe(pending.card.sessionId)
  expect(stopped).toBe(true)
  expect(h.provider.starts - before).toBe(1)
  expect(h.loop.liveLease(SESSION)).toBeNull()
  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  expect(parent.find((e) => e.name === 'tool/result')?.payload['handoff']).toMatchObject({
    outcome: 'aborted',
    childEndReason: 'completed',
    finalReply: 'committed child answer',
  })
  expect(parent.filter((e) => e.name === 'execution/run_started')).toHaveLength(1)
})

it.each([false, true])(
  'stops during handoff spill without resuming the parent (own=%s)',
  async (own) => {
    const h = harness()
    await setup(h)
    const reply = 'completed child evidence '.repeat(2000)
    h.provider.script(call('Agent', { description: 'review task', prompt: 'review' }))
    if (own) h.provider.script(call('Write', { file_path: '/work/a', content: 'x' }))
    else h.provider.script(scriptedTurn({ deltas: [reply], usage }))
    const write = h.host.fs.writeFile.bind(h.host.fs)
    let stopped: boolean | null = null
    h.host.fs.writeFile = async (path, bytes) => {
      await write(path, bytes)
      if (stopped === null && path.includes('/tool-output/')) {
        stopped = (await h.service.stop({ rootSessionId: SESSION })).stopped
      }
    }
    await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
    if (own) {
      await rootEnd(h.loop)
      const pending = await h.service.currentPending({ sessionId: SESSION })
      if (pending?.waitKind !== 'approval') throw new Error('missing child card')
      h.provider.script(scriptedTurn({ deltas: [reply], usage }))
      await h.service.answer({
        kind: 'approval',
        sessionId: pending.card.sessionId,
        requestId: pending.card.requestId,
        decision: 'allow',
        origin: null,
      })
    }
    await expect.poll(() => h.loop.liveLease(SESSION)).toBeNull()
    expect(stopped).toBe(true)
    expect(h.provider.starts).toBe(own ? 3 : 2)
    const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    // The aborted result is rebuilt under the name the first spill took, so its write is refused:
    // the reply keeps its start and nothing holds the rest (H9; Revisions 31).
    const result = parent.find((e) => e.name === 'tool/result')
    expect(result?.payload['handoff']).toMatchObject({
      outcome: 'aborted',
      childEndReason: 'completed',
      finalReply: reply.slice(0, SPILL_PREVIEW_CHARS),
      preview: 'unsaved',
    })
    expect(result?.payload['spill']).toBeUndefined()
    expect(parent.filter((e) => JSON.stringify(e.payload).includes(reply))).toEqual([])
    expect(parent.filter((e) => e.name === 'execution/run_started')).toHaveLength(1)
  },
)

it('keeps queued parent messages outside every child request until handoff is written', async () => {
  const h = harness()
  await setup(h)
  const stream = h.provider.stream.bind(h.provider)
  let queued = false
  h.provider.stream = (encoded, ctx) => {
    const original = stream(encoded, ctx)
    return (async function* () {
      for await (const event of original) {
        yield event
        if (!queued && event.type === 'text-delta' && event.text === 'child text') {
          queued = true
          expect(
            await h.service.send({ sessionId: SESSION, origin: null, text: 'PARENT_QUEUED_ONLY' }),
          ).toMatchObject({ status: 'queued' })
        }
      }
    })()
  }
  h.provider.script(call('Agent', { description: 'check task', prompt: 'child input' }))
  h.provider.script(scriptedTurn({ deltas: ['child text'], usage }))
  h.provider.script(scriptedTurn({ deltas: ['parent done'], usage }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
  await rootEnd(h.loop)
  expect(JSON.stringify(h.provider.requests[1]?.body)).not.toContain('PARENT_QUEUED_ONLY')
  expect(JSON.stringify(h.provider.requests[2]?.body)).toContain('PARENT_QUEUED_ONLY')
  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  const result = parent.find((e) => e.name === 'tool/result')!
  const queuedEntry = parent.find(
    (e) => e.name === 'message/user' && JSON.stringify(e.payload).includes('PARENT_QUEUED_ONLY'),
  )!
  expect(result.entryId).toBeLessThan(queuedEntry.entryId)
})

it('02 不变量 30 — refuses recursive Agent and AskUserQuestion calls without creating another child', async () => {
  const h = harness()
  await setup(h)
  h.provider.script(call('Agent', { description: 'check task', prompt: 'child input' }))
  h.provider.script(call('Agent', { description: 'nested task', prompt: 'nested' }, 'nested'))
  h.provider.script(call('AskUserQuestion', { questions: [] }, 'question'))
  h.provider.script(scriptedTurn({ deltas: ['child done'] }))
  h.provider.script(scriptedTurn({ deltas: ['parent done'] }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
  await rootEnd(h.loop)
  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  const childId = (
    parent.find((e) => e.name === 'session/parent_link')!.payload['child'] as { sessionId: string }
  ).sessionId
  const child = (await h.store.readRange({ sessionId: childId, limit: 1000 })).entries
  expect(
    child.some((e) => e.name === 'session/parent_link' || e.name === 'tool/permission_decided'),
  ).toBe(false)
  expect(
    child.filter((e) => e.name === 'execution/tool_outcome').map((e) => e.payload['source']),
  ).toEqual(['tool-unavailable', 'tool-unavailable'])
})

it('stops at the child deadline before another main request, preserving a partial handoff', async () => {
  const h = harness()
  await setup(h)
  const stream = h.provider.stream.bind(h.provider)
  h.provider.stream = (encoded, ctx) => {
    const source = stream(encoded, ctx)
    return (async function* () {
      for await (const event of source) {
        yield event
        if (event.type === 'text-delta' && event.text === 'advance child clock')
          h.host.advance(300000)
      }
    })()
  }
  h.provider.script(call('Agent', { description: 'check task', prompt: 'child' }))
  h.provider.script([
    { type: 'text-delta', index: 3, text: 'advance child clock' },
    ...call('Read', { file_path: '/work/a' }),
  ])
  h.provider.script(scriptedTurn({ deltas: ['parent after deadline'] }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
  await rootEnd(h.loop)
  expect(h.provider.starts).toBe(3)
  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  expect(parent.find((e) => e.name === 'tool/result')?.payload['handoff']).toMatchObject({
    outcome: 'partial',
    childEndReason: 'time-limit',
  })
  expect(parent.find((e) => e.name === 'tool/result')?.payload['isError']).toBe(false)
})

it.each([
  { own: false, long: false },
  { own: true, long: false },
  { own: false, long: true },
  { own: true, long: true },
])(
  'recovers the child-terminal/parent-result crash gap (own=$own, long=$long)',
  async ({ own, long }) => {
    const h = harness()
    await setup(h)
    const reply = long ? 'child recovery evidence '.repeat(2000) : 'child final'
    const writeFile = h.host.fs.writeFile.bind(h.host.fs)
    // Borrowed lease: simulate a failed first spill, so recovery must create the full result.
    // Own lease: leave the pre-crash spill in place; recovery must refuse to overwrite it.
    let failFirstSpill = long && !own
    h.host.fs.writeFile = async (path, bytes) => {
      if (failFirstSpill && path.includes('/tool-output/')) {
        failFirstSpill = false
        throw new Error('first spill unavailable')
      }
      return writeFile(path, bytes)
    }
    h.provider.script(call('Agent', { description: 'check task', prompt: 'child' }))
    if (own) h.provider.script(call('Write', { file_path: '/work/a', content: 'x' }))
    else h.provider.script(scriptedTurn({ deltas: [reply], usage }))
    const append = h.store.append.bind(h.store)
    const failed = Promise.withResolvers<void>()
    h.store.append = async (batch) => {
      if (
        batch.sessionId === SESSION &&
        batch.entries.some((e) => e.name === 'tool/result' && e.payload['handoff'] !== undefined)
      ) {
        failed.resolve()
        throw new Error('crash after child terminal')
      }
      return append(batch)
    }
    await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
    if (own) {
      await rootEnd(h.loop)
      const pending = await h.service.currentPending({ sessionId: SESSION })
      if (pending?.waitKind !== 'approval') throw new Error('missing card')
      h.provider.script(scriptedTurn({ deltas: [reply], usage }))
      await h.service.answer({
        kind: 'approval',
        sessionId: pending.card.sessionId,
        requestId: pending.card.requestId,
        decision: 'allow',
        origin: null,
      })
    }
    await failed.promise
    // Let the failed mailbox task release its lease before simulating a fresh process.
    await expect.poll(() => h.loop.liveLease(SESSION)).toBeNull()
    h.store.append = append
    const loop = createTestLoopPorts({ connector: { provider: h.provider, model: MODEL } })
    const service = createTestSessionService(
      {
        host: h.host,
        tape: h.store,
        ids: createCounterIds({ start: 100 }),
        connector: loop.connector,
        inspectors: [],
        protectedFiles: [],
      },
      { tools: { Agent: 'real' } },
    )
    service.bindLoop(loop)
    const starts = h.provider.starts
    expect((await service.recover()).errors).toEqual([])
    expect(h.provider.starts).toBe(starts)
    const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    // A long reply keeps its start: `spilled` when recovery wrote the file, `unsaved` when the
    // pre-crash file took its name (H9; Revisions 31).
    expect(parent.find((e) => e.name === 'tool/result')?.payload['handoff']).toMatchObject({
      outcome: 'uncertain',
      childEndReason: 'completed',
      finalReply: long ? reply.slice(0, SPILL_PREVIEW_CHARS) : reply,
      ...(long ? { preview: own ? 'unsaved' : 'spilled' } : {}),
    })
    expect(parent.some((e) => JSON.stringify(e.payload).includes(reply))).toBe(!long)
    expect(parent.find((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
      state: 'uncertain',
      source: 'crashed',
    })
    const result = parent.find((e) => e.name === 'tool/result')!
    const content = result.payload['content'] as { type: string; text: string }[]
    expect(result.payload['isError']).toBe(true)
    expect(content[0]!.text.length).toBeLessThan(SPILL_PREVIEW_CHARS + 500)
    const spill = result.payload['spill'] as { file: string } | undefined
    expect(spill !== undefined).toBe(long && !own)
    expect(content[0]!.text.includes('/tool-output/')).toBe(long && !own)
    let saved: string | Uint8Array | null = null
    if (spill !== undefined) {
      const path = absolutePath(
        `${h.host.identity.profileDir}/tool-output/${SESSION}/${spill.file}`,
      )
      saved = await h.host.fs.readFile(path, { encoding: 'utf8' })
    }
    expect(typeof saved === 'string' && saved.includes(reply)).toBe(long && !own)
    expect(typeof saved === 'string' && saved.includes('uncertain')).toBe(long && !own)
    expect((await service.recover()).errors).toEqual([])
    expect(
      (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries.filter(
        (e) => e.name === 'tool/result',
      ),
    ).toHaveLength(1)
  },
)

it('preserves the parent waiting through two recoveries when the child approval becomes resumable', async () => {
  const h = harness()
  await setup(h)
  h.provider.script(call('Agent', { description: 'write task', prompt: 'child' }))
  h.provider.script(call('Write', { file_path: '/work/a', content: 'x' }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
  await rootEnd(h.loop)
  h.host.setPolicy({
    status: 'current',
    version: 'no-write',
    snapshot: {
      tools: [{ policyId: 'ban', serverId: 'builtin', toolName: 'Write', effect: 'deny' }],
    },
  })
  const loop = createTestLoopPorts({ connector: { provider: h.provider, model: MODEL } })
  const service = createTestSessionService(
    {
      host: h.host,
      tape: h.store,
      ids: createCounterIds({ start: 100 }),
      connector: loop.connector,
      inspectors: [],
      protectedFiles: [],
    },
    { tools: { Agent: 'real' } },
  )
  service.bindLoop(loop)
  const first = await service.recover()
  expect(first.errors).toEqual([])
  expect(first.resumable).toEqual([expect.objectContaining({ rootSessionId: SESSION })])
  expect((await service.recover()).resumable).toHaveLength(1)
  expect(
    (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries.some(
      (e) => e.name === 'tool/result',
    ),
  ).toBe(false)
  h.provider.script(scriptedTurn({ deltas: ['child resumed after ban'] }))
  h.provider.script(scriptedTurn({ deltas: ['parent done'] }))
  expect(await service.resume({ rootSessionId: SESSION, origin: null })).toEqual({
    status: 'started',
  })
  expect((await rootEnd(loop)).reason).toEqual({ code: 'completed' })
  expect(loop.liveLease(SESSION)).toBeNull()
})

it('closes and releases a newly reserved parent lease when stop lands before its head append', async () => {
  const h = harness()
  await setup(h)
  h.provider.script(call('Agent', { description: 'write task', prompt: 'write' }))
  h.provider.script(call('Write', { file_path: '/work/a', content: 'x' }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
  await rootEnd(h.loop)
  const pending = await h.service.currentPending({ sessionId: SESSION })
  if (pending?.waitKind !== 'approval') throw new Error('missing child card')
  const head = h.store.head.bind(h.store)
  let stopped = false
  h.store.head = async (sessionId) => {
    const value = await head(sessionId)
    if (sessionId === SESSION && h.loop.leaseLog.length === 3 && !stopped) {
      stopped = true
      h.service.stop({ rootSessionId: SESSION })
    }
    return value
  }
  h.provider.script(scriptedTurn({ deltas: ['child final'] }))
  await h.service.answer({
    kind: 'approval',
    sessionId: pending.card.sessionId,
    requestId: pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
  await expect.poll(() => h.loop.liveLease(SESSION)).toBeNull()
  expect(stopped).toBe(true)
  expect(h.provider.starts).toBe(3)
  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  expect(parent.filter((e) => e.name === 'execution/run_started')).toHaveLength(1)
  expect(parent.find((e) => e.name === 'tool/result')?.payload['handoff']).toMatchObject({
    outcome: 'aborted',
    childEndReason: 'completed',
    finalReply: 'child final',
  })
  expect(parent.find((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
    state: 'aborted',
    source: 'stopped',
    reversibility: 'unknown',
  })
})

it('ends a child at 30 tool batches without offering a continuation and lets the parent receive partial work', async () => {
  const h = harness()
  await setup(h)
  h.provider.script(call('Agent', { description: 'inspect many files', prompt: 'inspect files' }))
  for (let i = 0; i < 31; i += 1) h.provider.script(call('Read', { file_path: `/work/file-${i}` }))
  h.provider.script(scriptedTurn({ deltas: ['parent has partial work'] }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'delegate' })
  expect((await rootEnd(h.loop)).reason.code).toBe('completed')
  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  const result = parent.find((e) => e.name === 'tool/result')!
  expect(result.payload['handoff']).toMatchObject({
    outcome: 'partial',
    childEndReason: 'step-limit',
  })
  expect(result.payload['isError']).toBe(false)
  const childId = (result.payload['handoff'] as { childSessionId: string }).childSessionId
  const child = (await h.store.readRange({ sessionId: childId, limit: 1000 })).entries
  expect(child.filter((e) => e.name === 'execution/dispatch_committed')).toHaveLength(30)
  expect(child.filter((e) => e.name === 'message/continuation')).toHaveLength(0)
  expect(child.findLast((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
    state: 'not-run',
    source: 'step-limit',
  })
})

it('enforces the child token budget before dispatch and records its usage once in the collecting parent Run', async () => {
  const h = harness()
  await setup(h)
  h.provider.script(call('Agent', { description: 'inspect file', prompt: 'inspect file' }))
  const largeUsage = { ...usage, inputTokens: 500001 }
  h.provider.script(
    call('Read', { file_path: '/work/large' }).map((event) =>
      event.type === 'usage' ? { type: 'usage' as const, usage: largeUsage } : event,
    ),
  )
  h.provider.script(scriptedTurn({ deltas: ['parent has budget result'], usage }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'delegate' })
  expect((await rootEnd(h.loop)).reason.code).toBe('completed')
  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  expect(parent.find((e) => e.name === 'tool/result')?.payload).toMatchObject({
    isError: false,
    handoff: {
      outcome: 'partial',
      childEndReason: 'usage-limit',
      calls: [{ toolName: 'Read', state: 'not-run', source: 'usage-limit' }],
    },
  })
  expect(parent.findLast((e) => e.name === 'execution/run_terminal')?.payload['usage']).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ origin: 'subagent', requests: 1, inputTokens: 500001 }),
    ]),
  )
})

it.each(['quit', 'close-window'] as const)(
  'preserves a borrowed child approval committed just before %s',
  async (cause) => {
    const h = harness()
    await setup(h)
    const append = h.store.append.bind(h.store)
    h.store.append = async (batch) => {
      const result = await append(batch)
      if (
        batch.sessionId !== SESSION &&
        batch.entries.some(
          (e) =>
            e.name === 'execution/run_terminal' &&
            (e.payload['reason'] as { code: string }).code === 'paused',
        )
      )
        h.loop.abort(SESSION, cause)
      return result
    }
    h.provider.script(call('Agent', { description: 'write task', prompt: 'write a file' }))
    h.provider.script(call('Write', { file_path: '/work/result', content: 'value' }))
    await h.service.send({ sessionId: SESSION, origin: null, text: 'delegate' })
    const end = await rootEnd(h.loop)
    expect(end).toMatchObject({
      recorded: true,
      reason: { code: 'paused', waitingFor: 'subagent' },
    })
    expect(h.logs).toEqual([])
    const pending = await h.service.currentPending({ sessionId: SESSION })
    expect(pending?.waitKind).toBe('approval')
    expect(h.loop.liveLease(SESSION)).toBeNull()
    const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    expect(parent.some((e) => e.name === 'tool/result')).toBe(false)
    expect((await h.service.recover()).errors).toEqual([])
    expect(await h.service.currentPending({ sessionId: SESSION })).toEqual(pending)
  },
)

it.each([false, true])(
  'deducts both OpenAI cache buckets from child handoff budgets (own lease=%s)',
  async (own) => {
    const h = harness(20)
    h.provider.encode = (req) => encodeOpenAIChat(req, 'anthropic')
    await setup(h)
    const zero = { ...usage, inputTokens: 0, outputTokens: 0 }
    h.provider.script(
      call('Agent', { description: 'inspect cached data', prompt: 'inspect' }).map((e) =>
        e.type === 'usage' ? { type: 'usage', usage: zero } : e,
      ),
    )
    if (own)
      h.provider.script(
        call('Write', { file_path: '/work/a', content: 'x' }).map((e) =>
          e.type === 'usage' ? { type: 'usage', usage: zero } : e,
        ),
      )
    h.provider.script(
      scriptedTurn({
        deltas: ['child final'],
        usage: { ...usage, inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 50 },
      }),
    )
    h.provider.script(scriptedTurn({ deltas: ['parent final'], usage: zero }))
    await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
    if (own) {
      await rootEnd(h.loop)
      const pending = await h.service.currentPending({ sessionId: SESSION })
      if (pending?.waitKind !== 'approval') throw new Error('child card missing')
      await h.service.answer({
        kind: 'approval',
        sessionId: pending.card.sessionId,
        requestId: pending.card.requestId,
        decision: 'allow',
        origin: null,
      })
    }
    expect((await rootEnd(h.loop)).reason).toEqual({ code: 'completed' })
    expect(h.provider.starts).toBe(own ? 4 : 3)
    const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    expect(parent.findLast((e) => e.name === 'execution/run_terminal')?.payload['usage']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: 'subagent',
          inputTokens: 100,
          outputTokens: 4,
          cacheReadTokens: 40,
          cacheWriteTokens: 50,
        }),
      ]),
    )
  },
)

it.each([false, true])(
  'clamps cached child input at zero before charging parent output (own lease=%s)',
  async (own) => {
    const h = harness(20)
    h.provider.encode = (req) => encodeOpenAIChat(req, 'anthropic')
    await setup(h)
    const zero = { ...usage, inputTokens: 0, outputTokens: 0 }
    h.provider.script(
      call('Agent', { description: 'inspect cached data', prompt: 'inspect' }).map((e) =>
        e.type === 'usage' ? { type: 'usage', usage: zero } : e,
      ),
    )
    if (own)
      h.provider.script(
        call('Write', { file_path: '/work/a', content: 'x' }).map((e) =>
          e.type === 'usage' ? { type: 'usage', usage: zero } : e,
        ),
      )
    h.provider.script(
      scriptedTurn({
        deltas: ['child final'],
        usage: { ...usage, inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30 },
      }),
    )
    h.provider.script(
      call('Read', { file_path: '/work/parent' }).map((e) =>
        e.type === 'usage' ? { type: 'usage', usage: { ...zero, inputTokens: 17 } } : e,
      ),
    )
    h.provider.script(scriptedTurn({ deltas: ['must not request'], usage: zero }))
    await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
    if (own) {
      await rootEnd(h.loop)
      const pending = await h.service.currentPending({ sessionId: SESSION })
      if (pending?.waitKind !== 'approval') throw new Error('child card missing')
      await h.service.answer({
        kind: 'approval',
        sessionId: pending.card.sessionId,
        requestId: pending.card.requestId,
        decision: 'allow',
        origin: null,
      })
    }
    expect((await rootEnd(h.loop)).reason).toEqual({ code: 'usage-limit', tokenLimit: 20 })
    expect(h.provider.starts).toBe(own ? 4 : 3)
    const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    expect(parent.findLast((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
      state: 'not-run',
      source: 'usage-limit',
    })
  },
)

it('makes the reserved parent lease visible before emitting the child end event', async () => {
  let onEvent: ((event: SessionEvent) => void) | undefined
  const h = harness(undefined, (e) => onEvent?.(e))
  await setup(h)
  h.provider.script(call('Agent', { description: 'write task', prompt: 'write' }))
  h.provider.script(call('Write', { file_path: '/work/a', content: 'x' }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
  await rootEnd(h.loop)
  const pending = await h.service.currentPending({ sessionId: SESSION })
  if (pending?.waitKind !== 'approval') throw new Error('child card missing')
  let stopped: Promise<{ stopped: boolean }> | null = null
  onEvent = (event) => {
    if (
      event.type === 'run-ended' &&
      event.sessionId !== SESSION &&
      event.reason.code === 'completed'
    ) {
      stopped = h.service.stop({ rootSessionId: SESSION })
    }
  }
  h.provider.script(scriptedTurn({ deltas: ['child final'] }))
  h.provider.script(scriptedTurn({ deltas: ['must not request'] }))
  await h.service.answer({
    kind: 'approval',
    sessionId: pending.card.sessionId,
    requestId: pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
  await expect.poll(() => h.loop.liveLease(SESSION)).toBeNull()
  expect(stopped).not.toBeNull()
  expect(await stopped).toEqual({ stopped: true })
  expect(h.provider.starts).toBe(3)
  expect(h.loop.leaseLog[1]?.finished).toBe(true)
  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  expect(parent.find((e) => e.name === 'tool/result')?.payload['handoff']).toMatchObject({
    outcome: 'aborted',
    childEndReason: 'completed',
  })
})

it('continues the child step budget across approval rather than restarting its 30 batches', async () => {
  const h = harness()
  await setup(h)
  h.provider.script(call('Agent', { description: 'inspect many files', prompt: 'inspect files' }))
  for (let i = 0; i < 29; i += 1) h.provider.script(call('Read', { file_path: `/work/file-${i}` }))
  h.provider.script(call('Write', { file_path: '/work/result', content: 'x' }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'delegate' })
  expect((await rootEnd(h.loop)).reason).toEqual({ code: 'paused', waitingFor: 'subagent' })
  const pending = await h.service.currentPending({ sessionId: SESSION })
  if (pending?.waitKind !== 'approval') throw new Error('child card missing')
  h.provider.script(call('Read', { file_path: '/work/must-not-read' }))
  h.provider.script(scriptedTurn({ deltas: ['parent has partial work'] }))
  await h.service.answer({
    kind: 'approval',
    sessionId: pending.card.sessionId,
    requestId: pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
  expect((await rootEnd(h.loop)).reason).toEqual({ code: 'completed' })
  const child = (await h.store.readRange({ sessionId: pending.card.sessionId, limit: 1000 }))
    .entries
  expect(child.filter((e) => e.name === 'execution/dispatch_committed')).toHaveLength(30)
  expect(
    child.filter((e) => e.name === 'execution/run_terminal').map((e) => e.payload['steps']),
  ).toEqual([30, 0])
  expect(child.findLast((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
    state: 'not-run',
    source: 'step-limit',
  })
  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  expect(parent.find((e) => e.name === 'tool/result')?.payload['handoff']).toMatchObject({
    outcome: 'partial',
    childEndReason: 'step-limit',
  })
})

it('keeps child model, effort and tool subset frozen when parent settings expand during approval', async () => {
  const h = harness()
  const model: ModelInfo = {
    ...MODEL,
    reasoning: true,
    thinkingSpec: {
      mode: 'adaptive',
      defaultOn: true,
      effortLevels: ['low', 'high'],
      defaultEffort: 'low',
    },
  }
  const other = { ...model, id: 'new-parent-model' }
  h.loop.connector.use({ provider: h.provider, model, effort: 'low' })
  h.host.setPolicy({
    status: 'current',
    version: 'no-grep',
    snapshot: {
      tools: [{ policyId: 'ban', serverId: 'builtin', toolName: 'Grep', effect: 'deny' }],
    },
  })
  await setup(h)
  h.provider.script(
    call('Agent', { description: 'write then inspect', prompt: 'write and inspect' }),
  )
  h.provider.script(call('Write', { file_path: '/work/a', content: 'x' }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'delegate' })
  expect((await rootEnd(h.loop)).reason).toEqual({ code: 'paused', waitingFor: 'subagent' })
  const pending = await h.service.currentPending({ sessionId: SESSION })
  if (pending?.waitKind !== 'approval') throw new Error('child card missing')
  h.host.setPolicy({ status: 'current', version: 'unrestricted', snapshot: { tools: [] } })
  h.loop.connector.use({
    provider: h.provider,
    model: other,
    models: [model, other],
    effort: 'high',
  })
  await h.service.selectModel({
    sessionId: SESSION,
    origin: null,
    choice: { providerId: 'anthropic', modelId: other.id, effort: 'high' },
  })
  h.provider.script(call('Grep', { pattern: 'secret', path: '/work' }))
  h.provider.script(scriptedTurn({ deltas: ['child done'] }))
  h.provider.script(scriptedTurn({ deltas: ['parent done'] }))
  await h.service.answer({
    kind: 'approval',
    sessionId: pending.card.sessionId,
    requestId: pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
  expect((await rootEnd(h.loop)).reason).toEqual({ code: 'completed' })
  const child = (await h.store.readRange({ sessionId: pending.card.sessionId, limit: 1000 }))
    .entries
  const selected = child.filter((e) => e.name === 'session/model_selected')
  expect(selected).toHaveLength(2)
  for (const entry of selected)
    expect(entry.payload).toMatchObject({
      providerId: 'anthropic',
      modelId: MODEL.id,
    })
  expect(child.filter((e) => e.name === 'view/tool_table')).toHaveLength(1)
  expect(child.findLast((e) => e.name === 'execution/tool_outcome')?.payload).toMatchObject({
    state: 'not-run',
    source: 'tool-unavailable',
  })
  expect(child.filter((e) => e.name === 'execution/dispatch_committed')).toHaveLength(1)
  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  expect(parent.findLast((e) => e.name === 'session/model_selected')?.payload).toMatchObject({
    modelId: MODEL.id,
  })
  expect(h.loop.connector.calls.resolveChoice).toBe(1)
  for (const request of h.provider.requests)
    expect(request.body).toMatchObject({ model: MODEL.id, output_config: { effort: 'low' } })
  for (const entry of child.filter((e) => e.name === 'provider/attempt_completed'))
    expect(entry.payload['request']).toMatchObject({ effort: 'low' })
})

it('02 不变量 29: preserves the remaining deadline through approval downtime and service restart', async () => {
  const h = harness()
  await setup(h)
  const stream = h.provider.stream.bind(h.provider)
  h.provider.stream = (encoded, ctx) => {
    const source = stream(encoded, ctx)
    return (async function* () {
      for await (const event of source) {
        yield event
        if (event.type === 'text-delta' && event.text.startsWith('clock:'))
          h.host.advance(Number(event.text.slice(6)))
      }
    })()
  }
  const timedCall = (ms: number, name: string, input: Record<string, unknown>): StreamEvent[] => [
    { type: 'text-delta', index: 3, text: `clock:${ms}` },
    ...call(name, input),
  ]
  h.provider.script(call('Agent', { description: 'write task', prompt: 'write then inspect' }))
  h.provider.script(timedCall(120000, 'Write', { file_path: '/work/a', content: 'kept' }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
  expect((await rootEnd(h.loop)).reason).toEqual({ code: 'paused', waitingFor: 'subagent' })
  const before = await h.service.currentPending({ sessionId: SESSION })
  if (before?.waitKind !== 'approval') throw new Error('child approval missing')
  const childId = before.card.sessionId
  const elapsed = async () =>
    subagentElapsedFromTape(
      (await h.store.readRange({ sessionId: childId, limit: 1000 })).entries,
      h.host.clock.now(),
    )
  expect(await elapsed()).toBe(120000)
  h.host.advance(600000)
  expect(await elapsed()).toBe(120000)
  const loop = createTestLoopPorts({ connector: { provider: h.provider, model: MODEL } })
  const service = createTestSessionService(
    {
      host: h.host,
      tape: h.store,
      ids: createCounterIds({ start: 100 }),
      connector: loop.connector,
      inspectors: [],
      protectedFiles: [],
    },
    { tools: { Agent: 'real' } },
  )
  service.bindLoop(loop)
  expect((await service.recover()).errors).toEqual([])
  expect(await service.currentPending({ sessionId: SESSION })).toEqual(before)
  expect(await elapsed()).toBe(120000)
  const starts = h.provider.starts
  // At 299999 ms a new child request is still allowed. At exactly 300000 it is not;
  // the Read already dispatched on that final request must still finish normally.
  h.provider.script(timedCall(179999, 'Read', { file_path: '/work/a' }))
  h.provider.script(timedCall(1, 'Read', { file_path: '/work/a' }))
  h.provider.script(scriptedTurn({ deltas: ['parent after deadline'] }))
  expect(
    await service.answer({
      kind: 'approval',
      sessionId: childId,
      requestId: before.card.requestId,
      decision: 'allow',
      origin: null,
    }),
  ).toEqual({ status: 'applied' })
  expect((await rootEnd(loop)).reason).toEqual({ code: 'completed' })
  expect(h.provider.starts - starts).toBe(3)
  expect(await elapsed()).toBe(300000)
  const child = (await h.store.readRange({ sessionId: childId, limit: 1000 })).entries
  expect(
    child
      .filter((entry) => entry.name === 'execution/tool_outcome')
      .map((entry) => entry.payload['state']),
  ).toEqual(['completed', 'completed', 'completed'])
  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  expect(parent.find((entry) => entry.name === 'tool/result')?.payload).toMatchObject({
    isError: false,
    handoff: { outcome: 'partial', childEndReason: 'time-limit' },
  })
  expect(loop.liveLease(SESSION)).toBeNull()
})

it('02 不变量 29: retries the same child payload past its deadline before closing the next request', async () => {
  const h = harness()
  await setup(h)
  await h.host.fs.mkdirp(absolutePath('/work'))
  await h.host.fs.writeFile(absolutePath('/work/a'), 'read after retry')
  h.provider.retryAdvice = () => ({ maxAttempts: 2, baseDelayMs: 0 })
  const schedule = h.host.clock.setTimeout.bind(h.host.clock)
  h.host.clock.setTimeout = (fn, ms) => {
    if (ms === 0) {
      void Promise.resolve().then(fn)
      return () => {}
    }
    return schedule(fn, ms)
  }
  const stream = h.provider.stream.bind(h.provider)
  h.provider.stream = (encoded, ctx) => {
    const source = stream(encoded, ctx)
    return (async function* () {
      for await (const event of source) {
        yield event
        if (event.type === 'text-delta' && event.text === 'cross retry deadline')
          h.host.advance(300000)
      }
    })()
  }
  h.provider.script(call('Agent', { description: 'inspect file', prompt: 'read file' }))
  h.provider.script([
    { type: 'text-delta', index: 0, text: 'cross retry deadline' },
    {
      type: 'error',
      code: 'rate-limit',
      retryable: true,
      providerCode: null,
      detail: 'retryable fixture',
      retryAfterMs: 0,
    },
  ])
  h.provider.script(call('Read', { file_path: '/work/a' }))
  h.provider.script(scriptedTurn({ deltas: ['parent collects partial work'] }))
  await h.service.send({ sessionId: SESSION, origin: null, text: 'parent' })
  expect((await rootEnd(h.loop)).reason).toEqual({ code: 'completed' })
  expect(h.provider.starts).toBe(4)
  expect(h.provider.requests[1]!.body).toEqual(h.provider.requests[2]!.body)
  const parent = (await h.store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  const result = parent.find((entry) => entry.name === 'tool/result')!
  expect(result.payload).toMatchObject({
    isError: false,
    handoff: { outcome: 'partial', childEndReason: 'time-limit' },
  })
  const childId = (result.payload['handoff'] as { childSessionId: string }).childSessionId
  const child = (await h.store.readRange({ sessionId: childId, limit: 1000 })).entries
  const attempts = child.filter((entry) => entry.name === 'provider/attempt_completed')
  expect(attempts).toHaveLength(2)
  expect(attempts[0]!.sourceSeq).toBe(attempts[1]!.sourceSeq)
  expect(attempts[0]!.provenanceKey).not.toBe(attempts[1]!.provenanceKey)
  expect(
    child
      .filter((entry) => entry.name === 'execution/tool_outcome')
      .map((entry) => entry.payload['state']),
  ).toEqual(['completed'])
})
