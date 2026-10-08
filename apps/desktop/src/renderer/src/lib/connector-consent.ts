import type { McpDraft, McpServerView } from '@tenon-app/contracts'
import { visible } from './visible'
export function grantArgv(argv: readonly string[]) {
  return argv.map(visible)
}
export const GRANT_BUTTONS = ['cancel', 'persistent', 'run'] as const
export const GRANT_DEFAULT = 'cancel' as const
export function grantResult(choice: (typeof GRANT_BUTTONS)[number]) {
  return choice === 'cancel' ? null : choice
}
export function launchChanged(server: McpServerView | undefined, draft: McpDraft) {
  if (!server) return true
  return JSON.stringify(fields(server.transport)) !== JSON.stringify(fields(draft.transport))
}

const fields = (t: McpDraft['transport']) =>
  t.type === 'http'
    ? { type: t.type, url: t.url }
    : {
        type: t.type,
        command: t.command,
        args: t.args,
        envs: Object.fromEntries(
          Object.entries(t.envs).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
        env_keys: [...t.env_keys].toSorted(),
      }

/** Values for secrets are deliberately not accepted by the preview's display model. */
export function grantEnvironment(transport: McpDraft['transport']) {
  return transport.type === 'stdio'
    ? {
        plain: Object.entries(transport.envs).map(([name, value]) => visible(name + '=' + value)),
        keys: transport.env_keys,
      }
    : { plain: [], keys: transport.header_keys }
}
export function resolvedCopy(path: string | null) {
  return path
    ? { key: 'mcp.resolved' as const, args: { path: visible(path) } }
    : { key: 'mcp.commandMissing' as const, args: {} }
}
