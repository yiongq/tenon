/**
 * Search backends (spec 02 §工具形状与后端选择, §依赖方向与能力入口).
 *
 * Plan step 9 declares the shapes, because `RunAssembly.search` references `SearchBackend`. The two
 * backends arrive in plan step 28 and do not change them. A backend is constructed by the host, the
 * same way a provider is, and reaches the network only through `network.fetch`.
 */
import type { HostNetwork } from '../../host/adapter.js'

export interface SearchBackendDefinition {
  readonly id: 'zhipu' | 'anthropic'
  create(args: { network: HostNetwork; secrets: Record<string, string> }): SearchBackend
}

export interface SearchBackend {
  readonly host: 'open.bigmodel.cn' | 'api.anthropic.com' // 审批卡的 network.host，也是 ConfirmTarget { type: 'search' } 里的 host
  readonly domainFilter: boolean // false 时 WebSearch 的 schema 不带两个域名参数
  /** 同步纯函数，kernel 在判权限之前调用。智谱截到 70 个码点；Anthropic 原样返回 */
  prepareQuery(query: string): { query: string; truncated: boolean }
  /** query 只收 prepareQuery 的产物 */
  search(req: {
    query: string
    allowedDomains?: string[]
    blockedDomains?: string[]
    signal: AbortSignal
  }): Promise<SearchOutcome>
}

export interface SearchHit {
  title: string
  url: string | null
  snippet?: string
  publishedAt?: string
}

export type SearchOutcome =
  | { ok: true; hits: SearchHit[] }
  | { ok: false; code: string; message: string } // 一律作为 is_error 结果交给模型，不抛
