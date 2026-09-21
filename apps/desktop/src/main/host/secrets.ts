import { AsyncEntry } from '@napi-rs/keyring'
import type { HostSecrets } from '@tenon-app/kernel'

/** Keychain service name fixed by the spec; the account is the kernel's `keyFor` key. */
export const KEYCHAIN_SERVICE = 'com.yiongspace.tenon'

const MAX_VALUE_BYTES = 2560 // Windows CRED_MAX_CREDENTIAL_BLOB_SIZE
const MAX_ACCOUNT_CHARS = 513 // Windows CRED_MAX_USERNAME_LENGTH

/**
 * OS keychain access. Only the async binding is used: the sync one blocks the main
 * process for seconds when macOS asks the user about keychain access.
 */
export class KeychainSecrets implements HostSecrets {
  private readonly service: string

  constructor(service: string = KEYCHAIN_SERVICE) {
    this.service = service
  }

  private entry(key: string): AsyncEntry {
    if (key.length === 0) throw new TypeError('secret key must not be empty')
    if (key.length > MAX_ACCOUNT_CHARS) {
      throw new RangeError(`secret key exceeds ${MAX_ACCOUNT_CHARS} chars`)
    }
    return new AsyncEntry(this.service, key)
  }

  /**
   * `null` means absent. A rejection means the store could not be read (locked, ACL
   * denied) and must not be treated as "not configured". The binding resolves `null`
   * at runtime although it is typed `undefined`; `?? null` is load-bearing.
   */
  async get(key: string): Promise<string | null> {
    return (await this.entry(key).getPassword()) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    const bytes = new TextEncoder().encode(value).byteLength
    if (bytes > MAX_VALUE_BYTES) {
      throw new RangeError(`secret value is ${bytes} bytes, exceeds ${MAX_VALUE_BYTES}`)
    }
    await this.entry(key).setPassword(value)
  }

  async delete(key: string): Promise<void> {
    await this.entry(key).deleteCredential()
  }
}

/**
 * Secrets that live and die with this process (spec 01 §desktop 接线, 「e2e 的机密接缝」).
 *
 * The real path is the only one a packaged Tenon has, and it is the only one that survives a
 * restart — but an automated run must not be the thing that writes into a developer's login
 * keychain, and CI's Linux box has no Secret Service to write to at all. `createDesktopHost`
 * swaps this in for a dev build that asked for it, the same class of switch as `TENON_DEV_ENV=off`.
 */
export class MemorySecrets implements HostSecrets {
  readonly #values = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.#values.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    this.#values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.#values.delete(key)
  }
}
