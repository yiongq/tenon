import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { McpLoginUi } from '@tenon-app/kernel'
export class McpLoopbackError extends Error {
  readonly code: 'port-in-use' | 'timeout' | 'cancelled'
  constructor(code: 'port-in-use' | 'timeout' | 'cancelled') {
    super(code)
    this.code = code
  }
}
export const listenMcpCallback: McpLoginUi['listen'] = async (port) => {
  let wanted: string | null = null
  let resolve: ((value: URLSearchParams) => void) | null = null
  let reject: ((error: Error) => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const early: { url: URL; res: ServerResponse }[] = []
  const respond = (url: URL, res: ServerResponse) => {
    if (
      url.pathname !== '/callback' ||
      closed ||
      (wanted !== null && url.searchParams.get('state') !== wanted)
    ) {
      res.writeHead(400)
      res.end()
      return
    }
    if (wanted === null) {
      if (early.length < 32) early.push({ url, res })
      else {
        res.writeHead(400)
        res.end()
      }
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('')
    resolve?.(url.searchParams)
    resolve = null
    reject = null
    clearTimeout(timer)
    closed = true
    server.close()
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
          closed = true
          server.closeAllConnections()
          server.close()
        }, timeoutMs)
        for (const item of early.splice(0)) respond(item.url, item.res)
      })
    },
    async close() {
      clearTimeout(timer)
      reject?.(new McpLoopbackError('cancelled'))
      reject = null
      resolve = null
      if (closed) return
      closed = true
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}
