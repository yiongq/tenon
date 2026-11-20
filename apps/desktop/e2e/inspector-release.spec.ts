import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  waitingApproval,
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

test('06 验收 27: a blocked command is allowed once from its receipt and then runs', async () => {
  const folders = makeFolderTree('inspector-release', { 'ws/keep.txt': 'keep\n' })
  tree = folders
  const workspace = join(folders.real, 'ws')
  const output = join(workspace, 'receipt-output.txt')
  // The JS escape becomes a raw BEL in the command argument, not a shell escape. Both POSIX
  // shells print it verbatim; only a new file in this test's temporary workspace is changed.
  const printed = 'receipt-allowed-\u0007-once'
  const command = `printf '%s' '${printed}' > receipt-output.txt`
  fake = await startFakeAnthropic({
    replies: [
      callsReply(bashCall('blocked_command', command)),
      textReply('Command blocked.'),
      callsReply(bashCall('released_command', command)),
      textReply('Command finished.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('inspector-release')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, workspace)
    await send(page, 'run the command')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Command blocked.')
    await expect(page.getByTestId('composer-stop')).toHaveCount(0)

    const rows = page.getByTestId('tool-row')
    await expect(rows).toHaveCount(1)
    const receipt = rows.first().getByTestId('blocked-receipt')
    await expect(receipt).toBeVisible()
    const notice = receipt.getByTestId('blocked-notice')
    await expect(notice).toHaveAttribute('data-source', 'inspector')
    await expect(notice).toHaveText('路径或命令里有控制字符，已拦下。')
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    expect(existsSync(output)).toBe(false)
    const blockedFacts = tapeFacts(userData)
    // A default manual task need not write a mode fact; absence also means manual.
    expect(
      named(blockedFacts, 'session/approval_mode_set').at(-1)?.payload['mode'] ?? 'manual',
    ).toBe('manual')
    expect(named(blockedFacts, 'execution/tool_outcome')).toMatchObject([
      {
        payload: {
          providerToolCallId: 'blocked_command',
          state: 'not-run',
          source: 'inspector',
          facts: { category: 'control-characters' },
        },
      },
    ])
    expect(named(blockedFacts, 'execution/dispatch_committed')).toHaveLength(0)

    const release = receipt.getByTestId('receipt-allow-once')
    await expect(release).toHaveText('允许这一次')
    await expect(release).toBeEnabled()
    await expect(receipt.getByTestId('receipt-action-note')).toHaveText(
      '在这个任务里再发出完全相同的这一步时生效一次；到下一轮回复结束还没用上就作废',
    )
    await release.click()
    await expect(release).toHaveText('已放行')
    await expect(release).toBeDisabled()
    // Releasing the receipt alone must neither resend to the model nor start the command.
    expect(server.requests).toHaveLength(2)
    expect(existsSync(output)).toBe(false)
    expect(named(tapeFacts(userData), 'execution/dispatch_committed')).toHaveLength(0)
    await expect(page.getByTestId('approval-card')).toHaveCount(0)

    await send(page, 'retry the identical command')
    await expect(rows).toHaveCount(2)
    const retried = rows.nth(1)
    const card = retried.getByTestId('approval-card')
    await expect(card).toBeVisible()
    await expect(page.getByTestId('approval-card')).toHaveCount(1)
    const pending = await waitingApproval(page)
    expect(pending.card.reason).toBe('command')
    expect(pending.allowScope).toBe('session')
    expect(pending.card.target).toEqual({ type: 'command', command, cwd: workspace })
    await expect(retried.getByTestId('blocked-receipt')).toHaveCount(0)
    expect(server.requests).toHaveLength(3)
    expect(existsSync(output)).toBe(false)
    expect(named(tapeFacts(userData), 'execution/dispatch_committed')).toHaveLength(0)
    expect(named(tapeFacts(userData), 'tool/call').map((fact) => fact.payload['input'])).toEqual([
      { command },
      { command },
    ])

    await allowCard(page)
    await expect(page.getByTestId('approval-card')).toHaveCount(0)
    await expect(retried.getByTestId('approval-answered')).toHaveAttribute(
      'data-outcome',
      'allowed',
    )
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Command finished.')
    await expect(page.getByTestId('composer-stop')).toHaveCount(0)
    expect(readFileSync(output, 'utf8')).toBe(printed)
    const finishedFacts = tapeFacts(userData)
    expect(named(finishedFacts, 'execution/dispatch_committed')).toMatchObject([
      { payload: { providerToolCallId: 'released_command', name: 'Bash' } },
    ])
    expect(named(finishedFacts, 'execution/tool_outcome')).toMatchObject([
      { payload: { providerToolCallId: 'blocked_command', state: 'not-run', source: 'inspector' } },
      { payload: { providerToolCallId: 'released_command', state: 'completed', source: null } },
    ])
    await expect(release).toHaveText('已放行')
    await expect(release).toBeDisabled()
    expect(server.requests).toHaveLength(4)
    expect(server.unscripted).toBe(0)
  } finally {
    await app.close()
  }
})
