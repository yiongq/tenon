import type { AbsolutePath, HostFs, HostIdentity } from '@tenon-app/kernel'
import { PROFILE_CONFIG_FILE, PROFILE_SUBDIRS, joinPath, profileDirFor } from '@tenon-app/kernel'
import type { Config, ConfigPatch } from '@tenon-app/contracts'
import { configSchema } from '@tenon-app/contracts'

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

/** Missing or unreadable config falls back to defaults; a corrupt file is not fatal. */
export async function readConfig(fs: HostFs, identity: HostIdentity): Promise<Config> {
  const path = configPath(identity)
  if ((await fs.stat(path)) === null) return configSchema.parse({})
  let raw: unknown
  try {
    raw = JSON.parse((await fs.readFile(path, { encoding: 'utf8' })) as string)
  } catch {
    return configSchema.parse({})
  }
  const parsed = configSchema.safeParse(raw)
  return parsed.success ? parsed.data : fieldwise(raw)
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
  const next = configSchema.parse({ ...previous, ...changes })
  await fs.writeFile(configPath(identity), `${JSON.stringify(next, null, 2)}\n`)
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
  for (const watcher of watchers.get(key) ?? []) watcher(next)
  return next
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
