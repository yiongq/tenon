import { Client } from '@modelcontextprotocol/client'
import type { HostAdapter, SpawnSpec } from '../host/adapter.js'
import { ChildStdioTransport } from './stdio-transport.js'
import type { ChildStdioTransportOptions } from './stdio-transport.js'

export interface McpStdioServerSpec {
  /** Human-readable id used in logs and errors. */
  readonly name: string
  /** Spawned through HostProcess; argv[0] must be absolute. */
  readonly spawn: SpawnSpec
  readonly transport?: ChildStdioTransportOptions
}

export type McpToolList = Awaited<ReturnType<Client['listTools']>>['tools']
export type McpCallToolResult = Awaited<ReturnType<Client['callTool']>>

export interface McpConnection {
  readonly name: string
  readonly client: Client
  readonly serverVersion: ReturnType<Client['getServerVersion']>
  readonly protocolVersion: string | undefined
  listTools(): Promise<McpToolList>
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult>
  /** Closes the client and lets the transport bring the child down. */
  close(): Promise<void>
  /** Resolves when the server process has exited. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>
}

const CLIENT_INFO = { name: 'tenon-kernel', version: '0.0.0' }

/**
 * Phase 0 MCP host: spawn one stdio server through the HostAdapter, negotiate, and
 * expose tools/list + tools/call. Everything the server returns is untrusted content.
 */
export async function connectStdioServer(
  host: HostAdapter,
  spec: McpStdioServerSpec,
  signal?: AbortSignal,
): Promise<McpConnection> {
  const child = await host.process.spawn(spec.spawn, signal)
  const transport = new ChildStdioTransport(child, host.clock, spec.transport)
  const client = new Client(CLIENT_INFO)
  try {
    await client.connect(transport)
  } catch (error) {
    await transport.close()
    throw error
  }
  return {
    name: spec.name,
    client,
    serverVersion: client.getServerVersion(),
    protocolVersion: transport.protocolVersion,
    exited: child.exited,
    async listTools() {
      return (await client.listTools()).tools
    },
    callTool(name, args) {
      return client.callTool({ name, arguments: args })
    },
    async close() {
      await client.close()
    },
  }
}
