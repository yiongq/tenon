/**
 * The table of registered secrets and what a cut leaves of one (docs/features/error-logs/spec.md
 * §怎么写「登记表有上限」「字段以截断结尾…」, §脱敏 层 2; acceptance 3): at most 10 000 values, the
 * one not registered for the longest time let go (D21), a value registered again taking no new place
 * but moving to the newest, looking a value up not slowing down however many registered values begin
 * alike, and the tail of a field cut upstream that is the start of a registered value.
 *
 * A real `createAppLog` on real temp folders; nothing is faked. Values are plain strings that no
 * generic token format would catch, so when one is taken out it was registered. A case whose name
 * says 复现 reproduces a finding of the segment-1 review (the three reviews of 2026-11-28, and the
 * recheck of f5a1784) and fails until that finding is fixed.
 */
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CUT_500, fragmentsOf } from './support/error-logs-sentinels.js'
import { leaksIn, openLog, readRecords, sweepTempRoots } from './support/error-logs.js'

afterEach(sweepTempRoots)

const secret = (i: number): string => `cap-secret-${String(i).padStart(6, '0')}`

it(
  'error-logs 验收 3: 复现 the table holds 10 000 values: the one registered longest ago is let go on the 10 001st, the newest and the one before stay, and a value registered again takes no new place',
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

    // The 10 001st: the one registered longest ago (the first, and not since) goes, nothing else does.
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

/** A 208-character value: ten thousand of these begin with the same 200 characters. */
const alike = (i: number): string => `${'A'.repeat(200)}${String(i).padStart(8, '0')}`

it(
  'error-logs 验收 3: 复现 ten thousand registered values that begin alike do not slow a field down: milliseconds to take one out of 2000 characters, under three seconds for 10 001 registrations',
  { timeout: 120_000 },
  () => {
    const { log } = openLog({ packaged: true })
    const began = performance.now()
    for (let i = 0; i < 10_001; i += 1) log.remember(alike(i))
    expect(performance.now() - began).toBeLessThan(3_000)

    // One of the values inside a field of 1 960 characters, and two fields that are not it: one ends
    // in what is not the start of any value, one ends in the start of all of them.
    const fields = [
      {
        field: `${'A'.repeat(1_700)}${alike(4_242)}${'z'.repeat(50)}`,
        expected: `${'A'.repeat(1_700)}[redacted]${'z'.repeat(50)}`,
      },
      { field: `${'A'.repeat(1_999)}B`, expected: `${'A'.repeat(1_999)}B` },
      { field: `x${'A'.repeat(1_950)}`, expected: `x${'A'.repeat(1_750)}[redacted]` },
    ]
    for (const { field, expected } of fields) {
      const started = performance.now()
      const redacted = log.redact(field)
      const took = performance.now() - started
      expect(redacted).toBe(expected)
      // An ordinary machine takes a millisecond or two; looking at every value that shares the
      // first 8 characters takes seconds. The bound only has to tell the two apart.
      expect(took).toBeLessThan(200)
    }
  },
)

it(
  'error-logs 验收 3: 复现 a value registered again moves to the newest: with the table full, the one let go is the one registered longest ago',
  { timeout: 120_000 },
  () => {
    const { log } = openLog({ packaged: true })
    for (let i = 0; i < 10_000; i += 1) log.remember(secret(i))
    // The first value is read again: it is the newest now and takes no new place.
    log.remember(secret(0))
    log.remember(secret(10_000))
    expect(log.redact(`a ${secret(0)} b`)).toBe('a [redacted] b')
    // The second is the one that has gone the longest without being registered.
    expect(log.redact(`a ${secret(1)} b`)).toBe(`a ${secret(1)} b`)
    expect(log.redact(`a ${secret(2)} b`)).toBe('a [redacted] b')
    expect(log.redact(`a ${secret(10_000)} b`)).toBe('a [redacted] b')
  },
)

it(
  'error-logs 验收 3: 复现 the order of letting go is that of the last registration: the half read again lives, the half that was not goes',
  { timeout: 120_000 },
  () => {
    const { log } = openLog({ packaged: true })
    for (let i = 0; i < 10_000; i += 1) log.remember(secret(i))
    for (let i = 0; i < 5_000; i += 1) log.remember(secret(i))
    for (let i = 10_000; i < 15_000; i += 1) log.remember(secret(i))
    const taken = (i: number): boolean => log.redact(`a ${secret(i)} b`) === 'a [redacted] b'
    expect([0, 4_999, 5_000, 9_999, 10_000, 14_999].map(taken)).toEqual([
      true,
      true,
      false,
      false,
      true,
      true,
    ])
  },
)

it('error-logs 验收 3: registered values that overlap are one replacement: one inside another, two that share an edge, a chain', () => {
  const cases = [
    {
      values: ['GGGGGGGG', 'XXXXXXXXGGGGGGGGYYYYYYYYYY'],
      field: 'a XXXXXXXXGGGGGGGGYYYYYYYYYY b',
    },
    {
      values: ['XXXXXXXXGGGGGGGGYYYYYYYYYY', 'GGGGGGGG'],
      field: 'a XXXXXXXXGGGGGGGGYYYYYYYYYY b',
    },
    { values: ['XXXXYYYY1234', '1234ZZZZWWWW'], field: 'a XXXXYYYY1234ZZZZWWWW b' },
    {
      values: ['AAAABBBB1111', '1111CCCCDDDD', 'DDDDEEEEFFFF'],
      field: 'a AAAABBBB1111CCCCDDDDEEEEFFFF b',
    },
  ]
  for (const { values, field } of cases) {
    const { log } = openLog({ packaged: true })
    for (const value of values) log.remember(value)
    expect([field, log.redact(field)]).toEqual([field, 'a [redacted] b'])
  }
})

it('error-logs 验收 3: the cut mark after a tail that is taken out stays as it was: `…`, `…(+N)`, or none', () => {
  const { log } = openLog({ packaged: true })
  log.remember(CUT_500)
  const tail = CUT_500.slice(0, 20)
  expect(log.redact(`gateway said: ${tail}…`)).toBe('gateway said: [redacted]…')
  expect(log.redact(`gateway said: ${tail}…(+4096)`)).toBe('gateway said: [redacted]…(+4096)')
  expect(log.redact(`gateway said: ${tail}`)).toBe('gateway said: [redacted]')
})

const lone = (i: number): string => `${String(i).padStart(8, '0')}-lone-value`
const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64')

it(
  'error-logs 验收 3: the value let go is let go everywhere: not whole, not in another spelling, and its start is no longer taken out of a cut field',
  { timeout: 120_000 },
  () => {
    const { log } = openLog({ packaged: true })
    for (let i = 0; i <= 10_000; i += 1) log.remember(lone(i))
    const gone = lone(0)
    const kept = lone(1)
    // `gone` was let go by the 10 001st; `kept` was not.
    for (const form of [gone, base64(gone), JSON.stringify(gone).slice(1, -1)]) {
      expect([form, log.redact(`a ${form} b`)]).toEqual([form, `a ${form} b`])
    }
    expect(log.redact(`gateway said: ${gone.slice(0, 12)}…`)).toBe(
      `gateway said: ${gone.slice(0, 12)}…`,
    )
    expect(log.redact(`a ${kept} b`)).toBe('a [redacted] b')
    expect(log.redact(`a ${base64(kept)} b`)).toBe('a [redacted] b')
    expect(log.redact(`gateway said: ${kept.slice(0, 12)}…`)).toBe('gateway said: [redacted]…')
  },
)

it(
  'error-logs 验收 3: a value that shares most of its start with the one let go is still found whole afterwards, in each spelling, and its start is still taken out of a cut field',
  { timeout: 120_000 },
  () => {
    const { log } = openLog({ packaged: true })
    const first = 'twin-prefix-first-0001'
    const twin = 'twin-prefix-second-0002'
    log.remember(first)
    log.remember(twin)
    // 9 999 more make 10 001: the first is let go, and the twin, which shares its start, stays.
    for (let i = 1; i <= 9_999; i += 1) log.remember(lone(i))
    expect(log.redact(`a ${first} b`)).toBe(`a ${first} b`)
    for (const form of [twin, base64(twin), JSON.stringify(twin).slice(1, -1)]) {
      expect([form, log.redact(`a ${form} b`)]).toEqual([form, 'a [redacted] b'])
    }
    expect(log.redact(`gateway said: ${twin.slice(0, 16)}…`)).toBe('gateway said: [redacted]…')
    expect(log.redact(`gateway said: ${first.slice(0, 16)}…`)).toBe(
      `gateway said: ${first.slice(0, 16)}…`,
    )
  },
)

it('error-logs 验收 3: a field that is exactly one registered 8-character value is taken out whole', () => {
  const { log, dir } = openLog({ packaged: true })
  log.remember('Qk7#mP9z')
  expect(log.redact('Qk7#mP9z')).toBe('[redacted]')
  expect(log.redact('x Qk7#mP9z')).toBe('x [redacted]')
  log.line('host', 'info')('Qk7#mP9z')
  expect(readRecords(join(dir, 'main.jsonl')).map((r) => r['text'])).toEqual(['[redacted]'])
})

it('error-logs 验收 3: 复现 what an upstream cut leaves of a value that begins with another registered value is taken out whole, whichever was registered first', () => {
  const short = 'Kp7w-tenant-key-01'
  const long = `${short}Rr4xTt8vWw2y-Uu5z`
  for (const values of [
    [short, long],
    [long, short],
  ]) {
    const { log, dir } = openLog({ packaged: true })
    for (const value of values) log.remember(value)
    // The shorter value is found inside the cut text and taken out; the rest of the longer one, which
    // is no start of anything and no whole value any more, must go with it.
    log.line('kernel', 'error')(`gateway said: ${long.slice(0, 30)}…`)
    log.line('kernel', 'error')(`gateway said: ${long.slice(0, 30)}…(+120)`)
    log.line('kernel', 'error')(`gateway said: ${long.slice(0, 30)}`)
    log.line('kernel', 'error')(`gateway said: ${long}`)
    const texts = readRecords(join(dir, 'main.jsonl')).map((r) => String(r['text']))
    expect(texts).toEqual([
      'gateway said: [redacted]…',
      'gateway said: [redacted]…(+120)',
      'gateway said: [redacted]',
      'gateway said: [redacted]',
    ])
    expect(leaksIn(dir, fragmentsOf(long))).toEqual([])
  }
})

it('error-logs 验收 3: 复现 what an upstream cut leaves of a value that begins with the last character of another registered value is taken out whole', () => {
  const first = 'Hm3x-first-value-Q'
  const second = 'Q-second-value-Yz9'
  const { log, dir } = openLog({ packaged: true })
  log.remember(first)
  log.remember(second)
  // The two share the `Q`: the first is found whole, the second begins inside it and is cut at 16.
  log.line('kernel', 'error')(`gateway said: ${first}${second.slice(1, 16)}…`)
  expect(readRecords(join(dir, 'main.jsonl')).map((r) => r['text'])).toEqual([
    'gateway said: [redacted]…',
  ])
  expect(leaksIn(dir, fragmentsOf(second))).toEqual([])
})

const taken = (log: { redact(text: string): string }, text: string): boolean =>
  log.redact(`a ${text} b`) === 'a [redacted] b'

it(
  'error-logs 验收 3: two registered values that are written alike share the spelling: while one of them stays the spelling is taken out, when both are gone it is not',
  { timeout: 120_000 },
  () => {
    // `again` is the base64 of `plain`: it is one of the spellings of `plain` and a value of its own.
    const plain = 'refcount-key-0001-AB'
    const again = 'cmVmY291bnQta2V5LTAwMDEtQUI='
    const orders: Array<readonly [string, string]> = [
      [plain, again],
      [again, plain],
    ]
    for (const [older, newer] of orders) {
      const { log } = openLog({ packaged: true })
      log.remember(older)
      log.remember(newer)
      // 9 998 more make 10 000: nothing is let go yet.
      for (let i = 1; i <= 9_998; i += 1) log.remember(lone(i))
      expect([older, taken(log, again), taken(log, plain)]).toEqual([older, true, true])
      // One more lets the older one go: the spelling stays, for the newer one still has it.
      log.remember(lone(9_999))
      expect([older, taken(log, again)]).toEqual([older, true])
      // One more lets the newer go: nobody has the spelling now.
      log.remember(lone(10_000))
      expect([older, taken(log, again), taken(log, plain)]).toEqual([older, false, false])
    }
  },
)

it(
  'error-logs 验收 3: the start that values share is taken out of a cut field while one of them is registered, and not once the last has been let go',
  { timeout: 120_000 },
  () => {
    const { log } = openLog({ packaged: true })
    for (const value of ['fork-start-AAAA-1', 'fork-start-BBBB-2', 'fork-start-CCCC-3']) {
      log.remember(value)
    }
    // 9 997 more make 10 000.
    for (let i = 1; i <= 9_997; i += 1) log.remember(lone(i))
    const cut = (start: string): string => log.redact(`gateway said: ${start}…`)
    expect([cut('fork-start-'), cut('fork-start-AAAA'), cut('fork-start-CCCC-')]).toEqual([
      'gateway said: [redacted]…',
      'gateway said: [redacted]…',
      'gateway said: [redacted]…',
    ])
    // The first two go: the start they shared still belongs to the third, theirs do not.
    log.remember(lone(9_998))
    log.remember(lone(9_999))
    expect([cut('fork-start-'), cut('fork-start-AAAA'), cut('fork-start-CCCC-')]).toEqual([
      'gateway said: [redacted]…',
      'gateway said: fork-start-AAAA…',
      'gateway said: [redacted]…',
    ])
    // The third goes: nothing is left that begins so.
    log.remember(lone(10_000))
    expect([cut('fork-start-'), cut('fork-start-AAAA'), cut('fork-start-CCCC-')]).toEqual([
      'gateway said: fork-start-…',
      'gateway said: fork-start-AAAA…',
      'gateway said: fork-start-CCCC-…',
    ])
  },
)
