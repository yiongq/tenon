/** Spec 05 step 8: real executors, a real mailbox and memory-host snapshots; no live model. */
import { describe, expect, it, vi } from 'vitest'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type { PendingApproval, SnapshotStatus, StreamEvent, TapeStore } from '../../src/index.js'
import { STOP_TERM_GRACE_MS } from '../../src/loop/limits.js'
import { SNAPSHOT_CHANGED, SNAPSHOT_FAILED } from '../../src/tools/snapshot-guard.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import { fakeChild, pendingCard, proxyStore } from './support.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const WORK = absolutePath('/work')
const FILE = absolutePath('/work/a.txt')
const MODEL = {
  id: 'snapshot-model',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop' as const,
  usageNeedsOptIn: false,
}
const usage = {
  inputTokens: 5,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}
const done = () => scriptedTurn({ deltas: ['done'], usage })
function call(name: string, input: Record<string, unknown>, id = 'call'): StreamEvent[] {
  return [
    { type: 'tool-call-start', index: 0, id, name },
    { type: 'tool-call-end', index: 0, id, name, input },
    { type: 'usage', usage },
    stopEvent('tool-use', 'tool_use'),
  ]
}
const inputFor = (name: string) =>
  name === 'Bash'
    ? { command: 'echo snapshot' }
    : name === 'Edit'
      ? { file_path: FILE, old_string: 'before', new_string: 'after' }
      : { file_path: FILE, content: 'after' }

async function harness(
  o: { status?: SnapshotStatus; missing?: boolean; store?: (store: TapeStore) => TapeStore } = {},
) {
  const memory = createMemoryHost()
  const spawn = vi.spyOn(memory.process, 'spawn').mockImplementation(async () => {
    const child = fakeChild(() => memory.clock.now(), 'dies')
    child.write('ok')
    child.exit(0)
    return child.child
  })
  await memory.fs.mkdirp(WORK)
  if (!o.missing) await memory.fs.writeFile(FILE, 'before')
  const inner = createMemoryTapeStore({ identity: memory.identity })
  const store = o.store?.(inner) ?? inner
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({ connector: { provider, model: MODEL } })
  const logs: string[] = []
  const service = createTestSessionService(
    {
      host: memory,
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      protectedFiles: [],
      connector: loop.connector,
      log: (line) => logs.push(line),
    },
    { tools: { Write: 'real', Edit: 'real', Bash: 'real', Agent: 'real' } },
  )
  service.bindLoop(loop)
  await service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: WORK })
  memory.snapshots.setStatus(SESSION, o.status ?? 'tree')
  const takeReal = memory.snapshots.take.bind(memory.snapshots)
  const take = vi.spyOn(memory.snapshots, 'take')
  const entries = async (sessionId = SESSION) =>
    (await store.readRange({ sessionId, limit: 1000 })).entries
  return { memory, spawn, store, provider, loop, service, logs, take, takeReal, entries }
}
type Harness = Awaited<ReturnType<typeof harness>>

async function pause(h: Harness, name: string, input = inputFor(name)) {
  h.provider.script(call(name, input))
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'change a file' })
  if (sent.status !== 'started') throw new Error('run did not start')
  expect((await h.loop.runEnded({ runId: sent.runId })).reason).toEqual({
    code: 'paused',
    waitingFor: 'approval',
  })
  const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
  if (pending === null) throw new Error('approval missing')
  return { pending, roundRunId: sent.runId }
}
function answer(h: Harness, pending: PendingApproval) {
  return h.service.answer({
    kind: 'approval',
    sessionId: pending.card.sessionId,
    requestId: pending.card.requestId,
    decision: 'allow',
    origin: null,
  })
}
async function finish(h: Harness, pending: PendingApproval) {
  h.provider.script(done())
  expect(await answer(h, pending)).toEqual({ status: 'applied' })
  expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
  expect(h.logs).toEqual([])
}
async function result(h: Harness) {
  return (await h.entries()).findLast((entry) => entry.name === 'tool/result')?.payload
}
async function outcome(h: Harness) {
  return (await h.entries()).findLast((entry) => entry.name === 'execution/tool_outcome')?.payload
}

describe('05 execution snapshots', () => {
  it.each(
    (['Write', 'Edit'] as const).flatMap((name) =>
      (['tree', 'warming', 'file-only'] as const).map((status) => ({ name, status })),
    ),
  )(
    '05 验收 1、9: $name records before and after snapshots in $status state before its outcome',
    async ({ name, status }) => {
      const h = await harness({ status })
      const { pending, roundRunId } = await pause(h, name)
      expect(pending.card.reversibility).toBe('snapshotted')
      expect(h.take).not.toHaveBeenCalled()
      const originalWrite = h.memory.fs.writeFile.bind(h.memory.fs)
      const written = vi.spyOn(h.memory.fs, 'writeFile').mockImplementation(async (path, data) => {
        const entries = await h.entries()
        expect(
          entries.some(
            (entry) =>
              entry.name === 'fs/snapshot_created' && entry.payload['moment'] === 'before-call',
          ),
        ).toBe(true)
        await originalWrite(path, data)
      })
      await finish(h, pending)
      expect(written).toHaveBeenCalledExactlyOnceWith(FILE, 'after')
      expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('after')
      const entries = await h.entries()
      const snapshots = entries.filter((entry) => entry.name === 'fs/snapshot_created')
      expect(snapshots.map((entry) => [entry.payload['moment'], entry.payload['scope']])).toEqual([
        ['before-call', status === 'tree' ? 'tree' : 'file'],
        ['after-call', 'file'],
      ])
      const before = snapshots[0]!
      const after = snapshots[1]!
      expect(before.payload).toMatchObject({ roundRunId, path: FILE, writer: { by: 'run' } })
      expect(before.sourceType).toBe('runtime_event')
      expect(before.sourceId).toBe(before.payload['runId'])
      expect(before.sourceSeq).toBe(before.payload['requestSeq'])
      expect(before.provenanceKey).toBe(
        `fs:v1:snapshot:${before.sourceId}:${before.sourceSeq}:0:before-call`,
      )
      expect(after.provenanceKey).toBe(
        `fs:v1:snapshot:${before.sourceId}:${before.sourceSeq}:0:after-call`,
      )
      expect(before.entryId).toBeLessThan(
        entries.find((entry) => entry.name === 'tool/result')!.entryId,
      )
      expect(before.entryId).toBeLessThan(
        entries.find((entry) => entry.name === 'execution/tool_outcome')!.entryId,
      )
      expect(await outcome(h)).toMatchObject({
        snapshotId: before.payload['snapshotId'],
        state: 'completed',
        reversibility: 'snapshotted',
      })
      expect(h.take.mock.calls.map(([request]) => request.call.roundRunId)).toEqual([
        roundRunId,
        roundRunId,
      ])
    },
  )

  it.each(['error', 'disk', 'over-budget', 'not-covered', 'no-git', 'aborted'] as const)(
    '05 验收 2: a promised snapshot failing with %s leaves the file untouched',
    async (reason) => {
      const h = await harness()
      const { pending } = await pause(h, 'Write')
      h.memory.snapshots.failNextTake(reason)
      const write = vi.spyOn(h.memory.fs, 'writeFile')
      await finish(h, pending)
      expect(write).not.toHaveBeenCalled()
      expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
      expect(await result(h)).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: SNAPSHOT_FAILED }],
      })
      expect(await outcome(h)).toMatchObject({ state: 'completed', reversibility: 'snapshotted' })
      expect(await outcome(h)).not.toHaveProperty('snapshotId')
      expect((await h.entries()).filter((entry) => entry.name === 'fs/snapshot_created')).toEqual(
        [],
      )
    },
  )

  it('05 验收 2: a snapshot timeout fails the write without opening the target', async () => {
    const h = await harness()
    const { pending } = await pause(h, 'Write')
    h.memory.snapshots.takeDelayMs = 6000
    const write = vi.spyOn(h.memory.fs, 'writeFile')
    h.provider.script(done())
    await answer(h, pending)
    await vi.waitFor(() => expect(h.take).toHaveBeenCalledOnce())
    h.memory.advance(5000)
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(write).not.toHaveBeenCalled()
    expect(await result(h)).toMatchObject({ isError: true })
    expect(await outcome(h)).toMatchObject({ state: 'completed' })
  })

  it.each(['file-only', 'unavailable'] as const)(
    '05 验收 2、9: an approved tree promise survives degradation to %s',
    async (status) => {
      const h = await harness()
      const { pending } = await pause(h, 'Write')
      h.memory.snapshots.setStatus(SESSION, status)
      await finish(h, pending)
      expect(h.take).toHaveBeenCalled()
      expect(await outcome(h)).toMatchObject({ reversibility: 'snapshotted', state: 'completed' })
      expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe(
        status === 'file-only' ? 'after' : 'before',
      )
      expect(
        (await h.entries())
          .filter((entry) => entry.name === 'fs/snapshot_created')
          .map((entry) => entry.payload['scope']),
      ).toEqual(status === 'file-only' ? ['file', 'file'] : [])
    },
  )

  it('05 验收 9: a file call approved without coverage does not start promising snapshots later', async () => {
    const h = await harness({ status: 'unavailable' })
    const { pending } = await pause(h, 'Write')
    expect(pending.card.reversibility).toBe('unknown')
    h.memory.snapshots.setStatus(SESSION, 'tree')
    await finish(h, pending)
    expect(h.take).not.toHaveBeenCalled()
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('after')
    expect(await outcome(h)).not.toHaveProperty('snapshotId')
  })

  it.each(['Write', 'Edit'])(
    '05 验收 42: %s refuses a target modified after capture',
    async (name) => {
      const h = await harness()
      const { pending } = await pause(h, name)
      const original = h.takeReal
      h.take.mockImplementation(async (request, signal) => {
        const taken = await original(request, signal)
        if (request.moment === 'before-call') await h.memory.fs.writeFile(FILE, 'external edit')
        return taken
      })
      await finish(h, pending)
      expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('external edit')
      expect(await result(h)).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: SNAPSHOT_CHANGED }],
      })
      expect(await outcome(h)).toMatchObject({ state: 'completed' })
      expect(
        (await h.entries())
          .filter((entry) => entry.name === 'fs/snapshot_created')
          .map((entry) => entry.payload['moment']),
      ).toEqual(['before-call'])
    },
  )

  it('05 验收 42: a new target appearing after capture is left intact', async () => {
    const h = await harness({ missing: true })
    const { pending } = await pause(h, 'Write')
    const original = h.takeReal
    h.take.mockImplementation(async (request, signal) => {
      const taken = await original(request, signal)
      if (request.moment === 'before-call') await h.memory.fs.writeFile(FILE, 'external new file')
      return taken
    })
    await finish(h, pending)
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('external new file')
    expect(await result(h)).toMatchObject({ isError: true })
  })

  it.each(['Write', 'Bash'])(
    '05 验收 43: stopping during %s capture writes neither snapshot facts nor the target or command',
    async (name) => {
      const h = await harness()
      const { pending } = await pause(h, name)
      h.memory.snapshots.takeDelayMs = 1000
      const write = vi.spyOn(h.memory.fs, 'writeFile')
      await answer(h, pending)
      await vi.waitFor(() => expect(h.take).toHaveBeenCalledOnce())
      const signal = h.take.mock.calls[0]![1]
      await h.service.stop({ rootSessionId: SESSION })
      expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
      h.memory.advance(1000)
      expect(signal.aborted).toBe(true)
      expect(write).not.toHaveBeenCalled()
      expect(h.spawn).not.toHaveBeenCalled()
      expect(
        (await h.entries()).filter(
          (entry) =>
            entry.name === 'fs/snapshot_created' || entry.name === 'execution/dispatch_committed',
        ),
      ).toEqual([])
      expect(await outcome(h)).toMatchObject({ state: 'not-run', source: 'stopped' })
    },
  )

  it('05 验收 43: a stop after capture but before its Tape write drops the captured fact', async () => {
    const h = await harness()
    const { pending } = await pause(h, 'Write')
    let captured = false
    const original = h.takeReal
    h.take.mockImplementation(async (request, signal) => {
      const taken = await original(request, signal)
      captured = true
      return taken
    })
    const now = h.memory.clock.now.bind(h.memory.clock)
    vi.spyOn(h.memory.clock, 'now').mockImplementation(() => {
      if (captured) {
        captured = false
        void h.service.stop({ rootSessionId: SESSION })
      }
      return now()
    })
    await answer(h, pending)
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
    expect((await h.entries()).filter((entry) => entry.name === 'fs/snapshot_created')).toEqual([])
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
  })

  it.each(['tree', 'warming', 'file-only', 'unavailable'] as const)(
    '05 验收 9、43: Bash in %s records enough evidence to tell whether the command had a tree snapshot',
    async (status) => {
      const h = await harness({ status })
      const { pending } = await pause(h, 'Bash')
      expect(pending.card.reversibility).toBe('unknown')
      const spawn = h.spawn.getMockImplementation()!
      h.spawn.mockImplementation(async (request) => {
        expect(
          (await h.entries())
            .filter((entry) => entry.name === 'fs/snapshot_created')
            .map((entry) => entry.payload['moment']),
        ).toEqual(status === 'tree' ? ['before-call'] : [])
        return spawn(request)
      })
      await finish(h, pending)
      expect(h.spawn).toHaveBeenCalledOnce()
      expect(h.take.mock.calls.map(([request]) => request.moment)).toEqual(
        status === 'tree' ? ['before-call', 'after-call'] : [],
      )
      expect(h.take.mock.calls.some(([request]) => request.path !== undefined)).toBe(false)
      const entries = await h.entries()
      const dispatch = entries.find((entry) => entry.name === 'execution/dispatch_committed')!
      const backed = entries.some(
        (entry) =>
          entry.name === 'fs/snapshot_created' &&
          entry.sourceId === dispatch.sourceId &&
          entry.sourceSeq === dispatch.sourceSeq &&
          entry.payload['ordinal'] === dispatch.payload['ordinal'] &&
          entry.payload['moment'] === 'before-call' &&
          entry.payload['scope'] === 'tree',
      )
      expect(backed).toBe(status === 'tree')
    },
  )

  it('05 验收 9: Bash still runs if its before-call tree snapshot fails', async () => {
    const h = await harness()
    const { pending } = await pause(h, 'Bash')
    h.memory.snapshots.failNextTake('error')
    await finish(h, pending)
    expect(h.spawn).toHaveBeenCalledOnce()
    expect(
      (await h.entries())
        .filter((entry) => entry.name === 'fs/snapshot_created')
        .map((entry) => entry.payload['moment']),
    ).toEqual(['after-call'])
    expect(await outcome(h)).not.toHaveProperty('snapshotId')
  })

  it('05 验收 9: Bash still runs after its tree snapshot times out and the session degrades', async () => {
    const h = await harness()
    const { pending } = await pause(h, 'Bash')
    h.memory.snapshots.takeDelayMs = 6000
    h.take.mockImplementation(async (request, signal) => {
      const taken = await h.takeReal(request, signal)
      h.memory.snapshots.takeDelayMs = 0
      return taken
    })
    h.provider.script(done())
    await answer(h, pending)
    await vi.waitFor(() => expect(h.take).toHaveBeenCalledOnce())
    h.memory.advance(5000)
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(h.spawn).toHaveBeenCalledOnce()
    expect(h.memory.snapshots.status(SESSION)).toBe('file-only')
    expect((await h.entries()).filter((entry) => entry.name === 'fs/snapshot_created')).toEqual([])
    expect(await outcome(h)).not.toHaveProperty('snapshotId')
  })

  it('05 验收 1: a failed atomic snapshot/dispatch append never reaches the file executor', async () => {
    let rejectSnapshots = true
    const h = await harness({
      store: (store) =>
        proxyStore(store, {
          append: async (batch) => {
            if (
              rejectSnapshots &&
              batch.entries.some((entry) => entry.name === 'fs/snapshot_created')
            ) {
              rejectSnapshots = false
              throw new Error('snapshot append failed')
            }
            return store.append(batch)
          },
        }),
    })
    const { pending } = await pause(h, 'Write')
    await answer(h, pending)
    await h.loop.runEnded()
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
    expect(
      (await h.entries()).filter(
        (entry) =>
          entry.name === 'fs/snapshot_created' || entry.name === 'execution/dispatch_committed',
      ),
    ).toEqual([])
  })

  it.each(['Write', 'Edit'])(
    '05 验收 42: %s rechecks the snapshot at its final write boundary',
    async (name) => {
      const h = await harness()
      const { pending } = await pause(h, name)
      let changed = false
      const read = h.memory.fs.readFile.bind(h.memory.fs)
      const stat = h.memory.fs.stat.bind(h.memory.fs)
      vi.spyOn(h.memory.fs, 'readFile').mockImplementation(async (path, opts) => {
        const data = await read(path, opts)
        if (name === 'Edit' && path === FILE && !changed) {
          changed = true
          await h.memory.fs.writeFile(FILE, 'changed during read')
        }
        return data
      })
      vi.spyOn(h.memory.fs, 'stat').mockImplementation(async (path) => {
        const data = await stat(path)
        if (name === 'Write' && path === WORK && !changed) {
          changed = true
          await h.memory.fs.writeFile(FILE, 'changed during stat')
        }
        return data
      })
      await finish(h, pending)
      expect(await read(FILE, { encoding: 'utf8' })).toBe(
        name === 'Edit' ? 'changed during read' : 'changed during stat',
      )
      expect(await result(h)).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: SNAPSHOT_CHANGED }],
      })
    },
  )

  it('05 验收 43: a host returning success after stop cannot publish its captured snapshot', async () => {
    const h = await harness()
    const { pending } = await pause(h, 'Write')
    h.take.mockImplementation(async (request, signal) => {
      const taken = await h.takeReal(request, signal)
      await h.service.stop({ rootSessionId: SESSION })
      return taken
    })
    await answer(h, pending)
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
    expect((await h.entries()).filter((entry) => entry.name === 'fs/snapshot_created')).toEqual([])
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
  })

  it.each(['Write', 'Edit'])(
    '05 验收 43: stopping at %s identity recheck prevents the file operation',
    async (name) => {
      const h = await harness()
      const { pending } = await pause(h, name)
      let captured = false
      h.take.mockImplementation(async (request, signal) => {
        const taken = await h.takeReal(request, signal)
        captured = true
        return taken
      })
      const identity = h.memory.fs.identity.bind(h.memory.fs)
      vi.spyOn(h.memory.fs, 'identity').mockImplementation(async (path) => {
        const stamp = await identity(path)
        if (captured) {
          captured = false
          await h.service.stop({ rootSessionId: SESSION })
        }
        return stamp
      })
      await answer(h, pending)
      expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
      expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
      expect(await outcome(h)).toMatchObject({ state: 'aborted', source: 'stopped' })
    },
  )

  it('05 验收 43: stopping after mutation during the after-call snapshot preserves the real outcome', async () => {
    const h = await harness()
    const { pending } = await pause(h, 'Write')
    h.take.mockImplementation(async (request, signal) => {
      if (request.moment === 'after-call') await h.service.stop({ rootSessionId: SESSION })
      return h.takeReal(request, signal)
    })
    await answer(h, pending)
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('after')
    expect(await outcome(h)).toMatchObject({ state: 'completed', reversibility: 'snapshotted' })
    expect(
      (await h.entries())
        .filter((entry) => entry.name === 'fs/snapshot_created')
        .map((entry) => entry.payload['moment']),
    ).toEqual(['before-call'])
  })

  it('05 验收 43: a Bash dispatch that wins the stop race is killed by the existing stop sequence', async () => {
    const h = await harness()
    const { pending } = await pause(h, 'Bash')
    const child = fakeChild(() => h.memory.clock.now(), 'dies')
    h.spawn.mockImplementation(async () => child.child)
    await answer(h, pending)
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce())
    await h.service.stop({ rootSessionId: SESSION })
    await vi.waitFor(() => expect(child.kills.map((kill) => kill.signal)).toEqual(['SIGTERM']))
    // As in stop.test.ts: let the SIGTERM await install the grace timer before advancing it.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    h.memory.advance(STOP_TERM_GRACE_MS)
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
    expect(child.kills.map((kill) => kill.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(await outcome(h)).toMatchObject({ state: 'aborted', source: 'stopped' })
    expect(
      (await h.entries())
        .filter((entry) => entry.name === 'fs/snapshot_created')
        .map((entry) => entry.payload['moment']),
    ).toEqual(['before-call'])
  })

  it('05 验收 1、37: resumed calls share a root round and the next message starts another round', async () => {
    const h = await harness()
    const { pending, roundRunId } = await pause(h, 'Write')
    h.provider.script(call('Write', { file_path: FILE, content: 'again' }, 'second'))
    h.provider.script(done())
    await answer(h, pending)
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(h.take.mock.calls.map(([request]) => request.call.roundRunId)).toEqual([
      roundRunId,
      roundRunId,
      roundRunId,
      roundRunId,
    ])
    h.provider.script(call('Write', { file_path: FILE, content: 'next round' }, 'third'))
    h.provider.script(done())
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'next task' })
    if (sent.status !== 'started') throw new Error('next run did not start')
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(h.take.mock.calls.slice(-2).map(([request]) => request.call.roundRunId)).toEqual([
      sent.runId,
      sent.runId,
    ])
    expect(sent.runId).not.toBe(roundRunId)
  })

  it('05 验收 43: stopping after the parent stat creates neither missing folders nor the target', async () => {
    const h = await harness()
    const parent = absolutePath('/work/newdir')
    const path = absolutePath('/work/newdir/a.txt')
    const { pending } = await pause(h, 'Write', { file_path: path, content: 'after' })
    const stat = h.memory.fs.stat.bind(h.memory.fs)
    vi.spyOn(h.memory.fs, 'stat').mockImplementation(async (target) => {
      const value = await stat(target)
      if (target === parent) await h.service.stop({ rootSessionId: SESSION })
      return value
    })
    await answer(h, pending)
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
    expect(await stat(parent)).toBeNull()
    expect(await stat(path)).toBeNull()
    expect(await outcome(h)).toMatchObject({ state: 'aborted', source: 'stopped' })
  })

  it('05 验收 1: a host write error after a partial write still records the after-call snapshot', async () => {
    const h = await harness()
    const { pending } = await pause(h, 'Write')
    const write = h.memory.fs.writeFile.bind(h.memory.fs)
    vi.spyOn(h.memory.fs, 'writeFile').mockImplementation(async (path) => {
      await write(path, 'partial write')
      throw new Error('write failed after some bytes')
    })
    await finish(h, pending)
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('partial write')
    expect(await result(h)).toMatchObject({ isError: true })
    expect(await outcome(h)).toMatchObject({ state: 'completed' })
    expect(
      (await h.entries())
        .filter((entry) => entry.name === 'fs/snapshot_created')
        .map((entry) => entry.payload['moment']),
    ).toEqual(['before-call', 'after-call'])
  })

  it.each(
    (['deleted', 'replaced by a link'] as const).flatMap((change) =>
      (['after capture', 'during stat'] as const).map((timing) => ({ change, timing })),
    ),
  )(
    '05 验收 42: Edit leaves external changes before-only when $change $timing',
    async ({ change, timing }) => {
      const h = await harness()
      await h.memory.fs.writeFile(absolutePath('/work/other.txt'), 'other content')
      const { pending } = await pause(h, 'Edit')
      let changed = false
      const mutate = async () => {
        if (changed) return
        changed = true
        await h.memory.fs.remove(FILE)
        if (change === 'replaced by a link') h.memory.symlink(FILE, absolutePath('/work/other.txt'))
      }
      h.take.mockImplementation(async (request, signal) => {
        const taken = await h.takeReal(request, signal)
        if (request.moment === 'before-call' && timing === 'after capture') await mutate()
        return taken
      })
      const stat = h.memory.fs.stat.bind(h.memory.fs)
      vi.spyOn(h.memory.fs, 'stat').mockImplementation(async (path) => {
        if (path === FILE && timing === 'during stat') await mutate()
        return stat(path)
      })
      await finish(h, pending)
      expect(await result(h)).toMatchObject({ isError: true })
      expect((await h.memory.fs.identity(FILE))?.kind ?? null).toBe(
        change === 'deleted' ? null : 'link',
      )
      expect(
        (await h.entries())
          .filter((entry) => entry.name === 'fs/snapshot_created')
          .map((entry) => entry.payload['moment']),
      ).toEqual(['before-call'])
    },
  )

  it('05 验收 9: Bash records an after-call tree when warming finishes during the command', async () => {
    const h = await harness({ status: 'warming' })
    const { pending } = await pause(h, 'Bash')
    const spawn = h.spawn.getMockImplementation()!
    h.spawn.mockImplementation(async (request) => {
      h.memory.snapshots.setStatus(SESSION, 'tree')
      return spawn(request)
    })
    await finish(h, pending)
    expect(h.take.mock.calls.map(([request]) => request.moment)).toEqual(['after-call'])
    expect(
      (await h.entries())
        .filter((entry) => entry.name === 'fs/snapshot_created')
        .map((entry) => entry.payload['moment']),
    ).toEqual(['after-call'])
    expect(await outcome(h)).not.toHaveProperty('snapshotId')
  })

  it.each(['Write', 'Bash'])(
    '05 验收 43: %s whose dispatch commits before stop is aborted rather than closed not-run',
    async (name) => {
      let stopAfterDispatch: (() => void) | undefined
      const h = await harness({
        store: (store) =>
          proxyStore(store, {
            append: async (batch) => {
              const receipts = await store.append(batch)
              if (batch.entries.some((entry) => entry.name === 'execution/dispatch_committed'))
                stopAfterDispatch?.()
              return receipts
            },
          }),
      })
      const { pending } = await pause(h, name)
      stopAfterDispatch = () => {
        void h.service.stop({ rootSessionId: SESSION })
      }
      await answer(h, pending)
      expect((await h.loop.runEnded()).reason).toEqual({ code: 'user-stopped' })
      expect(await outcome(h)).toMatchObject({ state: 'aborted', source: 'stopped' })
      expect(h.spawn).not.toHaveBeenCalled()
      expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
      expect(
        (await h.entries()).filter((entry) => entry.name === 'execution/dispatch_committed'),
      ).toHaveLength(1)
    },
  )

  it('05 验收 37: a child writes snapshots on its own Tape into the root session and root round', async () => {
    const h = await harness()
    h.provider.script(call('Agent', { description: 'write task', prompt: 'change file' }))
    h.provider.script(call('Write', inputFor('Write')))
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'parent task' })
    if (sent.status !== 'started') throw new Error('parent did not start')
    expect((await rootEnd(h)).reason).toEqual({ code: 'paused', waitingFor: 'subagent' })
    const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
    if (pending === null) throw new Error('child approval missing')
    expect(pending.card.sessionId).not.toBe(SESSION)
    expect(pending.card.reversibility).toBe('snapshotted')
    h.provider.script(done())
    h.provider.script(done())
    await answer(h, pending)
    expect((await rootEnd(h)).reason).toEqual({ code: 'completed' })
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('after')
    expect(
      h.take.mock.calls.map(([request]) => [
        request.sessionId,
        request.call.sessionId,
        request.call.roundRunId,
      ]),
    ).toEqual([
      [SESSION, pending.card.sessionId, sent.runId],
      [SESSION, pending.card.sessionId, sent.runId],
    ])
    expect((await h.entries()).filter((entry) => entry.name === 'fs/snapshot_created')).toEqual([])
    const child = await h.entries(pending.card.sessionId)
    const snapshots = child.filter((entry) => entry.name === 'fs/snapshot_created')
    expect(snapshots).toHaveLength(2)
    expect(
      child.find((entry) => entry.name === 'execution/tool_outcome')?.payload['snapshotId'],
    ).toBe(snapshots[0]?.payload['snapshotId'])
    expect(snapshots.map((entry) => entry.payload['roundRunId'])).toEqual([sent.runId, sent.runId])
  })
})

async function rootEnd(h: Harness) {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- child and parent ends arrive in causal order
    const ended = await h.loop.runEnded()
    if (ended.sessionId === SESSION) return ended
  }
}
