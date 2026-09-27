import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import { providerEnv, send, textReply } from './helpers/tools.js'

/**
 * Clearing and deleting a session in the real app take its tool-output folder with them (spec 02
 * §大响应落盘「删除是 host 的义务」, §本地持久化布局：只加一行; plan step 24, 旧 189). Phase 2 has no
 * screen that clears or deletes a session, so main's removal is reached through its e2e seam
 * (`TENON_E2E_SESSION_REMOVAL`, src/main/session-removal.ts), and the folder is checked in the app's
 * userData. The spilled files are written here: the kernel's spill writer is not what is under test.
 * The order, and the sends refused until a removal completes, are session-removal.test.ts's.
 */
let fake: FakeAnthropic | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
})

/** Main's removal on `globalThis` (development builds only). */
const REMOVAL_SEAM: Readonly<Record<string, string>> = { TENON_E2E_SESSION_REMOVAL: '1' }

async function removeSession(
  app: ElectronApplication,
  how: 'clear' | 'delete',
  sessionId: string,
): Promise<void> {
  await app.evaluate(
    async (_electron, asked) => {
      const seam = (
        globalThis as {
          tenonSessionRemoval?: Record<'clear' | 'delete', (id: string) => Promise<unknown>>
        }
      ).tenonSessionRemoval
      if (seam === undefined) throw new Error('the removal seam is off')
      await seam[asked.how](asked.sessionId)
    },
    { how, sessionId },
  )
}

async function shownSessionId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const latest = (await window.tenon.invoke('session.latest', { limit: 1 })) as {
      data: { sessionId: string } | null
    }
    if (latest.data === null) throw new Error('no session was written')
    return latest.data.sessionId
  })
}

/** A spilled file of the session, where the kernel puts one: `<runId>-<requestSeq>-<i>.txt`. */
function spill(folder: string, text: string): string {
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `${randomUUID()}-1-0.txt`)
  writeFileSync(file, text)
  return file
}

/** The names of the session's facts on the Tape, in the order written. */
function factNames(userData: string, sessionId: string): string[] {
  const db = new Database(join(dirname(configPathIn(userData)), 'sessions.db'), {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const rows = db
      .prepare('SELECT name FROM tape_entry WHERE session_id = ? ORDER BY entry_id')
      .all(sessionId) as Array<{ name: string }>
    return rows.map((row) => row.name)
  } finally {
    db.close()
  }
}

test('clearing and then deleting a session removes its tool-output folder, and no other (旧 189)', async () => {
  fake = await startFakeAnthropic({
    replies: [textReply('first ', 'answer'), textReply('second ', 'answer')],
  })
  const userData = makeUserDataDir('tool-output')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(fake.baseURL), ...REMOVAL_SEAM },
  })
  try {
    await send(page, 'hello')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('first answer')
    const sessionId = await shownSessionId(page)
    const outputs = join(dirname(configPathIn(userData)), 'tool-output')
    const mine = join(outputs, sessionId)
    spill(mine, 'A'.repeat(40_000))
    const theirs = spill(join(outputs, randomUUID()), 'another session')

    await removeSession(app, 'clear', sessionId)
    expect(existsSync(mine)).toBe(false)
    expect(readFileSync(theirs, 'utf8')).toBe('another session')
    // The same id, a new incarnation: the clear is complete, so the session takes a send again, and
    // what the old incarnation wrote is gone from the Tape.
    await send(page, 'again')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('second answer')
    await expect
      .poll(() => factNames(userData, sessionId).filter((name) => name === 'message/user'))
      .toHaveLength(1)
    expect(factNames(userData, sessionId).filter((name) => name === 'session/start')).toHaveLength(
      1,
    )
    // A spill of the new incarnation lands in the same folder, and stays.
    const fresh = spill(mine, 'new incarnation')
    expect(readFileSync(fresh, 'utf8')).toBe('new incarnation')

    await removeSession(app, 'delete', sessionId)
    expect(existsSync(mine)).toBe(false)
    expect(factNames(userData, sessionId)).toEqual([])
    expect(readFileSync(theirs, 'utf8')).toBe('another session')
  } finally {
    await app.close()
  }
})
