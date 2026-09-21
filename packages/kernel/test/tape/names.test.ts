/**
 * Acceptance 13 and invariant 14 of spec 01: the reserved-namespace table and the two-way append
 * authorisation. The attack list is the point of this file — every name a caller might reach for
 * from the wrong side has its own case, so weakening the table turns a test red rather than opening
 * a hole nobody notices until a user's file has a squatter's `execution/foo` in it.
 *
 * The identity columns get the same treatment. The spec's fact table fixes
 * `(source_type, source_id, source_seq)` per name, all three are in the hash preimage, and
 * `source_id` is what recovery groups a run by — so a fact written with the wrong identity is
 * unfindable AND makes its own correct rewrite a provenance conflict.
 */
import { describe, expect, it } from 'vitest'
import type { TapeKind, TapeSourceType } from '../../src/tape/entry.js'
import type {
  AppendAuthorizationInput,
  DeclaredTapeName,
  SliceEntryFields,
  TapeSlice,
} from '../../src/tape/names.js'
import {
  DECLARED_TAPE_NAMES,
  EXT_NAMESPACE,
  RESERVED_NAMESPACES,
  TAPE_NAME_MAX_LENGTH,
  TapeAppendAuthorizationError,
  TapeNameSyntaxError,
  assertAppendAuthorized,
  assertTapeName,
  createEntryWriter,
  declaredTapeName,
  isReservedNamespace,
} from '../../src/tape/names.js'

const SLICES: readonly TapeSlice[] = ['session', 'message', 'provider', 'execution', 'fs', 'skill']

const SUBJECT = '11111111-1111-4111-8111-111111111111'

/**
 * For a name with no declaration (an `ext/…` name, an undeclared sibling) nothing is fixed, so one
 * fixture serves. A declared name gets `fieldsFor`.
 */
const fields: SliceEntryFields = {
  sourceType: 'session',
  provenanceKey: 'ext:v1:acme:note',
  payload: { note: 'x' },
  createdAt: 1_700_000_000_000,
}

/** The identity triple the declaration demands — the happy path of the source gate. */
function fieldsFor(declared: DeclaredTapeName): SliceEntryFields {
  const seq = declared.sourceSeq
  return {
    sourceType: declared.sourceType ?? 'session',
    ...(declared.sourceId === 'null' ? {} : { sourceId: SUBJECT }),
    ...(seq === undefined || seq === 'null' ? {} : { sourceSeq: seq === 'ordinal' ? 3 : seq }),
    provenanceKey: `session:v1:start:${SUBJECT}`,
    payload: {},
    createdAt: 1_700_000_000_000,
  }
}

/** The name-and-kind question, with an identity that is never the reason for a rejection. */
function ask(
  kind: TapeKind,
  name: string,
  sourceType: TapeSourceType = 'session',
): AppendAuthorizationInput {
  return { kind, name, sourceType }
}

describe('the reserved namespace table', () => {
  it('reserves the twelve first-party prefixes and is frozen', () => {
    expect([...RESERVED_NAMESPACES]).toEqual([
      'session',
      'message',
      'tool',
      'execution',
      'contract',
      'view',
      'provider',
      'compaction',
      'fs',
      'skill',
      'plugin',
      'audit',
    ])
    expect(Object.isFrozen(RESERVED_NAMESPACES)).toBe(true)
    expect(Object.isFrozen(DECLARED_TAPE_NAMES)).toBe(true)
    expect(DECLARED_TAPE_NAMES.filter((d) => !Object.isFrozen(d))).toEqual([])
    expect(isReservedNamespace(EXT_NAMESPACE)).toBe(false)
  })

  it('declares every name under its own slice namespace, and nothing outside a reserved prefix', () => {
    const namespaces = DECLARED_TAPE_NAMES.map((d) => [d.name, d.name.split('/')[0] ?? ''])
    expect(namespaces).toEqual(DECLARED_TAPE_NAMES.map((d) => [d.name, d.slice]))
    expect(namespaces.filter(([, namespace]) => !isReservedNamespace(namespace ?? ''))).toEqual([])
    for (const declared of DECLARED_TAPE_NAMES) {
      expect(declaredTapeName(declared.name)).toEqual(declared)
    }
    expect(declaredTapeName('execution/anything')).toBeNull()
  })

  it('declares the phase-1 names and the reserved-only ones with their bound kinds', () => {
    const table = new Map(DECLARED_TAPE_NAMES.map((d) => [d.name, `${d.slice}/${d.kind}`]))
    expect(table.get('session/start')).toBe('session/anchor')
    expect(table.get('session/model_selected')).toBe('session/event')
    expect(table.get('message/user')).toBe('message/message')
    expect(table.get('message/assistant')).toBe('message/message')
    expect(table.get('message/retracted')).toBe('message/event')
    expect(table.get('provider/attempt_completed')).toBe('provider/event')
    expect(table.get('session/parent_link')).toBe('session/event')
    expect(table.get('execution/run_started')).toBe('execution/event')
    expect(table.get('execution/dispatch_committed')).toBe('execution/event')
    expect(table.get('execution/tool_outcome')).toBe('execution/event')
    expect(table.get('execution/run_terminal')).toBe('execution/event')
    expect(table.get('fs/snapshot_created')).toBe('fs/event')
  })

  it('pins the identity triple of every phase-1 name to the spec’s fact table', () => {
    const triple = new Map(
      DECLARED_TAPE_NAMES.map((d) => [
        d.name,
        [d.sourceType, d.sourceId, d.sourceSeq].map((part) => String(part)).join('/'),
      ]),
    )
    // kind | name | source of spec 01 §entry 模型's table, read left to right.
    expect(triple.get('session/start')).toBe('session/required/0')
    expect(triple.get('session/model_selected')).toBe('session/required/null')
    expect(triple.get('message/user')).toBe('message/required/ordinal')
    expect(triple.get('message/assistant')).toBe('message/required/ordinal')
    expect(triple.get('message/retracted')).toBe('message/required/null')
    expect(triple.get('provider/attempt_completed')).toBe('runtime_event/required/ordinal')
    // Reserved-only names fix nothing: the phase that writes them declares their triple with them.
    expect(triple.get('execution/run_started')).toBe('undefined/undefined/undefined')
  })

  it('declares no context-kind name yet, so no writer can produce one', () => {
    expect(DECLARED_TAPE_NAMES.filter((d) => d.kind === 'context')).toEqual([])
  })
})

describe('name syntax', () => {
  const malformed = [
    '',
    'message',
    'message/',
    '/user',
    'message//user',
    'Message/User',
    'message/User',
    'message/user-1',
    'message/user.1',
    'message/1user',
    'message/user ',
    'ext/acme/note!',
    'a/b/c/d/e/f/g/h/i',
    `ext/acme/${'a'.repeat(TAPE_NAME_MAX_LENGTH)}`,
  ]
  for (const name of malformed) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      expect(() => assertTapeName(name)).toThrow(TapeNameSyntaxError)
      expect(() => assertAppendAuthorized(ask('event', name), null)).toThrow(TapeNameSyntaxError)
      expect(() => assertAppendAuthorized(ask('event', name), 'message')).toThrow(
        TapeNameSyntaxError,
      )
    })
  }

  // A name can arrive from IPC or a replayed bridge frame, where no compiler was present. Each of
  // these used to escape as a raw TypeError, which a caller catching the named class does not catch.
  const nonStrings: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', {}],
    ['an array of segments', ['ext', 'acme', 'thing']],
    ['a boolean', true],
    ['a symbol', Symbol('ext/acme/thing')],
    // Accepted outright before: an object where the store writes a TEXT column.
    ['a boxed String', new String('ext/acme/thing')],
  ]
  for (const [label, value] of nonStrings) {
    it(`rejects ${label} as a name`, () => {
      expect(() => assertTapeName(value as string)).toThrow(TapeNameSyntaxError)
      expect(() => assertAppendAuthorized(ask('event', value as string), null)).toThrow(
        TapeNameSyntaxError,
      )
      expect(() => createEntryWriter(null)(value as string, { ...fields, kind: 'event' })).toThrow(
        TapeNameSyntaxError,
      )
    })
  }

  it('accepts a two-segment first-party name and a three-segment ext name', () => {
    expect(() => assertTapeName('message/user')).not.toThrow()
    expect(() => assertTapeName('ext/acme/note_2')).not.toThrow()
  })
})

describe('the closed kind and sourceType vocabularies', () => {
  it('rejects a kind outside the vocabulary, present or absent', () => {
    const name = 'ext/acme/note'
    expect(() =>
      assertAppendAuthorized({ kind: 'bogus_kind' as TapeKind, name, sourceType: 'session' }, null),
    ).toThrow(TapeAppendAuthorizationError)
    expect(() =>
      assertAppendAuthorized(
        { name, sourceType: 'session' } as unknown as AppendAuthorizationInput,
        null,
      ),
    ).toThrow(TapeAppendAuthorizationError)
    expect(() =>
      createEntryWriter(null)(name, { ...fields, kind: 'bogus_kind' as TapeKind }),
    ).toThrow(TapeAppendAuthorizationError)
  })

  it('rejects a sourceType outside the vocabulary, present or absent', () => {
    const name = 'ext/acme/note'
    expect(() =>
      assertAppendAuthorized(
        { kind: 'event', name, sourceType: 'bogus_source' as TapeSourceType },
        null,
      ),
    ).toThrow(TapeAppendAuthorizationError)
    expect(() =>
      assertAppendAuthorized({ kind: 'event', name } as AppendAuthorizationInput, null),
    ).toThrow(TapeAppendAuthorizationError)
    expect(() =>
      createEntryWriter(null)(name, {
        ...fields,
        kind: 'event',
        sourceType: 'bogus_source' as TapeSourceType,
      }),
    ).toThrow(TapeAppendAuthorizationError)
  })
})

describe('generic append (slice = null)', () => {
  /**
   * WHICH guard each reason names, as its own message reads. Asserting only that SOMETHING was
   * thrown leaves the generic path's guards covering for each other: delete the reserved-prefix
   * check and every reserved name is still caught by "must be under ext/", delete that one and a
   * two-segment name is still caught by "needs an owner segment". The message is the only thing
   * that tells one rejection from another, so every row names the guard it exists to hold up.
   *
   * This makes guard ORDER part of the asserted contract, deliberately: swapping two guards changes
   * no verdict, only which message a rejected name gets, and reds these rows. That is the price of
   * telling the guards apart at all — a reorder is a reviewable change to what a caller is told.
   */
  const guardMessage: Readonly<Record<string, RegExp>> = {
    'a declared reserved name': /reserved prefix/,
    'an undeclared sibling': /reserved prefix/,
    'not ext/': /generic append may only write ext\/<owner>/,
    'no owner segment': /missing an owner segment/,
    'kind context': /kind 'context' is reserved/,
  }

  const rejected: ReadonlyArray<readonly [TapeKind, string, string]> = [
    // An exact reserved name…
    ['event', 'execution/run_started', 'a declared reserved name'],
    ['anchor', 'session/start', 'a declared reserved name'],
    ['message', 'message/user', 'a declared reserved name'],
    ['event', 'provider/attempt_completed', 'a declared reserved name'],
    ['event', 'message/retracted', 'a declared reserved name'],
    // …and an UNDECLARED sibling under the same prefix, which is the hole DeepChat left open.
    ['event', 'execution/anything', 'an undeclared sibling'],
    ['event', 'tool/anything', 'an undeclared sibling'],
    ['event', 'fs/anything', 'an undeclared sibling'],
    ['event', 'view/assembled', 'an undeclared sibling'],
    ['event', 'view/tool_result', 'an undeclared sibling'],
    ['event', 'contract/anything', 'an undeclared sibling'],
    ['event', 'compaction/anything', 'an undeclared sibling'],
    ['event', 'skill/anything', 'an undeclared sibling'],
    ['event', 'plugin/anything', 'an undeclared sibling'],
    ['event', 'audit/anything', 'an undeclared sibling'],
    ['event', 'session/anything', 'an undeclared sibling'],
    ['event', 'message/anything', 'an undeclared sibling'],
    ['event', 'provider/anything', 'an undeclared sibling'],
    // A namespace that is neither first-party nor ext. The two-segment one is caught by the owner
    // guard as well, so the THREE-segment ones are what the "must be under ext/" guard alone holds
    // back: well-formed names a vendor could plausibly reach for, under a namespace nobody reserved.
    ['event', 'other/thing', 'not ext/'],
    ['event', 'other/acme/thing', 'not ext/'],
    ['event', 'acme/vendor/note', 'not ext/'],
    ['message', 'vendor/acme/message', 'not ext/'],
    // A namespace that merely BEGINS with `ext`, and one `ext` begins with: the guard is an exact
    // namespace match, not containment either way. Catches `namespace !== EXT_NAMESPACE` weakened
    // to `!namespace.startsWith(EXT_NAMESPACE)` (which would let `extra/` and `extension/` write)
    // and to `!EXT_NAMESPACE.startsWith(namespace)` (which would let `ex/` write).
    ['event', 'extra/acme/thing', 'not ext/'],
    ['event', 'extension/acme/note', 'not ext/'],
    ['event', 'ex/acme/thing', 'not ext/'],
    ['event', 'ext/note', 'no owner segment'],
    // The context kind is reserved wholesale for skill/.
    ['context', 'ext/acme/note', 'kind context'],
    // Not the context guard: `skill` IS the namespace that kind belongs to, so what stops this one
    // is the reserved prefix — generic append writes no skill/ name, whatever its kind.
    ['context', 'skill/note', 'an undeclared sibling'],
    ['context', 'message/user', 'kind context'],
  ]
  for (const [kind, name, why] of rejected) {
    it(`rejects ${kind} ${name} (${why})`, () => {
      const guard = guardMessage[why]
      if (guard === undefined) throw new Error(`no guard message declared for "${why}"`)
      expect(() => assertAppendAuthorized(ask(kind, name), null)).toThrow(
        TapeAppendAuthorizationError,
      )
      // The guard that fired, not merely that one did.
      expect(() => assertAppendAuthorized(ask(kind, name), null)).toThrow(guard)
      expect(() => createEntryWriter(null)(name, { ...fields, kind })).toThrow(
        TapeAppendAuthorizationError,
      )
      expect(() => createEntryWriter(null)(name, { ...fields, kind })).toThrow(guard)
    })
  }

  it('allows ext/<owner>/… with an explicit kind', () => {
    expect(() => assertAppendAuthorized(ask('event', 'ext/acme/note'), null)).not.toThrow()
    const entry = createEntryWriter(null)('ext/acme/note', { ...fields, kind: 'event' })
    expect(entry).toMatchObject({ kind: 'event', name: 'ext/acme/note' })
  })

  it('requires the generic path to state its kind', () => {
    expect(() => createEntryWriter(null)('ext/acme/note', fields)).toThrow(
      TapeAppendAuthorizationError,
    )
  })
})

describe('slice writers', () => {
  it('lets each slice write its own declared names, taking the kind from the declaration', () => {
    const produced = DECLARED_TAPE_NAMES.map((declared) => {
      const entry = createEntryWriter(declared.slice)(declared.name, fieldsFor(declared))
      return { name: entry.name, kind: entry.kind }
    })
    expect(produced).toEqual(DECLARED_TAPE_NAMES.map((d) => ({ name: d.name, kind: d.kind })))
  })

  it('never lets one slice write another slice’s names', () => {
    for (const declared of DECLARED_TAPE_NAMES) {
      for (const slice of SLICES) {
        if (slice === declared.slice) continue
        expect(() =>
          assertAppendAuthorized(
            ask(declared.kind, declared.name, declared.sourceType ?? 'session'),
            slice,
          ),
        ).toThrow(TapeAppendAuthorizationError)
        expect(() => createEntryWriter(slice)(declared.name, fieldsFor(declared))).toThrow(
          TapeAppendAuthorizationError,
        )
      }
    }
  })

  it('rejects an undeclared sibling from the slice that owns the prefix', () => {
    expect(() => createEntryWriter('execution')('execution/anything', fields)).toThrow(
      TapeAppendAuthorizationError,
    )
    expect(() => createEntryWriter('message')('message/anything', fields)).toThrow(
      TapeAppendAuthorizationError,
    )
    expect(() => createEntryWriter('fs')('fs/anything', fields)).toThrow(
      TapeAppendAuthorizationError,
    )
  })

  it('rejects a declared name written with the wrong kind', () => {
    expect(() =>
      assertAppendAuthorized(ask('event', 'message/user', 'message'), 'message'),
    ).toThrow(/bound to kind 'message'/)
    expect(() =>
      createEntryWriter('message')('message/user', {
        ...fieldsFor(declarationOf('message/user')),
        kind: 'event',
      }),
    ).toThrow(TapeAppendAuthorizationError)
    expect(() =>
      createEntryWriter('session')('session/start', {
        ...fieldsFor(declarationOf('session/start')),
        kind: 'event',
      }),
    ).toThrow(TapeAppendAuthorizationError)
  })

  it('never lets a slice writer escape into ext/', () => {
    expect(() =>
      createEntryWriter('message')('ext/acme/note', { ...fields, kind: 'event' }),
    ).toThrow(TapeAppendAuthorizationError)
  })

  it('gives the skill slice nothing to write until phase 3 declares its names', () => {
    for (const name of ['skill/context', 'skill/anything', 'message/user']) {
      expect(() => createEntryWriter('skill')(name, { ...fields, kind: 'context' })).toThrow(
        TapeAppendAuthorizationError,
      )
    }
  })
})

function declarationOf(name: string): DeclaredTapeName {
  const found = declaredTapeName(name)
  if (found === null) throw new Error(`test fixture names an undeclared tape name: ${name}`)
  return found
}

describe('the identity columns a declaration fixes', () => {
  it('rejects a declared name written with another sourceType', () => {
    expect(() =>
      createEntryWriter('message')('message/user', {
        ...fieldsFor(declarationOf('message/user')),
        sourceType: 'runtime_event',
      }),
    ).toThrow(/bound to sourceType 'message'/)
    expect(() =>
      assertAppendAuthorized(ask('anchor', 'session/start', 'runtime_event'), 'session'),
    ).toThrow(/bound to sourceType 'session'/)
  })

  it('rejects a declared name with no sourceId, the column readBySource groups by', () => {
    const attempt = fieldsFor(declarationOf('provider/attempt_completed'))
    const { sourceId: _noAttemptSource, ...withoutSourceId } = attempt
    expect(() =>
      createEntryWriter('provider')('provider/attempt_completed', withoutSourceId),
    ).toThrow(/needs a sourceId/)
    const { sourceId: _noStartSource, ...startWithoutSourceId } = fieldsFor(
      declarationOf('session/start'),
    )
    expect(() => createEntryWriter('session')('session/start', startWithoutSourceId)).toThrow(
      /needs a sourceId/,
    )
    // An empty string is not an identity either.
    expect(() =>
      createEntryWriter('provider')('provider/attempt_completed', {
        ...fieldsFor(declarationOf('provider/attempt_completed')),
        sourceId: '',
      }),
    ).toThrow(/needs a sourceId/)
  })

  it('rejects a missing, wrong or negative sourceSeq', () => {
    const start = fieldsFor(declarationOf('session/start'))
    const { sourceSeq: _dropped, ...withoutSeq } = start
    expect(() => createEntryWriter('session')('session/start', withoutSeq)).toThrow(
      /needs a sourceSeq/,
    )
    // session/start's ordinal is the fixed 0 of the fact table, not any number.
    expect(() =>
      createEntryWriter('session')('session/start', { ...start, sourceSeq: 999 }),
    ).toThrow(/bound to sourceSeq 0/)
    expect(() =>
      createEntryWriter('message')('message/user', {
        ...fieldsFor(declarationOf('message/user')),
        sourceSeq: -1,
      }),
    ).toThrow(/non-negative ordinal/)
    expect(() =>
      createEntryWriter('message')('message/user', {
        ...fieldsFor(declarationOf('message/user')),
        sourceSeq: 1.5,
      }),
    ).toThrow(/needs a sourceSeq/)
  })

  it('rejects a sourceSeq on a name the fact table gives none', () => {
    for (const name of ['message/retracted', 'session/model_selected']) {
      const slice = declarationOf(name).slice
      expect(() =>
        createEntryWriter(slice)(name, { ...fieldsFor(declarationOf(name)), sourceSeq: 0 }),
      ).toThrow(/has no sourceSeq/)
    }
  })

  it('does not let an absent sourceType buy a pass on the other two columns', () => {
    // The gate used to skip the whole ordinal check when sourceType was missing, so a NewEntry with
    // no source_type at all (a NOT NULL column) and a wrong ordinal went through.
    const start = fieldsFor(declarationOf('session/start'))
    expect(() =>
      createEntryWriter('session')('session/start', {
        ...start,
        sourceType: undefined as unknown as TapeSourceType,
        sourceSeq: 999,
      }),
    ).toThrow(TapeAppendAuthorizationError)
  })

  it('leaves a reserved-only name’s identity to the phase that writes it', () => {
    // No declared triple, so any identity passes — but only from the owning slice, and phase 2 is
    // expected to declare its triple when it declares its writer.
    const entry = createEntryWriter('execution')('execution/run_started', {
      sourceType: 'runtime_event',
      sourceId: SUBJECT,
      sourceSeq: 0,
      provenanceKey: 'execution:v1:run:started',
      payload: {},
      createdAt: 1,
    })
    expect(entry.name).toBe('execution/run_started')
  })
})

describe('the NewEntry a writer produces', () => {
  it('omits absent optional columns instead of setting them to undefined', () => {
    const entry = createEntryWriter(null)('ext/acme/note', { ...fields, kind: 'event' })
    expect(Object.hasOwn(entry, 'sourceId')).toBe(false)
    expect(Object.hasOwn(entry, 'sourceSeq')).toBe(false)
    expect(Object.hasOwn(entry, 'meta')).toBe(false)
  })

  it('passes through the columns it is given', () => {
    const entry = createEntryWriter('provider')('provider/attempt_completed', {
      sourceType: 'runtime_event',
      sourceId: '33333333-3333-4333-8333-333333333333',
      sourceSeq: 0,
      provenanceKey: 'provider:v1:attempt:33333333-3333-4333-8333-333333333333:0:1',
      payload: { providerId: 'anthropic' },
      meta: { note: 'x' },
      createdAt: 7,
    })
    expect(entry).toEqual({
      kind: 'event',
      name: 'provider/attempt_completed',
      sourceType: 'runtime_event',
      sourceId: '33333333-3333-4333-8333-333333333333',
      sourceSeq: 0,
      provenanceKey: 'provider:v1:attempt:33333333-3333-4333-8333-333333333333:0:1',
      payload: { providerId: 'anthropic' },
      meta: { note: 'x' },
      createdAt: 7,
    })
  })

  it('is pure: the same call twice yields equal entries and shares no writer state', () => {
    const writer = createEntryWriter('message')
    const userFields = fieldsFor(declarationOf('message/user'))
    const a = writer('message/user', userFields)
    const b = writer('message/user', userFields)
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })
})
