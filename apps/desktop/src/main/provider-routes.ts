import {
  providerConfigure,
  providerList,
  providerSelect,
  registerRoute,
} from '@tenon-app/contracts'
import type {
  IpcMainLike,
  ProviderConfigKeyContract,
  ProviderEntryContract,
  ProviderWriteResult,
} from '@tenon-app/contracts'
import { ProviderConfigMissingError, ProviderInvalidArgumentError } from '@tenon-app/kernel'
import type {
  ConfigKey,
  HostAdapter,
  ProviderDefinition,
  ProviderRegistry,
} from '@tenon-app/kernel'
import { readConfig, writeConfig } from './host/profile.js'
import { providerSecretKey, readProviderInputs, readProviderSecret } from './provider.js'

/**
 * The three provider routes (spec 01 §desktop 接线) — everything the settings card needs and
 * nothing more: read what is declared, save what was typed, choose what the next run uses.
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
}

/** Saved. The card re-reads `provider.list` afterwards rather than trusting an echoed value. */
const SAVED: ProviderWriteResult = { ok: true }

export function registerProviderRoutes(deps: ProviderRoutesDeps): void {
  const { ipcMain, host, providers } = deps
  const log = deps.log ?? ((line: string): void => console.warn(line))

  registerRoute(ipcMain, providerList, async () => {
    const config = await readConfig(host.fs, host.identity)
    return await Promise.all(
      providers.list().map((definition) =>
        describeProvider({
          host,
          definition,
          settings: config.providerConfig[definition.id],
          log,
        }),
      ),
    )
  })

  registerRoute(ipcMain, providerConfigure, async ({ id, values }) => {
    const definition = providers.get(id)
    if (definition === null) return refused('unknown-provider', null)
    const declared = new Map(definition.configKeys.map((key) => [key.name, key]))
    for (const name of Object.keys(values)) {
      if (!declared.has(name)) return refused('unknown-key', name)
    }

    const config = await readConfig(host.fs, host.identity)
    const stored = config.providerConfig[id] ?? {}
    // Only what is STORED (`env: {}`): a development variable must not make a half-filled
    // provider look complete, nor a typed value look valid because a variable covers for it.
    const current = await readProviderInputs({ host, definition, settings: stored, env: {}, log })
    const next = merge(current, declared, values)

    const check = accepts(definition, host, current, next, Object.keys(values))
    if (!check.ok) return refused('invalid-value', check.configKey)

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
    const settings = mergeSettings(stored, declared, values)
    await writeConfig(host.fs, host.identity, {
      providerConfig: { ...config.providerConfig, [id]: settings },
    })
    return SAVED
  })

  registerRoute(ipcMain, providerSelect, async ({ providerId, modelId }) => {
    const definition = providers.get(providerId)
    if (definition === null) return refused('unknown-provider', null)
    // One of the definition's own models. A model no table knows is still reachable through
    // `TENON_MODEL` (which synthesises a conservative `ModelInfo`); letting the card write one
    // would mean storing a capability set nobody declared.
    if (!definition.builtinModels.some((model) => model.id === modelId)) {
      return refused('unknown-model', null)
    }
    await writeConfig(host.fs, host.identity, { provider: { id: providerId, modelId } })
    return SAVED
  })
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
  readonly settings: Readonly<Record<string, string>> | undefined
  readonly log: (line: string) => void
}

async function describeProvider(options: DescribeOptions): Promise<ProviderEntryContract> {
  const { host, definition, settings, log } = options
  const configKeys = await Promise.all(
    definition.configKeys.map(async (key) => ({
      name: key.name,
      required: key.required,
      secret: key.secret,
      primary: key.primary === true,
      labelKey: key.labelKey,
      // Never for a secret, whatever a definition declares: `default` is the only field here that
      // carries a value, and the contract refuses one on a secret key (ipc/provider.ts).
      ...(key.default === undefined || key.secret ? {} : { default: key.default }),
      configured: key.secret
        ? (await readProviderSecret(host, definition.id, key.name, log)) !== null
        : hasValue(settings?.[key.name]) || hasValue(key.default),
    })),
  )
  return {
    id: definition.id,
    nameKey: definition.nameKey,
    configKeys,
    models: definition.builtinModels.map((model) => ({ id: model.id })),
    configured: isConfigured(configKeys),
  }
}

/**
 * "This provider could run as it stands": every REQUIRED key has a value and, where a definition
 * declares credentials at all, at least one of them is stored.
 *
 * The second clause is what makes the answer true for `anthropic`, whose two credentials are both
 * `required: false` because `ConfigKey` cannot say "one of these" — without it a provider with no
 * key at all would report itself ready. It reports what is STORED: a development variable makes
 * the chat path work without making this true, which is the honest reading for a card whose job
 * is to say what a packaged build would find.
 */
function isConfigured(keys: readonly ProviderConfigKeyContract[]): boolean {
  if (keys.some((key) => key.required && !key.configured)) return false
  const secrets = keys.filter((key) => key.secret)
  return secrets.length === 0 || secrets.some((key) => key.configured)
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
      clock: { now: () => host.clock.now() },
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
