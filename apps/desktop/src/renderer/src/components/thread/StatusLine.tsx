import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { statusLineOf } from '@/lib/status-line'
import { useSessionSnapshot } from '@/runtime/ChatProvider'

/**
 * The line under the latest turn while a Run is going (components.md `StatusLine`): 思考中… / 撰写中… /
 * 正在干活 · N 秒. It is removed whole when the Run ends or is stopped, never rewritten into something
 * else, and steps aside while a thinking block at the reply's tail says 「思考中」 itself; it reads only
 * what the window already knows (`run.state` and the thread; lib/status-line.ts).
 *
 * The seconds tick once a second; a screen reader hears only the words, which change when the state
 * does, not the counter (it is `aria-hidden`).
 */
export function StatusLine(): JSX.Element | null {
  const { t } = useTranslation()
  const { model, running, runSince, pending } = useSessionSnapshot()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  // A card hangs under its anchor row (a sub-agent's call under the Agent row): neither is at work.
  const waitingOn =
    pending === null
      ? []
      : pending.waitKind === 'approval'
        ? [pending.callKey, pending.anchorCallKey]
        : [pending.callKey]
  const state = statusLineOf({
    running,
    turns: model.turns,
    since: runSince,
    now,
    waitingOn,
  })
  if (state === null) return null
  return (
    <output
      data-testid="status-line"
      data-state={state.kind}
      className="flex items-center gap-2 font-sans text-ui-sm text-text-muted"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-pill bg-text-muted animate-ebb" />
      <span>
        {t(`status.${state.kind}`)}
        {state.kind === 'working' ? (
          <span aria-hidden data-testid="status-elapsed">
            {t('status.elapsed', { seconds: state.seconds })}
          </span>
        ) : null}
      </span>
    </output>
  )
}
