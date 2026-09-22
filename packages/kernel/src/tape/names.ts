/**
 * The reserved-namespace table and the two-way append authorisation (spec 01 §保留命名空间).
 *
 * The mechanism is DeepChat's, the coverage is not: theirs reserves only `execution/*` and
 * `contract/*` by prefix, which is why `view/assembled`, `message/retracted` and unknown
 * `view/tool_*` all slip through its generic append. Here every first-party namespace is reserved
 * BY PREFIX and a name is writable only if it was DECLARED, so an undeclared sibling
 * (`execution/anything`) is rejected exactly like a declared one written by the wrong writer.
 *
 * Two directions, one assertion:
 *   slice = null  the generic path: only `ext/<owner>/…`, never a reserved prefix, never kind
 *                 'context' (that kind belongs wholesale to `skill/`).
 *   slice = S     only the names declared for S, each with the kind it is bound to. One slice can
 *                 never write another's names.
 *
 * Tools and plugins get no append surface at all (phase 2 gives a model read-only retrieval), and
 * `apps/*` never calls `TapeStore.append` directly — it goes through the kernel facade, which hands
 * out slice writers built here.
 */
import type { NewEntry, TapeKind, TapeSourceType } from './entry.js'
import { TAPE_KINDS, TAPE_SOURCE_TYPES } from './entry.js'

/** A name whose syntax is wrong — before any question of authorisation. */
export class TapeNameSyntaxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeNameSyntaxError'
  }
}

/** A well-formed name the caller is not allowed to write. */
export class TapeAppendAuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeAppendAuthorizationError'
  }
}

/**
 * The twelve first-party prefixes, reserved BY PREFIX: any name whose first segment is one of
 * these is off limits to generic append, declared or not.
 *
 * Frozen, not merely `readonly`: `packages/contracts`' bridge frame rule 4 puts frame types in this
 * same name space, so this list is the one place the reservation is written down and no importer may
 * grow it. `classifyFrameType` does not consult it — a frame type is classified by shape, not by
 * membership — but the two share the segment syntax; see `NAME_SEGMENT`.
 */
export const RESERVED_NAMESPACES: readonly string[] = Object.freeze([
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

/** The one namespace generic append may write, as `ext/<owner>/…`. */
export const EXT_NAMESPACE = 'ext'

/**
 * A writer slice. It is the namespace it writes into: `tape.writer('message')` may write
 * `message/…` names and nothing else. `skill` is listed with no declared names because the
 * `context` kind is reserved for it — phase 3 declares the names, and until then the slice exists
 * so the rule can be stated instead of hard-coded.
 */
export type TapeSlice = 'session' | 'message' | 'provider' | 'execution' | 'fs' | 'skill'

/**
 * How the spec's fact table fixes `source_seq` for a name: a number is that exact value, `'null'` is
 * "this name has no ordinal", `'ordinal'` is "the fact carries one" (a `revision`, a `requestSeq`) —
 * which only its writer can check the value of, but its presence and range are checkable here.
 */
export type DeclaredSourceSeq = number | 'null' | 'ordinal'

export interface DeclaredTapeName {
  readonly name: string
  /** The kind this name is bound to. A declared name written with another kind is rejected. */
  readonly kind: TapeKind
  readonly slice: TapeSlice
  /**
   * The identity columns the spec's fact table fixes for this name. R1 makes
   * `(source_type, source_id, source_seq)` a phase-1 deliverable, and they are worth a gate rather
   * than a convention: all three are in the hash preimage (so a wrong one is sealed), `source_id` is
   * what `readBySource` groups a run by, and `source_id` is part of the idempotency comparison — a
   * fact written with the wrong identity is invisible to recovery AND turns its own correct rewrite
   * into a `TapeProvenanceConflictError`.
   *
   * All three are absent on the reserved-only names: the phase that owns the writer declares its
   * triple with it, and until then nothing may write those names at all.
   */
  readonly sourceType?: TapeSourceType
  /** Every phase-1 fact has a non-null source. `'null'` is here for a later fact that has none. */
  readonly sourceId?: 'required' | 'null'
  readonly sourceSeq?: DeclaredSourceSeq
}

/**
 * `as const` so the names survive as literal types (`DeclaredTapeNameId`): step 5's reducer compares
 * bare name literals, and a typo like 'message/retract' must not compile.
 */
const declarations = [
  // Written by phase 1 — source triple straight out of the spec's fact table.
  {
    name: 'session/start',
    kind: 'anchor',
    slice: 'session',
    sourceType: 'session',
    sourceId: 'required',
    sourceSeq: 0,
  },
  {
    name: 'session/model_selected',
    kind: 'event',
    slice: 'session',
    sourceType: 'session',
    sourceId: 'required',
    sourceSeq: 'null',
  },
  {
    name: 'message/user',
    kind: 'message',
    slice: 'message',
    sourceType: 'message',
    sourceId: 'required',
    sourceSeq: 'ordinal',
  },
  {
    name: 'message/assistant',
    kind: 'message',
    slice: 'message',
    sourceType: 'message',
    sourceId: 'required',
    sourceSeq: 'ordinal',
  },
  {
    name: 'message/retracted',
    kind: 'event',
    slice: 'message',
    sourceType: 'message',
    sourceId: 'required',
    sourceSeq: 'null',
  },
  {
    name: 'provider/attempt_completed',
    kind: 'event',
    slice: 'provider',
    sourceType: 'runtime_event',
    sourceId: 'required',
    sourceSeq: 'ordinal',
  },
  // Reserved only — the writers, and their source triples, arrive with the owning phase (R1, R5).
  { name: 'session/parent_link', kind: 'event', slice: 'session' },
  { name: 'execution/run_started', kind: 'event', slice: 'execution' },
  { name: 'execution/dispatch_committed', kind: 'event', slice: 'execution' },
  { name: 'execution/tool_outcome', kind: 'event', slice: 'execution' },
  { name: 'execution/run_terminal', kind: 'event', slice: 'execution' },
  { name: 'fs/snapshot_created', kind: 'event', slice: 'fs' },
] as const satisfies readonly DeclaredTapeName[]

/** Every first-party name as a literal type, so a reader cannot compare against a typo. */
export type DeclaredTapeNameId = (typeof declarations)[number]['name']

/**
 * Every first-party name that exists, whether or not phase 1 writes it. The reserved-only ones are
 * here so their identity is settled now: once a user's file contains an `execution/foo` written by
 * generic append, no later reader can tell a real fact from a squatter's placeholder, and the fix
 * is a data audit rather than a migration.
 *
 * Rows are frozen as well as the list: the authorisation lookup below holds these very objects, so
 * a mutable `kind` would be a way to talk a slice writer into the wrong binding at runtime.
 */
export const DECLARED_TAPE_NAMES: readonly DeclaredTapeName[] = Object.freeze(
  declarations.map((declared) => Object.freeze(declared)),
)

const DECLARED_BY_NAME = new Map<string, DeclaredTapeName>(
  DECLARED_TAPE_NAMES.map((declared) => [declared.name, declared]),
)

/**
 * Same segment syntax as a bridge frame type (spec 01 §桥帧骨架 rule 4). The two are separate
 * regexes in separate packages — contracts must classify a frame type without importing the tape's
 * length and segment bounds, which are index concerns — so `packages/contracts/test/`'s
 * `frame-tape-syntax.test.ts` pins them together: tighten one and it reds.
 */
const NAME_SEGMENT = /^[a-z][a-z0-9_]*$/

/** Names are indexed, logged and compared; a bound keeps them out of the pathological range. */
export const TAPE_NAME_MAX_LENGTH = 128

/** Enough for `ext/<owner>/<group>/<name>`; a deeper name is almost certainly a mistake. */
const TAPE_NAME_MAX_SEGMENTS = 8

export function isReservedNamespace(namespace: string): boolean {
  return RESERVED_NAMESPACES.includes(namespace)
}

export function declaredTapeName(name: string): DeclaredTapeName | null {
  return DECLARED_BY_NAME.get(name) ?? null
}

/** Syntax only: `<namespace>/<name>`, lowercase segments, bounded. Says nothing about who may write it. */
export function assertTapeName(name: string): void {
  // This gate stands in front of input that has crossed an untyped boundary (IPC, a 6b bridge frame,
  // a hand-written fixture), so a non-string must leave as this module's error rather than as a
  // TypeError from `.split`. A boxed String is a non-string too: the column is TEXT.
  if (typeof name !== 'string') {
    throw new TapeNameSyntaxError(`tape name must be a string, got ${typeof name}`)
  }
  if (name.length === 0 || name.length > TAPE_NAME_MAX_LENGTH) {
    throw new TapeNameSyntaxError(
      `tape name must be 1..${TAPE_NAME_MAX_LENGTH} characters, got ${name.length}`,
    )
  }
  const segments = name.split('/')
  if (segments.length < 2 || segments.length > TAPE_NAME_MAX_SEGMENTS) {
    throw new TapeNameSyntaxError(
      `tape name "${name}" must have 2..${TAPE_NAME_MAX_SEGMENTS} slash-separated segments`,
    )
  }
  for (const segment of segments) {
    if (!NAME_SEGMENT.test(segment)) {
      throw new TapeNameSyntaxError(`tape name "${name}" has an invalid segment "${segment}"`)
    }
  }
}

function namespaceOf(name: string): string {
  const slash = name.indexOf('/')
  return slash === -1 ? name : name.slice(0, slash)
}

/**
 * Checks the three identity columns the declaration fixes, each independently: a missing
 * `sourceType` must not buy a pass on `sourceSeq`, or the one call that omits the column a store
 * declares NOT NULL would slip through with a wrong ordinal as well.
 */
function assertDeclaredSource(declared: DeclaredTapeName, input: AppendAuthorizationInput): void {
  if (declared.sourceType !== undefined && input.sourceType !== declared.sourceType) {
    throw new TapeAppendAuthorizationError(
      `"${declared.name}" is bound to sourceType '${declared.sourceType}', not '${String(input.sourceType)}'`,
    )
  }
  if (declared.sourceId === 'required' && (input.sourceId === undefined || input.sourceId === '')) {
    throw new TapeAppendAuthorizationError(
      `"${declared.name}" needs a sourceId (the fact's subject); got ${String(input.sourceId)}`,
    )
  }
  if (declared.sourceId === 'null' && input.sourceId !== undefined) {
    throw new TapeAppendAuthorizationError(
      `"${declared.name}" has no sourceId; got "${input.sourceId}"`,
    )
  }
  const seq = declared.sourceSeq
  if (seq === undefined) return
  if (seq === 'null') {
    if (input.sourceSeq !== undefined) {
      throw new TapeAppendAuthorizationError(
        `"${declared.name}" has no sourceSeq; got ${String(input.sourceSeq)}`,
      )
    }
    return
  }
  if (input.sourceSeq === undefined || !Number.isSafeInteger(input.sourceSeq)) {
    throw new TapeAppendAuthorizationError(
      `"${declared.name}" needs a sourceSeq; got ${String(input.sourceSeq)}`,
    )
  }
  if (seq === 'ordinal') {
    if (input.sourceSeq < 0) {
      throw new TapeAppendAuthorizationError(
        `"${declared.name}" carries a non-negative ordinal sourceSeq; got ${String(input.sourceSeq)}`,
      )
    }
    return
  }
  if (input.sourceSeq !== seq) {
    throw new TapeAppendAuthorizationError(
      `"${declared.name}" is bound to sourceSeq ${String(seq)}, not ${String(input.sourceSeq)}`,
    )
  }
}

/**
 * What the gate needs to see. It is the identity half of a `NewEntry`, not a loosened version of it:
 * `sourceType` is NOT NULL on the row, so asking about a name without one would be asking about an
 * entry that cannot exist.
 */
export type AppendAuthorizationInput = Pick<NewEntry, 'kind' | 'name' | 'sourceType'> & {
  readonly sourceId?: string
  readonly sourceSeq?: number
}

/**
 * The gate every append passes, in both directions. A store, a test double and the kernel facade
 * all call it; nothing writes a tape row without it.
 *
 * `kind` and `sourceType` are checked against their closed vocabularies here, not just in the type
 * system: both are hashed and indexed, so an unknown value is permanent, and the compiler was not
 * present wherever this input came from.
 */
export function assertAppendAuthorized(
  input: AppendAuthorizationInput,
  slice: TapeSlice | null,
): void {
  assertTapeName(input.name)
  if (!(TAPE_KINDS as readonly unknown[]).includes(input.kind)) {
    throw new TapeAppendAuthorizationError(
      `kind must be one of ${TAPE_KINDS.join(', ')}; got ${String(input.kind)}`,
    )
  }
  if (!(TAPE_SOURCE_TYPES as readonly unknown[]).includes(input.sourceType)) {
    throw new TapeAppendAuthorizationError(
      `sourceType must be one of ${TAPE_SOURCE_TYPES.join(', ')}; got ${String(input.sourceType)}`,
    )
  }
  const namespace = namespaceOf(input.name)
  if (input.kind === 'context' && namespace !== 'skill') {
    throw new TapeAppendAuthorizationError(
      `kind 'context' is reserved for skill/ names; "${input.name}" is not one`,
    )
  }
  if (slice === null) {
    if (isReservedNamespace(namespace)) {
      throw new TapeAppendAuthorizationError(
        `"${input.name}" is under the reserved prefix "${namespace}/"; generic append may only write ext/<owner>/…`,
      )
    }
    if (namespace !== EXT_NAMESPACE) {
      throw new TapeAppendAuthorizationError(
        `generic append may only write ${EXT_NAMESPACE}/<owner>/…, not "${input.name}"`,
      )
    }
    if (input.name.split('/').length < 3) {
      throw new TapeAppendAuthorizationError(
        `"${input.name}" is missing an owner segment; generic append writes ${EXT_NAMESPACE}/<owner>/…`,
      )
    }
    return
  }
  const declared = declaredTapeName(input.name)
  if (declared === null) {
    throw new TapeAppendAuthorizationError(
      `"${input.name}" is not a declared tape name; the ${slice} slice may only write its declared names`,
    )
  }
  if (declared.slice !== slice) {
    throw new TapeAppendAuthorizationError(
      `"${input.name}" belongs to the ${declared.slice} slice, not to ${slice}`,
    )
  }
  if (declared.kind !== input.kind) {
    throw new TapeAppendAuthorizationError(
      `"${input.name}" is bound to kind '${declared.kind}', not '${input.kind}'`,
    )
  }
  assertDeclaredSource(declared, input)
}

/**
 * Everything about an entry except its name and — for a declared name — its kind, which the
 * declaration supplies.
 */
export interface SliceEntryFields {
  /** Optional for a declared name (taken from the declaration), required on the generic path. */
  readonly kind?: TapeKind
  /**
   * The identity columns. For a declared name all three are checked against the spec's fact table,
   * so `sourceId` and `sourceSeq` are optional here only in the sense that some names have none.
   */
  readonly sourceType: TapeSourceType
  readonly sourceId?: string
  readonly sourceSeq?: number
  readonly provenanceKey: string
  readonly payload: Record<string, unknown>
  readonly meta?: Record<string, unknown>
  readonly createdAt: number
}

export type TapeEntryWriter = (name: string, fields: SliceEntryFields) => NewEntry

/**
 * The half of a slice writer that needs no store: pure, it either returns an authorised `NewEntry`
 * or throws. The facade's `tape.writer(slice)` is this plus a store call, so authorisation cannot
 * be reached around by holding a store reference.
 *
 * `slice = null` is the generic path. The provenance key's syntax is NOT checked here — the store
 * rejects a malformed key (spec 01 §entry 模型), and importing the provenance module here would
 * make a cycle with the namespace table it reads.
 */
export function createEntryWriter(slice: TapeSlice | null): TapeEntryWriter {
  return (name, fields) => {
    assertTapeName(name)
    const kind = fields.kind ?? declaredTapeName(name)?.kind
    if (kind === undefined) {
      throw new TapeAppendAuthorizationError(
        `"${name}" is not a declared tape name, so its kind must be stated explicitly`,
      )
    }
    assertAppendAuthorized(
      {
        kind,
        name,
        sourceType: fields.sourceType,
        ...(fields.sourceId === undefined ? {} : { sourceId: fields.sourceId }),
        ...(fields.sourceSeq === undefined ? {} : { sourceSeq: fields.sourceSeq }),
      },
      slice,
    )
    return {
      kind,
      name,
      sourceType: fields.sourceType,
      ...(fields.sourceId === undefined ? {} : { sourceId: fields.sourceId }),
      ...(fields.sourceSeq === undefined ? {} : { sourceSeq: fields.sourceSeq }),
      provenanceKey: fields.provenanceKey,
      payload: fields.payload,
      ...(fields.meta === undefined ? {} : { meta: fields.meta }),
      createdAt: fields.createdAt,
    }
  }
}
