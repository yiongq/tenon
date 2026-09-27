/**
 * The prompt layer's skeleton (spec 02 §提示层：范围、位置、版本与组装; plan step 10): `fill()`, and the
 * notes written so far. Every cell of `closure` is checked in full by closure.test.ts at plan step 14;
 * the version gate (PROMPT_LAYER_HASH) arrives with the system prompts at plan step 18.
 */
import { describe, expect, it } from 'vitest'
import { MODEL_NOTES, fill } from '../../src/prompts/index.js'

describe('fill', () => {
  it('puts each slot in as it is, unescaped', () => {
    expect(fill('Read {path} ({bytes} bytes)', { path: '/tmp/<a>.txt', bytes: '12' })).toBe(
      'Read /tmp/<a>.txt (12 bytes)',
    )
    // A slot the template does not use is allowed: callers pass what the cell may use.
    expect(fill('no slots here', { unused: 'x' })).toBe('no slots here')
  })

  it('throws when the template names a slot that was not given', () => {
    expect(() => fill('{toolName} was blocked', {})).toThrow(TypeError)
    expect(() => fill('{toolName} was blocked', {})).toThrow(/\{toolName\}/)
  })
})

describe('the notes written so far', () => {
  it('say what a model gets back, in non-empty English', () => {
    // The closure table has its own test (test/loop/closure.test.ts, plan step 14).
    for (const text of [
      MODEL_NOTES.schemaUnusable,
      ...Object.values(MODEL_NOTES.inspectorFailed),
    ]) {
      expect(text.trim().length).toBeGreaterThan(0)
      expect(() => fill(text, {})).not.toThrow()
    }
    // The blocked-after-freeze sentence is the spec's own (§不带 tools 的请求与冻结后的变化).
    expect(MODEL_NOTES.closure['user-disabled']['not-run']).toBe(
      'This tool is not available in this session. Do not call it again.',
    )
    expect(MODEL_NOTES.closure.policy['not-run']).toBe(
      MODEL_NOTES.closure['user-disabled']['not-run'],
    )
  })
})
