import { createMcpRefresh } from '@/lib/mcp-refresh'
import { mcpAction as applyAction } from '@/lib/mcp-action'
import { invokeRoute, mcpList, mcpChanged } from '@tenon-app/contracts'
import type { RouteResponse, IpcResult } from '@tenon-app/contracts'
import { useSyncExternalStore } from 'react'
type Snapshot = RouteResponse<typeof mcpList>
let snapshot: Snapshot = { servers: [], overLimit: [] }
const listeners = new Set<() => void>()
let detach: (() => void) | null = null
export const refreshMcp = createMcpRefresh(
  () => invokeRoute(window.tenon, mcpList, {}),
  (next) => {
    snapshot = next
    for (const notify of listeners) notify()
  },
)

function subscribe(notify: () => void) {
  listeners.add(notify)
  if (!detach) {
    detach = window.tenon.on(mcpChanged.channel, (payload) => {
      if (mcpChanged.payload.safeParse(payload).success) void refreshMcp()
    })
    void refreshMcp()
  }
  return () => {
    listeners.delete(notify)
    if (!listeners.size) {
      detach?.()
      detach = null
    }
  }
}
export function useMcp() {
  return useSyncExternalStore(subscribe, () => snapshot)
}
export function mcpAction(promise: Promise<IpcResult<unknown>>) {
  return applyAction(promise, refreshMcp)
}
