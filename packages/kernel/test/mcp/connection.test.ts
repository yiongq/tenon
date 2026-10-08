import { Client } from '@modelcontextprotocol/client'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import { afterEach, expect, it, vi } from 'vitest'
import { absolutePath, connectStdioServer, createMemoryHost } from '../../src/index.js'
import type { ChildHandle, McpConnection } from '../../src/index.js'
import { ChildStdioTransport } from '../../src/mcp/stdio-transport.js'
import { mcpClientOptions } from '../../src/mcp/client.js'
import { createNodeProcess } from '../support/node-process.js'

const connections: McpConnection[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(connections.splice(0).map((c) => c.close()))
})
async function connect(mode = 'dual', logs: string[] = []) {
  const c = await connectStdioServer(createMemoryHost({ process: createNodeProcess() }), {
    name: 'fixture',
    spawn: {
      argv: [
        process.execPath,
        new URL('../support/fixtures/modern-server.mjs', import.meta.url).pathname,
        mode,
      ],
      cwd: absolutePath('/'),
      env: {},
      stdio: 'pipe',
    },
    sandbox: { profile: 'full-access', workspace: [] },
    transport: { onStderr: (line) => logs.push(line) },
    handshakeTimeoutMs: 1000,
    log: (line) => logs.push(line),
  })
  connections.push(c)
  return c
}
it('03 验收 33: the client validates structured output with CfWorker and declares no capabilities', () => {
  const options = mcpClientOptions()
  expect(options.jsonSchemaValidator).toBeInstanceOf(CfWorkerJsonSchemaValidator)
  expect(options.listMaxPages).toBe(64)
  expect(options).not.toHaveProperty('capabilities')
  expect(options.versionNegotiation).toEqual({ mode: 'legacy' })
})
it('03 验收 2 (connection): a silent server uses the 120 s handshake timeout, not the SDK 60 s, without cancelled', async () => {
  const frames: unknown[] = []
  let end!: () => void
  const exited = new Promise<{ code: number; signal: null }>((resolve) => {
    end = () => resolve({ code: 0, signal: null })
  })
  let stdout!: ReadableStreamDefaultController<Uint8Array>
  let stderr!: ReadableStreamDefaultController<Uint8Array>
  const child: ChildHandle = {
    pid: 1,
    exited,
    stdout: new ReadableStream({
      start(c) {
        stdout = c
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        stderr = c
      },
    }),
    stdin: new WritableStream({
      write(b) {
        frames.push(JSON.parse(new TextDecoder().decode(b)))
      },
      close() {
        stdout.close()
        stderr.close()
        end()
      },
    }),
    kill: async () => {
      end()
    },
  }
  const host = createMemoryHost({ process: { spawn: async () => child } })
  const spy = vi.spyOn(Client.prototype, 'connect')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let finished = false
  const pending = connectStdioServer(host, {
    name: 'silent',
    spawn: { argv: ['/bin/node'], cwd: absolutePath('/'), env: {}, stdio: 'pipe' },
    sandbox: { profile: 'full-access', workspace: [] },
    handshakeTimeoutMs: 120_000,
  }).catch((e) => {
    finished = true
    return e as Error
  })
  await vi.advanceTimersByTimeAsync(61_000)
  expect(spy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timeout: 120_000 }))
  expect(finished).toBe(false)
  await vi.advanceTimersByTimeAsync(59_000)
  expect(await pending).toMatchObject({ message: expect.stringMatching(/timed out/i) })
  expect(JSON.stringify(frames)).not.toContain('notifications/cancelled')
})
it('03 验收 13: stdio stays legacy and a modern-only stdio server is modern-only', async () => {
  expect((await connect()).era).toBe('legacy')
  await expect(connect('modern-only')).rejects.toMatchObject({ code: 'modern-only' })
})
it('03 验收 30 / 03 不变量 17: stopping a stdio call sends notifications/cancelled', async () => {
  const logs: string[] = []
  const c = await connect('dual', logs)
  const stop = new AbortController()
  const pending = c.callTool('slow', { ms: 1000 }, { signal: stop.signal })
  const rejection = pending.catch((error: Error) => error)
  await new Promise((resolve) => setTimeout(resolve, 120))
  stop.abort(new Error('stop'))
  expect(await rejection).toMatchObject({ message: expect.stringMatching(/stop/i) })
  await vi.waitFor(() => expect(logs.some((line) => line.startsWith('cancelled '))).toBe(true))
})
it('03 验收 30: progress resets the idle timer, but the total deadline cancels at ten times', async () => {
  const logs: string[] = []
  const c = await connect('dual', logs)
  let progress = 0
  await expect(
    c.callTool(
      'slow',
      { ms: 400 },
      {
        timeoutMs: 180,
        onprogress: () => {
          progress += 1
        },
        resetTimeoutOnProgress: true,
        maxTotalTimeoutMs: 1800,
      },
    ),
  ).resolves.toHaveProperty('content')
  expect(progress).toBeGreaterThan(1)
  const caller = new AbortController()
  const started = Date.now()
  await expect(
    c.callTool(
      'slow',
      { ms: 3000 },
      {
        signal: caller.signal,
        timeoutMs: 180,
        onprogress: () => {},
        resetTimeoutOnProgress: true,
        maxTotalTimeoutMs: 1800,
      },
    ),
  ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
  expect(Date.now() - started).toBeLessThan(2400)
  expect(caller.signal.aborted).toBe(false)
  await vi.waitFor(() => expect(logs.some((line) => line.startsWith('cancelled '))).toBe(true))
})

it('03 验收 30: an ordinary stdio timeout sends notifications/cancelled', async () => {
  const logs: string[] = []
  const c = await connect('dual', logs)
  await expect(c.callTool('slow', { ms: 1000 }, { timeoutMs: 80 })).rejects.toThrow(/time/i)
  await vi.waitFor(() => expect(logs.some((line) => line.startsWith('cancelled '))).toBe(true))
})

it('03 验收 30: the total deadline timer is cleared after success, error and caller cancellation', async () => {
  const c = await connect()
  const original = c.client.callTool.bind(c.client)
  const spy = vi.spyOn(c.client, 'callTool')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const initialTimers = vi.getTimerCount()
  for (const outcome of ['success', 'error', 'stop'] as const) {
    const caller = new AbortController()
    spy.mockImplementationOnce(async (_params, options) => {
      if (outcome === 'success') return { content: [] }
      if (outcome === 'error') throw new Error('fixture error')
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        })
      })
    })
    const pending = c.callTool('echo', {}, { signal: caller.signal, maxTotalTimeoutMs: 1000 })
    const settled = pending.catch(() => undefined)
    if (outcome === 'stop') caller.abort(new Error('stop'))
    // Sequential outcomes exercise the same connection without leaving deadline timers behind.
    // oxlint-disable-next-line no-await-in-loop
    await settled
    expect(spy.mock.calls.at(-1)?.[1]).not.toHaveProperty('maxTotalTimeout')
    expect(vi.getTimerCount()).toBe(initialTimers)
  }
  spy.mockImplementation(original)
})

it('03 验收 41: initialize declares no capabilities, never sets a log level and logs notifications', async () => {
  const sent = vi.spyOn(ChildStdioTransport.prototype, 'send')
  const logs: string[] = []
  const c = await connect('dual', logs)
  await c.callTool('echo', {})
  await vi.waitFor(() => expect(logs.join(' ')).toContain('fixture log'))
  const frames = sent.mock.calls.map(([message]) => message)
  expect(frames).toContainEqual(
    expect.objectContaining({
      method: 'initialize',
      params: expect.objectContaining({ capabilities: {} }),
    }),
  )
  expect(
    frames.some((m) => 'method' in m && ['server/discover', 'logging/setLevel'].includes(m.method)),
  ).toBe(false)
})

it('minor modern-only: hand-written -32602 data.supported is recognized without supportedVersions', async () => {
  await expect(
    connectStdioServer(createMemoryHost({ process: createNodeProcess() }), {
      name: 'modern-only',
      spawn: {
        argv: [
          process.execPath,
          new URL('../support/fixtures/modern-only-reply.mjs', import.meta.url).pathname,
        ],
        cwd: absolutePath('/'),
        env: {},
        stdio: 'pipe',
      },
      sandbox: { profile: 'full-access', workspace: [] },
    }),
  ).rejects.toMatchObject({ code: 'modern-only' })
})

it('03 验收 42: a real legacy dual stdio connection exposes the exact fixture instructions', async () => {
  const { INSTRUCTIONS } = await import('../support/fixtures/modern-server.mjs')
  expect((await connect('dual')).instructions).toBe(INSTRUCTIONS)
})
