import { expect, it } from 'vitest'
import type {
  AbsolutePath,
  SnapshotRoundQuery,
  SnapshotRestoreQuery,
  SnapshotRoundsResult,
  SnapshotPreviewResult,
  SnapshotRestoreResult,
} from '@tenon-app/kernel'
import type { RouteRequest, RouteResponse } from '../src/index.js'
import {
  invokeRoute,
  isRouteChannel,
  registerRoute,
  snapshotPreview,
  snapshotRestore,
  snapshotRounds,
} from '../src/index.js'

// The IPC shapes restate kernel data without importing it into the preload at runtime.
type Wire<T> = T extends AbsolutePath
  ? string
  : T extends readonly (infer Item)[]
    ? readonly Wire<Item>[]
    : T extends object
      ? { [Key in keyof T]: Wire<T[Key]> }
      : T
type Assert<T extends true> = T
type BothWays<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export type PreviewRequestMatches = Assert<
  BothWays<RouteRequest<typeof snapshotPreview>, SnapshotRoundQuery>
>
export type RestoreRequestMatches = Assert<
  BothWays<RouteRequest<typeof snapshotRestore>, Wire<SnapshotRestoreQuery>>
>
export type RoundsResponseMatches = Assert<
  BothWays<RouteResponse<typeof snapshotRounds>, Wire<SnapshotRoundsResult>>
>
export type PreviewResponseMatches = Assert<
  BothWays<RouteResponse<typeof snapshotPreview>, Wire<SnapshotPreviewResult>>
>
export type RestoreResponseMatches = Assert<
  BothWays<RouteResponse<typeof snapshotRestore>, Wire<SnapshotRestoreResult>>
>

const SESSION = '11111111-1111-4111-8111-111111111111'
const ROUND = '22222222-2222-4222-8222-22222222abcd'
const target = { sessionId: SESSION, roundRunId: ROUND }
const preview = {
  previewKey: 'opaque-preview-key',
  restore: ['/work/a'],
  remove: ['/work/new'],
  conflicts: ['/work/a'],
  skipped: [{ path: '/work/private', reason: 'excluded', promised: true }],
}

it('05 验收 18、22 (contracts): all three snapshot channels are registered and accept their requests', () => {
  for (const route of [snapshotRounds, snapshotPreview, snapshotRestore])
    expect(isRouteChannel(route.channel)).toBe(true)
  expect(snapshotRounds.request.parse({ sessionId: SESSION })).toEqual({ sessionId: SESSION })
  expect(snapshotPreview.request.parse(target)).toEqual(target)
  const restore = { ...target, previewKey: preview.previewKey, overwrite: ['/work/a'] }
  expect(snapshotRestore.request.parse(restore)).toEqual(restore)
})

it('05 验收 18、22 (contracts): malformed identities, paths and caller-supplied internals are refused', () => {
  for (const [route, request] of [
    [snapshotRounds, { sessionId: SESSION }],
    [snapshotPreview, target],
    [snapshotRestore, { ...target, previewKey: preview.previewKey, overwrite: [] }],
  ] as const) {
    expect(route.request.safeParse(request).success).toBe(true)
    expect(route.request.safeParse({ ...request, sessionId: 'not-a-uuid' }).success).toBe(false)
    expect(route.request.safeParse({ ...request, folders: ['/other'] }).success).toBe(false)
  }
  for (const roundRunId of ['', 'not-a-uuid', ROUND.toUpperCase()])
    expect(snapshotPreview.request.safeParse({ ...target, roundRunId }).success).toBe(false)
  for (const overwrite of [['relative'], [''], ['/work/a\0suffix'], [42], '/work/a'])
    expect(
      snapshotRestore.request.safeParse({ ...target, previewKey: 'key', overwrite }).success,
    ).toBe(false)
  expect(snapshotRestore.request.safeParse({ ...target, overwrite: [] }).success).toBe(false)
  expect(
    snapshotRestore.request.safeParse({ ...target, previewKey: '', overwrite: [] }).success,
  ).toBe(false)
})

it('05 验收 22 (contracts): success responses retain all kernel round, recovery, preview and completion fields', () => {
  const rounds = {
    ok: true,
    status: 'tree',
    rounds: [
      {
        roundRunId: ROUND,
        runIds: [ROUND],
        endMessageId: null,
        calls: [{ callKey: `${ROUND}:0:0`, snapshotId: 'before' }],
        canRestore: true,
        incompleteCoverage: true,
        commandsWithoutSnapshot: false,
      },
    ],
    incompleteRestores: [
      { entryId: 3, roundRunId: ROUND, undoSnapshotId: 'undo', previewKey: 'old' },
    ],
  }
  for (const status of ['tree', 'warming', 'file-only', 'unavailable'])
    expect(snapshotRounds.response.parse({ ...rounds, status })).toEqual({ ...rounds, status })
  expect(snapshotPreview.response.parse({ ok: true, preview })).toEqual({ ok: true, preview })
  const restored = {
    ok: true,
    undoSnapshotId: 'undo',
    restored: 1,
    removed: 2,
    kept: 3,
    skipped: 4,
    failed: ['/work/no'],
  }
  expect(snapshotRestore.response.parse(restored)).toEqual(restored)
})

it.each(['busy', 'gone', 'stale', 'undo-unavailable', 'over-budget', 'not-cowork'])(
  '05 验收 22 (contracts): the refusal %s is valid on every snapshot route',
  (code) => {
    for (const route of [snapshotRounds, snapshotPreview, snapshotRestore])
      expect(route.response.parse({ ok: false, code })).toEqual({ ok: false, code })
  },
)

it('05 验收 18、22 (contracts): malformed responses cannot cross either IPC boundary', async () => {
  const invalid = [
    { ok: false, code: 'unknown-session' },
    { ok: true, undoSnapshotId: 'undo', restored: -1, removed: 0, kept: 0, skipped: 0, failed: [] },
    {
      ok: true,
      undoSnapshotId: 'undo',
      restored: 0,
      removed: 0,
      kept: 0,
      skipped: 0,
      failed: ['relative'],
    },
  ]
  for (const response of invalid)
    expect(snapshotRestore.response.safeParse(response).success).toBe(false)
  expect(
    snapshotPreview.response.safeParse({
      ok: true,
      preview: { ...preview, skipped: [{ path: '/a', reason: 'other' }] },
    }).success,
  ).toBe(false)
  expect(
    snapshotPreview.response.safeParse({
      ok: true,
      preview: { ...preview, skipped: [{ path: '/a', reason: 'excluded', promised: false }] },
    }).success,
  ).toBe(false)
  expect(
    snapshotRounds.response.safeParse({
      ok: true,
      status: 'ready',
      rounds: [],
      incompleteRestores: [],
    }).success,
  ).toBe(false)
  let listener: ((event: unknown, ...args: unknown[]) => unknown) | undefined
  registerRoute(
    {
      handle: (_channel, handler) => {
        listener = handler
      },
    },
    snapshotPreview,
    () => ({ ok: true, preview: { ...preview, restore: ['relative'] } }) as never,
  )
  expect(await listener?.({}, target)).toMatchObject({
    ok: false,
    error: { code: 'invalid-response' },
  })
  expect(
    await invokeRoute({ invoke: async () => ({ ok: true, data: invalid[1] }) }, snapshotRestore, {
      ...target,
      previewKey: 'key',
      overwrite: [],
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid-response' } })
})

it('05 验收 34 (contracts): run and call identities are required and strictly checked', () => {
  const round = {
    roundRunId: ROUND,
    runIds: [ROUND],
    endMessageId: null,
    calls: [{ callKey: `${ROUND}:0:0`, snapshotId: 'before' }],
    canRestore: true,
    incompleteCoverage: false,
    commandsWithoutSnapshot: false,
  }
  expect(parseRound(round)).toBe(true)
  const { runIds: _runs, ...noRuns } = round
  const { calls: _calls, ...noCalls } = round
  for (const item of [
    noRuns,
    noCalls,
    { ...round, extra: true },
    { ...round, runIds: ['bad'] },
    { ...round, runIds: ROUND },
    { ...round, calls: [{}] },
    { ...round, calls: [{ callKey: 1, snapshotId: 'before' }] },
    { ...round, calls: [{ callKey: 'key', snapshotId: 1 }] },
    { ...round, calls: [{ callKey: 'key', snapshotId: 'before', extra: true }] },
  ])
    expect(parseRound(item)).toBe(false)
})

const parseRound = (item: unknown) =>
  snapshotRounds.response.safeParse({
    ok: true,
    status: 'tree',
    rounds: [item],
    incompleteRestores: [],
  }).success

it('05 验收 33 (contracts): the end message is required, nullable or a nonempty message identity', () => {
  const round = {
    roundRunId: ROUND,
    runIds: [ROUND],
    calls: [],
    endMessageId: null,
    canRestore: false,
    incompleteCoverage: false,
    commandsWithoutSnapshot: false,
  }
  expect(parseRound(round)).toBe(true)
  expect(parseRound({ ...round, endMessageId: 'assistant-ending' })).toBe(true)
  const { endMessageId: _end, ...missing } = round
  for (const invalid of [
    missing,
    { ...round, endMessageId: '' },
    { ...round, endMessageId: 1 },
    { ...round, endMessageId: { messageId: 'end' } },
    { ...round, endMessageId: 'end', extra: true },
  ])
    expect(parseRound(invalid)).toBe(false)
})

it('05 验收 18: overwrite accepts at most 50000 conflict choices', () => {
  const request = {
    ...target,
    previewKey: 'key',
    overwrite: Array.from({ length: 50_000 }, (_, i) => `/work/${i}`),
  }
  expect(snapshotRestore.request.safeParse(request).success).toBe(true)
  expect(
    snapshotRestore.request.safeParse({ ...request, overwrite: [...request.overwrite, '/extra'] })
      .success,
  ).toBe(false)
})
