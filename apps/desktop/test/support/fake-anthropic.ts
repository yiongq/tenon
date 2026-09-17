/**
 * A minimal Anthropic-compatible /v1/messages endpoint that streams a scripted reply
 * as SSE, slowly enough that a client can abort mid-stream. Records what it saw so a
 * test can assert that an abort really reached the wire.
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

export interface FakeAnthropicOptions {
  /** Text chunks to stream, in order. */
  chunks: string[]
  /** Delay between chunks in ms. */
  delayMs?: number
  /** Respond with this HTTP status and an error body instead of streaming. */
  failWith?: { status: number; type: string; message: string }
}

export interface FakeAnthropic {
  baseURL: string
  requests: Array<{ body: unknown; headers: Record<string, string | string[] | undefined> }>
  /** True once a client closed the connection before message_stop was written. */
  aborted: boolean
  chunksSent: number
  close(): Promise<void>
}

export async function startFakeAnthropic(options: FakeAnthropicOptions): Promise<FakeAnthropic> {
  const delayMs = options.delayMs ?? 30
  const state: FakeAnthropic = {
    baseURL: '',
    requests: [],
    aborted: false,
    chunksSent: 0,
    close: async () => {},
  }

  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      state.requests.push({ body: raw ? JSON.parse(raw) : null, headers: req.headers })
      if (req.method !== 'POST' || !req.url?.endsWith('/messages')) {
        res.writeHead(404).end()
        return
      }
      if (options.failWith) {
        res.writeHead(options.failWith.status, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: options.failWith.type, message: options.failWith.message },
          }),
        )
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      let finished = false
      res.on('close', () => {
        if (!finished) state.aborted = true
      })
      const event = (name: string, data: unknown): boolean => {
        if (res.destroyed) return false
        res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
        return true
      }
      void (async () => {
        event('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_fake',
            type: 'message',
            role: 'assistant',
            model: 'fake-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        })
        event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })
        for (const text of options.chunks) {
          // oxlint-disable-next-line no-await-in-loop
          await sleep(delayMs)
          if (res.destroyed) return
          if (
            !event('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text },
            })
          ) {
            return
          }
          state.chunksSent += 1
        }
        event('content_block_stop', { type: 'content_block_stop', index: 0 })
        event('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: options.chunks.length },
        })
        event('message_stop', { type: 'message_stop' })
        finished = true
        res.end()
      })()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake server did not bind')
  state.baseURL = `http://127.0.0.1:${address.port}`
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return state
}
