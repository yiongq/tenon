import { createMcpRefresh } from '../src/renderer/src/lib/mcp-refresh.js'
import type { IpcResult, RouteResponse, mcpList } from '@tenon-app/contracts'
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

it('03 验收 44 / 18a-8: out-of-order refreshes publish only the later request', async () => {
  type Result = IpcResult<RouteResponse<typeof mcpList>>
  const first = Promise.withResolvers<Result>(),
    second = Promise.withResolvers<Result>()
  const apply = vi.fn<(snapshot: RouteResponse<typeof mcpList>) => void>()
  const invoke = vi
    .fn<() => Promise<Result>>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  const refresh = createMcpRefresh(invoke, apply)
  const a = refresh(),
    b = refresh()
  const latest = {
    servers: [],
    overLimit: [{ providerId: 'fixture', omitted: 2 }],
  }
  second.resolve({ ok: true, data: latest })
  await b
  first.resolve({ ok: true, data: { servers: [], overLimit: [] } })
  await a
  expect(apply.mock.calls).toEqual([[latest]])
})
