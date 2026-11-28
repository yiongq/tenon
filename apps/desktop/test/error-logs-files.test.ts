/**
 * The app log's files under stress and under attack (docs/features/error-logs/spec.md §怎么写 「怎么写」
 * 「运行标记」, §一直要成立的规矩 第 7 条, §限量; acceptance 1, 13, 16, 17): a rotation that cannot
 * rename, what is copied to the top of a new file, the development mirror, a file or folder that is
 * somebody else's, the old marker read back, and `close`.
 *
 * Real `createAppLog` on real temp folders, the files read back from disk. A case whose name says
 * 复现 reproduces a finding of the segment-1 review (the three reviews of 2026-11-28) and fails until
 * that finding is fixed; the others hold today and keep a number or a check from moving.
 *
 * Three fakes, each made to behave as the real thing in the few ways the cases lean on:
 *
 *   - `node:fs` is spied (`spy: true`, every call passes through) so that the owner a stat reports can
 *     be changed for one path, as an `uid` of another user would be if the test ran as root. It
 *     stands in for a real foreign file in these ways only: `fstatSync` of a descriptor opened on that
 *     path, and `lstatSync` or `statSync` of it, answer with the real Stats but a `uid` one higher,
 *     `isFile()`, `isDirectory()`, `nlink`, `size` and `mode` unchanged; every other path and
 *     descriptor is answered as it is. The folder's and the file's owner are made foreign one at a
 *     time, which `createAppLog`'s single `uid` option cannot do.
 *   - `writeSync`, while a case says the disk is full, throws what `write(2)` raises on a full disk
 *     (an Error whose `code` is `ENOSPC`) and writes nothing; while it does not, it is the real one.
 *   - the background writer of the FIFO case is a real `sh` that opens the FIFO for writing 1.5 s
 *     from now. It stands in for what ends a blocking `open(O_RDONLY)` of a FIFO in real life (a
 *     writer turning up): the case is not left hanging if the open blocks, and says so by how long
 *     the open took.
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import type * as FsModule from 'node:fs'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeTempRoot, openLog, readText, sweepTempRoots } from './support/error-logs.js'
import type { OpenedLog } from './support/error-logs.js'

vi.mock('node:fs', { spy: true })

const actual = await vi.importActual<typeof FsModule>('node:fs')

/** The paths whose owner is reported as somebody else's, and what each open descriptor was opened on. */
const foreign = { paths: new Set<string>() }
const disk = { full: false }
const opened = new Map<number, string>()

function asSomebodyElses(st: Stats): Stats {
  return Object.assign(Object.create(Object.getPrototypeOf(st)) as Stats, st, { uid: st.uid + 1 })
}

beforeAll(() => {
  vi.mocked(openSync).mockImplementation(((...args: unknown[]) => {
    const fd = Reflect.apply(actual.openSync, actual, args) as number
    opened.set(fd, String(args[0]))
    return fd
  }) as typeof openSync)
  const byPath = (real: (...args: unknown[]) => unknown) =>
    ((...args: unknown[]) => {
      const st = real(...args) as Stats | undefined
      return st !== undefined && foreign.paths.has(String(args[0])) ? asSomebodyElses(st) : st
    }) as never
  vi.mocked(lstatSync).mockImplementation(
    byPath((...a) => Reflect.apply(actual.lstatSync, actual, a)),
  )
  vi.mocked(statSync).mockImplementation(
    byPath((...a) => Reflect.apply(actual.statSync, actual, a)),
  )
  vi.mocked(writeSync).mockImplementation(((...args: unknown[]) => {
    if (disk.full)
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    return Reflect.apply(actual.writeSync, actual, args) as number
  }) as typeof writeSync)
  vi.mocked(fstatSync).mockImplementation(((...args: unknown[]) => {
    const st = Reflect.apply(actual.fstatSync, actual, args) as Stats
    const path = opened.get(args[0] as number)
    return path !== undefined && foreign.paths.has(path) ? asSomebodyElses(st) : st
  }) as typeof fstatSync)
})

const savedTz = process.env['TZ']
afterEach(() => {
  disk.full = false
  foreign.paths.clear()
  sweepTempRoots()
  if (savedTz === undefined) delete process.env['TZ']
  else process.env['TZ'] = savedTz
})

const mode = (path: string): number => statSync(path).mode & 0o777
const pad = (n: number): string => String(n).padStart(3, '0')

type Parsed = Record<string, unknown>
const linesOf = (path: string): string[] =>
  readText(path)
    .split('\n')
    .filter((line) => line !== '')
const parse = (line: string): Parsed => JSON.parse(line) as Parsed
const recordsOf = (path: string): Parsed[] => linesOf(path).map(parse)

const STARTED = '2026-11-27T10:00:00.000+08:00'
const MARKER = `{"v":1,"startedAt":"${STARTED}","version":"0.0.0","pid":99}`

// ---- a rotation that cannot rename ------------------------------------------------------------

interface Block {
  /** Called once `main.1.jsonl` exists: from now on the next rotation cannot rename. */
  arm(logs: string): void
  free(logs: string): void
}

/** How many times a turn-over has been tried since the spy was last cleared: each begins by renaming `main.1.jsonl` to `main.2.jsonl`. */
const turnOverTries = (): number =>
  vi.mocked(renameSync).mock.calls.filter(([, to]) => String(to).endsWith('main.2.jsonl')).length

const LIFECYCLE = ['app.start', 'sandbox.helpers', 'sandbox.posture', 'window.shown']

function writeLifecycle(log: OpenedLog['log']): void {
  log.write('info', {
    event: 'app.start',
    packaged: true,
    platform: 'linux',
    arch: 'x64',
    userData: '/u',
  })
  log.write('info', { event: 'window.shown' })
  log.write('info', { event: 'sandbox.posture', state: 'active', reasons: [] })
  log.write('info', {
    event: 'sandbox.helpers',
    packageDir: '/p',
    applySeccomp: '/a',
    javaAgentJar: '/j',
  })
}

/**
 * Runs a log of 4 KiB files into a rotation that fails, 200 more lines through it, and then lets the
 * rename work again a minute later. `s<NNN>` sources keep every line under its own cap.
 */
function rotationBlocked(block: Block): number {
  const MAX = 4096
  const { log, dir, clock, stderr } = openLog({ packaged: true, maxBytes: MAX })
  const main = join(dir, 'main.jsonl')
  writeLifecycle(log)
  let written = 0
  const write = (): void => {
    log.line(`s${pad(written)}`, 'info')('z'.repeat(100))
    written += 1
  }
  while (!existsSync(join(dir, 'main.1.jsonl'))) {
    write()
    expect(written).toBeLessThan(100)
  }
  block.arm(dir)
  vi.mocked(renameSync).mockClear()
  try {
    const sizes: number[] = []
    for (let i = 0; i < 200; i += 1) {
      write()
      sizes.push(statSync(main).size)
    }
    const longest = Math.max(...linesOf(main).map((line) => Buffer.byteLength(line) + 1))
    // Never more than the limit and one line, however many lines came while it could not turn over.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX + longest)
    // The lines copied to the top of this file were copied once, by the one rotation that worked.
    expect(
      recordsOf(main)
        .filter((r) => r['carried'] === true)
        .map((r) => r['event'])
        .toSorted(),
    ).toEqual(LIFECYCLE)
    // However many times it failed, the stderr heard of it once.
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain('cannot be written')
    // The turn-over is tried again after a minute, not at every line: 200 lines at one instant are
    // one try (the rename of `main.1.jsonl` to `main.2.jsonl` is the first step of each).
    expect(turnOverTries()).toBeLessThanOrEqual(2)
    clock.advance(30_000)
    for (let i = 0; i < 20; i += 1) write()
    expect(turnOverTries()).toBeLessThanOrEqual(2)
  } finally {
    block.free(dir)
  }

  // A minute later the rename is tried again, and works: three files, the newest on top, with the
  // lifecycle lines copied and the lines that were dropped counted.
  clock.advance(61_000)
  log.line('host', 'info')('after the rename works again')
  log.close()
  for (const name of ['main.jsonl', 'main.1.jsonl', 'main.2.jsonl']) {
    expect([name, statSync(join(dir, name)).isFile()]).toEqual([name, true])
  }
  const all = ['main.jsonl', 'main.1.jsonl', 'main.2.jsonl'].flatMap((name) =>
    recordsOf(join(dir, name)),
  )
  const kept = new Set(
    all
      .filter((r) => r['event'] === 'line' && /^s\d{3}$/u.test(String(r['source'])))
      .map((r) => r['source']),
  )
  const dropped = all.filter((r) => r['event'] === 'log.dropped')
  expect(dropped.length).toBeGreaterThan(0)
  expect(dropped.map((r) => r['source'])).toEqual(dropped.map(() => 'rotate'))
  // Every line written is in a file or counted as dropped: none is lost without a word.
  expect(kept.size + dropped.reduce((sum, r) => sum + (r['count'] as number), 0)).toBe(written)
  expect(
    linesOf(main)
      .slice(0, 4)
      .map((line) => parse(line))
      .map((r) => [r['event'], r['carried']])
      .toSorted(),
  ).toEqual(LIFECYCLE.map((event) => [event, true]))
  expect(stderr).toHaveLength(1)
  return written
}

describe('a rotation that cannot rename', () => {
  it('error-logs 验收 13: 复现 an old name held by a folder: main.jsonl stays within its limit and a line, what is dropped is counted as rotate, and the copied lines are not piled up', () => {
    const written = rotationBlocked({
      arm(logs) {
        mkdirSync(join(logs, 'main.2.jsonl'))
        writeFileSync(join(logs, 'main.2.jsonl', 'in-the-way'), 'x')
      },
      free(logs) {
        rmSync(join(logs, 'main.2.jsonl'), { recursive: true, force: true })
      },
    })
    expect(written).toBeGreaterThan(200)
  })

  it.skipIf(process.platform !== 'darwin')(
    'error-logs 验收 13: 复现 an archive that cannot be renamed (locked): the same, whichever rename it is that fails',
    () => {
      const written = rotationBlocked({
        arm(logs) {
          execFileSync('chflags', ['uchg', join(logs, 'main.1.jsonl')])
        },
        free(logs) {
          execFileSync('chflags', ['nouchg', join(logs, 'main.1.jsonl')])
        },
      })
      expect(written).toBeGreaterThan(200)
    },
  )
})

// ---- what is copied to the top of a new file --------------------------------------------------

it('error-logs 验收 16: 复现 after sixty windows the posture, the helpers and the start are still copied, and of the windows only the latest', () => {
  const dir = join(makeTempRoot('carry-latest'), 'logs')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'running.json'), MARKER, { mode: 0o600 })
  const { log, clock } = openLog({ dir, makeDir: false, maxBytes: 16_000, packaged: true })
  log.write('info', {
    event: 'app.start',
    packaged: false,
    platform: 'linux',
    arch: 'x64',
    userData: '/u',
  })
  // The first posture is a pending one; the second is what it came to: only that is copied.
  log.write('info', { event: 'sandbox.posture', state: 'degraded', reasons: ['first'] })
  let latest = ''
  for (let i = 0; i < 60; i += 1) {
    clock.advance(7)
    log.write('info', { event: 'window.shown' })
    latest = readText(join(dir, 'main.jsonl')).trimEnd().split('\n').at(-1) ?? ''
  }
  log.write('info', { event: 'sandbox.posture', state: 'active', reasons: [] })
  log.write('info', {
    event: 'sandbox.helpers',
    packageDir: '/p',
    applySeccomp: '/a',
    javaAgentJar: '/j',
  })
  for (let i = 0; i < 300; i += 1) log.line(`f${pad(i)}`, 'info')('f'.repeat(120))
  expect(existsSync(join(dir, 'main.1.jsonl'))).toBe(true)

  const carried = recordsOf(join(dir, 'main.jsonl')).filter((r) => r['carried'] === true)
  expect(carried.map((r) => r['event']).toSorted()).toEqual([
    'app.start',
    'app.unclean-exit',
    'sandbox.helpers',
    'sandbox.posture',
    'window.shown',
  ])
  expect(carried.find((r) => r['event'] === 'sandbox.posture')).toMatchObject({
    state: 'active',
    reasons: [],
  })
  // The window that is copied is the sixtieth, with its own time.
  expect(carried.find((r) => r['event'] === 'window.shown')?.['t']).toBe(parse(latest)['t'])
  expect(
    linesOf(join(dir, 'main.jsonl'))
      .slice(0, 5)
      .every((line) => parse(line)['carried'] === true),
  ).toBe(true)
})

// ---- the development mirror ---------------------------------------------------------------------

it('error-logs 验收 1: 复现 the development mirror is ahead of the cap: a hundred lines are a hundred on stderr, sixty in the file and one count, and a line after close is mirrored too', () => {
  const { log, dir, stderr } = openLog({ packaged: false })
  for (let i = 0; i < 100; i += 1) log.line('host', 'warn')(`host ${i}`)
  const mirrored = (): string[] => stderr.filter((text) => /^host \d+\n$/u.test(text))
  expect(mirrored()).toHaveLength(100)
  expect(mirrored().at(-1)).toBe('host 99\n')
  const hostLines = (): Parsed[] =>
    recordsOf(join(dir, 'main.jsonl')).filter((r) => r['source'] === 'host')
  expect(hostLines()).toHaveLength(60)

  log.close()
  expect(
    recordsOf(join(dir, 'main.jsonl'))
      .filter((r) => r['event'] === 'log.dropped')
      .map((r) => [r['source'], r['count']]),
  ).toEqual([['host', 40]])

  // After the close nothing more goes to the file, and the terminal still hears of it.
  const before = readText(join(dir, 'main.jsonl'))
  log.line('host', 'warn')('after the close')
  expect(stderr).toContain('after the close\n')
  expect(readText(join(dir, 'main.jsonl'))).toBe(before)
})

// ---- a write that fails ------------------------------------------------------------------------------

it('error-logs 验收 13: a write that fails because the disk is full is told to stderr once, never thrown, and the app goes on', () => {
  const { log, dir, stderr } = openLog({ packaged: true })
  log.line('host', 'info')('before the disk filled')
  disk.full = true
  for (let i = 0; i < 20; i += 1) log.line(`s${pad(i)}`, 'info')('this line cannot be written')
  log.write('error', { event: 'process.gone', process: 'gpu', reason: 'crashed', exitCode: 1 })
  log.close()
  disk.full = false

  expect(stderr).toHaveLength(1)
  expect(stderr[0]).toContain('cannot be written')
  expect(stderr[0]).toContain('ENOSPC')
  expect(recordsOf(join(dir, 'main.jsonl')).map((r) => r['text'])).toEqual([
    'before the disk filled',
  ])
})

// ---- who owns what -----------------------------------------------------------------------------

describe('a file or a folder that is somebody else’s', () => {
  it('error-logs 验收 13: a main.jsonl of somebody else’s, in a folder that is ours, is not written to', () => {
    const root = makeTempRoot('foreign-file')
    const logs = join(root, 'logs')
    mkdirSync(logs, { mode: 0o755 })
    writeFileSync(join(logs, 'main.jsonl'), 'OLD\n', { mode: 0o600 })
    foreign.paths.add(join(logs, 'main.jsonl'))
    const refused = openLog({ dir: logs, makeDir: false, packaged: true })
    expect(refused.result).toMatchObject({ ok: false })
    refused.log.line('host', 'warn')('into somebody else’s file')
    refused.log.close()
    expect(readText(join(logs, 'main.jsonl'))).toBe('OLD\n')
    expect(readdirSync(logs)).toEqual(['main.jsonl'])
  })

  it('error-logs 验收 13: a log folder of somebody else’s, holding a main.jsonl that is ours, is not written to and not changed', () => {
    const root = makeTempRoot('foreign-folder')
    const logs = join(root, 'logs')
    mkdirSync(logs, { mode: 0o755 })
    chmodSync(logs, 0o755)
    foreign.paths.add(logs)
    const refused = openLog({ dir: logs, makeDir: false, packaged: true })
    expect(refused.result).toMatchObject({ ok: false })
    refused.log.line('host', 'warn')('into somebody else’s folder')
    refused.log.close()
    expect(readdirSync(logs)).toEqual([])
    expect(mode(logs)).toBe(0o755)
  })
})

// ---- the old marker, read back ------------------------------------------------------------------

function logsWithMarker(tag: string, plant: (logs: string, root: string) => void): string {
  const root = makeTempRoot(tag)
  const logs = join(root, 'logs')
  mkdirSync(logs, { mode: 0o700 })
  plant(logs, root)
  return logs
}

describe('the marker the last run left', () => {
  it('error-logs 验收 13: a marker that is a link is not followed, its target is left alone and it counts as unreadable', () => {
    let target = ''
    const logs = logsWithMarker('marker-link', (folder, root) => {
      target = join(root, 'elsewhere.json')
      writeFileSync(target, MARKER, { mode: 0o644 })
      chmodSync(target, 0o644)
      symlinkSync(target, join(folder, 'running.json'))
    })
    const started = openLog({ dir: logs, makeDir: false, packaged: true })
    expect(started.result).toEqual({ ok: true, previous: 'unreadable' })
    expect(
      recordsOf(join(logs, 'main.jsonl')).filter((r) => r['event'] === 'app.unclean-exit'),
    ).toMatchObject([{ startedAt: null, version: null }])
    expect(readText(target)).toBe(MARKER)
    expect(mode(target)).toBe(0o644)
    started.log.close()
    expect(readText(target)).toBe(MARKER)
  })

  it('error-logs 验收 13: a marker over 4 KiB is unreadable and one of exactly 4 KiB is read', () => {
    const padded = (bytes: number): string => MARKER + ' '.repeat(bytes - MARKER.length)
    for (const [bytes, previous] of [
      [4096, { v: 1, startedAt: STARTED, version: '0.0.0', pid: 99 }],
      [4097, 'unreadable'],
      [5 * 1024, 'unreadable'],
    ] as const) {
      const logs = logsWithMarker(`marker-${bytes}`, (folder) => {
        writeFileSync(join(folder, 'running.json'), padded(bytes), { mode: 0o600 })
      })
      expect([bytes, openLog({ dir: logs, makeDir: false, packaged: true }).result]).toEqual([
        bytes,
        { ok: true, previous },
      ])
    }
  })

  it('error-logs 验收 13: a marker that is a FIFO does not block the start', () => {
    const logs = logsWithMarker('marker-fifo', (folder) => {
      execFileSync('mkfifo', [join(folder, 'running.json')])
    })
    // Whatever would let a blocked open go: a writer 1.5 s from now. A start that waits for it
    // is a start that takes a second and a half; one that does not takes a few milliseconds.
    const writer = spawn('sh', ['-c', 'sleep 1.5; exec 9>"$1"', 'sh', join(logs, 'running.json')], {
      stdio: 'ignore',
    })
    try {
      const began = performance.now()
      const started = openLog({ dir: logs, makeDir: false, packaged: true })
      const took = performance.now() - began
      expect(started.result).toEqual({ ok: true, previous: 'unreadable' })
      expect(took).toBeLessThan(1000)
    } finally {
      writer.kill('SIGKILL')
    }
  })
})

// ---- close -------------------------------------------------------------------------------------

it('error-logs 验收 17: close removes running.json, writes app.quit last, and the next start finds nothing unclean', () => {
  process.env['TZ'] = 'Asia/Shanghai'
  const first = openLog({ packaged: true })
  expect(JSON.parse(readText(join(first.dir, 'running.json')))).toEqual({
    v: 1,
    startedAt: '2026-11-28T17:15:02.123+08:00',
    version: '0.0.0',
    pid: 4242,
  })
  first.log.line('host', 'info')('running')
  first.log.close()
  expect(existsSync(join(first.dir, 'running.json'))).toBe(false)
  expect(recordsOf(join(first.dir, 'main.jsonl')).at(-1)).toMatchObject({ event: 'app.quit' })

  const next = openLog({ dir: first.dir, makeDir: false, packaged: true })
  expect(next.result).toEqual({ ok: true, previous: 'none' })
  expect(
    recordsOf(join(first.dir, 'main.jsonl')).filter((r) => r['event'] === 'app.unclean-exit'),
  ).toEqual([])
})
