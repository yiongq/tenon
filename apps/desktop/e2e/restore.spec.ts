import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ipcResultSchema, sessionLatest, snapshotRounds } from '@tenon-app/contracts'
import type { Locator, Page } from '@playwright/test'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { allowCard } from './helpers/navigation.js'
import { named, tapeFacts } from './helpers/tape.js'
import { expect, test } from './helpers/test.js'
import {
  callsReply,
  deleteCall,
  makeFolderTree,
  providerEnv,
  send,
  startTask,
  textReply,
  waitingApproval,
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

const ORIGINAL = 'original bytes\r\n原来的第二行\n'
const CHANGED = 'changed by Write\n改过的内容\n'
const WRITTEN = '文件修改完成。'
const DELETED = '文件删除完成。'

/** Real user repository; no global Git settings, hooks or signing affect this fixture. */
function repository(tag: string) {
  const folders = makeFolderTree(tag, { 'workspace/notes.txt': ORIGINAL })
  tree = folders
  const workspace = join(folders.real, 'workspace')
  const file = join(workspace, 'notes.txt')
  chmodSync(file, 0o600)
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.filemode=true',
        '-c',
        'user.name=Tenon E2E',
        '-c',
        'user.email=e2e@example.invalid',
        ...args,
      ],
      {
        cwd: workspace,
        env: {
          PATH: process.env['PATH'],
          HOME: folders.real,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
        encoding: 'utf8',
      },
    )
  git('init', '--quiet', '--initial-branch=main')
  git('add', '--', 'notes.txt')
  git('commit', '--quiet', '-m', 'Original file')
  expect(git('status', '--porcelain')).toBe('')
  expect(existsSync(file)).toBe(true)
  const before = readFileSync(file)
  const mode = statSync(file).mode & 0o777
  expect(mode).toBe(0o600)
  return { workspace, file, before, mode, git }
}

function expectFile(file: string, bytes: Buffer, mode?: number) {
  expect(existsSync(file)).toBe(true)
  expect(readFileSync(file)).toEqual(bytes)
  expect(statSync(file).isFile()).toBe(true)
  if (mode !== undefined) expect(statSync(file).mode & 0o777).toBe(mode)
}

/** The only approval: its snapshot promise is checked before the existing click guard is crossed. */
async function approveSnapshot(page: Page, file: string) {
  const card = page.getByTestId('approval-card')
  await expect(card).toHaveCount(1)
  await expect(card.getByTestId('approval-undo')).toHaveText('有快照，这一轮可以一键还原。')
  const pending = await waitingApproval(page)
  expect(pending.card.target).toEqual({ type: 'path', path: file })
  await allowCard(page)
  return pending.card.sessionId
}

/** Scope the summary to the ending assistant message, not merely somewhere in the transcript. */
async function settlement(page: Page, reply: string, count: string): Promise<Locator> {
  const message = page.getByTestId('assistant-message').filter({
    has: page.getByTestId('assistant-text').filter({ hasText: reply }),
  })
  await expect(message).toHaveCount(1)
  await expect(message.getByTestId('assistant-text')).toHaveText(reply)
  await expect(page.getByTestId('turn-summary')).toHaveCount(1)
  const summary = message.getByTestId('turn-summary')
  await expect(summary).toContainText(count)
  await expect(summary.getByRole('button', { name: '可还原', exact: true })).toBeVisible()
  expect(
    await message.evaluate((element) => {
      const text = element.querySelector('[data-testid="assistant-text"]')!
      const end = element.querySelector('[data-testid="turn-summary"]')!
      return Boolean(text.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING)
    }),
  ).toBe(true)
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
  return summary
}

async function restoreFile(page: Page, summary: Locator, file: string) {
  await summary.getByRole('button', { name: '可还原', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '还原这一轮的文件改动' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: '将还原 1 个', exact: true })).toBeVisible()
  await expect(dialog.getByRole('listitem')).toHaveText([file])
  await expect(dialog.getByRole('heading', { name: '将跳过 0 个', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '确认还原', exact: true }).click()
  await expect(dialog).toContainText('已还原 1 个、删除 0 个、保留 0 个、跳过 0 个；0 个未完成。')
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
}

/** Read-only verification of D63's anchor; it never creates a round or asks for a restore. */
async function ending(page: Page, sessionId: string) {
  const result = ipcResultSchema(snapshotRounds.response).parse(
    await page.evaluate(
      (id) => window.tenon.invoke('snapshot.rounds', { sessionId: id }),
      sessionId,
    ),
  )
  if (!result.ok || !result.data.ok) throw new Error('Cannot read snapshot rounds')
  expect(result.data.rounds).toHaveLength(1)
  const round = result.data.rounds[0]!
  expect(round.canRestore).toBe(true)
  expect(round.endMessageId).not.toBeNull()
  const latest = ipcResultSchema(sessionLatest.response).parse(
    await page.evaluate(() => window.tenon.invoke('session.latest', { limit: 50 })),
  )
  if (!latest.ok || latest.data === null) throw new Error('Missing stored conversation')
  expect(latest.data.sessionId).toBe(sessionId)
  const last = latest.data.messages.at(-1)!
  expect(last.messageId).toBe(round.endMessageId)
  expect(last.role).toBe('assistant')
  expect(last.content).toEqual([{ type: 'text', text: WRITTEN }])
  return { roundRunId: round.roundRunId, endMessageId: round.endMessageId }
}

async function writeAndRestore(restart: boolean) {
  const tag = restart ? 'restore-history' : 'restore-write'
  const repo = repository(tag)
  fake = await startFakeAnthropic({
    replies: [callsReply(writeCall('toolu_write', repo.file, CHANGED)), textReply(WRITTEN)],
  })
  const server = fake
  const userData = makeUserDataDir(tag)
  seedConfig(userData, { locale: 'zh-CN' })
  const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  let sessionId: string
  let anchor: Awaited<ReturnType<typeof ending>>
  try {
    const { app, page } = first
    await startTask(app, page, repo.workspace)
    // No preparatory round or tree-status wait: warming file copies must honour the card.
    await send(page, '修改 notes.txt')
    expectFile(repo.file, repo.before, repo.mode)
    sessionId = await approveSnapshot(page, repo.file)
    const summary = await settlement(page, WRITTEN, '改了 1 个文件')
    expectFile(repo.file, Buffer.from(CHANGED))
    expect(repo.git('status', '--porcelain')).toBe(' M notes.txt\n')
    expect(server.requests).toHaveLength(2)
    anchor = await ending(page, sessionId)
    expect(named(tapeFacts(userData), 'message/assistant').at(-1)?.payload['messageId']).toBe(
      anchor.endMessageId,
    )
    if (!restart) {
      await restoreFile(page, summary, repo.file)
      expectFile(repo.file, repo.before, repo.mode)
      expect(repo.git('status', '--porcelain')).toBe('')
    }
  } finally {
    await first.app.close()
  }
  if (!restart) return

  // A new Electron process, the same userData, and no new model request or preparation turn.
  const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    const { page } = second
    await expect(page.getByTestId('user-text')).toHaveText('修改 notes.txt')
    const summary = await settlement(page, WRITTEN, '改了 1 个文件')
    expect(await ending(page, sessionId)).toEqual(anchor)
    expect(server.requests).toHaveLength(2)
    expectFile(repo.file, Buffer.from(CHANGED))
    await restoreFile(page, summary, repo.file)
    expectFile(repo.file, repo.before, repo.mode)
    expect(repo.git('status', '--porcelain')).toBe('')
    expect(server.requests).toHaveLength(2)
  } finally {
    await second.app.close()
  }
}

test('05 验收 15: write task, approve, summary, restore, content back and git status clean', async () => {
  await writeAndRestore(false)
})

test('05 验收 33: D63 restores from the same ending message after restarting with the same userData', async () => {
  test.setTimeout(120_000)
  await writeAndRestore(true)
})

test('05 验收 29: Delete promises a snapshot, counts the deletion, and restores bytes and permissions', async () => {
  const repo = repository('restore-delete')
  fake = await startFakeAnthropic({
    replies: [callsReply(deleteCall('toolu_delete', repo.file)), textReply(DELETED)],
  })
  const server = fake
  const userData = makeUserDataDir('restore-delete')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, repo.workspace)
    await send(page, '删除 notes.txt')
    expectFile(repo.file, repo.before, repo.mode)
    await approveSnapshot(page, repo.file)
    const summary = await settlement(page, DELETED, '删了 1 个文件')
    expect(existsSync(repo.file)).toBe(false)
    expect(repo.git('status', '--porcelain')).toBe(' D notes.txt\n')
    await restoreFile(page, summary, repo.file)
    expectFile(repo.file, repo.before, repo.mode)
    expect(repo.git('status', '--porcelain')).toBe('')
    expect(server.requests).toHaveLength(2)
  } finally {
    await app.close()
  }
})
