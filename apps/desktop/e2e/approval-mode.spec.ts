import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcResultSchema, sandboxGet } from '@tenon-app/contracts'
import type { Page } from '@playwright/test'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { allowCard } from './helpers/navigation.js'
import { named, tapeFacts } from './helpers/tape.js'
import { expect, test } from './helpers/test.js'
import {
  bashCall,
  callsReply,
  makeFolderTree,
  providerEnv,
  send,
  startTask,
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
