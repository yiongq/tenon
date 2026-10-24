/** Spec 05 §一键还原: Tape-owned identities, read queries and the durable two-stage handoff. */
import type {
  AbsolutePath,
  HostAdapter,
  RestoreDone,
  RestorePreview,
  RestoreQuery,
  SnapshotStatus,
} from '../host/adapter.js'
import { isWithin } from '../host/path.js'
import { sessionFactsOf } from '../session/facts.js'
import type {
  ParentLinkPayload,
  RestoredPayload,
  RestoreStartedPayload,
  SnapshotCreatedPayload,
  TapeEntry,
} from '../tape/entry.js'
import { restoredKey, restoreStartedKey } from '../tape/provenance.js'
import type { Tape } from '../tape/tape.js'
import { readSessionEntries } from './batch.js'
import { callKeyOf } from './run.js'
import { roundRunOf } from './snapshots.js'

export type SnapshotRefusalCode =
  | 'busy'
  | 'gone'
  | 'stale'
  | 'undo-unavailable'
  | 'over-budget'
  | 'not-cowork'
export interface SnapshotRefusal {
  readonly ok: false
  readonly code: SnapshotRefusalCode
}
export interface SnapshotRoundQuery {
  readonly sessionId: string
  readonly roundRunId: string
}
export interface SnapshotRestoreQuery extends SnapshotRoundQuery {
  readonly previewKey: string
  readonly overwrite: readonly AbsolutePath[]
}
export interface SnapshotRound {
  readonly roundRunId: string
  readonly canRestore: boolean
  readonly incompleteCoverage: boolean
  readonly commandsWithoutSnapshot: boolean
}
/** An unfinished attempt is evidence for the UI, never an instruction to retry apply at startup. */
export interface IncompleteRestore extends RestoreStartedPayload {
  readonly entryId: number
}
export type SnapshotRoundsResult =
  | SnapshotRefusal
  | {
      readonly ok: true
      readonly status: SnapshotStatus
      readonly rounds: readonly SnapshotRound[]
      readonly incompleteRestores: readonly IncompleteRestore[]
    }
export type SnapshotPreviewResult =
  | SnapshotRefusal
  | { readonly ok: true; readonly preview: RestorePreview }
export type SnapshotRestoreResult =
  | SnapshotRefusal
  | ({ readonly ok: true; readonly undoSnapshotId: string; readonly skipped: number } & RestoreDone)

interface CallNode {
  readonly callKey: string
  readonly roundRunId: string
  readonly children: CallNode[]
  before?: SnapshotCreatedPayload
  after?: SnapshotCreatedPayload
  dispatched: boolean
  promised: boolean
  command: boolean
}
interface CollectedRound {
  readonly roundRunId: string
  readonly nodes: CallNode[]
  readonly query: RestoreQuery
  incomplete: boolean
}
interface RootHistory {
  readonly entries: readonly TapeEntry[]
  readonly incarnationId: string
  readonly folders: readonly AbsolutePath[]
  readonly rounds: readonly CollectedRound[]
}
interface RestoreDeps {
  readonly tape: Tape
  readonly host: HostAdapter
  readonly now: () => number
  /** Read afresh for every busy check; an aborted lease stays active until its real finish. */
  readonly activeRoots: () => readonly string[]
}

/** Fold restore facts by undo id and round, regardless of whether this process wrote them. */
export function incompleteRestoresOf(entries: readonly TapeEntry[]): IncompleteRestore[] {
  const completed = new Set(
    entries
      .filter((entry) => entry.name === 'fs/restored')
      .map((entry) => {
        const payload = entry.payload as RestoredPayload
        return `${payload.roundRunId}:${payload.undoSnapshotId}`
      }),
  )
  return entries
    .filter((entry) => entry.name === 'fs/restore_started')
    .flatMap((entry) => {
      const payload = entry.payload as RestoreStartedPayload
      return completed.has(`${payload.roundRunId}:${payload.undoSnapshotId}`)
        ? []
        : [{ ...payload, entryId: entry.entryId }]
    })
}

function flatten(nodes: readonly CallNode[]): CallNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}
function queryCall(node: CallNode): RestoreQuery['calls'][number] {
  const path = node.before?.path ?? node.after?.path
  return {
    callKey: node.callKey,
    ...(node.before === undefined ? {} : { before: node.before.snapshotId }),
    ...(node.after === undefined ? {} : { after: node.after.snapshotId }),
    ...(path === undefined ? {} : { path }),
  }
}

async function collectHistory(
  deps: RestoreDeps,
  sessionId: string,
): Promise<RootHistory | SnapshotRefusal> {
  const entries = await readSessionEntries(deps.tape, sessionId)
  const facts = sessionFactsOf(entries)
  if (!facts.established || facts.subagentOf !== null) return { ok: false, code: 'gone' }
  if (facts.profile !== 'cowork') return { ok: false, code: 'not-cowork' }
  const start = entries.find((entry) => entry.name === 'session/start')!
  const roundIds = [
    ...new Set(
      entries
        .filter((entry) => entry.name === 'execution/run_started' && entry.sourceId !== null)
        .map((entry) => roundRunOf(entries, entry.sourceId!)),
    ),
  ]
  const unreadable = new Set<string>()
  const seen = new Set([sessionId])
  const readCalls = async (
    own: readonly TapeEntry[],
    inheritedRound?: string,
  ): Promise<CallNode[]> => {
    const calls = new Map<string, CallNode>()
    const nodeOf = (entry: TapeEntry): CallNode => {
      if (
        entry.sourceId === null ||
        entry.sourceSeq === null ||
        typeof entry.payload['ordinal'] !== 'number'
      )
        throw new Error('Snapshot call has no runtime identity')
      const callKey = callKeyOf(entry.sourceId, entry.sourceSeq, entry.payload['ordinal'])
      let node = calls.get(callKey)
      if (node === undefined) {
        node = {
          callKey,
          roundRunId: inheritedRound ?? roundRunOf(own, entry.sourceId),
          children: [],
          dispatched: false,
          promised: false,
          command: false,
        }
        calls.set(callKey, node)
      }
      return node
    }
    for (const entry of own) {
      if (entry.name === 'tool/call') {
        nodeOf(entry)
        continue
      }
      if (entry.name === 'execution/dispatch_committed') {
        const node = nodeOf(entry)
        node.dispatched = true
        node.command = entry.payload['name'] === 'Bash'
      } else if (entry.name === 'tool/permission_decided') {
        nodeOf(entry).promised ||= entry.payload['reversibility'] === 'snapshotted'
      } else if (entry.name === 'fs/snapshot_created') {
        const node = nodeOf(entry)
        const payload = entry.payload as SnapshotCreatedPayload
        if (
          payload.runId !== entry.sourceId ||
          payload.requestSeq !== entry.sourceSeq ||
          payload.roundRunId !== node.roundRunId
        )
          throw new Error('Snapshot identity disagrees with its call or root round')
        if (payload.moment === 'before-call') node.before = payload
        else node.after = payload
        if (
          node.before?.path !== undefined &&
          node.after?.path !== undefined &&
          node.before.path !== node.after.path
        )
          throw new Error('Snapshot target changed between call records')
      } else if (entry.name === 'session/parent_link') {
        const node = nodeOf(entry)
        const link = entry.payload as ParentLinkPayload
        if (seen.has(link.child.sessionId))
          throw new Error('Snapshot child links are cyclic or repeated')
        seen.add(link.child.sessionId)
        // oxlint-disable-next-line no-await-in-loop -- insert each child at its parent call, not by coarse wall-clock time
        const child = await readSessionEntries(deps.tape, link.child.sessionId)
        const childFacts = sessionFactsOf(child)
        const childStart = child.find((candidate) => candidate.name === 'session/start')
        if (
          childFacts.subagentOf?.sessionId !== entry.sessionId ||
          childFacts.subagentOf.linkKey !== entry.provenanceKey ||
          childStart?.payload['incarnationId'] !== link.child.incarnationId
        ) {
          unreadable.add(node.roundRunId)
          continue
        }
        // oxlint-disable-next-line no-await-in-loop -- depth-first call order follows the authoritative parent links
        node.children.push(...(await readCalls(child, node.roundRunId)))
      }
    }
    return [...calls.values()]
  }
  const all = flatten(await readCalls(entries))
  const rounds = roundIds.map((roundRunId): CollectedRound => {
    const nodes = all.filter((node) => node.roundRunId === roundRunId)
    const calls = nodes
      .filter((node) => node.before !== undefined || node.after !== undefined)
      .map(queryCall)
    return {
      roundRunId,
      nodes,
      query: { sessionId, roundRunId, calls },
      incomplete:
        unreadable.has(roundRunId) ||
        nodes.some(
          (node) =>
            (node.before?.skipped ?? 0) > 0 ||
            (node.after?.skipped ?? 0) > 0 ||
            (node.dispatched && node.promised && node.before === undefined) ||
            (node.before !== undefined && node.after === undefined),
        ),
    }
  })
  return {
    entries,
    incarnationId: String(start.payload['incarnationId']),
    folders: facts.workspace?.folders ?? [],
    rounds,
  }
}

function snapshotIds(round: CollectedRound): string[] {
  return [
    ...new Set(
      round.query.calls.flatMap((call) =>
        [call.before, call.after].filter((id): id is string => id !== undefined),
      ),
    ),
  ]
}
async function alive(
  deps: RestoreDeps,
  sessionId: string,
  round: CollectedRound,
): Promise<boolean> {
  const ids = snapshotIds(round)
  if (!round.query.calls.some((call) => call.before !== undefined)) return false
  const live = await deps.host.snapshots.alive(sessionId, ids)
  return ids.every((id) => live.has(id))
}
async function realFolders(
  deps: RestoreDeps,
  folders: readonly AbsolutePath[],
): Promise<AbsolutePath[]> {
  return Promise.all(folders.map(async (folder) => (await deps.host.fs.realpath(folder)) ?? folder))
}
async function busy(deps: RestoreDeps, folders: readonly AbsolutePath[]): Promise<boolean> {
  const target = await realFolders(deps, folders)
  const checked = new Set<string>()
  // Re-read after awaits so a root that started during a folder lookup is not missed.
  for (;;) {
    const next = deps.activeRoots().find((root) => !checked.has(root))
    if (next === undefined) return false
    checked.add(next)
    // oxlint-disable-next-line no-await-in-loop -- each live root's current workspace is independently authoritative
    const facts = sessionFactsOf(await readSessionEntries(deps.tape, next))
    // oxlint-disable-next-line no-await-in-loop -- roots use the host's real paths, including directory aliases
    const roots = await realFolders(deps, facts.workspace?.folders ?? [])
    if (roots.some((a) => target.some((b) => isWithin(a, b) || isWithin(b, a)))) return true
  }
}

export function createSnapshotRestorer(deps: RestoreDeps) {
  return {
    async rounds(sessionId: string): Promise<SnapshotRoundsResult> {
      const history = await collectHistory(deps, sessionId)
      if ('ok' in history) return history
      const rounds: SnapshotRound[] = []
      for (const round of history.rounds) {
        // oxlint-disable-next-line no-await-in-loop -- retention/liveness belongs to the host
        const canRestore = await alive(deps, sessionId, round)
        // Spec 05 §界面: a command may change excluded paths even when its tree capture succeeded.
        let incompleteCoverage =
          round.incomplete ||
          round.nodes.some((node) => node.dispatched && node.command) ||
          (!canRestore && snapshotIds(round).length > 0)
        if (canRestore) {
          // oxlint-disable-next-line no-await-in-loop -- current safety skips invalidate promises without changing Tape
          const preview = await deps.host.snapshots.preview(round.query)
          incompleteCoverage ||= preview.skipped.length > 0
        }
        rounds.push({
          roundRunId: round.roundRunId,
          canRestore,
          incompleteCoverage,
          commandsWithoutSnapshot: round.nodes.some(
            (node) => node.dispatched && node.command && node.before?.scope !== 'tree',
          ),
        })
      }
      return {
        ok: true,
        status: deps.host.snapshots.status(sessionId),
        rounds,
        incompleteRestores: incompleteRestoresOf(history.entries),
      }
    },

    async preview(q: SnapshotRoundQuery): Promise<SnapshotPreviewResult> {
      const history = await collectHistory(deps, q.sessionId)
      if ('ok' in history) return history
      const round = history.rounds.find((item) => item.roundRunId === q.roundRunId)
      if (round === undefined || !(await alive(deps, q.sessionId, round)))
        return { ok: false, code: 'gone' }
      return { ok: true, preview: await deps.host.snapshots.preview(round.query) }
    },

    async restore(q: SnapshotRestoreQuery): Promise<SnapshotRestoreResult> {
      const history = await collectHistory(deps, q.sessionId)
      if ('ok' in history) return history
      if (await busy(deps, history.folders)) return { ok: false, code: 'busy' }
      const round = history.rounds.find((item) => item.roundRunId === q.roundRunId)
      if (round === undefined || !(await alive(deps, q.sessionId, round)))
        return { ok: false, code: 'gone' }
      const preview = await deps.host.snapshots.preview(round.query)
      if (preview.previewKey !== q.previewKey) return { ok: false, code: 'stale' }
      if (q.overwrite.some((path) => !preview.conflicts.includes(path)))
        throw new TypeError('overwrite must be a subset of conflicts')
      const prepared = await deps.host.snapshots.prepare({
        ...round.query,
        previewKey: q.previewKey,
      })
      if (!prepared.ok) return { ok: false, code: prepared.reason }
      const cancel = { sessionId: q.sessionId, undoSnapshotId: prepared.undoSnapshotId }
      try {
        if (await busy(deps, history.folders)) {
          await deps.host.snapshots.cancel(cancel)
          return { ok: false, code: 'busy' }
        }
        // A started id may already have applied before a crash. Never apply it again, even without a completion.
        if (
          history.entries.some(
            (entry) =>
              (entry.name === 'fs/restore_started' || entry.name === 'fs/restored') &&
              entry.payload['undoSnapshotId'] === prepared.undoSnapshotId,
          )
        ) {
          await deps.host.snapshots.cancel(cancel)
          return { ok: false, code: 'stale' }
        }
        const n = history.entries.filter((entry) => entry.name === 'fs/restore_started').length
        const fs = deps.tape.writer('fs')
        const started = await fs.write({
          sessionId: q.sessionId,
          incarnationId: history.incarnationId,
          fact: {
            name: 'fs/restore_started',
            fields: {
              sourceType: 'session',
              sourceId: q.sessionId,
              sourceSeq: n,
              provenanceKey: restoreStartedKey(history.incarnationId, n),
              payload: {
                roundRunId: q.roundRunId,
                undoSnapshotId: prepared.undoSnapshotId,
                previewKey: q.previewKey,
              },
              createdAt: deps.now(),
            },
          },
        })
        if (!started.created) {
          await deps.host.snapshots.cancel(cancel)
          return { ok: false, code: 'stale' }
        }
        const done = await deps.host.snapshots.apply({ ...cancel, overwrite: q.overwrite })
        const payload: RestoredPayload = {
          roundRunId: q.roundRunId,
          undoSnapshotId: prepared.undoSnapshotId,
          restored: done.restored,
          removed: done.removed,
          kept: done.kept,
          skipped: preview.skipped.length,
          failed: done.failed.length,
        }
        await fs.write({
          sessionId: q.sessionId,
          incarnationId: history.incarnationId,
          fact: {
            name: 'fs/restored',
            fields: {
              sourceType: 'session',
              sourceId: q.sessionId,
              sourceSeq: n,
              provenanceKey: restoredKey(history.incarnationId, n),
              payload,
              createdAt: deps.now(),
            },
          },
        })
        return {
          ok: true,
          undoSnapshotId: prepared.undoSnapshotId,
          skipped: preview.skipped.length,
          ...done,
        }
      } catch (error) {
        // Also handles stores that committed but lost their acknowledgement: no apply is retried here.
        await deps.host.snapshots.cancel(cancel).catch(() => {})
        throw error
      }
    },
  }
}
