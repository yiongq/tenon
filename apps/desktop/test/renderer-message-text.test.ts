/**
 * What the copy buttons of a message put on the clipboard (components.md `UserActionBar`,
 * `AssistantActionBar`): the words only, and for an assistant message the whole round's reply —
 * once per round, on the last assistant message of it.
 */
import { describe, expect, it } from 'vitest'
import {
  endsRound,
  replyTextAt,
  showsAssistantBar,
  textOfMessage,
} from '../src/renderer/src/lib/message-text.js'
import type { MessageLike } from '../src/renderer/src/lib/message-text.js'

const user = (text: string): MessageLike => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (...content: MessageLike['content'][number][]): MessageLike => ({
  role: 'assistant',
  content,
})
const text = (value: string) => ({ type: 'text', text: value })

describe('textOfMessage', () => {
  it('keeps the text parts in order and leaves thinking and tool calls out', () => {
    const message = assistant(
      { type: 'reasoning', text: 'Let me think.' },
      text('First.'),
      { type: 'tool-call' },
      text('Second.'),
    )
    expect(textOfMessage(message)).toBe('First.\n\nSecond.')
  })

  it('is empty for a message with no words', () => {
    expect(textOfMessage(assistant({ type: 'tool-call' }, text('  \n ')))).toBe('')
  })
})

describe('a round of assistant messages', () => {
  // user, a reply that calls a tool, the reply after the result, then the next question.
  const thread: MessageLike[] = [
    user('read the file'),
    assistant(text('I will read it.'), { type: 'tool-call' }),
    assistant(text('It says hello.')),
    user('thanks'),
    assistant(text('You are welcome.')),
  ]

  it('closes once, on the last assistant message before a user message or the end', () => {
    expect(thread.map((_, index) => endsRound(thread, index))).toEqual([
      false,
      false,
      true,
      false,
      true,
    ])
  })

  it('copies every assistant message of the round up to the one asked about', () => {
    expect(replyTextAt(thread, 2)).toBe('I will read it.\n\nIt says hello.')
    expect(replyTextAt(thread, 4)).toBe('You are welcome.')
    // Not an assistant message: nothing for an assistant action to copy.
    expect(replyTextAt(thread, 0)).toBe('')
  })

  it('skips a message of the round that has no words', () => {
    const toolsOnly = [user('go'), assistant({ type: 'tool-call' }), assistant(text('Done.'))]
    expect(replyTextAt(toolsOnly, 2)).toBe('Done.')
    expect(replyTextAt([user('go'), assistant({ type: 'tool-call' })], 1)).toBe('')
  })
})

describe('the assistant action bar', () => {
  const ended = { running: false, reply: 'Done.', endCode: 'completed' }

  it('shows once a round is over and has words to copy', () => {
    expect(showsAssistantBar(ended)).toBe(true)
    // A message from before end reasons were stored still closes its round.
    expect(showsAssistantBar({ ...ended, endCode: undefined })).toBe(true)
  })

  it('waits while the reply is written, and has nothing to show without words', () => {
    expect(showsAssistantBar({ ...ended, running: true })).toBe(false)
    expect(showsAssistantBar({ ...ended, reply: '' })).toBe(false)
  })

  it('stays away from a reply that paused on a card or a question: the round goes on', () => {
    expect(showsAssistantBar({ ...ended, endCode: 'paused' })).toBe(false)
  })
})
