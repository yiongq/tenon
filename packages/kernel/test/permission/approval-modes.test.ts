import { describe, expect, it, vi } from 'vitest'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createTape,
  EMPTY_POLICY,
} from '../../src/index.js'
import { judgeCall } from '../../src/loop/batch.js'
import type { Decision, LayerInputs } from '../../src/permission/decide.js'
import { decide } from '../../src/permission/decide.js'
import { answerScope } from '../../src/permission/grants.js'
import { commandReversibility } from '../../src/permission/reversibility.js'
import { creationEntries } from '../../src/session/facts.js'
import { sessionStartKey } from '../../src/tape/provenance.js'
import * as patterns from '../../src/permission/reversibility.js'
import { modeJudgeFixture, MODE_SESSION } from '../support/approval-mode-judge.js'
import type { ManualFixture } from '../support/approval-mode-judge.js'
import baseline from './fixtures/06-manual-baseline.json' with { type: 'json' }

// Fixed pre-06 data references share identical records; no expected behavior is recomputed.
function baselineDecision(ref: {
  record: number
  summary: number
  confirm?: number
  block?: number
}) {
  return {
    record: baseline.records[ref.record],
    summary: baseline.summaries[ref.summary],
    ...(ref.confirm === undefined ? {} : { confirm: baseline.confirms[ref.confirm] }),
    ...(ref.block === undefined ? {} : { block: baseline.blocks[ref.block] }),
  }
}

const normalize = (d: Decision) => ({
  ...d,
  record: {
    ...d.record,
    steps: d.record.steps.filter((step) => step.by !== 'approval-mode'),
  },
  ...(d.confirm === undefined
    ? {}
    : {
        confirm: {
          ...d.confirm,
          facts: Object.fromEntries(
            Object.entries(d.confirm.facts).filter(([key]) => key !== 'autoAsk'),
          ),
        },
      }),
})

const SESSION = '11111111-1111-4111-8111-111111111111'
const INC = '22222222-2222-4222-8222-222222222222'
const WORK = absolutePath('/work')
const grant = {
  kind: 'session',
  grantFrom: { sessionId: SESSION, approvalKey: 'allowed' },
} as const

function decision(
  name: string,
  over: { [K in keyof LayerInputs]?: LayerInputs[K] | undefined } = {},
  command = 'echo ok',
) {
  const reversibility =
    name === 'Bash' ? commandReversibility(command) : name === 'Delete' ? 'snapshotted' : 'unknown'
  return decide({
    call: {
      tool: { name, originalName: name, source: 'builtin', serverId: 'builtin' },
      args: { command },
      reversibility,
    },
    callReason: {
      reason: name === 'Bash' ? 'command' : 'default',
      facts: name === 'Bash' ? { command, cwd: WORK, toolName: name } : { toolName: name },
    },
    layers: {
      policy: { status: 'current', version: 'v', snapshot: EMPTY_POLICY },
      reversibility: { value: reversibility, source: 'host' },
      requiresUserInteraction: false,
      sessionGrant: null,
      approvalMode: 'auto',
      place: 'workspace',
      snapshotStatus: 'tree',
      commandSandboxed: true,
      ...over,
    } as LayerInputs,
    inspectors: [],
  })
}

async function harness() {
  const memory = createMemoryHost()
  await memory.fs.mkdirp(WORK)
  const tape = createTape(createMemoryTapeStore({ identity: memory.identity }))
  await tape.appendEntries({
    sessionId: SESSION,
    incarnationId: INC,
    entries: [
      tape.writer('session').entry('session/start', {
        sourceType: 'session',
        sourceId: SESSION,
        sourceSeq: 0,
        provenanceKey: sessionStartKey(INC),
        payload: { incarnationId: INC },
        createdAt: 0,
      }),
      ...creationEntries(
        { tape, sessionId: SESSION, incarnationId: INC, now: () => 0 },
        {
          profile: 'cowork',
          workspace: { folders: [WORK], origin: 'dedicated' },
          modelChoice: null,
          approvalMode: 'auto',
        },
      ),
    ],
  })
  return { memory, tape }
}

describe('06 approval range', () => {
  it.each(['tree', 'warming', 'file-only'] as const)(
    '06 验收 1: auto allows workspace Write, Edit and covered Delete while snapshots are %s, and asks safely when unavailable',
    async (snapshotStatus) => {
      for (const name of ['Write', 'Edit', 'Delete']) {
        // oxlint-disable-next-line no-await-in-loop -- each tool reads independently configured host evidence
        const h = await modeJudgeFixture({
          name,
          snapshotStatus,
          posture: 'active',
          platform: 'yes',
        })
        // oxlint-disable-next-line no-await-in-loop -- judgement must observe this host's snapshot state
        expect((await h.judge()).decision).toMatchObject({
          record: {
            verdict: 'allow',
            decidedBy: 'approval-mode',
            steps: expect.arrayContaining([
              {
                by: 'approval-mode',
                said: 'allow',
                basis: { modeRule: 'auto-range' },
                status: 'ok',
              },
            ]),
          },
          summary: { code: 'auto-mode' },
        })
        h.memory.snapshots.setStatus(MODE_SESSION, 'unavailable')
        // oxlint-disable-next-line no-await-in-loop -- sample again after the host changes state
        const unavailable = await h.judge()
        expect(unavailable.decision.record.verdict).toBe('ask')
        expect(unavailable.decision.confirm?.facts['autoAsk']).toBe(
          name === 'Delete' ? undefined : 'no-snapshot',
        )
        expect(unavailable.decision.record.decidedBy).toBe(
          name === 'Delete' ? 'irreversible' : 'approval-mode',
        )
      }
      const missing = decide({
        call: {
          tool: { name: 'Write', originalName: 'Write', source: 'builtin', serverId: 'builtin' },
          args: {},
          reversibility: 'unknown',
        },
        callReason: { reason: 'default', facts: { toolName: 'Write' } },
        layers: {
          policy: { status: 'current', version: 'empty', snapshot: EMPTY_POLICY },
          approvalMode: 'auto',
          place: 'workspace',
          reversibility: { value: 'unknown', source: 'host' },
          requiresUserInteraction: false,
          sessionGrant: null,
        },
        inspectors: [],
      })
      expect(missing.record.verdict).toBe('ask')
    },
  )

  it('06 验收 2: a Write with no coverage is allowed in auto; a Delete with none asks irreversible', async () => {
    const { memory, tape } = await harness()
    for (const status of ['tree', 'file-only'] as const) {
      memory.snapshots.setStatus(SESSION, status)
      memory.snapshots.coverage = async () => 'none'
      for (const name of ['Write', 'Delete']) {
        // oxlint-disable-next-line no-await-in-loop -- every case samples the currently selected host status
        const judged = await judgeCall(
          {
            writer: { by: 'resolver' as const },
            tape,
            host: memory,
            sessionId: SESSION,
            inspectors: [],
            protectedFiles: [],
            userSetting: () => null,
            searchHost: null,
            signal: new AbortController().signal,
          },
          {
            name,
            originalName: name,
            source: 'builtin',
            serverId: 'builtin',
            requiresUserInteraction: false,
            spec: { name, description: '', inputSchema: { type: 'object' } },
          },
          { input: { file_path: '/work/a' } },
        )
        if (judged.kind !== 'judged') throw new Error('stopped')
        expect(judged.coverage).toBe('none')
        expect(judged.decision.record.verdict).toBe(name === 'Write' ? 'allow' : 'ask')
        expect(judged.reversibility).toBe(name === 'Delete' ? 'irreversible' : 'unknown')
        expect(judged.decision.confirm?.reason).toBe(name === 'Delete' ? 'irreversible' : undefined)
        expect(
          answerScope({
            decision: judged.decision,
            reversibility: judged.reversibility,
            source: 'builtin',
            toolName: name,
          }),
        ).toBe(name === 'Delete' ? 'once' : 'session')
      }
    }
  })

  it.each([
    ['unavailable snapshots', 'no-snapshot', 'unavailable', 'active', 'yes'],
    ['Linux', 'linux', 'tree', 'active', 'linux'],
    ['another platform', 'platform', 'tree', 'active', 'no'],
    ['missing platform query', 'platform', 'tree', 'active', undefined],
    ['missing SandboxPorts', 'platform', 'tree', 'active', undefined],
    [
      'unavailable snapshots and unavailable posture',
      undefined,
      'unavailable',
      'unavailable',
      'yes',
    ],
    ['linux and unavailable posture', undefined, 'tree', 'unavailable', 'linux'],
    ['pending', 'sandbox', 'tree', 'pending', 'yes'],
    ['degraded', 'sandbox', 'tree', 'degraded', 'yes'],
    ['missing posture', 'sandbox', 'tree', undefined, 'yes'],
    ['unavailable posture', undefined, 'tree', 'unavailable', 'yes'],
    ['multiple blockers', 'no-snapshot', 'unavailable', 'pending', 'linux'],
    ['platform before sandbox', 'linux', 'tree', 'pending', 'linux'],
    ['platform before redirect', 'platform', 'tree', 'active', 'no'],
    ['sandbox before redirect', 'sandbox', 'tree', 'pending', 'yes'],
    ['bound rerun', undefined, 'unavailable', 'active', 'yes'],
  ] as const)(
    '06 验收 5: auto still asks for a command when %s, with autoAsk %s',
    async (label, autoAsk, status, state, platform) => {
      const h = await modeJudgeFixture({
        name: 'Bash',
        command: 'npm test > out.log',
        snapshotStatus: status,
        ...(state === undefined ? {} : { posture: state }),
        platform: label === 'missing SandboxPorts' ? 'missing-port' : (platform ?? 'missing-query'),
      })
      const result = await h.judge(
        label === 'bound rerun'
          ? {
              previousSandbox: {
                profile: 'full-access',
                chosen: 'workspace-write',
                override: { key: 'rerun', action: 'rerun-unsandboxed' },
              },
            }
          : {},
      )
      expect(result.decision.record.verdict).toBe('ask')
      expect(result.decision.confirm?.facts['autoAsk']).toBe(autoAsk)
      expect(result.decision.confirm?.facts['sandbox']).toBe(
        state === 'unavailable' ? 'unavailable' : undefined,
      )
      expect(result.decision.confirm?.reason).toBe(label === 'bound rerun' ? 'elevated' : 'command')
    },
  )

  it('06 验收 6: an allow-path bound command is unasked in auto and asked in manual', async () => {
    const h = await modeJudgeFixture({
      name: 'Bash',
      snapshotStatus: 'tree',
      platform: 'yes',
      posture: 'active',
      profile: 'read-only',
    })
    const previousSandbox = {
      profile: 'workspace-write',
      chosen: 'read-only',
      override: { action: 'allow-path', key: 'receipt', path: absolutePath('/other/a') },
    } as const
    expect(await h.judge({ previousSandbox })).toMatchObject({
      sandbox: { profile: 'workspace-write' },
      decision: { record: { verdict: 'allow', decidedBy: 'approval-mode' } },
    })
    await h.setMode('manual')
    expect(await h.judge({ previousSandbox })).toMatchObject({
      decision: { record: { verdict: 'ask' } },
    })
  })

  it.each([
    [
      'git reset --hard',
      ['git reset --hard HEAD~1'],
      ['git reset --soft HEAD~1', 'git reset --harder'],
    ],
    [
      'git checkout -- or dot',
      ['git checkout -- a', 'git checkout .'],
      ['git checkout main', 'git checkout -b x', 'git checkout ./x'],
    ],
    [
      'git checkout force',
      [
        'git checkout -f main',
        'git checkout --force main',
        'git checkout -qf main',
        'git checkout -fq main',
      ],
      ['git checkout main', 'git checkout --forceful main'],
    ],
    [
      'git restore',
      [
        'git restore x',
        'GIT RESTORE x',
        'git restore --staged --worktree x',
        'git restore -S -W x',
        'git restore -SW x',
        'git restore -qW x',
        'git restore -sStaging x',
        'git restore -S -Wq x',
        'git restore a && echo --staged',
        'git restore a | grep --staged',
        'git restore a\necho --staged',
        "git restore --staged 'R&D/plan.md' --worktree",
        "git restore --staged 'a;b' --worktree",
        'git restore --staged a 2>&1 --worktree x',
        'git restore --staged x \\\n --worktree y',
        'git restore --staged a; git restore b',
        'git restore --staged a && git restore b',
        'git restore a; echo --staged',
        'git restore --staged a | git restore b',
        'git restore --staged a\ngit restore b',
      ],
      [
        'git restore --staged x',
        'git restore -S x',
        'git restore -qS x',
        'git restore -Sq x',
        'git restore -S x; git status',
      ],
    ],
    [
      'git switch',
      [
        'git switch --discard-changes main',
        'git switch -f main',
        'git switch --force main',
        'git switch -qf main',
        'git switch -fq main',
      ],
      ['git switch main', 'git switch --forceful main'],
    ],
    ['truncate', ['truncate -s 0 x'], ['echo truncated']],
    ['dd of=', ['dd if=/dev/zero of=x'], ['dd if=x']],
  ])(
    '06 验收 7: %s is irreversible in both modes; the misses stay unknown',
    (_row, hits, misses) => {
      for (const command of hits)
        for (const approvalMode of ['auto', 'manual'] as const) {
          expect(commandReversibility(command)).toBe('irreversible')
          const d = decision('Bash', { approvalMode, sessionGrant: grant }, command)
          expect(d.record).toMatchObject({ verdict: 'ask', decidedBy: 'irreversible' })
          expect(d.confirm?.reason).toBe('command')
          expect(
            answerScope({
              decision: d,
              reversibility: 'irreversible',
              source: 'builtin',
              toolName: 'Bash',
            }),
          ).toBe('once')
        }
      for (const command of misses) expect(commandReversibility(command)).toBe('unknown')
    },
  )

  it.each([
    ['outside Write', { name: 'Write', path: '/outside/a' }],
    ['sensitive Write', { name: 'Write', sensitive: true }],
    ['uncovered Delete', { name: 'Delete', coverage: 'none' }],
    ['policy disables auto', { name: 'Write', policy: 'disable-auto' }],
    ...[
      'git reset --hard',
      'git checkout -- a',
      'git checkout -f main',
      'git restore a',
      'git switch --discard-changes main',
      'truncate -s 0 a',
      'dd if=/dev/zero of=a',
    ].map((command) => [command, { name: 'Bash', command }] as const),
    ['inspector asks about a command', { name: 'Bash', inspector: true }],
    ['inspector asks about a file', { name: 'Write', inspector: true }],
  ] as const)('06 验收 5: %s never adds autoAsk in either mode', async (_label, row) => {
    const query = row as Partial<ManualFixture> & { name: string; inspector?: boolean }
    for (const mode of ['auto', 'manual'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- the two modes use separate Tape histories
      const h = await modeJudgeFixture(
        {
          snapshotStatus: query.sensitive || query.inspector ? 'tree' : 'unavailable',
          platform: 'yes',
          posture: 'active',
          ...query,
        },
        mode,
      )
      // oxlint-disable-next-line no-await-in-loop -- compare the two real judgements
      const result = await h.judge(
        query.inspector
          ? {
              inspectors: [
                {
                  id: 'ask',
                  kind: 'local-rule',
                  ceiling: 'ask',
                  beforeCall: async () => ({ kind: 'ask', category: 'exfiltration', findings: [] }),
                },
              ],
            }
          : {},
      )
      expect(result.decision.record.verdict).toBe('ask')
      expect(result.decision.confirm?.facts).not.toHaveProperty('autoAsk')
    }
  })

  it.each(['hit', 'miss'] as const)(
    '06 验收 7: pattern self-tests reject invalid %s samples',
    (kind) => {
      expect(() =>
        patterns.assertCommandPatterns([
          {
            row: 'broken',
            test: (sample) => sample === 'good',
            ...(kind === 'hit' ? { hits: ['good', 'bad'] } : { misses: ['bad', 'good'] }),
          },
        ]),
      ).toThrow('command pattern self-test failed: broken')
    },
  )

  it('06 验收 9: the manual mode decides every fixture as before 06', async () => {
    expect(baseline.source.commit).toBe('62fed4d25440309484ea1e5b4b313b89de21dd30')
    for (const { input, expected } of baseline.decideCases)
      expect(decide(input as Parameters<typeof decide>[0])).toEqual(baselineDecision(expected))
    for (const { query, expectedIndex } of baseline.judgeCases) {
      // oxlint-disable-next-line no-await-in-loop -- each fixture has an isolated host and history
      const h = await modeJudgeFixture(query as ManualFixture, 'manual')
      // oxlint-disable-next-line no-await-in-loop -- record all decision fields, not just the verdict
      const { decision: actualDecision, reversibility, sandbox, place } = await h.judge()
      const expected = baseline.judgeDecisions[expectedIndex]!
      const original = baselineDecision(expected.decision)
      // Step 7 intentionally adds the machine category to command cards; all old fields stay exact.
      const expectedDecision =
        query.name === 'Bash' && query.inspector && original.confirm?.reason === 'command'
          ? {
              ...original,
              confirm: {
                ...original.confirm,
                facts: { ...original.confirm.facts, category: 'exfiltration' },
              },
            }
          : original
      expect(
        JSON.parse(JSON.stringify({ decision: actualDecision, reversibility, sandbox, place })),
      ).toEqual({
        ...expected,
        decision: expectedDecision,
      })
    }
  })

  it('06 验收 9: auto changes only manual approval-mode asks to allows across the same fixtures', async () => {
    let changed = 0
    let commandsChanged = 0
    for (const { query } of baseline.judgeCases) {
      // oxlint-disable-next-line no-await-in-loop -- both modes judge one unchanged fixture
      const h = await modeJudgeFixture(query as ManualFixture, 'manual')
      // oxlint-disable-next-line no-await-in-loop -- before switching the mode
      const manual = (await h.judge()).decision
      // oxlint-disable-next-line no-await-in-loop -- only the mode fact changes
      await h.setMode('auto')
      // oxlint-disable-next-line no-await-in-loop -- the host inputs are unchanged
      const auto = (await h.judge()).decision

      if (
        manual.record.verdict === 'ask' &&
        manual.record.decidedBy === 'approval-mode' &&
        auto.record.verdict === 'allow'
      ) {
        changed++
        if (query.name === 'Bash') commandsChanged++
        // oxlint-disable-next-line vitest/no-conditional-expect -- this is the sole permitted relation
        expect(auto.record.decidedBy).toBe('approval-mode')
        // oxlint-disable-next-line vitest/no-conditional-expect -- excluded scopes cannot use this relation
        expect(
          (query.source ?? 'builtin') === 'builtin' &&
            ['Write', 'Edit', 'Delete', 'Bash'].includes(query.name) &&
            !(query.name !== 'Bash' && 'path' in query && query.path?.startsWith('/outside')) &&
            !('sensitive' in query && query.sensitive) &&
            !('policy' in query),
        ).toBe(true)
        // oxlint-disable-next-line vitest/no-conditional-expect -- automatic allows have the documented summary
        expect(auto.summary.code).toBe('auto-mode')
        // oxlint-disable-next-line vitest/no-conditional-expect -- an allowed call has neither card nor block
        expect([auto.confirm, auto.block]).toEqual([undefined, undefined])
        // oxlint-disable-next-line vitest/no-conditional-expect -- the preceding layers cannot loosen
        expect(normalize(auto).record.steps).toEqual(normalize(manual).record.steps)
      } else {
        // oxlint-disable-next-line vitest/no-conditional-expect -- every other outcome must be identical
        expect(normalize(auto)).toEqual(normalize(manual))
      }
    }
    expect(changed).toBeGreaterThanOrEqual(17)
    expect(commandsChanged).toBeGreaterThanOrEqual(3)
    for (const name of ['Read', 'Glob', 'Grep']) {
      // oxlint-disable-next-line no-await-in-loop -- independently verify the three unchanged read tools
      const h = await modeJudgeFixture({
        name,
        snapshotStatus: 'tree',
        platform: 'yes',
        posture: 'active',
      })
      // oxlint-disable-next-line no-await-in-loop -- inspect the actual layer record
      const d = (await h.judge()).decision
      expect(d.summary.code).toBe('workspace-read')
      expect(d.record.steps.find((step) => step.by === 'approval-mode')?.said).toBe('none')
    }
  })
  it.each(['Write', 'Bash'])(
    '06 验收 5: an MCP tool named %s never gains autoAsk',
    async (name) => {
      const h = await modeJudgeFixture({
        name,
        source: 'mcp',
        snapshotStatus: 'unavailable',
        platform: 'yes',
        posture: 'active',
      })
      const result = await h.judge()
      expect(result.decision.record.verdict).toBe('ask')
      expect(result.decision.confirm?.facts).not.toHaveProperty('autoAsk')
    },
  )

  it.each(['Write', 'Bash'])(
    '06 验收 1: unknown snapshot state fails closed for %s',
    async (name) => {
      const h = await modeJudgeFixture({
        name,
        snapshotStatus: 'tree',
        platform: 'yes',
        posture: 'active',
      })
      vi.spyOn(h.host.snapshots, 'status').mockReturnValue('future-state' as never)
      const result = await h.judge()
      expect(result.decision.record.verdict).toBe('ask')
      expect(result.decision.confirm?.facts['autoAsk']).toBe('no-snapshot')
      expect(decision(name, { snapshotStatus: 'future-state' as never }).record.verdict).toBe('ask')
    },
  )

  it.each(['Write', 'Bash'])(
    '06 验收 1: decide requires snapshot and command evidence for %s',
    (name) => {
      for (const snapshotStatus of [undefined, 'unavailable'] as const)
        expect(decision(name, { snapshotStatus }).record.verdict).toBe('ask')
      expect(decision(name, { snapshotStatus: 'tree' }).record.verdict).toBe('allow')
      expect(decision('Write', { place: 'outside', snapshotStatus: 'tree' }).record.verdict).toBe(
        'ask',
      )
      expect(decision('Bash', { commandSandboxed: undefined }).record.verdict).toBe('ask')
      expect(decision(name, { policy: { status: 'unavailable' } as never }).record.verdict).toBe(
        'deny',
      )
    },
  )

  it('06 验收 7: loading always runs command pattern self-tests', async () => {
    vi.resetModules()
    const some = Array.prototype.some
    const every = vi.spyOn(Array.prototype, 'some').mockImplementation(function (
      this: unknown[],
      callback,
      thisArg,
    ) {
      return this[0] === 'git reset --hard' ? true : some.call(this, callback, thisArg)
    })
    try {
      await expect(import('../../src/permission/reversibility.js')).rejects.toThrow(
        'command pattern self-test failed',
      )
    } finally {
      every.mockRestore()
      vi.resetModules()
    }
  })

  it.each(['facts', 'head', 'append'] as const)(
    '06 验收 15: a stop after policy %s prevents further judgement',
    async (stage) => {
      const h = await modeJudgeFixture({
        name: 'Write',
        snapshotStatus: 'tree',
        platform: 'yes',
        posture: 'active',
        policy: 'disable-auto',
      })
      const abort = new AbortController()
      let armed = false
      let heads = 0
      let writes = 0
      const tape = {
        writer: h.tape.writer.bind(h.tape),
        readRange: async (q: Parameters<typeof h.tape.readRange>[0]) => {
          const page = await h.tape.readRange(q)
          if (armed && stage === 'facts') abort.abort('user-stop')
          return page
        },
        head: async (id: string) => {
          heads++
          const head = await h.tape.head(id)
          if (stage === 'head') abort.abort('user-stop')
          return head
        },
        appendEntries: async (q: Parameters<typeof h.tape.appendEntries>[0]) => {
          writes++
          const receipts = await h.tape.appendEntries(q)
          if (stage === 'append') abort.abort('user-stop')
          return receipts
        },
      }
      const result = await judgeCall(
        {
          ...h.ctx,
          tape,
          signal: abort.signal,
          inspectors: [
            {
              id: 'arm-stop',
              kind: 'local-rule',
              ceiling: 'ask',
              beforeCall: async () => {
                armed = true
                return { kind: 'none' }
              },
            },
          ],
        },
        h.item,
        { input: h.input },
      )
      expect(result).toEqual({ kind: 'stopped' })
      expect(heads).toBe(stage === 'facts' ? 0 : 1)
      expect(writes).toBe(stage === 'append' ? 1 : 0)
    },
  )
})
