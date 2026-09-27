import { messageRowSchema } from '@tenon-app/contracts'
import type { MessageRow } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { projectedRow } from '../src/main/session.js'

/**
 * Spec 02 plan step 6, 旧 101 (原样块取乙): what the vendor sent verbatim stays in the kernel. A row
 * leaves the main process without `vendor` blocks, `vendorFields` or `vendorSource` (s6-spec-2), and
 * still passes the contracts' response schema, which is unchanged.
 */
const SESSION = '11111111-1111-4111-8111-111111111111'

function row(content: MessageRow['content']): MessageRow {
  return {
    sessionId: SESSION,
    messageId: 'm1',
    orderSeq: 1,
    role: 'assistant',
    status: 'complete',
    content,
    entryId: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('projectedRow', () => {
  it('strips vendor blocks and vendor fields, and the result passes messageRowSchema', () => {
    const stored = row([
      {
        type: 'text',
        text: 'hi',
        vendorFields: { citations: [{ url: 'https://example.com' }] },
        // Where the fields came from (s6-spec-2, owner 2026-09-27): the guard's, not the renderer's.
        vendorSource: { provider: 'anthropic', providerModel: 'claude-opus-5-5' },
      },
      {
        type: 'thinking',
        text: 'why',
        signature: 'sig',
        provider: 'anthropic',
        providerModel: 'claude-opus-5-5',
        vendorFields: { extra: 1 },
      },
      {
        type: 'vendor',
        provider: 'anthropic',
        providerModel: 'claude-opus-5-5',
        raw: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
        replay: 'never',
      },
      {
        type: 'tool-request',
        id: 't1',
        name: 'Read',
        input: { path: '/a' },
        vendorFields: { x: 2 },
        vendorSource: { provider: 'anthropic', providerModel: 'claude-opus-5-5' },
      },
    ])
    const out = projectedRow(stored)
    expect(out.content).toEqual([
      { type: 'text', text: 'hi' },
      {
        type: 'thinking',
        text: 'why',
        signature: 'sig',
        provider: 'anthropic',
        providerModel: 'claude-opus-5-5',
      },
      { type: 'tool-request', id: 't1', name: 'Read', input: { path: '/a' } },
    ])
    expect(messageRowSchema.safeParse(out).success).toBe(true)
    // The stored row itself does not parse: that is why the strip exists.
    expect(messageRowSchema.safeParse(stored).success).toBe(false)
  })

  it('keeps a row of nothing but vendor blocks, with empty content, so paging still lines up', () => {
    const out = projectedRow(
      row([
        {
          type: 'vendor',
          provider: 'zhipu',
          providerModel: 'glm-5.3',
          raw: { type: 'mcp', id: 'c1' },
          replay: 'never',
        },
      ]),
    )
    expect(out).toMatchObject({ messageId: 'm1', orderSeq: 1, content: [] })
    expect(messageRowSchema.safeParse(out).success).toBe(true)
  })
})
