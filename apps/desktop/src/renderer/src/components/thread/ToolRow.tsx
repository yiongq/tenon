import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import type { ToolOutcomeViewContract } from '@tenon-app/contracts'
import { useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { categoryOf } from '@/lib/approval-keys'
import { toolObject, toolSentence } from '@/lib/tool-sentence'
import { tx } from '@/lib/tx'
import { visible } from '@/lib/visible'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'
import type { Answered, SessionSnapshot } from '@/runtime/session-store'
import { ApprovalCard, ObjectLine, scopeKey } from './ApprovalCard'

/** The four block codes (§原因码表): they get a `BlockedNotice`, not a closure line. */
const BLOCK_CODES: ReadonlySet<string> = new Set([
  'policy',
  'user-disabled',
  'protected',
  'inspector',
])

/**
 * One tool call, one line of plain words (spec 02 §界面范围 `ToolRow`; H3): a sentence by tool name,
 * a connector tool's generic one with its name. Expanded, its input and output as plain text — a
 * tool result is untrusted content, and JSON never shows by default. A call that did not complete
 * says why, by its closure code; a blocked one carries the `BlockedNotice`; the card waiting on it
 * hangs below it, with the batch's later calls queued under the card.
 */
export function ToolRow(props: ToolCallMessagePartProps): JSX.Element | null {
  const { t } = useTranslation()
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  const [open, setOpen] = useState(false)
  const callKey = props.toolCallId
  const input = (props.args ?? {}) as Readonly<Record<string, unknown>>
  const outcome = (props.result ?? null) as ToolOutcomeViewContract | null
  const pending =
    snapshot.pending?.waitKind === 'approval' && snapshot.pending.anchorCallKey === callKey
      ? snapshot.pending
      : null
  const answered: Answered | null =
    snapshot.answered.get(callKey) ??
    (outcome?.approval !== undefined &&
    (outcome.approval.outcome === 'allowed' || outcome.approval.outcome === 'denied')
      ? {
          outcome: outcome.approval.outcome,
          scope: outcome.approval.scope,
          target: outcome.approval.target,
          subtask: false,
        }
      : null)
  const blocked = outcome !== null && outcome.source !== null && BLOCK_CODES.has(outcome.source)
  // A later call of the batch while a card waits: it is the queued row under that card, not a row
  // of its own saying it runs (§最小审批卡「排队行」).
  if (outcome === null && queuedBehindCard(snapshot, callKey)) return null
  // A call a deny closed without a card of its own «did not run»; the one denied says so itself.
  const closureKey =
    outcome?.source === 'user-rejected' &&
    outcome.approval === undefined &&
    snapshot.answered.get(callKey)?.outcome !== 'denied'
      ? 'confirm.notRun'
      : `closure.${String(outcome?.source)}`
  return (
    <div data-testid="tool-row" data-call-key={callKey} className="my-2 font-sans text-ui-sm">
      <button
        type="button"
        data-testid="tool-row-line"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="flex w-full items-baseline gap-2 text-left text-text-secondary"
      >
        <span className="min-w-0 break-words">{toolSentence(t, props.toolName, input)}</span>
        {outcome === null && pending === null ? (
          <span className="shrink-0 text-micro text-text-muted">{t('tool.running')}</span>
        ) : null}
      </button>
      {outcome !== null && outcome.state !== 'completed' && outcome.source !== null && !blocked ? (
        <p data-testid="tool-row-closure" className="text-micro text-text-muted">
          {t(closureKey as never)}
        </p>
      ) : null}
      {blocked && outcome !== null ? (
        <BlockedNotice
          outcome={outcome}
          toolName={props.toolName}
          profile={snapshot.facts?.profile ?? 'chat'}
        />
      ) : null}
      {open ? (
        <div className="mt-1 flex flex-col gap-1" data-testid="tool-row-details">
          <p className="text-micro text-text-muted">{t('tool.input')}</p>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-surface-1 p-2 font-mono text-micro text-text-primary">
            {/* Each argument escaped on its own, so the newline between two of them is a plain
                line break and only a newline inside one shows the mark (E4). */}
            {Object.entries(input)
              .map(
                ([key, value]) =>
                  `${key}: ${visible(typeof value === 'string' ? value : JSON.stringify(value))}`,
              )
              .join('\n')}
          </pre>
          {/* A call that never ran has no output: what its result holds is the kernel's note to the
              model, in English, which the closure line above already says in the interface's words. */}
          {outcome === null || outcome.state === 'not-run' ? null : (
            <>
              <p className="text-micro text-text-muted">{t('tool.output')}</p>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-surface-1 p-2 font-mono text-micro text-text-primary">
                {outcome.output}
              </pre>
            </>
          )}
        </div>
      ) : null}
      {answered === null ? null : <AnsweredRow answered={answered} />}
      {pending === null ? null : (
        <>
          {/* A new requestId is a new card (§最小审批卡「数据」): it mounts afresh, with no focus or
              expanded change carried over from the card it replaced. */}
          <ApprovalCard
            key={pending.card.requestId}
            pending={pending}
            since={snapshot.pendingSince}
            input={input}
            onRespond={(decision) => void store.respond(decision)}
          />
          <QueuedRows callKey={pending.callKey} />
        </>
      )}
    </div>
  )
}

/** The call's facts with the card's escaping (②′): a path in the notice reads as it will run. */
function visibleFacts(facts: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(facts).map(([key, value]) => [
      key,
      typeof value === 'string' ? visible(value) : value,
    ]),
  )
}

/** Whether a call waits, unanswerable, behind the card an earlier call of its batch holds (F6). */
function queuedBehindCard(snapshot: SessionSnapshot, callKey: string): boolean {
  const pending = snapshot.pending
  if (pending?.waitKind !== 'approval') return false
  const turn = snapshot.model.turns.find((candidate) =>
    candidate.parts.some((part) => part.kind === 'tool' && part.callKey === callKey),
  )
  if (turn === undefined) return false
  const keys = turn.parts.flatMap((part) => (part.kind === 'tool' ? [part.callKey] : []))
  const anchor = keys.indexOf(pending.anchorCallKey)
  return anchor >= 0 && keys.indexOf(callKey) > anchor
}

/** What a blocked call shows (§界面范围 `BlockedNotice`): what, why, and that the model was told. */
function BlockedNotice(props: {
  readonly outcome: ToolOutcomeViewContract
  readonly toolName: string
  readonly profile: 'chat' | 'cowork'
}): JSX.Element {
  const { t } = useTranslation()
  const facts = props.outcome.facts ?? {}
  // In a chat, Read beyond this chat's saved files is `protected` with a sentence of its own; an
  // inspector's block says what it found, by category, as the card does.
  const key =
    props.profile === 'chat' && props.outcome.source === 'protected' && facts['toolName'] === 'Read'
      ? 'blocked.chatReadScope'
      : props.outcome.source === 'inspector'
        ? `blocked.inspector.${categoryOf(facts)}`
        : `blocked.${String(props.outcome.source)}`
  return (
    <div
      data-testid="blocked-notice"
      data-source={props.outcome.source}
      className="mt-1 rounded-sm border border-border-subtle px-2 py-1 text-micro text-text-warning"
    >
      <p>{tx(t, key, visibleFacts({ toolName: props.toolName, ...facts }))}</p>
      <p className="text-text-muted">{t('blocked.told')}</p>
    </div>
  )
}

/** An answered card, collapsed to one line: result, scope, object (§最小审批卡「答完」). */
function AnsweredRow(props: { readonly answered: Answered }): JSX.Element {
  const { t } = useTranslation()
  const { answered } = props
  return (
    <div
      data-testid="approval-answered"
      data-outcome={answered.outcome}
      className="mt-1 flex flex-col gap-0.5 rounded-sm bg-surface-1 px-2 py-1 text-micro text-text-secondary"
    >
      <span>
        {answered.outcome === 'allowed'
          ? t('confirm.answered.allowed', {
              scope: t(scopeKey(answered.scope, answered.target.type, answered.subtask) as never),
            })
          : t('confirm.answered.denied')}
      </span>
      <ObjectLine target={answered.target} />
    </div>
  )
}

/** The batch's later calls, one queued row each, under the card; they cannot be answered (F6). */
function QueuedRows(props: { readonly callKey: string }): JSX.Element | null {
  const { t } = useTranslation()
  const snapshot = useSessionSnapshot()
  const turn = snapshot.model.turns.find((candidate) =>
    candidate.parts.some((part) => part.kind === 'tool' && part.callKey === props.callKey),
  )
  if (turn === undefined) return null
  const tools = turn.parts.flatMap((part) => (part.kind === 'tool' ? [part] : []))
  const after = tools.slice(tools.findIndex((part) => part.callKey === props.callKey) + 1)
  const waiting = after.filter((part) => part.outcome === null)
  if (waiting.length === 0) return null
  return (
    <ul className="mt-1 flex flex-col gap-1" data-testid="approval-queued">
      {waiting.map((part) => (
        <li
          key={part.callKey}
          data-testid="approval-queued-row"
          className="flex items-baseline gap-2 rounded-sm border border-border-subtle px-2 py-1 text-micro text-text-muted"
        >
          <span className="min-w-0 break-all font-mono">
            {visible(toolObject(part.name, part.input))}
          </span>
          <span className="shrink-0">{t('queue.queued')}</span>
        </li>
      ))}
    </ul>
  )
}
