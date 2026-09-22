/**
 * The gate under `ipc/session.ts`'s restatement of the kernel message shapes.
 *
 * The kernel never imports contracts, and contracts must not import the kernel at runtime (the
 * sandboxed preload bundles contracts, and a value import would pull the whole kernel in with it),
 * so the two `MessageRow` / `ContentBlock` definitions are written twice. These assignments are
 * what keeps them one shape: each direction is checked, so ADDING a block type or a column on
 * either side is a compile error here rather than a message that silently fails `schema.parse` on
 * the IPC boundary at runtime.
 *
 * Type-level, with one runtime assertion: the read limit is a number, and a number can drift
 * without any type noticing.
 */
import type { ContentBlock, MessageRow } from '@tenon-app/kernel'
import { MAX_READ_LIMIT, isCanonicalUuid } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import {
  SESSION_READ_LIMIT_MAX,
  contentBlockSchema,
  messageRowSchema,
  sessionMessages,
} from '../src/index.js'
import type { ContentBlockContract, MessageRowContract } from '../src/index.js'

/** `Assert<Extends<A, B>>` fails to compile the moment an `A` stops being usable as a `B`. */
type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

// Exported so `noUnusedLocals` keeps them; nothing imports them.
export type ContractBlockIsKernelBlock = Assert<Extends<ContentBlockContract, ContentBlock>>
export type KernelBlockIsContractBlock = Assert<Extends<ContentBlock, ContentBlockContract>>
export type ContractRowIsKernelRow = Assert<Extends<MessageRowContract, MessageRow>>
export type KernelRowIsContractRow = Assert<Extends<MessageRow, MessageRowContract>>

describe('the session IPC shapes and the kernel shapes', () => {
  it('bound the read limit to the same number the store enforces', () => {
    expect(SESSION_READ_LIMIT_MAX).toBe(MAX_READ_LIMIT)
  })

  it('parses a row the kernel could hand over, blocks included', () => {
    const row: MessageRow = {
      sessionId: '0f1e2d3c-4b5a-4697-8899-aabbccddeeff',
      messageId: 'm1',
      orderSeq: 7,
      role: 'assistant',
      status: 'complete',
      content: [
        { type: 'text', text: 'hello' },
        {
          type: 'thinking',
          text: 'why',
          signature: 'sig',
          provider: 'anthropic',
          providerModel: 'claude-opus-5',
        },
        { type: 'tool-request', id: 't1', name: 'read', input: { path: '/tmp' } },
        {
          type: 'tool-response',
          id: 't1',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      ],
      entryId: 9,
      createdAt: 1,
      updatedAt: 2,
    }
    expect(messageRowSchema.parse(row)).toEqual(row)
  })

  it('refuses a block type nobody declared', () => {
    expect(contentBlockSchema.safeParse({ type: 'script', src: 'x' }).success).toBe(false)
  })

  /**
   * Every id on the tape is a canonical UUID, and `chat.send` refuses anything else. These two
   * read routes must agree with it: a typo or a probe is a rejected request, not a bounded but
   * pointless store read. The kernel's own predicate is the reference — the regex is restated in
   * contracts only because contracts may not import the kernel at runtime.
   */
  it('accepts exactly the session ids the kernel calls canonical', () => {
    const candidates = [
      '0f1e2d3c-4b5a-4697-8899-aabbccddeeff',
      '0F1E2D3C-4B5A-4697-8899-AABBCCDDEEFF',
      'not-a-uuid',
      "'; DROP TABLE tape_entry; --",
      '',
      '0f1e2d3c4b5a46978899aabbccddeeff',
      ' 0f1e2d3c-4b5a-4697-8899-aabbccddeeff ',
    ]
    for (const sessionId of candidates) {
      const parsed = sessionMessages.request.safeParse({ sessionId, limit: 10 })
      expect([sessionId, parsed.success]).toEqual([sessionId, isCanonicalUuid(sessionId)])
    }
  })
})
