/**
 * Two rules the spec has a test guard by scanning the main process's source
 * (docs/features/error-logs/spec.md §一直要成立的规矩 第 2、5、6 条; acceptance 3's "every
 * registration point" rests on the second):
 *
 *   1. only `log/` and `mcp/log-sink.ts` write under the profile's `logs/` folder: no other file
 *      names the app log's files, or names the folder while it can write files itself; and
 *      nothing sets the log path of Electron's own (`app.setAppLogsPath`, `getPath('logs')`, D17);
 *   2. the one `HostSecrets` is built in `host/index.ts` and nowhere else in the main process:
 *      `new KeychainSecrets` and `new MemorySecrets` appear in that file only;
 *   3. (spec §一直要成立的规矩 第 1 条, which lint and this scan guard together) nothing in the main
 *      process outside `log/` writes the console, `process.stderr` or `process.stdout`, `dev-env.ts`
 *      no exception. Neither is complete: lint names the properties, imports and globals it bans
 *      (`.oxlintrc.json`), and this scan lists the spellings it knows (`TERMINAL_WRITERS`: the
 *      property forms, the imports, an alias of `console`, `process` or `globalThis`, `writeSync` to
 *      descriptor 1 or 2, `Reflect` on them). A spelling that is on neither list is not caught by
 *      either, and the review has to catch it;
 *   4. (error-logs 验收 6) `logRouteFailures` is the outermost of the route table's wrappers; and
 *      (spec 段一评审 s8) the sandbox's change notice is not held back by the line about the
 *      helper paths.
 *
 * A scan that finds nothing proves nothing until it is seen to find something, so each rule is
 * first run on a made-up file list that breaks it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '../src')
const MAIN = join(SRC, 'main')

interface Source {
  /** Relative to `apps/desktop/src/main`, with forward slashes. */
  readonly path: string
  readonly text: string
}

function sourcesIn(dir: string, root: string): Source[] {
  const found: Source[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') found.push(...sourcesIn(full, root))
    } else if (/\.(?:ts|tsx|mts|cts)$/u.test(name)) {
      found.push({
        path: relative(root, full).split('\\').join('/'),
        text: readFileSync(full, 'utf8'),
      })
    }
  }
  return found
}

const WRITES_LOGS = new Set(['mcp/log-sink.ts'])

/** Files outside `log/` and the MCP sink that name the app log's files, or the folder while able to write files. */
function stray(files: readonly Source[]): string[] {
  return files
    .filter((file) => !file.path.startsWith('log/') && !WRITES_LOGS.has(file.path))
    .filter((file) => {
      const namesAppLogFile = /\b(?:main\.jsonl|main\.[12]\.jsonl|running\.json)\b/u.test(file.text)
      const namesFolder = /['"`]logs['"`]|\blogs\//u.test(file.text)
      const canWrite = /from ['"]node:fs(?:\/promises)?['"]/u.test(file.text)
      return namesAppLogFile || (namesFolder && canWrite)
    })
    .map((file) => file.path)
}

/** Where Electron's own log path is touched. */
function electronLogPath(files: readonly Source[]): string[] {
  return files
    .filter((file) => /setAppLogsPath|getPath\(\s*['"`]logs['"`]\s*\)/u.test(file.text))
    .map((file) => file.path)
}

/** Files that make a keychain or memory secrets store, other than the one that may. */
function secretsBuilders(files: readonly Source[]): string[] {
  return files
    .filter((file) => file.path !== 'host/index.ts')
    .filter((file) => /new\s+(?:KeychainSecrets|MemorySecrets)\b/u.test(file.text))
    .map((file) => file.path)
}

it('error-logs 验收 3: only log/ and mcp/log-sink.ts write under logs/, and Electron’s own log path is never set', () => {
  // The scan finds a file that breaks the rule.
  const sample: Source[] = [
    { path: 'log/app-log.ts', text: "join(dir, 'main.jsonl')" },
    { path: 'mcp/log-sink.ts', text: "join(dir, 'logs', 'mcp-a.log')" },
    { path: 'index.ts', text: "const p = join(dir, 'main.jsonl')" },
    {
      path: 'chat.ts',
      text: "import { writeFile } from 'node:fs/promises'\njoin(dir, 'logs', 'x.txt')",
    },
    { path: 'menu.ts', text: "app.setAppLogsPath('/x')" },
  ]
  expect(stray(sample)).toEqual(['index.ts', 'chat.ts'])
  expect(electronLogPath(sample)).toEqual(['menu.ts'])

  const files = sourcesIn(MAIN, MAIN)
  expect(files.length).toBeGreaterThan(50)
  // The one file the rule allows outside log/ is really there.
  expect(files.some((file) => file.path === 'mcp/log-sink.ts')).toBe(true)
  expect(stray(files)).toEqual([])
  expect(electronLogPath(sourcesIn(SRC, SRC))).toEqual([])
})

it('error-logs 验收 3: new KeychainSecrets and new MemorySecrets appear in host/index.ts only', () => {
  const sample: Source[] = [
    { path: 'host/index.ts', text: 'new KeychainSecrets()' },
    { path: 'provider.ts', text: 'const s = new MemorySecrets()' },
    { path: 'mcp/store.ts', text: 'const s = new  KeychainSecrets(service)' },
    { path: 'host/secrets.ts', text: 'class MemorySecrets {}' },
  ]
  expect(secretsBuilders(sample)).toEqual(['provider.ts', 'mcp/store.ts'])

  const files = sourcesIn(MAIN, MAIN)
  // host/index.ts builds one, either way, or the rule is guarding nothing.
  expect(files.find((file) => file.path === 'host/index.ts')?.text).toMatch(
    /new\s+(?:KeychainSecrets|MemorySecrets)\b/u,
  )
  expect(secretsBuilders(files)).toEqual([])
})

// ---- 3. nothing but log/ writes the console or stderr -----------------------------------------------

/** Every way a source file of the main process may write to the terminal, with a name for the report. */
const TERMINAL_WRITERS: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  ['console.', /(?<![\w$.])console\s*[.[]/u],
  ['globalThis.console', /\bglobalThis\s*(?:\??\.\s*|\[\s*['"`])console\b/u],
  ['globalThis.process', /\bglobalThis\s*(?:\??\.\s*|\[\s*['"`])process\b/u],
  ['process.stderr / process.stdout', /\bprocess\s*(?:\??\.\s*|\[\s*['"`])std(?:err|out)\b/u],
  ['{ stderr } = process', /\{[^}]*\bstd(?:err|out)\b[^}]*\}\s*=\s*process\b/u],
  ['process.emitWarning', /\bprocess\s*\??\.\s*emitWarning\b/u],
  ['node:console', /\bfrom\s+['"](?:node:)?console['"]/u],
  ['import("node:process")', /\bimport\(\s*['"](?:node:)?process['"]\s*\)/u],
  // The bare name, not followed by a property: `const c = console`, `{ error } = console`, `use(console)`.
  ['console alias', /(?<![\w$./:'"-])console\b(?![\w$-]|\s*[.[(])/u],
  ['process alias', /\b(?:const|let|var)\s+[\w$]+\s*(?::[^=;]+)?=\s*process\b(?!\s*[.[])/u],
  // Bare only: `globalThis as SomeGlobal` is how the e2e seams reach their own property.
  ['globalThis alias', /\b(?:const|let|var)\s+[\w$]+\s*=\s*globalThis\s*(?:;|$)/mu],
  ['{ … } = globalThis', /\{[^}]*\}\s*=\s*globalThis\b(?!\s*[.[])/u],
  ['writeSync to descriptor 1 or 2', /\bwriteSync\(\s*[12]\s*,/u],
  [
    'Reflect on process, console or globalThis',
    /\bReflect\s*\.\s*\w+\(\s*(?:process|console|globalThis)\b/u,
  ],
]

/** `import … from 'node:process'` that can reach stderr or stdout: by name, as a namespace or as the default. */
function importsProcessStreams(text: string): boolean {
  for (const match of text.matchAll(/\bimport\s+([^;'"]+?)\s+from\s+['"](?:node:)?process['"]/gu)) {
    const clause = (match[1] ?? '').trim().replace(/^type\s+/u, '')
    if (/\bstd(?:err|out)\b|\*\s*as\b/u.test(clause) || /^[A-Za-z_$]/u.test(clause)) return true
  }
  return false
}

/** `path: way` for each way a file outside `log/` writes to the terminal. */
function terminalWriters(files: readonly Source[]): string[] {
  const found: string[] = []
  for (const file of files) {
    if (file.path.startsWith('log/')) continue
    for (const [name, pattern] of TERMINAL_WRITERS) {
      if (pattern.test(file.text)) found.push(`${file.path}: ${name}`)
    }
    if (importsProcessStreams(file.text)) found.push(`${file.path}: import of process streams`)
  }
  return found
}

it('error-logs 验收 1: outside log/ nothing in the main process writes the console, stderr or stdout, in any spelling, dev-env.ts included', () => {
  // The scan finds each of them, wherever the file is (the one in log/ is allowed).
  const sample: Source[] = [
    { path: 'a.ts', text: "console.warn('x')" },
    { path: 'b.ts', text: "console['error']('x')" },
    { path: 'c.ts', text: "globalThis.console.error('x')" },
    { path: 'd.ts', text: "globalThis.process.stderr.write('x')" },
    { path: 'e.ts', text: "process.stderr.write('x')" },
    { path: 'f.ts', text: "process['stdout'].write('x')" },
    { path: 'g.ts', text: "const { stderr } = process\nstderr.write('x')" },
    { path: 'h.ts', text: "import { stderr } from 'node:process'" },
    { path: 'i.ts', text: "import nodeProcess from 'node:process'" },
    { path: 'j.ts', text: "import * as p from 'process'" },
    { path: 'k.ts', text: "process.emitWarning('x')" },
    { path: 'l.ts', text: "import { Console } from 'node:console'" },
    { path: 'm.ts', text: "const p = await import('node:process')" },
    // Through a name the file gives it, through a descriptor, through reflection.
    { path: 'n.ts', text: "const c = console\nc.error('x')" },
    { path: 'o.ts', text: "const { error } = console\nerror('x')" },
    { path: 'p.ts', text: "const p = process\np.stderr.write('x')" },
    { path: 'q.ts', text: "const g = globalThis\ng.console.error('x')" },
    { path: 'r.ts', text: "const { process: p } = globalThis\np.stderr.write('x')" },
    { path: 's.ts', text: "writeSync(2, 'x')" },
    { path: 't.ts', text: "Reflect.get(process, 'stderr').write('x')" },
    { path: 'dev-env.ts', text: "process.stderr.write('dev-env has no exception')" },
    { path: 'log/app-log.ts', text: 'process.stderr.write(text)' },
    // What is not a writer: an address, a name that merely has the word in it, cwd, a type.
    { path: 'presets.ts', text: "'https://bailian.console.aliyun.com/cn-beijing'" },
    { path: 'ok-1.ts', text: "import { cwd } from 'node:process'\nconst consoleLevel = 1" },
    { path: 'ok-2.ts', text: "import type { Stats } from 'node:fs'\nconst stderrColor = 'red'" },
    {
      path: 'ok-3.ts',
      text: "watchUncaught(process, appLog)\nconst platform = process.platform\nwriteSync(fd, 'x')\nconst seam = globalThis as SeamGlobal\nconst url = 'https://platform.kimi.com/console/api-keys'",
    },
  ]
  expect(terminalWriters(sample)).toEqual([
    'a.ts: console.',
    'b.ts: console.',
    'c.ts: globalThis.console',
    'd.ts: globalThis.process',
    'd.ts: process.stderr / process.stdout',
    'e.ts: process.stderr / process.stdout',
    'f.ts: process.stderr / process.stdout',
    'g.ts: { stderr } = process',
    'h.ts: import of process streams',
    'i.ts: import of process streams',
    'j.ts: import of process streams',
    'k.ts: process.emitWarning',
    'l.ts: node:console',
    'm.ts: import("node:process")',
    'n.ts: console alias',
    'o.ts: console alias',
    'p.ts: process alias',
    'q.ts: globalThis alias',
    'r.ts: { … } = globalThis',
    's.ts: writeSync to descriptor 1 or 2',
    't.ts: Reflect on process, console or globalThis',
    'dev-env.ts: process.stderr / process.stdout',
  ])

  const files = sourcesIn(MAIN, MAIN)
  expect(files.some((file) => file.path === 'dev-env.ts')).toBe(true)
  expect(terminalWriters(files)).toEqual([])
})

// ---- 4. the order of the route wrappers, and the sandbox's notice -----------------------------------

/** The text from the `(` at `open` to its matching `)`, exclusive. */
function insideParens(text: string, open: number): string {
  let depth = 0
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === '(') depth += 1
    else if (text[at] === ')') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, at)
    }
  }
  return text.slice(open + 1)
}

/** The argument text of every call of `name(` in `text`. */
function callsOf(text: string, name: string): string[] {
  return [...text.matchAll(new RegExp(`(?<![\\w$.])${name}\\(`, 'gu'))].map((match) =>
    insideParens(text, match.index + match[0].length - 1),
  )
}

/** Files outside `log/` where `logRouteFailures` is called, and what is wrong with each call. */
function routeWrapperProblems(files: readonly Source[]): string[] {
  const calls = files
    .filter((file) => !file.path.startsWith('log/'))
    .flatMap((file) => callsOf(file.text, 'logRouteFailures').map((args) => ({ file, args })))
  if (calls.length !== 1) return [`${calls.length} calls of logRouteFailures, not 1`]
  const args = (calls[0]?.args ?? '').trim()
  const removing = args.indexOf('refuseWhileRemoving(')
  const shutting = args.indexOf('refuseWhileShuttingDown(')
  const innermost = args.search(/e2eRouteSeam\(|ipcMain\b/u)
  // The first argument opens with the removal wrapper, which holds the shutdown one, which holds the
  // base; the log itself is the call's last argument, so the call is outside all three.
  const problems: string[] = []
  if (removing !== 0) problems.push('the first wrapper inside it is not refuseWhileRemoving')
  if (!(removing < shutting))
    problems.push('refuseWhileShuttingDown is not inside refuseWhileRemoving')
  if (!(shutting < innermost)) problems.push('the base ipc is not inside refuseWhileShuttingDown')
  if (!/,\s*appLog\s*,?\s*$/u.test(args)) problems.push('appLog is not its last argument')
  return problems
}

it('error-logs 验收 6: logRouteFailures is the outermost of the route table’s wrappers: the shutdown and removal refusals happen outside it', () => {
  const ok = `const routes = logRouteFailures(
    refuseWhileRemoving(refuseWhileShuttingDown(e2eRouteSeam(ipcMain, a, b), () => x), removing),
    appLog,
  )`
  const innermost = `const routes = refuseWhileRemoving(
    refuseWhileShuttingDown(logRouteFailures(e2eRouteSeam(ipcMain, a, b), appLog), () => x),
    removing,
  )`
  const middle = `const routes = refuseWhileRemoving(
    logRouteFailures(refuseWhileShuttingDown(e2eRouteSeam(ipcMain, a, b), () => x), appLog),
    removing,
  )`
  const swapped = `const routes = logRouteFailures(
    refuseWhileShuttingDown(refuseWhileRemoving(e2eRouteSeam(ipcMain, a, b), removing), () => x),
    appLog,
  )`
  expect(routeWrapperProblems([{ path: 'index.ts', text: ok }])).toEqual([])
  expect(routeWrapperProblems([{ path: 'index.ts', text: innermost }])).not.toEqual([])
  expect(routeWrapperProblems([{ path: 'index.ts', text: middle }])).not.toEqual([])
  expect(routeWrapperProblems([{ path: 'index.ts', text: swapped }])).not.toEqual([])
  expect(routeWrapperProblems([])).not.toEqual([])

  const files = sourcesIn(MAIN, MAIN)
  expect(files.some((file) => file.path === 'index.ts')).toBe(true)
  expect(routeWrapperProblems(files)).toEqual([])
})

/** The `{ … }` that starts at the first `{` at or after `from`, through its matching `}`. */
function blockFrom(text: string, from: number): { start: number; end: number } | null {
  const start = text.indexOf('{', from)
  if (start < 0) return null
  let depth = 0
  for (let at = start; at < text.length; at += 1) {
    if (text[at] === '{') depth += 1
    else if (text[at] === '}') {
      depth -= 1
      if (depth === 0) return { start, end: at }
    }
  }
  return null
}

/** Whether `at` is inside a block opened by `keyword {` (try, finally, catch) in `text`. */
function insideBlockOf(text: string, at: number, keyword: RegExp): boolean {
  for (const match of text.matchAll(keyword)) {
    const block = blockFrom(text, match.index)
    if (block !== null && block.start < at && at < block.end) return true
  }
  return false
}

/** Whether what follows the block that holds `at` is a `catch` or a `finally`. */
function tryIsHandled(text: string, at: number): boolean {
  for (const match of text.matchAll(/\btry\s*\{/gu)) {
    const block = blockFrom(text, match.index)
    if (block !== null && block.start < at && at < block.end) {
      return /^\s*(?:catch\b|finally\b)/u.test(text.slice(block.end + 1))
    }
  }
  return false
}

/**
 * What is wrong with the callback of `outcome.then(…)` that writes the sandbox's lines: the
 * notice that its state changed (`sandboxRoutes.changed()`) must go out even when working out the
 * helper paths throws, so it comes before that, or that sits in a try that is handled, or the notice
 * sits in a `finally`.
 */
function sandboxNoticeProblems(text: string): string[] {
  const then = text.search(/\.outcome\s*\.then\s*\(/u)
  if (then < 0) return ['no .outcome.then(…) callback']
  const body = insideParens(text, text.indexOf('(', text.indexOf('.then', then)))
  const notice = body.indexOf('sandboxRoutes.changed(')
  if (notice < 0) return ['the callback does not send the notice']
  const helpers = body.indexOf('helperPaths(')
  if (helpers < 0 || notice < helpers) return []
  if (tryIsHandled(body, helpers)) return []
  if (insideBlockOf(body, notice, /\bfinally\s*\{/gu)) return []
  return ['the notice comes after helperPaths(), which may throw']
}

const callback = (inner: string): string =>
  `void host.sandbox.start().outcome.then((outcome) => {\n${inner}\n})`

it('error-logs 验收 17: 复现 the sandbox’s change notice goes out even when the helper paths cannot be worked out', () => {
  const write = "appLog.write('info', { event: 'sandbox.helpers', ...helperPaths() })"
  const posture = "appLog.write('info', { event: 'sandbox.posture', state: outcome.state })"
  // The notice after the call that may throw: held back.
  expect(
    sandboxNoticeProblems(callback(`${posture}\n${write}\nsandboxRoutes.changed()`)),
  ).not.toEqual([])
  // Each way of not being held back.
  expect(sandboxNoticeProblems(callback(`${posture}\nsandboxRoutes.changed()\n${write}`))).toEqual(
    [],
  )
  expect(
    sandboxNoticeProblems(
      callback(`${posture}\ntry { ${write} } catch { /* a line less */ }\nsandboxRoutes.changed()`),
    ),
  ).toEqual([])
  expect(
    sandboxNoticeProblems(callback(`try { ${write} } finally { sandboxRoutes.changed() }`)),
  ).toEqual([])
  expect(
    sandboxNoticeProblems(
      callback(`${posture}\nappLog.write('info', helpers)\nsandboxRoutes.changed()`),
    ),
  ).toEqual([])
  // No notice at all, and no callback at all.
  expect(sandboxNoticeProblems(callback(`${posture}\n${write}`))).not.toEqual([])
  expect(sandboxNoticeProblems('const x = 1')).not.toEqual([])

  const index = sourcesIn(MAIN, MAIN).find((file) => file.path === 'index.ts')
  expect(index).toBeDefined()
  expect(sandboxNoticeProblems(index?.text ?? '')).toEqual([])
})
