import { restoreNotes, roundForRun } from '@/lib/snapshots'
import { useSnapshotRounds } from '@/runtime/SnapshotProvider'
import { RestoreLink } from './RestoreDialog'
import { useAuiState } from '@assistant-ui/react'
import { invokeRoute, providerList, sessionModelChoice } from '@tenon-app/contracts'
import type { ProviderEntryContract, RunEndReasonContract } from '@tenon-app/contracts'
import { useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { Button } from '@/components/ui/button'
import { PathText } from '@/components/ui/path-text'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { customVendorGone, isInstanceId } from '@/lib/custom-vendor'
import { aggregateDone, cardOf, effectLineOf, providerErrorKey } from '@/lib/end-card'
import type { DoneGroup, EndVisual } from '@/lib/end-card'
import { toolSentence } from '@/lib/tool-sentence'
import { tx } from '@/lib/tx'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'
import { useConversation } from '@/runtime/conversation'
import type { SessionSnapshot } from '@/runtime/session-store'
import type { ChatErrorCode, ToolPart, Turn } from '@/runtime/thread-model'
import type { TurnCustom } from '@/runtime/to-thread-messages'

// The table itself (§失败卡与结束原因) is lib/end-card.ts, where a node test can reach it.
export { cardOf }

/**
 * Slots come from this end reason's own fields, with provider/model display names resolved from
 * those fields (presentation-r1 §失败卡), and reset times in the interface's language.
 */
export function slotsOf(
  reason: RunEndReasonContract,
  locale: string,
  t: TFunction,
  providers: readonly ProviderEntryContract[],
): Record<string, unknown> {
  const { code: _code, ...fields } = reason as RunEndReasonContract & Record<string, unknown>
  const entry =
    'providerId' in reason
      ? providers.find((provider) => provider.id === reason.providerId)
      : undefined
  const names: Record<string, string> = {}
  if ('providerId' in reason)
    names.provider =
      entry === undefined
        ? t('failure.providerFallback')
        : (entry.displayName ?? tx(t, entry.nameKey))
  if ('modelId' in reason) {
    const model = entry?.models.find((row) => row.id === reason.modelId)
    names.model = model?.nameKey === undefined ? reason.modelId : tx(t, model.nameKey)
  }
  if (reason.code === 'quota-exhausted') {
    const resetAt = (fields as { resetAt?: number | null }).resetAt
    return {
      ...fields,
      ...names,
      resetAt: resetAt == null ? 'unknown' : new Date(resetAt).toLocaleString(locale),
    }
  }
  return { ...fields, ...names }
}

const VISUAL_CLASS: Readonly<Record<EndVisual, string>> = {
  neutral: 'border-border-default text-text-secondary',
  danger: 'border-text-danger text-text-danger',
  warning: 'border-text-warning text-text-warning',
}

/**
 * Under a Run's last assistant turn: the summary line (what the round's calls did — read, changed,
 * ran, went online, used connectors, from the last user message on, over every Run of the round)
 * and, when the end calls for it, the failure card's three lines: what happened, what it already
 * did, one action. A rejection is reported by the answered approval row alone; any summary of completed calls stays here.
 */
export function RunEndCard(): JSX.Element | null {
  const custom = useAuiState((s) => s.message.metadata.custom) as unknown as TurnCustom | undefined
  const end = custom?.end
  const snapshot = useSessionSnapshot()
  const { data } = useSnapshotRounds()
  const round = roundForRun(data?.rounds ?? [], end?.runId ?? null)
  const latest = snapshot.model.turns.findLast(
    (turn) =>
      turn.end !== undefined &&
      turn.end.endReason?.code !== 'paused' &&
      round?.runIds.includes(turn.end.runId ?? ''),
  )
  if (end === undefined) {
    const historical = custom?.historicalSummary
    return historical === undefined ? null : (
      <SummaryLine summary={historical.summary} runId={historical.runId} />
    )
  }
  return (
    <>
      {end.endReason?.code === 'paused' ||
      (round !== undefined && latest?.end?.runId !== end.runId) ? null : (
        <SummaryLine summary={custom?.summary ?? null} runId={end.runId} />
      )}
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
 * An error that is not a Run's end uses its phase 1 code (§失败卡与结束原因 ①). Auth offers Settings;
 * other errors offer Retry while nothing came after the message that failed to send.
 */
function MessageError(props: {
  readonly code: ChatErrorCode
  readonly turnId: string
}): JSX.Element {
  const { t } = useTranslation()
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  const [settings, setSettings] = useState(false)
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
      className="flex w-full items-center justify-between gap-3 rounded-sm border border-text-danger px-3 py-2 font-sans text-ui-sm text-text-danger"
    >
      <span data-testid="message-error-text">{t(ERROR_KEY[props.code])}</span>
      {props.code === 'auth' ? (
        <Button
          variant="secondary"
          size="sm"
          data-testid="message-settings"
          onClick={() => setSettings(true)}
        >
          {t('failure.settings')}
        </Button>
      ) : canRetry ? (
        <Button
          variant="secondary"
          size="sm"
          data-testid="message-retry"
          onClick={() => void store.retry(sent.id)}
        >
          {t('error.retry')}
        </Button>
      ) : null}
      {props.code === 'auth' ? <SettingsModal open={settings} onOpenChange={setSettings} /> : null}
    </div>
  )
}

export function SummaryLine(props: {
  readonly summary: NonNullable<TurnCustom['summary']> | null
  readonly runId?: string | null
}): JSX.Element | null {
  const { t } = useTranslation()
  const { data } = useSnapshotRounds()
  const round = roundForRun(data?.rounds ?? [], props.runId ?? null)
  const notes = restoreNotes(round)
  const renderSummary = (link: ReactNode) => {
    if (props.summary === null && notes.link === null && !notes.command) return null
    return (
      <p data-testid="turn-summary" className="font-sans text-micro text-text-muted">
        {Object.entries(props.summary ?? {})
          .filter(([, count]) => count > 0)
          .map(([kind, count]) => tx(t, `summary.${kind}`, { count }))
          .join(t('summary.separator'))}
        {notes.link === null || round === undefined ? null : (
          <>
            {props.summary === null ? null : t('summary.separator')}
            {link}
          </>
        )}
        {notes.command ? (
          <>
            {props.summary === null && notes.link === null ? null : t('summary.separator')}
            {t('snapshot.command')}
          </>
        ) : null}
      </p>
    )
  }
  // Keep the flow mounted even if a timer/focus refresh removes its link or fails (data=null).
  // The dialog belongs to the open flow and remains visible until the user closes it.
  return (
    <RestoreLink
      roundRunId={round?.roundRunId ?? props.runId ?? ''}
      label={notes.link === null ? null : t(notes.link)}
    >
      {renderSummary}
    </RestoreLink>
  )
}

/**
 * M6 §实例被删或改坏「文案单列」: a provider error refusing a custom vendor instance — a new round finds
 * no definition or row and refuses as a missing key would, `errorCode: 'auth'`; a continuation that
 * cannot build its frozen provider ends the same way — while `provider.list` no longer lists that
 * instance or the row the session chose on it. The list also supplies display names for every
 * provider-bearing reason; until it answers the card uses the generic service name. A cleared key
 * keeps the instance listed, and with it the normal auth sentence.
 */
function useProviderDetails(reason: RunEndReasonContract): {
  readonly providers: readonly ProviderEntryContract[]
  readonly gone: boolean
} {
  const { sessionId } = useConversation()
  const providerId = 'providerId' in reason ? reason.providerId : null
  const checkGone =
    reason.code === 'provider-error' &&
    reason.errorCode === 'auth' &&
    providerId !== null &&
    isInstanceId(providerId)
  const [details, setDetails] = useState<{
    providerId: string
    providers: readonly ProviderEntryContract[]
    gone: boolean
  } | null>(null)
  useEffect(() => {
    if (providerId === null) return
    let current = true
    void Promise.all([
      invokeRoute(window.tenon, providerList, {}),
      checkGone ? invokeRoute(window.tenon, sessionModelChoice, { sessionId }) : null,
    ]).then(([list, choice]) => {
      if (!current || !list.ok) return
      setDetails({
        providerId,
        providers: list.data,
        gone: checkGone && customVendorGone(providerId, choice?.ok ? choice.data : null, list.data),
      })
    })
    return () => {
      current = false
    }
  }, [providerId, checkGone, sessionId])
  return details?.providerId === providerId && details !== null
    ? details
    : { providers: [], gone: false }
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
  const { gone, providers } = useProviderDetails(props.reason)
  const shape = cardOf(props.reason, props.retryOf !== null)
  if (shape === null) return null
  const turns = snapshot.model.turns
  const index = turns.findIndex((turn) => turn.id === props.turnId)
  const effects = effectsOf(turns, index)
  const done = aggregateDone(effects.done)
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
      className={`flex w-full flex-col gap-1 rounded-sm border px-3 py-2 font-sans text-ui-sm ${VISUAL_CLASS[shape.visual]}`}
    >
      <p data-testid="failure-what" data-custom-vendor-gone={gone}>
        {gone
          ? t('error.customVendorGone')
          : tx(
              t,
              props.reason.code === 'provider-error'
                ? providerErrorKey(props.reason.errorCode)
                : `runEnd.${props.reason.code}`,
              slotsOf(props.reason, i18n.language, t, providers),
            )}
        {!gone && props.reason.code === 'provider-error' && props.reason.attempts > 1
          ? t('failure.attempts', { count: props.reason.attempts })
          : null}
      </p>
      <div data-testid="failure-effects" className="text-text-secondary">
        {effects.none ? <p>{t('failure.effects.none')}</p> : null}
        {effects.done.length === 0 ? null : (
          <>
            <p>{t('failure.effects.doneHeading', { count: effects.done.length })}</p>
            <ul className="list-disc pl-5" data-testid="failure-effects-done">
              {done.visible.map((group) => (
                <DoneItem key={group.part.callKey} group={group} />
              ))}
            </ul>
            {done.folded.length === 0 ? null : (
              <details data-testid="failure-effects-more">
                <summary className="cursor-pointer">
                  {t('failure.effects.expandAll', {
                    count: done.visible.length + done.folded.length,
                  })}
                </summary>
                <ul className="list-disc pl-5">
                  {done.folded.map((group) => (
                    <DoneItem key={group.part.callKey} group={group} />
                  ))}
                </ul>
              </details>
            )}
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
        <SettingsModal open={settings} onOpenChange={setSettings} />
      ) : null}
    </div>
  )
}

function DoneItem({ group }: { readonly group: DoneGroup }): JSX.Element {
  const { t } = useTranslation()
  const { part, count, object, fullObject } = group
  const suffix = count > 1 ? ` ×${count}` : ''
  const full = toolSentence(t, part.name, part.input) + suffix
  const short =
    object === fullObject
      ? full
      : toolSentence(t, part.name, { ...part.input, file_path: object }) + suffix
  return (
    <li>
      <Tooltip>
        <TooltipTrigger render={<span />} tabIndex={0} aria-label={full}>
          <PathText text={short} />
        </TooltipTrigger>
        <TooltipContent>
          <PathText text={full} />
        </TooltipContent>
      </Tooltip>
    </li>
  )
}

/**
 * ② of the card: this round's calls by state (§失败卡与结束原因, §点停止时各状态怎么收) — the completed
 * ones grouped by tool and object; a stopped one says its later writes did not happen, except a request already sent
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
