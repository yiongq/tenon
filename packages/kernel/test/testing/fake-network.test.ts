import { describe, expect, it } from 'vitest'
import { HostNetworkDeniedError } from '../../src/index.js'
import { createStreamGate, fakeNetwork } from '../../src/testing/index.js'

/** Ten recorded SSE frames; each entry is one wire chunk. */
const FRAMES = Array.from({ length: 10 }, (_, i) => `event: delta\ndata: {"i":${i}}\n\n`)

const URL_UNDER_TEST = 'https://api.example.test/v1/messages'

function readerOf(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  const body = response.body
  if (body === null) throw new Error('response had no body')
  return body.getReader()
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is sequential by nature
    const { done, value } = await reader.read()
    if (done) return text
    text += decoder.decode(value, { stream: true })
  }
}

describe('fakeNetwork replay', () => {
  it('replays a recorded SSE body verbatim, in one chunk per frame', async () => {
    const net = fakeNetwork({ kind: 'sse', frames: FRAMES })
    const response = await net.fetch(URL_UNDER_TEST, { method: 'POST', body: '{}' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = readerOf(response)
    const chunks: string[] = []
    const decoder = new TextDecoder()
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is sequential by nature
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value))
    }
    expect(chunks).toEqual(FRAMES)
  })

  it('replays JSON and text bodies with their status and headers', async () => {
    const net = fakeNetwork([
      { kind: 'json', body: { ok: true } },
      {
        kind: 'json',
        body: { error: { type: 'rate_limit_error' } },
        status: 429,
        headers: { 'retry-after': '3', 'retry-after-ms': '1500' },
      },
      { kind: 'text', body: 'upstream down', status: 503 },
    ])
    const ok = await net.fetch(URL_UNDER_TEST)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true })
    const limited = await net.fetch(URL_UNDER_TEST)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('3')
    expect(limited.headers.get('retry-after-ms')).toBe('1500')
    expect(await limited.json()).toEqual({ error: { type: 'rate_limit_error' } })
    const down = await net.fetch(URL_UNDER_TEST)
    expect(down.status).toBe(503)
    expect(await down.text()).toBe('upstream down')
    expect(net.callCount).toBe(3)
  })

  it('lets a recorded header replace the default content type, whatever its casing', async () => {
    const net = fakeNetwork([
      { kind: 'json', body: { ok: true }, headers: { 'Content-Type': 'application/json' } },
      { kind: 'sse', frames: FRAMES, headers: { 'Content-Type': 'text/event-stream; v=1' } },
    ])
    const json = await net.fetch(URL_UNDER_TEST)
    expect(json.headers.get('content-type')).toBe('application/json')
    const sse = await net.fetch(URL_UNDER_TEST)
    expect(sse.headers.get('content-type')).toBe('text/event-stream; v=1')
  })

  it('refuses to invent an exchange the script does not have', async () => {
    const net = fakeNetwork({ kind: 'json', body: {} })
    await net.fetch(URL_UNDER_TEST)
    await expect(net.fetch(URL_UNDER_TEST)).rejects.toThrow(/no exchange scripted for call 2/)
  })

  it('numbers the exhaustion message by invocations, not by the script cursor', async () => {
    const net = fakeNetwork({ kind: 'json', body: {} })
    const aborted = new AbortController()
    aborted.abort()
    // Recorded, but it does not consume the exchange — so call 2 is the one served.
    await expect(net.fetch(URL_UNDER_TEST, { signal: aborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    await net.fetch(URL_UNDER_TEST)
    await expect(net.fetch(URL_UNDER_TEST)).rejects.toThrow(/no exchange scripted for call 3/)
    expect(net.callCount).toBe(3)
  })
})

describe('fakeNetwork request recording', () => {
  it('records url, method, lowercased headers and the parsed body', async () => {
    const net = fakeNetwork({ kind: 'json', body: {} })
    await net.fetch(URL_UNDER_TEST, {
      method: 'post',
      headers: { 'X-Api-Key': 'k-123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: true }),
    })
    expect(net.requests).toEqual([
      {
        url: URL_UNDER_TEST,
        method: 'POST',
        headers: { 'x-api-key': 'k-123', 'content-type': 'application/json' },
        bodyText: '{"model":"m","stream":true}',
        body: { model: 'm', stream: true },
      },
    ])
  })

  it('decodes the body shapes an SDK hands to fetch verbatim', async () => {
    const net = fakeNetwork([
      { kind: 'json', body: {} },
      { kind: 'json', body: {} },
    ])
    const bytes = new TextEncoder().encode('xx{"a":1}')
    await net.fetch(URL_UNDER_TEST, {
      method: 'POST',
      // A view at an offset: decoded from its own window, not the whole buffer.
      body: new DataView(bytes.buffer, 2, bytes.byteLength - 2),
    })
    await net.fetch(URL_UNDER_TEST, { method: 'POST', body: new URLSearchParams({ a: '1' }) })
    expect(net.requests[0]).toMatchObject({ bodyText: '{"a":1}', body: { a: 1 } })
    expect(net.requests[1]).toMatchObject({ bodyText: 'a=1', body: null })
  })

  it('records the call even when the body cannot be read', async () => {
    const net = fakeNetwork({ kind: 'json', body: {} })
    const locked = new ReadableStream<Uint8Array>()
    locked.getReader()
    await expect(
      net.fetch(URL_UNDER_TEST, { method: 'POST', body: locked }),
    ).rejects.toBeInstanceOf(TypeError)
    expect(net.requests).toMatchObject([{ method: 'POST', bodyText: null }])
  })

  it('accepts the other two fetch input shapes', async () => {
    const net = fakeNetwork([
      { kind: 'json', body: {} },
      { kind: 'json', body: {} },
    ])
    await net.fetch(new URL(URL_UNDER_TEST))
    await net.fetch(new Request(URL_UNDER_TEST, { method: 'PUT', body: 'not json' }))
    expect(net.requests[0]).toMatchObject({ url: URL_UNDER_TEST, method: 'GET', bodyText: null })
    expect(net.requests[1]).toMatchObject({
      url: URL_UNDER_TEST,
      method: 'PUT',
      bodyText: 'not json',
      body: null,
    })
  })
})

describe('fakeNetwork stepping', () => {
  it('hands out exactly the frames the caller released, then closes on end()', async () => {
    const gate = createStreamGate()
    const net = fakeNetwork({ kind: 'sse', frames: FRAMES, gate })
    const reader = readerOf(await net.fetch(URL_UNDER_TEST))
    gate.release(2)
    expect(gate.released).toBe(2)
    expect(gate.remaining).toBe(8)
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader.read()).value)).toBe(FRAMES[0])
    expect(decoder.decode((await reader.read()).value)).toBe(FRAMES[1])
    gate.release(FRAMES.length)
    gate.end()
    expect(gate.remaining).toBe(0)
    expect(await drain(reader)).toBe(FRAMES.slice(2).join(''))
  })

  it('discards frames still held back when end() truncates the stream', async () => {
    const gate = createStreamGate()
    const net = fakeNetwork({ kind: 'sse', frames: FRAMES, gate })
    const reader = readerOf(await net.fetch(URL_UNDER_TEST))
    gate.release(1)
    gate.end()
    expect(await drain(reader)).toBe(FRAMES[0])
    expect(gate.released).toBe(1)
  })

  it('serves one response per gate', async () => {
    const gate = createStreamGate()
    const net = fakeNetwork([
      { kind: 'sse', frames: FRAMES, gate },
      { kind: 'sse', frames: FRAMES, gate },
    ])
    readerOf(await net.fetch(URL_UNDER_TEST))
    await expect(net.fetch(URL_UNDER_TEST)).rejects.toThrow(/already attached/)
  })
})

describe('fakeNetwork abort', () => {
  it('rejects without consuming an exchange when the signal is already aborted', async () => {
    const net = fakeNetwork({ kind: 'sse', frames: FRAMES })
    const controller = new AbortController()
    controller.abort()
    await expect(
      net.fetch(URL_UNDER_TEST, { method: 'POST', body: '{}', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    // The call is still recorded — that is how "fetch was never invoked" stays testable —
    // but the script did not advance.
    expect(net.callCount).toBe(1)
    expect(await drain(readerOf(await net.fetch(URL_UNDER_TEST)))).toBe(FRAMES.join(''))
  })

  it('errors the body stream mid-flight, keeping exactly the text that arrived', async () => {
    for (let released = 0; released <= FRAMES.length; released += 1) {
      const gate = createStreamGate()
      const net = fakeNetwork({ kind: 'sse', frames: FRAMES, gate })
      const controller = new AbortController()
      // oxlint-disable-next-line no-await-in-loop -- one independent stream per abort point
      const reader = readerOf(await net.fetch(URL_UNDER_TEST, { signal: controller.signal }))
      const decoder = new TextDecoder()
      let text = ''
      for (let i = 0; i < released; i += 1) {
        gate.release()
        // oxlint-disable-next-line no-await-in-loop -- a stream is sequential by nature
        const chunk = await reader.read()
        text += decoder.decode(chunk.value, { stream: true })
      }
      controller.abort()
      // oxlint-disable-next-line no-await-in-loop -- assertions belong to this iteration
      await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
      expect(text).toBe(FRAMES.slice(0, released).join(''))
    }
  })

  it('drops frames that were queued but not yet read, like a real fetch', async () => {
    const gate = createStreamGate()
    const net = fakeNetwork({ kind: 'sse', frames: FRAMES, gate })
    const controller = new AbortController()
    const reader = readerOf(await net.fetch(URL_UNDER_TEST, { signal: controller.signal }))
    gate.release(4)
    controller.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps reporting the frames stranded by the abort', async () => {
    const gate = createStreamGate()
    const net = fakeNetwork({ kind: 'sse', frames: FRAMES, gate })
    const controller = new AbortController()
    const reader = readerOf(await net.fetch(URL_UNDER_TEST, { signal: controller.signal }))
    gate.release(4)
    await reader.read()
    controller.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    expect(gate.remaining).toBe(FRAMES.length - 4)
    expect(gate.released).toBe(4)
    // The stream is gone: releasing more moves nothing.
    gate.release(FRAMES.length)
    expect(gate.remaining).toBe(FRAMES.length - 4)
    expect(gate.released).toBe(4)
  })
})

describe('fakeNetwork mid-stream failure', () => {
  it('errors the body with a connection failure the reader tells from an abort', async () => {
    const gate = createStreamGate()
    const net = fakeNetwork({ kind: 'sse', frames: FRAMES, gate })
    const reader = readerOf(await net.fetch(URL_UNDER_TEST))
    gate.release(2)
    const decoder = new TextDecoder()
    let text = decoder.decode((await reader.read()).value, { stream: true })
    text += decoder.decode((await reader.read()).value, { stream: true })
    gate.fail()
    const rejection = reader.read()
    await expect(rejection).rejects.toBeInstanceOf(TypeError)
    await expect(rejection).rejects.not.toMatchObject({ name: 'AbortError' })
    expect(text).toBe(FRAMES.slice(0, 2).join(''))
    expect(gate.remaining).toBe(FRAMES.length - 2)
  })

  it('takes the reason it was given and is a no-op once the stream settled', async () => {
    const gate = createStreamGate()
    const net = fakeNetwork({ kind: 'sse', frames: FRAMES, gate })
    const reader = readerOf(await net.fetch(URL_UNDER_TEST))
    gate.release(FRAMES.length)
    gate.end()
    expect(await drain(reader)).toBe(FRAMES.join(''))
    gate.fail(new Error('too late'))
    const second = createStreamGate()
    const other = fakeNetwork({ kind: 'sse', frames: FRAMES, gate: second })
    const otherReader = readerOf(await other.fetch(URL_UNDER_TEST))
    second.fail(new Error('upstream reset'))
    await expect(otherReader.read()).rejects.toThrow('upstream reset')
  })
})

describe('fakeNetwork failures', () => {
  it('rejects with HostNetworkDeniedError when the host refuses egress', async () => {
    const net = fakeNetwork({ kind: 'denied' })
    await expect(net.fetch(URL_UNDER_TEST)).rejects.toBeInstanceOf(HostNetworkDeniedError)
  })

  it('rejects with a TypeError when the connection never came up', async () => {
    const net = fakeNetwork({ kind: 'connection-failure' })
    const rejection = net.fetch(URL_UNDER_TEST)
    await expect(rejection).rejects.toBeInstanceOf(TypeError)
    await expect(rejection).rejects.not.toBeInstanceOf(HostNetworkDeniedError)
  })
})

describe('fakeNetwork options (spec 02, 01 修补 4)', () => {
  it('keeps the one-argument form exactly as it was', async () => {
    const net = fakeNetwork([
      { kind: 'json', body: { n: 1 } },
      { kind: 'json', body: { n: 2 } },
    ])
    await net.fetch(URL_UNDER_TEST, { method: 'POST', body: '{"a":1}' })
    expect(await (await net.fetch(URL_UNDER_TEST)).json()).toEqual({ n: 2 })
    await expect(net.fetch(URL_UNDER_TEST)).rejects.toThrow(/no exchange scripted for call 3/)
    expect(net.callCount).toBe(3)
    expect(net.requests).toHaveLength(3)
    expect(net.requests[0]).toMatchObject({ method: 'POST', body: { a: 1 } })
    expect(net.checkFailures).toEqual([])
    expect(net.untrustedRequests).toEqual([])
  })

  it('runs checkRequest on every fetch before playback and records what it throws', async () => {
    const seen: string[] = []
    const refusal = new Error('first body is wrong')
    const net = fakeNetwork(
      [
        { kind: 'json', body: { error: { type: 'overloaded_error' } }, status: 529 },
        { kind: 'json', body: { ok: true } },
      ],
      {
        checkRequest: (request) => {
          seen.push(request.bodyText ?? '')
          if (request.body !== null && (request.body as { n?: number }).n === 1) throw refusal
        },
      },
    )
    // A failing check does not fail the fetch: the scripted response still arrives, and the
    // retry a provider would send next is checked (and served) just the same.
    const first = await net.fetch(URL_UNDER_TEST, { method: 'POST', body: '{"n":1}' })
    expect(first.status).toBe(529)
    const retry = await net.fetch(URL_UNDER_TEST, { method: 'POST', body: '{"n":2}' })
    expect(await retry.json()).toEqual({ ok: true })
    expect(seen).toEqual(['{"n":1}', '{"n":2}'])
    expect(net.checkFailures).toEqual([refusal])
    expect(net.callCount).toBe(2)
  })

  it('checks calls that never reach playback too, one failure per call', async () => {
    let checks = 0
    const net = fakeNetwork([], {
      checkRequest: () => {
        checks += 1
        throw new Error(`check ${checks}`)
      },
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(net.fetch(URL_UNDER_TEST, { signal: aborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    await expect(net.fetch(URL_UNDER_TEST)).rejects.toThrow(/no exchange scripted for call 2/)
    expect(checks).toBe(2)
    expect(net.checkFailures.map((error) => (error as Error).message)).toEqual([
      'check 1',
      'check 2',
    ])
  })

  it('replays the untrusted script with its own cursor and request log', async () => {
    let checks = 0
    const net = fakeNetwork(
      { kind: 'json', body: { from: 'fetch' } },
      {
        checkRequest: () => {
          checks += 1
        },
        untrusted: [
          { kind: 'text', body: '<html>page one</html>', status: 200 },
          { kind: 'denied', message: 'resolves to a private address' },
        ],
      },
    )
    const page = await net.fetchUntrusted('https://example.test/one')
    expect(await page.text()).toBe('<html>page one</html>')
    // The fetch script did not move: its first exchange is still the one served here.
    expect(await (await net.fetch(URL_UNDER_TEST)).json()).toEqual({ from: 'fetch' })
    await expect(net.fetchUntrusted('http://10.0.0.1/')).rejects.toBeInstanceOf(
      HostNetworkDeniedError,
    )
    await expect(net.fetchUntrusted('https://example.test/three')).rejects.toThrow(
      /no exchange scripted for untrusted call 3/,
    )
    expect(net.untrustedRequests.map((request) => request.url)).toEqual([
      'https://example.test/one',
      'http://10.0.0.1/',
      'https://example.test/three',
    ])
    expect(net.requests.map((request) => request.url)).toEqual([URL_UNDER_TEST])
    expect(net.callCount).toBe(1)
    // checkRequest is fetch's alone.
    expect(checks).toBe(1)
  })

  it('makes fetchUntrusted reject every call when no untrusted script was given', async () => {
    const net = fakeNetwork({ kind: 'json', body: {} }, { checkRequest: () => undefined })
    await expect(net.fetchUntrusted('https://example.test/')).rejects.toThrow(
      /fetchUntrusted has no script/,
    )
    await expect(fakeNetwork([]).fetchUntrusted('https://example.test/')).rejects.toThrow(
      /fetchUntrusted has no script/,
    )
    // Recorded all the same, and fetch's own script is untouched.
    expect(net.untrustedRequests).toMatchObject([{ url: 'https://example.test/', method: 'GET' }])
    expect(net.callCount).toBe(0)
    expect(await (await net.fetch(URL_UNDER_TEST)).json()).toEqual({})
  })
})
