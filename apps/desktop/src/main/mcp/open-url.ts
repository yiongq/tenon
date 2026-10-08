import type { FetchLike } from '@tenon-app/kernel'
import { endpointOf } from '../endpoint.js'
export const MCP_OPEN_URL_ENV = 'TENON_TEST_MCP_OPEN_URL'
export function createMcpOpenUrl(q: {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
  openExternal: (url: string) => Promise<unknown>
  fetch: FetchLike
}) {
  return async (value: URL) => {
    const reach = endpointOf(value.href)?.reach
    if (
      !['http:', 'https:'].includes(value.protocol) ||
      (value.protocol === 'http:' && reach !== 'loopback') ||
      value.username ||
      value.password
    )
      throw Object.assign(new Error('unsafe-url'), { code: 'unsafe-url' })
    if (!q.isPackaged && q.env['TENON_DEV_ENV'] === 'off' && q.env[MCP_OPEN_URL_ENV] === 'direct') {
      const response = await q.fetch(value, { redirect: 'manual' })
      const target = response.headers.get('location')
      if (!target) throw Object.assign(new Error('network'), { code: 'network' })
      const callback = new URL(target)
      if (
        callback.protocol !== 'http:' ||
        callback.hostname !== '127.0.0.1' ||
        callback.pathname !== '/callback'
      )
        throw Object.assign(new Error('unsafe-url'), { code: 'unsafe-url' })
      // auth() starts waiting after openUrl returns. Do not wait on the callback here.
      void q
        .fetch(callback)
        .then((result) => result.body?.cancel())
        .catch(() => {})
      return
    }
    await q.openExternal(value.href)
  }
}
