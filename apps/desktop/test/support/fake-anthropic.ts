/**
 * A minimal Anthropic-compatible /v1/messages endpoint that streams a scripted reply
 * as SSE, slowly enough that a client can abort mid-stream. Records what it saw so a
 * test can assert that an abort really reached the wire.
 *
 * Two ways to say what it answers:
 *
 * - `chunks` (with `failWith` / `failTimes` / `stopReasons`): every request gets the same text reply,
 *   the phase 1 shape the older tests use;
 * - `replies`: each `/messages` request gets its own scripted reply — text, thinking with its
 *   signature, tool_use blocks, its stop reason and pace, an HTTP failure, a stream held open until
 *   the test releases it (or the whole answer, before its status line), or a connection cut
 *   mid-stream. The frames are the ones the kernel's decoder
 *   reads (packages/kernel/src/provider/wire/anthropic-messages.ts, normaliseAnthropicEvents).
 */
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

/** One content block of a scripted reply. A string list streams one delta per item. */
export type ScriptedBlock =
  | { readonly type: 'text'; readonly text: string | readonly string[] }
  | {
      readonly type: 'thinking'
      readonly thinking: string | readonly string[]
      /** Sent as one `signature_delta` after the text, as the wire does. */
      readonly signature: string
    }
  | {
      readonly type: 'tool_use'
      readonly id: string
      readonly name: string
      readonly input: Readonly<Record<string, unknown>>
    }

/** A step of a scripted stream: a block, or something that happens between blocks. */
export type ScriptedStep =
  | ScriptedBlock
  /** Holds the stream open (nothing more is written) until `until` settles. */
  | { readonly type: 'wait'; readonly until: Promise<unknown> }
  /**
   * Destroys the connection here, with no terminal frame: a mid-stream failure, which the kernel
   * reads as a retryable network error and discards (§重试与「继续」).
   */
  | { readonly type: 'cut' }

/**
 * An HTTP failure: its status and the vendor's error body. `details` rides in `error.details`, where
 * the vendor names a spend limit (`error_code: 'enforced_spend_limit_reached'`, anthropic-messages.ts
 * isSpendLimit).
 */
export interface FailWith {
  readonly status: number
  readonly type: string
  readonly message: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface ScriptedReply {
  readonly steps?: readonly ScriptedStep[]
  /** Default: `tool_use` when the reply holds a tool_use block, `end_turn` otherwise. */
  readonly stopReason?: string
  /** Delay before each delta, in ms; default: the server's `delayMs`. */
  readonly delayMs?: number
  /** Answer with this HTTP status and error body instead of streaming. */
  readonly failWith?: FailWith
  /**
   * Answers nothing at all — no status line — until this settles, then the failure or the stream: a
   * request still in flight, whose outcome the test decides (a `wait` step instead holds a stream that
   * has already begun).
   */
  readonly hold?: Promise<unknown>
}

export interface FakeAnthropicOptions {
  /** Text chunks to stream, in order (the reply to every request `replies` does not cover). */
  chunks?: string[]
  /** Delay between chunks in ms. */
  delayMs?: number
  /** Respond with this HTTP status and an error body instead of streaming. */
  failWith?: FailWith
  /** With `failWith`: fail only this many requests, then stream normally. Default: always fail. */
  failTimes?: number
  /** The `stop_reason` of each streamed request, in order; `end_turn` past the end of the list. */
  stopReasons?: readonly string[]
  /**
   * Each `/messages` request's reply by its 0-based index — a list, or a function of the index and
   * the request body. Past the end of a list, the `chunks` reply is sent and `unscripted` counts it.
   */
  replies?: readonly ScriptedReply[] | ((index: number, body: unknown) => ScriptedReply | undefined)
}

export interface RecordedRequest {
  body: unknown
  headers: Record<string, string | string[] | undefined>
}

export interface FakeAnthropic {
  baseURL: string
  requests: RecordedRequest[]
  /** True once a client closed the connection before message_stop was written. */
  aborted: boolean
  chunksSent: number
  /** `/messages` requests past the end of a `replies` list (they got the `chunks` reply). */
  unscripted: number
  /** Connections this server cut on purpose (`{ type: 'cut' }`). */
  cuts: number
  close(): Promise<void>
}

/** A promise and the function that settles it: what a `wait` step holds the stream on. */
export interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

export function deferred(): Deferred {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, resolve: () => resolve() }
}

/** The bodies of the `/messages` requests, as the wire sent them. */
export function messageBodies(fake: FakeAnthropic): Array<{
  messages: Array<{ role: string; content: unknown }>
  tools?: Array<{ name: string }>
}> {
  return fake.requests
    .map((request) => request.body)
    .filter((body): body is { messages: Array<{ role: string; content: unknown }> } => {
      return typeof body === 'object' && body !== null && 'messages' in body
    })
}

function chunksOf(value: string | readonly string[]): readonly string[] {
  return typeof value === 'string' ? [value] : value
}

function failResponse(res: ServerResponse, failure: FailWith): void {
  res.writeHead(failure.status, { 'content-type': 'application/json' })
  const error = {
    type: failure.type,
    message: failure.message,
    ...(failure.details === undefined ? {} : { details: failure.details }),
  }
  res.end(JSON.stringify({ type: 'error', error }))
}

export async function startFakeAnthropic(options: FakeAnthropicOptions): Promise<FakeAnthropic> {
  const delayMs = options.delayMs ?? 30
  const chunks = options.chunks ?? []
  const state: FakeAnthropic = {
    baseURL: '',
    requests: [],
    aborted: false,
    chunksSent: 0,
    unscripted: 0,
    cuts: 0,
    close: async () => {},
  }
  let messageRequests = 0

  /** The reply to the `index`-th `/messages` request, or null for the `chunks` reply. */
  const scripted = (index: number, body: unknown): ScriptedReply | null => {
    const replies = options.replies
    if (replies === undefined) return null
    const reply = typeof replies === 'function' ? replies(index, body) : replies[index]
    if (reply === undefined) {
      state.unscripted += 1
      return null
    }
    return reply
  }

  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      const body: unknown = raw ? JSON.parse(raw) : null
      state.requests.push({ body, headers: req.headers })
      if (req.method !== 'POST' || !req.url?.endsWith('/messages')) {
        res.writeHead(404).end()
        return
      }
      const index = messageRequests
      messageRequests += 1
      const reply = scripted(index, body)
      if (reply !== null) {
        void answer(res, reply)
        return
      }
      const shouldFail =
        options.failWith !== undefined &&
        (options.failTimes === undefined || state.requests.length <= options.failTimes)
      if (options.failWith && shouldFail) {
        failResponse(res, options.failWith)
        return
      }
      void stream(res, [{ type: 'text', text: chunks }], {
        delayMs,
        stopReason: options.stopReasons?.[state.requests.length - 1] ?? 'end_turn',
        outputTokens: chunks.length,
      })
    })
  })

  /** A scripted reply: held first when it says so, then its failure or its stream. */
  async function answer(res: ServerResponse, reply: ScriptedReply): Promise<void> {
    if (reply.hold !== undefined) {
      await reply.hold
      // The client gave up while nothing was answered: an abort that reached the wire.
      if (res.destroyed) {
        state.aborted = true
        return
      }
    }
    if (reply.failWith !== undefined) {
      failResponse(res, reply.failWith)
      return
    }
    await stream(res, reply.steps ?? [], {
      delayMs: reply.delayMs ?? delayMs,
      stopReason:
        reply.stopReason ??
        ((reply.steps ?? []).some((step) => step.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    })
  }

  async function stream(
    res: ServerResponse,
    steps: readonly ScriptedStep[],
    pace: {
      readonly delayMs: number
      readonly stopReason: string
      /** `message_delta`'s output tokens; default: the deltas written. */
      readonly outputTokens?: number
    },
  ): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    let finished = false
    let cut = false
    res.on('close', () => {
      if (!finished && !cut) state.aborted = true
    })
    const event = (name: string, data: unknown): boolean => {
      if (res.destroyed) return false
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      return true
    }
    /** One delta after the pace's delay; false once the client has gone. */
    const delta = async (index: number, payload: Record<string, unknown>): Promise<boolean> => {
      await sleep(pace.delayMs)
      if (res.destroyed) return false
      return event('content_block_delta', { type: 'content_block_delta', index, delta: payload })
    }
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
    let index = 0
    let deltas = 0
    for (const step of steps) {
      switch (step.type) {
        case 'wait':
          // oxlint-disable-next-line no-await-in-loop -- the stream stays open until the test says so
          await step.until
          if (res.destroyed) return
          continue
        case 'cut':
          cut = true
          state.cuts += 1
          res.destroy()
          return
        case 'text': {
          event('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'text', text: '' },
          })
          for (const text of chunksOf(step.text)) {
            // oxlint-disable-next-line no-await-in-loop -- one delta at a time, at the reply's pace
            if (!(await delta(index, { type: 'text_delta', text }))) return
            state.chunksSent += 1
            deltas += 1
          }
          break
        }
        case 'thinking': {
          event('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          })
          for (const thinking of chunksOf(step.thinking)) {
            // oxlint-disable-next-line no-await-in-loop -- one delta at a time, at the reply's pace
            if (!(await delta(index, { type: 'thinking_delta', thinking }))) return
            deltas += 1
          }
          if (
            !event('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'signature_delta', signature: step.signature },
            })
          ) {
            return
          }
          break
        }
        case 'tool_use': {
          event('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: step.id, name: step.name, input: {} },
          })
          // oxlint-disable-next-line no-await-in-loop -- the arguments arrive at the reply's pace
          const sent = await delta(index, {
            type: 'input_json_delta',
            partial_json: JSON.stringify(step.input),
          })
          if (!sent) return
          deltas += 1
          break
        }
      }
      event('content_block_stop', { type: 'content_block_stop', index })
      index += 1
    }
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: pace.stopReason, stop_sequence: null },
      usage: { output_tokens: pace.outputTokens ?? deltas },
    })
    event('message_stop', { type: 'message_stop' })
    finished = true
    res.end()
  }

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
