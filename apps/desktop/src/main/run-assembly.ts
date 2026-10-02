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
 * `resolveChoice` answers ②–⑤ of the five layers (01 修补 6「五层解析」): ② the profile's default
 * (`defaultModelByProfile`), ③ `config.json`'s `provider`, ④ the development variables, ⑤ the first
 * builtin. ① — the session's own choice — arrives from the kernel and wins; the data-flow check is
 * only for a choice ②–⑤ made, which nobody confirmed in the menu (§模型选择「数据去向」). Search
 * selection uses this same endpoint and resolved credentials; `searchTarget` reads only the snapshot.
 */
import type { Config } from '@tenon-app/contracts'
import {
  ProviderConfigMissingError,
  createAnthropicSearchDefinition,
  prepareZhipuSearchQuery,
  zhipuSearchDefinition,
} from '@tenon-app/kernel'
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
  SearchBackend,
  SearchBackendDefinition,
} from '@tenon-app/kernel'
import { endpointOf, hostOf, originOf } from './endpoint.js'
import { configGeneration, readConfig, watchConfig } from './host/profile.js'
import {
  BASE_URL_KEY,
  boundHost,
  DEFAULT_MAX_TOKENS,
  DEV_ENV_FALLBACK,
  MAX_TOKENS_ENV,
  MODEL_ENV,
  declaredBaseURL,
  devEnv,
  readSettledInputs,
  selectModel,
  selectProviderId,
  unboundSecrets,
} from './provider.js'
import type { EnvLike } from './provider.js'

/** Phase 2 sends no tools to these (A14): a local model's tool calling is not something 02 verifies. */
export const TEXT_ONLY_PROVIDERS: ReadonlySet<ProviderId> = new Set(['ollama'])

export interface RunConnectorOptions {
  readonly host: HostAdapter
  readonly providers: ProviderRegistry
  /** `app.isPackaged`: a packaged build takes no credential, endpoint or choice from the environment. */
  readonly isPackaged?: boolean
  /** The environment the development fallback reads. Tests pass a fixed one; main passes none. */
  readonly env?: EnvLike
  readonly log?: (line: string) => void
  /**
   * `config.json` as main read it at startup, before `bindLoop` and `recover()`: what the synchronous
   * `endpointOrigin` answers from until the first write or read. Without it, the declared defaults.
   */
  readonly config?: Config
}

export function createRunConnector(options: RunConnectorOptions): RunConnector {
  const { host, providers } = options
  const log = options.log ?? ((line: string): void => console.warn(line))
  const env = (): EnvLike => devEnv({ isPackaged: options.isPackaged === true, env: options.env })
  /**
   * `config.json`'s provider settings as last known — startup's, then every write's, then a read no
   * write overlapped — so the synchronous `endpointOrigin` answers where `assemble` would send now,
   * not a definition's default: a resume's `model_selected` after a restart records the configured
   * host (§续跑「endpointOrigin 按实际发往的地址记」), and the data-flow check compares with it.
   */
  let stored: Config['providerConfig'] = options.config?.providerConfig ?? {}
  watchConfig(host.identity, (config) => {
    stored = config.providerConfig
  })
  /** A read's settings become the snapshot only while no write has landed since it was read. */
  const remember = (config: Config, generation: number): void => {
    if (configGeneration(host.identity) === generation) stored = config.providerConfig
  }
  const currentConfig = async (): Promise<Config> => {
    const before = configGeneration(host.identity)
    const config = await readConfig(host.fs, host.identity)
    remember(config, before)
    return config
  }

  return {
    endpointOrigin(providerId): string | null {
      // Synchronous by contract: `baseURLOf` over the snapshot, the way `assemble` resolves it —
      // the stored base URL, the development variable, the declared default.
      const definition = providers.get(providerId)
      if (definition === null) return null
      return originOf(baseURLOf(definition, stored[providerId], env()) ?? undefined)
    },

    // M6 §对 02 的修补 4 (T13): the definition's cap, as data; synchronous and reads no secret.
    toolsPerRequest(providerId): number | null {
      return providers.get(providerId)?.maxToolsPerRequest ?? null
    },

    searchTarget(providerId, query) {
      const definition = providers.get(providerId)
      if (definition === null) return null
      const backend = searchDefinitionFor(
        definition,
        baseURLOf(definition, stored[providerId], env()),
      )
      // Definitions' query transformations are pure; selecting a target must never read a key.
      if (backend?.id === 'zhipu') {
        return { host: 'open.bigmodel.cn', ...prepareZhipuSearchQuery(query) }
      }
      if (backend?.id === 'anthropic') {
        return { host: 'api.anthropic.com', query, truncated: false }
      }
      return null
    },

    async resolveChoice(q): Promise<ModelChoice | { needsConfirm: { host: string } }> {
      // ① wins, and was confirmed in the menu when it was chosen.
      if (q.sessionChoice !== null) return q.sessionChoice
      const config = await currentConfig()
      const vars = env()
      // ② the profile's default, then ③ what the settings card saved (「新会话默认」, 01 修补 9 (b)).
      const saved = config.defaultModelByProfile[q.profile] ?? config.provider
      const providerId = selectProviderId(saved?.id, vars)
      const definition = definitionOf(providers, providerId)
      // The saved model first; `TENON_MODEL` fills only what it left empty.
      const requested = trimmed(saved?.modelId) ?? trimmed(vars[MODEL_ENV])
      const model = selectModel(definition, requested, log)
      const choice: ModelChoice = {
        providerId,
        modelId: model.id,
        effort: null,
        capabilitySource: isBuiltin(definition, model.id)
          ? 'builtin'
          : saved?.source === 'user' && saved.modelId === model.id
            ? 'user'
            : 'synthesized',
      }
      // 「数据去向」: a session with history that sent to this machine or a private network is not
      // switched to a public host without the menu's confirmation (A9, B18).
      const before = endpointOf(q.previousOrigin ?? undefined)
      if (before !== null && before.reach !== 'public') {
        const next = endpointOf(
          baseURLOf(definition, config.providerConfig[providerId], vars) ?? undefined,
        )
        if (next !== null && next.reach === 'public') return { needsConfirm: { host: next.host } }
      }
      return choice
    },

    async assemble(q): Promise<RunAssembly> {
      const vars = env()
      const definition = providers.get(q.choice.providerId)
      // Chosen a moment ago, so the table has it; a quiet log, because the choice already said so.
      const model = definition === null ? null : selectModel(definition, q.choice.modelId, () => {})
      let provider: Provider | null = null
      let search: SearchBackend | null = null
      let failure: unknown = null
      let origin = defaultOrigin(definition)
      if (definition === null || model === null) {
        failure = new ProviderConfigMissingError(q.choice.providerId, 'a registered provider')
      } else {
        // The settings and the keys as one save left them: a save that moved the host between the
        // two reads would pair its new key with the old base URL (01 修补 6「key 绑定主机」).
        const read = await readSettledInputs({ host, definition, env: vars, log })
        // Only a settled read's config is a snapshot at all; `remember` then keeps it only while no
        // write of any key landed after it was read (rrE-2).
        if (read.settled) remember(read.config, read.generation)
        const settings = read.config.providerConfig[definition.id]
        const inputs = read.inputs
        origin = originOf(inputs.config[BASE_URL_KEY]) ?? origin
        // 「发送前再核一次」: a key bound to another host than the one this sends to is not used —
        // a configuration error, never a request (A9; 01 修补 6).
        const unbound = unboundSecrets(definition, settings, vars, inputs)
        try {
          if (!read.settled) {
            throw new ProviderConfigMissingError(
              definition.id,
              'a key read while no save was moving its host',
            )
          }
          if (unbound.length > 0) {
            throw new ProviderConfigMissingError(
              definition.id,
              `a key bound to the host it sends to (${unbound.join(', ')})`,
            )
          }
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
          const searchDefinition = searchDefinitionFor(
            definition,
            inputs.config[BASE_URL_KEY] ?? null,
          )
          if (searchDefinition !== null) {
            const backendHost =
              searchDefinition.id === 'zhipu' ? 'open.bigmodel.cn' : 'api.anthropic.com'
            // The same resolved secrets object as the provider, with its same source/host binding.
            // Never project a second key or read another provider's keychain account for search.
            if (
              Object.values(inputs.sources).every(
                (source) => boundHost(definition, settings, vars, source) === backendHost,
              )
            ) {
              search = searchDefinition.create({ network: host.network, secrets: inputs.secrets })
            }
          }
        } catch (error) {
          // A missing key or an unusable base URL: the kernel reads it off `provider()`.
          failure = error
        }
      }
      const info = model ?? unusableModel(q.choice)
      return {
        model: info,
        capabilitySource: q.choice.capabilitySource,
        endpointOrigin: origin ?? 'null',
        maxTokens: requestMaxTokens(vars, info),
        toolsWithheld: TEXT_ONLY_PROVIDERS.has(q.choice.providerId) ? 'provider-text-only' : null,
        search,
        mcpSources: [],
        provider(): Provider {
          if (provider === null) throw failure
          return provider
        },
      }
    },
  }
}

/**
 * `RunAssembly.maxTokens`: `TENON_MAX_TOKENS` on a development build, else phase 0's cap or the
 * row's own smaller limit. A custom vendor's probe asks with the same value (M6 §探测 `maxTokens`).
 */
export function requestMaxTokens(vars: EnvLike, model: Pick<ModelInfo, 'maxOutputTokens'>): number {
  return (
    positiveInteger(vars[MAX_TOKENS_ENV]) ?? Math.min(DEFAULT_MAX_TOKENS, model.maxOutputTokens)
  )
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
  return definition === null ? null : originOf(declaredBaseURL(definition))
}

/** Where a provider sends, with no secret read: the stored base URL, the dev variable, the default. */
function baseURLOf(
  definition: ProviderDefinition,
  settings: Readonly<Record<string, string>> | undefined,
  vars: EnvLike,
): string | null {
  const envName = DEV_ENV_FALLBACK[definition.id]?.[BASE_URL_KEY]
  return (
    trimmed(settings?.[BASE_URL_KEY]) ??
    trimmed(envName === undefined ? undefined : vars[envName]) ??
    trimmed(declaredBaseURL(definition))
  )
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

/** Search is available only on the supported provider/host combinations (spec 02 §工具形状与后端选择). */
function searchDefinitionFor(
  definition: ProviderDefinition,
  baseURL: string | null,
): SearchBackendDefinition | null {
  if (definition.id !== 'zhipu' && definition.id !== 'anthropic') return null
  const host = hostOf(baseURL ?? undefined)
  if (host === 'open.bigmodel.cn') return zhipuSearchDefinition
  if (definition.id === 'anthropic' && host === 'api.anthropic.com') {
    return createAnthropicSearchDefinition({ maxTokens: 4096, models: definition.builtinModels })
  }
  return null
}
