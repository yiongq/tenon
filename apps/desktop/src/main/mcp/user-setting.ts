import type { McpServer } from '@tenon-app/contracts'
import type { McpServerStatus, ToolKey, UserToolSetting } from '@tenon-app/kernel'
export function mcpUserSetting(
  servers: () => readonly McpServer[],
  status: () => readonly McpServerStatus[],
) {
  return (key: ToolKey): UserToolSetting | null => {
    if (key.serverId === 'builtin') return null
    const server = servers().find((s) => s.id === key.serverId)
    if (!server?.enabled) return { connectorOff: true }
    const setting = server.tools[key.toolName]
    if (setting?.setting === 'never') return { userSetting: 'never' }
    const tools = status().find((s) => s.serverId === key.serverId)?.tools
    const live = tools?.find((t) => t.originalName === key.toolName)
    const changed =
      key.definitionHash !== undefined &&
      tools != null &&
      live?.definitionHash !== key.definitionHash
    if (setting?.setting === 'always-allow') {
      if (
        key.definitionHash !== undefined &&
        setting.definitionHash === key.definitionHash &&
        !changed
      )
        return { userSetting: 'always-allow' }
      return { userSetting: 'ask', definitionChanged: true }
    }
    return { userSetting: 'ask', ...(changed ? { definitionChanged: true } : {}) }
  }
}
