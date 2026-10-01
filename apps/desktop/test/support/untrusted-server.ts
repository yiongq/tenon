/** Loopback HTTP server for testing public-looking fetches through connectTarget (spec 02 step 27). */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return (server.address() as AddressInfo).port
}

export async function serveUntrusted(
  reply: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) =>
    response.end('public page'),
) {
  const requests: IncomingMessage[] = []
  const server = createServer((request, response) => {
    requests.push(request)
    reply(request, response)
  })
  const port = await listen(server)
  return {
    server,
    requests,
    port,
    url: `http://127.0.0.1:${String(port)}`,
    publicUrl: `http://fetch.example:${String(port)}`,
    close: () => closeServer(server),
  }
}

export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
}
