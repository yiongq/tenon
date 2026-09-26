/**
 * Fixtures shared by the two wire encoders' tests. Not a test file itself: the kernel's vitest
 * project only collects files whose name ends in `.test.ts`.
 */
import type {
  ContentBlock,
  InternalMessage,
  ModelInfo,
  ProviderRequest,
  ToolSpec,
} from '../../../src/index.js'

/** A signature with the base64 alphabet in it: every assertion on it is byte equality. */
export const SIGNATURE = 'EqoBCkgIARABGAIiQL2+/wK3Zg=='
export const REDACTED_DATA = 'RURBQ1RFRA=='
export const PNG_DATA = 'iVBORw0KGgoAAAANSUhEUg=='

/** A signed-blocks model on the Anthropic wire. */
export function anthropicModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'claude-test-4',
    providerId: 'anthropic',
    contextLimit: 200_000,
    maxOutputTokens: 8192,
    reasoning: true,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: true,
    supportsCacheControl: true,
    thinkingPreservationFormat: 'signed-blocks',
    usageNeedsOptIn: false,
    ...overrides,
  }
}

/** An OpenAI-compatible model; the spec's second provider is zhipu, hence the ids. */
export function openAIModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'glm-test',
    providerId: 'zhipu',
    contextLimit: 128_000,
    maxOutputTokens: 4096,
    reasoning: true,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: true,
    supportsCacheControl: false,
    thinkingPreservationFormat: 'drop',
    usageNeedsOptIn: true,
    ...overrides,
  }
}

export function thinkingBlock(
  overrides: Partial<Extract<ContentBlock, { type: 'thinking' }>> = {},
): Extract<ContentBlock, { type: 'thinking' }> {
  return {
    type: 'thinking',
    text: 'weighing the options',
    signature: SIGNATURE,
    provider: 'anthropic',
    providerModel: 'claude-test-4',
    ...overrides,
  }
}

export function redactedBlock(
  overrides: Partial<Extract<ContentBlock, { type: 'redacted-thinking' }>> = {},
): Extract<ContentBlock, { type: 'redacted-thinking' }> {
  return {
    type: 'redacted-thinking',
    data: REDACTED_DATA,
    provider: 'anthropic',
    providerModel: 'claude-test-4',
    ...overrides,
  }
}

export function user(...content: ContentBlock[]): InternalMessage {
  return { role: 'user', content }
}

export function assistant(...content: ContentBlock[]): InternalMessage {
  return { role: 'assistant', content }
}

export const TOOL: ToolSpec = {
  name: 'read_file',
  description: 'Reads a file.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

export function requestOf(
  model: ModelInfo,
  overrides: Partial<ProviderRequest> = {},
): ProviderRequest {
  return { model, messages: [user({ type: 'text', text: 'hello' })], ...overrides }
}

/**
 * Runs `body` with the global `fetch` replaced by a stub that counts and rejects, restores it, and
 * returns the count. For the stream tests' invariant 8 half: both SDKs fall back to the platform
 * `fetch` when a client is built without one, and fakeNetwork only ever sees the requests it
 * served — a second request made past it would be invisible there. Build the provider inside
 * `body`, so a client that captures the global at construction is caught too.
 */
export async function globalFetchCallsDuring(body: () => Promise<void>): Promise<number> {
  const real = globalThis.fetch
  let calls = 0
  globalThis.fetch = () => {
    calls += 1
    return Promise.reject(new Error('the global fetch was reached'))
  }
  try {
    await body()
  } finally {
    globalThis.fetch = real
  }
  return calls
}
