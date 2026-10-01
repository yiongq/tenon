/** Spec 02 step 33: development-only wire instrumentation, never a Tape request snapshot. */
import type { FetchLike, HostNetwork } from '@tenon-app/kernel'

export const OFFICIAL_PROTOCOL_ENV = 'TENON_TEST_OFFICIAL_PROTOCOL'
export interface OfficialProtocolRecord {
  mode: 'strict' | 'record'
  model: unknown
  thinking: unknown
  requestBody: Record<string, unknown>
  status: number | null
  /** Actual response fields, including missing versus an explicit empty array. */
  transformations: unknown[]
  pingAtMs: number[]
  complete: boolean
}

declare global {
  var tenonOfficialProtocolRecords: OfficialProtocolRecord[] | undefined
}

/** No environment properties are accessed in a packaged process. */
export function officialProtocolTestNetwork(
  network: HostNetwork,
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
): HostNetwork {
  if (isPackaged) return network
  const mode = env[OFFICIAL_PROTOCOL_ENV]
  if (mode !== 'strict' && mode !== 'record') return network
  const records = (globalThis.tenonOfficialProtocolRecords ??= [])
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== 'https://api.anthropic.com' || url.pathname !== '/v1/messages')
      return network.fetch(input, init)
    // The official key must stay on the initial host, including non-streaming search requests.
    // This changes only the opted-in test transport; search bodies and headers stay untouched.
    init = { ...init, redirect: 'error' }
    // Provider transport supplies serialized JSON. Do not consume an arbitrary Request body.
    if (typeof init?.body !== 'string' || (init.method ?? 'GET').toUpperCase() !== 'POST')
      return network.fetch(input, init)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(init.body) as Record<string, unknown>
    } catch {
      return network.fetch(input, init)
    }
    if (body === null || typeof body !== 'object' || body['stream'] !== true)
      return network.fetch(input, init)
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    if (mode === 'strict') {
      headers.set('anthropic-beta', 'thinking-binding-controls-2026-08-01')
      body = {
        ...body,
        thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } },
      }
    }
    const record: OfficialProtocolRecord = {
      mode,
      model: body['model'],
      thinking: body['thinking'] ?? null,
      requestBody: body,
      status: null,
      transformations: [],
      pingAtMs: [],
      complete: false,
    }
    records.push(record)
    const response = await network.fetch(input, { ...init, headers, body: JSON.stringify(body) })
    record.status = response.status
    if (response.body === null) return response
    const decoder = new TextDecoder()
    let pending = ''
    const observe = (text: string) => {
      pending += text
      for (;;) {
        const match = /\r?\n\r?\n/.exec(pending)
        if (match === null) break
        const frame = pending.slice(0, match.index)
        pending = pending.slice(match.index + match[0].length)
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        try {
          const event = JSON.parse(data) as Record<string, unknown>
          if (event['type'] === 'ping') record.pingAtMs.push(performance.now())
          if (event['type'] === 'message_stop') record.complete = true
          for (const value of [event, event['message'], event['delta']]) {
            if (value !== null && typeof value === 'object' && 'input_transformations' in value)
              record.transformations.push(value.input_transformations)
          }
        } catch {
          /* Non-JSON SSE frames do not contribute protocol evidence. */
        }
      }
    }
    // Inline observation preserves backpressure and cancellation; no tee or second draining reader.
    const stream = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          observe(decoder.decode(chunk, { stream: true }))
          controller.enqueue(chunk)
        },
        flush() {
          observe(decoder.decode())
        },
      }),
    )
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  return { ...network, fetch }
}
