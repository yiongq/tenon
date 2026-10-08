import { expect, it, vi } from 'vitest'
import { mcpAction } from '../src/renderer/src/lib/mcp-action.js'
it('mcpAction maps invalid requests and refused restart; stale refreshes the current server view', async () => {
  const refresh = vi.fn<() => Promise<void>>(async () => {})
  expect(
    await mcpAction(
      Promise.resolve({ ok: false, error: { code: 'invalid-request', message: 'bad' } }),
      refresh,
    ),
  ).toBe('invalid-form')
  expect(await mcpAction(Promise.resolve({ ok: true, data: { restarted: false } }), refresh)).toBe(
    'restart-refused',
  )
  expect(
    await mcpAction(Promise.resolve({ ok: true, data: { ok: false, code: 'stale' } }), refresh),
  ).toBe('stale')
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(
    await mcpAction(Promise.resolve({ ok: true, data: { restarted: true } }), refresh),
  ).toBeNull()
  expect(refresh).toHaveBeenCalledTimes(2)
})
