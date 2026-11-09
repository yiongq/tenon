import { describe, expect, it } from 'vitest'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createTape,
  EMPTY_POLICY,
} from '../../src/index.js'
import { judgeCall } from '../../src/loop/batch.js'
import type { LayerInputs } from '../../src/permission/decide.js'
import { decide } from '../../src/permission/decide.js'
import { answerScope } from '../../src/permission/grants.js'
import { autoStillAsk, commandReversibility } from '../../src/permission/reversibility.js'
import { creationEntries } from '../../src/session/facts.js'
import { sessionStartKey } from '../../src/tape/provenance.js'
import baseline from './fixtures/06-manual-baseline.json' with { type: 'json' }

const SESSION = '11111111-1111-4111-8111-111111111111'
const INC = '22222222-2222-4222-8222-222222222222'
const WORK = absolutePath('/work')
const grant = {
  kind: 'session',
  grantFrom: { sessionId: SESSION, approvalKey: 'allowed' },
} as const

function decision(name: string, over: Partial<LayerInputs> = {}, command = 'echo ok') {
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
    },
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
    '06 验收 1: auto allows workspace file tools while snapshots are %s, and asks with no-snapshot when unavailable',
    (snapshotStatus) => {
      for (const name of ['Write', 'Edit', 'Delete']) {
        expect(decision(name, { snapshotStatus })).toMatchObject({
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
        const unavailable = decision(name, {
          snapshotStatus: 'unavailable',
          autoAsk: 'no-snapshot',
        })
        expect(unavailable).toMatchObject({
          record: { verdict: 'ask' },
          confirm: { facts: { autoAsk: 'no-snapshot' } },
        })
      }
      for (const name of ['WebSearch', 'WebFetch'])
        expect(decision(name).record.verdict).toBe('ask')
      expect(decision('Write', { place: 'outside' }).record.verdict).toBe('ask')
      expect(decision('Write', { sensitive: 'credential' }).record.verdict).toBe('ask')
      expect(decision('Write', { policy: { status: 'unavailable' } }).record.verdict).toBe('deny')
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
      const { memory, tape } = await harness()
      memory.snapshots.setStatus(SESSION, status)
      const host = {
        ...memory,
        sandbox: {
          ...memory.sandbox,
          ...(state === undefined
            ? {}
            : { posture: () => ({ state, profile: 'workspace-write' as const }) }),
        },
      }
      const result = await judgeCall(
        {
          host,
          tape,
          sessionId: SESSION,
          inspectors: [],
          protectedFiles: [],
          userSetting: () => null,
          searchHost: null,
          signal: new AbortController().signal,
          sandbox: {
            beforeWrap: () => {},
            grantsChanged: () => {},
            ...(platform === undefined ? {} : { autoCommands: () => platform }),
          },
          ...(label === 'bound rerun'
            ? {
                previousSandbox: {
                  profile: 'full-access' as const,
                  chosen: 'workspace-write' as const,
                  override: { key: 'rerun', action: 'rerun-unsandboxed' as const },
                },
              }
            : {}),
        },
        {
          name: 'Bash',
          originalName: 'Bash',
          source: 'builtin',
          serverId: 'builtin',
          requiresUserInteraction: false,
          spec: { name: 'Bash', description: '', inputSchema: {} },
        },
        { input: { command: 'npm test > out.log' } },
      )
      if (result.kind !== 'judged') throw new Error('stopped')
      expect(result.decision.record.verdict).toBe('ask')
      expect(result.decision.confirm?.facts['autoAsk']).toBe(autoAsk)
      expect(result.decision.confirm?.facts['sandbox']).toBe(
        state === 'unavailable' ? 'unavailable' : undefined,
      )
      expect(result.decision.confirm?.reason).toBe(label === 'bound rerun' ? 'elevated' : 'command')
    },
  )

  it('06 验收 6: an allow-path bound command is unasked in auto and asked in manual', () => {
    const sandbox = {
      profile: 'workspace-write',
      chosen: 'read-only',
      override: { action: 'allow-path', key: 'receipt', target: '/other/a' },
    } as const
    expect(decision('Bash', { sandbox }).record.verdict).toBe('allow')
    expect(decision('Bash', { sandbox, approvalMode: 'manual' }).record.verdict).toBe('ask')
  })

  it.each([
    ['git reset --hard', ['git reset --hard HEAD~1'], ['git reset --soft HEAD~1']],
    [
      'git checkout -- or dot',
      ['git checkout -- a', 'git checkout .'],
      ['git checkout main', 'git checkout -b x', 'git checkout ./x'],
    ],
    [
      'git checkout force',
      ['git checkout -f main', 'git checkout --force main'],
      ['git checkout main'],
    ],
    [
      'git restore',
      ['git restore x', 'git restore --staged --worktree x', 'git restore -S -W x'],
      ['git restore --staged x', 'git restore -S x'],
    ],
    [
      'git switch',
      ['git switch --discard-changes main', 'git switch -f main', 'git switch --force main'],
      ['git switch main'],
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
    'npm test >> out.log',
    'npm test 2>&1',
    'npm test >&2',
    'npm test > /dev/null',
    'x => x',
    'a -> b',
    'a >= b',
  ])('06 验收 8: a redirect asks once in auto with a session answer; %s does not', async (miss) => {
    const { memory, tape } = await harness()
    memory.snapshots.setStatus(SESSION, 'tree')
    const commandResult = await judgeCall(
      {
        tape,
        host: {
          ...memory,
          sandbox: {
            ...memory.sandbox,
            posture: () => ({ state: 'active', profile: 'workspace-write' }),
          },
        },
        sessionId: SESSION,
        inspectors: [],
        protectedFiles: [],
        userSetting: () => null,
        searchHost: null,
        signal: new AbortController().signal,
        sandbox: { beforeWrap: () => {}, grantsChanged: () => {}, autoCommands: () => 'yes' },
      },
      {
        name: 'Bash',
        originalName: 'Bash',
        source: 'builtin',
        serverId: 'builtin',
        requiresUserInteraction: false,
        spec: { name: 'Bash', description: '', inputSchema: {} },
      },
      { input: { command: 'npm test > out.log' } },
    )
    expect(commandResult).toMatchObject({
      decision: { record: { verdict: 'ask' }, confirm: { facts: { autoAsk: 'redirect' } } },
    })
    expect(autoStillAsk(miss)).toBeNull()
    expect(
      decision('Bash', autoStillAsk(miss) === null ? {} : { autoAsk: 'redirect' }, miss).record
        .verdict,
    ).toBe('allow')
    const command = 'npm test > out.log'
    expect(autoStillAsk(command)).toBe('redirect')
    const d = decision('Bash', { autoAsk: 'redirect' }, command)
    expect(d).toMatchObject({
      record: { verdict: 'ask' },
      confirm: { reason: 'command', facts: { autoAsk: 'redirect' } },
    })
    expect(
      answerScope({ decision: d, reversibility: 'unknown', source: 'builtin', toolName: 'Bash' }),
    ).toBe('session')
    for (const approvalMode of ['auto', 'manual'] as const)
      expect(
        decision('Bash', { autoAsk: 'redirect', approvalMode, sessionGrant: grant }, command)
          .summary.code,
      ).toBe('session-allowed')
  })

  it('06 验收 9: the manual mode decides every fixture as before 06', () => {
    for (const { input, expected } of baseline)
      expect(decide(input as Parameters<typeof decide>[0])).toEqual(expected)
  })
})
