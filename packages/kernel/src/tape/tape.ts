/**
 * The kernel's Tape facade (spec 01 §保留命名空间, §存储端口).
 *
 * **`apps/*` never call `TapeStore.append` directly** — they go through a kernel service, which goes
 * through this. The facade is where the two halves of the append gate meet:
 *
 *   - `tape.writer(slice)` hands out a writer bound to ONE slice. It may write only the names that
 *     slice declared, each with the kind it is bound to; another slice's names are rejected even
 *     though they are perfectly well-formed. This is the half a store cannot enforce, because a store
 *     never learns who called it.
 *   - `tape.append()` is the generic path and takes `ext/<owner>/…` only: no reserved prefix, no
 *     undeclared sibling of one (`execution/anything`), no `context` kind.
 *   - `tape.appendEntries()` writes already-built facts from SEVERAL slices in one transaction, each
 *     re-checked against the slice that declared its name. A run's terminal facts live in two slices
 *     and are one event, and the alternative to this door is a caller holding the raw store.
 *
 * Both validate the provenance key's grammar and the authorisation BEFORE the store is touched, so
 * nothing malformed ever reaches a transaction. The store repeats the checks it can make on its own
 * — belt and braces on purpose: a test double or a second facade must not become a way around them.
 *
 * Reads are passed straight through. The facade deliberately does not expose the store it wraps:
 * handing the port out would make the paragraph above a suggestion.
 */
import type { AppendResult, NewEntry, TapeEntry } from './entry.js'
import type { SliceEntryFields, TapeSlice } from './names.js'
import { assertAppendAuthorized, createEntryWriter, declaredTapeName } from './names.js'
import { assertProvenanceKey } from './provenance.js'
import type {
  MessageRow,
  SessionHead,
  SessionSummary,
  TapeListMessagesQuery,
  TapeListSessionsQuery,
  TapeReadBySourceQuery,
  TapeReadRangePage,
  TapeReadRangeQuery,
  TapeResetSessionQuery,
  TapeStore,
  TapeVerifyChainPage,
  TapeVerifyChainQuery,
} from './store.js'

/** One fact to write: a name plus everything about it except the kind a declaration already fixes. */
export interface TapeFact {
  readonly name: string
  readonly fields: SliceEntryFields
}

export interface TapeWriteBatch {
  readonly sessionId: string
  /** Minted by the kernel; a store creates the head row with it or rejects a stale one. */
  readonly incarnationId: string
  readonly facts: readonly TapeFact[]
}

/** Already-built facts, from one slice's writer or several. See `Tape.appendEntries`. */
export interface TapeAppendEntriesBatch {
  readonly sessionId: string
  readonly incarnationId: string
  readonly entries: readonly NewEntry[]
}

export interface TapeWriter {
  /** One fact, one transaction. */
  write(q: { sessionId: string; incarnationId: string; fact: TapeFact }): Promise<AppendResult>
  /** Several facts of this slice in ONE transaction: all of them or none. */
  writeBatch(batch: TapeWriteBatch): Promise<AppendResult[]>
  /**
   * The pure half: builds an authorised `NewEntry` without writing it. `resetSession` needs one (the
   * store is handed the `session/start` rather than assembling a reserved fact itself), and a caller
   * that wants to inspect a fact before committing it uses the same door.
   */
  entry(name: string, fields: SliceEntryFields): NewEntry
}

export interface Tape {
  /** A writer for one slice. Everything it accepts is checked against that slice's declarations. */
  writer(slice: TapeSlice): TapeWriter
  /** The generic path: `ext/<owner>/…` only. */
  append(batch: TapeWriteBatch): Promise<AppendResult[]>
  /**
   * One transaction spanning SLICES, for the facts that have to land together — a run's terminal
   * `message/assistant` and its `provider/attempt_completed` are declared in two slices but are one
   * event. Each entry is re-checked against the slice that declared ITS name, which is the same gate
   * the store runs; the per-slice restriction happened earlier, when `writer(slice).entry(…)` built
   * the entry. Without this door the only way to write such a batch would be to hold the raw
   * `TapeStore`, which is what the facade exists to prevent.
   */
  appendEntries(batch: TapeAppendEntriesBatch): Promise<AppendResult[]>

  readRange(q: TapeReadRangeQuery): Promise<TapeReadRangePage>
  readBySource(q: TapeReadBySourceQuery): Promise<TapeEntry[]>
  head(sessionId: string): Promise<SessionHead | null>
  verifyChain(q: TapeVerifyChainQuery): Promise<TapeVerifyChainPage>
  listSessions(q: TapeListSessionsQuery): Promise<SessionSummary[]>
  listMessages(q: TapeListMessagesQuery): Promise<MessageRow[]>
  rebuildProjections(sessionId: string): Promise<void>
  /** `start` must be an authorised `session/start`, normally from `writer('session').entry(…)`. */
  resetSession(q: TapeResetSessionQuery): Promise<AppendResult>
  deleteSession(sessionId: string): Promise<void>
  close(): Promise<void>
}

/**
 * The gate on an already-built entry, run against the slice that DECLARED its name (null for
 * `ext/<owner>/…`). It is the same assertion the store repeats, so an entry that came from somewhere
 * other than a slice writer is checked as strictly as one that did.
 */
function assertEntryAuthorized(entry: NewEntry): void {
  assertAppendAuthorized(
    {
      kind: entry.kind,
      name: entry.name,
      sourceType: entry.sourceType,
      ...(entry.sourceId === undefined ? {} : { sourceId: entry.sourceId }),
      ...(entry.sourceSeq === undefined ? {} : { sourceSeq: entry.sourceSeq }),
    },
    declaredTapeName(entry.name)?.slice ?? null,
  )
  assertProvenanceKey(entry.provenanceKey)
}

function buildEntries(slice: TapeSlice | null, facts: readonly TapeFact[]): NewEntry[] {
  const build = createEntryWriter(slice)
  return facts.map((fact) => {
    const entry = build(fact.name, fact.fields)
    // The slice writers cannot check this themselves: `names.ts` importing `provenance.ts` would
    // close a cycle with the namespace table that module reads.
    assertProvenanceKey(entry.provenanceKey)
    return entry
  })
}

export function createTape(store: TapeStore): Tape {
  // `async`, so a rejected name or key REJECTS instead of throwing synchronously: the port promises
  // a promise, and a caller holding only a `.catch()` must not be able to miss the gate.
  async function appendAs(slice: TapeSlice | null, batch: TapeWriteBatch): Promise<AppendResult[]> {
    return store.append({
      sessionId: batch.sessionId,
      incarnationId: batch.incarnationId,
      entries: buildEntries(slice, batch.facts),
    })
  }

  return {
    writer(slice: TapeSlice): TapeWriter {
      return {
        async write(q): Promise<AppendResult> {
          const results = await appendAs(slice, {
            sessionId: q.sessionId,
            incarnationId: q.incarnationId,
            facts: [q.fact],
          })
          const result = results[0]
          if (result === undefined) {
            throw new Error(`append of ${q.fact.name} returned no receipt`)
          }
          return result
        },
        async writeBatch(batch): Promise<AppendResult[]> {
          return appendAs(slice, batch)
        },
        entry(name, fields): NewEntry {
          const entry = createEntryWriter(slice)(name, fields)
          assertProvenanceKey(entry.provenanceKey)
          return entry
        },
      }
    },

    async append(batch: TapeWriteBatch): Promise<AppendResult[]> {
      return appendAs(null, batch)
    },

    async appendEntries(batch: TapeAppendEntriesBatch): Promise<AppendResult[]> {
      for (const entry of batch.entries) assertEntryAuthorized(entry)
      return store.append({
        sessionId: batch.sessionId,
        incarnationId: batch.incarnationId,
        entries: batch.entries,
      })
    },

    readRange: (q) => store.readRange(q),
    readBySource: (q) => store.readBySource(q),
    head: (sessionId) => store.head(sessionId),
    verifyChain: (q) => store.verifyChain(q),
    listSessions: (q) => store.listSessions(q),
    listMessages: (q) => store.listMessages(q),
    rebuildProjections: (sessionId) => store.rebuildProjections(sessionId),
    async resetSession(q: TapeResetSessionQuery): Promise<AppendResult> {
      // The same gate the write paths run, on an entry the caller assembled: a reset is an append of
      // one session-slice fact, and it must not be the way to smuggle one in unchecked.
      assertAppendAuthorized(
        {
          kind: q.start.kind,
          name: q.start.name,
          sourceType: q.start.sourceType,
          ...(q.start.sourceId === undefined ? {} : { sourceId: q.start.sourceId }),
          ...(q.start.sourceSeq === undefined ? {} : { sourceSeq: q.start.sourceSeq }),
        },
        'session',
      )
      assertProvenanceKey(q.start.provenanceKey)
      return store.resetSession(q)
    },
    deleteSession: (sessionId) => store.deleteSession(sessionId),
    close: () => store.close(),
  }
}
