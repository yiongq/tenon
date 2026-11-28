/**
 * The secrets the error-logs tests plant, and the one table that writes every kind of log event
 * with a planted value in each of its string fields (spec §写入口, 验收 3).
 *
 * The spellings below are literals on purpose: they came out of `derive-error-logs-spellings.mjs`,
 * a script that imports nothing from the app, and are pasted here as they were printed. A test
 * that computed them with the code under test could not notice a change in both at once.
 *
 * None of the raw values starts like a generic token format (sk-, ghp_, AKIA, …) or is a JWT, and
 * none sits in a `key=` position: when a test finds the log free of one, registration did it.
 */
import type { ErrorSummary, LogEvent, LogLevel } from './error-logs.js'

/** A secret and the three other ways the spec says it may turn up: base64, URL-encoded, JSON-escaped. */
export interface Sentinel {
  readonly raw: string
  readonly base64: string
  readonly url: string
  readonly json: string
}

// ---- derived by derive-error-logs-spellings.mjs ----------------------------------------------

export const STORED: Sentinel = {
  raw: 'TSNT-stored"A7/Lp+9=zk\\M3vN8wT',
  base64: 'VFNOVC1zdG9yZWQiQTcvTHArOT16a1xNM3ZOOHdU',
  url: 'TSNT-stored%22A7%2FLp%2B9%3Dzk%5CM3vN8wT',
  json: 'TSNT-stored\\"A7/Lp+9=zk\\\\M3vN8wT',
}

export const CONFIGURED: Sentinel = {
  raw: 'TSNT-config"B8/Mq+2=yj\\N4wP9xU',
  base64: 'VFNOVC1jb25maWciQjgvTXErMj15alxONHdQOXhV',
  url: 'TSNT-config%22B8%2FMq%2B2%3Dyj%5CN4wP9xU',
  json: 'TSNT-config\\"B8/Mq+2=yj\\\\N4wP9xU',
}

export const ENVVAR: Sentinel = {
  raw: 'TSNT-envvar"C9/Nr+3=xh\\P5xQ2yV',
  base64: 'VFNOVC1lbnZ2YXIiQzkvTnIrMz14aFxQNXhRMnlW',
  url: 'TSNT-envvar%22C9%2FNr%2B3%3Dxh%5CP5xQ2yV',
  json: 'TSNT-envvar\\"C9/Nr+3=xh\\\\P5xQ2yV',
}

export const OAUTH_ACCESS: Sentinel = {
  raw: 'TSNT-oaccess"D2/Ps+4=wg\\Q6yR3zW',
  base64: 'VFNOVC1vYWNjZXNzIkQyL1BzKzQ9d2dcUTZ5UjN6Vw==',
  url: 'TSNT-oaccess%22D2%2FPs%2B4%3Dwg%5CQ6yR3zW',
  json: 'TSNT-oaccess\\"D2/Ps+4=wg\\\\Q6yR3zW',
}

export const OAUTH_REFRESH: Sentinel = {
  raw: 'TSNT-orefresh"E3/Qt+5=vf\\R7zS4aX',
  base64: 'VFNOVC1vcmVmcmVzaCJFMy9RdCs1PXZmXFI3elM0YVg=',
  url: 'TSNT-orefresh%22E3%2FQt%2B5%3Dvf%5CR7zS4aX',
  json: 'TSNT-orefresh\\"E3/Qt+5=vf\\\\R7zS4aX',
}

export const OAUTH_CLIENT: Sentinel = {
  raw: 'TSNT-oclient"F4/Ru+6=ue\\S8aT5bY',
  base64: 'VFNOVC1vY2xpZW50IkY0L1J1KzY9dWVcUzhhVDViWQ==',
  url: 'TSNT-oclient%22F4%2FRu%2B6%3Due%5CS8aT5bY',
  json: 'TSNT-oclient\\"F4/Ru+6=ue\\\\S8aT5bY',
}

export const MCP_ENV_KEY: Sentinel = {
  raw: 'TSNT-mcpenvkey"G5/Sv+7=td\\T9bU6cZ',
  base64: 'VFNOVC1tY3BlbnZrZXkiRzUvU3YrNz10ZFxUOWJVNmNa',
  url: 'TSNT-mcpenvkey%22G5%2FSv%2B7%3Dtd%5CT9bU6cZ',
  json: 'TSNT-mcpenvkey\\"G5/Sv+7=td\\\\T9bU6cZ',
}

export const MCP_ENVS: Sentinel = {
  raw: 'TSNT-mcpenvs"H6/Tw+8=sc\\U2cV7dA',
  base64: 'VFNOVC1tY3BlbnZzIkg2L1R3Kzg9c2NcVTJjVjdkQQ==',
  url: 'TSNT-mcpenvs%22H6%2FTw%2B8%3Dsc%5CU2cV7dA',
  json: 'TSNT-mcpenvs\\"H6/Tw+8=sc\\\\U2cV7dA',
}

export const FIRST_KEY_ENV: Sentinel = {
  raw: 'TSNT-firstkey"K8/Vy+1=qa\\W4eX9fC',
  base64: 'VFNOVC1maXJzdGtleSJLOC9WeSsxPXFhXFc0ZVg5ZkM=',
  url: 'TSNT-firstkey%22K8%2FVy%2B1%3Dqa%5CW4eX9fC',
  json: 'TSNT-firstkey\\"K8/Vy+1=qa\\\\W4eX9fC',
}

export const TABLE: Sentinel = {
  raw: 'TSNT-table"J7/Ux+9=rb\\V3dW8eB',
  base64: 'VFNOVC10YWJsZSJKNy9VeCs5PXJiXFYzZFc4ZUI=',
  url: 'TSNT-table%22J7%2FUx%2B9%3Drb%5CV3dW8eB',
  json: 'TSNT-table\\"J7/Ux+9=rb\\\\V3dW8eB',
}

// ---- not registered through a spelling: cut points and overlap (spec 验收 3) --------------------

/** 40+ characters, so that a cut 15 characters in leaves a fragment well over 8 characters. */
export const CUT_300 = 'TSNT-cut300-Rq9Lm+Zx(7)k3Tn_Vw5Ypd8BfH2Js0'
export const CUT_500 = 'TSNT-cut500-Ab4Cd+Ef(8)g5Hi_Jk6Lmn9OpQ3Rs1'
export const CUT_2000 = 'TSNT-cut2000-Wx2Yz+Ab(6)c7De_Fg8Hij4KlM5No9'

/** `LONG` is `SHORT` followed by `LONG_TAIL`; SHORT is registered first. */
export const SHORT = 'TSNT-short-Mn7Pq3Rs'
export const LONG_TAIL = '-Vw8Xy2Zt5Uk9Jh4Gf6Ds1Ba'
export const LONG = 'TSNT-short-Mn7Pq3Rs-Vw8Xy2Zt5Uk9Jh4Gf6Ds1Ba'

/** The four spellings of a sentinel, listed, not computed. */
export function spellingsOf(sentinel: Sentinel): readonly string[] {
  return [sentinel.raw, sentinel.base64, sentinel.url, sentinel.json]
}

/** All four spellings in one string, to plant in a field. */
export function payloadOf(sentinel: Sentinel): string {
  return spellingsOf(sentinel).join(' <> ')
}

/** Every window of `length` characters of `text`: the fragments a half-cut secret would leave. */
export function fragmentsOf(text: string, length = 8): readonly string[] {
  const found: string[] = []
  for (let start = 0; start + length <= text.length; start += 1) {
    found.push(text.slice(start, start + length))
  }
  return found
}

function summary(value: string): ErrorSummary {
  return { name: value, code: value, message: value, frames: [value, value] }
}

/**
 * One event of every kind the write entry takes, `value` in each of its string fields. The
 * `satisfies` is the point: a new kind of event does not compile until it has a row here.
 */
export const EVENT_INJECTORS = {
  'app.start': (value) => ({
    event: 'app.start',
    packaged: false,
    platform: value,
    arch: value,
    userData: value,
  }),
  'app.unclean-exit': (value) => ({ event: 'app.unclean-exit', startedAt: value, version: value }),
  'app.startup-failed': (value) => ({ event: 'app.startup-failed', error: summary(value) }),
  'app.quit': () => ({ event: 'app.quit' }),
  'window.shown': () => ({ event: 'window.shown' }),
  'sandbox.posture': (value) => ({
    event: 'sandbox.posture',
    state: 'degraded',
    reasons: [value, value],
  }),
  'sandbox.helpers': (value) => ({
    event: 'sandbox.helpers',
    packageDir: value,
    applySeccomp: value,
    javaAgentJar: value,
  }),
  'main.uncaught': (value) => ({
    event: 'main.uncaught',
    origin: 'uncaughtException',
    error: summary(value),
  }),
  'process.gone': (value) => ({
    event: 'process.gone',
    process: value,
    reason: value,
    exitCode: 1,
    name: value,
  }),
  'ipc.failed': (value) => ({
    event: 'ipc.failed',
    channel: value,
    code: 'handler-failed',
    message: value,
  }),
  'renderer.error': (value) => ({
    event: 'renderer.error',
    message: value,
    source: value,
    line: 1,
    repeats: 1,
  }),
  'log.dropped': (value) => ({ event: 'log.dropped', source: value, count: 1 }),
  line: (value) => ({ event: 'line', source: value, text: value }),
} satisfies Record<LogEvent['event'], (value: string) => LogEvent>

/** The level each kind is written at (spec §记什么, §日志行: error, warn or info). */
export const EVENT_LEVELS = {
  'app.start': 'info',
  'app.unclean-exit': 'warn',
  'app.startup-failed': 'error',
  'app.quit': 'info',
  'window.shown': 'info',
  'sandbox.posture': 'info',
  'sandbox.helpers': 'info',
  'main.uncaught': 'error',
  'process.gone': 'error',
  'ipc.failed': 'warn',
  'renderer.error': 'error',
  'log.dropped': 'warn',
  line: 'info',
} satisfies Record<LogEvent['event'], LogLevel>
