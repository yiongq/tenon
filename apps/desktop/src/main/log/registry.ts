/**
 * The values the log has been told are secrets (docs/features/error-logs/spec.md §脱敏 层 2, §怎么写
 * 「脱敏的工作量有上界（D25）」「登记表有上限」「字段以截断结尾…」): at most 10 000 of them, the one
 * not registered for the longest time let go when one more comes (D21), a value registered again
 * taking no new place and moving to the newest. Registering costs what the value is long, and so
 * does looking for them in a string: the spellings sit in a prefix tree, so what a lookup costs does
 * not depend on how many registered values begin alike, and no list of them is scanned. Every value
 * and every spelling of one is registered, one longer than what redaction looks at in one string
 * (`REDACT_INPUT_LIMIT`) by its first characters up to that: a string is cut to that before it is
 * looked at, so no more of such a value can show in it, and that much is taken out.
 *
 * No electron import.
 */
import { MIN_SECRET_LENGTH, REDACTED, boundInput, secretSpellings } from './redact.js'

/** The most values the table holds. */
export const MAX_SECRETS = 10_000

/** What a cut leaves at the end of a field: `…` or `…(+5120)`. */
const CUT_MARK = /…(?:\(\+\d+\))?$/u

export interface SecretRegistry {
  /**
   * Registers a value (one under 8 characters changes nothing; one over 4096 is registered by its
   * first 4096); one already there becomes the newest.
   */
  add(secret: string): void
  /**
   * `text` with every spelling of every registered value replaced, and the end of it too when it
   * is the start (8 or more characters) of a registered value or of a spelling of one, with the cut
   * mark after it kept: what an upstream cut, or the cut of `REDACT_INPUT_LIMIT`, leaves of a
   * secret. At a place where several begin, the longest wins; matches that overlap one another, the
   * end among them, are one replacement. The end is looked for in the text as it was, so a value
   * found inside it does not hide the rest of the one it began.
   */
  replace(text: string): string
}

/** A branch of the tree: the characters along it, and the node they lead to. */
interface Edge {
  label: string
  /** The first character of `label` as a code: it stays what it is as the edge is split or joined. */
  readonly first: number
  to: Node
}

interface Node {
  /** Keyed by the first character of each label; null for a node nothing goes on from. */
  edges: Map<string, Edge> | null
  /**
   * The one edge of a node that has just one, else null: a text is followed along it without a
   * lookup, which is what a run of words that are each the start of the next costs at every step.
   */
  sole: Edge | null
  /** How many of the words added end here (two values may share a spelling). */
  ends: number
}

/** Sets `node.sole` after its edges changed. */
function settle(node: Node): void {
  node.sole = node.edges?.size === 1 ? (node.edges.values().next().value ?? null) : null
}

/** The edge that `text` takes from `node` at `pos`, if any; its label is not compared yet past the first character. */
function edgeAt(node: Node, text: string, pos: number): Edge | undefined {
  const sole = node.sole
  if (sole !== null) return text.charCodeAt(pos) === sole.first ? sole : undefined
  return node.edges?.get(text.charAt(pos))
}

/**
 * A set of words as a prefix tree with the single-child runs joined into one edge. Adding or taking
 * out a word costs its length; asking for the longest word at a place in a text costs at most the
 * length of what matches there, however many words share a start.
 */
class WordTree {
  private readonly root: Node = { edges: null, sole: null, ends: 0 }

  add(word: string): void {
    let node = this.root
    let at = 0
    while (at < word.length) {
      const edges = (node.edges ??= new Map())
      const first = word.charAt(at)
      const edge = edges.get(first)
      if (edge === undefined) {
        edges.set(first, {
          label: word.slice(at),
          first: word.charCodeAt(at),
          to: { edges: null, sole: null, ends: 1 },
        })
        settle(node)
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
        const below: Edge = {
          label: edge.label.slice(shared),
          first: edge.label.charCodeAt(shared),
          to: edge.to,
        }
        edge.label = edge.label.slice(0, shared)
        edge.to = { edges: new Map([[below.label.charAt(0), below]]), sole: below, ends: 0 }
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
      settle(above.node)
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

  /**
   * Whether the text from `at` to `limit` is the start of some word (or a word), as of the last
   * `longestAt`: that call followed the text through the tree and saw it.
   */
  covers = false

  /**
   * The length of the longest word that `text` has at `at`, or 0. Of what `text` has from `at` to
   * `limit` it also says whether that is the start of a word (`covers`), which costs no more steps.
   */
  longestAt(text: string, at: number, limit: number): number {
    let node = this.root
    let pos = at
    let longest = 0
    this.covers = false
    while (pos < text.length) {
      const edge = edgeAt(node, text, pos)
      if (edge === undefined) break
      const length = edge.label.length
      if (length > 1 && !text.startsWith(edge.label, pos)) {
        // The text goes another way along this edge, or stops: if it stops, it is the start of a word.
        this.covers = limit - pos <= length && edge.label.startsWith(text.slice(pos, limit))
        break
      }
      pos += length
      node = edge.to
      if (node.ends > 0) longest = pos - at
      if (pos >= limit) this.covers = true
    }
    return longest
  }
}

/** A copy of `text` that does not hold on to the longer string it was cut from. */
function detached(text: string): string {
  return Buffer.from(text, 'utf16le').toString('utf16le')
}

export function createSecretRegistry(): SecretRegistry {
  /**
   * Each registered value as far as it is registered (its first 4096 characters) with its spellings
   * as far as they are, the one registered longest ago first (a Map keeps the order of insertion).
   */
  const values = new Map<string, readonly string[]>()
  /** Every spelling of every value in the table, the value as written among them. */
  const spellings = new WordTree()

  const forgetStalest = (): void => {
    const stalest = values.keys().next().value
    if (stalest === undefined) return
    for (const spelling of values.get(stalest) ?? []) spellings.remove(spelling)
    values.delete(stalest)
  }

  const add = (secret: string): void => {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) return
    // What a string is cut to before it is looked at is all of the value that can show in it.
    const bounded = boundInput(secret)
    const kept = bounded.omitted === 0 ? secret : detached(bounded.text)
    const known = values.get(kept)
    if (known !== undefined) {
      // Registered again: no new place, and the newest now.
      values.delete(kept)
      values.set(kept, known)
      return
    }
    const forms = new Set<string>()
    for (const spelling of secretSpellings(kept)) {
      const form = boundInput(spelling).text
      if (form.length >= MIN_SECRET_LENGTH) forms.add(form)
    }
    values.set(kept, [...forms])
    for (const form of forms) spellings.add(form)
    if (values.size > MAX_SECRETS) forgetStalest()
  }

  const replace = (text: string): string => {
    if (values.size === 0 || text.length < MIN_SECRET_LENGTH) return text
    // The end of the text may be what an upstream cut left of a secret, with the cut mark that may
    // follow it left alone.
    const mark = CUT_MARK.exec(text)?.[0] ?? ''
    const bodyEnd = text.length - mark.length
    // [start, end) pairs, in order, the ones that overlap already joined.
    const spans: number[] = []
    // Where the end of the text before the mark begins when it is the start of a spelling, else -1:
    // the first place from which the walk through the tree took in the text to the mark.
    let tailAt = -1
    for (let at = 0; at + MIN_SECRET_LENGTH <= text.length; at += 1) {
      const length = spellings.longestAt(text, at, bodyEnd)
      if (tailAt < 0 && at + MIN_SECRET_LENGTH <= bodyEnd && spellings.covers) tailAt = at
      if (length === 0) continue
      const end = at + length
      const last = spans.length - 1
      if (last > 0 && at < (spans[last] ?? 0)) spans[last] = Math.max(spans[last] ?? 0, end)
      else spans.push(at, end)
    }
    if (tailAt >= 0) {
      // The pairs the tail reaches into or covers become part of it.
      let from = tailAt
      let to = bodyEnd
      while (spans.length > 0 && (spans[spans.length - 1] ?? 0) > from) {
        from = Math.min(from, spans[spans.length - 2] ?? from)
        to = Math.max(to, spans[spans.length - 1] ?? to)
        spans.length -= 2
      }
      spans.push(from, to)
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

  return { add, replace }
}
