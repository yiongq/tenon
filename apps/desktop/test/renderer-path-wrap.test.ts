/**
 * Paths and commands wrap only at `/` and at spaces. Before this, the monospace object line used
 * `break-all` (`…/real/m⏎y-project/docs/plan.md`) and the sans sentence broke after the hyphen of a
 * name (`my-⏎project`): a name cut in two reads as two names. This pins where the breaks may fall;
 * the component that renders them (components/ui/path-text.tsx) is measured in a real window by the
 * e2e in ux-craft.spec.ts, which is where a line break can be seen.
 */
import { describe, expect, it } from 'vitest'
import { pathPieces } from '../src/renderer/src/lib/path-wrap.js'

const PATH = '/private/var/folders/3n/tenon-e2e-ux-task-DmYHEY/real/my-project/docs/plan.md'

describe('pathPieces', () => {
  it('splits a path after each slash and nowhere else', () => {
    const pieces = pathPieces(PATH).map((piece) => piece.text)
    expect(pieces).toEqual([
      '/',
      'private/',
      'var/',
      'folders/',
      '3n/',
      'tenon-e2e-ux-task-DmYHEY/',
      'real/',
      'my-project/',
      'docs/',
      'plan.md',
    ])
  })

  it('keeps a hyphenated name in one piece, and marks every break but the last', () => {
    const pieces = pathPieces('real/my-project/a.txt')
    expect(pieces.map((piece) => piece.text)).toEqual(['real/', 'my-project/', 'a.txt'])
    expect(pieces.map((piece) => piece.breakAfter)).toEqual([true, true, false])
    expect(pieces.every((piece) => piece.kind === 'segment')).toBe(true)
  })

  it('leaves spaces to the line breaker and words without a slash alone', () => {
    const pieces = pathPieces('rm -rf /tmp/a-b && echo done')
    expect(pieces.map((piece) => [piece.kind, piece.text])).toEqual([
      ['word', 'rm'],
      ['space', ' '],
      ['word', '-rf'],
      ['space', ' '],
      ['segment', '/'],
      ['segment', 'tmp/'],
      ['segment', 'a-b'],
      ['space', ' '],
      ['word', '&&'],
      ['space', ' '],
      ['word', 'echo'],
      ['space', ' '],
      ['word', 'done'],
    ])
  })

  it('never changes the text, newlines and escape marks included', () => {
    for (const text of [
      PATH,
      '',
      '/',
      '//',
      'https://example.com/a/b?c=d',
      'cat a.txt⏎\nrm /tmp/x\\u{202E}/y',
      '读取 /private/var/my-project/a.txt',
      '  leading and trailing  ',
    ]) {
      for (const absoluteOnly of [false, true]) {
        expect(
          pathPieces(text, { absoluteOnly })
            .map((piece) => piece.text)
            .join(''),
        ).toBe(text)
      }
    }
  })
})

describe('pathPieces in output (absoluteOnly)', () => {
  // The note a spilled result carries (kernel prompts `spill`): the file is on a line of its own.
  const SPILL = `Tenon saved all of it to this file:\n${PATH}\nUse Read on that file.`

  it('splits the absolute path into names and leaves the text around it in one run each', () => {
    const pieces = pathPieces(SPILL, { absoluteOnly: true })
    expect(pieces.map((piece) => [piece.kind, piece.text])).toEqual([
      ['plain', 'Tenon saved all of it to this file:\n'],
      ...pathPieces(PATH).map((piece) => [piece.kind, piece.text]),
      ['plain', '\nUse Read on that file.'],
    ])
  })

  it('treats `~/` as absolute, and a relative path, a URL or a fraction as plain text', () => {
    expect(
      pathPieces('see ~/my-project/a.txt', { absoluteOnly: true }).map((piece) => piece.kind),
    ).toEqual(['plain', 'segment', 'segment', 'segment'])
    const notAbsolute = ['src/a-b/c.ts', 'https://example.com/a-b', '1/2', '//', 'a / b']
    expect(notAbsolute.map((text) => pathPieces(text, { absoluteOnly: true }))).toEqual(
      notAbsolute.map((text) => [{ text, kind: 'plain', breakAfter: false }]),
    )
  })
})
