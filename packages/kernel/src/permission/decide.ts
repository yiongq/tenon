/**
 * The decision table (spec 02 §权限决策顺序, §判决记录与摘要; D2, D3, D5, D10, D12, F8, F9).
 *
 * `decide()` is pure: no clock, no IO. The kernel computes every layer's state before calling it —
 * the one `policy.current()` reading, where the path falls, the layer-3 setting, the reversibility,
 * the session grant, the approval mode — and runs the inspectors first, folding a timeout or an error
 * into an outcome with a `status`. What comes out is the verdict, the ordered steps with the layer that
 * decided, the summary the interface reads, and the card's reason and slots (or the block's).
 *
 * The layers are evaluated together, not first-match (D2), and merged in two steps:
 *
 *   1. Layer 4 ① (irreversible) alone: a policy that releases this tool, the user's always-allow for
 *      a connector tool, or a task grant (phase 6) takes that "must ask" away. Nothing takes away
 *      layer 4 ② (the server says the user must interact) or layer 5.
 *   2. The first tier that holds: deny > must ask > allow > the manual mode's ask > the default ask.
 *
 * Layers 1 and 3 are read by `policyDeniesTool` / `userDisablesTool` too, which the tool table's
 * exclusions share (§开表与排除): a tool excluded when the table opened and one blocked after it froze
 * are one reading.
 */
import type { ConfirmReason, Reversibility } from '../host/adapter.js'
import { CONFIRM_FACT_KEYS } from '../host/adapter.js'
import type { PolicyState, ToolPolicyRule } from '../host/policy.js'
import type { BlockReason } from '../loop/closure.js'
import { BLOCKED_FACT_KEYS } from '../loop/closure.js'
import type { DenyOpinion, FlaggedCategory } from './inspector.js'
import type { DecisionRecord, DecisionSource, DecisionStep, DecisionSummary } from './record.js'
import { summarize } from './record.js'
import type { InspectedCall } from './session-view.js'
import type { PathPlace } from './workspace.js'

export interface Decision {
  readonly record: DecisionRecord
  readonly summary: DecisionSummary // summarize(record, call)，写入时存进载荷
  readonly confirm?: {
    readonly reason: ConfirmReason
    readonly facts: Readonly<Record<string, string>>
  } // verdict 为 'ask' 时有
  readonly block?: {
    readonly reason: BlockReason
    readonly facts: Readonly<Record<string, string>>
  } // verdict 为 'deny' 时有
}

/** A connector tool's setting in the user's connector menu: 'never' is layer 3, 'always-allow' layer 6. */
export type ConnectorToolSetting = 'always-allow' | 'ask' | 'never'

/** What layer 3 reads for one tool. Phase 2 has no producer: only tests inject it. */
export interface UserToolSetting {
  readonly definitionChanged?: true
  readonly connectorOff?: true
  readonly userSetting?: ConnectorToolSetting
}

/** Every layer's state for one call, computed by the kernel before `decide()`; fields only grow. */
export interface LayerInputs {
  // 第 1 层：本次判决唯一一次 policy.current() 的结果（D4）。命中哪些规则，由 decide 按 call.tool 的 (serverId, originalName) 自己匹配
  readonly policy: PolicyState
  // 第 2 层
  readonly place?: PathPlace // 只在文件工具有，locatePath 的结果（D8）；对话形态里 own-spill 以外的改记 'protected'（开放问题 13）
  readonly urlBlocked?: true // 只在 WebFetch 有：URL 字面命中第 2 层的地址规则（H8）
  // 第 3 层：只对 MCP 工具有意义。02 没有产生方，只由测试注入；来源随阶段 3 的连接器入口定
  readonly connectorOff?: true
  readonly userSetting?: ConnectorToolSetting // 'never' 归第 3 层，'always-allow' 归第 6 层，'ask' 不表态
  // 第 4 层
  readonly reversibility: { readonly value: Reversibility; readonly source: 'host' | 'policy' } // 02 的产品恒为 host；'policy' 6b 才有产生方
  readonly requiresUserInteraction: boolean // 取 ToolTableItem.requiresUserInteraction（D12）
  // 第 6 层
  readonly sessionGrant: null | {
    // 由 grants.ts 按 grantKey 从 Tape 推出，含父会话继承（H5 ①）
    readonly kind: 'session' | 'session-search' | 'session-domain'
    readonly inherited?: true
    readonly grantFrom: { readonly sessionId: string; readonly approvalKey: string } // 生效的那条 tool/approval_resolved（F8）
  }
  readonly taskGrant?: true // 阶段 6 才有产生方；02 只由测试注入
  // 第 7 层
  readonly approvalMode: 'manual' | 'auto' // 02 的产品恒为 'manual'；'auto' 只由测试注入（D7）
}

/** A layer-5 opinion as the kernel folded it: a timeout or an error keeps its status (F1). */
export type InspectorOutcome = {
  readonly inspectorId: string
  readonly ceiling: 'ask' | 'deny'
} & (
  | { readonly status: 'ok'; readonly opinion: DenyOpinion }
  | { readonly status: 'timeout' | 'error' }
)

/** The default table's reason column (§内置工具的默认档位), computed before `decide()`. */
export interface CallReason {
  readonly reason: 'outside-workspace' | 'network' | 'command' | 'default' // 表里是「—」的行给 'default'，只作第 8 层兜底
  readonly facts: Readonly<Record<string, string>> // 该原因的必填键，另加 toolName；被拦时的 target 也从这里取
}

export interface DecisionInput {
  readonly call: InspectedCall
  readonly callReason: CallReason
  readonly layers: LayerInputs // 第 1–4、6–7 层的状态
  readonly inspectors: readonly InspectorOutcome[] // 按注册顺序
}

/**
 * Layer 1, whole-tool form (§第 1 层真值表与 TenantPolicy): the policy denies this tool when it is
 * unavailable, or when a `deny` rule names its server — and its tool, or no tool at all. Rules match
 * the ORIGINAL name, never the one mapped for the provider (H4).
 */
export function policyDeniesTool(
  policy: PolicyState,
  tool: { readonly serverId: string; readonly originalName: string },
): boolean {
  if (policy.status === 'unavailable') return true
  return rulesFor(policy, tool).some((rule) => rule.effect === 'deny')
}

/** Layer 3: the user turned the connector off, or set this tool to never. */
export function userDisablesTool(setting: UserToolSetting | null): boolean {
  return setting !== null && (setting.connectorOff === true || setting.userSetting === 'never')
}

/** The tools whose calls are file operations: the ones layer 2's protected list and the auto mode read. */
const FILE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep'])
/** Launching these is never gated by the approval mode (E4, H6); what an Agent does is judged per call. */
const NOT_GATED: ReadonlySet<string> = new Set(['AskUserQuestion', 'Agent'])

/**
 * The card reasons in D5's order (§`ConfirmReason` 只增四个值): `policy` and `interaction-required`
 * first — `policy` wins a tie (暂定) — and `irreversible`, `default` only when nothing else holds.
 */
const REASON_ORDER: readonly ConfirmReason[] = [
  'policy',
  'interaction-required',
  'flagged',
  'outside-workspace',
  'network',
  'elevated',
  'command',
  'irreversible',
  'default',
]

type Said = DecisionStep['said']

export function decide(input: DecisionInput): Decision {
  const { call, callReason, layers, inspectors } = input
  const builtin = call.tool.source === 'builtin'
  const name = call.tool.originalName
  const steps: DecisionStep[] = []

  // ----- layer 1: the tenant policy ---------------------------------------------------------------
  const rules = layers.policy.status === 'unavailable' ? [] : rulesFor(layers.policy, call.tool)
  const policyUnavailable = layers.policy.status === 'unavailable'
  if (policyUnavailable) steps.push({ by: 'tenant-policy', said: 'deny', status: 'ok' })
  else if (rules.length === 0) steps.push({ by: 'tenant-policy', said: 'none', status: 'ok' })
  else {
    for (const rule of rules) {
      const said: Said = rule.effect === 'deny' ? 'deny' : rule.effect === 'ask' ? 'ask' : 'none'
      steps.push({ by: 'tenant-policy', said, basis: { policyId: rule.policyId }, status: 'ok' })
    }
  }
  const policyDeny = policyUnavailable || rules.some((rule) => rule.effect === 'deny')
  const policyAsk = rules.some((rule) => rule.effect === 'ask')
  const policyRelease = rules.find((rule) => rule.effect === 'release-irreversible')

  // ----- layer 2: the protected list, and the one narrow way in ------------------------------------
  const readOnly = layers.reversibility.value === 'read-only'
  let protectedSaid: Said = 'none'
  if (layers.place === 'protected' || layers.urlBlocked === true) protectedSaid = 'deny'
  else if (layers.place === 'own-spill') protectedSaid = readOnly ? 'allow' : 'deny'
  steps.push({ by: 'protected', said: protectedSaid, status: 'ok' })

  // ----- layer 3: what the user switched off ------------------------------------------------------
  const disabled = userDisablesTool({
    ...(layers.connectorOff === undefined ? {} : { connectorOff: layers.connectorOff }),
    ...(layers.userSetting === undefined ? {} : { userSetting: layers.userSetting }),
  })
  steps.push({ by: 'user-disabled', said: disabled ? 'deny' : 'none', status: 'ok' })

  // ----- layer 4: must ask — ① irreversible (step 1 may release it), ② the server says so ----------
  const alwaysAllow = layers.userSetting === 'always-allow'
  const releasedBy: DecisionStep['basis'] =
    policyRelease !== undefined
      ? { releasedBy: 'tenant-policy', policyId: policyRelease.policyId }
      : alwaysAllow
        ? { releasedBy: 'always-allow' }
        : layers.taskGrant === true
          ? { releasedBy: 'task' }
          : undefined
  const irreversible = layers.reversibility.value === 'irreversible'
  const mustAskIrreversible = irreversible && releasedBy === undefined
  steps.push({
    by: 'irreversible',
    said: mustAskIrreversible ? 'ask' : 'none',
    ...(irreversible && releasedBy !== undefined ? { basis: releasedBy } : {}),
    status: 'ok',
  })
  steps.push({
    by: 'connector-confirm',
    said: layers.requiresUserInteraction ? 'ask' : 'none',
    status: 'ok',
  })

  // ----- layer 5: the inspectors, in registration order ------------------------------------------
  const inspectorSteps = inspectors.map(inspectorStep)
  steps.push(...inspectorSteps)
  const inspectorDeny = inspectorSteps.some((step) => step.said === 'deny')
  const inspectorAsk = inspectorSteps.some((step) => step.said === 'ask')

  // ----- layer 6: what the user granted -----------------------------------------------------------
  const grant: DecisionStep['basis'] | undefined =
    layers.sessionGrant !== null
      ? {
          grant: layers.sessionGrant.kind,
          grantFrom: layers.sessionGrant.grantFrom,
          ...(layers.sessionGrant.inherited === true ? { inherited: true as const } : {}),
        }
      : alwaysAllow
        ? {
            grant: 'always-allow',
            ...(irreversible ? { releasedBy: 'always-allow' as const } : {}),
          }
        : layers.taskGrant === true
          ? { grant: 'task' }
          : builtin && FILE_TOOLS.has(name) && layers.place === 'workspace' && readOnly
            ? { grant: 'workspace-folder' }
            : undefined
  steps.push({
    by: 'user-grant',
    said: grant === undefined ? 'none' : 'allow',
    ...(grant === undefined ? {} : { basis: grant }),
    status: 'ok',
  })

  // ----- layer 7: the approval mode --------------------------------------------------------------
  const autoMode =
    layers.approvalMode === 'auto' &&
    !(layers.policy.status !== 'unavailable' && layers.policy.snapshot.disableAutoMode === true)
  let modeSaid: Said = 'none'
  let modeRule: 'auto-range' | 'not-gated' | undefined
  if (builtin && NOT_GATED.has(name)) {
    modeSaid = 'allow'
    modeRule = 'not-gated'
  } else if (autoMode && builtin && FILE_TOOLS.has(name) && layers.place === 'workspace') {
    modeSaid = 'allow'
    modeRule = 'auto-range'
  } else if (!readOnly) {
    // 「会改动」 (owner-confirmed): anything not read-only is asked in the manual mode — and outside
    // the auto mode's range.
    modeSaid = 'ask'
  }
  steps.push({
    by: 'approval-mode',
    said: modeSaid,
    ...(modeRule === undefined ? {} : { basis: { modeRule } }),
    status: 'ok',
  })

  // ----- layer 8, and step 2 of the merge ---------------------------------------------------------
  let verdict: DecisionRecord['verdict']
  let decidedBy: DecisionSource
  if (policyDeny || protectedSaid === 'deny' || disabled || inspectorDeny) {
    verdict = 'deny'
    decidedBy = policyDeny
      ? 'tenant-policy'
      : protectedSaid === 'deny'
        ? 'protected'
        : disabled
          ? 'user-disabled'
          : 'inspector'
  } else if (policyAsk || mustAskIrreversible || layers.requiresUserInteraction || inspectorAsk) {
    verdict = 'ask'
    decidedBy = policyAsk
      ? 'tenant-policy'
      : layers.requiresUserInteraction
        ? 'connector-confirm'
        : inspectorAsk
          ? 'inspector'
          : 'irreversible'
  } else if (protectedSaid === 'allow' || grant !== undefined || modeSaid === 'allow') {
    verdict = 'allow'
    decidedBy =
      protectedSaid === 'allow' ? 'protected' : grant !== undefined ? 'user-grant' : 'approval-mode'
  } else if (modeSaid === 'ask') {
    verdict = 'ask'
    decidedBy = 'approval-mode'
  } else {
    verdict = 'ask'
    decidedBy = 'default'
  }
  steps.push({ by: 'default', said: decidedBy === 'default' ? 'ask' : 'none', status: 'ok' })

  const record: DecisionRecord = { verdict, decidedBy, steps }
  const summary = summarize(record, call)
  const toolName = name
  if (verdict === 'deny') {
    const reason = blockReasonOf(decidedBy)
    const pool: Record<string, string> = {
      toolName,
      target:
        callReason.facts['target'] ?? callReason.facts['path'] ?? callReason.facts['host'] ?? '',
      category: layerFiveCategory(inspectorSteps, 'deny'),
    }
    return { record, summary, block: { reason, facts: pick(pool, BLOCKED_FACT_KEYS[reason]) } }
  }
  if (verdict === 'ask') {
    const reason = primaryReason({
      command: builtin && name === 'Bash',
      policy: policyAsk,
      interaction: layers.requiresUserInteraction,
      flagged: inspectorAsk,
      callReason: callReason.reason,
      irreversible: mustAskIrreversible,
    })
    const pool: Record<string, string> = {
      ...callReason.facts,
      toolName,
      category: layerFiveCategory(inspectorSteps, 'ask'),
    }
    return { record, summary, confirm: { reason, facts: pick(pool, CONFIRM_FACT_KEYS[reason]) } }
  }
  return { record, summary }
}

/**
 * The card's reason (D5, E1, E4): every reason that holds is collected — layer 1's ask, layer 4 ②,
 * layer 5's ask, the call's own reason, an unreleased irreversible — and the first in D5's order wins.
 * The exception: a command's reason is always `command`; its pattern table changes the reversibility,
 * never the reason (`curl -X POST`: reason `command`, reversibility `irreversible`).
 */
export function primaryReason(q: {
  readonly command: boolean
  readonly policy: boolean
  readonly interaction: boolean
  readonly flagged: boolean
  readonly callReason: CallReason['reason']
  readonly irreversible: boolean
}): ConfirmReason {
  if (q.command) return 'command'
  const holding = new Set<ConfirmReason>([q.callReason])
  if (q.policy) holding.add('policy')
  if (q.interaction) holding.add('interaction-required')
  if (q.flagged) holding.add('flagged')
  if (q.irreversible) holding.add('irreversible')
  return REASON_ORDER.find((reason) => holding.has(reason)) ?? 'default'
}

/** The only tools the parallel group takes (H14; §一批工具怎么执行): the builtin workspace reads. */
export const PARALLEL_TOOL_NAMES: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep'])

/**
 * Whether a call may run in the parallel group (H14; §一批工具怎么执行): only a Read, Glob or Grep
 * inside the workspace, allowed as such. A read of the spill directory, a read outside the workspace,
 * WebSearch and WebFetch never do — not even once the user allowed them.
 */
export function canRunInParallel(call: InspectedCall, decision: Decision): boolean {
  if (call.tool.source !== 'builtin' || !PARALLEL_TOOL_NAMES.has(call.tool.originalName)) {
    return false
  }
  if (decision.record.verdict !== 'allow' || decision.record.decidedBy !== 'user-grant')
    return false
  return decision.record.steps.some(
    (step) => step.by === 'user-grant' && step.basis?.grant === 'workspace-folder',
  )
}

/** A layer-5 outcome as a step; a timeout or an error folds into the strictest its ceiling allows (F1). */
function inspectorStep(outcome: InspectorOutcome): DecisionStep {
  if (outcome.status !== 'ok') {
    return {
      by: 'inspector',
      inspectorId: outcome.inspectorId,
      said: outcome.ceiling === 'deny' ? 'deny' : 'ask',
      basis: { category: 'inspector-failed' },
      status: outcome.status,
    }
  }
  const { opinion } = outcome
  if (opinion.kind === 'none') {
    return opinion.findings === undefined
      ? { by: 'inspector', inspectorId: outcome.inspectorId, said: 'none', status: 'ok' }
      : {
          by: 'inspector',
          inspectorId: outcome.inspectorId,
          said: 'none',
          basis: { findings: opinion.findings },
          status: 'ok',
        }
  }
  return {
    by: 'inspector',
    inspectorId: outcome.inspectorId,
    said: opinion.kind,
    basis: { category: opinion.category, findings: opinion.findings },
    status: 'ok',
  }
}

/** The policy's rules naming this tool — by its server, and its original name or no name. */
function rulesFor(
  policy: Extract<PolicyState, { status: 'current' | 'cached' }>,
  tool: { readonly serverId: string; readonly originalName: string },
): ToolPolicyRule[] {
  return policy.snapshot.tools.filter(
    (rule) =>
      rule.serverId === tool.serverId &&
      (rule.toolName === undefined || rule.toolName === tool.originalName),
  )
}

function blockReasonOf(decidedBy: DecisionSource): BlockReason {
  switch (decidedBy) {
    case 'tenant-policy':
      return 'policy'
    case 'protected':
      return 'protected'
    case 'user-disabled':
      return 'user-disabled'
    default:
      return 'inspector'
  }
}

/**
 * The category a layer-5 verdict reports (§Inspector 接口与合议): the first `ok` opinion, in
 * registration order, among those that said this; `inspector-failed` when every one of them failed.
 */
function layerFiveCategory(steps: readonly DecisionStep[], said: 'ask' | 'deny'): FlaggedCategory {
  const saying = steps.filter((step) => step.said === said)
  const ok = saying.find((step) => step.status === 'ok' && step.basis?.category !== undefined)
  return ok?.basis?.category ?? 'inspector-failed'
}

function pick(
  pool: Readonly<Record<string, string>>,
  keys: readonly string[],
): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, pool[key] ?? '']))
}
