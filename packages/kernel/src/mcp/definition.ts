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
const single = new Set([
  'not',
  'if',
  'then',
  'else',
  'items',
  'additionalProperties',
  'additionalItems',
  'contains',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentSchema',
])
const maps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
])
const arrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
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
function resolve(root: unknown, ref: string): unknown {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let value = root
  for (const token of ref.slice(2).split('/')) {
    if (!object(value) && !Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[
      decodeURIComponent(token).replaceAll('~1', '/').replaceAll('~0', '~')
    ]
  }
  return value
}
/** Walk schema keywords, counting each reference expansion per path, never exponentially running it. */
export function schemaProblem(root: unknown, screen = true): string | null {
  const pending: { value: unknown; refs: ReadonlySet<string> }[] = [
    { value: root, refs: new Set() },
  ]
  let count = 0
  while (pending.length) {
    const { value, refs } = pending.pop()!
    if (typeof value !== 'boolean' && !object(value)) continue
    if (++count > 10_000) return 'schema-expansion'
    if (!object(value)) continue
    const ref = value['$ref']
    if (typeof ref === 'string') {
      if (screen && !ref.startsWith('#')) return 'external-ref'
      if (ref.startsWith('#') && !refs.has(ref)) {
        let target: unknown
        try {
          target = resolve(root, ref)
        } catch {
          return 'invalid-ref'
        }
        pending.push({ value: target, refs: new Set([...refs, ref]) })
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (screen && key === 'pattern' && typeof child === 'string' && slowPattern(child))
        return 'slow-pattern'
      if (maps.has(key) && object(child)) {
        for (const [name, schema] of Object.entries(child)) {
          if (screen && key === 'patternProperties' && slowPattern(name)) return 'slow-pattern'
          pending.push({ value: schema, refs })
        }
      } else if (arrays.has(key) && Array.isArray(child)) {
        for (const schema of child) pending.push({ value: schema, refs })
      } else if (single.has(key)) {
        if (key === 'items' && Array.isArray(child)) {
          for (const schema of child) pending.push({ value: schema, refs })
        } else pending.push({ value: child, refs })
      }
    }
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
