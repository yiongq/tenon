/**
 * A minimal OpenAI-compatible /chat/completions endpoint that streams a scripted reply as SSE,
 * slowly enough that a client can abort mid-stream. The counterpart of `fake-anthropic.ts` for
 * the second wire, and the server acceptance 6 points the `zhipu` definition at.
 *
 * `node:http` is allowed HERE and only here: this is a host-level test double (spec 01 §对
 * 00-foundation 的修补). The kernel's own tests talk to `fakeNetwork`.
 *
 * The frame shape follows the vendors' documented streaming format, the same source as the
 * kernel's fixtures: one `data:` line per chunk, a role-only opening chunk, content deltas, a
 * chunk carrying `finish_reason`, the trailing usage chunk `stream_options.include_usage` buys,
 * and the `data: [DONE]` sentinel.
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

export interface FakeOpenAIOptions {
  /** Text chunks to stream, in order. */
  chunks: string[]
  /** Delay between chunks in ms. */
  delayMs?: number
  /**
   * Send this many chunks, then HOLD the connection open — nothing more goes onto the socket
   * until `release()` is called. What a test buys with it: an assertion that the early text was
   * already on screen at a moment when the rest of the reply did not exist yet, which a client
   * that buffered the whole reply could not satisfy.
   */
  holdAfter?: number
  /** Respond with this HTTP status and an error body instead of streaming. */
  failWith?: { status: number; code: string; message: string }
}

export interface FakeOpenAIRequest {
  path: string
  body: unknown
  headers: Record<string, string | string[] | undefined>
}

export interface FakeOpenAI {
  /** What a `baseURL` setting points at: the SDK appends `/chat/completions`. */
  baseURL: string
  requests: FakeOpenAIRequest[]
  /** True once a client closed the connection before the stream ended. */
  aborted: boolean
  chunksSent: number
  /** Lets a stream held by `holdAfter` finish. A no-op when nothing is held. */
  release(): void
  close(): Promise<void>
}

export async function startFakeOpenAI(options: FakeOpenAIOptions): Promise<FakeOpenAI> {
  const delayMs = options.delayMs ?? 30
  const hold = Promise.withResolvers<void>()
  const state: FakeOpenAI = {
    baseURL: '',
    requests: [],
    aborted: false,
    chunksSent: 0,
    release: () => hold.resolve(),
    close: async () => {},
  }

  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      const path = req.url ?? ''
      state.requests.push({ path, body: raw ? JSON.parse(raw) : null, headers: req.headers })
      if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
        res.writeHead(404).end()
        return
      }
      if (options.failWith) {
        const failure = options.failWith
        res.writeHead(failure.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: failure.code, message: failure.message } }))
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
      const frame = (data: unknown): boolean => {
        if (res.destroyed) return false
        res.write(`data: ${JSON.stringify(data)}\n\n`)
        return true
      }
      const chunk = (delta: unknown, finishReason: string | null = null): boolean =>
        frame({
          id: 'chatcmpl-fake',
          object: 'chat.completion.chunk',
          created: 1_774_000_000,
          model: 'fake-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })
      void (async () => {
        chunk({ role: 'assistant', content: '' })
        for (const text of options.chunks) {
          // oxlint-disable-next-line no-await-in-loop
          await sleep(delayMs)
          if (res.destroyed) return
          if (!chunk({ content: text })) return
          state.chunksSent += 1
          if (state.chunksSent !== options.holdAfter) continue
          // The tail waits here, on the socket's side of everything: nothing the app could have
          // buffered contains it yet.
          // oxlint-disable-next-line no-await-in-loop
          await hold.promise
          if (res.destroyed) return
        }
        chunk({}, 'stop')
        frame({
          id: 'chatcmpl-fake',
          object: 'chat.completion.chunk',
          created: 1_774_000_000,
          model: 'fake-model',
          choices: [],
          usage: {
            prompt_tokens: 7,
            completion_tokens: options.chunks.length,
            total_tokens: 7 + options.chunks.length,
          },
        })
        if (!res.destroyed) res.write('data: [DONE]\n\n')
        finished = true
        res.end()
      })()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake server did not bind')
  // With the trailing `/v1`, because that is where this wire's endpoint lives and what every
  // OpenAI-compatible vendor documents (the Anthropic wire refuses the same suffix).
  state.baseURL = `http://127.0.0.1:${address.port}/v1`
  state.close = () =>
    new Promise<void>((resolve) => {
      // Releasing first: a stream still parked on `holdAfter` would otherwise leave its loop
      // awaiting forever, and `server.close` waits for handlers to finish.
      hold.resolve()
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return state
}
