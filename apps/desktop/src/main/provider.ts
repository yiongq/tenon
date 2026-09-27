/**
 * Where a provider's settings come from (spec 01 §desktop 接线). The Run connector
 * (`run-assembly.ts`, spec 02) turns them into the constructed `Provider` a Run sends through.
 *
 * The kernel knows how to talk to a provider; it deliberately does not know where the credentials
 * are. That lookup is the host's, and it lives here:
 *
 *   - secrets come from `HostAdapter.secrets` under `keyFor(identity, 'provider', <id>, <name>)`,
 *   - non-secret values from `config.json`'s `providerConfig[<id>]`, then the definition's own
 *     `ConfigKey.default` — `create()` is documented to receive config with defaults applied,
 *   - and, on a DEV build only, from the environment variables the spec names — the fallback that
 *     keeps a developer's `.env.local` working. The kernel never reads an environment variable
 *     (its lint gate bans the `process` global outright), so this file is the only place the
 *     variable names exist. It is 「开发期回落」 literally: a PACKAGED build ignores every variable
 *     named here, the same way `dev-env.ts` and the secrets seam refuse once packaged. Otherwise
 *     an `ANTHROPIC_BASE_URL` in a user's shell would redirect a shipped Tenon — key included.
 *
 * WHICH provider is `selectProviderId`: `config.json`'s `provider.id` (written by the settings
 * card's `provider.select`), then `TENON_PROVIDER` on a dev build, then the spec's first builtin.
 * What happens to a model id that is not in a builtin table — the owner's daily setup — is
 * `selectModel`.
 */
import {
  ANTHROPIC_PROVIDER_ID,
  ProviderConfigMissingError,
  ZHIPU_PROVIDER_ID,
  keyFor,
} from '@tenon-app/kernel'
import type { HostAdapter, ModelInfo, ProviderDefinition, ProviderId } from '@tenon-app/kernel'
import type { Config } from '@tenon-app/contracts'
import { hostOf } from './endpoint.js'
import { configGeneration, providerSettingsGeneration, readConfig } from './host/profile.js'

/**
 * The environment a dev build falls back to, per provider and per `ConfigKey.name` (spec 01
 * §desktop 接线, 「开发期回落保留」). There is no generic `TENON_<ID>_<KEY>` scheme on purpose — a
 * variable name that composes is a variable name nobody can grep for. A provider without a row
 * here is configured through the settings card and nowhere else.
 */
export const DEV_ENV_FALLBACK: Readonly<Record<ProviderId, Readonly<Record<string, string>>>> = {
  [ANTHROPIC_PROVIDER_ID]: {
    apiKey: 'ANTHROPIC_API_KEY',
    authToken: 'ANTHROPIC_AUTH_TOKEN',
    baseURL: 'ANTHROPIC_BASE_URL',
  },
  [ZHIPU_PROVIDER_ID]: {
    apiKey: 'ZHIPU_API_KEY',
  },
}

/** What a caller hands `ProviderRequest.maxTokens` when the model table's own limit is too big. */
export const MAX_TOKENS_ENV = 'TENON_MAX_TOKENS'
export const MODEL_ENV = 'TENON_MODEL'
/** The dev fallback for the provider choice itself; `config.json` wins over it. */
export const PROVIDER_ENV = 'TENON_PROVIDER'

/**
 * The provider a run uses when nothing was ever chosen. The spec's first builtin, and the one
 * phase 0 shipped — an empty `config.json` must still reach a working chat path.
 */
export const DEFAULT_PROVIDER_ID: ProviderId = ANTHROPIC_PROVIDER_ID

/**
 * Phase 0's cap on one reply — and on its cost — kept (spec 01 §desktop 接线, 「阶段 0 的行为全部
 * 保留」). Without it the default would be the model table's `maxOutputTokens`, which is 128 000 on
 * the default model: twice phase 0's worst case, silently. `TENON_MAX_TOKENS` still overrides it
 * outright, and a model that cannot go this high keeps its own smaller limit.
 */
export const DEFAULT_MAX_TOKENS = 64_000

/** The conservative table used when a definition ships no models of its own. */
const FALLBACK_CONTEXT_LIMIT = 128_000
const FALLBACK_MAX_OUTPUT_TOKENS = 4096

export type EnvLike = Readonly<Record<string, string | undefined>>

/**
 * The environment the development fallbacks read — `{}` once packaged, because a shipped Tenon
 * takes no credential, endpoint or provider choice from the ambient shell (「开发期回落」). Every
 * reader of a `TENON_*` / vendor variable in this process goes through here.
 */
export function devEnv(options: { isPackaged?: boolean; env?: EnvLike | undefined }): EnvLike {
  return options.isPackaged === true ? {} : (options.env ?? process.env)
}

/**
 * Which provider a run uses: what the settings card saved, else the dev fallback, else the
 * default. The dev variable only FILLS what the config lacks — a chosen provider is never
 * overridden by a variable in someone's shell.
 */
export function selectProviderId(selected: string | null | undefined, env: EnvLike): ProviderId {
  return trimmed(selected) ?? fromEnv(env, PROVIDER_ENV) ?? DEFAULT_PROVIDER_ID
}

/** A definition's non-secret config and its secrets, as `ProviderDefinition.create()` takes them. */
export interface ProviderInputs {
  readonly config: Record<string, string>
  readonly secrets: Record<string, string>
  /** Where each secret was found: the keychain, or (a development build only) the environment. */
  readonly sources: Readonly<Record<string, 'keychain' | 'env'>>
}

export interface ReadInputsOptions {
  readonly host: HostAdapter
  readonly definition: ProviderDefinition
  readonly settings?: Readonly<Record<string, string>> | undefined
  /** Already narrowed by `devEnv`; pass `{}` to read only what is STORED. */
  readonly env: EnvLike
  readonly log: (line: string) => void
}

/**
 * Everything a definition declares, resolved from where the host keeps it: secrets from the
 * keychain, the rest from `config.json`, then the declared default, with the development
 * environment filling only what neither supplied.
 *
 * Shared by the Run connector (`run-assembly.ts`, which builds the provider a Run sends through) and
 * `provider.configure`, which needs the same answer without the environment, to decide whether what
 * the user just typed can build a client at all.
 */
export async function readProviderInputs(options: ReadInputsOptions): Promise<ProviderInputs> {
  const { host, definition, env, log } = options
  const fallback = DEV_ENV_FALLBACK[definition.id] ?? {}
  // One pass over the declared keys, secrets read together: a definition declares two or three,
  // and a keychain round trip is the slowest thing on the send path before the request itself.
  const resolved = await Promise.all(
    definition.configKeys.map(async (key) => {
      if (!key.secret) {
        // `key.default` last: `create()` is documented to receive the non-secret config with
        // defaults already applied, so a definition that does not re-apply its own still works.
        const value =
          trimmed(options.settings?.[key.name]) ??
          fromEnv(env, fallback[key.name]) ??
          trimmed(key.default)
        return { key, value, source: null }
      }
      const stored = await readProviderSecret(host, definition.id, key.name, log)
      if (stored !== null) return { key, value: stored, source: 'keychain' as const }
      const fromVars = fromEnv(env, fallback[key.name])
      return { key, value: fromVars, source: fromVars === null ? null : ('env' as const) }
    }),
  )
  const secrets: Record<string, string> = {}
  const config: Record<string, string> = {}
  const sources: Record<string, 'keychain' | 'env'> = {}
  for (const { key, value, source } of resolved) {
    if (value === null) continue
    if (key.secret) secrets[key.name] = value
    else config[key.name] = value
    if (source !== null) sources[key.name] = source
  }
  return { config, secrets, sources }
}

/** What `readSettledInputs` read, and whether one save left all of it. */
export interface SettledInputs {
  readonly config: Config
  readonly inputs: ProviderInputs
  /**
   * No write changed this provider's settings while it was read (`providerSettingsGeneration`): the
   * keys belong to the host this config names. Writes of anything else do not count (rrE-2).
   */
  readonly settled: boolean
  /**
   * `configGeneration` just before this `config.json` was read: a snapshot kept from `config` is
   * current while it is unchanged — any write after the read, of any key, is newer than `config`.
   */
  readonly generation: number
}

/** Reads again at most this many times while saves keep landing mid-read. */
const SETTLE_ATTEMPTS = 3

/**
 * `config.json` and then a definition's inputs, as ONE save left them (01 修补 6「key 绑定主机」). A
 * save that moves the host between the two reads would pair the new host's key with the old base URL
 * — and send it there — because nothing on the send path holds the profile's lock (a keychain prompt
 * must not hold every save). Read again while a write changed THIS provider's settings in between;
 * `settled: false` after `SETTLE_ATTEMPTS`, which a send refuses as a configuration error. A write
 * of anything else (a default model on a held round's release, the locale, the sidebar, the folder
 * list, another provider) cannot unpair these keys, so it neither reads the keychain again — a
 * second prompt on an unsigned build — nor refuses the send (rrE-2).
 */
export async function readSettledInputs(
  options: Omit<ReadInputsOptions, 'settings'>,
): Promise<SettledInputs> {
  const { host, definition } = options
  let last: SettledInputs | null = null
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    const generation = configGeneration(host.identity)
    const before = providerSettingsGeneration(host.identity, definition.id)
    // oxlint-disable-next-line no-await-in-loop -- a read again only when a save landed mid-read
    const config = await readConfig(host.fs, host.identity)
    const settings = config.providerConfig[definition.id]
    // oxlint-disable-next-line no-await-in-loop -- the same read, its second half
    const inputs = await readProviderInputs({ ...options, settings })
    const settled = providerSettingsGeneration(host.identity, definition.id) === before
    last = { config, inputs, settled, generation }
    if (settled) return last
  }
  if (last === null) throw new Error('readSettledInputs: no attempt ran')
  return last
}

/** The config key a definition's endpoint is under. */
export const BASE_URL_KEY = 'baseURL'

/** The declared default base URL of a definition, when it has one. */
export function declaredBaseURL(definition: ProviderDefinition): string | undefined {
  return definition.configKeys.find((key) => key.name === BASE_URL_KEY)?.default
}

/**
 * The host a key is bound to (A9; spec 02 01 修补 6「key 绑定主机」), never stored on its own: a
 * keychain key belongs to the base URL saved with it — the stored one, or the declared default when
 * none is — and an environment key to the environment's base URL, or the declared default.
 */
export function boundHost(
  definition: ProviderDefinition,
  settings: Readonly<Record<string, string>> | undefined,
  env: EnvLike,
  source: 'keychain' | 'env',
): string | null {
  const fallback = DEV_ENV_FALLBACK[definition.id] ?? {}
  const url =
    source === 'keychain'
      ? (trimmed(settings?.[BASE_URL_KEY]) ?? trimmed(declaredBaseURL(definition)))
      : (fromEnv(env, fallback[BASE_URL_KEY]) ?? trimmed(declaredBaseURL(definition)))
  return hostOf(url ?? undefined)
}

/**
 * The secrets present that a send must not use: bound to another host than the one the provider
 * sends to now (01 修补 6「发送前再核一次」). A definition with no base URL has nothing to bind to.
 */
export function unboundSecrets(
  definition: ProviderDefinition,
  settings: Readonly<Record<string, string>> | undefined,
  env: EnvLike,
  inputs: ProviderInputs,
): string[] {
  const current = hostOf(inputs.config[BASE_URL_KEY])
  if (current === null) return []
  return Object.entries(inputs.sources)
    .filter(([, source]) => boundHost(definition, settings, env, source) !== current)
    .map(([name]) => name)
}

/**
 * The `ModelInfo` a request runs against.
 *
 * A `TENON_MODEL` that names a builtin model IS that model. A miss synthesises a conservative
 * one — every capability off, thinking dropped, the smallest limits the definition knows about —
 * because the owner's daily setup is exactly a model that is not in any builtin table, behind an
 * Anthropic-compatible endpoint. Guessing capabilities upward would mean sending tool definitions
 * or signed thinking blocks to an endpoint that may answer 400; guessing downward only costs
 * features that the settings card will make explicit later.
 */
export function selectModel(
  definition: ProviderDefinition,
  requested: string | null,
  log: (line: string) => void,
): ModelInfo {
  const builtin = definition.builtinModels
  if (requested === null) {
    const first = builtin[0]
    if (first === undefined) {
      throw new ProviderConfigMissingError(definition.id, `a model id (${MODEL_ENV})`)
    }
    return first
  }
  const known = builtin.find((model) => model.id === requested)
  if (known !== undefined) return known
  log(
    `[provider] ${definition.id}: "${requested}" is not a builtin model; ` +
      'assuming a conservative capability set (no tools, no vision, no thinking)',
  )
  return {
    id: requested,
    providerId: definition.id,
    contextLimit: smallest(builtin, (model) => model.contextLimit) ?? FALLBACK_CONTEXT_LIMIT,
    maxOutputTokens:
      smallest(builtin, (model) => model.maxOutputTokens) ?? FALLBACK_MAX_OUTPUT_TOKENS,
    reasoning: false,
    supportsToolCalling: false,
    supportsStreamingToolCalls: false,
    supportsVision: false,
    supportsCacheControl: false,
    thinkingPreservationFormat: 'drop',
    usageNeedsOptIn: false,
  }
}

/** The keychain key a provider's secret lives under (spec 01 §desktop 接线). */
export function providerSecretKey(
  host: HostAdapter,
  providerId: ProviderId,
  keyName: string,
): string {
  return keyFor(host.identity, 'provider', providerId, keyName)
}

/**
 * A stored secret, or `null` for "there is none here". An UNREADABLE keychain (locked, no Secret
 * Service) is logged and also reads as null: the environment stays in charge on a dev build, and
 * the settings card shows the key as not configured rather than claiming one it cannot see.
 */
export async function readProviderSecret(
  host: HostAdapter,
  providerId: ProviderId,
  keyName: string,
  log: (line: string) => void,
): Promise<string | null> {
  try {
    return trimmed(await host.secrets.get(providerSecretKey(host, providerId, keyName)))
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    log(`[provider] keychain unavailable for ${providerId}.${keyName}: ${cause}`)
    return null
  }
}

function fromEnv(env: EnvLike, name: string | undefined): string | null {
  if (name === undefined) return null
  return trimmed(env[name])
}

/**
 * Blank is "not configured", not a value: an empty `ANTHROPIC_API_KEY=` line, or a settings field
 * the user cleared, must fall through to the next candidate instead of shadowing it (and an empty
 * credential on the wire answers 401, which reads as a wrong key rather than a missing one).
 */
function trimmed(value: string | null | undefined): string | null {
  if (value == null) return null
  const text = value.trim()
  return text === '' ? null : text
}

function smallest(models: readonly ModelInfo[], of: (model: ModelInfo) => number): number | null {
  let lowest: number | null = null
  for (const model of models) {
    const value = of(model)
    if (lowest === null || value < lowest) lowest = value
  }
  return lowest
}
