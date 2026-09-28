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
  it('does not trust an MCP name, and asks only when both source conditions hold and the URL is unvouched', () => {
    const q = input()
    expect(
      exfiltrationOpinion({ ...q, call: { ...q.call, tool: { ...q.call.tool, source: 'mcp' } } }),
    ).toEqual({ kind: 'none' })
    for (const patch of [
      { touchedPrivateData: false },
      { untrustedSources: [] },
      { fetchUrlVouched: true },
    ])
      expect(exfiltrationOpinion({ ...q, view: { ...q.view, ...patch } })).toEqual({ kind: 'none' })
  })
})
