import type { AbsolutePath } from './adapter.js'
import { joinPath } from './path.js'

/** Sub-directories every profile has from day one (`sessions.db` arrives in phase 1). */
export const PROFILE_SUBDIRS = ['logs', 'mcp', 'skills', 'plugins'] as const

export const PROFILE_CONFIG_FILE = 'config.json'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Ids become directory names, so they are restricted to a safe subset. */
export function assertProfileId(kind: 'userId' | 'tenantId', value: string): void {
  if (!ID_PATTERN.test(value) || value === '.' || value === '..') {
    throw new TypeError(`${kind} "${value}" is not a valid profile id`)
  }
}

/**
 * `<root>/profiles/<userId>/<tenantId>` — one local profile per (userId, tenantId).
 * Two tenants of the same user never share a directory.
 */
export function profileDirFor(root: AbsolutePath, userId: string, tenantId: string): AbsolutePath {
  assertProfileId('userId', userId)
  assertProfileId('tenantId', tenantId)
  return joinPath(root, 'profiles', userId, tenantId)
}
