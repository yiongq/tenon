/**
 * The walkthrough report of docs/features/error-logs (plan 3.2.2): one HTML page, for the owner, that
 * says for each scenario what was done, shows a picture where there is one, the log's own line
 * as it was written, the same line made readable, and every check with a tick or a cross.
 *
 * How it is put together, so that whoever makes a scenario work later does not touch this file:
 *
 * - A scenario is a name in `SCENARIOS` below, in the order the page shows them. Every scenario
 *   has its section from the start; one that no e2e case has run yet reads 「还没有运行结果」.
 * - An e2e case reports on its scenario with `walkthrough('<id>')`: `did` (one sentence), `shot`
 *   (a picture), `logLines` (lines of `main.jsonl`, copied byte for byte), `note`, `box`, and
 *   `check` — a check is the assertion itself, run in a try: the report gets a tick or a cross,
 *   and the case fails at the end if any check did. `run` wraps the whole case body so that a
 *   fragment is written whatever happens, and returns the problem instead of throwing, so a case
 *   can go on to a second scenario before it fails.
 * - Each `run` writes a fragment, `reports/walkthrough/data/<id>.json`, with its pictures in
 *   `reports/walkthrough/shots/`. A scenario that several cases report on adds to its fragment.
 * - `publishWalkthroughReport` reads every fragment and writes `reports/walkthrough/index.html`: one
 *   file, its style inline and its pictures inside it, nothing fetched. It is called from the
 *   `afterAll` of each spec that reports; the last one to run leaves the whole page. Called with
 *   the test's info it also attaches the page to the Playwright report.
 * - The folder is `apps/desktop/reports/`, which CI uploads as the `e2e-report` artifact, so the
 *   page, its fragments and its pictures come along.
 * - The fragments are cleared at the start of each run (Playwright's runner process is the run:
 *   its pid is what a worker's parent is), so a page never mixes two runs.
 *
 * The page is in Chinese, for a reader who does not read the code: no function names; the log's
 * own event names appear because they are what the log says.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { logsDirIn } from './launch.js'

export type ScenarioId =
  | 'bad-key'
  | 'lifecycle'
  | 'renderer-error'
  | 'connector-log'
  | 'dev-version'
  | 'renderer-crash'
  | 'main-error'
  | 'unclean-exit'
  | 'startup-failure'
  | 'open-logs'

interface ScenarioInfo {
  readonly id: ScenarioId
  readonly segment: '段一' | '段二'
  readonly title: string
  /** What the owner would have been asked to try, in one sentence. */
  readonly plain: string
}

/** The scenarios, in the order of the page. */
export const SCENARIOS: readonly ScenarioInfo[] = [
  {
    id: 'bad-key',
    segment: '段一',
    title: '存一把错的 key，发一句话',
    plain:
      '在设置里存一把错的智谱 key，回到对话发一条消息；日志里该多出一行模型请求失败，里面没有这把 key，也没有这句话。',
  },
  {
    id: 'lifecycle',
    segment: '段一',
    title: '正常打开、用一会儿、正常关闭',
    plain:
      '打开 Tenon 再正常退出；日志里该有启动、窗口出来了、沙箱状态、退出，文件夹和文件只有你自己能读。',
  },
  {
    id: 'renderer-error',
    segment: '段一',
    title: '界面里抛出一个没接住的错',
    plain:
      '界面里连续抛三次同一个错；日志里该是一行报错加一行「共三次」，只记错误级，只带文件名和行号。',
  },
  {
    id: 'connector-log',
    segment: '段一',
    title: '连接器的日志只有你自己能读',
    plain: '配一个连接器让它写出日志；新写的日志文件该是只有你能读，启动时已有的旧文件也该被收紧。',
  },
  {
    id: 'dev-version',
    segment: '段一',
    title: '开发时启动，每一行的版本是 Tenon 的',
    plain: '用平时开发的方式启动；日志每一行里的版本该是 Tenon 的版本，而不是 Electron 的。',
  },
  {
    id: 'renderer-crash',
    segment: '段二',
    title: '窗口进程崩溃',
    plain: '让窗口的渲染进程崩一次；日志里该多出一行：崩的是窗口进程，原因和退出码。',
  },
  {
    id: 'main-error',
    segment: '段二',
    title: '后台抛一个没接住的错',
    plain:
      '在后台抛一个没接住的错、再让一个异步操作失败而没人处理；日志各多一行，Electron 的英文报错框照旧弹出，Tenon 不退出。',
  },
  {
    id: 'unclean-exit',
    segment: '段二',
    title: '强制退出之后再打开',
    plain:
      '把 Tenon 强制结束，再打开；这一次的日志里该写着「上次没有正常退出」和上次的启动时间；正常退出之后再打开则没有这一行。',
  },
  {
    id: 'startup-failure',
    segment: '段二',
    title: '启动失败时的提示框',
    plain:
      '把数据目录里的一个子文件夹换成同名文件让启动失败；日志里该有这次失败的一行，弹框写明日志在哪个文件夹，Tenon 以退出码 1 结束。',
  },
  {
    id: 'open-logs',
    segment: '段二',
    title: '帮助菜单里的「打开日志文件夹」',
    plain:
      '点「帮助 → 打开日志文件夹」；Tenon 该把日志文件夹交给系统去打开，打不开时弹框写出路径。',
  },
]

interface Check {
  readonly ok: boolean
  readonly text: string
  readonly detail: string | null
}

interface Shot {
  readonly caption: string
  /** Relative to `reports/walkthrough/`. */
  readonly file: string
}

interface Box {
  readonly caption: string
  readonly title: string
  readonly content: string
}

interface Fragment {
  readonly id: ScenarioId
  readonly did: readonly string[]
  readonly checks: readonly Check[]
  readonly shots: readonly Shot[]
  readonly rawLines: readonly string[]
  readonly notes: readonly { readonly label: string; readonly text: string }[]
  readonly boxes: readonly Box[]
  readonly finishedAt: string
}

// ---- where things are -------------------------------------------------------------------------------

const ROOT = (): string => join(process.cwd(), 'reports', 'walkthrough')
const DATA = (): string => join(ROOT(), 'data')
const SHOTS = (): string => join(ROOT(), 'shots')
const STAMP = (): string => join(ROOT(), 'run.json')

/**
 * Empties the fragments and pictures the first time a run touches the folder: the stamp is the
 * runner's pid, which every worker of one run has as its parent (a worker that is replaced after a
 * failed case sees the same one).
 */
function startRun(): void {
  const run = String(process.ppid)
  let current: string | null = null
  try {
    current = (JSON.parse(readFileSync(STAMP(), 'utf8')) as { run?: string }).run ?? null
  } catch {
    current = null
  }
  if (current === run) return
  rmSync(DATA(), { recursive: true, force: true })
  rmSync(SHOTS(), { recursive: true, force: true })
  mkdirSync(DATA(), { recursive: true })
  mkdirSync(SHOTS(), { recursive: true })
  writeFileSync(STAMP(), JSON.stringify({ run }))
}

let shotCounter = 0

function fragmentPath(id: ScenarioId): string {
  return join(DATA(), `${id}.json`)
}

function readFragment(id: ScenarioId): Fragment | null {
  try {
    return JSON.parse(readFileSync(fragmentPath(id), 'utf8')) as Fragment
  } catch {
    return null
  }
}

// ---- recording --------------------------------------------------------------------------------------

/** The first lines of an error's message: what a cross says went wrong, not the whole dump. */
function shortMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  // Playwright's messages carry colour escapes.
  // oxlint-disable-next-line no-control-regex -- the escape character is what is being removed
  const plain = text.replace(/\u001b\[[0-9;]*m/gu, '')
  return plain.split('\n').slice(0, 14).join('\n').slice(0, 1_500)
}

export interface Walkthrough {
  /** One sentence: what was done in this scenario. */
  did(sentence: string): void
  /** A picture of `page`, or of an image already taken (a Buffer), with what it shows. */
  shot(source: Page | Buffer, caption: string): Promise<void>
  /** The lines of the app log that `match` picks, copied as written (`main.jsonl`), in file order. */
  logLines(userData: string, match: (record: Record<string, unknown>) => boolean): void
  /** A labelled block of text: a listing, a file's content. */
  note(label: string, text: string): void
  /** What a box said, as it was given to the system (the box itself is the system's, not a page). */
  box(caption: string, title: string, content: string): void
  /** Runs the assertion; a tick if it holds, a cross with what failed if it does not. */
  check(text: string, assertion: () => void | Promise<void>): Promise<void>
  /**
   * Runs the case body, writes the scenario's fragment whatever happened, and returns the problem
   * (a body that threw, or checks that failed) instead of throwing it; see `failIfAny`.
   */
  run(body: (report: Walkthrough) => Promise<void>): Promise<Error | null>
}

/** Throws one error naming every problem a case's `run`s returned; does nothing when there are none. */
export function failIfAny(...problems: Array<Error | null>): void {
  const real = problems.filter((one): one is Error => one !== null)
  if (real.length === 0) return
  throw new Error(real.map((one) => one.message).join('\n\n'))
}

/** The report of one scenario of the page; see the file's head. */
export function walkthrough(id: ScenarioId): Walkthrough {
  const did: string[] = []
  const checks: Check[] = []
  const shots: Shot[] = []
  const rawLines: string[] = []
  const notes: Array<{ label: string; text: string }> = []
  const boxes: Box[] = []

  const report: Walkthrough = {
    did(sentence) {
      did.push(sentence)
    },
    async shot(source, caption) {
      startRun()
      shotCounter += 1
      const name = `${id}-${Date.now()}-${shotCounter}.png`
      const path = join(SHOTS(), name)
      try {
        if (Buffer.isBuffer(source)) writeFileSync(path, source)
        else await source.screenshot({ path, scale: 'css', timeout: 10_000 })
        shots.push({ caption, file: `shots/${name}` })
      } catch (error) {
        notes.push({ label: `${caption}（没能截到图）`, text: shortMessage(error) })
      }
    },
    logLines(userData, match) {
      const file = join(logsDirIn(userData), 'main.jsonl')
      if (!existsSync(file)) return
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line === '') continue
        try {
          if (match(JSON.parse(line) as Record<string, unknown>)) rawLines.push(line)
        } catch {
          // a torn line is not one a case picks
        }
      }
    },
    note(label, text) {
      notes.push({ label, text })
    },
    box(caption, title, content) {
      boxes.push({ caption, title, content })
    },
    async check(text, assertion) {
      try {
        await assertion()
        checks.push({ ok: true, text, detail: null })
      } catch (error) {
        checks.push({ ok: false, text, detail: shortMessage(error) })
      }
    },
    async run(body) {
      let problem: Error | null = null
      try {
        await body(report)
      } catch (error) {
        problem = error instanceof Error ? error : new Error(String(error))
        checks.push({
          ok: false,
          text: '这一步没能做完，后面的检查没有跑',
          detail: shortMessage(problem),
        })
      }
      write()
      const failed = checks.filter((one) => !one.ok)
      if (problem !== null) return problem
      if (failed.length === 0) return null
      return new Error(
        `${id}: ${failed.length} check(s) failed:\n${failed
          .map((one) => `- ${one.text}\n${one.detail ?? ''}`)
          .join('\n')}`,
      )
    },
  }

  /** Adds this case's part to the scenario's fragment of this run. */
  function write(): void {
    startRun()
    const before = readFragment(id)
    const merged: Fragment = {
      id,
      did: [...(before?.did ?? []), ...did],
      checks: [...(before?.checks ?? []), ...checks],
      shots: [...(before?.shots ?? []), ...shots],
      rawLines: [...(before?.rawLines ?? []), ...rawLines],
      notes: [...(before?.notes ?? []), ...notes],
      boxes: [...(before?.boxes ?? []), ...boxes],
      finishedAt: new Date().toISOString(),
    }
    writeFileSync(fragmentPath(id), JSON.stringify(merged, null, 2))
  }

  return report
}

// ---- pictures the page cannot take of itself --------------------------------------------------------

/** The window's own picture, from the main process; null when it cannot be had (a window that crashed). */
export async function windowPicture(app: ElectronApplication): Promise<Buffer | null> {
  try {
    const base64 = await Promise.race([
      app.evaluate(async ({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents
        if (contents === undefined) return ''
        return (await contents.capturePage()).toPNG().toString('base64')
      }),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 5_000)),
    ])
    return base64 === '' ? null : Buffer.from(base64, 'base64')
  } catch {
    return null
  }
}

/**
 * The whole screen, as far as the machine can give it: on Linux under a display, with ImageMagick's
 * `import`; null anywhere else, or when the tool is not there. What a native box looks like is
 * only ever in this picture, so a case that wants it asks, and says so in the report when it is not.
 */
export function screenPicture(): Buffer | null {
  if (process.platform !== 'linux' || process.env['DISPLAY'] === undefined) return null
  try {
    return execFileSync('import', ['-window', 'root', 'png:-'], {
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

// ---- reading the lines ------------------------------------------------------------------------------

const EVENT_NAMES: Readonly<Record<string, string>> = {
  'app.start': '启动',
  'app.unclean-exit': '上次没有正常退出',
  'app.startup-failed': '启动失败',
  'app.quit': '正常退出',
  'window.shown': '窗口出来了',
  'sandbox.posture': '沙箱状态',
  'sandbox.helpers': '交给沙箱的辅助程序',
  'main.uncaught': '后台没接住的错',
  'process.gone': '进程退出',
  'ipc.failed': '界面向后台的请求失败',
  'renderer.error': '界面里没接住的报错',
  'log.dropped': '限量丢掉的行',
  line: '某个模块交来的一行',
}

const str = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value))

/** What the key=value pairs of a model request failure say. */
function modelFailure(line: string): string | null {
  if (!line.includes('attempt failed:')) return null
  const pair = (name: string): string => new RegExp(`${name}=(\\S+)`, 'u').exec(line)?.[1] ?? '?'
  const retry = pair('retryable') === 'true' ? '可以重试' : '不能重试'
  return `模型请求失败：厂商 ${pair('provider')}，模型 ${pair('model')}，种类 ${pair('code')}，HTTP 状态 ${pair('status')}，厂商的码 ${pair('providerCode')}，${retry}`
}

function errorOf(value: unknown): string {
  const error = value as { name?: unknown; code?: unknown; message?: unknown } | null
  if (error === null || typeof error !== 'object') return str(value)
  const code = error.code === undefined ? '' : `（${str(error.code)}）`
  return `${str(error.name)}${code}：${str(error.message)}`
}

/** One sentence for a record, in the reader's words. */
function describe(record: Record<string, unknown>): string {
  switch (record['event']) {
    case 'app.start':
      return `${record['packaged'] === true ? '安装版' : '开发版'}，${str(record['platform'])} ${str(record['arch'])}，数据目录 ${str(record['userData'])}`
    case 'app.unclean-exit':
      return `上次启动于 ${str(record['startedAt'])}，版本 ${str(record['version'])}，没有走到正常退出`
    case 'app.startup-failed':
      return errorOf(record['error'])
    case 'app.quit':
      return '正常退出，运行标记已删除'
    case 'window.shown':
      return '主窗口显示出来了'
    case 'sandbox.posture':
      return `沙箱 ${str(record['state'])}；原因：${str(record['reasons'])}`
    case 'sandbox.helpers':
      return `沙箱用到的辅助程序在 ${str(record['packageDir'])}`
    case 'main.uncaught':
      return `${record['origin'] === 'unhandledRejection' ? '没人处理的异步失败' : '没接住的异常'}：${errorOf(record['error'])}`
    case 'process.gone': {
      const name = record['name'] === undefined ? '' : `（${str(record['name'])}）`
      return `${str(record['process'])}${name} 进程退出：原因 ${str(record['reason'])}，退出码 ${str(record['exitCode'])}`
    }
    case 'ipc.failed':
      return `${str(record['channel'])} 失败，种类 ${str(record['code'])}：${str(record['message'])}`
    case 'renderer.error':
      return `${str(record['message'])}（${str(record['source'])} 第 ${str(record['line'])} 行，共 ${str(record['repeats'])} 次）`
    case 'log.dropped':
      return `${str(record['source'])} 丢掉了 ${str(record['count'])} 条`
    case 'line':
      return (
        modelFailure(str(record['text'])) ?? `[${str(record['source'])}] ${str(record['text'])}`
      )
    default:
      return JSON.stringify(record)
  }
}

// ---- the page ---------------------------------------------------------------------------------------

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function section(info: ScenarioInfo, fragment: Fragment | null, root: string): string {
  const head = `<h2><span class="seg">${info.segment}</span> ${escape(info.title)}</h2><p class="plain">${escape(info.plain)}</p>`
  if (fragment === null) {
    return `<section id="${info.id}">${head}<p class="empty">还没有运行结果。这一节要等相应的功能做出来、对应的端到端用例跑过才会有内容。</p></section>`
  }
  const failed = fragment.checks.filter((one) => !one.ok).length
  const state =
    failed === 0
      ? `<span class="pill ok">全部通过 · ${fragment.checks.length} 条</span>`
      : `<span class="pill bad">${failed} 条没通过 · 共 ${fragment.checks.length} 条</span>`
  const did = fragment.did.map((one) => `<p class="did">做了什么：${escape(one)}</p>`).join('')
  const shots = fragment.shots
    .map((one) => {
      let src = ''
      try {
        src = `data:image/png;base64,${readFileSync(join(root, one.file)).toString('base64')}`
      } catch {
        return `<p class="empty">（图 ${escape(one.caption)} 找不到了）</p>`
      }
      return `<figure><img alt="${escape(one.caption)}" src="${src}"><figcaption>${escape(one.caption)}</figcaption></figure>`
    })
    .join('')
  const boxes = fragment.boxes
    .map(
      (one) =>
        `<figure class="box"><div class="boxframe"><b>${escape(one.title)}</b><pre>${escape(one.content)}</pre></div><figcaption>${escape(one.caption)}</figcaption></figure>`,
    )
    .join('')
  const raw = fragment.rawLines.length
    ? `<h3>日志原始的一行</h3><pre class="raw">${fragment.rawLines.map(escape).join('\n')}</pre>`
    : ''
  const rows = fragment.rawLines
    .map((line) => {
      try {
        const record = JSON.parse(line) as Record<string, unknown>
        const event = str(record['event'])
        return `<tr><td>${escape(str(record['t']))}</td><td class="lv-${escape(str(record['level']))}">${escape(str(record['level']))}</td><td>${escape(event)}<br><small>${escape(EVENT_NAMES[event] ?? '')}</small></td><td>${escape(describe(record))}</td></tr>`
      } catch {
        return ''
      }
    })
    .join('')
  const tidy = rows
    ? `<h3>整理后的样子</h3><table><thead><tr><th>时间</th><th>级别</th><th>事件</th><th>要点</th></tr></thead><tbody>${rows}</tbody></table>`
    : ''
  const notes = fragment.notes
    .map((one) => `<h3>${escape(one.label)}</h3><pre class="note">${escape(one.text)}</pre>`)
    .join('')
  const checks = `<h3>逐条检查</h3><ul class="checks">${fragment.checks
    .map(
      (one) =>
        `<li class="${one.ok ? 'ok' : 'bad'}"><span class="mark">${one.ok ? '✓' : '✗'}</span> ${escape(one.text)}${one.detail === null ? '' : `<pre class="detail">${escape(one.detail)}</pre>`}</li>`,
    )
    .join('')}</ul>`
  return `<section id="${info.id}">${head}${state}${did}${shots}${boxes}${raw}${tidy}${notes}${checks}</section>`
}

const STYLE = `
:root { color-scheme: light dark; --bg: #fbfaf7; --fg: #1d1d1b; --muted: #6b6a64; --line: #deddd5; --card: #ffffff; --ok: #1b7a43; --bad: #b3261e; --warn: #9a6700; --code: #f1f0ea; }
@media (prefers-color-scheme: dark) { :root { --bg: #191918; --fg: #ecebe4; --muted: #a09f96; --line: #34332f; --card: #222220; --ok: #5fcf8a; --bad: #ff8a80; --warn: #e3b341; --code: #2a2a27; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 0 0 4px; }
h3 { font-size: 14px; margin: 18px 0 6px; color: var(--muted); font-weight: 600; }
.sub { color: var(--muted); margin: 0 0 20px; }
ul.nav { display: flex; flex-wrap: wrap; gap: 6px 10px; margin: 0 0 24px; padding: 0; list-style: none; }
ul.nav a { color: inherit; text-decoration: none; border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; font-size: 13px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin: 0 0 18px; }
.seg { font-size: 12px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; vertical-align: 2px; }
.plain { color: var(--muted); margin: 0 0 10px; }
.did { margin: 6px 0; }
.empty { color: var(--muted); font-style: italic; }
.pill { display: inline-block; font-size: 13px; border-radius: 999px; padding: 1px 10px; border: 1px solid currentColor; }
.pill.ok, li.ok .mark { color: var(--ok); }
.pill.bad, li.bad .mark { color: var(--bad); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; background: var(--muted); }
.dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); }
figure { margin: 12px 0; } figure img { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; }
figcaption { font-size: 13px; color: var(--muted); margin-top: 4px; }
.boxframe { max-width: 460px; border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; background: var(--code); }
.boxframe pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
pre { background: var(--code); border-radius: 6px; padding: 8px 10px; overflow-x: auto; margin: 0; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre.raw { white-space: pre-wrap; word-break: break-all; }
pre.detail { margin-top: 4px; white-space: pre-wrap; color: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; vertical-align: top; padding: 5px 8px; border-bottom: 1px solid var(--line); }
td small { color: var(--muted); }
.lv-error { color: var(--bad); font-weight: 600; } .lv-warn { color: var(--warn); font-weight: 600; }
ul.checks { list-style: none; padding: 0; margin: 0; }
ul.checks li { padding: 3px 0; } .mark { font-weight: 700; display: inline-block; width: 1.3em; }
`

/** The page, from every fragment of this run. */
export function renderReport(generatedAt: Date): string {
  const root = ROOT()
  const fragments = SCENARIOS.map((info) => readFragment(info.id))
  const nav = SCENARIOS.map((info, index) => {
    const fragment = fragments[index] ?? null
    const kind = fragment === null ? '' : fragment.checks.some((one) => !one.ok) ? 'bad' : 'ok'
    return `<li><a href="#${info.id}"><span class="dot ${kind}"></span>${escape(info.title)}</a></li>`
  }).join('')
  const sections = SCENARIOS.map((info, index) =>
    section(info, fragments[index] ?? null, root),
  ).join('')
  const filled = fragments.filter((one) => one !== null).length
  const failed = fragments.filter((one) => one?.checks.some((check) => !check.ok)).length
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>错误日志走查报告</title><style>${STYLE}</style></head>
<body><main>
<h1>错误日志走查报告</h1>
<p class="sub">生成于 ${escape(generatedAt.toISOString())} · ${SCENARIOS.length} 个场景，${filled} 个有结果，${failed} 个有没通过的检查。每一节先放日志原始的一行，再放整理后的样子。</p>
<ul class="nav">${nav}</ul>
${sections}
</main></body></html>
`
}

/**
 * Writes `reports/walkthrough/index.html` from every fragment so far, and, given the test's info,
 * attaches the page to the Playwright report. Call from `afterAll`; it never throws.
 */
export async function publishWalkthroughReport(info?: TestInfo): Promise<void> {
  try {
    startRun()
    const html = renderReport(new Date())
    writeFileSync(join(ROOT(), 'index.html'), html)
    if (info === undefined) return
    try {
      await info.attach('walkthrough-report.html', { body: html, contentType: 'text/html' })
    } catch {
      // an afterAll that cannot carry an attachment still leaves the file
    }
  } catch {
    // the report is a help to reading a run, never a reason for one to fail
  }
}
