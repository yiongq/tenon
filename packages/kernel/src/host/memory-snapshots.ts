/**
 * Spec 05 §接口 and §快照怎么拍: models the real host's four states, target stamps,
 * session-scoped liveness and resolved take failures/timeouts/aborts. No disk, git or restore engine;
 * restore methods conservatively refuse until the later snapshot/restore implementation steps.
 * Coverage is scripted by session state; path eligibility and exclusions belong to the later subsystem.
 */
import type {
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

type Failure = Extract<SnapshotTaken, { ok: false }>['reason']

/** Inspectable controls belong to the memory host only, never to HostSnapshots. */
export class MemorySnapshots implements HostSnapshots {
  private readonly states = new Map<string, SnapshotStatus>()
  private readonly live = new Map<string, Set<string>>()
  private nextId = 0
  private nextFailure: Failure | undefined
  takeDelayMs = 0

  private readonly fs: HostFs
  private readonly clock: HostClock

  constructor(fs: HostFs, clock: HostClock) {
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

  async preview(_q: RestoreQuery): Promise<RestorePreview> {
    throw new Error('MemorySnapshots: restore engine is unavailable')
  }

  async prepare(_q: RestoreQuery & { previewKey: string }): Promise<RestorePrepared> {
    return { ok: false, reason: 'undo-unavailable' }
  }

  async apply(_q: Parameters<HostSnapshots['apply']>[0]): Promise<RestoreDone> {
    throw new Error('MemorySnapshots: restore engine is unavailable')
  }

  async cancel(_q: Parameters<HostSnapshots['cancel']>[0]): Promise<void> {}

  async alive(sessionId: string, ids: readonly string[]): Promise<ReadonlySet<string>> {
    const live = this.live.get(sessionId)
    return new Set(ids.filter((id) => live?.has(id)))
  }
}
