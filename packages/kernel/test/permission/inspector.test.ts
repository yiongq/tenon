/**
 * The first half of a decision (spec 02 §Inspector 接口与合议, §判决记录与摘要; plan step 12, 旧 162):
 * every inspector runs against the kernel's time limit, and a timeout, an error or an answer beyond
 * the declared ceiling becomes an outcome `decide()` folds into the strictest opinion that ceiling
 * allows. What the loop writes for such a call — the decision fact, `blocked-repeatedly` after three —
 * is plan step 13's.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_POLICY, INSPECTOR_TIMEOUT_MS, createMemoryHost } from '../../src/index.js'
import type { PolicyState } from '../../src/index.js'
import { decide } from '../../src/permission/decide.js'
import type { InspectorOutcome, LayerInputs } from '../../src/permission/decide.js'
import { runInspectors } from '../../src/permission/inspector.js'
import type { BeforeCallInput, InspectedCall } from '../../src/permission/session-view.js'
import { MODEL_NOTES } from '../../src/prompts/index.js'
import { createFakeInspector } from '../../src/testing/index.js'

const CALL: InspectedCall = {
  tool: { name: 'WebFetch', source: 'builtin', serverId: 'builtin', originalName: 'WebFetch' },
  args: { url: 'https://example.com/x' },
  reversibility: 'unknown',
}
const INPUT: BeforeCallInput = {
  call: CALL,
  view: {
    firstUserText: '',
    recentUserTexts: [],
    nonReadOnlyCalls: [],
    untrustedSources: [],
    touchedPrivateData: false,
  },
}
const CURRENT: PolicyState = { status: 'current', version: 'v', snapshot: EMPTY_POLICY }
const EXFIL = {
  kind: 'ask' as const,
  category: 'exfiltration' as const,
  findings: [{ code: 'lethal-trifecta' }],
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

function decideWith(outcomes: readonly InspectorOutcome[], over: Partial<LayerInputs> = {}) {
  return decide({
    call: CALL,
    callReason: { reason: 'network', facts: { host: 'example.com', toolName: 'WebFetch' } },
    layers: layers(over),
    inspectors: outcomes,
  })
}

/** Lets every already-settled promise run its callbacks, without a timer. */
async function settledMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one microtask turn at a time
    await Promise.resolve()
  }
}

async function outcomesOf(
  result: ReturnType<typeof runInspectors>,
): Promise<readonly InspectorOutcome[]> {
  const settled = await result
  if (settled.stopped) throw new Error('stopped')
  return settled.outcomes
}

describe('runInspectors', () => {
  it('times out an asking inspector after the kind’s limit, and decide() asks, flagged', async () => {
    const host = createMemoryHost()
    const slow = createFakeInspector({ id: 'slow', ceiling: 'ask', answer: 'never' })
    const running = runInspectors({
      inspectors: [slow.registration],
      input: INPUT,
      setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms),
      signal: new AbortController().signal,
    })
    host.advance(INSPECTOR_TIMEOUT_MS['local-rule'] - 1)
    host.advance(1)
    const outcomes = await outcomesOf(running)
    expect(outcomes).toEqual([{ inspectorId: 'slow', ceiling: 'ask', status: 'timeout' }])
    expect(slow.lastSignal?.aborted).toBe(true)
    const decision = decideWith(outcomes)
    expect(decision.record).toMatchObject({ verdict: 'ask', decidedBy: 'inspector' })
    expect(decision.confirm).toEqual({
      reason: 'flagged',
      facts: { toolName: 'WebFetch', category: 'inspector-failed' },
    })
    expect(decision.record.steps.find((s) => s.by === 'inspector')).toMatchObject({
      inspectorId: 'slow',
      status: 'timeout',
    })
    expect(INSPECTOR_TIMEOUT_MS).toEqual({ 'local-rule': 2000, model: 30_000 })
  })

  it('reads a denying inspector that throws as a denial, with the error sentence for the model', async () => {
    const host = createMemoryHost()
    const broken = createFakeInspector({
      id: 'strict',
      ceiling: 'deny',
      answer: { throws: new Error('boom') },
    })
    const outcomes = await outcomesOf(
      runInspectors({
        inspectors: [broken.registration],
        input: INPUT,
        setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms),
        signal: new AbortController().signal,
      }),
    )
    expect(outcomes).toEqual([{ inspectorId: 'strict', ceiling: 'deny', status: 'error' }])
    const decision = decideWith(outcomes)
    expect(decision.block).toEqual({
      reason: 'inspector',
      facts: { toolName: 'WebFetch', category: 'inspector-failed' },
    })
    // The closure writer picks the note by the step's status (plan step 14).
    expect(MODEL_NOTES.inspectorFailed.error).toContain('failed with an error')
    expect(MODEL_NOTES.inspectorFailed.timeout).toContain('timed out')
  })

  it('reads an answer beyond the ceiling, or of the wrong shape, as an error (F1)', async () => {
    const host = createMemoryHost()
    const overreach = createFakeInspector({
      id: 'asker',
      ceiling: 'ask',
      answer: { kind: 'deny', category: 'exfiltration', findings: [] },
    })
    const malformed = createFakeInspector({
      id: 'odd',
      ceiling: 'deny',
      answer: { kind: 'ask', category: 'made-up', findings: [] } as never,
    })
    const outcomes = await outcomesOf(
      runInspectors({
        inspectors: [overreach.registration, malformed.registration],
        input: INPUT,
        setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms),
        signal: new AbortController().signal,
      }),
    )
    expect(outcomes.map((o) => o.status)).toEqual(['error', 'error'])
  })

  it('takes the category of the first ok opinion; inspector-failed only when every one failed', async () => {
    const host = createMemoryHost()
    const slow = createFakeInspector({ id: 'slow', ceiling: 'ask', answer: 'never' })
    const exfil = createFakeInspector({ id: 'exfil', ceiling: 'ask', answer: EXFIL })
    const running = runInspectors({
      inspectors: [slow.registration, exfil.registration],
      input: INPUT,
      setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms),
      signal: new AbortController().signal,
    })
    // Let the quick one answer before the limit passes: only the slow one times out.
    await settledMicrotasks()
    host.advance(INSPECTOR_TIMEOUT_MS['local-rule'])
    const mixed = await outcomesOf(running)
    expect(decideWith(mixed).confirm?.facts['category']).toBe('exfiltration')
    const both = [
      { inspectorId: 'a', ceiling: 'ask' as const, status: 'timeout' as const },
      { inspectorId: 'b', ceiling: 'ask' as const, status: 'timeout' as const },
    ]
    expect(decideWith(both).confirm?.facts['category']).toBe('inspector-failed')
  })

  it('aborts the inspectors on a stop and reports it, with no outcome to decide on (B1)', async () => {
    const host = createMemoryHost()
    const slow = createFakeInspector({ id: 'slow', ceiling: 'ask', answer: 'never' })
    const stop = new AbortController()
    const running = runInspectors({
      inspectors: [slow.registration],
      input: INPUT,
      setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms),
      signal: stop.signal,
    })
    await Promise.resolve()
    stop.abort('user-stop')
    expect(await running).toEqual({ stopped: true })
    expect(slow.lastSignal?.aborted).toBe(true)
    // Already stopped before it starts: nothing runs.
    const late = createFakeInspector({ id: 'late', ceiling: 'ask' })
    expect(
      await runInspectors({
        inspectors: [late.registration],
        input: INPUT,
        setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms),
        signal: stop.signal,
      }),
    ).toEqual({ stopped: true })
    expect(late.calls).toEqual([])
  })
})

describe('an inspector result never widens a verdict (F1)', () => {
  const rank = { allow: 0, ask: 1, deny: 2 } as const
  const extras: readonly InspectorOutcome[] = [
    { inspectorId: 'x', ceiling: 'ask', status: 'ok', opinion: { kind: 'none' } },
    { inspectorId: 'x', ceiling: 'ask', status: 'ok', opinion: EXFIL },
    {
      inspectorId: 'x',
      ceiling: 'deny',
      status: 'ok',
      opinion: { kind: 'deny', category: 'exfiltration', findings: [] },
    },
    { inspectorId: 'x', ceiling: 'ask', status: 'timeout' },
    { inspectorId: 'x', ceiling: 'deny', status: 'error' },
  ]
  const inputs: readonly Partial<LayerInputs>[] = [
    {},
    { place: 'workspace', reversibility: { value: 'read-only', source: 'host' } },
    { place: 'own-spill', reversibility: { value: 'read-only', source: 'host' } },
    { sessionGrant: { kind: 'session-domain', grantFrom: { sessionId: 's', approvalKey: 'k' } } },
    { userSetting: 'always-allow' },
    { reversibility: { value: 'irreversible', source: 'host' } },
    { approvalMode: 'auto', place: 'workspace' },
    { policy: { status: 'unavailable' } },
  ]

  it('holds for every input here, with any one outcome added to any other', () => {
    for (const over of inputs) {
      for (const before of [[], ...extras.map((e) => [e])]) {
        const base = decideWith(before, over).record.verdict
        for (const extra of extras) {
          const after = decideWith([...before, { ...extra, inspectorId: 'y' }], over).record.verdict
          expect(rank[after]).toBeGreaterThanOrEqual(rank[base])
        }
      }
    }
  })
})
