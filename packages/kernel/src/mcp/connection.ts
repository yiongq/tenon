import {
  Client,
  StreamableHTTPClientTransport,
  ProtocolError,
  UnauthorizedError,
  InsufficientScopeError,
  OAuthError,
  SdkHttpError,
  SdkErrorCode,
  SdkError,
} from '@modelcontextprotocol/client'
import type {
  AuthProvider,
  OAuthClientProvider,
  ListChangedHandlers,
  RequestOptions,
} from '@modelcontextprotocol/client'
import { mcpClientOptions } from './client.js'
import { wrapMcpFetch } from './http-fetch.js'
import type { McpStreamBreak } from './http-fetch.js'
import type {
  FetchLike,
  AbsolutePath,
  HostAdapter,
  SandboxRequest,
  SpawnSpec,
} from '../host/adapter.js'
import { ChildStdioTransport } from './stdio-transport.js'
import type { ChildStdioTransportOptions } from './stdio-transport.js'

export interface McpStdioServerSpec {
  readonly handshakeTimeoutMs?: number
  readonly listChanged?: ListChangedHandlers
  readonly log?: (line: string) => void

  /** Human-readable id used in logs and errors. */
  readonly name: string
  /** Spawned through HostSandbox.wrap + HostProcess; argv[0] must be absolute. */
  readonly spawn: SpawnSpec
  /** Required on purpose: whoever starts a server states the profile it runs under. */
  readonly sandbox: {
    readonly profile: SandboxRequest['profile']
    readonly workspace: readonly AbsolutePath[]
  }
  readonly transport?: ChildStdioTransportOptions
}

export type McpToolList = Awaited<ReturnType<Client['listTools']>>['tools']
export type McpCallToolResult = Awaited<ReturnType<Client['callTool']>>

export interface McpCallOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly onprogress?: (progress: { readonly progress: number; readonly total?: number }) => void
  readonly resetTimeoutOnProgress?: boolean
  readonly maxTotalTimeoutMs?: number
}

export interface McpConnection {
  readonly era?: 'legacy' | 'modern'
  readonly instructions?: string
  listPrompts?(options?: McpCallOptions): ReturnType<Client['listPrompts']>
  getPrompt?(
    name: string,
    args?: Record<string, string>,
    options?: McpCallOptions,
  ): ReturnType<Client['getPrompt']>
  listResources?(options?: McpCallOptions): ReturnType<Client['listResources']>
  readResource?(uri: string, options?: McpCallOptions): ReturnType<Client['readResource']>

  readonly name: string
  readonly client: Client
  readonly serverVersion: ReturnType<Client['getServerVersion']>
  readonly protocolVersion: string | undefined
  listTools(options?: McpCallOptions): Promise<McpToolList>
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: McpCallOptions,
  ): Promise<McpCallToolResult>
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
  host: Pick<HostAdapter, 'process' | 'sandbox' | 'clock'>,
  spec: McpStdioServerSpec,
  signal?: AbortSignal,
): Promise<McpConnection> {
  // AGENTS.md: every subprocess goes through the sandbox wrapper. Phase 0's wrapper passes
  // the command through (and logs it); phase 4 swaps the implementation, not this call.
  const commandId = `mcp:${spec.name}`
  const wrapped = await host.sandbox.wrap({
    commandId,
    argv: spec.spawn.argv,
    cwd: spec.spawn.cwd,
    env: spec.spawn.env,
    profile: spec.sandbox.profile,
    workspace: [...spec.sandbox.workspace],
  })
  const child = await host.process.spawn(
    { ...spec.spawn, argv: wrapped.argv, env: wrapped.env },
    signal,
  )
  void child.exited.then(() => host.sandbox.afterExit(commandId)).catch(() => {})
  const transport = new ChildStdioTransport(child, host.clock, spec.transport)
  const client = new Client(
    CLIENT_INFO,
    mcpClientOptions({
      era: 'legacy',
      ...(spec.listChanged === undefined ? {} : { listChanged: spec.listChanged }),
    }),
  )
  logNotifications(client, spec.log)
  try {
    await client.connect(transport, {
      ...(spec.handshakeTimeoutMs === undefined ? {} : { timeout: spec.handshakeTimeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    await transport.close()
    if (error instanceof ProtocolError && (error.code === -32022 || modernVersionsOnly(error.data)))
      throw new McpConnectionError('modern-only')
    throw error
  }
  return connected(client, spec.name, child.exited, async () => {
    await client.close().catch(() => {})
    await transport.close()
  })
}

export class McpConnectionError extends Error {
  readonly code: 'modern-only' | 'era-negotiation-failed' | 'handshake-failed'
  constructor(code: 'modern-only' | 'era-negotiation-failed' | 'handshake-failed') {
    super(code)
    this.code = code
    this.name = 'McpConnectionError'
  }
}
export class McpServerUnavailableError extends Error {
  readonly reason: string
  constructor(reason = 'connector-unavailable') {
    super(reason)
    this.reason = reason
    this.name = 'McpServerUnavailableError'
  }
}
export class McpUnauthorizedError extends Error {
  constructor() {
    super('connector-unauthorized')
    this.name = 'McpUnauthorizedError'
  }
}
export class McpResourceNotFoundError extends Error {
  constructor() {
    super('resource-not-found')
    this.name = 'McpResourceNotFoundError'
  }
}
export function isMcpAuthError(error: unknown): boolean {
  return (
    error instanceof McpUnauthorizedError ||
    error instanceof UnauthorizedError ||
    error instanceof InsufficientScopeError ||
    (error instanceof OAuthError && ['invalid_grant', 'invalid_client'].includes(error.code)) ||
    (error instanceof SdkHttpError && error.code === SdkErrorCode.ClientHttpAuthentication)
  )
}
function modernVersionsOnly(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const versions =
    (data as Record<string, unknown>)['supported'] ??
    (data as Record<string, unknown>)['supportedVersions']
  return (
    Array.isArray(versions) &&
    versions.length > 0 &&
    versions.every((v) => typeof v === 'string' && v >= '2026-07-28')
  )
}
export interface McpHttpServerSpec {
  readonly name: string
  readonly url: string
  readonly fetch: FetchLike
  readonly staticHeaders?: Readonly<Record<string, string>>
  readonly authProvider?: AuthProvider | OAuthClientProvider
  readonly protocol?: 'auto' | 'legacy'
  readonly handshakeTimeoutMs?: number
  readonly listChanged?: ListChangedHandlers
  readonly log?: (line: string) => void
  readonly onStreamBreak?: (request: McpStreamBreak) => void
}
export async function connectHttpServer(
  spec: McpHttpServerSpec,
  signal?: AbortSignal,
): Promise<McpConnection> {
  const client = new Client(
    CLIENT_INFO,
    mcpClientOptions({
      era: spec.protocol ?? 'auto',
      ...(spec.listChanged === undefined ? {} : { listChanged: spec.listChanged }),
    }),
  )
  logNotifications(client, spec.log)
  const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
    fetch: wrapMcpFetch(spec.fetch, {
      serverUrl: spec.url,
      ...(spec.staticHeaders === undefined ? {} : { staticHeaders: spec.staticHeaders }),
      ...(spec.onStreamBreak === undefined ? {} : { onStreamBreak: spec.onStreamBreak }),
    }),
    ...(spec.authProvider === undefined ? {} : { authProvider: spec.authProvider }),
    onInsufficientScope: 'throw',
  })
  try {
    await client.connect(transport, {
      ...(spec.handshakeTimeoutMs === undefined ? {} : { timeout: spec.handshakeTimeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    await transport.close().catch(() => {})
    if (error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed) {
      if (error.cause instanceof TypeError) throw error.cause
      const status = (error.data as Record<string, unknown> | undefined)?.['status']
      if (typeof status === 'number' && status >= 500)
        throw new McpConnectionError('handshake-failed')
      if (error.message.includes('closed during'))
        throw new TypeError('MCP probe connection closed', { cause: error })
      throw new McpConnectionError('era-negotiation-failed')
    }
    throw error
  }
  let resolve!: (value: { code: null; signal: null }) => void
  const exited = new Promise<{ code: null; signal: null }>((done) => {
    resolve = done
  })
  // SDK callback property; Client has no EventTarget API.
  // oxlint-disable-next-line prefer-add-event-listener
  client.onclose = () => resolve({ code: null, signal: null })
  return connected(client, spec.name, exited, () => client.close())
}
function requestOptions(q?: McpCallOptions): RequestOptions {
  return {
    ...(q?.signal === undefined ? {} : { signal: q.signal }),
    ...(q?.timeoutMs === undefined ? {} : { timeout: q.timeoutMs }),
    ...(q?.onprogress === undefined
      ? {}
      : {
          onprogress: (progress) =>
            q.onprogress?.({
              progress: progress.progress,
              ...(progress.total === undefined ? {} : { total: progress.total }),
            }),
        }),
    ...(q?.resetTimeoutOnProgress === undefined
      ? {}
      : { resetTimeoutOnProgress: q.resetTimeoutOnProgress }),
  }
}
function logNotifications(client: Client, log?: (line: string) => void) {
  client.setNotificationHandler('notifications/message', (notification) => {
    log?.(JSON.stringify(notification.params))
  })
}
function connected(
  client: Client,
  serverName: string,
  exited: McpConnection['exited'],
  close: () => Promise<void>,
): McpConnection {
  return {
    name: serverName,
    client,
    exited,
    close,
    get serverVersion() {
      return client.getServerVersion()
    },
    get protocolVersion() {
      return client.getNegotiatedProtocolVersion()
    },
    get era() {
      return client.getProtocolEra() ?? 'legacy'
    },
    get instructions() {
      return client.getInstructions() ?? ''
    },
    async listTools(options) {
      return (
        await client.listTools(undefined, { ...requestOptions(options), cacheMode: 'refresh' })
      ).tools
    },
    callTool(name, args, options) {
      return callWithDeadline(client, name, args, options)
    },
    listPrompts(options) {
      return client.listPrompts(undefined, requestOptions(options))
    },
    getPrompt(name, args, options) {
      return client.getPrompt(
        { name, ...(args === undefined ? {} : { arguments: args }) },
        requestOptions(options),
      )
    },
    listResources(options) {
      return client.listResources(undefined, requestOptions(options))
    },
    async readResource(uri, options) {
      try {
        return await client.readResource({ uri }, requestOptions(options))
      } catch (error) {
        if (error instanceof ProtocolError && (error.code === -32002 || error.code === -32602))
          throw new McpResourceNotFoundError()
        throw error
      }
    },
  }
}

/** A hard deadline must use SDK cancellation, including when progress keeps the idle timer alive. */
async function callWithDeadline(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  options?: McpCallOptions,
): Promise<McpCallToolResult> {
  if (options?.maxTotalTimeoutMs === undefined)
    return client.callTool({ name, arguments: args }, requestOptions(options))
  const deadline = new AbortController()
  const signal =
    options.signal === undefined
      ? deadline.signal
      : AbortSignal.any([options.signal, deadline.signal])
  // Spec 03 §超时、取消与断流: this deadline shares the SDK real timer domain.
  // oxlint-disable-next-line no-restricted-globals
  const timer = setTimeout(
    () =>
      deadline.abort(new SdkError(SdkErrorCode.RequestTimeout, 'MCP total time limit exceeded')),
    options.maxTotalTimeoutMs,
  )
  try {
    return await client.callTool({ name, arguments: args }, requestOptions({ ...options, signal }))
  } finally {
    clearTimeout(timer)
  }
}

export class McpInvalidOutputError extends Error {
  override name = 'McpInvalidOutputError'
  constructor() {
    super('MCP structured output is invalid or its schema is unusable')
  }
}
