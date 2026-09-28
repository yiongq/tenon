/**
 * What the loop tests share: a host whose timers fire at once, the connector tool every batch calls,
 * a store a case can reach into, and leases begun the way the desktop begins them.
 */
import { createMemoryHost } from '../../src/index.js'
import type {
  HostAdapter,
  LoopPorts,
  McpConnection,
  McpToolSource,
  PendingApproval,
  PendingCard,
  RunOrigin,
  TapeStore,
} from '../../src/index.js'

/** The connector tool the loop tests call: `look` on server `fs`, under its provider name. */
export const LOOK = 'fs__look'

/**
 * A host whose timers fire at once, each delay recorded: a backoff is asserted, not waited for. A
 * timer fires on the next microtask, so it beats an inspector's answer: every fake inspector would
 * time out. With `answersFirst`, it fires on the next macrotask instead — once everything already
 * settled has run — so a fake answers as scripted and only one that never answers times out.
 */
export function instantHost(
  delays: number[] = [],
  o: { readonly answersFirst?: boolean } = {},
): HostAdapter {
  const host = createMemoryHost()
  let clock = 1_000
  return {
    ...host,
    clock: {
      now: (): number => (clock += 1),
      setTimeout: (fn, ms): (() => void) => {
        delays.push(ms)
        let live = true
        const fire = (): void => {
          if (live) fn()
        }
        if (o.answersFirst === true) setTimeout(fire, 0)
        else void Promise.resolve().then(fire)
        return () => {
          live = false
        }
      },
    },
  }
}

/**
 * The `fs` server with its one tool. `executed` records each call's arguments; `during`, when given,
 * runs while the call is in flight — where a case stops the Run or writes behind its back; a
 * `description` stands in for a server that changed its tool since the table froze.
 */
export function lookSource(
  executed: Record<string, unknown>[],
  during?: (args: Record<string, unknown>) => void | Promise<void>,
  description?: string,
): McpToolSource {
  const connection = {
    listTools: () =>
      Promise.resolve([
        {
          name: 'look',
          inputSchema: { type: 'object' },
          ...(description === undefined ? {} : { description }),
        },
      ]),
    callTool: async (_name: string, args: Record<string, unknown>) => {
      executed.push(args)
      await during?.(args)
      return {
        content: [{ type: 'text', text: `looked at ${String(args['at'])}` }],
        isError: false,
      }
    },
  } as unknown as McpConnection
  return { serverId: 'fs', connection }
}

/** The store with one or more of its methods replaced; the rest pass through, bound. */
export function proxyStore(store: TapeStore, overrides: Partial<TapeStore>): TapeStore {
  return new Proxy(store, {
    get(target, key): unknown {
      if (typeof key === 'string' && key in overrides) {
        return overrides[key as keyof TapeStore]
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  })
}

/**
 * `loop` with its leases begun as the desktop's RunRegistry begins them: a lease begun for a window
 * already closed is aborted at once with `close-window` (chat.ts), so a command that waited in the
 * mailbox while its window closed writes nothing (「登记之后、append 之前被中止」).
 */
export function closedWindows(loop: LoopPorts, closed: readonly RunOrigin[]): LoopPorts {
  return {
    ...loop,
    leases: {
      begin: (q) => {
        const begun = loop.leases.begin(q)
        if (!('refused' in begun) && q.origin !== null && closed.includes(q.origin)) {
          begun.abort('close-window')
        }
        return begun
      },
    },
  }
}

/**
 * `currentPending`'s approval card, for a case that pauses on a card: a question waiting there is a
 * bug in the case, so it throws (plan step 26 added the question variant).
 */
export function pendingCard(pending: PendingCard | null): PendingApproval | null {
  if (pending?.waitKind === 'question') throw new Error('a question waits, not an approval card')
  return pending
}
