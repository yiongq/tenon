import { canonicalJson } from '../tape/canonical-json.js'
import { canonicalHash } from '../provider/wire/shared.js'
import type { ToolSpec } from '../provider/types.js'

export function mcpDefinitionHash(tool: {
  readonly spec: ToolSpec
  readonly outputSchema?: unknown
  readonly requiresUserInteraction: boolean
}): string {
  return canonicalHash(
    {
      spec: tool.spec,
      outputSchema: tool.outputSchema ?? null,
      requiresUserInteraction: tool.requiresUserInteraction,
    },
    'MCP definition',
  )
}

const encoder = new TextEncoder()
const maps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
])
const arrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'])
const nestedQuantifier = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/
const duplicateAlternative = /\(([^|()]+)\|\1\)[+*{]/
function slowPattern(pattern: string): boolean {
  return (
    pattern.length > 1024 || nestedQuantifier.test(pattern) || duplicateAlternative.test(pattern)
  )
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
/** Physical nesting is independent of the schema's reference expansion. */
function tooDeep(value: unknown): boolean {
  const pending = [{ value, depth: 1 }]
  while (pending.length) {
    const item = pending.pop()!
    if (typeof item.value !== 'object' || item.value === null) continue
    if (item.depth > 32) return true
    for (const child of Object.values(item.value))
      pending.push({ value: child, depth: item.depth + 1 })
  }
  return false
}
// Match the schema locations registered by CfWorker, including extensions under unknown keys.
const ignored = new Set([
  'id',
  '$id',
  '$ref',
  '$recursiveRef',
  '$schema',
  '$anchor',
  '$vocabulary',
  '$comment',
  'default',
  'enum',
  'const',
  'required',
  'type',
  'maximum',
  'minimum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'multipleOf',
  'maxLength',
  'minLength',
  'pattern',
  'format',
  'maxItems',
  'minItems',
  'uniqueItems',
  'maxProperties',
  'minProperties',
])
function pointer(key: string): string {
  return encodeURI(key.replaceAll('~', '~0').replaceAll('/', '~1'))
}
function children(value: Record<string, unknown>): { value: unknown; path: string }[] {
  const result: { value: unknown; path: string }[] = []
  for (const [key, child] of Object.entries(value)) {
    if (ignored.has(key)) continue
    const path = '/' + pointer(key)
    if (Array.isArray(child)) {
      if (arrays.has(key))
        child.forEach((subschema, i) => result.push({ value: subschema, path: `${path}/${i}` }))
    } else if ((maps.has(key) || key === 'dependencies') && object(child)) {
      for (const [name, subschema] of Object.entries(child))
        result.push({ value: subschema, path: `${path}/${pointer(name)}` })
    } else result.push({ value: child, path })
  }
  return result.filter((child) => typeof child.value === 'boolean' || object(child.value))
}
/** Cheap preflight only; connector validation is bounded by the desktop worker (T23 ⑦). */
export function schemaProblem(root: unknown, screen = true): string | null {
  if (!screen) return null
  const pending = [root]
  while (pending.length) {
    const value = pending.pop()
    if (!object(value)) continue
    for (const key of ['$ref', '$recursiveRef'])
      if (typeof value[key] === 'string' && !value[key].startsWith('#')) return 'external-ref'
    if (typeof value['pattern'] === 'string' && slowPattern(value['pattern'])) return 'slow-pattern'
    if (
      object(value['patternProperties']) &&
      Object.keys(value['patternProperties']).some(slowPattern)
    )
      return 'slow-pattern'
    pending.push(...children(value).map((child) => child.value))
  }
  return null
}
export function definitionProblem(tool: {
  readonly description?: string
  readonly inputSchema: unknown
  readonly outputSchema?: unknown
}): string | null {
  if (tooDeep(tool.inputSchema) || tooDeep(tool.outputSchema)) return 'schema-depth'
  try {
    if (
      encoder.encode(
        canonicalJson({
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema ?? null,
        }),
      ).byteLength > 65_536
    )
      return 'definition-size'
  } catch {
    return 'invalid-json'
  }
  return schemaProblem(tool.inputSchema, false) ?? schemaProblem(tool.outputSchema)
}
export function toolsOverLimit(tools: readonly unknown[]): boolean {
  if (tools.length > 1000) return true
  try {
    return encoder.encode(canonicalJson(tools)).byteLength > 5 * 1024 * 1024
  } catch {
    return true
  }
}
