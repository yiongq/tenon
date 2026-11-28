/**
 * How much work taking a secret out of a string may cost (docs/features/error-logs/spec.md §怎么写
 * 「脱敏的工作量有上界」, §脱敏 层 2; acceptance 2 and 3): every string that goes into redaction is
 * cut to 16 384 characters first, with the `…(+N)` of what was left out counted over the whole text,
 * and a value (or a spelling of one) longer than that is not registered. With a registered value of
 * 4096 characters and a text of 1 MB, writing a line stays within 200 ms.
 *
 * A real `createAppLog` on real temp folders; only the clock is driven by hand. The text the
 * timing cases use is the worst a registered value of 4096 characters can meet: one that is one
 * character short of the value at every position (4095 `A` and a `B`, over and over), and one that
 * is the value at every position (all `A`). The 200 ms is the spec's; an ordinary machine does the
 * bounded work in about a tenth of a second at most, and the unbounded one in seconds, so the bound
 * only has to tell the two apart. A case whose name says 复现 reproduces the finding of the third
 * review of segment one (the major about the cost of a lookup) and fails until it is fixed.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
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

/** Milliseconds one call takes. */
function took(action: () => void): number {
  const began = performance.now()
  action()
  return performance.now() - began
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
    const written: unknown[] = []
    for (const [shape, text] of [
      ['one character short of the value at every position', nearMiss(MEGABYTE)],
      ['the value at every position', everywhere(MEGABYTE)],
    ] as const) {
      const { log, dir } = openLog({ packaged: true })
      log.remember(VALUE)
      const ms = took(() => {
        log.line('host', 'warn')(text)
      })
      if (ms >= BUDGET_MS) slow.push([shape, Math.round(ms)])
      written.push(...lineTexts(dir))
    }
    expect(slow).toEqual([])
    // No match anywhere in the first: the first 2000 characters and the count of the rest. The
    // second is the value over and over: taken out, and no run of it is left.
    expect(written[0]).toBe(`${nearMiss(2_000)}…(+998000)`)
    expect(String(written[1])).not.toContain('AAAAAAAA')
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
      const ms = run(nearMiss(MEGABYTE))
      // Every one named with its time, so the failure shows which is slow and by how much.
      if (ms >= BUDGET_MS) over.push([name, Math.round(ms)])
    }
    expect(over).toEqual([])
  },
)

// ---- what is cut, and what it says ---------------------------------------------------------------

it('error-logs 验收 2: the …(+N) of a field counts the whole text, not what was left after the cut to 16 384: 16 384, 16 385, 20 000 and 1 MB characters', () => {
  const { log, dir } = openLog({ packaged: true })
  for (const length of [16_384, 16_385, 20_000, MEGABYTE]) {
    log.line(`s${length}`, 'info')('x'.repeat(length))
  }
  expect(lineTexts(dir)).toEqual([
    `${'x'.repeat(2_000)}…(+14384)`,
    `${'x'.repeat(2_000)}…(+14385)`,
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

it('error-logs 验收 3: 复现 the text that redact is given is cut to 16 384 characters first, a value cut by it is taken out like one cut upstream, and a pair of surrogates is not split', () => {
  const { log } = openLog({ packaged: true })
  const secret = 'Zq4#vT8!mW2$nX6@kR9%'
  log.remember(secret)
  const filler = 'x'.repeat(16_384 - secret.length)
  // Exactly 16 384: all of it is looked at, and nothing is cut.
  expect(log.redact(`${filler}${secret}`)).toBe(`${filler}[redacted]`)
  expect(log.redact('y'.repeat(16_384))).toBe('y'.repeat(16_384))
  // One more: that one is left out, and said so.
  expect(log.redact(`${filler}${secret}z`)).toBe(`${filler}[redacted]…(+1)`)
  expect(log.redact('y'.repeat(16_385))).toBe(`${'y'.repeat(16_384)}…(+1)`)
  // The cut falls inside the secret: what is left of it is no more to be seen than what an upstream cut leaves.
  const inside = `${'x'.repeat(16_384 - 12)}${secret}tail`
  expect(log.redact(inside)).toBe(`${'x'.repeat(16_384 - 12)}[redacted]…(+12)`)
  // The cut would fall between the two halves of a pair: it falls before the pair.
  expect(log.redact(`${'x'.repeat(16_383)}\u{1F600}y`)).toBe(`${'x'.repeat(16_383)}…(+3)`)
})

// ---- what is registered --------------------------------------------------------------------------

it('error-logs 验收 3: 复现 a value of 16 384 characters is registered and one of 16 385 is not', () => {
  const longest = 'Qk7#mP9z'.repeat(2_048)
  expect(longest).toHaveLength(16_384)
  {
    const { log, dir } = openLog({ packaged: true })
    log.remember(longest)
    log.line('host', 'warn')(longest)
    expect(lineTexts(dir)).toEqual(['[redacted]'])
  }
  {
    // One character longer: not registered, so the text is what any long text is: cut to 2000.
    const tooLong = `${longest}q`
    const { log, dir } = openLog({ packaged: true })
    log.remember(tooLong)
    log.line('host', 'warn')(tooLong)
    expect(lineTexts(dir)).toEqual([`${tooLong.slice(0, 2_000)}…(+14385)`])
  }
})

it('error-logs 验收 3: 复现 a value of 1 MB is not registered, and says no more than 2000 characters of itself when it is the text of a line', () => {
  const { log, dir } = openLog({ packaged: true })
  const huge = 'Qk7#mP9z'.repeat(125_000)
  const registering = took(() => {
    log.remember(huge)
  })
  log.line('host', 'warn')(huge)
  expect(registering).toBeLessThan(BUDGET_MS)
  expect(lineTexts(dir)).toEqual([`${huge.slice(0, 2_000)}…(+998000)`])
})
