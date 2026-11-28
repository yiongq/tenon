/**
 * Two rules the spec has a test guard by scanning the main process's source
 * (docs/features/error-logs/spec.md §一直要成立的规矩 第 2、5、6 条; acceptance 3's "every
 * registration point" rests on the second):
 *
 *   1. only `log/` and `mcp/log-sink.ts` write under the profile's `logs/` folder: no other file
 *      names the app log's files, or names the folder while it can write files itself; and
 *      nothing sets the log path of Electron's own (`app.setAppLogsPath`, `getPath('logs')`, D17);
 *   2. the one `HostSecrets` is built in `host/index.ts` and nowhere else in the main process:
 *      `new KeychainSecrets` and `new MemorySecrets` appear in that file only.
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
