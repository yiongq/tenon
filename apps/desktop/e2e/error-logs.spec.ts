import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import type { ElectronApplication } from '@playwright/test'
import { appLogEvents, appLogRecords, LOCAL_TIME, runningMarker } from './helpers/app-log.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'

/**
 * The app log in the real shell (docs/features/error-logs/spec.md; acceptance 14 and 17): what a
 * launch writes to `<profileDir>/logs/main.jsonl` and `running.json`, read from disk, and what the
 * window's console errors become. A development build under Playwright: `ver` is Electron's own
 * version (spec §日志行), the sandbox is the fake one (`TENON_TEST_SANDBOX=fake`), and the
 * quit is `app.quit()` or a SIGTERM, as in `stop-exit.spec.ts`.
 */

/** `app.quit()`, as the menu's Quit and Cmd+Q call it; resolves once the process is gone. */
async function quitAndWait(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ app: electronApp }) => electronApp.quit())
  await closed
}

/** Whether `pid` is a live process: not gone, and not a zombie waiting to be reaped. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
      .trim()
      .startsWith('Z')
  } catch {
    return false
  }
}

/** The path as the log writes it: the home folder is `~`. */
function asLogged(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

test('error-logs 验收 17: start comes first, window, posture and helpers all appear, quit comes last and removes the marker', async () => {
  const userData = makeUserDataDir('log-lifecycle')
  seedConfig(userData, { locale: 'en' })
  const { app } = await launchTenon({ userData })
  const pid = app.process().pid
  const electronVersion = await app.evaluate(() => process.versions.electron)
  try {
    // The window, the sandbox's state and its helpers arrive in any order, each with a time.
    await expect
      .poll(() => appLogEvents(userData), { timeout: 15_000 })
      .toEqual(
        expect.arrayContaining(['app.start', 'window.shown', 'sandbox.posture', 'sandbox.helpers']),
      )
    const records = appLogRecords(userData)
    // The first line of a fresh profile: the start, with what the app is and where it keeps its data.
    expect(records[0]).toMatchObject({
      event: 'app.start',
      level: 'info',
      packaged: false,
      platform: process.platform,
      arch: process.arch,
      userData: asLogged(userData),
    })
    for (const record of records) {
      expect(record, record.event).toMatchObject({ v: 1, ver: electronVersion, pid })
      expect(record.t, record.event).toMatch(LOCAL_TIME)
    }
    const posture = records.find((record) => record.event === 'sandbox.posture')
    expect(['active', 'degraded', 'unavailable']).toContain(posture?.['state'])
    expect(Array.isArray(posture?.['reasons'])).toBe(true)
    const helpers = records.find((record) => record.event === 'sandbox.helpers')
    for (const field of ['packageDir', 'applySeccomp', 'javaAgentJar']) {
      expect(typeof helpers?.[field], field).toBe('string')
    }
    // While it runs, the marker says so.
    expect(runningMarker(userData)).toMatchObject({ v: 1, version: electronVersion, pid })
    expect(String(runningMarker(userData)?.['startedAt'])).toMatch(LOCAL_TIME)
  } finally {
    await quitAndWait(app)
  }
  // The quit is the last line, once, and the marker is gone.
  const after = appLogRecords(userData)
  expect(after.at(-1)).toMatchObject({ event: 'app.quit', level: 'info', pid })
  expect(after.filter((record) => record.event === 'app.quit')).toHaveLength(1)
  expect(after.filter((record) => record.event === 'app.start')).toHaveLength(1)
  expect(runningMarker(userData)).toBeNull()
})

test('error-logs 验收 17: a SIGTERM before the sandbox installs its handlers is a clean quit that writes app.quit and removes the marker', async () => {
  test.skip(process.platform === 'win32', 'no SIGTERM')
  const userData = makeUserDataDir('log-sigterm')
  seedConfig(userData, { locale: 'en' })
  const { app } = await launchTenon({ userData })
  const pid = app.process().pid
  let exited = false
  try {
    if (pid === undefined) throw new Error('the app has no pid')
    await expect.poll(() => appLogEvents(userData), { timeout: 15_000 }).toContain('window.shown')
    // The fake sandbox never installs srt's own signal handlers: this is the native quit.
    process.kill(pid, 'SIGTERM')
    await expect.poll(() => isRunning(pid), { timeout: 10_000 }).toBe(false)
    exited = true
  } finally {
    if (!exited) await app.close()
  }
  expect(appLogRecords(userData).at(-1)).toMatchObject({ event: 'app.quit' })
  expect(runningMarker(userData)).toBeNull()
})

test('error-logs 验收 14: an uncaught renderer error logs its first line, file and line, and repeats merge', async () => {
  const userData = makeUserDataDir('log-renderer')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  const records = (marker: string) =>
    appLogRecords(userData).filter(
      (record) => record.event === 'renderer.error' && String(record['message']).includes(marker),
    )
  try {
    // Output and warnings are not errors; three of one error are one error three times.
    await page.evaluate(() => {
      console.log('E2E_LOG_NOT_LOGGED')
      console.info('E2E_INFO_NOT_LOGGED')
      console.warn('E2E_WARN_NOT_LOGGED')
      for (let i = 0; i < 3; i += 1) {
        setTimeout(() => {
          throw new Error('E2E_RENDERER_BOOM')
        }, 0)
      }
    })
    await expect.poll(() => records('E2E_RENDERER_BOOM').length, { timeout: 15_000 }).toBe(1)
    // A different error ends the run of the first: its count is written, then the new one.
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('E2E_RENDERER_OTHER')
      }, 0)
    })
    await expect.poll(() => records('E2E_RENDERER_OTHER').length, { timeout: 15_000 }).toBe(1)
    await expect.poll(() => records('E2E_RENDERER_BOOM').length, { timeout: 15_000 }).toBe(2)
  } finally {
    await quitAndWait(app)
  }
  const [first, count] = records('E2E_RENDERER_BOOM')
  expect(first).toMatchObject({ level: 'error', message: 'Uncaught Error: E2E_RENDERER_BOOM' })
  // Only the file's name, no query, no folder; and a line number.
  expect(String(first?.['source'])).not.toMatch(/[/?#]/u)
  expect(Number.isInteger(first?.['line'])).toBe(true)
  // The first line counts itself; the follow-up line carries the total of the run.
  expect(first?.['repeats']).toBe(1)
  expect(count?.['repeats']).toBe(3)
  expect(records('E2E_RENDERER_OTHER')[0]).toMatchObject({ level: 'error' })
  const text = JSON.stringify(appLogRecords(userData))
  for (const quiet of ['E2E_LOG_NOT_LOGGED', 'E2E_INFO_NOT_LOGGED', 'E2E_WARN_NOT_LOGGED']) {
    expect(text, quiet).not.toContain(quiet)
  }
})
