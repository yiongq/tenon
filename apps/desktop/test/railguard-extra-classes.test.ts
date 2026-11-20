/* oxlint-disable no-await-in-loop -- each original parameter in order */
import { expect, it } from 'vitest'
import type { BeforeCallInput } from '@tenon-app/kernel'
import { railguardInspector } from '../src/main/inspectors/railguard.js'

// 06 D39: two classes railguard 0.7.0 does not report. Bidirectional controls ask like zero-width
// characters; C1 controls block like C0 ones; other format characters stay a known limit.
const PARAMETERS = [
  ['Bash', 'command'],
  ['Read', 'file_path'],
  ['Write', 'file_path'],
  ['Edit', 'file_path'],
  ['Delete', 'file_path'],
  ['Glob', 'path'],
  ['Grep', 'path'],
] as const
const input = (name: string, args: Record<string, unknown>): BeforeCallInput => ({
  call: {
    tool: { name, originalName: name, source: 'builtin', serverId: 'builtin' },
    args,
    reversibility: 'unknown',
  },
  view: {
    firstUserText: '',
    recentUserTexts: [],
    nonReadOnlyCalls: [],
    untrustedSources: [],
    privateSources: [],
    touchedPrivateData: false,
  },
})
const HIDDEN = {
  kind: 'ask',
  category: 'hidden-characters',
  findings: [{ code: 'hidden-characters' }],
}
const CONTROL = {
  kind: 'deny',
  category: 'control-characters',
  findings: [{ code: 'control-characters' }],
}

it('06 验收 19: the adapter also asks on bidi controls and blocks C1 controls', async () => {
  const inspector = railguardInspector()
  const bidi = ['‮', '‪', '⁦', '⁩', '‎', '‏', '؜']
  const c1 = ['\u0080', '\u0085', '\u009B', '\u009F']
  for (const [tool, parameter] of PARAMETERS) {
    const run = (text: string) =>
      inspector.beforeCall(input(tool, { [parameter]: text }), new AbortController().signal)
    for (const char of bidi) expect(await run(`/w/a${char}b.txt`)).toEqual(HIDDEN)
    for (const char of c1) expect(await run(`/w/a${char}b.txt`)).toEqual(CONTROL)
    // A C0 control still blocks, and wins over a bidi control beside it.
    expect(await run('/w/a\u0007‮b.txt')).toEqual(CONTROL)
    expect(await run('/w/a\u0085‮b.txt')).toEqual(CONTROL)
    // Not this class: plain text, Latin-1 letters right after C1, and the known limit (D39).
    for (const text of ['/w/plain.txt', '/w/café .txt', '/w/love❤️.txt', '/w/a­b'])
      expect(await run(text)).toEqual({ kind: 'none' })
  }
})
