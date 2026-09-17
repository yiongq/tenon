import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineRoute, invokeRoute, registerRoute } from '../src/route.js'
import type { IpcMainLike } from '../src/route.js'

/** A fake ipcMain/ipcRenderer pair: whatever main registers, the renderer can invoke. */
function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const main: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
  }
  const renderer = {
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const listener = handlers.get(channel)
      if (!listener) throw new Error(`no handler for ${channel}`)
      return listener({ sender: 'renderer' }, ...args)
    },
  }
  return { main, renderer, handlers }
}

const echo = defineRoute('test.echo', {
  request: z.object({ text: z.string().min(1) }),
  response: z.object({ text: z.string() }),
})

describe('registerRoute', () => {
  it('passes a valid request to the handler and returns ok', async () => {
    const { main, renderer } = fakeIpc()
    registerRoute(main, echo, ({ text }) => ({ text: text.toUpperCase() }))
    const result = await invokeRoute(renderer, echo, { text: 'hi' })
    expect(result).toEqual({ ok: true, data: { text: 'HI' } })
  })

  it('returns a structured error for a message that does not match the schema', async () => {
    const { main, renderer, handlers } = fakeIpc()
    let called = false
    registerRoute(main, echo, () => {
      called = true
      return { text: '' }
    })
    // Bypass the typed helper: send garbage exactly as a hostile renderer would.
    const raw = await handlers.get('test.echo')?.({}, { text: 42 })
    expect(raw).toMatchObject({
      ok: false,
      error: { code: 'invalid-request', issues: [{ path: ['text'] }] },
    })
    expect(called).toBe(false)
    const missing = await renderer.invoke('test.echo', undefined)
    expect(missing).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('never throws out of the listener when the handler throws', async () => {
    const { main, handlers } = fakeIpc()
    registerRoute(main, echo, () => {
      throw new Error('boom')
    })
    await expect(handlers.get('test.echo')?.({}, { text: 'x' })).resolves.toEqual({
      ok: false,
      error: { code: 'handler-failed', message: 'boom' },
    })
  })

  it('rejects a handler result that violates the response schema', async () => {
    const { main, renderer } = fakeIpc()
    registerRoute(main, echo, () => ({ text: 7 }) as never)
    const result = await invokeRoute(renderer, echo, { text: 'x' })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-response' } })
  })

  it('renderer side rejects an envelope that is not an IpcResult', async () => {
    const renderer = { invoke: async () => 'not an envelope' }
    const result = await invokeRoute(renderer, echo, { text: 'x' })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-response' } })
  })
})
