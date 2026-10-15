import type { McpDraft, McpServerView, McpWarning } from '@tenon-app/contracts'
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

export function secretNames(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value)
      ? [...new Set(value.filter((v): v is string => typeof v === 'string'))]
      : []
  } catch {
    return []
  }
}
export function enteredSecrets(names: readonly string[], values: Readonly<Record<string, string>>) {
  return Object.fromEntries(names.flatMap((name) => (values[name] ? [[name, values[name]]] : [])))
}

/**
 * A grant warning as two kinds of text (03 acceptance 46; 02 E4): the sentence, interface copy that
 * must fit on its line, and what it quotes — an argument, a package, an environment variable — which
 * is content and may wrap. `content` is null for a warning that quotes nothing (sudo, rm -rf).
 */
export function warningParts(warning: McpWarning): {
  readonly key: `mcp.warning.${McpWarning['kind']}`
  readonly slot: 'arg' | 'package' | 'name' | null
  readonly content: string | null
} {
  const key = `mcp.warning.${warning.kind}` as const
  if ('arg' in warning) return { key, slot: 'arg', content: visible(warning.arg) }
  if ('package' in warning) return { key, slot: 'package', content: visible(warning.package) }
  if ('name' in warning) return { key, slot: 'name', content: visible(warning.name) }
  return { key, slot: null, content: null }
}

/**
 * The catalogue's sentence around one placeholder, as the text before and after it: the message is
 * formatted with `marker` in the placeholder's place and cut there, so the copy keeps its own word
 * order in each language. A message without the marker is all `before`.
 */
export function splitAtMarker(message: string, marker: string): { before: string; after: string } {
  const at = message.indexOf(marker)
  return at < 0
    ? { before: message, after: '' }
    : { before: message.slice(0, at), after: message.slice(at + marker.length) }
}
