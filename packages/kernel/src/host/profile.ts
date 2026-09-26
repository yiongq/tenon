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

/** The profile directory's folder for large tool outputs (spec 02 §本地持久化布局：只加一行). */
export const TOOL_OUTPUT_DIR = 'tool-output'

/**
 * `<profileDir>/tool-output/<sessionId>` — one session's spilled outputs (H9). The session id is a
 * canonical UUID and is used as the folder name as it is; the folder is made on the first spill.
 */
export function toolOutputDirFor(profileDir: AbsolutePath, sessionId: string): AbsolutePath {
  return joinPath(profileDir, TOOL_OUTPUT_DIR, sessionId)
}
