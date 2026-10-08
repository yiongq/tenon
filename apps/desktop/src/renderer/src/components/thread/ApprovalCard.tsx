import { useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  connectorCardName,
  definitionNotice,
  changeView,
  defaultButton,
  keyAnswer,
  keyHints,
  objectParts,
} from '@/lib/approval-card'
import { APPROVAL_CLICK_GUARD_MS, reasonKey, scopeKey } from '@/lib/approval-keys'
import { reversibilityScale } from '@/lib/reversibility-scale'
import { useMcp } from '@/runtime/mcp-store'
import { tx } from '@/lib/tx'
import { visible } from '@/lib/visible'
import type { PendingCard } from '@/runtime/session-store'

// The guard and the two key tables live in lib/approval-keys.ts, where a node test can reach them.
export { APPROVAL_CLICK_GUARD_MS, reasonKey, scopeKey }

type Card = PendingCard['card']

/** The question-style title, by kind and target — never words the model chose (H3). */
function titleKey(card: Card): string {
  if (card.kind === 'file') {
    return card.reversibility === 'read-only'
      ? 'confirm.title.file.read'
      : 'confirm.title.file.write'
  }
  if (card.kind === 'network') {
    return card.target.type === 'search'
      ? 'confirm.title.network.search'
      : 'confirm.title.network.url'
  }
  return card.kind === 'command' ? 'confirm.title.command' : 'confirm.title.tool'
}

/** The object line: the one thing the card is about, in full, escaped (②, ②′; E4). */
export function ObjectLine(props: { readonly target: Card['target'] }): JSX.Element {
  const { t } = useTranslation()
  const parts = objectParts(t, props.target)
  const [only] = parts
  if (parts.length === 1 && only !== undefined)
    return <code className={PART_CLASS.value}>{only.text}</code>
  return (
    <span className="flex flex-col gap-0.5">
      {parts.map((part, index) =>
        part.role === 'note' ? (
          // oxlint-disable-next-line react/no-array-index-key -- the parts are fixed per target type
          <span key={index} className={PART_CLASS.note}>
            {part.text}
          </span>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- the parts are fixed per target type
          <code key={index} className={PART_CLASS[part.role]}>
            {part.text}
          </code>
        ),
      )}
    </span>
  )
}

const PART_CLASS = {
  value: 'block whitespace-pre-wrap break-all font-mono text-ui-sm text-text-primary',
  note: 'font-sans text-micro text-text-muted',
  host: 'font-mono text-micro text-text-muted',
} as const

/** A card's facts as its sentence shows them: the same escaping as the object line (②′). */
function visibleFacts(facts: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, visible(value)]))
}

/**
 * The minimal approval card (spec 02 §最小审批卡; H3, F6, D10, E4): under the tool row it belongs to,
 * never pinned above the composer. A new card takes no focus; focus that comes to it from outside
 * lands on its default button — 「允许」, or 「拒绝」 on an irreversible card. There ⏎ anywhere in the
 * card is 「拒绝」 and only a click (or Space on 「允许」) allows; on any other card ⏎ allows from the
 * card or 「允许」, and on another button does that button's own thing.
 */
export function ApprovalCard(props: {
  readonly pending: PendingCard
  readonly since: number
  /** The call's tool as its row names it: which of a write's arguments are its change (⑤). */
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly onRespond: (decision: 'allow' | 'deny') => void
}): JSX.Element {
  const { t } = useTranslation()
  const { card } = props.pending
  const { servers } = useMcp()
  const serverName = connectorCardName(card.target, servers)
  const notice = definitionNotice(props.pending.definitionChanged)
  const allowRef = useRef<HTMLButtonElement | null>(null)
  const denyRef = useRef<HTMLButtonElement | null>(null)
  const change = changeView(card, props.toolName, props.input)
  const [showChange, setShowChange] = useState(change?.expanded === true)
  const hints = keyHints(card)
  const subtask = props.pending.callKey !== props.pending.anchorCallKey
  const guarded = (): boolean => Date.now() - props.since < APPROVAL_CLICK_GUARD_MS
  const answer = (decision: 'allow' | 'deny'): void => {
    if (!guarded()) props.onRespond(decision)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>): void => {
    // React types `target` as the card; it is whichever element inside had focus.
    const from: EventTarget = event.target
    const decision = keyAnswer(
      card,
      event.key,
      from === event.currentTarget ? 'card' : from === allowRef.current ? 'allow' : 'other',
    )
    if (decision === null) return
    // Taken from the button too: on an irreversible card ⏎ on 「允许」 denies.
    event.preventDefault()
    answer(decision)
  }
  return (
    // A card, not a control: ⏎ and Esc from its buttons bubble here, which is how ⏎ on 「允许」
    // still denies an irreversible card (§最小审批卡).
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above
    <fieldset
      tabIndex={-1}
      data-testid="approval-card"
      data-request-id={card.requestId}
      aria-label={t(titleKey(card) as never)}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        // Only focus that comes in from elsewhere by keyboard moves: focus moving inside the card,
        // coming back with the window (no related target), or put there by a click stays put.
        const from = event.relatedTarget
        if (!(from instanceof Node) || event.currentTarget.contains(from)) return
        const preferred = (defaultButton(card) === 'deny' ? denyRef : allowRef).current
        // React types `target` as the card; it is whichever element inside took focus.
        const into: Element = event.target
        if (preferred === null || into === preferred) return
        if (into.matches(':focus-visible')) preferred.focus()
      }}
      className="mt-2 flex min-w-0 flex-col gap-2 rounded-md border border-border-default bg-surface-1 p-3 font-sans"
    >
      <p className="text-ui font-medium text-text-primary" data-testid="approval-title">
        {t(titleKey(card) as never)}
      </p>
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- readonly scale is an ARIA group, not form controls
        role="group"
        aria-label={t('mcp.reversibilityScale')}
        data-testid="reversibility-scale"
        className="flex flex-wrap gap-2 text-micro"
      >
        {reversibilityScale(card.reversibility).map((cell) => (
          <span
            key={cell.value}
            aria-current={cell.current ? 'true' : undefined}
            className={cell.current ? 'font-semibold text-text-primary' : 'text-text-muted'}
          >
            {t(cell.key)}
          </span>
        ))}
      </div>
      <div data-testid="approval-object">
        <ObjectLine target={card.target} />
      </div>
      {serverName ? (
        <p data-testid="approval-server" className="break-all">
          {visible(serverName)}
        </p>
      ) : null}
      {notice ? <p data-testid="approval-definition-changed">{t(notice)}</p> : null}
      <p className="text-ui-sm text-text-secondary" data-testid="approval-reason">
        {tx(t, reasonKey(card), visibleFacts(card.facts))}
      </p>
      {card.reversibility === 'irreversible' ? (
        <p className="text-ui-sm font-medium text-text-danger" data-testid="approval-irreversible">
          {t('confirm.irreversible')}
        </p>
      ) : null}
      {change === null ? null : (
        <div>
          {change.kind === 'arguments' ? (
            <p className="text-micro text-text-muted">{t('confirm.arguments')}</p>
          ) : (
            <button
              type="button"
              data-testid="approval-change-toggle"
              aria-expanded={showChange}
              className="text-micro text-text-muted underline"
              onClick={() => setShowChange((open) => !open)}
            >
              {t('confirm.showChange')}
            </button>
          )}
          {showChange ? (
            <div data-testid="approval-input" className="mt-1 flex flex-col gap-1">
              {change.sections.map((section) => (
                <div key={section.label ?? ''} data-testid="approval-change-section">
                  {section.label === null ? null : (
                    <p className="text-micro text-text-muted" data-testid="approval-change-label">
                      {t(section.label as never)}
                    </p>
                  )}
                  <pre
                    data-testid="approval-change-text"
                    className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-surface-0 p-2 font-mono text-micro text-text-primary"
                  >
                    {section.text}
                  </pre>
                </div>
              ))}
              {change.note === null ? null : (
                <p className="text-micro text-text-muted" data-testid="approval-change-note">
                  {t(change.note as never)}
                </p>
              )}
            </div>
          ) : null}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-micro text-text-muted" data-testid="approval-scope">
          {t(scopeKey(props.pending.allowScope, card.target.type, subtask) as never)}
        </span>
        <Button
          ref={denyRef}
          variant="outline"
          size="sm"
          data-testid="approval-deny"
          onClick={() => answer('deny')}
        >
          {t('confirm.deny')}
          <kbd className="ml-1 text-micro text-text-muted" data-testid="approval-deny-keys">
            {hints.deny.map((key) => t(key as never)).join(' ')}
          </kbd>
        </Button>
        <Button
          ref={allowRef}
          size="sm"
          data-testid="approval-allow"
          onClick={() => answer('allow')}
        >
          {t('confirm.allow')}
          {hints.allow.length === 0 ? null : (
            <kbd className="ml-1 text-micro text-text-on-accent" data-testid="approval-allow-keys">
              {hints.allow.map((key) => t(key as never)).join(' ')}
            </kbd>
          )}
        </Button>
      </div>
    </fieldset>
  )
}
