import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  builtinCandidates,
  PRODUCT_BUILTINS,
  mcpCandidates,
  openToolTable,
  definitionProblem,
  canonicalJson,
  joinPath,
} from '@tenon-app/kernel'
import type {
  HostAdapter,
  ProviderRegistry,
  McpServerStatus,
  AbsolutePath,
} from '@tenon-app/kernel'
import {
  registerRoute,
  RISKY_ENV_NAMES,
  RISKY_ENV_PREFIX,
  mcpList,
  mcpPreview,
  mcpSave,
  mcpDelete,
  mcpSetEnabled,
  mcpReorder,
  mcpSetToolSetting,
  mcpRelease,
  mcpReviewChange,
  mcpSetInstructions,
  mcpConnect,
  mcpRestart,
  mcpRevoke,
  mcpRefreshTools,
  mcpLogin,
  mcpCancelLogin,
  mcpReadLog,
} from '@tenon-app/contracts'
import type { IpcMainLike, McpDraft, McpWarning, McpServerView } from '@tenon-app/contracts'
import type { Locale } from '../../i18n/resources.js'
import type { DesktopMcp } from './controller.js'
import { resolveMcpCommand } from './resolve-command.js'
import { listenMcpCallback, usesMcpCallbackTestPort } from './loopback.js'
import type { McpCallbackListener } from './loopback.js'
import { createMcpOpenUrl } from './open-url.js'
import { mcpAddress } from './address.js'
import { visible } from '../../renderer/src/lib/visible.js'
import { describeProvider } from '../provider-routes.js'
import { devEnv } from '../provider.js'
export function previewMcpWarnings(draft: McpDraft, home: string): McpWarning[] {
  const t = draft.transport
  if (t.type === 'http') return []
  const executable = basename(t.command)
  const args = new Set([executable, ...t.args])
  const warnings: McpWarning[] = []
  if (args.has('sudo')) warnings.push({ kind: 'sudo' })
  if (
    args.has('rm') &&
    (t.args.includes('--recursive') ||
      (/r/i.test(t.args.filter((arg) => arg.startsWith('-')).join('')) &&
        /f/i.test(t.args.filter((arg) => arg.startsWith('-')).join(''))))
  )
    warnings.push({ kind: 'rm-rf' })
  for (const arg of t.args) {
    if (arg === '~' || arg.startsWith('~/') || arg === home || arg.startsWith(home + '/'))
      warnings.push({ kind: 'home-path', arg: visible(arg) })
    if (arg.replace(/^~(?=\/|$)/, home).includes('/.ssh'))
      warnings.push({ kind: 'ssh-path', arg: visible(arg) })
  }
  if (executable === 'npx' || executable === 'uvx') {
    const pkg = t.args.find((arg) => !arg.startsWith('-'))
    if (pkg) {
      const version =
        executable === 'uvx' && pkg.includes('==')
          ? pkg.split('==').at(-1)
          : pkg.slice(pkg.lastIndexOf('@') + 1)
      if (
        (pkg.startsWith('@')
          ? pkg.lastIndexOf('@') === 0
          : !pkg.includes('@') && !pkg.includes('==')) ||
        !version ||
        version === 'latest'
      )
        warnings.push({ kind: 'unpinned-package', package: pkg })
    }
  }
  for (const name of [...Object.keys(t.envs), ...t.env_keys])
    if (
      RISKY_ENV_NAMES.some((n) => n.toUpperCase() === name.toUpperCase()) ||
      name.toLowerCase().startsWith(RISKY_ENV_PREFIX)
    )
      warnings.push({ kind: 'risky-env', name })
  return warnings
}
function prettyDefinition(value: unknown): string {
  return JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)
}
function absentStatus(id: string): McpServerStatus {
  return {
    serverId: id,
    phase: 'stopped',
    stopReason: null,
    error: null,
    firstConnect: true,
    restartInMs: null,
    era: null,
    protocolVersion: null,
    tools: null,
    instructions: null,
    loggedIn: null,
  }
}
export function registerMcpRoutes(q: {
  ipcMain: IpcMainLike
  mcp: DesktopMcp
  host: HostAdapter
  providers: ProviderRegistry
  home: AbsolutePath
  baseEnv: () => Promise<Readonly<Record<string, string>>>
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  openExternal: (url: string) => Promise<unknown>
  locale: () => Locale
}) {
  const { ipcMain, mcp } = q
  registerRoute(ipcMain, mcpList, async () => {
    const statuses = mcp.pool.status()
    // oxlint-disable-next-line oxc/no-map-spread -- immutable config is enriched for the view
    const servers: McpServerView[] = mcp.config().mcpServers.map((server) => {
      const status = statuses.find((s) => s.serverId === server.id) ?? absentStatus(server.id)
      const counts = new Map<string, number>()
      for (const tool of status.tools ?? [])
        counts.set(tool.mappedName, (counts.get(tool.mappedName) ?? 0) + 1)
      return {
        ...server,
        status,
        needsConsent: mcp.needsConsent(server.id),
        loggedIn: status.loggedIn,
        instructionsView: status.instructions
          ? {
              ...status.instructions,
              review:
                !server.instructions.enabled ||
                server.instructions.pinHash === null ||
                status.instructions.hash === server.instructions.pinHash
                  ? 'ok'
                  : 'changed',
            }
          : null,
        toolViews: (status.tools ?? []).map((tool) => {
          const raw = tool.definition as {
            description?: string
            inputSchema?: unknown
            outputSchema?: unknown
          }
          const policy = q.host.policy.current()
          const asks =
            policy.status === 'unavailable' ||
            policy.snapshot.tools.some(
              (rule) =>
                rule.serverId === server.id &&
                (rule.toolName === undefined || rule.toolName === tool.originalName) &&
                ['ask', 'deny'].includes(rule.effect),
            )
          return {
            originalName: tool.originalName,
            mappedName: tool.mappedName,
            setting: server.tools[tool.originalName]?.setting ?? 'ask',
            definitionHash: tool.definitionHash,
            review: tool.review,
            requiresUserInteraction: tool.requiresUserInteraction,
            alwaysAllowOffered: !tool.requiresUserInteraction && !asks,
            description: (raw.description ?? '').slice(0, 1024),
            unavailable:
              (counts.get(tool.mappedName) ?? 0) > 1
                ? 'name-collision'
                : definitionProblem({
                      inputSchema: raw.inputSchema,
                      outputSchema: raw.outputSchema,
                    })
                  ? 'invalid-definition'
                  : null,
          }
        }),
      }
    })
    const candidates = [
      ...builtinCandidates({
        profile: 'cowork',
        available: (name) => PRODUCT_BUILTINS.has(name),
        search: null,
      }),
      ...(await mcpCandidates(mcp.pool.routes())),
    ]
    const uncapped = openToolTable({
      providerId: 'view',
      incarnationId: randomUUID(),
      generation: 0,
      reason: 'first-use',
      candidates,
      policy: q.host.policy.current(),
      tenantId: q.host.identity.tenantId,
      userSetting: mcp.userSetting,
      hasSearchBackend: false,
      toolsPerRequest: null,
    })
    const base = uncapped.items.filter((t) => t.source === 'builtin').length
    const count = uncapped.items.length - base
    const descriptions = await Promise.all(
      q.providers.list().map((definition) =>
        describeProvider({
          host: q.host,
          definition,
          env: devEnv({ isPackaged: q.isPackaged, env: q.env }),
          log: () => {},
        }),
      ),
    )
    const configured = new Set(descriptions.filter((d) => d?.configured).map((d) => d!.id))
    const overLimit = q.providers
      .list()
      .filter((p) => configured.has(p.id))
      .flatMap((provider) => {
        const cap = provider.maxToolsPerRequest
        const omitted = cap === undefined ? 0 : Math.max(0, count - Math.max(0, cap - base))
        return omitted ? [{ providerId: provider.id, omitted }] : []
      })
    return { servers, overLimit }
  })
  registerRoute(ipcMain, mcpPreview, async ({ draft }) => {
    if (draft.transport.type === 'http') {
      const address = mcpAddress(draft.transport.url)
      return address.ok
        ? { ok: true as const, argv: [address.url], resolved: null, warnings: [] }
        : address
    }
    const base = await q.baseEnv()
    const resolved = await resolveMcpCommand(draft.transport.command, base['PATH'] ?? '')
    return {
      ok: true as const,
      argv: [draft.transport.command, ...draft.transport.args].map(visible),
      resolved: resolved.ok ? resolved.path : null,
      warnings: previewMcpWarnings(draft, q.home),
    }
  })
  registerRoute(ipcMain, mcpSave, (request) => mcp.store.save(request))
  registerRoute(ipcMain, mcpDelete, ({ id }) => mcp.store.delete(id))
  registerRoute(ipcMain, mcpSetEnabled, ({ id, enabled }) => mcp.store.setEnabled(id, enabled))
  registerRoute(ipcMain, mcpReorder, ({ ids }) => mcp.store.reorder(ids))
  registerRoute(ipcMain, mcpSetToolSetting, ({ id, tool, setting }) =>
    mcp.store.setToolSetting(id, tool, setting),
  )
  registerRoute(ipcMain, mcpRelease, ({ id, target, definitionHash }) =>
    mcp.store.release(
      id,
      'tool' in target ? { kind: 'tool', name: target.tool } : { kind: 'instructions' },
      definitionHash,
    ),
  )
  registerRoute(ipcMain, mcpSetInstructions, ({ id, enabled }) =>
    mcp.store.setInstructions(id, enabled),
  )
  registerRoute(ipcMain, mcpConnect, ({ id, consent }) => mcp.store.connect(id, consent))
  registerRoute(ipcMain, mcpRevoke, ({ id }) => mcp.store.revoke(id))
  registerRoute(ipcMain, mcpRestart, ({ id }) => {
    const restarted = mcp.pool.status().some((s) => s.serverId === id) && !mcp.needsConsent(id)
    if (restarted) mcp.pool.restart(id)
    return { restarted }
  })
  registerRoute(ipcMain, mcpRefreshTools, async ({ id }) => {
    try {
      await mcp.pool.refreshTools(id)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })
  registerRoute(ipcMain, mcpReadLog, ({ id }) => mcp.logs.read(id))
  registerRoute(ipcMain, mcpReviewChange, async ({ id, target }) => {
    const status = mcp.pool.status().find((s) => s.serverId === id)
    let cache: { pinnedDefinitions?: Record<string, unknown>; pinnedInstructions?: string } | null =
      null
    try {
      const text = (await q.host.fs.readFile(
        joinPath(q.host.identity.profileDir as AbsolutePath, 'mcp', `${id}.json`),
        { encoding: 'utf8' },
      )) as string

      const parsed = text.length <= 5 * 1024 * 1024 ? JSON.parse(text) : null
      cache = parsed?.version === 1 ? parsed : null
    } catch {
      /* missing cache means no before */
    }
    if ('tool' in target) {
      const before = cache?.pinnedDefinitions?.[target.tool]
      const after = status?.tools?.find((t) => t.originalName === target.tool)?.definition ?? null
      return {
        before: before === undefined ? null : prettyDefinition(before),
        after: prettyDefinition(after),
      }
    }
    return {
      before: cache?.pinnedInstructions == null ? null : prettyDefinition(cache.pinnedInstructions),
      after: prettyDefinition(status?.instructions?.text ?? ''),
    }
  })
  registerRoute(ipcMain, mcpLogin, async ({ id }) => {
    const config = mcp.config()
    let callback: McpCallbackListener | undefined
    const result = await mcp.pool.login(id, {
      listen: async (port) => {
        // Test-only: the application binds port 0 and reports the actual bound port. No probe/close race.
        const auto = usesMcpCallbackTestPort(q)
        const listener = await listenMcpCallback(auto ? 0 : port, {
          locale: q.locale(),
          displayName: config.mcpServers.find((s) => s.id === id)?.displayName ?? id,
        })
        callback = listener
        if (auto)
          (globalThis as { tenonMcpCallbackPort?: number }).tenonMcpCallbackPort = listener.port
        return listener
      },
      openUrl: createMcpOpenUrl({
        isPackaged: q.isPackaged,
        env: q.env,
        openExternal: q.openExternal,
        fetch: q.host.network.fetch,
      }),
    })
    callback?.complete(result)
    return result
  })
  // Revoking a pending login closes its listener through the existing pool/provider cancellation path.
  registerRoute(ipcMain, mcpCancelLogin, ({ id }) => ({ cancelled: mcp.pool.cancelLogin(id) }))
}
