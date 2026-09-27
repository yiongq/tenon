import { useAuiState } from '@assistant-ui/react'
import type { RunEndReasonContract } from '@tenon-app/contracts'
import { useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { ProviderSettings } from '@/components/settings/ProviderSettings'
import { Button } from '@/components/ui/button'
import { cardOf, effectLineOf } from '@/lib/end-card'
import type { EndVisual } from '@/lib/end-card'
import { toolSentence } from '@/lib/tool-sentence'
import { tx } from '@/lib/tx'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'
import type { SessionSnapshot } from '@/runtime/session-store'
import type { ChatErrorCode, ToolPart, Turn } from '@/runtime/thread-model'
import type { TurnCustom } from '@/runtime/to-thread-messages'

// The table itself (§失败卡与结束原因) is lib/end-card.ts, where a node test can reach it.
export { cardOf }

/**
 * The slots of an end reason's sentence: its own fields, nothing more (§结束原因词表); a reset time in
 * the interface's language, not the system's.
 */
function slotsOf(reason: RunEndReasonContract, locale: string): Record<string, unknown> {
  const { code: _code, ...fields } = reason as RunEndReasonContract & Record<string, unknown>
  if (reason.code === 'quota-exhausted') {
    const resetAt = (fields as { resetAt?: number | null }).resetAt
    return {
      ...fields,
      resetAt: resetAt == null ? 'unknown' : new Date(resetAt).toLocaleString(locale),
    }
  }
  return fields
}

const VISUAL_CLASS: Readonly<Record<EndVisual, string>> = {
  neutral: 'border-border-default text-text-secondary',
  danger: 'border-text-danger text-text-danger',
  warning: 'border-text-warning text-text-warning',
}

/**
 * Under a Run's last assistant turn: the summary line (what the round's calls did — read, changed,
 * sent out, from the last user message on, over every Run of the round) and, when the end calls for
 * it, the failure card's three lines: what happened, what it already did, one action.
 */
export function RunEndCard(): JSX.Element | null {
  const custom = useAuiState((s) => s.message.metadata.custom) as unknown as TurnCustom | undefined
  const end = custom?.end
  if (end === undefined) return null
  return (
    <>
      {custom?.summary === undefined ? null : <SummaryLine summary={custom.summary} />}
      {end.endReason === null ? (
        end.errorCode === null ? null : (
          <MessageError code={end.errorCode} turnId={custom?.turnId ?? ''} />
        )
      ) : (
        <FailureCard
          reason={end.endReason}
          runId={end.runId}
          retryOf={end.retryOf}
          turnId={custom?.turnId ?? ''}
        />
      )}
    </>
  )
}

const ERROR_KEY = {
  network: 'error.network',
  auth: 'error.auth',
  'rate-limit': 'error.rate-limit',
  provider: 'error.provider',
  unknown: 'error.unknown',
} as const satisfies Record<ChatErrorCode, string>

/**
 * Whether an end's action no longer applies (§重试与「继续」): anything came after it — a message, a
 * later Run's reply or end — or a Run is in progress. 「继续」 and 「重试」 act on the conversation as
 * it stands at this end; 「重试」 also waits while messages are queued, which would go out ahead of
 * the resend and make it a second copy.
 */
function superseded(snapshot: Pick<SessionSnapshot, 'model' | 'running'>, index: number): boolean {
  return snapshot.running || index + 1 < snapshot.model.turns.length
}

function queueWaits(snapshot: Pick<SessionSnapshot, 'queue' | 'held'>): boolean {
  return snapshot.queue.length > 0 || snapshot.held !== null
}

/**
 * An error that is not a Run's end — the send itself failed, so there is no `endReason` — shows as
 * in phase 1, by its code (§失败卡与结束原因 ①): the sentence, and 「重试」 sending that message again
 * while nothing came after it.
 */
function MessageError(props: {
  readonly code: ChatErrorCode
  readonly turnId: string
}): JSX.Element {
  const { t } = useTranslation()
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  const index = snapshot.model.turns.findIndex((turn) => turn.id === props.turnId)
  // The message it failed to send: the one just above this end.
  const sent = snapshot.model.turns.slice(0, index).findLast((turn) => turn.role === 'user')
  const canRetry =
    index >= 0 && sent !== undefined && !superseded(snapshot, index) && !queueWaits(snapshot)
  return (
    <div
      role="alert"
      data-testid="message-error"
      data-error-code={props.code}
      className="mt-2 flex w-full items-center justify-between gap-3 rounded-sm border border-text-danger px-3 py-2 font-sans text-ui-sm text-text-danger"
    >
      <span data-testid="message-error-text">{t(ERROR_KEY[props.code])}</span>
      {canRetry ? (
        <Button
          variant="secondary"
          size="sm"
          data-testid="message-retry"
          onClick={() => void store.retry(sent.id)}
        >
          {t('error.retry')}
        </Button>
      ) : null}
    </div>
  )
}

function SummaryLine(props: { readonly summary: NonNullable<TurnCustom['summary']> }): JSX.Element {
  const { t } = useTranslation()
  return (
    <p data-testid="turn-summary" className="mt-2 font-sans text-micro text-text-muted">
      {tx(t, 'summary.line', { ...props.summary })}
    </p>
  )
}

function FailureCard(props: {
  readonly reason: RunEndReasonContract
  readonly runId: string | null
  readonly retryOf: string | null
  readonly turnId: string
}): JSX.Element | null {
  const { t, i18n } = useTranslation()
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  const [copied, setCopied] = useState(false)
  const [settings, setSettings] = useState(false)
  const shape = cardOf(props.reason, props.retryOf !== null)
  if (shape === null) return null
  const turns = snapshot.model.turns
  const index = turns.findIndex((turn) => turn.id === props.turnId)
  const effects = effectsOf(turns, index)
  const later = superseded(snapshot, index) || (shape.action === 'retry' && queueWaits(snapshot))
  const act = (): void => {
    switch (shape.action) {
      case 'continue':
        void store.continueRun()
        break
      case 'retry':
        if (props.retryOf !== null) void store.retry(props.retryOf)
        break
      case 'settings':
        setSettings(true)
        break
      case 'copy': {
        // Codes, slots and ids only: never a secret, never the conversation (§失败卡与结束原因).
        const providerId =
          'providerId' in props.reason ? (props.reason as { providerId: string }).providerId : null
        const text = JSON.stringify({ endReason: props.reason, runId: props.runId, providerId })
        void navigator.clipboard.writeText(text).then(() => setCopied(true))
        break
      }
    }
  }
  const actionKey =
    shape.action === 'continue'
      ? 'failure.continue'
      : shape.action === 'retry'
        ? 'failure.retry'
        : shape.action === 'settings'
          ? 'failure.settings'
          : copied
            ? 'failure.copied'
            : 'failure.copy'
  const counted = [
    effects.stopped > 0 ? t('failure.effects.stopped', { count: effects.stopped }) : '',
    effects.stoppedSent > 0 ? t('failure.effects.stoppedSent', { count: effects.stoppedSent }) : '',
    effects.notRun > 0 ? t('failure.effects.notRun', { count: effects.notRun }) : '',
    effects.uncertain > 0 ? t('failure.effects.uncertain', { count: effects.uncertain }) : '',
  ].filter((line) => line !== '')
  return (
    <div
      // Announced as it appears (the phase 1 error was an alert): a failure interrupts, a stop the
      // user made only reports (components.md LiveRegion).
      role={shape.visual === 'neutral' ? undefined : 'alert'}
      aria-live={shape.visual === 'neutral' ? 'polite' : undefined}
      data-testid="failure-card"
      data-code={props.reason.code}
      data-visual={shape.visual}
      className={`mt-2 flex flex-col gap-1 rounded-sm border px-3 py-2 font-sans text-ui-sm ${VISUAL_CLASS[shape.visual]}`}
    >
      <p data-testid="failure-what">
        {tx(t, `runEnd.${props.reason.code}`, slotsOf(props.reason, i18n.language))}
      </p>
      <div data-testid="failure-effects" className="text-text-secondary">
        {effects.none ? <p>{t('failure.effects.none')}</p> : null}
        {effects.done.length === 0 ? null : (
          <>
            <p>{t('failure.effects.doneHeading', { count: effects.done.length })}</p>
            <ul className="list-disc pl-5" data-testid="failure-effects-done">
              {effects.done.map((part) => (
                <li key={part.callKey}>{toolSentence(t, part.name, part.input)}</li>
              ))}
            </ul>
          </>
        )}
        {counted.length === 0 ? null : <p>{counted.join(' ')}</p>}
      </div>
      {(shape.action === 'continue' || shape.action === 'retry') && later ? null : (
        <div>
          <Button
            variant="secondary"
            size="sm"
            data-testid="failure-action"
            data-action={shape.action}
            onClick={act}
          >
            {t(actionKey as never)}
          </Button>
        </div>
      )}
      {shape.action === 'settings' ? (
        <ProviderSettings open={settings} onOpenChange={setSettings} />
      ) : null}
    </div>
  )
}

/**
 * ② of the card: this round's calls by state (§失败卡与结束原因, §点停止时各状态怎么收) — the completed
 * ones by name; a stopped one says its later writes did not happen, except a request already sent
 * out, which may have reached the other side (lib/end-card.ts `effectLineOf`).
 */
function effectsOf(
  turns: readonly Turn[],
  index: number,
): {
  none: boolean
  done: ToolPart[]
  stopped: number
  stoppedSent: number
  notRun: number
  uncertain: number
} {
  const lastUser = turns
    .slice(0, index + 1)
    .findLastIndex((turn) => turn.role === 'user' && turn.optimistic !== true)
  const done: ToolPart[] = []
  let stopped = 0
  let stoppedSent = 0
  let notRun = 0
  let uncertain = 0
  for (const turn of turns.slice(lastUser + 1, index + 1)) {
    for (const part of turn.parts) {
      if (part.kind !== 'tool' || part.outcome === null) continue
      const line = effectLineOf(part.name, part.outcome)
      if (line === 'done') done.push(part)
      else if (line === 'stopped-sent') stoppedSent += 1
      else if (line === 'stopped') stopped += 1
      else if (line === 'not-run') notRun += 1
      else uncertain += 1
    }
  }
  const none = done.length + stopped + stoppedSent + notRun + uncertain === 0
  return { none, done, stopped, stoppedSent, notRun, uncertain }
}
