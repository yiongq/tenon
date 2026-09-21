/**
 * Folding and replay (spec 01 §投影与重放), the half acceptance 3 states about the provider context.
 *
 * The fold is tested on hand-built entries because it is pure; `rebuildProviderContext` is tested
 * against the real memory store, because what it has to get right is the PAGING — pinning
 * `atEntryId`, handing the incarnation back, and never yielding an empty assistant turn.
 */
import { describe, expect, it } from 'vitest'
import type { ContentBlock, ModelInfo } from '../../src/provider/types.js'
import { createMemoryTapeStore } from '../../src/tape/memory-store.js'
import type { NewEntry, TapeEntry, TapeKind } from '../../src/tape/entry.js'
import { createEntryWriter } from '../../src/tape/names.js'
import {
  messageRetractedKey,
  messageRevisionKey,
  sessionStartKey,
} from '../../src/tape/provenance.js'
import { effectiveMessages, rebuildProviderContext } from '../../src/tape/replay.js'
import type { TapeStore } from '../../src/tape/store.js'
import { createCounterIds } from '../../src/testing/fake-ids.js'

const IDENTITY = { userId: 'u', tenantId: 'tenant-a', profileDir: '/tenon/a' }

const TARGET: ModelInfo = {
  id: 'claude-test',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 4096,
  reasoning: true,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'signed-blocks',
  usageNeedsOptIn: false,
}

let clock = 1_700_000_000_000

function at(): number {
  clock += 1000
  return clock
}

function fold(
  overrides: Partial<TapeEntry> & { kind: TapeKind; name: string; entryId: number },
): TapeEntry {
  return {
    tenantId: 'tenant-a',
    sessionId: 'session',
    incarnationId: 'incarnation',
    sourceType: 'message',
    sourceId: 'message',
    sourceSeq: 0,
    provenanceKey: 'message:v1:x:0',
    payload: {},
    meta: {},
    createdAt: 1_700_000_000_000,
    contentHash: new Uint8Array(32),
    prevHash: null,
    entryHash: new Uint8Array(32),
    hashVer: 1,
    ...overrides,
  }
}

function messageEntry(
  entryId: number,
  messageId: string,
  revision: number,
  role: 'user' | 'assistant',
  content: ContentBlock[],
): TapeEntry {
  return fold({
    kind: 'message',
    name: role === 'user' ? 'message/user' : 'message/assistant',
    entryId,
    sourceId: messageId,
    sourceSeq: revision,
    payload: {
      messageId,
      revision,
      role,
      content,
      status: 'complete',
      ...(role === 'assistant' ? { runId: 'run' } : {}),
    },
  })
}

function retractedEntry(entryId: number, messageId: string): TapeEntry {
  return fold({
    kind: 'event',
    name: 'message/retracted',
    entryId,
    sourceId: messageId,
    sourceSeq: null,
    payload: { messageId, reason: 'user-deleted' },
  })
}

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

describe('effectiveMessages', () => {
  it('keeps the highest revision of a message and leaves it where it started', () => {
    const folded = effectiveMessages([
      messageEntry(1, 'm1', 0, 'user', text('first')),
      messageEntry(2, 'm2', 0, 'assistant', text('answer')),
      messageEntry(3, 'm1', 1, 'user', text('first, edited')),
    ])
    expect(folded.map((visible) => visible.messageId)).toEqual(['m1', 'm2'])
    expect(folded[0]?.content).toEqual(text('first, edited'))
    expect(folded[0]?.orderSeq).toBe(1)
    expect(folded[0]?.entryId).toBe(3)
    expect(folded[0]?.revision).toBe(1)
  })

  it('hides a message whose retraction came after it', () => {
    const folded = effectiveMessages([
      messageEntry(1, 'm1', 0, 'user', text('keep')),
      messageEntry(2, 'm2', 0, 'assistant', text('drop')),
      retractedEntry(3, 'm2'),
    ])
    expect(folded.map((visible) => visible.messageId)).toEqual(['m1'])
  })

  it('brings a message back when a revision is appended after the retraction', () => {
    const folded = effectiveMessages([
      messageEntry(1, 'm1', 0, 'user', text('original')),
      retractedEntry(2, 'm1'),
      messageEntry(3, 'm1', 1, 'user', text('edited after deleting')),
    ])
    expect(folded).toHaveLength(1)
    expect(folded[0]?.content).toEqual(text('edited after deleting'))
    // The revision does not move it: order_seq is still the first fact's entry id.
    expect(folded[0]?.orderSeq).toBe(1)
  })

  it('passes every other kind and event name through as evidence', () => {
    const folded = effectiveMessages([
      fold({ kind: 'anchor', name: 'session/start', entryId: 1, payload: { incarnationId: 'i' } }),
      fold({
        kind: 'event',
        name: 'session/model_selected',
        entryId: 2,
        payload: { providerId: 'p', modelId: 'm' },
      }),
      fold({ kind: 'event', name: 'provider/attempt_completed', entryId: 3, payload: {} }),
      fold({ kind: 'tool_call', name: 'tool/called', entryId: 4, payload: {} }),
      fold({ kind: 'context', name: 'skill/loaded', entryId: 5, payload: {} }),
      messageEntry(6, 'm1', 0, 'user', text('the only message')),
    ])
    expect(folded.map((visible) => visible.messageId)).toEqual(['m1'])
  })

  it('does not depend on the order it is handed the entries', () => {
    const entries = [
      messageEntry(1, 'm1', 0, 'user', text('first')),
      messageEntry(3, 'm1', 1, 'user', text('edited')),
      messageEntry(2, 'm2', 0, 'assistant', text('answer')),
    ]
    expect(effectiveMessages(entries)).toEqual(effectiveMessages(entries.toReversed()))
  })
})

// -------------------------------------------------------------------------------------------------

function newStore(): TapeStore {
  return createMemoryTapeStore({ identity: IDENTITY })
}

interface Session {
  readonly store: TapeStore
  readonly sessionId: string
  readonly incarnationId: string
  readonly ids: ReturnType<typeof createCounterIds>
}

async function openSession(): Promise<Session> {
  const store = newStore()
  const ids = createCounterIds()
  const sessionId = ids.uuid()
  const incarnationId = ids.uuid()
  await store.append({
    sessionId,
    incarnationId,
    entries: [
      createEntryWriter('session')('session/start', {
        sourceType: 'session',
        sourceId: sessionId,
        sourceSeq: 0,
        provenanceKey: sessionStartKey(incarnationId),
        payload: { incarnationId },
        createdAt: at(),
      }),
    ],
  })
  return { store, sessionId, incarnationId, ids }
}

function message(
  messageId: string,
  revision: number,
  role: 'user' | 'assistant',
  content: ContentBlock[],
): NewEntry {
  return createEntryWriter('message')(role === 'user' ? 'message/user' : 'message/assistant', {
    sourceType: 'message',
    sourceId: messageId,
    sourceSeq: revision,
    provenanceKey: messageRevisionKey(messageId, revision),
    payload: {
      messageId,
      revision,
      role,
      content,
      status: 'complete',
      ...(role === 'assistant' ? { runId: '00000000-0000-4000-8000-0000000000ff' } : {}),
    },
    createdAt: at(),
  })
}

function retract(messageId: string): NewEntry {
  return createEntryWriter('message')('message/retracted', {
    sourceType: 'message',
    sourceId: messageId,
    provenanceKey: messageRetractedKey(messageId),
    payload: { messageId, reason: 'user-deleted' },
    createdAt: at(),
  })
}

describe('rebuildProviderContext', () => {
  it('rebuilds the conversation in order_seq order', async () => {
    const session = await openSession()
    const first = session.ids.uuid()
    const answer = session.ids.uuid()
    const second = session.ids.uuid()
    await session.store.append({
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      entries: [
        message(first, 0, 'user', text('question one')),
        message(answer, 0, 'assistant', text('answer one')),
        message(second, 0, 'user', text('question two')),
      ],
    })
    const context = await rebuildProviderContext(session.store, {
      sessionId: session.sessionId,
      target: TARGET,
    })
    expect(context).toEqual([
      { role: 'user', content: text('question one') },
      { role: 'assistant', content: text('answer one') },
      { role: 'user', content: text('question two') },
    ])
  })

  it('never yields a turn with empty content', async () => {
    const session = await openSession()
    const empty = session.ids.uuid()
    const kept = session.ids.uuid()
    await session.store.append({
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      entries: [
        // Nothing writes one — a failed turn writes no assistant message at all — but a context
        // carrying it would be a 400 from the wire, so replay refuses it whatever is on disk.
        message(empty, 0, 'assistant', []),
        message(kept, 0, 'user', text('still here')),
      ],
    })
    const context = await rebuildProviderContext(session.store, {
      sessionId: session.sessionId,
      target: TARGET,
    })
    expect(context).toEqual([{ role: 'user', content: text('still here') }])
  })

  it('leaves the wire shape to encode(): empty blocks, adjacent roles, a leading assistant', async () => {
    const session = await openSession()
    const first = session.ids.uuid()
    const second = session.ids.uuid()
    const answer = session.ids.uuid()
    await session.store.append({
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      entries: [
        message(answer, 0, 'assistant', text('an answer to a retracted question')),
        retract(answer),
        // A failed turn writes no assistant message, so two user turns legitimately meet; the second
        // send has different text, so the retry rule mints a new messageId rather than a revision.
        message(first, 0, 'user', text('hi')),
        message(second, 0, 'user', [{ type: 'text', text: '' }]),
      ],
    })
    const context = await rebuildProviderContext(session.store, {
      sessionId: session.sessionId,
      target: TARGET,
    })
    // What replay guarantees is the FOLD and nothing else. A block with no renderable content and the
    // arrangement of turns are `encode()`'s to fix, where the target and the tools are known — the
    // audit trail on provider/attempt_completed has to describe what was actually sent.
    expect(context).toEqual([
      { role: 'user', content: text('hi') },
      { role: 'user', content: [{ type: 'text', text: '' }] },
    ])
  })

  it('passes thinking blocks through unchanged — the guard runs only in encode()', async () => {
    const session = await openSession()
    const thinking: ContentBlock[] = [
      {
        type: 'thinking',
        text: 'let me think',
        signature: 'sig-abc',
        provider: 'some-other-provider',
        providerModel: 'some-other-model',
      },
      { type: 'text', text: 'the answer' },
    ]
    await session.store.append({
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      entries: [message(session.ids.uuid(), 0, 'assistant', thinking)],
    })
    const context = await rebuildProviderContext(session.store, {
      sessionId: session.sessionId,
      target: TARGET,
    })
    // A foreign provider's block would be dropped by decideThinking; replay keeps it so the audit
    // trail encode() writes stays complete.
    expect(context[0]?.content).toEqual(thinking)
  })

  it('pins the context at atEntryId, so later facts are invisible', async () => {
    const session = await openSession()
    const first = session.ids.uuid()
    const later = session.ids.uuid()
    const [receipt] = await session.store.append({
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      entries: [message(first, 0, 'user', text('inside the snapshot'))],
    })
    await session.store.append({
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      entries: [message(later, 0, 'user', text('after the snapshot'))],
    })
    const pinned = await rebuildProviderContext(session.store, {
      sessionId: session.sessionId,
      atEntryId: receipt?.entryId ?? 0,
      target: TARGET,
    })
    expect(pinned).toEqual([{ role: 'user', content: text('inside the snapshot') }])
    const unpinned = await rebuildProviderContext(session.store, {
      sessionId: session.sessionId,
      target: TARGET,
    })
    expect(unpinned).toHaveLength(2)
  })

  it('folds a retraction and a revision out of the context', async () => {
    const session = await openSession()
    const kept = session.ids.uuid()
    const dropped = session.ids.uuid()
    await session.store.append({
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      entries: [
        message(kept, 0, 'user', text('original')),
        message(dropped, 0, 'assistant', text('to be retracted')),
      ],
    })
    await session.store.append({
      sessionId: session.sessionId,
      incarnationId: session.incarnationId,
      entries: [message(kept, 1, 'user', text('edited')), retract(dropped)],
    })
    const context = await rebuildProviderContext(session.store, {
      sessionId: session.sessionId,
      target: TARGET,
    })
    expect(context).toEqual([{ role: 'user', content: text('edited') }])
  })

  it('reads a session that spans more than one page', async () => {
    const session = await openSession()
    const messageIds: string[] = []
    // The page size is MAX_READ_LIMIT, so 1200 facts guarantee at least two round trips.
    for (let base = 0; base < 1200; base += 200) {
      const batch: NewEntry[] = []
      for (let offset = 0; offset < 200; offset += 1) {
        const messageId = session.ids.uuid()
        messageIds.push(messageId)
        batch.push(message(messageId, 0, 'user', text(`message ${base + offset}`)))
      }
      // oxlint-disable-next-line no-await-in-loop -- one transaction per batch, in order
      await session.store.append({
        sessionId: session.sessionId,
        incarnationId: session.incarnationId,
        entries: batch,
      })
    }
    const context = await rebuildProviderContext(session.store, {
      sessionId: session.sessionId,
      target: TARGET,
    })
    expect(context).toHaveLength(messageIds.length)
    expect(context[0]?.content).toEqual(text('message 0'))
    expect(context.at(-1)?.content).toEqual(text('message 1199'))
  })

  it('is empty for a session that does not exist', async () => {
    const store = newStore()
    const context = await rebuildProviderContext(store, {
      sessionId: 'nobody',
      target: TARGET,
    })
    expect(context).toEqual([])
  })
})
