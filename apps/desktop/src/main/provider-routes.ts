import {
  providerConfigure,
  providerList,
  providerSelect,
  registerRoute,
} from '@tenon-app/contracts'
import type {
  CustomVendorContract,
  IpcMainLike,
  ProviderConfigKeyContract,
  ProviderEntryContract,
  ProviderWriteResult,
} from '@tenon-app/contracts'
import { ProviderConfigMissingError, ProviderInvalidArgumentError } from '@tenon-app/kernel'
import type {
  ConfigKey,
  HostAdapter,
  ModelInfo,
  ProviderDefinition,
  ProviderRegistry,
} from '@tenon-app/kernel'
import {
  instanceChoiceRefusal,
  instanceDefinition,
  instanceReach,
  instanceRefusal,
  isInstanceId,
} from './custom-vendors/registry.js'
import type { ProbeRuns } from './custom-vendors/routes.js'
import { saveCustomVendorKeyHeld } from './custom-vendors/store.js'
import { endpointOf, hostOf } from './endpoint.js'
import { readConfig, withConfigLock, writeConfigHeld } from './host/profile.js'
import {
  BASE_URL_KEY,
  declaredBaseURL,
  devEnv,
  providerSecretKey,
  readProviderInputs,
  readSettledInputs,
  unboundSecrets,
} from './provider.js'
import type { EnvLike } from './provider.js'
import { TEXT_ONLY_PROVIDERS } from './run-assembly.js'

/**
 * The three provider routes (spec 01 §desktop 接线) — everything the settings card needs and
 * nothing more: read what is declared, save what was typed, choose what the next run uses. A custom
 * vendor instance (M6 01 修补 6) is listed with its name and its probe marks, takes its key here and
 * nothing else, and offers only the rows it lists.
 *
 * Two properties this file owes the rest of the system:
 *
 *   - **A secret never travels back.** `provider.list` reports `configured` per key and no value;
 *     the response schema has no field one could be put in. What the card prefills for the
 *     NON-secret keys it reads from `config.get`, which is the file those live in.
 *   - **A value that cannot build a client is refused before anything is written.** The card is
 *     where a base URL is typed, so `create()` throwing `ProviderInvalidArgumentError` is a
 *     configuration error to hand back — never a crash, and never a half-saved provider. A
 *     `ProviderConfigMissingError` is NOT that: it only says the provider is still incomplete,
 *     which is the normal state while filling a form key by key.
 *
 * Adding a provider stays "one definition plus catalogue keys": nothing below switches on an id.
 */
export interface ProviderRoutesDeps {
  ipcMain: IpcMainLike
  host: HostAdapter
  providers: ProviderRegistry
  log?: (line: string) => void
  /**
   * `app.isPackaged`: 「已配置」 counts a development variable only on a development build — what a
   * send there would actually find (01 修补 6「已配置」).
   */
  isPackaged?: boolean
  /** The environment the development fallback reads. Tests pass a fixed one; main passes none. */
  env?: EnvLike
  /** M6 §写入规则: an instance's key save aborts its running probe first (custom-vendors/routes.ts). */
  probes?: Pick<ProbeRuns, 'abort'>
}

/** Saved. The card re-reads `provider.list` afterwards rather than trusting an echoed value. */
const SAVED: ProviderWriteResult = { ok: true }

export function registerProviderRoutes(deps: ProviderRoutesDeps): void {
  const { ipcMain, host, providers } = deps
  const log = deps.log ?? ((line: string): void => console.warn(line))
  const env = (): EnvLike => devEnv({ isPackaged: deps.isPackaged === true, env: deps.env })

  registerRoute(ipcMain, providerList, async () => {
    const entries = await Promise.all(
      providers.list().map((definition) => describeProvider({ host, definition, env: env(), log })),
    )
    return entries.filter((entry): entry is ProviderEntryContract => entry !== null)
  })

  registerRoute(ipcMain, providerConfigure, ({ id, values }) =>
    // In the profile's lock, the config read again inside it: two saves never cross, and a key
    // is never left paired with another host's base URL (01 修补 6「key 绑定主机」).
    withConfigLock(host.identity, () => configure(id, values)),
  )

  async function configure(
    id: string,
    values: Readonly<Record<string, string>>,
  ): Promise<ProviderWriteResult> {
    const definition = providers.get(id)
    if (definition === null) return refused('unknown-provider', null)
    const declared = new Map(definition.configKeys.map((key) => [key.name, key]))
    for (const name of Object.keys(values)) {
      if (!declared.has(name)) return refused('unknown-key', name)
    }
    if (isInstanceId(id)) return configureInstance(id, values)

    const config = await readConfig(host.fs, host.identity)
    const stored = config.providerConfig[id] ?? {}
    // Only what is STORED (`env: {}`): a development variable must not make a half-filled
    // provider look complete, nor a typed value look valid because a variable covers for it.
    const current = await readProviderInputs({ host, definition, settings: stored, env: {}, log })
    const next = merge(current, declared, values)

    const check = accepts(definition, host, current, next, Object.keys(values))
    if (!check.ok) return refused('invalid-value', check.configKey)

    const settings = mergeSettings(stored, declared, values)
    const before = hostOf(nonEmpty(stored[BASE_URL_KEY]) ?? declaredBaseURL(definition))
    const after = hostOf(nonEmpty(settings[BASE_URL_KEY]) ?? declaredBaseURL(definition))
    // Ollama is for this machine or a private network only: its cloud is not a base URL here.
    if (TEXT_ONLY_PROVIDERS.has(id) && after !== null && isOllamaCloud(after)) {
      return refused('key-host-binding', BASE_URL_KEY)
    }
    if (before !== after) return moveHost(definition, config.providerConfig, settings, values)

    // Secrets first: a `config.json` write that failed afterwards leaves a credential the user
    // can still use, while the reverse would leave a provider pointing somewhere with no key.
    await Promise.all(
      Object.entries(values)
        .filter(([name]) => declared.get(name)?.secret === true)
        .map(([name, raw]) => {
          const secretName = providerSecretKey(host, id, name)
          const value = raw.trim()
          // Empty deletes it. Step 14's reading, not the spec's (§desktop 接线 states no rule for
          // clearing a secret): the card is the only way to remove a stored credential, and a
          // blank one on the wire answers 401, which reads as a wrong key rather than as none.
          // The card says so before it happens — a cleared field whose key is stored shows what
          // Save will do.
          return value === ''
            ? host.secrets.delete(secretName)
            : host.secrets.set(secretName, value)
        }),
    )
    await writeConfigHeld(host.fs, host.identity, {
      providerConfig: { ...config.providerConfig, [id]: settings },
    })
    return SAVED
  }

  /**
   * An instance's save (M6 §IPC, §写入规则「保存实例的 key」): its key and nothing else. The address
   * is its description's, fixed once it exists (T2; M6 不变量 2), so a `baseURL` is refused before
   * anything is written, whatever else came with it; `providerConfig` is never written for an
   * instance (§注册表视图). The key save aborts a running probe of the instance, then clears every
   * row's snapshot, then stores the key (T3).
   */
  async function configureInstance(
    id: string,
    values: Readonly<Record<string, string>>,
  ): Promise<ProviderWriteResult> {
    if (Object.hasOwn(values, BASE_URL_KEY)) return refused('invalid-value', BASE_URL_KEY)
    const apiKey = values[INSTANCE_KEY]
    if (apiKey === undefined) return SAVED
    deps.probes?.abort(id, 'key')
    const saved = await saveCustomVendorKeyHeld({ host }, id, apiKey)
    return saved.ok ? SAVED : refused('unknown-provider', null)
  }

  /**
   * A save that moves the base URL to another host (01 修补 6「key 绑定主机」): every stored key must
   * be typed again or cleared in it, or nothing is written. Then every declared secret is deleted —
   * whatever was read — the config written, and the new keys stored: a step that fails leaves no
   * key rather than a key bound to the wrong host. A keychain that cannot be read or cleared refuses
   * the whole save before `config.json` is touched.
   */
  async function moveHost(
    definition: ProviderDefinition,
    all: Readonly<Record<string, Readonly<Record<string, string>>>>,
    settings: Record<string, string>,
    values: Readonly<Record<string, string>>,
  ): Promise<ProviderWriteResult> {
    const secrets = definition.configKeys.filter((key) => key.secret)
    const name = (key: ConfigKey): string => providerSecretKey(host, definition.id, key.name)
    let stored: string[]
    try {
      const read = await Promise.all(
        secrets.map(async (key) =>
          (await host.secrets.get(name(key))) === null ? null : key.name,
        ),
      )
      stored = read.filter((key): key is string => key !== null)
    } catch (error) {
      log(
        `[provider] ${definition.id}: the keychain could not be read to move the host: ${String(error)}`,
      )
      return refused('key-host-binding', BASE_URL_KEY)
    }
    if (stored.some((key) => !Object.hasOwn(values, key))) {
      return refused('key-host-binding', BASE_URL_KEY)
    }
    try {
      await Promise.all(secrets.map((key) => host.secrets.delete(name(key))))
    } catch (error) {
      log(
        `[provider] ${definition.id}: the keychain could not be cleared to move the host: ${String(error)}`,
      )
      return refused('key-host-binding', BASE_URL_KEY)
    }
    await writeConfigHeld(host.fs, host.identity, {
      providerConfig: { ...all, [definition.id]: settings },
    })
    // One at a time: a write that fails after another one succeeded must not leave that one
    // stored — every declared secret is deleted again before the failure goes up (「任一步失败都停在
    // 没有 key 的状态」).
    const typed = secrets
      .map((key) => ({ key, value: (values[key.name] ?? '').trim() }))
      .filter(({ value }) => value !== '')
    try {
      for (const { key, value } of typed) {
        // oxlint-disable-next-line no-await-in-loop -- in order, so a failure stops the rest
        await host.secrets.set(name(key), value)
      }
    } catch (error) {
      await Promise.allSettled(secrets.map((key) => host.secrets.delete(name(key))))
      throw error
    }
    return SAVED
  }

  registerRoute(ipcMain, providerSelect, async ({ providerId, modelId }) => {
    const definition = providers.get(providerId)
    if (definition === null) return refused('unknown-provider', null)
    // A hand-typed id is accepted and marked (M6, A15; 01 修补 9 (c)): its capabilities are the
    // conservative synthesis, so it only ever holds a text conversation. Not on an instance: its
    // rows carry the limits the user set (M6 §列表与上限; T6).
    if (isInstanceId(providerId) && !listsModel(definition, modelId)) {
      return refused('unknown-model', null)
    }
    const selection = selectionOf(definition, modelId)
    return withConfigLock(host.identity, async () => {
      // The instance and its row again, as the lock leaves them: a delete that held it first must
      // not have its cleared default written back (M6 §写入规则「删除」; 验收 25).
      if (isInstanceId(providerId)) {
        const gone = instanceChoiceRefusal(
          await readConfig(host.fs, host.identity),
          providerId,
          modelId,
        )
        if (gone !== null) return refused(gone, null)
      }
      // The card's 「新会话默认模型」: both profiles' defaults and `provider` (§模型选择「设置卡」).
      await writeConfigHeld(host.fs, host.identity, {
        provider: selection,
        defaultModelByProfile: { chat: selection, cowork: selection },
      })
      return SAVED
    })
  })
}

/** The one key an instance takes through `provider.configure` (§key). */
const INSTANCE_KEY = 'apiKey'

/** Whether the definition's table has this id. */
function listsModel(definition: ProviderDefinition, modelId: string): boolean {
  return definition.builtinModels.some((model) => model.id === modelId)
}

/** What `config.json` records for a choice: the id, marked when no builtin table has it. */
export function selectionOf(
  definition: ProviderDefinition,
  modelId: string,
): { id: string; modelId: string; source?: 'user' } {
  const builtin = definition.builtinModels.some((model) => model.id === modelId)
  return builtin ? { id: definition.id, modelId } : { id: definition.id, modelId, source: 'user' }
}

function isOllamaCloud(host: string): boolean {
  return host === 'ollama.com' || host.endsWith('.ollama.com')
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}

function refused(
  code: Extract<ProviderWriteResult, { ok: false }>['code'],
  configKey: string | null,
): ProviderWriteResult {
  return { ok: false, code, configKey }
}

interface DescribeOptions {
  readonly host: HostAdapter
  readonly definition: ProviderDefinition
  /** Already narrowed by `devEnv`: `{}` on a packaged build. */
  readonly env: EnvLike
  readonly log: (line: string) => void
}

/**
 * One `provider.list` entry, or null for an instance this read no longer finds (deleted since the
 * view listed it).
 */
async function describeProvider(options: DescribeOptions): Promise<ProviderEntryContract | null> {
  const { definition, env } = options
  // Settings and keys as one save left them, as a send reads them (run-assembly.ts).
  const { config, inputs } = await readSettledInputs(options)
  // M6 01 修补 6「provider.list」: an instance is described from the entry this same read found.
  const instance = isInstanceId(definition.id)
    ? (config.customVendors.find((entry) => entry.id === definition.id) ?? null)
    : null
  if (isInstanceId(definition.id) && instance === null) return null
  const settings = config.providerConfig[definition.id]
  // 「已配置」 is what a send on THIS build would find (01 修补 6): the keychain, the development
  // variables on a development build, and not a key bound to another host than the one used.
  const unbound = new Set(unboundSecrets(definition, settings, env, inputs))
  const configKeys = definition.configKeys.map((key) => ({
    name: key.name,
    required: key.required,
    secret: key.secret,
    primary: key.primary === true,
    labelKey: key.labelKey,
    // Never for a secret, whatever a definition declares: `default` is the only field here that
    // carries a value, and the contract refuses one on a secret key (ipc/provider.ts).
    ...(key.default === undefined || key.secret ? {} : { default: key.default }),
    configured: key.secret
      ? inputs.sources[key.name] !== undefined && !unbound.has(key.name)
      : hasValue(settings?.[key.name]) || hasValue(key.default),
  }))
  const endpoint = endpointOf(inputs.config[BASE_URL_KEY]) ?? { host: '', reach: 'public' as const }
  if (instance !== null) {
    return describeInstance(definition, instance, configKeys, unbound, endpoint)
  }
  return {
    id: definition.id,
    nameKey: definition.nameKey,
    configKeys,
    models: definition.builtinModels.map((model) => menuRow(definition, model)),
    // A send refuses outright while any present key is bound to another host (plan step 19's
    // reading ③, run-assembly.ts), so the provider is not ready either: 「发送时会被拒的 key 不算」.
    configured: isConfigured(configKeys) && unbound.size === 0,
    endpoint,
  }
}

/**
 * An instance's entry (M6 01 修补 4, 6; §运行时「行标记」): the user's name, the generic `nameKey`,
 * each row marked by its probe and its reach, no thinking levels (T5), and `refused` when the stored
 * address fails §地址校验 — which also makes it not configured (§存储; M6 不变量 3). A loopback or
 * private instance needs no stored key: only its binding counts (§key; 推出的读法 7).
 */
function describeInstance(
  definition: ProviderDefinition,
  instance: CustomVendorContract,
  configKeys: readonly ProviderConfigKeyContract[],
  unbound: ReadonlySet<string>,
  endpoint: ProviderEntryContract['endpoint'],
): ProviderEntryContract {
  const local = instanceReach(instance) !== 'public'
  const refusal = instanceRefusal(instance)
  const models = instanceDefinition(instance).builtinModels.map(
    (model): ProviderEntryContract['models'][number] => ({
      id: model.id,
      // M6 不变量 6: tools, and so `probed`, only off a passing snapshot; never for a local one (Q7).
      mark: local
        ? 'local-text-only'
        : model.supportsToolCalling
          ? 'probed'
          : 'unverified-text-only',
      listing: 'main',
    }),
  )
  const keys = local ? requiredConfigured(configKeys) : isConfigured(configKeys)
  return {
    id: definition.id,
    nameKey: definition.nameKey,
    displayName: instance.displayName,
    configKeys: [...configKeys],
    models,
    configured: keys && unbound.size === 0 && refusal === null,
    endpoint,
    ...(refusal === null ? {} : { refused: refusal }),
  }
}

/** A builtin row as the menu lists it (01 修补 6「provider.list」). */
function menuRow(
  definition: ProviderDefinition,
  model: ModelInfo,
): ProviderEntryContract['models'][number] {
  const spec = model.thinkingSpec
  return {
    id: model.id,
    // Ollama sends no tools (A14); zhipu's and anthropic's rows stay verified wherever they point.
    mark: TEXT_ONLY_PROVIDERS.has(definition.id) ? 'local-text-only' : 'verified',
    ...(model.purposeKey === undefined ? {} : { purposeKey: model.purposeKey }),
    listing: model.listing ?? 'main',
    ...(spec?.effortLevels === undefined || spec.effortLevels.length === 0
      ? {}
      : { effortLevels: [...spec.effortLevels] }),
    ...(spec?.defaultEffort === undefined ? {} : { defaultEffort: spec.defaultEffort }),
  }
}

/**
 * "This provider could run as it stands": every REQUIRED key has a value and, where a definition
 * declares credentials at all, at least one of them is stored.
 *
 * The second clause is what makes the answer true for `anthropic`, whose two credentials are both
 * `required: false` because `ConfigKey` cannot say "one of these" — without it a provider with no
 * key at all would report itself ready. Each key's `configured` is what this build can actually use
 * (spec 02 01 修补 6「已配置」): a development variable counts on a development build only, and a key
 * bound to another host than the one the provider sends to does not count at all.
 */
function isConfigured(keys: readonly ProviderConfigKeyContract[]): boolean {
  if (!requiredConfigured(keys)) return false
  const secrets = keys.filter((key) => key.secret)
  return secrets.length === 0 || secrets.some((key) => key.configured)
}

/** Every REQUIRED key has a value: `isConfigured`'s first clause alone. */
function requiredConfigured(keys: readonly ProviderConfigKeyContract[]): boolean {
  return !keys.some((key) => key.required && !key.configured)
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== ''
}

interface Inputs {
  readonly config: Record<string, string>
  readonly secrets: Record<string, string>
}

/** What `create()` would receive if this save went through. */
function merge(
  current: Inputs,
  declared: ReadonlyMap<string, ConfigKey>,
  values: Readonly<Record<string, string>>,
): Inputs {
  const config = { ...current.config }
  const secrets = { ...current.secrets }
  for (const [name, raw] of Object.entries(values)) {
    const key = declared.get(name)
    if (key === undefined) continue
    const value = raw.trim()
    if (key.secret) {
      if (value === '') delete secrets[name]
      else secrets[name] = value
    } else {
      // '' reaches `create()` as "not configured", where the declared default takes over — the
      // reading every builtin definition already applies through `configuredValue`.
      config[name] = value
    }
  }
  return { config, secrets }
}

/** `config.json`'s `providerConfig[id]` after this save: the non-secret keys, merged key by key. */
function mergeSettings(
  stored: Readonly<Record<string, string>>,
  declared: ReadonlyMap<string, ConfigKey>,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const settings = { ...stored }
  for (const [name, raw] of Object.entries(values)) {
    const key = declared.get(name)
    if (key === undefined || key.secret) continue
    settings[name] = raw.trim()
  }
  return settings
}

/** `configKey` is the field to point at, or null when the failure names none. */
type Acceptance = { ok: true } | { ok: false; configKey: string | null }

/**
 * Whether the definition would accept this save. The client is built and thrown away on purpose:
 * constructing one is the definition's own complete statement of what a usable value is, and
 * re-implementing those checks here would mean two rules that drift apart.
 *
 * The field to blame is found by ELIMINATION rather than by reading the error text: each written
 * key is put back to what was stored, one at a time, and the one whose reversion makes the client
 * build again is the one at fault. The kernel's messages quote the offending value verbatim, so a
 * scan for key names inside them points at whichever name the pasted text happens to contain
 * (`https://relay.example/apiKey/v1` would blame `apiKey`) — and at a field the user may not even
 * have touched.
 */
function accepts(
  definition: ProviderDefinition,
  host: HostAdapter,
  current: Inputs,
  next: Inputs,
  written: readonly string[],
): Acceptance {
  if (buildable(definition, host, next)) return { ok: true }
  for (const name of written) {
    if (buildable(definition, host, revert(definition, current, next, name))) {
      return { ok: false, configKey: name }
    }
  }
  return { ok: false, configKey: null }
}

/**
 * Whether `create()` accepts these inputs, ignoring what is still MISSING: a form filled one key
 * at a time passes through "no credential yet", which is incomplete rather than invalid.
 *
 * Missing is ignored by filling in a placeholder for every credential a definition declares and
 * does not have, because both wires check their credentials BEFORE their base URL — without the
 * placeholder, `create()` never reaches the URL rules and every value would look acceptable on a
 * provider whose key is not stored yet. The placeholder is built here, used to construct a client
 * that is immediately discarded, and never written anywhere.
 */
function buildable(definition: ProviderDefinition, host: HostAdapter, inputs: Inputs): boolean {
  const secrets = { ...inputs.secrets }
  for (const key of definition.configKeys) {
    if (key.secret && secrets[key.name] === undefined) secrets[key.name] = PLACEHOLDER_SECRET
  }
  try {
    definition.create({
      network: host.network,
      clock: { now: () => host.clock.now(), setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms) },
      config: inputs.config,
      secrets,
    })
    return true
  } catch (error) {
    // Still incomplete with placeholders in place: something other than a credential is missing,
    // which is the form's normal state and not a value to refuse.
    if (error instanceof ProviderConfigMissingError) return true
    // Anything else is not a configuration problem and must not be reported as one.
    if (!(error instanceof ProviderInvalidArgumentError)) throw error
    return false
  }
}

/** Never stored, never sent: only long enough for `create()` to get past its credential gate. */
const PLACEHOLDER_SECRET = 'not-a-credential'

/** `next` with one key put back to what is stored today. */
function revert(
  definition: ProviderDefinition,
  current: Inputs,
  next: Inputs,
  name: string,
): Inputs {
  const secret = definition.configKeys.find((key) => key.name === name)?.secret === true
  const side = secret ? 'secrets' : 'config'
  const restored = { ...next[side] }
  const before = current[side][name]
  if (before === undefined) delete restored[name]
  else restored[name] = before
  return secret ? { ...next, secrets: restored } : { ...next, config: restored }
}
