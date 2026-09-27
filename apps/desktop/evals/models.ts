/**
 * The model table the eval runner sends through, and the column a run writes to (spec 02 §同题对比
 * 「评测专用行」; H15, A9, M4).
 *
 * The eval-only row: glm-5.3 on the ANTHROPIC definition, sent to Zhipu's Anthropic-compatible
 * endpoint `https://open.bigmodel.cn/api/anthropic` with `ZHIPU_API_KEY` as `apiKey` (`x-api-key`).
 * Tools on, no `thinkingSpec`. It is registered only by `evalProviderRegistry()` — the runner's own
 * registry — and never by `registerBuiltinProviders`, so the daily table and the model menu do not
 * have it. The row's data follows plan step 2's probe T8 (2026-09-26): the endpoint answers every
 * request with `thinking` blocks carrying a 24-character `signature` whether or not `thinking` is
 * sent, and a thinking + tool_use round trip echoed as sent completes (`signed-blocks`); it accepts
 * `cache_control` but caches implicitly and reports no cache writes (`supportsCacheControl: false`);
 * `thinking`, `display` and `output_config.effort` are accepted with no visible effect, hence no
 * `thinkingSpec`. The limits and the price are glm-5.3's own row on the zhipu definition (zhipu.ts):
 * the same model, billed per token by the same vendor.
 *
 * Keys (A9, M4): a column names the variable its key is read from, and the host that variable is
 * bound to. `ZHIPU_API_KEY` only ever goes to open.bigmodel.cn; the official Anthropic key only to
 * api.anthropic.com, and only from the runner's own environment — the live suite's variable and its
 * rule (e2e/helpers/app-env.ts, e2e/helpers/live-env.ts), so the owner keeps one name for that key.
 */
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_PROVIDER_ID,
  ZHIPU_DEFAULT_BASE_URL,
  ZHIPU_PROVIDER_ID,
  anthropicDefinition,
  createProviderRegistry,
  ollamaDefinition,
  zhipuDefinition,
} from '@tenon-app/kernel'
import type { ModelInfo, ProviderDefinition, ProviderRegistry } from '@tenon-app/kernel'
import { OFFICIAL_KEY_ENV, looksOfficial } from '../e2e/helpers/app-env.js'

/** Zhipu's Anthropic-compatible endpoint (the SDK appends `/v1/messages`). */
export const ZHIPU_ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'

/** Where each key variable may be sent (A9): the host its key is bound to. */
export const KEY_HOSTS: Readonly<Record<string, string>> = {
  ZHIPU_API_KEY: 'open.bigmodel.cn',
  [OFFICIAL_KEY_ENV]: 'api.anthropic.com',
}

export const EVAL_GLM_53_ANTHROPIC: ModelInfo = Object.freeze({
  id: 'glm-5.3',
  providerId: ANTHROPIC_PROVIDER_ID,
  contextLimit: 1_000_000,
  maxOutputTokens: 128_000,
  reasoning: true,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'signed-blocks',
  usageNeedsOptIn: false,
  pricing: Object.freeze({
    inputPerMTok: 8,
    outputPerMTok: 28,
    cacheReadPerMTok: 2,
    currency: 'CNY',
  }),
} satisfies ModelInfo)

/** The anthropic definition with the eval-only row after its builtin rows; nothing else differs. */
export const EVAL_ANTHROPIC_DEFINITION: ProviderDefinition = {
  ...anthropicDefinition,
  builtinModels: [...anthropicDefinition.builtinModels, EVAL_GLM_53_ANTHROPIC],
}

/** The registry the runner hands the desktop's Run connector: the builtin three, anthropic widened. */
export function evalProviderRegistry(): ProviderRegistry {
  const registry = createProviderRegistry()
  for (const definition of [EVAL_ANTHROPIC_DEFINITION, zhipuDefinition, ollamaDefinition]) {
    registry.register(definition)
  }
  return registry
}

/** A Tenon column: client × model × endpoint, and where its key comes from. */
export interface EvalColumn {
  readonly providerId: string
  readonly modelId: string
  /** What `config.json`'s `providerConfig[providerId].baseURL` holds for the run. */
  readonly baseURL: string
  /** The variable the key is read from. Records and commands name only it, never its value. */
  readonly keyEnv: string
  /** Only the runner's own environment may hold the key (the official Anthropic key). */
  readonly keyFromProcessOnly: boolean
  readonly effort: string | null
}

/**
 * The baseline column (§同题对比「基线」), which the gate reads. Chosen by the small comparison
 * (plan step 25) and written here when the owner has picked flash or glm-5.3; null until then, and
 * the gate fails on null.
 */
export const BASELINE_COLUMN: string | null = null

/** `EvalRecord.column.endpoint`: host and path, no scheme, no trailing slash. */
export function endpointOf(baseURL: string): string {
  const url = new URL(baseURL)
  return `${url.host}${url.pathname}`.replace(/\/+$/, '')
}

/** The column's slug in the results file name: `tenon-<model>-<endpoint>`, `/` as `-`. */
export function columnSlug(column: Pick<EvalColumn, 'modelId' | 'baseURL'>): string {
  return `tenon-${column.modelId}-${endpointOf(column.baseURL)}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9.-]+/g, '-')
}

export type EnvRecord = Readonly<Record<string, string | undefined>>

/**
 * The column `TENON_EVAL_PROVIDER` / `_MODEL` / `_EFFORT` name. The provider defaults to zhipu and
 * the model to the definition's first row, as a new user's fallback does. Throws for anything that
 * could not run as a table row, or whose key would travel to a host it is not bound to.
 */
export function resolveColumn(env: EnvRecord): EvalColumn {
  const providerId = blank(env['TENON_EVAL_PROVIDER']) ?? ZHIPU_PROVIDER_ID
  const registry = evalProviderRegistry()
  const definition = registry.get(providerId)
  if (
    definition === null ||
    (providerId !== ZHIPU_PROVIDER_ID && providerId !== ANTHROPIC_PROVIDER_ID)
  ) {
    throw new Error(`TENON_EVAL_PROVIDER=${providerId}: the runner runs zhipu or anthropic only`)
  }
  const modelId = blank(env['TENON_EVAL_MODEL']) ?? definition.builtinModels[0]?.id
  const model = definition.builtinModels.find((row) => row.id === modelId)
  if (modelId === undefined || model === undefined) {
    throw new Error(`TENON_EVAL_MODEL=${String(modelId)} is not a row of the ${providerId} table`)
  }
  const effort = blank(env['TENON_EVAL_EFFORT'])
  if (effort !== null && !(model.thinkingSpec?.effortLevels ?? []).includes(effort)) {
    throw new Error(`TENON_EVAL_EFFORT=${effort} is not an effort level of ${modelId}`)
  }
  const column: EvalColumn =
    providerId === ZHIPU_PROVIDER_ID
      ? {
          providerId,
          modelId,
          baseURL: ZHIPU_DEFAULT_BASE_URL,
          keyEnv: 'ZHIPU_API_KEY',
          keyFromProcessOnly: false,
          effort,
        }
      : model === EVAL_GLM_53_ANTHROPIC
        ? {
            providerId,
            modelId,
            baseURL: ZHIPU_ANTHROPIC_BASE_URL,
            keyEnv: 'ZHIPU_API_KEY',
            keyFromProcessOnly: false,
            effort,
          }
        : {
            providerId,
            modelId,
            baseURL: ANTHROPIC_DEFAULT_BASE_URL,
            keyEnv: OFFICIAL_KEY_ENV,
            keyFromProcessOnly: true,
            effort,
          }
  assertKeyBound(column)
  return column
}

/** A column whose key variable is bound to another host than the one it sends to never runs (A9). */
export function assertKeyBound(column: Pick<EvalColumn, 'baseURL' | 'keyEnv'>): void {
  const bound = KEY_HOSTS[column.keyEnv]
  const host = new URL(column.baseURL).hostname
  if (bound === undefined || bound !== host) {
    throw new Error(`${column.keyEnv} is bound to ${String(bound)}, not to ${host} (A9)`)
  }
}

/**
 * The key, read inside the eval process only: from its environment, then `.env.local` (`file`),
 * except the official key, which the runner's environment alone may hold and `.env.local` never
 * (the live suite's rule). Throws naming the variable, never the value.
 */
export function readKey(column: EvalColumn, runner: EnvRecord, file: EnvRecord): string {
  const official = Object.keys(file).filter(
    (name) => name === OFFICIAL_KEY_ENV || looksOfficial(file[name] ?? ''),
  )
  if (column.keyFromProcessOnly && official.length > 0) {
    throw new Error(
      `.env.local holds an official Anthropic key (${official.join(', ')}); pass ${OFFICIAL_KEY_ENV} in this run's environment only`,
    )
  }
  const key =
    blank(runner[column.keyEnv]) ?? (column.keyFromProcessOnly ? null : blank(file[column.keyEnv]))
  if (key === null) throw new Error(`no ${column.keyEnv} in this run's environment or .env.local`)
  if (!column.keyFromProcessOnly && looksOfficial(key)) {
    throw new Error(
      `${column.keyEnv} looks like an official Anthropic key; it never goes to ${column.baseURL}`,
    )
  }
  return key
}

function blank(value: string | undefined): string | null {
  const text = value?.trim() ?? ''
  return text === '' ? null : text
}
