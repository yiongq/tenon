import type { TFunction } from 'i18next'
import type { McpServerView } from '@tenon-app/contracts'
import { visible } from './visible'

/**
 * The one line a tool call shows (spec 02 §界面范围 `ToolRow`): a sentence by tool name, with the
 * argument that says what it touches; a tool the catalogue does not name — a connector's — gets the
 * generic sentence with its name. Arguments are content: shown as they are, never as JSON, with the
 * card's escaping (②′) — a row must not read differently from the card under it.
 */
const SLOT: Readonly<Record<string, { readonly key: string; readonly arg: string } | null>> = {
  Read: { key: 'path', arg: 'file_path' },
  Write: { key: 'path', arg: 'file_path' },
  Edit: { key: 'path', arg: 'file_path' },
  Delete: { key: 'path', arg: 'file_path' },
  Bash: { key: 'command', arg: 'command' },
  Glob: { key: 'pattern', arg: 'pattern' },
  Grep: { key: 'pattern', arg: 'pattern' },
  WebSearch: { key: 'query', arg: 'query' },
  WebFetch: { key: 'url', arg: 'url' },
  Agent: { key: 'description', arg: 'description' },
  AskUserQuestion: null,
}

/** The value actually displayed in a named tool's slot, shared with answered-card comparisons. */
export function toolSlotValue(name: string, input: Readonly<Record<string, unknown>>): string {
  const slot = SLOT[name]
  const value = slot === undefined || slot === null ? undefined : input[slot.arg]
  return typeof value === 'string' ? visible(value) : ''
}

export function toolSentence(
  t: TFunction,
  name: string,
  input: Readonly<Record<string, unknown>>,
  servers: readonly Pick<McpServerView, 'displayName' | 'toolViews'>[] = [],
): string {
  if (!Object.hasOwn(SLOT, name)) {
    for (const server of servers) {
      const tool = server.toolViews.find((entry) => entry.mappedName === name)
      if (tool)
        return t('tool.generic', {
          server: visible(server.displayName),
          tool: visible(tool.originalName),
        })
    }
    return t('tool.genericMapped', { toolName: visible(name) })
  }
  const slot = SLOT[name]
  if (slot === null || slot === undefined) return t(`tool.${name}` as never)
  return String(t(`tool.${name}` as never, { [slot.key]: toolSlotValue(name, input) } as never))
}

/** The argument a queued row names (§最小审批卡「排队行」): the path or the command. */
export function toolObject(name: string, input: Readonly<Record<string, unknown>>): string {
  const slot = SLOT[name]
  const value = slot === undefined || slot === null ? undefined : input[slot.arg]
  return typeof value === 'string' ? value : name
}
