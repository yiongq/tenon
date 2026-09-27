/**
 * Read, Glob and Grep (spec 02 §内置工具与参数「Read」「Glob、Grep」; plan step 18): the executors, on
 * the memory host. Read keeps every result under the spill threshold by whole lines (open question
 * 24); Glob sorts by code unit and follows no link that leads outside the workspace; Grep's modes,
 * and its engine (plan step 22): ripgrep's dialect, in time linear in the text, the program capped
 * (adv-3), a line's work and a call's time bounded, the event loop given its turns (s18-safety-2);
 * both walks skip the protected list (§内置工具的默认档位; plan step 11: 旧 159).
 */
import { RE2JS } from 're2js'
import { describe, expect, it, vi } from 'vitest'
import { absolutePath, createMemoryHost } from '../../src/index.js'
import type { AbsolutePath, HostClock, MemoryHost } from '../../src/index.js'
import { SPILL_THRESHOLD_CHARS } from '../../src/loop/spill.js'
import { fill } from '../../src/prompts/index.js'
import { globMatcher } from '../../src/tools/builtin/files.js'
import { GLOB_RESULT_LIMIT, GLOB_TEXTS, globExecutor } from '../../src/tools/builtin/glob.js'
import {
  GREP_HEAD_LIMIT,
  GREP_LINE_WORK_MAX,
  GREP_TEXTS,
  GREP_TIME_BUDGET_MS,
  entriesOf,
  grepExecutor,
  grepMeter,
} from '../../src/tools/builtin/grep.js'
import type { GrepOptions, GrepPage } from '../../src/tools/builtin/grep.js'
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
  clock: HostClock = host.clock,
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
    clock,
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
    // Where a plain line is cut, for a file of the same number of lines.
    const plain = readResult(`${'a'.repeat(SPILL_THRESHOLD_CHARS)}\nsecond\n`, 1, null)
    const cut = (linesBack(plain.text)[0] ?? '').length
    // A surrogate pair straddles that cut, its high half the last character that fits: never split.
    const long = `${'a'.repeat(cut - 1)}😀${'b'.repeat(50_000)}`
    const result = readResult(`${long}\nsecond\n`, 1, null)
    expect(result.text.length).toBeLessThanOrEqual(SPILL_THRESHOLD_CHARS)
    const shown = linesBack(result.text)[0] ?? ''
    expect(shown).toBe('a'.repeat(cut - 1))
    expect(result.text).toContain(`only its first ${String(cut - 1)} characters are shown`)
    expect(result.text).toContain('Line 1 of 2 is too long')
    expect(result.text).toContain('The next part starts at offset 2.')
    expect(readResult(`${long}\nsecond\n`, 2, null).text).toBe('2\tsecond')
  })

  it('names the next part after a cut line even when the limit ends on it, and none after the last line', () => {
    // §内置工具与参数「Read」「下一段从 N+1 起」: the exemption at `offset + limit - 1` is the ordinary
    // closing sentence's, not the cut line's.
    const long = 'a'.repeat(50_000)
    const limited = readResult(`${long}\nsecond\nthird\n`, 1, 1)
    expect(limited.text.length).toBeLessThanOrEqual(SPILL_THRESHOLD_CHARS)
    expect(limited.text).toContain('Line 1 of 3 is too long')
    expect(limited.text).toContain('The next part starts at offset 2.')
    const last = readResult(`first\n${long}\n`, 2, 1)
    expect(last.text).toContain('Line 2 of 2 is too long')
    expect(last.text).not.toContain('offset')
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

  it('sorts the whole walk by path, not folder by folder', async () => {
    // Folder by folder, a/b.ts comes before a-c.ts; by code unit '-' (0x2d) is before '/' (0x2f).
    const host = await hostWith({ '/ws/a/b.ts': '', '/ws/a-c.ts': '' })
    const all = await run(globExecutor, host, 'Glob', { pattern: '**/*.ts' }, WS)
    expect(textOf(all).split('\n')).toEqual(['/ws/a-c.ts', '/ws/a/b.ts'])
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
    // Exactly the limit is not "more than" it: every path, and no note.
    const exact = textOf(await run(globExecutor, host, 'Glob', { pattern: 'f00*' }, WS))
    expect(exact).toBe(
      Array.from(
        { length: GLOB_RESULT_LIMIT },
        (_, i) => `/ws/f${String(i).padStart(5, '0')}`,
      ).join('\n'),
    )
    const file = await run(globExecutor, host, 'Glob', { pattern: '*' }, absolutePath('/ws/f00000'))
    expect(file.isError).toBe(true)
    expect(textOf(file)).toBe(fill(GLOB_TEXTS.notDirectory, { path: '/ws/f00000' }))
  })

  it('reads the dialect it documents', () => {
    expect(globMatcher('src/**/test_*.py').test('src/a/b/test_x.py')).toBe(true)
    expect(globMatcher('src/**/test_*.py').test('src/test_x.py')).toBe(true)
    expect(globMatcher('*.{ts,tsx}').test('a.tsx')).toBe(true)
    expect(globMatcher('[!a]?.md').test('bc.md')).toBe(true)
    expect(globMatcher('[!a]?.md').test('ac.md')).toBe(false)
    expect(globMatcher('a.b').test('axb')).toBe(false)
    // `?` is one character, a surrogate pair included; a bad class fails as the pattern.
    expect(globMatcher('?.md').test('😀.md')).toBe(true)
    expect(() => globMatcher('[z-a]')).toThrow(SyntaxError)
  })

  it('matches in time linear in the path, so a pattern cannot hold the process (§内置工具与参数)', async () => {
    // As a backtracking regular expression this took seconds on one name, and no stop can land
    // inside a match: the main process serves every window meanwhile.
    const host = await hostWith({ [`/ws/${'a'.repeat(60)}`]: '' })
    const started = performance.now()
    const glob = await run(globExecutor, host, 'Glob', { pattern: '*a*a*a*a*a*a*a*a*a*b' }, WS)
    expect(textOf(glob)).toBe(GLOB_TEXTS.none)
    expect(globMatcher('*a*a*a*a*a*a*a*a*a*b').test(`${'a'.repeat(5000)}b`)).toBe(true)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

/** Grep's answer to a pattern it turns down for `message`. */
function invalidBecause(message: string): string {
  return fill(GREP_TEXTS.invalidPattern, { message })
}

/** Grep's options as its executor reads them from a call: content mode, the defaults otherwise. */
function grepOptions(o: Partial<GrepOptions>): GrepOptions {
  return {
    mode: 'content',
    lineNumbers: true,
    onlyMatching: false,
    before: 0,
    after: 0,
    multiline: false,
    headLimit: GREP_HEAD_LIMIT,
    offset: 0,
    ...o,
  }
}

/**
 * A clock `step` ms on at every reading, whose timers run on the real event loop, each a turn
 * counted and `onTurn` called first.
 */
function turnsOf(
  step: number,
  onTurn: () => void = () => {},
): {
  clock: HostClock
  turns: () => number
} {
  let now = 0
  let turns = 0
  const clock: HostClock = {
    now: () => (now += step),
    setTimeout: (fn, ms) => {
      const timer = setTimeout(() => {
        turns += 1
        onTurn()
        fn()
      }, ms)
      return () => clearTimeout(timer)
    },
  }
  return { clock, turns: () => turns }
}

/** `run`'s last three arguments for a call on a clock `step` ms on at every reading. */
function onClock(step: number): [AbortSignal, PathScope, HostClock] {
  return [new AbortController().signal, SCOPE, turnsOf(step).clock]
}

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

  it('never shows half a surrogate pair, a pattern of one lone surrogate included', async () => {
    // `.` is a whole character (§内置工具与参数「正则方言跟 ripgrep」; a lone surrogate would replay
    // in every request).
    const host = await hostWith({ '/ws/a.json': '{"t": "a😀b"}\n', '/ws/e.txt': '😀😀\n' })
    const cut = await run(
      grepExecutor,
      host,
      'Grep',
      { pattern: '\\"t\\": \\".{0,2}', output_mode: 'content', '-o': true },
      absolutePath('/ws/a.json'),
    )
    expect(textOf(cut)).toBe('/ws/a.json:1:"t": "a😀')
    expect(textOf(cut).isWellFormed()).toBe(true)
    // re2js finds a lone surrogate by its literal, inside a pair: a match on the low half gets the
    // high half back, one on the high half its low half, and a character is shown once.
    for (const half of ['\\x{DE00}', '\\x{D83D}']) {
      // oxlint-disable-next-line no-await-in-loop -- one pattern at a time
      const halves = await run(
        grepExecutor,
        host,
        'Grep',
        { pattern: half, output_mode: 'content', '-o': true, multiline: true },
        absolutePath('/ws/e.txt'),
      )
      expect(textOf(halves)).toBe('/ws/e.txt:1:😀\n/ws/e.txt:1:😀')
    }
    const each = await run(
      grepExecutor,
      host,
      'Grep',
      { pattern: '\\"|.', output_mode: 'content', '-o': true },
      absolutePath('/ws/e.txt'),
    )
    expect(textOf(each)).toBe('/ws/e.txt:1:😀\n/ws/e.txt:1:😀')
  })

  it('pages one long file, and still counts the rest for the note', async () => {
    const big = 'x\n'.repeat(100_000)
    const host = await hostWith({ '/ws/big.txt': big, '/ws/small.txt': 'x\n' })
    const paged = await run(
      grepExecutor,
      host,
      'Grep',
      { pattern: '.', output_mode: 'content', offset: 99_999 },
      WS,
    )
    expect(paged).toMatchObject({ isError: false, state: 'completed' })
    expect(textOf(paged)).toBe(`/ws/big.txt:100000:x\n/ws/small.txt:1:x`)
    const first = await run(
      grepExecutor,
      host,
      'Grep',
      { pattern: '.', output_mode: 'content' },
      WS,
    )
    const [shown, note] = textOf(first).split('\n\n')
    expect(shown?.split('\n')).toHaveLength(GREP_HEAD_LIMIT)
    expect(note).toBe(
      fill(GREP_TEXTS.more, {
        from: '1',
        to: String(GREP_HEAD_LIMIT),
        total: '100001',
        next: String(GREP_HEAD_LIMIT),
      }),
    )
  })

  it('fills the page from the first lines of a long file, and only counts the rest', async () => {
    // s18-safety-3: one file's lines, hits and entry strings were all built before the page was
    // applied — a 64 MiB file of short lines is millions of each. Now an entry is built only on the
    // page, and the page is full once the pattern has run over the lines it needed, not the file.
    const text = Array.from({ length: 100_000 }, (_, i) => (i % 10 === 0 ? 'x' : 'y')).join('\n')
    // Every entry but a `--` is built around its path: the entry strings built, counted.
    let built = 0
    const path = {
      toString: () => {
        built += 1
        return '/ws/long.txt'
      },
    } as unknown as AbsolutePath
    // The pattern runs once a line, and once more a match where the match is shown: a few hundred
    // fill the page, and only a count reads the whole file first — 110 000 runs — to build its one
    // entry.
    for (const [o, total, runsToFill] of [
      // Every tenth line matches: groups of five lines, the first of three, set apart by `--`.
      [grepOptions({ before: 2, after: 2 }), 3 + 9999 * 6, 1000],
      [grepOptions({ onlyMatching: true, multiline: true }), 10_000, 1000],
      [grepOptions({ mode: 'count' }), 1, 110_000],
    ] as const) {
      const found: GrepPage = { offset: 0, end: GREP_HEAD_LIMIT, kept: [], total: 0 }
      built = 0
      let runs = 0
      const counted =
        <A extends unknown[], R>(search: (...args: A) => R) =>
        (...args: A): R => {
          if (found.kept.length < GREP_HEAD_LIMIT) runs += 1
          return search(...args)
        }
      const regex = RE2JS.compile('x', o.multiline ? RE2JS.DOTALL | RE2JS.MULTILINE : 0)
      regex.test = counted(regex.test.bind(regex))
      const matcherOf = regex.matcher.bind(regex)
      regex.matcher = (input) => {
        const matcher = matcherOf(input)
        matcher.find = counted(matcher.find.bind(matcher))
        return matcher
      }
      const meter = grepMeter(createMemoryHost().clock, new AbortController().signal, 3)
      expect(regex.programSize()).toBe(3)
      // oxlint-disable-next-line no-await-in-loop -- one set of options at a time
      await entriesOf(found, path, text, regex, o, meter)
      expect(found.total).toBe(total)
      expect(found.kept).toHaveLength(Math.min(total, GREP_HEAD_LIMIT))
      expect(built).toBeLessThanOrEqual(found.kept.length)
      expect(runs).toBeLessThanOrEqual(runsToFill)
    }
  })

  it("reads ripgrep's dialect: inline flags, Unicode classes, and multiline ^ and $ at each line", async () => {
    const host = await hostWith({ ...FILES, '/ws/u.txt': 'héllo 日本 12\nαβγ abc\n' })
    const grep = async (input: Record<string, unknown>): Promise<string> =>
      textOf(await run(grepExecutor, host, 'Grep', { output_mode: 'content', ...input }, WS))
    // An inline flag, as ripgrep and RE2 read it: no JavaScript RegExp has `(?i)`.
    expect(await grep({ pattern: '(?i)ALPHA' })).toBe(
      '/ws/a.ts:1:const alpha = 1\n/ws/a.ts:3:// Alpha again\n/ws/b.py:1:alpha = 3',
    )
    // Unicode classes, a general category and a script by its bare name, each a whole character.
    expect(await grep({ pattern: '\\p{L}+', '-o': true, glob: '*.txt' })).toBe(
      '/ws/u.txt:1:héllo\n/ws/u.txt:1:日本\n/ws/u.txt:2:αβγ\n/ws/u.txt:2:abc',
    )
    expect(await grep({ pattern: '\\p{Greek}+', '-o': true })).toBe('/ws/u.txt:2:αβγ')
    // Multiline is `rg -U --multiline-dotall`: a match runs across lines, and `^` and `$` match at
    // each line's ends, not only the file's.
    expect(await grep({ pattern: '2$\\n^// Alpha', multiline: true })).toBe(
      '/ws/a.ts:2:const beta = 2\n/ws/a.ts:3:// Alpha again',
    )
  })

  it("turns down a backreference and look-around, in ripgrep's words", async () => {
    const host = await hostWith(FILES)
    const bad = async (pattern: string): Promise<ToolExecution> =>
      run(grepExecutor, host, 'Grep', { pattern }, WS)
    const backreference = await bad('(a)\\1')
    expect(backreference).toMatchObject({ isError: true, state: 'completed' })
    expect(textOf(backreference)).toBe(
      fill(GREP_TEXTS.invalidPattern, { message: GREP_TEXTS.backreference }),
    )
    // Look-ahead and look-behind alike; re2js alone would call the look-behind a bad group name.
    for (const pattern of ['alpha(?=\\s)', '(?<=const )alpha']) {
      // oxlint-disable-next-line no-await-in-loop -- one pattern at a time
      const lookaround = await bad(pattern)
      expect(lookaround.isError).toBe(true)
      expect(textOf(lookaround)).toBe(
        fill(GREP_TEXTS.invalidPattern, { message: GREP_TEXTS.lookaround }),
      )
    }
  })

  it("reads ripgrep's Perl classes as Unicode, in a class and outside one (plat-2, mut-6)", async () => {
    // ripgrep's \w, \d and \s are Unicode by default and RE2's are ASCII: before the rewrite, \w+
    // found `h` and `llo` in héllo and nothing in Chinese, and \d+ no fullwidth or Arabic-Indic digit.
    const host = await hostWith({
      '/ws/u.txt': [
        'user_name = zhang',
        '用户名称 = 张三',
        'héllo-x 日本',
        '价格１２３元 ١٢٣ 12',
        'a\u3000b\u00a0c',
      ].join('\n'),
    })
    const grep = async (input: Record<string, unknown>): Promise<string> =>
      textOf(await run(grepExecutor, host, 'Grep', { output_mode: 'content', ...input }, WS))
    expect(await grep({ pattern: '\\w+ =', '-o': true })).toBe(
      '/ws/u.txt:1:user_name =\n/ws/u.txt:2:用户名称 =',
    )
    expect(await grep({ pattern: '\\w+', '-o': true, '-n': false })).toBe(
      ['user_name', 'zhang', '用户名称', '张三', 'héllo', 'x', '日本']
        .concat(['价格１２３元', '١٢٣', '12', 'a', 'b', 'c'])
        .map((word) => `/ws/u.txt:${word}`)
        .join('\n'),
    )
    expect(await grep({ pattern: '\\d+', '-o': true })).toBe(
      '/ws/u.txt:4:１２３\n/ws/u.txt:4:١٢٣\n/ws/u.txt:4:12',
    )
    // U+3000, the ideographic space, and U+00A0, the no-break space, are both white space.
    expect(await grep({ pattern: 'a\\sb\\sc' })).toBe('/ws/u.txt:5:a\u3000b\u00a0c')
    // In a class as well: with the hyphen, and beside \W, which becomes an alternative to the rest.
    expect(await grep({ pattern: '[\\w-]+', '-o': true, '-n': false })).toContain(
      '/ws/u.txt:héllo-x\n/ws/u.txt:日本',
    )
    expect(await grep({ pattern: '[=\\W]{3}', '-o': true })).toBe(
      '/ws/u.txt:1: = \n/ws/u.txt:2: = ',
    )
    // A negated class stays negated, and the Perl classes' negations are Unicode too: rg 15.2's
    // answers, line by line.
    expect(await grep({ pattern: '[^a-z]+', '-o': true })).toBe(
      ['1:_', '1: = ', '2:用户名称 = 张三', '3:é', '3:-', '3: 日本', '4:价格１２３元 ١٢٣ 12']
        .concat(['5:\u3000', '5:\u00a0'])
        .map((part) => `/ws/u.txt:${part}`)
        .join('\n'),
    )
    const other = await hostWith({
      '/ws/v.txt': ['abc 日本 - x', 'ab ^^ cd', 'a\u3000b c', 'héllo 日本', '١٢٣x'].join('\n'),
    })
    const target = absolutePath('/ws/v.txt')
    const nonWord = ['1: ', '1: - ', '2: ^^ ', '3:\u3000', '3: ', '4: ']
    for (const [pattern, parts] of [
      // `\W` alone in a class, and beside a `^` that is no negation.
      ['[\\W]+', nonWord],
      ['[\\W^]+', nonWord],
      ['\\W+', nonWord],
      [
        '\\S+',
        ['1:abc', '1:日本', '1:-', '1:x', '2:ab', '2:^^', '2:cd', '3:a', '3:b', '3:c'].concat([
          '4:héllo',
          '4:日本',
          '5:١٢٣x',
        ]),
      ],
      ['\\D+', ['1:abc 日本 - x', '2:ab ^^ cd', '3:a\u3000b c', '4:héllo 日本', '5:x']],
    ] as const) {
      const input = { pattern, output_mode: 'content', '-o': true }
      // oxlint-disable-next-line no-await-in-loop -- one pattern at a time
      const found = textOf(await run(grepExecutor, other, 'Grep', input, target))
      expect(found).toBe(parts.map((part) => `/ws/v.txt:${part}`).join('\n'))
    }
    // re2js's reason for what it cannot parse quotes the pattern as written, not as rewritten.
    expect(await grep({ pattern: '(\\w' })).toBe(
      fill(GREP_TEXTS.invalidPattern, {
        message: 'error parsing regexp: missing closing ): `(\\w`',
      }),
    )
  })

  it('turns down what re2js would read otherwise than ripgrep, rather than misread it (plat-2)', async () => {
    const host = await hostWith({ '/ws/u.txt': 'user_name = 用户\n' })
    const refusal = async (pattern: string): Promise<string> => {
      const result = await run(grepExecutor, host, 'Grep', { pattern }, WS)
      expect(result).toMatchObject({ isError: true, state: 'completed' })
      return textOf(result)
    }
    // ripgrep's class set operations and nested classes, which re2js takes as literal characters:
    // `[\w&&\p{Han}]` alone found user_name and zhang too.
    for (const pattern of ['[\\w&&\\p{Han}]+', '[a-z--aeiou]', '[a~~b]', '[a[bc]]', '[--a]']) {
      // oxlint-disable-next-line no-await-in-loop -- one pattern at a time
      expect(await refusal(pattern)).toBe(invalidBecause(GREP_TEXTS.classSet))
    }
    // An escaped `&` and a POSIX class are no set operation.
    expect(textOf(await run(grepExecutor, host, 'Grep', { pattern: '[\\&&[:alpha:]]+' }, WS))).toBe(
      '/ws/u.txt',
    )
    expect(await refusal('[^\\W_]+')).toBe(invalidBecause(GREP_TEXTS.negatedNonWord))
    for (const pattern of ['\\<user', 'name\\>', '\\b{start}user']) {
      // oxlint-disable-next-line no-await-in-loop -- one pattern at a time
      expect(await refusal(pattern)).toBe(invalidBecause(GREP_TEXTS.wordBoundary))
    }
  })

  it('turns down a program over the cap, before compiling one far over it (adv-3)', async () => {
    const host = await hostWith({ '/ws/x.txt': `${'x'.repeat(10_000)}\n` })
    const tooLarge = fill(GREP_TEXTS.invalidPattern, { message: GREP_TEXTS.tooLarge })
    const grep = (pattern: string): Promise<ToolExecution> =>
      run(grepExecutor, host, 'Grep', { pattern, output_mode: 'content' }, WS)
    const compile = vi.spyOn(RE2JS, 'compile')
    try {
      // 4 002 instructions once compiled: over the cap, though its text is within ten times it.
      const over = await grep('\\w{1000}'.repeat(4))
      expect(over).toMatchObject({ isError: true, state: 'completed' })
      expect(textOf(over)).toBe(tooLarge)
      expect(compile).toHaveBeenCalledTimes(1)
      // adv-3's pattern: 994 characters and 142 002 instructions, which took 1.9 s over a 10 KB line.
      // Its text alone turns it down; re2js is not asked to compile it.
      compile.mockClear()
      expect(textOf(await grep('.{1000}'.repeat(142)))).toBe(tooLarge)
      expect(compile).not.toHaveBeenCalled()
      // The bound takes the larger count of `{n,m}`, and a group's contents with the group.
      for (const pattern of ['.{0,1000}'.repeat(20), '(?:.{1000})'.repeat(40)]) {
        // oxlint-disable-next-line no-await-in-loop -- one pattern at a time
        expect(textOf(await grep(pattern))).toBe(tooLarge)
        expect(compile).not.toHaveBeenCalled()
      }
    } finally {
      compile.mockRestore()
    }
  })

  it('stops at a line too long for its pattern, and takes the longest it allows within a second (s18-safety-2)', async () => {
    // Random `a` and `b`, on which re2js's DFA settles least: a line costs up to about 30 ns a
    // character an instruction, at every program size up to the cap.
    let seed = 1
    const ab = (n: number): string =>
      Array.from({ length: n }, () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed >> 16 < 0x4000 ? 'a' : 'b'
      }).join('')
    for (const [pattern, program] of [
      ['[ab]*a[ab]{300}c', 306],
      [`[ab]*a${'[ab]{996}'.repeat(3)}c`, 2994],
    ] as const) {
      expect(RE2JS.compile(pattern).programSize()).toBe(program)
      const longest = Math.floor(GREP_LINE_WORK_MAX / program)
      // oxlint-disable-next-line no-await-in-loop -- one pattern at a time, each timed
      const host = await hostWith({
        '/ws/x.txt': `short\n${ab(longest - 4)}bbbc\n`,
        '/ws/y.txt': `short\n${ab(longest - 3)}bbbc\n`,
      })
      for (const onlyMatching of [false, true]) {
        const input = { pattern, output_mode: 'content', '-o': onlyMatching }
        const started = performance.now()
        // oxlint-disable-next-line no-await-in-loop -- one mode at a time, each timed
        const taken = await run(grepExecutor, host, 'Grep', input, absolutePath('/ws/x.txt'))
        expect(performance.now() - started).toBeLessThan(1000)
        expect(taken).toMatchObject({ isError: false, state: 'completed' })
        // One character more, and the call stops before matching the line, which it names.
        // oxlint-disable-next-line no-await-in-loop -- one mode at a time
        const over = await run(grepExecutor, host, 'Grep', input, absolutePath('/ws/y.txt'))
        expect(over).toMatchObject({ isError: true, state: 'completed' })
        expect(textOf(over)).toBe(fill(GREP_TEXTS.tooLong, { where: '/ws/y.txt:2' }))
      }
    }
    // In multiline mode the whole file is one text, and the file is named: three instructions over
    // just more than a third of the bound in characters.
    const host = await hostWith({
      '/ws/m.txt': 'x\n'.repeat(Math.floor(GREP_LINE_WORK_MAX / 6) + 1),
    })
    const multiline = await run(grepExecutor, host, 'Grep', { pattern: 'y', multiline: true }, WS)
    expect(RE2JS.compile('y', RE2JS.DOTALL | RE2JS.MULTILINE).programSize()).toBe(3)
    expect(textOf(multiline)).toBe(fill(GREP_TEXTS.tooLong, { where: '/ws/m.txt' }))
    expect(textOf(await run(grepExecutor, host, 'Grep', { pattern: 'y' }, WS))).toBe(
      GREP_TEXTS.none,
    )
  })

  it('stops a call past its time budget, with what it had found (s18-safety-2)', async () => {
    const timeUp = fill(GREP_TEXTS.timeUp, { seconds: String(GREP_TIME_BUDGET_MS / 1000) })
    // The clock a second on at every reading. Between files: forty that each match, in path order.
    const names = Array.from({ length: 40 }, (_, i) => `/ws/f${String(i).padStart(2, '0')}.txt`)
    const many = await hostWith(Object.fromEntries(names.map((name) => [name, 'alpha\n'])))
    const files = await run(grepExecutor, many, 'Grep', { pattern: 'alpha' }, WS, ...onClock(1000))
    expect(files).toMatchObject({ isError: true, state: 'completed' })
    const [reason, found = ''] = textOf(files).split('\n\n')
    expect(reason).toBe(timeUp)
    const [heading, ...listed] = found.split('\n')
    expect(heading).toBe(GREP_TEXTS.foundBefore)
    expect(listed.length).toBeGreaterThan(5)
    expect(listed).toEqual(names.slice(0, listed.length))
    expect(listed.length).toBeLessThan(names.length)
    // Between lines: a thousand characters a line, about a million units of work, the clock read
    // before each. No line matches, so nothing goes with the reason.
    const lines = await hostWith({ '/ws/l.txt': `${'x'.repeat(1000)}\n`.repeat(100) })
    const target = absolutePath('/ws/l.txt')
    const inFile = await run(
      grepExecutor,
      lines,
      'Grep',
      { pattern: 'z.{997}' },
      target,
      ...onClock(1000),
    )
    expect(textOf(inFile)).toBe(timeUp)
    // Between the finds of `-o`: `a.*z|a` scans the rest of the line for every `a` it finds.
    const quadratic = await hostWith({ '/ws/q.txt': 'a'.repeat(5000) })
    const parts = await run(
      grepExecutor,
      quadratic,
      'Grep',
      { pattern: 'a.*z|a', output_mode: 'content', '-o': true, head_limit: 2 },
      absolutePath('/ws/q.txt'),
      ...onClock(1000),
    )
    expect(textOf(parts)).toBe(
      `${timeUp}\n\n${GREP_TEXTS.foundBefore}\n/ws/q.txt:1:a\n/ws/q.txt:1:a`,
    )
  })

  it('gives the event loop a turn every 50 ms of matching, and a stop lands there (s18-safety-2)', async () => {
    const host = await hostWith({ '/ws/l.txt': `${'x'.repeat(1000)}\n`.repeat(100) })
    const target = absolutePath('/ws/l.txt')
    const input = { pattern: 'z.{997}', output_mode: 'count' }
    // The clock 20 ms on at every reading, one before each line: a turn every few lines of the one
    // file, and the search runs to its end.
    const calm = turnsOf(20)
    const done = await run(grepExecutor, host, 'Grep', input, target, undefined, SCOPE, calm.clock)
    expect(done).toMatchObject({ isError: false, state: 'completed' })
    expect(textOf(done)).toBe(GREP_TEXTS.none)
    expect(calm.turns()).toBeGreaterThan(10)
    // A stop that comes in on the first turn ends the call there, in the middle of the file: aborted,
    // as between two reads.
    const stop = new AbortController()
    const stopping = turnsOf(20, () => stop.abort())
    const stopped = await run(
      grepExecutor,
      host,
      'Grep',
      input,
      target,
      stop.signal,
      SCOPE,
      stopping.clock,
    )
    expect(stopped).toEqual({ content: [], isError: true, state: 'aborted' })
    expect(stopping.turns()).toBe(1)
  })

  it('runs a pathological pattern over a 30 000-character line in bounded time (s18-safety-2)', async () => {
    // A backtracking RegExp takes exponential or high-polynomial time on each of these, and no stop
    // can land inside a match: the main process serves every window meanwhile. re2js is linear.
    // Nineteen `a`s spread over the line: `(.*a){20}` needs one more.
    const spread = `${'x'.repeat(1578)}a`.repeat(19).padEnd(30_000, 'x')
    const host = await hostWith({
      '/ws/a.txt': `${'a'.repeat(30_000)}!\n`,
      '/ws/x.txt': `${'x'.repeat(30_000)}\n`,
      '/ws/s.txt': `${spread}\n`,
    })
    for (const [pattern, file] of [
      ['(a+)+$', '/ws/a.txt'],
      ['(x+x+)+y', '/ws/x.txt'],
      ['(.*a){20}', '/ws/s.txt'],
    ] as const) {
      const started = performance.now()
      // oxlint-disable-next-line no-await-in-loop -- one pattern at a time, each timed
      const result = await run(
        grepExecutor,
        host,
        'Grep',
        { pattern, output_mode: 'content' },
        absolutePath(file),
      )
      expect(textOf(result)).toBe(GREP_TEXTS.none)
      expect(performance.now() - started).toBeLessThan(1000)
    }
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
