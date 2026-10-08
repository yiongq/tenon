import { isDeepStrictEqual } from 'node:util'
import type { AbsolutePath, HostFs, HostIdentity } from '@tenon-app/kernel'
import {
  CUSTOM_PROVIDER_ID_PATTERN,
  PROFILE_CONFIG_FILE,
  PROFILE_SUBDIRS,
  joinPath,
  profileDirFor,
} from '@tenon-app/kernel'
import type { Config, ConfigPatch, CustomVendorContract } from '@tenon-app/contracts'
import { configSchema, customVendorSchema, mcpServerSchema } from '@tenon-app/contracts'

/**
 * Creates `<root>/profiles/<userId>/<tenantId>/` with its phase-0 sub-directories
 * and returns the identity the kernel will run under.
 */
export async function openProfile(
  fs: HostFs,
  root: AbsolutePath,
  userId: string,
  tenantId: string,
): Promise<HostIdentity> {
  const profileDir = profileDirFor(root, userId, tenantId)
  await fs.mkdirp(profileDir)
  await Promise.all(PROFILE_SUBDIRS.map((sub) => fs.mkdirp(joinPath(profileDir, sub))))
  return { userId, tenantId, profileDir }
}

export function configPath(identity: HostIdentity): AbsolutePath {
  return joinPath(identity.profileDir as AbsolutePath, PROFILE_CONFIG_FILE)
}

/**
 * Missing or unreadable config falls back to defaults; a corrupt file is not fatal.
 *
 * M6 §存储: `customVendors` is read entry by entry (`readCustomVendors`), and `providerConfig`'s
 * entries under an instance id are dropped (`withoutInstanceSettings`).
 */
export async function readConfig(
  fs: HostFs,
  identity: HostIdentity,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<Config> {
  const path = configPath(identity)
  if ((await fs.stat(path)) === null) return configSchema.parse({})
  let raw: unknown
  try {
    raw = JSON.parse((await fs.readFile(path, { encoding: 'utf8' })) as string)
  } catch {
    return configSchema.parse({})
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return configSchema.parse({})
  const { customVendors, mcpServers, ...rest } = raw as Record<string, unknown>
  const parsed = configSchema.safeParse(rest)
  const config = parsed.success ? parsed.data : fieldwise(rest)
  return {
    ...config,
    providerConfig: withoutInstanceSettings(config.providerConfig),
    customVendors: readCustomVendors(customVendors, log),
    mcpServers: readMcpServers(mcpServers, log),
  }
}

function readMcpServers(value: unknown, log: (line: string) => void): Config['mcpServers'] {
  if (!Array.isArray(value)) return []
  const kept: Config['mcpServers'] = []
  const seen = new Set<string>()
  value.forEach((entry, index) => {
    const parsed = mcpServerSchema.safeParse(entry)
    if (!parsed.success || seen.has(parsed.data.id)) {
      log(
        `[config] mcpServers[${index}] dropped: ${parsed.success ? 'duplicate-id' : 'invalid-schema'}`,
      )
      return
    }
    seen.add(parsed.data.id)
    kept.push(parsed.data)
  })
  return kept
}

/**
 * `providerConfig` with no entry under an instance id. An instance's address is its description's
 * alone (M6 §注册表视图; 推出的读法 3; M6 不变量 3), so the key binding, `provider.list`'s endpoint,
 * `endpointOrigin` and the data-flow check all fall back to the declared default. Applied on read and
 * on write alike — whichever route writes, such an entry reaches neither the file nor a watcher.
 */
function withoutInstanceSettings(
  providerConfig: Config['providerConfig'],
): Config['providerConfig'] {
  return Object.fromEntries(
    Object.entries(providerConfig).filter(([id]) => !CUSTOM_PROVIDER_ID_PATTERN.test(id)),
  )
}

/**
 * `config.json`'s `customVendors`, one entry at a time (M6 §存储; 推出的读法 13). Whole-field
 * fallback would let one bad entry cost every instance, and the next write persist that. So: a row
 * whose id has surrounding whitespace is dropped (Revisions 2026-10-02: a hand edit costs that row,
 * not the instance and its key binding), a repeated model id keeps its first row, an entry the schema
 * refuses is dropped, a repeated instance id keeps its first entry. The log names the entry's index
 * and what failed — schema paths and issue codes only, never a value, so never an address.
 *
 * An address that fails §地址校验 is NOT dropped here: the registry view keeps such an instance and
 * reads it as not configured (`custom-vendors/registry.ts`).
 */
function readCustomVendors(value: unknown, log: (line: string) => void): CustomVendorContract[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    log('[config] customVendors is not a list; read as none')
    return []
  }
  const kept: CustomVendorContract[] = []
  const ids = new Set<string>()
  value.forEach((entry: unknown, index) => {
    const parsed = customVendorSchema.safeParse(readableRows(entry, index, log))
    if (!parsed.success) {
      const reasons = parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(entry)'}: ${issue.code}`,
      )
      log(`[config] customVendors[${index}] dropped (${reasons.join('; ')})`)
      return
    }
    if (ids.has(parsed.data.id)) {
      log(`[config] customVendors[${index}] dropped (its id repeats an earlier entry)`)
      return
    }
    ids.add(parsed.data.id)
    kept.push(parsed.data)
  })
  return kept
}

/**
 * An entry with each model id's first row only, and no row whose id has surrounding whitespace (the
 * schema refuses one, which would drop the whole entry); anything else is left for the schema.
 */
function readableRows(entry: unknown, index: number, log: (line: string) => void): unknown {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
  const models = (entry as Record<string, unknown>)['models']
  if (!Array.isArray(models)) return entry
  const seen = new Set<string>()
  let padded = 0
  const rows = models.filter((row: unknown) => {
    const id =
      typeof row === 'object' && row !== null ? (row as Record<string, unknown>)['id'] : undefined
    if (typeof id !== 'string') return true
    if (id !== id.trim()) {
      padded += 1
      return false
    }
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  if (padded > 0) {
    log(
      `[config] customVendors[${index}]: ${padded} row(s) dropped (id has surrounding whitespace)`,
    )
  }
  return { ...entry, models: rows }
}

/**
 * One bad field costs that field, not the file.
 *
 * Whole-object rejection was survivable while every setting was a scalar, but `provider` is
 * all-or-nothing (`{ id, modelId }`), so a half-written or hand-edited entry would drop the
 * language and the sidebar state too — and the next save would persist those defaults over what
 * the user had chosen. Each declared key is validated on its own and the failures fall back to
 * their declared defaults; an unknown key is dropped, as the schema always did.
 */
function fieldwise(raw: unknown): Config {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return configSchema.parse({})
  const source = raw as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(configSchema.shape)) {
    const value = source[name]
    if (value !== undefined && field.safeParse(value).success) kept[name] = value
  }
  return configSchema.parse(kept)
}

/**
 * One lock per profile (spec 02 01 修补 6「key 绑定主机」): `provider.configure` and every
 * `writeConfig` run through it one at a time, so a key and the base URL it is bound to are always
 * saved as a pair, and two saves never interleave a read and a write.
 */
const configLocks = new Map<string, Promise<unknown>>()
/** Per profile, like the lock: the writes counted so far, and who hears of the next one. */
const generations = new Map<string, number>()
/** Per profile, then per provider: the writes so far that changed that provider's settings. */
const settingsGenerations = new Map<string, Map<string, number>>()
const watchers = new Map<string, Set<(config: Config) => void>>()

export function withConfigLock<T>(identity: HostIdentity, work: () => Promise<T>): Promise<T> {
  const key = identity.profileDir
  const before = configLocks.get(key) ?? Promise.resolve()
  const run = before.then(work, work)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  configLocks.set(key, settled)
  void settled.then(() => {
    if (configLocks.get(key) === settled) configLocks.delete(key)
  })
  return run
}

/** Writes a patch under the profile's lock. */
export function writeConfig(
  fs: HostFs,
  identity: HostIdentity,
  patch: ConfigPatch,
): Promise<Config> {
  return withConfigLock(identity, () => writeConfigHeld(fs, identity, patch))
}

/** Writes a patch; the caller already holds the profile's lock (`withConfigLock`). */
export async function writeConfigHeld(
  fs: HostFs,
  identity: HostIdentity,
  patch: ConfigPatch,
): Promise<Config> {
  // An explicit `undefined` in the patch means "leave it alone", not "reset to default".
  const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
  const previous = await readConfig(fs, identity)
  const merged = configSchema.parse({ ...previous, ...changes })
  // M6 不变量 3: what the file, the counts below and the watchers see, never only what a read sees.
  const next = { ...merged, providerConfig: withoutInstanceSettings(merged.providerConfig) }
  await replaceConfigFile(fs, configPath(identity), `${JSON.stringify(next, null, 2)}\n`)
  // Counted once the file holds it, and never before: a reader that saw the old generation before
  // its read and the same one after cannot have read a key a later save stored (`configGeneration`).
  const key = identity.profileDir
  generations.set(key, configGeneration(identity) + 1)
  const moved = settingsGenerations.get(key) ?? new Map<string, number>()
  settingsGenerations.set(key, moved)
  for (const id of new Set([
    ...Object.keys(previous.providerConfig),
    ...Object.keys(next.providerConfig),
  ])) {
    if (!sameSettings(previous.providerConfig[id], next.providerConfig[id])) {
      moved.set(id, (moved.get(id) ?? 0) + 1)
    }
  }
  // M6 §写入规则: a write that changed an instance's entry — created, renamed, its rows or their
  // snapshots changed, deleted — counts as a change of that instance's settings.
  const vendorsBefore = new Map(previous.customVendors.map((entry) => [entry.id, entry]))
  const vendorsAfter = new Map(next.customVendors.map((entry) => [entry.id, entry]))
  for (const id of new Set([...vendorsBefore.keys(), ...vendorsAfter.keys()])) {
    if (!isDeepStrictEqual(vendorsBefore.get(id), vendorsAfter.get(id))) {
      moved.set(id, (moved.get(id) ?? 0) + 1)
    }
  }
  for (const watcher of watchers.get(key) ?? []) watcher(next)
  return next
}

/** A host fs that can replace a file whole, the way `DesktopFs.replaceFile` does. */
interface ReplacingFs extends HostFs {
  replaceFile(path: AbsolutePath, data: Uint8Array | string): Promise<void>
}

/**
 * `config.json`'s every write (M6 §写入规则): a temporary file in the same directory, renamed over it,
 * so a read outside the lock sees the old file or the new one, and a write that fails partway leaves
 * the old one and its instances. The desktop host does that (`DesktopFs.replaceFile`); a host without
 * it — the memory host, which swaps a file's whole content in one step anyway — writes as it always
 * has. `HostFs.writeFile` itself is left alone: the agent's Write tool uses it too.
 */
function replaceConfigFile(fs: HostFs, path: AbsolutePath, text: string): Promise<void> {
  const replacing = fs as Partial<ReplacingFs>
  return typeof replacing.replaceFile === 'function'
    ? replacing.replaceFile(path, text)
    : fs.writeFile(path, text)
}

/**
 * One more change of a provider's settings, with no write of `config.json` (M6 §写入规则; 推出的读法
 * 12): an instance's key save counts once its keychain write is done — or has failed — whether or not
 * its entry changed, so a probe or a read that began between the two writes cannot keep what it read.
 * The caller holds the profile's lock.
 */
export function countProviderSettingsWrite(identity: HostIdentity, providerId: string): void {
  const key = identity.profileDir
  const moved = settingsGenerations.get(key) ?? new Map<string, number>()
  settingsGenerations.set(key, moved)
  moved.set(providerId, (moved.get(providerId) ?? 0) + 1)
}

/**
 * How many writes this process has made to the profile's `config.json`. A reader of `config.json`
 * and then the keychain that sees the same generation before and after read both as ONE save left
 * them: `provider.configure` stores a moved host's keys only after its config write is counted
 * (01 修补 6「key 绑定主机」: 「由上面的保存规则与锁保证 key 与地址始终配对」 — on the read side too).
 */
export function configGeneration(identity: HostIdentity): number {
  return generations.get(identity.profileDir) ?? 0
}

/**
 * How many writes this process has made that changed one provider's settings in `config.json` — the
 * part of `configGeneration` a read of that provider's keys can be unpaired by. A write of the locale,
 * the sidebar, the folder list, a default model or another provider's settings leaves it, and so does
 * a save that stores this provider's settings as they were: none of them moves the host its keys are
 * bound to (01 修补 6「key 绑定主机」; rrE-2). A count, not a comparison of values, so a save that moves
 * the host away and a second that moves it back still read as two.
 */
export function providerSettingsGeneration(identity: HostIdentity, providerId: string): number {
  return settingsGenerations.get(identity.profileDir)?.get(providerId) ?? 0
}

function sameSettings(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean {
  const left = Object.entries(a ?? {})
  const right = b ?? {}
  return left.length === Object.keys(right).length && left.every(([name, v]) => right[name] === v)
}

/** Hears every write, with what the file now holds; the returned function stops it. */
export function watchConfig(identity: HostIdentity, watcher: (config: Config) => void): () => void {
  const key = identity.profileDir
  const set = watchers.get(key) ?? new Set<(config: Config) => void>()
  watchers.set(key, set)
  set.add(watcher)
  return () => {
    set.delete(watcher)
  }
}
