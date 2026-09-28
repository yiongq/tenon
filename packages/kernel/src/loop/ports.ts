/**
 * The loop's ports (spec 02 §主进程与 kernel 的循环接口). The loop belongs to the kernel — one serial
 * point per root session (the mailbox), at most one live lease — and these are the only ways it
 * reaches the host.
 *
 * `RunConnector` enters through `SessionServiceOptions.connector` (01 修补 6), because a Run the
 * kernel opens itself (a resume, an auto-send, a sub-agent, collecting a handoff) has no route to
 * hand it an instance. Everything else is the host's run-time state and enters through
 * `SessionService.bindLoop`, so the loop's shape is not frozen into 01's constructor.
 *
 * Frozen from plan step 9 (M1): after ①, a host-implemented port (`RunConnector`, `LoopPorts`,
 * `RunLease`) only gains OPTIONAL members (open question 26).
 */
import type { McpConnection } from '../mcp/connection.js'
import type { ModelInfo, Provider, ProviderId } from '../provider/types.js'
import type { CommandShell } from '../tools/builtin/bash.js'
import type { SearchBackend } from '../tools/search/types.js'
import type { SessionEvent } from './events.js'

export type CapabilitySource = 'builtin' | 'user' | 'synthesized'

export interface ModelChoice {
  readonly providerId: ProviderId
  readonly modelId: string
  readonly effort: string | null
  readonly capabilitySource: CapabilitySource
}

export interface RunConnector {
  // desktop 的 run-assembly.ts 实现
  /** 同步、不读密钥：同批写 session/model_selected 时用（§执行日志与恢复表 同批规则 2、3） */
  endpointOrigin(providerId: ProviderId): string | null
  /** Pure current-config target for paused search approval, without reading credentials. */
  searchTarget?(
    providerId: ProviderId,
    query: string,
  ): {
    readonly host: SearchBackend['host']
    readonly query: string
    readonly truncated: boolean
  } | null
  /** 五层的 ②–⑤ 加数据去向检查（§模型选择）；① 由 kernel 从 Tape 读出传入。不读密钥。
   *  数据去向检查只在 sessionChoice 为 null（选择来自 ②–⑤）时做，① 已在菜单里确认过 */
  resolveChoice(q: {
    sessionId: string
    profile: 'chat' | 'cowork'
    sessionChoice: ModelChoice | null
    previousOrigin: string | null
  }): Promise<ModelChoice | { needsConfirm: { host: string } }>
  /** 只在 mailbox 之外调；配置问题不 reject：provider 留到 provider() 再抛，搜索后端给 null。
   *  signal 是本 Run 租约的；中止之后 Run 不等它 resolve（钥匙串弹框可能一直不答） */
  assemble(q: {
    sessionId: string
    rootSessionId: string
    choice: ModelChoice
    signal: AbortSignal
  }): Promise<RunAssembly>
}

export interface RunAssembly {
  readonly model: ModelInfo // 只用于新一轮；续跑取 Tape 冻结的 view/content(model_info)（A3、不变量 33）
  readonly capabilitySource: CapabilitySource
  readonly endpointOrigin: string
  readonly maxTokens: number
  readonly toolsWithheld: 'provider-text-only' | null // Ollama 范围规则（A14）；值与 ToolsWithheldPayload.reason 同名
  readonly search: SearchBackend | null // Run 开始就建好；null 即 no-search-backend（§搜索与抓取）
  readonly mcpSources: readonly McpToolSource[] // 阶段 2 只有 kernel 测试的 Everything 夹具（H4）
  provider(): Provider // 缺 key、主机不符抛 ProviderConfigMissingError
}

export interface McpToolSource {
  readonly serverId: string
  readonly connection: McpConnection
}

export interface LoopPorts {
  // 经 SessionService.bindLoop 交入
  readonly queue: {
    // desktop 的 queue.ts：主进程内存，退出即丢（H13、B4）
    enqueue(
      root: string,
      text: string,
      o: { urgent: boolean },
    ): Promise<{ queuedId: string; seq: number }>
    peek(root: string): Promise<readonly QueuedMessage[]>
    /** 取走即删；给了 queuedId 只取这一项 */
    take(
      root: string,
      o: { upToSeq: number | null; urgentOnly: boolean; queuedId?: string },
    ): Promise<readonly QueuedMessage[]>
    /** 放回取走、最后没发出的项，按原 seq 排，urgent 按交入的值存 */
    restore(root: string, items: readonly QueuedMessage[]): Promise<void>
  }
  /** 同步；拒绝码只增 */
  readonly leases: {
    begin(q: {
      rootSessionId: string
      origin: RunOrigin | null
    }): RunLease | { refused: 'shutting-down' }
  }
  readonly events: (e: SessionEvent) => void // 同步；抛错只进 log
  readonly locale: (q: { sessionId: string }) => 'zh-CN' | 'en' // 只在组装 system 时读（§提示层：范围、位置、版本与组装）
  readonly localDate: (q: { sessionId: string }) => string // YYYY-MM-DD，用户本地时区的今天；只在写 message/environment 时读（开放问题 16）
  readonly commandShell: CommandShell // Bash 的 shell 与基础环境，desktop 算好（§内置工具与参数「Bash」；开放问题 17）
}

/** desktop 的 RunRegistry 实现；stopRequested：收到过 abort('user-stop')，不论是不是第一个原因 */
export interface RunLease {
  readonly signal: AbortSignal
  readonly stopRequested: boolean
  abort(cause: RunAbortCause): void
  finish(): void
}

export interface QueuedMessage {
  readonly queuedId: string
  readonly seq: number
  readonly text: string
  readonly urgent: boolean
}

/** desktop 传发起它的 webContents，kernel 只原样交回 */
export type RunOrigin = object

/** Given by whoever aborts; the kernel reads it off `signal.reason` (§进行中、暂停与 RunRegistry). */
export type RunAbortCause =
  | 'user-stop' // chat.stop（停止钮、离开确认里的「停止任务」）；「立即发送」打断当前 Run（H13）
  | 'quit' // before-quit 里确认停止；before-quit-for-update（自动更新）
  | 'close-window' // 窗口 close 里确认停止；watchOwner（文档被销毁，或主框架换了文档）
