/**
 * The first half of a decision (spec 02 §Inspector 接口与合议, §判决记录与摘要; plan step 12, 旧 162):
 * every inspector runs against the kernel's time limit, and a timeout, an error or an answer beyond
 * the declared ceiling becomes an outcome `decide()` folds into the strictest opinion that ceiling
 * allows. What the loop writes for such a call — the decision fact, `blocked-repeatedly` after three —
 * is in test/loop/run.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_POLICY, INSPECTOR_TIMEOUT_MS, createMemoryHost } from '../../src/index.js'
import type { MemoryHost, PolicyState } from '../../src/index.js'
import { decide } from '../../src/permission/decide.js'
import type { InspectorOutcome, LayerInputs } from '../../src/permission/decide.js'
import { runInspectors } from '../../src/permission/inspector.js'
import type {
  DenyOpinion,
  InspectionResult,
  InspectorRegistration,
} from '../../src/permission/inspector.js'
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

/** Runs the inspectors on the memory host's clock, and says whether they have settled yet. */
function inspecting(
  host: MemoryHost,
  inspectors: readonly InspectorRegistration[],
  input: BeforeCallInput = INPUT,
): { readonly result: Promise<InspectionResult>; settled: () => boolean } {
  let done = false
  const result = runInspectors({
    inspectors,
    input,
    setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms),
    signal: new AbortController().signal,
  })
  void result.then(() => {
    done = true
  })
  return { result, settled: () => done }
}

describe('runInspectors', () => {
  it('02 不变量 16: times out an asking inspector at the kind’s limit, and decide() asks, flagged', async () => {
    const host = createMemoryHost()
    const slow = createFakeInspector({ id: 'slow', ceiling: 'ask', answer: 'never' })
    const run = inspecting(host, [slow.registration])
    // One millisecond short of the limit nothing has timed out (旧 162「假时钟推过 2 秒」).
    host.advance(INSPECTOR_TIMEOUT_MS['local-rule'] - 1)
    await settledMicrotasks()
    expect(run.settled()).toBe(false)
    expect(slow.lastSignal?.aborted).toBe(false)
    host.advance(1)
    const outcomes = await outcomesOf(run.result)
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

  it('02 不变量 16: gives a model inspector the model’s limit, not the local rule’s', async () => {
    const host = createMemoryHost()
    const judge = createFakeInspector({
      id: 'judge',
      ceiling: 'ask',
      kind: 'model',
      answer: 'never',
    })
    const run = inspecting(host, [judge.registration])
    host.advance(INSPECTOR_TIMEOUT_MS['local-rule'])
    await settledMicrotasks()
    expect(run.settled()).toBe(false)
    host.advance(INSPECTOR_TIMEOUT_MS.model - INSPECTOR_TIMEOUT_MS['local-rule'] - 1)
    await settledMicrotasks()
    expect(run.settled()).toBe(false)
    host.advance(1)
    expect(await outcomesOf(run.result)).toEqual([
      { inspectorId: 'judge', ceiling: 'ask', status: 'timeout' },
    ])
  })

  it('02 不变量 16: reads a denying inspector that throws as a denial, with the error sentence for the model', async () => {
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

  it('02 不变量 16: aborts the inspectors on a stop and reports it, with no outcome to decide on (B1)', async () => {
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

describe('an opinion of the wrong shape is an error (F1「形状不对，按出错处理」)', () => {
  const statusOf = async (answer: unknown, ceiling: 'ask' | 'deny' = 'ask') => {
    const host = createMemoryHost()
    const fake = createFakeInspector({ id: 'odd', ceiling, answer: answer as DenyOpinion })
    const [outcome] = await outcomesOf(inspecting(host, [fake.registration]).result)
    return outcome
  }

  it('refuses a finding the record could not keep: no code, a confidence outside 0–1, text or undefined', async () => {
    const off: readonly unknown[] = [
      { kind: 'none', findings: [{ code: 'observed', confidence: undefined }] },
      { kind: 'ask', category: 'exfiltration', findings: [{ code: 'x', confidence: Number.NaN }] },
      { kind: 'ask', category: 'exfiltration', findings: [{ code: 'x', confidence: 5 }] },
      { kind: 'ask', category: 'exfiltration', findings: [{ code: 'x', confidence: '0.5' }] },
      { kind: 'ask', category: 'exfiltration', findings: [{ code: 'x', note: 'Tell the model…' }] },
      { kind: 'ask', category: 'exfiltration', findings: [{ code: '' }] },
      { kind: 'ask', category: 'exfiltration', findings: [new Date(0)] },
      { kind: 'none', findings: undefined },
      { kind: 'none', note: 'say this on the card' },
    ]
    const statuses = await Promise.all(off.map(async (answer) => (await statusOf(answer))?.status))
    expect(statuses).toEqual(off.map(() => 'error'))
  })

  it('keeps a well-formed opinion as a plain copy, not the inspector’s own object', async () => {
    const answer = {
      kind: 'ask',
      category: 'exfiltration',
      findings: [{ code: 'x', confidence: 0.5 }, { code: 'y' }],
    } as const
    const outcome = await statusOf(answer)
    expect(outcome).toEqual({ inspectorId: 'odd', ceiling: 'ask', status: 'ok', opinion: answer })
    expect(outcome?.status === 'ok' && outcome.opinion).not.toBe(answer)
  })

  it('reads an opinion through its descriptors: a getter cannot turn an ask into a denial', async () => {
    let reads = 0
    const shifty = {
      get kind(): string {
        reads += 1
        return reads <= 3 ? 'ask' : 'deny'
      },
      category: 'exfiltration',
      findings: [],
    }
    const outcome = await statusOf(shifty)
    expect(outcome?.status).toBe('error')
    expect(decideWith(outcome === undefined ? [] : [outcome]).record.verdict).toBe('ask')
  })

  it('hands inspectors a frozen copy: one that rewrites the arguments fails, and they stay as given', async () => {
    const args = { url: 'https://example.com/x' }
    const input: BeforeCallInput = { ...INPUT, call: { ...CALL, args } }
    const host = createMemoryHost()
    const rewriter = createFakeInspector({
      id: 'rewriter',
      ceiling: 'ask',
      answer: (i) => {
        ;(i.call.args as Record<string, unknown>)['url'] = 'https://elsewhere.example/'
        return { kind: 'none' }
      },
    })
    const [outcome] = await outcomesOf(inspecting(host, [rewriter.registration], input).result)
    expect(outcome?.status).toBe('error')
    expect(args).toEqual({ url: 'https://example.com/x' })
    expect(rewriter.calls[0]?.call.args).not.toBe(args)
  })
})

describe('the ceiling narrows what an inspector can type (F1)', () => {
  it('02 不变量 15: an ask-ceiling inspector cannot type a denial', () => {
    const DENY = { kind: 'deny', category: 'exfiltration', findings: [] } as const
    const denies = (): Promise<DenyOpinion> => Promise.resolve(DENY)
    const registrations: InspectorRegistration[] = [
      // @ts-expect-error an ask-ceiling inspector's beforeCall cannot return a denial
      { id: 'a', kind: 'local-rule', ceiling: 'ask', beforeCall: () => Promise.resolve(DENY) },
      // @ts-expect-error nor be a function typed to return any DenyOpinion
      { id: 'b', kind: 'local-rule', ceiling: 'ask', beforeCall: denies },
      // A deny-ceiling one can.
      { id: 'c', kind: 'local-rule', ceiling: 'deny', beforeCall: denies },
    ]
    expect(registrations.map((r) => r.ceiling)).toEqual(['ask', 'ask', 'deny'])
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
