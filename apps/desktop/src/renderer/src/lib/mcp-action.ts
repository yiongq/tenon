import type { IpcResult } from '@tenon-app/contracts'
export async function mcpAction(
  promise: Promise<IpcResult<unknown>>,
  refresh: () => Promise<void>,
): Promise<string | null> {
  try {
    const result = await promise
    if (!result.ok) return result.error.code === 'invalid-request' ? 'invalid-form' : 'unavailable'
    const data = result.data as { ok?: boolean; code?: string; restarted?: boolean }
    if (data.ok === false) {
      if (data.code === 'stale') await refresh()
      return data.code ?? 'unavailable'
    }
    if (data.restarted === false) return 'restart-refused'
    await refresh()
    return null
  } catch {
    return 'unavailable'
  }
}
