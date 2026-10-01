import { afterEach, expect, it, vi } from 'vitest'
import type { HostNetwork } from '@tenon-app/kernel'
import {
  officialProtocolTestNetwork,
  OFFICIAL_PROTOCOL_ENV,
} from '../src/main/host/official-protocol-test-seam.js'
import { acceptedWithoutTransformations } from '../e2e/helpers/official-protocol.js'

const url = 'https://api.anthropic.com/v1/messages'
function fixture(
  text = 'data: {"type":"message_start","message":{"input_transformations":[]}}\n\ndata: {"type":"ping"}\n\n',
) {
  const fetch = vi.fn<HostNetwork['fetch']>(async () => new Response(text))
  return { fetch, fetchUntrusted: vi.fn<HostNetwork['fetch']>() }
}
const request = { method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-5', stream: true }) }
afterEach(() => {
  globalThis.tenonOfficialProtocolRecords = undefined
})

it('packaged never reads the environment, and ordinary development returns the original network', () => {
  const network = fixture()
  const env = Object.defineProperty({}, OFFICIAL_PROTOCOL_ENV, {
    get() {
      throw new Error('Forbidden packaged environment read')
    },
  })
  expect(officialProtocolTestNetwork(network, true, env)).toBe(network)
  expect(officialProtocolTestNetwork(network, false, {})).toBe(network)
})

it.each([
  ['https://relay.test/v1/messages', true],
  ['http://api.anthropic.com/v1/messages', true],
  ['https://api.anthropic.com:444/v1/messages', true],
  ['https://api.anthropic.com/v1/other', true],
])('leaves non-main official requests untouched: %s stream=%s', async (target, stream) => {
  const network = fixture()
  const wrapped = officialProtocolTestNetwork(network, false, { [OFFICIAL_PROTOCOL_ENV]: 'strict' })
  const init = { ...request, body: JSON.stringify({ stream }) }
  await wrapped.fetch(target, init)
  expect(network.fetch).toHaveBeenCalledWith(target, init)
  expect(globalThis.tenonOfficialProtocolRecords).toEqual([])
  expect(wrapped.fetchUntrusted).toBe(network.fetchUntrusted)
})

it('records actual empty transformations and pings while preserving response bytes and excluding credentials', async () => {
  const text =
    'data: {"type":"message_start","message":{"input_transformations":[]}}\r\n\r\ndata: {"type":"ping"}\r\n\r\ndata: {"type":"message_stop"}\r\n\r\n'
  const network = fixture(text)
  const wrapped = officialProtocolTestNetwork(network, false, { [OFFICIAL_PROTOCOL_ENV]: 'strict' })
  const response = await wrapped.fetch(url, {
    ...request,
    headers: { 'x-api-key': 'SENSITIVE_SENTINEL' },
  })
  expect(await response.text()).toBe(text)
  const sent = network.fetch.mock.calls[0]?.[1]
  expect(sent?.redirect).toBe('error')
  expect(new Headers(sent?.headers).get('anthropic-beta')).toBe(
    'thinking-binding-controls-2026-08-01',
  )
  expect(JSON.parse(String(sent?.body)).thinking).toEqual({
    type: 'adaptive',
    block_binding: { prefix_mismatch_behavior: 'error' },
  })
  const record = globalThis.tenonOfficialProtocolRecords?.[0]
  expect(record?.requestBody).toEqual(JSON.parse(String(sent?.body)))
  expect(record?.transformations).toEqual([[]])
  expect(record?.pingAtMs).toHaveLength(1)
  expect(record !== undefined && acceptedWithoutTransformations(record)).toBe(true)
  expect(JSON.stringify(record)).not.toContain('SENSITIVE_SENTINEL')
  expect(JSON.stringify(record)).not.toContain('x-api-key')
})

it('record-only preserves omitted thinking and does not count a missing response field as acceptance', async () => {
  const network = fixture(
    'data: {"type":"message_start","message":{}}\n\ndata: {"type":"message_stop"}\n\n',
  )
  const wrapped = officialProtocolTestNetwork(network, false, { [OFFICIAL_PROTOCOL_ENV]: 'record' })
  await (await wrapped.fetch(url, request)).text()
  const sent = network.fetch.mock.calls[0]?.[1]
  expect(sent?.redirect).toBe('error')
  expect(new Headers(sent?.headers).has('anthropic-beta')).toBe(false)
  expect(JSON.parse(String(sent?.body)).thinking).toBeUndefined()
  const record = globalThis.tenonOfficialProtocolRecords?.[0]
  expect(record?.complete).toBe(true)
  expect(record !== undefined && acceptedWithoutTransformations(record)).toBe(false)
})

it('handles split SSE frames and propagates cancellation to the original stream', async () => {
  const cancel = vi.fn<() => void>()
  const encoder = new TextEncoder()
  const fetch = vi.fn<HostNetwork['fetch']>(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"type":"message_start","message":{"input_trans'),
            )
            controller.enqueue(encoder.encode('formations":[]}}\n\n'))
          },
          cancel,
        }),
      ),
  )
  const wrapped = officialProtocolTestNetwork({ fetch, fetchUntrusted: fetch }, false, {
    [OFFICIAL_PROTOCOL_ENV]: 'strict',
  })
  const reader = (await wrapped.fetch(url, request)).body!.getReader()
  await reader.read()
  await reader.read()
  await reader.cancel()
  await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
  expect(globalThis.tenonOfficialProtocolRecords?.[0]?.transformations).toEqual([[]])
  expect(globalThis.tenonOfficialProtocolRecords?.[0]?.complete).toBe(false)
  const record = globalThis.tenonOfficialProtocolRecords?.[0]
  expect(record !== undefined && acceptedWithoutTransformations(record)).toBe(false)
})

it.each(['strict', 'record'])(
  'refuses search redirects in %s mode without changing its protocol',
  async (mode) => {
    const network = fixture('{"content":[]}')
    const wrapped = officialProtocolTestNetwork(network, false, { [OFFICIAL_PROTOCOL_ENV]: mode })
    const init: RequestInit = {
      method: 'POST',
      redirect: 'follow',
      headers: { 'x-api-key': 'SEARCH_KEY_SENTINEL' },
      body: JSON.stringify({
        stream: false,
        thinking: { type: 'disabled' },
        tools: [{ type: 'web_search' }],
      }),
    }
    await wrapped.fetch(url, init)
    expect(network.fetch).toHaveBeenCalledWith(url, { ...init, redirect: 'error' })
    expect(globalThis.tenonOfficialProtocolRecords).toEqual([])
  },
)

it('refuses redirects for an official Request without consuming or instrumenting its body', async () => {
  const network = fixture()
  const wrapped = officialProtocolTestNetwork(network, false, { [OFFICIAL_PROTOCOL_ENV]: 'strict' })
  const input = new Request(url, { method: 'POST', body: '{"stream":false}', redirect: 'follow' })
  await wrapped.fetch(input)
  expect(network.fetch).toHaveBeenCalledWith(input, { redirect: 'error' })
  expect(input.bodyUsed).toBe(false)
  expect(globalThis.tenonOfficialProtocolRecords).toEqual([])
})
