/**
 * What one line of `main.jsonl` is, tested at its edges (docs/features/error-logs/spec.md §日志行,
 * §怎么写「上限」「脱敏、截断都按字段做」「一行里除了…」「缩到最短仍超过 16 KiB 的行」; acceptance 1, 2, 3).
 *
 * A real `createAppLog` on real temp folders, the files read back from disk; nothing is faked. What
 * is driven by hand is the clock and, for the time zone, `process.env.TZ`. A case whose name says
 * 复现 reproduces a finding of the segment-1 review (docs/features/error-logs: the three reviews of
 * 2026-11-28) and fails until that finding is fixed; the others hold today and keep a number or an
 * edge from moving. Expected values are literals: 16 KiB (16 384 bytes, the newline counted), 2000
 * characters, the `…(+N)` mark, the escapes.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fragmentsOf, TABLE } from './support/error-logs-sentinels.js'
import { leaksIn, openLog, readText, sweepTempRoots } from './support/error-logs.js'
import type { LogEvent } from './support/error-logs.js'

const savedTz = process.env['TZ']
afterEach(() => {
  sweepTempRoots()
  if (savedTz === undefined) delete process.env['TZ']
  else process.env['TZ'] = savedTz
})

const FIXED_FIELDS = ['v', 't', 'level', 'ver', 'pid', 'event']

/** The non-empty lines of a file. */
function linesOf(path: string): string[] {
  return readText(path)
    .split('\n')
    .filter((line) => line !== '')
}

/** The lines that are not a JSON object: a case asserts this list is empty rather than throwing on one. */
function notJson(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    try {
      const parsed: unknown = JSON.parse(line)
      return typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    } catch {
      return true
    }
  })
}

type Parsed = Record<string, unknown>

const parse = (line: string): Parsed => JSON.parse(line) as Parsed

/** Whether an object's first six keys are the fixed ones, in order: what a reader of the file counts on. */
const startsWithFixedFields = (record: Parsed): boolean =>
  JSON.stringify(Object.keys(record).slice(0, 6)) === JSON.stringify(FIXED_FIELDS)

/**
 * A line that cannot be made to fit: 150 keys of 200 characters. Only a string value is ever cut,
 * never a key, so this stays about 30 KB however much is cut.
 */
function stubborn(): Record<string, number> {
  return Object.fromEntries(
    Array.from({ length: 150 }, (_, i) => [`k${String(i).padStart(3, '0')}${'_'.repeat(196)}`, i]),
  )
}

const asEvent = (event: object): LogEvent => event as unknown as LogEvent

it('error-logs 验收 2: 复现 a registered value that looks like the log format leaves every later line whole', () => {
  const lookalikes = ['"level":', '","event":"', '","source":"kernel","text":"', '{"v":1,"t":"']
  for (const lookalike of lookalikes) {
    const { log, dir } = openLog({ packaged: true })
    log.remember(lookalike)
    log.line('kernel', 'error')('before: model request failed, status=401')
    log.line('kernel', 'error')(`inside the text: ${lookalike} and on`)
    log.write('warn', {
      event: 'ipc.failed',
      channel: 'chat.send',
      code: 'handler-failed',
      message: `m ${lookalike}`,
    })
    log.close()

    const lines = linesOf(join(dir, 'main.jsonl'))
    expect([lookalike, notJson(lines)]).toEqual([lookalike, []])
    const records = lines.map(parse)
    expect(records.map((r) => [r['event'], r['level']])).toEqual([
      ['line', 'error'],
      ['line', 'error'],
      ['ipc.failed', 'warn'],
      ['app.quit', 'info'],
    ])
    expect(records.every(startsWithFixedFields)).toBe(true)
    expect(records[0]).toMatchObject({
      source: 'kernel',
      text: 'before: model request failed, status=401',
    })
    // The value is taken out of the text it is in, and only out of that.
    expect(records[1]).toMatchObject({
      source: 'kernel',
      text: 'inside the text: [redacted] and on',
    })
    expect(records[2]).toMatchObject({
      channel: 'chat.send',
      code: 'handler-failed',
      message: 'm [redacted]',
    })
  }
})

it('error-logs 验收 16: 复现 the lines copied to the new file after a rotation survive a registered value that looks like the log format', () => {
  const { log, dir } = openLog({ packaged: true, maxBytes: 4096 })
  log.write('info', {
    event: 'app.start',
    packaged: true,
    platform: 'linux',
    arch: 'x64',
    userData: '/u',
  })
  log.write('info', { event: 'window.shown' })
  log.remember('"level":')
  for (let i = 0; i < 60; i += 1)
    log.line(`s${String(i).padStart(3, '0')}`, 'info')('z'.repeat(100))
  expect(existsSync(join(dir, 'main.1.jsonl'))).toBe(true)

  const lines = linesOf(join(dir, 'main.jsonl'))
  expect(notJson(lines)).toEqual([])
  const copies = lines.map(parse).filter((r) => r['carried'] === true)
  expect(copies.map((r) => r['event']).toSorted()).toEqual(['app.start', 'window.shown'])
  expect(copies.every(startsWithFixedFields)).toBe(true)
  expect(copies.find((r) => r['event'] === 'app.start')).toMatchObject({
    packaged: true,
    platform: 'linux',
    arch: 'x64',
    userData: '/u',
    carried: true,
  })
})

it('error-logs 验收 2: 复现 U+2028, U+2029 and the C1 control characters are escaped, so a line is one line whichever break a reader cuts at', () => {
  const c1 = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(0x80 + i)).join('')
  const awkward = `a b c\u0085d ${c1} e\nf\rg`
  const { log, dir } = openLog({ packaged: true })
  log.line('host', 'warn')(awkward)
  log.write('error', {
    event: 'main.uncaught',
    origin: 'uncaughtException',
    error: { name: 'Error', message: awkward, frames: [`at ${awkward}`] },
  })
  const text = readText(join(dir, 'main.jsonl'))

  // Two records, each ended by one \n; cut at any other kind of line break there is nothing to cut.
  expect(text.split('\n')).toHaveLength(3)
  for (const [name, separator] of [
    ['CR', '\r'],
    ['LS U+2028', ' '],
    ['PS U+2029', ' '],
    ['NEL U+0085', '\u0085'],
  ] as const) {
    expect([name, text.split(separator).length]).toEqual([name, 1])
  }
  for (let code = 0x80; code <= 0x9f; code += 1) {
    expect([code, text.includes(String.fromCharCode(code))]).toEqual([code, false])
  }

  // Escaped, and so the same text again once the line is read as JSON.
  const records = linesOf(join(dir, 'main.jsonl')).map(parse)
  expect(records[0]?.['text']).toBe(awkward)
  expect(records[1]?.['error']).toMatchObject({ message: awkward, frames: [`at ${awkward}`] })
})

it('error-logs 验收 2: 复现 a line that cannot be made to fit is written as log.dropped naming the event, count 1, and never as the event', () => {
  const { log, dir } = openLog({ packaged: true })
  log.write(
    'error',
    asEvent({
      event: 'process.gone',
      process: 'gpu',
      reason: 'crashed',
      exitCode: 1,
      ...stubborn(),
    }),
  )
  log.line('host', 'warn')('an ordinary line after it')
  log.write('warn', asEvent({ event: 'line', source: 'host', text: 'too big', ...stubborn() }))
  log.close()

  const lines = linesOf(join(dir, 'main.jsonl'))
  expect(notJson(lines)).toEqual([])
  for (const line of lines) expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(16 * 1024)
  const records = lines.map(parse)
  // Neither of the two that did not fit is in the file under its own name.
  expect(records.filter((r) => r['event'] === 'process.gone')).toEqual([])
  expect(records.filter((r) => r['text'] === 'too big')).toEqual([])
  expect(
    records.filter((r) => r['event'] === 'log.dropped').map((r) => [r['source'], r['count']]),
  ).toEqual([
    ['process.gone', 1],
    ['line', 1],
  ])
  expect(records.filter((r) => r['event'] === 'log.dropped').every(startsWithFixedFields)).toBe(
    true,
  )
  expect(records.filter((r) => r['text'] === 'an ordinary line after it')).toHaveLength(1)
})

it('error-logs 验收 2: the log.dropped that stands in for a line that cannot fit has the level of that line', () => {
  const { log, dir } = openLog({ packaged: true })
  log.write(
    'error',
    asEvent({ event: 'process.gone', process: 'gpu', reason: 'x', exitCode: 1, ...stubborn() }),
  )
  log.write('warn', asEvent({ event: 'line', source: 'host', text: 'too big', ...stubborn() }))
  log.write(
    'info',
    asEvent({
      event: 'app.start',
      packaged: true,
      platform: 'linux',
      arch: 'x64',
      userData: '/u',
      ...stubborn(),
    }),
  )
  expect(
    linesOf(join(dir, 'main.jsonl'))
      .map(parse)
      .map((r) => [r['event'], r['source'], r['count'], r['level']]),
  ).toEqual([
    ['log.dropped', 'process.gone', 1, 'error'],
    ['log.dropped', 'line', 1, 'warn'],
    ['log.dropped', 'app.start', 1, 'info'],
  ])
})

it('error-logs 验收 2: the line that stands in for one that cannot fit fits whatever the version is, and names the event: never a name of its own', () => {
  // 5 000 control characters, each six bytes once escaped; the version is cut to 200 characters.
  const { log, dir } = openLog({ packaged: true, version: '\u0001'.repeat(5_000) })
  log.write(
    'error',
    asEvent({
      event: 'process.gone',
      process: 'gpu',
      reason: 'crashed',
      exitCode: 1,
      ...stubborn(),
    }),
  )
  const lines = linesOf(join(dir, 'main.jsonl'))
  expect(lines).toHaveLength(1)
  expect(Buffer.byteLength(lines[0] ?? '') + 1).toBeLessThanOrEqual(16 * 1024)
  expect(parse(lines[0] ?? '')).toMatchObject({
    event: 'log.dropped',
    source: 'process.gone',
    count: 1,
    level: 'error',
  })
})

/** The size on disk of one `main.uncaught` record with these stack frames. */
function sizeWithFrames(frames: readonly string[]): { size: number; text: string } {
  const { log, dir } = openLog({ packaged: true })
  log.write('error', {
    event: 'main.uncaught',
    origin: 'uncaughtException',
    error: { name: 'Error', message: 'm', frames },
  })
  const text = readText(join(dir, 'main.jsonl'))
  return { size: Buffer.byteLength(text), text }
}

it('error-logs 验收 2: a line is cut at 16 KiB exactly: 50 bytes over is cut, 10 bytes under is left alone', () => {
  // Eight frames of 1900 characters (none of them reaches the 2000 of a field) and a last one whose
  // length sets the size: every character is one byte, so the line grows by one byte per character.
  const body = Array.from({ length: 8 }, () => 'y'.repeat(1900))
  const base = sizeWithFrames([...body, '']).size
  const framesFor = (size: number): string[] => [...body, 'z'.repeat(size - base)]

  const under = sizeWithFrames(framesFor(16 * 1024 - 10))
  expect(under.size).toBe(16 * 1024 - 10)
  expect(under.text).not.toContain('…(+')

  const over = sizeWithFrames(framesFor(16 * 1024 + 50))
  expect(over.size).toBeLessThanOrEqual(16 * 1024)
  expect(over.size).toBeGreaterThan(8 * 1024)
  expect(over.text.split('\n')).toHaveLength(2)
  expect(over.text).toMatch(/…\(\+\d+\)/u)
  expect(parse(over.text.trim())).toMatchObject({ event: 'main.uncaught' })
})

it('error-logs 验收 2: a cut never splits a surrogate pair, and the mark counts what was really left out', () => {
  const { log, dir } = openLog({ packaged: true })
  const emoji = '\u{1F600}'
  // 2101 characters; the cut at 2000 would fall inside the pair at 1999-2000: it falls before it.
  log.line('host', 'info')(`${'x'.repeat(1999)}${emoji}${'y'.repeat(100)}`)
  // 2100 characters, the pair at 1998-1999 is whole inside the limit: it stays.
  log.line('host', 'info')(`${'x'.repeat(1998)}${emoji}${'y'.repeat(100)}`)
  const texts = linesOf(join(dir, 'main.jsonl')).map((line) => parse(line)['text'])
  expect(texts).toEqual([`${'x'.repeat(1999)}…(+102)`, `${'x'.repeat(1998)}${emoji}…(+100)`])
})

it('error-logs 验收 1: the time ends +00:00 at a zero offset, and its milliseconds are three digits', () => {
  process.env['TZ'] = 'UTC'
  const { log, dir, clock } = openLog({ packaged: true, startIso: '2026-11-28T09:15:02.007Z' })
  log.line('host', 'info')('seven')
  clock.set('2026-11-28T09:15:02.000Z')
  log.line('host', 'info')('zero')
  clock.set('2026-11-28T09:15:02.050Z')
  log.line('host', 'info')('fifty')
  expect(linesOf(join(dir, 'main.jsonl')).map((line) => parse(line)['t'])).toEqual([
    '2026-11-28T09:15:02.007+00:00',
    '2026-11-28T09:15:02.000+00:00',
    '2026-11-28T09:15:02.050+00:00',
  ])
})

it('error-logs 验收 3: 复现 a secret in the version is replaced before the version is cut to 200 characters, in running.json and in every line', () => {
  const version = `${'x'.repeat(190)}${TABLE.raw}`
  const expected = `${'x'.repeat(190)}[redacted]`
  const { log, dir, open } = openLog({ deferOpen: true, packaged: true, version })
  log.remember(TABLE.raw)
  open()
  log.line('host', 'warn')('an ordinary line')
  // The line that is not written whole is made differently from the others: its version too.
  log.write(
    'error',
    asEvent({
      event: 'process.gone',
      process: 'gpu',
      reason: 'crashed',
      exitCode: 1,
      ...stubborn(),
    }),
  )

  expect(parse(readText(join(dir, 'running.json')))['version']).toBe(expected)
  expect(leaksIn(dir, fragmentsOf(TABLE.raw))).toEqual([])
  log.close()
  const records = linesOf(join(dir, 'main.jsonl')).map(parse)
  expect(records.length).toBeGreaterThanOrEqual(3)
  expect(records.map((r) => r['ver'])).toEqual(records.map(() => expected))
  expect(leaksIn(dir, fragmentsOf(TABLE.raw))).toEqual([])
})

it('error-logs 验收 13: 复现 write never throws: an event whose field throws what cannot be made a string is left out, told to stderr once, and the lines after it are written', () => {
  // Three things a getter can throw that no `String(error)` or `error.code` survives.
  const unreadable = [
    Object.create(null) as object,
    {
      toString(): string {
        throw new Error('no text')
      },
    },
    new Proxy(
      {},
      {
        get(): never {
          throw new Error('no property')
        },
      },
    ),
  ]
  for (const thrown of unreadable) {
    const { log, dir, stderr } = openLog({ packaged: true })
    const hostile = {
      event: 'line',
      source: 'host',
      get text(): string {
        throw thrown
      },
    }
    expect(() => {
      log.write('warn', asEvent(hostile))
    }).not.toThrow()
    expect(() => {
      log.write('warn', asEvent(hostile))
    }).not.toThrow()
    log.line('host', 'info')('the line after it')
    log.close()
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain('the app log cannot be written')
    expect(
      linesOf(join(dir, 'main.jsonl'))
        .map(parse)
        .filter((r) => r['event'] === 'line')
        .map((r) => r['text']),
    ).toEqual(['the line after it'])
  }
})
