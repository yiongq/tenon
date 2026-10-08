import { join } from 'node:path'
import { named, tapeFacts } from './helpers/tape.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
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
    await page.getByTestId('mcp-secret-TOKEN').fill('fixture-not-visible')
    await expect(page.getByTestId('mcp-secret-TOKEN')).toHaveAttribute('type', 'password')
    await page.getByTestId('connector-save').click()
    await expect(page.getByTestId('grant-cancel')).toBeFocused()
    const argv = page.getByTestId('grant-argv')
    await expect(argv).toContainText(MODERN_FIXTURE)
    await expect(page.getByTestId('connector-grant')).toContainText('实际路径：' + process.execPath)
    await expect(page.getByTestId('grant-warnings')).toContainText('主目录')
    await expect(page.getByTestId('grant-warnings')).toContainText('NODE_PATH')
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
    await page.getByTestId('mcp-envKeys').fill('[]')
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
    await expect(launched.page.getByTestId('connector-run')).toContainText('需要确认')
    await expect(launched.page.getByTestId('connector-persistent')).toContainText('已连接')
    expect((await mcpServers(launched.page)).find((s) => s.id === 'run')?.needsConsent).toBe(true)
    await launched.page
      .getByTestId('connector-run')
      .getByRole('button', { name: /Notes run/ })
      .click()
    await launched.page.getByTestId('connector-connect').click()
    await launched.page.getByTestId('grant-run').click()
    await connected(launched.page, 'run')
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
      textReply('before release'),
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
    await newChatFromSidebar(page)
    await send(page, 'before release')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('before release')
    const before = fake.requests[2]?.body as { tools?: { name: string }[] }
    expect(before.tools?.some((v) => v.name === 'notes__added')).toBe(false)
    expect(
      named(tapeFacts(userData), 'view/tool_table').some((f) =>
        (f.payload.excluded as { originalName: string; code: string }[]).some(
          (v) => v.originalName === 'added' && v.code === 'definition-changed',
        ),
      ),
    ).toBe(true)
    await openConnectors(page)
    await page
      .getByTestId('connector-notes')
      .getByRole('button', { name: /Notes fixture/ })
      .click()
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
    await newChatFromSidebar(page)
    await send(page, 'change description')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('changed')
    const next = fake.requests[3]?.body as { tools?: { name: string }[] }
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
  const gate = join(userData, 'start-gate')
  seedConfig(userData, {
    locale: 'en',
    mcpServers: [stdioConfig('notes', ['--start-gate-file', gate])],
  })
  const { app, page } = await launchTenon({ userData })
  try {
    await expect(page.getByTestId('connector-status-notice')).toHaveText(
      'Connecting to Notes fixture…',
    )
    writeFileSync(gate, 'ready')
    await connected(page)
    await expect(page.getByTestId('connector-status-notice')).toBeHidden()
  } finally {
    await app.close()
  }
})

test('03 验收 24/39/44: UI controls persist permissions, restart, refresh, logs, instructions, edit, revoke, move and delete secrets', async () => {
  const fake = await startFakeAnthropic({
    replies: [
      textReply('never session'),
      callsReply(connectorCall('toolu_allowed', 'echo')),
      textReply('allowed session'),
    ],
  })
  const userData = makeUserDataDir('connector-controls')
  seedConfig(userData, { locale: 'en', mcpServers: [stdioConfig()] })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await connected(page)
    await openConnectors(page)
    await page
      .getByTestId('connector-notes')
      .getByRole('button', { name: /Notes fixture/ })
      .click()
    const detail = page.getByTestId('connector-detail'),
      select = page.getByTestId('tool-setting-echo')
    await expect(select).toHaveAccessibleName('echo')
    await select.selectOption('never')
    await expect(detail).toContainText(
      "Calls in this session are blocked; new sessions won't offer it",
    )
    await expect.poll(async () => (await mcpServers(page))[0]?.tools.echo?.setting).toBe('never')
    await closeSettings(page)
    await send(page, 'never session')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('never session')
    expect(
      (fake.requests[0]!.body as { tools: { name: string }[] }).tools.some(
        (t) => t.name === 'notes__echo',
      ),
    ).toBe(false)
    await openConnectors(page)
    await page
      .getByTestId('connector-notes')
      .getByRole('button', { name: /Notes fixture/ })
      .click()
    await select.selectOption('always-allow')
    await closeSettings(page)
    await newChatFromSidebar(page)
    await send(page, 'allowed session')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('allowed session')
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    await page.getByTestId('tool-row-line').last().click()
    await expect(page.getByTestId('tool-side-effects')).toContainText('Side effects')
    await expect(page.getByTestId('tool-side-effects')).toContainText('Unknown')
    await expect(page.getByTestId('tool-effect-marker')).toBeVisible()
    await openConnectors(page)
    await page
      .getByTestId('connector-notes')
      .getByRole('button', { name: /Notes fixture/ })
      .click()
    await detail.getByRole('button', { name: 'Restart', exact: true }).click()
    await connected(page)
    await detail.getByRole('button', { name: 'Refresh tools', exact: true }).click()
    await detail.getByRole('button', { name: 'View log', exact: true }).click()
    await expect(page.getByTestId('connector-review-dialog')).toBeVisible()
    await page.getByTestId('connector-review-dialog').locator('[data-slot="dialog-close"]').click()
    await page.getByTestId('connector-instructions').click()
    await expect.poll(async () => (await mcpServers(page))[0]?.instructions.enabled).toBe(true)
    await page.getByTestId('connector-edit').click()
    await page.getByTestId('mcp-envKeys').fill('["TOKEN"]')
    await page.getByTestId('mcp-secret-TOKEN').fill('fixture-secret')
    await page.getByTestId('mcp-timeout').fill('12')
    await page.getByTestId('connector-save').click()
    await page.getByTestId('grant-persistent').click()
    await connected(page)
    await expect(detail).toContainText('Call 12s')
    await detail.getByRole('button', { name: 'Revoke authorization' }).click()
    await expect(detail).toContainText('Confirmation required')
    await detail.getByTestId('connector-connect').click()
    await page.getByTestId('grant-run').click()
    await connected(page)
    await detail.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.getByTestId('connector-delete-confirm').click()
    await expect(page.getByTestId('connector-notes')).toHaveCount(0)
    await addStdio(page, 'notes')
    await page.getByTestId('mcp-envKeys').fill('["TOKEN"]')
    await expect(page.getByTestId('mcp-secret-TOKEN')).toHaveValue('')
    await page.getByTestId('connector-save').click()
    await page.getByTestId('grant-run').click()
    await expect(page.getByTestId('connector-form').getByRole('alert')).toHaveText(
      'Enter a secret value',
    )
    await page.getByTestId('mcp-secret-TOKEN').fill('new-fixture-secret')
    await page.getByTestId('connector-save').click()
    await page.getByTestId('grant-run').click()
    await connected(page)
    await addStdio(page, 'other')
    await page.getByTestId('connector-save').click()
    await page.getByTestId('grant-persistent').click()
    await connected(page, 'other')
    await page.getByTestId('connector-down-notes').click()
    await expect
      .poll(async () => (await mcpServers(page)).map((s) => s.id))
      .toEqual(['other', 'notes'])
    await page.getByTestId('connector-up-notes').click()
    await expect
      .poll(async () => (await mcpServers(page)).map((s) => s.id))
      .toEqual(['notes', 'other'])
    await page.getByTestId('connector-other').getByRole('switch').click()
    await expect(page.getByTestId('connector-other')).toContainText('Disabled')
    await page.getByTestId('connector-other').getByRole('switch').click()
    await connected(page, 'other')
  } finally {
    await app.close()
    await fake.close()
  }
})

test('03 验收 25: npx unpinned warning and escaped environment/path preview', async () => {
  const userData = makeUserDataDir('connector-npx')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  try {
    await openConnectors(page)
    await addStdio(page, 'draft')
    await page.getByTestId('mcp-command').fill('npx')
    await page.getByTestId('mcp-args').fill('["unversioned-package"]')
    await page.getByTestId('mcp-envs').fill(JSON.stringify({ NODE_PATH: 'a\u202Eb' }))
    await page.getByTestId('connector-save').click()
    await expect(page.getByTestId('grant-warnings')).toContainText(
      'Package version is not pinned: unversioned-package',
    )
    await expect(page.getByTestId('connector-grant')).toContainText('NODE_PATH=a\\u{202E}b')
    await page.getByTestId('grant-cancel').click()
    expect(await mcpServers(page)).toEqual([])
  } finally {
    await app.close()
  }
})

test('03 验收 35/44: capped configured provider displays its name and omitted count', async () => {
  const userData = makeUserDataDir('connector-cap')
  seedConfig(userData, {
    locale: 'en',
    mcpServers: [stdioConfig('notes', ['--tool-count', '130'])],
  })
  const { app, page } = await launchTenon({ userData, env: { ZHIPU_API_KEY: 'e2e-fixture-key' } })
  try {
    await connected(page)
    await openConnectors(page)
    await expect(page.getByTestId('connectors-pane')).toContainText('Zhipu')
    await expect(page.getByTestId('connectors-pane')).toContainText('additional tools unavailable')
    expect(
      JSON.stringify(await page.evaluate(() => window.tenon.invoke('mcp.list', {}))),
    ).toContain('omitted')
  } finally {
    await app.close()
  }
})

test('03 验收 4/44: crashed process shows its error and stderr tail', async () => {
  const crash = stdioConfig()
  crash.transport = {
    type: 'stdio',
    command: process.execPath,
    args: [join(MODERN_FIXTURE, '..', 'crash-server.mjs')],
    envs: {},
    env_keys: [],
  }
  const { launchHash } = await import('../src/main/mcp/runtime.js')
  crash.consent = { launchHash: launchHash(crash) }
  const hold = deferred(),
    call = callsReply(connectorCall('toolu_crash', 'crash'))
  const fake = await startFakeAnthropic({
    replies: [
      { ...call, steps: [{ type: 'wait', until: hold.promise }, ...(call.steps ?? [])] },
      textReply('crashed'),
    ],
  })
  const userData = makeUserDataDir('connector-crash')
  seedConfig(userData, { locale: 'en', mcpServers: [crash] })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await connected(page)
    await openConnectors(page)
    await page
      .getByTestId('connector-notes')
      .getByRole('button', { name: /Notes fixture/ })
      .click()
    await page.getByTestId('tool-setting-crash').selectOption('always-allow')
    await closeSettings(page)
    await send(page, 'crash')
    await openConnectors(page)
    await page
      .getByTestId('connector-notes')
      .getByRole('button', { name: /Notes fixture/ })
      .click()
    hold.resolve()
    await expect(page.getByTestId('connector-detail')).toContainText(
      'The process exited unexpectedly',
    )
    await expect(page.getByTestId('connector-detail')).toContainText('line 29')
  } finally {
    await app.close()
    await fake.close()
  }
})

test('03 验收 38/39: release uses the viewed hash, stale refreshes and server text is escaped', async () => {
  const userData = makeUserDataDir('connector-stale'),
    file = join(userData, 'definition.json')
  writeFileSync(file, JSON.stringify({ description: 'initial' }))
  seedConfig(userData, {
    locale: 'en',
    mcpServers: [stdioConfig('notes', ['--definition-file', file])],
  })
  const { app, page } = await launchTenon({ userData })
  try {
    await connected(page)
    writeFileSync(file, JSON.stringify({ description: 'one\u202Etext' }))
    await expect.poll(async () => (await mcpServers(page))[0]?.toolViews[0]?.review).toBe('changed')
    await openConnectors(page)
    await page
      .getByTestId('connector-notes')
      .getByRole('button', { name: /Notes fixture/ })
      .click()
    const tool = page.getByTestId('connector-tool-echo')
    await expect(page.getByTestId('tool-setting-echo')).toBeDisabled()
    await expect(tool).toContainText('one\\u{202E}text')
    await tool.getByRole('button', { name: 'View changes' }).click()
    await expect(page.getByTestId('connector-review-dialog')).toContainText('one\\u{202E}text')
    writeFileSync(file, JSON.stringify({ description: 'two\u202Etext' }))
    await expect
      .poll(async () => (await mcpServers(page))[0]?.toolViews[0]?.description)
      .toBe('two\u202Etext')
    await page.getByTestId('connector-review-dialog').locator('[data-slot="dialog-close"]').click()
    await page.getByTestId('tool-release-echo').click()
    await expect(page.getByTestId('connector-detail').getByRole('alert')).toHaveText(
      'Definition changed again; refresh',
    )
    await tool.getByRole('button', { name: 'View changes' }).click()
    await expect(page.getByTestId('connector-review-dialog')).toContainText('two\\u{202E}text')
    await page.getByTestId('connector-review-dialog').locator('[data-slot="dialog-close"]').click()
    await page.getByTestId('tool-release-echo').click()
    await expect(page.getByTestId('tool-setting-echo')).toBeEnabled()
  } finally {
    await app.close()
  }
})
