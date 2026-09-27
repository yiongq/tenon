/**
 * What an answer grants, and for how long (spec 02 §作用域与授权键; plan step 11, 旧 153, 02 不变量 20
 * first half), plus the two per-call readings made before `decide()` — reversibility and the call's
 * own reason (§内置工具的默认档位). Rebuilding the grants from real Tape facts after a restart is the
 * answer path's (plan step 15); here the derivation runs on the facts it reads.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_POLICY, absolutePath } from '../../src/index.js'
import type { AbsolutePath } from '../../src/index.js'
import { decide } from '../../src/permission/decide.js'
import type { Decision, LayerInputs } from '../../src/permission/decide.js'
import {
  answerScope,
  grantKey,
  sessionGrantKindOf,
  sessionGrants,
} from '../../src/permission/grants.js'
import type { GrantFact } from '../../src/permission/grants.js'
import { callReasonOf, reversibilityOf } from '../../src/permission/reversibility.js'
import type { InspectedCall } from '../../src/permission/session-view.js'

const p = (path: string): AbsolutePath => absolutePath(path)

function decision(
  name: string,
  source: 'builtin' | 'mcp',
  over: Partial<LayerInputs> = {},
): Decision {
  const call: InspectedCall = {
    tool: { name, source, serverId: source === 'builtin' ? 'builtin' : 'srv', originalName: name },
    args: {},
    reversibility: 'unknown',
  }
  return decide({
    call,
    callReason: { reason: 'default', facts: { toolName: name } },
    layers: {
      policy: { status: 'current', version: 'v', snapshot: EMPTY_POLICY },
      reversibility: { value: 'unknown', source: 'host' },
      requiresUserInteraction: false,
      sessionGrant: null,
      approvalMode: 'manual',
      ...over,
    },
    inspectors: [],
  })
}

const scope = (
  d: Decision,
  over: {
    reversibility?: 'unknown' | 'irreversible'
    place?: 'workspace' | 'outside'
    source?: 'builtin' | 'mcp'
    toolName: string
  },
) =>
  answerScope({
    decision: d,
    reversibility: over.reversibility ?? 'unknown',
    ...(over.place === undefined ? {} : { place: over.place }),
    source: over.source ?? 'builtin',
    toolName: over.toolName,
  })

const allowed = (key: string, held: 'once' | 'session' = 'session', n = 0): GrantFact => ({
  kind: 'approval',
  sessionId: 's',
  approvalKey: `tool:v1:approval:${String(n)}`,
  outcome: 'allowed',
  grant: { scope: held, key },
})

const tool = (originalName: string, source: 'builtin' | 'mcp' = 'builtin') => ({
  source,
  originalName,
})

describe('grantKey', () => {
  it('is the JSON of server, tool, kind and the object’s fields, in declaration order', () => {
    expect(grantKey('builtin', 'Write', { kind: 'file', path: p('/ws/a.ts') })).toBe(
      '["builtin","Write","file","/ws/a.ts"]',
    )
    expect(
      grantKey('builtin', 'Bash', { kind: 'command', command: 'ls  -la', cwd: p('/ws') }),
    ).toBe('["builtin","Bash","command","ls  -la","/ws"]')
    expect(grantKey('builtin', 'WebSearch', { kind: 'search', host: 'open.bigmodel.cn' })).toBe(
      '["builtin","WebSearch","search","open.bigmodel.cn"]',
    )
    expect(grantKey('builtin', 'WebFetch', { kind: 'domain', host: 'example.com' })).toBe(
      '["builtin","WebFetch","domain","example.com"]',
    )
    expect(grantKey('srv', 'tool', { kind: 'call', argsHash: 'abc' })).toBe(
      '["srv","tool","call","abc"]',
    )
  })

  it('tells a Write grant from an Edit one, and a command in another cwd from this one', () => {
    const file = { kind: 'file' as const, path: p('/ws/a.ts') }
    expect(grantKey('builtin', 'Write', file)).not.toBe(grantKey('builtin', 'Edit', file))
    const here = grantKey('builtin', 'Bash', { kind: 'command', command: 'make', cwd: p('/ws') })
    const there = grantKey('builtin', 'Bash', { kind: 'command', command: 'make', cwd: p('/ws2') })
    expect(here).not.toBe(there)
    expect(sessionGrantKindOf({ kind: 'search', host: 'h' })).toBe('session-search')
    expect(sessionGrantKindOf({ kind: 'domain', host: 'h' })).toBe('session-domain')
    expect(sessionGrantKindOf(file)).toBe('session')
  })
})

describe('the answer scope, top row first', () => {
  it('holds once for a must-ask card, an irreversible call, a path outside, a connector tool', () => {
    expect(
      scope(decision('tool', 'mcp', { requiresUserInteraction: true }), {
        source: 'mcp',
        toolName: 'tool',
      }),
    ).toBe('once')
    expect(
      scope(
        decision('Write', 'builtin', { reversibility: { value: 'irreversible', source: 'host' } }),
        { reversibility: 'irreversible', place: 'workspace', toolName: 'Write' },
      ),
    ).toBe('once')
    expect(
      scope(decision('Write', 'builtin', { place: 'outside' }), {
        place: 'outside',
        toolName: 'Write',
      }),
    ).toBe('once')
    // A connector tool of unknown reversibility, allowed: once, and asked again next time.
    expect(scope(decision('tool', 'mcp'), { source: 'mcp', toolName: 'tool' })).toBe('once')
  })

  it('holds once for an irreversible call a policy released, asked only by the manual mode (owner-confirmed)', () => {
    // The irreversible row decides here, not the must-ask row above it: the policy lifted layer 4 ①,
    // so the card is the manual mode's (§作用域与授权键「被策略放开后因手动档弹出的卡也算」).
    const released = decision('Bash', 'builtin', {
      place: 'workspace',
      reversibility: { value: 'irreversible', source: 'host' },
      policy: {
        status: 'current',
        version: 'v',
        snapshot: {
          tools: [
            {
              policyId: 'lift',
              serverId: 'builtin',
              toolName: 'Bash',
              effect: 'release-irreversible',
            },
          ],
        },
      },
    })
    expect([released.record.verdict, released.record.decidedBy]).toEqual(['ask', 'approval-mode'])
    expect(
      scope(released, { reversibility: 'irreversible', place: 'workspace', toolName: 'Bash' }),
    ).toBe('once')
  })

  it('holds for the session for Write / Edit in the workspace, Bash, WebSearch and WebFetch', () => {
    for (const toolName of ['Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch']) {
      expect(
        scope(decision(toolName, 'builtin', { place: 'workspace' }), {
          place: 'workspace',
          toolName,
        }),
      ).toBe('session')
    }
    // Builtin tools only ever produce once or session (02 不变量 20, the half 02 tests).
    expect(
      scope(decision('Read', 'builtin', { place: 'outside' }), {
        place: 'outside',
        toolName: 'Read',
      }),
    ).toBe('once')
  })
})

describe('session grants from the Tape’s answers', () => {
  const write = (path: string) => grantKey('builtin', 'Write', { kind: 'file', path: p(path) })
  const command = (cwd: string) =>
    grantKey('builtin', 'Bash', { kind: 'command', command: 'make', cwd: p(cwd) })
  const workspace = (...folders: string[]): GrantFact => ({
    kind: 'workspace',
    folders: folders.map(p),
  })

  it('counts only allowed answers held for the session', () => {
    const grants = sessionGrants([
      workspace('/ws'),
      allowed(write('/ws/a.ts')),
      allowed(write('/ws/b.ts'), 'once'),
      { kind: 'approval', sessionId: 's', approvalKey: 'k', outcome: 'denied', grant: null },
    ])
    expect([...grants.keys()]).toEqual([write('/ws/a.ts')])
    expect(grants.get(write('/ws/a.ts'))).toEqual({
      sessionId: 's',
      approvalKey: 'tool:v1:approval:0',
    })
  })

  it('voids the write grants under a removed folder for good, even when it comes back', () => {
    const grants = sessionGrants([
      workspace('/ws', '/other'),
      allowed(write('/other/x.ts')),
      allowed(write('/ws/a.ts')),
      workspace('/ws'),
      workspace('/ws', '/other'),
    ])
    expect([...grants.keys()]).toEqual([write('/ws/a.ts')])
    // A grant given after it came back is a new answer, and holds.
    const again = sessionGrants([
      workspace('/ws', '/other'),
      allowed(write('/other/x.ts')),
      workspace('/ws'),
      workspace('/ws', '/other'),
      allowed(write('/other/x.ts'), 'session', 1),
    ])
    expect([...again.keys()]).toEqual([write('/other/x.ts')])
  })

  it('voids every command grant when the cwd changes', () => {
    const grants = sessionGrants([
      workspace('/dedicated'),
      allowed(command('/dedicated')),
      allowed(write('/dedicated/a.ts')),
      workspace('/picked', '/dedicated'),
    ])
    expect([...grants.keys()]).toEqual([write('/dedicated/a.ts')])
  })
})

describe('the readings made before decide()', () => {
  it('gives reads read-only, writes and the rest unknown, commands never read-only (E1)', () => {
    for (const name of ['Read', 'Glob', 'Grep', 'AskUserQuestion'])
      expect(reversibilityOf(tool(name), {})).toBe('read-only')
    for (const name of ['Write', 'Edit', 'Agent', 'WebSearch', 'WebFetch'])
      expect(reversibilityOf(tool(name), {})).toBe('unknown')
    expect(reversibilityOf(tool('Bash'), { command: 'ls' })).toBe('unknown')
    expect(reversibilityOf(tool('anything', 'mcp'), {})).toBe('unknown')
  })

  it('gives each tool its reason column, with the slots its card needs', () => {
    const base = { workspace: p('/ws'), searchHost: 'open.bigmodel.cn' }
    expect(
      callReasonOf({
        ...base,
        tool: tool('Read'),
        args: {},
        place: 'outside',
        real: p('/etc/hosts'),
      }),
    ).toEqual({
      reason: 'outside-workspace',
      facts: { path: '/etc/hosts', workspace: '/ws', toolName: 'Read', target: '/etc/hosts' },
    })
    expect(
      callReasonOf({ ...base, tool: tool('Write'), args: {}, place: 'workspace', real: p('/ws/a') })
        .reason,
    ).toBe('default')
    expect(callReasonOf({ ...base, tool: tool('Bash'), args: { command: 'make' } })).toEqual({
      reason: 'command',
      facts: { command: 'make', cwd: '/ws', toolName: 'Bash' },
    })
    expect(callReasonOf({ ...base, tool: tool('WebSearch'), args: { query: 'q' } })).toEqual({
      reason: 'network',
      facts: { host: 'open.bigmodel.cn', toolName: 'WebSearch' },
    })
    expect(
      callReasonOf({ ...base, tool: tool('WebFetch'), args: { url: 'https://Example.com/a' } })
        .facts,
    ).toMatchObject({ host: 'example.com', target: 'example.com' })
    expect(callReasonOf({ ...base, tool: tool('echo', 'mcp'), args: {} })).toEqual({
      reason: 'default',
      facts: { toolName: 'echo' },
    })
  })
})
