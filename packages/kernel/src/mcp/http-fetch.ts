import type { FetchLike } from '../host/adapter.js'

export interface McpStreamBreak {
  readonly id: string | number
  readonly method: string
}
/** Transport-managed headers win; credentials are never sent to another origin. */
export function wrapMcpFetch(
  fetch: FetchLike,
  q: {
    readonly serverUrl: string
    readonly staticHeaders?: Readonly<Record<string, string>>
    readonly onStreamBreak?: (request: McpStreamBreak) => void
  },
): FetchLike {
  const origin = new URL(q.serverUrl).origin
  return async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).origin === origin) {
      for (const [name, value] of Object.entries(q.staticHeaders ?? {})) {
        if (!request.headers.has(name)) request.headers.set(name, value)
      }
    }
    let rpc: McpStreamBreak | null = null
    if (request.method === 'POST') {
      try {
        const body = (await request.clone().json()) as Record<string, unknown>
        if (
          (typeof body['id'] === 'number' || typeof body['id'] === 'string') &&
          typeof body['method'] === 'string'
        )
          rpc = { id: body['id'], method: body['method'] }
      } catch {
        /* a notification or a non-RPC auth request */
      }
    }
    const response = await fetch(request)
    if (!rpc || !response.ok || !response.body || !q.onStreamBreak) return response
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const sse = response.headers.get('content-type')?.includes('text/event-stream') === true
    let buffered = ''
    let answered = false
    let resumable = false
    let cancelled = false
    const observe = (data: string) => {
      try {
        const result = JSON.parse(data) as Record<string, unknown>
        if (result['id'] === rpc.id && ('result' in result || 'error' in result)) answered = true
      } catch {
        /* partial event */
      }
    }
    const broken = () => {
      if (!cancelled && !request.signal.aborted && !answered && !resumable) q.onStreamBreak?.(rpc)
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await reader.read()
          if (part.done) {
            buffered += decoder.decode()
            if (!sse) observe(buffered)
            broken()
            controller.close()
            return
          }
          buffered += decoder.decode(part.value, { stream: true })
          if (sse) {
            buffered = buffered.replaceAll('\r\n', '\n')
            let end = buffered.indexOf('\n\n')
            while (end >= 0) {
              const event = buffered.slice(0, end)
              if (/^id:\s*\S/m.test(event)) resumable = true
              observe(
                event
                  .split('\n')
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trimStart())
                  .join('\n'),
              )
              buffered = buffered.slice(end + 2)
              end = buffered.indexOf('\n\n')
            }
          }
          controller.enqueue(part.value)
        } catch (error) {
          broken()
          controller.error(error)
        }
      },
      async cancel(reason) {
        cancelled = true
        await reader.cancel(reason)
      },
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
