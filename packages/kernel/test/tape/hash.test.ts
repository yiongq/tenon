/**
 * Fixed vectors pin the hash recipe of spec 01 §哈希链. Every expected digest below was derived
 * INDEPENDENTLY of this implementation: a throwaway node:crypto script built each preimage by hand
 * from the six lines of the spec, and its hex output is hard-coded here. Changing the recipe must
 * therefore break these tests, and a second implementation (the desktop store, a server host, a
 * third-party auditor) can be checked against the same numbers.
 */
import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { HashEntryFields, StoredEntryFields } from '../../src/tape/hash.js'
import {
  HASH_BYTE_LENGTH,
  HASH_VER,
  KNOWN_HASH_VERS,
  TapeHashRecipeError,
  bytesEqual,
  contentHash,
  hashEntry,
  isKnownHashVer,
  isStoredEntryProvable,
  sha256Hex,
} from '../../src/tape/hash.js'
import { TapeIntegerRangeError } from '../../src/tape/entry.js'

const hex = (bytes: Uint8Array): string => bytesToHex(bytes)

const START_PAYLOAD = '{"incarnationId":"11111111-1111-4111-8111-111111111111"}'
const USER_PAYLOAD =
  '{"content":[{"text":"hi","type":"text"}],"messageId":"22222222-2222-4222-8222-222222222222"' +
  ',"revision":0,"role":"user","status":"complete"}'
const ASTRAL_PAYLOAD = '{"text":"你好 😀 \\u0301"}'

const startContent = contentHash(START_PAYLOAD, '{}')
const userContent = contentHash(USER_PAYLOAD, '{}')

/** (a) The first entry of an incarnation: prev_hash is null. */
const first: HashEntryFields = {
  hashVer: HASH_VER,
  tenantId: 'tenant-a',
  sessionId: 'session-1',
  incarnationId: '11111111-1111-4111-8111-111111111111',
  entryId: 1,
  kind: 'anchor',
  name: 'session/start',
  sourceType: 'session',
  sourceId: 'session-1',
  sourceSeq: 0,
  provenanceKey: 'session:v1:start:11111111-1111-4111-8111-111111111111',
  createdAt: 1_700_000_000_000,
  contentHash: startContent,
  prevHash: null,
}
const FIRST_HASH = '068a4166b50adf36991d71ef15678efaf3b606b04308c766a65fcb7568324519'

/** (b) The next entry, chained onto (a). */
const chained: HashEntryFields = {
  ...first,
  entryId: 2,
  kind: 'message',
  name: 'message/user',
  sourceType: 'message',
  sourceId: '22222222-2222-4222-8222-222222222222',
  sourceSeq: 0,
  provenanceKey: 'message:v1:22222222-2222-4222-8222-222222222222:0',
  createdAt: 1_700_000_000_001,
  contentHash: userContent,
  prevHash: hashEntry(first),
}

describe('contentHash', () => {
  it('hashes the two JSON columns with length prefixes', () => {
    expect(hex(contentHash('{}', '{}'))).toBe(
      'eef9f070664c5c5011b7b31b97777941c0a8d37775dacc1cde1a77ed54fd9274',
    )
    expect(hex(startContent)).toBe(
      '18fdd8c80eab160301d79ecc95bb4daee0e114b4e6407d8eb847eade7afa1c73',
    )
    expect(hex(userContent)).toBe(
      '830894d172564557994f10afc27002904c85bd1a88129cef04d7ac268cda1614',
    )
  })

  it('hashes the STORED TEXT, so the same value in different text differs', () => {
    expect(hex(contentHash('{"a":1}', '{}'))).toBe(
      '8f2611fbf47697803299011e76277bb4965d4644050ddcceb2c514b8ef30c7cf',
    )
    expect(hex(contentHash('{ "a": 1 }', '{}'))).toBe(
      '0343726ed79ebdde531cca80d118f206285f9ec91832f8982e33e20c1e101a82',
    )
  })

  it('covers non-ASCII and astral characters byte for byte', () => {
    expect(hex(contentHash(ASTRAL_PAYLOAD, '{"lang":"zh"}'))).toBe(
      '9b91523a54c49717fc0f0ddef279de188f02788d45a5e6acdf39740f23b8c2b4',
    )
  })

  it('returns a 32-byte digest', () => {
    expect(startContent).toHaveLength(HASH_BYTE_LENGTH)
  })
})

describe('hashEntry · fixed vectors', () => {
  it('(a) seals a first entry with prev_hash null', () => {
    expect(hex(hashEntry(first))).toBe(FIRST_HASH)
  })

  it('(b) seals a chained entry', () => {
    expect(hex(hashEntry(chained))).toBe(
      '8e1ff9b94062aa9c6f9ed8c347959b8222fad05289424e2e825b439f0f729ec6',
    )
  })

  it('(c) seals null source_id / source_seq', () => {
    expect(hex(hashEntry({ ...chained, sourceId: null, sourceSeq: null }))).toBe(
      '9c48bfe4ccfe5676a2f8fa8efa7adf67565cbb850ca4b3b752adcea1231fb01a',
    )
  })

  it('(d) covers non-ASCII and astral characters in the identity columns', () => {
    expect(
      hex(
        hashEntry({
          ...first,
          tenantId: '租户-a',
          sessionId: 'session-😀',
          contentHash: contentHash(ASTRAL_PAYLOAD, '{"lang":"zh"}'),
        }),
      ),
    ).toBe('854cc236cc87aaf68c538a71b0d1132c0b389ab93c9bb195da20038d74b83f1c')
  })

  it('(e) does not collide where naive concatenation would', () => {
    // 'ab' ‖ 'c' and 'a' ‖ 'bc' at adjacent fields (session_id, incarnation_id) produce the same
    // byte run without length prefixes. This pair is the reason the recipe prefixes every field.
    const left = hashEntry({ ...first, sessionId: 'ab', incarnationId: 'c' })
    const right = hashEntry({ ...first, sessionId: 'a', incarnationId: 'bc' })
    expect(hex(left)).toBe('5e9b0cb6f05a49067486666115993949754b8edc62601ea021b04b278a71fb99')
    expect(hex(right)).toBe('bf764172eadf284e8bc7da2e03f03022f52473d3f373e7ca6d059d348a5cbaec')
    expect(bytesEqual(left, right)).toBe(false)
  })

  it('(f) distinguishes null from an empty string', () => {
    const empty = hashEntry({ ...first, sourceId: '' })
    const absent = hashEntry({ ...first, sourceId: null })
    expect(hex(empty)).toBe('ba842629ee349d97668a1a5416e776a55d011b405c6d7bf758997c1b2e25aaf6')
    expect(hex(absent)).toBe('05fb84f70aaedfaadbfa77398dd8df839e9504c998f847e35e0ece1d34bd24de')
    expect(bytesEqual(empty, absent)).toBe(false)
  })

  it('is stable across calls and covers every semantic column', () => {
    expect(hex(hashEntry(first))).toBe(hex(hashEntry({ ...first })))
    const columns: ReadonlyArray<readonly [string, Partial<HashEntryFields>]> = [
      ['tenantId', { tenantId: 'tenant-b' }],
      ['sessionId', { sessionId: 'session-2' }],
      ['incarnationId', { incarnationId: '33333333-3333-4333-8333-333333333333' }],
      ['entryId', { entryId: 2 }],
      ['kind', { kind: 'event' }],
      ['name', { name: 'session/model_selected' }],
      ['sourceType', { sourceType: 'runtime_event' }],
      ['sourceId', { sourceId: 'other' }],
      ['sourceSeq', { sourceSeq: 1 }],
      ['provenanceKey', { provenanceKey: 'session:v1:start:other' }],
      ['createdAt', { createdAt: 1_700_000_000_001 }],
      ['contentHash', { contentHash: userContent }],
      ['prevHash', { prevHash: userContent }],
    ]
    // Any column that does NOT change the digest is listed by name in the failure.
    const unsealed = columns
      .filter(([, patch]) => hex(hashEntry({ ...first, ...patch })) === FIRST_HASH)
      .map(([column]) => column)
    expect(unsealed).toEqual([])
  })
})

describe('hashEntry · refusals', () => {
  it('refuses an unknown hash_ver instead of guessing a recipe', () => {
    expect(() => hashEntry({ ...first, hashVer: 2 })).toThrow(TapeHashRecipeError)
    expect(() => hashEntry({ ...first, hashVer: 2 })).toThrow(/unknown hash_ver 2/)
    expect(() => hashEntry({ ...first, hashVer: 0 })).toThrow(/unknown hash_ver/)
  })

  it('answers which versions it can verify, so a verifier can ask before it recomputes', () => {
    expect([...KNOWN_HASH_VERS]).toEqual([HASH_VER])
    expect(isKnownHashVer(HASH_VER)).toBe(true)
    expect(isKnownHashVer(2)).toBe(false)
    expect(isKnownHashVer(0)).toBe(false)
  })

  it('refuses integers outside the safe range with the error the port names', () => {
    expect(() => hashEntry({ ...first, entryId: 2 ** 53 })).toThrow(TapeIntegerRangeError)
    expect(() => hashEntry({ ...first, entryId: 2 ** 53 })).toThrow(/entry_id/)
    expect(() => hashEntry({ ...first, createdAt: 1.5 })).toThrow(/created_at/)
    expect(() => hashEntry({ ...first, sourceSeq: -1.5 })).toThrow(/source_seq/)
  })

  it('refuses a digest that is not 32 bytes', () => {
    expect(() => hashEntry({ ...first, contentHash: new Uint8Array(16) })).toThrow(/content_hash/)
    expect(() => hashEntry({ ...first, prevHash: new Uint8Array(33) })).toThrow(/prev_hash/)
  })

  it('refuses a digest that is not exactly a Uint8Array, so no Buffer leaks through', () => {
    // A Node Buffer IS a Uint8Array, so `instanceof` would wave it through and the host type would
    // travel on into whatever the store returns (invariant 17). The prototype is what distinguishes
    // them; this stand-in has the same shape as a Buffer without importing node:buffer.
    class BufferLike extends Uint8Array {}
    const buffered = new BufferLike(HASH_BYTE_LENGTH)
    expect(buffered).toBeInstanceOf(Uint8Array)
    expect(() => hashEntry({ ...first, contentHash: buffered })).toThrow(TapeHashRecipeError)
    expect(() => hashEntry({ ...first, contentHash: buffered })).toThrow(/exactly a Uint8Array/)
    expect(() => hashEntry({ ...first, prevHash: buffered })).toThrow(/exactly a Uint8Array/)
    // The conversion a store is required to do produces a plain Uint8Array, which passes.
    expect(() => hashEntry({ ...first, contentHash: new Uint8Array(buffered) })).not.toThrow()
  })

  it('refuses a missing digest as its own error, not a TypeError from reading .length', () => {
    expect(() => hashEntry({ ...first, contentHash: null as unknown as Uint8Array })).toThrow(
      TapeHashRecipeError,
    )
    expect(() => hashEntry({ ...first, contentHash: undefined as unknown as Uint8Array })).toThrow(
      TapeHashRecipeError,
    )
  })
})

describe('sha256Hex and bytesEqual', () => {
  it('matches the published SHA-256 vectors', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Hex('abc')).toBe(sha256Hex(new Uint8Array([97, 98, 99])))
  })

  it('compares bytes by value', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
    expect(bytesEqual(startContent, startContent)).toBe(true)
  })
})

/**
 * `isStoredEntryProvable` is the predicate every store's `verifyChain` is built from, so its FALSE
 * branches are what acceptance 12's byte flip exercises through SQLite — and they are unreachable
 * through the port (nothing can corrupt a stored row from outside). Unit-testing them here is what
 * keeps a store from shipping a `verifyChain` that trusts the `content_hash` column, forgets to link
 * the rows, or quietly blesses a `hash_ver` it cannot compute (plan.md 「Open」: report it as the bad
 * entry).
 */
describe('isStoredEntryProvable', () => {
  const storedFirst: StoredEntryFields = {
    ...first,
    payloadJson: START_PAYLOAD,
    metaJson: '{}',
    entryHash: hashEntry(first),
  }
  const storedSecond: StoredEntryFields = {
    ...chained,
    payloadJson: USER_PAYLOAD,
    metaJson: '{}',
    entryHash: hashEntry(chained),
  }

  it('accepts a healthy chain', () => {
    expect(isStoredEntryProvable(storedFirst, null)).toBe(true)
    expect(isStoredEntryProvable(storedSecond, storedFirst.entryHash)).toBe(true)
  })

  it('rejects a payload byte that changed under an intact content_hash column', () => {
    const flipped: StoredEntryFields = {
      ...storedFirst,
      payloadJson: START_PAYLOAD.replace('1111-1111', '1111-1112'),
    }
    expect(isStoredEntryProvable(flipped, null)).toBe(false)
    // …and the meta column is covered by the same digest.
    expect(isStoredEntryProvable({ ...storedFirst, metaJson: '{"a":1}' }, null)).toBe(false)
  })

  it('rejects a broken link even when both rows are individually intact', () => {
    expect(isStoredEntryProvable(storedSecond, null)).toBe(false)
    expect(isStoredEntryProvable(storedSecond, storedSecond.entryHash)).toBe(false)
    expect(isStoredEntryProvable(storedFirst, storedSecond.entryHash)).toBe(false)
  })

  it('rejects a broken seal, including one hiding a rewritten identity column', () => {
    expect(isStoredEntryProvable({ ...storedFirst, entryHash: userContent }, null)).toBe(false)
    // A bare UPDATE of source_id: the text and the content hash still agree, the seal does not.
    expect(isStoredEntryProvable({ ...storedFirst, sourceId: 'another-session' }, null)).toBe(false)
    expect(isStoredEntryProvable({ ...storedFirst, createdAt: 1_700_000_000_001 }, null)).toBe(
      false,
    )
  })

  it('rejects a hash_ver this build cannot compute rather than blessing it', () => {
    expect(isStoredEntryProvable({ ...storedFirst, hashVer: HASH_VER + 1 }, null)).toBe(false)
  })

  it('rejects a row the recipe cannot hash at all instead of throwing at the caller', () => {
    // A prev_hash that is not 32 bytes and matches the previous row byte for byte: the link check
    // passes, so what fails is the recipe itself. A verifier must still name the row.
    const short = new Uint8Array(HASH_BYTE_LENGTH - 1)
    expect(isStoredEntryProvable({ ...storedSecond, prevHash: short }, short)).toBe(false)
    // An entry_id outside the safe range is the same class of unusable row.
    expect(isStoredEntryProvable({ ...storedFirst, entryId: 2 ** 60 }, null)).toBe(false)
  })
})
