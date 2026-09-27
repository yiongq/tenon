/**
 * The `./testing` subpath has to resolve from an app, not just from inside the kernel:
 * at runtime through the `development` condition vitest/electron-vite apply, and at type
 * level through dist/testing/index.d.ts. Later steps drive desktop tests off fakeNetwork,
 * so this is the guard that the subpath keeps working.
 */
import { fakeNetwork } from '@tenon-app/kernel/testing'
import { describe, expect, it, vi } from 'vitest'
import { createDesktopNetwork } from '../src/main/host/network.js'

/** What the desktop egress asked of undici; test/network.test.ts drives the real one. */
const undici = vi.hoisted(() => ({
  agents: [] as { readonly options: unknown }[],
  calls: [] as { readonly input: unknown; readonly init: unknown }[],
  answer: new Response('ok'),
}))
vi.mock('undici', () => ({
  Agent: class {
    readonly options: unknown
    constructor(options: unknown) {
      this.options = options
      undici.agents.push(this)
    }
  },
  fetch: (input: unknown, init: unknown) => {
    undici.calls.push({ input, init })
    return Promise.resolve(undici.answer)
  },
}))

describe('@tenon-app/kernel/testing from the desktop app', () => {
  it('resolves and replays a scripted exchange', async () => {
    const net = fakeNetwork({ kind: 'json', body: { ok: true }, status: 201 })
    const response = await net.fetch('https://api.example.test/v1', {
      method: 'POST',
      body: '{"a":1}',
    })
    expect(response.status).toBe(201)
    expect(net.requests).toMatchObject([{ method: 'POST', body: { a: 1 } }])
  })
})

/** Stands in for the platform fetch: the desktop egress must never fall back to it. */
const platformFetch: typeof globalThis.fetch = () =>
  Promise.reject(new Error('the platform fetch was reached'))

describe('createDesktopNetwork', () => {
  it("is one hop onto undici's fetch, with undici's own time limits off", async () => {
    const real = globalThis.fetch
    globalThis.fetch = platformFetch
    try {
      const network = createDesktopNetwork()
      // 01 修补 9 (w), owner 2026-09-27: both undici limits off; only the kernel's limits cut.
      expect(undici.agents.map((agent) => agent.options)).toEqual([
        { headersTimeout: 0, bodyTimeout: 0 },
      ])
      // Identity, not shape: rewriting the url, dropping a field of init or adding a
      // `?? fallback` all have to make this red — that fallback is what the 01 spec forbids.
      const signal = new AbortController().signal
      const init = { method: 'POST', body: '{"a":1}', signal, redirect: 'manual' as const }
      const result = await network.fetch('https://api.example.test/v1', init)
      expect(result).toBe(undici.answer)
      expect(undici.calls).toHaveLength(1)
      const [call] = undici.calls
      expect(call?.input).toBe('https://api.example.test/v1')
      const sent = call?.init as Record<string, unknown>
      expect(Object.keys(sent).toSorted()).toEqual([...Object.keys(init), 'dispatcher'].toSorted())
      for (const [key, value] of Object.entries(init)) expect(sent[key]).toBe(value)
      expect(sent['dispatcher']).toBe(undici.agents[0])
    } finally {
      globalThis.fetch = real
    }
  })
})
