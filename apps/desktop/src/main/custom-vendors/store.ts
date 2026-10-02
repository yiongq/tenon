/**
 * Writing custom vendor instances (M6 §写入规则, §key, §地址校验): create, rename and change the
 * rows, delete, and save the key — each in the profile's config lock, the one `provider.configure`
 * takes (01 修补 6), with `config.json` read again inside it.
 *
 * The orders are the spec's, chosen for what a failure halfway leaves behind:
 *
 *   - create: key, then the entry. A failed entry write deletes the key again; the id is never reused,
 *     so a key whose deletion failed too belongs to no instance any path can read (M6 不变量 13).
 *   - delete: the key, then the entry. A failed key deletion refuses the whole delete; never 「条目已删、
 *     key 还在」.
 *   - key save: the snapshots cleared, then the key (the reverse of 02's 「先写机密」): a failed key write
 *     stops at 「快照已清、旧 key 还在」, tools off (T3).
 *
 * A key is only ever under `keyFor(identity, 'provider', <instance id>, 'apiKey')`; neither it nor
 * an address is ever logged (M6 不变量 14). The routes are `routes.ts` (delete, create, update) and
 * `provider.configure` (the key save).
 */
import { PROVIDER_VALUE_MAX_LENGTH } from '@tenon-app/contracts'
import type {
  Config,
  ConfigPatch,
  CustomVendorContract,
  CustomVendorErrorCode,
  ProviderSelection,
  RouteRequest,
  RouteResponse,
  customVendorCreate,
  customVendorUpdate,
} from '@tenon-app/contracts'
import { CUSTOM_PROVIDER_ID_PATTERN } from '@tenon-app/kernel'
import type { HostAdapter } from '@tenon-app/kernel'
import { endpointOf } from '../endpoint.js'
import {
  countProviderSettingsWrite,
  readConfig,
  withConfigLock,
  writeConfigHeld,
} from '../host/profile.js'
import { providerSecretKey } from '../provider.js'
import { checkAddress } from './address.js'
import { presetEndpoint } from './presets.js'
import { instanceDefinition } from './registry.js'

export interface CustomVendorStoreDeps {
  readonly host: HostAdapter
  readonly log: (line: string) => void
  /** A lowercase canonical UUID (main: `randomUUID`); the new instance's id is `custom-<uuid>` (T1). */
  readonly uuid: () => string
}

export type CreateRequest = RouteRequest<typeof customVendorCreate>
export type CreateResult = RouteResponse<typeof customVendorCreate>
export type UpdateRequest = RouteRequest<typeof customVendorUpdate>
export type WriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: CustomVendorErrorCode }

/** The one secret an instance declares (§实例描述与通用工厂 `configKeys`). */
const API_KEY = 'apiKey'

const SAVED: WriteResult = { ok: true }

/**
 * `customVendor.create` (§写入规则「新建」; §IPC): the address checked — a preset's looked up here, by
 * preset, region and wire — then the id minted, the key stored when there is one, the entry added.
 * A refusal changes nothing. A failed `config.json` write deletes the key it stored and throws.
 */
export function createCustomVendor(
  deps: CustomVendorStoreDeps,
  request: CreateRequest,
): Promise<CreateResult> {
  const { host, log } = deps
  return withConfigLock(host.identity, async () => {
    const source = request.source
    const address =
      source.kind === 'preset'
        ? presetEndpoint(source.presetId, source.regionId, request.wire)
        : source.baseURL
    if (address === null) return refused('invalid-address')
    const check = checkAddress(address, request.wire)
    if (!check.ok) return refused(check.code)
    // What is stored must fit the schema it is read back through (`customVendorSchema.baseURL`), or
    // the next read would drop the whole instance: normalising can lengthen what was typed. Only a
    // new entry is held to it; one already stored is judged by §地址校验 rules 1–5 alone (§存储).
    if (check.baseURL.length > PROVIDER_VALUE_MAX_LENGTH) return refused('invalid-address')
    const apiKey = request.apiKey.trim()
    // §key: a public instance needs one; a loopback or private one may go without (推出的读法 7).
    if (apiKey === '' && endpointOf(check.baseURL)?.reach === 'public') {
      return refused('key-required')
    }

    const config = await readConfig(host.fs, host.identity)
    const id = mint(deps.uuid, config.customVendors)
    const entry: CustomVendorContract = {
      id,
      displayName: request.displayName.trim(),
      wire: request.wire,
      baseURL: check.baseURL,
      // Only for a preset source (§IPC): what it was created from, shown and never trusted.
      ...(source.kind === 'preset' ? { presetId: source.presetId } : {}),
      models: [],
    }
    const name = providerSecretKey(host, id, API_KEY)
    if (apiKey !== '') {
      try {
        await host.secrets.set(name, apiKey)
      } catch {
        log(`[custom-vendor] ${id}: the keychain did not store the new instance's key`)
        return refused('keychain')
      }
    }
    try {
      await writeConfigHeld(host.fs, host.identity, {
        customVendors: [...config.customVendors, entry],
      })
    } catch (error) {
      if (apiKey !== '') {
        try {
          await host.secrets.delete(name)
        } catch {
          // An orphan under an id nothing will mint again (推出的读法 9): the id only.
          log(
            `[custom-vendor] ${id}: the key of an instance that was not saved could not be removed`,
          )
        }
      }
      throw error
    }
    return { ok: true, id }
  })
}

/**
 * `customVendor.update` (§写入规则「改名与模型」): the name and the rows, nothing else (T2). A row kept
 * by id keeps its snapshot unless its output limit changed (推出的读法 20); a new row has none; a
 * removed row's snapshot goes with it, and so does a new-session default that named it (推出的读法 41).
 */
export function updateCustomVendor(
  deps: CustomVendorStoreDeps,
  request: UpdateRequest,
): Promise<WriteResult> {
  const { host } = deps
  return withConfigLock(host.identity, async () => {
    const config = await readConfig(host.fs, host.identity)
    const index = config.customVendors.findIndex((entry) => entry.id === request.id)
    const before = config.customVendors[index]
    if (before === undefined) return refused('not-found')
    const models =
      request.models === undefined
        ? before.models
        : request.models.map((row) => {
            const old = before.models.find((candidate) => candidate.id === row.id)
            const probe = old?.maxOutputTokens === row.maxOutputTokens ? old.probe : undefined
            return {
              id: row.id,
              contextLimit: row.contextLimit,
              maxOutputTokens: row.maxOutputTokens,
              ...(probe === undefined ? {} : { probe }),
            }
          })
    const kept = new Set(models.map((row) => row.id))
    const entry: CustomVendorContract = {
      ...before,
      ...(request.displayName === undefined ? {} : { displayName: request.displayName.trim() }),
      models,
    }
    await writeConfigHeld(host.fs, host.identity, {
      customVendors: config.customVendors.with(index, entry),
      ...withoutDefaults(config, (s) => s.id === before.id && !kept.has(s.modelId)),
    })
    return SAVED
  })
}

/**
 * `customVendor.delete` (§写入规则「删除」, T8): every secret the instance declares deleted, whatever
 * is stored — a failure refuses the whole delete with `config.json` untouched — then the entry
 * removed, and with it every new-session default that named the instance (推出的读法 41). Deleting
 * the key is what disables it (「先失效再删 key」, 推出的读法 11).
 */
export function deleteCustomVendor(deps: CustomVendorStoreDeps, id: string): Promise<WriteResult> {
  return withConfigLock(deps.host.identity, () => deleteCustomVendorHeld(deps, id))
}

/** `deleteCustomVendor`, whose caller already holds the profile's lock (the delete route). */
export async function deleteCustomVendorHeld(
  deps: Pick<CustomVendorStoreDeps, 'host' | 'log'>,
  id: string,
): Promise<WriteResult> {
  const { host, log } = deps
  const config = await readConfig(host.fs, host.identity)
  const entry = config.customVendors.find((candidate) => candidate.id === id)
  if (entry === undefined) return refused('not-found')
  const secrets = instanceDefinition(entry).configKeys.filter((key) => key.secret)
  try {
    await Promise.all(
      secrets.map((key) => host.secrets.delete(providerSecretKey(host, id, key.name))),
    )
  } catch {
    log(`[custom-vendor] ${id}: the keychain could not delete the key; nothing was deleted`)
    return refused('keychain')
  }
  await writeConfigHeld(host.fs, host.identity, {
    customVendors: config.customVendors.filter((candidate) => candidate.id !== id),
    ...withoutDefaults(config, (s) => s.id === id),
  })
  return SAVED
}

/** `saveCustomVendorKeyHeld` in the profile's lock. */
export function saveCustomVendorKey(
  deps: Pick<CustomVendorStoreDeps, 'host'>,
  id: string,
  apiKey: string,
): Promise<WriteResult> {
  return withConfigLock(deps.host.identity, () => saveCustomVendorKeyHeld(deps, id, apiKey))
}

/**
 * Saving an instance's key (§写入规则「保存实例的 key」, T3; `provider.configure`'s instance branch,
 * whose caller already holds the lock): every row's snapshot cleared in `config.json`, then the key
 * stored — or deleted, when what was typed is blank — and then, done or failed, one more change of
 * the instance's settings counted (推出的读法 12), so a probe begun before this save never keeps its
 * result (M6 不变量 12). A failed keychain write throws, the snapshots already gone.
 */
export async function saveCustomVendorKeyHeld(
  deps: Pick<CustomVendorStoreDeps, 'host'>,
  id: string,
  apiKey: string,
): Promise<WriteResult> {
  const { host } = deps
  const config = await readConfig(host.fs, host.identity)
  const index = config.customVendors.findIndex((entry) => entry.id === id)
  const entry = config.customVendors[index]
  if (entry === undefined) return refused('not-found')
  if (entry.models.some((row) => row.probe !== undefined)) {
    const cleared = entry.models.map(({ probe: _probe, ...row }) => row)
    await writeConfigHeld(host.fs, host.identity, {
      customVendors: config.customVendors.with(index, { ...entry, models: cleared }),
    })
  }
  const name = providerSecretKey(host, id, API_KEY)
  const value = apiKey.trim()
  try {
    // Blank deletes it, as `provider.configure` does for every provider.
    if (value === '') await host.secrets.delete(name)
    else await host.secrets.set(name, value)
  } finally {
    countProviderSettingsWrite(host.identity, id)
  }
  return SAVED
}

/**
 * `custom-<uuid>`, never one `customVendors` holds (T1). A UUID source that draws anything but a
 * lowercase canonical UUID is a bug, not a state to store.
 */
function mint(uuid: () => string, taken: readonly CustomVendorContract[]): string {
  const id = `custom-${uuid()}`
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(id) || taken.some((entry) => entry.id === id)) {
    throw new Error('custom vendor: the UUID source drew an unusable instance id')
  }
  return id
}

/**
 * The patch that clears `provider` and the profiles' new-session defaults where they name what is
 * going away (§写入规则「删除」): `provider: null`, the profile's key removed. Empty when none does.
 */
function withoutDefaults(
  config: Config,
  names: (selection: ProviderSelection) => boolean,
): ConfigPatch {
  const patch: ConfigPatch = {}
  if (config.provider !== null && names(config.provider)) patch.provider = null
  const defaults = Object.entries(config.defaultModelByProfile)
  const kept = defaults.filter(([, selection]) => selection === undefined || !names(selection))
  if (kept.length !== defaults.length) patch.defaultModelByProfile = Object.fromEntries(kept)
  return patch
}

function refused(code: CustomVendorErrorCode): { ok: false; code: CustomVendorErrorCode } {
  return { ok: false, code }
}
