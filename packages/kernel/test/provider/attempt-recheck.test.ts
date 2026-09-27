/**
 * The attempt re-check (spec 02 §组装清单与内容寄存「复算 promptHash」; 02 不变量 33; acceptance 7's last
 * clause; plan step 6: 旧 42 and the assembly half of 旧 112, which waited on step 10's manifest).
 *
 * One session over both real adapters and fakeNetwork: a builtin Anthropic row with an effort (tools
 * sent, the snapshot carrying effort and display), a builtin Zhipu row with an effort (the other wire),
 * then a hand-typed Anthropic model that takes no tools (a synthesised row, tools withheld). Every
 * attempt it leaves is re-checked by `recheckAttempt`, which reads the Tape and nothing else for the
 * re-encode: the current model table is handed in only for the 「模型表已变」 verdict.
 */
import { describe, expect, it } from 'vitest'
import {
  ZHIPU_DEFAULT_BASE_URL,
  anthropicDefinition,
  canonicalJson,
  createMemoryTapeStore,
  encodeAnthropicMessages,
  encodeOpenAIChat,
  modelWireHash,
  sha256Hex,
  zhipuDefinition,
} from '../../src/index.js'
import type { ModelInfo, Provider, TapeEntry, TapeStore } from '../../src/index.js'
import {
  assertLastTurnIsUser,
  assertToolPairing,
  createCounterIds,
  createTestLoopPorts,
  createTestSessionService,
  fakeNetwork,
  recheckAttempt,
} from '../../src/testing/index.js'
import type { AttemptRecheck, FakeNetwork } from '../../src/testing/index.js'
import { LOOK, instantHost, lookSource, proxyStore } from '../loop/support.js'
import * as anthropicFixture from './fixtures/anthropic-sse.js'
import * as openAIFixture from './fixtures/openai-sse.js'

const IDENTITY = {
  userId: 'recheck-user',
  tenantId: 'recheck-tenant',
  profileDir: '/tenon/recheck',
}
const SESSION = '5b2e8c1d-6b3d-4a71-9f52-0c8de7a11c33'

type Wire = 'anthropic-messages' | 'openai-chat'

function row(rows: readonly ModelInfo[], id: string): ModelInfo {
  const found = rows.find((model) => model.id === id)
  if (found === undefined) throw new Error(`no ${id} row`)
  return found
}

const SONNET = row(anthropicDefinition.builtinModels, 'claude-sonnet-5')
const FLASH = row(zhipuDefinition.builtinModels, 'glm-5.3-flash')
/** Hand-typed: its capabilities are synthesised, and it takes no tools (旧 36 ①). */
const TYPED: ModelInfo = {
  ...SONNET,
  id: 'claude-own-model',
  supportsToolCalling: false,
  supportsStreamingToolCalls: false,
}

/** The model table as it stands when the session ran: both definitions' rows and the typed one. */
const TABLE: readonly ModelInfo[] = [
  ...anthropicDefinition.builtinModels,
  ...zhipuDefinition.builtinModels,
  TYPED,
]

function lookup(
  table: readonly ModelInfo[],
): (providerId: string, modelId: string) => ModelInfo | null {
  return (providerId, modelId) =>
    table.find((model) => model.providerId === providerId && model.id === modelId) ?? null
}

function callTurn(wire: Wire, id: string): readonly string[] {
  const calls = [{ id, name: LOOK, args: JSON.stringify({ at: id }) }]
  return wire === 'anthropic-messages'
    ? anthropicFixture.turnFrames(['Looking.'], calls, 'tool_use')
    : openAIFixture.turnFrames(['Looking.'], calls, 'tool_calls')
}

function textTurn(wire: Wire): readonly string[] {
  return wire === 'anthropic-messages'
    ? anthropicFixture.turnFrames(['Done.'], [], 'end_turn')
    : openAIFixture.turnFrames(['Done.'], [], 'stop')
}

function wireProvider(wire: Wire, exchanges: readonly (readonly string[])[]): Provider {
  const net: FakeNetwork = fakeNetwork(
    exchanges.map((frames) => ({ kind: 'sse' as const, frames })),
    {
      checkRequest: (request) => {
        assertToolPairing(request)
        assertLastTurnIsUser(request)
      },
    },
  )
  const definition = wire === 'anthropic-messages' ? anthropicDefinition : zhipuDefinition
  return definition.create({
    network: net,
    clock: { now: () => 0, setTimeout: () => () => undefined },
    config: {
      baseURL:
        wire === 'anthropic-messages' ? 'https://api.anthropic.test' : ZHIPU_DEFAULT_BASE_URL,
    },
    secrets: { apiKey: 'test-key-not-a-real-credential' },
  })
}

/** The session described above; its store and every attempt fact on it, in order. */
async function recordedSession(): Promise<{ store: TapeStore; attempts: TapeEntry[] }> {
  const anthropic = wireProvider('anthropic-messages', [
    callTurn('anthropic-messages', 'toolu_r1'),
    textTurn('anthropic-messages'),
    textTurn('anthropic-messages'),
  ])
  const zhipu = wireProvider('openai-chat', [
    callTurn('openai-chat', 'call_r2'),
    textTurn('openai-chat'),
  ])
  const store = createMemoryTapeStore({ identity: IDENTITY })
  const sources = [lookSource([])]
  const loop = createTestLoopPorts({
    connector: { provider: anthropic, model: SONNET, effort: 'low', mcpSources: sources },
  })
  const service = createTestSessionService(
    {
      host: instantHost(),
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
    },
    { tools: {}, userSetting: () => ({ userSetting: 'always-allow' }) },
  )
  service.bindLoop(loop)
  const send = async (text: string): Promise<void> => {
    const sent = await service.send({ sessionId: SESSION, origin: null, text })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    expect((await loop.runEnded({ runId: sent.runId })).reason.code).toBe('completed')
  }
  await send('look on A')
  loop.connector.use({ provider: zhipu, model: FLASH, effort: 'high', mcpSources: sources })
  await send('look on Z')
  loop.connector.use({
    provider: anthropic,
    model: TYPED,
    capabilitySource: 'user',
    mcpSources: sources,
  })
  await send('text only now')
  const entries = (await store.readRange({ sessionId: SESSION, limit: 1000 })).entries
  return { store, attempts: entries.filter((entry) => entry.name === 'provider/attempt_completed') }
}

function recheck(
  store: TapeStore,
  attempt: TapeEntry,
  table: readonly ModelInfo[] = TABLE,
): Promise<AttemptRecheck> {
  return recheckAttempt(store, { sessionId: SESSION, attempt, currentModel: lookup(table) })
}

function wireOf(attempt: TapeEntry): Wire {
  return (attempt.payload['encoder'] as { wire: Wire }).wire
}

/** The promptHash the rebuilt request encodes to, on the attempt's own wire. */
function promptHashOf(result: AttemptRecheck, attempt: TapeEntry): string {
  if (result.verdict !== 'verified' && result.verdict !== 'model-table-changed') {
    throw new Error(`attempt ${attempt.entryId}: ${JSON.stringify(result)}`)
  }
  const providerId = String(attempt.payload['providerId'])
  return wireOf(attempt) === 'anthropic-messages'
    ? encodeAnthropicMessages(result.request, providerId).promptHash
    : encodeOpenAIChat(result.request, providerId).promptHash
}

describe('re-encoding an attempt from its assembly alone', () => {
  it('02 不变量 33: every attempt of the session recomputes its promptHash, on both wires', async () => {
    const { store, attempts } = await recordedSession()
    // Two requests per tool round on each wire, then the typed model's one.
    expect(attempts.map(wireOf)).toEqual([
      'anthropic-messages',
      'anthropic-messages',
      'openai-chat',
      'openai-chat',
      'anthropic-messages',
    ])
    const results = await Promise.all(attempts.map((attempt) => recheck(store, attempt)))
    expect(results.map((result) => result.verdict)).toEqual(Array(5).fill('verified'))
    // The rebuilt requests are the ones the three shapes produce: the frozen table's tools sent on
    // the first four and withheld from the typed model; each with the incarnation's one system text;
    // the snapshot's effort (and, on the Anthropic row, its display) carried back in.
    const requests = results.map((result) =>
      result.verdict === 'verified' ? result.request : null,
    )
    const toolNames = requests.map((request) => request?.tools?.map((tool) => tool.name) ?? [])
    expect(toolNames[0]).toContain(LOOK)
    expect(toolNames).toEqual([toolNames[0], toolNames[0], toolNames[0], toolNames[0], []])
    expect(new Set(requests.map((request) => request?.system)).size).toBe(1)
    expect(requests[0]?.system).toEqual(expect.any(String))
    expect(requests.map((request) => request?.effort)).toEqual([
      'low',
      'low',
      'high',
      'high',
      undefined,
    ])
    expect(requests[0]?.display).toBe('summarized')
    expect(requests.map((request) => request?.model.id)).toEqual([
      SONNET.id,
      SONNET.id,
      FLASH.id,
      FLASH.id,
      TYPED.id,
    ])
    // 「清空模型注册表」: with no table at all the verdict changes, the recompute does not.
    for (const attempt of attempts) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time keeps a failure readable
      const blind = await recheck(store, attempt, [])
      expect(blind).toMatchObject({ verdict: 'model-table-changed', currentModelWireHash: null })
      expect(promptHashOf(blind, attempt)).toBe(attempt.payload['promptHash'])
    }
  })

  it('files the full ModelInfo under view/assembled.modelInfoHash and its wire fields under modelWireHash (旧 112)', async () => {
    const { store, attempts } = await recordedSession()
    const entries = (await store.readRange({ sessionId: SESSION, limit: 1000 })).entries
    for (const attempt of attempts) {
      const manifest = entries.find(
        (entry) => entry.provenanceKey === attempt.payload['assemblyRef'],
      )
      const modelInfoHash = manifest?.payload['modelInfoHash']
      const stored = entries.find(
        (entry) =>
          entry.name === 'view/content' &&
          entry.payload['type'] === 'model_info' &&
          entry.payload['hash'] === modelInfoHash,
      )?.payload['model'] as ModelInfo
      const sent = lookup(TABLE)(
        String(attempt.payload['providerId']),
        String(attempt.payload['modelId']),
      )
      expect(stored).toEqual(sent)
      expect(sha256Hex(canonicalJson(stored))).toBe(modelInfoHash)
      expect(modelWireHash(stored)).toBe(attempt.payload['modelWireHash'])
    }
  })

  it('reports 「模型表已变」, not tampering, after a row encode() reads is edited, and still recomputes (旧 42)', async () => {
    const { store, attempts } = await recordedSession()
    const edited = TABLE.map((model) =>
      model === FLASH ? { ...model, maxOutputTokens: model.maxOutputTokens - 1 } : model,
    )
    const results = await Promise.all(attempts.map((attempt) => recheck(store, attempt, edited)))
    expect(results.map((result) => result.verdict)).toEqual([
      'verified',
      'verified',
      'model-table-changed',
      'model-table-changed',
      'verified',
    ])
    const changed = results[2]
    expect(changed).toMatchObject({
      verdict: 'model-table-changed',
      currentModelWireHash: modelWireHash({ ...FLASH, maxOutputTokens: FLASH.maxOutputTokens - 1 }),
    })
    // The original promptHash, from the ModelInfo original the manifest holds.
    results.forEach((result, i) => {
      const attempt = attempts[i]
      if (attempt === undefined) throw new Error('no attempt')
      expect(promptHashOf(result, attempt)).toBe(attempt.payload['promptHash'])
    })
    // A field encode() never reads is no change to the wire: the verdict stays 'verified' (M3).
    const repriced = TABLE.map((model) =>
      model === FLASH ? { ...model, pricing: { inputPerMTok: 9, outputPerMTok: 9 } } : model,
    )
    const same = await Promise.all(attempts.map((attempt) => recheck(store, attempt, repriced)))
    expect(same.map((result) => result.verdict)).toEqual(Array(5).fill('verified'))
  })

  it('reports tampering when the Tape itself no longer reproduces the record, whatever the table says', async () => {
    const { store, attempts } = await recordedSession()
    const flash = attempts[2]
    if (flash === undefined) throw new Error('no Zhipu attempt')
    // The same edit as above, made to the stored original instead of the table: that is tampering.
    const shorter = { ...FLASH, maxOutputTokens: FLASH.maxOutputTokens - 1 }
    const editedOriginal = rewritten(store, (entry) =>
      entry.name === 'view/content' && entry.payload['type'] === 'model_info'
        ? { ...entry, payload: { ...entry.payload, model: shorter } }
        : entry,
    )
    const edited = TABLE.map((model) => (model === FLASH ? shorter : model))
    expect(await recheck(editedOriginal, flash, edited)).toMatchObject({
      verdict: 'tampered',
      problems: expect.arrayContaining([
        'the stored ModelInfo does not hash to view/assembled.modelInfoHash',
      ]),
    })
    // A message changed after the fact: the context no longer encodes to the recorded hash.
    const editedMessage = rewritten(store, (entry) =>
      entry.name === 'message/user'
        ? { ...entry, payload: { ...entry.payload, content: [{ type: 'text', text: 'other' }] } }
        : entry,
    )
    expect(await recheck(editedMessage, flash, edited)).toEqual({
      verdict: 'tampered',
      problems: ['the promptHash does not recompute'],
    })
  })

  // 02 不变量 33 (plan step 6, 旧 42): each original is checked against the name it is filed under,
  // and a record edited to agree with a changed table is tampering, never 「模型表已变」 or verified.
  it('names the original that no longer matches, and never passes an edited record', async () => {
    const { store, attempts } = await recordedSession()
    const [first, second, flash] = attempts
    if (first === undefined || second === undefined || flash === undefined) {
      throw new Error('no attempts')
    }
    // The second request of the first run pointing at the first request's manifest.
    const borrowed = String(first.payload['assemblyRef'])
    expect(
      await recheck(store, { ...second, payload: { ...second.payload, assemblyRef: borrowed } }),
    ).toEqual({
      verdict: 'tampered',
      problems: [`the attempt names the manifest ${borrowed}, not its own request's`],
    })
    // The attempt's modelWireHash rewritten to match an edited table row.
    const shorter = { ...FLASH, maxOutputTokens: FLASH.maxOutputTokens - 1 }
    const edited = TABLE.map((model) => (model === FLASH ? shorter : model))
    expect(
      await recheck(
        store,
        { ...flash, payload: { ...flash.payload, modelWireHash: modelWireHash(shorter) } },
        edited,
      ),
    ).toEqual({
      verdict: 'tampered',
      problems: ["the stored ModelInfo's wire fields do not hash to attempt.modelWireHash"],
    })
    // The request snapshot naming another system prompt than its manifest.
    const snapshot = first.payload['request'] as Record<string, unknown>
    expect(
      await recheck(store, {
        ...first,
        payload: { ...first.payload, request: { ...snapshot, systemHash: 'f'.repeat(64) } },
      }),
    ).toEqual({
      verdict: 'tampered',
      problems: ['the request snapshot and the manifest name different system prompts'],
    })
    // The stored system text edited under its old name.
    const otherSystem = rewritten(store, (entry) =>
      entry.name === 'view/content' && entry.payload['type'] === 'system'
        ? { ...entry, payload: { ...entry.payload, text: 'another system prompt' } }
        : entry,
    )
    expect(await recheck(otherSystem, first)).toEqual({
      verdict: 'tampered',
      problems: ['the stored system text does not hash to its name'],
    })
    // The frozen tool table losing a row: every spec left still hashes to its name.
    const fewerTools = rewritten(store, (entry) =>
      entry.name === 'view/tool_table'
        ? {
            ...entry,
            payload: {
              ...entry.payload,
              tools: (entry.payload['tools'] as unknown[]).slice(0, -1),
            },
          }
        : entry,
    )
    expect(await recheck(fewerTools, first)).toEqual({
      verdict: 'tampered',
      problems: ['the promptHash does not recompute', 'the toolDefinitionsHash does not recompute'],
    })
  })

  it('leaves out the records invariant 33 does not speak of', async () => {
    const { store, attempts } = await recordedSession()
    const first = attempts[0]
    if (first === undefined) throw new Error('no attempt')
    const { assemblyRef: _ref, ...phaseOne } = first.payload
    expect(
      await recheckAttempt(store, {
        sessionId: SESSION,
        attempt: { ...first, payload: phaseOne },
        currentModel: lookup(TABLE),
      }),
    ).toEqual({ verdict: 'not-covered', reason: 'no-assembly' })
    const encoder = first.payload['encoder'] as { version: number }
    expect(
      await recheckAttempt(store, {
        sessionId: SESSION,
        attempt: {
          ...first,
          payload: { ...first.payload, encoder: { ...encoder, version: encoder.version + 1 } },
        },
        currentModel: lookup(TABLE),
      }),
    ).toEqual({ verdict: 'not-covered', reason: 'other-encoder' })
  })
})

/** The store with every read fact passed through `edit`: what a Tape changed behind the store looks like. */
function rewritten(store: TapeStore, edit: (entry: TapeEntry) => TapeEntry): TapeStore {
  return proxyStore(store, {
    readRange: async (q) => {
      const page = await store.readRange(q)
      return { ...page, entries: page.entries.map(edit) }
    },
  })
}
