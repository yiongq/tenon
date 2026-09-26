/**
 * What an inspector sees (spec 02 §挂点与会话视图): the call, and a read-only view of the session
 * computed from the tape — never accumulated in memory, and never holding a tool result's text.
 *
 * Plan step 9 declares these, because `InspectorRegistration` references them. The view is computed
 * in plan step 12; its fields only ever grow.
 */
import type { Reversibility } from '../host/adapter.js'
import type { ToolTableItem } from '../tools/registry.js'

export interface InspectedCall {
  readonly tool: Pick<ToolTableItem, 'name' | 'source' | 'originalName'> // §内置工具与工具来源
  readonly args: Readonly<Record<string, unknown>>
  readonly reversibility: Reversibility // host 判定（E1）
}

export interface BeforeCallInput {
  readonly call: InspectedCall
  readonly view: SessionView
}

export interface SessionView {
  readonly firstUserText: string // 你最初的请求：第一条真人 message/user 的文本块；子会话里为 ''
  readonly recentUserTexts: readonly string[] // 最近几条真人 message/user 的文本块，旧→新；暂取 8 条，待校准
  readonly nonReadOnlyCalls: readonly {
    readonly toolName: string
    readonly reversibility: Reversibility
  }[] // 已派发、可逆性不是 read-only 的调用
  readonly untrustedSources: readonly string[] // 结果来自不可信来源的工具名，去重；02 里只可能是 WebSearch、WebFetch
  readonly touchedPrivateData: boolean // 定义见 §外带检查
  readonly fetchUrlVouched?: boolean // 只在 WebFetch 调用时有：URL 出现在本会话真人 message/user 里，或在本会话 WebSearch 结果的 searchHitUrls 里；子会话只算父、子两边的 searchHitUrls
}

export interface AfterResultInput {
  readonly call: InspectedCall
  readonly result: { readonly isError: boolean; readonly bytes: number; readonly text?: string } // text 只给 WebSearch、WebFetch
}

export interface ResultMarker {
  readonly code: string // 例：'looks-like-injection'、'private-data'
}
