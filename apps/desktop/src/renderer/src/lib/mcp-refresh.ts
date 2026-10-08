import type { IpcResult, RouteResponse, mcpList } from '@tenon-app/contracts'
type Snapshot = RouteResponse<typeof mcpList>
/** Only the last requested refresh may replace the current view, regardless of reply order. */
export function createMcpRefresh(
  invoke: () => Promise<IpcResult<Snapshot>>,
  apply: (snapshot: Snapshot) => void,
) {
  let serial = 0
  return async () => {
    const version = ++serial
    const result = await invoke()
    if (result.ok && version === serial) apply(result.data)
  }
}
