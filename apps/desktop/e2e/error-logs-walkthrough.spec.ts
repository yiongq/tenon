import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { TestInfo } from '@playwright/test'
import { startFakeOpenAI } from '../test/support/fake-openai.js'
import type { FakeOpenAI } from '../test/support/fake-openai.js'
import { appLogRecords, LOCAL_TIME, runningMarker } from './helpers/app-log.js'
import type { AppLogRecord } from './helpers/app-log.js'
import {
  countEvents,
  killSpawnedApps,
  quitAndWait,
  quitBySigterm,
  spawnTenon,
} from './helpers/app-process.js'
import { closeSettings, connected, openConnectors, stdioConfig } from './helpers/connectors.js'
import { launchTenon, logsDirIn, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { newChatFromSidebar } from './helpers/navigation.js'
import { expect, test } from './helpers/test.js'
import { ZHIPU_ORIGIN, originMap, send } from './helpers/tools.js'
import { failIfAny, publishWalkthroughReport, walkthrough } from './helpers/walkthrough-report.js'

/**
 * The scripted walkthrough of docs/features/error-logs (plan 3.2.1 and 3.2.2): what the owner would
 * be asked to do by hand, done by the test, with a report of it (`helpers/walkthrough-report.ts`,
 * `reports/walkthrough/index.html`, the CI artifact `e2e-report`).
 *
 * - The real app under Playwright, the fake sandbox, memory secrets, no developer `.env.local`
 *   (`launchTenon`); the model is a fake endpoint standing in for the vendor's address, as
 *   `provider-settings.spec.ts` does, and it answers 401. The key is typed into the settings card,
 *   the message into the composer: the real route from the screen to the log, nothing seeded.
 * - What the log must hold and must not hold is read from the files after the app is gone.
 * - Two scenarios segment one did not look at: a connector's log file is for its owner alone, and a
 *   development start writes Tenon's version on every line. The second spawns the app the way a
 *   developer starts it (`electron .`, the app folder), because Playwright's launcher hands it
 *   `./out/main/index.js` as a file, and for a file the app's version is Electron's own (spec §日志行).
 */

test.afterAll(async () => {
  let info: TestInfo | undefined
  try {
    info = test.info()
  } catch {
    info = undefined
  }
  await publishWalkthroughReport(info)
})

test.afterEach(async () => {
  await killSpawnedApps()
})

/**
 * A key no other text in the log can contain by chance: no 8 characters of it are words, names of
 * folders or anything the app writes.
 */
const KEY = 'Zq7Xw2Kp9Lm4Vt8Rb3Ny6Hc5Jd'
const MESSAGE = 'WT_MESSAGE_8Hq3 请帮我看看这个文件夹'
const MODEL = 'glm-4.6'

let fake: FakeOpenAI | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
})

/** Every file the log folder holds, as text: the log, its archives, the marker, a connector's log. */
function logFolderText(userData: string): string {
  const dir = logsDirIn(userData)
  return readdirSync(dir)
    .map((name) => {
      try {
        return readFileSync(join(dir, name), 'utf8')
      } catch {
        return ''
      }
    })
    .join('\n')
}

/** Every piece of `secret` that is `length` characters long. */
function piecesOf(secret: string, length: number): string[] {
  const pieces: string[] = []
  for (let at = 0; at + length <= secret.length; at += 1) pieces.push(secret.slice(at, at + length))
  return pieces
}

const mode = (path: string): number => statSync(path).mode & 0o777
const octal = (value: number): string => value.toString(8).padStart(4, '0')

/** `ls -l` of the log folder, and the folder's own line, for the report. */
function listing(dir: string): string {
  const own = execFileSync('ls', ['-ld', dir], { encoding: 'utf8' }).trim()
  const files = execFileSync('ls', ['-l', dir], { encoding: 'utf8' }).trim()
  return `${own}\n\n${files}`
}

const attemptFailed = (userData: string): AppLogRecord[] =>
  appLogRecords(userData).filter(
    (record) => record.event === 'line' && String(record['text']).includes('attempt failed'),
  )

test('error-logs 走查: a wrong key, one message from the composer, then a normal quit', async () => {
  fake = await startFakeOpenAI({
    chunks: [],
    // The vendor's refusal echoes the key it was given, as some do: so a key that is in the line
    // would be the vendor's doing as well as the app's.
    failWith: { status: 401, code: '1000', message: `invalid api key: ${KEY} was refused` },
  })
  const server = fake
  const userData = makeUserDataDir('walkthrough')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: originMap({ [ZHIPU_ORIGIN]: server.baseURL }),
  })

  const wrongKey = walkthrough('bad-key')
  const first = await wrongKey.run(async (r) => {
    r.did(
      '在设置里给智谱存一把假 key，回到对话从输入框发一条消息；模型服务回 401（key 不对）。看界面的失败提示，再看日志。',
    )
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    const card = page.getByTestId('provider-settings')
    await expect(card).toBeVisible()
    await page.getByTestId('provider-select').selectOption('zhipu')
    await expect(page.getByTestId('provider-status-apiKey')).toHaveText('No key stored yet.')
    await page.getByTestId('provider-config-apiKey').fill(KEY)
    await page.getByTestId('model-select').selectOption(MODEL)
    await page.getByTestId('provider-save').click()
    await expect(card).toBeHidden()
    // The card again, to show the key is kept and the field is empty.
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    await expect(page.getByTestId('provider-status-apiKey')).toHaveText(
      'A key is stored. Type a new one to replace it.',
    )
    await r.shot(page, '存 key 之后的设置界面：写着已存了一把 key，输入框是空的')
    await closeSettings(page)

    await newChatFromSidebar(page)
    await send(page, MESSAGE)
    const failure = page.getByTestId('failure-card')
    await expect(failure).toHaveAttribute('data-code', 'provider-error')
    await r.shot(page, '对话里的失败提示')
    await expect.poll(() => attemptFailed(userData).length, { timeout: 15_000 }).toBe(1)

    const everything = logFolderText(userData)
    const failed = attemptFailed(userData)
    r.logLines(userData, (record) => String(record['text'] ?? '').includes('attempt failed'))

    await r.check(
      '模型服务真的收到了这把 key（所以它本来可能写进日志）；401 只请求了一次，没有重试',
      () => {
        expect(
          server.requests.filter((one) => one.path.endsWith('/chat/completions')),
        ).toHaveLength(1)
        expect(server.requests[0]?.headers['authorization']).toBe(`Bearer ${KEY}`)
      },
    )
    await r.check('日志里有这次失败：一行，级别 error', () => {
      expect(failed).toHaveLength(1)
      expect(failed[0]).toMatchObject({ event: 'line', level: 'error' })
    })
    await r.check('这一行写着厂商是智谱、种类 auth（key 不对）、HTTP 状态 401、不能重试', () => {
      const line = String(failed[0]?.['text'])
      expect(line).toMatch(/attempt failed: provider=zhipu model=\S+ code=auth status=401 /u)
      expect(line).toContain('retryable=false')
    })
    await r.check('日志文件夹里没有这把 key，任何连续 8 个字符以上的片段也没有', () => {
      expect(everything).not.toContain(KEY)
      expect(piecesOf(KEY, 8).filter((piece) => everything.includes(piece))).toEqual([])
    })
    await r.check('日志文件夹里没有你发的那句话（整句和其中的词都没有）', () => {
      expect(everything).not.toContain('WT_MESSAGE_8Hq3')
      expect(everything).not.toContain('请帮我看看这个文件夹')
    })
  })

  // However the first half went, the app is quit the normal way and the log read after it.
  if (app.process().exitCode === null) await quitAndWait(app)

  const lifecycle = walkthrough('lifecycle')
  const second = await lifecycle.run(async (r) => {
    r.did(
      '用完之后正常退出（等于 Cmd+Q），再看日志文件夹：生命周期几行、没有多余的警告、文件权限。',
    )
    const records = appLogRecords(userData)
    const dir = logsDirIn(userData)
    r.logLines(userData, (record) =>
      ['app.start', 'window.shown', 'sandbox.posture', 'sandbox.helpers', 'app.quit'].includes(
        String(record['event']),
      ),
    )
    if (process.platform !== 'win32') r.note('日志文件夹里有什么（ls -l）', listing(dir))

    await r.check('每一行都带版本、进程号和带时区的时间', () => {
      expect(records.length).toBeGreaterThan(0)
      for (const record of records) {
        expect(record.v, record.event).toBe(1)
        expect(typeof record.ver, record.event).toBe('string')
        expect(record.pid, record.event).toBe(records[0]?.pid)
        expect(record.t, record.event).toMatch(LOCAL_TIME)
      }
    })
    await r.check('这次启动的第一行是「启动」：开发版、平台、架构、数据目录', () => {
      expect(records[0]).toMatchObject({
        event: 'app.start',
        level: 'info',
        packaged: false,
        platform: process.platform,
        arch: process.arch,
        userData: expect.stringContaining('tenon-e2e-walkthrough'),
      })
    })
    await r.check('窗口出来了、沙箱状态、交给沙箱的辅助程序路径，三行都在', () => {
      const events = records.map((record) => record.event)
      expect(events).toEqual(
        expect.arrayContaining(['window.shown', 'sandbox.posture', 'sandbox.helpers']),
      )
    })
    await r.check('退出是最后一行，只有一行；运行标记已经删掉', () => {
      expect(records.at(-1)).toMatchObject({ event: 'app.quit', level: 'info' })
      expect(records.filter((record) => record.event === 'app.quit')).toHaveLength(1)
      expect(runningMarker(userData)).toBeNull()
      expect(existsSync(join(dir, 'running.json.tmp'))).toBe(false)
    })
    await r.check('除了那次 401，没有任何 warn 或 error 级的行', () => {
      const loud = records
        .filter((record) => record.level === 'warn' || record.level === 'error')
        .map((record) => `${record.level} ${record.event} ${String(record['text'] ?? '')}`)
      expect(loud).toHaveLength(1)
      expect(loud[0]).toContain('attempt failed')
    })
    if (process.platform !== 'win32') {
      await r.check('日志文件夹只有你自己能进（0700），日志文件只有你自己能读写（0600）', () => {
        expect(octal(mode(dir))).toBe('0700')
        expect(octal(mode(join(dir, 'main.jsonl')))).toBe('0600')
        for (const name of readdirSync(dir)) {
          expect([name, octal(mode(join(dir, name)))]).toEqual([name, '0600'])
        }
      })
    }
  })
  failIfAny(first, second)
})

test('error-logs 走查: a connector writes a log that only its owner can read, and an older loose one is tightened', async () => {
  test.skip(process.platform === 'win32', 'file modes')
  const userData = makeUserDataDir('walkthrough-connector')
  const activity = join(userData, 'activity.log')
  seedConfig(userData, {
    locale: 'en',
    mcpServers: [stdioConfig('notes', ['--activity-file', activity])],
  })
  // What an older Tenon left: a connector's log anyone could read.
  const dir = logsDirIn(userData)
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  const older = join(dir, 'mcp-old.log')
  writeFileSync(older, 'a line from an older run\n', { mode: 0o644 })
  chmodSync(older, 0o644)

  const { app, page } = await launchTenon({ userData })
  const report = walkthrough('connector-log')
  const problem = await report.run(async (r) => {
    r.did(
      '配一个连接器让它启动并写出日志（它启动时往 stderr 写一行）；启动前还放了一个旧版本留下的、人人可读的连接器日志。',
    )
    try {
      await connected(page)
      const fresh = join(dir, 'mcp-notes.log')
      await expect.poll(() => existsSync(fresh), { timeout: 15_000 }).toBe(true)
      await expect.poll(() => mode(older), { timeout: 10_000 }).toBe(0o600)
      await openConnectors(page)
      await r.shot(page, '连接器已连上')
      await closeSettings(page)
      r.note('日志文件夹里有什么（ls -l）', listing(dir))
      await r.check('连接器新写的日志是 0600：只有你自己能读写', () => {
        expect(octal(mode(fresh))).toBe('0600')
        expect(readFileSync(fresh, 'utf8')).toContain('fixture stderr: ready')
      })
      await r.check('启动时已有的旧日志被改成了 0600，内容没动', () => {
        expect(octal(mode(older))).toBe('0600')
        expect(readFileSync(older, 'utf8')).toBe('a line from an older run\n')
      })
      await r.check('日志文件夹是 0700，应用自己的日志和运行标记是 0600', () => {
        expect(octal(mode(dir))).toBe('0700')
        expect(octal(mode(join(dir, 'main.jsonl')))).toBe('0600')
        expect(octal(mode(join(dir, 'running.json')))).toBe('0600')
      })
    } finally {
      await quitAndWait(app)
    }
  })
  failIfAny(problem)
})

test('error-logs 走查: a development start writes Tenon’s version on every line, not Electron’s', async () => {
  test.skip(process.platform === 'win32', 'SIGTERM')
  const userData = makeUserDataDir('walkthrough-version')
  const report = walkthrough('dev-version')
  const problem = await report.run(async (r) => {
    r.did(
      '用平时开发的方式启动（在应用文件夹里 electron .，不经 Playwright），等窗口出来再正常退出，看日志每一行的版本。',
    )
    const tenon = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
    const electron = (
      JSON.parse(readFileSync(join('node_modules', 'electron', 'package.json'), 'utf8')) as {
        version: string
      }
    ).version
    const app = spawnTenon({ userData, entry: 'app' })
    await expect.poll(() => countEvents(userData, 'window.shown'), { timeout: 45_000 }).toBe(1)
    await quitBySigterm(app)
    const records = appLogRecords(userData)
    r.logLines(
      userData,
      (record) => record['event'] === 'app.start' || record['event'] === 'app.quit',
    )
    r.note('两个版本号', `Tenon（apps/desktop/package.json）：${tenon}\nElectron：${electron}`)
    r.note(
      '另一种启动方式',
      'Playwright 的启动器把 ./out/main/index.js 当文件交给 Electron，这时应用拿到的版本是 Electron 自己的（spec「日志行」一节也这么写）；所以 e2e 里别的用例读到的是 Electron 的版本号，这一条用平时开发的方式启动才看得到 Tenon 的。',
    )
    await r.check('日志有内容：启动、窗口、退出都在', () => {
      expect(records.map((record) => record.event)).toEqual(
        expect.arrayContaining(['app.start', 'window.shown', 'app.quit']),
      )
    })
    await r.check(`每一行的版本都是 Tenon 的版本（${tenon}）`, () => {
      expect(tenon).not.toBe(electron)
      expect([...new Set(records.map((record) => record.ver))]).toEqual([tenon])
    })
    await r.check('没有一行写成 Electron 的版本', () => {
      expect(records.filter((record) => record.ver === electron)).toEqual([])
    })
  })
  failIfAny(problem)
})

test('error-logs 走查: an error the page does not catch is one line and a count', async () => {
  const userData = makeUserDataDir('walkthrough-renderer')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData })
  const report = walkthrough('renderer-error')
  const problem = await report.run(async (r) => {
    r.did('在界面里让同一个没接住的错连续抛三次，再抛一个不一样的；另外打一条警告和一条普通输出。')
    const lines = (marker: string): AppLogRecord[] =>
      appLogRecords(userData).filter(
        (record) => record.event === 'renderer.error' && String(record['message']).includes(marker),
      )
    try {
      await expect.poll(() => countEvents(userData, 'window.shown'), { timeout: 15_000 }).toBe(1)
      await page.evaluate(() => {
        console.warn('WT_RENDERER_WARNING')
        console.info('WT_RENDERER_INFO')
        for (let i = 0; i < 3; i += 1) {
          setTimeout(() => {
            throw new Error('WT_RENDERER_BOOM')
          }, 0)
        }
      })
      await expect.poll(() => lines('WT_RENDERER_BOOM').length, { timeout: 15_000 }).toBe(1)
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error('WT_RENDERER_OTHER')
        }, 0)
      })
      await expect.poll(() => lines('WT_RENDERER_OTHER').length, { timeout: 15_000 }).toBe(1)
      await expect.poll(() => lines('WT_RENDERER_BOOM').length, { timeout: 15_000 }).toBe(2)
      await r.shot(page, '抛错之后的窗口')
    } finally {
      await quitAndWait(app)
    }
    const [first, count] = lines('WT_RENDERER_BOOM')
    r.logLines(userData, (record) => String(record['message'] ?? '').includes('WT_RENDERER_'))
    await r.check('第一次立即记下：级别 error，第一行说明，只带文件名和行号，次数 1', () => {
      expect(first).toMatchObject({
        level: 'error',
        message: 'Uncaught Error: WT_RENDERER_BOOM',
        repeats: 1,
      })
      expect(String(first?.['source'])).not.toMatch(/[/?#]/u)
      expect(Number.isInteger(first?.['line'])).toBe(true)
    })
    await r.check('后两次同样的错没有各占一行，另一个错出现时补一行总数：共 3 次', () => {
      expect(lines('WT_RENDERER_BOOM')).toHaveLength(2)
      expect(count?.['repeats']).toBe(3)
    })
    await r.check('不一样的错另记一行', () => {
      expect(lines('WT_RENDERER_OTHER')[0]).toMatchObject({ level: 'error' })
    })
    await r.check('警告和普通输出不进日志', () => {
      const all = JSON.stringify(appLogRecords(userData))
      expect(all).not.toContain('WT_RENDERER_WARNING')
      expect(all).not.toContain('WT_RENDERER_INFO')
    })
  })
  failIfAny(problem)
})
