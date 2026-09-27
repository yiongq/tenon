import type { TFunction } from 'i18next'
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
  Bash: { key: 'command', arg: 'command' },
  Glob: { key: 'pattern', arg: 'pattern' },
  Grep: { key: 'pattern', arg: 'pattern' },
  WebSearch: { key: 'query', arg: 'query' },
  WebFetch: { key: 'url', arg: 'url' },
  Agent: { key: 'description', arg: 'description' },
  AskUserQuestion: null,
}

export function toolSentence(
  t: TFunction,
  name: string,
  input: Readonly<Record<string, unknown>>,
): string {
  if (!Object.hasOwn(SLOT, name)) return t('tool.generic', { toolName: visible(name) })
  const slot = SLOT[name]
  if (slot === null || slot === undefined) return t(`tool.${name}` as never)
  const value = input[slot.arg]
  return String(
    t(
      `tool.${name}` as never,
      { [slot.key]: typeof value === 'string' ? visible(value) : '' } as never,
    ),
  )
}

/** The argument a queued row names (§最小审批卡「排队行」): the path or the command. */
export function toolObject(name: string, input: Readonly<Record<string, unknown>>): string {
  const slot = SLOT[name]
  const value = slot === undefined || slot === null ? undefined : input[slot.arg]
  return typeof value === 'string' ? value : name
}
