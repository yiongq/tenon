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
 * tools to carries `toolsWithheld`, and the kernel's loop never names a provider. M6 extends it to
 * the custom vendor instances (02 修补 7): a loopback or private instance is `provider-text-only`, a
 * public instance's row with no passing probe `not-probed`; `assemble` remakes an instance's row from
 * the same read as its key (§注册表视图), and says `probed` / `user` for it (§运行时「行标记」).
 *
 * `resolveChoice` answers ②–⑤ of the five layers (01 修补 6「五层解析」): ② the profile's default
 * (`defaultModelByProfile`), ③ `config.json`'s `provider`, ④ the development variables, ⑤ the first
 * builtin. ① — the session's own choice — arrives from the kernel and wins; the data-flow check is
 * only for a choice ②–⑤ made, which nobody confirmed in the menu (§模型选择「数据去向」). Search
 * selection uses this same endpoint and resolved credentials; `searchTarget` reads only the snapshot.
 */
import type { Config } from '@tenon-app/contracts'
import {
  ANTHROPIC_PROVIDER_ID,
  ProviderConfigMissingError,
  ZHIPU_PROVIDER_ID,
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
import {
  instanceReach,
  instanceRowOf,
  isInstanceId,
  isProbedRow,
} from './custom-vendors/registry.js'
import type { InstanceRow } from './custom-vendors/registry.js'
import { endpointOf, hostOf, originOf } from './endpoint.js'
import { configGeneration, readConfig, watchConfig } from './host/profile.js'
import {
  BASE_URL_KEY,
  boundHost,
  builtinRefusal,
  DEFAULT_MAX_TOKENS,
  DEV_ENV_FALLBACK,
  MAX_TOKENS_ENV,
  MODEL_ENV,
  OFFICIAL_ORIGINS,
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
  logRefusedDevEndpoints(env(), options.config?.providerConfig ?? {}, log)
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
      const providerId = q.choice.providerId
      const viewed = providers.get(providerId)
      const instance = isInstanceId(providerId)
      // What `create()` builds and the row it sends: for a builtin, the view's; for an instance,
      // remade below from the read that also takes its key.
      let definition = viewed
      // Chosen a moment ago, so the table has it; a quiet log, because the choice already said so.
      // An instance's row is only ever looked up (M6 §实例被删或改坏): no conservative synthesis.
      let model =
        viewed === null || instance ? null : selectModel(viewed, q.choice.modelId, () => {})
      // An instance gone from the view answers as one whose row is gone (plan step 7 读法 (1)).
      let range: Pick<RunAssembly, 'capabilitySource' | 'toolsWithheld'> = instance
        ? instanceRange(viewed, null, q.choice)
        : {
            capabilitySource: q.choice.capabilitySource,
            toolsWithheld: TEXT_ONLY_PROVIDERS.has(providerId) ? 'provider-text-only' : null,
          }
      let provider: Provider | null = null
      let search: SearchBackend | null = null
      let failure: unknown = null
      let origin = defaultOrigin(viewed)
      if (viewed === null) {
        failure = new ProviderConfigMissingError(providerId, 'a registered provider')
      } else {
        // The settings and the keys as one save left them: a save that moved the host between the
        // two reads would pair its new key with the old base URL (01 修补 6「key 绑定主机」).
        const read = await readSettledInputs({ host, definition: viewed, env: vars, log })
        // Only a settled read's config is a snapshot at all; `remember` then keeps it only while no
        // write of any key landed after it was read (rrE-2).
        if (read.settled) remember(read.config, read.generation)
        if (instance) {
          // M6 §注册表视图: the row from the same read as the key, never the view's definition as
          // this call found it — a key save landing mid-read clears the snapshot the new key would
          // otherwise be sent with.
          const listed = instanceRowOf(read.config, providerId, q.choice.modelId)
          // M6 不变量 3: the request goes where the key binding, `endpointOrigin` and 02's data-flow
          // check — all read off the view — say. The app never moves an instance's address or wire
          // (T2), so they differ only after a hand edit of config.json (§存储), until the next write
          // or a restart: a configuration error, never a request to the edited host.
          const row =
            listed !== null &&
            listed.entry.baseURL === declaredBaseURL(viewed) &&
            listed.entry.wire === viewed.wire
              ? listed
              : null
          definition = row?.definition ?? null
          model = row?.model ?? null
          range = instanceRange(viewed, row, q.choice)
        }
        const settings = read.config.providerConfig[viewed.id]
        const inputs = read.inputs
        origin = originOf(inputs.config[BASE_URL_KEY]) ?? origin
        // 「发送前再核一次」: a key bound to another host than the one this sends to is not used —
        // a configuration error, never a request (A9; 01 修补 6).
        const unbound = unboundSecrets(viewed, settings, vars, inputs)
        // M6 §点名 (b), (c): zhipu or anthropic configured outside its official origin, or zhipu on
        // the subscription path, reads as not configured — 0 requests (M6 不变量 16).
        const refusal = builtinRefusal(viewed.id, inputs.config[BASE_URL_KEY])
        try {
          // M6 §实例被删或改坏 (T12): the instance or its row is gone — `provider()` refuses, as for
          // a missing key, and `assemble` itself resolves (ports.ts).
          if (definition === null || model === null) {
            throw new ProviderConfigMissingError(providerId, 'an instance that lists this model')
          }
          if (refusal !== null) {
            throw new ProviderConfigMissingError(
              definition.id,
              `its official endpoint (${refusal.code}); another endpoint is a custom vendor`,
            )
          }
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
                (source) => boundHost(viewed, settings, vars, source) === backendHost,
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
        capabilitySource: range.capabilitySource,
        endpointOrigin: origin ?? 'null',
        maxTokens: requestMaxTokens(vars, info),
        toolsWithheld: range.toolsWithheld,
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
 * M6 §点名 (c): `DEV_ENV_FALLBACK` still reads a base URL variable (`ANTHROPIC_BASE_URL`), and one
 * outside the provider's official origin leaves it not configured — `provider.list` says `refused`,
 * a send sends nothing. One line at construction tells the developer why, naming the origin only
 * (never a path or userinfo). The variable only fills what config.json lacks, so a provider with an
 * address saved at startup is skipped, and the line says a later save still wins. A packaged build
 * reads no variable, so it never logs this.
 */
function logRefusedDevEndpoints(
  vars: EnvLike,
  stored: Config['providerConfig'],
  log: (line: string) => void,
): void {
  for (const [providerId, names] of Object.entries(DEV_ENV_FALLBACK)) {
    const name = names[BASE_URL_KEY]
    const value = name === undefined ? null : trimmed(vars[name])
    if (name === undefined || value === null) continue
    if (trimmed(stored[providerId]?.[BASE_URL_KEY]) !== null) continue
    const refusal = builtinRefusal(providerId, value)
    if (refusal === null) continue
    const why =
      refusal.code === 'subscription-endpoint'
        ? 'is a subscription endpoint'
        : `points at ${refusal.origin ?? 'no origin'}, not ${OFFICIAL_ORIGINS[providerId] ?? ''}`
    log(
      `[provider] ${name} ${why}: unless an address is saved in the settings card, ${providerId} ` +
        'reads as not configured; another endpoint is a custom vendor (settings card)',
    )
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

/**
 * An instance's range rule and `capabilitySource` (M6 §不发工具, §行标记; 推出的读法 27, 28, 32): from
 * the row this assembly remade, not from the choice — `resolveChoice` and the kernel's `choiceOf`
 * answer `builtin` / `user` for it — except a choice carrying `probed`, which only a resume's or a
 * reopened table's frozen `model_selected` does: that Run keeps sending the frozen row's tools after
 * a key save cleared the snapshot (M6 不变量 18). A loopback or private instance sends none (Q7).
 * `row` is null once the instance or the row is gone, and `viewed` once the view has no instance
 * either: `provider()` refuses anyway, and the answer is the one for a row with no passing probe.
 */
function instanceRange(
  viewed: ProviderDefinition | null,
  row: InstanceRow | null,
  choice: ModelChoice,
): Pick<RunAssembly, 'capabilitySource' | 'toolsWithheld'> {
  const probed = choice.capabilitySource === 'probed' || (row !== null && isProbedRow(row))
  const local =
    viewed !== null && instanceReach({ baseURL: declaredBaseURL(viewed) ?? '' }) !== 'public'
  return {
    capabilitySource: probed ? 'probed' : 'user',
    toolsWithheld: local ? 'provider-text-only' : probed ? null : 'not-probed',
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

/**
 * Search is available only on the supported provider/host combinations (spec 02 §工具形状与后端选择):
 * zhipu on its own host, anthropic on api.anthropic.com. M6 §点名 (f) removed 02 spec:2738's third,
 * anthropic pointed at Zhipu's /api/anthropic: §点名 (a) leaves no input that reaches it, and an
 * instance — the Anthropic wire to Zhipu now — has no search (Q10).
 */
function searchDefinitionFor(
  definition: ProviderDefinition,
  baseURL: string | null,
): SearchBackendDefinition | null {
  const host = hostOf(baseURL ?? undefined)
  if (definition.id === ZHIPU_PROVIDER_ID && host === 'open.bigmodel.cn') {
    return zhipuSearchDefinition
  }
  if (definition.id === ANTHROPIC_PROVIDER_ID && host === 'api.anthropic.com') {
    return createAnthropicSearchDefinition({ maxTokens: 4096, models: definition.builtinModels })
  }
  return null
}
