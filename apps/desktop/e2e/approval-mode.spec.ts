import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcResultSchema, sandboxGet } from '@tenon-app/contracts'
import type { Page } from '@playwright/test'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { allowCard } from './helpers/navigation.js'
import { named, tapeFacts } from './helpers/tape.js'
import { expect, test } from './helpers/test.js'
import {
  bashCall,
  callsReply,
  grantFolder,
  makeFolderTree,
  providerEnv,
  send,
  startTask,
  stubFolderDialog,
  textReply,
  writeCall,
} from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

let fake: FakeAnthropic | undefined
let tree: FolderTree | undefined
test.afterEach(async () => {
  await fake?.close()
  fake = undefined
  tree?.dispose()
  tree = undefined
})

const ORIGINAL = 'original line\n'
const CHANGED = 'changed in auto\n'
const WRITTEN = '文件修改完成。'
const RAN = '命令完成。'
const WRITTEN_AGAIN = '又改了一次。'
const LINUX_SENTENCE = '在 Linux 上，自动档里的命令照样先问你：这里护不住命令新建的仓库文件。'

/** What main last wrote to config.json (only main writes it). */
function savedConfig(userData: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPathIn(userData), 'utf8')) as Record<string, unknown>
}

async function sandboxState(page: Page): Promise<string | null> {
  const result = ipcResultSchema(sandboxGet.response).parse(
    await page.evaluate(() => window.tenon.invoke('sandbox.get', {})),
  )
  return result.ok ? result.data.posture.state : null
}

/**
 * Spec 06 §界面, acceptance 40 (macOS, Linux). On macOS the real sandbox must be active before a
 * command can go unasked (m12): the test waits for it. Linux e2e has no bubblewrap, so it takes the
 * test seam's active posture: the command is asked there for being on Linux, not for the posture.
 */
test('06 验收 40: auto mode writes and restores unasked, the banner returns to manual', async () => {
  const linux = process.platform === 'linux'
  const folders = makeFolderTree('approval-mode', { 'ws/notes.txt': ORIGINAL })
  tree = folders
  const workspace = join(folders.real, 'ws')
  const file = join(workspace, 'notes.txt')
  const made = join(workspace, 'made-by-command.txt')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(writeCall('auto_write', file, CHANGED)),
      textReply(WRITTEN),
      callsReply(bashCall('auto_command', 'touch made-by-command.txt')),
      textReply(RAN),
      callsReply(writeCall('manual_write', file, CHANGED)),
      textReply(WRITTEN_AGAIN),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('approval-mode')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...(linux ? { TENON_TEST_SANDBOX: 'fake' } : {}) },
  })
  try {
    await startTask(app, page, workspace)
    // 「允许」 adds the folder to this task only: nothing is kept for later picks (D42).
    expect(savedConfig(userData)['folderAccess'] ?? []).toEqual([])
    // The task draft has the menu, in manual by default; auto brings the banner and, once, the notice.
    const trigger = page.getByTestId('approval-mode-trigger')
    await expect(trigger).toHaveAttribute('data-mode', 'manual')
    await trigger.click()
    await page.getByTestId('approval-mode-auto').click()
    await expect(trigger).toHaveAttribute('data-mode', 'auto')
    const banner = page.getByTestId('auto-banner')
    await expect(banner).toContainText('自动档：能还原的改动不再问你')
    await expect(page.getByTestId('auto-notice')).toBeVisible()
    await page.getByTestId('auto-notice-dismiss').click()
    await expect(page.getByTestId('auto-notice')).toHaveCount(0)

    // A workspace Write goes unasked: the Run reaches its reply with no card in between.
    await send(page, '修改 notes.txt')
    await expect(page.getByTestId('assistant-text').last()).toHaveText(WRITTEN)
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    expect(readFileSync(file, 'utf8')).toBe(CHANGED)
    expect(named(tapeFacts(userData), 'session/approval_mode_set').at(-1)?.payload).toMatchObject({
      mode: 'auto',
      by: 'user',
    })

    // The round's summary line restores it in one step.
    const summary = page.getByTestId('turn-summary').last()
    await expect(summary).toContainText('改了 1 个文件')
    await summary.getByRole('button', { name: '可还原', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '还原这一轮的文件改动' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '确认还原', exact: true }).click()
    await expect(dialog).toContainText('已还原 1 个')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(readFileSync(file, 'utf8')).toBe(ORIGINAL)

    // A command: unasked in macOS's active sandbox; asked on Linux, with the Linux sentence.
    if (!linux) await expect.poll(() => sandboxState(page), { timeout: 30_000 }).toBe('active')
    await send(page, '运行命令')
    if (linux) {
      const card = page.getByTestId('approval-card')
      await expect(card).toBeVisible()
      await expect(card.getByTestId('approval-reason')).toHaveText(LINUX_SENTENCE)
      await allowCard(page)
    }
    await expect(page.getByTestId('assistant-text').last()).toHaveText(RAN)
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    expect(existsSync(made)).toBe(true)

    // The banner is the way back: manual again, and the next Write is asked.
    await banner.click()
    await expect(banner).toHaveCount(0)
    await expect(trigger).toHaveAttribute('data-mode', 'manual')
    await send(page, '再改一次')
    await expect(page.getByTestId('approval-card')).toBeVisible()
    await allowCard(page)
    await expect(page.getByTestId('assistant-text').last()).toHaveText(WRITTEN_AGAIN)
    expect(
      named(tapeFacts(userData), 'session/approval_mode_set').map((fact) => [
        fact.payload['mode'],
        fact.payload['by'],
      ]),
    ).toEqual([
      ['auto', 'user'],
      ['manual', 'user'],
    ])
    expect(server.requests).toHaveLength(6)
    expect(server.unscripted).toBe(0)
  } finally {
    await app.close()
  }
})

test('06 验收 35: a kept default and kept folder show in settings, and revoking brings the dialog back', async () => {
  const folders = makeFolderTree('approval-settings', { 'kept/a.txt': 'a\n' })
  tree = folders
  const kept = join(folders.real, 'kept')
  const userData = makeUserDataDir('approval-settings')
  seedConfig(userData, { locale: 'zh-CN' })
  writeFileSync(
    configPathIn(userData),
    JSON.stringify({ locale: 'zh-CN', approvalMode: 'auto', folderAccess: [kept] }),
  )
  const { app, page } = await launchTenon({ userData })
  try {
    // A new task starts in the default config.json holds, through main's own wiring.
    await page.getByTestId('folder-toggle').click()
    const trigger = page.getByTestId('approval-mode-trigger')
    await expect(trigger).toHaveAttribute('data-mode', 'auto')
    // The kept folder is added with no dialog.
    const chip = page.getByTestId('folder-chip')
    await chip.click()
    const popup = page.getByTestId('folder-popover')
    await expect(popup).toHaveAttribute('data-open', '')
    await stubFolderDialog(app, [kept])
    await popup.getByTestId('folder-add').click()
    await expect(page.getByTestId('folder-item')).toHaveCount(1)
    await expect(page.getByTestId('folder-grant')).toHaveCount(0)
    // The popover's link opens 「权限与网络」: the default and the kept folder are there.
    await popup.getByTestId('folder-access-settings').click()
    const settings = page.getByTestId('provider-settings')
    await expect(settings).toBeVisible()
    await expect(settings.getByTestId('approval-default-auto')).toBeChecked()
    await expect(settings.getByTestId('folder-access-item')).toHaveCount(1)
    await expect(settings.getByTestId('folder-access-item')).toContainText('kept')
    await settings.getByTestId('folder-access-revoke').click()
    await expect(settings.getByTestId('folder-access-empty')).toBeVisible()
    expect(savedConfig(userData)['folderAccess']).toEqual([])
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    // This task keeps the folder; a later pick of it asks again, and 「取消」 adds nothing.
    await chip.click()
    await expect(popup).toHaveAttribute('data-open', '')
    await expect(page.getByTestId('folder-item')).toHaveCount(1)
    await stubFolderDialog(app, [kept])
    await popup.getByTestId('folder-add').click()
    await grantFolder(page, 'cancel')
    await expect(page.getByTestId('folder-item')).toHaveCount(1)
    expect(savedConfig(userData)['folderAccess']).toEqual([])
  } finally {
    await app.close()
  }
})
