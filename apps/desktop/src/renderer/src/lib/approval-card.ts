import type { ConfirmRequestInput } from '@tenon-app/contracts'
import type { TFunction } from 'i18next'
import { visible } from './visible'

/**
 * What the minimal approval card shows and how its keys answer (spec 02 §最小审批卡; H3, D10, E4),
 * out of ApprovalCard.tsx so a node test can reach it: the component only lays these out.
 */
type Card = Pick<ConfirmRequestInput, 'kind' | 'reversibility' | 'target'>
type Target = Card['target']

/**
 * ② One part of the object line, each on its own line and never joined into one string: `value` in
 * the monospace of the object itself, `note` (the command's cwd) and `host` (the search backend)
 * under it, smaller. Every part is escaped (②′).
 */
export interface ObjectPart {
  readonly text: string
  readonly role: 'value' | 'note' | 'host'
}

export function objectParts(t: TFunction, target: Target): readonly ObjectPart[] {
  switch (target.type) {
    case 'path':
      return [{ text: visible(target.path), role: 'value' }]
    case 'command':
      return [
        { text: visible(target.command), role: 'value' },
        { text: t('confirm.cwd', { cwd: visible(target.cwd) }), role: 'note' },
      ]
    case 'search':
      return [
        { text: visible(target.query), role: 'value' },
        { text: visible(target.host), role: 'host' },
      ]
    case 'url':
      return [{ text: visible(target.url), role: 'value' }]
    case 'tool':
      // A connector ID and the tool's own name, two parts: the name may hold spaces and 「·」.
      return [
        { text: visible(target.serverId), role: 'value' },
        { text: visible(target.toolName), role: 'value' },
      ]
  }
}

/** ⑤ One block of the change: a label (a catalogue key) over the text, or the text alone. */
export interface ChangeSection {
  readonly label: string | null
  readonly text: string
}

/**
 * ⑤ What the card can show of the call's `input`: a write's change, collapsed behind 「展开改动」 until
 * asked for; a connector call's arguments, expanded from the start (open question 15). Plain text,
 * escaped as ②′ escapes: a Write's content, an Edit's `old_string` and `new_string` each under its
 * label (and a note when `replace_all` is set); a connector's arguments as the JSON it sends. Null for
 * a card with nothing of the kind — a read, a command (its object line is the whole command), a
 * search or a fetch.
 */
export interface ChangeView {
  readonly kind: 'change' | 'arguments'
  readonly expanded: boolean
  readonly sections: readonly ChangeSection[]
  /** A catalogue key for a line under the sections, or null. */
  readonly note: string | null
}

export function changeView(
  card: Card,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): ChangeView | null {
  if (card.target.type === 'tool') {
    const text = visible(JSON.stringify(input, null, 2))
    return { kind: 'arguments', expanded: true, sections: [{ label: null, text }], note: null }
  }
  if (card.kind !== 'file' || card.reversibility === 'read-only') return null
  if (toolName === 'Write') {
    return change([{ label: null, text: textOf(input['content']) }], null)
  }
  if (toolName === 'Edit') {
    return change(
      [
        { label: 'confirm.change.old', text: textOf(input['old_string']) },
        { label: 'confirm.change.new', text: textOf(input['new_string']) },
      ],
      input['replace_all'] === true ? 'confirm.change.replaceAll' : null,
    )
  }
  // Write and Edit are the only file tools that write (FILE_TOOL_NAMES).
  return null
}

function change(sections: readonly ChangeSection[], note: string | null): ChangeView {
  return { kind: 'change', expanded: false, sections, note }
}

/** An argument as plain text, escaped (②′); a missing or non-string one as nothing. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? visible(value) : ''
}

/**
 * ⑥ The button focus lands on when it comes into the card (§最小审批卡「按键」): 「拒绝」 on an
 * irreversible card, 「允许」 on any other — a connector's included.
 */
export function defaultButton(card: Pick<Card, 'reversibility'>): 'allow' | 'deny' {
  return card.reversibility === 'irreversible' ? 'deny' : 'allow'
}

/** ⑥ The key hints beside each button, as catalogue keys: 「拒绝 ⏎ Esc」「允许」 when irreversible. */
export function keyHints(card: Pick<Card, 'reversibility'>): {
  readonly deny: readonly string[]
  readonly allow: readonly string[]
} {
  return card.reversibility === 'irreversible'
    ? { deny: ['confirm.key.enter', 'confirm.key.esc'], allow: [] }
    : { deny: ['confirm.key.esc'], allow: ['confirm.key.enter'] }
}

/**
 * What a key pressed inside the card answers, by where the focus was: the card itself, 「允许」, or
 * another element in it (「拒绝」, the change toggle). Null leaves the key to that element. Esc denies.
 * On an irreversible card ⏎ denies from anywhere, 「允许」 included — only a click or Space there
 * allows, and Space is the button's own; on any other card ⏎ allows from the card or 「允许」.
 */
export function keyAnswer(
  card: Pick<Card, 'reversibility'>,
  key: string,
  from: 'card' | 'allow' | 'other',
): 'allow' | 'deny' | null {
  if (key === 'Escape') return 'deny'
  if (key !== 'Enter') return null
  if (card.reversibility === 'irreversible') return 'deny'
  return from === 'other' ? null : 'allow'
}

/** The connector may have been deleted since the frozen call was assembled. */
export function connectorCardName(
  target: Target,
  servers: readonly { id: string; displayName: string }[],
): string | null {
  return target.type === 'tool' && target.serverId !== 'builtin'
    ? (servers.find((s) => s.id === target.serverId)?.displayName ?? target.serverId)
    : null
}
export function definitionNotice(changed: boolean | undefined) {
  return changed ? ('mcp.definitionNotice' as const) : null
}
