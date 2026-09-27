/**
 * The ten builtin tools (spec 02 §内置工具与参数; plan step 10, 旧 140 and 旧 147): what each schema
 * takes, what none of them takes, which profile offers which, and what each records once dispatched.
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOLS, BUILTIN_TOOL_NAMES } from '../../src/tools/builtin/index.js'
import { BASH_MAX_TIMEOUT_MS } from '../../src/tools/builtin/bash.js'
import { builtinCandidates } from '../../src/tools/registry.js'
import type { SearchBackend } from '../../src/index.js'

/** The parameter table's 「收的参数」 column, verbatim. */
const PARAMETERS: Record<string, readonly string[]> = {
  Read: ['file_path', 'offset', 'limit'],
  Write: ['file_path', 'content'],
  Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  Bash: ['command', 'timeout', 'description'],
  Glob: ['pattern', 'path'],
  Grep: [
    'pattern',
    'path',
    'glob',
    'type',
    'output_mode',
    '-i',
    '-n',
    '-o',
    '-A',
    '-B',
    '-C',
    'context',
    'head_limit',
    'offset',
    'multiline',
  ],
  Agent: ['description', 'prompt'],
  AskUserQuestion: ['questions'],
  WebSearch: ['query'],
  WebFetch: ['url'],
}

/** Every key anywhere in a schema, nested ones included. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf)
  if (typeof value !== 'object' || value === null) return []
  const keys: string[] = []
  for (const [key, inner] of Object.entries(value)) keys.push(key, ...keysOf(inner))
  return keys
}

function propertiesOf(schema: Record<string, unknown>): string[] {
  return Object.keys(schema['properties'] as Record<string, unknown>)
}

describe('the builtin schemas', () => {
  it('take exactly the parameters of the table, required ones marked', () => {
    expect(BUILTIN_TOOL_NAMES.toSorted()).toEqual(Object.keys(PARAMETERS).toSorted())
    for (const name of BUILTIN_TOOL_NAMES) {
      const spec = BUILTIN_TOOLS[name].spec({ domainFilter: false })
      expect(spec.name).toBe(name)
      expect(propertiesOf(spec.inputSchema).toSorted()).toEqual(
        [...(PARAMETERS[name] ?? [])].toSorted(),
      )
      expect(spec.inputSchema['additionalProperties']).toBe(false)
      expect(spec.description.length).toBeGreaterThan(0)
      // No dialect is declared: the validator reads a schema without $schema as 2020-12.
      expect(spec.inputSchema).not.toHaveProperty('$schema')
    }
    expect(BUILTIN_TOOLS.Read.spec({ domainFilter: false }).inputSchema['required']).toEqual([
      'file_path',
    ])
    expect(BUILTIN_TOOLS.Edit.spec({ domainFilter: false }).inputSchema['required']).toEqual([
      'file_path',
      'old_string',
      'new_string',
    ])
  })

  it('offer no background mode, no self-rated danger and no mode of their own (E4)', () => {
    const forbidden = new Set([
      'run_in_background',
      'dangerouslyDisableSandbox',
      'mode',
      'isolation',
    ])
    for (const name of BUILTIN_TOOL_NAMES) {
      for (const domainFilter of [false, true]) {
        const keys = keysOf(BUILTIN_TOOLS[name].spec({ domainFilter }).inputSchema)
        expect(keys.filter((key) => forbidden.has(key))).toEqual([])
        expect(keys.filter((key) => /danger|risk|safe/i.test(key))).toEqual([])
      }
    }
    expect(
      propertiesOf(BUILTIN_TOOLS.WebFetch.spec({ domainFilter: false }).inputSchema),
    ).not.toContain('prompt')
    const bash = BUILTIN_TOOLS.Bash.spec({ domainFilter: false }).inputSchema
    expect(
      (bash['properties'] as Record<string, Record<string, unknown>>)['timeout']?.['maximum'],
    ).toBe(BASH_MAX_TIMEOUT_MS)
    expect(BASH_MAX_TIMEOUT_MS).toBe(600_000)
  })

  it('give WebSearch its domain parameters only when the backend filters by domain (H8)', () => {
    expect(propertiesOf(BUILTIN_TOOLS.WebSearch.spec({ domainFilter: false }).inputSchema)).toEqual(
      ['query'],
    )
    expect(propertiesOf(BUILTIN_TOOLS.WebSearch.spec({ domainFilter: true }).inputSchema)).toEqual([
      'query',
      'allowed_domains',
      'blocked_domains',
    ])
  })

  it('record read for Read, Glob and Grep, write for Write and Edit, the rest as the table says', () => {
    const effects = Object.fromEntries(
      BUILTIN_TOOL_NAMES.map((name) => [name, BUILTIN_TOOLS[name].effect]),
    )
    expect(effects).toEqual({
      Read: 'read',
      Glob: 'read',
      Grep: 'read',
      Write: 'write',
      Edit: 'write',
      // 暂定, owner 2026-09-25
      Bash: 'external',
      Agent: 'external',
      AskUserQuestion: 'read',
      WebSearch: 'external',
      WebFetch: 'external',
    })
  })
})

describe('the builtin candidates of a profile (H1)', () => {
  const search: SearchBackend = {
    host: 'open.bigmodel.cn',
    domainFilter: false,
    prepareQuery: (query) => ({ query, truncated: false }),
    search: () => Promise.resolve({ ok: true, hits: [] }),
  }
  const names = (profile: 'chat' | 'cowork'): string[] =>
    builtinCandidates({ profile, available: () => true, search })
      .map((candidate) => candidate.name)
      .toSorted()

  it('are four tools in chat and all ten in cowork', () => {
    expect(names('chat')).toEqual(['AskUserQuestion', 'Read', 'WebFetch', 'WebSearch'])
    expect(names('cowork')).toEqual(BUILTIN_TOOL_NAMES.toSorted())
  })

  it('keep only what the registry offers, under the builtin server id', () => {
    const offered = builtinCandidates({
      profile: 'cowork',
      available: (name) => name === 'Read',
      search: null,
    })
    expect(offered).toEqual([
      {
        source: 'builtin',
        serverId: 'builtin',
        originalName: 'Read',
        name: 'Read',
        spec: BUILTIN_TOOLS.Read.spec({ domainFilter: false }),
        requiresUserInteraction: false,
      },
    ])
  })
})
