import { readFileSync } from 'node:fs'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import {
  addStdio,
  closeSettings,
  connected,
  connectorCall,
  mcpServers,
  MODERN_FIXTURE,
  openConnectors,
  resultOf,
  setAlways,
  stdioConfig,
} from './helpers/connectors.js'
import { callsReply, providerEnv, send, textReply } from './helpers/tools.js'
import { newChatFromSidebar, PAST_CLICK_GUARD_MS } from './helpers/navigation.js'

test('03 验收 24/25: full argv, warnings, cancel focus, run and persistent consent across relaunch', async () => {
  const userData = makeUserDataDir('connectors-consent')
  seedConfig(userData, { locale: 'zh-CN' })
  let launched = await launchTenon({ userData })
  try {
    const { page } = launched
    await openConnectors(page)
    await addStdio(page, 'run', [
      'sudo',
      'rm',
      '-r',
      '-f',
      '~/.ssh',
      'hidden\u202Etext',
      'x'.repeat(4096),
    ])
    await page.getByTestId('mcp-envs').fill(JSON.stringify({ NODE_PATH: '/tmp/fixture' }))
    await page.getByTestId('mcp-envKeys').fill('["TOKEN"]')
    await page.getByTestId('mcp-secretEnv').fill('{"TOKEN":"fixture-not-visible"}')
    await page.getByTestId('connector-save').click()
    await expect(page.getByTestId('grant-cancel')).toBeFocused()
    const argv = page.getByTestId('grant-argv')
    await expect(argv).toContainText(MODERN_FIXTURE)
    await expect(argv).toContainText('hidden\\u{202E}text')
    await expect(argv).toContainText('x'.repeat(4096))
    await expect(page.getByTestId('grant-warnings')).toContainText('rm -rf')
    await expect(page.getByTestId('grant-warnings')).toContainText('sudo')
    await expect(page.getByTestId('grant-warnings')).toContainText('SSH')
    await expect(page.getByTestId('connector-grant')).toContainText('TOKEN（钥匙串）')
    await expect(page.getByTestId('connector-grant')).not.toContainText('fixture-not-visible')
    await page.keyboard.press('Escape')
    expect(await mcpServers(page)).toEqual([])
    expect(JSON.parse(readFileSync(configPathIn(userData), 'utf8')).mcpServers ?? []).toEqual([])
    await page.getByTestId('connector-save').click()
    await page.getByTestId('grant-run').click()
    await connected(page, 'run')
    await expect(page.getByTestId('connector-form')).toBeHidden()
    await addStdio(page, 'persistent')
    await page.getByTestId('connector-save').click()
    await page.getByTestId('grant-persistent').click()
    await connected(page, 'persistent')
    await launched.app.close()
    launched = await launchTenon({ userData })
    await openConnectors(launched.page)
    await expect(launched.page.getByTestId('connector-run')).toContainText('待确认')
    await expect(launched.page.getByTestId('connector-persistent')).toContainText('已连接')
    expect((await mcpServers(launched.page)).find((s) => s.id === 'run')?.needsConsent).toBe(true)
  } finally {
    await launched.app.close()
  }
})

test('03 验收 28: two sessions share the same live process PID', async () => {
  const fake = await startFakeAnthropic({
    replies: [
      callsReply(connectorCall('toolu_pid1', 'pid')),
      textReply('first pid'),
      callsReply(connectorCall('toolu_pid2', 'pid')),
      textReply('second pid'),
    ],
  })
  const userData = makeUserDataDir('connector-pid')
  seedConfig(userData, { locale: 'en', mcpServers: [stdioConfig()] })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await connected(page)
    await setAlways(page, 'pid')
    await send(page, 'pid')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('first pid')
    await newChatFromSidebar(page)
    await send(page, 'pid again')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('second pid')
    const results = [
      resultOf(fake.requests[1]?.body, 'toolu_pid1'),
      resultOf(fake.requests[3]?.body, 'toolu_pid2'),
    ].map((r) => r.content.map((c) => c.text ?? '').join(''))
    expect(results).toHaveLength(2)
    expect(results[0]).toBe(results[1])
    expect(Number(results[0])).toBeGreaterThan(1)
  } finally {
    await app.close()
    await fake.close()
  }
})

test('03 验收 38/39/45: new-tool review affects next table; changed frozen definition shows card and scale', async () => {
  const fake = await startFakeAnthropic({
    replies: [
      callsReply(connectorCall('toolu_add', 'add-tool')),
      textReply('added'),
      callsReply(connectorCall('toolu_change', 'change-desc')),
      textReply('changed'),
      callsReply(connectorCall('toolu_echo', 'echo')),
      textReply('echo done'),
    ],
  })
  const userData = makeUserDataDir('connector-definitions')
  seedConfig(userData, { locale: 'zh-CN', mcpServers: [stdioConfig()] })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await connected(page)
    await setAlways(page, 'add-tool')
    await setAlways(page, 'change-desc')
    await setAlways(page, 'echo')
    await send(page, 'add tool')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('added')
    await openConnectors(page)
    await page.getByTestId('connector-notes').getByRole('button').click()
    await expect(page.getByTestId('tool-setting-echo').locator('..').locator('+ span')).toHaveText(
      '新会话生效',
    )
    const tool = page.getByTestId('connector-tool-added')
    await expect(tool).toContainText('新出现')
    await tool.getByRole('button', { name: '查看变化' }).click()
    await expect(page.getByTestId('connector-review-dialog')).toContainText('added')
    await page.getByTestId('connector-review-dialog').locator('[data-slot="dialog-close"]').click()
    await page.getByTestId('tool-release-added').click()
    await expect(tool).not.toContainText('新出现')
    await closeSettings(page)
    const first = fake.requests[0]?.body as { tools?: { name: string }[] }
    expect(first.tools?.some((t) => t.name === 'notes__added')).toBe(false)
    await newChatFromSidebar(page)
    await send(page, 'change description')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('changed')
    const next = fake.requests[2]?.body as { tools?: { name: string }[] }
    expect(next.tools?.some((t) => t.name === 'notes__added')).toBe(true)
    await expect
      .poll(
        async () =>
          (await mcpServers(page))[0]?.toolViews.find((t) => t.originalName === 'echo')?.review,
      )
      .toBe('changed')
    await send(page, 'echo')
    const card = page.getByTestId('approval-card')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('approval-server')).toHaveText('Notes fixture')
    await expect(card.getByTestId('approval-definition-changed')).toContainText(
      '总是允许这次不生效',
    )
    await expect(card.locator('[aria-current="true"]')).toHaveText('未知')
    await expect(card.getByTestId('reversibility-scale').locator('span')).toHaveCount(5)
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    await card.getByTestId('approval-deny').click()
    await expect(card).toBeHidden()
  } finally {
    await app.close()
    await fake.close()
  }
})

test('03 验收 29: a slow first connection appears above the composer', async () => {
  const userData = makeUserDataDir('connector-slow')
  seedConfig(userData, {
    locale: 'en',
    mcpServers: [stdioConfig('notes', ['--start-delay-ms', '3000'])],
  })
  const { app, page } = await launchTenon({ userData })
  try {
    await expect(page.getByTestId('connector-status-notice')).toHaveText(
      'Connecting to Notes fixture…',
    )
    await connected(page)
    await expect(page.getByTestId('connector-status-notice')).toBeHidden()
  } finally {
    await app.close()
  }
})
