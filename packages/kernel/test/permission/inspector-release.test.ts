/* oxlint-disable no-await-in-loop -- check every tool, mode and reachable failure independently */
import { expect, it } from 'vitest'
import type { DenyOpinion, InspectorRegistration } from '../../src/index.js'
import { judgeCall } from '../../src/loop/batch.js'
import { summarize } from '../../src/permission/record.js'
import { answerScope } from '../../src/permission/grants.js'
import { decide } from '../../src/permission/decide.js'
import type { InspectorOutcome } from '../../src/permission/decide.js'
import { EMPTY_POLICY } from '../../src/index.js'
import type { DecisionRecord } from '../../src/permission/record.js'
import { modeJudgeFixture } from '../support/approval-mode-judge.js'

it.each(['Bash', 'Read', 'Write', 'Edit', 'Delete', 'Glob', 'Grep'])(
  '06 验收 19: control characters deny and invisible characters ask in %s',
  async (name) => {
    for (const mode of ['manual', 'auto'] as const) {
      const h = await modeJudgeFixture(
        { name, posture: 'active', snapshotStatus: 'tree', platform: 'yes' },
        mode,
      )
      for (const kind of ['deny', 'ask'] as const) {
        const opinion: Exclude<DenyOpinion, { kind: 'none' }> = {
          kind,
          category: kind === 'deny' ? 'control-characters' : 'hidden-characters',
          findings: [],
        }
        const inspector: InspectorRegistration = {
          id: 'hygiene',
          ceiling: 'deny',
          kind: 'local-rule',
          beforeCall: async () => opinion,
        }
        const judged = await judgeCall({ ...h.ctx, inspectors: [inspector] }, h.item, {
          input: h.input,
        })
        expect(judged).toMatchObject({
          kind: 'judged',
          decision: { record: { verdict: kind, decidedBy: 'inspector' } },
        })
        if (judged.kind !== 'judged') throw new Error('unexpected stop')
        expect(
          kind === 'deny' ? judged.decision.block?.facts : judged.decision.confirm?.facts,
        ).toMatchObject({ category: opinion.category })
        expect(judged.decision.record.steps.find((step) => step.by === 'inspector')?.status).toBe(
          'ok',
        )
        /* oxlint-disable vitest/no-conditional-expect -- only asks carry a card and answer scope */
        if (kind === 'ask') {
          expect(judged.decision.confirm?.facts).not.toHaveProperty('autoAsk')
          expect(
            answerScope({
              decision: judged.decision,
              reversibility: judged.reversibility,
              source: 'builtin',
              toolName: name,
            }),
          ).toBe('once')
        }
        /* oxlint-enable vitest/no-conditional-expect */
      }
    }
  },
)

it('06 验收 25: summarize maps inspector-flagged, check-incomplete and auto-sandboxed-command', () => {
  const call = {
    tool: { name: 'Bash', originalName: 'Bash', source: 'builtin' as const, serverId: 'builtin' },
    args: {},
    reversibility: 'unknown' as const,
  }
  const cases: Array<[DecisionRecord, string]> = []
  for (const status of ['error', 'timeout'] as const)
    for (const verdict of ['ask', 'deny'] as const)
      cases.push([
        {
          verdict,
          decidedBy: 'inspector',
          steps: [
            {
              by: 'inspector',
              inspectorId: 'failed',
              said: verdict,
              status,
              basis: { category: 'inspector-failed' },
            },
          ],
        },
        'check-incomplete',
      ])
  cases.push(
    [
      {
        verdict: 'ask',
        decidedBy: 'inspector',
        steps: [
          {
            by: 'inspector',
            inspectorId: 'hygiene',
            said: 'ask',
            status: 'ok',
            basis: { category: 'hidden-characters' },
          },
        ],
      },
      'inspector-flagged',
    ],
    [
      {
        verdict: 'ask',
        decidedBy: 'inspector',
        steps: [
          {
            by: 'inspector',
            inspectorId: 'exfiltration',
            said: 'ask',
            status: 'ok',
            basis: { category: 'exfiltration' },
          },
        ],
      },
      'exfiltration-recheck',
    ],
    [
      {
        verdict: 'deny',
        decidedBy: 'inspector',
        steps: [
          {
            by: 'inspector',
            inspectorId: 'hygiene',
            said: 'deny',
            status: 'ok',
            basis: { category: 'control-characters' },
          },
        ],
      },
      'inspector-blocked',
    ],
    [
      {
        verdict: 'allow',
        decidedBy: 'approval-mode',
        steps: [
          {
            by: 'approval-mode',
            said: 'allow',
            status: 'ok',
            basis: { modeRule: 'auto-sandboxed-command' },
          },
        ],
      },
      'auto-mode',
    ],
  )
  for (const [record, code] of cases)
    expect(summarize(record, call)).toEqual({
      verdict: record.verdict,
      code,
      facts: { toolName: 'Bash' },
    })
})

it('06 验收 25: summarize maps inspector-flagged, check-incomplete and auto-sandboxed-command', () => {
  const external: InspectorOutcome[] = [
    { inspectorId: 'ex', ceiling: 'ask', status: 'ok', opinion: { kind: 'none' } },
    {
      inspectorId: 'ex',
      ceiling: 'ask',
      status: 'ok',
      opinion: { kind: 'ask', category: 'exfiltration', findings: [] },
    },
    { inspectorId: 'ex', ceiling: 'ask', status: 'error' },
    { inspectorId: 'ex', ceiling: 'ask', status: 'timeout' },
  ]
  const hygiene: InspectorOutcome[] = [
    { inspectorId: 'hygiene', ceiling: 'deny', status: 'ok', opinion: { kind: 'none' } },
    {
      inspectorId: 'hygiene',
      ceiling: 'deny',
      status: 'ok',
      opinion: { kind: 'ask', category: 'hidden-characters', findings: [] },
    },
    {
      inspectorId: 'hygiene',
      ceiling: 'deny',
      status: 'ok',
      opinion: { kind: 'deny', category: 'control-characters', findings: [] },
    },
    { inspectorId: 'hygiene', ceiling: 'deny', status: 'error' },
    { inspectorId: 'hygiene', ceiling: 'deny', status: 'timeout' },
  ]
  const expected = [
    ['auto-mode', 'inspector-flagged', 'inspector-blocked', 'check-incomplete', 'check-incomplete'],
    [
      'exfiltration-recheck',
      'exfiltration-recheck',
      'inspector-blocked',
      'check-incomplete',
      'check-incomplete',
    ],
    [
      'check-incomplete',
      'inspector-flagged',
      'inspector-blocked',
      'check-incomplete',
      'check-incomplete',
    ],
    [
      'check-incomplete',
      'inspector-flagged',
      'inspector-blocked',
      'check-incomplete',
      'check-incomplete',
    ],
  ]
  for (const [i, first] of external.entries())
    for (const [j, second] of hygiene.entries()) {
      const result = decide({
        call: {
          tool: { name: 'Bash', originalName: 'Bash', source: 'builtin', serverId: 'builtin' },
          args: { command: 'echo ok' },
          reversibility: 'unknown',
        },
        callReason: { reason: 'command', facts: { command: 'echo ok', cwd: '/work' } },
        layers: {
          policy: { status: 'current', version: 'empty', snapshot: EMPTY_POLICY },
          reversibility: { value: 'unknown', source: 'host' },
          requiresUserInteraction: false,
          sessionGrant: null,
          approvalMode: 'auto',
          snapshotStatus: 'tree',
          commandSandboxed: true,
        },
        inspectors: [first, second],
      })
      expect(result.summary.code).toBe(expected[i]![j])
    }
})
