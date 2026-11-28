/**
 * The app log's file format, caps and protections (docs/features/error-logs/spec.md §日志行,
 * §怎么写, §限量; acceptance 1, 2, 13, 16).
 *
 * Everything here runs against a real `createAppLog` on real temp folders: the files are the
 * thing under test, so no file system is faked. What is driven by hand is the clock, `stderr` (a
 * captured list) and the sizes (`maxBytes`), so a case needs a few lines, not 5 MiB. The one fake
 * is `node:fs` made spy-able (`spy: true`, calls pass through), used only to learn the name of
 * `running.json`'s temp file before a case plants something on that name.
 *
 * Expected values are literals written from the spec: field names and order, the event names, the
 * source names, the 60/600 line caps, 16 KiB, 15 MiB, the file modes.
 */
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeTempRoot,
  openLog,
  readRecords,
  readText,
  sweepTempRoots,
} from './support/error-logs.js'
import type { LogRecord } from './support/error-logs.js'

vi.mock('node:fs', { spy: true })

const savedTz = process.env['TZ']
afterEach(() => {
  sweepTempRoots()
  if (savedTz === undefined) delete process.env['TZ']
  else process.env['TZ'] = savedTz
})

const mode = (path: string): number => statSync(path).mode & 0o777

/** A record line as it is copied to a new file after a rotation: the same text, `carried` last. */
const carried = (line: string): string => `${line.slice(0, -1)},"carried":true}`

describe('the fixed fields', () => {
  it('error-logs 验收 1: representative sources reach main.jsonl with time, level, event and version', () => {
    process.env['TZ'] = 'Asia/Shanghai'
    const { log, dir, clock } = openLog({ version: '0.0.0' })
    const sources = [
      ['host', 'warn'],
      ['tape', 'error'],
      ['kernel', 'error'],
      ['mcp', 'warn'],
      ['config', 'warn'],
      ['shutdown', 'warn'],
      ['recovery', 'info'],
    ] as const
    for (const [source, level] of sources) log.line(source, level)(`[${source}] one line`)

    const text = readText(join(dir, 'main.jsonl'))
    const records = readRecords(join(dir, 'main.jsonl'))
    expect(records.map((r) => [r.event, r.source, r.level, r.text])).toEqual([
      ['line', 'host', 'warn', '[host] one line'],
      ['line', 'tape', 'error', '[tape] one line'],
      ['line', 'kernel', 'error', '[kernel] one line'],
      ['line', 'mcp', 'warn', '[mcp] one line'],
      ['line', 'config', 'warn', '[config] one line'],
      ['line', 'shutdown', 'warn', '[shutdown] one line'],
      ['line', 'recovery', 'info', '[recovery] one line'],
    ])
    // The six fixed fields come first, in this order, then the event's own.
    const first = JSON.parse(text.split('\n')[0] ?? '') as Record<string, unknown>
    expect(Object.keys(first).slice(0, 6)).toEqual(['v', 't', 'level', 'ver', 'pid', 'event'])
    expect(Object.keys(first).slice(6).toSorted()).toEqual(['source', 'text'])
    expect(first).toMatchObject({
      v: 1,
      t: '2026-11-28T17:15:02.123+08:00',
      ver: '0.0.0',
      pid: 4242,
    })

    // Local time with the zone's offset, to the millisecond, at the moment of the write.
    process.env['TZ'] = 'Asia/Kolkata'
    log.line('host', 'info')('in India')
    process.env['TZ'] = 'America/New_York'
    clock.advance(1)
    log.line('host', 'info')('in New York')
    expect(
      readRecords(join(dir, 'main.jsonl'))
        .slice(-2)
        .map((r) => r.t),
    ).toEqual(['2026-11-28T14:45:02.123+05:30', '2026-11-28T04:15:02.124-05:00'])
  })

  it('error-logs 验收 1: a development build mirrors lines to stderr, redacted and without control characters; a packaged build does not', () => {
    const dev = openLog({ packaged: false })
    dev.log.remember('mirror-secret-0001')
    dev.log.line('host', 'warn')('seen in the terminal mirror-secret-0001 \u001b[31mred\u001b[0m')
    expect(dev.stderr.length).toBeGreaterThan(0)
    const mirrored = dev.stderr.join('')
    expect(mirrored).toContain('seen in the terminal')
    expect(mirrored).not.toContain('mirror-secret-0001')
    expect(mirrored).not.toContain('\u001b')

    const packaged = openLog({ packaged: true })
    packaged.log.line('host', 'warn')('seen nowhere but the file')
    expect(packaged.stderr).toEqual([])
    expect(readRecords(join(packaged.dir, 'main.jsonl')).map((r) => r.text)).toEqual([
      'seen nowhere but the file',
    ])
  })
})

describe('one record per line', () => {
  it('error-logs 验收 2: escapes, truncation marks, a torn last line and the pre-open buffer keep one record per line', () => {
    // Newlines and control characters are escaped, so one record is one physical line.
    {
      const { log, dir } = openLog()
      const awkward = 'a\nb\r\nc\u0000d e\tf\u001b[31mg'
      log.line('host', 'warn')(awkward)
      const text = readText(join(dir, 'main.jsonl'))
      expect(text.split('\n')).toHaveLength(2)
      expect(text.endsWith('\n')).toBe(true)
      expect(readRecords(join(dir, 'main.jsonl'))[0]?.text).toBe(awkward)
    }

    // A string field over 2000 characters is cut and says by how much.
    {
      const { log, dir } = openLog()
      log.line('host', 'warn')('x'.repeat(5000))
      const stored = readRecords(join(dir, 'main.jsonl'))[0]?.text as string
      const mark = /…\(\+(\d+)\)$/.exec(stored)
      expect(mark).not.toBeNull()
      const kept = stored.length - (mark?.[0].length ?? 0)
      expect(kept).toBeLessThanOrEqual(2000)
      expect(kept).toBeGreaterThanOrEqual(1990)
      expect(Number(mark?.[1])).toBe(5000 - kept)
      expect(stored.slice(0, kept)).toBe('x'.repeat(kept))
    }

    // A line over 16 KiB gets its longest string field halved until it fits.
    {
      const { log, dir } = openLog()
      const field = 'y'.repeat(2000)
      log.write('error', {
        event: 'main.uncaught',
        origin: 'uncaughtException',
        error: {
          name: field,
          code: field,
          message: field,
          frames: Array.from({ length: 10 }, () => field),
        },
      })
      const text = readText(join(dir, 'main.jsonl'))
      expect(text.split('\n')).toHaveLength(2)
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024)
      const record = readRecords(join(dir, 'main.jsonl'))[0]
      expect(record).toMatchObject({ event: 'main.uncaught', origin: 'uncaughtException' })
      expect(text).toMatch(/…\(\+\d+\)/)
    }

    // The last line the previous run was writing has no newline: the next start completes it.
    {
      const dir = join(makeTempRoot('torn'), 'logs')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const torn = '{"v":1,"t":"2026-11-28T17:15:00.000+08:00","level":"info","ver":"0.0.0","pid":'
      writeFileSync(join(dir, 'main.jsonl'), `{"v":1,"event":"earlier"}\n${torn}`, { mode: 0o600 })
      const { log } = openLog({ dir, makeDir: false })
      log.line('host', 'info')('after the torn line')
      const lines = readText(join(dir, 'main.jsonl')).split('\n')
      expect(lines[0]).toBe('{"v":1,"event":"earlier"}')
      expect(lines[1]).toBe(torn)
      expect(JSON.parse(lines[2] ?? '')).toMatchObject({
        event: 'line',
        text: 'after the torn line',
      })
    }

    // What was written before `open` is kept and written, in its order, once it is open.
    {
      const { log, dir, open } = openLog({ deferOpen: true })
      log.line('early', 'info')('first')
      log.write('info', { event: 'window.shown' })
      log.line('early', 'info')('third')
      open()
      expect(readRecords(join(dir, 'main.jsonl')).map((r) => [r.event, r.text])).toEqual([
        ['line', 'first'],
        ['window.shown', undefined],
        ['line', 'third'],
      ])
    }

    // A buffer that overflows says how many it dropped, and what it kept is still in order.
    {
      const { log, dir, open } = openLog({ deferOpen: true })
      const total = 50_000
      for (let i = 0; i < total; i += 1) {
        log.write('error', {
          event: 'process.gone',
          process: 'gpu',
          reason: 'crashed',
          exitCode: i,
        })
      }
      open()
      const records = readRecords(join(dir, 'main.jsonl'))
      const kept = records.filter((r) => r.event === 'process.gone')
      const dropped = records
        .filter((r) => r.event === 'log.dropped')
        .reduce((sum, r) => sum + (r['count'] as number), 0)
      expect(kept.length).toBeGreaterThan(0)
      expect(kept.length).toBeLessThan(total)
      expect(kept.length + dropped).toBe(total)
      const codes = kept.map((r) => r['exitCode'] as number)
      expect(codes).toEqual(codes.toSorted((a, b) => a - b))
      expect(new Set(codes).size).toBe(codes.length)
    }
  })
})

/** The size of one `line` record as these cases write it, found by writing one. */
function recordSize(): number {
  const { log, dir } = openLog()
  log.line('s000', 'info')('z'.repeat(100))
  return statSync(join(dir, 'main.jsonl')).size
}

/** The numbers of the `s<NNN>` sources in a log file, in file order. */
function numbersIn(path: string): number[] {
  return readRecords(path)
    .filter((r) => r.event === 'line')
    .map((r) => Number((r['source'] as string).slice(1)))
}

/** The fresh name `running.json` is written under before it is renamed into place. */
function learnTempName(): string | undefined {
  vi.mocked(renameSync).mockClear()
  const probe = openLog({ packaged: true })
  probe.log.close()
  const renamed = vi
    .mocked(renameSync)
    .mock.calls.find(([, to]) => basename(String(to)) === 'running.json')
  return renamed === undefined ? undefined : basename(String(renamed[0]))
}

describe('the size limit, the protections and the cap per source', () => {
  it('error-logs 验收 13: rotation keeps two archives under 15 MiB, 0600 files in a 0700 folder, refuses links, hard links and foreign owners, and a leftover temp file does not stop logging', () => {
    const umask = process.umask(0)
    try {
      // Rotation: adding the next line would pass the limit, so the log turns over first; the two
      // newest archives stay, the oldest goes. Three records fit in a file, and the files that are
      // there afterwards are exactly the ones a count by hand gives.
      const one = recordSize()
      const { log, dir } = openLog({ maxBytes: 3 * one + 10 })
      for (let i = 0; i < 3; i += 1)
        log.line(`s${String(i).padStart(3, '0')}`, 'info')('z'.repeat(100))
      expect(statSync(join(dir, 'main.jsonl')).size).toBe(3 * one)
      expect(existsSync(join(dir, 'main.1.jsonl'))).toBe(false)
      for (let i = 3; i < 14; i += 1)
        log.line(`s${String(i).padStart(3, '0')}`, 'info')('z'.repeat(100))
      expect(readdirSync(dir).toSorted()).toEqual([
        'main.1.jsonl',
        'main.2.jsonl',
        'main.jsonl',
        'running.json',
      ])
      expect(numbersIn(join(dir, 'main.jsonl'))).toEqual([12, 13])
      expect(numbersIn(join(dir, 'main.1.jsonl'))).toEqual([9, 10, 11])
      expect(numbersIn(join(dir, 'main.2.jsonl'))).toEqual([6, 7, 8])
      for (const name of ['main.jsonl', 'main.1.jsonl', 'main.2.jsonl', 'running.json']) {
        expect([name, mode(join(dir, name))]).toEqual([name, 0o600])
      }
      // The folder was made 0755 by the test, as openProfile makes it: open tightens it.
      expect(mode(dir)).toBe(0o700)

      // A folder that is not there yet is made, 0700.
      const fresh = join(makeTempRoot('fresh'), 'profile', 'logs')
      const created = openLog({ dir: fresh, makeDir: false })
      expect(created.result).toMatchObject({ ok: true })
      expect(mode(fresh)).toBe(0o700)

      // Already there with loose modes: tightened to 0600 and 0700.
      const loose = join(makeTempRoot('loose'), 'logs')
      mkdirSync(loose, { recursive: true, mode: 0o755 })
      writeFileSync(join(loose, 'main.jsonl'), '{"v":1,"event":"old"}\n', { mode: 0o666 })
      chmodSync(join(loose, 'main.jsonl'), 0o666)
      expect(openLog({ dir: loose, makeDir: false }).result).toMatchObject({ ok: true })
      expect(mode(loose)).toBe(0o700)
      expect(mode(join(loose, 'main.jsonl'))).toBe(0o600)

      // A folder that is a link is not written into.
      {
        const root = makeTempRoot('dirlink')
        const real = join(root, 'real')
        mkdirSync(real)
        symlinkSync(real, join(root, 'logs'))
        const refused = openLog({ dir: join(root, 'logs'), makeDir: false, packaged: true })
        expect(refused.result).toMatchObject({ ok: false })
        refused.log.line('host', 'warn')('into a link')
        refused.log.write('info', { event: 'window.shown' })
        refused.log.close()
        expect(readdirSync(real)).toEqual([])
        // Reported once to stderr, and it did not stop the app from running.
        expect(refused.stderr).toHaveLength(1)
      }

      // A main.jsonl that is a link: the file it points at is left alone.
      {
        const root = makeTempRoot('filelink')
        const logs = join(root, 'logs')
        mkdirSync(logs)
        const victim = join(root, 'victim.txt')
        writeFileSync(victim, 'VICTIM\n', { mode: 0o644 })
        symlinkSync(victim, join(logs, 'main.jsonl'))
        const refused = openLog({ dir: logs, makeDir: false, packaged: true })
        expect(refused.result).toMatchObject({ ok: false })
        refused.log.line('host', 'warn')('through a link')
        refused.log.close()
        expect(readText(victim)).toBe('VICTIM\n')
        expect(mode(victim)).toBe(0o644)
        expect(lstatSync(join(logs, 'main.jsonl')).isSymbolicLink()).toBe(true)
      }

      // A main.jsonl with a second name: neither name is written, nothing changes.
      {
        const root = makeTempRoot('hardlink')
        const logs = join(root, 'logs')
        mkdirSync(logs)
        writeFileSync(join(logs, 'main.jsonl'), 'OLD\n', { mode: 0o600 })
        linkSync(join(logs, 'main.jsonl'), join(root, 'other-name'))
        const refused = openLog({ dir: logs, makeDir: false, packaged: true })
        expect(refused.result).toMatchObject({ ok: false })
        refused.log.line('host', 'warn')('through a hard link')
        refused.log.close()
        expect(readText(join(logs, 'main.jsonl'))).toBe('OLD\n')
        expect(readText(join(root, 'other-name'))).toBe('OLD\n')
      }

      // Files that belong to somebody else (the log is told another user id): not written.
      {
        const root = makeTempRoot('foreign')
        const logs = join(root, 'logs')
        mkdirSync(logs)
        writeFileSync(join(logs, 'main.jsonl'), 'OLD\n', { mode: 0o600 })
        const refused = openLog({
          dir: logs,
          makeDir: false,
          packaged: true,
          uid: (process.getuid?.() ?? 0) + 1,
        })
        expect(refused.result).toMatchObject({ ok: false })
        refused.log.line('host', 'warn')('into somebody else’s file')
        refused.log.close()
        expect(readText(join(logs, 'main.jsonl'))).toBe('OLD\n')
        expect(readdirSync(logs)).toEqual(['main.jsonl'])
      }

      // running.json is written through a temp file. A link planted on that name must not carry
      // the write to its target; a leftover from a killed or full-disk run must not stop it.
      {
        const temp = learnTempName()
        expect(temp, 'running.json is written by renameSync from a temp file').toBeDefined()
        const root = makeTempRoot('tempname')
        const logs = join(root, 'logs')
        mkdirSync(logs)
        const victim = join(root, 'victim.txt')
        writeFileSync(victim, 'VICTIM\n', { mode: 0o644 })
        symlinkSync(victim, join(logs, temp ?? 'unknown-temp'))
        const opened = openLog({ dir: logs, makeDir: false, packaged: true })
        expect(opened.result).toMatchObject({ ok: true })
        opened.log.line('host', 'warn')('still logging')
        expect(readText(victim)).toBe('VICTIM\n')
        expect(lstatSync(join(logs, 'running.json')).isFile()).toBe(true)
        expect(JSON.parse(readText(join(logs, 'running.json')))).toMatchObject({ v: 1, pid: 4242 })
        expect(readRecords(join(logs, 'main.jsonl')).map((r) => r.text)).toEqual(['still logging'])

        const leftover = join(makeTempRoot('leftover'), 'logs')
        mkdirSync(leftover)
        writeFileSync(join(leftover, temp ?? 'unknown-temp'), 'half a marker', { mode: 0o600 })
        const second = openLog({ dir: leftover, makeDir: false, packaged: true })
        expect(second.result).toMatchObject({ ok: true })
        second.log.line('host', 'warn')('still logging')
        expect(JSON.parse(readText(join(leftover, 'running.json')))).toMatchObject({ v: 1 })
        expect(readRecords(join(leftover, 'main.jsonl')).map((r) => r.text)).toEqual([
          'still logging',
        ])
      }
    } finally {
      process.umask(umask)
    }
  })

  it('error-logs 验收 13: the defaults are 5 MiB a file and two archives, 15 MiB in all', () => {
    const { log, dir } = openLog()
    const pad = 'p'.repeat(2000)
    // ~6.3 KB a record, ~21 MB in all: past three files' worth.
    for (let i = 0; i < 3400; i += 1) {
      log.write('error', {
        event: 'process.gone',
        process: pad,
        reason: pad,
        exitCode: i,
        name: pad,
      })
    }
    const sizes = ['main.jsonl', 'main.1.jsonl', 'main.2.jsonl'].map(
      (name) => statSync(join(dir, name)).size,
    )
    for (const size of sizes) expect(size).toBeLessThanOrEqual(5_242_880)
    expect(sizes[1]).toBeGreaterThan(5_242_880 - 16 * 1024)
    expect(sizes[2]).toBeGreaterThan(5_242_880 - 16 * 1024)
    expect(sizes[0]! + sizes[1]! + sizes[2]!).toBeLessThanOrEqual(15_728_640)
    expect(existsSync(join(dir, 'main.3.jsonl'))).toBe(false)
  })

  it('error-logs 验收 16: each source is capped per window with a dropped count, sources do not share quota, and carried lifecycle lines survive rotation', () => {
    // 60 a window per source, and sources do not draw on one another's quota.
    {
      const { log, dir, clock } = openLog()
      for (let i = 0; i < 100; i += 1) {
        log.line('host', 'warn')(`host ${i}`)
        log.line('tape', 'warn')(`tape ${i}`)
        if (i < 5) log.line('kernel', 'warn')(`kernel ${i}`)
      }
      let records = readRecords(join(dir, 'main.jsonl'))
      expect(records.filter((r) => r['source'] === 'host')).toHaveLength(60)
      expect(records.filter((r) => r['source'] === 'tape')).toHaveLength(60)
      expect(records.filter((r) => r['source'] === 'kernel')).toHaveLength(5)
      // The first 60 are the ones kept.
      expect(
        records
          .filter((r) => r['source'] === 'host')
          .map((r) => r['text'])
          .at(-1),
      ).toBe('host 59')

      // The next window opens: the drops are accounted for, once per source, and logging resumes.
      clock.advance(61_000)
      log.line('host', 'warn')('host again')
      log.line('tape', 'warn')('tape again')
      log.close()
      records = readRecords(join(dir, 'main.jsonl'))
      const dropped = records.filter((r) => r.event === 'log.dropped')
      expect(dropped.map((r) => [r['source'], r['count']]).toSorted()).toEqual([
        ['host', 40],
        ['tape', 40],
      ])
      expect(records.map((r) => r['text'])).toEqual(
        expect.arrayContaining(['host again', 'tape again']),
      )
      expect(records.at(-1)?.event).toBe('app.quit')
    }

    // Every channel of ipc.failed is one source, `ipc`; every window's renderer errors one, `renderer`.
    {
      const { log, dir } = openLog()
      for (let i = 0; i < 70; i += 1) {
        log.write('warn', {
          event: 'ipc.failed',
          channel: `chat.c${i}`,
          code: 'handler-failed',
          message: 'x',
        })
        log.write('error', {
          event: 'renderer.error',
          message: `error number ${i}`,
          source: 'index.html',
          line: i,
          repeats: 1,
        })
      }
      log.close()
      const records = readRecords(join(dir, 'main.jsonl'))
      expect(records.filter((r) => r.event === 'ipc.failed')).toHaveLength(60)
      expect(records.filter((r) => r.event === 'renderer.error')).toHaveLength(60)
      const dropped = records.filter((r) => r.event === 'log.dropped')
      expect(dropped.map((r) => [r['source'], r['count']]).toSorted()).toEqual([
        ['ipc', 10],
        ['renderer', 10],
      ])
    }

    // main.uncaught has a source of its own with 600 a window.
    {
      const { log, dir } = openLog()
      for (let i = 0; i < 650; i += 1) {
        log.write('error', {
          event: 'main.uncaught',
          origin: 'uncaughtException',
          error: { name: 'Error', message: `boom ${i}` },
        })
      }
      log.close()
      const records = readRecords(join(dir, 'main.jsonl'))
      expect(records.filter((r) => r.event === 'main.uncaught')).toHaveLength(600)
      expect(records.filter((r) => r.event === 'log.dropped').map((r) => r['count'])).toEqual([50])
    }

    // Nine kinds are never limited, and their own summary is not either.
    {
      const { log, dir } = openLog()
      const unlimited = [
        { event: 'app.start', packaged: false, platform: 'linux', arch: 'x64', userData: '/u' },
        { event: 'app.unclean-exit', startedAt: null, version: null },
        { event: 'app.startup-failed', error: { name: 'Error', message: 'm' } },
        { event: 'app.quit' },
        { event: 'window.shown' },
        { event: 'sandbox.posture', state: 'active', reasons: [] },
        { event: 'sandbox.helpers', packageDir: '/p', applySeccomp: '/a', javaAgentJar: '/j' },
        { event: 'process.gone', process: 'gpu', reason: 'crashed', exitCode: 1 },
        { event: 'log.dropped', source: 'host', count: 1 },
      ] as const
      for (let i = 0; i < 100; i += 1) for (const event of unlimited) log.write('info', event)
      const records = readRecords(join(dir, 'main.jsonl'))
      for (const event of unlimited) {
        expect([event.event, records.filter((r) => r.event === event.event).length]).toEqual([
          event.event,
          100,
        ])
      }
    }

    // After a rotation, this launch's lifecycle lines are copied to the top of the new file, as
    // they were written, with "carried": true last; nothing else is.
    {
      const dir = join(makeTempRoot('carry'), 'logs')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(dir, 'running.json'),
        '{"v":1,"startedAt":"2026-11-27T10:00:00.000+08:00","version":"0.0.0","pid":99}',
        { mode: 0o600 },
      )
      const { log } = openLog({ dir, makeDir: false, maxBytes: 12_000, packaged: true })
      log.write('info', {
        event: 'app.start',
        packaged: false,
        platform: 'linux',
        arch: 'x64',
        userData: '/u',
      })
      log.write('info', { event: 'window.shown' })
      log.write('info', { event: 'sandbox.posture', state: 'active', reasons: ['r'] })
      log.write('info', {
        event: 'sandbox.helpers',
        packageDir: '/p',
        applySeccomp: '/a',
        javaAgentJar: '/j',
      })
      log.line('host', 'info')('not a lifecycle line')
      const originals = readText(join(dir, 'main.jsonl'))
        .split('\n')
        .filter((l) => l !== '')
      expect(originals.map((l) => (JSON.parse(l) as LogRecord).event)).toEqual([
        'app.unclean-exit',
        'app.start',
        'window.shown',
        'sandbox.posture',
        'sandbox.helpers',
        'line',
      ])
      for (let i = 0; i < 400; i += 1)
        log.line(`f${String(i).padStart(3, '0')}`, 'info')('f'.repeat(120))
      expect(existsSync(join(dir, 'main.2.jsonl'))).toBe(true)

      const now = readText(join(dir, 'main.jsonl'))
        .split('\n')
        .filter((l) => l !== '')
      const lifecycle = originals.slice(0, 5).map(carried)
      expect(now.slice(0, 5).toSorted()).toEqual(lifecycle.toSorted())
      const rest = now.slice(5).map((l) => JSON.parse(l) as LogRecord)
      expect(rest.every((r) => r['carried'] === undefined)).toBe(true)
      expect(rest.every((r) => r.event === 'line')).toBe(true)
      expect(Buffer.byteLength(readText(join(dir, 'main.jsonl')))).toBeLessThanOrEqual(12_000)
    }
  })
})
