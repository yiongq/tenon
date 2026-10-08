import { schemaChain } from '../support/schema-chains.js'
/**
 * Argument validation before any permission decision (spec 02 §内置工具与参数「参数校验与失败」; plan
 * step 10, 旧 141 and the connector half; open question 16). What a failed call writes — the
 * `invalid-input` closure, no card, no decision, no dispatch — is the per-round loop's (plan steps 13
 * and 14); this file pins the verdicts it acts on.
 */
import { describe, expect, it, vi } from 'vitest'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import { MODEL_NOTES } from '../../src/prompts/index.js'
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.js'
import type { BuiltinToolName } from '../../src/tools/builtin/tool.js'
import { ASK_NOT_UNIQUE } from '../../src/tools/builtin/ask-user-question.js'
import { EDIT_SAME_STRINGS } from '../../src/tools/builtin/edit.js'
import { WEB_SEARCH_BOTH_DOMAIN_LISTS } from '../../src/tools/builtin/web-search.js'
import { createArgumentValidator } from '../../src/tools/validate.js'
import type { ToolSpec } from '../../src/index.js'

const validator = createArgumentValidator()

function builtin(name: BuiltinToolName, domainFilter = false) {
  return {
    source: 'builtin' as const,
    originalName: name,
    spec: BUILTIN_TOOLS[name].spec({ domainFilter }),
  }
}

function connector(inputSchema: Record<string, unknown>) {
  const spec: ToolSpec = { name: 'srv__tool', description: '', inputSchema }
  return { source: 'mcp' as const, originalName: 'tool', spec }
}

function question(header: string, options = 2): Record<string, unknown> {
  return {
    question: `Which ${header}?`,
    header,
    options: Array.from({ length: options }, (_, i) => ({ label: `o${i}`, description: '' })),
    multiSelect: false,
  }
}

describe('builtin arguments', () => {
  it('pass when they are what the table takes', () => {
    expect(validator.check(builtin('Read'), { file_path: '/tmp/a.txt' })).toEqual({ ok: true })
    expect(validator.check(builtin('Bash'), { command: 'ls', timeout: 600_000 })).toEqual({
      ok: true,
    })
    expect(validator.check(builtin('AskUserQuestion'), { questions: [question('Pick')] })).toEqual({
      ok: true,
    })
  })

  it('fail the schema: a timeout past the cap, a parameter it does not take, missing ones', () => {
    for (const [name, args] of [
      ['Bash', { command: 'ls', timeout: 600_001 }],
      ['Bash', { command: 'ls', run_in_background: true }],
      ['WebFetch', { url: 'https://example.com', prompt: 'summarise' }],
      ['Edit', { file_path: '/tmp/a', old_string: '', new_string: 'x' }],
      ['Read', {}],
    ] as const) {
      // The validator's own message is the reason: tool output, not prompt layer.
      expect(validator.check(builtin(name), args)).toMatchObject({
        ok: false,
        source: 'invalid-input',
        reason: expect.stringMatching(/\S/),
      })
    }
  })

  it('fail the checks the schema cannot state, with the tool’s fixed English', () => {
    expect(validator.check(builtin('Write'), { file_path: 'relative.txt', content: '' })).toEqual({
      ok: false,
      source: 'invalid-input',
      reason: 'file_path must be an absolute path.',
    })
    expect(validator.check(builtin('Grep'), { pattern: 'x', path: 'src' })).toEqual({
      ok: false,
      source: 'invalid-input',
      reason: 'path must be an absolute path.',
    })
    expect(
      validator.check(builtin('Edit'), {
        file_path: '/tmp/a',
        old_string: 'same',
        new_string: 'same',
      }),
    ).toEqual({ ok: false, source: 'invalid-input', reason: EDIT_SAME_STRINGS })
    expect(
      validator.check(builtin('WebSearch', true), {
        query: 'tenon',
        allowed_domains: ['a.com'],
        blocked_domains: ['b.com'],
      }),
    ).toEqual({ ok: false, source: 'invalid-input', reason: WEB_SEARCH_BOTH_DOMAIN_LISTS })
  })

  it('hold AskUserQuestion to 1–4 questions, 2–4 options and a header of 12 code points', () => {
    const ask = (questions: unknown[]): boolean =>
      validator.check(builtin('AskUserQuestion'), { questions }).ok
    expect(ask([question('a'), question('b'), question('c'), question('d')])).toBe(true)
    expect(ask([1, 2, 3, 4, 5].map(() => question('q')))).toBe(false)
    expect(ask([])).toBe(false)
    expect(ask([question('one option', 1)])).toBe(false)
    expect(ask([question('five', 5)])).toBe(false)
    // Code points, not UTF-16 units: twelve emoji are twelve, even though each is two units.
    expect(ask([question('😀'.repeat(12))])).toBe(true)
    expect(ask([question('😀'.repeat(13))])).toBe(false)
    expect(ask([question('x'.repeat(13))])).toBe(false)
    // An answer is keyed by its question and its labels, so neither may repeat (Revisions 31).
    const same = { ...question('b'), question: 'Which a?' }
    expect(
      validator.check(builtin('AskUserQuestion'), { questions: [question('a'), same] }),
    ).toEqual({ ok: false, source: 'invalid-input', reason: ASK_NOT_UNIQUE })
    const twice = [
      { label: 'o0', description: '' },
      { label: 'o0', description: 'again' },
    ]
    expect(ask([{ ...question('a'), options: twice }])).toBe(false)
  })
})

describe('connector arguments', () => {
  it('are checked against the schema the server gave', () => {
    const echo = connector({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    })
    expect(validator.check(echo, { message: 'hi' })).toEqual({ ok: true })
    expect(validator.check(echo, {})).toMatchObject({ ok: false, source: 'invalid-input' })
  })

  it('close as tool-unavailable when the schema itself cannot be used', () => {
    const unusable = { ok: false, source: 'tool-unavailable', reason: MODEL_NOTES.schemaUnusable }
    // Built fine, fails when it runs: a pattern no engine compiles.
    const badPattern = connector({
      type: 'object',
      properties: { q: { type: 'string', pattern: '(' } },
    })
    expect(validator.check(badPattern, { q: 'x' })).toEqual(unusable)
    // Fails when it is built: a dialect the validator does not support.
    const oldDialect = connector({
      $schema: 'http://json-schema.org/draft-03/schema#',
      type: 'object',
    })
    expect(validator.check(oldDialect, {})).toEqual(unusable)
    // Unresolvable reference, found only when validating.
    const dangling = connector({ type: 'object', properties: { q: { $ref: '#/$defs/missing' } } })
    expect(validator.check(dangling, { q: 1 })).toEqual(unusable)
  })
})

it('03 验收 33: nested quantifiers, duplicate alternatives, oversized patterns and external refs are schemaUnusable', () => {
  for (const schema of [
    { type: 'object', properties: { x: { pattern: '(a+)+' } } },
    { type: 'object', properties: { x: { pattern: '(a|a)+' } } },
    { type: 'object', properties: { x: { pattern: 'a'.repeat(1025) } } },
    { type: 'object', patternProperties: { '(a+)+': {} } },
    { type: 'object', $ref: 'https://example.test/schema' },
  ])
    expect(validator.check(connector(schema), {})).toEqual({
      ok: false,
      source: 'tool-unavailable',
      reason: MODEL_NOTES.schemaUnusable,
    })
  expect(
    validator.check(
      connector({ type: 'object', properties: { x: { type: 'string', pattern: '^a+$' } } }),
      { x: 'aaa' },
    ),
  ).toEqual({ ok: true })
})

it('03 验收 33: external refs are refused before constructing a validator', () => {
  const compile = vi.spyOn(CfWorkerJsonSchemaValidator.prototype, 'getValidator')
  try {
    const fresh = createArgumentValidator()
    expect(
      fresh.check(connector({ type: 'object', $ref: 'https://example.test/schema' }), {}),
    ).toMatchObject({ source: 'tool-unavailable' })
    expect(compile).not.toHaveBeenCalled()
  } finally {
    compile.mockRestore()
  }
})

it('03 验收 32: anchor and dependencies chains are refused before CfWorker compiles, including fragment ids', () => {
  const compile = vi.spyOn(CfWorkerJsonSchemaValidator.prototype, 'getValidator')
  try {
    for (const kind of [
      'anchor',
      'fragment-id',
      'dependencies',
      'tuple',
      'numeric-id',
      'empty-id',
    ] as const) {
      expect(
        createArgumentValidator().check(connector(schemaChain(kind)), { x: 1, y: 1 }),
      ).toMatchObject({ ok: false, source: 'tool-unavailable', reason: MODEL_NOTES.schemaUnusable })
    }
    expect(compile).not.toHaveBeenCalled()
  } finally {
    compile.mockRestore()
  }
})
