import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appLogRecords, LOCAL_TIME, runningMarker } from './helpers/app-log.js'
import {
  countEvents,
  exitWithin,
  helperFile,
  killSpawnedApps,
  quitBySigterm,
  spawnTenon,
} from './helpers/app-process.js'
import { logsDirIn, makeUserDataDir } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import {
  failIfAny,
  publishWalkthroughReport,
  screenPicture,
  walkthrough,
} from './helpers/walkthrough-report.js'

/**
 * Starts that end badly, and the start after them (docs/features/error-logs/spec.md §运行标记,
 * §启动失败; acceptance 10 and 11). Playwright cannot do these: its launcher waits for a debugger
 * connection the losing start never makes, and a process it did not kill itself leaves it
 * confused. Each process here is spawned directly (`helpers/app-process.ts`) against a profile
 * the case owns, and everything is read from the files the app leaves.
 *
 * - A kill is SIGKILL: the app runs no code after it, so what the next start finds is what a
 *   crash, an out-of-memory kill or a power cut leaves.
 * - A start that fails is made the way the spec says: the profile's `mcp` folder is a file of the
 *   same name, so making the profile's folders fails. The log is made first, so it writes.
 * - The box is Electron's `dialog.showErrorBox`, which blocks the main process until someone
 *   closes it. Where a case needs the app to go on, `helpers/dialog-recorder-preload.cjs` replaces
 *   it with a function that writes what it is given to a file; the case that wants the real box
 *   leaves it alone, lets the app sit in it, and ends the process.
 *
 * Each case also reports on its scenario of the walkthrough page (`helpers/walkthrough-report.ts`).
 */

test.afterAll(async () => {
  await publishWalkthroughReport()
})

test.afterEach(async () => {
  await killSpawnedApps()
})

test.skip(process.platform === 'win32', 'no SIGTERM, no SIGKILL')

const profileDirOf = (userData: string): string => join(userData, 'profiles', 'local', 'personal')

/** Makes the failure: a file where the profile's `mcp` folder is made. */
function breakProfile(userData: string): string {
  const profile = profileDirOf(userData)
  mkdirSync(profile, { recursive: true })
  const blocker = join(profile, 'mcp')
  writeFileSync(blocker, 'a file where the mcp folder should be\n')
  return blocker
}

/** The path as the log writes it: the home folder is `~`. */
function asLogged(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** Waits for the Nth window of the log, the sign a start got all the way. */
async function untilWindow(userData: string, nth: number): Promise<void> {
  await expect.poll(() => countEvents(userData, 'window.shown'), { timeout: 45_000 }).toBe(nth)
}

const boxLines = (file: string): Array<{ at: number; title: string; content: string }> => {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { at: number; title: string; content: string })
  } catch {
    return []
  }
}

test('error-logs 验收 10: a SIGKILLed app reports the unclean exit on the next start and a clean quit does not', async () => {
  test.setTimeout(150_000)
  const userData = makeUserDataDir('log-unclean')
  const report = walkthrough('unclean-exit')
  const problem = await report.run(async (r) => {
    r.did(
      '打开 Tenon，等窗口出来，把它强制结束（SIGKILL，等于在活动监视器里强制退出）；再打开，看日志；正常退出，再打开第三次，看日志。',
    )
    const first = spawnTenon({ userData })
    await untilWindow(userData, 1)
    const marker = runningMarker(userData)
    await first.kill()
    const markerAfterKill = runningMarker(userData)
    const lastAfterKill = appLogRecords(userData).at(-1)

    const second = spawnTenon({ userData })
    await untilWindow(userData, 2)
    const afterSecondStart = appLogRecords(userData)
    await quitBySigterm(second)
    const markerAfterQuit = runningMarker(userData)
    const lastAfterQuit = appLogRecords(userData).at(-1)

    const third = spawnTenon({ userData })
    await untilWindow(userData, 3)
    const uncleanAfterThird = appLogRecords(userData).filter(
      (record) => record.event === 'app.unclean-exit',
    )
    await quitBySigterm(third)

    r.logLines(userData, (record) => record['event'] === 'app.unclean-exit')
    r.note('被强制结束的那次启动留下的运行标记（running.json）', JSON.stringify(marker, null, 2))
    const unclean = afterSecondStart.filter((record) => record.event === 'app.unclean-exit')

    await r.check('正在运行时有运行标记，记着这次的启动时间、版本和进程号', () => {
      expect(marker).toMatchObject({ v: 1, pid: first.pid })
      expect(String(marker?.['startedAt'])).toMatch(LOCAL_TIME)
      expect(typeof marker?.['version']).toBe('string')
    })
    await r.check('被强制结束后标记还在，日志最后一行不是「正常退出」（它没有机会写）', () => {
      expect(markerAfterKill).toEqual(marker)
      expect(lastAfterKill?.event).not.toBe('app.quit')
    })
    await r.check('再打开：这次启动的日志里有一行「上次没有正常退出」，只有一行', () => {
      expect(unclean).toHaveLength(1)
      expect(unclean[0]).toMatchObject({ pid: second.pid })
    })
    await r.check('这一行带着上次的启动时间和版本，与上次的标记一致', () => {
      expect(unclean[0]?.['startedAt']).toBe(marker?.['startedAt'])
      expect(unclean[0]?.['version']).toBe(marker?.['version'])
    })
    await r.check('这次正常退出：日志最后一行是正常退出，标记被删掉', () => {
      expect(lastAfterQuit).toMatchObject({ event: 'app.quit' })
      expect(markerAfterQuit).toBeNull()
    })
    await r.check('正常退出之后再打开：没有新的「上次没有正常退出」，仍然只有上面那一行', () => {
      expect(uncleanAfterThird).toHaveLength(1)
    })
    await r.check('第三次也正常退出，标记又被删掉', () => {
      expect(runningMarker(userData)).toBeNull()
    })
  })
  failIfAny(problem)
})

test('error-logs 验收 10: a failed startup leaves the marker and the next start reports it', async () => {
  test.setTimeout(150_000)
  const userData = makeUserDataDir('log-unclean-failed')
  const blocker = breakProfile(userData)
  const boxFile = join(userData, 'e2e-boxes.jsonl')
  const report = walkthrough('unclean-exit')
  const problem = await report.run(async (r) => {
    r.did(
      '让启动失败（数据目录里的 mcp 子文件夹被换成同名文件），再把它改回来重新打开，看这次的日志。',
    )
    const failing = spawnTenon({
      userData,
      preload: helperFile('dialog-recorder-preload.cjs'),
      env: { TENON_E2E_BOX_FILE: boxFile },
    })
    await expect
      .poll(() => countEvents(userData, 'app.startup-failed'), { timeout: 45_000 })
      .toBe(1)
    // The box is recorded, not shown, so the app goes on to exit with 1; if the recorder did not
    // load, the real box holds it, and the process is ended.
    const left = await exitWithin(failing, 20_000)
    if (left === null) await failing.kill()
    const marker = runningMarker(userData)

    rmSync(blocker)
    const next = spawnTenon({ userData })
    await untilWindow(userData, 1)
    const unclean = appLogRecords(userData).filter((record) => record.event === 'app.unclean-exit')
    await quitBySigterm(next)

    r.logLines(userData, (record) => record['event'] === 'app.unclean-exit')
    r.note('启动失败那次留下的运行标记（running.json）', JSON.stringify(marker, null, 2))
    await r.check('启动失败后，运行标记还在（启动失败不算正常退出）', () => {
      expect(marker).toMatchObject({ v: 1, pid: failing.pid })
    })
    await r.check('改回来再打开：日志里有一行「上次没有正常退出」，带着失败那次的启动时间', () => {
      expect(unclean).toHaveLength(1)
      expect(unclean[0]?.['startedAt']).toBe(marker?.['startedAt'])
      expect(unclean[0]?.['version']).toBe(marker?.['version'])
    })
    await r.check('这次启动成功，也正常退出了：标记被删掉', () => {
      expect(runningMarker(userData)).toBeNull()
    })
  })
  failIfAny(problem)
})

test('error-logs 验收 11: a file in place of the mcp folder fails the start and app.startup-failed is written', async () => {
  test.setTimeout(150_000)
  test.skip(
    process.platform !== 'linux',
    'the real box is modal on a desktop; this case runs where the display is a virtual one (CI, Linux)',
  )
  const userData = makeUserDataDir('log-start-failed')
  breakProfile(userData)
  const report = walkthrough('startup-failure')
  const problem = await report.run(async (r) => {
    r.did(
      '让启动失败：数据目录里的 mcp 子文件夹被换成同名文件；不替换任何东西，让真的提示框弹出来，再把进程结束。',
    )
    const app = spawnTenon({ userData })
    await expect
      .poll(() => countEvents(userData, 'app.startup-failed'), { timeout: 45_000 })
      .toBe(1)
    // The real box is modal: the app sits in it until the process is ended. Where the display
    // cannot show one, Electron prints the message and the app leaves with 1 by itself.
    const early = await exitWithin(app, 2_000)
    const picture = early === null ? screenPicture() : null
    if (picture !== null) await r.shot(picture, '启动失败时屏幕上的样子（整屏，真的提示框在里面）')
    else
      r.note(
        '提示框的图',
        '这台机器没能截到整屏的图（要 Linux 的虚拟显示加 ImageMagick 的 import）；提示框的文字见「启动失败的提示框」一节里换成记录的那一次。真框要人看（验收 19）。',
      )
    const killed = early === null ? await app.kill() : null
    const records = appLogRecords(userData)
    const failed = records.find((record) => record.event === 'app.startup-failed')
    r.logLines(userData, (record) => record['event'] === 'app.startup-failed')

    await r.check('日志里有一行启动失败，级别 error', () => {
      expect(failed).toMatchObject({ level: 'error' })
    })
    await r.check('这一行记着是什么错：错误的名字、码（文件已存在）和说明里的 mcp', () => {
      const error = failed?.['error'] as { name: string; code?: string; message: string }
      expect(error.name.length).toBeGreaterThan(0)
      expect(['EEXIST', 'ENOTDIR']).toContain(error.code)
      expect(error.message).toContain('mcp')
    })
    await r.check('它是这次启动里「启动」之后的失败：启动在前，没有窗口出来过', () => {
      expect(records[0]).toMatchObject({ event: 'app.start' })
      expect(records.some((record) => record.event === 'window.shown')).toBe(false)
    })
    await r.check(
      '提示框弹出后进程停在框里（被我们结束），或者没有显示器时自己以退出码 1 结束',
      () => {
        if (early === null) expect(killed).toMatchObject({ signal: 'SIGKILL' })
        else expect(early.code).toBe(1)
      },
    )
    await r.check('运行标记还在：启动失败不删标记', () => {
      expect(runningMarker(userData)).toMatchObject({ v: 1, pid: app.pid })
    })
  })
  failIfAny(problem)
})

test('error-logs 验收 11: the start-failure box comes after the line, names the log folder in the system language, and the app exits with 1', async () => {
  test.setTimeout(150_000)
  const report = walkthrough('startup-failure')
  const problems: Array<Error | null> = []
  for (const locale of ['en', 'zh-CN'] as const) {
    const userData = makeUserDataDir(`log-start-box-${locale}`)
    breakProfile(userData)
    const boxFile = join(userData, 'e2e-boxes.jsonl')
    // oxlint-disable-next-line no-await-in-loop -- one Electron at a time
    const problem = await report.run(async (r) => {
      r.did(
        `同样的启动失败，系统语言是 ${locale}；提示框换成记录（真框是模态的），看它写了什么、进程怎么结束。`,
      )
      const app = spawnTenon({
        userData,
        systemLanguages: [locale],
        preload: helperFile('dialog-recorder-preload.cjs'),
        env: { TENON_E2E_BOX_FILE: boxFile },
      })
      const status = await exitWithin(app, 60_000)
      if (status === null) await app.kill()
      const boxes = boxLines(boxFile)
      const failed = appLogRecords(userData).find((record) => record.event === 'app.startup-failed')
      const folder = asLogged(logsDirIn(userData))
      r.logLines(userData, (record) => record['event'] === 'app.startup-failed')
      if (boxes[0] !== undefined) {
        r.box(`系统语言 ${locale} 时的提示框`, boxes[0].title, boxes[0].content)
      }

      await r.check(`${locale}：Tenon 自己以退出码 1 结束（没有卡在框里）`, () => {
        expect(status).toEqual({ code: 1, signal: null })
      })
      await r.check(`${locale}：弹了一个框，在日志那一行写下之后`, () => {
        expect(boxes).toHaveLength(1)
        expect(failed).toBeDefined()
        expect(Date.parse(String(failed?.['t']))).toBeLessThanOrEqual(boxes[0]?.at ?? 0)
      })
      await r.check(
        `${locale}：框里写明 Tenon 没能启动，和日志文件夹的完整路径（主目录写成 ~）`,
        () => {
          const text = `${boxes[0]?.title}\n${boxes[0]?.content}`
          expect(text).toContain('Tenon')
          expect(boxes[0]?.content).toContain(folder)
        },
      )
      await r.check(
        `${locale}：框的语言跟着系统语言（${locale === 'zh-CN' ? '中文' : '英文'}）`,
        () => {
          const text = `${boxes[0]?.title}${boxes[0]?.content}`
          expect(/[㐀-鿿]/u.test(text)).toBe(locale === 'zh-CN')
        },
      )
      await r.check(`${locale}：运行标记还在`, () => {
        expect(runningMarker(userData)).toMatchObject({ v: 1, pid: app.pid })
      })
    })
    problems.push(problem)
  }
  failIfAny(...problems)
})
