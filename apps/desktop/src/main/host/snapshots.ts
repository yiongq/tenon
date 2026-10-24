/**
 * Spec 05 §快照怎么拍 and §判定时怎么知道拍不拍得了: desktop snapshots under one tenant profile.
 * Each repository's writes are serial; a profile transaction lock also covers reservations,
 * publication and reclaim, so concurrent callers cannot spend the same free bytes.
 * Restore methods remain conservative until plan step 13.
 */
import { randomUUID } from 'node:crypto'
import { lstat, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import type {
  AbsolutePath,
  FileIdentity,
  HostClock,
  HostIdentity,
  HostSnapshots,
  RestoreDone,
  RestorePrepared,
  RestorePreview,
  RestoreQuery,
  SnapshotCoverage,
  SnapshotRequest,
  SnapshotStatus,
  SnapshotTaken,
} from '@tenon-app/kernel'
import { absolutePath, isCanonicalUuid } from '@tenon-app/kernel'
import { SnapshotGit, repoPath } from './snapshot-git.js'
import type { GitPorts } from './snapshot-git.js'
import {
  atomicJson,
  captureFile,
  contains,
  directory,
  diskBytes,
  errno,
  loadManifests,
  MAX_FILE_BYTES,
  parentModes,
  statOrNull,
  targetPath,
} from './snapshot-storage.js'
import type { SnapshotManifest } from './snapshot-storage.js'
import { captureTree, scanTree } from './snapshot-tree.js'

export interface SnapshotLimits {
  bytes: number
  files: number
  firstMs: number
  takeMs: number
  rounds: number
  ageMs: number
  coverageMs: number
}
export const SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = {
  bytes: 3_000_000_000,
  files: 100_000,
  firstMs: 120_000,
  takeMs: 5_000,
  rounds: 20,
  ageMs: 30 * 24 * 60 * 60 * 1000,
  coverageMs: 1_000,
}
export interface DesktopSnapshotsOptions extends GitPorts {
  identity: HostIdentity
  clock: HostClock
  home?: AbsolutePath
  platform?: NodeJS.Platform
  gitPath?: string
  /** Test budgets use the same paths and real git, without allocating gigabytes or waiting minutes. */
  limits?: Partial<SnapshotLimits>
  /** Host diagnostic; UI notices are wired with Tape/execution in later steps. Once per session. */
  onDegraded?: (sessionId: string, state: 'file-only' | 'unavailable') => void
}
interface Session {
  id: string
  dir: string
  folders: AbsolutePath[]
  state: SnapshotStatus
  manifests: SnapshotManifest[]
  controller: AbortController
  warming: Promise<void> | null
  configured: boolean
  generation: number
  notified: Set<string>
  repos: Set<string>
  lastDegradeReason: string | null
  treeDisabled: boolean
  diskFailed: boolean
}
class SnapshotBudgetError extends Error {}

export class DesktopSnapshots implements HostSnapshots {
  readonly ready: Promise<void>
  private readonly options: DesktopSnapshotsOptions
  private readonly limits: SnapshotLimits
  private readonly git: SnapshotGit
  private readonly sessions = new Map<string, Session>()
  private root: string
  private queue: Promise<unknown> = Promise.resolve()
  private reserved = 0
  private startupFailure: string | null = null
  private readonly active = new Map<string, number>()
  private readonly idleWaiters = new Map<string, Set<() => void>>()
  private readonly treeQueues = new Map<string, Promise<unknown>>()
  private activeRounds: () => readonly { rootSessionId: string; runId: string | null }[] = () => []

  constructor(options: DesktopSnapshotsOptions) {
    this.options = options
    this.limits = { ...SNAPSHOT_LIMITS, ...options.limits }
    this.root = join(options.identity.profileDir, 'snapshots')
    this.git = new SnapshotGit(options, options.platform, options.gitPath)
    this.ready = this.initialize().catch((error: unknown) => {
      this.startupFailure = error instanceof Error ? error.message : String(error)
    })
  }

  bindActiveRounds(read: () => readonly { rootSessionId: string; runId: string | null }[]): void {
    this.activeRounds = read
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }
  private treeSerial<T>(session: Session, work: () => Promise<T>): Promise<T> {
    const next = (this.treeQueues.get(session.id) ?? Promise.resolve()).then(work, work)
    this.treeQueues.set(
      session.id,
      next.catch(() => {}),
    )
    return next
  }
  private session(id: string): Session {
    if (!isCanonicalUuid(id)) throw new Error('Snapshot session id must be a canonical UUID')
    let session = this.sessions.get(id)
    if (session === undefined) {
      session = {
        id,
        dir: join(this.root, id),
        folders: [],
        state: 'unavailable',
        manifests: [],
        controller: new AbortController(),
        warming: null,
        configured: false,
        generation: 0,
        notified: new Set(),
        repos: new Set(),
        lastDegradeReason: null,
        treeDisabled: false,
        diskFailed: false,
      }
      this.sessions.set(id, session)
    }
    return session
  }
  /** Internal diagnostics only: raw errors never become message-stream copy. */
  lastDegradeReason(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.lastDegradeReason ?? this.startupFailure
  }
  private degrade(session: Session, state: 'file-only' | 'unavailable', reason: unknown): void {
    if (session.diskFailed && state !== 'unavailable') return
    const detail = reason instanceof Error ? reason.message : String(reason)
    session.lastDegradeReason = detail
    if (state === 'unavailable') session.diskFailed = true
    if (/budget|timeout|timed out/i.test(detail)) session.treeDisabled = true
    session.state = state
    if (!session.notified.has(state)) {
      session.notified.add(state)
      this.options.onDegraded?.(session.id, state)
    }
  }
  private profileFailure(error: unknown): boolean {
    const path =
      typeof error === 'object' && error !== null ? (error as { path?: unknown }).path : undefined
    return (
      (errno(error, 'ENOSPC') && (typeof path !== 'string' || contains(this.root, path))) ||
      (errno(error, 'EACCES') && typeof path === 'string' && contains(this.root, path))
    )
  }
  private async sessionDirs(session: Session): Promise<void> {
    await directory(this.root)
    await directory(session.dir)
    await directory(join(session.dir, 'files'))
    await directory(join(session.dir, 'manifests'))
    await directory(join(session.dir, 'repos'))
    await writeFile(join(session.dir, 'empty'), '')
  }

  private async initialize(): Promise<void> {
    const profile = await realpath(this.options.identity.profileDir)
    this.root = join(profile, 'snapshots')
    await directory(this.root)
    const signal = AbortSignal.timeout(this.limits.firstMs)
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isCanonicalUuid(entry.name)) continue
      const session = this.session(entry.name)
      try {
        // oxlint-disable-next-line no-await-in-loop -- recover one profile-owned session at a time
        await this.sessionDirs(session)
        // oxlint-disable-next-line no-await-in-loop -- reconstruct metadata before trusting refs
        session.manifests = await loadManifests(session.dir, session.id)
        session.folders = [
          ...new Set(
            session.manifests.flatMap((manifest) => manifest.trees.map((tree) => tree.folder)),
          ),
        ]
        // oxlint-disable-next-line no-await-in-loop -- git is never probed on Windows
        const available = await this.git.available(join(this.root, 'git-home'), signal)
        const repos = join(session.dir, 'repos')
        // oxlint-disable-next-line no-await-in-loop -- directories here are hashes, never workspace paths
        for (const repoName of await readdir(repos)) {
          if (!/^[0-9a-f]{64}$/.test(repoName)) continue
          const repo = join(repos, repoName)
          // oxlint-disable-next-line no-await-in-loop -- stale process must end before its index is touched
          await this.git.recoverProcess(repo, signal)
          // oxlint-disable-next-line no-await-in-loop -- discard a partial index and lock, not the workspace
          await Promise.all(
            ['index.lock', 'index'].map((name) => rm(join(repo, name), { force: true })),
          )
          const latest = session.manifests
            .toReversed()
            .toSorted((a, b) => b.createdAt - a.createdAt)
            .flatMap((manifest) => manifest.trees)
            .find((tree) => repoPath(session.dir, tree.folder) === repo)
          if (latest === undefined) {
            // No durable snapshot owns anything in this profile-only repository.
            // oxlint-disable-next-line no-await-in-loop -- remove crash debris after stopping its process
            await rm(repo, { recursive: true, force: true })
          } else if (available) {
            // Restore the index only; no -u, checkout or reset ever writes the workspace.
            // oxlint-disable-next-line no-await-in-loop -- rebuild each repository's index from a durable snapshot
            await this.git.run(repo, latest.folder, ['read-tree', latest.commit], signal)
            session.repos.add(repo)
          }
        }
        session.state = 'file-only'
        // oxlint-disable-next-line no-await-in-loop -- expiration covers even the sole/latest round
        await this.expire(session)
        // oxlint-disable-next-line no-await-in-loop -- remove refs and CAS files without a committed manifest
        await this.reclaim(session, signal)
      } catch (error) {
        this.degrade(session, 'unavailable', error)
      }
    }
  }

  status(sessionId: string): SnapshotStatus {
    return this.sessions.get(sessionId)?.state ?? 'unavailable'
  }

  /** Called only with folders accepted by the desktop/kernel workspace setter; never changes policy. */
  async setWorkspace(sessionId: string, folders: readonly AbsolutePath[]): Promise<void> {
    await this.ready
    const session = this.session(sessionId)
    const resolved = await Promise.all(
      folders.map(async (folder) => {
        try {
          return absolutePath(await realpath(folder))
        } catch {
          return folder
        }
      }),
    )
    if (
      session.configured &&
      session.folders.length === resolved.length &&
      session.folders.every((folder, i) => folder === resolved[i])
    )
      return
    session.configured = true
    session.controller.abort()
    session.controller = new AbortController()
    session.folders = resolved
    session.generation++
    const generation = session.generation
    if (session.diskFailed || session.treeDisabled) {
      session.state = session.diskFailed ? 'unavailable' : 'file-only'
      return
    }
    session.lastDegradeReason = null
    session.state = 'warming'
    const task = this.treeSerial(session, async () => {
      if (generation !== session.generation) return
      const signal = AbortSignal.any([
        session.controller.signal,
        AbortSignal.timeout(this.limits.firstMs),
      ])
      try {
        await this.sessionDirs(session)
        const foldersToWarm = []
        for (const folder of session.folders) {
          // oxlint-disable-next-line no-await-in-loop -- only real, non-home workspace folders get git repos
          if (await this.treeAllowed(folder)) foldersToWarm.push(folder)
        }
        if (
          foldersToWarm.length === 0 ||
          !(await this.git.available(join(this.root, 'git-home'), signal))
        ) {
          this.degrade(
            session,
            this.profileFailure(this.git.unavailableCause) ? 'unavailable' : 'file-only',
            this.git.unavailableReason ?? 'Workspace is limited to single-file snapshots',
          )
          return
        }
        const q: SnapshotRequest = {
          sessionId,
          call: { sessionId, roundRunId: 'warmup', runId: 'warmup', requestSeq: 0, ordinal: 0 },
          folders: foldersToWarm,
          moment: 'before-call',
        }
        const result = await this.capture(session, q, signal, true)
        if (!result.ok) throw new Error(result.reason)
        if (generation === session.generation && !session.diskFailed && !session.treeDisabled)
          session.state = 'tree'
      } catch (error) {
        if (generation !== session.generation) return
        this.degrade(
          session,
          this.profileFailure(error) ? 'unavailable' : 'file-only',
          signal.aborted && !session.controller.signal.aborted
            ? 'First snapshot timeout budget exceeded'
            : error,
        )
      }
    })
    session.warming = task
    void task.finally(() => {
      if (session.warming === task) session.warming = null
    })
  }

  async settled(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.warming
    await this.treeQueues.get(sessionId)
    await this.queue
  }

  private async treeAllowed(folder: AbsolutePath): Promise<boolean> {
    if ((this.options.platform ?? process.platform) === 'win32') return false
    const home = await realpath(this.options.home ?? homedir())
    const blocked = [
      home,
      dirname(home),
      join(home, 'Desktop'),
      join(home, 'Documents'),
      join(home, 'Downloads'),
    ]
    if (blocked.includes(folder) || contains(folder, this.root)) return false
    const [stat, parent] = await Promise.all([lstat(folder), lstat(dirname(folder))])
    return stat.isDirectory() && dirname(folder) !== folder && stat.dev === parent.dev
  }

  async coverage(q: { sessionId: string; path: AbsolutePath }): Promise<SnapshotCoverage> {
    const controller = new AbortController()
    let cancel: (() => void) | undefined
    const timeout = new Promise<SnapshotCoverage>((resolve) => {
      cancel = this.options.clock.setTimeout(() => {
        controller.abort()
        resolve('none')
      }, this.limits.coverageMs)
    })
    try {
      return await Promise.race([
        timeout,
        this.readCoverage(q, controller.signal).catch(() => 'none' as const),
      ])
    } finally {
      cancel?.()
    }
  }
  private async readCoverage(
    q: { sessionId: string; path: AbsolutePath },
    signal: AbortSignal,
  ): Promise<SnapshotCoverage> {
    await this.ready
    const session = this.sessions.get(q.sessionId)
    if (session === undefined || session.state === 'unavailable') return 'none'
    signal.throwIfAborted()
    const path = await targetPath(q.path)
    const folder = session.folders
      .filter((root) => contains(root, path))
      .toSorted((a, b) => b.length - a.length)[0]
    if (folder === undefined || contains(this.root, path)) return 'none'
    const rel = relative(folder, path)
    if (rel.split(sep).includes('.git')) return 'none'
    const stat = await statOrNull(path)
    signal.throwIfAborted()
    if (
      stat !== null &&
      ((!stat.isFile() && !stat.isSymbolicLink()) ||
        (stat.isFile() && stat.nlink > 1n) ||
        stat.size > BigInt(MAX_FILE_BYTES))
    )
      return 'none'
    if (stat?.isFile()) {
      // Permission checking is read-only; capture will still re-check when it actually opens.
      const { access } = await import('node:fs/promises')
      await access(path, 4)
    }
    if (session.state !== 'tree' || !session.repos.has(repoPath(session.dir, folder))) return 'file'
    // Only paths actually in the latest tree qualify as tree; new/excluded files use a single copy.
    const latest = session.manifests
      .toReversed()
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .flatMap((manifest) => manifest.trees)
      .find((tree) => tree.folder === folder)
    return latest?.entries.some((entry) => entry.path === path) ? 'tree' : 'file'
  }

  async take(q: SnapshotRequest, signal: AbortSignal): Promise<SnapshotTaken> {
    try {
      await this.ready
      signal.throwIfAborted()
      const session = this.session(q.sessionId)
      // Runtime callers also supply accepted folders; this covers restored sessions before a pick.
      if (!session.configured) await this.setWorkspace(q.sessionId, q.folders)
      const generation = session.generation
      // Freeze the mode before the first await: warming copies must never enter an unlocked tree.
      const withTree = session.state === 'tree'
      const deadline = AbortSignal.timeout(this.limits.takeMs)
      const combined = AbortSignal.any([signal, session.controller.signal, deadline])
      const run = async (): Promise<SnapshotTaken> => {
        try {
          combined.throwIfAborted()
          if (generation !== session.generation) return { ok: false, reason: 'aborted' }
          if (session.state === 'unavailable') return { ok: false, reason: 'disk' }
          await this.sessionDirs(session)
          if (
            q.path !== undefined &&
            (await this.readCoverage({ sessionId: q.sessionId, path: q.path }, combined)) === 'none'
          )
            return { ok: false, reason: 'not-covered' }
          await this.serial(() => this.expire(session))
          try {
            return await this.capture(
              session,
              q,
              combined,
              false,
              withTree && session.state === 'tree',
            )
          } catch (error) {
            if (
              !combined.aborted &&
              q.path !== undefined &&
              !(error instanceof SnapshotBudgetError) &&
              !this.profileFailure(error) &&
              !errno(error, 'EACCES')
            ) {
              this.degrade(session, 'file-only', error)
              return await this.capture(session, q, combined, false, false)
            }
            throw error
          }
        } catch (error) {
          if (signal.aborted || session.controller.signal.aborted)
            return { ok: false, reason: 'aborted' }
          if (deadline.aborted)
            this.degrade(session, 'file-only', 'Snapshot timeout budget exceeded')
          if (error instanceof SnapshotBudgetError) {
            this.degrade(session, 'file-only', error)
            return { ok: false, reason: 'over-budget' }
          }
          if (this.profileFailure(error)) {
            this.degrade(session, 'unavailable', error)
            return { ok: false, reason: 'disk' }
          }
          if (/file-count budget/.test(error instanceof Error ? error.message : String(error)))
            this.degrade(session, 'file-only', error)
          return { ok: false, reason: 'error' }
        }
      }
      // While the first tree warms, leaf copies never wait for its repository/index lock.
      return await (withTree ? this.treeSerial(session, run) : run())
    } catch {
      return { ok: false, reason: signal.aborted ? 'aborted' : 'error' }
    }
  }

  private async capture(
    session: Session,
    q: SnapshotRequest,
    signal: AbortSignal,
    bootstrap: boolean,
    withTree = bootstrap,
  ): Promise<SnapshotTaken> {
    // Register under the same lock as GC, before any repository/index operation.
    await this.serial(async () => {
      this.active.set(session.id, (this.active.get(session.id) ?? 0) + 1)
    })
    let reservation = 0
    const id = randomUUID()
    try {
      signal.throwIfAborted()
      const manifest: SnapshotManifest = {
        version: 1,
        id,
        sessionId: session.id,
        createdAt: this.options.clock.now(),
        call: q.call,
        moment: q.moment,
        bootstrap,
        trees: [],
        files: [],
        directories: {},
        skipped: 0,
      }
      const scans = []
      let estimate = 64_000
      if (bootstrap || (withTree && (q.moment !== 'after-call' || q.path === undefined))) {
        for (const folder of session.folders) {
          // oxlint-disable-next-line no-await-in-loop -- one shadow index is mutated at a time
          if (!(await this.treeAllowed(folder))) continue
          const repo = repoPath(session.dir, folder)
          if (!session.repos.has(repo)) {
            // oxlint-disable-next-line no-await-in-loop -- probe and initialize on the workspace volume
            await this.git.init(repo, folder, signal)
            session.repos.add(repo)
          }
          // oxlint-disable-next-line no-await-in-loop -- read metadata before any bytes are reserved or staged
          const scan = await scanTree(
            this.git,
            repo,
            folder,
            this.options.identity.profileDir,
            this.limits.files,
            signal,
          )
          estimate += scan.bytes * 2 + scan.entries.length * 4096
          scans.push({ repo, folder, scan })
          if (
            scans.reduce((count, item) => count + item.scan.entries.length, 0) > this.limits.files
          )
            throw new Error('Snapshot file-count budget exceeded')
        }
      }
      let target: FileIdentity | null | undefined
      if (q.path !== undefined)
        estimate += Number((await statOrNull(await targetPath(q.path)))?.size ?? 0n) + 8192
      if (scans.length === 0 && q.path === undefined) return { ok: false, reason: 'not-covered' }
      await this.serial(() => this.reserve(estimate, session, q.call.roundRunId, signal))
      reservation = estimate
      try {
        signal.throwIfAborted()
        for (const { repo, folder, scan } of scans) {
          // oxlint-disable-next-line no-await-in-loop -- parentless commit and ref for each accepted folder
          manifest.trees.push(await captureTree(this.git, repo, folder, scan, id, signal))
          manifest.skipped += scan.skipped
        }
        if (q.path !== undefined) {
          const path = await targetPath(q.path)
          const captured = await captureFile(path, join(session.dir, 'files'), signal)
          manifest.files.push(captured.file)
          target = captured.target
          const folder = session.folders
            .filter((root) => contains(root, path))
            .toSorted((a, b) => b.length - a.length)[0]!
          manifest.directories = await parentModes(path, folder)
        }
        signal.throwIfAborted()
        await this.serial(async () => {
          if ((await diskBytes(this.root)) > this.limits.bytes)
            throw new SnapshotBudgetError('Actual snapshot disk usage exceeded budget')
          await atomicJson(join(session.dir, 'manifests', `${id}.json`), manifest)
          session.manifests.push(manifest)
          // Warmup is an index bootstrap, not a user round. No call points at it.
          if (!bootstrap)
            await this.removeManifests(
              session,
              session.manifests.filter((item) => item.bootstrap),
              signal,
            )
          await this.keepRounds(session, signal)
        })
        signal.throwIfAborted()
        return {
          ok: true,
          snapshotId: id,
          scope: manifest.trees.length > 0 ? 'tree' : 'file',
          ...(target === undefined ? {} : { target }),
          skipped: manifest.skipped,
        }
      } catch (error) {
        session.manifests = session.manifests.filter((item) => item.id !== id)
        await rm(join(session.dir, 'manifests', `${id}.json`), { force: true })
        // Use a fresh cleanup deadline; the capture's deadline may have fired while git held its index.
        await this.git.settled()
        throw error
      }
    } finally {
      await this.serial(async () => {
        this.reserved -= reservation
        const left = (this.active.get(session.id) ?? 1) - 1
        if (left === 0) {
          this.active.delete(session.id)
          for (const resolve of this.idleWaiters.get(session.id) ?? []) resolve()
          this.idleWaiters.delete(session.id)
        } else this.active.set(session.id, left)
        if (left === 0)
          await this.reclaim(session, AbortSignal.timeout(this.limits.takeMs)).catch(() => {})
      })
    }
  }

  private async reserve(
    bytes: number,
    current: Session,
    round: string,
    signal: AbortSignal,
  ): Promise<void> {
    for (const session of this.sessions.values()) {
      // oxlint-disable-next-line no-await-in-loop -- age retention overrides every protection
      await this.expire(session)
    }
    let used = await diskBytes(this.root)
    const candidates = [...this.sessions.values()]
      .flatMap((session) => {
        if ((this.active.get(session.id) ?? 0) > (session === current ? 1 : 0)) return []
        const rounds = [...new Set(session.manifests.map((manifest) => manifest.call.roundRunId))]
        const latest = session.manifests
          .toReversed()
          .toSorted((a, b) => b.createdAt - a.createdAt)[0]?.call.roundRunId
        return rounds
          .filter(
            (id) =>
              id !== latest &&
              !(session === current && id === round) &&
              !this.activeRounds().some(
                (run) => run.rootSessionId === session.id && run.runId === id,
              ),
          )
          .map((id) => ({
            session,
            id,
            age: Math.min(
              ...session.manifests
                .filter((manifest) => manifest.call.roundRunId === id)
                .map((manifest) => manifest.createdAt),
            ),
          }))
      })
      .toSorted((a, b) => a.age - b.age)
    for (const candidate of candidates) {
      if (used + this.reserved + bytes <= this.limits.bytes) break
      // oxlint-disable-next-line no-await-in-loop -- remove one old round, reclaim and measure actual usage
      await this.removeManifests(
        candidate.session,
        candidate.session.manifests.filter((manifest) => manifest.call.roundRunId === candidate.id),
        signal,
        true,
      )
      // oxlint-disable-next-line no-await-in-loop -- disk blocks after git GC, not estimated content sizes
      used = await diskBytes(this.root)
    }
    if (used + this.reserved + bytes > this.limits.bytes)
      throw new SnapshotBudgetError('Snapshot budget is reserved or protected')
    this.reserved += bytes
  }

  private async expire(session: Session): Promise<void> {
    const latest = Math.max(...session.manifests.map((manifest) => manifest.createdAt))
    if (session.manifests.length > 0 && this.options.clock.now() - latest >= this.limits.ageMs) {
      await this.removeManifests(
        session,
        [...session.manifests],
        AbortSignal.timeout(this.limits.takeMs),
      )
    }
  }
  private async keepRounds(session: Session, signal: AbortSignal): Promise<void> {
    const rounds = new Map<string, number>()
    for (const manifest of session.manifests)
      if (!manifest.bootstrap)
        rounds.set(
          manifest.call.roundRunId,
          Math.max(rounds.get(manifest.call.roundRunId) ?? 0, manifest.createdAt),
        )
    const drop = new Set(
      [...rounds]
        .toReversed()
        .toSorted((a, b) => b[1] - a[1])
        .slice(this.limits.rounds)
        .map(([id]) => id),
    )
    await this.removeManifests(
      session,
      session.manifests.filter((manifest) => drop.has(manifest.call.roundRunId)),
      signal,
    )
  }
  private async removeManifests(
    session: Session,
    manifests: readonly SnapshotManifest[],
    signal: AbortSignal,
    reclaimActive = false,
  ): Promise<void> {
    if (manifests.length === 0) return
    const ids = new Set(manifests.map((manifest) => manifest.id))
    session.manifests = session.manifests.filter((manifest) => !ids.has(manifest.id))
    for (const manifest of manifests) {
      // oxlint-disable-next-line no-await-in-loop -- metadata removal publishes liveness loss before reclaim
      await rm(join(session.dir, 'manifests', `${manifest.id}.json`), { force: true })
    }
    await this.reclaim(session, signal, reclaimActive)
  }
  private async reclaim(
    session: Session,
    signal: AbortSignal,
    reclaimActive = false,
  ): Promise<void> {
    if (!reclaimActive && this.active.has(session.id)) return
    const keepFiles = new Set(
      session.manifests.flatMap((manifest) =>
        manifest.files.flatMap((file) => (file.hash === undefined ? [] : [file.hash])),
      ),
    )
    for (const name of await readdir(join(session.dir, 'files'))) {
      if (!keepFiles.has(name)) {
        // oxlint-disable-next-line no-await-in-loop -- CAS content with no durable owner is garbage
        await rm(join(session.dir, 'files', name), { force: true, recursive: true })
      }
    }
    for (const repo of session.repos) {
      const tree = session.manifests
        .toReversed()
        .toSorted((a, b) => b.createdAt - a.createdAt)
        .flatMap((manifest) => manifest.trees)
        .find((item) => repoPath(session.dir, item.folder) === repo)
      const folder =
        tree?.folder ?? session.folders.find((item) => repoPath(session.dir, item) === repo)
      if (folder === undefined) continue
      // oxlint-disable-next-line no-await-in-loop -- enumerate references under the repository lock
      const listed = await this.git.run(
        repo,
        folder,
        ['for-each-ref', '--format=%(refname)', 'refs/tenon/'],
        signal,
      )
      const refs = listed.trim().split('\n').filter(Boolean)
      const keep = new Set(
        session.manifests
          .filter((manifest) =>
            manifest.trees.some((item) => repoPath(session.dir, item.folder) === repo),
          )
          .map((manifest) => `refs/tenon/${manifest.id}`),
      )
      for (const ref of refs)
        if (!keep.has(ref)) {
          // oxlint-disable-next-line no-await-in-loop -- validate no caller-provided revision is used
          // oxlint-disable-next-line no-await-in-loop -- prune one obsolete reference at a time
          await this.git.run(repo, folder, ['update-ref', '-d', ref], signal)
        }
      // The index is a GC root. Failed captures must not pin unpublished or expired blobs.
      // oxlint-disable-next-line no-await-in-loop -- rebuild only the profile-owned index, never use -u
      await this.git.run(repo, folder, ['read-tree', tree?.commit ?? '--empty'], signal)
      // No parent chains or reflogs retain old snapshots. Reclaim now, never at an unspecified GC.
      // oxlint-disable-next-line no-await-in-loop -- each repository is collected before measuring blocks
      await this.git.run(repo, folder, ['gc', '--prune=now'], signal)
    }
  }

  async alive(sessionId: string, ids: readonly string[]): Promise<ReadonlySet<string>> {
    await this.ready
    return this.serial(async () => {
      const session = this.sessions.get(sessionId)
      if (session === undefined) return new Set<string>()
      await this.expire(session)
      const live = new Set(session.manifests.map((manifest) => manifest.id))
      return new Set(ids.filter((id) => live.has(id)))
    })
  }
  async removeSession(sessionId: string): Promise<void> {
    await this.ready
    const session = this.session(sessionId)
    session.generation++
    session.controller.abort()
    await session.warming
    await this.treeQueues.get(sessionId)
    // Also wait for in-flight single copies; they observe the session abort before publication.
    if (this.active.has(sessionId))
      await new Promise<void>((resolve) => {
        const waiters = this.idleWaiters.get(sessionId) ?? new Set()
        waiters.add(resolve)
        this.idleWaiters.set(sessionId, waiters)
      })
    await this.serial(async () => {
      await rm(session.dir, { recursive: true, force: true })
      this.sessions.delete(sessionId)
    })
  }

  /** Plan step 13 replaces the restore half; preview makes no promise and changes nothing. */
  async preview(_q: RestoreQuery): Promise<RestorePreview> {
    return { previewKey: '', restore: [], remove: [], conflicts: [], skipped: [] }
  }
  async prepare(_q: RestoreQuery & { previewKey: string }): Promise<RestorePrepared> {
    return { ok: false, reason: 'undo-unavailable' }
  }
  async apply(_q: Parameters<HostSnapshots['apply']>[0]): Promise<RestoreDone> {
    throw new Error('Snapshot restore is unavailable until spec 05 step 13')
  }
  async cancel(_q: Parameters<HostSnapshots['cancel']>[0]): Promise<void> {}
}

/** Eval hosts without lifecycle wiring still conservatively refuse snapshots (plan step 13). */
export const unavailableSnapshots: HostSnapshots = {
  coverage: async () => 'none',
  status: () => 'unavailable',
  take: async (_q, signal) => ({ ok: false, reason: signal.aborted ? 'aborted' : 'not-covered' }),
  preview: async () => ({ previewKey: '', restore: [], remove: [], conflicts: [], skipped: [] }),
  prepare: async () => ({ ok: false, reason: 'undo-unavailable' }),
  apply: async () => {
    throw new Error('Snapshot restore is unavailable until spec 05 step 13')
  },
  cancel: async () => {},
  alive: async () => new Set(),
}
