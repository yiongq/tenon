import type { Turn } from '../runtime/thread-model'
import { firstSentence } from './first-sentence'

/**
 * What the top bar calls the session on screen: the first sentence of its first user message, on
 * one line. Empty while the session has no message, which is how the bar tells 「no session yet」.
 * Kept whole: the top bar shortens it to its width on screen (CSS), and its tooltip and accessible
 * name carry all of it. Nothing is cut or punctuated here (00 §国际化: punctuation lives in the
 * catalogue, never spliced in code).
 * A user turn sent while a question waited is most likely that question's answer, not a message
 * (`Turn.answering`), so it does not name the session.
 */
export function sessionTitle(turns: readonly Turn[], locale: string): string {
  const first = turns.find((turn) => turn.role === 'user' && turn.answering !== true)
  if (first === undefined) return ''
  const text = first.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n')
  return firstSentence(text, locale).replaceAll(/\s+/g, ' ')
}
