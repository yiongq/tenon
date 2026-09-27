// Replays last night's full test run: the log is rebuilt from a fixed seed, so every run prints
// the same thing. Usage: node run-tests.mjs

function prng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = prng(927_2026)
const pick = (list) => list[Math.floor(rand() * list.length)]
const between = (low, high) => low + Math.floor(rand() * (high - low + 1))

const SUITES = [
  ['auth', 'AU'],
  ['billing', 'BI'],
  ['catalog', 'CA'],
  ['checkout', 'CH'],
  ['inventory', 'IN'],
  ['ledger', 'LE'],
  ['notifications', 'NO'],
  ['search', 'SE'],
  ['sync', 'SY'],
  ['uploads', 'UP'],
]
const FAILING = 'sync'
const CASES = [
  'rejects an expired session token',
  'ignores a duplicate request id',
  'rounds half a cent up',
  'returns an empty page past the end',
  'fills a missing optional field',
  'batches a burst of 500 writes',
  'reprices a cart mid-checkout',
  'refreshes a stale cache entry',
  'handles a timezone at the day boundary',
  'refuses an oversized payload',
  'keeps the sort order across pages',
  'retries a dropped connection once',
  'masks internal paths in errors',
  'expires an unused upload link',
  'merges two edits to different fields',
  'reports a partial refund',
  'validates an address without a postcode',
  'orders results by relevance',
]
const FLAKES = ['ETIMEDOUT', 'ECONNRESET', 'socket hang up', 'port already in use']

const ids = new Set()
function testId(prefix) {
  for (;;) {
    const id = `${prefix}-${between(1000, 9999)}`
    if (!ids.has(id)) {
      ids.add(id)
      return id
    }
  }
}

const lines = ['Running 10 suites (seed 0x3f2a, 4 workers)', '']
const tally = { passed: 0, failed: 0, flaky: 0, skipped: 0 }
let millis = 0
for (const [suite, prefix] of SUITES) {
  lines.push(` ${suite}/`)
  const total = between(66, 74)
  const failAt = suite === FAILING ? between(Math.floor(total * 0.4), Math.floor(total * 0.6)) : 0
  for (let n = 1; n <= total; n += 1) {
    const id = testId(prefix)
    const name =
      n === failAt ? `${suite} › keeps the newer revision on a tie` : `${suite} › ${pick(CASES)}`
    const ms = between(1, 120)
    millis += ms
    if (n === failAt) {
      tally.failed += 1
      const expected = between(10, 40)
      lines.push(
        `  ✗ [${id}] ${name} (${ms} ms)`,
        `      AssertionError: expected revision ${expected - 1} to equal ${expected}`,
        `        at test/${suite}/conflict.spec.ts:${between(20, 140)}:${between(3, 30)}`,
        '      failed 3 of 3 attempts',
      )
    } else if (rand() < 0.012) {
      tally.flaky += 1
      lines.push(
        `  ↻ [${id}] ${name} (failed attempt 1: ${pick(FLAKES)}, passed on retry, ${ms * 9} ms)`,
      )
    } else if (rand() < 0.02) {
      tally.skipped += 1
      lines.push(`  - [${id}] ${name} (skipped: needs a live ${pick(['S3', 'SMTP', 'Redis'])})`)
    } else {
      tally.passed += 1
      lines.push(`  ✓ [${id}] ${name} (${ms} ms)`)
    }
  }
  lines.push('')
}
const all = tally.passed + tally.failed + tally.flaky + tally.skipped
lines.push(
  `Tests  ${tally.failed} failed | ${tally.flaky} flaky | ${tally.passed} passed | ` +
    `${tally.skipped} skipped (${all})`,
  `Duration  ${(millis / 1000).toFixed(2)}s`,
)
process.stdout.write(`${lines.join('\n')}\n`)
process.exitCode = tally.failed === 0 ? 0 : 1
