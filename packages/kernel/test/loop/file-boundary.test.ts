/** Spec 05 steps 9–10: persisted stamps and the approved file mutation boundary. */
import { describe, expect, it, vi } from 'vitest'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type {
  MemoryHost,
  PendingApproval,
  SnapshotStatus,
  StreamEvent,
  TapeStore,
} from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import { FILE_CHANGED, HARDLINK_CHANGED } from '../../src/tools/snapshot-guard.js'
import { DELETE_TEXTS } from '../../src/tools/builtin/delete.js'
import { pendingCard } from './support.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const WORK = absolutePath('/work')
const FILE = absolutePath('/work/a.txt')
const MODEL = {
  id: 'file-model',
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
function call(name: string, input: Record<string, unknown>): StreamEvent[] {
  return [
    { type: 'tool-call-start', index: 0, id: 'call', name },
    { type: 'tool-call-end', index: 0, id: 'call', name, input },
    { type: 'usage', usage },
    stopEvent('tool-use', 'tool_use'),
  ]
}
function inputFor(name: string, path = FILE) {
  return name === 'Edit'
    ? { file_path: path, old_string: 'before', new_string: 'after' }
    : name === 'Write'
      ? { file_path: path, content: 'after' }
      : { file_path: path }
}
function runtime(memory: MemoryHost, store: TapeStore, idsFrom = 0) {
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({ connector: { provider, model: MODEL } })
  const logs: string[] = []
  const service = createTestSessionService(
    {
      host: memory,
      tape: store,
      ids: createCounterIds({ start: idsFrom }),
      inspectors: [],
      protectedFiles: [absolutePath('/protected/keep')],
      sensitivePaths: async () => ({ credential: [], autoRunNames: ['.envrc'], linkTargets: [] }),
      connector: loop.connector,
      log: (line) => logs.push(line),
    },
    { tools: { Read: 'real', Write: 'real', Edit: 'real', Delete: 'real', Agent: 'real' } },
  )
  service.bindLoop(loop)
  return {
    memory,
    store,
    provider,
    loop,
    service,
    logs,
    entries: async (sessionId = SESSION) =>
      (await store.readRange({ sessionId, limit: 1000 })).entries,
  }
}
async function harness(status: SnapshotStatus = 'unavailable') {
  const memory = createMemoryHost()
  await memory.fs.mkdirp(WORK)
  await memory.fs.writeFile(FILE, 'before')
  const h = runtime(memory, createMemoryTapeStore({ identity: memory.identity }))
  await h.service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: WORK })
  memory.snapshots.setStatus(SESSION, status)
  return h
}
type Harness = ReturnType<typeof runtime>
async function start(
  h: Harness,
  name: string,
  input: Record<string, unknown> = inputFor(name),
  sessionId = SESSION,
) {
  h.provider.script(call(name, input))
  const sent = await h.service.send({ sessionId, origin: null, text: 'file task' })
  if (sent.status !== 'started') throw new Error('run did not start')
  const ended = await h.loop.runEnded({ runId: sent.runId })
  if (ended.reason.code !== 'paused') return null
  const pending = pendingCard(await h.service.currentPending({ sessionId }))
  if (pending === null) throw new Error('approval missing')
  return pending
}
async function finish(h: Harness, pending: PendingApproval) {
  expect(
    await h.service.answer({
      kind: 'approval',
      sessionId: pending.card.sessionId,
      requestId: pending.card.requestId,
      decision: 'allow',
      origin: null,
    }),
  ).toEqual({ status: 'applied' })
  expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
  expect(h.logs).toEqual([])
}
async function invoke(
  h: Harness,
  name: string,
  input: Record<string, unknown> = inputFor(name),
  sessionId = SESSION,
) {
  // The automatic Read path also needs its next model response queued before it starts.
  h.provider.script(call(name, input))
  h.provider.script(done())
  const sent = await h.service.send({ sessionId, origin: null, text: 'file task' })
  if (sent.status !== 'started') throw new Error('run did not start')
  const ended = await h.loop.runEnded({ runId: sent.runId })
  if (ended.reason.code === 'paused') {
    const pending = pendingCard(await h.service.currentPending({ sessionId }))
    if (pending === null) throw new Error('approval missing')
    await finish(h, pending)
    return
  }
  expect(ended.reason).toEqual({ code: 'completed' })
  expect(h.logs).toEqual([])
}
const result = async (h: Harness) =>
  (await h.entries()).findLast((e) => e.name === 'tool/result')!.payload
const outcome = async (h: Harness) =>
  (await h.entries()).findLast((e) => e.name === 'execution/tool_outcome')!.payload
async function refused(h: Harness, text: string) {
  expect(await result(h)).toMatchObject({ isError: true, content: [{ type: 'text', text }] })
  expect(await outcome(h)).toMatchObject({ state: 'completed' })
  expect(await outcome(h)).not.toHaveProperty('file')
}

describe('05 persisted file stamps', () => {
  it('05 验收 23: Read, Write and Edit persist the stamp of their successful file result', async () => {
    const h = await harness()
    const read = vi.spyOn(h.memory.fs.guarded, 'read')
    const rawRead = vi.spyOn(h.memory.fs, 'readFile')
    await invoke(h, 'Read')
    expect(read).toHaveBeenCalledOnce()
    expect(rawRead).not.toHaveBeenCalled()
    expect(await outcome(h)).toMatchObject({ file: { mtimeNs: '0', size: 6 } })
    h.memory.advance(1)
    await invoke(h, 'Write', { file_path: FILE, content: 'before!' })
    expect(await outcome(h)).toMatchObject({ file: { mtimeNs: '1000000', size: 7 } })
    h.memory.advance(1)
    await invoke(h, 'Edit')
    expect(await outcome(h)).toMatchObject({ file: { mtimeNs: '2000000', size: 6 } })
  })

  it('05 验收 23: a Read whose open handle changed during reading records no stamp', async () => {
    const h = await harness()
    vi.spyOn(h.memory.fs.guarded, 'read').mockResolvedValue({ data: 'moving file', stamp: null })
    await invoke(h, 'Read')
    expect(await result(h)).toMatchObject({ isError: false })
    expect(await outcome(h)).not.toHaveProperty('file')
  })

  it('05 验收 23: Read forwards the opened-file stamp, never a later identity of the path', async () => {
    const h = await harness()
    const identity = (await h.memory.fs.identity(FILE))!
    vi.spyOn(h.memory.fs.guarded, 'read').mockResolvedValue({
      data: 'opened B',
      stamp: { ...identity, size: 8, mtimeNs: 123n },
    })
    await invoke(h, 'Read')
    expect(await outcome(h)).toMatchObject({ file: { mtimeNs: '123', size: 8 } })
    await invoke(h, 'Write')
    await refused(h, FILE_CHANGED)
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
  })

  it.each(['Write', 'Edit'])(
    '05 验收 23: %s refuses a different size even at the same mtime',
    async (name) => {
      const h = await harness()
      await invoke(h, 'Read')
      await h.memory.fs.writeFile(FILE, 'before externally edited')
      await invoke(h, name)
      await refused(h, FILE_CHANGED)
      expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe(
        'before externally edited',
      )
      await invoke(h, 'Read')
      await invoke(h, name)
      expect(await result(h)).toMatchObject({ isError: false })
    },
  )

  it.each(['Write', 'Edit'])(
    '05 验收 23: %s refuses a different nanosecond mtime at the same size',
    async (name) => {
      const h = await harness()
      await invoke(h, 'Read')
      h.memory.advance(1)
      await h.memory.fs.writeFile(FILE, 'before')
      await invoke(h, name)
      await refused(h, FILE_CHANGED)
      expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
    },
  )

  it('05 验收 24: a restarted session uses its Tape stamp at the same real path through an alias', async () => {
    const h = await harness()
    h.memory.symlink(absolutePath('/work/alias'), FILE)
    await invoke(h, 'Read', { file_path: '/work/alias' })
    const pending = await start(h, 'Write')
    if (pending === null) throw new Error('approval missing')
    await h.memory.fs.writeFile(FILE, 'external version')
    const restarted = runtime(h.memory, h.store, 1000)
    await restarted.service.recover()
    restarted.provider.script(done())
    await finish(restarted, pending)
    await refused(restarted, FILE_CHANGED)
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('external version')
  })

  it('05 验收 23: a stamp from another path or session cannot block an unread target', async () => {
    const h = await harness()
    const otherFile = absolutePath('/work/b.txt')
    await h.memory.fs.writeFile(otherFile, 'different')
    await invoke(h, 'Read', { file_path: otherFile })
    await h.service.selectProfile({ sessionId: OTHER, profile: 'cowork', dedicated: WORK })
    await invoke(h, 'Read', inputFor('Read'), OTHER)
    await h.memory.fs.writeFile(FILE, 'external version')
    await invoke(h, 'Write')
    expect(await result(h)).toMatchObject({ isError: false })
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('after')
  })

  it('05 验收 50: a removed target is exclusively recreated despite its older Read stamp', async () => {
    const h = await harness()
    await invoke(h, 'Read')
    await h.memory.fs.remove(FILE)
    const create = vi.spyOn(h.memory.fs.guarded, 'create')
    await invoke(h, 'Write')
    expect(create).toHaveBeenCalledExactlyOnceWith(FILE, 'after')
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('after')
    expect(await outcome(h)).toMatchObject({ file: { mtimeNs: '0', size: 5 } })
  })

  it('05 验收 50: a file appearing between the missing check and exclusive create is untouched', async () => {
    const h = await harness()
    await invoke(h, 'Read')
    await h.memory.fs.remove(FILE)
    const create = h.memory.fs.guarded.create
    vi.spyOn(h.memory.fs.guarded, 'create').mockImplementation(async (path, data) => {
      await h.memory.fs.writeFile(path, 'external new file')
      await create(path, data)
    })
    await invoke(h, 'Write')
    await refused(h, FILE_CHANGED)
    expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('external new file')
  })

  it.each(['Write', 'Edit'])(
    '05 验收 25: %s rechecks name counts at the final write boundary without snapshots',
    async (name) => {
      const h = await harness()
      await invoke(h, 'Read')
      const read = h.memory.fs.readFile.bind(h.memory.fs)
      const stat = h.memory.fs.stat.bind(h.memory.fs)
      let changed = false
      const change = () => {
        if (!changed) {
          changed = true
          h.memory.hardlink(FILE, absolutePath('/work/second'))
        }
      }
      vi.spyOn(h.memory.fs, 'readFile').mockImplementation(async (path, opts) => {
        const data = await read(path, opts)
        if (name === 'Edit' && path === FILE) change()
        return data
      })
      vi.spyOn(h.memory.fs, 'stat').mockImplementation(async (path) => {
        const data = await stat(path)
        if (name === 'Write' && path === WORK) change()
        return data
      })
      await invoke(h, name)
      await refused(h, HARDLINK_CHANGED)
      expect(await read(FILE, { encoding: 'utf8' })).toBe('before')
      expect(await read(absolutePath('/work/second'), { encoding: 'utf8' })).toBe('before')
    },
  )

  it('05 验收 50: Edit exclusively recreates a target removed while its text was being read', async () => {
    const h = await harness()
    await invoke(h, 'Read')
    const read = h.memory.fs.readFile.bind(h.memory.fs)
    vi.spyOn(h.memory.fs, 'readFile').mockImplementationOnce(async (path, opts) => {
      const data = await read(path, opts)
      await h.memory.fs.remove(path)
      return data
    })
    const create = vi.spyOn(h.memory.fs.guarded, 'create')
    await invoke(h, 'Edit')
    expect(create).toHaveBeenCalledExactlyOnceWith(FILE, 'after')
    expect(await result(h)).toMatchObject({ isError: false })
    expect(await read(FILE, { encoding: 'utf8' })).toBe('after')
  })

  it.each(['Write', 'Edit'])(
    '05 验收 25: %s refuses a second name added after approval during capture',
    async (name) => {
      const h = await harness('tree')
      const pending = await start(h, name)
      if (pending === null) throw new Error('approval missing')
      const take = h.memory.snapshots.take.bind(h.memory.snapshots)
      vi.spyOn(h.memory.snapshots, 'take').mockImplementation(async (q, signal) => {
        const captured = await take(q, signal)
        if (q.moment === 'before-call') h.memory.hardlink(FILE, absolutePath('/work/second'))
        return captured
      })
      h.provider.script(done())
      await finish(h, pending)
      await refused(h, HARDLINK_CHANGED)
      expect(await h.memory.fs.readFile(FILE, { encoding: 'utf8' })).toBe('before')
      expect(await h.memory.fs.readFile(absolutePath('/work/second'), { encoding: 'utf8' })).toBe(
        'before',
      )
    },
  )

  it('05 验收 25: a second name appearing during judgment still requires its own approval', async () => {
    const h = await harness()
    await invoke(h, 'Write')
    const identity = h.memory.fs.identity.bind(h.memory.fs)
    let linked = false
    vi.spyOn(h.memory.fs, 'identity').mockImplementation(async (path) => {
      const at = await identity(path)
      if (path === FILE && !linked) {
        linked = true
        h.memory.hardlink(FILE, absolutePath('/work/second'))
      }
      return at
    })
    const pending = await start(h, 'Write')
    expect(pending?.card).toMatchObject({
      reason: 'sensitive-path',
      facts: { category: 'hardlink' },
    })
  })

  it.each(['Write', 'Edit', 'Delete'])(
    '05 验收 25: an approved hardlink also classified auto-run can execute %s',
    async (name) => {
      const h = await harness('tree')
      const path = absolutePath('/work/.envrc')
      await h.memory.fs.writeFile(path, 'before')
      h.memory.hardlink(path, absolutePath('/work/second'))
      await invoke(h, name, inputFor(name, path))
      expect(await result(h)).toMatchObject({ isError: false })
      expect(await h.memory.fs.readFile(absolutePath('/work/second'), { encoding: 'utf8' })).toBe(
        name === 'Delete' ? 'before' : 'after',
      )
    },
  )

  it('05 验收 25: an explicitly approved preexisting hardlink can be written and asks again next time', async () => {
    const h = await harness('tree')
    h.memory.hardlink(FILE, absolutePath('/work/second'))
    const pending = await start(h, 'Write')
    expect(pending?.card).toMatchObject({
      reason: 'sensitive-path',
      facts: { category: 'hardlink' },
    })
    if (pending === null) throw new Error('approval missing')
    h.provider.script(done())
    await finish(h, pending)
    expect(await h.memory.fs.readFile(absolutePath('/work/second'), { encoding: 'utf8' })).toBe(
      'after',
    )
    const again = await start(h, 'Write')
    expect(again?.card.reason).toBe('sensitive-path')
  })
})

describe('05 Delete execution', () => {
  it('05 验收 29: Delete captures before removing and links its completed outcome to that snapshot', async () => {
    const h = await harness('tree')
    const remove = h.memory.fs.remove.bind(h.memory.fs)
    vi.spyOn(h.memory.fs, 'remove').mockImplementation(async (path) => {
      expect(
        (await h.entries()).some(
          (e) => e.name === 'fs/snapshot_created' && e.payload['moment'] === 'before-call',
        ),
      ).toBe(true)
      await remove(path)
    })
    await invoke(h, 'Delete')
    expect(await h.memory.fs.identity(FILE)).toBeNull()
    expect(await result(h)).toMatchObject({ isError: false })
    const entries = await h.entries()
    const snapshots = entries.filter((e) => e.name === 'fs/snapshot_created')
    expect(snapshots.map((e) => e.payload['moment'])).toEqual(['before-call', 'after-call'])
    expect(snapshots[0]!.entryId).toBeLessThan(
      entries.find((e) => e.name === 'tool/result')!.entryId,
    )
    expect(snapshots[0]!.entryId).toBeLessThan(
      entries.find((e) => e.name === 'execution/tool_outcome')!.entryId,
    )
    expect(await outcome(h)).toMatchObject({
      state: 'completed',
      snapshotId: snapshots[0]!.payload['snapshotId'],
    })
  })

  it('05 验收 29: Delete records its after-call snapshot even if removal mutates then throws', async () => {
    const h = await harness('tree')
    const remove = h.memory.fs.remove.bind(h.memory.fs)
    vi.spyOn(h.memory.fs, 'remove').mockImplementation(async (path) => {
      await remove(path)
      throw new Error('host failed after unlink')
    })
    await invoke(h, 'Delete')
    expect(await result(h)).toMatchObject({ isError: true })
    expect(await h.memory.fs.identity(FILE)).toBeNull()
    expect(
      (await h.entries())
        .filter((e) => e.name === 'fs/snapshot_created')
        .map((e) => e.payload['moment']),
    ).toEqual(['before-call', 'after-call'])
  })

  it.each([
    {
      row: 'covered workspace',
      path: FILE,
      status: 'tree',
      reason: 'default',
      reversibility: 'snapshotted',
    },
    {
      row: 'uncovered workspace',
      path: FILE,
      status: 'unavailable',
      reason: 'irreversible',
      reversibility: 'irreversible',
    },
    {
      row: 'sensitive',
      path: absolutePath('/work/.envrc'),
      status: 'tree',
      reason: 'sensitive-path',
      reversibility: 'snapshotted',
    },
    {
      row: 'outside',
      path: absolutePath('/other/a.txt'),
      status: 'tree',
      reason: 'outside-workspace',
      reversibility: 'irreversible',
    },
  ] as const)(
    '05 验收 29、30: Delete asks for $row with its specified reason and coverage',
    async (row) => {
      const h = await harness(row.status)
      await h.memory.fs.mkdirp(absolutePath('/other'))
      await h.memory.fs.writeFile(row.path, 'before')
      if (row.row === 'outside') vi.spyOn(h.memory.snapshots, 'coverage').mockResolvedValue('none')
      const pending = await start(h, 'Delete', inputFor('Delete', row.path))
      expect(pending?.card).toMatchObject({
        kind: 'file',
        reason: row.reason,
        reversibility: row.reversibility,
        target: { type: 'path', path: row.path },
      })
      if (pending === null) throw new Error('approval missing')
      h.provider.script(done())
      await finish(h, pending)
      expect(await h.memory.fs.identity(row.path)).toBeNull()
      // Recreate: the previous allow must never become a session grant for Delete.
      await h.memory.fs.writeFile(row.path, 'again')
      const again = await start(h, 'Delete', inputFor('Delete', row.path))
      expect(again?.card.reason).toBe(row.reason)
    },
  )

  it.each(['missing', 'directory'] as const)(
    '05 验收 30: Delete fails completed on a %s target without removing anything',
    async (kind) => {
      const h = await harness()
      await h.memory.fs.remove(FILE)
      if (kind === 'directory') await h.memory.fs.mkdirp(FILE)
      const remove = vi.spyOn(h.memory.fs, 'remove')
      await invoke(h, 'Delete')
      expect(await result(h)).toMatchObject({ isError: true })
      expect(await outcome(h)).toMatchObject({ state: 'completed' })
      expect(remove).not.toHaveBeenCalled()
      expect((await h.memory.fs.identity(FILE))?.kind ?? null).toBe(
        kind === 'missing' ? null : 'dir',
      )
    },
  )

  it('05 验收 30: Delete refuses a parent replaced by a link after judgment', async () => {
    const h = await harness('tree')
    await h.memory.fs.mkdirp(absolutePath('/other'))
    await h.memory.fs.writeFile(absolutePath('/other/a.txt'), 'outside')
    const pending = await start(h, 'Delete', { file_path: '/work/sub/a.txt' })
    if (pending === null) throw new Error('approval missing')
    const take = h.memory.snapshots.take.bind(h.memory.snapshots)
    vi.spyOn(h.memory.snapshots, 'take').mockImplementation(async (q, signal) => {
      const captured = await take(q, signal)
      if (q.moment === 'before-call') h.memory.symlink(absolutePath('/work/sub'), '/other')
      return captured
    })
    h.provider.script(done())
    await finish(h, pending)
    await refused(h, DELETE_TEXTS.parentChanged)
    expect(await h.memory.fs.readFile(absolutePath('/other/a.txt'), { encoding: 'utf8' })).toBe(
      'outside',
    )
  })

  it.each(['tree', 'unavailable'] as const)(
    '05 验收 30、32: Delete in %s refuses a regular leaf replaced by a link after judgment',
    async (status) => {
      const h = await harness(status)
      const pending = await start(h, 'Delete')
      if (pending === null) throw new Error('approval missing')
      await h.memory.fs.remove(FILE)
      h.memory.symlink(FILE, '/protected/keep')
      h.provider.script(done())
      await finish(h, pending)
      expect(await result(h)).toMatchObject({ isError: true })
      expect(await outcome(h)).toMatchObject({ state: 'completed' })
      expect((await h.memory.fs.identity(FILE))?.kind).toBe('link')
    },
  )

  it('05 验收 30: Delete removes a leaf link without following it into the protected target', async () => {
    const h = await harness('tree')
    await h.memory.fs.mkdirp(absolutePath('/protected'))
    await h.memory.fs.writeFile(absolutePath('/protected/keep'), 'protected')
    await h.memory.fs.remove(FILE)
    h.memory.symlink(FILE, '/protected/keep')
    await invoke(h, 'Delete')
    expect(await h.memory.fs.identity(FILE)).toBeNull()
    expect(await h.memory.fs.readFile(absolutePath('/protected/keep'), { encoding: 'utf8' })).toBe(
      'protected',
    )
    expect(await result(h)).toMatchObject({ isError: false })
    expect(
      (await h.entries())
        .filter((e) => e.name === 'fs/snapshot_created')
        .map((e) => e.payload['path']),
    ).toEqual([FILE, FILE])
  })

  it.each(['Write', 'Edit', 'Delete'])(
    '05 验收 25、30: a hardlink inside the own spill remains blocked for %s',
    async (name) => {
      const h = await harness()
      const dir = absolutePath(`/profiles/user/tenant/tool-output/${SESSION}`)
      const path = absolutePath(`${dir}/a.txt`)
      await h.memory.fs.mkdirp(dir)
      h.memory.hardlink(FILE, path)
      await invoke(h, name, inputFor(name, path))
      expect(await outcome(h)).toMatchObject({ state: 'not-run' })
      expect(await h.memory.fs.readFile(path, { encoding: 'utf8' })).toBe('before')
    },
  )

  it.each(['/protected/keep', '/profiles/user/tenant/keep'])(
    '05 验收 30: Delete blocks protected/profile path %s without a card',
    async (path) => {
      const h = await harness('tree')
      await h.memory.fs.mkdirp(absolutePath(path.slice(0, path.lastIndexOf('/'))))
      await h.memory.fs.writeFile(absolutePath(path), 'keep')
      await invoke(h, 'Delete', inputFor('Delete', absolutePath(path)))
      expect(pendingCard(await h.service.currentPending({ sessionId: SESSION }))).toBeNull()
      expect(await result(h)).toMatchObject({ isError: true })
      expect(await outcome(h)).toMatchObject({ state: 'not-run' })
      expect(await h.memory.fs.readFile(absolutePath(path), { encoding: 'utf8' })).toBe('keep')
    },
  )

  it('05 验收 29: a child receives Delete and captures on its own Tape in the root snapshot session', async () => {
    const h = await harness('tree')
    h.provider.script(call('Agent', { description: 'delete task', prompt: 'delete file' }))
    h.provider.script(call('Delete', inputFor('Delete')))
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'parent task' })
    if (sent.status !== 'started') throw new Error('run did not start')
    const rootEnd = async () => {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- wait for the causal child and root ends
        const ended = await h.loop.runEnded()
        if (ended.sessionId === SESSION) return ended
      }
    }
    expect((await rootEnd()).reason).toEqual({ code: 'paused', waitingFor: 'subagent' })
    const pending = pendingCard(await h.service.currentPending({ sessionId: SESSION }))
    if (pending === null) throw new Error('approval missing')
    expect(pending.card.sessionId).not.toBe(SESSION)
    h.provider.script(done())
    h.provider.script(done())
    const take = vi.spyOn(h.memory.snapshots, 'take')
    await h.service.answer({
      kind: 'approval',
      sessionId: pending.card.sessionId,
      requestId: pending.card.requestId,
      decision: 'allow',
      origin: null,
    })
    expect((await rootEnd()).reason).toEqual({ code: 'completed' })
    expect(await h.memory.fs.identity(FILE)).toBeNull()
    expect(
      take.mock.calls.map(([q]) => [q.sessionId, q.call.sessionId, q.call.roundRunId]),
    ).toEqual([
      [SESSION, pending.card.sessionId, sent.runId],
      [SESSION, pending.card.sessionId, sent.runId],
    ])
    expect(
      (await h.entries(pending.card.sessionId)).filter((e) => e.name === 'fs/snapshot_created'),
    ).toHaveLength(2)
  })
})
