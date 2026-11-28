/**
 * Two rules of segment two that a test guards by scanning the desktop app's source
 * (docs/features/error-logs/spec.md §一直要成立的规矩 第 11、12 条; acceptance 15 and 9):
 *
 *   1. nothing starts Electron's crash reporter or sets where its dumps go (§崩溃转储, D5): Tenon
 *      keeps no dump, and a dump can hold memory, command lines and environments (E3);
 *   2. the main process registers no `uncaughtException` listener (P2): Electron's own listener
 *      shows its error box only while it is the sole one, and `uncaughtExceptionMonitor` and
 *      `unhandledRejection` are what Tenon listens to instead.
 *
 * A scan that finds nothing proves nothing until it is seen to find something, so each rule is
 * first run on a made-up file list that breaks it, and on a list that must not trip it. Both are
 * green today and guard against a later change.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '../src')
const MAIN = join(SRC, 'main')

interface Source {
  /** Relative to the folder scanned, with forward slashes. */
  readonly path: string
  readonly text: string
}

function sourcesIn(dir: string, root: string): Source[] {
  const found: Source[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') found.push(...sourcesIn(full, root))
    } else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(name)) {
      found.push({
        path: relative(root, full).split('\\').join('/'),
        text: readFileSync(full, 'utf8'),
      })
    }
  }
  return found
}

/** Files that name the crash reporter, a dump folder, or the switch that moves it. */
function crashCollectors(files: readonly Source[]): string[] {
  return files
    .filter((file) =>
      /crashReporter|crashDumps|crash-dumps-dir|enable-crash-reporter|--crash-reporter|setCrashKey/u.test(
        file.text,
      ),
    )
    .map((file) => file.path)
}

it('error-logs 验收 15: no source starts the crash reporter', () => {
  const sample: Source[] = [
    { path: 'a.ts', text: "import { crashReporter } from 'electron'\ncrashReporter.start({})" },
    { path: 'b.ts', text: "app.setPath('crashDumps', '/x')" },
    { path: 'c.ts', text: "app.commandLine.appendSwitch('crash-dumps-dir', '/x')" },
    { path: 'd.ts', text: "app.commandLine.appendSwitch('enable-crash-reporter')" },
    {
      path: 'ok.ts',
      text: "const note = 'a crash report is for the system'\nwatchProcessExits(app, log)",
    },
  ]
  expect(crashCollectors(sample)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])

  // The whole app: the main process, the preload, the renderer.
  const files = sourcesIn(SRC, SRC)
  expect(files.length).toBeGreaterThan(100)
  expect(files.some((file) => file.path === 'main/index.ts')).toBe(true)
  expect(crashCollectors(files)).toEqual([])
})

/** Files that register a listener for `uncaughtException` (not for `uncaughtExceptionMonitor`). */
function uncaughtListeners(files: readonly Source[]): string[] {
  const listen =
    /\.\s*(?:on|once|addListener|prependListener|prependOnceListener)\s*\(\s*(?:'uncaughtException'|"uncaughtException"|`uncaughtException`)/u
  const capture = /setUncaughtExceptionCaptureCallback/u
  return files
    .filter((file) => listen.test(file.text) || capture.test(file.text))
    .map((file) => file.path)
}

it('error-logs 验收 9: the main process registers no uncaughtException listener', () => {
  const sample: Source[] = [
    { path: 'a.ts', text: "process.on('uncaughtException', (e) => log(e))" },
    { path: 'b.ts', text: 'process.once("uncaughtException", handler)' },
    { path: 'c.ts', text: "process\n  .addListener('uncaughtException', handler)" },
    { path: 'd.ts', text: 'process.setUncaughtExceptionCaptureCallback(handler)' },
    // What is allowed, and the text of an event's own name.
    { path: 'ok-1.ts', text: "proc.on('uncaughtExceptionMonitor', (error, origin) => {})" },
    { path: 'ok-2.ts', text: "proc.on('unhandledRejection', (reason) => {})" },
    { path: 'ok-3.ts', text: "readonly origin: 'uncaughtException' | 'unhandledRejection'" },
  ]
  expect(uncaughtListeners(sample)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])

  const files = sourcesIn(MAIN, MAIN)
  expect(files.some((file) => file.path === 'index.ts')).toBe(true)
  expect(uncaughtListeners(files)).toEqual([])
})
