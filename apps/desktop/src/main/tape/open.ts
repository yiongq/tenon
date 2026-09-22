import type { HostIdentity, TapeStore } from '@tenon-app/kernel'
import { createSqliteTapeStore } from './sqlite-store.js'

/**
 * Opening `<profileDir>/sessions.db` at startup.
 *
 * `createSqliteTapeStore` refuses two on-disk states outright — a file belonging to another tenant
 * (`TapeTenantMismatchError`) and one written by a newer build (`TapeSchemaVersionError`) — and it
 * refuses them WITHOUT writing a byte. The spec does not say what the window should then do, so
 * this takes the smallest honest behaviour: the app still starts, the cause is logged, no data is
 * touched, and the chat and session routes answer `null` / a terminal `error` instead of a reply.
 * Refusing to start would also refuse the settings and the menus the user needs to resolve it; an
 * empty transcript with no message would be worse still, because it looks like data loss.
 */
export interface OpenSessionStoreOptions {
  readonly identity: HostIdentity
  /** The host clock, for the two timestamps that are not data on a fact. */
  readonly now: () => number
  readonly log: (line: string) => void
}

export function openSessionStore(options: OpenSessionStoreOptions): TapeStore | null {
  try {
    return createSqliteTapeStore({ identity: options.identity, now: options.now })
  } catch (error) {
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    options.log(`[tape] sessions.db could not be opened, conversations will not persist: ${cause}`)
    return null
  }
}
