/** Real kernel WebFetch plus desktop DNS pinning, using only local HTTP servers (step 27). */
import { gzipSync } from 'node:zlib'
import { HostNetworkDeniedError, createMemoryHost, createMemoryTapeStore } from '@tenon-app/kernel'
import type { HostNetwork, ModelInfo, StreamEvent } from '@tenon-app/kernel'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '@tenon-app/kernel/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchAddress } from '../src/main/host/fetch-untrusted.js'
import { createDesktopNetwork } from '../src/main/host/network.js'
import { serveUntrusted } from './support/untrusted-server.js'

const SESSION = '7c4e9a2e-6b3d-4a71-9f52-0c8de7a11b37'
const MODEL: ModelInfo = {
  id: 'fetch-model',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}
const PUBLIC: FetchAddress = { address: '93.184.216.34', family: 4 }
const LOOPBACK: FetchAddress = { address: '127.0.0.1', family: 4 }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- release fixtures sequentially
    await close()
  }
})

async function server(reply?: Parameters<typeof serveUntrusted>[0]) {
  const served = await serveUntrusted(reply)
  cleanup.push(served.close)
  return served
}

function harness(network: HostNetwork) {
  const host = createMemoryHost({ network })
  const tape = createMemoryTapeStore({ identity: host.identity })
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({ connector: { provider, model: MODEL } })
  const service = createTestSessionService(
    {
      host,
      tape,
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
      log: () => {},
    },
    { tools: { WebFetch: 'real' } },
  )
  service.bindLoop(loop)
  return { service, loop, tape, provider }
}
type Harness = ReturnType<typeof harness>
const fetchCall = (url: string): StreamEvent[] => [
  { type: 'tool-call-start', index: 0, id: 'fetch', name: 'WebFetch' },
  {
    type: 'tool-call-end',
    index: 0,
    id: 'fetch',
    name: 'WebFetch',
    input: { url },
  },
  stopEvent('tool-use', 'tool_use'),
]
async function facts(h: Harness, name: string) {
  const entries = (await h.tape.readRange({ sessionId: SESSION, limit: 1000 })).entries
  return entries.filter((entry) => entry.name === name)
}
async function startAndAllow(h: Harness, url: string) {
  h.provider.script(fetchCall(url))
  h.provider.script(scriptedTurn({ deltas: ['Done'] }))
  expect(
    (await h.service.send({ sessionId: SESSION, origin: null, text: 'Fetch the page' })).status,
  ).toBe('started')
  expect((await h.loop.runEnded()).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
  const pending = await h.service.currentPending({ sessionId: SESSION })
  if (pending?.waitKind !== 'approval') throw new Error('Expected a domain approval')
  expect(pending.card.target).toEqual({ type: 'url', url })
  expect(
    await h.service.answer({
      kind: 'approval',
      sessionId: SESSION,
      requestId: pending.card.requestId,
      decision: 'allow',
      origin: null,
    }),
  ).toEqual({ status: 'applied' })
  expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
}

describe('kernel WebFetch cannot turn a public URL into a local request', () => {
  it('returns a public server’s 302-to-loopback without requesting the target', async () => {
    const target = await server()
    const source = await server((_req, res) => {
      res.writeHead(302, { location: `${target.url}/private` })
      res.end()
    })
    const lookup = vi.fn<() => Promise<FetchAddress[]>>(async () => [PUBLIC])
    const h = harness(createDesktopNetwork({ lookup, connectTarget: () => LOOPBACK }))
    await startAndAllow(h, source.publicUrl)
    expect(source.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(0)
    expect(lookup).toHaveBeenCalledTimes(1)
    const result = (await facts(h, 'tool/result'))[0]?.payload
    expect(result?.['isError']).toBe(false)
    expect(JSON.stringify(result)).toContain('302')
    expect(JSON.stringify(result)).toContain(`${target.url}/private`)
  })

  it('denies a newly private DNS answer despite a persisted domain grant, while provider loopback still works', async () => {
    const served = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('public page')
    })
    const lookup = vi.fn<() => Promise<FetchAddress[]>>(async () => [PUBLIC])
    const network = createDesktopNetwork({ lookup, connectTarget: () => LOOPBACK })
    const h = harness(network)
    await startAndAllow(h, served.publicUrl)
    expect(served.requests).toHaveLength(1)
    expect((await facts(h, 'tool/approval_resolved'))[0]?.payload['grant']).toMatchObject({
      scope: 'session',
    })
    lookup.mockResolvedValue([LOOPBACK])
    h.provider.script(fetchCall(served.publicUrl))
    h.provider.script(scriptedTurn({ deltas: ['Blocked'] }))
    await h.service.send({ sessionId: SESSION, origin: null, text: 'Again' })
    expect((await h.loop.runEnded()).reason).toEqual({ code: 'completed' })
    expect(await h.service.currentPending({ sessionId: SESSION })).toBeNull()
    expect(served.requests).toHaveLength(1)
    expect((await facts(h, 'execution/tool_outcome')).at(-1)?.payload).toMatchObject({
      state: 'not-run',
      source: 'protected',
      effect: 'blocked',
      facts: { toolName: 'WebFetch', target: 'fetch.example' },
    })
    expect((await facts(h, 'tool/result')).at(-1)?.payload['isError']).toBe(true)
    await expect(network.fetchUntrusted(served.publicUrl)).rejects.toBeInstanceOf(
      HostNetworkDeniedError,
    )
    expect(await (await network.fetch(served.url)).text()).toBe('public page')
    expect(served.requests).toHaveLength(2)
    expect(lookup).toHaveBeenCalledTimes(3)
  })
})

describe('kernel WebFetch bounds the bytes it reads after decompression', () => {
  it.each(['text/plain', 'text/html'])(
    'stops reading a gzip bomb served as %s just past the limit',
    async (type) => {
      const inflated = 16 * 1024 * 1024
      const bomb = gzipSync(Buffer.alloc(inflated, 0x61), { level: 9 })
      const served = await server((_req, res) => {
        res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip' })
        res.end(bomb)
      })
      const h = harness(
        createDesktopNetwork({ lookup: async () => [PUBLIC], connectTarget: () => LOOPBACK }),
      )
      await startAndAllow(h, served.publicUrl)
      const result = (await facts(h, 'tool/result'))[0]?.payload
      expect(result?.['isError']).toBe(true)
      const received = Number(/\((\d+) bytes received\)/u.exec(JSON.stringify(result))?.[1])
      // Counted after undici gunzips: past the limit, far short of the inflated body.
      expect(received).toBeGreaterThan(bomb.byteLength)
      expect(received).toBeLessThan(inflated / 4)
    },
  )
})
