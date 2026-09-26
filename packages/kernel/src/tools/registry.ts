/**
 * The tool registry (spec 02 §工具来源、命名与权限键): where tools come from, and the name each
 * one goes to a provider under.
 *
 * Plan step 9 declares `ToolTableItem`, which `InspectedCall` (§挂点与会话视图) references, and the
 * reserved builtin server id. The registry itself — sources, name mapping, the per-request cap —
 * arrives in plan step 10 and does not change the shape.
 */
import type { ToolSpec } from '../provider/types.js'
import type { ToolOrigin } from '../tape/entry.js'

/** The `ToolOrigin.serverId` of the builtin tools. Reserved: phase 3's server config refuses it. */
export const BUILTIN_SERVER_ID = 'builtin'

export interface ToolTableItem extends ToolOrigin {
  name: string // 发给 provider 的名字，满足 ^[a-zA-Z0-9_-]{1,64}$；内置工具 === originalName
  spec: ToolSpec // spec.name === name
  requiresUserInteraction: boolean // 裁决 D12；内置工具恒为 false
}
// provider 服务端执行的 MCP 不在 source 里，要用时只增一个值
