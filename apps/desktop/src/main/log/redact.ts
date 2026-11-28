/**
 * What is taken out of a string before it reaches the log (docs/features/error-logs/spec.md §脱敏):
 * the spellings a registered secret may turn up in, the generic token formats, the cut with its
 * mark, the summary of an error, and the wrap that registers every secret the host reads or writes.
 * Pure functions: the registered values and the folders live in `app-log.ts`.
 *
 * No electron import.
 */
import type { HostSecrets } from '@tenon-app/kernel'
import type { ErrorSummary } from './events.js'

export const REDACTED = '[redacted]'

/** A secret shorter than this is not registered: it would take ordinary words out of every line. */
export const MIN_SECRET_LENGTH = 8

/** The most frames of a stack an error summary keeps, and the longest each may be. */
const SUMMARY_FRAMES = 10
const FRAME_LIMIT = 300
const MESSAGE_LIMIT = 500

/** What a summary says of a thrown value that is not an error: log words, not copy for the user. */
const NON_ERROR = 'NonError'
const UNREADABLE = '(the error could not be read)'
const FUNCTION_THROWN = '[function]'

/**
 * The ways one registered value may be written: as it is, in base64 (padded, unpadded and URL-safe),
 * URL-encoded and JSON-escaped. Longest first, which is the order they are replaced in.
 */
export function secretSpellings(secret: string): string[] {
  const base64 = Buffer.from(secret, 'utf8').toString('base64')
  const found = new Set<string>([
    secret,
    base64,
    base64.replace(/=+$/u, ''),
    base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, ''),
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
  ])
  return [...found].filter((one) => one.length > 0)
}

/**
 * `text` cut to `limit` characters, with a mark that says how many were left out: `…(+5120)`. The
 * mark is added after the limit and does not count in it. A pair of UTF-16 halves is never split.
 */
export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text
  let cut = Math.max(0, limit)
  const last = text.charCodeAt(cut - 1)
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1
  return `${text.slice(0, cut)}…(+${text.length - cut})`
}

/**
 * The formats of the common tokens, replaced whether or not the value was ever registered. Each
 * stays linear on long input: every one starts at a literal or a character class, and none of them
 * reaches past a quote or a backslash, so a line already written as JSON stays JSON.
 */
const GENERIC: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu,
    REDACTED,
  ],
  [/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/gu, REDACTED],
  [/\bgh[opusr]_[A-Za-z0-9]{20,}/gu, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/gu, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{16,}/gu, REDACTED],
  [/\bxox[abp]-[A-Za-z0-9-]{10,}/gu, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/gu, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/gu, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/gu, REDACTED],
  [/\b(Authorization)\s*:\s*[^\r\n"\\]*/giu, `$1: ${REDACTED}`],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/giu, `$1 ${REDACTED}`],
  // `scheme://user:pass@host`: the userinfo goes, the host and path stay.
  [/:\/\/[^\s/:@"'\\]+:[^\s/@"'\\]+@/gu, `://${REDACTED}@`],
  [
    /([?&#])(token|key|apikey|api_key|api-key|secret|client_secret|code|access_token|access-token|refresh_token|password|sig)=[^&#\s"'<>\\]+/giu,
    `$1$2=${REDACTED}`,
  ],
]

/** `text` with every generic token format replaced. */
export function redactGeneric(text: string): string {
  let result = text
  for (const [pattern, replacement] of GENERIC) result = result.replace(pattern, replacement)
  return result
}

/** An error as the log keeps it (spec §接口 `ErrorSummary`): name, code, a short message, ten frames. */
export function summarizeError(error: unknown, redact: (text: string) => string): ErrorSummary {
  try {
    return summarize(error, redact)
  } catch {
    // A getter that throws, a proxy that refuses: say so rather than lose the line.
    return { name: NON_ERROR, message: UNREADABLE }
  }
}

function summarize(error: unknown, redact: (text: string) => string): ErrorSummary {
  if (typeof error === 'function') return { name: NON_ERROR, message: FUNCTION_THROWN }
  if (typeof error !== 'object' || error === null) {
    return { name: NON_ERROR, message: truncateText(redact(String(error)), MESSAGE_LIMIT) }
  }
  const record = error as { message?: unknown; code?: unknown; stack?: unknown; name?: unknown }
  const constructorName = (error as { constructor?: { name?: unknown } }).constructor?.name
  const name =
    typeof constructorName === 'string' && constructorName !== '' && constructorName !== 'Object'
      ? constructorName
      : typeof record.name === 'string' && record.name !== ''
        ? record.name
        : NON_ERROR
  const code =
    typeof record.code === 'string' || typeof record.code === 'number' ? String(record.code) : null
  const message = typeof record.message === 'string' ? record.message : ''
  const frames =
    typeof record.stack === 'string'
      ? record.stack
          .split('\n')
          .filter((line) => /^\s*at\s/u.test(line))
          .slice(0, SUMMARY_FRAMES)
          .map((line) => truncateText(redact(line.trim()), FRAME_LIMIT))
      : []
  return {
    name: truncateText(redact(name), 200),
    ...(code === null ? {} : { code: redact(code) }),
    message: truncateText(redact(message), MESSAGE_LIMIT),
    ...(frames.length === 0 ? {} : { frames }),
  }
}

/**
 * The host's one `HostSecrets`, wrapped so that every value that passes through is registered with
 * the log (spec §一直要成立的规矩 第 5 条): a `get` registers what it read, a `set` what it is about
 * to write, before it is written.
 */
export function rememberingSecrets(
  secrets: HostSecrets,
  log: { remember(secret: string): void },
): HostSecrets {
  return {
    async get(key) {
      const value = await secrets.get(key)
      if (value !== null) log.remember(value)
      return value
    },
    async set(key, value) {
      log.remember(value)
      await secrets.set(key, value)
    },
    delete: (key) => secrets.delete(key),
  }
}
