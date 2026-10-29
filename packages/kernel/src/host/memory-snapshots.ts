/**
 * Spec 05: reproduces snapshot bytes/types/modes, per-call origins and gaps, conflict/stale,
 * undo snapshots, prepare/apply/cancel and real-folder lease ordering in one memory host.
 * It does not reproduce gitignore, git/disk budgets, volume casing or OS descriptor races.
 */
import type {
  AbsolutePath,
  FileIdentity,
  HostClock,
  HostFs,
  HostSnapshots,
  RestoreDone,
  RestorePrepared,
  RestorePreview,
  RestoreQuery,
  SnapshotCoverage,
  SnapshotRequest,
  SnapshotStatus,
  SnapshotTaken,
} from './adapter.js'

import { isWithin } from './path.js'

export interface MemorySnapshotNode {
  identity: FileIdentity
  data?: Uint8Array
  link?: string
}
export interface MemorySnapshotAccess {
  snapshotEntries(): Map<AbsolutePath, MemorySnapshotNode>
  restoreEntry(path: AbsolutePath, node: MemorySnapshotNode | undefined): void
  setSnapshotFolders(sessionId: string, roots: readonly AbsolutePath[]): void
  snapshotLock(roots: readonly AbsolutePath[]): (() => void) | null
}
interface Image {
  sessionId: string
  folders: readonly AbsolutePath[]
  tree: boolean
  path?: AbsolutePath
  nodes: Map<AbsolutePath, MemorySnapshotNode>
}
interface Item {
  path: AbsolutePath
  start: MemorySnapshotNode | undefined
  now: MemorySnapshotNode | undefined
  conflict: boolean
}
const stateKey = (node: MemorySnapshotNode | undefined, stamp = false): string =>
  JSON.stringify(
    node === undefined
      ? null
      : [
          node.identity.kind,
          node.identity.mode,
          node.link,
          node.data === undefined ? null : [...node.data],
          ...(stamp
            ? [
                node.identity.size,
                String(node.identity.mtimeNs),
                node.identity.nlink,
                String(node.identity.dev),
              ]
            : []),
        ],
  )

const covered = (image: Image | undefined, path: AbsolutePath): boolean =>
  image !== undefined &&
  (image.path === path || (image.tree && image.folders.some((root) => isWithin(path, root))))

type Failure = Extract<SnapshotTaken, { ok: false }>['reason']

/** Inspectable controls belong to the memory host only, never to HostSnapshots. */
export class MemorySnapshots implements HostSnapshots {
  private readonly states = new Map<string, SnapshotStatus>()
  private readonly live = new Map<string, Set<string>>()
  private readonly images = new Map<string, Image>()
  private readonly folders = new Map<string, readonly AbsolutePath[]>()
  private readonly prepared = new Map<string, { id: string; items: Item[]; release: () => void }>()
  private readonly access: MemorySnapshotAccess
  private nextId = 0
  private nextFailure: Failure | undefined
  takeDelayMs = 0

  private readonly fs: HostFs
  private readonly clock: HostClock

  constructor(fs: HostFs, clock: HostClock, access: MemorySnapshotAccess) {
    this.access = access
    this.fs = fs
    this.clock = clock
  }

  setStatus(sessionId: string, status: SnapshotStatus): void {
    this.states.set(sessionId, status)
  }

  failNextTake(reason: Failure): void {
    this.nextFailure = reason
  }

  status(sessionId: string): SnapshotStatus {
    return this.states.get(sessionId) ?? 'unavailable'
  }

  async coverage(q: {
    sessionId: string
    path: Parameters<HostFs['identity']>[0]
  }): Promise<SnapshotCoverage> {
    const state = this.status(q.sessionId)
    return state === 'tree' ? 'tree' : state === 'unavailable' ? 'none' : 'file'
  }

  async take(q: SnapshotRequest, signal: AbortSignal): Promise<SnapshotTaken> {
    if (signal.aborted) return { ok: false, reason: 'aborted' }
    if (this.takeDelayMs > 0) {
      const reason = await this.wait(signal)
      if (reason !== undefined) {
        if (reason === 'error') this.setStatus(q.sessionId, 'file-only')
        return { ok: false, reason }
      }
    }
    if (signal.aborted) return { ok: false, reason: 'aborted' }
    const failure = this.nextFailure
    this.nextFailure = undefined
    if (failure !== undefined) {
      if (failure === 'disk') this.setStatus(q.sessionId, 'unavailable')
      if (failure === 'over-budget') this.setStatus(q.sessionId, 'file-only')
      return { ok: false, reason: failure }
    }
    const state = this.status(q.sessionId)
    if (state === 'unavailable' || (state !== 'tree' && q.path === undefined)) {
      return { ok: false, reason: 'not-covered' }
    }
    try {
      const target = q.path === undefined ? undefined : await this.fs.identity(q.path)
      if (signal.aborted) return { ok: false, reason: 'aborted' }
      const snapshotId = `memory-snapshot-${++this.nextId}`
      const tree = state === 'tree' && (q.moment !== 'after-call' || q.path === undefined)
      const nodes = this.access.snapshotEntries()
      this.folders.set(q.sessionId, q.folders)
      this.access.setSnapshotFolders(q.sessionId, q.folders)
      this.images.set(snapshotId, {
        sessionId: q.sessionId,
        folders: q.folders,
        tree,
        ...(q.path === undefined ? {} : { path: q.path }),
        nodes: new Map(
          [...nodes].filter(([path]) =>
            tree ? q.folders.some((folder) => isWithin(path, folder)) : path === q.path,
          ),
        ),
      })
      const live = this.live.get(q.sessionId) ?? new Set<string>()
      live.add(snapshotId)
      this.live.set(q.sessionId, live)
      return {
        ok: true,
        snapshotId,
        scope:
          state === 'tree' && (q.moment !== 'after-call' || q.path === undefined) ? 'tree' : 'file',
        ...(target === undefined ? {} : { target }),
        skipped: 0,
      }
    } catch {
      return { ok: false, reason: 'error' }
    }
  }

  /** Spec 05 §快照怎么拍: later snapshots stop after five seconds, and always resolve. */
  private wait(signal: AbortSignal): Promise<Failure | undefined> {
    return new Promise((resolve) => {
      let cancelTimer: (() => void) | undefined
      const delay = this.takeDelayMs
      const finish = (reason: Failure | undefined) => {
        cancelTimer?.()
        signal.removeEventListener('abort', abort)
        resolve(reason)
      }
      const abort = () => finish('aborted')
      signal.addEventListener('abort', abort, { once: true })
      cancelTimer = this.clock.setTimeout(
        () => finish(delay > 5_000 ? 'error' : undefined),
        Math.min(delay, 5_000),
      )
      if (signal.aborted) abort()
    })
  }

  private plan(q: RestoreQuery): { preview: RestorePreview; items: Item[] } {
    const current = this.access.snapshotEntries()
    const roots = this.folders.get(q.sessionId) ?? []
    const changes = new Map<
      AbsolutePath,
      {
        start: MemorySnapshotNode | undefined
        last: MemorySnapshotNode | undefined
        missing: boolean
        gap: boolean
        covered: boolean
        promised: boolean
      }
    >()
    const image = (id?: string): Image | undefined => {
      const result = id === undefined ? undefined : this.images.get(id)
      return result?.sessionId === q.sessionId ? result : undefined
    }
    for (const call of q.calls) {
      const before = image(call.before)
      const after = image(call.after)
      const paths =
        call.path === undefined
          ? new Set([...(before?.nodes.keys() ?? []), ...(after?.nodes.keys() ?? [])])
          : new Set([call.path])
      for (const path of paths) {
        if (roots.includes(path)) continue
        const start = before?.nodes.get(path)
        const end = after?.nodes.get(path)
        if (call.path === undefined && after !== undefined && stateKey(start) === stateKey(end))
          continue
        const previous = changes.get(path)
        if (previous === undefined)
          changes.set(path, {
            start,
            last: end,
            missing: after === undefined,
            gap: false,
            covered: covered(before, path) && (after === undefined || covered(after, path)),
            promised: call.path !== undefined && covered(before, path),
          })
        else {
          previous.gap ||= previous.missing || stateKey(previous.last) !== stateKey(start)
          previous.last = end
          previous.missing = after === undefined
          previous.covered &&=
            covered(before, path) && (after === undefined || covered(after, path))
        }
      }
    }
    const restore: AbsolutePath[] = [],
      remove: AbsolutePath[] = [],
      conflicts: AbsolutePath[] = []
    const skipped: RestorePreview['skipped'][number][] = []
    const items: Item[] = []
    const stamps: unknown[] = []
    for (const [path, change] of [...changes].toSorted(([a], [b]) => a.localeCompare(b))) {
      const now = current.get(path)
      stamps.push([path, stateKey(now, true)])
      const reason = !roots.some((root) => isWithin(path, root))
        ? 'outside-folders'
        : [change.start, now].some(
              (node) => node?.identity.kind === 'file' && node.identity.nlink > 1,
            )
          ? 'hardlink'
          : !change.covered
            ? 'not-covered'
            : undefined
      if (reason !== undefined) {
        skipped.push({ path, reason, ...(change.promised ? { promised: true as const } : {}) })
        continue
      }
      if (stateKey(now) === stateKey(change.start)) continue
      const conflict = change.gap || change.missing || stateKey(now) !== stateKey(change.last)
      if (conflict) conflicts.push(path)
      if (change.start === undefined) remove.push(path)
      else restore.push(path)
      items.push({ path, start: change.start, now, conflict })
    }
    const previewKey = JSON.stringify([
      q.sessionId,
      q.roundRunId,
      q.calls,
      roots,
      restore,
      remove,
      conflicts,
      skipped,
      stamps,
    ])
    return { preview: { previewKey, restore, remove, conflicts, skipped }, items }
  }

  async preview(q: RestoreQuery): Promise<RestorePreview> {
    return this.plan(q).preview
  }

  async prepare(q: RestoreQuery & { previewKey: string }): Promise<RestorePrepared> {
    if (this.prepared.has(q.sessionId)) return { ok: false, reason: 'busy' }
    const folders = this.folders.get(q.sessionId) ?? []
    const release = this.access.snapshotLock(folders)
    if (release === null) return { ok: false, reason: 'busy' }
    let retained = false
    try {
      if (
        q.calls.some(
          (call) =>
            call.before !== undefined && this.images.get(call.before)?.sessionId !== q.sessionId,
        )
      )
        return { ok: false, reason: 'gone' }
      const plan = this.plan(q)
      const taken = await this.take(
        {
          sessionId: q.sessionId,
          call: {
            sessionId: q.sessionId,
            roundRunId: q.roundRunId,
            runId: q.roundRunId,
            ordinal: 0,
            requestSeq: 0,
          },
          folders,
          moment: 'before-restore',
          ...(this.status(q.sessionId) === 'tree' || plan.items[0] === undefined
            ? {}
            : { path: plan.items[0].path }),
        },
        new AbortController().signal,
      )
      if (!taken.ok)
        return {
          ok: false,
          reason: taken.reason === 'over-budget' ? 'over-budget' : 'undo-unavailable',
        }
      // One combined undo image covers every selected file even when ordinary takes are file-only.
      this.images.set(taken.snapshotId, {
        sessionId: q.sessionId,
        folders,
        tree: true,
        nodes: this.access.snapshotEntries(),
      })
      const latest = this.plan(q)
      if (latest.preview.previewKey !== q.previewKey) return { ok: false, reason: 'stale' }
      this.prepared.set(q.sessionId, { id: taken.snapshotId, items: latest.items, release })
      retained = true
      return { ok: true, undoSnapshotId: taken.snapshotId }
    } finally {
      if (!retained) release()
    }
  }

  async apply(q: Parameters<HostSnapshots['apply']>[0]): Promise<RestoreDone> {
    const prepared = this.prepared.get(q.sessionId)
    if (prepared?.id !== q.undoSnapshotId) throw new Error('Restore was not prepared')
    try {
      if (
        q.overwrite.some(
          (path) => !prepared.items.some((item) => item.path === path && item.conflict),
        )
      )
        throw new Error('Overwrite must be a subset of conflicts')
      const selected = prepared.items.filter(
        (item) => !item.conflict || q.overwrite.includes(item.path),
      )
      let restored = 0,
        removed = 0
      const failed: AbsolutePath[] = []
      const current = this.access.snapshotEntries()
      const valid = selected.filter((item) => {
        if (stateKey(current.get(item.path), true) === stateKey(item.now, true)) return true
        failed.push(item.path)
        return false
      })
      const removals = valid
        .filter(
          (item) =>
            item.start === undefined || item.start.identity.kind !== item.now?.identity.kind,
        )
        .toSorted((a, b) => b.path.length - a.path.length)
      for (const item of removals) {
        try {
          this.access.restoreEntry(item.path, undefined)
          if (item.start === undefined) removed++
        } catch {
          failed.push(item.path)
        }
      }
      for (const item of valid
        .filter((candidate) => candidate.start !== undefined)
        .toSorted((a, b) => a.path.length - b.path.length)) {
        if (failed.includes(item.path)) continue
        try {
          this.access.restoreEntry(item.path, item.start)
          restored++
        } catch {
          failed.push(item.path)
        }
      }
      return { restored, removed, kept: prepared.items.length - selected.length, failed }
    } finally {
      this.prepared.delete(q.sessionId)
      prepared.release()
    }
  }

  async cancel(q: Parameters<HostSnapshots['cancel']>[0]): Promise<void> {
    const prepared = this.prepared.get(q.sessionId)
    if (prepared?.id !== q.undoSnapshotId) return
    this.prepared.delete(q.sessionId)
    prepared.release()
  }

  async alive(sessionId: string, ids: readonly string[]): Promise<ReadonlySet<string>> {
    const live = this.live.get(sessionId)
    return new Set(ids.filter((id) => live?.has(id)))
  }
}
