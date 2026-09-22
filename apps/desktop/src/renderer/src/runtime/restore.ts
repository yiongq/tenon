import type { MessageRowContract } from '@tenon-app/contracts'
import type { ThreadMessageLike } from '@assistant-ui/react'

/**
 * Turning stored messages back into thread messages (spec 01 验收 5).
 *
 * The tail, not the whole history: what the window opens on is the end of the last conversation,
 * and `session.messages` pages backwards from there when phase 6 adds the scrollback. 200 is
 * generous for a screenful and well inside the port's own bound.
 */
export const RESTORE_LIMIT = 200

/**
 * Stored content is UNTRUSTED — it is model output, and from phase 2 tool results too. It is
 * rendered exactly as a streamed reply is: text parts, through the same block registry. A block
 * type this phase cannot produce (thinking, tool calls, images) is left out rather than guessed
 * at; adding one is a line here and a renderer in the registry, never a branch in a component.
 *
 * The stored `status` travels with the message. A reply the user stopped came back looking like a
 * finished one otherwise — assistant-ui gives a text-only message with no status the automatic
 * "complete" — so the truncated text would present as the whole answer, which is the divergence
 * between what was seen and what was recorded that keeping the partial text exists to prevent.
 */
export function toThreadMessages(rows: readonly MessageRowContract[]): ThreadMessageLike[] {
  return rows.map((row) => ({
    id: row.messageId,
    role: row.role,
    createdAt: new Date(row.createdAt),
    // A message with nothing to show still gets its (empty) part: assistant-ui drops a blank text
    // part, so such a turn renders empty rather than as a placeholder. Nothing this phase writes
    // is blank — an assistant message is only written when text arrived — and inventing filler
    // content for phase 2's thinking-only turns would put words on the tape's behalf.
    content: [{ type: 'text' as const, text: textOf(row.content) }],
    ...(row.role === 'assistant' ? statusOf(row.status) : {}),
  }))
}

/**
 * assistant-ui's own vocabulary. `complete` is left unset on purpose: its automatic status is
 * derived from the content and is the right answer for a message that finished normally.
 * Role-conditional because `fromThreadMessageLike` throws on a status anywhere but an assistant
 * message.
 */
function statusOf(status: MessageRowContract['status']): { status?: ThreadMessageLike['status'] } {
  if (status === 'aborted') return { status: { type: 'incomplete', reason: 'cancelled' } }
  if (status === 'error') return { status: { type: 'incomplete', reason: 'error' } }
  return {}
}

function textOf(content: MessageRowContract['content']): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n\n')
}
