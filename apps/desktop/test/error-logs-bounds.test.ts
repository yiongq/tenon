/**
 * How much work taking a secret out of a string may cost, and what that cap leaves of a secret
 * (docs/features/error-logs/spec.md §怎么写「脱敏的工作量有上界（D25）」, §脱敏 层 2; acceptance 2
 * and 3): every string that goes into redaction is cut to 4096 characters first, with the `…(+N)`
 * of what was left out counted over the whole text; every registered value and every spelling of
 * one is registered, a longer one by its first 4096 characters, so what shows of it in a text that
 * is cut is taken out. With a registered value of 4096 characters, or thousands of values that are
 * each the start of the next, and a text of 1 MB, writing a line stays within 200 ms.
 *
 * A real `createAppLog` on real temp folders; only the clock is driven by hand. The text the
 * timing cases use is the worst a registered value of 4096 characters can meet: one that is one
 * character short of the value at every position (4095 `A` and a `B`, over and over), and one that
 * is the value at every position (all `A`). The 200 ms is the spec's; an ordinary machine does the
 * bounded work in about a tenth of a second at most, and the unbounded one in seconds, so the bound
 * only has to tell the two apart. A case whose name says 复现 reproduces a finding of the third
 * review of segment one (the major about the cost of a lookup) or of the final check after it (the
 * spellings that the bound let through, the values that begin alike) and fails until it is fixed.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fragmentsOf } from './support/error-logs-sentinels.js'
import {
  leaksIn,
  openLog,
  readRecords,
  readText,
  summarizeError,
  sweepTempRoots,
  watchRendererConsole,
} from './support/error-logs.js'

afterEach(sweepTempRoots)

const MEGABYTE = 1_000_000
const BUDGET_MS = 200

/** A registered value of 4096 characters: the longest one a window can register through `mcp.save`. */
const VALUE = 'A'.repeat(4_096)

/** One character short of `VALUE` at every position of `length` characters. */
const nearMiss = (length: number): string =>
  `${'A'.repeat(4_095)}B`.repeat(Math.ceil(length / 4_096)).slice(0, length)

/** `VALUE` at every position of `length` characters. */
const everywhere = (length: number): string => 'A'.repeat(length)

/** 4089 registered values, each the start of the next: `A` 8 times, 9 times, … 4096 times. */
const CHAIN = Array.from({ length: 4_089 }, (_, i) => 'A'.repeat(8 + i))

/**
 * `length` characters that look like a secret, the same on every run, and that no generic token
 * format takes out: letters, digits and a few signs, no two windows of 8 alike.
 */
function secretOf(length: number, seed = 20_261_128): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%!@^*()+=~'
  const chars: string[] = []
  let state = seed
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0
    chars.push(alphabet.charAt((state >>> 16) % alphabet.length))
  }
  return chars.join('')
}

const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64')

/**
 * `length` characters that the generic formats take out down to `Authorization: [redacted]` and
 * the line break: what lets a cut fall inside the first 2000 characters that a field keeps.
 */
const collapsing = (length: number): string => `Authorization: ${'a'.repeat(length - 16)}\n`

/** Milliseconds one call takes. */
function took(action: () => void): number {
  const began = performance.now()
  action()
  return performance.now() - began
}

/**
 * The least of up to three runs of a timed case: a run on a machine that is busy with something
 * else can take twice as long as the work does. One that is over four times the budget is the work
 * and not the machine, and is not run again.
 */
function leastOf(run: () => number): number {
  let least = Number.POSITIVE_INFINITY
  for (let attempt = 0; attempt < 3; attempt += 1) {
    least = Math.min(least, run())
    if (least < BUDGET_MS || least > 4 * BUDGET_MS) break
  }
  return least
}

interface ConsoleDetails {
  readonly level: string
  readonly message: string
  readonly sourceId: string
  readonly lineNumber: number
}

/** The part of a `webContents` the renderer watcher uses, with a way to make it emit. */
function fakeContents(): {
  readonly contents: {
    on(event: 'console-message', listener: (details: ConsoleDetails) => unknown): unknown
  }
  emit(details: ConsoleDetails): void
} {
  const listeners: Array<(details: ConsoleDetails) => unknown> = []
  const contents = {
    on(_event: 'console-message', listener: (details: ConsoleDetails) => unknown): unknown {
      listeners.push(listener)
      return contents
    },
  }
  return {
    contents,
    emit(details) {
      for (const listener of listeners) listener(details)
    },
  }
}

const lineTexts = (dir: string): unknown[] =>
  readRecords(join(dir, 'main.jsonl'))
    .filter((r) => r.event === 'line')
    .map((r) => r['text'])

// ---- the time --------------------------------------------------------------------------------

it(
  'error-logs 验收 3: 复现 a registered value of 4096 characters and a line of 1 MB: writing the line takes under 200 ms, whichever way the text matches the value',
  { timeout: 300_000 },
  () => {
    const slow: Array<[string, number]> = []
    const written = new Map<string, unknown>()
    for (const [shape, text] of [
      ['one character short of the value at every position', nearMiss(MEGABYTE)],
      ['the value at every position', everywhere(MEGABYTE)],
    ] as const) {
      const ms = leastOf(() => {
        const { log, dir } = openLog({ packaged: true })
        log.remember(VALUE)
        const run = took(() => {
          log.line('host', 'warn')(text)
        })
        written.set(shape, lineTexts(dir)[0])
        return run
      })
      if (ms >= BUDGET_MS) slow.push([shape, Math.round(ms)])
    }
    expect(slow).toEqual([])
    // No match anywhere in the first: the first 2000 characters and the count of the rest. The
    // second is the value over and over: taken out, and no run of it is left.
    expect(written.get('one character short of the value at every position')).toBe(
      `${nearMiss(2_000)}…(+998000)`,
    )
    expect(String(written.get('the value at every position'))).not.toContain('AAAAAAAA')
  },
)

it(
  'error-logs 验收 3: 复现 4089 registered values, each the start of the next, and a line of 1 MB: writing the line takes under 200 ms, whichever way the text matches',
  { timeout: 600_000 },
  () => {
    const slow: Array<[string, number]> = []
    const written = new Map<string, unknown>()
    for (const [shape, text] of [
      ['one character short of the longest value at every position', nearMiss(MEGABYTE)],
      ['the longest value at every position', everywhere(MEGABYTE)],
    ] as const) {
      const ms = leastOf(() => {
        const { log, dir } = openLog({ packaged: true })
        for (const value of CHAIN) log.remember(value)
        const run = took(() => {
          log.line('host', 'warn')(text)
        })
        written.set(shape, lineTexts(dir)[0])
        return run
      })
      if (ms >= BUDGET_MS) slow.push([shape, Math.round(ms)])
    }
    expect(slow).toEqual([])
    // The first 4096 characters are what is looked at: 4095 `A` are a value, and the `B` is not.
    expect(written.get('one character short of the longest value at every position')).toBe(
      '[redacted]B…(+995904)',
    )
    expect(written.get('the longest value at every position')).toBe('[redacted]…(+995904)')
  },
)

/** Each way a string gets into redaction: what it does with a text of 1 MB, and how long that took. */
const ENTRIES: ReadonlyArray<readonly [string, (text: string) => number]> = [
  [
    'a string field of an event',
    (text) => {
      const { log } = openLog({ packaged: true })
      log.remember(VALUE)
      return took(() => {
        log.write('warn', {
          event: 'ipc.failed',
          channel: 'chat.send',
          code: 'handler-failed',
          message: text,
        })
      })
    },
  ],
  [
    'a string inside the summary of an error that is part of an event',
    (text) => {
      const { log } = openLog({ packaged: true })
      log.remember(VALUE)
      return took(() => {
        log.write('error', {
          event: 'main.uncaught',
          origin: 'uncaughtException',
          error: { name: 'Error', message: text },
        })
      })
    },
  ],
  [
    'the text of a line',
    (text) => {
      const { log } = openLog({ packaged: true })
      log.remember(VALUE)
      return took(() => {
        log.line('kernel', 'error')(text)
      })
    },
  ],
  [
    'the first line of an interface error',
    (text) => {
      const { log } = openLog({ packaged: true })
      log.remember(VALUE)
      const renderer = fakeContents()
      watchRendererConsole(renderer.contents, log)
      return took(() => {
        renderer.emit({
          level: 'error',
          message: text,
          sourceId: 'file:///a/app.js',
          lineNumber: 1,
        })
      })
    },
  ],
  [
    'the source of an interface error',
    (text) => {
      const { log } = openLog({ packaged: true })
      log.remember(VALUE)
      const renderer = fakeContents()
      watchRendererConsole(renderer.contents, log)
      return took(() => {
        renderer.emit({ level: 'error', message: 'boom', sourceId: text, lineNumber: 1 })
      })
    },
  ],
  [
    'the message of an error summary',
    (text) => {
      const { log } = openLog({ packaged: true })
      log.remember(VALUE)
      return took(() => {
        summarizeError(new Error(text), log.redact)
      })
    },
  ],
  [
    'the name of an error summary',
    (text) => {
      const { log } = openLog({ packaged: true })
      log.remember(VALUE)
      return took(() => {
        summarizeError({ name: text, message: 'm' }, log.redact)
      })
    },
  ],
  [
    'the code of an error summary',
    (text) => {
      const { log } = openLog({ packaged: true })
      log.remember(VALUE)
      return took(() => {
        summarizeError({ code: text, message: 'm' }, log.redact)
      })
    },
  ],
  [
    'a frame of an error summary',
    (text) => {
      const { log } = openLog({ packaged: true })
      log.remember(VALUE)
      return took(() => {
        summarizeError({ message: 'm', stack: `Error: m\n    at ${text}` }, log.redact)
      })
    },
  ],
  [
    'a thrown value that is a string',
    (text) => {
      const { log } = openLog({ packaged: true })
      log.remember(VALUE)
      return took(() => {
        summarizeError(text, log.redact)
      })
    },
  ],
  [
    'the version, when the log is opened and on a line',
    (text) => {
      const { log, open } = openLog({ deferOpen: true, packaged: true, version: text })
      log.remember(VALUE)
      const opening = took(() => {
        open()
      })
      const line = took(() => {
        log.line('host', 'info')('an ordinary line')
      })
      return Math.max(opening, line)
    },
  ],
  [
    'the redact that the log offers',
    (text) => {
      const { log } = openLog({ packaged: true })
      log.remember(VALUE)
      return took(() => {
        log.redact(text)
      })
    },
  ],
  [
    'the copy of a line at the top of the file the log turns over to',
    (text) => {
      const { log, dir } = openLog({ packaged: true, maxBytes: 4_096 })
      log.remember(VALUE)
      log.write('info', { event: 'sandbox.posture', state: 'degraded', reasons: [text] })
      // The slowest call while it fills up to the turn-over is the one that makes the copy.
      let slowest = 0
      for (let i = 0; !existsSync(join(dir, 'main.1.jsonl')); i += 1) {
        slowest = Math.max(
          slowest,
          took(() => {
            log.line(`s${String(i).padStart(3, '0')}`, 'info')('z'.repeat(100))
          }),
        )
        expect(i).toBeLessThan(200)
      }
      return slowest
    },
  ],
  [
    'a line that only the terminal of a development build gets: held back by the cap',
    (text) => {
      const { log } = openLog({ packaged: false })
      log.remember(VALUE)
      for (let i = 0; i < 60; i += 1) log.line('host', 'warn')(`host ${i}`)
      return took(() => {
        log.line('host', 'warn')(text)
      })
    },
  ],
  [
    'a line that only the terminal of a development build gets: written after the close',
    (text) => {
      const { log } = openLog({ packaged: false })
      log.remember(VALUE)
      log.close()
      return took(() => {
        log.line('host', 'warn')(text)
      })
    },
  ],
  [
    'a line the terminal of a development build is given a copy of',
    (text) => {
      const { log } = openLog({ packaged: false })
      log.remember(VALUE)
      return took(() => {
        log.line('host', 'warn')(text)
      })
    },
  ],
]

it(
  'error-logs 验收 3: 复现 every way a string gets into redaction is bounded: a registered value of 4096 characters and a text of 1 MB take under 200 ms',
  { timeout: 600_000 },
  () => {
    const over: Array<[string, number]> = []
    for (const [name, run] of ENTRIES) {
      const ms = leastOf(() => run(nearMiss(MEGABYTE)))
      // Every one named with its time, so the failure shows which is slow and by how much.
      if (ms >= BUDGET_MS) over.push([name, Math.round(ms)])
    }
    expect(over).toEqual([])
  },
)

// ---- what is cut, and what it says ---------------------------------------------------------------

it('error-logs 验收 2: the …(+N) of a field counts the whole text, not what was left after the cut to 4096: 4096, 4097, 20 000 and 1 MB characters', () => {
  const { log, dir } = openLog({ packaged: true })
  for (const length of [4_096, 4_097, 20_000, MEGABYTE]) {
    log.line(`s${length}`, 'info')('x'.repeat(length))
  }
  expect(lineTexts(dir)).toEqual([
    `${'x'.repeat(2_000)}…(+2096)`,
    `${'x'.repeat(2_000)}…(+2097)`,
    `${'x'.repeat(2_000)}…(+18000)`,
    `${'x'.repeat(2_000)}…(+998000)`,
  ])
})

it('error-logs 验收 2: the …(+N) of each cut counts the whole text: an event field, an interface error, an error summary and the version, over 1 MB', () => {
  const text = 'x'.repeat(MEGABYTE)
  const { log, dir, open } = openLog({
    deferOpen: true,
    packaged: true,
    version: 'v'.repeat(MEGABYTE),
  })
  open()
  log.write('warn', {
    event: 'ipc.failed',
    channel: 'chat.send',
    code: 'handler-failed',
    message: text,
  })
  const renderer = fakeContents()
  watchRendererConsole(renderer.contents, log)
  renderer.emit({ level: 'error', message: text, sourceId: text, lineNumber: 7 })

  const records = readRecords(join(dir, 'main.jsonl'))
  expect(records.find((r) => r.event === 'ipc.failed')?.['message']).toBe(
    `${'x'.repeat(2_000)}…(+998000)`,
  )
  expect(records.find((r) => r.event === 'renderer.error')).toMatchObject({
    message: `${'x'.repeat(300)}…(+999700)`,
    source: `${'x'.repeat(200)}…(+999800)`,
  })
  // The version is cut to 200 in the file and in the marker alike.
  const version = `${'v'.repeat(200)}…(+999800)`
  expect(records.map((r) => r.ver)).toEqual(records.map(() => version))
  expect(JSON.parse(readText(join(dir, 'running.json'))) as { version: string }).toMatchObject({
    version,
  })

  expect(summarizeError(new Error(text), log.redact)).toMatchObject({
    name: 'Error',
    message: `${'x'.repeat(500)}…(+999500)`,
  })
  expect(summarizeError({ message: 'm', stack: `Error: m\n    at ${text}` }, log.redact)).toEqual({
    name: 'NonError',
    message: 'm',
    frames: [`at ${'x'.repeat(297)}…(+999703)`],
  })
  expect(summarizeError({ name: text, message: 'm' }, log.redact).name).toBe(
    `${'x'.repeat(200)}…(+999800)`,
  )
})

it('error-logs 验收 3: 复现 the text that redact is given is cut to 4096 characters first, a value cut by it is taken out like one cut upstream, and a pair of surrogates is not split', () => {
  const { log } = openLog({ packaged: true })
  const secret = 'Zq4#vT8!mW2$nX6@kR9%'
  log.remember(secret)
  const filler = 'x'.repeat(4_096 - secret.length)
  // Exactly 4096: all of it is looked at, and nothing is cut.
  expect(log.redact(`${filler}${secret}`)).toBe(`${filler}[redacted]`)
  expect(log.redact('y'.repeat(4_096))).toBe('y'.repeat(4_096))
  // One more: that one is left out, and said so.
  expect(log.redact(`${filler}${secret}z`)).toBe(`${filler}[redacted]…(+1)`)
  expect(log.redact('y'.repeat(4_097))).toBe(`${'y'.repeat(4_096)}…(+1)`)
  // The cut falls inside the secret: what is left of it is no more to be seen than what an upstream cut leaves.
  const inside = `${'x'.repeat(4_096 - 12)}${secret}tail`
  expect(log.redact(inside)).toBe(`${'x'.repeat(4_096 - 12)}[redacted]…(+12)`)
  // The cut would fall between the two halves of a pair: it falls before the pair.
  expect(log.redact(`${'x'.repeat(4_095)}\u{1F600}y`)).toBe(`${'x'.repeat(4_095)}…(+3)`)
})

// ---- what is registered --------------------------------------------------------------------------

it('error-logs 验收 3: 复现 a value of 4096 characters is registered whole and one of 4097 by its first 4096: both are taken out of a text that is cut', () => {
  const longest = secretOf(4_096)
  {
    const { log, dir } = openLog({ packaged: true })
    log.remember(longest)
    log.line('host', 'warn')(longest)
    expect(lineTexts(dir)).toEqual(['[redacted]'])
  }
  {
    // One character longer: registered by its first 4096, which is what a text is cut to.
    const tooLong = `${longest}q`
    const { log, dir } = openLog({ packaged: true })
    log.remember(tooLong)
    log.line('host', 'warn')(tooLong)
    // Another text that begins with the same 4096 characters is taken out as well (spec §已知限制).
    log.line('host', 'warn')(`${longest}zzzz`)
    expect(lineTexts(dir)).toEqual(['[redacted]…(+1)', '[redacted]…(+4)'])
  }
})

it('error-logs 验收 3: 复现 a value of 1 MB is registered by its first 4096 characters: registering it takes under 200 ms, and as the text of a line it is taken out', () => {
  const { log, dir } = openLog({ packaged: true })
  const huge = secretOf(MEGABYTE)
  const registering = took(() => {
    log.remember(huge)
  })
  log.line('host', 'warn')(huge)
  expect(registering).toBeLessThan(BUDGET_MS)
  expect(lineTexts(dir)).toEqual(['[redacted]…(+995904)'])
  expect(leaksIn(dir, fragmentsOf(huge.slice(0, 4_096))).slice(0, 3)).toEqual([])
})

for (const [size, length] of [
  ['4097 characters', 4_097],
  ['1 MB', MEGABYTE],
] as const) {
  it(`error-logs 验收 3: 复现 a registered value of ${size} leaves no 8 characters of itself in the log: at the start of a text, well into it, and where the cut falls`, () => {
    const value = secretOf(length)
    const { log, dir } = openLog({ packaged: true })
    log.remember(value)
    const expected: string[] = []
    // How much of the value is inside the first 4096 characters of the text.
    for (const shown of [4_096, 3_096, 20, 8]) {
      const before = shown === 4_096 ? '' : collapsing(4_096 - shown)
      const text = `${before}${value} and then some`
      log.line(`s${shown}`, 'warn')(text)
      expected.push(
        `${before === '' ? '' : 'Authorization: [redacted]\n'}[redacted]…(+${text.length - 4_096})`,
      )
    }
    expect(leaksIn(dir, fragmentsOf(value.slice(0, 4_096))).slice(0, 3)).toEqual([])
    expect(lineTexts(dir)).toEqual(expected)
  })
}

it('error-logs 验收 3: 复现 what an upstream cut leaves of a value longer than 4096 characters is taken out when it is 8 or more characters of its start; 7 are ordinary text', () => {
  const value = secretOf(MEGABYTE)
  const { log, dir } = openLog({ packaged: true })
  log.remember(value)
  for (const length of [8, 30, 4_000]) {
    log.line('kernel', 'error')(`gateway said: ${value.slice(0, length)}…`)
  }
  log.line('kernel', 'error')(`gateway said: ${value.slice(0, 7)}…`)
  expect(lineTexts(dir)).toEqual([
    'gateway said: [redacted]…',
    'gateway said: [redacted]…',
    'gateway said: [redacted]…',
    `gateway said: ${value.slice(0, 7)}…`,
  ])
  expect(leaksIn(dir, fragmentsOf(value.slice(0, 4_096)))).toEqual([])
})

// ---- the spellings --------------------------------------------------------------------------------

it('error-logs 验收 3: 复现 a spelling longer than 4096 characters is registered by its first 4096: base64 of 13 000 characters, of 4096, URL-encoded 4096 Chinese characters, and the value followed by its base64', () => {
  const chinese = Array.from({ length: 4_096 }, (_, i) =>
    String.fromCodePoint(0x4e00 + ((i * 7_919) % 20_000)),
  ).join('')
  const long = secretOf(13_000)
  const mid = secretOf(10_000, 7)
  const full = secretOf(4_096, 11)
  const cases: Array<{ name: string; text: string; value: string; line: string }> = [
    {
      name: 'base64 of a value of 13 000 characters: 17 336',
      value: long,
      text: base64(long),
      line: `[redacted]…(+${base64(long).length - 4_096})`,
    },
    {
      name: 'URL-encoded 4096 Chinese characters: 36 864',
      value: chinese,
      text: encodeURIComponent(chinese),
      line: `[redacted]…(+${encodeURIComponent(chinese).length - 4_096})`,
    },
    {
      name: 'base64 of a value of 4096 characters: 5464',
      value: full,
      text: base64(full),
      line: `[redacted]…(+${base64(full).length - 4_096})`,
    },
    {
      name: 'a value of 10 000 characters, then its base64 (which the cut keeps none of)',
      value: mid,
      text: `token ${mid} as base64 ${base64(mid)}`,
      line: `token [redacted]…(+${`token ${mid} as base64 ${base64(mid)}`.length - 4_096})`,
    },
  ]
  const seen: Array<[string, unknown[], string[]]> = []
  for (const { name, value, text } of cases) {
    const { log, dir } = openLog({ packaged: true })
    log.remember(value)
    log.line('host', 'warn')(text)
    // Of the value and of the text, the first 4096 characters are all that is looked at.
    const shown = [value.slice(0, 4_096), text.slice(0, 4_096)]
    seen.push([
      name,
      lineTexts(dir),
      leaksIn(
        dir,
        shown.flatMap((one) => fragmentsOf(one)),
      ).slice(0, 3),
    ])
  }
  expect(seen).toEqual(cases.map(({ name, line }) => [name, [line], []]))
})

it('error-logs 验收 3: 复现 what the cut leaves of a spelling of a registered value is taken out like what it leaves of the value: each spelling, at the cut of 4096 and in a field cut upstream', () => {
  // A quote and a backslash early on, so that no spelling begins as the value does.
  const key = 'Zq4"#vT8\\!mW2$nX6@kR9%Lp3^Hs7&Jd5*Fb1(Cn0)Gy2+Qw8=Re4~Ut6'
  const padded = base64(key)
  const spellings: ReadonlyArray<readonly [string, string]> = [
    ['base64', padded],
    ['base64 without the padding', padded.replace(/=+$/u, '')],
    ['URL-safe base64', padded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')],
    ['URL-encoded', encodeURIComponent(key)],
    ['JSON-escaped', JSON.stringify(key).slice(1, -1)],
  ]
  const { log, dir } = openLog({ packaged: true })
  log.remember(key)
  const wanted: Array<[string, string]> = []
  for (const [name, spelling] of spellings) {
    // 40 and 8 characters of the spelling are inside the first 4096 characters of the text.
    for (const inside of [40, 8]) {
      const text = `${collapsing(4_096 - 4 - inside)}key=${spelling}`
      log.line('host', 'warn')(text)
      wanted.push([
        `${name}, ${inside} inside`,
        `Authorization: [redacted]\nkey=[redacted]…(+${spelling.length - inside})`,
      ])
    }
    // The kernel cuts a vendor's text and adds a `…`: 24 characters of the spelling are left.
    log.line('kernel', 'error')(`gateway said: ${spelling.slice(0, 24)}…`)
    wanted.push([`${name}, cut upstream`, 'gateway said: [redacted]…'])
  }
  const seen = lineTexts(dir).map((text, i) => [wanted[i]?.[0] ?? '(one too many)', String(text)])
  expect(seen).toEqual(wanted)
  const windows = spellings.flatMap(([, spelling]) => fragmentsOf(spelling))
  expect(leaksIn(dir, windows)).toEqual([])
})
