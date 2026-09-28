import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import {
  callsReply,
  makeFolderTree,
  providerEnv,
  readCall,
  send,
  startTask,
  textReply,
  waitingApproval,
  writeCall,
} from './helpers/tools.js'

/** Parent Agent row -> forwarded child approval -> restart/deny -> next child approval -> handoff. */
test('a child’s cards stay under its parent row and its handoff survives restart', async () => {
  test.setTimeout(90_000)
  const folders = makeFolderTree('subagent', { 'ws/context.txt': 'parent context' })
  const deniedPath = join(folders.real, 'ws', 'denied.txt')
  const allowedPath = join(folders.real, 'ws', 'allowed.txt')
  const prompt = 'Prepare two small files and report back.'
  const fake = await startFakeAnthropic({
    replies: [
      callsReply(
        {
          type: 'tool_use',
          id: 'toolu_agent',
          name: 'Agent',
          input: { description: 'Prepare project notes', prompt },
        },
        readCall('toolu_parent_read', join(folders.real, 'ws', 'context.txt')),
      ),
      callsReply(writeCall('toolu_child_denied', deniedPath, 'declined child content')),
      callsReply(writeCall('toolu_child_allowed', allowedPath, 'approved child content')),
      textReply('Child handoff with control \u202E marker.'),
      textReply('Parent received the handoff.'),
    ],
  })
  const userData = makeUserDataDir('subagent')
  seedConfig(userData, { locale: 'en' })
  let anchor = ''
  let firstRequest = ''
  try {
    const first = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await startTask(first.app, first.page, join(folders.real, 'ws'))
      await send(first.page, 'Delegate the file preparation.')
      const card = first.page.getByTestId('approval-card')
      await expect(card).toBeVisible()
      const pending = await waitingApproval(first.page)
      anchor = pending.anchorCallKey
      firstRequest = pending.card.requestId
      expect(pending.callKey).not.toBe(anchor)
      const parent = first.page.locator(`[data-testid="tool-row"][data-call-key="${anchor}"]`)
      await expect(parent.getByTestId('tool-row-line')).toContainText('Prepare project notes')
      await expect(parent.getByTestId('approval-card')).toBeVisible()
      await expect(parent.getByTestId('approval-queued-row')).toHaveCount(1)
      await card.getByTestId('approval-change-toggle').click()
      await expect(card.getByTestId('approval-change-text')).toHaveText('declined child content')
      expect(fake.requests).toHaveLength(2)
    } finally {
      await first.app.close()
    }

    const second = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      const page = second.page
      const card = page.getByTestId('approval-card')
      await expect(card).toBeVisible()
      expect((await waitingApproval(page)).card.requestId).toBe(firstRequest)
      const parent = page.locator(`[data-testid="tool-row"][data-call-key="${anchor}"]`)
      await expect(parent.getByTestId('approval-card')).toBeVisible()
      await card.getByTestId('approval-change-toggle').click()
      await expect(card.getByTestId('approval-change-text')).toHaveText('declined child content')
      await page.waitForTimeout(600)
      await card.getByTestId('approval-deny').click()
      await expect
        .poll(async () => (await waitingApproval(page)).card.requestId)
        .not.toBe(firstRequest)
      await expect(card).toBeVisible()
      await card.getByTestId('approval-change-toggle').click()
      await expect(card.getByTestId('approval-change-text')).toHaveText('approved child content')
      expect(existsSync(deniedPath)).toBe(false)
      expect(fake.requests).toHaveLength(3)
      await page.waitForTimeout(600)
      await card.getByTestId('approval-allow').click()
      await expect(page.getByTestId('assistant-text').last()).toHaveText(
        'Parent received the handoff.',
      )
      expect(readFileSync(allowedPath, 'utf8')).toBe('approved child content')
      await parent.getByTestId('tool-row-line').click()
      await expect(parent.getByTestId('tool-row-details')).toContainText(prompt)
      await expect(parent.getByTestId('tool-row-details')).toContainText(
        'Child handoff with control \\u{202E} marker.',
      )
      await expect(page.getByTestId('approval-card')).toHaveCount(0)
    } finally {
      await second.app.close()
    }

    const third = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      const parent = third.page.locator(`[data-testid="tool-row"][data-call-key="${anchor}"]`)
      await expect(parent).toBeVisible()
      await parent.getByTestId('tool-row-line').click()
      await expect(parent.getByTestId('tool-row-details')).toContainText(prompt)
      await expect(parent.getByTestId('tool-row-details')).toContainText(
        'Child handoff with control \\u{202E} marker.',
      )
      await expect(third.page.getByTestId('approval-card')).toHaveCount(0)
    } finally {
      await third.app.close()
    }
  } finally {
    await fake.close()
    folders.dispose()
  }
})
