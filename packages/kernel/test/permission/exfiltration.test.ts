import { describe, expect, it } from 'vitest'
import { exfiltrationInspector, exfiltrationOpinion } from '../../src/index.js'
import type { BeforeCallInput } from '../../src/index.js'

function input(): BeforeCallInput {
  return {
    call: {
      tool: { name: 'WebFetch', originalName: 'WebFetch', source: 'builtin', serverId: 'builtin' },
      args: { url: 'https://a.test/leak' },
      reversibility: 'unknown',
    },
    view: {
      firstUserText: '',
      recentUserTexts: [],
      nonReadOnlyCalls: [],
      untrustedSources: ['WebFetch'],
      privateSources: ['local'],
      touchedPrivateData: true,
      fetchUrlVouched: false,
    },
  }
}
describe('the ask-only local exfiltration rule', () => {
  it('exports the complete registration, with no after-result hook', async () => {
    expect(exfiltrationInspector).toMatchObject({
      id: 'exfiltration',
      ceiling: 'ask',
      kind: 'local-rule',
    })
    expect(exfiltrationInspector.afterResult).toBeUndefined()
    expect(await exfiltrationInspector.beforeCall(input(), new AbortController().signal)).toEqual({
      kind: 'ask',
      category: 'exfiltration',
      findings: [{ code: 'lethal-trifecta' }],
    })
  })
  it.each(['Read', 'Grep', 'Bash', 'WebSearch', 'Agent'])('does not police %s', (name) => {
    const q = input()
    expect(
      exfiltrationOpinion({
        ...q,
        call: { ...q.call, tool: { ...q.call.tool, name, originalName: name } },
      }),
    ).toEqual({ kind: 'none' })
  })
  it('asks for MCP even with a WebFetch name, and preserves the builtin URL exemption', () => {
    const q = input()
    expect(
      exfiltrationOpinion({ ...q, call: { ...q.call, tool: { ...q.call.tool, source: 'mcp' } } }),
    ).toMatchObject({ kind: 'ask', category: 'exfiltration' })
    for (const patch of [
      { touchedPrivateData: false, privateSources: [] },
      { untrustedSources: [] },
      { fetchUrlVouched: true },
    ])
      expect(exfiltrationOpinion({ ...q, view: { ...q.view, ...patch } })).toEqual({ kind: 'none' })
  })

  it('auto-tier-hardening 验收 7: 同源读写不出卡', () => {
    const base = input()
    const call: BeforeCallInput['call'] = {
      ...base.call,
      tool: { name: 'X__write', originalName: 'write', source: 'mcp', serverId: 'X' },
    }
    const q = {
      ...base,
      call,
      view: { ...base.view, untrustedSources: ['mcp:X'], privateSources: ['mcp:X'] },
    }
    expect(exfiltrationOpinion(q)).toEqual({ kind: 'none' })
    // Another private source makes this same outbound call cross-source.
    expect(
      exfiltrationOpinion({ ...q, view: { ...q.view, privateSources: ['mcp:X', 'mcp:Y'] } }),
    ).toMatchObject({ kind: 'ask', category: 'exfiltration' })
  })

  it('auto-tier-hardening 验收 13: 只有 S 的不可信加本地私密读也出卡', () => {
    const base = input()
    const call: BeforeCallInput['call'] = {
      ...base.call,
      tool: { name: 'S__send', originalName: 'send', source: 'mcp', serverId: 'S' },
      reversibility: 'read-only',
    }
    const view = {
      ...base.view,
      untrustedSources: ['mcp:S'],
      privateSources: ['mcp:S', 'local'],
      fetchUrlVouched: true,
    }
    const q = { ...base, call, view }
    // A connector is an exit even when read-only; WebFetch's URL exemption does not apply.
    expect(exfiltrationOpinion(q)).toMatchObject({ kind: 'ask', category: 'exfiltration' })
    expect(exfiltrationOpinion({ ...q, view: { ...q.view, untrustedSources: [] } })).toEqual({
      kind: 'none',
    })
  })
})
