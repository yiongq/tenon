import { mcpServerSchema } from '@tenon-app/contracts'
import { join } from 'node:path'
import { serverEverythingSpawnSpec } from '../../../packages/kernel/test/support/server-everything.js'
import { launchHash } from '../src/main/mcp/runtime.js'
import type { McpServerView } from '@tenon-app/contracts'
import { startHttpFixture } from '../../../packages/kernel/test/support/http-fixture.js'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import { callsReply, textReply, providerEnv, send } from './helpers/tools.js'

test('MCP main process: the bundled schema worker validates a real connector call and quit closes the pool', async () => {
  const server = await startHttpFixture({ era: 'modern' })
  const fake = await startFakeAnthropic({
    replies: [
      callsReply({
        type: 'tool_use',
        id: 'toolu_mcp',
        name: 'notes__echo',
        input: { text: 'worker-fixture' },
      }),
      textReply('MCP worker succeeded.'),
    ],
  })
  const { app, page } = await launchTenon({
    userData: makeUserDataDir('mcp-main'),
    env: providerEnv(fake.baseURL),
  })
  try {
    const saved = await page.evaluate(
      (url) =>
        window.tenon.invoke('mcp.save', {
          mode: 'create',
          draft: {
            id: 'notes',
            displayName: 'Notes fixture',
            source: 'manual',
            transport: {
              type: 'http',
              url,
              protocol: 'auto',
              header_keys: [],
              oauth: { ownClient: null },
            },
            handshakeTimeoutSec: null,
            callTimeoutSec: null,
            instructions: { enabled: false },
          },
          secrets: { env: {}, headers: {} },
          consent: 'persistent',
        }),
      server.url,
    )
    expect(saved).toEqual({ ok: true, data: { ok: true } })
    await expect
      .poll(async () =>
        page.evaluate(() =>
          window.tenon.invoke('mcp.list', {}).then((r) => {
            const result = r as { ok: boolean; data: { servers: McpServerView[] } }
            return result.ok ? result.data.servers[0]?.status.phase : null
          }),
        ),
      )
      .toBe('connected')
    expect(
      await page.evaluate(() =>
        window.tenon.invoke('mcp.setToolSetting', {
          id: 'notes',
          tool: 'echo',
          setting: 'always-allow',
        }),
      ),
    ).toEqual({ ok: true, data: { ok: true } })
    await send(page, 'Use notes echo with worker-fixture')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('MCP worker succeeded.')
    expect(fake.requests).toHaveLength(2)
    const result = JSON.stringify(fake.requests[1]?.body)
    expect(result).toContain('worker-fixture')
    expect(result).not.toContain('is_error":true')
    expect(server.requests.some((r) => r.body.method === 'tools/call')).toBe(true)
  } finally {
    await app.close()
    await Promise.all([server.close(), fake.close()])
  }
})

test('MCP Everything: a seeded profile connects and a model message calls the real legacy server through the schema worker', async () => {
  const fake = await startFakeAnthropic({
    replies: [
      callsReply({
        type: 'tool_use',
        id: 'toolu_everything',
        name: 'everything__echo',
        input: { message: 'Everything dev fixture' },
      }),
      textReply('Everything echo succeeded.'),
    ],
  })
  const spawn = serverEverythingSpawnSpec(),
    userData = makeUserDataDir('mcp-everything')
  const server = mcpServerSchema.parse({
    id: 'everything',
    displayName: 'Everything fixture',
    source: 'manual',
    enabled: true,
    transport: {
      type: 'stdio',
      command: spawn.argv[0],
      args: spawn.argv.slice(1),
      envs: {},
      env_keys: [],
    },
    handshakeTimeoutSec: null,
    callTimeoutSec: null,
    consent: null,
    toolsPinned: false,
    tools: {},
    instructions: { enabled: false, pinHash: null },
  })
  server.consent = { launchHash: launchHash(server) }
  seedConfig(userData, { locale: 'en', mcpServers: [server] })
  const renderer = process.env['TENON_MCP_DEV_RENDERER_URL']
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(fake.baseURL), ...(renderer ? { ELECTRON_RENDERER_URL: renderer } : {}) },
  })
  try {
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const r = (await window.tenon.invoke('mcp.list', {})) as {
            ok: boolean
            data: { servers: McpServerView[] }
          }
          return r.ok ? r.data.servers[0]?.status.phase : null
        }),
      )
      .toBe('connected')
    expect(
      await page.evaluate(() =>
        window.tenon.invoke('mcp.setToolSetting', {
          id: 'everything',
          tool: 'echo',
          setting: 'always-allow',
        }),
      ),
    ).toEqual({ ok: true, data: { ok: true } })
    await send(page, 'Use Everything echo with Everything dev fixture.')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Everything echo succeeded.')
    expect(fake.requests).toHaveLength(2)
    expect(JSON.stringify(fake.requests[1]?.body)).toContain('Echo: Everything dev fixture')
    expect(JSON.stringify(fake.requests[1]?.body)).not.toContain('is_error":true')
    const evidence = process.env['TENON_MCP_DEV_EVIDENCE_DIR']
    if (evidence) await page.screenshot({ path: join(evidence, 'seg2-everything-dev.png') })
  } finally {
    await app.close()
    await fake.close()
  }
})
