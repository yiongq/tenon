/**
 * The model table the eval runner sends through, and the column a run writes to (spec 02 §同题对比
 * 「评测专用行」; H15, A9, M4; M6 §点名 (d)).
 *
 * The eval-only column: glm-5.3 on Zhipu's Anthropic-compatible endpoint
 * `https://open.bigmodel.cn/api/anthropic` with `ZHIPU_API_KEY` as the key (`x-api-key`). Since M6
 * it is a custom vendor instance (an anthropic-messages entry of `customVendors`), not a row of the
 * anthropic definition: anthropic takes api.anthropic.com only (§点名 (a)). The runner writes the
 * entry into the run's profile, probes the row with the product's `probeModel` before anything else
 * — a row that does not pass is not run (M6 推出的读法 35) — and sends through the product's
 * registry view. Its limits are glm-5.3's own row on the zhipu definition (zhipu.ts). An instance
 * row has no `pricing` (§合成), so the runner prices this column at its own eval-only price, the
 * same model's per-token price at the same vendor (Q17). The column keeps its name: client, model
 * and endpoint are those of the 02 row (`TENON_EVAL_PROVIDER=anthropic`, `TENON_EVAL_MODEL=glm-5.3`
 * still name it), and an instance has no WebSearch (Q10).
 *
 * Keys (A9, M4): a column names the variable its key is read from, and the host that variable is
 * bound to. `ZHIPU_API_KEY` only ever goes to open.bigmodel.cn; the official Anthropic key only to
 * api.anthropic.com, and only from the runner's own environment — the live suite's variable and its
 * rule (e2e/helpers/app-env.ts, e2e/helpers/live-env.ts), so the owner keeps one name for that key.
 */
import type { CustomVendorContract } from '@tenon-app/contracts'
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_PROVIDER_ID,
  ZHIPU_DEFAULT_BASE_URL,
  ZHIPU_PROVIDER_ID,
  createProviderRegistry,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type { ModelInfo, ProviderRegistry } from '@tenon-app/kernel'
import { OFFICIAL_KEY_ENV, looksOfficial } from '../e2e/helpers/app-env.js'

/** Zhipu's Anthropic-compatible endpoint (the SDK appends `/v1/messages`). */
export const ZHIPU_ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'

/** Where each key variable may be sent (A9): the host its key is bound to. */
export const KEY_HOSTS: Readonly<Record<string, string>> = {
  ZHIPU_API_KEY: 'open.bigmodel.cn',
  [OFFICIAL_KEY_ENV]: 'api.anthropic.com',
}

/** The eval-only instance's model: glm-5.3, with the limits of its zhipu.ts row. */
export const EVAL_INSTANCE_MODEL_ID = 'glm-5.3'

/**
 * The eval-only instance (M6 §点名 (d)): the `customVendors` entry the runner writes, unprobed. Its
 * id is fixed — each run has a profile of its own — and matches `CUSTOM_PROVIDER_ID_PATTERN` (T1).
 */
export const EVAL_INSTANCE: CustomVendorContract = Object.freeze({
  id: 'custom-00000000-0000-4000-8000-000000000053',
  displayName: 'GLM-5.3 · Anthropic wire (eval)',
  wire: 'anthropic-messages' as const,
  baseURL: ZHIPU_ANTHROPIC_BASE_URL,
  models: [{ id: EVAL_INSTANCE_MODEL_ID, contextLimit: 1_000_000, maxOutputTokens: 128_000 }],
})

/**
 * The price the runner reads the instance column's cost at (Q17; §点名 (d)): glm-5.3's, per million
 * tokens, in CNY — ¥8 in, ¥28 out, ¥2 for a cached read. Never a model row's: no instance row has
 * one.
 */
export const EVAL_INSTANCE_PRICING: NonNullable<ModelInfo['pricing']> = Object.freeze({
  inputPerMTok: 8,
  outputPerMTok: 28,
  cacheReadPerMTok: 2,
  currency: 'CNY' as const,
})

/**
 * The registry under the runner's view: the builtin three, as the app has them. The instance column
 * joins it through the product's registry view (custom-vendors/registry.ts), never by registration.
 */
export function evalProviderRegistry(): ProviderRegistry {
  const registry = createProviderRegistry()
  registerBuiltinProviders(registry)
  return registry
}

/** What the runner writes for an instance column, and the price it reads its cost at. */
export interface EvalInstance {
  readonly entry: CustomVendorContract
  readonly pricing: NonNullable<ModelInfo['pricing']>
}

/** A Tenon column: client × model × endpoint, and where its key comes from. */
export interface EvalColumn {
  /** A builtin's id, or the instance's (`custom-<uuid>`). */
  readonly providerId: string
  readonly modelId: string
  /**
   * Where the column sends: `config.json`'s `providerConfig[providerId].baseURL` for a builtin, the
   * instance's own address for an instance.
   */
  readonly baseURL: string
  /** The variable the key is read from. Records and commands name only it, never its value. */
  readonly keyEnv: string
  /** Only the runner's own environment may hold the key (the official Anthropic key). */
  readonly keyFromProcessOnly: boolean
  readonly effort: string | null
  /** The custom vendor instance the column is (M6 §点名 (d)); null for a builtin column. */
  readonly instance: EvalInstance | null
}

/**
 * The baseline column (§同题对比「基线」), which the gate reads: glm-5.3 on /paas/v4, chosen by the
 * small comparison of 2026-09-28 (plan step 25 record: 15/15 against glm-5.3-flash's 13/15, whose two
 * misses were both a disabled tool hit three times in a row). The gate fails on null.
 */
export const BASELINE_COLUMN: string | null = 'tenon-glm-5.3-open.bigmodel.cn-api-paas-v4'

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
 * the model to the definition's first row, as a new user's fallback does; `anthropic` with
 * `glm-5.3` is the eval-only instance column (M6 §点名 (d)), which has no effort levels. Throws for
 * anything that could not run as a table row, or whose key would travel to a host it is not bound
 * to.
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
  const instance = providerId === ANTHROPIC_PROVIDER_ID && modelId === EVAL_INSTANCE_MODEL_ID
  const model = definition.builtinModels.find((row) => row.id === modelId)
  if (modelId === undefined || (model === undefined && !instance)) {
    throw new Error(`TENON_EVAL_MODEL=${String(modelId)} is not a row of the ${providerId} table`)
  }
  const effort = blank(env['TENON_EVAL_EFFORT'])
  if (effort !== null && !(model?.thinkingSpec?.effortLevels ?? []).includes(effort)) {
    throw new Error(`TENON_EVAL_EFFORT=${effort} is not an effort level of ${modelId}`)
  }
  const column: EvalColumn = instance
    ? {
        providerId: EVAL_INSTANCE.id,
        modelId,
        baseURL: EVAL_INSTANCE.baseURL,
        keyEnv: 'ZHIPU_API_KEY',
        keyFromProcessOnly: false,
        effort,
        instance: { entry: EVAL_INSTANCE, pricing: EVAL_INSTANCE_PRICING },
      }
    : providerId === ZHIPU_PROVIDER_ID
      ? {
          providerId,
          modelId,
          baseURL: ZHIPU_DEFAULT_BASE_URL,
          keyEnv: 'ZHIPU_API_KEY',
          keyFromProcessOnly: false,
          effort,
          instance: null,
        }
      : {
          providerId,
          modelId,
          baseURL: ANTHROPIC_DEFAULT_BASE_URL,
          keyEnv: OFFICIAL_KEY_ENV,
          keyFromProcessOnly: true,
          effort,
          instance: null,
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
