import { CUSTOM_ID_REGEX } from '@tenon-app/contracts'
import type {
  CustomVendorContract,
  CustomVendorErrorCode,
  ProviderEntryContract,
  RouteResponse,
  customVendorFetchModels,
  customVendorProbe,
} from '@tenon-app/contracts'

/**
 * The interface's custom vendor decisions (M6 §运行时「行标记」, §实例被删或改坏, §预设, §探测), pure
 * so a node test reaches them without the settings card or the model menu.
 */

type Mark = ProviderEntryContract['models'][number]['mark']
type CustomRow = CustomVendorContract['models'][number]
export type ProbeSnapshot = NonNullable<CustomRow['probe']>
export type ProbeReason = NonNullable<ProbeSnapshot['reason']>
type ProbeAnswer = RouteResponse<typeof customVendorProbe>
export type ProbeRefusedCode = Extract<ProbeAnswer, { status: 'refused' }>['code']
type ModelsAnswer = RouteResponse<typeof customVendorFetchModels>
export type FetchModelsCode = Extract<ModelsAnswer, { ok: false }>['code']
export type FetchedModel = Extract<ModelsAnswer, { ok: true }>['models'][number]

/** T1: an instance id, `custom-<uuid>` — also for one `provider.list` no longer lists. */
export function isInstanceId(id: string): boolean {
  return CUSTOM_ID_REGEX.test(id)
}

/**
 * A row a task can send with (§运行时「行标记」; Q6): a builtin `verified` row or an instance row
 * that passed its probe. Every other row holds text conversations only and is greyed in a task —
 * 「`verified` 与 `probed` 以外置灰」, which replaces 02's 「非 `verified` 置灰」.
 */
export function holdsTools(mark: Mark): boolean {
  return mark === 'verified' || mark === 'probed'
}

/**
 * A menu row's second line by its mark (§对 02 的修补 1; 推出的读法 26): an instance's row without a
 * passing probe keeps `unverified-text-only` with its own line, told apart by the entry carrying a
 * `displayName` (only an instance's does).
 */
export function markLineKey(
  mark: Mark,
  instance: boolean,
):
  | 'model.row.line'
  | 'model.mark.probed'
  | 'model.mark.localTextOnly'
  | 'model.mark.unverified'
  | 'model.mark.unprobed' {
  switch (mark) {
    case 'verified':
      return 'model.row.line'
    case 'probed':
      return 'model.mark.probed'
    case 'local-text-only':
      return 'model.mark.localTextOnly'
    case 'unverified-text-only':
      return instance ? 'model.mark.unprobed' : 'model.mark.unverified'
  }
}

/**
 * §实例被删或改坏「文案单列」: the session's provider is an instance and `provider.list` no longer has
 * it, or no longer has the row the session chose on it. Only whether they are listed counts, not
 * `configured`: an instance whose key was cleared, or whose address is refused, is still listed and
 * keeps 02's copy. `choice` is the session's own (`session.modelChoice`); null when unread.
 */
export function customVendorGone(
  providerId: string,
  choice: { readonly providerId: string; readonly modelId: string } | null,
  entries: readonly Pick<ProviderEntryContract, 'id' | 'models'>[],
): boolean {
  if (!isInstanceId(providerId)) return false
  const entry = entries.find((candidate) => candidate.id === providerId)
  if (entry === undefined) return true
  if (choice === null || choice.providerId !== providerId) return false
  return !entry.models.some((row) => row.id === choice.modelId)
}

/** §地址校验 (Q13): which pay-as-you-go reminder the key field carries. */
export type KeyReminder = 'zhipu' | 'minimax'

/**
 * Hosts whose address is shared by pay-as-you-go and a subscription (§地址校验, Q13): Zhipu's two,
 * whose GLM Coding Plan key Tenon must not use, and MiniMax's three, whose M Plan key is a separate
 * one. Exact hosts, as the spec lists them.
 */
const REMINDER_HOSTS: Readonly<Record<KeyReminder, readonly string[]>> = {
  zhipu: ['open.bigmodel.cn', 'api.z.ai'],
  minimax: ['api.minimax.cn', 'api.minimax.io', 'api.minimaxi.com'],
}

export const KEY_REMINDER_KEY = {
  zhipu: 'customVendor.key.reminder.zhipu',
  minimax: 'customVendor.key.reminder.minimax',
} as const satisfies Record<KeyReminder, string>

/** The reminder an address's host calls for (验收 7), or null; an address that does not parse has none. */
export function keyReminderOf(address: string): KeyReminder | null {
  let host: string
  try {
    host = new URL(address.trim()).hostname.replace(/\.$/, '')
  } catch {
    return null
  }
  for (const reminder of ['zhipu', 'minimax'] as const) {
    if (REMINDER_HOSTS[reminder].includes(host)) return reminder
  }
  return null
}

/** §结果与原因码: one sentence per code, `customVendor.probe.reason.<code>`. */
export const PROBE_REASON_KEY = {
  'no-tool-call': 'customVendor.probe.reason.no-tool-call',
  'output-limit': 'customVendor.probe.reason.output-limit',
  'no-finish': 'customVendor.probe.reason.no-finish',
  config: 'customVendor.probe.reason.config',
  auth: 'customVendor.probe.reason.auth',
  quota: 'customVendor.probe.reason.quota',
  'rate-limit': 'customVendor.probe.reason.rate-limit',
  'request-rejected': 'customVendor.probe.reason.request-rejected',
  'echo-rejected': 'customVendor.probe.reason.echo-rejected',
  'bad-tool-call': 'customVendor.probe.reason.bad-tool-call',
  'opaque-fields': 'customVendor.probe.reason.opaque-fields',
  service: 'customVendor.probe.reason.service',
} as const satisfies Record<ProbeReason, string>

/** `customVendor.probe` answering without a result (§IPC). */
export const PROBE_REFUSED_KEY = {
  'not-found': 'customVendor.probe.refused.not-found',
  'unknown-model': 'customVendor.probe.refused.unknown-model',
  'local-endpoint': 'customVendor.probe.refused.local-endpoint',
  busy: 'customVendor.probe.refused.busy',
  aborted: 'customVendor.probe.refused.aborted',
} as const satisfies Record<ProbeRefusedCode, string>

/** `customVendor.fetchModels` failing (§列表与上限): `unsupported` asks for the id by hand. */
export const FETCH_MODELS_KEY = {
  'not-found': 'customVendor.models.fetchError.not-found',
  config: 'customVendor.models.fetchError.config',
  auth: 'customVendor.models.fetchError.auth',
  unsupported: 'customVendor.models.fetchError.unsupported',
  service: 'customVendor.models.fetchError.service',
} as const satisfies Record<FetchModelsCode, string>

/** `customVendor.create` / `.update` / `.delete` refusing (§IPC `customVendorErrorCodeSchema`). */
export const VENDOR_ERROR_KEY = {
  'invalid-address': 'customVendor.error.invalid-address',
  'https-required': 'customVendor.error.https-required',
  'subscription-endpoint': 'customVendor.error.subscription-endpoint',
  'key-required': 'customVendor.error.key-required',
  'not-found': 'customVendor.error.not-found',
  keychain: 'customVendor.error.keychain',
} as const satisfies Record<CustomVendorErrorCode, string>

/**
 * A row's stored probe as one line (§结果与原因码): passed, the reason's sentence — `opaque-fields`
 * naming the fields — or never probed. A snapshot that did not pass carries a reason; one without
 * reads as never probed rather than as a code it does not have.
 */
export function probeLineOf(snapshot: ProbeSnapshot | undefined): {
  readonly key: string
  readonly fields?: string
} {
  if (snapshot === undefined) return { key: 'customVendor.probe.none' }
  if (snapshot.outcome === 'passed') return { key: 'customVendor.probe.passed' }
  if (snapshot.reason === null) return { key: 'customVendor.probe.none' }
  if (snapshot.reason === 'opaque-fields') {
    return { key: PROBE_REASON_KEY['opaque-fields'], fields: snapshot.unknownFields.join(', ') }
  }
  return { key: PROBE_REASON_KEY[snapshot.reason] }
}

/** A model row as the settings card's inputs hold it: the text typed, limits included. */
export interface RowDraft {
  readonly id: string
  readonly contextLimit: string
  readonly maxOutputTokens: string
}

/** A row as `customVendor.update` takes it: no snapshot, which only main writes. */
export interface SentRow {
  readonly id: string
  readonly contextLimit: number
  readonly maxOutputTokens: number
}

/**
 * A typed row, or why it cannot be saved. The id loses its surrounding whitespace first
 * (§列表与上限: `customVendor.update` refuses a padded one); both limits must be positive integers or
 * the row is not saved — no fallback to 01 spec:708's 128000 / 4096 (T6).
 */
export function rowOf(
  draft: RowDraft,
):
  | { readonly ok: true; readonly row: SentRow }
  | { readonly ok: false; readonly problem: 'id' | 'limits' } {
  const id = draft.id.trim()
  if (id === '' || id.length > 200) return { ok: false, problem: 'id' }
  const contextLimit = positiveInteger(draft.contextLimit)
  const maxOutputTokens = positiveInteger(draft.maxOutputTokens)
  if (contextLimit === null || maxOutputTokens === null) return { ok: false, problem: 'limits' }
  return { ok: true, row: { id, contextLimit, maxOutputTokens } }
}

function positiveInteger(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * The rows to send when `row` is saved: the instance's rows as they are, without snapshots, and
 * `row` in place of the one with its id, or after the rest. A kept id keeps its snapshot in main
 * unless its output limit changed (§写入规则「改名与模型」).
 */
export function withRow(rows: readonly CustomRow[], row: SentRow): SentRow[] {
  const sent = rows.map(sentRow)
  const at = sent.findIndex((candidate) => candidate.id === row.id)
  return at === -1 ? [...sent, row] : sent.with(at, row)
}

/** The rows to send when the row `id` is removed. */
export function withoutRow(rows: readonly CustomRow[], id: string): SentRow[] {
  return rows.filter((row) => row.id !== id).map(sentRow)
}

function sentRow(row: CustomRow): SentRow {
  return { id: row.id, contextLimit: row.contextLimit, maxOutputTokens: row.maxOutputTokens }
}

/** A fetched model as a row draft: the limits /models gave prefill, the rest stays to be typed (T6). */
export function draftOf(model: FetchedModel): RowDraft {
  return {
    id: model.id,
    contextLimit: model.contextLimit?.toString() ?? '',
    maxOutputTokens: model.maxOutputTokens?.toString() ?? '',
  }
}
