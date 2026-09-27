/**
 * Read, Glob and Grep (spec 02 §内置工具与参数「Read」「Glob、Grep」; plan step 18): the executors, on
 * the memory host. Read keeps every result under the spill threshold by whole lines (open question
 * 24); Glob sorts by code unit and follows no link that leads outside the workspace; Grep's modes;
 * both walks skip the protected list (§内置工具的默认档位; plan step 11: 旧 159).
 */
import { describe, expect, it } from 'vitest'
import { absolutePath, createMemoryHost } from '../../src/index.js'
import type { AbsolutePath, MemoryHost } from '../../src/index.js'
import { SPILL_THRESHOLD_CHARS } from '../../src/loop/spill.js'
import { fill } from '../../src/prompts/index.js'
import { globToRegExp } from '../../src/tools/builtin/files.js'
import { GLOB_RESULT_LIMIT, GLOB_TEXTS, globExecutor } from '../../src/tools/builtin/glob.js'
import { GREP_TEXTS, grepExecutor } from '../../src/tools/builtin/grep.js'
import { READ_TEXTS, readExecutor, readResult } from '../../src/tools/builtin/read.js'
import { BUILTIN_SERVER_ID } from '../../src/tools/registry.js'
import type { ExecuteQuery, ToolExecution, ToolExecutor } from '../../src/tools/executor.js'
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.js'
import type { PathScope } from '../../src/permission/workspace.js'

const WS = absolutePath('/ws')

/** The scope most cases walk in: one root, a profile directory well away from it. */
const SCOPE: PathScope = {
  roots: [WS],
  profileDir: absolutePath('/tenon/prof'),
  ownSpillDir: absolutePath('/tenon/prof/tool-output/s1'),
  protectedFiles: [],
}

async function hostWith(files: Record<string, string>): Promise<MemoryHost> {
  const host = createMemoryHost()
  await host.fs.mkdirp(WS)
  for (const [path, text] of Object.entries(files)) {
    const at = absolutePath(path)
    // oxlint-disable-next-line no-await-in-loop -- the folder before the file in it
    await host.fs.mkdirp(absolutePath(at.slice(0, at.lastIndexOf('/')) || '/'))
    // oxlint-disable-next-line no-await-in-loop -- one file at a time
    await host.fs.writeFile(at, text)
  }
  return host
}

function run(
  executor: ToolExecutor,
  host: MemoryHost,
  name: 'Read' | 'Glob' | 'Grep',
  input: Record<string, unknown>,
  target: AbsolutePath,
  signal: AbortSignal = new AbortController().signal,
  scope: PathScope = SCOPE,
): Promise<ToolExecution> {
  const q: ExecuteQuery = {
    item: {
      source: 'builtin',
      serverId: BUILTIN_SERVER_ID,
      originalName: name,
      name,
      spec: BUILTIN_TOOLS[name].spec({ domainFilter: false }),
      requiresUserInteraction: false,
    },
    input,
    signal,
    target,
    scope,
    fs: host.fs,
  }
  return executor(q)
}

function textOf(execution: ToolExecution): string {
  return execution.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

/** The file's lines back from a numbered Read result, the closing sentence left out. */
function linesBack(text: string): string[] {
  return text
    .split('\n\n')[0]
    ?.split('\n')
    .map((line) => line.slice(line.indexOf('\t') + 1)) as string[]
}

describe('Read keeps each result under the threshold, by whole lines (open question 24)', () => {
  it('reads a 100 000-character file in parts that join back into it', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${String(i + 1)} `.padEnd(50, 'x'))
    const content = `${lines.join('\n')}\n`
    expect(content.length).toBeGreaterThan(100_000)
    const back: string[] = []
    let offset = 1
    for (let parts = 0; parts < 20; parts += 1) {
      const result = readResult(content, offset, null)
      expect(result.text.length).toBeLessThanOrEqual(SPILL_THRESHOLD_CHARS)
      back.push(...linesBack(result.text))
      const next = /offset (\d+) to read the next part/.exec(result.text)
      if (next === null) break
      expect(result.text).toContain(`of ${String(lines.length)}`)
      offset = Number(next[1])
    }
    expect(back).toEqual(lines)
  })

  it('gives the first part of a line too long for one result, and the next offset after it', () => {
    // A surrogate pair straddles the cut: it is never split.
    const long = `${'a'.repeat(SPILL_THRESHOLD_CHARS - 400)}😀${'b'.repeat(50_000)}`
    const result = readResult(`${long}\nsecond\n`, 1, null)
    expect(result.text.length).toBeLessThanOrEqual(SPILL_THRESHOLD_CHARS)
    const shown = linesBack(result.text)[0] ?? ''
    expect(long.startsWith(shown)).toBe(true)
    expect(/[\uD800-\uDBFF]$/.test(shown)).toBe(false)
    expect(result.text).toContain('Line 1 of 2 is too long')
    expect(result.text).toContain('The next part starts at offset 2.')
    expect(readResult(`${long}\nsecond\n`, 2, null).text).toBe('2\tsecond')
  })

  it('adds no closing sentence when it stops at the limit, before the end of the file', () => {
    const result = readResult('a\nb\nc\nd\n', 2, 2)
    expect(result).toEqual({ text: '2\tb\n3\tc', isError: false })
  })

  it('answers an empty file, an offset past the end, and failures of the target', async () => {
    expect(readResult('', 1, null)).toEqual({ text: READ_TEXTS.empty, isError: false })
    expect(readResult('one\n', 3, null)).toEqual({
      text: fill(READ_TEXTS.pastEnd, { total: '1', offset: '3' }),
      isError: true,
    })
    const host = await hostWith({ '/ws/bin': 'a\0b' })
    const missing = await run(readExecutor, host, 'Read', {}, absolutePath('/ws/none'))
    expect(missing).toMatchObject({ isError: true, state: 'completed' })
    expect(textOf(missing)).toBe(fill(READ_TEXTS.notFound, { path: '/ws/none' }))
    expect(textOf(await run(readExecutor, host, 'Read', {}, WS))).toBe(
      fill(READ_TEXTS.isDirectory, { path: '/ws' }),
    )
    expect(textOf(await run(readExecutor, host, 'Read', {}, absolutePath('/ws/bin')))).toBe(
      fill(READ_TEXTS.notText, { path: '/ws/bin' }),
    )
  })

  it('stops between two reads once the stop signal is set, as aborted', async () => {
    const host = await hostWith({ '/ws/a.txt': 'x\n' })
    const stop = new AbortController()
    stop.abort()
    const result = await run(readExecutor, host, 'Read', {}, absolutePath('/ws/a.txt'), stop.signal)
    expect(result.state).toBe('aborted')
  })
})

describe('Glob', () => {
  it('sorts by path in code units and matches `*` within one folder', async () => {
    const host = await hostWith({
      '/ws/b.ts': '',
      '/ws/B.ts': '',
      '/ws/a.md': '',
      '/ws/src/c.ts': '',
      '/ws/src/deep/d.ts': '',
    })
    const top = await run(globExecutor, host, 'Glob', { pattern: '*.ts' }, WS)
    expect(textOf(top)).toBe('/ws/B.ts\n/ws/b.ts')
    const all = await run(globExecutor, host, 'Glob', { pattern: '**/*.ts' }, WS)
    expect(textOf(all).split('\n')).toEqual([
      '/ws/B.ts',
      '/ws/b.ts',
      '/ws/src/c.ts',
      '/ws/src/deep/d.ts',
    ])
    expect(textOf(await run(globExecutor, host, 'Glob', { pattern: '*.py' }, WS))).toBe(
      GLOB_TEXTS.none,
    )
  })

  it('follows a link inside the workspace, and not one that leads outside it', async () => {
    const host = await hostWith({ '/ws/src/a.ts': '', '/outside/secret.ts': '' })
    host.symlink(absolutePath('/ws/out'), '/outside')
    host.symlink(absolutePath('/ws/alias'), '/ws/src')
    host.symlink(absolutePath('/ws/loop'), '/ws')
    const all = await run(globExecutor, host, 'Glob', { pattern: '**/*.ts' }, WS)
    // The link into the workspace is walked like a folder; the loop back to /ws is not.
    expect(textOf(all).split('\n')).toEqual(['/ws/alias/a.ts', '/ws/src/a.ts'])
  })

  it('says a path that is not a folder failed, and caps a long answer with a note', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < GLOB_RESULT_LIMIT + 5; i += 1)
      files[`/ws/f${String(i).padStart(5, '0')}`] = ''
    const host = await hostWith(files)
    const capped = textOf(await run(globExecutor, host, 'Glob', { pattern: 'f*' }, WS))
    expect(capped.split('\n\n')[0]?.split('\n')).toHaveLength(GLOB_RESULT_LIMIT)
    expect(capped).toContain(fill(GLOB_TEXTS.over, { limit: String(GLOB_RESULT_LIMIT) }))
    const file = await run(globExecutor, host, 'Glob', { pattern: '*' }, absolutePath('/ws/f00000'))
    expect(file.isError).toBe(true)
    expect(textOf(file)).toBe(fill(GLOB_TEXTS.notDirectory, { path: '/ws/f00000' }))
  })

  it('reads the dialect it documents', () => {
    expect(globToRegExp('src/**/test_*.py').test('src/a/b/test_x.py')).toBe(true)
    expect(globToRegExp('src/**/test_*.py').test('src/test_x.py')).toBe(true)
    expect(globToRegExp('*.{ts,tsx}').test('a.tsx')).toBe(true)
    expect(globToRegExp('[!a]?.md').test('bc.md')).toBe(true)
    expect(globToRegExp('[!a]?.md').test('ac.md')).toBe(false)
    expect(globToRegExp('a.b').test('axb')).toBe(false)
  })
})

describe('Grep', () => {
  const FILES = {
    '/ws/a.ts': 'const alpha = 1\nconst beta = 2\n// Alpha again\n',
    '/ws/b.py': 'alpha = 3\n',
    '/ws/sub/c.ts': 'nothing here\n',
    '/ws/bin.dat': 'alpha\0binary',
  }

  it('lists the matching files by default, skipping what is not text', async () => {
    const host = await hostWith(FILES)
    const result = await run(grepExecutor, host, 'Grep', { pattern: 'alpha' }, WS)
    expect(textOf(result)).toBe('/ws/a.ts\n/ws/b.py')
  })

  it('shows lines with numbers, context and case folding in content mode', async () => {
    const host = await hostWith(FILES)
    const content = await run(
      grepExecutor,
      host,
      'Grep',
      { pattern: 'alpha', output_mode: 'content', '-i': true, glob: '*.ts' },
      WS,
    )
    expect(textOf(content)).toBe('/ws/a.ts:1:const alpha = 1\n/ws/a.ts:3:// Alpha again')
    const around = await run(
      grepExecutor,
      host,
      'Grep',
      { pattern: 'beta', output_mode: 'content', '-C': 1, '-n': false },
      absolutePath('/ws/a.ts'),
    )
    expect(textOf(around)).toBe(
      '/ws/a.ts-const alpha = 1\n/ws/a.ts:const beta = 2\n/ws/a.ts-// Alpha again',
    )
  })

  it('counts, filters by type, and matches across lines when asked', async () => {
    const host = await hostWith(FILES)
    const counted = await run(
      grepExecutor,
      host,
      'Grep',
      { pattern: 'a', output_mode: 'count', type: 'py' },
      WS,
    )
    expect(textOf(counted)).toBe('/ws/b.py:1')
    const across = await run(
      grepExecutor,
      host,
      'Grep',
      { pattern: 'alpha.*beta', multiline: true, output_mode: 'content' },
      WS,
    )
    expect(textOf(across)).toBe('/ws/a.ts:1:const alpha = 1\n/ws/a.ts:2:const beta = 2')
  })

  it('pages with head_limit and offset, and says where the rest starts', async () => {
    const host = await hostWith({ '/ws/n.txt': 'x\nx\nx\nx\nx\n' })
    const paged = await run(
      grepExecutor,
      host,
      'Grep',
      { pattern: 'x', output_mode: 'content', head_limit: 2, offset: 1 },
      WS,
    )
    expect(textOf(paged)).toBe(
      `/ws/n.txt:2:x\n/ws/n.txt:3:x\n\n${fill(GREP_TEXTS.more, { from: '2', to: '3', total: '5', next: '3' })}`,
    )
  })

  it('answers a bad pattern, an unknown type and no match without a search', async () => {
    const host = await hostWith(FILES)
    const bad = await run(grepExecutor, host, 'Grep', { pattern: '(' }, WS)
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toMatch(/^The pattern is not a regular expression Grep can use: /)
    const type = await run(grepExecutor, host, 'Grep', { pattern: 'a', type: 'cobol' }, WS)
    expect(textOf(type)).toBe(fill(GREP_TEXTS.unknownType, { type: 'cobol' }))
    expect(textOf(await run(grepExecutor, host, 'Grep', { pattern: 'zzz' }, WS))).toBe(
      GREP_TEXTS.none,
    )
  })
})

describe('the walks skip the protected list (§内置工具的默认档位「Glob、Grep 的遍历」; 旧 159)', () => {
  // The workspace is the home folder: it holds the profile directory — this session's spill, another
  // session's, the config — and a shell file, and a project with a link to that shell file.
  const HOME = absolutePath('/home/u')
  const PROFILE = absolutePath('/home/u/prof')
  const HOME_SCOPE: PathScope = {
    roots: [HOME],
    profileDir: PROFILE,
    ownSpillDir: absolutePath('/home/u/prof/tool-output/s1'),
    protectedFiles: [absolutePath('/home/u/.zshrc')],
  }
  const HOME_FILES = {
    '/home/u/.zshrc': 'export TOKEN=SECRET-rc\n',
    '/home/u/prof/config.json': '{"token":"SECRET-config"}\n',
    '/home/u/prof/logs/main.log': 'SECRET-log\n',
    '/home/u/prof/tool-output/s2/r-1-0.txt': 'other session SECRET-spill\n',
    '/home/u/prof/tool-output/s1/r-1-0.txt': 'own SECRET-own\n',
    '/home/u/proj/a.ts': 'const x = "SECRET-ws"\n',
  }

  async function homeHost(): Promise<MemoryHost> {
    const host = await hostWith(HOME_FILES)
    host.symlink(absolutePath('/home/u/proj/rc'), '/home/u/.zshrc')
    host.symlink(absolutePath('/home/u/proj/other'), '/home/u/prof/tool-output/s2')
    return host
  }

  it('Grep finds no line of the config, the other spill, the logs or the shell file, and does not fail', async () => {
    const host = await homeHost()
    const grep = (pattern: string): Promise<ToolExecution> =>
      run(
        grepExecutor,
        host,
        'Grep',
        { pattern, output_mode: 'content' },
        HOME,
        undefined,
        HOME_SCOPE,
      )
    // A string only config.json holds: 0 hits, no error (旧 159).
    const config = await grep('SECRET-config')
    expect(config).toMatchObject({ isError: false, state: 'completed' })
    expect(textOf(config)).toBe(GREP_TEXTS.none)
    // Every secret: only the workspace file and this session's own spill answer — the link to the
    // shell file and the link to the other session's spill are skipped as their targets are.
    expect(textOf(await grep('SECRET')).split('\n')).toEqual([
      '/home/u/prof/tool-output/s1/r-1-0.txt:1:own SECRET-own',
      '/home/u/proj/a.ts:1:const x = "SECRET-ws"',
    ])
  })

  it('Glob under the profile directory lists only this session’s spill directory', async () => {
    const host = await homeHost()
    const glob = await run(
      globExecutor,
      host,
      'Glob',
      { pattern: '**' },
      HOME,
      undefined,
      HOME_SCOPE,
    )
    expect(glob.isError).toBe(false)
    expect(textOf(glob).split('\n')).toEqual([
      '/home/u/prof/tool-output/s1/r-1-0.txt',
      '/home/u/proj/a.ts',
    ])
    // Walked from the spill directory itself, it is all there.
    const own = await run(
      globExecutor,
      host,
      'Glob',
      { pattern: '*' },
      absolutePath('/home/u/prof/tool-output/s1'),
      undefined,
      HOME_SCOPE,
    )
    expect(textOf(own)).toBe('/home/u/prof/tool-output/s1/r-1-0.txt')
  })
})
