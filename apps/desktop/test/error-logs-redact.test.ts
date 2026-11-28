/**
 * What is taken out of a line before it is written (docs/features/error-logs/spec.md §脱敏, §写入口,
 * §记什么; acceptance 3 and 5): registered secrets in four spellings, the generic token formats,
 * the home and application folders, the error summary, and the cuts and rotations that must not
 * leave a piece of a secret behind.
 *
 * Real `createAppLog` on real temp folders; only the clock is driven by hand. `watchRendererConsole`
 * is given a stand-in for a `webContents` that has the one method it uses (`on('console-message')`)
 * and calls the listener the way Electron's `console-message` event does: with one details object.
 *
 * Every secret is a literal (support/error-logs-sentinels.ts) and the expectations are literals:
 * `[redacted]`, `~`, `<app>`, the 8-character floor, the 300/500/2000 cuts, the ten frames.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  HOME,
  allLogText,
  leaksIn,
  makeTempRoot,
  openLog,
  readRecords,
  readText,
  summarizeError,
  sweepTempRoots,
  watchRendererConsole,
} from './support/error-logs.js'
import {
  CUT_2000,
  CUT_300,
  CUT_500,
  EVENT_INJECTORS,
  EVENT_LEVELS,
  LONG,
  LONG_TAIL,
  SHORT,
  TABLE,
  fragmentsOf,
  payloadOf,
  spellingsOf,
} from './support/error-logs-sentinels.js'

afterEach(sweepTempRoots)

/** Pieces joined at run time: this file holds no string a secret scanner would take for a token. */
const assemble = (...parts: string[]): string => parts.join('')

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

it('error-logs 验收 5: home paths read ~ and errors drop cmd, spawnargs and env', () => {
  // The user's home becomes ~ wherever a path turns up: in a line, in an event's own field.
  const { log, dir } = openLog()
  expect(log.redact(`ENOENT ${HOME}/Projects/secret-project/notes.txt`)).toBe(
    'ENOENT ~/Projects/secret-project/notes.txt',
  )
  expect(log.redact('/Applications/Tenon.app/Contents/Resources/app.asar/out/main/index.js')).toBe(
    '<app>/app.asar/out/main/index.js',
  )
  log.line('host', 'warn')(`cannot read ${HOME}/Projects/p/file.txt`)
  log.write('info', {
    event: 'app.start',
    packaged: false,
    platform: 'darwin',
    arch: 'arm64',
    userData: `${HOME}/Library/Application Support/Tenon`,
  })
  const written = readRecords(join(dir, 'main.jsonl'))
  expect(written[0]?.['text']).toBe('cannot read ~/Projects/p/file.txt')
  expect(written[1]?.['userData']).toBe('~/Library/Application Support/Tenon')
  expect(allLogText(dir)).not.toContain('alice')

  // A development build's application folder is inside the home: it is replaced first.
  const dev = openLog({ home: HOME, appDir: `${HOME}/dev/tenon/apps/desktop` })
  expect(dev.log.redact(`${HOME}/dev/tenon/apps/desktop/out/main/index.js`)).toBe(
    '<app>/out/main/index.js',
  )
  expect(dev.log.redact(`${HOME}/dev/other-project/a.ts`)).toBe('~/dev/other-project/a.ts')

  // An error is its name, code, shortened message and first ten frames: nothing else it carries.
  class SpawnProblem extends Error {}
  const frames = Array.from(
    { length: 14 },
    (_, i) => `    at f${i} (${HOME}/Projects/app/src/f${i}.ts:${i}:1)`,
  )
  const cause = Object.assign(new Error('cause-message-77'), { code: 'ECAUSE' })
  const failure = Object.assign(new SpawnProblem(`spawn ${HOME}/bin/tool ENOENT`), {
    code: 'ENOENT',
    cmd: 'tool --token=cmd-secret-77',
    spawnargs: ['--password', 'args-secret-77'],
    env: { API_TOKEN: 'env-secret-77' },
    stdout: 'stdout-secret-77',
    headers: { authorization: 'headers-secret-77' },
    cause,
  })
  failure.stack = [`SpawnProblem: spawn ${HOME}/bin/tool ENOENT`, ...frames].join('\n')
  const summary = summarizeError(failure, log.redact)
  expect(Object.keys(summary).toSorted()).toEqual(['code', 'frames', 'message', 'name'])
  expect(summary.name).toBe('SpawnProblem')
  expect(summary.code).toBe('ENOENT')
  expect(summary.message).toBe('spawn ~/bin/tool ENOENT')
  expect(summary.frames).toHaveLength(10)
  expect(summary.frames?.[0]).toContain('~/Projects/app/src/f0.ts:0:1')
  expect(summary.frames?.[9]).toContain('~/Projects/app/src/f9.ts:9:1')
  for (const secret of [
    'cmd-secret-77',
    'args-secret-77',
    'env-secret-77',
    'stdout-secret-77',
    'headers-secret-77',
    'cause-message-77',
    'alice',
  ]) {
    expect(JSON.stringify(summary)).not.toContain(secret)
  }
  log.write('error', { event: 'main.uncaught', origin: 'uncaughtException', error: summary })
  expect(allLogText(dir)).not.toContain('-secret-77')

  // The message is cut to 500 characters, and a thrown value that is not an Error is still a summary.
  const long = summarizeError(new Error('m'.repeat(600)), log.redact)
  expect(long.message.slice(0, 490)).toBe('m'.repeat(490))
  expect(long.message.length).toBeLessThanOrEqual(520)
  const plain = summarizeError(`plain failure at ${HOME}/x`, log.redact)
  expect(plain.message).toBe('plain failure at ~/x')
  expect(plain.name).toMatch(/\S/)
  expect(summarizeError(new Error('no code'), log.redact).code).toBeUndefined()
})

it('error-logs 验收 3: only secrets of 8 or more characters are registered, the longest is replaced first, and each comes with its spellings', () => {
  const { log } = openLog()
  // The floor: 7 characters are not registered, 8 are.
  log.remember('1234567')
  log.remember('abcdefgh')
  expect(log.redact('a 1234567 b abcdefgh c')).toBe('a 1234567 b [redacted] c')

  // A registered value is replaced in the base64, URL-encoded and JSON-escaped spellings too.
  log.remember(TABLE.raw)
  for (const spelling of spellingsOf(TABLE)) {
    expect([spelling, log.redact(`x ${spelling} y`)]).toEqual([spelling, 'x [redacted] y'])
  }

  // A secret that is the start of another, registered first: the longer one still goes whole.
  expect(LONG.startsWith(SHORT)).toBe(true)
  expect(LONG.slice(SHORT.length)).toBe(LONG_TAIL)
  log.remember(SHORT)
  log.remember(LONG)
  expect(log.redact(`a ${LONG} b ${SHORT} c`)).toBe('a [redacted] b [redacted] c')
})

it('error-logs 验收 3: no sentinel, spelling or fragment survives cuts at 300, 500 or 2000 or a shorter overlapping secret registered first', () => {
  const dir = join(makeTempRoot('cuts'), 'logs')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // The previous run's marker, with a secret in its version: it is read back into app.unclean-exit.
  writeFileSync(
    join(dir, 'running.json'),
    JSON.stringify({
      v: 1,
      startedAt: '2026-11-27T10:00:00.000+08:00',
      version: `0.0.0-${TABLE.raw}`,
      pid: 99,
    }),
    { mode: 0o600 },
  )
  const { log, open } = openLog({
    dir,
    makeDir: false,
    deferOpen: true,
    maxBytes: 65_536,
    version: `0.0.0-${TABLE.raw}`,
  })

  // Registered before anything is written, the short one of the overlapping pair first.
  for (const secret of [CUT_300, CUT_500, CUT_2000, TABLE.raw, SHORT, LONG]) log.remember(secret)
  const everything = [
    ...spellingsOf(TABLE),
    SHORT,
    LONG,
    LONG_TAIL,
    ...fragmentsOf(TABLE.raw),
    ...fragmentsOf(CUT_300),
    ...fragmentsOf(CUT_500),
    ...fragmentsOf(CUT_2000),
    ...fragmentsOf(LONG),
  ]

  // Before open: held, then written; the secret is in the buffered line.
  log.write('info', EVENT_INJECTORS.line(payloadOf(TABLE)))
  const result = open()
  expect(result.ok).toBe(true)
  expect(leaksIn(dir, everything)).toEqual([])

  // Every kind of event, the four spellings in each of its string fields.
  for (const kind of Object.keys(EVENT_INJECTORS) as Array<keyof typeof EVENT_INJECTORS>) {
    log.write(EVENT_LEVELS[kind], EVENT_INJECTORS[kind](payloadOf(TABLE)))
    expect({ kind, leaks: leaksIn(dir, everything) }).toEqual({ kind, leaks: [] })
  }

  const lastRecord = (): string => JSON.stringify(readRecords(join(dir, 'main.jsonl')).at(-1))

  // 500: the message of an error summary, with a secret across the cut.
  const atFiveHundred = summarizeError(
    new Error(`${'m'.repeat(480)}${CUT_500}${'z'.repeat(200)}`),
    log.redact,
  )
  log.write('error', { event: 'main.uncaught', origin: 'uncaughtException', error: atFiveHundred })
  expect(lastRecord()).toContain('[redacted]')
  expect(leaksIn(dir, everything)).toEqual([])

  // 300: a stack frame, with a secret across the cut.
  const atThreeHundred = new Error('frame case')
  atThreeHundred.stack = [
    'Error: frame case',
    `    at fn (${'p'.repeat(270)}${CUT_300})`,
    '    at other (/tmp/x.ts:1:1)',
  ].join('\n')
  log.write('error', {
    event: 'main.uncaught',
    origin: 'unhandledRejection',
    error: summarizeError(atThreeHundred, log.redact),
  })
  expect(lastRecord()).toContain('[redacted]')
  expect(leaksIn(dir, everything)).toEqual([])

  // 300: the first line of a renderer error, with a secret across the cut.
  const renderer = fakeContents()
  watchRendererConsole(renderer.contents, log)
  renderer.emit({
    level: 'error',
    message: `${'p'.repeat(280)}${CUT_300}\nsecond line`,
    sourceId: 'file:///app/index.html',
    lineNumber: 7,
  })
  expect(lastRecord()).toContain('[redacted]')
  expect(leaksIn(dir, everything)).toEqual([])

  // 2000: a string field of a line, with a secret across the cut.
  log.line('kernel', 'error')(`${'p'.repeat(1980)}${CUT_2000}${'q'.repeat(200)}`)
  expect(lastRecord()).toContain('[redacted]')
  expect(leaksIn(dir, everything)).toEqual([])

  // The overlapping pair, whole and apart, in a line and in an error.
  log.line('kernel', 'warn')(`before ${LONG} between ${SHORT} after`)
  log.write('error', {
    event: 'main.uncaught',
    origin: 'uncaughtException',
    error: summarizeError(new Error(LONG), log.redact),
  })
  expect(leaksIn(dir, everything)).toEqual([])

  // Turn the log over several times: what was written is copied or archived, and none of it leaks.
  for (let i = 0; i < 1200; i += 1) {
    log.line(`f${String(i).padStart(4, '0')}`, 'info')('f'.repeat(120))
  }
  expect(readText(join(dir, 'main.2.jsonl')).length).toBeGreaterThan(0)
  expect(readText(join(dir, 'running.json')).length).toBeGreaterThan(0)
  expect(leaksIn(dir, everything)).toEqual([])
  expect((allLogText(dir).match(/\[redacted\]/g) ?? []).length).toBeGreaterThan(10)

  log.close()
  expect(leaksIn(dir, everything)).toEqual([])
})

it('error-logs 验收 3: common token formats are replaced without being registered', () => {
  const { log, dir } = openLog()
  // Built from pieces so that this file holds nothing a secret scanner would take for a token.
  const tail36 = '0123456789abcdefghijklmnopqrstuvwxyz'
  const slack = '1234567890-1234567890123-abcdefghijklmnopqrstuvwx'
  const whole: Array<[label: string, token: string]> = [
    ['sk-', assemble('sk', '-', 'proj0123456789abcdefABCDEF0123456789abcd')],
    ['ghp_', assemble('gh', 'p_', tail36)],
    ['gho_', assemble('gh', 'o_', tail36)],
    ['ghu_', assemble('gh', 'u_', tail36)],
    ['ghs_', assemble('gh', 's_', tail36)],
    ['ghr_', assemble('gh', 'r_', tail36)],
    [
      'github_pat_',
      assemble(
        'github',
        '_pat_',
        '11ABCDEFG0abcdefghij_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      ),
    ],
    ['glpat-', assemble('gl', 'pat-', 'abcdefghij0123456789')],
    ['xoxb-', assemble('xo', 'xb-', slack)],
    ['xoxa-', assemble('xo', 'xa-', slack)],
    ['xoxp-', assemble('xo', 'xp-', slack)],
    ['AKIA', assemble('AK', 'IA', 'ABCDEFGHIJKLMNOP')],
    ['AIza', assemble('AI', 'za', 'SyA1B2C3D4E5F6G7H8I9J0KlMnOpQrStUv')],
    [
      'JWT',
      [
        'eyJhbGciOiJIUzI1NiJ9',
        'eyJzdWIiOiJ4eHh4eHgifQ',
        'abcdefghijklmnopqrstuvwxyz0123456789ABCD',
      ].join('.'),
    ],
  ]
  for (const [label, token] of whole) {
    expect([label, log.redact(`before ${token} after`)]).toEqual([label, 'before [redacted] after'])
    log.line('host', 'warn')(`seen ${token}`)
  }

  // A bearer token, an Authorization header, credentials in an address.
  const bearer = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA'
  const basic = 'dXNlcjpwYXNzd29yZDEyMw'
  const password = 'hunter2pass'
  const redactedBearer = log.redact(`sent Bearer ${bearer} ok`)
  expect(redactedBearer).not.toContain(bearer)
  expect(redactedBearer).toContain('[redacted]')
  const redactedHeader = log.redact(`Authorization: Basic ${basic}==`)
  expect(redactedHeader).not.toContain(basic)
  expect(redactedHeader).toContain('[redacted]')
  const redactedUrl = log.redact(`clone https://alice:${password}@git.example.test/repo.git`)
  expect(redactedUrl).not.toContain(password)
  expect(redactedUrl).toContain('git.example.test/repo.git')

  // A PEM private key block, lines and all.
  const pemBody = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj'
  const pem = [
    `-----BEGIN ${'PRIVATE'} KEY-----`,
    pemBody,
    'abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    `-----END ${'PRIVATE'} KEY-----`,
  ].join('\n')
  const redactedPem = log.redact(`key:\n${pem}\nafter`)
  expect(redactedPem).not.toContain(pemBody)
  expect(redactedPem).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCD')
  expect(redactedPem).toContain('after')

  // The value of these parameters in an address, whatever the case of the name; the rest stays.
  const params = [
    'token',
    'key',
    'apikey',
    'api_key',
    'api-key',
    'secret',
    'client_secret',
    'code',
    'access_token',
    'access-token',
    'refresh_token',
    'password',
    'sig',
  ]
  for (const name of params) {
    for (const spelled of [name, name.toUpperCase()]) {
      const redacted = log.redact(`https://api.example.test/cb?a=1&${spelled}=PARAMVALUE-0042&b=2`)
      expect([spelled, redacted]).toEqual([
        spelled,
        `https://api.example.test/cb?a=1&${spelled}=[redacted]&b=2`,
      ])
    }
  }
  log.line('host', 'warn')(`https://api.example.test/cb?a=1&access_token=PARAMVALUE-0042&b=2`)
  log.line('host', 'warn')(`clone https://alice:${password}@git.example.test/repo.git`)

  // The same, in the file.
  expect(leaksIn(dir, [...whole.map(([, token]) => token), 'PARAMVALUE-0042', password])).toEqual(
    [],
  )
})
