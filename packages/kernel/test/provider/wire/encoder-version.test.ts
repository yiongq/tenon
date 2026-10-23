/**
 * `encoder.version` moves with the bytes (spec 02, 01 修补 7: 「encoder.version 是编码器自己的版本号，
 * 凡改变编码结果的提交都加一」; invariant 33 trusts it). One fixed request per wire, reaching the
 * paths an encoder change would touch — thinking, vendor fields and blocks, tool pairs, images, the
 * spec 02 keys — and a table of the `promptHash` every version of that encoder gives it. A second
 * request covers the vendor fields of text and tool_use blocks that go back to the same model.
 * claude-5-5-models adds a third request for thinking off with between_tools at version 4.
 *
 * When this fails, the encoding changed: raise the wire's `ENCODER.version` by one and APPEND a row.
 * Never edit a row — an attempt recorded under that version was hashed from those bytes, and a
 * verifier re-encoding it trusts that "same encoder" means "same bytes".
 */
import { describe, expect, it } from 'vitest'
import {
  encodeAnthropicMessages,
  encodeOpenAIChat,
  encoderOf,
  modelWireHash,
} from '../../../src/index.js'
import type { EncodedRequest, ModelInfo, ProviderRequest } from '../../../src/index.js'
import { PNG_DATA, SIGNATURE, TOOL, assistant, user } from './fixtures.js'

/**
 * promptHash of the golden request, by encoder version. anthropic-messages 1 is ee2781a (step 6); 2 is
 * 3cb1249 (step 7), which added the top-level `cache_control` and left the version at 1; 3 judges the
 * vendor fields of text and tool_use blocks by their `vendorSource` (s6-spec-2, owner 2026-09-27) —
 * the golden text block has none, so its `citations` no longer go out. openai-chat never sent those
 * fields, so its bytes, and its version, stayed. openai-chat 2 writes the output limit under the
 * row's `maxTokensField` (M6 §对 01 的修补 3, T10): the golden row names `max_completion_tokens`, and
 * the same request on a row without the key is still row 1 (below).
 */
const GOLDEN: Readonly<
  Record<'anthropic-messages' | 'openai-chat', Readonly<Record<number, string>>>
> = {
  'anthropic-messages': {
    1: '19d4b9c002611705b354dff54d23898ea14195213b0e7da11f0c5174048f977f',
    2: '59a5fbf449219c9c34a2f8f127bde26bda8a920cbcacc2ec6d275034b8008866',
    3: 'e246329eaa8a7dd5129311efc0fb49b765740cd34a35c6fe3c70f9fdfb8c2f33',
    4: 'e246329eaa8a7dd5129311efc0fb49b765740cd34a35c6fe3c70f9fdfb8c2f33',
  },
  'openai-chat': {
    1: 'bf2278ab5d0fcfa5d95d523b4756ac6dfa0dcb9e220e6f525a596799c3e9e21a',
    2: 'bf62c43f6a9c9f044e9591bfd9cb43c739d0e7f6e348fb885876c0af8704703f',
  },
}

/**
 * modelWireHash of the golden rows as they stood before M6 (M6 不变量 5): `WIRE_MODEL_FIELDS` gained
 * `maxTokensField`, and a row that leaves it out must hash as it did, or every attempt recorded
 * before M6 would read as made under another model table.
 */
const GOLDEN_WIRE_HASH: Readonly<Record<'anthropic-messages' | 'openai-chat', string>> = {
  'anthropic-messages': '7798ded8ec0a944109e43dcd633778c3327a0583ac2b1334a31fd46ebea15711',
  'openai-chat': '5b0aff622cf665672c7d9153241690b8a4678b6e0a16df79ac9c081a8b1c78e5',
}

/**
 * promptHash of the same-model fields request, by anthropic-messages version. It starts at 3, the
 * version that began judging these fields by their `vendorSource` (s6-spec-2): the rows before it
 * cannot be rehashed. openai-chat has none — a field set its guard would send back has no place on
 * that wire and is refused, so no bytes of it exist to pin.
 */
const GOLDEN_FIELDS: Readonly<Record<number, string>> = {
  3: '27ed911f5a28ddc03ecc8661edc48fbc0e6efc548da70ef8d059d9feb8a78ad2',
  4: '27ed911f5a28ddc03ecc8661edc48fbc0e6efc548da70ef8d059d9feb8a78ad2',
}

/** claude-5-5-models 验收 4: the off-shape request begins at encoder version 4. */
const GOLDEN_OFF: Readonly<Record<number, string>> = {
  4: 'f323de5eb43842e075f335eff60d663880eb19a3c1ac5627e6b42fb6eae5a446',
}

/** Fixed here rather than read from a definition: a model-table edit is not an encoder change. */
const ANTHROPIC_ROW: ModelInfo = {
  id: 'claude-golden-1',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 16_000,
  reasoning: true,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: true,
  supportsCacheControl: true,
  thinkingPreservationFormat: 'signed-blocks',
  usageNeedsOptIn: false,
  thinkingSpec: {
    mode: 'adaptive',
    defaultOn: true,
    effortLevels: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    displays: ['summarized', 'omitted'],
    defaultDisplay: 'summarized',
  },
}

const BETWEEN_TOOLS_ROW: ModelInfo = {
  ...ANTHROPIC_ROW,
  thinkingSpec: {
    ...ANTHROPIC_ROW.thinkingSpec!,
    mode: 'adaptive-gated',
    disableMaxEffort: 'high',
    offType: 'between_tools',
  },
}

const OPENAI_ROW: ModelInfo = {
  id: 'glm-golden-1',
  providerId: 'zhipu',
  contextLimit: 128_000,
  maxOutputTokens: 8192,
  reasoning: true,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: true,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'reasoning-content',
  reasoningEchoField: 'reasoning_content',
  usageNeedsOptIn: true,
  requestParams: { thinking: { type: 'enabled' }, tool_stream: true },
  thinkingSpec: { mode: 'effort-only', defaultOn: true, effortLevels: ['low', 'high', 'max'] },
  maxTokensField: 'max_completion_tokens',
}

/** OPENAI_ROW as a builtin row is: without M6's key, so 01's `max_tokens`. */
const { maxTokensField: _field, ...OPENAI_ROW_WITHOUT_FIELD } = OPENAI_ROW

/** A same-model history with a tool pair, an image, vendor fields and a vendor block, ending on user. */
function goldenRequest(model: ModelInfo): ProviderRequest {
  const provider = model.providerId
  const providerModel = model.id
  return {
    model,
    system: 'You are Tenon.',
    tools: [TOOL],
    effort: 'high',
    ...(provider === 'anthropic' ? { display: 'summarized' as const } : {}),
    messages: [
      user({ type: 'text', text: 'Read a.ts' }),
      assistant(
        {
          type: 'thinking',
          text: 'It asks for a file.',
          signature: SIGNATURE,
          provider,
          providerModel,
          vendorFields: { future_field: 1 },
        },
        { type: 'text', text: 'Reading.', vendorFields: { citations: [] } },
        { type: 'tool-request', id: 'call_golden_1', name: 'read_file', input: { path: 'a.ts' } },
        // The one kind each wire decodes: an unknown block, a call the vendor ran itself.
        provider === 'anthropic'
          ? {
              type: 'vendor',
              provider,
              providerModel,
              raw: { type: 'future_block', n: 1 },
              replay: 'same-model',
            }
          : {
              type: 'vendor',
              provider,
              providerModel,
              raw: { id: 'call_golden_mcp', type: 'mcp', mcp: { name: 'web_search' } },
              replay: 'never',
            },
      ),
      user(
        {
          type: 'tool-response',
          id: 'call_golden_1',
          isError: false,
          content: [{ type: 'text', text: 'export {}' }],
        },
        { type: 'image', mediaType: 'image/png', data: PNG_DATA },
      ),
      assistant({ type: 'text', text: 'It is empty.' }),
      user({ type: 'text', text: 'Thanks.' }),
    ],
  }
}

/** The same golden history, with thinking off and no tool definitions. */
function offGoldenRequest(): ProviderRequest {
  const { tools: _tools, ...request } = goldenRequest(BETWEEN_TOOLS_ROW)
  return { ...request, thinking: { enabled: false }, effort: 'high' }
}

/**
 * Text and tool_use blocks whose vendor fields came from this very model, so the guard merges them
 * back (spec 02, 01 修补 2; s6-spec-2) — including a stored key the block's own must win over.
 */
function fieldsGoldenRequest(model: ModelInfo): ProviderRequest {
  const source = { provider: model.providerId, providerModel: model.id }
  return {
    model,
    tools: [TOOL],
    messages: [
      user({ type: 'text', text: 'Read a.ts' }),
      assistant(
        {
          type: 'text',
          text: 'Reading.',
          vendorFields: { citations: [{ type: 'char_location', cited_text: 'a.ts' }] },
          vendorSource: source,
        },
        {
          type: 'tool-request',
          id: 'call_golden_2',
          name: 'read_file',
          input: { path: 'a.ts' },
          vendorFields: { future_tool: [1, 2], id: 'call_stored' },
          vendorSource: source,
        },
      ),
      user({
        type: 'tool-response',
        id: 'call_golden_2',
        isError: false,
        content: [{ type: 'text', text: 'export {}' }],
      }),
    ],
  }
}

function versionOf(encoded: EncodedRequest): number {
  const encoder = encoderOf(encoded)
  if (encoder === null) throw new Error('no encoder recorded')
  return encoder.version
}

function goldenTables(
  wire: 'anthropic-messages' | 'openai-chat',
): readonly Readonly<Record<number, string>>[] {
  return wire === 'anthropic-messages' ? [GOLDEN[wire], GOLDEN_FIELDS, GOLDEN_OFF] : [GOLDEN[wire]]
}

function newestVersion(wire: 'anthropic-messages' | 'openai-chat'): number {
  return Math.max(...goldenTables(wire).flatMap((table) => Object.keys(table).map(Number)))
}

describe('encoder.version moves with the bytes (01 修补 7, invariant 33)', () => {
  const cases = [
    ['anthropic-messages', encodeAnthropicMessages(goldenRequest(ANTHROPIC_ROW), 'anthropic')],
    ['openai-chat', encodeOpenAIChat(goldenRequest(OPENAI_ROW), 'zhipu')],
  ] as const
  for (const [wire, encoded] of cases) {
    it(`claude-5-5-models 验收 4: ${wire}: the current version is the newest row, and its row is these bytes`, () => {
      const rows = GOLDEN[wire]
      expect(versionOf(encoded)).toBe(newestVersion(wire))
      expect(
        encoded.promptHash,
        `The ${wire} encoding changed. Raise its ENCODER.version by one and append a row; never edit one.`,
      ).toBe(rows[versionOf(encoded)])
      // A version must change at least one request, or introduce a new golden request.
      const tables = goldenTables(wire)
      for (let version = 2; version <= newestVersion(wire); version += 1) {
        expect(
          tables.some(
            (table) => table[version] !== undefined && table[version] !== table[version - 1],
          ),
          `${wire} version ${version} must change bytes in at least one table or start a new table`,
        ).toBe(true)
      }
    })
  }

  it('claude-5-5-models 验收 4: anthropic-messages: same-model text and tool_use fields have their own table', () => {
    const encoded = encodeAnthropicMessages(fieldsGoldenRequest(ANTHROPIC_ROW), 'anthropic')
    // Both field sets pass the guard, so these bytes are the merge-back path and not a drop.
    expect(encoded.thinkingDecisions).toEqual([
      { action: 'replay', reason: 'same-model' },
      { action: 'replay', reason: 'same-model' },
    ])
    expect(versionOf(encoded)).toBe(newestVersion('anthropic-messages'))
    expect(
      encoded.promptHash,
      'The anthropic-messages encoding changed. Raise its ENCODER.version by one and append a row to both tables; never edit one.',
    ).toBe(GOLDEN_FIELDS[versionOf(encoded)])
  })

  it('claude-5-5-models 验收 4: between_tools off has its own golden table from version 4', () => {
    const encoded = encodeAnthropicMessages(offGoldenRequest(), 'anthropic')
    expect(versionOf(encoded)).toBe(newestVersion('anthropic-messages'))
    expect(encoded.body).toHaveProperty('thinking', { type: 'between_tools' })
    expect(encoded.body).not.toHaveProperty('tools')
    expect(encoded.promptHash).toBe(GOLDEN_OFF[versionOf(encoded)])
  })

  it('M6 不变量 5: a row without maxTokensField is still openai-chat 1’s bytes and modelWireHash', () => {
    const encoded = encodeOpenAIChat(goldenRequest(OPENAI_ROW_WITHOUT_FIELD), 'zhipu')
    expect(
      encoded.promptHash,
      'A row without maxTokensField must encode as before M6: builtin rows never write the key.',
    ).toBe(GOLDEN['openai-chat'][1])
    expect(encoded.body).toHaveProperty('max_tokens', 8192)
    expect(encoded.body).not.toHaveProperty('max_completion_tokens')
    // Row 2's request differs only by the key the row names, carrying the same limit.
    const named = encodeOpenAIChat(goldenRequest(OPENAI_ROW), 'zhipu')
    expect(named.body).toHaveProperty('max_completion_tokens', 8192)
    expect(named.body).not.toHaveProperty('max_tokens')
    expect(modelWireHash(OPENAI_ROW_WITHOUT_FIELD)).toBe(GOLDEN_WIRE_HASH['openai-chat'])
    expect(modelWireHash(ANTHROPIC_ROW)).toBe(GOLDEN_WIRE_HASH['anthropic-messages'])
    // The key is a wire field: naming it moves the hash.
    expect(modelWireHash(OPENAI_ROW)).not.toBe(GOLDEN_WIRE_HASH['openai-chat'])
  })
})
