/** Session-local launch confirmations. Every change updates the pool immediately. */
export function createMcpConsent(changed: () => void) {
  const allowed = new Map<string, string>()
  return {
    get: (id: string) => allowed.get(id),
    restore(id: string, hash: string | undefined) {
      if (hash === undefined) allowed.delete(id)
      else allowed.set(id, hash)
      changed()
    },
    matches: (id: string, hash: string) => allowed.get(id) === hash,
    allow(id: string, hash: string) {
      allowed.set(id, hash)
      changed()
    },
    revoke(id: string) {
      allowed.delete(id)
      changed()
    },
  }
}
export type McpConsent = ReturnType<typeof createMcpConsent>
