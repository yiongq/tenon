import type { IpcMainLike } from '@tenon-app/contracts'

/**
 * The e2e seam over the route table (spec 02 §e2e 接缝): development builds only, the same class of
 * switch as `TENON_E2E_RECOVERY_DELAY_MS` and `TENON_SECRETS=memory`. Off, the table is `ipcMain`
 * itself.
 *
 * - `TENON_E2E_ROUTE_COUNTS=1` counts every invoke of every route by channel, as it ARRIVES — before
 *   the handler runs, so a call still waiting on the recovery gate counts — in
 *   `globalThis.tenonRouteCalls`, which a test reads through `electronApp.evaluate`. What main
 *   received is the criterion (plan step 20, 旧 134: 「主进程收到 0 次 `chat.stop`」), never what the
 *   renderer believes it sent.
 * - `TENON_E2E_FAIL_ROUTES=<channel>,…` makes those routes answer `ok: false` once their own handler
 *   has run (after the gate, where a real failure would come from): `session.latest` failing is one
 *   of the answers that must let sending through (§启动恢复与发送防护, B15).
 */
export const ROUTE_COUNTS_ENV = 'TENON_E2E_ROUTE_COUNTS'
export const FAIL_ROUTES_ENV = 'TENON_E2E_FAIL_ROUTES'

/** Where the counts live in the main process, for `electronApp.evaluate` to read. */
export interface RouteCallsGlobal {
  tenonRouteCalls?: Record<string, number>
}

export function e2eRouteSeam(
  ipc: IpcMainLike,
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
): IpcMainLike {
  if (isPackaged) return ipc
  const counting = env[ROUTE_COUNTS_ENV] === '1'
  const failing = new Set(
    (env[FAIL_ROUTES_ENV] ?? '')
      .split(',')
      .map((channel) => channel.trim())
      .filter((channel) => channel !== ''),
  )
  if (!counting && failing.size === 0) return ipc
  const calls: Record<string, number> = {}
  if (counting) (globalThis as RouteCallsGlobal).tenonRouteCalls = calls
  return {
    handle(channel, listener) {
      ipc.handle(channel, async (event, ...args) => {
        if (counting) calls[channel] = (calls[channel] ?? 0) + 1
        const answer: unknown = await listener(event, ...args)
        if (!failing.has(channel)) return answer
        // A diagnostic, never shown: the renderer maps `code` to copy (contracts' IpcError).
        const diagnostic = `${channel}: failed by ${FAIL_ROUTES_ENV}`
        return { ok: false, error: { code: 'handler-failed', message: diagnostic } }
      })
    },
  }
}
