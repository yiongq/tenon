/**
 * The values the log has been told are secrets (docs/features/error-logs/spec.md §脱敏 层 2, §怎么写
 * 「登记表有上限」「字段以截断结尾…」): at most 10 000 of them, the oldest let go when one more comes,
 * a value registered again taking no place and not moving up. Registering is cheap whatever the
 * size of the table, and so is looking for them in a string: both go by the first 8 characters of
 * a spelling, the length a registered value has at least, so no table is sorted or scanned whole.
 *
 * No electron import.
 */
import { MIN_SECRET_LENGTH, REDACTED, secretSpellings } from './redact.js'

/** The most values the table holds. */
export const MAX_SECRETS = 10_000

/** What a cut leaves at the end of a field: `…` or `…(+5120)`. */
const CUT_MARK = /…(?:\(\+\d+\))?$/u

export interface SecretRegistry {
  /** Registers a value; one under 8 characters, or one already there, changes nothing. */
  add(secret: string): void
  /**
   * `text` with every spelling of every registered value replaced. At a place where several begin,
   * the longest wins; matches that overlap one another are one replacement.
   */
  replace(text: string): string
  /**
   * `text` when it ends with the start (8 or more characters) of a registered value, as written:
   * that tail replaced and the cut mark after it kept. What an upstream cut leaves of a secret.
   */
  cutTail(text: string): string
}

/** The first 8 characters of a spelling: what the tables are indexed by. */
const keyOf = (word: string): string => word.slice(0, MIN_SECRET_LENGTH)

/** Adds `word` to its list, behind the ones as long as it or longer. */
const insert = (index: Map<string, string[]>, word: string): void => {
  const key = keyOf(word)
  const list = index.get(key)
  if (list === undefined) {
    index.set(key, [word])
    return
  }
  let at = list.length
  while (at > 0 && (list[at - 1] ?? '').length < word.length) at -= 1
  list.splice(at, 0, word)
}

/** Takes one occurrence of `word` out of its list. */
const remove = (index: Map<string, string[]>, word: string): void => {
  const key = keyOf(word)
  const list = index.get(key)
  if (list === undefined) return
  const at = list.indexOf(word)
  if (at >= 0) list.splice(at, 1)
  if (list.length === 0) index.delete(key)
}

export function createSecretRegistry(): SecretRegistry {
  /** Each registered value with its spellings, oldest first (a Map keeps the order of insertion). */
  const values = new Map<string, readonly string[]>()
  /** The first 8 characters of a spelling, and the spellings that begin with them, longest first. */
  const spellingsBy = new Map<string, string[]>()
  /** The same for the values as written. */
  const valuesBy = new Map<string, string[]>()
  /** How many spellings begin with each UTF-16 unit: a string is only looked at where one may start. */
  const starts = new Uint32Array(0x10000)
  let longestValue = 0

  const forgetOldest = (): void => {
    const oldest = values.keys().next().value
    if (oldest === undefined) return
    for (const spelling of values.get(oldest) ?? []) {
      remove(spellingsBy, spelling)
      starts[spelling.charCodeAt(0)] = (starts[spelling.charCodeAt(0)] ?? 1) - 1
    }
    remove(valuesBy, oldest)
    values.delete(oldest)
  }

  const add = (secret: string): void => {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH || values.has(secret)) {
      return
    }
    const spellings = secretSpellings(secret).filter((one) => one.length >= MIN_SECRET_LENGTH)
    values.set(secret, spellings)
    for (const spelling of spellings) {
      insert(spellingsBy, spelling)
      starts[spelling.charCodeAt(0)] = (starts[spelling.charCodeAt(0)] ?? 0) + 1
    }
    insert(valuesBy, secret)
    longestValue = Math.max(longestValue, secret.length)
    if (values.size > MAX_SECRETS) forgetOldest()
  }

  const replace = (text: string): string => {
    if (spellingsBy.size === 0 || text.length < MIN_SECRET_LENGTH) return text
    // [start, end) pairs, in order, the ones that overlap already joined.
    const spans: number[] = []
    for (let at = 0; at + MIN_SECRET_LENGTH <= text.length; at += 1) {
      if ((starts[text.charCodeAt(at)] ?? 0) === 0) continue
      const candidates = spellingsBy.get(text.slice(at, at + MIN_SECRET_LENGTH))
      const found = candidates?.find((spelling) => text.startsWith(spelling, at))
      if (found === undefined) continue
      const end = at + found.length
      const last = spans.length - 1
      if (last > 0 && at < (spans[last] ?? 0)) spans[last] = Math.max(spans[last] ?? 0, end)
      else spans.push(at, end)
    }
    if (spans.length === 0) return text
    let result = ''
    let copied = 0
    for (let pair = 0; pair < spans.length; pair += 2) {
      result += text.slice(copied, spans[pair]) + REDACTED
      copied = spans[pair + 1] ?? text.length
    }
    return result + text.slice(copied)
  }

  const cutTail = (text: string): string => {
    if (valuesBy.size === 0) return text
    const mark = CUT_MARK.exec(text)?.[0] ?? ''
    const body = mark === '' ? text : text.slice(0, text.length - mark.length)
    // A tail shorter than the longest value, so it can be the start of that one.
    for (
      let at = Math.max(0, body.length - longestValue + 1);
      at + MIN_SECRET_LENGTH <= body.length;
      at += 1
    ) {
      const candidates = valuesBy.get(body.slice(at, at + MIN_SECRET_LENGTH))
      if (candidates === undefined) continue
      const tail = body.slice(at)
      if (candidates.some((value) => value.length >= tail.length && value.startsWith(tail))) {
        return `${body.slice(0, at)}${REDACTED}${mark}`
      }
    }
    return text
  }

  return { add, replace, cutTail }
}
