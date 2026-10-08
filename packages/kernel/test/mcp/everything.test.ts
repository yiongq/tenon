import { describe, expect, it } from 'vitest'
import {
  absolutePath,
  connectStdioServer,
  createMemoryHost,
  McpResourceNotFoundError,
} from '../../src/index.js'
import type { McpServerRuntime } from '../../src/mcp/pool.js'
import type { HostClock } from '../../src/index.js'
import { createNodeProcess } from '../support/node-process.js'
import { serverEverythingSpawnSpec } from '../support/server-everything.js'

/** Acceptance 3: the kernel drives a real MCP stdio server through HostProcess only. */
describe('connectStdioServer against @modelcontextprotocol/server-everything', () => {
  it('negotiates, lists tools and calls echo, then shuts the server down cleanly', async () => {
    const host = createMemoryHost({ process: createNodeProcess() })
    const conn = await connectStdioServer(host, {
      name: 'everything',
      spawn: serverEverythingSpawnSpec(),
      sandbox: { profile: 'read-only', workspace: [] },
    })
    // The spawn went through the sandbox wrapper (phase 0: passthrough + log).
    expect(host.sandboxLog).toEqual(['sandbox: passthrough mcp:everything read-only'])
    try {
      expect(conn.serverVersion?.name).toBeTruthy()
      expect(conn.protocolVersion).toBeTruthy()

      const tools = await conn.listTools()
      expect(tools.length).toBeGreaterThan(0)
      expect(tools.map((t) => t.name)).toContain('echo')

      const result = await conn.callTool('echo', { message: 'tenon' })
      const text = JSON.stringify(result.content)
      expect(text).toContain('tenon')
      expect(result.isError ?? false).toBe(false)
    } finally {
      await conn.close()
    }
    // stdin EOF is enough for a well-behaved server: no signal needed.
    const exit = await conn.exited
    expect(exit).toEqual({ code: 0, signal: null })
  }, 20_000)

  it('rejects a relative argv[0] before spawning anything', async () => {
    const host = createMemoryHost({ process: createNodeProcess() })
    const spec = serverEverythingSpawnSpec()
    await expect(
      connectStdioServer(host, {
        name: 'bad',
        spawn: { ...spec, argv: ['node', 'x'] },
        sandbox: { profile: 'full-access', workspace: [] },
      }),
    ).rejects.toThrow(/absolute/)
  })
})

const realClock: HostClock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  },
}

describe('a server whose stream breaks but whose process stays alive', () => {
  it('is reaped: the oversized frame closes the transport and the child is terminated', async () => {
    const host = { ...createMemoryHost({ process: createNodeProcess() }), clock: realClock }
    const fixture = new URL('../support/fixtures/wedged-server.mjs', import.meta.url).pathname
    const conn = await connectStdioServer(host, {
      name: 'wedged',
      spawn: {
        argv: [process.execPath, fixture],
        cwd: absolutePath(process.cwd()),
        env: { PATH: process.env['PATH'] ?? '' },
        stdio: 'pipe',
      },
      sandbox: { profile: 'read-only', workspace: [] },
      transport: { maxBufferChars: 256, graceMs: 100 },
    })
    // The fixture answers `initialize`, then writes one endless unterminated line and
    // ignores stdin EOF. Without the reaping it would run until the test process dies.
    const exit = await conn.exited
    expect(exit.signal).toBe('SIGTERM')
    await conn.close()
    await conn.close()
  }, 15_000)
})

it('03 验收 40 (Everything): lists and gets a prompt, lists and reads a resource, maps -32002', async () => {
  const conn = await connectStdioServer(createMemoryHost({ process: createNodeProcess() }), {
    name: 'everything',
    spawn: serverEverythingSpawnSpec(),
    sandbox: { profile: 'full-access', workspace: [] },
  })
  try {
    expect((await conn.listPrompts?.())?.prompts.map((p) => p.name)).toContain('simple-prompt')
    expect(await conn.getPrompt?.('simple-prompt')).toHaveProperty('messages')
    const resources = (await conn.listResources?.())?.resources ?? []
    expect(resources.length).toBeGreaterThan(0)
    expect(await conn.readResource?.(resources[0]!.uri)).toHaveProperty('contents')
    await expect(conn.readResource?.('demo://missing')).rejects.toBeInstanceOf(
      McpResourceNotFoundError,
    )
  } finally {
    await conn.close()
  }
})

it('03 验收 39 (Everything): gzip-file-as-resource with a data URI changes the resources snapshot', async () => {
  const { createMcpPool } = await import('../../src/mcp/pool.js')
  const { vi } = await import('vitest')
  const host = createMemoryHost({ process: createNodeProcess() })
  const spawn = serverEverythingSpawnSpec()
  const runtime: McpServerRuntime = {
    serverId: 'everything',
    launchHash: 'fixture-launch',
    consented: true,
    transport: {
      type: 'stdio',
      command: spawn.argv[0]!,
      args: spawn.argv.slice(1),
      envs: {},
      envKeys: [],
    },
    handshakeTimeoutMs: 30_000,
    callTimeoutMs: 1000,
    rank: 0,
    toolsPinned: false,
    pins: {},
    instructions: { enabled: false, pinHash: null },
  }
  const changed = vi.fn<() => void>()
  const pool = createMcpPool({
    host,
    ids: { uuid: () => crypto.randomUUID() },
    baseEnv: async () => spawn.env,
    homeDir: spawn.cwd,
    resolveCommand: async (command) => ({ ok: true, path: absolutePath(command) }),
    runtimeOf: () => runtime,
    log: () => {},
    onPin: async () => {},
    onIssuer: async () => {},
    onChange: changed,
  })
  pool.apply([runtime])
  try {
    await vi.waitFor(() => expect(pool.status()[0]?.phase).toBe('connected'))
    const proxy = pool.routes()[0]!.connection
    const before = await proxy.listResources?.()
    const changes = changed.mock.calls.length
    await proxy.callTool('gzip-file-as-resource', {
      data: 'data:text/plain,fixture%20resource',
      name: 'fixture.txt.gz',
      outputType: 'resourceLink',
    })
    await vi.waitFor(() => expect(changed.mock.calls.length).toBeGreaterThan(changes))
    const after = await proxy.listResources?.()
    expect(after?.resources.length).toBeGreaterThan(before?.resources.length ?? 0)
    expect(after?.resources.some((r) => r.name === 'fixture.txt.gz')).toBe(true)
  } finally {
    const closing = pool.close({ deadlineMs: 1000 })
    host.advance(1000)
    await closing
  }
}, 20_000)
