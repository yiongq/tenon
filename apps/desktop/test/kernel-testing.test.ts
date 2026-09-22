/**
 * The `./testing` subpath has to resolve from an app, not just from inside the kernel:
 * at runtime through the `development` condition vitest/electron-vite apply, and at type
 * level through dist/testing/index.d.ts. Later steps drive desktop tests off fakeNetwork,
 * so this is the guard that the subpath keeps working.
 */
import { fakeNetwork } from '@tenon-app/kernel/testing'
import { describe, expect, it } from 'vitest'
import { createDesktopNetwork } from '../src/main/host/network.js'

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

describe('createDesktopNetwork', () => {
  it('is one hop onto the platform fetch', async () => {
    const real = globalThis.fetch
    const seen: { input: unknown; init: unknown }[] = []
    const answer = new Response('ok')
    const stub: typeof globalThis.fetch = (input, init) => {
      seen.push({ input, init })
      return Promise.resolve(answer)
    }
    globalThis.fetch = stub
    try {
      // Identity, not shape: rewriting the url, dropping init or adding a `?? fallback`
      // all have to make this red — that fallback is what the 01 spec forbids.
      const init = { method: 'POST', body: '{"a":1}' }
      const result = await createDesktopNetwork().fetch('https://api.example.test/v1', init)
      expect(result).toBe(answer)
      expect(seen).toHaveLength(1)
      expect(seen[0]?.input).toBe('https://api.example.test/v1')
      expect(seen[0]?.init).toBe(init)
    } finally {
      globalThis.fetch = real
    }
  })
})
