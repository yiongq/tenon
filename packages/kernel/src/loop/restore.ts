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
import { effectiveMessages } from '../tape/replay.js'
import { sessionFactsOf } from '../session/facts.js'
import type {
  ParentLinkPayload,
  RestoredPayload,
  RunStartedPayload,
  RunTerminalPayload,
  RestoreStartedPayload,
  SnapshotCreatedPayload,
  TapeEntry,
} from '../tape/entry.js'
import { restoredKey, restoreStartedKey } from '../tape/provenance.js'
import type { Tape } from '../tape/tape.js'
import { readSessionEntries } from './batch.js'
import { callKeyOf } from './run.js'

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
  readonly endMessageId: string | null
  readonly runIds: readonly string[]
  readonly calls: readonly { readonly callKey: string; readonly snapshotId: string }[]
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
  snapshotId?: string
  before?: SnapshotCreatedPayload
  after?: SnapshotCreatedPayload
  dispatched: boolean
  promised: boolean
  command: boolean
}
interface CollectedRound {
  readonly roundRunId: string
  readonly runIds: readonly string[]
  readonly revision: string
  readonly nodes: CallNode[]
  readonly rootNodes: CallNode[]
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
  readonly activeRuns: () => readonly string[]
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

/** Resolve resume chains once, then group Runs in Tape order (including text-only resumes). */
function indexRounds(entries: readonly TapeEntry[]) {
  const started = new Map<string, RunStartedPayload>()
  for (const entry of entries) {
    if (
      entry.name === 'execution/run_started' &&
      entry.sourceId !== null &&
      !started.has(entry.sourceId)
    )
      started.set(entry.sourceId, entry.payload as RunStartedPayload)
  }
  const byRun = new Map<string, string>()
  const byRound = new Map<string, string[]>()
  for (const runId of started.keys()) {
    const path = new Set<string>()
    let current = runId
    while (!byRun.has(current)) {
      if (path.has(current)) throw new Error('snapshot round has a cyclic resume chain')
      path.add(current)
      const cause = started.get(current)?.cause
      if (cause?.kind !== 'resume') break
      current = cause.pausedRunId
    }
    const roundRunId = byRun.get(current) ?? current
    for (const member of path) byRun.set(member, roundRunId)
    const runs = byRound.get(roundRunId) ?? []
    runs.push(runId)
    byRound.set(roundRunId, runs)
  }
  return { byRun, byRound }
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
  const { byRun, byRound } = indexRounds(entries)
  // Entry ids are session-local: keep each participating Tape's last fact, not a shared max.
  const revisions = new Map<string, Map<string, readonly [string, number]>>()
  const noteFact = (entry: TapeEntry, inheritedRound?: string) => {
    const round =
      inheritedRound ??
      byRun.get(entry.sourceId ?? '') ??
      byRun.get(String(entry.payload['runId'])) ??
      (typeof entry.payload['roundRunId'] === 'string' ? entry.payload['roundRunId'] : undefined)
    if (round === undefined) return
    const tapes = revisions.get(round) ?? new Map<string, readonly [string, number]>()
    tapes.set(entry.sessionId, [entry.incarnationId, entry.entryId])
    revisions.set(round, tapes)
  }
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
          roundRunId: inheritedRound ?? byRun.get(entry.sourceId) ?? entry.sourceId,
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
      noteFact(entry, inheritedRound)
      if (entry.name === 'tool/call') {
        nodeOf(entry)
        continue
      }
      if (entry.name === 'execution/dispatch_committed') {
        const node = nodeOf(entry)
        node.dispatched = true
        node.command = entry.payload['name'] === 'Bash'
      } else if (entry.name === 'execution/tool_outcome') {
        const snapshotId = entry.payload['snapshotId']
        if (typeof snapshotId === 'string') nodeOf(entry).snapshotId = snapshotId
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
        if (child.length > 0) noteFact(child.at(-1)!, node.roundRunId)
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
  const rootNodes = await readCalls(entries)
  const all = flatten(rootNodes)
  const rounds = [...byRound].map(([roundRunId, runIds]): CollectedRound => {
    const nodes = all.filter((node) => node.roundRunId === roundRunId)
    const calls = nodes
      .filter((node) => node.before !== undefined || node.after !== undefined)
      .map(queryCall)
    return {
      roundRunId,
      runIds,
      revision: JSON.stringify([...(revisions.get(roundRunId) ?? [])]),
      nodes,
      rootNodes: rootNodes.filter((node) => node.roundRunId === roundRunId),
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

/** D63: use the visible message fold, never a child's message or a retracted revision. */
function endMessageOf(
  entries: readonly TapeEntry[],
  runIds: readonly string[],
  activeRuns: readonly string[],
): string | null {
  const lastRunId = runIds.at(-1)
  const terminal = entries.findLast(
    (entry) => entry.name === 'execution/run_terminal' && entry.sourceId === lastRunId,
  )
  if (
    terminal === undefined ||
    (terminal.payload as RunTerminalPayload).reason.code === 'paused' ||
    activeRuns.some((runId) => runIds.includes(runId))
  )
    return null
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]))
  return (
    effectiveMessages(entries).findLast(
      (message) =>
        message.role === 'assistant' &&
        runIds.includes(String(byId.get(message.entryId)?.payload['runId'])),
    )?.messageId ?? null
  )
}

export function createSnapshotRestorer(deps: RestoreDeps) {
  const previewSkips = new Map<string, { revision: string; alive: boolean; skipped: boolean }>()
  return {
    // Settlement coverage may lag workspace-only changes between Tape revisions; explicit preview always recomputes the authoritative list.
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
        const cacheKey = JSON.stringify([
          history.entries[0]!.tenantId,
          sessionId,
          history.incarnationId,
          round.roundRunId,
        ])
        let cached = previewSkips.get(cacheKey)
        if (cached?.revision !== round.revision || cached.alive !== canRestore) {
          let skipped = false
          if (canRestore) {
            // oxlint-disable-next-line no-await-in-loop -- only changed rounds need the host's expensive preview
            skipped = (await deps.host.snapshots.preview(round.query)).skipped.length > 0
          }
          cached = { revision: round.revision, alive: canRestore, skipped }
          previewSkips.set(cacheKey, cached)
        }
        incompleteCoverage ||= cached.skipped
        const runIds = round.runIds
        rounds.push({
          roundRunId: round.roundRunId,
          runIds,
          endMessageId: endMessageOf(history.entries, runIds, deps.activeRuns()),
          calls: round.rootNodes.flatMap((node) => {
            const snapshotId = node.command
              ? node.before?.scope === 'tree'
                ? node.before.snapshotId
                : undefined
              : node.snapshotId
            return snapshotId === undefined ? [] : [{ callKey: node.callKey, snapshotId }]
          }),
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
