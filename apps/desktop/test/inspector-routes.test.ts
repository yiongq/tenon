import { expect, it, vi } from 'vitest'
import type { IpcMainLike } from '@tenon-app/contracts'
import type { SessionService } from '@tenon-app/kernel'
import { registerInspectorRoutes } from '../src/main/inspector-routes.js'
import { refuseWhileShuttingDown } from '../src/main/shutdown.js'

const request = { sessionId: '11111111-1111-4111-8111-111111111111', callKey: 'opaque:call:key' }
function harness(gate?: Promise<void>, absent = false) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain: IpcMainLike = {
    handle: (name, handler) => {
      handlers.set(name, handler)
    },
  }
  const releaseInspector = vi.fn<SessionService['releaseInspector']>(async () => ({
    status: 'released',
  }))
  let shuttingDown = false
  registerInspectorRoutes({
    ipcMain: refuseWhileShuttingDown(ipcMain, () => shuttingDown),
    sessions: absent ? null : { releaseInspector },
    ...(gate === undefined ? {} : { gate }),
  })
  return {
    releaseInspector,
    stop: () => {
      shuttingDown = true
    },
    call: (payload: unknown = request) => handlers.get('inspector.release')!({}, payload),
  }
}

it('inspector.release waits for startup recovery, forwards the opaque callKey, and validates input', async () => {
  const gate = Promise.withResolvers<void>()
  const h = harness(gate.promise)
  const result = h.call()
  await Promise.resolve()
  expect(h.releaseInspector).not.toHaveBeenCalled()
  gate.resolve()
  expect(await result).toEqual({ ok: true, data: { status: 'released' } })
  expect(h.releaseInspector).toHaveBeenCalledExactlyOnceWith(request)
  expect(await h.call({ ...request, inspectorIds: ['forged'] })).toMatchObject({
    ok: false,
    error: { code: 'invalid-request' },
  })
  expect(h.releaseInspector).toHaveBeenCalledTimes(1)
})

it('inspector.release refuses at shutdown before the recovery gate, and handles no session store', async () => {
  const h = harness(new Promise(() => {}))
  h.stop()
  expect(await h.call()).toEqual({
    ok: false,
    error: { code: 'handler-failed', message: 'the app is shutting down' },
  })
  expect(h.releaseInspector).not.toHaveBeenCalled()
  expect(await harness(undefined, true).call()).toEqual({ ok: true, data: { status: 'not-found' } })
})

it.each(['released', 'already-released', 'stale', 'not-found', 'refused'] as const)(
  'inspector.release preserves the kernel status %s',
  async (status) => {
    const h = harness()
    h.releaseInspector.mockResolvedValue({ status })
    expect(await h.call()).toEqual({ ok: true, data: { status } })
  },
)
