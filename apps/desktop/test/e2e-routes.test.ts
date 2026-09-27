/**
 * The e2e route seam (spec 02 §e2e 接缝; plan step 20, 旧 134 and 旧 138's e2e): off unless a
 * development build asks, a count per channel taken as the call arrives, and a failure that answers
 * after the route's own handler has run.
 */
import { registerRoute, sessionLatest } from '@tenon-app/contracts'
import type { IpcMainLike } from '@tenon-app/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { FAIL_ROUTES_ENV, ROUTE_COUNTS_ENV, e2eRouteSeam } from '../src/main/e2e-routes.js'
import type { RouteCallsGlobal } from '../src/main/e2e-routes.js'

type Listener = (event: unknown, ...args: unknown[]) => unknown

function fakeIpc(): IpcMainLike & { readonly handlers: Map<string, Listener> } {
  const handlers = new Map<string, Listener>()
  return { handlers, handle: (channel, listener) => void handlers.set(channel, listener) }
}

const counts = (): Record<string, number> | undefined =>
  (globalThis as RouteCallsGlobal).tenonRouteCalls

afterEach(() => {
  delete (globalThis as RouteCallsGlobal).tenonRouteCalls
})

describe('e2eRouteSeam', () => {
  it('is ipcMain itself in a packaged build, and in a development build nobody asked', () => {
    const ipc = fakeIpc()
    expect(e2eRouteSeam(ipc, true, { [ROUTE_COUNTS_ENV]: '1', [FAIL_ROUTES_ENV]: 'a' })).toBe(ipc)
    expect(e2eRouteSeam(ipc, false, {})).toBe(ipc)
    expect(e2eRouteSeam(ipc, false, { [ROUTE_COUNTS_ENV]: 'yes', [FAIL_ROUTES_ENV]: ' , ' })).toBe(
      ipc,
    )
    expect(counts()).toBeUndefined()
  })

  it('counts a call when it arrives, before its handler settles', async () => {
    const ipc = fakeIpc()
    const routes = e2eRouteSeam(ipc, false, { [ROUTE_COUNTS_ENV]: '1' })
    const { promise: gate, resolve } = Promise.withResolvers<void>()
    registerRoute(routes, sessionLatest, async () => {
      await gate
      return null
    })
    const pending = ipc.handlers.get(sessionLatest.channel)?.({}, { limit: 1 })
    expect(counts()).toEqual({ [sessionLatest.channel]: 1 })
    resolve()
    await expect(pending).resolves.toEqual({ ok: true, data: null })
    expect(counts()).toEqual({ [sessionLatest.channel]: 1 })
  })

  it('answers ok:false for a failed route only after its handler ran', async () => {
    const ipc = fakeIpc()
    const routes = e2eRouteSeam(ipc, false, { [FAIL_ROUTES_ENV]: ` ${sessionLatest.channel} ` })
    let ran = 0
    registerRoute(routes, sessionLatest, () => {
      ran += 1
      return null
    })
    const answer = await ipc.handlers.get(sessionLatest.channel)?.({}, { limit: 1 })
    expect(ran).toBe(1)
    expect(answer).toMatchObject({ ok: false, error: { code: 'handler-failed' } })
    // Failing alone does not turn the counter on.
    expect(counts()).toBeUndefined()
  })
})
