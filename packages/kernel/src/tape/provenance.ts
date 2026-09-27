/**
 * `provenance_key` — the idempotency key of every append (spec 01 §entry 模型).
 *
 * Grammar: `<namespace>:v<n>:<stable identity>`. What must NOT appear in it is the point: no
 * in-process counter, no timestamp, no randomness. That is what makes the same logical fact carry
 * the same key when phase 6b's bridge replays it at-least-once, so idempotency falls out instead of
 * being arranged. The cost is worth saying out loud: a fact that legitimately recurs has to put its
 * own distinguishing value in the key, or the second write silently returns `created: false`.
 *
 * The ordinals the builders accept — `revision`, `requestSeq`, `physicalAttempt` — are not process
 * counters. They are part of the fact's logical identity and are reproducible from the tape itself,
 * which is why they may appear in a key.
 *
 * The store rejects a key this module's validator turns down; the builders are the only supported
 * way to mint one for a first-party fact.
 */
import { isCanonicalUuid } from '../ids.js'
import { EXT_NAMESPACE, isReservedNamespace } from './names.js'

/** A key that does not fit the grammar. The store turns this into a rejected append. */
export class TapeProvenanceSyntaxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeProvenanceSyntaxError'
  }
}

/**
 * Keys are indexed and unique per session, and the longest first-party key is around 80 characters
 * (`provider:v1:attempt:<uuid>:<seq>:<attempt>`). The bound only keeps the pathological range out.
 */
export const PROVENANCE_KEY_MAX_LENGTH = 256

/** `v1`, `v2`, … — no leading zero, no `v0`. */
const VERSION_SEGMENT = /^v[1-9][0-9]{0,3}$/

/**
 * Identity segments carry UUIDs, small integers and fixed words. Nothing that needs escaping, and
 * LOWERCASE only: the store's uniqueness is byte-wise (`UNIQUE (tenant_id, session_id,
 * provenance_key)`), so `…-11111111111a` and `…-11111111111A` would be two rows for one logical
 * fact. The builders only ever emit lowercase (canonical UUIDs, decimal ordinals, fixed words), so
 * the validator admitting more than they can mint would be a hole in exactly the property R7 asks
 * of this grammar.
 */
const IDENTITY_SEGMENT = /^[a-z0-9._-]+$/

export interface ParsedProvenanceKey {
  readonly namespace: string
  /** The `n` of `v<n>`. */
  readonly version: number
  /** The identity segments after the version, at least one. */
  readonly identity: readonly string[]
}

/**
 * Returns null instead of throwing, for a caller that wants to classify rather than reject.
 * The namespace must be a first-party one or `ext`: a key is as namespaced as the name it belongs
 * to, so an unknown namespace is a typo or a squatter either way.
 *
 * An `ext` key is owner-scoped like the name it belongs to (`ext/<owner>/…`): without that segment
 * two extensions describing their own facts both mint `ext:v1:thing`, and the second append inside
 * one session silently returns `created: false` — the trap the spec warns about.
 */
export function parseProvenanceKey(key: string): ParsedProvenanceKey | null {
  // A key reaches a store from an untyped boundary too (IPC, a replayed bridge frame), and this
  // classifier must answer "no" rather than throw a TypeError out of `.split`.
  if (typeof key !== 'string') return null
  if (key.length === 0 || key.length > PROVENANCE_KEY_MAX_LENGTH) return null
  const segments = key.split(':')
  if (segments.length < 3) return null
  const [namespace, version, ...identity] = segments
  if (namespace === undefined || version === undefined) return null
  if (!isReservedNamespace(namespace) && namespace !== EXT_NAMESPACE) return null
  if (namespace === EXT_NAMESPACE && identity.length < 2) return null
  if (!VERSION_SEGMENT.test(version)) return null
  if (!identity.every((segment) => IDENTITY_SEGMENT.test(segment))) return null
  return { namespace, version: Number(version.slice(1)), identity }
}

export function isValidProvenanceKey(key: string): boolean {
  return parseProvenanceKey(key) !== null
}

/** The gate a store puts in front of every append. */
export function assertProvenanceKey(key: string): void {
  if (!isValidProvenanceKey(key)) {
    throw new TapeProvenanceSyntaxError(
      // String(), not a template hole: an implicit conversion throws on a symbol.
      `"${String(key)}" is not a provenance key: <namespace>:v<n>:<stable identity>, ` +
        `no counters, timestamps or randomness`,
    )
  }
}

function uuidPart(label: string, value: string): string {
  if (!isCanonicalUuid(value)) {
    throw new TapeProvenanceSyntaxError(`${label} must be a canonical UUID, got "${value}"`)
  }
  return value
}

function ordinalPart(label: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TapeProvenanceSyntaxError(
      `${label} must be a non-negative safe integer, got ${String(value)}`,
    )
  }
  return String(value)
}

/** `session:v1:start:<incarnationId>` — one per incarnation, so clearing a session gets a new key. */
export function sessionStartKey(incarnationId: string): string {
  return `session:v1:start:${uuidPart('incarnationId', incarnationId)}`
}

/**
 * `message:v1:<messageId>:<revision>`. Resending the same text reuses both parts, which is what
 * makes a retry an idempotent no-op; an edit-and-resend keeps the id and increments the revision.
 */
export function messageRevisionKey(messageId: string, revision: number): string {
  return `message:v1:${uuidPart('messageId', messageId)}:${ordinalPart('revision', revision)}`
}

/** `message:v1:<messageId>:retracted` — 'retracted' cannot collide with a revision ordinal. */
export function messageRetractedKey(messageId: string): string {
  return `message:v1:${uuidPart('messageId', messageId)}:retracted`
}

/**
 * `session:v1:model:<runId>` — one per run. Switching model inside a run (a later phase) extends
 * the key with a `:<requestSeq>` segment rather than changing what is already written.
 */
export function modelSelectedKey(runId: string): string {
  return `session:v1:model:${uuidPart('runId', runId)}`
}

/** `provider:v1:attempt:<runId>:<requestSeq>:<physicalAttempt>` — the identity of one transmission. */
export function attemptCompletedKey(
  runId: string,
  requestSeq: number,
  physicalAttempt: number,
): string {
  return (
    `provider:v1:attempt:${uuidPart('runId', runId)}` +
    `:${ordinalPart('requestSeq', requestSeq)}:${ordinalPart('physicalAttempt', physicalAttempt)}`
  )
}

// -------------------------------------------------------------------------------------------------
// Spec 02 §名字总表 — the keys of the phase-2 names, one builder per row. `<i>` is the call's
// ordinal in its reply, `<n>` the fact's ordinal in its incarnation, `<g>` the tool-table generation
// and `<r>` the call's re-judgement count (from 1); all of them come from the tape, never a counter.
// `message/continuation` has no builder of its own: its key is `messageRevisionKey(messageId, 0)`.
// -------------------------------------------------------------------------------------------------

/** A digest in a key: lowercase SHA-256 hex, the only spelling `canonicalHash` / `systemHash` emit. */
function digestPart(label: string, value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TapeProvenanceSyntaxError(`${label} must be 64 lowercase hex digits, got "${value}"`)
  }
  return value
}

/** A provider id inside a key: it has to be a valid identity segment as it stands. */
function providerPart(value: string): string {
  if (typeof value !== 'string' || !IDENTITY_SEGMENT.test(value)) {
    throw new TapeProvenanceSyntaxError(
      `providerId must be a lowercase identity segment ([a-z0-9._-]+), got "${value}"`,
    )
  }
  return value
}

/** `…:<runId>:<requestSeq>:<i>` — the key every tool/ fact and per-call execution/ fact hangs on. */
function callPart(runId: string, requestSeq: number, ordinal: number): string {
  return (
    `${uuidPart('runId', runId)}:${ordinalPart('requestSeq', requestSeq)}` +
    `:${ordinalPart('ordinal', ordinal)}`
  )
}

/** `session:v1:profile:<incarnationId>` — rewritten with the carry when a session is cleared. */
export function profileSetKey(incarnationId: string): string {
  return `session:v1:profile:${uuidPart('incarnationId', incarnationId)}`
}

/** `session:v1:workspace:<incarnationId>:<n>`. */
export function workspaceSetKey(incarnationId: string, n: number): string {
  return `session:v1:workspace:${uuidPart('incarnationId', incarnationId)}:${ordinalPart('n', n)}`
}

/** `session:v1:model_choice:<incarnationId>:<n>` — `<n>` is counted from the tape in the queue. */
export function modelChoiceSetKey(incarnationId: string, n: number): string {
  return (
    `session:v1:model_choice:${uuidPart('incarnationId', incarnationId)}` +
    `:${ordinalPart('n', n)}`
  )
}

/** `session:v1:parent_link:<runId>:<requestSeq>:<i>`. */
export function parentLinkKey(runId: string, requestSeq: number, ordinal: number): string {
  return `session:v1:parent_link:${callPart(runId, requestSeq, ordinal)}`
}

/** `view:v1:content:<type>:<hash>` — content-addressed, so the same content is written once. */
export function viewContentKey(type: 'system' | 'tool_spec' | 'model_info', hash: string): string {
  if (type !== 'system' && type !== 'tool_spec' && type !== 'model_info') {
    throw new TapeProvenanceSyntaxError(
      `view/content type must be system, tool_spec or model_info, got "${String(type)}"`,
    )
  }
  return `view:v1:content:${type}:${digestPart('hash', hash)}`
}

/** `view:v1:tool_table:<incarnationId>:<g>:<providerId>`. */
export function toolTableKey(
  incarnationId: string,
  generation: number,
  providerId: string,
): string {
  return (
    `view:v1:tool_table:${uuidPart('incarnationId', incarnationId)}` +
    `:${ordinalPart('generation', generation)}:${providerPart(providerId)}`
  )
}

/** `view:v1:tools_withheld:<runId>:<requestSeq>`. */
export function toolsWithheldKey(runId: string, requestSeq: number): string {
  return `view:v1:tools_withheld:${uuidPart('runId', runId)}:${ordinalPart('requestSeq', requestSeq)}`
}

/** `view:v1:assembled:<runId>:<requestSeq>` — a transient resend of the same requestSeq reuses it. */
export function assembledKey(runId: string, requestSeq: number): string {
  return `view:v1:assembled:${uuidPart('runId', runId)}:${ordinalPart('requestSeq', requestSeq)}`
}

/** `tool:v1:call:<runId>:<requestSeq>:<i>`. */
export function toolCallKey(runId: string, requestSeq: number, ordinal: number): string {
  return `tool:v1:call:${callPart(runId, requestSeq, ordinal)}`
}

/**
 * `tool:v1:decision:<runId>:<requestSeq>:<i>`, and `…:<i>:rejudge:<r>` for a re-judgement. `<r>`
 * counts from 1 per call and equals the payload's `rejudge`; 0 is the first decision, which has no
 * `rejudge` segment at all, so it is refused here rather than minting a second key for it.
 */
export function permissionDecidedKey(
  runId: string,
  requestSeq: number,
  ordinal: number,
  rejudge?: number,
): string {
  const base = `tool:v1:decision:${callPart(runId, requestSeq, ordinal)}`
  if (rejudge === undefined) return base
  if (!Number.isSafeInteger(rejudge) || rejudge < 1) {
    throw new TapeProvenanceSyntaxError(
      `rejudge counts from 1 (the first decision has none), got ${String(rejudge)}`,
    )
  }
  return `${base}:rejudge:${String(rejudge)}`
}

/** `tool:v1:approval:<runId>:<requestSeq>:<i>` — one key for every outcome, so a call gets one. */
export function approvalResolvedKey(runId: string, requestSeq: number, ordinal: number): string {
  return `tool:v1:approval:${callPart(runId, requestSeq, ordinal)}`
}

/** `tool:v1:result:<runId>:<requestSeq>:<i>`. */
export function toolResultKey(runId: string, requestSeq: number, ordinal: number): string {
  return `tool:v1:result:${callPart(runId, requestSeq, ordinal)}`
}

/** `execution:v1:run_started:<runId>`. */
export function runStartedKey(runId: string): string {
  return `execution:v1:run_started:${uuidPart('runId', runId)}`
}

/** `execution:v1:dispatch:<runId>:<requestSeq>:<i>`. */
export function dispatchCommittedKey(runId: string, requestSeq: number, ordinal: number): string {
  return `execution:v1:dispatch:${callPart(runId, requestSeq, ordinal)}`
}

/** `execution:v1:outcome:<runId>:<requestSeq>:<i>`. */
export function toolOutcomeKey(runId: string, requestSeq: number, ordinal: number): string {
  return `execution:v1:outcome:${callPart(runId, requestSeq, ordinal)}`
}

/** `execution:v1:run_terminal:<runId>`. */
export function runTerminalKey(runId: string): string {
  return `execution:v1:run_terminal:${uuidPart('runId', runId)}`
}

/** `compaction:v1:anchor:<runId>:<requestSeq>` — the requestSeq of the summary request. */
export function compactionAnchorKey(runId: string, requestSeq: number): string {
  return `compaction:v1:anchor:${uuidPart('runId', runId)}:${ordinalPart('requestSeq', requestSeq)}`
}
