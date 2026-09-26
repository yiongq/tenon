/**
 * What the loop tests share: a host whose timers fire at once, the connector tool every batch calls,
 * and a store a case can reach into.
 */
import { createMemoryHost } from '../../src/index.js'
import type { HostAdapter, McpConnection, McpToolSource, TapeStore } from '../../src/index.js'

/** The connector tool the loop tests call: `look` on server `fs`, under its provider name. */
export const LOOK = 'fs__look'

/** A host whose timers fire at once, each delay recorded: a backoff is asserted, not waited for. */
export function instantHost(delays: number[] = []): HostAdapter {
  const host = createMemoryHost()
  let clock = 1_000
  return {
    ...host,
    clock: {
      now: (): number => (clock += 1),
      setTimeout: (fn, ms): (() => void) => {
        delays.push(ms)
        let live = true
        void Promise.resolve().then(() => {
          if (live) fn()
        })
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
