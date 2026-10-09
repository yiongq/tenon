import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { McpLoginUi, McpLoginResult } from '@tenon-app/kernel'
import { createI18n } from '../../i18n/create-instance.js'
import type { Locale } from '../../i18n/resources.js'
export class McpLoopbackError extends Error {
  readonly code: 'port-in-use' | 'timeout' | 'cancelled'
  constructor(code: 'port-in-use' | 'timeout' | 'cancelled') {
    super(code)
    this.code = code
  }
}
export type McpCallbackListener = Awaited<ReturnType<McpLoginUi['listen']>> & {
  complete(result: McpLoginResult): void
}
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )
export async function listenMcpCallback(
  port: number,
  page: { locale: Locale; displayName: string } = { locale: 'en', displayName: '' },
): Promise<McpCallbackListener> {
  const i18n = await createI18n(page.locale, () => {})
  let wanted: string | null = null
  let resolve: ((value: URLSearchParams) => void) | null = null
  let reject: ((error: Error) => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let pageTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let callback: ServerResponse | null = null
  const early: { url: URL; res: ServerResponse }[] = []
  const reply = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    })
    res.end(
      `<!doctype html><html lang="${page.locale}"><meta charset="utf-8"><title>${escapeHtml(i18n.t('app.name'))}</title><body><p>${escapeHtml(message)}</p></body></html>`,
    )
  }
  const invalid = (res: ServerResponse) => reply(res, 400, i18n.t('mcp.callback.invalid'))
  // Do not await server.close: it waits for the response which the route still has to complete.
  const stopListening = () => {
    closed = true
    server.close()
    server.closeIdleConnections()
  }
  const finishPage = (message: string) => {
    if (!callback) return
    clearTimeout(pageTimer)
    const res = callback
    callback = null
    res.once('finish', () => server.closeIdleConnections())
    reply(res, 200, message)
    stopListening()
  }
  const respond = (url: URL, res: ServerResponse) => {
    if (
      url.pathname !== '/callback' ||
      closed ||
      callback ||
      (wanted !== null && url.searchParams.get('state') !== wanted)
    ) {
      invalid(res)
      return
    }
    if (wanted === null) {
      if (early.length < 32) early.push({ url, res })
      else invalid(res)
      return
    }
    callback = res
    // The 30 seconds start at the state-matched callback, independently of the 120 s login wait.
    pageTimer = setTimeout(() => finishPage(i18n.t('mcp.callback.pending')), 30_000)
    resolve?.(url.searchParams)
    resolve = null
    reject = null
    clearTimeout(timer)
  }
  const server = createServer((req, res) =>
    respond(new URL(req.url ?? '/', 'http://127.0.0.1'), res),
  )
  await new Promise<void>((done, fail) => {
    server.once('error', () => fail(new McpLoopbackError('port-in-use')))
    server.listen(port, '127.0.0.1', () => done())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new McpLoopbackError('port-in-use')
  return {
    port: address.port,
    waitForCallback(state, timeoutMs) {
      if (closed || wanted !== null) return Promise.reject(new McpLoopbackError('cancelled'))
      wanted = state
      return new Promise<URLSearchParams>((done, fail) => {
        resolve = done
        reject = fail
        timer = setTimeout(() => {
          reject?.(new McpLoopbackError('timeout'))
          reject = null
          resolve = null
          for (const item of early.splice(0)) invalid(item.res)
          stopListening()
        }, timeoutMs)
        for (const item of early.splice(0)) respond(item.url, item.res)
      })
    },
    async close() {
      clearTimeout(timer)
      reject?.(new McpLoopbackError('cancelled'))
      reject = null
      resolve = null
      for (const item of early.splice(0)) invalid(item.res)
      stopListening()
    },
    complete(result) {
      finishPage(
        result.ok
          ? i18n.t('mcp.callback.success', { name: page.displayName })
          : i18n.t(`mcp.callback.${result.code}`),
      )
    },
  }
}

/** Opt-in local test listener; packaged and normal development/live launches ignore the switch. */
export function usesMcpCallbackTestPort(q: {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
}): boolean {
  return (
    !q.isPackaged &&
    q.env['TENON_DEV_ENV'] === 'off' &&
    q.env['TENON_TEST_MCP_CALLBACK_PORT'] === 'auto'
  )
}
