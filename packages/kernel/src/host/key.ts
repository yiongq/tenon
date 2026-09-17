import type { HostIdentity } from './adapter.js'

export const KEY_SEPARATOR = ':'

/**
 * Builds every persistence key the kernel uses. Keys are never concatenated by
 * hand: the tenantId prefix is what keeps tenants apart in shared stores such
 * as the OS keychain (account name `<tenantId>:<key>`).
 */
export function keyFor(identity: Pick<HostIdentity, 'tenantId'>, ...parts: string[]): string {
  const { tenantId } = identity
  if (tenantId.length === 0) throw new TypeError('keyFor: tenantId must not be empty')
  if (tenantId.includes(KEY_SEPARATOR)) {
    throw new TypeError(`keyFor: tenantId must not contain "${KEY_SEPARATOR}"`)
  }
  if (parts.length === 0) throw new TypeError('keyFor: at least one key part is required')
  for (const part of parts) {
    if (part.length === 0) throw new TypeError('keyFor: key parts must not be empty')
  }
  return [tenantId, ...parts].join(KEY_SEPARATOR)
}
