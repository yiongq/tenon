/**
 * Manual spec 03 acceptance 48. Lead runs this only with the owner present: macOS may ask for
 * keychain access, the system browser needs a Notion login, and one zhipu tool round is paid.
 * Keys come only from this process's environment. Never run this file in CI or collect traces.
 * Notion's documented read-only search: https://developers.notion.com/guides/mcp/mcp-supported-tools
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transformWithEsbuild } from 'vite'
import type { ElectronApplication } from '@playwright/test'
import type { McpServer } from '@tenon-app/contracts'
import { keyFor } from '@tenon-app/kernel'
import type { HostSecrets } from '@tenon-app/kernel'
import { expect, test } from './helpers/test.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { closeSettings, mcpServers, openConnectors } from './helpers/connectors.js'
import { compact, originMapRefusal } from './helpers/live-env.js'
import { named, tapeFacts } from './helpers/tape.js'
import { send, waitingApproval } from './helpers/tools.js'
import { PAST_CLICK_GUARD_MS } from './helpers/navigation.js'

const LIVE = process.env['TENON_LIVE'] === '1'
const NOTION_URL = 'https://mcp.notion.com/mcp'
const identity = { tenantId: 'personal' }
const providerAccount = keyFor(identity, 'provider', 'zhipu', 'apiKey')

type MainSecrets = {
  secrets: HostSecrets
  previousProviderKey: string | null
}

/** All declared accounts, including empty slots: never infer cleanup from just the active slot. */
function accountsIn(userData: string, id: string): string[] {
  const config = JSON.parse(readFileSync(configPathIn(userData), 'utf8')) as {
    mcpServers?: McpServer[]
  }
  const server = config.mcpServers?.find((s) => s.id === id)
  if (server?.transport.type !== 'http') return []
  return [
    keyFor(identity, 'mcp', id, 'oauth', 'own', 'secret'),
    ...server.transport.oauth.issuers.flatMap((issuer) =>
      [keyFor(identity, 'mcp', id, 'oauth', issuer, 'client')].concat(
        ['a', 'b'].flatMap((slot) =>
          [0, 1, 2, 3].map((i) =>
            keyFor(identity, 'mcp', id, 'oauth', issuer, 'tokens', slot, String(i)),
          ),
        ),
      ),
    ),
  ]
}

/** Only presence crosses the evaluate boundary; credentials stay in Electron main. */
async function absentAccounts(app: ElectronApplication, accounts: string[]): Promise<boolean[]> {
  return app.evaluate(async (_electron, keys) => {
    const state = (globalThis as { liveMcpSecrets?: MainSecrets }).liveMcpSecrets
    if (!state) throw new Error('live keychain reader was not installed')
    return Promise.all(keys.map(async (key) => (await state.secrets.get(key)) === null))
  }, accounts)
}

test.describe('live mcp oauth · Notion', () => {
  test.skip(!LIVE, 'opt-in only: TENON_LIVE=1, lead and owner present')
  test.describe.configure({ timeout: 600_000 })
  test.use({ trace: 'off', screenshot: 'off', video: 'off' })

  test('03 验收 48: real browser, DCR, readonly model call and keychain deletion', async () => {
    // Fail rather than silently bypassing a dangerous setup. The live config also checks its
    // dotenv source; this spec itself never reads an env file or opens a fixture browser.
    const refusal = originMapRefusal(process.env, {})
    if (refusal !== null) throw new Error(refusal)
    if (process.env['CI']) throw new Error('live OAuth must be run manually without CI')
    const key = process.env['TENON_LIVE_ZHIPU_KEY']?.trim() || process.env['ZHIPU_API_KEY']?.trim()
    if (!key)
      throw new Error('pass TENON_LIVE_ZHIPU_KEY or ZHIPU_API_KEY in the process environment')
    const model = process.env['TENON_LIVE_ZHIPU_MODEL']?.trim() || 'glm-5.3-flash'
    const userData = makeUserDataDir('live-notion')
    const id = 'live-notion-' + randomUUID().slice(0, 8)
    seedConfig(userData, { locale: 'en', provider: { id: 'zhipu', modelId: model } })
    const { app, page } = await launchTenon({
      userData,
      secrets: 'keychain',
      env: compact({ ZHIPU_API_KEY: key, TENON_MAX_TOKENS: '8192' }),
    })
    let accounts: string[] = []
    let deleted = false
    try {
      // Load the actual HostSecrets implementation inside main, not a runner-side native binding
      // or a new production IPC route. Transpile only this local module, whose only runtime import
      // is keyring. Keep the owner's existing provider key in main and restore it in finally:
      // a daily-use keychain entry would otherwise override the process key supplied for this run.
      const { code: moduleSource } = await transformWithEsbuild(
        readFileSync(resolve('src/main/host/secrets.ts'), 'utf8'),
        'secrets.ts',
        { format: 'cjs', target: 'node24' },
      )
      await app.evaluate(
        async ({ app: electronApp }, { source, account }) => {
          const { createRequire } = await import('node:module')
          const module = { exports: {} as { KeychainSecrets: new () => HostSecrets } }
          new Function('require', 'module', 'exports', source)(
            createRequire(electronApp.getAppPath() + '/package.json'),
            module,
            module.exports,
          )
          const secrets = new module.exports.KeychainSecrets()
          const previousProviderKey = await secrets.get(account)
          ;(globalThis as { liveMcpSecrets?: MainSecrets }).liveMcpSecrets = {
            secrets,
            previousProviderKey,
          }
          const value = process.env['ZHIPU_API_KEY']
          if (!value) throw new Error('zhipu environment key missing in main')
          await secrets.set(account, value)
        },
        { source: moduleSource, account: providerAccount },
      )

      await openConnectors(page)
      await page.getByTestId('connector-add').click()
      await page.getByTestId('mcp-type').selectOption('http')
      await page.getByTestId('mcp-id').fill(id)
      await page.getByTestId('mcp-displayName').fill('Notion live')
      await page.getByTestId('mcp-url').fill(NOTION_URL)
      // No ownClient: acceptance 48 exercises automatic client registration.
      await page.getByTestId('connector-save').click()
      await expect(page.getByTestId('connector-grant')).toContainText('https://mcp.notion.com')
      await page.getByTestId('grant-persistent').click()
      await expect(page.getByTestId('connector-form')).toBeHidden()
      const row = page.getByTestId('connector-' + id)
      await row.getByRole('button', { name: /^Notion live/ }).click()
      // Let the initial connection install its OAuth provider before requesting a login.
      await expect
        .poll(async () => (await mcpServers(page)).find((s) => s.id === id)?.status.phase, {
          timeout: 30_000,
        })
        .toBe('unauthorized')
      await page.getByTestId('connector-login').click()
      // The owner signs in in the real system browser. No shell/openUrl or callback-port seam.
      await expect
        .poll(
          async () => {
            const server = (await mcpServers(page)).find((s) => s.id === id)
            return server?.loggedIn === true && server.status.phase === 'connected'
          },
          { timeout: 120_000 },
        )
        .toBe(true)
      await expect
        .poll(async () => (await mcpServers(page)).find((s) => s.id === id)?.toolViews.length ?? 0)
        .toBeGreaterThan(0)
      const server = (await mcpServers(page)).find((s) => s.id === id)!
      accounts = accountsIn(userData, id)
      expect(accounts.length).toBeGreaterThan(1)
      const clients = accounts.filter((account) => account.endsWith(':client'))
      const slots = accounts.filter((account) => account.includes(':tokens:'))
      // Prevent vacuous cleanup checks; an existing DCR client and real token must precede delete.
      expect((await absentAccounts(app, clients)).some((absent) => !absent)).toBe(true)
      expect((await absentAccounts(app, slots)).some((absent) => !absent)).toBe(true)
      const search = server.toolViews.find((tool) => tool.originalName === 'notion-search')
      expect(search !== undefined && search.unavailable === null).toBe(true)
      if (!search) throw new Error('Notion did not list the documented readonly search tool')
      // A readOnlyHint is never an authorization. Explicitly disable all other MCP tools and keep
      // search on "ask", so the only card approved by this test is this documented read operation.
      for (const tool of server.toolViews) {
        const setting = tool.originalName === search.originalName ? 'ask' : 'never'
        // Serialize settings writes before the first frozen table is assembled.
        // oxlint-disable-next-line no-await-in-loop
        const ok = await page.evaluate(
          async ({ id: serverId, name, setting: value }) => {
            const result = await window.tenon.invoke('mcp.setToolSetting', {
              id: serverId,
              tool: name,
              setting: value,
            })
            return (result as { ok: boolean }).ok
          },
          { id, name: tool.originalName, setting },
        )
        expect(ok).toBe(true)
      }
      await closeSettings(page)
      const query = 'tenon-live-readonly-' + randomUUID()
      await send(
        page,
        `Call only ${search.mappedName} exactly once to search for ${query}. ` +
          'Use a keyword search. Do not call any other tool, create or modify anything. ' +
          'After the result, reply only: live-search-complete.',
      )
      await expect(page.getByTestId('approval-card')).toBeVisible({ timeout: 180_000 })
      const approval = await waitingApproval(page)
      const calls = named(tapeFacts(userData), 'tool/call')
      expect(calls.length).toBe(1)
      expect(calls[0]?.payload['name']).toBe(search.mappedName)
      expect(approval.card.target).toEqual({
        type: 'tool',
        serverId: id,
        toolName: search.originalName,
      })
      const card = page.getByTestId('approval-card')
      await expect(card).toContainText('Notion live')
      await page.waitForTimeout(PAST_CLICK_GUARD_MS)
      await card.getByTestId('approval-allow').click()
      await expect(page.getByTestId('assistant-text').last()).toContainText(
        'live-search-complete',
        {
          timeout: 180_000,
        },
      )
      await expect(page.getByTestId('composer-stop')).toHaveCount(0, { timeout: 180_000 })
      await expect(page.getByTestId('message-error')).toHaveCount(0)
      const facts = tapeFacts(userData)
      expect(named(facts, 'tool/call').length).toBe(1)
      expect(named(facts, 'execution/dispatch_committed').length).toBe(1)
      expect(named(facts, 'tool/result')[0]?.payload['isError']).toBe(false)
      expect(named(facts, 'execution/tool_outcome')[0]?.payload['state']).toBe('completed')
      expect(named(facts, 'execution/tool_outcome')[0]?.payload['source']).toBeNull()
      // The body/result can contain private Notion data: never attach it or print it.
      accounts = [...new Set([...accounts, ...accountsIn(userData, id)])]
      await openConnectors(page)
      await row.getByRole('button', { name: /^Notion live/ }).click()
      await page
        .getByTestId('connector-detail')
        .getByRole('button', { name: 'Delete', exact: true })
        .click()
      await page.getByTestId('connector-delete-confirm').click()
      await expect(row).toHaveCount(0)
      deleted = true
      expect((await absentAccounts(app, accounts)).every(Boolean)).toBe(true)
      test.info().annotations.push({
        type: 'live-summary',
        description: JSON.stringify({
          date: new Date().toISOString(),
          vendor: 'Notion',
          address: NOTION_URL,
          source: 'spec Open 2 / owner 2026-10-08',
          clientIdentity: 'DCR',
          tools: server.toolViews.length,
          readonlyCall: 'success',
          model,
          cost: 'lead records actual zhipu usage/cost outside the repository',
        }),
      })
    } finally {
      try {
        // A timeout or failed model round must not orphan this randomly named connector's tokens.
        // Use the real deletion route, including on partial login; do not erase keychain entries
        // behind the runtime's back. Keep the profile on failure for the lead's investigation.
        if (!deleted) {
          accounts = [...new Set([...accounts, ...accountsIn(userData, id)])]
          const exists = (await mcpServers(page)).some((s) => s.id === id)
          if (exists) {
            const ok = await page.evaluate(async (serverId) => {
              const result = await window.tenon.invoke('mcp.delete', { id: serverId })
              const reply = result as { ok: boolean; data?: { ok: boolean } }
              return reply.ok && reply.data?.ok === true
            }, id)
            expect(ok).toBe(true)
            expect((await absentAccounts(app, accounts)).every(Boolean)).toBe(true)
          }
        }
      } finally {
        try {
          await app.evaluate(async (_electron, account) => {
            const globals = globalThis as { liveMcpSecrets?: MainSecrets }
            const state = globals.liveMcpSecrets
            if (!state) return
            if (state.previousProviderKey === null) await state.secrets.delete(account)
            else await state.secrets.set(account, state.previousProviderKey)
            delete globals.liveMcpSecrets
          }, providerAccount)
        } finally {
          await app.close()
        }
      }
    }
  })
})
