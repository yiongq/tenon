/**
 * What an error nobody caught in the main process leaves in the log (docs/features/error-logs/
 * spec.md §记什么「主进程没接住的错」, §一直要成立的规矩 第 12 条; acceptance 9): a line for an
 * exception through Node's `uncaughtExceptionMonitor` and one for a lone Promise rejection through
 * an `unhandledRejection` listener, and never an `uncaughtException` listener, which would take
 * Electron's own error box away (P2). The real thing, the box included, is the e2e case of the
 * same number (`e2e/error-logs-process.spec.ts`).
 *
 * `watchUncaught` is given a stand-in for Node's `process`: an EventEmitter. It reproduces the
 * parts of the real one the watcher depends on (evidence.md E4, P2):
 *
 *  1. `uncaughtExceptionMonitor` calls its listener with `(error, origin)`, where `origin` is
 *     'uncaughtException' or 'unhandledRejection'; the monitor only watches, it changes nothing
 *     about what Node and Electron then do.
 *  2. `unhandledRejection` calls its listener with `(reason, promise)`, and `reason` is whatever
 *     was rejected with: an Error, a string, undefined.
 *  3. EventEmitter does not guard a listener: one that throws would throw into the emit, which in
 *     the real process is a second uncaught error from inside the handler of the first. So the
 *     tests emit things a careless watcher would trip over and expect no throw.
 *  4. `listenerCount` and `eventNames` tell what was registered. In the real process Electron's own
 *     `uncaughtException` listener is one of them; here there is none, so "registers no
 *     `uncaughtException` listener" reads as zero.
 */
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { HOME, leaksIn, openLog, readRecords, sweepTempRoots } from './support/error-logs.js'
import type { LogRecord } from './support/error-logs.js'
import { watchUncaught } from './support/error-logs-seg2.js'

afterEach(sweepTempRoots)

const uncaught = (dir: string) =>
  readRecords(join(dir, 'main.jsonl')).filter((record) => record.event === 'main.uncaught')

/** The error an `Error` summary holds, as the record carries it. */
interface Summary {
  readonly name: string
  readonly message: string
  readonly frames?: readonly string[]
}

/** The summary of the error in a `main.uncaught` line. */
const summaryOf = (line: LogRecord | undefined): Summary => line?.['error'] as Summary

it('error-logs 验收 9: watchUncaught listens to the monitor and to unhandledRejection, and never to uncaughtException', () => {
  const { log } = openLog({ packaged: true })
  const proc = new EventEmitter()
  watchUncaught(proc, log)
  expect(proc.listenerCount('uncaughtExceptionMonitor')).toBe(1)
  expect(proc.listenerCount('unhandledRejection')).toBe(1)
  // A listener of `uncaughtException` would end Electron's own error box (P2); and nothing else
  // is listened to either.
  expect(proc.listenerCount('uncaughtException')).toBe(0)
  expect([...proc.eventNames()].map(String).toSorted()).toEqual([
    'uncaughtExceptionMonitor',
    'unhandledRejection',
  ])
})

it('error-logs 验收 9: an exception is one error line from uncaughtException with the error summarized, whatever origin the monitor names', () => {
  const { log, dir } = openLog({ packaged: true })
  const proc = new EventEmitter()
  watchUncaught(proc, log)

  const error = new RangeError(`E2E_BOOM while reading ${HOME}/projects/x`)
  proc.emit('uncaughtExceptionMonitor', error, 'uncaughtException')
  // The origin is the event that fired, not the argument (spec §接口: 来源按哪个事件触发来定).
  proc.emit('uncaughtExceptionMonitor', new Error('E2E_SECOND'), 'unhandledRejection')

  const lines = uncaught(dir)
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatchObject({
    level: 'error',
    event: 'main.uncaught',
    origin: 'uncaughtException',
  })
  const first = summaryOf(lines[0])
  expect(first.name).toBe('RangeError')
  // Redacted before it is written: the home folder reads ~.
  expect(first.message).toBe('E2E_BOOM while reading ~/projects/x')
  // Frames: the first ten at most, each a stack line.
  const frames = first.frames ?? []
  expect(frames.length).toBeGreaterThanOrEqual(1)
  expect(frames.length).toBeLessThanOrEqual(10)
  expect(frames.every((frame) => frame.trimStart().startsWith('at '))).toBe(true)
  expect(lines[1]).toMatchObject({ origin: 'uncaughtException' })
  expect(summaryOf(lines[1]).message).toBe('E2E_SECOND')
})

it('error-logs 验收 9: a lone rejection is one error line from unhandledRejection, whatever was rejected with', () => {
  const { log, dir } = openLog({ packaged: true })
  const proc = new EventEmitter()
  watchUncaught(proc, log)

  const promise = Promise.resolve()
  proc.emit('unhandledRejection', new TypeError('E2E_REJECTED'), promise)
  // A rejection with something that is not an error: Node hands it over as it is.
  const odd: unknown[] = ['E2E_A_STRING', undefined, null, 42, { not: 'an error' }]
  for (const reason of odd) {
    expect(() => proc.emit('unhandledRejection', reason, promise)).not.toThrow()
  }

  const lines = uncaught(dir)
  expect(lines).toHaveLength(1 + odd.length)
  for (const line of lines) {
    expect(line).toMatchObject({ level: 'error', origin: 'unhandledRejection' })
  }
  const first = summaryOf(lines[0])
  expect(first).toMatchObject({ name: 'TypeError', message: 'E2E_REJECTED' })
  // A string reason is kept, in the message.
  expect(summaryOf(lines[1]).message).toContain('E2E_A_STRING')
})

it('error-logs 验收 9: what the watcher is given is redacted by the log: a registered secret in the message is not written', () => {
  const SECRET = 'wrong-key-main-uncaught-QK7Z2'
  const { log, dir } = openLog({ packaged: true })
  log.remember(SECRET)
  const proc = new EventEmitter()
  watchUncaught(proc, log)
  proc.emit(
    'uncaughtExceptionMonitor',
    new Error(`request failed for ${SECRET}`),
    'uncaughtException',
  )
  proc.emit('unhandledRejection', new Error(`rejected ${SECRET}`), Promise.resolve())
  expect(uncaught(dir)).toHaveLength(2)
  expect(leaksIn(dir, [SECRET])).toEqual([])
})

it('error-logs 验收 9: an error that cannot be read does not make the watcher throw', () => {
  const { log, dir } = openLog({ packaged: true })
  const proc = new EventEmitter()
  watchUncaught(proc, log)
  // A getter that throws and a proxy that refuses: the shapes `summarizeError` is for.
  const hostile = {
    get message(): string {
      throw new Error('no message for you')
    },
  }
  const refusing = new Proxy(
    {},
    {
      get: () => {
        throw new Error('no')
      },
    },
  )
  expect(() => proc.emit('uncaughtExceptionMonitor', hostile, 'uncaughtException')).not.toThrow()
  expect(() => proc.emit('unhandledRejection', refusing, Promise.resolve())).not.toThrow()
  expect(uncaught(dir)).toHaveLength(2)
})
