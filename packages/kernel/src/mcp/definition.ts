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
/** Resolve local ids and anchors before counting expansions; no validator runs during this pass. */
export function schemaProblem(root: unknown, screen = true): string | null {
  const lookup = new Map<string, unknown>()
  const bases = new WeakMap<object, string>()
  const nodes = [{ value: root, base: 'https://tenon.invalid/schema', path: '' }]
  let physical = -1
  try {
    while (nodes.length) {
      const { value, base, path } = nodes.pop()!
      if (typeof value !== 'boolean' && !object(value)) continue
      if (++physical > 10_000) return 'schema-expansion'
      let scope = base
      let localPath = path
      if (object(value)) {
        const id = value['$id'] || value['id']
        if ('$id' in value || 'id' in value) {
          if (typeof id !== 'string' || id.length === 0) return 'invalid-id'
          const url = new URL(id, base)
          lookup.set(url.href, value)
          if (!url.hash) {
            scope = url.href
            localPath = ''
          }
        }
        bases.set(value, scope)
        if (typeof value['$anchor'] === 'string')
          lookup.set(new URL('#' + value['$anchor'], scope).href, value)
      }
      lookup.set(new URL(path ? '#' + path : '', base).href, value)
      lookup.set(new URL(localPath ? '#' + localPath : '', scope).href, value)
      if (object(value))
        for (const child of children(value))
          nodes.push({ value: child.value, base: scope, path: localPath + child.path })
    }
    const pending: { value: unknown; refs: ReadonlySet<string> }[] = [
      { value: root, refs: new Set() },
    ]
    let count = -1 // The root is not one of its sub-schemas.
    while (pending.length) {
      const { value, refs } = pending.pop()!
      if (typeof value !== 'boolean' && !object(value)) continue
      if (++count > 10_000) return 'schema-expansion'
      if (!object(value)) continue
      for (const key of ['$ref', '$recursiveRef']) {
        const ref = value[key]
        if (typeof ref !== 'string') continue
        let url: URL
        try {
          url = new URL(ref, bases.get(value))
        } catch {
          if (!screen) continue
          return ref.startsWith('#') ? 'invalid-ref' : 'external-ref'
        }
        if (url.hash === '') url.hash = ''
        const uri = url.href
        if (!lookup.has(uri)) {
          if (!screen) continue
          return !ref.startsWith('#') ? 'external-ref' : 'invalid-ref'
        }
        if (!refs.has(uri)) pending.push({ value: lookup.get(uri), refs: new Set([...refs, uri]) })
      }
      if (screen && typeof value['pattern'] === 'string' && slowPattern(value['pattern']))
        return 'slow-pattern'
      if (
        screen &&
        object(value['patternProperties']) &&
        Object.keys(value['patternProperties']).some(slowPattern)
      )
        return 'slow-pattern'
      for (const child of children(value)) pending.push({ value: child.value, refs })
    }
  } catch {
    return 'invalid-ref'
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
