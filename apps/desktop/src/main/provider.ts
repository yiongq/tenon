/**
 * Turning settings into a constructed `Provider` (spec 01 §desktop 接线).
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
 * Nothing here decides WHICH provider: step 13 wires `anthropic`, and `provider.select`,
 * `TENON_PROVIDER` and the settings card are step 14's. What it does decide is what happens to a
 * model id that is not in a builtin table — the owner's daily setup — see `selectModel`.
 */
import { ProviderConfigMissingError, keyFor } from '@tenon-app/kernel'
import type {
  ConfigKey,
  HostAdapter,
  ModelInfo,
  Provider,
  ProviderDefinition,
  ProviderId,
  ProviderRegistry,
} from '@tenon-app/kernel'

/**
 * The environment a dev build falls back to, per provider and per `ConfigKey.name`. Step 14 adds
 * `ZHIPU_API_KEY` here; there is no generic `TENON_<ID>_<KEY>` scheme on purpose — a variable name
 * that composes is a variable name nobody can grep for.
 */
export const DEV_ENV_FALLBACK: Readonly<Record<ProviderId, Readonly<Record<string, string>>>> = {
  anthropic: {
    apiKey: 'ANTHROPIC_API_KEY',
    authToken: 'ANTHROPIC_AUTH_TOKEN',
    baseURL: 'ANTHROPIC_BASE_URL',
  },
}

/** What a caller hands `ProviderRequest.maxTokens` when the model table's own limit is too big. */
export const MAX_TOKENS_ENV = 'TENON_MAX_TOKENS'
export const MODEL_ENV = 'TENON_MODEL'

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

export interface ResolveProviderOptions {
  readonly host: HostAdapter
  readonly providers: ProviderRegistry
  readonly providerId: ProviderId
  /** `config.json`'s `providerConfig[providerId]`, when the user has saved any. */
  readonly settings?: Readonly<Record<string, string>> | undefined
  readonly env?: EnvLike
  /** `app.isPackaged`. The environment fallback below is a DEV build's, and only a dev build's. */
  readonly isPackaged?: boolean
  readonly log?: (line: string) => void
}

export interface ResolvedProvider {
  readonly provider: Provider
  readonly model: ModelInfo
  /** `TENON_MAX_TOKENS` when set, otherwise phase 0's cap within what the model allows. */
  readonly maxTokens: number
}

/**
 * Reads the credentials, builds the provider and picks the model.
 *
 * It rejects rather than returns a null provider: a missing credential is a configuration
 * problem with a name (`ProviderConfigMissingError`), and the caller maps it to an error code the
 * interface has copy for. An UNREADABLE keychain (locked, no Secret Service) is not the same
 * thing as an unconfigured one: it is logged and the environment stays in charge, exactly as
 * phase 0 did.
 */
export async function resolveChatProvider(
  options: ResolveProviderOptions,
): Promise<ResolvedProvider> {
  const { host, providers, providerId } = options
  // A packaged build reads no environment at all here: `{}`, not `process.env`.
  const env: EnvLike = options.isPackaged === true ? {} : (options.env ?? process.env)
  const log = options.log ?? ((line: string): void => console.warn(line))
  const definition = providers.get(providerId)
  if (definition === null) {
    throw new ProviderConfigMissingError(providerId, 'a registered provider definition')
  }

  const fallback = DEV_ENV_FALLBACK[providerId] ?? {}
  // One pass over the declared keys, secrets read together: a definition declares two or three,
  // and a keychain round trip is the slowest thing on the send path before the request itself.
  const resolvedKeys = await Promise.all(
    definition.configKeys.map(async (key) => ({
      key,
      value: key.secret
        ? ((await readSecret(host, providerId, key, log)) ?? fromEnv(env, fallback[key.name]))
        : // `key.default` last: `create()` is documented to receive the non-secret config with
          // defaults already applied, so a definition that does not re-apply its own still works.
          (trimmed(options.settings?.[key.name]) ??
          fromEnv(env, fallback[key.name]) ??
          trimmed(key.default)),
    })),
  )
  const secrets: Record<string, string> = {}
  const config: Record<string, string> = {}
  for (const { key, value } of resolvedKeys) {
    if (value === null) continue
    if (key.secret) secrets[key.name] = value
    else config[key.name] = value
  }

  const provider = definition.create({
    network: host.network,
    // A reading, never a timer: `retryAfterMs` needs the wall clock, retrying does not belong
    // to a provider (spec 01 §Provider 层).
    clock: { now: () => host.clock.now() },
    config,
    secrets,
  })
  const model = selectModel(definition, fromEnv(env, MODEL_ENV), log)
  const asked = positiveInteger(env[MAX_TOKENS_ENV])
  return {
    provider,
    model,
    maxTokens: asked ?? Math.min(DEFAULT_MAX_TOKENS, model.maxOutputTokens),
  }
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

async function readSecret(
  host: HostAdapter,
  providerId: ProviderId,
  key: ConfigKey,
  log: (line: string) => void,
): Promise<string | null> {
  const name = keyFor(host.identity, 'provider', providerId, key.name)
  try {
    return trimmed(await host.secrets.get(name))
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    log(`[provider] keychain unavailable for ${providerId}.${key.name}: ${cause}`)
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

function positiveInteger(value: string | undefined): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function smallest(models: readonly ModelInfo[], of: (model: ModelInfo) => number): number | null {
  let lowest: number | null = null
  for (const model of models) {
    const value = of(model)
    if (lowest === null || value < lowest) lowest = value
  }
  return lowest
}
