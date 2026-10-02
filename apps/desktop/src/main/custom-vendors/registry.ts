/**
 * The provider registry main hands out (M6 §注册表视图; 推出的读法 2): the builtin registry, then the
 * custom vendor instances of `config.json`'s `customVendors`, each made by the kernel's generic
 * factory from the entry as it stands. 01's `ProviderRegistry` is not amended — no `unregister`, no
 * `replace`: the kernel loop never reads a registry, and desktop and the evals are its only users.
 *
 * The snapshot follows run-assembly's `stored` (run-assembly.ts:87-94): startup's read, then every
 * write as `watchConfig` hears it, so creating, renaming, changing the rows of or deleting an
 * instance takes effect without a restart. The builtin entries keep their order and content;
 * instances come after them, in `customVendors`'s order.
 */
import type {
  Config,
  CustomVendorContract,
  ProviderRefusal,
  ProviderWriteErrorCode,
} from '@tenon-app/contracts'
import {
  CUSTOM_PROVIDER_ID_PATTERN,
  ProviderConfigMissingError,
  ProviderInvalidArgumentError,
  customVendorDefinition,
} from '@tenon-app/kernel'
import type {
  CustomModelRow,
  HostIdentity,
  ProviderDefinition,
  ProviderId,
  ProviderRegistry,
} from '@tenon-app/kernel'
import { endpointOf } from '../endpoint.js'
import type { Reach } from '../endpoint.js'
import { watchConfig } from '../host/profile.js'
import { checkAddress } from './address.js'

/** Every instance id starts with it (T1); `register()` refuses it for anything else. */
const CUSTOM_ID_PREFIX = 'custom-'

export interface ProviderViewOptions {
  /** The builtin definitions; `register()` goes to it. */
  readonly builtin: ProviderRegistry
  /** Whose `config.json` is watched. */
  readonly identity: HostIdentity
  /** `config.json` as main read it at startup; without it, no instance until the first write. */
  readonly config?: Config
}

export function createProviderView(options: ProviderViewOptions): ProviderRegistry {
  const { builtin } = options
  let entries: readonly CustomVendorContract[] = options.config?.customVendors ?? []
  /** The definitions of `entries`, made on first use after each change. */
  let made: Map<ProviderId, ProviderDefinition> | null = null
  watchConfig(options.identity, (config) => {
    entries = config.customVendors
    made = null
  })
  const instances = (): Map<ProviderId, ProviderDefinition> => {
    if (made === null) {
      made = new Map()
      for (const entry of entries) {
        if (!made.has(entry.id)) made.set(entry.id, instanceDefinition(entry))
      }
    }
    return made
  }
  return {
    register(definition): void {
      // An instance exists only as a `customVendors` entry: a definition registered under its id
      // would outlive the entry's deletion and shadow nothing the settings card can see.
      if (definition.id.startsWith(CUSTOM_ID_PREFIX)) {
        throw new ProviderInvalidArgumentError(
          `provider id "${definition.id}" is reserved for custom vendor instances`,
        )
      }
      builtin.register(definition)
    },
    get(id): ProviderDefinition | null {
      return builtin.get(id) ?? instances().get(id) ?? null
    },
    list(): ProviderDefinition[] {
      return [...builtin.list(), ...instances().values()]
    },
  }
}

/**
 * An instance's definition, made from its `config.json` entry by the kernel's factory
 * (§实例描述与通用工厂). `keyRequired` is false only for a loopback or private address (§key). An
 * address that fails §地址校验 still gets its definition — it is listed, and its rows answer — but
 * `create()` throws `ProviderConfigMissingError`, so nothing is ever sent to it (§存储; M6 不变量 3).
 */
export function instanceDefinition(entry: CustomVendorContract): ProviderDefinition {
  const definition = customVendorDefinition({
    id: entry.id,
    wire: entry.wire,
    baseURL: entry.baseURL,
    keyRequired: instanceReach(entry) === 'public',
    models: entry.models.map(instanceRow),
  })
  if (instanceRefusal(entry) === null) return definition
  return {
    ...definition,
    create() {
      throw new ProviderConfigMissingError(entry.id, 'a base URL that passes the address checks')
    },
  }
}

/**
 * Why an instance's stored address is refused (§存储; `providerRefusalSchema`'s address codes), or
 * null when it passes §地址校验 rules 1–5 — those alone, not the length a new entry is held to.
 */
export function instanceRefusal(
  entry: Pick<CustomVendorContract, 'baseURL' | 'wire'>,
): ProviderRefusal | null {
  const check = checkAddress(entry.baseURL, entry.wire)
  return check.ok ? null : { code: check.code }
}

/**
 * Where an instance's address points, by spelling (Q7; `reachOf`): `loopback` and `private` are the
 * instances that may go without a key (§key), send no tools and are never probed (§回环与私网). An
 * address that does not parse reads as public — it is refused anyway (§存储).
 */
export function instanceReach(entry: Pick<CustomVendorContract, 'baseURL'>): Reach {
  return endpointOf(entry.baseURL)?.reach ?? 'public'
}

/** A `config.json` model row as the kernel's factory and probe take it. */
export function instanceRow(row: CustomVendorContract['models'][number]): CustomModelRow {
  return {
    id: row.id,
    contextLimit: row.contextLimit,
    maxOutputTokens: row.maxOutputTokens,
    ...(row.probe === undefined ? {} : { probe: row.probe }),
  }
}

/** Whether a provider id names a custom vendor instance (T1) rather than a builtin. */
export function isInstanceId(id: string): boolean {
  return CUSTOM_PROVIDER_ID_PATTERN.test(id)
}

/**
 * Why a choice of an instance's row cannot be written (§列表与上限; 验收 12, 25): the instance or its
 * row is not in `config` — `config.json` as read inside the profile's lock, so a delete or a row
 * removal that held the lock first is seen. A choice that went through anyway would put back the
 * new-session default the delete just cleared. null for a builtin id, or a row the instance lists.
 */
export function instanceChoiceRefusal(
  config: Config,
  providerId: string,
  modelId: string,
): Extract<ProviderWriteErrorCode, 'unknown-provider' | 'unknown-model'> | null {
  if (!isInstanceId(providerId)) return null
  const entry = config.customVendors.find((candidate) => candidate.id === providerId)
  if (entry === undefined) return 'unknown-provider'
  return entry.models.some((row) => row.id === modelId) ? null : 'unknown-model'
}
