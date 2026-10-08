import type { JSX } from 'react'
import { questionsOf } from '@/lib/ask'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'
import { useMcp } from '@/runtime/mcp-store'
import { composerSlot } from '@/lib/composer-slots'
import { ConnectorStatusNotice } from './ConnectorStatusNotice'
import { AskWidget } from './AskWidget'

/**
 * The one host above the composer (spec 02 §阶段 2 做的组件 `ComposerSlots`; components.md:84): in
 * phase 2 it holds only the question widget — the approval card sits in the thread, under its row.
 * The questions are read from the waiting call's own `tool-request` block (`approval.current`'s
 * question variant names it by `callKey`), live or redrawn.
 */
export function ComposerSlots(): JSX.Element | null {
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  const pending = snapshot.pending
  const { servers } = useMcp()
  const slot = composerSlot(pending?.waitKind === 'question', servers)
  if (slot?.kind === 'connecting') return <ConnectorStatusNotice name={slot.name} />
  if (pending?.waitKind !== 'question') return null
  const call = snapshot.model.turns
    .flatMap((turn) => turn.parts)
    .find((part) => part.kind === 'tool' && part.callKey === pending.callKey)
  if (call?.kind !== 'tool') return null
  const questions = questionsOf(call.input)
  if (questions.length === 0) return null
  return (
    <div data-testid="composer-slots">
      {/* A new question is a new widget: nothing chosen for the last one carries over. */}
      <AskWidget
        key={pending.requestId}
        questions={questions}
        onAnswer={(answers) => store.answerQuestion(answers)}
      />
    </div>
  )
}
