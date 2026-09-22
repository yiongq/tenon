/**
 * The entry model's two load-bearing properties, asserted through the package barrel (so a missing
 * export is a red test rather than a surprise in step 4):
 *
 * 1. Every phase-1 payload type is assignable to `NewEntry.payload`. That only holds because the
 *    payloads are type aliases — an interface gets no implicit index signature — so this file is
 *    what stops someone turning them into interfaces.
 * 2. Every phase-1 payload survives `canonicalJson`. This is why `ForkOrigin.entryHash` is hex and
 *    not `Uint8Array`: a payload is JSON, and canonical JSON admits no typed arrays.
 */
import { describe, expect, it } from 'vitest'
import type {
  AssistantMessagePayload,
  AttemptCompletedPayload,
  MessageRetractedPayload,
  ModelSelectedPayload,
  NewEntry,
  SessionStartPayload,
  SnapshotCoordinate,
  UserMessagePayload,
} from '../../src/index.js'
import {
  CanonicalJsonError,
  TAPE_KINDS,
  TAPE_SOURCE_TYPES,
  TapeAppendAuthorizationError,
  TapeHashRecipeError,
  TapeIntegerRangeError,
  TapeNameSyntaxError,
  TapeProvenanceSyntaxError,
  canonicalJson,
  contentHash,
  createEntryWriter,
  hashEntry,
  messageRevisionKey,
  sessionStartKey,
} from '../../src/index.js'

const INCARNATION = '11111111-1111-4111-8111-111111111111'
const MESSAGE = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'

type TextBlock = { type: 'text'; text: string }

const start: SessionStartPayload = {
  incarnationId: INCARNATION,
  forkedFrom: {
    sessionId: 'session-0',
    incarnationId: '44444444-4444-4444-8444-444444444444',
    entryId: 12,
    // Hex, because the parent's entry_hash has to travel inside JSON.
    entryHash: '068a4166b50adf36991d71ef15678efaf3b606b04308c766a65fcb7568324519',
  },
}

const user: UserMessagePayload<TextBlock> = {
  messageId: MESSAGE,
  revision: 0,
  role: 'user',
  content: [{ type: 'text', text: 'hi' }],
  status: 'complete',
}

const assistant: AssistantMessagePayload<TextBlock> = {
  messageId: MESSAGE,
  revision: 0,
  role: 'assistant',
  content: [{ type: 'text', text: 'hello' }],
  status: 'complete',
  runId: RUN,
}

const retracted: MessageRetractedPayload = { messageId: MESSAGE, reason: 'user-deleted' }
const modelSelected: ModelSelectedPayload = { providerId: 'anthropic', modelId: 'claude-x' }

const attempt: AttemptCompletedPayload = {
  providerId: 'anthropic',
  modelId: 'claude-x',
  contextAtEntryId: 4,
  request: { systemHash: 'ab'.repeat(32), maxTokens: 1024, temperature: 0.2 },
  promptHash: 'cd'.repeat(32),
  toolDefinitionsHash: 'ef'.repeat(32),
  thinkingDecisions: [],
  usage: null,
  stop: { reason: 'end-turn' },
  error: null,
}

const payloads: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['session/start', start],
  ['message/user', user],
  ['message/assistant', assistant],
  ['message/retracted', retracted],
  ['session/model_selected', modelSelected],
  ['provider/attempt_completed', attempt],
]

describe('phase-1 payloads', () => {
  for (const [name, payload] of payloads) {
    it(`${name} fits NewEntry.payload and survives canonicalJson`, () => {
      const json = canonicalJson(payload)
      expect(json.startsWith('{')).toBe(true)
      expect(JSON.parse(json)).toEqual(payload)
      // Same text twice, and the stored text is what gets hashed.
      expect(canonicalJson(payload)).toBe(json)
      expect(contentHash(json, '{}')).toHaveLength(32)
    })
  }

  it('user messages carry nothing that varies per run, so a retry is idempotent', () => {
    // A resent user message reuses messageId and revision; if the payload held a runId the second
    // append would be "same key, different content" — a TapeProvenanceConflictError, not a retry.
    const resent: UserMessagePayload<TextBlock> = { ...user }
    expect(canonicalJson(resent)).toBe(canonicalJson(user))
    expect(messageRevisionKey(user.messageId, user.revision)).toBe(
      messageRevisionKey(resent.messageId, resent.revision),
    )
    expect(Object.keys(user)).not.toContain('runId')
    expect(Object.keys(assistant)).toContain('runId')
  })

  it('rejects bytes inside a payload, which is why lineage hashes are hex', () => {
    expect(() => canonicalJson({ forkedFrom: { entryHash: new Uint8Array([1, 2, 3]) } })).toThrow(
      /plain object/,
    )
  })
})

describe('a writer plus a builder produce a complete NewEntry', () => {
  it('assembles session/start', () => {
    const entry: NewEntry = createEntryWriter('session')('session/start', {
      sourceType: 'session',
      sourceId: 'session-1',
      sourceSeq: 0,
      provenanceKey: sessionStartKey(INCARNATION),
      payload: start,
      createdAt: 1_700_000_000_000,
    })
    expect(entry.kind).toBe('anchor')
    expect(entry.provenanceKey).toBe(`session:v1:start:${INCARNATION}`)
  })

  it('pins a snapshot coordinate to (incarnationId, entryId)', () => {
    const coordinate: SnapshotCoordinate = { incarnationId: INCARNATION, entryId: 12 }
    expect(canonicalJson(coordinate)).toBe(`{"entryId":12,"incarnationId":"${INCARNATION}"}`)
  })
})

/**
 * `packages/kernel/package.json` exposes only `.` and `./testing`, so anything the barrel does not
 * re-export is unreachable from `apps/desktop` — a store cannot throw or `instanceof`-catch an error
 * the spec says the kernel owns. Every test above matches on message regexes, which is exactly why a
 * missing class export went unnoticed; these assertions are about the export, not the behaviour.
 */
describe('the kernel-defined tape errors are reachable from the package index', () => {
  it('exports every error class a store or a host has to catch by name', () => {
    const classes = [
      CanonicalJsonError,
      TapeAppendAuthorizationError,
      TapeHashRecipeError,
      TapeIntegerRangeError,
      TapeNameSyntaxError,
      TapeProvenanceSyntaxError,
    ]
    for (const cls of classes) {
      expect(typeof cls).toBe('function')
      const instance = new cls('probe')
      expect(instance).toBeInstanceOf(Error)
      expect(instance.name).toBe(cls.name)
    }
  })

  it('throws TapeIntegerRangeError, the name spec §存储端口 gives it, from the recipe', () => {
    // Acceptance 15 has a store throw this on a read; the kernel owns the class, so it is the same
    // one here and there.
    expect(() =>
      hashEntry({
        hashVer: 1,
        tenantId: 't',
        sessionId: 's',
        incarnationId: INCARNATION,
        entryId: 2 ** 53,
        kind: 'anchor',
        name: 'session/start',
        sourceType: 'session',
        sourceId: 's',
        sourceSeq: 0,
        provenanceKey: sessionStartKey(INCARNATION),
        createdAt: 1,
        contentHash: new Uint8Array(32),
        prevHash: null,
      }),
    ).toThrow(TapeIntegerRangeError)
  })

  it('exports the closed vocabularies as frozen runtime lists', () => {
    expect(Object.isFrozen(TAPE_KINDS)).toBe(true)
    expect(Object.isFrozen(TAPE_SOURCE_TYPES)).toBe(true)
    expect([...TAPE_KINDS]).toEqual([
      'message',
      'tool_call',
      'tool_result',
      'anchor',
      'event',
      'context',
    ])
    expect([...TAPE_SOURCE_TYPES]).toEqual([
      'session',
      'message',
      'tool_call',
      'tool_result',
      'runtime_event',
      'summary',
      'subagent',
      'migration',
    ])
  })
})
