/** Spec 05 steps 6–7: coverage is host evidence, queried before inspecting and deciding. */
import { describe, expect, it, vi } from 'vitest'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createTape,
  sessionStartKey,
} from '../../src/index.js'
import type { SnapshotCoverage } from '../../src/index.js'
import { decisionEntry, judgeCall } from '../../src/loop/batch.js'
import type { CallFacts, Judgement } from '../../src/loop/batch.js'
import type { InspectorRegistration } from '../../src/permission/inspector.js'
import { grantKey, answerScope } from '../../src/permission/grants.js'
import { reversibilityOf } from '../../src/permission/reversibility.js'
import { approvalResolvedKey, permissionDecidedKey } from '../../src/tape/provenance.js'
import type { ToolTableItem } from '../../src/tools/registry.js'

const SESSION = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'
const INCARNATION = '33333333-3333-4333-8333-333333333333'
const PATH = absolutePath('/work/a')

const facts: CallFacts = {
  entries: [],
  profile: 'cowork',
  scope: {
    roots: [absolutePath('/work')],
    ownSpillDir: absolutePath('/profile/tool-output/s'),
    profileDir: absolutePath('/profile'),
    protectedFiles: [],
  },
  workspace: null,
}

function tool(name: string, source: 'builtin' | 'mcp' = 'builtin'): ToolTableItem {
  return {
    name,
    source,
    originalName: name,
    serverId: source === 'builtin' ? 'builtin' : 'server',
    requiresUserInteraction: false,
    spec: { name, description: '', inputSchema: { type: 'object' } },
  }
}

async function harness() {
  const host = createMemoryHost()
  await host.fs.mkdirp(absolutePath('/work'))
  const tape = createTape(createMemoryTapeStore({ identity: host.identity }))
  await tape.appendEntries({
    sessionId: SESSION,
    incarnationId: INCARNATION,
    entries: [
      tape.writer('session').entry('session/start', {
        sourceType: 'session',
        sourceId: SESSION,
        sourceSeq: 0,
        provenanceKey: sessionStartKey(INCARNATION),
        payload: { incarnationId: INCARNATION },
        createdAt: 0,
      }),
    ],
  })
  const coverage = vi.spyOn(host.snapshots, 'coverage')
  const ctx = {
    host,
    tape,
    sessionId: SESSION,
    inspectors: [],
    protectedFiles: [],
    userSetting: () => null,
    searchHost: null,
    signal: new AbortController().signal,
  }
  const judge = (
    name: string,
    overrides: Partial<CallFacts> = {},
    source: 'builtin' | 'mcp' = 'builtin',
  ) =>
    judgeCall(
      ctx,
      tool(name, source),
      { input: { file_path: PATH, command: 'rm a' } },
      { ...facts, ...overrides },
    )
  return { host, tape, coverage, ctx, judge }
}

function judged(value: Judgement) {
  if (value.kind !== 'judged') throw new Error('unexpected stopped judgement')
  return value
}

async function record(h: Awaited<ReturnType<typeof harness>>, value: Judgement) {
  const entry = decisionEntry({
    tape: h.tape,
    now: () => 1,
    ref: { runId: RUN, requestSeq: 2, ordinal: 3, providerToolCallId: 'call' },
    argsHash: 'hash',
    judged: judged(value),
    key: permissionDecidedKey(RUN, 2, 3),
    writer: { by: 'run', runId: RUN },
  })
  await h.tape.appendEntries({ sessionId: SESSION, incarnationId: INCARNATION, entries: [entry] })
  return (await h.tape.readRange({ sessionId: SESSION, limit: 10 })).entries.at(-1)?.payload
}

describe('05 coverage before permission', () => {
  it.each(
    (['tree', 'warming', 'file-only', 'unavailable'] as const).flatMap((status) =>
      ['Write', 'Edit', 'Delete'].map((name) => ({ status, name })),
    ),
  )(
    '05 验收 4: $name records $status coverage with the file decision',
    async ({ status, name }) => {
      const h = await harness()
      h.host.snapshots.setStatus(SESSION, status)
      const coverage = status === 'tree' ? 'tree' : status === 'unavailable' ? 'none' : 'file'
      const value = judged(await h.judge(name))
      const reversibility =
        coverage !== 'none' ? 'snapshotted' : name === 'Delete' ? 'irreversible' : 'unknown'
      expect(h.coverage).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, path: PATH })
      expect(value).toMatchObject({ coverage, reversibility })
      expect(value.decision.confirm?.reason).toBe(
        name === 'Delete' && coverage === 'none' ? 'irreversible' : 'default',
      )
      expect(await record(h, value)).toMatchObject({
        coverage,
        reversibility,
        confirm: { kind: 'file', target: { type: 'path', path: PATH } },
      })
      expect(
        answerScope({
          decision: value.decision,
          reversibility: value.reversibility,
          ...(value.place === undefined ? {} : { place: value.place }),
          source: 'builtin',
          toolName: name,
        }),
      ).toBe(name === 'Delete' ? 'once' : 'session')
      expect(value.grantObject).toEqual({ kind: 'file', path: PATH })
    },
  )

  it.each(
    (['throw', 'reject', 'timeout'] as const).flatMap((failure) =>
      ['Write', 'Edit', 'Delete'].map((name) => ({ failure, name })),
    ),
  )('05 验收 4: $name records none after coverage $failure', async ({ failure, name }) => {
    const h = await harness()
    let rejectLate: ((reason: Error) => void) | undefined
    h.coverage.mockImplementation(() => {
      if (failure === 'throw') throw new Error('host failed synchronously')
      if (failure === 'reject') return Promise.reject(new Error('host rejected'))
      return new Promise<SnapshotCoverage>((_resolve, reject) => {
        rejectLate = reject
      })
    })
    let settled = false
    const result = h.judge(name).then((value) => {
      settled = true
      return value
    })
    await vi.waitFor(() => expect(h.coverage).toHaveBeenCalledOnce())
    if (failure === 'timeout') {
      h.host.advance(999)
      await Promise.resolve()
    }
    expect(settled && failure === 'timeout').toBe(false)
    if (failure === 'timeout') h.host.advance(1)
    const value = judged(await result)
    expect(value).toMatchObject({
      coverage: 'none',
      reversibility: name === 'Delete' ? 'irreversible' : 'unknown',
    })
    expect(await record(h, value)).toMatchObject({
      coverage: 'none',
      reversibility: value.reversibility,
    })
    rejectLate?.(new Error('late rejection after timeout'))
    await Promise.resolve()
  })

  it('05 验收 4: coverage is still pending at 999 ms and resolves none at 1000 ms', async () => {
    const h = await harness()
    h.coverage.mockReturnValue(new Promise(() => {}))
    let settled = false
    const result = h.judge('Write').then((value) => {
      settled = true
      return value
    })
    await vi.waitFor(() => expect(h.coverage).toHaveBeenCalledOnce())
    h.host.advance(999)
    // A real event-loop turn drains the whole judgeCall chain, rather than one microtask.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    h.host.advance(1)
    expect(judged(await result)).toMatchObject({ coverage: 'none', reversibility: 'unknown' })
    expect(settled).toBe(true)
  })

  it('05 验收 4: successful coverage cancels its deadline and inspectors see the computed label', async () => {
    const h = await harness()
    h.host.snapshots.setStatus(SESSION, 'tree')
    const cancel = vi.fn<() => void>()
    vi.spyOn(h.host.clock, 'setTimeout').mockReturnValue(cancel)
    const beforeCall = vi.fn<Extract<InspectorRegistration, { ceiling: 'ask' }>['beforeCall']>(() =>
      Promise.resolve({ kind: 'none' }),
    )
    const value = judged(
      await judgeCall(
        { ...h.ctx, inspectors: [{ id: 'check', kind: 'local-rule', ceiling: 'ask', beforeCall }] },
        tool('Write'),
        { input: { file_path: PATH } },
        facts,
      ),
    )
    expect(value.reversibility).toBe('snapshotted')
    expect(beforeCall.mock.calls[0]?.[0].call.reversibility).toBe('snapshotted')
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it.each(['Read', 'Glob', 'Grep', 'Bash', 'Agent', 'WebSearch', 'WebFetch', 'AskUserQuestion'])(
    '05 验收 3、4: %s never queries or records coverage',
    async (name) => {
      const h = await harness()
      h.host.snapshots.setStatus(SESSION, 'tree')
      const value = judged(await h.judge(name))
      expect(h.coverage).not.toHaveBeenCalled()
      expect(value).not.toHaveProperty('coverage')
      expect(await record(h, value)).not.toHaveProperty('coverage')
      expect(value.reversibility).not.toBe('snapshotted')
    },
  )

  it('05 验收 4: chat and connector tools never query coverage', async () => {
    const h = await harness()
    expect(judged(await h.judge('Write', { profile: 'chat' })).decision.record.verdict).toBe('deny')
    expect(judged(await h.judge('Write', {}, 'mcp')).reversibility).toBe('unknown')
    expect(h.coverage).not.toHaveBeenCalled()
  })

  it('05 验收 4: coverage receives the resolved path; Delete keeps the link itself', async () => {
    const h = await harness()
    await h.host.fs.writeFile(absolutePath('/work/target'), 'x')
    h.host.symlink(PATH, absolutePath('/work/target'))
    await h.judge('Write')
    expect(h.coverage).toHaveBeenLastCalledWith({ sessionId: SESSION, path: '/work/target' })
    await h.judge('Delete')
    expect(h.coverage).toHaveBeenLastCalledWith({ sessionId: SESSION, path: PATH })
  })

  it.each([
    {
      row: 'covered workspace',
      status: 'tree',
      sensitive: false,
      outside: false,
      reason: 'default',
      reversibility: 'snapshotted',
    },
    {
      row: 'uncovered workspace',
      status: 'unavailable',
      sensitive: false,
      outside: false,
      reason: 'irreversible',
      reversibility: 'irreversible',
    },
    {
      row: 'covered sensitive path',
      status: 'file-only',
      sensitive: true,
      outside: false,
      reason: 'sensitive-path',
      reversibility: 'snapshotted',
    },
    {
      row: 'uncovered sensitive path',
      status: 'unavailable',
      sensitive: true,
      outside: false,
      reason: 'sensitive-path',
      reversibility: 'irreversible',
    },
    {
      row: 'outside workspace',
      status: 'unavailable',
      sensitive: false,
      outside: true,
      reason: 'outside-workspace',
      reversibility: 'irreversible',
    },
  ] as const)('05 验收 4: Delete asks once for $row with the specified reason', async (row) => {
    const h = await harness()
    h.host.snapshots.setStatus(SESSION, row.status)
    const value = judged(
      await h.judge('Delete', {
        scope: {
          ...facts.scope,
          roots: [absolutePath(row.outside ? '/other' : '/work')],
          ...(row.sensitive
            ? { sensitive: { credential: [], autoRunNames: ['a'], linkTargets: [] } }
            : {}),
        },
      }),
    )
    expect(value.reversibility).toBe(row.reversibility)
    expect(value.decision.record.verdict).toBe('ask')
    expect(value.decision.confirm?.reason).toBe(row.reason)
    expect(
      answerScope({
        decision: value.decision,
        reversibility: value.reversibility,
        source: 'builtin',
        toolName: 'Delete',
      }),
    ).toBe('once')
  })

  it.each(['tree', 'file', 'none', undefined] as const)(
    '05 验收 3、4: reversibility is pure for coverage %s and Bash ignores it',
    (coverage) => {
      for (const name of ['Write', 'Edit', 'Delete']) {
        expect(reversibilityOf(tool(name), {}, coverage)).toBe(
          coverage === 'tree' || coverage === 'file'
            ? 'snapshotted'
            : name === 'Delete'
              ? 'irreversible'
              : 'unknown',
        )
        expect(reversibilityOf(tool(name, 'mcp'), {}, coverage)).toBe('unknown')
      }
      expect(reversibilityOf(tool('Bash'), { command: 'rm a' }, coverage)).toBe('irreversible')
      expect(reversibilityOf(tool('Bash'), { command: 'ls' }, coverage)).toBe('unknown')
    },
  )
})

async function withGrant(
  h: Awaited<ReturnType<typeof harness>>,
  name: string,
  previous: string | undefined,
  input = { file_path: PATH, command: 'echo stable', url: 'https://example.com' },
) {
  const value = judged(await judgeCall(h.ctx, tool(name), { input }, facts))
  if (value.grantObject === null) throw new Error('fixture requires a grant object')
  if (previous !== undefined)
    await record(h, { ...value, reversibility: previous as typeof value.reversibility })
  await h.tape.appendEntries({
    sessionId: SESSION,
    incarnationId: INCARNATION,
    entries: [
      h.tape.writer('tool').entry('tool/approval_resolved', {
        sourceType: 'runtime_event',
        sourceId: RUN,
        sourceSeq: 2,
        provenanceKey: approvalResolvedKey(RUN, 2, 3),
        createdAt: 2,
        payload: {
          ordinal: 3,
          providerToolCallId: 'call',
          decisionKey: permissionDecidedKey(RUN, 2, 3),
          outcome: 'allowed',
          via: 'card',
          grant: { scope: 'session', key: grantKey('builtin', name, value.grantObject) },
          writer: { by: 'run', runId: RUN },
        },
      }),
    ],
  })
  return (await h.tape.readRange({ sessionId: SESSION, limit: 100 })).entries
}

describe('05 file grant strength (D61)', () => {
  it.each(
    ['Write', 'Edit', 'Delete'].flatMap((name) =>
      ['own', 'parent'].flatMap((source) => [
        { name, source, previous: 'snapshotted', coverage: 'none' as const, allowed: false },
        { name, source, previous: 'snapshotted', coverage: 'file' as const, allowed: true },
        { name, source, previous: 'unknown', coverage: 'tree' as const, allowed: true },
        { name, source, previous: 'irreversible', coverage: 'tree' as const, allowed: true },
        {
          name,
          source,
          previous: 'unknown',
          coverage: 'none' as const,
          allowed: name !== 'Delete',
        },
        { name, source, previous: 'irreversible', coverage: 'none' as const, allowed: true },
        { name, source, previous: undefined, coverage: 'tree' as const, allowed: false },
      ]),
    ),
  )(
    '05 验收 4: $source $name grant from $previous with $coverage coverage allows=$allowed',
    async (row) => {
      const h = await harness()
      const entries = await withGrant(h, row.name, row.previous)
      h.coverage.mockResolvedValue(row.coverage)
      // Release layer 4 so Delete's always-ask irreversibility cannot mask a broken grant guard.
      if (row.name === 'Delete')
        h.host.setPolicy({
          status: 'current',
          version: 'release',
          snapshot: {
            tools: [
              {
                policyId: 'release',
                serverId: 'builtin',
                toolName: 'Delete',
                effect: 'release-irreversible',
              },
            ],
          },
        })
      const value = judged(
        await h.judge(row.name, row.source === 'own' ? { entries } : { parentEntries: entries }),
      )
      expect(value.decision.record.verdict).toBe(row.allowed ? 'allow' : 'ask')
      expect(value.decision.record.decidedBy === 'user-grant').toBe(row.allowed)
      expect(value.reversibility).toBe(
        row.coverage === 'none'
          ? row.name === 'Delete'
            ? 'irreversible'
            : 'unknown'
          : 'snapshotted',
      )
    },
  )

  it('05 验收 4: an unusable own grant cannot hide an eligible inherited grant', async () => {
    const h = await harness()
    const parent = await harness()
    const entries = await withGrant(h, 'Write', undefined)
    const parentEntries = await withGrant(parent, 'Write', 'unknown')
    h.coverage.mockResolvedValue('file')
    const value = judged(await h.judge('Write', { entries, parentEntries }))
    expect(value.decision.record).toMatchObject({ verdict: 'allow', decidedBy: 'user-grant' })
    expect(value.decision.summary).toMatchObject({
      code: 'session-allowed',
      facts: { inherited: 'parent' },
    })
  })

  it.each(['Bash', 'WebFetch'])(
    '05 验收 4: %s grants still work without a file reversibility baseline',
    async (name) => {
      const h = await harness()
      const entries = await withGrant(h, name, undefined)
      const value = judged(
        await judgeCall(
          h.ctx,
          tool(name),
          { input: { command: 'echo stable', url: 'https://example.com' } },
          { ...facts, entries },
        ),
      )
      expect(value.decision.record).toMatchObject({ verdict: 'allow', decidedBy: 'user-grant' })
    },
  )
})
