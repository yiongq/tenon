import { describe, expect, it } from 'vitest'
import {
  PROVENANCE_KEY_MAX_LENGTH,
  TapeProvenanceSyntaxError,
  approvalResolvedKey,
  assembledKey,
  assertProvenanceKey,
  attemptCompletedKey,
  compactionAnchorKey,
  dispatchCommittedKey,
  isValidProvenanceKey,
  messageRetractedKey,
  messageRevisionKey,
  modelChoiceSetKey,
  modelSelectedKey,
  parentLinkKey,
  parseProvenanceKey,
  permissionDecidedKey,
  profileSetKey,
  runStartedKey,
  runTerminalKey,
  sessionStartKey,
  toolCallKey,
  toolOutcomeKey,
  toolResultKey,
  toolTableKey,
  toolsWithheldKey,
  viewContentKey,
  workspaceSetKey,
} from '../../src/tape/provenance.js'

const INCARNATION = '11111111-1111-4111-8111-111111111111'
const MESSAGE = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'
/** Hex LETTERS matter here: a digit-only uuid is unchanged by toUpperCase, so it tests nothing. */
const LETTERED = 'abcdef12-3456-4789-8abc-def012345678'

describe('provenance key grammar', () => {
  const valid = [
    'session:v1:start:11111111-1111-4111-8111-111111111111',
    'message:v1:22222222-2222-4222-8222-222222222222:0',
    'message:v1:22222222-2222-4222-8222-222222222222:retracted',
    'session:v1:model:33333333-3333-4333-8333-333333333333',
    'provider:v1:attempt:33333333-3333-4333-8333-333333333333:0:1',
    'ext:v1:acme:thing-1',
    'audit:v12:x',
    'compaction:v1:a.b_c-d',
  ]
  for (const key of valid) {
    it(`accepts ${key}`, () => {
      expect(isValidProvenanceKey(key)).toBe(true)
      expect(() => assertProvenanceKey(key)).not.toThrow()
    })
  }

  const invalid: ReadonlyArray<readonly [string, string]> = [
    ['', 'empty'],
    ['session', 'no version, no identity'],
    ['session:v1', 'no identity'],
    ['session:v1:', 'empty identity segment'],
    ['session::start', 'empty version'],
    [':v1:start', 'empty namespace'],
    ['session:1:start', 'version without v'],
    ['session:v0:start', 'v0'],
    ['session:v01:start', 'leading zero'],
    ['session:vx:start', 'non-numeric version'],
    ['unknown:v1:start', 'namespace is neither first-party nor ext'],
    ['Session:v1:start', 'namespace case'],
    ['session:v1:start:bad space', 'space in the identity'],
    ['session:v1:start:a/b', 'slash in the identity'],
    ['session:v1:start:a:b:', 'trailing empty segment'],
    [`ext:v1:acme:${'a'.repeat(PROVENANCE_KEY_MAX_LENGTH)}`, 'longer than the bound'],
    // Uniqueness in the store is byte-wise, so a case variant of a key is a SECOND row for one
    // logical fact. The builders can only mint lowercase, so neither may the validator accept more.
    [`message:v1:${LETTERED.toUpperCase()}:0`, 'uppercase identity'],
    ['session:v1:START:x', 'uppercase fixed word'],
    // An ext key is owner-scoped like the ext/<owner>/… name it belongs to; without the owner
    // segment two extensions mint the same key and the second append silently returns created:false.
    ['ext:v1:thing', 'ext without an owner segment'],
  ]
  for (const [key, why] of invalid) {
    it(`rejects ${JSON.stringify(key)} (${why})`, () => {
      expect(isValidProvenanceKey(key)).toBe(false)
      expect(parseProvenanceKey(key)).toBeNull()
      expect(() => assertProvenanceKey(key)).toThrow(TapeProvenanceSyntaxError)
    })
  }

  // A key crosses IPC and, in 6b, a bridge frame; the validator is the store's gate for input no
  // compiler saw. Each of these used to escape as a raw TypeError out of `.split`.
  const nonStrings: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', {}],
    ['an array', ['session', 'v1', 'start']],
    ['a symbol', Symbol('session:v1:start:x')],
    ['a boxed String', new String('session:v1:start:x')],
  ]
  for (const [label, value] of nonStrings) {
    it(`rejects ${label}`, () => {
      expect(isValidProvenanceKey(value as string)).toBe(false)
      expect(parseProvenanceKey(value as string)).toBeNull()
      expect(() => assertProvenanceKey(value as string)).toThrow(TapeProvenanceSyntaxError)
    })
  }

  it('parses the three parts', () => {
    expect(parseProvenanceKey('provider:v1:attempt:x:0:1')).toEqual({
      namespace: 'provider',
      version: 1,
      identity: ['attempt', 'x', '0', '1'],
    })
  })
})

/** The same key with the whole thing, and then only its identity segments, upper-cased. */
function caseVariantsOf(key: string): readonly string[] {
  const [namespace, version, ...identity] = key.split(':')
  const upperIdentity = [namespace, version, ...identity.map((s) => s.toUpperCase())].join(':')
  return [key.toUpperCase(), upperIdentity].filter((variant) => variant !== key)
}

describe('provenance key builders', () => {
  it('builds exactly the five phase-1 keys', () => {
    expect(sessionStartKey(INCARNATION)).toBe(`session:v1:start:${INCARNATION}`)
    expect(messageRevisionKey(MESSAGE, 0)).toBe(`message:v1:${MESSAGE}:0`)
    expect(messageRevisionKey(MESSAGE, 2)).toBe(`message:v1:${MESSAGE}:2`)
    expect(messageRetractedKey(MESSAGE)).toBe(`message:v1:${MESSAGE}:retracted`)
    expect(modelSelectedKey(RUN)).toBe(`session:v1:model:${RUN}`)
    expect(attemptCompletedKey(RUN, 0, 1)).toBe(`provider:v1:attempt:${RUN}:0:1`)
  })

  it('produces keys its own validator accepts', () => {
    for (const key of [
      sessionStartKey(INCARNATION),
      messageRevisionKey(MESSAGE, 7),
      messageRetractedKey(MESSAGE),
      modelSelectedKey(RUN),
      attemptCompletedKey(RUN, 3, 2),
    ]) {
      expect(isValidProvenanceKey(key)).toBe(true)
      expect(key.length).toBeLessThanOrEqual(PROVENANCE_KEY_MAX_LENGTH)
    }
  })

  it('leaves the validator no key the builders cannot mint: no case variant validates', () => {
    // The gap this closes: a validator wider than the builders means two byte-different keys for one
    // logical fact, and the store's uniqueness is byte-wise — two rows instead of created:false.
    const minted = [
      sessionStartKey(LETTERED),
      messageRevisionKey(LETTERED, 7),
      messageRetractedKey(LETTERED),
      modelSelectedKey(LETTERED),
      attemptCompletedKey(LETTERED, 3, 2),
    ]
    const variants = minted.flatMap(caseVariantsOf)
    // Every key here has at least one identity segment that changes under toUpperCase.
    expect(variants.length).toBe(minted.length * 2)
    expect(variants.filter((variant) => isValidProvenanceKey(variant))).toEqual([])
  })

  it('keeps a retracted key apart from every revision key of the same message', () => {
    expect(messageRetractedKey(MESSAGE)).not.toBe(messageRevisionKey(MESSAGE, 0))
  })

  it('rejects a non-canonical UUID', () => {
    const bad = [
      '',
      'not-a-uuid',
      'ABCDEF12-3456-4789-8ABC-DEF012345678', // uppercase is not canonical
      `{${INCARNATION}}`,
      `urn:uuid:${INCARNATION}`,
      INCARNATION.replace(/-/g, ''),
    ]
    for (const value of bad) {
      expect(() => sessionStartKey(value)).toThrow(TapeProvenanceSyntaxError)
      expect(() => messageRevisionKey(value, 0)).toThrow(/messageId/)
      expect(() => messageRetractedKey(value)).toThrow(/messageId/)
      expect(() => modelSelectedKey(value)).toThrow(/runId/)
      expect(() => attemptCompletedKey(value, 0, 0)).toThrow(/runId/)
    }
  })

  it('rejects ordinals that are not non-negative safe integers', () => {
    expect(() => messageRevisionKey(MESSAGE, -1)).toThrow(/revision/)
    expect(() => messageRevisionKey(MESSAGE, 1.5)).toThrow(/revision/)
    expect(() => messageRevisionKey(MESSAGE, Number.NaN)).toThrow(/revision/)
    expect(() => messageRevisionKey(MESSAGE, 2 ** 53)).toThrow(/revision/)
    expect(() => attemptCompletedKey(RUN, -1, 0)).toThrow(/requestSeq/)
    expect(() => attemptCompletedKey(RUN, 0, -1)).toThrow(/physicalAttempt/)
  })
})

describe('spec 02 key builders (§名字总表)', () => {
  const HASH = 'ab'.repeat(32)
  /** Every row of the table's key column, built for one call identity. */
  const keys = (id: string): Array<readonly [string, string]> => [
    [profileSetKey(id), `session:v1:profile:${id}`],
    [workspaceSetKey(id, 2), `session:v1:workspace:${id}:2`],
    [modelChoiceSetKey(id, 1), `session:v1:model_choice:${id}:1`],
    [parentLinkKey(id, 3, 1), `session:v1:parent_link:${id}:3:1`],
    [viewContentKey('system', HASH), `view:v1:content:system:${HASH}`],
    [viewContentKey('tool_spec', HASH), `view:v1:content:tool_spec:${HASH}`],
    [viewContentKey('model_info', HASH), `view:v1:content:model_info:${HASH}`],
    [toolTableKey(id, 0, 'zhipu'), `view:v1:tool_table:${id}:0:zhipu`],
    [toolsWithheldKey(id, 4), `view:v1:tools_withheld:${id}:4`],
    [assembledKey(id, 4), `view:v1:assembled:${id}:4`],
    [messageRevisionKey(id, 0), `message:v1:${id}:0`], // message/continuation
    [toolCallKey(id, 3, 1), `tool:v1:call:${id}:3:1`],
    [permissionDecidedKey(id, 3, 1), `tool:v1:decision:${id}:3:1`],
    [permissionDecidedKey(id, 3, 1, 2), `tool:v1:decision:${id}:3:1:rejudge:2`],
    [approvalResolvedKey(id, 3, 1), `tool:v1:approval:${id}:3:1`],
    [toolResultKey(id, 3, 1), `tool:v1:result:${id}:3:1`],
    [runStartedKey(id), `execution:v1:run_started:${id}`],
    [dispatchCommittedKey(id, 3, 1), `execution:v1:dispatch:${id}:3:1`],
    [toolOutcomeKey(id, 3, 1), `execution:v1:outcome:${id}:3:1`],
    [runTerminalKey(id), `execution:v1:run_terminal:${id}`],
    [compactionAnchorKey(id, 5), `compaction:v1:anchor:${id}:5`],
  ]

  it('builds exactly the keys the name table writes down, each valid and within bounds', () => {
    for (const [built, expected] of keys(RUN)) {
      expect(built).toBe(expected)
      expect(isValidProvenanceKey(built)).toBe(true)
      expect(built.length).toBeLessThanOrEqual(PROVENANCE_KEY_MAX_LENGTH)
    }
  })

  it('never mints two keys for one fact, nor one key for two', () => {
    const built = keys(RUN).map(([key]) => key)
    expect(new Set(built).size).toBe(built.length)
    // Case variants of a minted key do not validate either (the byte-wise uniqueness argument).
    expect(keys(LETTERED).filter(([key]) => isValidProvenanceKey(key.toUpperCase()))).toEqual([])
  })

  it('counts a re-judgement from 1: the first decision has no rejudge segment', () => {
    for (const r of [0, -1, 1.5, Number.NaN]) {
      expect(() => permissionDecidedKey(RUN, 0, 0, r)).toThrow(TapeProvenanceSyntaxError)
    }
    expect(permissionDecidedKey(RUN, 0, 0, 1)).not.toBe(permissionDecidedKey(RUN, 0, 0))
  })

  it('refuses a non-digest content hash, an unknown content type and an unsafe provider id', () => {
    for (const hash of ['', 'AB'.repeat(32), 'ab'.repeat(31), `${'ab'.repeat(32)}0`]) {
      expect(() => viewContentKey('system', hash)).toThrow(/64 lowercase hex/)
    }
    expect(() => viewContentKey('prompt' as 'system', HASH)).toThrow(TapeProvenanceSyntaxError)
    for (const providerId of ['', 'Zhipu', 'a:b', 'z hipu']) {
      expect(() => toolTableKey(RUN, 0, providerId)).toThrow(/providerId/)
    }
  })

  it('refuses a non-canonical id and a bad ordinal in every builder', () => {
    expect(() => toolCallKey('not-a-uuid', 0, 0)).toThrow(/runId/)
    expect(() => profileSetKey('not-a-uuid')).toThrow(/incarnationId/)
    expect(() => toolResultKey(RUN, -1, 0)).toThrow(/requestSeq/)
    expect(() => approvalResolvedKey(RUN, 0, 1.5)).toThrow(/ordinal/)
    expect(() => workspaceSetKey(INCARNATION, -1)).toThrow(/n must/)
    expect(() => toolTableKey(INCARNATION, -1, 'zhipu')).toThrow(/generation/)
  })
})
