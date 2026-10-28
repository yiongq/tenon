import { invokeRoute, snapshotPreview, snapshotRestore, snapshotRounds } from '@tenon-app/contracts'
import type { IpcMainLike } from '@tenon-app/contracts'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '@tenon-app/kernel'
import type { SnapshotRefusalCode } from '@tenon-app/kernel'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '@tenon-app/kernel/testing'
import { expect, it, vi } from 'vitest'
import { registerSnapshotRoutes, snapshotWindowCanAccess } from '../src/main/snapshot-routes.js'
import { refuseWhileShuttingDown } from '../src/main/shutdown.js'
import { refuseWhileRemoving } from '../src/main/session-removal.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const UNKNOWN = '33333333-3333-4333-8333-333333333333'
const WORK = absolutePath('/work/project')
const FILE = absolutePath('/work/project/a.txt')
const APP = 'file:///opt/tenon/out/renderer/index.html'
const MODEL = {
  id: 'route-model',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: false,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop' as const,
  usageNeedsOptIn: false,
}

async function harness(
  options: {
    gate?: Promise<void>
    noStore?: boolean
    shuttingDown?: boolean
    removing?: boolean
  } = {},
) {
  const host = createMemoryHost()
  await host.fs.mkdirp(WORK)
  await host.fs.writeFile(FILE, 'A')
  const store = createMemoryTapeStore({ identity: host.identity })
  const provider = createScriptedProvider({ models: [MODEL] })
  const ports = createTestLoopPorts({ connector: { provider, model: MODEL } })
  const sessions = createTestSessionService(
    {
      host,
      tape: store,
      ids: createCounterIds(),
      connector: ports.connector,
      inspectors: [],
      protectedFiles: [],
    },
    { tools: { Write: 'real' } },
  )
  sessions.bindLoop(ports)
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain: IpcMainLike = {
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    },
  }
  const frame = { url: APP }
  const sender = { mainFrame: frame, isDestroyed: () => false }
  const window = { webContents: sender, isDestroyed: () => false }
  const event = { sender, senderFrame: frame }
  const visible = vi.fn<(event: unknown, sessionId: string) => boolean>((caller) =>
    snapshotWindowCanAccess(caller, [window], APP),
  )
  const routes = refuseWhileRemoving(
    refuseWhileShuttingDown(ipcMain, () => options.shuttingDown ?? false),
    () => options.removing ?? false,
  )
  registerSnapshotRoutes({
    ipcMain: routes,
    sessions: options.noStore ? null : sessions,
    canAccessSession: visible,
    ...(options.gate === undefined ? {} : { gate: options.gate }),
  })
  const call = async (channel: string, request: unknown, caller: unknown = event) => {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error(`no handler: ${channel}`)
    return handler(caller, request)
  }
  const invoker = { invoke: (channel: string, request: unknown) => call(channel, request) }
  const entries = async () => (await store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  const change = async (sessionId = SESSION) => {
    await sessions.selectProfile({ sessionId, profile: 'cowork', dedicated: WORK })
    host.snapshots.setStatus(sessionId, 'tree')
    provider.script([
      { type: 'tool-call-start', index: 0, id: 'write', name: 'Write' },
      {
        type: 'tool-call-end',
        index: 0,
        id: 'write',
        name: 'Write',
        input: { file_path: FILE, content: 'B' },
      },
      stopEvent('tool-use', 'tool_use'),
    ])
    const sent = await sessions.send({ sessionId, text: 'write file', origin: null })
    if (sent.status !== 'started') throw new Error('Run did not start')
    await ports.runEnded({ runId: sent.runId })
    const pending = await sessions.currentPending({ sessionId })
    if (pending?.waitKind !== 'approval') throw new Error('Approval missing')
    provider.script(scriptedTurn({ deltas: ['done'] }))
    await sessions.answer({
      kind: 'approval',
      sessionId,
      requestId: pending.card.requestId,
      decision: 'allow',
      origin: null,
    })
    await ports.runEnded()
    return sent.runId
  }
  return { host, store, sessions, ports, visible, event, call, invoker, entries, change }
}
type Harness = Awaited<ReturnType<typeof harness>>
async function preview(h: Harness, roundRunId: string) {
  const result = await invokeRoute(h.invoker, snapshotPreview, { sessionId: SESSION, roundRunId })
  if (!result.ok) throw new Error(result.error.code)
  if (!result.data.ok) throw new Error(result.data.code)
  return result.data.preview
}
function requests(roundRunId: string, sessionId = SESSION) {
  return [
    ['snapshot.rounds', { sessionId }],
    ['snapshot.preview', { sessionId, roundRunId }],
    ['snapshot.restore', { sessionId, roundRunId, previewKey: 'preview', overwrite: [] }],
  ] as const
}

it('05 验收 18、22 (routes): rounds, preview and restore succeed through both schemas without approval or verdict facts', async () => {
  const h = await harness()
  const roundRunId = await h.change()
  const before = await h.entries()
  expect(await invokeRoute(h.invoker, snapshotRounds, { sessionId: SESSION })).toEqual({
    ok: true,
    data: {
      ok: true,
      status: 'tree',
      rounds: [
        {
          roundRunId,
          endMessageId: before.findLast((entry) => entry.name === 'message/assistant')?.payload[
            'messageId'
          ],
          runIds: before
            .filter((entry) => entry.name === 'execution/run_started')
            .map((entry) => entry.sourceId),
          calls: before
            .filter(
              (entry) =>
                entry.name === 'execution/tool_outcome' &&
                entry.payload['snapshotId'] !== undefined,
            )
            .map((entry) => ({
              callKey: `${entry.sourceId}:${entry.sourceSeq}:${entry.payload['ordinal']}`,
              snapshotId: entry.payload['snapshotId'],
            })),
          canRestore: true,
          incompleteCoverage: false,
          commandsWithoutSnapshot: false,
        },
      ],
      incompleteRestores: [],
    },
  })
  const p = await preview(h, roundRunId)
  expect(p).toMatchObject({ restore: [FILE], conflicts: [] })
  expect(await h.entries()).toEqual(before)
  expect(
    await invokeRoute(h.invoker, snapshotRestore, {
      sessionId: SESSION,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).toMatchObject({
    ok: true,
    data: {
      ok: true,
      undoSnapshotId: expect.any(String),
      restored: 1,
      removed: 0,
      kept: 0,
      skipped: 0,
      failed: [],
    },
  })
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('A')
  expect((await h.entries()).slice(before.length).map((entry) => entry.name)).toEqual([
    'fs/restore_started',
    'fs/restored',
  ])
  expect(await h.sessions.currentPending({ sessionId: SESSION })).toBeNull()
})

it('05 验收 22 (routes): missing sessions and an unavailable store answer gone without snapshot access', async () => {
  const h = await harness()
  const query = vi.spyOn(h.sessions, 'snapshotPreview')
  await Promise.all(
    requests(UNKNOWN, UNKNOWN).map(async ([channel, request]) => {
      expect(await h.call(channel, request)).toEqual({
        ok: true,
        data: { ok: false, code: 'gone' },
      })
    }),
  )
  expect(query).not.toHaveBeenCalled()
  const empty = await harness({ noStore: true })
  await Promise.all(
    requests(UNKNOWN).map(async ([channel, request]) => {
      expect(await empty.call(channel, request)).toEqual({
        ok: true,
        data: { ok: false, code: 'gone' },
      })
    }),
  )
})

it('05 验收 22 (routes): established chats and task drafts are refused without starting a restore', async () => {
  const h = await harness()
  await h.sessions.createSession({ sessionId: SESSION })
  await h.sessions.selectProfile({ sessionId: OTHER, profile: 'cowork', dedicated: WORK })
  const apply = vi.spyOn(h.host.snapshots, 'apply')
  await Promise.all(
    requests(UNKNOWN).map(async ([channel, request]) => {
      expect(await h.call(channel, request)).toEqual({
        ok: true,
        data: { ok: false, code: 'not-cowork' },
      })
    }),
  )
  await Promise.all(
    requests(UNKNOWN, OTHER).map(async ([channel, request]) => {
      expect(await h.call(channel, request)).toEqual({
        ok: true,
        data: { ok: false, code: 'gone' },
      })
    }),
  )
  expect(apply).not.toHaveBeenCalled()
})

it('05 验收 22 (routes): another session round is gone and cannot touch either session', async () => {
  const h = await harness()
  await h.change()
  const otherRound = await h.change(OTHER)
  const before = await h.entries()
  const prepare = vi.spyOn(h.host.snapshots, 'prepare')
  await Promise.all(
    requests(otherRound)
      .slice(1)
      .map(async ([channel, request]) => {
        expect(await h.call(channel, request)).toEqual({
          ok: true,
          data: { ok: false, code: 'gone' },
        })
      }),
  )
  expect(prepare).not.toHaveBeenCalled()
  expect(await h.entries()).toEqual(before)
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('B')
})

it('05 验收 18 (routes): a forged overwrite refuses before prepare and writes neither bytes nor facts', async () => {
  const h = await harness()
  const roundRunId = await h.change()
  const p = await preview(h, roundRunId)
  const before = await h.entries()
  const prepare = vi.spyOn(h.host.snapshots, 'prepare')
  const restore = vi.spyOn(h.sessions, 'snapshotRestore')
  await Promise.all(
    [FILE, '/outside/private'].map(async (path) => {
      expect(
        await h.call('snapshot.restore', {
          sessionId: SESSION,
          roundRunId,
          previewKey: p.previewKey,
          overwrite: [path],
        }),
      ).toMatchObject({ ok: false, error: { code: 'handler-failed' } })
    }),
  )
  expect(restore).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  expect(await h.entries()).toEqual(before)
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('B')
})

it.each([false, true])(
  '05 验收 18 (routes): a real conflict is overwritten only when selected (%s)',
  async (overwrite) => {
    const h = await harness()
    const roundRunId = await h.change()
    await h.host.fs.writeFile(FILE, 'user edit')
    const p = await preview(h, roundRunId)
    expect(p.conflicts).toEqual([FILE])
    expect(
      await h.call('snapshot.restore', {
        sessionId: SESSION,
        roundRunId,
        previewKey: p.previewKey,
        overwrite: overwrite ? [FILE] : [],
      }),
    ).toMatchObject({
      ok: true,
      data: { ok: true, restored: overwrite ? 1 : 0, kept: overwrite ? 0 : 1 },
    })
    expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe(overwrite ? 'A' : 'user edit')
  },
)

it('05 验收 22 (routes): a changed preview is stale before prepare and leaves bytes and facts intact', async () => {
  const h = await harness()
  const roundRunId = await h.change()
  const p = await preview(h, roundRunId)
  await h.host.fs.writeFile(FILE, 'user edit')
  const before = await h.entries()
  const prepare = vi.spyOn(h.host.snapshots, 'prepare')
  expect(
    await h.call('snapshot.restore', {
      sessionId: SESSION,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).toEqual({ ok: true, data: { ok: false, code: 'stale' } })
  expect(prepare).not.toHaveBeenCalled()
  expect(await h.entries()).toEqual(before)
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('user edit')
})

it('05 验收 22 (routes): edits between route validation and the kernel mailbox still return stale', async () => {
  const h = await harness()
  const roundRunId = await h.change()
  const p = await preview(h, roundRunId)
  const before = await h.entries()
  const restore = h.sessions.snapshotRestore.bind(h.sessions)
  vi.spyOn(h.sessions, 'snapshotRestore').mockImplementationOnce(async (q) => {
    await h.host.fs.writeFile(FILE, 'changed between turns')
    return restore(q)
  })
  expect(
    await h.call('snapshot.restore', {
      sessionId: SESSION,
      roundRunId,
      previewKey: p.previewKey,
      overwrite: [],
    }),
  ).toEqual({ ok: true, data: { ok: false, code: 'stale' } })
  expect(await h.entries()).toEqual(before)
  expect(await h.host.fs.readFile(FILE, { encoding: 'utf8' })).toBe('changed between turns')
})

it.each<SnapshotRefusalCode>([
  'busy',
  'gone',
  'stale',
  'undo-unavailable',
  'over-budget',
  'not-cowork',
])(
  '05 验收 22 (routes): kernel refusal %s passes through unchanged on all three routes',
  async (code) => {
    const h = await harness()
    const roundRunId = await h.change()
    const p = await preview(h, roundRunId)
    const refusal = { ok: false as const, code }
    vi.spyOn(h.sessions, 'snapshotRounds').mockResolvedValueOnce(refusal)
    expect(await h.call('snapshot.rounds', { sessionId: SESSION })).toEqual({
      ok: true,
      data: refusal,
    })
    vi.spyOn(h.sessions, 'snapshotPreview').mockResolvedValueOnce(refusal)
    expect(await h.call('snapshot.preview', { sessionId: SESSION, roundRunId })).toEqual({
      ok: true,
      data: refusal,
    })
    const restore = vi.spyOn(h.sessions, 'snapshotRestore').mockResolvedValueOnce(refusal)
    const request = { sessionId: SESSION, roundRunId, previewKey: p.previewKey, overwrite: [] }
    expect(await h.call('snapshot.restore', request)).toEqual({ ok: true, data: refusal })
    expect(restore).toHaveBeenCalledExactlyOnceWith(request)
  },
)

it('05 验收 22 (routes): inaccessible windows and subframes get gone before any session read', async () => {
  const h = await harness()
  const facts = vi.spyOn(h.sessions, 'sessionFacts')
  const frames = [{}, { ...h.event, senderFrame: { url: APP } }, { ...h.event, sender: {} }]
  await Promise.all(
    frames.flatMap((caller) =>
      requests(UNKNOWN).map(async ([channel, request]) => {
        expect(await h.call(channel, request, caller)).toEqual({
          ok: true,
          data: { ok: false, code: 'gone' },
        })
      }),
    ),
  )
  expect(facts).not.toHaveBeenCalled()
})

it('05 验收 22 (routes): window visibility requires a live application main document', () => {
  const frame = { url: `${APP}#thread` }
  const sender = { mainFrame: frame, isDestroyed: () => false }
  const window = { webContents: sender, isDestroyed: () => false }
  const event = { sender, senderFrame: frame }
  expect(snapshotWindowCanAccess(event, [window], APP)).toBe(true)
  expect(snapshotWindowCanAccess(event, [], APP)).toBe(false)
  expect(snapshotWindowCanAccess(event, [{ ...window, isDestroyed: () => true }], APP)).toBe(false)
  sender.isDestroyed = () => true
  expect(snapshotWindowCanAccess(event, [window], APP)).toBe(false)
  sender.isDestroyed = () => false
  frame.url = 'https://untrusted.example/'
  expect(snapshotWindowCanAccess(event, [window], APP)).toBe(false)
})

it('05 验收 22 (routes): all snapshot handlers wait for startup recovery', async () => {
  const gate = Promise.withResolvers<void>()
  const h = await harness({ gate: gate.promise })
  const facts = vi.spyOn(h.sessions, 'sessionFacts')
  let settled = 0
  const pending = requests(UNKNOWN).map(([channel, request]) =>
    h.call(channel, request).finally(() => {
      settled++
    }),
  )
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(settled).toBe(0)
  expect(h.visible).not.toHaveBeenCalled()
  expect(facts).not.toHaveBeenCalled()
  gate.resolve()
  expect(await Promise.all(pending)).toEqual(
    pending.map(() => ({ ok: true, data: { ok: false, code: 'gone' } })),
  )
})

it.each(['shutdown', 'removal'] as const)(
  '05 验收 22 (routes): %s refuses restore before the handler',
  async (kind) => {
    const h = await harness({ shuttingDown: kind === 'shutdown', removing: kind === 'removal' })
    expect(await h.call('snapshot.restore', requests(UNKNOWN)[2][1])).toMatchObject({
      ok: false,
      error: { code: 'handler-failed' },
    })
    expect(h.visible).not.toHaveBeenCalled()
  },
)

it('05 验收 18、22 (routes): malformed requests never reach the handler and invalid kernel responses are blocked', async () => {
  const h = await harness()
  expect(
    await h.call('snapshot.restore', {
      sessionId: SESSION,
      roundRunId: UNKNOWN,
      previewKey: 'key',
      overwrite: ['relative'],
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  expect(h.visible).not.toHaveBeenCalled()
  const roundRunId = await h.change()
  vi.spyOn(h.sessions, 'snapshotPreview').mockResolvedValueOnce({
    ok: true,
    preview: { previewKey: 'key', restore: ['relative'], remove: [], conflicts: [], skipped: [] },
  } as never)
  expect(await h.call('snapshot.preview', { sessionId: SESSION, roundRunId })).toMatchObject({
    ok: false,
    error: { code: 'invalid-response' },
  })
})
