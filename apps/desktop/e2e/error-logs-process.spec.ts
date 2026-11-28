import type { ElectronApplication } from '@playwright/test'
import type { AppLogRecord } from './helpers/app-log.js'
import { appLogEvents, appLogRecords } from './helpers/app-log.js'
import { quitAndWait } from './helpers/app-process.js'
import { launchTenon, logsDirIn, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import {
  failIfAny,
  publishWalkthroughReport,
  walkthrough,
  windowPicture,
} from './helpers/walkthrough-report.js'

/**
 * What the real shell logs when a process goes away or the main process throws, and the Help
 * menu's way to the log folder (docs/features/error-logs/spec.md; acceptance 8, 9 and 12). A
 * development build under Playwright, the fake sandbox, an English interface.
 *
 * Electron's own error box of a main-process exception and the system's file manager are not
 * pages Playwright can see. What the box says is recorded by replacing `dialog.showErrorBox` in
 * the main process for the case, and what is handed to the system by replacing `shell.openPath`;
 * both are called on the object itself, never destructured, so the replacement is what runs (as
 * `shutdown.ts` does with `dialog.showMessageBox`). The real box and the real file manager are the
 * walkthrough's to look at (acceptance 19).
 *
 * Each case also reports on its scenario of the walkthrough page (`helpers/walkthrough-report.ts`).
 */

test.afterAll(async () => {
  await publishWalkthroughReport()
})

/** What a replaced `showErrorBox` or `openPath` kept, in the main process, for the case to read. */
interface Kept {
  boxes?: Array<{ title: string; content: string }>
  opened?: string[]
  openAnswer?: string
}

const goneLines = (userData: string): AppLogRecord[] =>
  appLogRecords(userData).filter((record) => record.event === 'process.gone')

const uncaughtLines = (userData: string): AppLogRecord[] =>
  appLogRecords(userData).filter((record) => record.event === 'main.uncaught')

/** Replaces `dialog.showErrorBox` so that it records what it is given instead of blocking. */
async function recordErrorBoxes(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const kept = globalThis as unknown as Kept
    kept.boxes = []
    dialog.showErrorBox = (title, content) => {
      kept.boxes?.push({ title, content })
    }
  })
}

async function errorBoxes(
  app: ElectronApplication,
): Promise<Array<{ title: string; content: string }>> {
  return await app.evaluate(() => (globalThis as unknown as Kept).boxes ?? [])
}

test('error-logs 验收 8: a crashed renderer adds a process.gone line', async () => {
  const userData = makeUserDataDir('log-renderer-crash')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  const report = walkthrough('renderer-crash')
  const problem = await report.run(async (r) => {
    r.did('让窗口的渲染进程崩一次（用 Electron 自己的强制崩溃），再正常退出。')
    let before: AppLogRecord[] = []
    try {
      await expect.poll(() => appLogEvents(userData), { timeout: 15_000 }).toContain('window.shown')
      before = goneLines(userData)
      await r.shot(page, '崩溃之前的窗口')
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer()
      })
      await expect.poll(() => goneLines(userData).length, { timeout: 15_000 }).toBeGreaterThan(0)
      const picture = await windowPicture(app)
      if (picture === null) r.note('崩溃之后的窗口', '窗口的渲染进程已经没了，截不到图。')
      else await r.shot(picture, '崩溃之后的窗口')
    } finally {
      await quitAndWait(app)
    }
    r.logLines(userData, (record) => record['event'] === 'process.gone')
    const lines = goneLines(userData)
    await r.check('崩溃之前，启动和使用中没有任何进程退出的行', () => {
      expect(before).toHaveLength(0)
    })
    await r.check('崩溃之后多出一行进程退出，级别是 error，进程是「renderer」（窗口进程）', () => {
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({ level: 'error', process: 'renderer' })
    })
    await r.check('这一行写着原因（崩了或被杀）和退出码', () => {
      // Electron's forced crash reports `killed` or `crashed` (evidence.md E7).
      expect(['crashed', 'killed']).toContain(lines[0]?.['reason'])
      expect(Number.isInteger(lines[0]?.['exitCode'])).toBe(true)
    })
    await r.check('崩溃之后 Tenon 仍然能正常退出，日志最后一行是正常退出', () => {
      expect(appLogRecords(userData).at(-1)).toMatchObject({ event: 'app.quit' })
    })
  })
  failIfAny(problem)
})

test('error-logs 验收 9: a thrown main error is logged and Electron still shows its dialog without quitting', async () => {
  const userData = makeUserDataDir('log-main-throw')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  const report = walkthrough('main-error')
  const problem = await report.run(async (r) => {
    r.did(
      '在后台的一个定时器里抛出一个没接住的错，看日志、看 Electron 弹的报错框、看 Tenon 还在不在。',
    )
    let boxes: Array<{ title: string; content: string }> = []
    let windows = 0
    let exitCode: number | null = null
    try {
      await expect.poll(() => appLogEvents(userData), { timeout: 15_000 }).toContain('window.shown')
      await recordErrorBoxes(app)
      await app.evaluate(() => {
        setTimeout(() => {
          throw new Error('E2E_MAIN_BOOM')
        }, 0)
      })
      await expect.poll(() => uncaughtLines(userData).length, { timeout: 15_000 }).toBe(1)
      await expect.poll(async () => (await errorBoxes(app)).length, { timeout: 5_000 }).toBe(1)
      boxes = await errorBoxes(app)
      windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
      exitCode = app.process().exitCode
      await r.shot(page, '抛错之后，窗口照常能用')
    } finally {
      await quitAndWait(app)
    }
    const [line] = uncaughtLines(userData)
    r.logLines(userData, (record) => record['event'] === 'main.uncaught')
    r.box(
      'Electron 自己弹的英文报错框（这里换成了记录，真框是模态的，要人看；见验收 19）',
      boxes[0]?.title ?? '',
      boxes[0]?.content ?? '',
    )
    await r.check('日志多出一行，级别 error，来源是 uncaughtException（没接住的异常）', () => {
      expect(uncaughtLines(userData)).toHaveLength(1)
      expect(line).toMatchObject({ level: 'error', origin: 'uncaughtException' })
    })
    await r.check('这一行记着错误的名字和说明，还有最多 10 行调用栈', () => {
      const error = line?.['error'] as { name: string; message: string; frames?: string[] }
      expect(error.name).toBe('Error')
      expect(error.message).toBe('E2E_MAIN_BOOM')
      expect(error.frames?.length).toBeGreaterThanOrEqual(1)
      expect(error.frames?.length).toBeLessThanOrEqual(10)
    })
    await r.check('Electron 照旧弹出它自己的英文报错框，框里是这个错', () => {
      expect(boxes).toHaveLength(1)
      expect(boxes[0]?.title).toBe('A JavaScript error occurred in the main process')
      expect(boxes[0]?.content).toContain('E2E_MAIN_BOOM')
    })
    await r.check('Tenon 没有退出：进程还在，窗口还在', () => {
      expect(exitCode).toBeNull()
      expect(windows).toBe(1)
    })
    await r.check('之后还能正常退出，日志最后一行是正常退出', () => {
      expect(appLogRecords(userData).at(-1)).toMatchObject({ event: 'app.quit' })
    })
  })
  failIfAny(problem)
})

test('error-logs 验收 9: a lone rejection is logged and nothing else changes', async () => {
  const userData = makeUserDataDir('log-main-reject')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  const report = walkthrough('main-error')
  const problem = await report.run(async (r) => {
    r.did(
      '在后台让一个异步操作失败、没有人处理它（单独的 Promise 拒绝），看日志、看有没有报错框、看 Tenon 还在不在。',
    )
    let boxes: Array<{ title: string; content: string }> = []
    let windows = 0
    let exitCode: number | null = null
    try {
      await expect.poll(() => appLogEvents(userData), { timeout: 15_000 }).toContain('window.shown')
      await recordErrorBoxes(app)
      await app.evaluate(() => {
        setTimeout(() => {
          void Promise.reject(new Error('E2E_MAIN_REJECT'))
        }, 0)
      })
      await expect.poll(() => uncaughtLines(userData).length, { timeout: 15_000 }).toBe(1)
      // A box would be shown within a turn of the loop; give it half a second to show up.
      await new Promise((resolve) => setTimeout(resolve, 500))
      boxes = await errorBoxes(app)
      windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
      exitCode = app.process().exitCode
      await r.shot(page, '没人处理的异步失败之后，窗口照常能用')
    } finally {
      await quitAndWait(app)
    }
    const [line] = uncaughtLines(userData)
    r.logLines(userData, (record) => record['event'] === 'main.uncaught')
    await r.check(
      '日志多出一行，级别 error，来源是 unhandledRejection（没人处理的异步失败）',
      () => {
        expect(uncaughtLines(userData)).toHaveLength(1)
        expect(line).toMatchObject({ level: 'error', origin: 'unhandledRejection' })
      },
    )
    await r.check('这一行记着错误的名字和说明', () => {
      expect(line?.['error']).toMatchObject({ name: 'Error', message: 'E2E_MAIN_REJECT' })
    })
    await r.check('照旧不弹报错框', () => {
      expect(boxes).toEqual([])
    })
    await r.check('Tenon 没有退出：进程还在，窗口还在', () => {
      expect(exitCode).toBeNull()
      expect(windows).toBe(1)
    })
    await r.check('之后还能正常退出，日志最后一行是正常退出', () => {
      expect(appLogRecords(userData).at(-1)).toMatchObject({ event: 'app.quit' })
    })
  })
  failIfAny(problem)
})

test('error-logs 验收 12: the Help menu item hands the logs folder to the system, and shows its path when the system cannot', async () => {
  const userData = makeUserDataDir('log-open-folder')
  seedConfig(userData, { locale: 'en' })
  const { app } = await launchTenon({ userData })
  const report = walkthrough('open-logs')
  const problem = await report.run(async (r) => {
    r.did('点「帮助 → Open Logs Folder」两次：第一次系统打开了；第二次让系统回一句打不开。')
    const folder = logsDirIn(userData)
    /** The Help menu's item, clicked as the menu clicks it; false when the menu has none. */
    const clickItem = async (): Promise<boolean> =>
      await app.evaluate(({ Menu }) => {
        const help = Menu.getApplicationMenu()?.items.find((item) => item.role === 'help')
        const item = help?.submenu?.items.find((entry) => entry.label === 'Open Logs Folder')
        if (item === undefined) return false
        item.click()
        return true
      })
    const kept = async (): Promise<Kept> =>
      await app.evaluate(() => {
        const state = globalThis as unknown as Kept
        return { boxes: state.boxes ?? [], opened: state.opened ?? [] }
      })
    let first: Kept = {}
    let second: Kept = {}
    const clicked = [false, false]
    try {
      await expect.poll(() => appLogEvents(userData), { timeout: 15_000 }).toContain('window.shown')
      await app.evaluate(({ shell, dialog }) => {
        const state = globalThis as unknown as Kept
        state.opened = []
        state.boxes = []
        state.openAnswer = ''
        // The system's answer: '' when it opened the folder, a message when it could not.
        shell.openPath = (path) => {
          state.opened?.push(path)
          return Promise.resolve(state.openAnswer ?? '')
        }
        dialog.showErrorBox = (title, content) => {
          state.boxes?.push({ title, content })
        }
      })
      clicked[0] = await clickItem()
      await expect.poll(async () => (await kept()).opened?.length, { timeout: 5_000 }).toBe(1)
      // Give a box the same half second a rejection gets: none should come.
      await new Promise((resolve) => setTimeout(resolve, 500))
      first = await kept()
      await app.evaluate(() => {
        const state = globalThis as unknown as Kept
        state.openAnswer = 'E2E_CANNOT_OPEN'
      })
      clicked[1] = await clickItem()
      await expect.poll(async () => (await kept()).boxes?.length, { timeout: 5_000 }).toBe(1)
      second = await kept()
    } finally {
      await quitAndWait(app)
    }
    r.note('第一次点击，交给系统打开的路径', (first.opened ?? []).join('\n'))
    r.note('第二次点击，交给系统的路径', (second.opened ?? []).join('\n'))
    const box = second.boxes?.[0]
    if (box !== undefined) r.box('系统打不开时弹出的框', box.title, box.content)
    await r.check('帮助菜单里有「Open Logs Folder」这一项（英文界面）', () => {
      expect(clicked).toEqual([true, true])
    })
    await r.check('点它，Tenon 把日志文件夹交给系统去打开，路径正是这个文件夹', () => {
      expect(first.opened).toEqual([folder])
    })
    await r.check('系统打开成功时不弹任何框', () => {
      expect(first.boxes).toEqual([])
    })
    await r.check('系统回一句打不开时，弹框写出这个文件夹的路径', () => {
      expect(second.opened).toEqual([folder, folder])
      expect(second.boxes).toHaveLength(1)
      expect(box?.content).toContain(folder)
    })
    r.note('这里没法看到的', '真的在访达或文件管理器里打开了这个文件夹，要人点一下看（验收 19）。')
  })
  failIfAny(problem)
})
