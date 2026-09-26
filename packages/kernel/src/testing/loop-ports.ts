/**
 * The loop's ports for tests (spec 02 §主进程与 kernel 的循环接口「测试与 6b」): a scripted connector,
 * one in-memory queue, recording leases and an event recorder — so the state tables, the races and
 * recovery are kernel tests that need no Electron.
 *
 * What it models of a host, and nothing more:
 *
 *   - **leases** are recorded, and a second `begin` for a root that still has a live lease THROWS:
 *     the kernel promises never to ask, and a test that could not see it asking would prove nothing
 *     about it. `abort` keeps the first cause and sets `stopRequested` on any `user-stop`, the way
 *     the desktop's RunRegistry does. `beginShutdown` makes every later `begin` refuse.
 *   - **the queue** holds each root's messages in `seq` order; `take` removes, `restore` puts back
 *     at the original `seq`.
 *   - **the connector** answers from a script a case can change between sends: the model and the
 *     provider it builds, a `needsConfirm`, a `provider()` that throws, an `assemble` held open.
 *
 * No timers (the kernel lint gate): a case holds something open with a promise it resolves by hand.
 */
import type { SessionEvent } from '../loop/events.js'
import type {
  CapabilitySource,
  LoopPorts,
  McpToolSource,
  ModelChoice,
  QueuedMessage,
  RunAbortCause,
  RunAssembly,
  RunConnector,
  RunLease,
  RunOrigin,
} from '../loop/ports.js'
import type { AbsolutePath } from '../host/adapter.js'
import type { ModelInfo, Provider, ProviderId } from '../provider/types.js'
import type { CommandShell } from '../tools/builtin/bash.js'
import type { SearchBackend } from '../tools/search/types.js'

/** What the scripted connector answers with. */
export interface TestConnectorScript {
  readonly provider: Provider
  readonly model: ModelInfo
  readonly effort?: string | null
  readonly capabilitySource?: CapabilitySource
  /** Default `https://connector.test`. */
  readonly endpointOrigin?: string
  /** Default the model's `maxOutputTokens`. */
  readonly maxTokens?: number
  readonly toolsWithheld?: 'provider-text-only' | null
  readonly search?: SearchBackend | null
  readonly mcpSources?: readonly McpToolSource[]
}

export interface TestConnector extends RunConnector {
  /** Replaces what the connector answers from the next call on. */
  use(script: TestConnectorScript): void
  /** From the next `resolveChoice` on, answers `needsConfirm` with this host; null = chooses again. */
  needsConfirm(host: string | null): void
  /** The next `times` calls of `provider()` (default: all of them) throw this; null = builds again. */
  failProvider(error: Error | null, times?: number): void
  /**
   * Holds the NEXT `assemble` open until `release()`; `reached` settles once it is called. How a case
   * lands a second command inside a prebuild without a timer.
   */
  holdAssemble(): { readonly reached: Promise<void>; readonly release: () => void }
  readonly calls: {
    readonly resolveChoice: number
    readonly assemble: number
    readonly provider: number
  }
}

/** One recorded lease: what it was begun for, and what happened to it. */
export interface TestLease extends RunLease {
  readonly rootSessionId: string
  readonly origin: RunOrigin | null
  /** The first abort cause, or null while it was never aborted. */
  readonly cause: RunAbortCause | null
  readonly finished: boolean
}

type RunEnded = Extract<SessionEvent, { type: 'run-ended' }>

export interface TestLoopPortsOptions {
  readonly connector?: TestConnectorScript
  /** Default `'2026-09-26'`. */
  readonly localDate?: string
  /** Default `'en'`. */
  readonly locale?: 'zh-CN' | 'en'
  /** Default `/bin/sh` with an empty environment. */
  readonly commandShell?: CommandShell
  /** Called synchronously with every event as it is recorded: how a case acts at an exact point. */
  readonly onEvent?: (event: SessionEvent) => void
}

export interface TestLoopPorts extends LoopPorts {
  /** For `createSessionService({ connector })`: the connector goes in at construction. */
  readonly connector: TestConnector
  /** Every event, in the order the kernel sent them. */
  readonly recorded: readonly SessionEvent[]
  /** Every lease ever begun, in order. */
  readonly leaseLog: readonly TestLease[]
  /** The root's live lease (begun, not finished), or null. */
  liveLease(rootSessionId: string): TestLease | null
  /** Aborts the root's live lease the way a host does on a window close or a quit. */
  abort(rootSessionId: string, cause: RunAbortCause): boolean
  /** Every later `begin` answers `{ refused: 'shutting-down' }`. */
  beginShutdown(): void
  /** The root's queued messages, in `seq` order, without taking them. */
  queued(rootSessionId: string): readonly QueuedMessage[]
  /** The next `run-ended` not yet taken by an earlier call, optionally of one Run. */
  runEnded(q?: { readonly runId?: string | null }): Promise<RunEnded>
  setLocalDate(date: string): void
  /** The interface language the next system text is assembled in (a mid-session change, 旧 151). */
  setLocale(locale: 'zh-CN' | 'en'): void
}

const DEFAULT_ORIGIN = 'https://connector.test'

/** A `runEnded()` query matches every end when it names no Run. */
function matches(event: RunEnded, runId: string | null | undefined): boolean {
  return runId === undefined || event.runId === runId
}

export function createTestLoopPorts(options: TestLoopPortsOptions = {}): TestLoopPorts {
  const recorded: SessionEvent[] = []
  const leaseLog: TestLease[] = []
  const live = new Map<string, TestLease>()
  const queues = new Map<string, QueuedMessage[]>()
  let shuttingDown = false
  let nextSeq = 1
  let nextQueuedId = 1
  let localDate = options.localDate ?? '2026-09-26'
  let locale = options.locale ?? 'en'

  // run-ended bookkeeping: each event is handed to at most one `runEnded()` call.
  const ended: RunEnded[] = []
  const taken = new Set<number>()
  const waiters: Array<{ runId: string | null | undefined; resolve: (event: RunEnded) => void }> =
    []

  function record(event: SessionEvent): void {
    recorded.push(event)
    options.onEvent?.(event)
    if (event.type !== 'run-ended') return
    const index = ended.push(event) - 1
    const waiter = waiters.findIndex((w) => matches(event, w.runId))
    if (waiter < 0) return
    const [w] = waiters.splice(waiter, 1)
    taken.add(index)
    w?.resolve(event)
  }

  function queueOf(root: string): QueuedMessage[] {
    let queue = queues.get(root)
    if (queue === undefined) {
      queue = []
      queues.set(root, queue)
    }
    return queue
  }

  function begin(q: {
    rootSessionId: string
    origin: RunOrigin | null
  }): RunLease | { refused: 'shutting-down' } {
    if (shuttingDown) return { refused: 'shutting-down' }
    if (live.has(q.rootSessionId)) {
      throw new Error(`begin: root ${q.rootSessionId} already has a live lease`)
    }
    const controller = new AbortController()
    let cause: RunAbortCause | null = null
    let stopRequested = false
    let finished = false
    const lease: TestLease = {
      rootSessionId: q.rootSessionId,
      origin: q.origin,
      signal: controller.signal,
      get stopRequested(): boolean {
        return stopRequested
      },
      get cause(): RunAbortCause | null {
        return cause
      },
      get finished(): boolean {
        return finished
      },
      abort(next: RunAbortCause): void {
        if (next === 'user-stop') stopRequested = true
        if (cause !== null) return
        cause = next
        controller.abort(next)
      },
      finish(): void {
        if (finished) throw new Error(`finish: a lease of ${q.rootSessionId} finished twice`)
        finished = true
        if (live.get(q.rootSessionId) === lease) live.delete(q.rootSessionId)
      },
    }
    live.set(q.rootSessionId, lease)
    leaseLog.push(lease)
    return lease
  }

  const shell: CommandShell = options.commandShell ?? {
    path: '/bin/sh' as AbsolutePath,
    env: () => Promise.resolve({}),
  }

  return {
    connector: createTestConnector(options.connector),
    recorded,
    leaseLog,
    queue: {
      enqueue(root, text, o): Promise<{ queuedId: string; seq: number }> {
        const item: QueuedMessage = {
          queuedId: `queued-${nextQueuedId++}`,
          seq: nextSeq++,
          text,
          urgent: o.urgent,
        }
        queueOf(root).push(item)
        return Promise.resolve({ queuedId: item.queuedId, seq: item.seq })
      },
      peek(root): Promise<readonly QueuedMessage[]> {
        return Promise.resolve([...queueOf(root)])
      },
      take(root, o): Promise<readonly QueuedMessage[]> {
        const queue = queueOf(root)
        const picked = queue.filter(
          (item) =>
            (o.queuedId === undefined || item.queuedId === o.queuedId) &&
            (o.upToSeq === null || item.seq <= o.upToSeq) &&
            (!o.urgentOnly || item.urgent),
        )
        queues.set(
          root,
          queue.filter((item) => !picked.includes(item)),
        )
        return Promise.resolve(picked)
      },
      restore(root, items): Promise<void> {
        const merged = [...queueOf(root), ...items].toSorted((a, b) => a.seq - b.seq)
        queues.set(root, merged)
        return Promise.resolve()
      },
    },
    leases: { begin },
    events: record,
    locale: () => locale,
    localDate: () => localDate,
    commandShell: shell,
    liveLease: (root) => live.get(root) ?? null,
    abort(root, cause): boolean {
      const lease = live.get(root)
      if (lease === undefined) return false
      lease.abort(cause)
      return true
    },
    beginShutdown(): void {
      shuttingDown = true
    },
    queued: (root) => [...queueOf(root)],
    runEnded(q = {}): Promise<RunEnded> {
      const index = ended.findIndex((event, i) => !taken.has(i) && matches(event, q.runId))
      const event = ended[index]
      if (event !== undefined) {
        taken.add(index)
        return Promise.resolve(event)
      }
      return new Promise((resolve) => waiters.push({ runId: q.runId, resolve }))
    },
    setLocale(next): void {
      locale = next
    },
    setLocalDate(date): void {
      localDate = date
    },
  }
}

/**
 * The scripted connector. Without a script it still answers `endpointOrigin`; `resolveChoice`
 * rejects, because a case that sends without saying where to has a bug the test should show.
 */
export function createTestConnector(initial?: TestConnectorScript): TestConnector {
  let script = initial ?? null
  let confirmHost: string | null = null
  let providerError: Error | null = null
  let providerFailures = 0
  let held: { reached: () => void; gate: Promise<void> } | null = null
  const calls = { resolveChoice: 0, assemble: 0, provider: 0 }

  function current(): TestConnectorScript {
    if (script === null) throw new Error('the test connector has no script; pass connector: {…}')
    return script
  }

  return {
    endpointOrigin(providerId: ProviderId): string | null {
      return script?.provider.id === providerId ? (script.endpointOrigin ?? DEFAULT_ORIGIN) : null
    },
    resolveChoice(): Promise<ModelChoice | { needsConfirm: { host: string } }> {
      calls.resolveChoice += 1
      if (confirmHost !== null) return Promise.resolve({ needsConfirm: { host: confirmHost } })
      try {
        const s = current()
        return Promise.resolve({
          providerId: s.provider.id,
          modelId: s.model.id,
          effort: s.effort ?? null,
          capabilitySource: s.capabilitySource ?? 'builtin',
        })
      } catch (error) {
        return Promise.reject(error)
      }
    },
    async assemble(): Promise<RunAssembly> {
      calls.assemble += 1
      const hold = held
      held = null
      if (hold !== null) {
        hold.reached()
        await hold.gate
      }
      const s = current()
      return {
        model: s.model,
        capabilitySource: s.capabilitySource ?? 'builtin',
        endpointOrigin: s.endpointOrigin ?? DEFAULT_ORIGIN,
        maxTokens: s.maxTokens ?? s.model.maxOutputTokens,
        toolsWithheld: s.toolsWithheld ?? null,
        search: s.search ?? null,
        mcpSources: s.mcpSources ?? [],
        provider(): Provider {
          calls.provider += 1
          if (providerError !== null && providerFailures > 0) {
            providerFailures -= 1
            throw providerError
          }
          return s.provider
        },
      }
    },
    use(next): void {
      script = next
    },
    needsConfirm(host): void {
      confirmHost = host
    },
    failProvider(error, times = Number.POSITIVE_INFINITY): void {
      providerError = error
      providerFailures = error === null ? 0 : times
    },
    holdAssemble(): { reached: Promise<void>; release: () => void } {
      const reached = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      held = { reached: reached.resolve, gate: gate.promise }
      return { reached: reached.promise, release: gate.resolve }
    },
    calls,
  }
}
