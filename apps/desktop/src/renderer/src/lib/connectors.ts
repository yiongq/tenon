import type { McpServerView } from '@tenon-app/contracts'
export const TOOL_SETTING_KEY = {
  'always-allow': 'mcp.always',
  ask: 'mcp.ask',
  never: 'mcp.never',
} as const
export const MCP_EFFECTIVE_NEXT = 'mcp.nextSession' as const
export const MCP_NEVER_NOTE = 'mcp.neverNote' as const
export const MCP_ACTIONS = [
  'log',
  'restart',
  'refresh',
  'login',
  'revoke',
  'edit',
  'delete',
] as const
export function toolSettings(tool: McpServerView['toolViews'][number]) {
  return (['always-allow', 'ask', 'never'] as const).filter(
    (setting) => setting !== 'always-allow' || tool.alwaysAllowOffered,
  )
}
export const CONNECTOR_STATUSES = [
  'disabled',
  'needs-consent',
  'crash-limit',
  'stopped',
  'connecting',
  'connected',
  'restarting',
  'error',
  'unauthorized',
] as const
export function connectorStatus(server: McpServerView): (typeof CONNECTOR_STATUSES)[number] {
  if (!server.enabled) return 'disabled'
  if (server.needsConsent) return 'needs-consent'
  if (server.status.phase === 'stopped' && server.status.stopReason === 'crash-limit')
    return 'crash-limit'
  return server.status.phase
}
export function unavailableKey(
  value: NonNullable<McpServerView['toolViews'][number]['unavailable']>,
) {
  return `mcp.unavailable.${value}` as const
}
export function draftOf(server: McpServerView) {
  const transport =
    server.transport.type === 'stdio'
      ? server.transport
      : {
          ...server.transport,
          oauth: {
            ownClient: server.transport.oauth.ownClient
              ? {
                  clientId: server.transport.oauth.ownClient.clientId,
                  redirectPort: server.transport.oauth.ownClient.redirectPort,
                  hasSecret: server.transport.oauth.ownClient.hasSecret,
                }
              : null,
          },
        }
  return {
    id: server.id,
    displayName: server.displayName,
    source: server.source,
    transport,
    handshakeTimeoutSec: server.handshakeTimeoutSec,
    callTimeoutSec: server.callTimeoutSec,
    instructions: { enabled: server.instructions.enabled },
  }
}

export function reorderConnector(ids: readonly string[], from: string, target: string): string[] {
  const source = ids.indexOf(from),
    destination = ids.indexOf(target)
  if (source < 0 || destination < 0 || source === destination) return [...ids]
  const next = ids.filter((id) => id !== from)
  next.splice(destination, 0, from)
  return next
}
