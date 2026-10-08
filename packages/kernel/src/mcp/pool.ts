import { synchronousSchemaVerdict } from '../tools/validate.js'
import type { SchemaValidatorPort } from '../tools/validate.js'
import type { AbsolutePath, ChildHandle, FetchLike, HostAdapter } from '../host/adapter.js'
import { absolutePath } from '../host/path.js'
import { keyFor } from '../host/key.js'
import type { McpAbsentSource, McpToolSource } from '../loop/ports.js'
import { canonicalJson } from '../tape/canonical-json.js'
import { sha256Hex } from '../tape/hash.js'
import { mcpToolName, MCP_SERVER_ID_PATTERN } from '../tools/registry.js'
import { MODEL_NOTES } from '../prompts/index.js'
import { buildStdioEnv, redactLine } from './env.js'
import { definitionProblem, mcpDefinitionHash, toolsOverLimit } from './definition.js'
import {
  connectHttpServer,
  connectStdioServer,
  isMcpAuthError,
  McpConnectionError,
  McpInvalidOutputError,
  McpServerUnavailableError,
  McpUnauthorizedError,
} from './connection.js'
import type { McpCallOptions, McpConnection, McpToolList } from './connection.js'
import { createMcpOAuthProvider } from './oauth.js'
import type { McpLoginUi, McpLoginResult, McpOAuthProvider } from './oauth.js'
import { createMcpTokenStore, McpKeychainError } from './token-store.js'
import type { McpTokenStore } from './token-store.js'
import { wrapMcpFetch } from './http-fetch.js'
import {
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  InsufficientScopeError,
} from '@modelcontextprotocol/client'

export type McpTransportRuntime =
  | {
      readonly type: 'stdio'
      readonly command: string
      readonly args: readonly string[]
      readonly envs: Readonly<Record<string, string>>
      readonly envKeys: readonly string[]
    }
  | {
      readonly type: 'http'
      readonly url: string
      readonly headerKeys: readonly string[]
      readonly protocol: 'auto' | 'legacy'
      readonly fetch: FetchLike /* desktop 的专用 fetch（T38） */
      readonly oauth: McpOAuthRuntime
    }
export interface McpOAuthRuntime {
  readonly issuers: readonly string[]
  readonly ownClient: {
    readonly clientId: string
    readonly redirectPort: number
    readonly hasSecret: boolean
    readonly issuer: string | null
  } | null // Q9、T32
  readonly clientMetadataUrl: string | null // CIMD_CLIENT_METADATA_URL；owner 给地址之前为 null（Q9）
  readonly dcrRedirectPort: number // 产品 53280（读法 35）；测试可换
}
export interface McpPinRequest {
  readonly tools: readonly { readonly name: string; readonly definitionHash: string }[]
}
/** desktop 从 config.json 的每个启用条目与确认算出，交给池；停用的不交 */
export interface McpServerRuntime {
  readonly serverId: string
  readonly launchHash: string
  readonly consented: boolean // Q11-1：false 时池不起它，状态为已停止（needs-consent）
  readonly transport: McpTransportRuntime
  readonly handshakeTimeoutMs: number // 配置值，缺省 30 000；「改配置后第一次」的 120 s 由池判（T8）
  readonly callTimeoutMs: number // 配置值，缺省 60 000，已夹到 1–3600 s（T9）
  readonly rank: number // 在连接器栏里的位置，0 起（Q11-2）
  readonly toolsPinned: boolean // Q14
  readonly pins: Readonly<Record<string, string>> // 原名 → 钉住的 definitionHash（Q14）
  readonly instructions: { readonly enabled: boolean; readonly pinHash: string | null } // Q4-2
}
export interface McpPoolOptions {
  readonly schemaValidator?: SchemaValidatorPort
  readonly host: Pick<HostAdapter, 'identity' | 'fs' | 'secrets' | 'process' | 'sandbox' | 'clock'>
  readonly ids: { uuid(): string }
  readonly baseEnv: () => Promise<Readonly<Record<string, string>>> // shell-env 的终端环境（Q8-1）
  readonly homeDir: AbsolutePath // cwd（Q5）
  readonly resolveCommand: (
    command: string,
    path: string,
  ) => Promise<
    | { ok: true; path: AbsolutePath }
    | { ok: false; code: 'command-not-found' | 'windows-unsupported' }
  > // T27、T43
  readonly runtimeOf: (serverId: string) => McpServerRuntime | null // 重连前重读（Q6）
  readonly log: (serverId: string, line: string) => void // 已脱敏（T12）
  readonly onPin: (serverId: string, q: McpPinRequest) => Promise<void> // 第一次成功列表时整表钉住（Q14）
  readonly onIssuer: (
    serverId: string,
    issuer: { readonly hash: string; readonly url: string },
    write: 'tokens' | 'client',
  ) => Promise<void> // 写钥匙串前先记进 config，挪到末尾（T35）
  readonly onChange: () => void // 状态、列表、说明变了
}
export interface McpPool {
  apply(servers: readonly McpServerRuntime[]): void // 换快照：按 serverId 与 launchHash 起、停、重启
  status(): readonly McpServerStatus[]
  /** 派发路由：每台启用的 server（含需要确认的）一个按 serverId 转发的来源，不论阶段；顺序按 rank。不等待 */
  routes(): readonly McpToolSource[]
  /** 开表候选：先等还在连接的（连接中、等待重启）最多 waitMs 或到 signal，再分成已连接与缺席 */
  tableSources(q: { readonly waitMs: number; readonly signal: AbortSignal }): Promise<McpRunSources>
  restart(serverId: string): void // 用户点「重启」、机密改值：崩溃计数清零
  refreshTools(serverId: string): Promise<void> // T42
  cancelLogin(serverId: string): boolean
  login(serverId: string, ui: McpLoginUi): Promise<McpLoginResult> // §登录流程
  close(q: { readonly deadlineMs: number }): Promise<void> // 退出时：并行关全部，到 deadlineMs 对仍活着的进程组无条件 SIGKILL
}
export interface McpRunSources {
  readonly sources: readonly McpToolSource[] // routes() 里此刻「已连接」的那几个（同一批代理）；顺序按 rank
  readonly absent: readonly McpAbsentSource[] // 启用却没连上或没登录的（T47）
}
export type McpErrorCode =
  | 'handshake-timeout'
  | 'handshake-failed'
  | 'modern-only'
  | 'era-negotiation-failed'
  | 'command-not-found'
  | 'windows-unsupported'
  | 'spawn-failed'
  | 'missing-secret'
  | 'tools-limit'
  | 'network'
  | 'rate-limited'
  | 'keychain'
  | 'crashed'
export interface McpServerStatus {
  readonly serverId: string
  readonly phase: 'stopped' | 'connecting' | 'connected' | 'restarting' | 'error' | 'unauthorized'
  readonly stopReason: 'needs-consent' | 'crash-limit' | null // Q11-1、Q6
  readonly error: { readonly code: McpErrorCode; readonly stderrTail: string } | null
  readonly firstConnect: boolean // 本次运行还没为当前 launchHash 连上过（Q5、T48）
  readonly restartInMs: number | null
  readonly era: 'legacy' | 'modern' | null
  readonly protocolVersion: string | null
  readonly tools: readonly McpLiveTool[] | null // 最近一次成功的列表；null = 本次运行还没拿到
  readonly instructions: { readonly text: string; readonly hash: string } | null
  readonly loggedIn: boolean | null // 只 http：有可用令牌
}
export interface McpLiveTool {
  readonly originalName: string
  readonly mappedName: string
  readonly definitionHash: string
  readonly definition: unknown // 规范化的定义原文（只给栏里显示与缓存）
  readonly requiresUserInteraction: boolean
  readonly review: 'ok' | 'changed' | 'new' // Q14：与 pins 比
}

export interface McpServerCache {
  readonly version: 1
  readonly connectedLaunchHash: string | null
  readonly lastTools: readonly { name: string; definitionHash: string }[]
  readonly pinnedDefinitions: Readonly<Record<string, unknown>>
  readonly pinnedInstructions: string | null
  readonly oauth: { readonly issuer: string; readonly discoveredAt: number } | null
}
const emptyCache = (): McpServerCache => ({
  version: 1,
  connectedLaunchHash: null,
  lastTools: [],
  pinnedDefinitions: {},
  pinnedInstructions: null,
  oauth: null,
})
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
interface ServerState {
  runtime: McpServerRuntime
  oauth: McpOAuthProvider | null
  tokenStore: McpTokenStore | null
  httpFetch: FetchLike | null
  requiredScope: string | undefined
  oauthIssuerHash: string | null
  status: Mutable<McpServerStatus>
  cache: McpServerCache
  connection: McpConnection | null
  source: McpToolSource
  generation: number
  controller: AbortController
  children: Set<ChildHandle>
  timer: (() => void) | null
  cacheLoaded: Promise<void>
  ready: Promise<void>
  write: Promise<void>
  raw: McpToolList
  secrets: string[]
  stderr: string[]
  pinned: boolean
  crashes: number
  lastCrash: number | null
  networkAttempt: number
  retired: boolean
  finish: () => void
  listeners: Set<() => void>
  requests: Map<string | number, { abort: AbortController; broken: boolean }>
  issuing: { method: string; abort: AbortController; broken: boolean; release: () => void } | null
  sends: Promise<void>
}

export function createMcpPool(options: McpPoolOptions): McpPool {
  const { host } = options
  const states = new Map<string, ServerState>()
  const encoder = new TextEncoder()
  let closed = false
  const announce = (s: ServerState) => {
    const source = s.source as Mutable<McpToolSource>
    if (source) {
      delete source.instructions
      const live = s.status.instructions
      if (s.runtime.instructions.enabled && live && live.hash === s.runtime.instructions.pinHash)
        source.instructions = live
    }
    for (const listener of s.listeners) listener()
    options.onChange()
  }
  function sorted(): ServerState[] {
    return [...states.values()].toSorted(
      (a, b) =>
        a.runtime.rank - b.runtime.rank || (a.runtime.serverId < b.runtime.serverId ? -1 : 1),
    )
  }
  const path = (s: ServerState) =>
    absolutePath(`${host.identity.profileDir}/mcp/${s.runtime.serverId}.json`)
  function log(s: ServerState, line: string) {
    const safe = redactLine(line, s.secrets)
    s.stderr.push(safe)
    s.stderr = s.stderr.slice(-20)
    while (encoder.encode(s.stderr.join('\n')).length > 4096) {
      if (s.stderr.length > 1) s.stderr.shift()
      else {
        const points = Array.from(s.stderr[0] ?? '')
        let low = 0
        let high = points.length
        while (low < high) {
          const middle = Math.floor((low + high) / 2)
          if (encoder.encode(points.slice(middle).join('')).length > 4096) low = middle + 1
          else high = middle
        }
        s.stderr[0] = points.slice(low).join('')
      }
    }
    options.log(s.runtime.serverId, safe)
  }
  function error(s: ServerState, code: McpErrorCode) {
    s.status.phase = 'error'
    s.status.error = { code, stderrTail: s.stderr.join('\n') }
    s.status.restartInMs = null
    announce(s)
  }
  function save(s: ServerState) {
    const data = canonicalJson(s.cache)
    if (encoder.encode(data).length > 5 * 1024 * 1024) return
    s.write = s.write
      .then(async () => {
        await host.fs.mkdirp(absolutePath(`${host.identity.profileDir}/mcp`))
        await host.fs.writeFile(path(s), data)
      })
      .catch(() => {})
  }
  async function list(s: ServerState, tools: McpToolList, generation: number) {
    if (s.retired || generation !== s.generation) return
    if (toolsOverLimit(tools)) {
      error(s, 'tools-limit')
      await s.connection?.close()
      return
    }
    const live = tools.map((tool): McpLiveTool => {
      const mappedName = mcpToolName(s.runtime.serverId, tool.name)
      const requiresUserInteraction = tool['_meta']?.['anthropic/requiresUserInteraction'] === true
      const definitionHash = mcpDefinitionHash({
        spec: {
          name: mappedName,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema as Record<string, unknown>,
        },
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        requiresUserInteraction,
      })
      const pin = s.runtime.pins[tool.name]
      return {
        originalName: tool.name,
        mappedName,
        definitionHash,
        definition: JSON.parse(canonicalJson(tool)),
        requiresUserInteraction,
        review:
          !s.runtime.toolsPinned || pin === definitionHash
            ? 'ok'
            : pin === undefined
              ? 'new'
              : 'changed',
      }
    })
    s.raw = structuredClone(tools)
    s.status.tools = live
    if (!s.pinned && !s.runtime.toolsPinned) {
      s.pinned = true
      await options.onPin(s.runtime.serverId, {
        tools: live.map((t) => ({ name: t.originalName, definitionHash: t.definitionHash })),
      })
      if (s.retired || generation !== s.generation) return
      s.cache = {
        ...s.cache,
        pinnedDefinitions: Object.fromEntries(live.map((t) => [t.originalName, t.definition])),
      }
    }
    s.cache = {
      ...s.cache,
      lastTools: live.map((t) => ({ name: t.originalName, definitionHash: t.definitionHash })),
    }
    save(s)
    announce(s)
  }
  async function readSecrets(s: ServerState, kind: 'env' | 'header', names: readonly string[]) {
    const entries = await Promise.all(
      names.map(async (name) => {
        const value = await host.secrets
          .get(
            keyFor(
              host.identity,
              'mcp',
              s.runtime.serverId,
              kind,
              kind === 'header' ? name.toLowerCase() : name,
            ),
          )
          .catch(() => {
            throw new PoolError('missing-secret')
          })
        if (value === null) throw new PoolError('missing-secret')
        s.secrets.push(value)
        return [name, value] as const
      }),
    )
    return Object.fromEntries(entries)
  }
  async function stop(s: ServerState, reason: McpServerStatus['stopReason'] = null) {
    s.status.stopReason = reason
    s.generation++
    s.oauth?.cancelLogin()
    s.timer?.()
    s.timer = null
    s.controller.abort(new Error('MCP server stopped'))
    s.status.phase = 'stopped'
    s.status.error = null
    s.status.restartInMs = null
    const connection = s.connection
    const children = [...s.children]
    s.connection = null
    announce(s)
    await connection?.close().catch(() => {})
    children.forEach((child) => s.children.delete(child))
    s.finish()
  }
  function retry(s: ServerState, remote: boolean) {
    if (s.retired || closed || (s.status.phase !== 'connected' && s.status.phase !== 'connecting'))
      return
    let delay: number
    if (remote) {
      if (s.networkAttempt >= 5) {
        error(s, 'network')
        return
      }
      delay = 1000 * 2 ** s.networkAttempt++
    } else {
      s.status.error = { code: 'crashed', stderrTail: s.stderr.join('\n') }
      const now = host.clock.now()
      s.crashes = s.lastCrash !== null && now - s.lastCrash <= 60_000 ? s.crashes + 1 : 1
      s.lastCrash = now
      if (s.crashes >= 3) {
        s.status.phase = 'stopped'
        s.status.stopReason = 'crash-limit'
        const connection = s.connection
        const children = [...s.children]
        s.connection = null
        void connection
          ?.close()
          .catch(() => {})
          .then(() => children.forEach((child) => s.children.delete(child)))
        s.finish()
        announce(s)
        return
      }
      delay = s.crashes * 1000
    }
    s.status.phase = 'restarting'
    s.status.restartInMs = delay
    announce(s)
    s.timer = host.clock.setTimeout(() => {
      s.timer = null
      const runtime = options.runtimeOf(s.runtime.serverId)
      if (!runtime || !runtime.consented) {
        void stop(s, runtime && !runtime.consented ? 'needs-consent' : null)
        return
      }
      if (runtime.launchHash !== s.runtime.launchHash) resetLaunch(s, runtime)
      s.runtime = runtime
      launch(s)
    }, delay)
  }
  function launch(s: ServerState) {
    s.timer?.()
    s.timer = null
    const previous = s.connection
    const children = [...s.children]
    s.connection = null
    s.controller.abort(new Error('MCP reconnect'))
    s.controller = new AbortController()
    const generation = ++s.generation
    s.status.phase = 'connecting'
    s.status.stopReason = null
    s.status.restartInMs = null
    announce(s)
    s.ready = s.ready
      .then(async () => {
        await previous?.close().catch(() => {})
        children.forEach((child) => s.children.delete(child))
        s.stderr = []
        if (s.retired || generation !== s.generation) return
        await start(s, generation)
      })
      .catch(() => {})
  }
  async function start(s: ServerState, generation: number) {
    let connection: McpConnection | null = null
    const active = () => !s.retired && generation === s.generation
    try {
      const runtime = s.runtime
      const timeout =
        s.cache.connectedLaunchHash === runtime.launchHash
          ? runtime.handshakeTimeoutMs
          : Math.max(runtime.handshakeTimeoutMs, 120_000)
      const listChanged = {
        tools: {
          autoRefresh: false,
          debounceMs: 0,
          onChanged: () => {
            if (active() && s.connection) void refresh(s).catch(() => {})
          },
        },
        prompts: {
          autoRefresh: true,
          debounceMs: 0,
          onChanged: () => {
            if (active()) announce(s)
          },
        },
        resources: {
          autoRefresh: true,
          debounceMs: 0,
          onChanged: () => {
            if (active()) announce(s)
          },
        },
      }
      if (runtime.transport.type === 'stdio') {
        const base = await options.baseEnv()
        const resolved = await options.resolveCommand(runtime.transport.command, base['PATH'] ?? '')
        if (!resolved.ok) throw new PoolError(resolved.code)
        const values = await readSecrets(s, 'env', runtime.transport.envKeys)
        if (!active()) return
        connection = await connectStdioServer(
          {
            ...host,
            process: {
              spawn: async (spec, signal) => {
                const child = await host.process.spawn(spec, signal).catch(() => {
                  throw new PoolError('spawn-failed')
                })
                s.children.add(child)
                return child
              },
            },
          },
          {
            name: runtime.serverId,
            spawn: {
              argv: [resolved.path, ...runtime.transport.args],
              cwd: options.homeDir,
              env: buildStdioEnv({ base, envs: runtime.transport.envs, envKeyValues: values }),
              stdio: 'pipe',
            },
            sandbox: { profile: 'full-access', workspace: [] },
            transport: { onStderr: (line) => log(s, line) },
            handshakeTimeoutMs: timeout,
            listChanged,
            log: (line) => log(s, line),
          },
          s.controller.signal,
        )
      } else {
        const transport = runtime.transport
        const staticHeaders = await readSecrets(s, 'header', transport.headerKeys)
        if (!active()) return
        const privilegedFetch = wrapMcpFetch(transport.fetch, {
          serverUrl: transport.url,
          staticHeaders,
        })
        const handed: FetchLike = async (input, init) => {
          const request = new Request(input, init)
          const serverRequest =
            new URL(request.url).origin === new URL(transport.url).origin &&
            new URL(request.url).pathname === new URL(transport.url).pathname
          let listens = serverRequest && request.method === 'GET'
          if (request.method === 'POST') {
            try {
              const body = (await request.clone().json()) as {
                method?: string
                id?: string | number
              }
              listens = body.method === 'subscriptions/listen'
              if (s.issuing && s.issuing.method === body.method && body.id !== undefined) {
                s.requests.set(body.id, s.issuing)
                s.issuing.release()
                s.issuing = null
              }
            } catch {
              /* not an RPC request */
            }
          }
          try {
            const response = await privilegedFetch(request)
            if (
              !listens ||
              !response.ok ||
              !response.body ||
              !response.headers.get('content-type')?.includes('text/event-stream')
            )
              return response
            const reader = response.body.getReader()
            const disconnected = () => {
              if (!request.signal.aborted && active() && s.status.phase === 'connected')
                retry(s, true)
            }
            return new Response(
              new ReadableStream<Uint8Array>({
                async pull(controller) {
                  try {
                    const part = await reader.read()
                    if (part.done) {
                      disconnected()
                      controller.close()
                    } else controller.enqueue(part.value)
                  } catch (e) {
                    disconnected()
                    controller.error(e)
                  }
                },
                cancel: (reason) => reader.cancel(reason),
              }),
              { status: response.status, headers: response.headers },
            )
          } catch (e) {
            if (
              serverRequest &&
              !request.signal.aborted &&
              active() &&
              s.status.phase === 'connected'
            )
              retry(s, true)
            throw e
          }
        }
        s.httpFetch = handed
        if (!s.oauth) {
          const store =
            s.tokenStore ??
            createMcpTokenStore({
              secrets: host.secrets,
              identity: host.identity,
              serverId: runtime.serverId,
              ids: options.ids,
              deleting: () => s.retired || !s.runtime.consented,
              log: (line) => log(s, line),
              onIssuer: async (issuer, write) => {
                await options.onIssuer(runtime.serverId, issuer, write)
                s.oauthIssuerHash = issuer.hash
              },
            })
          s.tokenStore = store
          let oauth!: McpOAuthProvider
          oauth = createMcpOAuthProvider({
            serverId: runtime.serverId,
            serverUrl: transport.url,
            fetch: (input, init) => {
              if (!s.httpFetch) throw new McpServerUnavailableError()
              return s.httpFetch(input, init)
            },
            isActive: () => s.oauth === oauth && !s.retired && s.runtime.consented,
            requiredScope: () => s.requiredScope,
            onDiscovery: (issuer) => {
              s.cache = { ...s.cache, oauth: { issuer, discoveredAt: host.clock.now() } }
              save(s)
            },
            runtime: () => {
              if (s.runtime.transport.type !== 'http') throw new McpServerUnavailableError()
              return s.runtime.transport.oauth
            },
            identity: host.identity,
            secrets: host.secrets,
            ids: options.ids,
            store,
            currentIssuerHash: () => s.oauthIssuerHash,
            onUnauthorized: () => {
              if (s.oauth === oauth && !s.retired) {
                s.status.phase = 'unauthorized'
                s.status.loggedIn = false
                announce(s)
              }
            },
            addSecret: (secret) => s.secrets.push(secret),
          })
          s.oauth = oauth
        }
        s.status.loggedIn = (await s.oauth.tokens()) !== undefined
        connection = await connectHttpServer(
          {
            name: runtime.serverId,
            url: transport.url,
            protocol: transport.protocol,
            staticHeaders,
            fetch: handed,
            authProvider: s.oauth.authProvider,
            handshakeTimeoutMs: timeout,
            listChanged,
            log: (line) => log(s, line),
            onStreamBreak: ({ id }) => {
              const operation = s.requests.get(id)
              if (operation) {
                operation.broken = true
                operation.abort.abort(new Error('MCP response stream broke'))
              }
            },
          },
          s.controller.signal,
        )
      }
      if (!active()) {
        await connection.close()
        return
      }
      s.connection = connection
      await refresh(s)
      if (!active() || s.status.phase === 'error') return
      const text = connection.instructions ?? ''
      s.status.instructions = text ? { text, hash: sha256Hex(text) } : null
      s.cache = { ...s.cache, connectedLaunchHash: runtime.launchHash }
      if (s.status.instructions?.hash === runtime.instructions.pinHash)
        s.cache = { ...s.cache, pinnedInstructions: text }
      save(s)
      s.status.phase = 'connected'
      s.status.error = null
      s.networkAttempt = 0
      s.status.firstConnect = false
      s.status.era = connection.era ?? 'legacy'
      s.status.protocolVersion = connection.protocolVersion ?? null
      announce(s)
      void connection.exited.then(() => {
        if (active() && s.status.phase === 'connected') retry(s, runtime.transport.type === 'http')
      })
    } catch (e) {
      await connection?.close().catch(() => {})
      if (!active()) return
      if (isMcpAuthError(e)) {
        s.status.loggedIn = false
        s.status.phase = 'unauthorized'
        announce(s)
        return
      }
      const code = classify(e)
      if (s.runtime.transport.type === 'http' && s.networkAttempt > 0 && code === 'network') {
        retry(s, true)
        return
      }
      error(s, code)
    }
  }
  async function rpc<T>(
    s: ServerState,
    method: string,
    callOptions: McpCallOptions | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
    retryRead = false,
  ): Promise<T> {
    if (s.runtime.transport.type === 'stdio')
      return fn(callOptions?.signal ?? new AbortController().signal)
    const attempt = async (): Promise<T> => {
      const previous = s.sends
      let release!: () => void
      s.sends = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      const abort = new AbortController()
      const signal = callOptions?.signal
        ? AbortSignal.any([callOptions.signal, abort.signal])
        : abort.signal
      const operation = { method, abort, broken: false, release }
      s.issuing = operation
      try {
        return await fn(signal)
      } catch (e) {
        if (operation.broken && retryRead) throw new BrokenReadError()
        throw e
      } finally {
        release()
        if (s.issuing === operation) s.issuing = null
        for (const [id, pending] of s.requests) if (pending === operation) s.requests.delete(id)
      }
    }
    try {
      return await attempt()
    } catch (e) {
      if (e instanceof BrokenReadError)
        return attempt().catch((retryError) => {
          throw retryError instanceof BrokenReadError
            ? new Error('MCP response stream broke twice')
            : retryError
        })
      throw e
    }
  }
  async function refresh(s: ServerState) {
    const connection = s.connection
    if (!connection) throw new McpServerUnavailableError()
    const tools = await rpc(
      s,
      'tools/list',
      undefined,
      (signal) => connection.listTools({ signal }),
      true,
    )
    await list(s, tools, s.generation)
  }
  function wait(s: ServerState, ms: number, signal: AbortSignal): Promise<void> {
    if (!waiting(s) || signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      let clear!: () => void
      const done = () => {
        clear()
        s.listeners.delete(change)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const change = () => {
        if (!waiting(s)) done()
      }
      clear = host.clock.setTimeout(done, ms)
      s.listeners.add(change)
      signal.addEventListener('abort', done, { once: true })
    })
  }
  async function available(s: ServerState, signal?: AbortSignal): Promise<McpConnection> {
    if (waiting(s))
      await wait(
        s,
        s.status.phase === 'connecting' && s.status.firstConnect
          ? 10_000
          : s.runtime.handshakeTimeoutMs,
        signal ?? new AbortController().signal,
      )
    signal?.throwIfAborted()
    if (s.status.phase === 'unauthorized') throw new McpUnauthorizedError()
    if (s.status.phase !== 'connected' || !s.connection) throw new McpServerUnavailableError()
    return s.connection
  }
  function make(runtime: McpServerRuntime): ServerState {
    let finish!: () => void
    const exited = new Promise<{ code: null; signal: null }>((resolve) => {
      finish = () => resolve({ code: null, signal: null })
    })
    const s = {} as ServerState
    Object.assign(s, {
      runtime,
      oauth: null,
      tokenStore: null,
      httpFetch: null,
      requiredScope: undefined,
      oauthIssuerHash:
        runtime.transport.type === 'http' ? (runtime.transport.oauth.issuers.at(-1) ?? null) : null,
      status: {
        serverId: runtime.serverId,
        phase: 'stopped',
        stopReason: runtime.consented ? null : 'needs-consent',
        error: null,
        firstConnect: true,
        restartInMs: null,
        era: null,
        protocolVersion: null,
        tools: null,
        instructions: null,
        loggedIn: runtime.transport.type === 'http' ? false : null,
      },
      cache: emptyCache(),
      connection: null,
      generation: 0,
      controller: new AbortController(),
      children: new Set(),
      timer: null,
      cacheLoaded: Promise.resolve(),
      ready: Promise.resolve(),
      write: Promise.resolve(),
      raw: [],
      secrets: [],
      stderr: [],
      pinned: false,
      crashes: 0,
      lastCrash: null,
      networkAttempt: 0,
      retired: false,
      finish,
      listeners: new Set(),
      requests: new Map(),
      issuing: null,
      sends: Promise.resolve(),
    })
    const proxy: McpConnection = {
      name: runtime.serverId,
      exited,
      close: async () => {},
      get client() {
        if (!s.connection || s.status.phase !== 'connected') throw new McpServerUnavailableError()
        return s.connection.client
      },
      get serverVersion() {
        return s.connection?.serverVersion
      },
      get protocolVersion() {
        return s.connection?.protocolVersion
      },
      get era() {
        return s.connection?.era ?? 'legacy'
      },
      get instructions() {
        return s.connection?.instructions ?? ''
      },
      listTools: async () => structuredClone(s.raw),
      async callTool(name, args, q) {
        const connection = await available(s, q?.signal)
        const tool = s.raw.find((t) => t.name === name)
        if (
          tool?.outputSchema !== undefined &&
          definitionProblem({ inputSchema: {}, outputSchema: tool.outputSchema }) !== null
        )
          throw new McpServerUnavailableError(MODEL_NOTES.schemaUnusable)
        try {
          const result = await rpc(s, 'tools/call', q, (signal) =>
            connection.callTool(name, args, {
              ...q,
              signal,
              timeoutMs: s.runtime.callTimeoutMs,
              onprogress: () => {},
              resetTimeoutOnProgress: true,
              maxTotalTimeoutMs: Math.min(10 * s.runtime.callTimeoutMs, 3_600_000),
            }),
          )
          if (tool?.outputSchema !== undefined && result.structuredContent !== undefined) {
            const verdict = options.schemaValidator
              ? await options.schemaValidator.validate({
                  schema: tool.outputSchema,
                  instance: result.structuredContent,
                  signal: q?.signal ?? s.controller.signal,
                })
              : synchronousSchemaVerdict(tool.outputSchema, result.structuredContent)
            if (!verdict.ok) throw new McpInvalidOutputError()
          }
          return result
        } catch (e) {
          if (e instanceof InsufficientScopeError) s.requiredScope = e.requiredScope
          if (isMcpAuthError(e)) {
            s.status.loggedIn = false
            s.status.phase = 'unauthorized'
            announce(s)
            throw new McpUnauthorizedError()
          }
          throw e
        }
      },
      async listPrompts(q) {
        const c = await available(s, q?.signal)
        return c.listPrompts!(q)
      },
      async listResources(q) {
        const c = await available(s, q?.signal)
        return c.listResources!(q)
      },
      async getPrompt(name, args, q) {
        const c = await available(s, q?.signal)
        return rpc(
          s,
          'prompts/get',
          q,
          (signal) => c.getPrompt!(name, args, { ...q, signal }),
          true,
        )
      },
      async readResource(uri, q) {
        const c = await available(s, q?.signal)
        return rpc(s, 'resources/read', q, (signal) => c.readResource!(uri, { ...q, signal }), true)
      },
    }
    s.source = {
      serverId: runtime.serverId,
      connection: proxy,
      get rank() {
        return s.runtime.rank
      },
      review: (q) => {
        const pin = s.runtime.pins[q.originalName]
        return !s.runtime.toolsPinned || pin === q.definitionHash
          ? 'ok'
          : pin === undefined
            ? 'new'
            : 'changed'
      },
    }
    s.ready = (async () => {
      try {
        const json = String(await host.fs.readFile(path(s), { encoding: 'utf8' }))
        if (encoder.encode(json).length > 5 * 1024 * 1024) return
        const data = JSON.parse(json) as McpServerCache
        if (
          data.version === 1 &&
          Array.isArray(data.lastTools) &&
          data.lastTools.every(
            (tool) =>
              tool && typeof tool.name === 'string' && typeof tool.definitionHash === 'string',
          ) &&
          data.pinnedDefinitions !== null &&
          typeof data.pinnedDefinitions === 'object' &&
          !Array.isArray(data.pinnedDefinitions) &&
          (data.oauth === null ||
            (typeof data.oauth?.issuer === 'string' && Number.isFinite(data.oauth.discoveredAt))) &&
          (data.pinnedInstructions === null || typeof data.pinnedInstructions === 'string') &&
          (data.connectedLaunchHash === null || typeof data.connectedLaunchHash === 'string')
        )
          s.cache = data
      } catch {
        /* reconstructable cache */
      }
    })()
    s.cacheLoaded = s.ready
    return s
  }
  return {
    apply(servers) {
      if (closed) return
      for (const server of servers)
        if (server.serverId === 'builtin' || !MCP_SERVER_ID_PATTERN.test(server.serverId))
          throw new TypeError('Invalid MCP server id')
      const ids = new Set(servers.map((s) => s.serverId))
      for (const [id, s] of states)
        if (!ids.has(id)) {
          s.retired = true
          void stop(s)
          states.delete(id)
        }
      for (const runtime of servers) {
        const old = states.get(runtime.serverId)
        if (!old) {
          const s = make(runtime)
          states.set(runtime.serverId, s)
          announce(s)
          if (runtime.consented) launch(s)
        } else {
          const changed =
            old.runtime.launchHash !== runtime.launchHash ||
            (old.runtime.transport.type === 'http' &&
              runtime.transport.type === 'http' &&
              old.runtime.transport.protocol !== runtime.transport.protocol)
          const consent = old.runtime.consented
          old.runtime = runtime
          if (!runtime.consented) {
            void stop(old, 'needs-consent')
          } else if (changed || !consent) {
            resetLaunch(old, runtime)
            launch(old)
          } else {
            old.status.tools =
              old.status.tools?.map((tool) => ({
                ...tool,
                review: old.source.review!({
                  originalName: tool.originalName,
                  definitionHash: tool.definitionHash,
                }),
              })) ?? null
            const pinnedDefinitions = { ...old.cache.pinnedDefinitions }
            for (const tool of old.status.tools ?? [])
              if (runtime.pins[tool.originalName] === tool.definitionHash)
                pinnedDefinitions[tool.originalName] = tool.definition
            old.cache = {
              ...old.cache,
              pinnedDefinitions,
              pinnedInstructions:
                old.status.instructions?.hash === runtime.instructions.pinHash
                  ? old.status.instructions.text
                  : old.cache.pinnedInstructions,
            }
            save(old)
            announce(old)
          }
        }
      }
    },
    status: () => sorted().map((s) => structuredClone(s.status)),
    routes: () => sorted().map((s) => s.source),
    async tableSources(q) {
      const current = sorted()
      await Promise.all(current.map((s) => s.cacheLoaded))
      await Promise.all(current.map((s) => wait(s, q.waitMs, q.signal)))
      return {
        sources: sorted()
          .filter((s) => s.status.phase === 'connected')
          .map((s) => s.source),
        absent: sorted()
          .filter((s) => s.status.phase !== 'connected')
          .map((s) => ({
            serverId: s.runtime.serverId,
            code:
              s.status.phase === 'unauthorized'
                ? ('connector-unauthorized' as const)
                : ('connector-unavailable' as const),
            cachedTools: s.cache.lastTools.map((t) => t.name),
          })),
      }
    },
    restart(id) {
      const s = states.get(id)
      if (s?.runtime.consented) {
        s.crashes = 0
        s.lastCrash = null
        s.networkAttempt = 0
        s.status.error = null
        s.timer?.()
        s.timer = null
        launch(s)
      }
    },
    async refreshTools(id) {
      const s = states.get(id)
      if (!s) throw new McpServerUnavailableError()
      await refresh(s)
    },
    cancelLogin(id) {
      return states.get(id)?.oauth?.cancelLogin() ?? false
    },
    async login(id, ui) {
      const s = states.get(id)
      if (!s?.oauth || s.runtime.transport.type !== 'http' || !s.runtime.consented)
        return { ok: false, code: 'cancelled' }
      const generation = s.generation
      const scope = s.requiredScope
      const result = await s.oauth.login(ui)
      if (s.retired || generation !== s.generation) return { ok: false, code: 'cancelled' }
      if (result.ok) {
        if (scope === s.requiredScope) s.requiredScope = undefined
        s.status.loggedIn = true
        launch(s)
      }
      return result
    },
    async close(q) {
      closed = true
      const all = [...states.values()]
      let cancel!: () => void
      const deadline = new Promise<void>((resolve) => {
        cancel = host.clock.setTimeout(() => {
          void Promise.all(
            all.flatMap((s) => [...s.children].map((child) => child.kill('SIGKILL'))),
          ).then(() => resolve())
        }, q.deadlineMs)
      })
      await Promise.race([
        Promise.all(
          all.map(async (s) => {
            s.retired = true
            await stop(s)
            await s.ready
            await s.write
          }),
        ),
        deadline,
      ])
      cancel()
    },
  }
}
class PoolError extends Error {
  readonly code: McpErrorCode
  constructor(code: McpErrorCode) {
    super(code)
    this.code = code
  }
}
class BrokenReadError extends Error {}
function classify(e: unknown): McpErrorCode {
  if (e instanceof McpKeychainError) return 'keychain'
  if (e instanceof PoolError || e instanceof McpConnectionError) return e.code
  if (e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout) return 'handshake-timeout'
  if (e instanceof SdkHttpError && e.data?.['status'] === 429) return 'rate-limited'
  if (e instanceof TypeError) return 'network'
  return 'handshake-failed'
}

function waiting(s: ServerState): boolean {
  return s.status.phase === 'connecting' || s.status.phase === 'restarting'
}

function resetLaunch(s: ServerState, runtime: McpServerRuntime) {
  s.oauth?.cancelLogin()
  s.oauth = null
  s.oauthIssuerHash =
    runtime.transport.type === 'http' ? (runtime.transport.oauth.issuers.at(-1) ?? null) : null
  s.crashes = 0
  s.lastCrash = null
  s.networkAttempt = 0
  s.status.firstConnect = true
  s.status.error = null
}
