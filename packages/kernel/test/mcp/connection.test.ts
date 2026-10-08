import { Client } from '@modelcontextprotocol/client'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import { afterEach, expect, it, vi } from 'vitest'
import { absolutePath, connectStdioServer, createMemoryHost } from '../../src/index.js'
import type { ChildHandle, McpConnection } from '../../src/index.js'
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
  })
  connections.push(c)
  return c
}
it('03 验收 33 / 03 不变量 17: the client validates structured output with CfWorker and declares no capabilities', () => {
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
it('03 验收 30: stopping a stdio call sends notifications/cancelled', async () => {
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
it('SDK progress resets the timer and maxTotalTimeout rejects (cancellation gap in plan Open)', async () => {
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
  await expect(
    c.callTool(
      'slow',
      { ms: 3000 },
      {
        timeoutMs: 180,
        onprogress: () => {},
        resetTimeoutOnProgress: true,
        maxTotalTimeoutMs: 1800,
      },
    ),
  ).rejects.toThrow(/time/i)
})

it('03 验收 30: an ordinary stdio timeout sends notifications/cancelled', async () => {
  const logs: string[] = []
  const c = await connect('dual', logs)
  await expect(c.callTool('slow', { ms: 1000 }, { timeoutMs: 80 })).rejects.toThrow(/time/i)
  await vi.waitFor(() => expect(logs.some((line) => line.startsWith('cancelled '))).toBe(true))
})
