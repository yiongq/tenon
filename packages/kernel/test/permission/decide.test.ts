/**
 * The decision table, row by row (spec 02 §权限决策顺序, §判决记录与摘要; plan step 11, 旧 5 with its
 * 旁注 row, 旧 152, 旧 154, 旧 155, the primary-reason order). Each case builds `LayerInputs`
 * directly — no Tape, no loop — and asserts the verdict and `decidedBy`, with the basis where it
 * carries the point.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_POLICY } from '../../src/index.js'
import type { McpConnection, PolicyState, ToolPolicyRule } from '../../src/index.js'
import { canRunInParallel, decide, primaryReason } from '../../src/permission/decide.js'
import type {
  CallReason,
  Decision,
  InspectorOutcome,
  LayerInputs,
} from '../../src/permission/decide.js'
import { summarize } from '../../src/permission/record.js'
import { reversibilityOf } from '../../src/permission/reversibility.js'
import type { InspectedCall } from '../../src/permission/session-view.js'
import { mcpCandidates } from '../../src/tools/mcp-source.js'

const CURRENT: PolicyState = { status: 'current', version: 'v1', snapshot: EMPTY_POLICY }

function policy(...tools: ToolPolicyRule[]): PolicyState {
  return { status: 'current', version: 'v7', snapshot: { tools } }
}

function builtin(name: string, args: Record<string, unknown> = {}): InspectedCall {
  return {
    tool: { name, source: 'builtin', serverId: 'builtin', originalName: name },
    args,
    reversibility: 'unknown',
  }
}

function connector(originalName = 'tool', serverId = 'srv'): InspectedCall {
  return {
    tool: { name: `${serverId}__${originalName}`, source: 'mcp', serverId, originalName },
    args: {},
    reversibility: 'unknown',
  }
}

function layers(over: Partial<LayerInputs> = {}): LayerInputs {
  return {
    policy: CURRENT,
    reversibility: { value: 'unknown', source: 'host' },
    requiresUserInteraction: false,
    sessionGrant: null,
    approvalMode: 'manual',
    ...over,
  }
}

const READ_ONLY = { value: 'read-only' as const, source: 'host' as const }
const IRREVERSIBLE = { value: 'irreversible' as const, source: 'host' as const }
const SESSION_GRANT = {
  kind: 'session' as const,
  grantFrom: { sessionId: 's', approvalKey: 'tool:v1:approval:x' },
}

function run(
  call: InspectedCall,
  over: Partial<LayerInputs> = {},
  callReason: CallReason = { reason: 'default', facts: { toolName: call.tool.originalName } },
  inspectors: readonly InspectorOutcome[] = [],
): Decision {
  return decide({ call, callReason, layers: layers(over), inspectors })
}

function verdictOf(decision: Decision): [string, string] {
  return [decision.record.verdict, decision.record.decidedBy]
}

const ask = (inspectorId: string, ceiling: 'ask' | 'deny' = 'ask'): InspectorOutcome => ({
  inspectorId,
  ceiling,
  status: 'ok',
  opinion: { kind: 'ask', category: 'exfiltration', findings: [{ code: 'x' }] },
})
const deny = (inspectorId: string): InspectorOutcome => ({
  inspectorId,
  ceiling: 'deny',
  status: 'ok',
  opinion: { kind: 'deny', category: 'exfiltration', findings: [] },
})

describe('each layer, alone', () => {
  it('layer 1 denies a tool the policy denies, and an unavailable policy denies everything (D4)', () => {
    expect(
      verdictOf(
        run(builtin('Read'), {
          policy: policy({ policyId: 'p', serverId: 'builtin', effect: 'deny', toolName: 'Read' }),
          reversibility: READ_ONLY,
          place: 'workspace',
        }),
      ),
    ).toEqual(['deny', 'tenant-policy'])
    const unavailable = run(builtin('Read'), {
      policy: { status: 'unavailable' },
      reversibility: READ_ONLY,
      place: 'workspace',
    })
    expect(verdictOf(unavailable)).toEqual(['deny', 'tenant-policy'])
    expect(unavailable.block).toEqual({ reason: 'policy', facts: { toolName: 'Read' } })
    // A rule naming only the server covers all its tools.
    expect(
      verdictOf(
        run(connector(), { policy: policy({ policyId: 'p', serverId: 'srv', effect: 'deny' }) }),
      ),
    ).toEqual(['deny', 'tenant-policy'])
    // A rule for another server, or another tool, says nothing.
    expect(
      verdictOf(
        run(connector(), { policy: policy({ policyId: 'p', serverId: 'other', effect: 'deny' }) }),
      ),
    ).toEqual(['ask', 'approval-mode'])
  })

  it('layer 2 blocks the protected list, lets the session read its own spill, and blocks writing it', () => {
    const blocked = run(
      builtin('Read'),
      { place: 'protected', reversibility: READ_ONLY },
      {
        reason: 'default',
        facts: { toolName: 'Read', path: '/p/config.json', target: '/p/config.json' },
      },
    )
    expect(verdictOf(blocked)).toEqual(['deny', 'protected'])
    expect(blocked.block).toEqual({
      reason: 'protected',
      facts: { toolName: 'Read', target: '/p/config.json' },
    })
    expect(
      verdictOf(run(builtin('Read'), { place: 'own-spill', reversibility: READ_ONLY })),
    ).toEqual(['allow', 'protected'])
    expect(verdictOf(run(builtin('Write'), { place: 'own-spill' }))).toEqual(['deny', 'protected'])
    expect(verdictOf(run(builtin('WebFetch'), { urlBlocked: true }))).toEqual(['deny', 'protected'])
  })

  it('layer 3 denies what the user switched off (旧 154)', () => {
    const never = run(connector(), { userSetting: 'never' })
    expect(verdictOf(never)).toEqual(['deny', 'user-disabled'])
    expect(never.block).toEqual({ reason: 'user-disabled', facts: { toolName: 'tool' } })
    expect(verdictOf(run(connector(), { connectorOff: true }))).toEqual(['deny', 'user-disabled'])
    // 'ask' takes no position.
    expect(verdictOf(run(connector(), { userSetting: 'ask' }))).toEqual(['ask', 'approval-mode'])
  })

  it('layer 4 asks for an irreversible call and for a server that requires the user', () => {
    const irreversible = run(builtin('Write'), { reversibility: IRREVERSIBLE, place: 'workspace' })
    expect(verdictOf(irreversible)).toEqual(['ask', 'irreversible'])
    expect(irreversible.confirm?.reason).toBe('irreversible')
    const interaction = run(connector(), { requiresUserInteraction: true })
    expect(verdictOf(interaction)).toEqual(['ask', 'connector-confirm'])
    expect(interaction.confirm).toEqual({
      reason: 'interaction-required',
      facts: { toolName: 'tool' },
    })
  })

  it('layer 5 tightens: an ask asks, a deny denies, a failure folds into its ceiling (F1)', () => {
    const inWorkspace = { place: 'workspace' as const, reversibility: READ_ONLY }
    expect(verdictOf(run(builtin('Read'), inWorkspace, undefined, [ask('ex')]))).toEqual([
      'ask',
      'inspector',
    ])
    expect(verdictOf(run(builtin('Read'), inWorkspace, undefined, [deny('strict')]))).toEqual([
      'deny',
      'inspector',
    ])
    const timedOut = run(builtin('Read'), inWorkspace, undefined, [
      { inspectorId: 'ex', ceiling: 'ask', status: 'timeout' },
    ])
    expect(verdictOf(timedOut)).toEqual(['ask', 'inspector'])
    expect(timedOut.confirm).toEqual({
      reason: 'flagged',
      facts: { toolName: 'Read', category: 'inspector-failed' },
    })
    expect(timedOut.summary.code).toBe('check-incomplete')
    const failedDeny = run(builtin('Read'), inWorkspace, undefined, [
      { inspectorId: 'strict', ceiling: 'deny', status: 'error' },
    ])
    expect(failedDeny.block).toEqual({
      reason: 'inspector',
      facts: { toolName: 'Read', category: 'inspector-failed' },
    })
    const step = failedDeny.record.steps.find((s) => s.by === 'inspector')
    expect(step).toMatchObject({ inspectorId: 'strict', said: 'deny', status: 'error' })
  })

  it('layer 6 allows what a grant covers', () => {
    expect(
      run(builtin('Read'), { place: 'workspace', reversibility: READ_ONLY }).record.steps.find(
        (s) => s.by === 'user-grant',
      )?.basis,
    ).toEqual({ grant: 'workspace-folder' })
    expect(
      verdictOf(run(builtin('Write'), { place: 'workspace', sessionGrant: SESSION_GRANT })),
    ).toEqual(['allow', 'user-grant'])
    expect(verdictOf(run(connector(), { userSetting: 'always-allow' }))).toEqual([
      'allow',
      'user-grant',
    ])
    expect(verdictOf(run(connector(), { taskGrant: true }))).toEqual(['allow', 'user-grant'])
  })

  it('layer 7: the manual mode asks what changes, and never gates AskUserQuestion or Agent', () => {
    expect(verdictOf(run(builtin('Write'), { place: 'workspace' }))).toEqual([
      'ask',
      'approval-mode',
    ])
    for (const approvalMode of ['manual', 'auto'] as const) {
      expect(
        verdictOf(run(builtin('AskUserQuestion'), { reversibility: READ_ONLY, approvalMode })),
      ).toEqual(['allow', 'approval-mode'])
      expect(verdictOf(run(builtin('Agent'), { approvalMode }))).toEqual(['allow', 'approval-mode'])
    }
    // A policy ask rule naming them asks after all (旧 154).
    for (const toolName of ['Agent', 'AskUserQuestion']) {
      expect(
        verdictOf(
          run(builtin(toolName), {
            reversibility: toolName === 'Agent' ? { value: 'unknown', source: 'host' } : READ_ONLY,
            policy: policy({ policyId: 'p', serverId: 'builtin', effect: 'ask', toolName }),
          }),
        ),
      ).toEqual(['ask', 'tenant-policy'])
    }
    // Only the builtin launches: a connector tool that happens to share the name is asked as one.
    for (const originalName of ['Agent', 'AskUserQuestion']) {
      expect(verdictOf(run(connector(originalName)))).toEqual(['ask', 'approval-mode'])
    }
  })

  it('旁注: an MCP annotation such as readOnlyHint is shown, never read — it loosens nothing', async () => {
    const connection = {
      listTools: () =>
        Promise.resolve([
          {
            name: 'get-sum',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
          },
        ]),
    } as unknown as McpConnection
    const [candidate] = await mcpCandidates([{ serverId: 'everything', connection }])
    if (candidate === undefined) throw new Error('no candidate')
    // The table item keeps nothing of the annotations, and the host reads the tool as unknown.
    expect(JSON.stringify(candidate)).not.toContain('readOnlyHint')
    const args = { a: 1, b: 2 }
    const reversibility = reversibilityOf(candidate, args)
    expect(reversibility).toBe('unknown')
    const call: InspectedCall = {
      tool: {
        name: candidate.name,
        source: candidate.source,
        serverId: candidate.serverId,
        originalName: candidate.originalName,
      },
      args,
      reversibility,
    }
    expect(
      verdictOf(run(call, { reversibility: { value: reversibility, source: 'host' } })),
    ).toEqual(['ask', 'approval-mode'])
  })

  it('layer 8 asks when nothing else holds: a read outside the workspace (旧 157)', () => {
    const outside = run(
      builtin('Read'),
      { place: 'outside', reversibility: READ_ONLY },
      {
        reason: 'outside-workspace',
        facts: { path: '/etc/hosts', workspace: '/ws', toolName: 'Read' },
      },
    )
    expect(verdictOf(outside)).toEqual(['ask', 'default'])
    expect(outside.confirm).toEqual({
      reason: 'outside-workspace',
      facts: { path: '/etc/hosts', workspace: '/ws' },
    })
  })
})

describe('step 2: the first tier that holds', () => {
  it('deny beats must-ask beats allow beats the manual ask beats the default ask', () => {
    const everything = {
      policy: policy({ policyId: 'p', serverId: 'srv', effect: 'deny' }),
      requiresUserInteraction: true,
      userSetting: 'always-allow' as const,
    }
    expect(verdictOf(run(connector(), everything))).toEqual(['deny', 'tenant-policy'])
    expect(
      verdictOf(run(connector(), { requiresUserInteraction: true, userSetting: 'always-allow' })),
    ).toEqual(['ask', 'connector-confirm'])
    expect(verdictOf(run(connector(), { userSetting: 'always-allow' }))).toEqual([
      'allow',
      'user-grant',
    ])
    expect(verdictOf(run(connector()))).toEqual(['ask', 'approval-mode'])
    expect(verdictOf(run(builtin('Read'), { reversibility: READ_ONLY }))).toEqual([
      'ask',
      'default',
    ])
  })

  it('names the first allower in table order: protected > user-grant > approval-mode', () => {
    // A workspace Read in the auto mode: the folder (layer 6) and the auto range (layer 7) both allow.
    const read = run(builtin('Read'), {
      place: 'workspace',
      reversibility: READ_ONLY,
      approvalMode: 'auto',
    })
    expect(verdictOf(read)).toEqual(['allow', 'user-grant'])
    expect(read.summary.code).toBe('workspace-read')
    // The session's own spill with a task grant: the narrow way (layer 2) and the grant both allow.
    expect(
      verdictOf(
        run(builtin('Read'), { place: 'own-spill', reversibility: READ_ONLY, taskGrant: true }),
      ),
    ).toEqual(['allow', 'protected'])
  })

  it('names the first denier in table order, and the must-ask layers in D5 order', () => {
    // Layer 1 before layer 2: a protected path the policy also denies is the policy's block.
    const layered = run(builtin('Read'), {
      place: 'protected',
      reversibility: READ_ONLY,
      policy: policy({ policyId: 'p', serverId: 'builtin', effect: 'deny', toolName: 'Read' }),
    })
    expect(verdictOf(layered)).toEqual(['deny', 'tenant-policy'])
    expect(layered.block?.reason).toBe('policy')
    expect(
      verdictOf(
        run(connector(), { place: 'protected', userSetting: 'never' }, undefined, [deny('d')]),
      ),
    ).toEqual(['deny', 'protected'])
    expect(verdictOf(run(connector(), { userSetting: 'never' }, undefined, [deny('d')]))).toEqual([
      'deny',
      'user-disabled',
    ])
    const both = {
      policy: policy({ policyId: 'p', serverId: 'srv', effect: 'ask' }),
      requiresUserInteraction: true,
    }
    expect(verdictOf(run(connector(), both))).toEqual(['ask', 'tenant-policy'])
    expect(
      verdictOf(
        run(
          connector(),
          { requiresUserInteraction: true, reversibility: IRREVERSIBLE },
          undefined,
          [ask('ex')],
        ),
      ),
    ).toEqual(['ask', 'connector-confirm'])
    expect(
      verdictOf(run(connector(), { reversibility: IRREVERSIBLE }, undefined, [ask('ex')])),
    ).toEqual(['ask', 'inspector'])
  })

  it('lets an unavailable policy and layer 5 beat the spill narrow way (D2, H9)', () => {
    expect(
      verdictOf(
        run(builtin('Read'), {
          place: 'own-spill',
          reversibility: READ_ONLY,
          policy: { status: 'unavailable' },
        }),
      ),
    ).toEqual(['deny', 'tenant-policy'])
    expect(
      verdictOf(
        run(builtin('Read'), { place: 'own-spill', reversibility: READ_ONLY }, undefined, [
          ask('ex'),
        ]),
      ),
    ).toEqual(['ask', 'inspector'])
    expect(
      verdictOf(
        run(builtin('Read'), {
          place: 'own-spill',
          reversibility: READ_ONLY,
          policy: policy({ policyId: 'p', serverId: 'builtin', effect: 'deny', toolName: 'Read' }),
        }),
      ),
    ).toEqual(['deny', 'tenant-policy'])
  })
})

describe('the layer-1 truth table (16 cells)', () => {
  const rule = (
    effect: 'deny' | 'ask' | 'release-irreversible',
    serverId: string,
    toolName: string,
  ): PolicyState =>
    policy(
      effect === 'release-irreversible'
        ? { policyId: 'p', serverId, effect, toolName }
        : { policyId: 'p', serverId, effect, toolName },
    )
  const never = (p: PolicyState, reversibility: LayerInputs['reversibility'] = IRREVERSIBLE) =>
    run(connector(), { policy: p, userSetting: 'never', reversibility })
  const silent = (p: PolicyState, reversibility: LayerInputs['reversibility'] = IRREVERSIBLE) =>
    run(connector(), { policy: p, reversibility })
  const session = (p: PolicyState, reversibility: LayerInputs['reversibility'] = IRREVERSIBLE) =>
    run(builtin('Write'), {
      policy: p,
      sessionGrant: SESSION_GRANT,
      place: 'workspace',
      reversibility,
    })
  const always = (p: PolicyState, reversibility: LayerInputs['reversibility'] = IRREVERSIBLE) =>
    run(connector(), { policy: p, userSetting: 'always-allow', reversibility })

  it('deny row: every cell denies', () => {
    for (const cell of [
      never(rule('deny', 'srv', 'tool')),
      silent(rule('deny', 'srv', 'tool')),
      session(rule('deny', 'builtin', 'Write')),
      always(rule('deny', 'srv', 'tool')),
    ]) {
      expect(verdictOf(cell)).toEqual(['deny', 'tenant-policy'])
    }
  })

  it('ask row: never denies; the rest ask every time, grants not counted', () => {
    expect(verdictOf(never(rule('ask', 'srv', 'tool')))).toEqual(['deny', 'user-disabled'])
    for (const cell of [
      silent(rule('ask', 'srv', 'tool')),
      session(rule('ask', 'builtin', 'Write')),
      always(rule('ask', 'srv', 'tool')),
    ]) {
      expect(verdictOf(cell)).toEqual(['ask', 'tenant-policy'])
      expect(cell.confirm?.reason).toBe('policy')
    }
    // In any mode.
    expect(
      verdictOf(
        run(builtin('Read'), {
          policy: rule('ask', 'builtin', 'Read'),
          place: 'workspace',
          reversibility: READ_ONLY,
          approvalMode: 'auto',
        }),
      ),
    ).toEqual(['ask', 'tenant-policy'])
  })

  it('no-opinion row (every personal tenant): by mode; irreversible asks unless always-allowed', () => {
    expect(verdictOf(never(CURRENT))).toEqual(['deny', 'user-disabled'])
    expect(verdictOf(silent(CURRENT, { value: 'unknown', source: 'host' }))).toEqual([
      'ask',
      'approval-mode',
    ])
    expect(verdictOf(silent(CURRENT))).toEqual(['ask', 'irreversible'])
    expect(verdictOf(session(CURRENT, { value: 'unknown', source: 'host' }))).toEqual([
      'allow',
      'user-grant',
    ])
    expect(verdictOf(session(CURRENT))).toEqual(['ask', 'irreversible'])
    expect(verdictOf(always(CURRENT))).toEqual(['allow', 'user-grant'])
  })

  it('release row: by mode, irreversible no longer forced, and a builtin rule names BUILTIN_SERVER_ID', () => {
    expect(verdictOf(never(rule('release-irreversible', 'srv', 'tool')))).toEqual([
      'deny',
      'user-disabled',
    ])
    const released = silent(rule('release-irreversible', 'srv', 'tool'))
    // The manual mode still asks — but as the mode, not as layer 4 ①.
    expect(verdictOf(released)).toEqual(['ask', 'approval-mode'])
    expect(released.record.steps.find((s) => s.by === 'irreversible')).toMatchObject({
      said: 'none',
      basis: { releasedBy: 'tenant-policy' },
    })
    expect(verdictOf(session(rule('release-irreversible', 'builtin', 'Write')))).toEqual([
      'allow',
      'user-grant',
    ])
    expect(verdictOf(always(rule('release-irreversible', 'srv', 'tool')))).toEqual([
      'allow',
      'user-grant',
    ])
  })
})

describe('step 1: the three releases take away layer 4 ① and never ②', () => {
  const releases: Array<[string, Partial<LayerInputs>]> = [
    [
      'release-irreversible',
      {
        policy: policy({
          policyId: 'p',
          serverId: 'srv',
          effect: 'release-irreversible',
          toolName: 'tool',
        }),
      },
    ],
    ['always-allow', { userSetting: 'always-allow' }],
    ['task grant', { taskGrant: true }],
  ]
  for (const [label, over] of releases) {
    it(`${label}`, () => {
      const released = run(connector(), { ...over, reversibility: IRREVERSIBLE })
      expect(released.record.steps.find((s) => s.by === 'irreversible')?.said).toBe('none')
      expect(
        verdictOf(
          run(connector(), { ...over, reversibility: IRREVERSIBLE, requiresUserInteraction: true }),
        ),
      ).toEqual(['ask', 'connector-confirm'])
    })
  }
})

describe('the spec’s two worked examples (旧 152)', () => {
  it('example 1: a second git push asks again, as a command, once — a session grant changes nothing', () => {
    const push = builtin('Bash', { command: 'git push' })
    const reason: CallReason = {
      reason: 'command',
      facts: { command: 'git push', cwd: '/ws', toolName: 'Bash' },
    }
    for (const sessionGrant of [null, SESSION_GRANT]) {
      const decision = run(push, { reversibility: IRREVERSIBLE, sessionGrant }, reason)
      expect(verdictOf(decision)).toEqual(['ask', 'irreversible'])
      expect(decision.confirm).toEqual({
        reason: 'command',
        facts: { command: 'git push', cwd: '/ws' },
      })
    }
  })

  it('example 2: a policy-irreversible connector tool that is always-allowed is allowed; a policy ask asks', () => {
    const policyIrreversible = { value: 'irreversible' as const, source: 'policy' as const }
    const allowed = run(connector(), {
      reversibility: policyIrreversible,
      userSetting: 'always-allow',
    })
    expect(verdictOf(allowed)).toEqual(['allow', 'user-grant'])
    expect(allowed.record.steps.find((s) => s.by === 'user-grant')?.basis).toEqual({
      grant: 'always-allow',
      releasedBy: 'always-allow',
    })
    const asked = run(connector(), {
      reversibility: policyIrreversible,
      userSetting: 'always-allow',
      policy: policy({ policyId: 'p', serverId: 'srv', effect: 'ask', toolName: 'tool' }),
    })
    expect(verdictOf(asked)).toEqual(['ask', 'tenant-policy'])
    expect(asked.confirm?.reason).toBe('policy')
  })
})

describe('F9 and the auto mode', () => {
  it('02 不变量 18: asks or denies on an inspector even under a session grant or always-allow', () => {
    for (const over of [
      { sessionGrant: SESSION_GRANT },
      { userSetting: 'always-allow' as const },
    ]) {
      expect(verdictOf(run(builtin('WebFetch'), over, undefined, [ask('ex')]))).toEqual([
        'ask',
        'inspector',
      ])
      expect(verdictOf(run(builtin('WebFetch'), over, undefined, [deny('strict')]))).toEqual([
        'deny',
        'inspector',
      ])
    }
  })

  it('allows a Write in the workspace in the auto mode only, and not when the policy turns it off (旧 155)', () => {
    const inWorkspace = { place: 'workspace' as const, approvalMode: 'auto' as const }
    const auto = run(builtin('Write'), inWorkspace)
    expect(verdictOf(auto)).toEqual(['allow', 'approval-mode'])
    expect(auto.summary.code).toBe('auto-mode')
    expect(
      verdictOf(
        run(builtin('Write'), {
          ...inWorkspace,
          policy: {
            status: 'current',
            version: 'v',
            snapshot: { tools: [], disableAutoMode: true },
          },
        }),
      ),
    ).toEqual(['ask', 'approval-mode'])
    expect(verdictOf(run(builtin('Write'), { place: 'outside', approvalMode: 'auto' }))).toEqual([
      'ask',
      'approval-mode',
    ])
  })
})

describe('the card’s primary reason (D5)', () => {
  const base = {
    command: false,
    policy: false,
    interaction: false,
    flagged: false,
    irreversible: false,
  }
  it('takes the first of several, with policy over interaction-required', () => {
    expect(primaryReason({ ...base, callReason: 'network', flagged: true })).toBe('flagged')
    expect(primaryReason({ ...base, callReason: 'outside-workspace', irreversible: true })).toBe(
      'outside-workspace',
    )
    expect(primaryReason({ ...base, callReason: 'default', policy: true, interaction: true })).toBe(
      'policy',
    )
    expect(primaryReason({ ...base, callReason: 'default', irreversible: true })).toBe(
      'irreversible',
    )
    expect(primaryReason({ ...base, callReason: 'default' })).toBe('default')
  })

  it('always says command for a command, whatever else holds (curl POST: command, irreversible)', () => {
    expect(
      primaryReason({
        ...base,
        command: true,
        callReason: 'command',
        irreversible: true,
        flagged: true,
      }),
    ).toBe('command')
  })

  it('puts flagged before network on a WebFetch whose check holds (F5)', () => {
    const decision = run(
      builtin('WebFetch', { url: 'https://x.test/a' }),
      {},
      {
        reason: 'network',
        facts: { host: 'x.test', toolName: 'WebFetch', url: 'https://x.test/a' },
      },
      [ask('exfiltration')],
    )
    expect(decision.confirm).toEqual({
      reason: 'flagged',
      facts: { toolName: 'WebFetch', category: 'exfiltration' },
    })
    expect(decision.summary.code).toBe('exfiltration-recheck')
  })
})

describe('the summary (§判决记录与摘要)', () => {
  it('maps every decider to a code, and never throws', () => {
    const cases: Array<[Decision, string]> = [
      [
        run(connector(), { policy: policy({ policyId: 'p', serverId: 'srv', effect: 'deny' }) }),
        'org-policy',
      ],
      [run(builtin('Read'), { place: 'protected', reversibility: READ_ONLY }), 'protected'],
      [run(connector(), { userSetting: 'never' }), 'user-disabled'],
      [run(connector(), { requiresUserInteraction: true }), 'connector-requires-confirm'],
      [
        run(builtin('Write'), { place: 'workspace', reversibility: IRREVERSIBLE }),
        'irreversible-once',
      ],
      [
        run(builtin('Read'), { place: 'workspace', reversibility: READ_ONLY }, undefined, [
          deny('d'),
        ]),
        'inspector-blocked',
      ],
      [run(builtin('Write'), { place: 'workspace' }), 'default-ask'],
      [run(builtin('Read'), { reversibility: READ_ONLY }), 'default-ask'],
      [run(builtin('Read'), { place: 'own-spill', reversibility: READ_ONLY }), 'own-output-read'],
      [
        run(builtin('Write'), { place: 'workspace', sessionGrant: SESSION_GRANT }),
        'session-allowed',
      ],
      [
        run(builtin('WebSearch'), { sessionGrant: { ...SESSION_GRANT, kind: 'session-search' } }),
        'session-allowed-search',
      ],
      [run(connector(), { userSetting: 'always-allow' }), 'user-rule'],
      [run(builtin('Read'), { place: 'workspace', reversibility: READ_ONLY }), 'workspace-read'],
      [run(connector(), { taskGrant: true }), 'task-grant'],
      [run(builtin('Agent')), 'no-approval-needed'],
    ]
    for (const [decision, code] of cases) expect(decision.summary.code).toBe(code)
    const domain = run(builtin('WebFetch', { url: 'https://Docs.Example.com/x' }), {
      sessionGrant: { ...SESSION_GRANT, kind: 'session-domain', inherited: true },
    })
    expect(domain.summary).toEqual({
      verdict: 'allow',
      code: 'session-allowed-domain',
      facts: { toolName: 'WebFetch', host: 'docs.example.com', inherited: 'parent' },
    })
    expect(
      summarize(domain.record, builtin('WebFetch', { url: 'https://docs.example.com/x' })),
    ).toEqual(domain.summary)
  })
})

describe('which calls may run in parallel (H14)', () => {
  it('only a Read, Glob or Grep allowed as a workspace read', () => {
    for (const name of ['Read', 'Glob', 'Grep']) {
      const call = builtin(name)
      expect(
        canRunInParallel(call, run(call, { place: 'workspace', reversibility: READ_ONLY })),
      ).toBe(true)
      expect(
        canRunInParallel(call, run(call, { place: 'own-spill', reversibility: READ_ONLY })),
      ).toBe(false)
      expect(
        canRunInParallel(call, run(call, { place: 'outside', reversibility: READ_ONLY })),
      ).toBe(false)
    }
    const fetch = builtin('WebFetch')
    expect(
      canRunInParallel(
        fetch,
        run(fetch, { sessionGrant: { ...SESSION_GRANT, kind: 'session-domain' } }),
      ),
    ).toBe(false)
  })
})
