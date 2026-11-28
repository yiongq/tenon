/**
 * The table of registered secrets and what a cut leaves of one (docs/features/error-logs/spec.md
 * §怎么写「登记表有上限」「字段以截断结尾…」, §脱敏 层 2; acceptance 3): at most 10 000 values, the
 * oldest let go, a value registered again taking no place, registering not growing slower and
 * slower, and the tail of a field cut upstream that is the start of a registered value.
 *
 * A real `createAppLog` on real temp folders; nothing is faked. Values are plain strings of 17
 * characters that no generic token format would catch, so when one is taken out it was registered.
 * A case whose name says 复现 reproduces a finding of the segment-1 review (the three reviews of
 * 2026-11-28) and fails until that finding is fixed.
 */
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CUT_500, fragmentsOf } from './support/error-logs-sentinels.js'
import { leaksIn, openLog, readRecords, sweepTempRoots } from './support/error-logs.js'

afterEach(sweepTempRoots)

const secret = (i: number): string => `cap-secret-${String(i).padStart(6, '0')}`

it(
  'error-logs 验收 3: 复现 the table holds 10 000 values: the oldest is let go on the 10 001st, the newest and the one before stay, and a value registered again takes no place',
  { timeout: 120_000 },
  () => {
    const { log } = openLog({ packaged: true })
    // The first value is registered fifty times over; it is still one place.
    for (let again = 0; again < 50; again += 1) log.remember(secret(0))
    for (let i = 1; i < 10_000; i += 1) log.remember(secret(i))
    // 10 000 different values: every one is still taken out, the first and the last included.
    expect(log.redact(`a ${secret(0)} b`)).toBe('a [redacted] b')
    expect(log.redact(`a ${secret(1)} b`)).toBe('a [redacted] b')
    expect(log.redact(`a ${secret(9_999)} b`)).toBe('a [redacted] b')

    // The 10 001st: the first registered goes, nothing else does.
    log.remember(secret(10_000))
    expect(log.redact(`a ${secret(0)} b`)).toBe(`a ${secret(0)} b`)
    expect(log.redact(`a ${secret(1)} b`)).toBe('a [redacted] b')
    expect(log.redact(`a ${secret(5_000)} b`)).toBe('a [redacted] b')
    expect(log.redact(`a ${secret(10_000)} b`)).toBe('a [redacted] b')
  },
)

it(
  'error-logs 验收 3: 复现 registering 10 001 values takes well under three seconds',
  { timeout: 120_000 },
  () => {
    const { log } = openLog({ packaged: true })
    const began = performance.now()
    for (let i = 0; i < 10_001; i += 1) log.remember(secret(i))
    const took = performance.now() - began
    // An ordinary machine does this in a few tens of milliseconds; a table that is sorted whole at
    // every registration needs five seconds or more. The bound only has to tell the two apart.
    expect(took).toBeLessThan(3_000)
  },
)

it('error-logs 验收 3: 复现 a field cut upstream that ends with 8 or more characters of the start of a registered value loses that tail; 7 are ordinary text', () => {
  const { log, dir } = openLog({ packaged: true })
  log.remember(CUT_500)
  // The kernel cuts a vendor's error text at 500 characters and adds a `…`: what is left of a
  // secret it did not know is its start.
  for (const length of [8, 15, CUT_500.length - 1]) {
    log.line('kernel', 'error')(`gateway said: ${CUT_500.slice(0, length)}…`)
  }
  log.line('kernel', 'error')(`gateway said: ${CUT_500.slice(0, 7)}…`)

  const texts = readRecords(join(dir, 'main.jsonl')).map((r) => String(r['text']))
  for (const text of texts.slice(0, 3)) expect(text).toMatch(/^gateway said: \[redacted\]…?$/u)
  expect(texts[3]).toBe(`gateway said: ${CUT_500.slice(0, 7)}…`)
  // No window of 8 characters of the secret is anywhere in the files.
  expect(leaksIn(dir, fragmentsOf(CUT_500))).toEqual([])
})
