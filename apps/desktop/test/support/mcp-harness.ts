import { randomUUID } from 'node:crypto'
import {
  absolutePath,
  createMemoryHost,
  createProviderRegistry,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type { ipcRoutes, RouteResponse, McpDraft } from '@tenon-app/contracts'
import { readConfig } from '../../src/main/host/profile.js'
import { createDesktopMcp } from '../../src/main/mcp/controller.js'
import { registerMcpRoutes } from '../../src/main/mcp/routes.js'
import { createSchemaWorker } from '../../src/main/mcp/schema-worker.js'
type McpReply<C extends string> = RouteResponse<
  (typeof ipcRoutes)[`mcp${Capitalize<C extends `mcp.${infer N}` ? N : never>}` &
    keyof typeof ipcRoutes]
>
export const mcpDraft = (id = 'notes'): McpDraft => ({
  id,
  displayName: id,
  source: 'manual',
  transport: {
    type: 'stdio',
    command: process.execPath,
    args: [
      new URL(
        '../../../../packages/kernel/test/support/fixtures/modern-server.mjs',
        import.meta.url,
      ).pathname,
      'dual',
    ],
    envs: {},
    env_keys: [],
  },
  handshakeTimeoutSec: null,
  callTimeoutSec: null,
  instructions: { enabled: false },
})
export async function mcpHarness() {
  const host = createMemoryHost()
  await host.fs.mkdirp(absolutePath(host.identity.profileDir))
  const providers = createProviderRegistry()
  registerBuiltinProviders(providers)
  const mcp = createDesktopMcp({
    host,
    config: await readConfig(host.fs, host.identity),
    home: absolutePath('/home/fixture'),
    baseEnv: async () => ({ PATH: '/usr/bin:/bin' }),
    uuid: randomUUID,
    changed: () => {},
    schemaValidator: createSchemaWorker(),
  })
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  registerMcpRoutes({
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener)
      },
    },
    mcp,
    host,
    providers,
    home: absolutePath('/home/fixture'),
    baseEnv: async () => ({ PATH: '/usr/bin:/bin' }),
    isPackaged: false,
    env: {},
    openExternal: async () => {},
    locale: () => (mcp.config().locale === 'zh-CN' ? 'zh-CN' : 'en'),
  })
  return {
    host,
    mcp,
    providers,
    handlers,
    call: async <C extends string>(channel: C, payload: unknown): Promise<McpReply<C>> => {
      const result = (await handlers.get(channel)!({}, payload)) as { ok: boolean; data: unknown }
      if (!result.ok) throw new Error(JSON.stringify(result))
      return result.data as McpReply<C>
    },
    close: async () => {
      const closing = mcp.close({ deadlineMs: 0 })
      host.advance(0)
      await closing
    },
  }
}
