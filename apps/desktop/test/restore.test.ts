/**
 * What a restored conversation looks like once assistant-ui has finished with it (spec 01 验收 5).
 *
 * The rows are put through `fromThreadMessageLike` — the conversion `useLocalRuntime` performs on
 * `initialMessages` — because that is where a claim about restored messages either holds or
 * quietly does not: a status is honoured on assistant messages only, and a blank text part is
 * dropped rather than rendered.
 */
import type { MessageRowContract } from '@tenon-app/contracts'
import { fromThreadMessageLike } from '@assistant-ui/react'
import type { MessageStatus, ThreadMessageLike } from '@assistant-ui/react'
import { describe, expect, it } from 'vitest'
import { toThreadMessages } from '../src/renderer/src/runtime/restore.js'

/** What the runtime applies to a message that carries no status of its own. */
const AUTO: MessageStatus = { type: 'complete', reason: 'unknown' }

function row(over: Partial<MessageRowContract>): MessageRowContract {
  return {
    sessionId: '0f1e2d3c-4b5a-4697-8899-aabbccddeeff',
    messageId: 'm1',
    orderSeq: 1,
    role: 'assistant',
    status: 'complete',
    content: [{ type: 'text', text: 'hello' }],
    entryId: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }
}

/** One row in, one message out — the shape every assertion here is about. */
function restored(source: MessageRowContract): ThreadMessageLike {
  const [message, ...rest] = toThreadMessages([source])
  if (message === undefined || rest.length > 0) throw new Error('expected exactly one message')
  return message
}

describe('toThreadMessages', () => {
  it('brings a stopped reply back as a stopped one', () => {
    const stopped = restored(
      row({ messageId: 'm2', status: 'aborted', content: [{ type: 'text', text: 'w0 w1' }] }),
    )
    expect(stopped.status).toEqual({ type: 'incomplete', reason: 'cancelled' })
    // And it survives the conversion the runtime does, instead of being given the automatic
    // "complete" a text-only message gets: a truncated answer must not present as a whole one.
    const message = fromThreadMessageLike(stopped, 'fallback', AUTO)
    expect(message.status).toEqual({ type: 'incomplete', reason: 'cancelled' })
  })

  it('leaves a finished reply to the runtime s own status', () => {
    const complete = restored(row({}))
    expect(complete.status).toBeUndefined()
    expect(fromThreadMessageLike(complete, 'fallback', AUTO).status).toEqual(AUTO)
  })

  it('never puts a status on a user message', () => {
    // `fromThreadMessageLike` throws on one, so this is the assertion and the regression guard.
    const user = restored(row({ role: 'user', status: 'complete', messageId: 'm3' }))
    expect(user.status).toBeUndefined()
    expect(() => fromThreadMessageLike(user, 'fallback', AUTO)).not.toThrow()
  })

  it('keeps the message id, the timestamp and only the text blocks', () => {
    const message = restored(
      row({
        messageId: 'm4',
        content: [
          { type: 'text', text: 'first' },
          { type: 'tool-request', id: 't1', name: 'read', input: {} },
          { type: 'text', text: 'second' },
        ],
      }),
    )
    expect(message.id).toBe('m4')
    expect(message.createdAt).toEqual(new Date(1_700_000_000_000))
    expect(message.content).toEqual([{ type: 'text', text: 'first\n\nsecond' }])
  })

  it('renders a message with nothing to show as an empty turn', () => {
    // Documented, not guarded: assistant-ui drops a blank text part, so the turn is there but
    // shows nothing. Phase 1 writes no such message; phase 2's thinking-only turns will, and
    // this is what they will look like until the registry can render them.
    const blank = restored(row({ content: [] }))
    expect(fromThreadMessageLike(blank, 'fallback', AUTO).content).toEqual([])
  })
})
