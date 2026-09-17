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
  return parsed.success ? parsed.data : configSchema.parse({})
}

export async function writeConfig(
  fs: HostFs,
  identity: HostIdentity,
  patch: ConfigPatch,
): Promise<Config> {
  // An explicit `undefined` in the patch means "leave it alone", not "reset to default".
  const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
  const next = configSchema.parse({ ...(await readConfig(fs, identity)), ...changes })
  await fs.writeFile(configPath(identity), `${JSON.stringify(next, null, 2)}\n`)
  return next
}
