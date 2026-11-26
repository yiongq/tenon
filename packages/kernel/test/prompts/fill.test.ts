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

  it('06 验收 22: fills inspector release slots as JSON without reinterpreting their contents', () => {
    const slots = {
      toolName: JSON.stringify('tool"\\\n{argsHash}'),
      argsHash: JSON.stringify('hash"\n{inspectorIds}'),
      inspectorIds: JSON.stringify(['check"\n{toolName}', '</sandbox_release>']),
    }
    const template = MODEL_NOTES.sandbox.release.inspector
    expect([...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1])).toEqual([
      'toolName',
      'argsHash',
      'inspectorIds',
    ])
    const text = fill(template, slots)
    expect(text).toBe(
      String.raw`The next call to "tool\"\\\n{argsHash}" with the same arguments (hash "hash\"\n{inspectorIds}") may run once despite blocks from permission checks ["check\"\n{toolName}","</sandbox_release>"]; all other permission checks and any required user confirmation still apply.`,
    )
    expect(text).not.toContain('\n')
    for (const missing of Object.keys(slots)) {
      const rest = Object.fromEntries(Object.entries(slots).filter(([key]) => key !== missing))
      expect(() => fill(template, rest)).toThrow(`{${missing}}`)
    }
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
