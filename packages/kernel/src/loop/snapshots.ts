/** Spec 05: snapshot identities come from the call's Tape, including a child's parent link. */
import type { AbsolutePath, SnapshotRequest, SnapshotTaken } from '../host/adapter.js'
import { sessionFactsOf } from '../session/facts.js'
import type {
  FactWriter,
  NewEntry,
  RunStartedPayload,
  SnapshotCreatedPayload,
  TapeEntry,
} from '../tape/entry.js'
import { snapshotCreatedKey } from '../tape/provenance.js'
import type { Tape } from '../tape/tape.js'
import type { CallRef } from './closure.js'

export interface CallSnapshot {
  readonly request: SnapshotRequest
  readonly before: SnapshotTaken
}

/** A resumed Run belongs to the round it paused; a new message or continue begins a new round. */
function roundRunOf(entries: readonly TapeEntry[], runId: string): string {
  const seen = new Set<string>()
  let current = runId
  while (!seen.has(current)) {
    seen.add(current)
    const started = entries.find(
      (entry) => entry.name === 'execution/run_started' && entry.sourceId === current,
    )
    const cause = (started?.payload as RunStartedPayload | undefined)?.cause
    if (cause?.kind !== 'resume') return current
    current = cause.pausedRunId
  }
  throw new Error('snapshot round has a cyclic resume chain')
}

export function snapshotSessionId(sessionId: string, entries: readonly TapeEntry[]): string {
  return sessionFactsOf(entries).subagentOf?.sessionId ?? sessionId
}

export function snapshotRequest(q: {
  readonly sessionId: string
  readonly call: CallRef
  readonly entries: readonly TapeEntry[]
  readonly parentEntries: readonly TapeEntry[]
  readonly folders: readonly AbsolutePath[]
  readonly path?: AbsolutePath
}): SnapshotRequest {
  const parent = sessionFactsOf(q.entries).subagentOf
  const link =
    parent === null
      ? undefined
      : q.parentEntries.find((entry) => entry.provenanceKey === parent.linkKey)
  if (parent !== null && (link?.name !== 'session/parent_link' || link.sourceId === null)) {
    throw new Error('snapshot child has no parent call identity')
  }
  const roundRunId =
    parent === null
      ? roundRunOf(q.entries, q.call.runId)
      : roundRunOf(q.parentEntries, link!.sourceId!)
  return {
    sessionId: parent?.sessionId ?? q.sessionId,
    call: {
      sessionId: q.sessionId,
      roundRunId,
      runId: q.call.runId,
      requestSeq: q.call.requestSeq,
      ordinal: q.call.ordinal,
    },
    folders: q.folders,
    moment: 'before-call',
    ...(q.path === undefined ? {} : { path: q.path }),
  }
}

export function snapshotEntry(
  q: {
    readonly tape: Tape
    readonly now: () => number
    readonly writer: FactWriter
  },
  request: SnapshotRequest,
  taken: Extract<SnapshotTaken, { ok: true }>,
): NewEntry {
  if (request.moment === 'before-restore')
    throw new Error('a call snapshot cannot be before-restore')
  const payload: SnapshotCreatedPayload = {
    snapshotId: taken.snapshotId,
    runId: request.call.runId,
    requestSeq: request.call.requestSeq,
    ordinal: request.call.ordinal,
    moment: request.moment,
    scope: taken.scope,
    ...(request.path === undefined ? {} : { path: request.path }),
    roundRunId: request.call.roundRunId,
    skipped: taken.skipped,
    writer: q.writer,
  }
  return q.tape.writer('fs').entry('fs/snapshot_created', {
    sourceType: 'runtime_event',
    sourceId: request.call.runId,
    sourceSeq: request.call.requestSeq,
    provenanceKey: snapshotCreatedKey(
      request.call.runId,
      request.call.requestSeq,
      request.call.ordinal,
      request.moment,
    ),
    payload,
    createdAt: q.now(),
  })
}
