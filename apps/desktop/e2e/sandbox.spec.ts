import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import type { TapeEntry } from '@tenon-app/kernel'
import type { Page } from '@playwright/test'
import { sandboxDomainHosts } from '../../../packages/kernel/src/permission/sandbox-release.js'
import { messageBodies, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import { test, expect } from './helpers/test.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { closeSettings } from './helpers/connectors.js'
import { PAST_CLICK_GUARD_MS } from './helpers/navigation.js'
import {
  bashCall,
  callsReply,
  makeFolderTree,
  providerEnv,
  send,
  startTask,
  textReply,
  waitingApproval,
} from './helpers/tools.js'

/** Read only this test's personal Tape, independently of the renderer's projection. */
function sandboxFacts(userData: string, name: string): Record<string, unknown>[] {
  const db = new Database(join(dirname(configPathIn(userData)), 'sessions.db'), {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const rows = db
      .prepare(
        'SELECT payload_json FROM tape_entry WHERE tenant_id = ? AND name = ? ORDER BY entry_id',
      )
      .all('personal', name) as Array<{ payload_json: string }>
    return rows.map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)
  } finally {
    db.close()
  }
}

/** The same persisted session entries the kernel reads when supplying beforeWrap's hosts. */
function sessionEntries(userData: string, sessionId: string): TapeEntry[] {
  const db = new Database(join(dirname(configPathIn(userData)), 'sessions.db'), {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const rows = db
      .prepare(
        `SELECT tenant_id AS tenantId, session_id AS sessionId, entry_id AS entryId,
          incarnation_id AS incarnationId, kind, name, source_type AS sourceType,
          source_id AS sourceId, source_seq AS sourceSeq, provenance_key AS provenanceKey,
          payload_json AS payload, meta_json AS meta, created_at AS createdAt,
          content_hash AS contentHash, prev_hash AS prevHash, entry_hash AS entryHash,
          hash_ver AS hashVer
        FROM tape_entry WHERE tenant_id = ? AND session_id = ? ORDER BY entry_id`,
      )
      .all('personal', sessionId) as Array<
      Omit<TapeEntry, 'payload' | 'meta'> & {
        payload: string
        meta: string
      }
    >
    return rows.map((row) =>
      Object.assign(row, {
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        meta: JSON.parse(row.meta) as Record<string, unknown>,
      }),
    )
  } finally {
    db.close()
  }
}

async function allowCommand(page: Page) {
  await expect(page.getByTestId('approval-card')).toBeVisible()
  await page.waitForTimeout(PAST_CLICK_GUARD_MS)
  await page.getByTestId('approval-allow').click()
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
}

async function openPermissions(page: Page) {
  await page.getByTestId('account-row').click()
  await page.getByTestId('account-permissions').click()
  await expect(page.getByTestId('sandbox-pane')).toBeVisible()
}
function savedSettings(userData: string): unknown {
  return (JSON.parse(readFileSync(configPathIn(userData), 'utf8')) as { sandbox: unknown }).sandbox
}

for (const locale of ['zh-CN', 'en'] as const) {
  test(`04 验收 30: permissions pane validates, saves and restores command settings (${locale})`, async () => {
    const userData = makeUserDataDir('sandbox-settings')
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData })
    try {
      await openPermissions(page)
      const pane = page.getByTestId('sandbox-pane')
      await expect(page.getByTestId('provider-settings').getByRole('tab')).toHaveCount(3)
      await expect(page.getByTestId('settings-permissions')).toHaveText(
        locale === 'zh-CN' ? '权限与网络' : 'Permissions & network',
      )
      const status = page.getByTestId('sandbox-status')
      await expect(status).toHaveCount(1)
      await expect(status.locator('summary')).toContainText(
        locale === 'zh-CN' ? '沙箱已生效' : 'Sandbox active',
      )
      await expect(status).toContainText(
        locale === 'zh-CN' ? '这是测试接缝' : 'This is a test seam',
      )
      await expect(status).not.toHaveAttribute('open', '')
      await status.locator('summary').click()
      await expect(status).toContainText('fake')
      const input = page.getByTestId('sandbox-domain-input')
      await input.fill('*.com')
      await input.press('Enter')
      await expect(pane.getByRole('alert')).toHaveText(
        locale === 'zh-CN'
          ? '第 1 条地址无效，请检查写法。'
          : 'Address 1 is invalid. Check its format.',
      )
      await expect(input).toHaveValue('*.com')
      await expect(input).toBeEnabled()
      await input.fill('EXAMPLE.COM')
      await input.press('Enter')
      await expect(pane.getByRole('alert')).toHaveCount(0)
      await expect(page.getByTestId('sandbox-domain')).toContainText('example.com')
      await expect(input).toHaveValue('')
      await input.fill('localhost:3000')
      await input.press('Enter')
      await expect(
        page.getByTestId('sandbox-domain').filter({ hasText: 'localhost:3000' }),
      ).toContainText(
        locale === 'zh-CN' ? '只对走代理的客户端有效' : 'only for clients using the proxy',
      )
      await page
        .getByTestId('sandbox-domain')
        .filter({ hasText: 'example.com' })
        .getByRole('button')
        .click()
      await expect(page.getByTestId('sandbox-domain')).toHaveCount(1)
      const preset = page.getByTestId('sandbox-preset')
      await expect(preset).not.toHaveAttribute('open', '')
      await preset.locator('summary').click()
      await expect(preset).toContainText('registry.npmjs.org')
      await expect(preset).toContainText(
        locale === 'zh-CN' ? '同时接受 npm 发布' : 'also accepts npm publishing',
      )
      await expect(preset).toContainText('sandbox-cache')
      await page.getByTestId('sandbox-package-managers').check()
      await expect(page.getByTestId('sandbox-package-managers')).toBeChecked()
      const advanced = page.getByTestId('sandbox-advanced')
      await expect(advanced).not.toHaveAttribute('open', '')
      await advanced.locator('summary').click()
      await advanced.locator('input[value="read-only"]').check()
      await expect(advanced.locator('input[value="read-only"]')).toBeChecked()
      await expect
        .poll(() => savedSettings(userData))
        .toEqual({
          profile: 'read-only',
          allowedDomains: ['localhost:3000'],
          packageManagers: true,
        })
      // A change pushed from outside this pane must update its controlled inputs too.
      const changed = await page.evaluate(() =>
        window.tenon.invoke('sandbox.setSettings', { profile: 'workspace-write' }),
      )
      expect(changed).toEqual({ ok: true, data: { ok: true } })
      await expect(advanced.locator('input[value="workspace-write"]')).toBeChecked()
      await advanced.locator('input[value="read-only"]').check()
      await expect(advanced.locator('input[value="read-only"]')).toBeChecked()
      await closeSettings(page)
      // The location hash must open the new pane directly, as it does the existing sections.
      await page.evaluate(() => {
        window.location.hash = '#settings/permissions'
      })
      await expect(page.getByTestId('sandbox-pane')).toBeVisible()
      await expect(page.getByTestId('sandbox-package-managers')).toBeChecked()
    } finally {
      await app.close()
    }
    const relaunched = await launchTenon({ userData })
    try {
      await openPermissions(relaunched.page)
      await expect(relaunched.page.getByTestId('sandbox-package-managers')).toBeChecked()
      await expect(relaunched.page.getByTestId('sandbox-domain')).toContainText('localhost:3000')
      await relaunched.page.getByTestId('sandbox-advanced').locator('summary').click()
      await expect(
        relaunched.page.locator('input[name="sandbox-profile"][value="read-only"]'),
      ).toBeChecked()
      await expect
        .poll(() => savedSettings(userData))
        .toEqual({
          profile: 'read-only',
          allowedDomains: ['localhost:3000'],
          packageManagers: true,
        })
    } finally {
      await relaunched.app.close()
    }
  })
}

test('04 验收 30: off seam shows an unavailable reason and keeps the fix behind the expander', async () => {
  const userData = makeUserDataDir('sandbox-settings-off')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: { TENON_TEST_SANDBOX: 'off' } })
  try {
    await openPermissions(page)
    const status = page.getByTestId('sandbox-status')
    await expect(status.locator('summary')).toContainText('Sandbox unavailable')
    await expect(status.locator('summary')).toContainText('This is a test seam')
    await expect(page.getByTestId('sandbox-reason-test-seam')).toBeHidden()
    await status.locator('summary').click()
    await expect(page.getByTestId('sandbox-reason-test-seam')).toContainText(
      'TENON_TEST_SANDBOX removed',
    )
    await expect(page.getByTestId('sandbox-reason-test-seam')).toContainText('off')
  } finally {
    await app.close()
  }
})

for (const locale of ['zh-CN', 'en'] as const) {
  test(`04 验收 18 (e2e): with \`off\`, a command card shows the unavailable line (${locale})`, async () => {
    const tree = makeFolderTree('sandbox-off-card', { 'ws/keep.txt': 'keep' })
    const fake = await startFakeAnthropic({
      replies: [callsReply(bashCall('off_command', 'printf off')), textReply('Declined.')],
    })
    const userData = makeUserDataDir('sandbox-off-card')
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({
      userData,
      env: { ...providerEnv(fake.baseURL), TENON_TEST_SANDBOX: 'off' },
    })
    try {
      await startTask(app, page, join(tree.real, 'ws'))
      await send(page, 'run the command')
      const pending = await waitingApproval(page)
      expect(pending.card.reason).toBe('command')
      expect(pending.card.facts).toEqual({
        command: 'printf off',
        cwd: join(tree.real, 'ws'),
        sandbox: 'unavailable',
      })
      await expect(page.getByTestId('approval-unavailable')).toHaveText(
        locale === 'zh-CN'
          ? '沙箱不可用，将以你的权限运行'
          : 'Sandbox unavailable; this command will run with your permissions',
      )
      await expect(page.getByTestId('approval-reason')).toHaveCount(0)
      await page.waitForTimeout(PAST_CLICK_GUARD_MS)
      await page.getByTestId('approval-deny').click()
      await expect(page.getByTestId('approval-card')).toHaveCount(0)
      await expect(page.getByTestId('assistant-text').last()).toHaveText('Declined.')
    } finally {
      await app.close()
      await fake.close()
      tree.dispose()
    }
  })
}

test('04 验收 32: a blocked command, 在这个任务里允许连接, the next request carries the release note and the allowlist has the host', async () => {
  const tree = makeFolderTree('sandbox-domain', { 'ws/keep.txt': 'keep' })
  const fake = await startFakeAnthropic({
    replies: [
      callsReply(bashCall('blocked_domain', ': tenon-test-blocked:registry.example.test')),
      textReply('Connection blocked.'),
      callsReply(bashCall('next_command', 'printf next')),
      textReply('Finished.'),
    ],
  })
  const userData = makeUserDataDir('sandbox-domain')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await startTask(app, page, join(tree.real, 'ws'))
    await send(page, 'connect')
    const sessionId = (await waitingApproval(page)).card.sessionId
    await allowCommand(page)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Connection blocked.')
    const receipt = page.getByTestId('sandbox-notice')
    await expect(receipt.getByTestId('receipt-objects')).toHaveText(
      '没能连接 registry.example.test',
    )
    await expect(receipt.getByTestId('receipt-why')).toHaveText('这个网站不在允许连接的列表里')
    const release = receipt.getByTestId('receipt-allow-domain')
    await expect(release).toHaveText('在这个任务里允许连接 registry.example.test')
    await release.click()
    await expect(release).toHaveText('已放行')
    await expect(release).toBeDisabled()
    expect(fake.requests).toHaveLength(2)
    // Session grants feed beforeWrap's hosts; the permanent settings list stays empty.
    expect(sandboxFacts(userData, 'tool/receipt_override')).toMatchObject([
      { action: 'allow-domain', target: 'registry.example.test', via: 'receipt-override' },
    ])
    expect(await sandboxDomainHosts(async (id) => sessionEntries(userData, id), sessionId)).toEqual(
      ['registry.example.test'],
    )
    await openPermissions(page)
    await expect(page.getByTestId('sandbox-domain')).toHaveCount(0)
    await closeSettings(page)
    await send(page, 'continue with another command')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Finished.')
    expect(fake.requests).toHaveLength(4)
    const nextMessages = messageBodies(fake)[2]!.messages
    expect(nextMessages).toContainEqual({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<sandbox_release>\nThe user granted the following permissions:\nCommands may connect to "registry.example.test" for this session.\n</sandbox_release>',
        },
      ],
    })
    await expect(page.getByTestId('user-text')).toHaveCount(2)
    await expect(
      page.getByTestId('user-text').filter({ hasText: '<sandbox_release>' }),
    ).toHaveCount(0)
    expect(fake.unscripted).toBe(0)
  } finally {
    await app.close()
    await fake.close()
    tree.dispose()
  }
})

test('04 验收 32: 允许这条命令下次不受限制地运行一次 runs nothing by itself; the resent command shows the elevated card, runs full-access once, then the next is back in the sandbox', async () => {
  const tree = makeFolderTree('sandbox-rerun', { 'ws/keep.txt': 'keep' })
  const runs = join(tree.real, 'ws/runs.txt')
  const command =
    "printf 'run\\n' >> runs.txt; printf ran; : tenon-test-blocked:registry.example.test"
  const fake = await startFakeAnthropic({
    replies: [
      callsReply(bashCall('blocked_once', command)),
      textReply('Blocked.'),
      callsReply(bashCall('elevated_once', command)),
      callsReply(bashCall('restricted_again', command)),
      textReply('Finished.'),
    ],
  })
  const userData = makeUserDataDir('sandbox-rerun')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
  try {
    await startTask(app, page, join(tree.real, 'ws'))
    await send(page, 'run once')
    expect(existsSync(runs)).toBe(false)
    await allowCommand(page)
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Blocked.')
    expect(readFileSync(runs, 'utf8')).toBe('run\n')
    const release = page.getByTestId('receipt-rerun-unsandboxed')
    await release.click()
    await expect(release).toHaveText('Allowed')
    await expect(release).toBeDisabled()
    // Wait beyond a new card's guard: neither a provider call nor a process may start on click.
    await page.waitForTimeout(PAST_CLICK_GUARD_MS)
    expect(fake.requests).toHaveLength(2)
    expect(readFileSync(runs, 'utf8')).toBe('run\n')
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    await send(page, 'retry the identical command twice')
    const pending = await waitingApproval(page)
    expect(pending.card.reason).toBe('elevated')
    expect(pending.allowScope).toBe('once')
    await expect(page.getByTestId('approval-reason')).toHaveText(
      'This command will run without restrictions this once, just as if you ran it in a terminal: it can read and write every file you can access and connect to any site. This allows it once only and will not be remembered.\n' +
        command,
    )
    await expect(page.getByTestId('approval-allow')).toContainText('Allow (Just this once)')
    expect(readFileSync(runs, 'utf8')).toBe('run\n')
    await allowCommand(page)
    // Reusing the binding would pause on another elevated card instead of finishing.
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Finished.')
    expect(readFileSync(runs, 'utf8')).toBe('run\nrun\nrun\n')
    const rows = page.getByTestId('tool-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0).getByTestId('sandbox-notice')).toBeVisible()
    await expect(rows.nth(1).getByTestId('sandbox-notice')).toHaveCount(0)
    await expect(rows.nth(2).getByTestId('sandbox-notice')).toBeVisible()
    expect(
      sandboxFacts(userData, 'tool/permission_decided')
        .filter((p) => p['rejudge'] === undefined)
        .map((p) => p['sandbox']),
    ).toMatchObject([
      { profile: 'workspace-write' },
      { profile: 'full-access', override: { action: 'rerun-unsandboxed' } },
      { profile: 'workspace-write' },
    ])
    expect(fake.requests).toHaveLength(5)
    expect(fake.unscripted).toBe(0)
  } finally {
    await app.close()
    await fake.close()
    tree.dispose()
  }
})
