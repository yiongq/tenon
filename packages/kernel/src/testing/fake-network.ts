/**
 * fakeNetwork — a HostNetwork that replays recorded exchanges out of web standard APIs
 * only (Response + ReadableStream), so kernel tests run in any realm and never open a
 * socket. It owns no timers: a slow stream is advanced by the caller through a StreamGate,
 * which is what makes "abort at frame N and assert the partial text" deterministic.
 *
 * node:http fake servers stay in apps/desktop/test/support/, for host-level tests.
 */
import { HostNetworkDeniedError } from '../host/adapter.js'
import type { FetchLike, HostNetwork } from '../host/adapter.js'

/** A recorded SSE response. */
export interface SseExchange {
  readonly kind: 'sse'
  /**
   * Wire chunks, replayed verbatim (UTF-8) one chunk per entry — so a recorded frame
   * keeps its own `event:` / `data:` lines and its terminating blank line.
   */
  readonly frames: readonly string[]
  /** Default 200. */
  readonly status?: number
  /** Set over `content-type: text/event-stream`, whatever their casing. */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Holds every frame back until the caller releases it. Without a gate the whole body
   * is enqueued and the stream closed before `fetch` resolves — which also means an
   * abort arriving afterwards has nothing left to interrupt, so abort tests need a gate.
   */
  readonly gate?: StreamGate
}

/** A JSON response — including the error statuses later steps retry on (401, 429). */
export interface JsonExchange {
  readonly kind: 'json'
  readonly body: unknown
  /** Default 200. */
  readonly status?: number
  /** Set over `content-type: application/json`, whatever their casing. */
  readonly headers?: Readonly<Record<string, string>>
}

/** A response whose body is replayed byte for byte, for recorded non-JSON error pages. */
export interface TextExchange {
  readonly kind: 'text'
  readonly body: string
  /** Default 200. */
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
}

/** The host refused the request on egress policy; providers map it to `egress-denied`. */
export interface DeniedExchange {
  readonly kind: 'denied'
  readonly message?: string
}

/** The connection never came up: what a real fetch rejects with is a TypeError. */
export interface ConnectionFailureExchange {
  readonly kind: 'connection-failure'
  readonly message?: string
}

export type FakeExchange =
  | SseExchange
  | JsonExchange
  | TextExchange
  | DeniedExchange
  | ConnectionFailureExchange

export interface RecordedRequest {
  readonly url: string
  readonly method: string
  /** Lowercased header names, as the Headers iterator yields them. */
  readonly headers: Readonly<Record<string, string>>
  /** The body verbatim, or null when the call had none. */
  readonly bodyText: string | null
  /** `bodyText` parsed as JSON, or null when it was absent or not JSON. */
  readonly body: unknown
}

export interface FakeNetwork extends HostNetwork {
  /** Every invocation in order, including ones rejected because the signal was already aborted. */
  readonly requests: readonly RecordedRequest[]
  /** `requests.length` — the "fakeNetwork was never called" assertion. */
  readonly callCount: number
}

/**
 * Releases the frames of one gated response. Nothing here is timed: the test decides
 * when the next frame exists, so aborting after exactly N frames is reproducible.
 */
export interface StreamGate {
  /** Lets `count` more frames (default 1) through to the reader. */
  release(count?: number): void
  /** No more frames are coming: closes the stream, discarding anything still held back. */
  end(): void
  /**
   * The connection dropped mid-body (what a provider maps to a retryable `network`
   * error): errors the body stream with `error`, which a reader tells from an abort by
   * its `name` not being `AbortError`. A no-op before the exchange is served and after
   * the stream has settled.
   */
  fail(error?: unknown): void
  /** Frames never released — still held back, or stranded by an abort / cancel. */
  readonly remaining: number
  /**
   * Frames pushed into the body stream. A release-side counter: a reader that stopped
   * early (abort, cancel) provably never saw the ones still queued behind it.
   */
  readonly released: number
}

export function createStreamGate(): StreamGate {
  return new FrameGate()
}

/** Where a gate pushes frames. Set once the gated exchange is served. */
interface FrameSink {
  push(frame: string): void
  close(): void
  fail(error: unknown): void
}

class FrameGate implements StreamGate {
  #held: string[] = []
  #sink: FrameSink | undefined
  #attached = false
  #credits = 0
  #ended = false
  #released = 0

  attach(sink: FrameSink, frames: readonly string[]): void {
    if (this.#attached) {
      throw new Error('StreamGate: already attached; create one gate per gated exchange')
    }
    this.#attached = true
    this.#sink = sink
    this.#held = [...frames]
    this.#drain()
  }

  /**
   * Called when the stream is gone (aborted, cancelled, failed): dropping the sink makes
   * every further release a no-op. The held frames stay so `remaining` keeps reporting
   * what the reader never got — an abort test asserts on exactly that number.
   */
  detach(): void {
    this.#sink = undefined
  }

  release(count = 1): void {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError('StreamGate.release: count must be a non-negative integer')
    }
    this.#credits += count
    this.#drain()
  }

  end(): void {
    this.#ended = true
    this.#drain()
  }

  fail(error: unknown = new TypeError('fakeNetwork: connection terminated')): void {
    this.#sink?.fail(error)
  }

  get remaining(): number {
    return this.#held.length
  }

  get released(): number {
    return this.#released
  }

  #drain(): void {
    const sink = this.#sink
    if (sink === undefined) return
    while (this.#credits > 0 && this.#held.length > 0) {
      const frame = this.#held.shift()
      if (frame === undefined) break
      this.#credits -= 1
      this.#released += 1
      sink.push(frame)
    }
    if (this.#ended) {
      // end() truncates: whatever is still held was never coming, so it is discarded here
      // rather than left to be reported as stranded.
      this.#held = []
      this.#sink = undefined
      sink.close()
    }
  }
}

/**
 * Replays `script` in call order. Running out of exchanges is an error, not a repeat:
 * a test that fires one request more than it scripted should say so.
 */
export function fakeNetwork(script: FakeExchange | readonly FakeExchange[]): FakeNetwork {
  const exchanges: readonly FakeExchange[] = 'kind' in script ? [script] : script
  const requests: RecordedRequest[] = []
  let cursor = 0

  const fetchImpl: FetchLike = async (input, init) => {
    const signal = init?.signal ?? (isRequestLike(input) ? input.signal : undefined) ?? undefined
    // Record before anything can throw: a call the fake refuses still has to be visible.
    const recording = await recordRequest(input, init)
    requests.push(recording.request)
    if (recording.bodyError !== undefined) throw recording.bodyError
    // Like a real fetch: an already-aborted signal never reaches the wire, so it also
    // does not consume an exchange.
    if (signal?.aborted === true) throw abortReason(signal)
    const exchange = exchanges[cursor]
    if (exchange === undefined) {
      const last = requests.at(-1)
      // Numbered by invocations, not by the script cursor: a pre-aborted call is recorded
      // without consuming an exchange, so only this ordinal matches what `requests` shows.
      throw new Error(
        `fakeNetwork: no exchange scripted for call ${requests.length} (${last?.method} ${last?.url})`,
      )
    }
    cursor += 1
    switch (exchange.kind) {
      case 'denied':
        throw new HostNetworkDeniedError(exchange.message ?? 'egress denied by host policy')
      case 'connection-failure':
        throw new TypeError(exchange.message ?? 'fetch failed')
      case 'json':
        return bodyResponse(JSON.stringify(exchange.body), 'application/json', exchange)
      case 'text':
        return bodyResponse(exchange.body, 'text/plain;charset=utf-8', exchange)
      case 'sse':
        return sseResponse(exchange, signal)
    }
  }

  return {
    fetch: fetchImpl,
    requests,
    get callCount(): number {
      return requests.length
    },
  }
}

function bodyResponse(
  body: string,
  contentType: string,
  exchange: JsonExchange | TextExchange,
): Response {
  return new Response(body, {
    status: exchange.status ?? 200,
    headers: headersOver(contentType, exchange.headers),
  })
}

/**
 * The recorded headers over a default content type. `set()`, not an object spread: the
 * Headers constructor APPENDS, so a fixture carrying wire casing (`Content-Type`,
 * `Retry-After`) would be glued onto the default instead of replacing it.
 */
function headersOver(
  contentType: string,
  recorded: Readonly<Record<string, string>> | undefined,
): Headers {
  const headers = new Headers({ 'content-type': contentType })
  for (const [name, value] of Object.entries(recorded ?? {})) headers.set(name, value)
  return headers
}

function sseResponse(exchange: SseExchange, signal: AbortSignal | undefined): Response {
  const encoder = new TextEncoder()
  const gate = exchange.gate === undefined ? undefined : asFrameGate(exchange.gate)
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let settled = false
  let onAbort: (() => void) | undefined

  const detach = (): void => {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    gate?.detach()
  }

  const sink: FrameSink = {
    push(frame) {
      if (settled) return
      controller?.enqueue(encoder.encode(frame))
    },
    close() {
      if (settled) return
      settled = true
      detach()
      controller?.close()
    },
    fail(error) {
      if (settled) return
      settled = true
      detach()
      // Same exit as an abort, with the caller's reason: a dropped connection mid-body.
      controller?.error(error)
    },
  }

  // start() runs synchronously inside the constructor, so the controller exists below and
  // a bad script (a reused gate) still fails out of fetch() rather than out of the stream.
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      settled = true
      detach()
    },
  })

  onAbort = (): void => {
    if (settled) return
    settled = true
    detach()
    // A real fetch errors the body stream on abort; anything still queued is lost.
    controller?.error(abortReason(signal))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (gate === undefined) {
    for (const frame of exchange.frames) sink.push(frame)
    sink.close()
  } else {
    gate.attach(sink, exchange.frames)
  }

  return new Response(body, {
    status: exchange.status ?? 200,
    headers: headersOver('text/event-stream', exchange.headers),
  })
}

function asFrameGate(gate: StreamGate): FrameGate {
  if (!(gate instanceof FrameGate)) {
    throw new TypeError('fakeNetwork: gate must come from createStreamGate()')
  }
  return gate
}

/** A Request (which carries url / method / headers / body) as opposed to a string or URL. */
function isRequestLike(input: string | URL | Request): input is Request {
  return typeof input !== 'string' && 'method' in input
}

interface Recording {
  readonly request: RecordedRequest
  /** Set when the body would not decode; thrown only after the request is recorded. */
  readonly bodyError: unknown
}

async function recordRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<Recording> {
  const request = isRequestLike(input) ? input : undefined
  const url = isRequestLike(input) ? input.url : typeof input === 'string' ? input : input.href
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? request?.headers)
  let bodyText: string | null = null
  let bodyError: unknown
  try {
    bodyText = await bodyTextOf(init?.body, request)
  } catch (error) {
    bodyError = error
  }
  return {
    request: {
      url,
      method,
      headers: Object.fromEntries(headers.entries()),
      bodyText,
      body: bodyText === null ? null : parseJson(bodyText),
    },
    bodyError,
  }
}

async function bodyTextOf(
  body: RequestInit['body'],
  request: Request | undefined,
): Promise<string | null> {
  if (typeof body === 'string') return body
  // Every typed array and DataView, at its own offset — both SDKs pass such bodies through
  // verbatim.
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (body !== undefined && body !== null) {
    // Blob / FormData / URLSearchParams / ReadableStream: let the platform decode it,
    // which keeps the fake web-standard. `duplex` is required for a stream body.
    const decode: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half' }
    return await new Request('http://fake.invalid/body', decode).text()
  }
  // A Request body is a stream; clone so the caller can still read it.
  if (request !== undefined && request.body !== null) return await request.clone().text()
  return null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** What a real fetch rejects with: the signal's own reason, else a fresh AbortError. */
function abortReason(signal: AbortSignal | undefined): unknown {
  const reason: unknown = signal?.reason
  if (reason !== undefined && reason !== null) return reason
  return new DOMException('The operation was aborted.', 'AbortError')
}
