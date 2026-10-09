import type { ElectronApplication } from '@playwright/test'
import { createServer } from 'node:net'
import {
  startFakeAuthServer,
  startHttpFixture,
} from '../../../packages/kernel/test/support/http-fixture.js'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import {
  closeSettings,
  connected,
  connectorCall,
  mcpServers,
  openConnectors,
  resultOf,
  setAlways,
} from './helpers/connectors.js'
import { callsReply, providerEnv, send, textReply } from './helpers/tools.js'
async function portListener() {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return {
    port: address.port,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}
async function addHttp(page: Parameters<typeof openConnectors>[0], url: string, port: number) {
  await openConnectors(page)
  await page.getByTestId('connector-add').click()
  await page.getByTestId('mcp-type').selectOption('http')
  await page.getByTestId('mcp-id').fill('notes')
  await page.getByTestId('mcp-displayName').fill('HTTP Notes')
  await page.getByTestId('mcp-url').fill(url)
  await page.getByTestId('mcp-clientId').fill('fixture-client')
  await page.getByTestId('mcp-port').fill(String(port))
  await page.getByTestId('connector-save').click()
  await expect(page.getByTestId('connector-grant')).toContainText(new URL(url).origin)
  await page.getByTestId('grant-persistent').click()
  await expect(page.getByTestId('connector-form')).toBeHidden()
}

test('03 验收 21 (UI): 401 offers relogin, own-client login succeeds, same frozen session calls again', async () => {
  const auth = await startFakeAuthServer(),
    http = await startHttpFixture({ era: 'legacy', authUrl: auth.url })
  const fake = await startFakeAnthropic({
    replies: [
      callsReply(connectorCall('toolu_401', 'echo')),
      textReply('needs login'),
      callsReply(connectorCall('toolu_after', 'echo')),
      textReply('authenticated'),
    ],
  })
  const userData = makeUserDataDir('connector-oauth')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({
    userData,
    env: {
      ...providerEnv(fake.baseURL),
      TENON_TEST_MCP_OPEN_URL: 'direct',
      TENON_TEST_MCP_CALLBACK_PORT: 'auto',
    },
  })
  try {
    await assertNoBrowser(app)
    await addHttp(page, http.url, 53280)
    await connected(page)
    await setAlways(page, 'echo')
    await closeSettings(page)
    http.set({ failNext: '401' })
    await send(page, 'echo')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('needs login')
    const button = page.getByTestId('tool-relogin')
    await expect(button).toBeVisible()
    http.set({ requireToken: 'fixture-access-1' })
    await app.evaluate(() => {
      const { ServerResponse } = process.getBuiltinModule('node:http')
      const end = ServerResponse.prototype.end
      ServerResponse.prototype.end = function (...args: unknown[]) {
        if (this.req.url?.startsWith('/callback?'))
          (globalThis as { tenonCallbackPage?: string }).tenonCallbackPage = String(args[0] ?? '')
        return Reflect.apply(end, this, args)
      }
    })
    await button.click()
    await connected(page)
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as { tenonCallbackPage?: string }).tenonCallbackPage ?? ''),
      )
      .toContain('已登录 HTTP Notes，可以关闭这个页面回到 Tenon')
    expect(await browserCalls(app)).toBe(0)
    expect(
      await app.evaluate(
        () => (globalThis as { tenonMcpCallbackPort?: number }).tenonMcpCallbackPort,
      ),
    ).toBeGreaterThan(1024)
    expect(auth.requests.filter((r) => r.path === '/authorize')).toHaveLength(1)
    expect(auth.requests.filter((r) => r.path === '/register')).toHaveLength(0)
    await send(page, 'echo again')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('authenticated')
    expect(http.requests.filter((r) => r.method === 'tools/call')).toHaveLength(2)
    expect(http.requests.findLast((r) => r.method === 'tools/call')?.headers.authorization).toBe(
      'Bearer fixture-access-1',
    )
    expect(resultOf(fake.requests[3]?.body, 'toolu_after').is_error).toBe(false)
    const listed = await mcpServers(page)
    expect(JSON.stringify(listed)).not.toContain('fixture-access-1')
  } finally {
    await app.close()
    await Promise.all([auth.close(), http.close(), fake.close()])
  }
})

test('03 验收 18 (UI): busy own-client callback port shows 端口被占用', async () => {
  const auth = await startFakeAuthServer(),
    http = await startHttpFixture({ era: 'legacy', authUrl: auth.url }),
    busy = await portListener()
  const userData = makeUserDataDir('connector-port')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: { TENON_TEST_MCP_OPEN_URL: 'direct' } })
  try {
    await assertNoBrowser(app)
    await addHttp(page, http.url, busy.port)
    await connected(page)
    await page
      .getByTestId('connector-notes')
      .getByRole('button', { name: /^HTTP Notes/ })
      .click()
    await page.getByTestId('connector-login').click()
    await expect(page.getByTestId('connector-detail').getByRole('alert')).toHaveText('端口被占用')
    expect(auth.requests.filter((r) => r.path === '/authorize')).toHaveLength(0)
    expect(await browserCalls(app)).toBe(0)
  } finally {
    await app.close()
    await Promise.all([auth.close(), http.close(), busy.close()])
  }
})

async function assertNoBrowser(app: Parameters<typeof browserCalls>[0]) {
  await app.evaluate(({ shell }) => {
    const state = globalThis as { tenonBrowserCalls?: number }
    state.tenonBrowserCalls = 0
    shell.openExternal = async () => {
      state.tenonBrowserCalls!++
      throw new Error('e2e must never open the system browser')
    }
  })
}
async function browserCalls(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as { tenonBrowserCalls?: number }).tenonBrowserCalls ?? 0)
}

test('03 验收 16 (UI): mismatched iss refuses login and never requests a token or system browser', async () => {
  const auth = await startFakeAuthServer({ issInCallback: 'https://wrong.example' }),
    http = await startHttpFixture({ era: 'legacy', authUrl: auth.url })
  const userData = makeUserDataDir('connector-iss')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { TENON_TEST_MCP_OPEN_URL: 'direct', TENON_TEST_MCP_CALLBACK_PORT: 'auto' },
  })
  try {
    await assertNoBrowser(app)
    await addHttp(page, http.url, 53280)
    await connected(page)
    await page
      .getByTestId('connector-notes')
      .getByRole('button', { name: /^HTTP Notes/ })
      .click()
    await page.getByTestId('connector-login').click()
    await expect(page.getByTestId('connector-detail').getByRole('alert')).toHaveText(
      'Login callback issuer mismatch',
    )
    expect(auth.requests.filter((r) => r.path === '/token')).toHaveLength(0)
    expect(await browserCalls(app)).toBe(0)
  } finally {
    await app.close()
    await Promise.all([auth.close(), http.close()])
  }
})
