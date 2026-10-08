import { createMcpPool } from '@tenon-app/kernel'
import type { AbsolutePath, HostAdapter, McpPool, SchemaValidatorPort } from '@tenon-app/kernel'
import type { Config } from '@tenon-app/contracts'
import { watchConfig } from '../host/profile.js'
import { createMcpConsent } from './consent.js'
import { mcpRuntimes, launchHash } from './runtime.js'
import { createMcpStore } from './store.js'
import { createMcpFetch } from './fetch.js'
import { createMcpLogSink } from './log-sink.js'
import { resolveMcpCommand } from './resolve-command.js'
import { mcpUserSetting } from './user-setting.js'
export function createDesktopMcp(q: {
  host: HostAdapter
  config: Config
  home: AbsolutePath
  baseEnv: () => Promise<Readonly<Record<string, string>>>
  uuid: () => string
  changed: () => void
  schemaValidator: SchemaValidatorPort & { close(): Promise<void> }
}) {
  let config = q.config
  const logs = createMcpLogSink(q.host.identity)
  let pool: McpPool
  const fetchFor = (url: string) => createMcpFetch(url, q.host.network)
  const consent = createMcpConsent(() => apply(config.mcpServers))
  const store = createMcpStore({
    host: q.host,
    consent,
    pool: () => pool,
    apply: (servers) => apply(servers),
    log: (line) => console.warn(line),
  })
  function runtimes(servers = config.mcpServers) {
    return mcpRuntimes(
      servers.filter((s) => !store.isDeleting(s.id)),
      consent,
      fetchFor,
    )
  }
  function apply(servers: Config['mcpServers'] | readonly Config['mcpServers'][number][]) {
    pool.apply(runtimes([...servers]))
  }
  pool = createMcpPool({
    host: q.host,
    ids: { uuid: q.uuid },
    baseEnv: q.baseEnv,
    homeDir: q.home,
    schemaValidator: q.schemaValidator,
    resolveCommand: resolveMcpCommand,
    runtimeOf: (id) => runtimes().find((s) => s.serverId === id) ?? null,
    log: (id, line) => {
      void logs.append(id, line)
    },
    onPin: async (id, pin) => {
      if (!(await store.pin(id, pin.tools)).ok) throw new Error('MCP server retired')
    },
    onIssuer: async (id, issuer, kind) => {
      if (!(await store.recordIssuer(id, issuer, kind)).ok) throw new Error('MCP server retired')
    },
    onChange: q.changed,
  })
  const unwatch = watchConfig(q.host.identity, (next) => {
    const changed = JSON.stringify(config.mcpServers) !== JSON.stringify(next.mcpServers)
    config = next
    if (changed) apply(config.mcpServers)
    q.changed()
  })
  apply(config.mcpServers)
  return {
    pool,
    store,
    logs,
    config: () => config,
    consent,
    needsConsent: (id: string) => {
      const server = config.mcpServers.find((s) => s.id === id)
      return (
        !!server?.enabled &&
        server.consent?.launchHash !== launchHash(server) &&
        !consent.matches(id, launchHash(server))
      )
    },
    userSetting: mcpUserSetting(
      () => config.mcpServers,
      () => pool.status(),
    ),
    async close(options: { deadlineMs: number }) {
      unwatch()
      await Promise.all([pool.close(options), q.schemaValidator.close()])
      await logs.close()
    },
  }
}
export type DesktopMcp = ReturnType<typeof createDesktopMcp>
