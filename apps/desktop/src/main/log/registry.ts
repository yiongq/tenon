/**
 * The values the log has been told are secrets (docs/features/error-logs/spec.md §脱敏 层 2, §怎么写
 * 「登记表有上限」「字段以截断结尾…」): at most 10 000 of them, the one not registered for the
 * longest time let go when one more comes (D21), a value registered again taking no new place and
 * moving to the newest. Registering costs what the value is long, and so does looking for them in a
 * string: the spellings sit in a prefix tree, so what a lookup costs does not depend on how many
 * registered values begin alike, and no list of them is scanned.
 *
 * No electron import.
 */
import { MIN_SECRET_LENGTH, REDACTED, secretSpellings } from './redact.js'

/** The most values the table holds. */
export const MAX_SECRETS = 10_000

/** What a cut leaves at the end of a field: `…` or `…(+5120)`. */
const CUT_MARK = /…(?:\(\+\d+\))?$/u

export interface SecretRegistry {
  /** Registers a value (one under 8 characters changes nothing); one already there becomes the newest. */
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

/** A branch of the tree: the characters along it, and the node they lead to. */
interface Edge {
  label: string
  to: Node
}

interface Node {
  /** Keyed by the first character of each label; null for a node nothing goes on from. */
  edges: Map<string, Edge> | null
  /** How many of the words added end here (two values may share a spelling). */
  ends: number
}

/**
 * A set of words as a prefix tree with the single-child runs joined into one edge. Adding or taking
 * out a word costs its length; asking for the longest word at a place in a text costs at most the
 * length of what matches there, however many words share a start.
 */
class WordTree {
  private readonly root: Node = { edges: null, ends: 0 }

  add(word: string): void {
    let node = this.root
    let at = 0
    while (at < word.length) {
      const edges = (node.edges ??= new Map())
      const first = word.charAt(at)
      const edge = edges.get(first)
      if (edge === undefined) {
        edges.set(first, { label: word.slice(at), to: { edges: null, ends: 1 } })
        return
      }
      let shared = edge.label.length
      if (!word.startsWith(edge.label, at)) {
        shared = 1
        while (
          shared < edge.label.length &&
          edge.label.charCodeAt(shared) === word.charCodeAt(at + shared)
        ) {
          shared += 1
        }
      }
      if (shared < edge.label.length) {
        // The word leaves this edge part of the way along: the edge is split there.
        const below: Edge = { label: edge.label.slice(shared), to: edge.to }
        edge.label = edge.label.slice(0, shared)
        edge.to = { edges: new Map([[below.label.charAt(0), below]]), ends: 0 }
      }
      node = edge.to
      at += shared
    }
    node.ends += 1
  }

  /** Takes out one occurrence of `word`; what is not there changes nothing. */
  remove(word: string): void {
    const trail: Array<{ node: Node; key: string }> = []
    let node = this.root
    let at = 0
    while (at < word.length) {
      const key = word.charAt(at)
      const edge = node.edges?.get(key)
      if (edge === undefined || !word.startsWith(edge.label, at)) return
      trail.push({ node, key })
      node = edge.to
      at += edge.label.length
    }
    if (node.ends === 0) return
    node.ends -= 1
    if (node.ends > 0) return
    let above = trail.pop()
    if (node.edges === null || node.edges.size === 0) {
      // Nothing ends here and nothing goes on: the branch that led here goes.
      if (above === undefined) return
      above.node.edges?.delete(above.key)
      if (above.node.edges?.size === 0) above.node.edges = null
      node = above.node
      above = trail.pop()
    }
    // A node that is no end and no fork is joined to the edge above it.
    if (above !== undefined && node.ends === 0 && node.edges?.size === 1) {
      const incoming = above.node.edges?.get(above.key)
      const only = node.edges.values().next().value
      if (incoming !== undefined && only !== undefined) {
        incoming.label += only.label
        incoming.to = only.to
      }
    }
  }

  /** The length of the longest word that `text` has at `at`, or 0. */
  longestAt(text: string, at: number): number {
    let node = this.root
    let pos = at
    let longest = 0
    while (pos < text.length) {
      const edge = node.edges?.get(text.charAt(pos))
      if (edge === undefined || !text.startsWith(edge.label, pos)) break
      pos += edge.label.length
      node = edge.to
      if (node.ends > 0) longest = pos - at
    }
    return longest
  }

  /** Whether the text from `at` to its end is the start of some word (or a word). */
  startsAt(text: string, at: number): boolean {
    let node = this.root
    let pos = at
    while (pos < text.length) {
      const edge = node.edges?.get(text.charAt(pos))
      if (edge === undefined) return false
      if (text.length - pos <= edge.label.length) return edge.label.startsWith(text.slice(pos))
      if (!text.startsWith(edge.label, pos)) return false
      pos += edge.label.length
      node = edge.to
    }
    return true
  }
}

export function createSecretRegistry(): SecretRegistry {
  /** Each registered value with its spellings, the one registered longest ago first (a Map keeps the order of insertion). */
  const values = new Map<string, readonly string[]>()
  /** Every spelling of every value in the table. */
  const spellings = new WordTree()
  /** The values as written. */
  const written = new WordTree()
  let longestValue = 0

  const forgetStalest = (): void => {
    const stalest = values.keys().next().value
    if (stalest === undefined) return
    for (const spelling of values.get(stalest) ?? []) spellings.remove(spelling)
    written.remove(stalest)
    values.delete(stalest)
  }

  const add = (secret: string): void => {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) return
    const known = values.get(secret)
    if (known !== undefined) {
      // Registered again: no new place, and the newest now.
      values.delete(secret)
      values.set(secret, known)
      return
    }
    const forms = secretSpellings(secret).filter((one) => one.length >= MIN_SECRET_LENGTH)
    values.set(secret, forms)
    for (const form of forms) spellings.add(form)
    written.add(secret)
    longestValue = Math.max(longestValue, secret.length)
    if (values.size > MAX_SECRETS) forgetStalest()
  }

  const replace = (text: string): string => {
    if (values.size === 0 || text.length < MIN_SECRET_LENGTH) return text
    // [start, end) pairs, in order, the ones that overlap already joined.
    const spans: number[] = []
    for (let at = 0; at + MIN_SECRET_LENGTH <= text.length; at += 1) {
      const length = spellings.longestAt(text, at)
      if (length === 0) continue
      const end = at + length
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
    if (values.size === 0) return text
    const mark = CUT_MARK.exec(text)?.[0] ?? ''
    const body = mark === '' ? text : text.slice(0, text.length - mark.length)
    // A tail shorter than the longest value, so it can be the start of that one.
    for (
      let at = Math.max(0, body.length - longestValue + 1);
      at + MIN_SECRET_LENGTH <= body.length;
      at += 1
    ) {
      if (written.startsAt(body, at)) return `${body.slice(0, at)}${REDACTED}${mark}`
    }
    return text
  }

  return { add, replace, cutTail }
}
