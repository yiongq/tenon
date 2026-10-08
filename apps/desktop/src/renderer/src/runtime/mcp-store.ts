import { invokeRoute, mcpList, mcpChanged } from '@tenon-app/contracts'
import type { RouteResponse, IpcResult } from '@tenon-app/contracts'
import { useSyncExternalStore } from 'react'
type Snapshot = RouteResponse<typeof mcpList>
let snapshot: Snapshot = { servers: [], overLimit: [] }
let serial = 0
const listeners = new Set<() => void>()
let detach: (() => void) | null = null
export async function refreshMcp() {
  const version = ++serial
  const result = await invokeRoute(window.tenon, mcpList, {})
  if (result.ok && version === serial) {
    snapshot = result.data
    for (const notify of listeners) notify()
  }
}
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
export async function mcpAction(promise: Promise<IpcResult<unknown>>): Promise<string | null> {
  try {
    const result = await promise
    if (!result.ok) return 'unavailable'
    const data = result.data as { ok?: boolean; code?: string }
    if (data.ok === false) return data.code ?? 'unavailable'
    await refreshMcp()
    return null
  } catch {
    return 'unavailable'
  }
}
