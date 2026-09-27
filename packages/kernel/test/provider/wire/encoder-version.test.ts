/**
 * `encoder.version` moves with the bytes (spec 02, 01 修补 7: 「encoder.version 是编码器自己的版本号，
 * 凡改变编码结果的提交都加一」; invariant 33 trusts it). One fixed request per wire, reaching the
 * paths an encoder change would touch — thinking, vendor fields and blocks, tool pairs, images, the
 * spec 02 keys — and a table of the `promptHash` every version of that encoder gives it.
 *
 * When this fails, the encoding changed: raise the wire's `ENCODER.version` by one and APPEND a row.
 * Never edit a row — an attempt recorded under that version was hashed from those bytes, and a
 * verifier re-encoding it trusts that "same encoder" means "same bytes".
 */
import { describe, expect, it } from 'vitest'
import { encodeAnthropicMessages, encodeOpenAIChat, encoderOf } from '../../../src/index.js'
import type { EncodedRequest, ModelInfo, ProviderRequest } from '../../../src/index.js'
import { PNG_DATA, SIGNATURE, TOOL, assistant, user } from './fixtures.js'

/**
 * promptHash of the golden request, by encoder version. anthropic-messages 1 is ee2781a (step 6); 2 is
 * 3cb1249 (step 7), which added the top-level `cache_control` and left the version at 1; 3 judges the
 * vendor fields of text and tool_use blocks by their `vendorSource` (s6-spec-2, owner 2026-09-27) —
 * the golden text block has none, so its `citations` no longer go out. openai-chat never sent those
 * fields, so its bytes, and its version, stayed.
 */
const GOLDEN: Readonly<
  Record<'anthropic-messages' | 'openai-chat', Readonly<Record<number, string>>>
> = {
  'anthropic-messages': {
    1: '19d4b9c002611705b354dff54d23898ea14195213b0e7da11f0c5174048f977f',
    2: '59a5fbf449219c9c34a2f8f127bde26bda8a920cbcacc2ec6d275034b8008866',
    3: 'e246329eaa8a7dd5129311efc0fb49b765740cd34a35c6fe3c70f9fdfb8c2f33',
  },
  'openai-chat': {
    1: 'bf2278ab5d0fcfa5d95d523b4756ac6dfa0dcb9e220e6f525a596799c3e9e21a',
  },
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
}

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

function versionOf(encoded: EncodedRequest): number {
  const encoder = encoderOf(encoded)
  if (encoder === null) throw new Error('no encoder recorded')
  return encoder.version
}

describe('encoder.version moves with the bytes (01 修补 7, invariant 33)', () => {
  const cases = [
    ['anthropic-messages', encodeAnthropicMessages(goldenRequest(ANTHROPIC_ROW), 'anthropic')],
    ['openai-chat', encodeOpenAIChat(goldenRequest(OPENAI_ROW), 'zhipu')],
  ] as const
  for (const [wire, encoded] of cases) {
    it(`${wire}: the current version is the newest row, and its row is these bytes`, () => {
      const rows = GOLDEN[wire]
      const versions = Object.keys(rows).map(Number)
      expect(versionOf(encoded)).toBe(Math.max(...versions))
      expect(
        encoded.promptHash,
        `The ${wire} encoding changed. Raise its ENCODER.version by one and append a row; never edit one.`,
      ).toBe(rows[versionOf(encoded)])
      // A version is one encoding: two rows with one hash would be a bump that changed nothing.
      expect(new Set(Object.values(rows)).size).toBe(versions.length)
    })
  }
})
