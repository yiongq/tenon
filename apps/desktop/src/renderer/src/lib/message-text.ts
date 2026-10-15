/** What a thread message is, as far as copying it is concerned. */
interface PartLike {
  readonly type: string
  readonly text?: string
}
export interface MessageLike {
  readonly role: string
  readonly content: readonly PartLike[]
}

/**
 * The words of one message: its text parts in order, a blank line between two. Thinking, tool calls
 * and every other part are not words the user would paste anywhere.
 */
export function textOfMessage(message: MessageLike): string {
  return message.content
    .flatMap((part) =>
      part.type === 'text' && part.text !== undefined && part.text.trim() !== '' ? [part.text] : [],
    )
    .join('\n\n')
}

/**
 * Whether the assistant message at `index` is the last of its round. One round can hold several
 * assistant messages (a Run's reply, the tool results, the reply after them), and the action bar
 * closes the round once (components.md `AssistantMessage`: 「动作条仍只出现一次」).
 */
export function endsRound(messages: readonly MessageLike[], index: number): boolean {
  return messages[index]?.role === 'assistant' && messages[index + 1]?.role !== 'assistant'
}

/**
 * The reply an action bar copies: the text of every assistant message of the round up to `index`,
 * in order. Empty for a message that is not an assistant's.
 */
export function replyTextAt(messages: readonly MessageLike[], index: number): string {
  let first = index
  while (first > 0 && messages[first - 1]?.role === 'assistant') first -= 1
  if (messages[index]?.role !== 'assistant') return ''
  return messages
    .slice(first, index + 1)
    .map(textOfMessage)
    .filter((text) => text !== '')
    .join('\n\n')
}

/**
 * Whether an assistant message shows its action bar: only once it closes a round that is over —
 * not while it is still being written, not without words to copy, and not on a reply that paused
 * for a card or a question (the round goes on after the answer).
 */
export function showsAssistantBar(input: {
  readonly running: boolean
  readonly reply: string
  readonly endCode: string | undefined
}): boolean {
  return !input.running && input.reply !== '' && input.endCode !== 'paused'
}
