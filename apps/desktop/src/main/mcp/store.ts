// Configuration mutations are sequential under the profile lock.
// oxlint-disable no-await-in-loop
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LINKER_INJECTION_ENV,
  mcpDraftSchema,
  mcpServerSchema,
  headerNameSchema,
} from '@tenon-app/contracts'
import type {
  McpServer,
  RouteRequest,
  RouteResponse,
  mcpSave,
  mcpSecretsSchema,
} from '@tenon-app/contracts'
import { keyFor } from '@tenon-app/kernel'
import type { HostAdapter, McpPool } from '@tenon-app/kernel'
import { readConfig, withConfigLock, writeConfigHeld } from '../host/profile.js'
import type { McpConsent } from './consent.js'
import { launchHash } from './runtime.js'
import { mcpAddress } from './address.js'
import type { z } from 'zod'
export type McpWriteResult = RouteResponse<typeof mcpSave>
type Secrets = z.infer<typeof mcpSecretsSchema>
const saved = { ok: true } as const
const refused = (code: Extract<McpWriteResult, { ok: false }>['code']): McpWriteResult => ({
  ok: false,
  code,
})
export function mcpAccounts(server: McpServer, host: Pick<HostAdapter, 'identity'>): string[] {
  const key = (...parts: string[]) => keyFor(host.identity, 'mcp', server.id, ...parts)
  const t = server.transport
  if (t.type === 'stdio') return t.env_keys.map((name) => key('env', name))
  return [
    ...t.header_keys.map((name) => key('header', name.toLowerCase())),
    ...(t.oauth.ownClient?.hasSecret ? [key('oauth', 'own', 'secret')] : []),
    // oxlint-disable-next-line oxc/no-map-spread -- each issuer expands into its own declared accounts
    ...t.oauth.issuers.flatMap((issuer) => [
      key('oauth', issuer, 'client'),
      ...['a', 'b'].flatMap((slot) =>
        Array.from({ length: 4 }, (_, i) => key('oauth', issuer, 'tokens', slot, String(i))),
      ),
    ]),
  ]
}
export function createMcpStore(q: {
  host: HostAdapter
  consent: McpConsent
  pool: () => McpPool
  apply: (servers: readonly McpServer[]) => void
  log: (line: string) => void
}) {
  const { host } = q
  const deleting = new Set<string>()
  const key = (id: string, ...parts: string[]) => keyFor(host.identity, 'mcp', id, ...parts)
  const current = () => readConfig(host.fs, host.identity)
  const write = (servers: McpServer[]) =>
    writeConfigHeld(host.fs, host.identity, { mcpServers: servers })
  const mutate = (id: string, change: (s: McpServer) => McpServer | McpWriteResult) =>
    withConfigLock(host.identity, async (): Promise<McpWriteResult> => {
      const config = await current()
      const old = config.mcpServers.find((s) => s.id === id)
      if (!old || deleting.has(id)) return refused('not-found')
      const next = change(old)
      if ('ok' in next) return next
      await write(config.mcpServers.map((s) => (s.id === id ? next : s)))
      return saved
    })
  return {
    isDeleting: (id: string) => deleting.has(id),
    save(request: RouteRequest<typeof mcpSave>): Promise<McpWriteResult> {
      return withConfigLock(host.identity, async () => {
        const draft = request.draft
        if (draft.id === 'builtin') return refused('invalid-id')
        if (draft.transport.type === 'stdio') {
          const stdio = draft.transport
          const names = [...Object.keys(draft.transport.envs), ...draft.transport.env_keys]
          if (
            names.some((name) =>
              LINKER_INJECTION_ENV.some((blocked) => blocked === name.toUpperCase()),
            )
          )
            return refused('blocked-env')
          if (draft.transport.env_keys.some((name) => Object.hasOwn(stdio.envs, name)))
            return refused('duplicate-env')
        }
        const checked = mcpDraftSchema.safeParse(draft)
        if (!checked.success)
          return refused(
            checked.error.issues.some((i) => i.path.includes('id'))
              ? 'invalid-id'
              : 'invalid-header',
          )
        const transport = checked.data.transport
        if (transport.type === 'http') {
          if (
            [...transport.header_keys, ...Object.keys(request.secrets.headers)].some(
              (name) => !headerNameSchema.safeParse(name).success,
            )
          )
            return refused('invalid-header')
          const address = mcpAddress(transport.url)
          if (!address.ok) return refused(address.code)
          transport.url = address.url
          transport.header_keys = [
            ...new Set(transport.header_keys.map((name) => name.toLowerCase())),
          ]
        }
        const config = await current()
        const old = config.mcpServers.find((s) => s.id === draft.id)
        if (request.mode === 'create' && old) return refused('duplicate-id')
        if (request.mode === 'update' && (!old || deleting.has(draft.id)))
          return refused('not-found')
        const t: McpServer['transport'] =
          transport.type === 'stdio'
            ? transport
            : {
                ...transport,
                oauth: {
                  issuers: old?.transport.type === 'http' ? old.transport.oauth.issuers : [],
                  ownClient: transport.oauth.ownClient
                    ? {
                        ...transport.oauth.ownClient,
                        issuer:
                          old?.transport.type === 'http' &&
                          old.transport.oauth.ownClient?.clientId ===
                            transport.oauth.ownClient.clientId
                            ? old.transport.oauth.ownClient.issuer
                            : null,
                      }
                    : null,
                },
              }
        const hash = launchHash({ transport: t })
        const changed = !old || launchHash(old) !== hash
        if (changed && request.consent === null) return refused('consent-required')
        const next = mcpServerSchema.parse({
          ...checked.data,
          transport: t,
          enabled: old?.enabled ?? true,
          toolsPinned: old?.toolsPinned ?? false,
          tools: Object.fromEntries(
            Object.entries(old?.tools ?? {}).map(([name, tool]) => [
              name,
              {
                ...tool,
                setting: changed && tool.setting === 'always-allow' ? 'ask' : tool.setting,
              },
            ]),
          ),
          instructions: {
            enabled: draft.instructions.enabled,
            pinHash: old?.instructions.pinHash ?? null,
          },
          consent:
            request.consent === 'persistent'
              ? { launchHash: hash }
              : changed
                ? null
                : (old?.consent ?? null),
        })
        const values = secretWrites(next, request.secrets, key)
        if (values.some(([, value]) => new TextEncoder().encode(value).byteLength > 2560))
          return refused('secret-too-long')
        const needed =
          t.type === 'stdio'
            ? t.env_keys.map((name) => key(next.id, 'env', name))
            : [
                ...t.header_keys.map((name) => key(next.id, 'header', name)),
                ...(t.oauth.ownClient?.hasSecret ? [key(next.id, 'oauth', 'own', 'secret')] : []),
              ]
        const previous = new Map<string, string | null>()
        const attempted: [string, string][] = []
        try {
          for (const account of needed) {
            const value = await host.secrets.get(account)
            if (!values.some(([name]) => name === account) && value === null)
              return refused('secret-required')
            previous.set(account, value)
          }
          for (const [account, value] of values) {
            attempted.push([account, value])
            await host.secrets.set(account, value)
          }
        } catch {
          await rollback(attempted, previous, host, q.log, next.id)
          return refused('keychain')
        }
        const previousConsent = q.consent.get(next.id)
        if (request.consent === 'run') q.consent.allow(next.id, hash)
        try {
          await write(
            old
              ? config.mcpServers.map((s) => (s.id === next.id ? next : s))
              : [...config.mcpServers, next],
          )
        } catch (error) {
          await rollback(attempted, previous, host, q.log, next.id)
          q.consent.restore(next.id, previousConsent)
          throw error
        }
        const kept = new Set(mcpAccounts(next, host))
        for (const account of old ? mcpAccounts(old, host) : [])
          if (!kept.has(account))
            await host.secrets
              .delete(account)
              .catch(() => q.log(`[mcp] removed secret cleanup failed: ${next.id}`))
        if (
          values.length ||
          (old?.transport.type === 'http' &&
            t.type === 'http' &&
            (JSON.stringify(old.transport.header_keys) !== JSON.stringify(t.header_keys) ||
              JSON.stringify(old.transport.oauth.ownClient) !== JSON.stringify(t.oauth.ownClient)))
        )
          q.pool().restart(next.id)
        return saved
      })
    },
    delete(id: string): Promise<McpWriteResult> {
      return withConfigLock(host.identity, async () => {
        const config = await current()
        const server = config.mcpServers.find((s) => s.id === id)
        if (!server) return refused('not-found')
        deleting.add(id)
        try {
          await q.pool().retire(id)
        } catch (error) {
          deleting.delete(id)
          q.apply(config.mcpServers)
          throw error
        }
        try {
          for (const account of mcpAccounts(server, host)) await host.secrets.delete(account)
        } catch {
          deleting.delete(id)
          q.apply(config.mcpServers)
          return refused('keychain')
        }
        try {
          await write(config.mcpServers.filter((s) => s.id !== id))
        } catch (error) {
          deleting.delete(id)
          q.apply(config.mcpServers)
          throw error
        }
        q.apply(config.mcpServers.filter((s) => s.id !== id))
        q.consent.revoke(id)
        await unlink(join(host.identity.profileDir, 'mcp', `${id}.json`)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            q.log(`[mcp] cache cleanup failed: ${id}`)
        })
        deleting.delete(id)
        return saved
      })
    },
    setEnabled: (id: string, enabled: boolean) => mutate(id, (s) => ({ ...s, enabled })),
    reorder(ids: string[]): Promise<McpWriteResult> {
      return withConfigLock(host.identity, async () => {
        const config = await current()
        if (
          ids.length !== config.mcpServers.length ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => !config.mcpServers.some((s) => s.id === id))
        )
          return refused('invalid-id')
        await write(ids.map((id) => config.mcpServers.find((s) => s.id === id)!))
        return saved
      })
    },
    setToolSetting(id: string, tool: string, setting: 'always-allow' | 'ask' | 'never') {
      if (id === 'builtin') return Promise.resolve(refused('invalid-id'))
      return mutate(id, (s) => {
        const live = q
          .pool()
          .status()
          .find((v) => v.serverId === id)
          ?.tools?.find((v) => v.originalName === tool)
        if (!s.tools[tool] || !live) return refused('not-found')
        if (setting === 'always-allow') {
          if (live.requiresUserInteraction) return refused('interaction-required')
          const policy = host.policy.current()
          if (
            policy.status === 'unavailable' ||
            policy.snapshot.tools.some(
              (r) =>
                r.serverId === id &&
                (r.toolName === undefined || r.toolName === tool) &&
                ['ask', 'deny'].includes(r.effect),
            )
          )
            return refused('policy-asks')
        }
        return {
          ...s,
          tools: {
            ...s.tools,
            [tool]: {
              setting,
              definitionHash: s.tools[tool]!.definitionHash,
            },
          },
        }
      })
    },
    release(
      id: string,
      target: { kind: 'tool'; name: string } | { kind: 'instructions' },
      hash: string,
    ) {
      return mutate(id, (s) => {
        const status = q
          .pool()
          .status()
          .find((v) => v.serverId === id)
        if (target.kind === 'instructions') {
          if (status?.instructions?.hash !== hash) return refused('stale')
          return { ...s, instructions: { ...s.instructions, pinHash: hash } }
        }
        const live = status?.tools?.find((v) => v.originalName === target.name)
        if (!live || live.definitionHash !== hash) return refused('stale')
        return {
          ...s,
          tools: { ...s.tools, [target.name]: { setting: 'ask', definitionHash: hash } },
        }
      })
    },
    setInstructions: (id: string, enabled: boolean) =>
      mutate(id, (s) => {
        const instructions = q
          .pool()
          .status()
          .find((v) => v.serverId === id)?.instructions
        if (enabled && !instructions) return refused('not-found')
        return {
          ...s,
          instructions: { enabled, pinHash: enabled ? instructions!.hash : s.instructions.pinHash },
        }
      }),
    connect(id: string, consent: 'run' | 'persistent') {
      return mutate(id, (s) => {
        const hash = launchHash(s)
        if (consent === 'run') {
          q.consent.allow(id, hash)
          return saved
        }
        return { ...s, consent: { launchHash: hash } }
      })
    },
    revoke: (id: string) =>
      mutate(id, (s) => {
        q.consent.revoke(id)
        return { ...s, consent: null }
      }),
    pin: (id: string, tools: readonly { name: string; definitionHash: string }[]) =>
      mutate(id, (s) =>
        s.toolsPinned
          ? saved
          : {
              ...s,
              toolsPinned: true,
              tools: Object.fromEntries(
                tools.map((t) => [t.name, { setting: 'ask', definitionHash: t.definitionHash }]),
              ),
            },
      ),
    recordIssuer(id: string, issuer: { hash: string; url: string }, kind: 'tokens' | 'client') {
      return withConfigLock(host.identity, async () => {
        const config = await current()
        const s = config.mcpServers.find((entry) => entry.id === id)
        if (!s || deleting.has(id)) return refused('not-found')
        if (s.transport.type !== 'http') return refused('not-found')
        const oauth = s.transport.oauth
        let issuers = oauth.issuers.filter((h) => h !== issuer.hash)
        if (issuers.length === 8) {
          const accounts = mcpAccounts(
            {
              ...s,
              transport: {
                ...s.transport,
                header_keys: [],
                oauth: { ownClient: null, issuers: [issuers[0]!] },
              },
            },
            host,
          )
          const previous = new Map<string, string | null>()
          const attempted: [string, string][] = []
          try {
            for (const account of accounts) previous.set(account, await host.secrets.get(account))
            for (const account of accounts) {
              attempted.push([account, ''])
              await host.secrets.delete(account)
            }
          } catch {
            await rollback(attempted, previous, host, q.log, id)
            return refused('keychain')
          }
          issuers = issuers.slice(1)
        }
        const next: McpServer = {
          ...s,
          transport: {
            ...s.transport,
            oauth: {
              issuers: [...issuers, issuer.hash],
              ownClient:
                kind === 'tokens' && oauth.ownClient?.issuer === null
                  ? { ...oauth.ownClient, issuer: issuer.url }
                  : oauth.ownClient,
            },
          },
        }
        await write(config.mcpServers.map((entry) => (entry.id === id ? next : entry)))
        return saved
      })
    },
  }
}
export type McpStore = ReturnType<typeof createMcpStore>
function secretWrites(
  server: McpServer,
  secrets: Secrets,
  key: (id: string, ...parts: string[]) => string,
): [string, string][] {
  const t = server.transport
  return t.type === 'stdio'
    ? t.env_keys.flatMap((name) =>
        secrets.env[name] === undefined
          ? []
          : [[key(server.id, 'env', name), secrets.env[name]!] as [string, string]],
      )
    : [
        ...t.header_keys.flatMap((name) => {
          const entry = Object.entries(secrets.headers).find(
            ([header]) => header.toLowerCase() === name,
          )
          return entry ? [[key(server.id, 'header', name), entry[1]] as [string, string]] : []
        }),
        ...(t.oauth.ownClient?.hasSecret && secrets.ownClientSecret !== undefined
          ? [
              [key(server.id, 'oauth', 'own', 'secret'), secrets.ownClientSecret] as [
                string,
                string,
              ],
            ]
          : []),
      ]
}
async function rollback(
  values: [string, string][],
  previous: Map<string, string | null>,
  host: HostAdapter,
  log: (line: string) => void,
  id: string,
) {
  for (const [account] of values) {
    const old = previous.get(account)
    await (old == null ? host.secrets.delete(account) : host.secrets.set(account, old)).catch(() =>
      log(`[mcp] secret rollback failed: ${id}`),
    )
  }
}
