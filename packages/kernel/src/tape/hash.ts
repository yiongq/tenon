/**
 * The hash chain recipe (spec 01 §哈希链), byte for byte:
 *
 *   field(x)     = u32be( byteLength(utf8(x)) ) ‖ utf8(x)   strings; integers as decimal strings
 *   field(bytes) = u32be( length ) ‖ bytes                  hashes as raw bytes
 *   field(null)  = 0xFFFFFFFF                               collides with no length
 *
 *   content_hash = SHA-256( field(payload_json) ‖ field(meta_json) )
 *   entry_hash   = SHA-256( field("tenon.tape.v" + hash_ver)
 *                         ‖ field(tenant_id) ‖ field(session_id) ‖ field(incarnation_id)
 *                         ‖ field(entry_id) ‖ field(kind) ‖ field(name)
 *                         ‖ field(source_type) ‖ field(source_id) ‖ field(source_seq)
 *                         ‖ field(provenance_key) ‖ field(created_at)
 *                         ‖ field(content_hash) ‖ field(prev_hash) )
 *
 * Length-prefixed, never delimiter-joined and never leaning on JSON escaping: two entries whose
 * field contents differ cannot produce the same preimage, and any language can recompute this from
 * the six lines above. The preimage covers every semantically meaningful column, so a bare UPDATE
 * of `source_id` breaks the chain; adding such a column later means bumping `hash_ver`.
 *
 * Synchronous and pure, because a store computes it inside better-sqlite3's synchronous
 * transaction — WebCrypto's async `digest()` cannot be called from there, and `node:crypto` is
 * lint-banned in the kernel. Hence @noble/hashes (MIT, zero-dependency, audited, synchronous).
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

import type { TapeKind, TapeSourceType } from './entry.js'
import { TapeIntegerRangeError } from './entry.js'

/**
 * The one bytes↔hex codec, re-exported so nothing hand-rolls a second one. A hash inside a payload
 * is lowercase hex (`ForkOrigin.entryHash`) while a hash on a column is bytes, so crossing between
 * them is routine; `bytesToHex` always emits lowercase.
 */
export { bytesToHex, hexToBytes }

/** The only recipe this build knows. A row carries its own version; readers switch on it. */
export const HASH_VER = 1

/**
 * Every recipe version this build can compute. `hash_ver` is a real column so a future recipe means
 * new rows with a new version and a verifier that picks the recipe BY ROW — not a silently broken
 * chain and not trying both. Exported because a verifier has to be able to ASK before it recomputes:
 * see `hashEntry`.
 */
export const KNOWN_HASH_VERS: readonly number[] = Object.freeze([HASH_VER])

/** The question a verifier asks about a row before trying to reseal it. */
export function isKnownHashVer(hashVer: number): boolean {
  return KNOWN_HASH_VERS.includes(hashVer)
}

/**
 * The recipe cannot be applied to what it was handed: an unknown `hash_ver`, or a digest column that
 * is not 32 bytes. Distinct from a broken chain — `verifyChain` reports a mismatching hash, but a row
 * it cannot hash at all is this.
 */
export class TapeHashRecipeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeHashRecipeError'
  }
}

/** SHA-256 digest length. `content_hash` / `prev_hash` inputs are checked against it. */
export const HASH_BYTE_LENGTH = 32

/** Every semantic column of the row being sealed. `hashVer` selects the recipe. */
export interface HashEntryFields {
  readonly hashVer: number
  readonly tenantId: string
  readonly sessionId: string
  readonly incarnationId: string
  readonly entryId: number
  readonly kind: TapeKind
  readonly name: string
  readonly sourceType: TapeSourceType
  readonly sourceId: string | null
  readonly sourceSeq: number | null
  readonly provenanceKey: string
  readonly createdAt: number
  /** The digest of the stored text, i.e. the result of `contentHash`. */
  readonly contentHash: Uint8Array
  /** null only for the first entry of an incarnation. */
  readonly prevHash: Uint8Array | null
}

const NULL_FIELD = Uint8Array.of(0xff, 0xff, 0xff, 0xff)

/** 0xFFFFFFFF is the null marker, so a real field of that length would be ambiguous. */
const MAX_FIELD_LENGTH = 0xff_ff_ff_fe

type Hasher = ReturnType<typeof sha256.create>

function u32be(length: number): Uint8Array {
  return Uint8Array.of(
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
  )
}

function pushBytes(hasher: Hasher, label: string, bytes: Uint8Array): void {
  if (bytes.length > MAX_FIELD_LENGTH) {
    throw new TapeHashRecipeError(
      `hashEntry: ${label} is too long to length-prefix (${bytes.length} bytes)`,
    )
  }
  hasher.update(u32be(bytes.length))
  hasher.update(bytes)
}

function pushText(hasher: Hasher, label: string, text: string): void {
  pushBytes(hasher, label, utf8ToBytes(text))
}

function pushInteger(hasher: Hasher, label: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new TapeIntegerRangeError(
      `hashEntry: ${label} must be a safe integer, got ${String(value)}`,
    )
  }
  // Decimal string, so the preimage never depends on an integer encoding. String(-0) is '0'.
  pushText(hasher, label, String(value))
}

function pushDigest(hasher: Hasher, label: string, digest: Uint8Array): void {
  // Exactly `Uint8Array`, not merely an instance of it: a Node `Buffer` IS a Uint8Array, and
  // invariant 17 says no Buffer crosses the port (better-sqlite3 hands a store a Buffer, which it
  // must convert with `new Uint8Array(buf)`). This is the one place the kernel sees a raw column, so
  // the leak is caught here or nowhere. A null also lands here, as this module's error rather than
  // as a TypeError from reading `.length`.
  if (!(digest instanceof Uint8Array)) {
    throw new TapeHashRecipeError(
      `hashEntry: ${label} must be a Uint8Array, got ${typeof digest}: ${String(digest)}`,
    )
  }
  if (Object.getPrototypeOf(digest) !== Uint8Array.prototype) {
    throw new TapeHashRecipeError(
      `hashEntry: ${label} must be exactly a Uint8Array, not a Buffer or another subclass`,
    )
  }
  if (digest.length !== HASH_BYTE_LENGTH) {
    throw new TapeHashRecipeError(
      `hashEntry: ${label} must be ${HASH_BYTE_LENGTH} bytes, got ${digest.length}`,
    )
  }
  pushBytes(hasher, label, digest)
}

/**
 * Hashes the two JSON columns AS STORED. Callers pass the exact text that goes to disk (the output
 * of `canonicalJson`), never a fresh serialisation of the value — that is what keeps JSON
 * normalisation out of the trust surface and lets a future content erasure keep the chain valid.
 *
 * No `hashVer` parameter: the v1 preimage is `field(payload_json) ‖ field(meta_json)` and nothing
 * else, and a parameter that does not enter the preimage would be a signature claiming a dependency
 * the recipe does not have. The version gate lives on `hashEntry`, which does hash `hash_ver` (in the
 * domain string), and on `isKnownHashVer` for a caller that wants to ask first.
 */
export function contentHash(payloadJson: string, metaJson: string): Uint8Array {
  const hasher = sha256.create()
  pushText(hasher, 'payload_json', payloadJson)
  pushText(hasher, 'meta_json', metaJson)
  return hasher.digest()
}

/**
 * Seals one row. A store calls it inside the append transaction, where entryId and prevHash exist.
 *
 * An unknown `hash_ver` is refused rather than hashed with the wrong recipe. A verifier paging over
 * rows a later build wrote must therefore ask `isKnownHashVer(row.hash_ver)` BEFORE it recomputes:
 * an unverifiable row is a fact about the data, not a broken chain, and reporting it as
 * `firstBadEntryId` would accuse a row this build simply cannot check. How `verifyChain` reports one
 * is not settled — the port's result shape (spec 01 §存储端口) has no third state — so step 7 must
 * decide it rather than let this exception escape a paging loop.
 */
export function hashEntry(fields: HashEntryFields): Uint8Array {
  if (!isKnownHashVer(fields.hashVer)) {
    throw new TapeHashRecipeError(
      `hashEntry: unknown hash_ver ${String(fields.hashVer)}; ` +
        `this build implements ${KNOWN_HASH_VERS.join(', ')}`,
    )
  }
  const hasher = sha256.create()
  pushText(hasher, 'domain', `tenon.tape.v${fields.hashVer}`)
  pushText(hasher, 'tenant_id', fields.tenantId)
  pushText(hasher, 'session_id', fields.sessionId)
  pushText(hasher, 'incarnation_id', fields.incarnationId)
  pushInteger(hasher, 'entry_id', fields.entryId)
  pushText(hasher, 'kind', fields.kind)
  pushText(hasher, 'name', fields.name)
  pushText(hasher, 'source_type', fields.sourceType)
  if (fields.sourceId === null) hasher.update(NULL_FIELD)
  else pushText(hasher, 'source_id', fields.sourceId)
  if (fields.sourceSeq === null) hasher.update(NULL_FIELD)
  else pushInteger(hasher, 'source_seq', fields.sourceSeq)
  pushText(hasher, 'provenance_key', fields.provenanceKey)
  pushInteger(hasher, 'created_at', fields.createdAt)
  pushDigest(hasher, 'content_hash', fields.contentHash)
  if (fields.prevHash === null) hasher.update(NULL_FIELD)
  else pushDigest(hasher, 'prev_hash', fields.prevHash)
  return hasher.digest()
}

/**
 * SHA-256 as lowercase hex. The provider layer's `promptHash` / `toolDefinitionsHash` are this
 * over `canonicalJson(body)`; hex because those two travel inside a payload, and a payload is
 * JSON (no room for bytes).
 */
export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === 'string' ? utf8ToBytes(input) : input))
}

/**
 * Plain, deliberately NOT constant-time. Both operands are hashes of public data — the idempotency
 * check compares one stored digest with one recomputed digest, so there is no secret to leak
 * through timing, and pretending otherwise would suggest this module offers confidentiality. It
 * does not: the chain makes tampering evident, nothing more.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}
