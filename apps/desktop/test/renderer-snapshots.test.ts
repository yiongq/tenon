import { expect, it, vi } from 'vitest'
import {
  recordRows,
  callSnapshot,
  roundForRun,
  restoreNotes,
  previewGroups,
  overwritePaths,
  unfinishedRestore,
  RestoreFlow,
  readRecordMessages,
  readHistoryModel,
} from '../src/renderer/src/lib/snapshots.js'
import type { Preview, Round, Rounds } from '../src/renderer/src/lib/snapshots.js'
import { toolMarker, toolRowEffect } from '../src/renderer/src/lib/tool-row-effect.js'
import { summaryBefore, threadFromRows } from '../src/renderer/src/runtime/thread-model.js'
import { toThreadMessages } from '../src/renderer/src/runtime/to-thread-messages.js'
import type { TurnCustom } from '../src/renderer/src/runtime/to-thread-messages.js'
import type { MessageRowContract, ToolOutcomeViewContract } from '@tenon-app/contracts'

const SESSION = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'
const RESUME = '33333333-3333-4333-8333-333333333333'
const key = `${RESUME}:1:0`
const round: Round = {
  roundRunId: RUN,
  runIds: [RUN, RESUME],
  endMessageId: null,
  calls: [{ callKey: key, snapshotId: 'before' }],
  canRestore: true,
  incompleteCoverage: false,
  commandsWithoutSnapshot: false,
}
const preview: Preview = {
  previewKey: 'preview',
  restore: ['/a', '/b'],
  remove: ['/new'],
  conflicts: ['/a', '/b'],
  skipped: [
    { path: '/secret', reason: 'excluded' },
    { path: '/missing', reason: 'not-covered' },
    { path: '/link', reason: 'hardlink', promised: true },
    { path: '/outside', reason: 'outside-folders' },
  ],
}
const done = {
  ok: true,
  undoSnapshotId: 'undo',
  restored: 1,
  removed: 1,
  kept: 1,
  skipped: 4,
  failed: ['/b'],
}
const outcome: ToolOutcomeViewContract = {
  state: 'completed',
  effect: 'write',
  isError: false,
  source: null,
  reversibility: 'snapshotted',
  output: 'ok',
  permission: { verdict: 'allow', code: 'task-grant', facts: { toolName: 'Delete' } },
}
function row(name = 'Delete', path = '/a', callKey = key, result = outcome): MessageRowContract {
  return {
    sessionId: SESSION,
    messageId: callKey,
    orderSeq: 1,
    role: 'assistant',
    status: 'complete',
    content: [{ type: 'tool-request', id: callKey, name, input: { file_path: path } }],
    entryId: 1,
    createdAt: 0,
    updatedAt: 0,
    calls: [{ callKey, outcome: result }],
  }
}
function host() {
  const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>(
    async (_channel, _request) => ({
      ok: true,
      data: { ok: true, preview },
    }),
  )
  const changed = vi.fn<() => void>()
  return { invoke, changed, flow: new RestoreFlow({ invoke }, SESSION, changed) }
}

it('05 验收 33: historical settlement reads earlier root and child pages without expanding the visible tail', async () => {
  const CHILD = '44444444-4444-4444-8444-444444444444'
  const rootWrite = row('Write', '/early-root', `${RUN}:0:0`)
  const agent = {
    ...row('Agent', '', `${RUN}:0:1`, {
      ...outcome,
      handoff: {
        outcome: 'completed',
        childEndReason: 'completed',
        childSessionId: CHILD,
        finalReply: 'done',
      },
    }),
    orderSeq: 2,
  }
  const tail = Array.from({ length: 1000 }, (_, i): MessageRowContract => ({
    ...rootWrite,
    messageId: `text-${i}`,
    orderSeq: i + 3,
    content: [{ type: 'text', text: 'done' }],
    calls: [],
  }))
  const childWrite = { ...row('Write', '/early-child', `${CHILD}:0:0`), sessionId: CHILD }
  const childTail = tail.map((message) => ({ ...message, sessionId: CHILD }))
  childTail[0] = {
    ...row('Delete', '/removed-child', `${CHILD}:1:0`),
    sessionId: CHILD,
    orderSeq: 3,
  }
  const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>(
    async (_channel, request) => {
      const query = request as { sessionId: string; beforeOrderSeq?: number }
      const root = query.sessionId === SESSION
      return {
        ok: true,
        data:
          query.beforeOrderSeq === undefined
            ? root
              ? tail
              : childTail
            : root
              ? [rootWrite, agent]
              : [childWrite],
      }
    },
  )
  const historicalModel = await readHistoryModel({ invoke }, SESSION)
  const visible = threadFromRows(tail.slice(-200))
  const messages = toThreadMessages(
    visible,
    [{ ...round, endMessageId: tail.at(-1)!.messageId }],
    historicalModel,
  )
  expect(messages.map((message) => message.id)).toEqual(visible.turns.map((turn) => turn.id))
  expect((messages.at(-1)!.metadata!.custom as unknown as TurnCustom).historicalSummary).toEqual({
    runId: RESUME,
    summary: { read: 0, search: 0, write: 2, delete: 1, command: 0, online: 0, connector: 0 },
  })
  expect(
    messages
      .slice(0, -1)
      .every(
        (message) =>
          (message.metadata!.custom as unknown as TurnCustom).historicalSummary === undefined,
      ),
  ).toBe(true)
  expect(invoke.mock.calls.map(([, request]) => request)).toEqual([
    { sessionId: SESSION, limit: 1000 },
    { sessionId: SESSION, limit: 1000, beforeOrderSeq: 3 },
    { sessionId: CHILD, limit: 1000 },
    { sessionId: CHILD, limit: 1000, beforeOrderSeq: 3 },
  ])
})

it('05 验收 16、18: preview groups retain all paths and reasons; only chosen conflict paths are sent', async () => {
  expect(previewGroups(preview)).toEqual([
    {
      kind: 'restore',
      paths: [
        { path: '/a', reason: null },
        { path: '/b', reason: null },
      ],
    },
    { kind: 'remove', paths: [{ path: '/new', reason: null }] },
    { kind: 'skipped', paths: preview.skipped },
  ])
  expect(overwritePaths(preview, new Set(['/a', '/new', '/secret', '/forged']))).toEqual(['/a'])
  const h = host()
  await h.flow.open(RUN)
  expect(h.flow.getSnapshot().selected.size).toBe(0)
  h.flow.select('/a', true)
  h.flow.select('/new', true)
  h.flow.select('/b', true)
  h.flow.select('/b', false)
  h.invoke.mockResolvedValueOnce({ ok: true, data: done })
  await h.flow.confirm()
  expect(h.invoke).toHaveBeenLastCalledWith('snapshot.restore', {
    sessionId: SESSION,
    roundRunId: RUN,
    previewKey: 'preview',
    overwrite: ['/a'],
  })
  expect(h.flow.getSnapshot().done).toEqual(done)
})

it('05 验收 16: cancel never sends a restore, including while a preview is in flight', async () => {
  const h = host()
  await h.flow.open(RUN)
  h.flow.select('/a', true)
  h.flow.cancel()
  await h.flow.confirm()
  expect(h.invoke.mock.calls.map(([channel]) => channel)).toEqual(['snapshot.preview'])
  const gate = Promise.withResolvers<unknown>()
  h.invoke.mockReturnValueOnce(gate.promise)
  const opening = h.flow.open(RUN)
  h.flow.cancel()
  gate.resolve({ ok: true, data: { ok: true, preview } })
  await opening
  expect(h.flow.getSnapshot().phase).toBe('closed')
  expect(h.invoke.mock.calls.every(([channel]) => channel === 'snapshot.preview')).toBe(true)
})

it('05 验收 18、22: stale fetches a fresh preview and resets every conflict to keep; duplicate confirm cannot apply twice', async () => {
  const h = host()
  await h.flow.open(RUN)
  h.flow.select('/a', true)
  const gate = Promise.withResolvers<unknown>()
  h.invoke.mockReturnValueOnce(gate.promise)
  const applying = h.flow.confirm()
  await h.flow.confirm()
  h.flow.cancel()
  expect(h.flow.getSnapshot().phase).toBe('applying')
  gate.resolve({ ok: true, data: { ok: false, code: 'stale' } })
  h.invoke.mockResolvedValueOnce({
    ok: true,
    data: { ok: true, preview: { ...preview, previewKey: 'fresh' } },
  })
  await applying
  expect(h.invoke.mock.calls.map(([channel]) => channel)).toEqual([
    'snapshot.preview',
    'snapshot.restore',
    'snapshot.preview',
  ])
  expect(h.flow.getSnapshot()).toMatchObject({
    phase: 'preview',
    error: 'stale',
    preview: { previewKey: 'fresh' },
    selected: new Set(),
  })
})

it.each(['busy', 'gone', 'undo-unavailable', 'over-budget', 'not-cowork'] as const)(
  '05 验收 22: %s is presented without retrying restore',
  async (code) => {
    const h = host()
    await h.flow.open(RUN)
    h.invoke.mockResolvedValueOnce({ ok: true, data: { ok: false, code } })
    await h.flow.confirm()
    expect(h.flow.getSnapshot()).toMatchObject({ phase: 'error', error: code, preview: null })
    expect(h.invoke).toHaveBeenCalledTimes(2)
  },
)

it('05 验收 33: settlement finds resumed Runs and uses only the kernel coverage and liveness flags', () => {
  expect(roundForRun([round], RESUME)).toBe(round)
  expect(roundForRun([round], SESSION)).toBeUndefined()
  expect(restoreNotes(round)).toEqual({ link: 'snapshot.available', command: false })
  expect(
    restoreNotes({ ...round, incompleteCoverage: true, commandsWithoutSnapshot: true }),
  ).toEqual({ link: 'snapshot.partial', command: true })
  expect(restoreNotes({ ...round, canRestore: false })).toEqual({ link: null, command: false })
  expect(restoreNotes(undefined)).toEqual({ link: null, command: false })
})

it('05 验收 34: record derives all six columns from root messages and snapshot rounds, including reads without snapshots', () => {
  const messages = [
    row(),
    row('Read', '/read', `${RUN}:0:0`),
    row('Write', '/other', `${SESSION}:0:0`),
  ]
  expect(recordRows(messages, round)).toEqual([
    {
      callKey: key,
      tool: 'Delete',
      object: '/a',
      decision: outcome.permission,
      reversibility: 'snapshotted',
      snapshotId: 'before',
      canRestore: true,
    },
    {
      callKey: `${RUN}:0:0`,
      tool: 'Read',
      object: '/read',
      decision: outcome.permission,
      reversibility: 'snapshotted',
      snapshotId: null,
      canRestore: false,
    },
  ])
  expect(callSnapshot([{ ...round, canRestore: false }], key)).toEqual({
    snapshotId: 'before',
    canRestore: false,
  })
  expect(
    recordRows(messages, { ...round, canRestore: false }).every((item) => !item.canRestore),
  ).toBe(true)
})

it('05 验收 34: the record reads beyond the loaded tail instead of dropping early calls', async () => {
  const tail = Array.from({ length: 1000 }, (_, index) => ({ ...row(), orderSeq: index + 1 }))
  const first = { ...row(), orderSeq: 0 }
  const invoke = vi
    .fn<(channel: string, request: unknown) => Promise<unknown>>()
    .mockResolvedValueOnce({ ok: true, data: tail })
    .mockResolvedValueOnce({ ok: true, data: [first] })
  const rows = await readRecordMessages({ invoke }, SESSION)
  expect(rows).toEqual([first, ...tail])
  expect(invoke).toHaveBeenLastCalledWith('session.messages', {
    sessionId: SESSION,
    limit: 1000,
    beforeOrderSeq: 1,
  })
})

it('05 验收 22、51: only unmatched restore starts produce the startup notice', () => {
  const data: Rounds = { ok: true, status: 'tree', rounds: [round], incompleteRestores: [] }
  expect(unfinishedRestore(data)).toBe(false)
  expect(unfinishedRestore(null)).toBe(false)
  expect(
    unfinishedRestore({
      ...data,
      incompleteRestores: [
        { entryId: 1, roundRunId: RUN, undoSnapshotId: 'undo', previewKey: 'key' },
      ],
    }),
  ).toBe(true)
})

it('05 验收 47: completed failures replace irreversible markers; sandbox receipts suppress both', () => {
  expect(toolMarker({ ...outcome, reversibility: 'irreversible' })).toBe('irreversible')
  expect(toolMarker({ ...outcome, reversibility: 'irreversible', isError: true })).toBe('failed')
  expect(toolMarker({ ...outcome, isError: true })).toBe('failed')
  expect(
    toolMarker({
      ...outcome,
      isError: true,
      sandbox: { violations: [], more: 0, anyProtected: false },
    }),
  ).toBeNull()
  expect(
    toolMarker({
      ...outcome,
      reversibility: 'irreversible',
      sandbox: { violations: [], more: 0, anyProtected: false },
    }),
  ).toBeNull()
  expect(toolMarker({ ...outcome, state: 'aborted', isError: true })).toBeNull()
})

it('05 验收 48: Delete expands only on success and counts distinct successful paths', () => {
  expect(toolRowEffect(outcome, 'Delete')).toMatchObject({
    didKey: 'tool.did.delete',
    undoKey: 'confirm.undo.snapshotted',
  })
  expect(toolRowEffect({ ...outcome, isError: true }, 'Delete')?.didKey).toBeNull()
  expect(toolRowEffect({ ...outcome, state: 'not-run' }, 'Delete')?.didKey).toBeNull()
  const model = threadFromRows([
    row(),
    row('Delete', '/a', 'duplicate'),
    row('Delete', '/b', 'second'),
    row('Delete', '/bad', 'failed', { ...outcome, isError: true }),
    row('Delete', '/stopped', 'stopped', { ...outcome, state: 'aborted' }),
  ])
  expect(summaryBefore(model.turns, model.turns.length - 1)).toEqual({
    read: 0,
    search: 0,
    write: 0,
    delete: 2,
    command: 0,
    online: 0,
    connector: 0,
  })
})

it.each(
  ['open', 'confirm'].flatMap((stage) =>
    ['reject', 'invalid', 'busy'].map((kind) => ({
      stage,
      kind,
      error: kind === 'busy' ? 'busy' : 'failed',
    })),
  ),
)('05 验收 18、22: restore $stage reports $kind failures', async (reply) => {
  const { stage } = reply
  const h = host()
  const listener = vi.fn<() => void>()
  const unsubscribe = h.flow.subscribe(listener)
  if (stage === 'confirm') await h.flow.open(RUN)
  if (reply.kind === 'reject') h.invoke.mockRejectedValueOnce(new Error('offline'))
  else
    h.invoke.mockResolvedValueOnce(
      reply.kind === 'invalid' ? {} : { ok: true, data: { ok: false, code: 'busy' } },
    )
  if (stage === 'open') await h.flow.open(RUN)
  else await h.flow.confirm()
  expect(h.flow.getSnapshot()).toMatchObject({
    phase: 'error',
    error: reply.error,
    preview: null,
  })
  expect(listener).toHaveBeenCalled()
  unsubscribe()
  listener.mockClear()
  h.flow.cancel()
  expect(listener).not.toHaveBeenCalled()
})

it.each(['resolve', 'reject'] as const)(
  '05 验收 18: an older preview that later %ss cannot replace the current round or reopen a cancelled dialog',
  async (completion) => {
    const h = host()
    const pending = Promise.withResolvers<unknown>()
    h.invoke.mockReturnValueOnce(pending.promise)
    const old = h.flow.open(RUN)
    await h.flow.open(RESUME)
    const current = h.flow.getSnapshot()
    if (completion === 'resolve') pending.resolve({ ok: true, data: { ok: false, code: 'gone' } })
    else pending.reject(new Error('late error'))
    await old
    expect(h.flow.getSnapshot()).toBe(current)
    expect(h.changed).not.toHaveBeenCalled()
    const cancelled = Promise.withResolvers<unknown>()
    h.invoke.mockReturnValueOnce(cancelled.promise)
    const loading = h.flow.open(RUN)
    h.flow.cancel()
    cancelled.resolve({ ok: true, data: { ok: true, preview } })
    await loading
    expect(h.flow.getSnapshot().phase).toBe('closed')
  },
)

it.each(['resolve', 'reject'] as const)(
  '05 验收 18、22: a superseded apply %s cannot replace a newer preview; duplicate confirms and cancellation while applying do nothing',
  async (completion) => {
    const h = host()
    await h.flow.confirm()
    expect(h.invoke).not.toHaveBeenCalled()
    await h.flow.open(RUN)
    h.flow.select('/a', true)
    h.flow.select('/a', false)
    h.flow.select('/forged', true)
    expect([...h.flow.getSnapshot().selected]).toEqual([])
    const pending = Promise.withResolvers<unknown>()
    h.invoke.mockReturnValueOnce(pending.promise)
    const applying = h.flow.confirm()
    const state = h.flow.getSnapshot()
    h.flow.cancel()
    h.flow.select('/a', true)
    await h.flow.confirm()
    expect(h.flow.getSnapshot()).toBe(state)
    expect(h.invoke).toHaveBeenCalledTimes(2)
    await h.flow.open(RESUME)
    const current = h.flow.getSnapshot()
    if (completion === 'resolve') pending.resolve({ ok: true, data: done })
    else pending.reject(new Error('late apply error'))
    await applying
    expect(h.flow.getSnapshot()).toBe(current)
  },
)
