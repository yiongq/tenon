import { useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { APPROVAL_CLICK_GUARD_MS, reasonKey, scopeKey } from '@/lib/approval-keys'
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
  const { target } = props
  const mono = 'block whitespace-pre-wrap break-all font-mono text-ui-sm text-text-primary'
  switch (target.type) {
    case 'path':
      return <code className={mono}>{visible(target.path)}</code>
    case 'command':
      return (
        <span className="flex flex-col gap-0.5">
          <code className={mono}>{visible(target.command)}</code>
          <span className="font-sans text-micro text-text-muted">
            {t('confirm.cwd', { cwd: visible(target.cwd) })}
          </span>
        </span>
      )
    case 'search':
      return (
        <span className="flex flex-col gap-0.5">
          <code className={mono}>{visible(target.query)}</code>
          <span className="font-mono text-micro text-text-muted">{visible(target.host)}</span>
        </span>
      )
    case 'url':
      return <code className={mono}>{visible(target.url)}</code>
    case 'tool':
      // Two parts, never joined into one string: a tool's own name may hold spaces and ·.
      return (
        <span className="flex flex-col gap-0.5">
          <code className={mono}>{visible(target.serverId)}</code>
          <code className={mono}>{visible(target.toolName)}</code>
        </span>
      )
  }
}

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
  readonly input: Readonly<Record<string, unknown>>
  readonly onRespond: (decision: 'allow' | 'deny') => void
}): JSX.Element {
  const { t } = useTranslation()
  const { card } = props.pending
  const irreversible = card.reversibility === 'irreversible'
  const allowRef = useRef<HTMLButtonElement | null>(null)
  const denyRef = useRef<HTMLButtonElement | null>(null)
  const [showInput, setShowInput] = useState(card.target.type === 'tool')
  const subtask = props.pending.callKey !== props.pending.anchorCallKey
  const guarded = (): boolean => Date.now() - props.since < APPROVAL_CLICK_GUARD_MS
  const answer = (decision: 'allow' | 'deny'): void => {
    if (!guarded()) props.onRespond(decision)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      answer('deny')
    } else if (event.key === 'Enter') {
      if (irreversible) {
        // The card takes Enter from every button, 「允许」 included: here it only ever denies.
        event.preventDefault()
        answer('deny')
      } else {
        // React types `target` as the card; it is whichever element inside had focus.
        const from: EventTarget = event.target
        if (from !== event.currentTarget && from !== allowRef.current) return
        event.preventDefault()
        answer('allow')
      }
    }
  }
  const writes = card.kind === 'file' && card.reversibility !== 'read-only'
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
        const preferred = (irreversible ? denyRef : allowRef).current
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
      <div data-testid="approval-object">
        <ObjectLine target={card.target} />
      </div>
      <p className="text-ui-sm text-text-secondary" data-testid="approval-reason">
        {tx(t, reasonKey(card), visibleFacts(card.facts))}
      </p>
      {irreversible ? (
        <p className="text-ui-sm font-medium text-text-danger" data-testid="approval-irreversible">
          {t('confirm.irreversible')}
        </p>
      ) : null}
      {writes || card.target.type === 'tool' ? (
        <div>
          {card.target.type === 'tool' ? (
            <p className="text-micro text-text-muted">{t('confirm.arguments')}</p>
          ) : (
            <button
              type="button"
              className="text-micro text-text-muted underline"
              onClick={() => setShowInput((open) => !open)}
            >
              {t('confirm.showChange')}
            </button>
          )}
          {showInput ? (
            <pre
              data-testid="approval-input"
              className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-surface-0 p-2 font-mono text-micro text-text-primary"
            >
              {visible(JSON.stringify(props.input, null, 2))}
            </pre>
          ) : null}
        </div>
      ) : null}
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
          <kbd className="ml-1 text-micro text-text-muted">
            {irreversible
              ? `${t('confirm.key.enter')} ${t('confirm.key.esc')}`
              : t('confirm.key.esc')}
          </kbd>
        </Button>
        <Button
          ref={allowRef}
          size="sm"
          data-testid="approval-allow"
          onClick={() => answer('allow')}
        >
          {t('confirm.allow')}
          {irreversible ? null : (
            <kbd className="ml-1 text-micro text-text-on-accent">{t('confirm.key.enter')}</kbd>
          )}
        </Button>
      </div>
    </fieldset>
  )
}
