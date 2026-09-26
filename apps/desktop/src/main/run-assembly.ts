/**
 * The desktop's `RunConnector` (spec 02 §主进程与 kernel 的循环接口, §依赖方向与能力入口; 01 修补 6):
 * what a Run is sent to, and the provider it is sent through. Split out of phase 1's
 * `resolveChatProvider`, along the line the loop needs:
 *
 *   - `resolveChoice` decides WHICH provider and model, from `config.json` and the development
 *     fallback. It reads no secret, so the kernel can call it before anything else and a keychain
 *     prompt never stands between a send and its judgement.
 *   - `assemble` reads the secrets and builds the provider. A configuration problem is not a
 *     rejection: it is thrown by `provider()`, which the kernel calls when it is about to send.
 *
 * The Ollama range rule lives here and nowhere else (A14): a Run on a provider that phase 2 sends no
 * tools to carries `toolsWithheld`, and the kernel's loop never names a provider.
 *
 * Plan step 9 answers the lower three layers of the five (③ `config.json`'s `provider`, ④ the
 * development variables, ⑤ the default); ① the session's own choice arrives from the kernel, ② the
 * per-profile default and the data-flow check are plan step 19; the search backend is step 28.
 */
import { ProviderConfigMissingError } from '@tenon-app/kernel'
import type {
  HostAdapter,
  ModelChoice,
  ModelInfo,
  Provider,
  ProviderDefinition,
  ProviderId,
  ProviderRegistry,
  RunAssembly,
  RunConnector,
} from '@tenon-app/kernel'
import { readConfig } from './host/profile.js'
import {
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_ENV,
  MODEL_ENV,
  devEnv,
  readProviderInputs,
  selectModel,
  selectProviderId,
} from './provider.js'
import type { EnvLike } from './provider.js'

/** Phase 2 sends no tools to these (A14): a local model's tool calling is not something 02 verifies. */
const TEXT_ONLY_PROVIDERS: ReadonlySet<ProviderId> = new Set(['ollama'])

export interface RunConnectorOptions {
  readonly host: HostAdapter
  readonly providers: ProviderRegistry
  /** `app.isPackaged`: a packaged build takes no credential, endpoint or choice from the environment. */
  readonly isPackaged?: boolean
  /** The environment the development fallback reads. Tests pass a fixed one; main passes none. */
  readonly env?: EnvLike
  readonly log?: (line: string) => void
}

export function createRunConnector(options: RunConnectorOptions): RunConnector {
  const { host, providers } = options
  const log = options.log ?? ((line: string): void => console.warn(line))
  const env = (): EnvLike => devEnv({ isPackaged: options.isPackaged === true, env: options.env })
  /** The origin each provider was last assembled against: what the synchronous read answers. */
  const origins = new Map<ProviderId, string>()

  return {
    endpointOrigin(providerId): string | null {
      // Synchronous by contract, so it answers from the last assembly, then from the definition's
      // own default. Plan step 15 is its first reader (a resume's `model_selected`).
      return origins.get(providerId) ?? defaultOrigin(providers.get(providerId))
    },

    async resolveChoice(q): Promise<ModelChoice> {
      // ① wins, and was confirmed in the menu when it was chosen.
      if (q.sessionChoice !== null) return q.sessionChoice
      const config = await readConfig(host.fs, host.identity)
      const vars = env()
      const providerId = selectProviderId(config.provider?.id, vars)
      const definition = definitionOf(providers, providerId)
      // The saved model first; `TENON_MODEL` fills only what it left empty.
      const requested = trimmed(config.provider?.modelId) ?? trimmed(vars[MODEL_ENV])
      const model = selectModel(definition, requested, log)
      return {
        providerId,
        modelId: model.id,
        effort: null,
        capabilitySource: isBuiltin(definition, model.id) ? 'builtin' : 'synthesized',
      }
    },

    async assemble(q): Promise<RunAssembly> {
      const config = await readConfig(host.fs, host.identity)
      const vars = env()
      const definition = providers.get(q.choice.providerId)
      // Chosen a moment ago, so the table has it; a quiet log, because the choice already said so.
      const model = definition === null ? null : selectModel(definition, q.choice.modelId, () => {})
      let provider: Provider | null = null
      let failure: unknown = null
      let origin = defaultOrigin(definition)
      if (definition === null || model === null) {
        failure = new ProviderConfigMissingError(q.choice.providerId, 'a registered provider')
      } else {
        const inputs = await readProviderInputs({
          host,
          definition,
          settings: config.providerConfig[definition.id],
          env: vars,
          log,
        })
        origin = originOf(inputs.config['baseURL']) ?? origin
        try {
          provider = definition.create({
            network: host.network,
            // A reading for `retryAfterMs`, and a timer for the byte-level idle watchdog only
            // (01 修补 2 and 4): retrying still belongs to the loop, not to a provider.
            clock: {
              now: () => host.clock.now(),
              setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms),
            },
            config: inputs.config,
            secrets: inputs.secrets,
          })
        } catch (error) {
          // A missing key or an unusable base URL: the kernel reads it off `provider()`.
          failure = error
        }
      }
      if (origin !== null) origins.set(q.choice.providerId, origin)
      const info = model ?? unusableModel(q.choice)
      return {
        model: info,
        capabilitySource: q.choice.capabilitySource,
        endpointOrigin: origin ?? 'null',
        maxTokens:
          positiveInteger(vars[MAX_TOKENS_ENV]) ??
          Math.min(DEFAULT_MAX_TOKENS, info.maxOutputTokens),
        toolsWithheld: TEXT_ONLY_PROVIDERS.has(q.choice.providerId) ? 'provider-text-only' : null,
        search: null,
        mcpSources: [],
        provider(): Provider {
          if (provider === null) throw failure
          return provider
        },
      }
    },
  }
}

/** A registered definition, or the configuration error a missing one is. */
function definitionOf(providers: ProviderRegistry, providerId: ProviderId): ProviderDefinition {
  const definition = providers.get(providerId)
  if (definition === null) {
    throw new ProviderConfigMissingError(providerId, 'a registered provider definition')
  }
  return definition
}

function isBuiltin(definition: ProviderDefinition, modelId: string): boolean {
  return definition.builtinModels.some((model) => model.id === modelId)
}

/** The origin of a definition's declared default base URL, when it declares one. */
function defaultOrigin(definition: ProviderDefinition | null): string | null {
  const key = definition?.configKeys.find((candidate) => candidate.name === 'baseURL')
  return originOf(key?.default)
}

/** `URL.origin` — scheme, host and port — or null for what is not a URL. */
function originOf(url: string | undefined): string | null {
  if (url === undefined || url.trim() === '') return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * The ModelInfo of an assembly whose provider cannot be built. It is never encoded against:
 * `provider()` throws first and the kernel writes nothing.
 */
function unusableModel(choice: ModelChoice): ModelInfo {
  return {
    id: choice.modelId,
    providerId: choice.providerId,
    contextLimit: 1,
    maxOutputTokens: 1,
    reasoning: false,
    supportsToolCalling: false,
    supportsStreamingToolCalls: false,
    supportsVision: false,
    supportsCacheControl: false,
    thinkingPreservationFormat: 'drop',
    usageNeedsOptIn: false,
  }
}

function trimmed(value: string | null | undefined): string | null {
  if (value == null) return null
  const text = value.trim()
  return text === '' ? null : text
}

function positiveInteger(value: string | undefined): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}
