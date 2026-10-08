import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createFixtureServer } from './fixtures/modern-server.mjs'

export interface HttpFixtureOptions {
  era?: 'modern' | 'legacy' | 'probe-204' | 'probe-non-json'
  failNext?: '401' | '403-scope' | '429' | 'break-stream' | undefined
  failConnect?: '429' | undefined
  authUrl?: string
  requireToken?: string | undefined
}
export interface FixtureRequest {
  method: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown>
  meta: unknown
}
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const part of req) chunks.push(Buffer.from(part))
  return Buffer.concat(chunks).toString()
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}
export async function startHttpFixture(initial: HttpFixtureOptions = {}) {
  let opts = { ...initial }
  const requests: FixtureRequest[] = []
  const modern = createMcpHandler(createFixtureServer, { legacy: 'reject' })
  const pending = new Map<unknown, { timer: ReturnType<typeof setTimeout>; res: ServerResponse }>()
  const legacyTools = [
    'echo',
    'slow',
    'elicit',
    'add-tool',
    'change-desc',
    'change-output',
    'pid',
  ].map((name) => ({ name, description: name, inputSchema: { type: 'object' } }))
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url?.includes('.well-known/oauth-protected-resource')) {
        if (opts.authUrl) json(res, { resource: `${url}`, authorization_servers: [opts.authUrl] })
        else json(res, {}, 404)
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      const raw = await readBody(req)
      const body = JSON.parse(raw) as Record<string, unknown>
      const method = String(body['method'] ?? '')
      requests.push({
        method,
        headers: { ...req.headers },
        body,
        meta: (body['params'] as Record<string, unknown> | undefined)?.['_meta'],
      })
      const fail = opts.failConnect ?? (method === 'tools/call' ? opts.failNext : undefined)
      if (method === 'tools/call') opts = { ...opts, failNext: undefined }
      if (
        fail === '401' ||
        (opts.requireToken && req.headers.authorization !== `Bearer ${opts.requireToken}`)
      ) {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource"`,
        })
        res.end()
        return
      }
      if (fail === '403-scope') {
        res.writeHead(403, {
          'www-authenticate': 'Bearer error="insufficient_scope", scope="extra"',
        })
        res.end()
        return
      }
      if (fail === '429') {
        res.writeHead(429)
        res.end()
        return
      }
      if (fail === 'break-stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(': open\n\n')
        setImmediate(() => res.destroy())
        return
      }
      if (method === 'server/discover' && opts.era === 'probe-204') {
        res.writeHead(204)
        res.end()
        return
      }
      if (method === 'server/discover' && opts.era === 'probe-non-json') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('probe')
        return
      }
      if (opts.era === undefined || opts.era === 'modern') {
        const response = await modern.fetch(
          new Request(url, { method: 'POST', headers: req.headers as HeadersInit, body: raw }),
        )
        res.writeHead(response.status, Object.fromEntries(response.headers))
        if (response.body) {
          const reader = response.body.getReader()
          res.on('close', () => {
            void reader.cancel()
          })
          for (;;) {
            // A fixture copies the HTTP response sequentially.
            // oxlint-disable-next-line no-await-in-loop
            const part = await reader.read()
            if (part.done) break
            res.write(part.value)
          }
        }
        res.end()
        return
      }
      const params = (body['params'] ?? {}) as Record<string, unknown>
      const result = (value: unknown) =>
        json(res, { jsonrpc: '2.0', id: body['id'], result: value })
      if (method === 'notifications/cancelled') {
        const active = pending.get(params['requestId'])
        if (active) {
          clearTimeout(active.timer)
          active.res.end()
          pending.delete(params['requestId'])
        }
        res.writeHead(202)
        res.end()
        return
      }
      if (body['id'] === undefined) {
        res.writeHead(202)
        res.end()
        return
      }
      if (method === 'initialize') {
        result({
          protocolVersion: params['protocolVersion'],
          capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
          serverInfo: { name: 'http-legacy', version: '1' },
          instructions: 'legacy fixture instructions',
        })
        return
      }
      if (method === 'tools/list') {
        result({ tools: legacyTools })
        return
      }
      if (method === 'tools/call') {
        const args = (params['arguments'] ?? {}) as Record<string, unknown>
        if (params['name'] === 'slow') {
          const timer = setTimeout(
            () => {
              pending.delete(body['id'])
              result({ content: [{ type: 'text', text: 'slow' }] })
            },
            Number(args['ms'] ?? 500),
          )
          pending.set(body['id'], { timer, res })
          return
        }
        result({ content: [{ type: 'text', text: JSON.stringify(args) }] })
        return
      }
      if (method === 'resources/list') {
        result({ resources: [{ uri: 'fixture://a', name: 'a' }] })
        return
      }
      if (method === 'resources/read' && params['uri'] === 'fixture://a') {
        result({ contents: [{ uri: 'fixture://a', text: 'fixture resource' }] })
        return
      }
      if (method === 'prompts/list') {
        result({ prompts: [{ name: 'fixture' }] })
        return
      }
      if (method === 'prompts/get') {
        result({ messages: [{ role: 'user', content: { type: 'text', text: 'fixture prompt' } }] })
        return
      }
      json(res, {
        jsonrpc: '2.0',
        id: body['id'],
        error: { code: method === 'resources/read' ? -32002 : -32601, message: 'Not found' },
      })
    })().catch(() => {
      if (!res.writableEnded) res.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no fixture address')
  const url = `http://127.0.0.1:${address.port}/mcp`
  return {
    url,
    requests,
    set(next: HttpFixtureOptions) {
      opts = { ...opts, ...next }
    },
    async close() {
      for (const { timer, res } of pending.values()) {
        clearTimeout(timer)
        res.destroy()
      }
      await modern.close()
      pending.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export interface FakeAuthOptions {
  prm?: boolean
  pkceField?: 'missing' | 'no-s256' | 'ok'
  metadataDown?: boolean
  issuerInMetadata?: string
  issInCallback?: string | null
  cimd?: boolean
  authNone?: boolean
  registration?: boolean
  rotateRefresh?: boolean
  refreshResult?: 'ok' | 'invalid_grant' | 'invalid_client'
  after401?: boolean
  callbackError?: 'access_denied' | null
}
export async function startFakeAuthServer(initial: FakeAuthOptions = {}) {
  let opts = { ...initial }
  const requests: {
    path: string
    headers: IncomingMessage['headers']
    body: Record<string, unknown>
  }[] = []
  let generation = 0
  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', url)
      const raw = await readBody(req)
      const body = req.headers['content-type']?.includes('application/json')
        ? (JSON.parse(raw || '{}') as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(raw))
      requests.push({ path: u.pathname, headers: { ...req.headers }, body })
      if (u.pathname.includes('.well-known/oauth-protected-resource')) {
        json(
          res,
          opts.prm === false ? {} : { resource: url, authorization_servers: [url] },
          opts.prm === false ? 404 : 200,
        )
        return
      }
      if (
        u.pathname.includes('.well-known/oauth-authorization-server') ||
        u.pathname.includes('.well-known/openid-configuration')
      ) {
        if (opts.metadataDown) {
          json(res, {}, 503)
          return
        }
        json(res, {
          issuer: opts.issuerInMetadata ?? url,
          authorization_endpoint: `${url}/authorize`,
          token_endpoint: `${url}/token`,
          ...(opts.registration === false ? {} : { registration_endpoint: `${url}/register` }),
          ...(opts.pkceField === 'missing'
            ? {}
            : {
                code_challenge_methods_supported:
                  opts.pkceField === 'no-s256' ? ['plain'] : ['S256'],
              }),
          client_id_metadata_document_supported: opts.cimd ?? false,
          token_endpoint_auth_methods_supported:
            opts.authNone === false ? ['client_secret_basic'] : ['none', 'client_secret_post'],
          authorization_response_iss_parameter_supported: true,
          response_types_supported: ['code'],
        })
        return
      }
      if (u.pathname === '/authorize') {
        const redirect = new URL(u.searchParams.get('redirect_uri') ?? '')
        redirect.searchParams.set('state', u.searchParams.get('state') ?? '')
        if (opts.issInCallback !== null) redirect.searchParams.set('iss', opts.issInCallback ?? url)
        redirect.searchParams.set(
          opts.callbackError ? 'error' : 'code',
          opts.callbackError ?? 'fixture-code',
        )
        res.writeHead(302, { location: redirect.href })
        res.end()
        return
      }
      if (u.pathname === '/register') {
        json(res, { ...body, client_id: 'fixture-client', client_id_issued_at: 1 })
        return
      }
      if (u.pathname === '/token') {
        if (
          body['grant_type'] === 'refresh_token' &&
          opts.refreshResult &&
          opts.refreshResult !== 'ok'
        ) {
          json(res, { error: opts.refreshResult }, 400)
          return
        }
        generation += 1
        json(res, {
          access_token: `fixture-access-${generation}`,
          refresh_token:
            opts.rotateRefresh === false ? 'fixture-refresh' : `fixture-refresh-${generation}`,
          token_type: 'Bearer',
          expires_in: 3600,
        })
        return
      }
      json(res, {}, 404)
    })().catch(() => {
      res.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no auth address')
  const url = `http://127.0.0.1:${address.port}`
  return {
    url,
    requests,
    set(next: FakeAuthOptions) {
      opts = { ...opts, ...next }
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
