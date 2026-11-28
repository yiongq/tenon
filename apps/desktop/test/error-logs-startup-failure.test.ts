/**
 * What happens when Tenon cannot start (docs/features/error-logs/spec.md §启动失败, §接口
 * `reportStartupFailure`; acceptance 11): the order write a line → wait for ready → show the box →
 * exit with 1, the box's language and what it says, and the branch where the log could not be
 * written. `index.ts` cannot be run in a unit test, so everything the function is handed is a
 * stand-in or a real object the test owns:
 *
 *  - the log is the real `createAppLog` on a real folder, so "the line is written" is read from
 *    the file, and "before the box" is read from the file at the moment the box is shown;
 *  - `showErrorBox` is Electron's `dialog.showErrorBox`: a synchronous call that blocks the main
 *    process until the user closes the box and returns nothing. The stand-in records the call and
 *    returns at once (it reproduces the signature and the "returns nothing" part; blocking is what
 *    a real box adds, and the e2e case of the same number has the real one);
 *  - `whenReady` is `app.whenReady()` made by hand: a promise the test settles when it chooses
 *    (on Linux a box shown before ready only prints to stderr, evidence.md E7, so the function must
 *    not show it earlier);
 *  - `exit` is `app.exit`: it takes the code and does not return in the real thing; here it records.
 *
 * The real start failure, `index.ts`'s wiring and the real box are in `e2e/error-logs-restart.spec.ts`.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
import { afterEach, expect, it, vi } from 'vitest'
import {
  APP_DIR,
  makeTempRoot,
  openLog,
  readRecords,
  sweepTempRoots,
} from './support/error-logs.js'
import type { OpenedLog } from './support/error-logs.js'
import { reportStartupFailure } from './support/error-logs-startup.js'

afterEach(sweepTempRoots)

const CJK = /[㐀-鿿]/u

/** A turn of the event loop: whatever the function can do without waiting on `whenReady` is done. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

interface Shown {
  readonly title: string
  readonly content: string
  /** The kinds of event in `main.jsonl` at the moment the box was shown. */
  readonly loggedBefore: readonly string[]
}

/** Everything a start failure is handed, recording what is done with it and in what order. */
function harness(
  opened: OpenedLog,
  extra: { languages?: readonly string[]; error?: unknown } = {},
) {
  const ready = Promise.withResolvers<void>()
  const trace: string[] = []
  const boxes: Shown[] = []
  const exits: number[] = []
  const file = join(opened.dir, 'main.jsonl')
  const openFallback = vi.fn<() => void>(() => {
    trace.push('openFallback')
  })
  const q = {
    error: 'error' in extra ? extra.error : new TypeError('E2E_START_BOOM'),
    log: opened.log,
    openFallback,
    whenReady: (): Promise<void> => {
      trace.push('whenReady')
      return ready.promise
    },
    showErrorBox: (title: string, content: string): void => {
      trace.push('box')
      boxes.push({
        title,
        content,
        loggedBefore: readRecords(file).map((record) => record.event),
      })
    },
    exit: (code: number): void => {
      trace.push(`exit(${code})`)
      exits.push(code)
    },
    languages: extra.languages ?? ['en-US'],
  }
  return { q, ready, trace, boxes, exits, openFallback, file }
}

/** An open log whose folder sits under a "home" the test owns, so the folder reads `~/…`. */
function logUnderHome(): OpenedLog & { readonly home: string } {
  const home = makeTempRoot('startup-home')
  const dir = join(
    home,
    'Library',
    'Application Support',
    'Tenon',
    'profiles',
    'local',
    'personal',
    'logs',
  )
  const opened = openLog({ dir, home })
  return Object.assign(opened, { home })
}

const FOLDER = '~/Library/Application Support/Tenon/profiles/local/personal/logs'

it('error-logs 验收 11: reportStartupFailure logs, waits for ready, shows the localized box, then exits 1', async () => {
  const opened = logUnderHome()
  const h = harness(opened)
  const done = reportStartupFailure(h.q)
  await settle()

  // First the line, on disk: an error, the error summarized.
  const failed = readRecords(h.file).filter((record) => record.event === 'app.startup-failed')
  expect(failed).toHaveLength(1)
  expect(failed[0]).toMatchObject({ level: 'error' })
  expect(failed[0]?.['error']).toMatchObject({ name: 'TypeError', message: 'E2E_START_BOOM' })
  // Then it waits for ready: no box and no exit yet.
  expect(h.trace).toContain('whenReady')
  expect(h.boxes).toEqual([])
  expect(h.exits).toEqual([])

  h.ready.resolve()
  await done

  // One box, shown after the line was written, then one exit with 1, after the box.
  expect(h.boxes).toHaveLength(1)
  expect(h.boxes[0]?.loggedBefore).toContain('app.startup-failed')
  expect(h.exits).toEqual([1])
  expect(h.trace.indexOf('whenReady')).toBeLessThan(h.trace.indexOf('box'))
  expect(h.trace.indexOf('box')).toBeLessThan(h.trace.indexOf('exit(1)'))
  // English for an English system; it says Tenon did not start, and where the log is, with the
  // home folder written ~ and nothing of the real one.
  const box = h.boxes[0]
  expect(box?.title.length).toBeGreaterThan(0)
  expect(`${box?.title} ${box?.content}`).toContain('Tenon')
  expect(CJK.test(`${box?.title}${box?.content}`)).toBe(false)
  expect(box?.content).toContain(FOLDER)
  expect(box?.content).not.toContain(opened.home)
  // The log was open, so there was nothing to try again.
  expect(h.openFallback).not.toHaveBeenCalled()
  // A start failure is not a quit: the marker stays, and no `app.quit` is written.
  expect(existsSync(join(opened.dir, 'running.json'))).toBe(true)
  expect(readRecords(h.file).some((record) => record.event === 'app.quit')).toBe(false)
})

it('error-logs 验收 11: the box speaks the system language, zh-CN or en, and en when there is no choice', async () => {
  const cases: Array<[readonly string[], 'zh' | 'en']> = [
    [['zh-CN'], 'zh'],
    [['zh-Hans-CN', 'en-US'], 'zh'],
    [['en-US'], 'en'],
    [['fr-FR', 'de-DE'], 'en'],
    [[], 'en'],
  ]
  for (const [languages, expected] of cases) {
    const opened = logUnderHome()
    const h = harness(opened, { languages })
    h.ready.resolve()
    // oxlint-disable-next-line no-await-in-loop -- one function at a time, each on its own log
    await reportStartupFailure(h.q)
    expect(h.boxes, `${languages.join()}`).toHaveLength(1)
    const text = `${h.boxes[0]?.title}${h.boxes[0]?.content}`
    expect(CJK.test(text), `${languages.join()}`).toBe(expected === 'zh')
    // Either way: Tenon by name, and the folder.
    expect(text, `${languages.join()}`).toContain('Tenon')
    expect(h.boxes[0]?.content, `${languages.join()}`).toContain(FOLDER)
    expect(h.exits, `${languages.join()}`).toEqual([1])
  }
})

it('error-logs 验收 11: a log that is not open is opened again first, and then the line and the folder are in place', async () => {
  const root = makeTempRoot('startup-fallback')
  const dir = join(root, 'profiles', 'local', 'personal', 'logs')
  const opened = openLog({ dir, home: root, deferOpen: true })
  const h = harness(opened)
  // The fallback is what index.ts hands in: it opens the log on the folder it worked out.
  h.openFallback.mockImplementation(() => {
    h.trace.push('openFallback')
    opened.open()
  })
  h.ready.resolve()
  await reportStartupFailure(h.q)

  expect(h.openFallback).toHaveBeenCalledTimes(1)
  expect(h.trace.indexOf('openFallback')).toBeLessThan(h.trace.indexOf('box'))
  // The line is in the file, and the box names the folder.
  const failed = readRecords(h.file).filter((record) => record.event === 'app.startup-failed')
  expect(failed).toHaveLength(1)
  expect(h.boxes[0]?.content).toContain('~/profiles/local/personal/logs')
  expect(h.exits).toEqual([1])
})

it('error-logs 验收 11: when the log cannot be written the box says so, with the error name, and still exits 1', async () => {
  // The folder cannot be made: its parent is a file. This is how a start that failed before the
  // log could open looks.
  const root = makeTempRoot('startup-unwritable')
  const blocker = join(root, 'not-a-folder')
  writeFileSync(blocker, 'a file where a folder should be\n')
  const dir = join(blocker, 'logs')
  const check = async (languages: readonly string[], said: RegExp): Promise<void> => {
    const opened = openLog({ dir, home: root, deferOpen: true, makeDir: false })
    const h = harness(opened, { languages, error: new RangeError('E2E_NO_LOG_START') })
    h.openFallback.mockImplementation(() => {
      h.trace.push('openFallback')
      // The attempt fails, as the real one would here; the log stays closed.
      opened.log.open(absolutePath(dir), {
        version: '0.0.0',
        packaged: false,
        home: absolutePath(root),
        appDir: absolutePath(APP_DIR),
      })
    })
    h.ready.resolve()
    await reportStartupFailure(h.q)
    expect(opened.log.dir).toBeNull()
    expect(h.openFallback).toHaveBeenCalledTimes(1)
    expect(h.boxes).toHaveLength(1)
    const content = h.boxes[0]?.content ?? ''
    // True to what happened: no folder is claimed, the error's name is there.
    expect(content).toMatch(said)
    expect(content).toContain('RangeError')
    expect(content).not.toContain(root)
    expect(content).not.toContain('~/')
    expect(h.exits).toEqual([1])
    expect(h.trace.indexOf('box')).toBeLessThan(h.trace.indexOf('exit(1)'))
  }
  // zh-CN: 「日志也没能写下」 is the spec's own wording; en has no wording in the spec.
  await check(['zh-CN'], /日志也没能写下/u)
  await check(['en-US'], /RangeError/u)
})

it('error-logs 验收 11: whatever the start failed with, even a thing that is not an error, ends in a line, a box and exit 1', async () => {
  const things: unknown[] = ['E2E_A_STRING', undefined, null, { code: 'EACCES' }]
  for (const error of things) {
    const opened = logUnderHome()
    const h = harness(opened, { error })
    h.ready.resolve()
    // oxlint-disable-next-line no-await-in-loop -- one function at a time, each on its own log
    await reportStartupFailure(h.q)
    expect(
      readRecords(h.file).filter((record) => record.event === 'app.startup-failed'),
      `${String(error)}`,
    ).toHaveLength(1)
    expect(h.boxes, `${String(error)}`).toHaveLength(1)
    expect(h.exits, `${String(error)}`).toEqual([1])
  }
})

it('error-logs 验收 11: a secret in the failure is redacted in the line', async () => {
  const SECRET = 'wrong-key-start-failed-TR5N8'
  const opened = logUnderHome()
  opened.log.remember(SECRET)
  const h = harness(opened, { error: new Error(`could not read the store with ${SECRET}`) })
  h.ready.resolve()
  await reportStartupFailure(h.q)
  const text = JSON.stringify(readRecords(h.file))
  expect(text).not.toContain(SECRET)
  expect(text).toContain('app.startup-failed')
  // and nothing of it in the box either
  expect(JSON.stringify(h.boxes)).not.toContain(SECRET)
})
