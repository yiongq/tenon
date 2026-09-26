import { chatContinue, chatSend, chatStop, registerRoute } from '@tenon-app/contracts'
import type { IpcMainLike } from '@tenon-app/contracts'
import { isCanonicalUuid } from '@tenon-app/kernel'
import type {
  AbsolutePath,
  CommandShell,
  HostClock,
  LoopPorts,
  RunAbortCause,
  RunLease,
  RunOrigin,
  SessionService,
} from '@tenon-app/kernel'
import type { EventSender } from './host/index.js'
import { localDateOf } from './locale.js'
import { createRunQueue } from './queue.js'
import type { RunQueue } from './queue.js'
import { createRunEvents, emitChatEvent } from './run-events.js'

/**
 * The chat path (spec 01 §desktop 接线; spec 02 §主进程与 kernel 的循环接口, §进行中、暂停与
 * RunRegistry). The loop is the kernel's now: `chat.send` forwards to `SessionService.send` and
 * `chat.stop` to `stop`, and what a Run does comes back as loop events (run-events.ts). What stays in
 * this file is the part only a host can do — which Runs are in progress, and which document asked for
 * each one:
 *
 *   - **the RunRegistry** is the one place in-progress Runs are recorded, by root session. It is the
 *     kernel's `LoopPorts.leases`: every Run the kernel opens is begun here first, so a stop, a
 *     closing window or a quit can reach it. It replaces phase 1's `inFlight` map.
 *   - **a Run never outlives the document that asked for it.** When the window closes, or the View
 *     menu's Reload replaces its document, the lease is aborted with `close-window`, and the kernel
 *     persists what did arrive as `status: 'aborted'` — which is what the user saw.
 *
 * Until plan step 17 queues and auto-sends a message sent while a reply streams, `chat.send` keeps
 * phase 1's refusal: a root with a live lease answers `ALREADY_STREAMING`, and a message the kernel
 * queued anyway (it arrived while the lease was being begun) is withdrawn and refused the same way.
 */

/** Diagnostics: logged and carried in the never-rendered `detail`, never shown to a user. */
const ALREADY_STREAMING = 'a reply is already streaming for this session'
const NO_STORE = 'the session store is unavailable'
const NOT_A_SESSION_ID = 'the session id is not a canonical uuid'
const NOT_BOUND = 'the agent loop is not bound yet'

/** Plan step 22 replaces this with shell-env.ts's shell and the user's terminal environment. */
const PLACEHOLDER_SHELL: CommandShell = {
  path: '/bin/sh' as AbsolutePath,
  env: () => Promise.resolve({}),
}

/**
 * The document a Run belongs to, as this file needs it — structural, so chat.ts stays free of
 * electron: what IPC hands the handler is an `IpcMainInvokeEvent` whose `sender` is a WebContents,
 * and that WebContents is the `RunOrigin` the kernel hands back.
 */
interface RunOwner {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
}

/**
 * Spec 02 §进行中、暂停与 RunRegistry — desktop-internal, not in contracts. `begin` is
 * `LoopPorts.leases.begin`.
 */
export interface RunRegistry {
  /** Registers a Run; after `beginShutdown` answers refused, and the kernel writes nothing. */
  begin(q: {
    rootSessionId: string
    origin: RunOrigin | null
  }): RunLease | { refused: 'shutting-down' }
  /** Roots with an un-aborted lease (one that has not opened a Run yet included); by origin if given. */
  running(origin?: RunOrigin): readonly string[]
  /** Aborts; the first cause stands, and a `user-stop` sets `stopRequested` whenever it comes. */
  abort(
    target: { rootSessionId: string } | { origin: RunOrigin } | 'all',
    cause: RunAbortCause,
  ): boolean
  /** Resolves when every registered lease has finished, or after `timeoutMs`, whichever is first. */
  settled(timeoutMs: number): Promise<void>
  /** From now on `begin` refuses. */
  beginShutdown(): void
  /** Desktop-internal: the lease's first Run, whichever session of the tree it ran in. */
  noteRunStarted(rootSessionId: string, runId: string): void
  /** Desktop-internal: every live lease, aborted ones included, with its Run. */
  snapshot(): readonly { rootSessionId: string; runId: string | null; aborted: boolean }[]
}

interface Registered {
  readonly lease: RunLease
  readonly controller: AbortController
  readonly origin: RunOrigin | null
  runId: string | null
  stopRequested: boolean
  detach: () => void
}

/** Aborts with the first cause only; a `user-stop` marks `stopRequested` whenever it comes. */
function abortOne(entry: Registered, cause: RunAbortCause): void {
  if (cause === 'user-stop') entry.stopRequested = true
  if (!entry.controller.signal.aborted) entry.controller.abort(cause)
}

export function createRunRegistry(clock: Pick<HostClock, 'setTimeout'>): RunRegistry {
  const live = new Map<string, Registered>()
  const waiters = new Set<() => void>()
  let shuttingDown = false

  const registry: RunRegistry = {
    begin(q) {
      if (shuttingDown) return { refused: 'shutting-down' }
      if (live.has(q.rootSessionId)) {
        // The kernel promises one live lease per root; a second begin is its bug, not a race.
        throw new Error(`RunRegistry: ${q.rootSessionId} already has a live lease`)
      }
      const controller = new AbortController()
      const entry: Registered = {
        controller,
        origin: q.origin,
        runId: null,
        stopRequested: false,
        detach: () => {},
        lease: {
          signal: controller.signal,
          get stopRequested(): boolean {
            return entry.stopRequested
          },
          abort: (cause) => abortOne(entry, cause),
          finish: () => {
            entry.detach()
            if (live.get(q.rootSessionId) === entry) live.delete(q.rootSessionId)
            if (live.size === 0) for (const resolve of waiters) resolve()
          },
        },
      }
      // Watched from the moment the lease exists: a window that disappears while the Run is still
      // being prepared must not leave one behind either.
      entry.detach = watchOwner(ownerOf(q.origin), () => abortOne(entry, 'close-window'))
      live.set(q.rootSessionId, entry)
      return entry.lease
    },
    running(origin) {
      return [...live.entries()]
        .filter(([, entry]) => !entry.controller.signal.aborted)
        .filter(([, entry]) => origin === undefined || entry.origin === origin)
        .map(([root]) => root)
    },
    abort(target, cause) {
      const targets = [...live.entries()].filter(
        ([root, entry]) =>
          target === 'all' ||
          ('rootSessionId' in target
            ? root === target.rootSessionId
            : entry.origin === target.origin),
      )
      for (const [, entry] of targets) abortOne(entry, cause)
      return targets.length > 0
    },
    settled(timeoutMs) {
      if (live.size === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const done = (): void => {
          waiters.delete(done)
          cancel()
          resolve()
        }
        const cancel = clock.setTimeout(done, timeoutMs)
        waiters.add(done)
      })
    },
    beginShutdown() {
      shuttingDown = true
    },
    noteRunStarted(rootSessionId, runId) {
      const entry = live.get(rootSessionId)
      if (entry !== undefined) entry.runId ??= runId
    },
    snapshot() {
      return [...live.entries()].map(([rootSessionId, entry]) => ({
        rootSessionId,
        runId: entry.runId,
        aborted: entry.controller.signal.aborted,
      }))
    },
  }
  return registry
}

/** The host's half of the loop: the registry, the queue and the ports `bindLoop` takes. */
export interface DesktopLoop {
  readonly registry: RunRegistry
  readonly queue: RunQueue
  readonly ports: LoopPorts
}

export interface DesktopLoopOptions {
  readonly clock: HostClock
  readonly send: EventSender
  /** The interface language now; the kernel reads it when it assembles a system prompt. */
  readonly locale: () => 'zh-CN' | 'en'
  readonly log?: (line: string) => void
}

export function createDesktopLoop(options: DesktopLoopOptions): DesktopLoop {
  const log = options.log ?? ((line: string): void => console.warn(line))
  const registry = createRunRegistry(options.clock)
  const queue = createRunQueue()
  const events = createRunEvents({
    send: options.send,
    onRunStarted: (root, runId) => registry.noteRunStarted(root, runId),
    log,
  })
  return {
    registry,
    queue,
    ports: {
      queue,
      leases: registry,
      events,
      locale: () => options.locale(),
      // Open question 16 (owner 2026-09-26): the user's local date, in this machine's time zone.
      localDate: () => localDateOf(options.clock.now()),
      commandShell: PLACEHOLDER_SHELL,
    },
  }
}

export interface ChatDeps {
  readonly send: EventSender
  readonly ipcMain: IpcMainLike
  /**
   * `null` when `sessions.db` could not be opened (another tenant's file, or one written by a
   * newer build). The window still runs and every chat route answers with a terminal `error`
   * instead of crashing, because the alternative — refusing to start — would also refuse the
   * settings the user needs in order to fix it. Nothing on disk is touched.
   */
  readonly sessions: SessionService | null
  /** The loop's host half, bound to `sessions`; null exactly when `sessions` is. */
  readonly loop: DesktopLoop | null
  readonly log?: (line: string) => void
  /** Startup recovery: every chat route waits for it first (spec 02 §启动恢复与发送防护). */
  readonly gate?: Promise<void>
}

export function registerChatRoutes(deps: ChatDeps): void {
  const { send, ipcMain, sessions, loop, gate } = deps
  const log = deps.log ?? ((line: string): void => console.warn(line))
  const accepted = { accepted: true as const }

  registerRoute(ipcMain, chatSend, async ({ sessionId, text }, event) => {
    await gate
    const fail = (detail: string): typeof accepted => {
      emitChatEvent(send, log, { type: 'error', sessionId, code: 'unknown', detail })
      return accepted
    }
    if (sessions === null || loop === null) return fail(NO_STORE)
    // Every id on the tape is a canonical UUID; a session id that is not one would be taken for a
    // new conversation on every send, so it is refused here rather than at the store.
    if (!isCanonicalUuid(sessionId)) return fail(NOT_A_SESSION_ID)
    // Plan step 17 turns this refusal into the queue. A root whose lease is still closing counts:
    // its Run has not written its end yet.
    if (loop.registry.snapshot().some((entry) => entry.rootSessionId === sessionId)) {
      throw new Error(ALREADY_STREAMING)
    }
    const result = await sessions.send({ sessionId, origin: ownerOf(senderOf(event)), text })
    switch (result.status) {
      case 'queued':
      case 'held':
        // Arrived while the lease was being begun: nothing sends it on yet, so it is withdrawn.
        await loop.queue.take(sessionId, {
          upToSeq: null,
          urgentOnly: false,
          queuedId: result.queuedId,
        })
        throw new Error(ALREADY_STREAMING)
      case 'refused':
        throw new Error(result.code === 'not-bound' ? NOT_BOUND : 'the app is shutting down')
      default:
        // started, not-sent (the loop already sent the terminal event), and the rest.
        return accepted
    }
  })

  registerRoute(ipcMain, chatStop, async ({ sessionId }) => {
    await gate
    if (sessions === null) return { stopped: false }
    return sessions.stop({ rootSessionId: sessionId })
  })

  // 「继续」 (spec 02 §重试与「继续」): the kernel judges whether there is anything to continue.
  registerRoute(ipcMain, chatContinue, async ({ sessionId }, event) => {
    await gate
    if (sessions === null || loop === null) throw new Error(NO_STORE)
    if (!isCanonicalUuid(sessionId)) throw new Error(NOT_A_SESSION_ID)
    const result = await sessions.continueRun({ sessionId, origin: ownerOf(senderOf(event)) })
    switch (result.status) {
      case 'refused':
        // A refusal is `ok: false` on every loop route (§主进程与 kernel 的循环接口).
        throw new Error('continue refused: the loop is not bound, or the app is shutting down')
      case 'held':
        return { status: 'held' as const, host: result.host }
      default:
        return { status: result.status }
    }
  })
}

/** The sender behind an IPC event, when there is one (a unit test's event carries none). */
function senderOf(event: unknown): unknown {
  return isRecord(event) ? event['sender'] : undefined
}

/** The document a Run belongs to, if what IPC handed over is one. */
function ownerOf(candidate: unknown): RunOwner | null {
  if (!isRecord(candidate)) return null
  const hasListeners =
    typeof candidate['on'] === 'function' && typeof candidate['off'] === 'function'
  return hasListeners ? (candidate as unknown as RunOwner) : null
}

/** Calls `gone` once the owning document is replaced or destroyed; returns the detach. */
function watchOwner(owner: RunOwner | null, gone: () => void): () => void {
  if (owner === null) return (): void => {}
  const onDestroyed = (): void => gone()
  const onNavigation = (...args: unknown[]): void => {
    // Electron's own `did-start-navigation` params. A main-frame navigation that is not a
    // fragment / pushState one replaces the document; anything else leaves the Run alone.
    const details = args[0]
    if (!isRecord(details)) return
    if (details['isMainFrame'] === true && details['isSameDocument'] === false) gone()
  }
  owner.on('destroyed', onDestroyed)
  owner.on('did-start-navigation', onNavigation)
  return (): void => {
    owner.off('destroyed', onDestroyed)
    owner.off('did-start-navigation', onNavigation)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
