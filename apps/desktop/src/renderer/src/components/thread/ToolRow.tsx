import { callSnapshot } from '@/lib/snapshots'
import { useSnapshotRounds } from '@/runtime/SnapshotProvider'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import type { ToolOutcomeViewContract } from '@tenon-app/contracts'
import { invokeRoute, mcpLogin, sandboxRelease } from '@tenon-app/contracts'
import { AlertTriangle, CircleX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ClampedPre } from '@/components/ui/clamped-pre'
import { PathText } from '@/components/ui/path-text'
import { mcpAction, useMcp } from '@/runtime/mcp-store'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { needsProxyWarning } from '@/lib/sandbox-settings'
import { toolMarker, toolRowEffect } from '@/lib/tool-row-effect'
import { useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { categoryOf } from '@/lib/approval-keys'
import { questionsOf, summaryOf } from '@/lib/ask'
import { toolObject, toolSentence, toolSlotValue } from '@/lib/tool-sentence'
import { tx } from '@/lib/tx'
import { hostOfUrl } from '@/lib/url-host'
import { visible } from '@/lib/visible'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'
import type { Answered, SessionSnapshot } from '@/runtime/session-store'
import { ApprovalCard, ObjectLine, scopeKey } from './ApprovalCard'
import { AskSummaryCard } from './AskSummaryCard'

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
 * hangs below it, with the batch's later calls queued under the card. An AskUserQuestion that waits
 * has the batch's later calls queued under its row — its widget is above the composer — and once it
 * has its result, the summary card (§阶段 2 做的组件 `AskSummaryCard`).
 */
export function ToolRow(props: ToolCallMessagePartProps): JSX.Element | null {
  const { t } = useTranslation()
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  const { servers } = useMcp()
  const [open, setOpen] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  // Keep the live card's host when answering; persisted answers derive it from the URL.
  const [answeredHost, setAnsweredHost] = useState<string | undefined>(undefined)
  const callKey = props.toolCallId
  const input = (props.args ?? {}) as Readonly<Record<string, unknown>>
  const outcome = (props.result ?? null) as ToolOutcomeViewContract | null
  const effect = toolRowEffect(outcome, props.toolName)
  const marker = toolMarker(outcome)
  const rounds = useSnapshotRounds()
  const saved = callSnapshot(rounds.data?.rounds ?? [], callKey)
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
  // The question this call asks waits on the widget above the composer, not on a card here.
  const asking = snapshot.pending?.waitKind === 'question' && snapshot.pending.callKey === callKey
  const summary =
    props.toolName === 'AskUserQuestion'
      ? summaryOf(questionsOf(input), outcome, snapshot.asked.get(callKey) ?? null)
      : null
  const blocked =
    outcome !== null &&
    (outcome.sandbox !== undefined || (outcome.source !== null && BLOCK_CODES.has(outcome.source)))
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
    <div
      data-testid="tool-row"
      data-call-key={callKey}
      className="flex flex-col gap-2 font-sans text-ui-sm"
    >
      <button
        type="button"
        data-testid="tool-row-line"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="flex w-full items-baseline gap-2 text-left text-text-secondary"
      >
        {/* The sentence takes the free width, so the marker and 「运行中」 line up at the row's end
            whether the sentence is short or wraps. */}
        <span className="min-w-0 flex-1">
          <PathText text={toolSentence(t, props.toolName, input, servers)} />
        </span>
        {effect?.marker ? (
          <Tooltip>
            <TooltipTrigger render={<span />} data-testid="tool-effect-marker" className="shrink-0">
              {marker === 'failed' ? (
                <CircleX aria-hidden className="inline size-3" />
              ) : (
                <AlertTriangle aria-hidden className="inline size-3" />
              )}
              <span className="sr-only">
                {t(marker === 'failed' ? 'tool.did.failed' : 'tool.did.irreversible')}
              </span>
            </TooltipTrigger>
            <TooltipContent className="w-max max-w-none whitespace-nowrap [&>[data-slot=tooltip-arrow]]:hidden">
              {t(marker === 'failed' ? 'tool.did.failed' : 'tool.did.irreversible')}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {outcome === null && pending === null && !asking && summary === null ? (
          <span className="shrink-0 text-micro text-text-muted">{t('tool.running')}</span>
        ) : null}
      </button>
      {outcome !== null &&
      outcome.state !== 'completed' &&
      outcome.source !== null &&
      !blocked &&
      !(outcome.source === 'user-rejected' && answered?.outcome === 'denied') ? (
        <p data-testid="tool-row-closure" className="text-micro text-text-muted">
          {t(closureKey as never)}
        </p>
      ) : null}
      {effect?.loginServerId ? (
        <div>
          <Button
            data-testid="tool-relogin"
            variant="outline"
            size="sm"
            disabled={loginBusy}
            onClick={() => {
              setLoginBusy(true)
              void mcpAction(invokeRoute(window.tenon, mcpLogin, { id: effect.loginServerId! }))
                .then(setLoginError)
                .finally(() => setLoginBusy(false))
            }}
          >
            {t('mcp.relogin')}
          </Button>
          {loginError ? <p role="alert">{t(`mcp.error.${loginError}` as never)}</p> : null}
        </div>
      ) : null}
      {outcome?.sandbox !== undefined ? (
        <SandboxNotice
          key={callKey}
          callKey={callKey}
          outcome={outcome}
          sandbox={outcome.sandbox}
        />
      ) : blocked && outcome !== null ? (
        <BlockedNotice
          outcome={outcome}
          toolName={props.toolName}
          profile={snapshot.facts?.profile ?? 'chat'}
        />
      ) : null}
      {open ? (
        <div className="flex flex-col gap-1" data-testid="tool-row-details">
          <p className="text-micro text-text-muted">{t('tool.input')}</p>
          <ClampedPre
            className="rounded-sm bg-surface-1 p-2 font-mono text-micro text-text-primary"
            paths
            // Each argument escaped on its own, so the newline between two of them is a plain
            // line break and only a newline inside one shows the mark (E4).
            text={Object.entries(input)
              .map(
                ([key, value]) =>
                  `${key}: ${visible(typeof value === 'string' ? value : JSON.stringify(value))}`,
              )
              .join('\n')}
          />
          {/* A call that never ran has no output: what its result holds is the kernel's note to the
              model, in English, which the closure line above already says in the interface's words. */}
          {outcome === null || outcome.state === 'not-run' ? null : (
            <>
              <p className="text-micro text-text-muted">{t('tool.output')}</p>
              <ClampedPre
                className="rounded-sm bg-surface-1 p-2 font-mono text-micro text-text-primary"
                testId="tool-row-output"
                paths="absolute"
                // A handoff whose reply was cut (`preview`): the start of the sub-agent's reply the
                // Tape kept, not the model's English note about the file (H9). One spilled only by
                // its call lines kept the reply whole and shows its output like any tool's.
                text={
                  props.toolName === 'Agent'
                    ? visible(
                        outcome.handoff?.preview === undefined
                          ? outcome.output
                          : outcome.handoff.finalReply,
                      )
                    : outcome.output
                }
              />
              {outcome.handoff?.preview === undefined ? null : (
                <p data-testid="tool-row-preview" className="text-micro text-text-muted">
                  {t(outcome.handoff.preview === 'spilled' ? 'preview.spilled' : 'preview.unsaved')}
                </p>
              )}
            </>
          )}
          {saved === null ? null : (
            <p data-testid="tool-snapshot" className="text-micro text-text-muted">
              {t('snapshot.number', { id: visible(saved.snapshotId) })}
            </p>
          )}
          {effect?.didKey ? (
            <p data-testid="tool-side-effects" className="text-micro text-text-secondary">
              {t(effect.didKey)}
              {effect.undoKey === null ? null : ` · ${t(effect.undoKey)}`}
            </p>
          ) : null}
        </div>
      ) : null}
      {answered === null ? null : (
        <AnsweredRow
          answered={answered}
          input={input}
          toolName={props.toolName}
          host={answeredHost}
        />
      )}
      {summary === null ? null : <AskSummaryCard summary={summary} />}
      {asking ? <QueuedRows callKey={callKey} /> : null}
      {pending === null ||
      (pending.card.sessionId !== store.sessionId && snapshot.pendingCall === null) ? null : (
        <>
          {/* A new requestId is a new card (§最小审批卡「数据」): it mounts afresh, with no focus or
              expanded change carried over from the card it replaced. */}
          <ApprovalCard
            key={pending.card.requestId}
            pending={pending}
            since={snapshot.pendingSince}
            toolName={
              pending.card.sessionId === store.sessionId
                ? props.toolName
                : (snapshot.pendingCall?.name ?? '')
            }
            input={
              pending.card.sessionId === store.sessionId
                ? input
                : (snapshot.pendingCall?.input ?? {})
            }
            onRespond={(decision) => {
              const host = pending.card.facts['host']
              setAnsweredHost(typeof host === 'string' ? host : undefined)
              void store.respond(decision)
            }}
          />
          <QueuedRows callKey={pending.anchorCallKey} />
        </>
      )}
    </div>
  )
}

/**
 * Whether a call waits, unanswerable, behind the card an earlier call of its batch holds (F6), or
 * behind the question one asks (§阶段 2 做的组件: 同批后面的调用以排队行叠在那次 AskUserQuestion 的行下).
 */
function queuedBehindCard(snapshot: SessionSnapshot, callKey: string): boolean {
  const pending = snapshot.pending
  if (pending === null) return false
  const turn = snapshot.model.turns.find((candidate) =>
    candidate.parts.some((part) => part.kind === 'tool' && part.callKey === callKey),
  )
  if (turn === undefined) return false
  const keys = turn.parts.flatMap((part) => (part.kind === 'tool' ? [part.callKey] : []))
  const anchor = keys.indexOf(
    pending.waitKind === 'approval' ? pending.anchorCallKey : pending.callKey,
  )
  return anchor >= 0 && keys.indexOf(callKey) > anchor
}

type SandboxOutcome = NonNullable<ToolOutcomeViewContract['sandbox']>
type Violation = SandboxOutcome['violations'][number]
type ReleaseAction = 'allow-domain' | 'allow-path' | 'rerun-unsandboxed'
type ReleaseState = 'busy' | 'released' | 'stale' | 'not-found' | 'refused' | 'failed'

/** Only recorded classifications decide the copy; a path never implies read, write or credentials. */
function violationWhy(violation: Violation): string {
  if (violation.kind === 'fs') {
    if (violation.release === 'path') return 'receipt.why.path'
    return violation.protected ? 'receipt.why.protected' : 'receipt.why.file'
  }
  if (violation.release === 'domain') return 'receipt.why.domain'
  const target = violation.target!
  try {
    const host = new URL(`http://${target.includes(':') ? `[${target}]` : target}`).hostname
    if (needsProxyWarning(`${host}:1`)) return 'receipt.why.local'
    if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'receipt.why.ip'
  } catch {
    // A name that cannot be recognized belongs to the same non-releasable name class.
  }
  return 'receipt.why.host'
}

/** The three-part receipt also appears on successful calls carrying diagnostics only. */
export function SandboxNotice(props: {
  readonly callKey: string
  readonly outcome: ToolOutcomeViewContract
  readonly sandbox: SandboxOutcome
}): JSX.Element {
  const { t } = useTranslation()
  const store = useSessionStore()
  const [states, setStates] = useState(new Map<string, ReleaseState>())
  const { violations, more, anyProtected } = props.sandbox
  const objects = violations.filter((violation) => violation.target !== null)
  const unknown = violations.length - objects.length
  const why = [...new Set(objects.map(violationWhy))]
  const domains = [
    ...new Set(violations.filter((v) => v.release === 'domain').map((v) => v.target!)),
  ].slice(0, 3)
  const paths = [
    ...new Set(violations.filter((v) => v.release === 'path' && !v.observed).map((v) => v.target!)),
  ].slice(0, 3)
  // Bash prefixes non-zero exits and signals on the first line; stop/timeout remain explicit sources.
  const exitedZero =
    props.outcome.state === 'completed' &&
    props.outcome.source !== 'stopped' &&
    props.outcome.source !== 'timed-out' &&
    !/^(?:Exit code: [^0]|Killed by signal:)/.test(props.outcome.output.split('\n', 1)[0] ?? '')
  const hintOnly = violations.every((v) => v.observed) && exitedZero

  async function release(action: ReleaseAction, target: string | null, key: string) {
    setStates((was) => new Map(was).set(key, 'busy'))
    let state: ReleaseState
    try {
      const result = await invokeRoute(window.tenon, sandboxRelease, {
        sessionId: store.sessionId,
        callKey: props.callKey,
        action,
        target,
      })
      state = !result.ok
        ? 'failed'
        : result.data.status === 'already-released'
          ? 'released'
          : result.data.status
    } catch {
      state = 'failed'
    }
    setStates((was) => new Map(was).set(key, state))
  }

  function actionButton(action: ReleaseAction, target: string | null): JSX.Element {
    const key = JSON.stringify([action, target])
    const state = states.get(key)
    return (
      <div
        key={key}
        className="flex min-w-0 flex-col items-start gap-1"
        data-testid="receipt-action"
      >
        <Button
          variant="outline"
          size="sm"
          data-testid={`receipt-${action}`}
          disabled={state === 'busy' || state === 'released'}
          className="max-w-full h-auto min-h-(--t-h-control-compact) whitespace-normal text-left"
          onClick={() => release(action, target, key)}
        >
          <PathText
            text={
              state === 'released'
                ? t('receipt.released')
                : tx(t, `receipt.action.${action}`, { target: visible(target ?? '') })
            }
          />
        </Button>
        <p data-testid="receipt-action-note">{tx(t, `receipt.note.${action}`)}</p>
        {state !== undefined && state !== 'busy' && state !== 'released' ? (
          <p role="alert">{tx(t, `receipt.error.${state}`)}</p>
        ) : null}
      </div>
    )
  }

  return (
    <div
      data-testid="sandbox-notice"
      className="flex min-w-0 flex-col gap-2 rounded-sm border border-border-subtle px-2 py-1 text-micro text-text-warning"
    >
      <div data-testid="receipt-objects">
        {objects.slice(0, 3).map((violation, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- the recorded order is immutable
          <p key={index}>
            <PathText
              text={tx(
                t,
                violation.kind === 'network'
                  ? 'receipt.connection'
                  : violation.release === 'path'
                    ? 'receipt.write'
                    : 'receipt.access',
                { target: visible(violation.target!) },
              )}
            />
          </p>
        ))}
        {objects.length > 3 || more > 0 ? (
          <p>{t('receipt.more', { count: Math.max(0, objects.length - 3) + more })}</p>
        ) : null}
        {unknown > 0 ? <p>{t('receipt.unknown', { count: unknown })}</p> : null}
      </div>
      <div data-testid="receipt-why">
        {why.map((key) => (
          <p key={key}>{tx(t, key)}</p>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-2" data-testid="receipt-actions">
        {domains.map((target) => actionButton('allow-domain', target))}
        {paths.map((target) => actionButton('allow-path', target))}
        {!anyProtected && !hintOnly ? actionButton('rerun-unsandboxed', null) : null}
        {anyProtected ? <p data-testid="receipt-protected">{t('receipt.protected')}</p> : null}
      </div>
    </div>
  )
}

/** The four block codes each say why, without repeating the object or the tool name. */
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
    props.profile === 'chat' && props.outcome.source === 'protected' && props.toolName === 'Read'
      ? 'blocked.chatReadScope'
      : props.outcome.source === 'inspector'
        ? `blocked.inspector.${categoryOf(facts)}`
        : props.outcome.source === 'protected'
          ? props.toolName === 'WebFetch'
            ? 'blocked.protected.fetch'
            : props.toolName === 'Write' || props.toolName === 'Edit'
              ? 'blocked.protected.write'
              : 'blocked.protected.read'
          : `blocked.${String(props.outcome.source)}`
  return (
    <div
      data-testid="blocked-notice"
      data-source={props.outcome.source}
      className="rounded-sm border border-border-subtle px-2 py-1 text-micro text-text-warning"
    >
      <p>{tx(t, key)}</p>
    </div>
  )
}

/** Keep only the authorization facts absent from the main session's tool sentence. */
export function AnsweredRow(props: {
  readonly answered: Answered
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly host?: string | undefined
}): JSX.Element {
  const { t } = useTranslation()
  const { answered } = props
  const target = answered.target
  let extra = ''
  if (!answered.subtask && answered.outcome === 'allowed') {
    switch (target.type) {
      case 'command':
        extra = t('confirm.cwd', { cwd: visible(target.cwd) })
        break
      case 'search':
        extra = t('confirm.answered.searchHost', { host: visible(target.host) })
        break
      case 'url':
        extra = t('confirm.answered.searchHost', {
          host: visible(props.host ?? hostOfUrl(target.url)),
        })
        break
      case 'path':
        // Compare the displayed slot, including its escaping, rather than the whole sentence.
        if (toolSlotValue(props.toolName, props.input) !== visible(target.path)) {
          extra = t('confirm.answered.realPath', { path: visible(target.path) })
        }
        break
      case 'tool':
        break
    }
  }
  return (
    <div
      data-testid="approval-answered"
      data-outcome={answered.outcome}
      className="flex flex-col gap-0.5 rounded-sm bg-surface-1 px-2 py-1 text-micro text-text-secondary"
    >
      <span>
        {answered.outcome === 'allowed'
          ? t('confirm.answered.allowed', {
              scope: t(scopeKey(answered.scope, answered.target.type, answered.subtask) as never),
            })
          : t('confirm.answered.denied')}
        {answered.outcome === 'denied' && !answered.subtask ? (
          ` · ${t('confirm.answered.roundEnds')}`
        ) : extra === '' ? null : (
          <PathText text={` · ${extra}`} />
        )}
      </span>
      {answered.subtask ? <ObjectLine target={answered.target} /> : null}
    </div>
  )
}

/**
 * The batch's later calls, one queued row each, under the card or the waiting question's row; they
 * cannot be answered (F6).
 */
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
    <ul className="flex flex-col gap-1" data-testid="approval-queued">
      {waiting.map((part) => (
        <li
          key={part.callKey}
          data-testid="approval-queued-row"
          className="flex items-baseline gap-2 rounded-sm border border-border-subtle px-2 py-1 text-micro text-text-muted"
        >
          <span className="min-w-0 font-mono">
            <PathText text={visible(toolObject(part.name, part.input))} />
          </span>
          <span className="shrink-0">{t('queue.queued')}</span>
        </li>
      ))}
    </ul>
  )
}
