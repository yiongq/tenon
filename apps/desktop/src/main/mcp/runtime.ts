import { canonicalJson, sha256Hex } from '@tenon-app/kernel'
import type { McpServerRuntime, HostNetwork } from '@tenon-app/kernel'
import type { McpServer } from '@tenon-app/contracts'
import type { McpConsent } from './consent.js'
export const CIMD_CLIENT_METADATA_URL: string | null = null
export const DCR_REDIRECT_PORT = 53280
export function launchHash(server: Pick<McpServer, 'transport'>): string {
  const t = server.transport
  return sha256Hex(
    canonicalJson(
      t.type === 'http'
        ? { type: t.type, url: t.url }
        : {
            type: t.type,
            command: t.command,
            args: t.args,
            envs: t.envs,
            env_keys: t.env_keys.toSorted(),
          },
    ),
  )
}
export function mcpRuntimes(
  servers: readonly McpServer[],
  consent: McpConsent,
  fetchFor: (url: string) => HostNetwork['fetch'],
): McpServerRuntime[] {
  return servers.flatMap((server, rank) => {
    if (!server.enabled) return []
    const hash = launchHash(server)
    const t = server.transport
    return [
      {
        serverId: server.id,
        launchHash: hash,
        consented: server.consent?.launchHash === hash || consent.matches(server.id, hash),
        transport:
          t.type === 'stdio'
            ? { type: 'stdio', command: t.command, args: t.args, envs: t.envs, envKeys: t.env_keys }
            : {
                type: 'http',
                url: t.url,
                fetch: fetchFor(t.url),
                protocol: t.protocol,
                headerKeys: t.header_keys,
                oauth: {
                  ...t.oauth,
                  clientMetadataUrl: CIMD_CLIENT_METADATA_URL,
                  dcrRedirectPort: DCR_REDIRECT_PORT,
                },
              },
        handshakeTimeoutMs: (server.handshakeTimeoutSec ?? 30) * 1000,
        callTimeoutMs: (server.callTimeoutSec ?? 60) * 1000,
        rank,
        toolsPinned: server.toolsPinned,
        pins: Object.fromEntries(
          Object.entries(server.tools).map(([name, tool]) => [name, tool.definitionHash]),
        ),
        instructions: server.instructions,
      },
    ]
  })
}
