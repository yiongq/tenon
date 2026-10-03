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
 *
 * Two ways to say what it answers, as `fake-anthropic.ts` has them:
 *
 * - `chunks` (with `failWith` / `holdAfter`): every request gets the same text reply;
 * - `replies`: each /chat/completions request gets its own scripted reply — text, a thinking field
 *   (`reasoning_content` or `reasoning`), tool calls in the index protocol (the first fragment with
 *   its id, type and name, the arguments after it), a delta written as given (a vendor's field the
 *   decoder does not read: M6 §不认识的字段), its finish reason and pace, an HTTP failure, or nothing
 *   at all until the test releases it. The frames are the ones the kernel's decoder reads and its
 *   probe fixtures use (packages/kernel/test/provider/fixtures/probe-documented.ts).
 *
 * `models` answers GET /models (M6 §列表与上限: the list 「获取模型列表」 asks for).
 */
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

/** One step of a scripted reply. A string list streams one delta per item. */
export type OpenAIStep =
  | { readonly type: 'text'; readonly text: string | readonly string[] }
  | {
      readonly type: 'reasoning'
      /** The thinking field the delta carries; default `reasoning_content`. */
      readonly field?: 'reasoning_content' | 'reasoning'
      readonly text: string | readonly string[]
    }
  | {
      readonly type: 'tool_call'
      readonly id: string
      readonly name: string
      readonly input: Readonly<Record<string, unknown>>
    }
  /** A delta written as given, beside nothing else. */
  | { readonly type: 'delta'; readonly delta: Readonly<Record<string, unknown>> }
  /** Holds the stream open (nothing more is written) until `until` settles. */
  | { readonly type: 'wait'; readonly until: Promise<unknown> }

/** An HTTP failure: its status and the `error` object of the body. */
export interface OpenAIFailure {
  readonly status: number
  readonly code: string
  readonly message: string
  readonly type?: string
}

export interface OpenAIReply {
  readonly steps?: readonly OpenAIStep[]
  /** Default: `tool_calls` when the reply holds a tool call, `stop` otherwise. */
  readonly finishReason?: string
  /** Delay before each delta, in ms; default: the server's `delayMs`. */
  readonly delayMs?: number
  /** Answer with this HTTP status and error body instead of streaming. */
  readonly failWith?: OpenAIFailure
  /**
   * Answers nothing at all — no status line — until this settles, then the failure or the stream: a
   * request still in flight, whose outcome the test decides.
   */
  readonly hold?: Promise<unknown>
}

export interface FakeOpenAIOptions {
  /** Text chunks to stream, in order (the reply to every request `replies` does not cover). */
  chunks?: string[]
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
  failWith?: OpenAIFailure
  /**
   * Each /chat/completions request's reply by its 0-based index — a list, or a function of the
   * index and the request body. Past the end of a list (or `undefined` from the function), the
   * `chunks` reply is sent and `unscripted` counts it.
   */
  replies?: readonly OpenAIReply[] | ((index: number, body: unknown) => OpenAIReply | undefined)
  /** GET /models answers `{ object: 'list', data: models }`; without it, 404. */
  models?: readonly Readonly<Record<string, unknown>>[]
}

export interface FakeOpenAIRequest {
  /** The path with its query, as the client sent it. */
  path: string
  method: string
  body: unknown
  headers: Record<string, string | string[] | undefined>
}

export interface FakeOpenAI {
  /** What a `baseURL` setting points at: the SDK appends `/chat/completions`. */
  baseURL: string
  requests: FakeOpenAIRequest[]
  /** True once a client closed a connection before its answer ended. */
  aborted: boolean
  /** How many connections a client closed before their answer ended. */
  aborts: number
  chunksSent: number
  /** /chat/completions requests past the end of a `replies` list (they got the `chunks` reply). */
  unscripted: number
  /** Lets a stream held by `holdAfter` finish. A no-op when nothing is held. */
  release(): void
  close(): Promise<void>
}

/** The /chat/completions requests a fake saw, in order. */
export function completionRequests(fake: FakeOpenAI): FakeOpenAIRequest[] {
  return fake.requests.filter((request) => request.path.endsWith('/chat/completions'))
}

function chunksOf(value: string | readonly string[]): readonly string[] {
  return typeof value === 'string' ? [value] : value
}

function failResponse(res: ServerResponse, failure: OpenAIFailure): void {
  res.writeHead(failure.status, { 'content-type': 'application/json' })
  const error = {
    message: failure.message,
    ...(failure.type === undefined ? {} : { type: failure.type }),
    code: failure.code,
  }
  res.end(JSON.stringify({ error }))
}

/** Every frame of one response: `data: <json>` and its blank line; false once the client left. */
function framesOf(res: ServerResponse) {
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
  const usage = (completionTokens: number): boolean =>
    frame({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      created: 1_774_000_000,
      model: 'fake-model',
      choices: [],
      usage: {
        prompt_tokens: 7,
        completion_tokens: completionTokens,
        total_tokens: 7 + completionTokens,
      },
    })
  return { chunk, usage }
}

export async function startFakeOpenAI(options: FakeOpenAIOptions): Promise<FakeOpenAI> {
  const delayMs = options.delayMs ?? 30
  const chunks = options.chunks ?? []
  const hold = Promise.withResolvers<void>()
  const state: FakeOpenAI = {
    baseURL: '',
    requests: [],
    aborted: false,
    aborts: 0,
    chunksSent: 0,
    unscripted: 0,
    release: () => hold.resolve(),
    close: async () => {},
  }
  let completions = 0

  /** The reply to the `index`-th /chat/completions request, or null for the `chunks` reply. */
  const scripted = (index: number, body: unknown): OpenAIReply | null => {
    const replies = options.replies
    if (replies === undefined) return null
    const reply = typeof replies === 'function' ? replies(index, body) : replies[index]
    if (reply === undefined) {
      state.unscripted += 1
      return null
    }
    return reply
  }

  /** A client gave up on `res` before its answer ended. */
  const abandoned = (): void => {
    state.aborted = true
    state.aborts += 1
  }

  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      const path = req.url ?? ''
      const method = req.method ?? ''
      const body: unknown = raw ? JSON.parse(raw) : null
      state.requests.push({ path, method, body, headers: req.headers })
      const route = path.split('?')[0] ?? ''
      if (method === 'GET' && route.endsWith('/models') && options.models !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: options.models }))
        return
      }
      if (method !== 'POST' || !route.endsWith('/chat/completions')) {
        res.writeHead(404).end()
        return
      }
      const index = completions
      completions += 1
      const reply = scripted(index, body)
      if (reply !== null) {
        void answer(res, reply)
        return
      }
      if (options.failWith) {
        failResponse(res, options.failWith)
        return
      }
      void streamChunks(res)
    })
  })

  /** The phase 1 reply: the same text chunks for every request, `holdAfter` honoured. */
  async function streamChunks(res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    let finished = false
    res.on('close', () => {
      if (!finished) abandoned()
    })
    const { chunk, usage } = framesOf(res)
    chunk({ role: 'assistant', content: '' })
    for (const text of chunks) {
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
    usage(chunks.length)
    if (!res.destroyed) res.write('data: [DONE]\n\n')
    finished = true
    res.end()
  }

  /** A scripted reply: held first when it says so, then its failure or its stream. */
  async function answer(res: ServerResponse, reply: OpenAIReply): Promise<void> {
    let finished = false
    // Listening from the start: a client that gives up while the answer is held is an abort too.
    res.on('close', () => {
      if (!finished) abandoned()
    })
    if (reply.hold !== undefined) {
      await reply.hold
      if (res.destroyed) return
    }
    if (reply.failWith !== undefined) {
      finished = true
      failResponse(res, reply.failWith)
      return
    }
    const steps = reply.steps ?? []
    const pace = reply.delayMs ?? delayMs
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const { chunk, usage } = framesOf(res)
    /** One delta after the reply's delay; false once the client has gone. */
    const delta = async (payload: Record<string, unknown>): Promise<boolean> => {
      await sleep(pace)
      return chunk(payload)
    }
    chunk({ role: 'assistant', content: '' })
    let deltas = 0
    let calls = 0
    for (const step of steps) {
      switch (step.type) {
        case 'wait':
          // oxlint-disable-next-line no-await-in-loop -- open until the test says so
          await step.until
          if (res.destroyed) return
          continue
        case 'text':
          for (const text of chunksOf(step.text)) {
            // oxlint-disable-next-line no-await-in-loop -- one delta at a time, at the reply's pace
            if (!(await delta({ content: text }))) return
            state.chunksSent += 1
            deltas += 1
          }
          continue
        case 'reasoning':
          for (const text of chunksOf(step.text)) {
            // oxlint-disable-next-line no-await-in-loop -- one delta at a time, at the reply's pace
            if (!(await delta({ [step.field ?? 'reasoning_content']: text }))) return
            deltas += 1
          }
          continue
        case 'tool_call': {
          const index = calls
          calls += 1
          // The index protocol: id, type and name first, the arguments in a fragment of their own.
          // oxlint-disable-next-line no-await-in-loop -- one delta at a time, at the reply's pace
          const opened = await delta({
            tool_calls: [
              {
                index,
                id: step.id,
                type: 'function',
                function: { name: step.name, arguments: '' },
              },
            ],
          })
          if (!opened) return
          // oxlint-disable-next-line no-await-in-loop -- the arguments arrive at the reply's pace
          const sent = await delta({
            tool_calls: [{ index, function: { arguments: JSON.stringify(step.input) } }],
          })
          if (!sent) return
          deltas += 1
          continue
        }
        case 'delta':
          // oxlint-disable-next-line no-await-in-loop -- one delta at a time, at the reply's pace
          if (!(await delta({ ...step.delta }))) return
          deltas += 1
          continue
      }
    }
    chunk({}, reply.finishReason ?? (calls > 0 ? 'tool_calls' : 'stop'))
    usage(deltas)
    if (!res.destroyed) res.write('data: [DONE]\n\n')
    finished = true
    res.end()
  }

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
