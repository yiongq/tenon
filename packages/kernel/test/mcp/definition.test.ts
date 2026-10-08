import { expect, it } from 'vitest'
import { definitionProblem, mcpDefinitionHash, toolsOverLimit } from '../../src/mcp/definition.js'
import { canonicalJson } from '../../src/tape/canonical-json.js'

const empty = { description: '', inputSchema: { type: 'object' } }
function nested(depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = {}
  for (let i = 1; i < depth; i++) schema = { items: schema }
  return schema
}
it('definition hashes are stable across key order and change with description, outputSchema or interaction', () => {
  const a = { spec: { name: 's__x', ...empty }, requiresUserInteraction: false }
  const hash = mcpDefinitionHash(a)
  expect(
    mcpDefinitionHash({
      ...a,
      spec: { inputSchema: empty.inputSchema, description: '', name: 's__x' },
    }),
  ).toBe(hash)
  expect(mcpDefinitionHash({ ...a, spec: { ...a.spec, description: 'changed' } })).not.toBe(hash)
  expect(mcpDefinitionHash({ ...a, outputSchema: { type: 'string' } })).not.toBe(hash)
  expect(mcpDefinitionHash({ ...a, requiresUserInteraction: true })).not.toBe(hash)
})
it('03 验收 32: 65536 bytes passes and 65537 bytes fails, including outputSchema', () => {
  const overhead = new TextEncoder().encode(canonicalJson({ ...empty, outputSchema: null })).length
  expect(definitionProblem({ ...empty, description: 'a'.repeat(65_536 - overhead) })).toBeNull()
  expect(definitionProblem({ ...empty, description: 'a'.repeat(65_537 - overhead) })).toBe(
    'definition-size',
  )
  const withOutput = { ...empty, outputSchema: { description: '' } }
  const size = new TextEncoder().encode(canonicalJson(withOutput)).length
  expect(
    definitionProblem({ ...withOutput, outputSchema: { description: 'a'.repeat(65_536 - size) } }),
  ).toBeNull()
  expect(
    definitionProblem({ ...withOutput, outputSchema: { description: 'a'.repeat(65_537 - size) } }),
  ).toBe('definition-size')
})
it('03 验收 32: 32 physical levels passes and 33 fails in either schema', () => {
  expect(definitionProblem({ ...empty, inputSchema: nested(32) })).toBeNull()
  expect(definitionProblem({ ...empty, inputSchema: nested(33) })).toBe('schema-depth')
  expect(definitionProblem({ ...empty, outputSchema: nested(32) })).toBeNull()
  expect(definitionProblem({ ...empty, outputSchema: nested(33) })).toBe('schema-depth')
})
it('03 验收 33: unsafe output patterns and external refs are invalid definitions', () => {
  expect(definitionProblem({ ...empty, outputSchema: { pattern: '(a+)+' } })).toBe('slow-pattern')
  expect(
    definitionProblem({ ...empty, outputSchema: { patternProperties: { '(a|a)+': {} } } }),
  ).toBe('slow-pattern')
  expect(
    definitionProblem({ ...empty, outputSchema: { $ref: 'https://example.test/schema' } }),
  ).toBe('external-ref')
})
it('03 验收 32: 1000 tools and 5 MiB pass, 1001 tools and one more byte fail', () => {
  expect(toolsOverLimit(Array.from({ length: 1000 }, () => empty))).toBe(false)
  expect(toolsOverLimit(Array.from({ length: 1001 }, () => empty))).toBe(true)
  const overhead = canonicalJson([{ ...empty }]).length
  expect(toolsOverLimit([{ ...empty, description: 'a'.repeat(5 * 1024 * 1024 - overhead) }])).toBe(
    false,
  )
  expect(
    toolsOverLimit([{ ...empty, description: 'a'.repeat(5 * 1024 * 1024 - overhead + 1) }]),
  ).toBe(true)
})

it('03 验收 32 / 51: ordinary annotation ids are not static schema errors', () => {
  expect(definitionProblem({ inputSchema: { type: 'object', example: { id: 42 } } })).toBeNull()
})
