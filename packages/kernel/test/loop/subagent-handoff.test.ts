import { describe, expect, it } from 'vitest'
import {
  buildSubagentHandoff,
  handoffText,
  subagentElapsedFromTape,
  subagentElapsedMs,
} from '../../src/loop/subagent.js'
import {
  SUBAGENT_DEADLINE_MS,
  SUBAGENT_STEP_LIMIT,
  SUBAGENT_TOKEN_LIMIT,
  STEP_LIMIT,
} from '../../src/loop/limits.js'
import type { RunUsageLine, TapeEntry } from '../../src/tape/entry.js'

function fact(
  id: number,
  name: string,
  payload: Record<string, unknown>,
  options: Partial<TapeEntry> = {},
): TapeEntry {
  return {
    tenantId: 'tenant',
    sessionId: 'child',
    incarnationId: 'inc',
    entryId: id,
    name,
    kind: name === 'message/assistant' ? 'message' : 'event',
    sourceType: 'runtime_event',
    sourceId: 'run',
    sourceSeq: 1,
    provenanceKey: `key-${id}`,
    payload,
    meta: {},
    createdAt: id * 1000,
    contentHash: new Uint8Array(),
    prevHash: null,
    entryHash: new Uint8Array(),
    hashVer: 1,
    ...options,
  }
}
const ownUsage: RunUsageLine = {
  providerId: 'zhipu',
  modelId: 'glm-5.3',
  origin: 'own',
  requests: 2,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheWriteTokens: 3,
  reasoningTokens: 10,
}
const terminal = (id = 20, code = 'completed', usage: RunUsageLine[] = []) =>
  fact(id, 'execution/run_terminal', {
    reason: { code },
    usage,
    steps: 1,
    writer: { by: 'run', runId: 'run' },
  })
const call = (id: number, ordinal = 0, input: Record<string, unknown> = { file_path: '/w/link' }) =>
  fact(id, 'tool/call', {
    runId: 'run',
    requestSeq: 1,
    ordinal,
    providerToolCallId: `call${ordinal}`,
    messageId: 'reply',
    name: 'Read',
    input,
    argsHash: 'hash',
  })
const closed = (id: number, ordinal = 0, state = 'completed', source: string | null = null) =>
  fact(id, 'execution/tool_outcome', { ordinal, state, source })

describe('child handoff persisted evidence', () => {
  it('pins a dispatched symlink target to its decision, ignoring a later rejudgement', () => {
    const entries = [
      call(1),
      fact(2, 'tool/permission_decided', { ordinal: 0, target: { type: 'path', path: '/w/A' } }),
      fact(3, 'execution/dispatch_committed', { ordinal: 0, decisionKey: 'key-2' }),
      fact(4, 'tool/permission_decided', { ordinal: 0, target: { type: 'path', path: '/w/B' } }),
      closed(5),
      terminal(),
    ]
    expect(buildSubagentHandoff(entries, { childSessionId: 'child' }).calls).toEqual([
      { toolName: 'Read', target: '/w/A', state: 'completed', source: null },
    ])
  })

  it('uses the final non-dispatched decision, supports old cards, and never guesses missing paths', () => {
    const entries = [
      call(1),
      fact(2, 'tool/permission_decided', { ordinal: 0, target: { type: 'path', path: '/w/A' } }),
      fact(3, 'tool/permission_decided', {
        ordinal: 0,
        confirm: { target: { type: 'path', path: '/w/B' } },
      }),
      closed(4, 0, 'not-run', 'user-rejected'),
      call(5, 1, { z: false, a: 'raw\ntext' }),
      closed(6, 1, 'not-run', 'invalid-input'),
      terminal(),
    ]
    const handoff = buildSubagentHandoff(entries, { childSessionId: 'child' })
    expect(handoff.calls.map((row) => row.target)).toEqual([
      '/w/B',
      'unresolved: Read {"a":"raw\\ntext","z":false}',
    ])
    expect(handoffText(handoff)).toContain('user-rejected')
    expect(handoffText(handoff)).not.toContain('invalid-input')
  })

  it('keeps an old dispatched decision unresolved rather than borrowing a later target', () => {
    const entries = [
      call(1),
      fact(2, 'tool/permission_decided', { ordinal: 0 }),
      fact(3, 'execution/dispatch_committed', { ordinal: 0, decisionKey: 'key-2' }),
      fact(4, 'tool/permission_decided', { ordinal: 0, target: { type: 'path', path: '/w/B' } }),
      closed(5),
      terminal(),
    ]
    expect(buildSubagentHandoff(entries, { childSessionId: 'child' }).calls[0]?.target).toBe(
      'unresolved: Read {"file_path":"/w/link"}',
    )
  })

  it('combines every child Run usage once and retains the last reply verbatim after a late stop', () => {
    const entries = [
      terminal(1, 'paused', [ownUsage]),
      fact(2, 'message/assistant', {
        messageId: 'reply',
        revision: 0,
        role: 'assistant',
        status: 'complete',
        runId: 'run',
        content: [
          { type: 'text', text: ' first ' },
          { type: 'thinking', text: 'private', signature: 'sig' },
          { type: 'text', text: '\nlast' },
        ],
      }),
      terminal(3, 'completed', [ownUsage]),
    ]
    const handoff = buildSubagentHandoff(entries, { childSessionId: 'child', outcome: 'aborted' })
    expect(handoff).toMatchObject({
      outcome: 'aborted',
      childEndReason: 'completed',
      finalReply: ' first \nlast',
      usage: [
        {
          ...ownUsage,
          requests: 4,
          inputTokens: 200,
          outputTokens: 40,
          cacheReadTokens: 10,
          cacheWriteTokens: 6,
          reasoningTokens: 20,
        },
      ],
    })
    expect(handoffText(handoff)).toContain('Changes made before stopping remain in place.')
    expect(handoffText(handoff)).not.toContain('private')
  })

  it('reports partial failures and null reason while stopped on an approval or before child creation', () => {
    const failed = buildSubagentHandoff(
      [call(1), closed(2, 0, 'uncertain', 'crashed'), terminal(3, 'provider-error')],
      { childSessionId: 'child' },
    )
    expect(failed.outcome).toBe('partial')
    expect(handoffText(failed)).toContain('child end reason: provider-error')
    expect(handoffText(failed)).toContain('state: uncertain; source: crashed')
    expect(
      buildSubagentHandoff([terminal(1, 'paused')], {
        childSessionId: 'child',
        outcome: 'superseded',
      }).childEndReason,
    ).toBeNull()
    expect(
      handoffText(buildSubagentHandoff([], { childSessionId: 'child', outcome: 'uncertain' })),
    ).toContain('child end reason: none')
    expect(() => buildSubagentHandoff([call(1), terminal()], { childSessionId: 'child' })).toThrow(
      'open child call',
    )
  })

  it.each([
    [{ type: 'command', command: 'pwd', cwd: '/old' }, 'pwd (cwd: /old)'],
    [
      { type: 'search', query: 'query', host: 'api.anthropic.com' },
      'query (host: api.anthropic.com)',
    ],
    [{ type: 'url', url: 'https://example.test/?x=1' }, 'https://example.test/?x=1'],
    [{ type: 'tool', serverId: 'server', toolName: 'tool' }, 'server/tool'],
  ])('formats the recorded target %j without host IO', (target, expected) => {
    expect(
      buildSubagentHandoff(
        [
          call(1),
          fact(2, 'tool/permission_decided', { ordinal: 0, target }),
          closed(3),
          terminal(),
        ],
        { childSessionId: 'child' },
      ).calls[0]?.target,
    ).toBe(expected)
  })
})

describe('02 不变量 29 — child running time', () => {
  it('excludes paused gaps and counts an active Run only until now', () => {
    expect(
      subagentElapsedMs(
        [
          { startedAt: 1000, endedAt: 2000 },
          { startedAt: 100000, endedAt: null },
        ],
        105000,
      ),
    ).toBe(6000)
    expect(SUBAGENT_STEP_LIMIT).toBe(30)
    expect(SUBAGENT_STEP_LIMIT).toBeLessThan(STEP_LIMIT)
    expect(SUBAGENT_TOKEN_LIMIT).toBe(500000)
    expect(SUBAGENT_DEADLINE_MS).toBe(300000)
  })
  it('does not count downtime or recovery writes, including resumed calls owned by another Run', () => {
    const entries = [
      fact(1, 'execution/run_started', {}, { createdAt: 1000 }),
      fact(
        2,
        'tool/permission_decided',
        { writer: { by: 'run', runId: 'run' } },
        { sourceId: 'original', createdAt: 4000 },
      ),
      fact(3, 'execution/tool_outcome', { writer: { by: 'recovery' } }, { createdAt: 100000 }),
      fact(
        4,
        'execution/run_terminal',
        { writer: { by: 'recovery' }, reason: { code: 'recovered' } },
        { createdAt: 100000 },
      ),
      fact(5, 'execution/run_started', {}, { sourceId: 'next', createdAt: 200000 }),
    ]
    expect(subagentElapsedFromTape(entries, 202000)).toBe(5000)
  })
})
