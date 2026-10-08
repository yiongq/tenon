import type { McpServerView } from '@tenon-app/contracts'
/** A pending question occupies the slot; connection progress never displaces it. */
export function composerSlot(hasQuestion: boolean, servers: readonly McpServerView[]) {
  if (hasQuestion) return { kind: 'question' } as const
  const server = servers.find(
    (s) => s.enabled && !s.needsConsent && s.status.phase === 'connecting' && s.status.firstConnect,
  )
  return server ? ({ kind: 'connecting', name: server.displayName } as const) : null
}
