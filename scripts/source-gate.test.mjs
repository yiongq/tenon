// The public source gate (source-gate.mjs) as a regression test: the real repository scans clean,
// and the fixtures below keep both the scan and each pattern honest (a gate that cannot go red is
// worse than none). To add a public pattern, add a row to SOURCE_PATTERNS there and a planted case
// here. Private checks run outside the repo.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { classPrefix, scanSources } from './source-gate.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// Identifiers are assembled at run time so this file stays clean when the real-repo scan reads it.
// Every fixture value is made up (`zzfix…`, `zqx…`); never plant a real identifier.
const planted = (prefix, kind, tail) => [prefix, kind, tail].join('-')
/** The injectable hash: the first 16 hex digits of the SHA-256 of the lower-cased word. */
const hashOf = (word) => createHash('sha256').update(word.toLowerCase()).digest('hex').slice(0, 16)
/** A made-up word and class prefix, with the tables that list them. */
const FAKE_WORD = 'zqxfixtureword'
const FAKE_SHORT_WORD = 'zqxw' // listed too, but under five letters: never matched
const FAKE_PREFIX = 'zqx'
const FAKE_TABLES = {
  patterns: [classPrefix('fixture class prefix', FAKE_PREFIX)],
  codenameHashes: new Set([hashOf(FAKE_WORD), hashOf(FAKE_SHORT_WORD)]),
}
/**
 * A scratch git repository holding `files`, untracked (the scan lists those too) unless named in
 * `tracked`, which are added to the index.
 */
const fixture = (files, tracked = []) => {
  const root = mkdtempSync(join(tmpdir(), 'source-gate-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  if (tracked.length > 0) execFileSync('git', ['add', '--', ...tracked], { cwd: root })
  return root
}

describe('source gate: no reverse-engineered identifiers', () => {
  it('finds none in any file the repository holds', () => {
    const findings = scanSources(repoRoot)
    expect(
      findings,
      `Reverse-engineered identifiers must not enter the repo. Remove or rename:\n${findings.join('\n')}`,
    ).toEqual([])
  })

  describe('the scan itself', () => {
    it('names file and line for every pattern, wherever the file is', () => {
      const root = fixture({
        'docs/ux/notes.md': `fine\nclass ${planted('rea', 'ui', 'zzfix1')} here\n`,
        'apps/desktop/src/renderer/src/a.tsx': `const x = '${planted('codex', 'web', 'zzfix2')}'\n`,
        'apps/server/src/b.ts': `// ${planted('REA', 'Diff', 'zzfix3')}\n`,
        'apps/desktop/src/main/c.css': `.${planted('codex', 'shell', 'zzfix4')} {}\n`,
        'packages/kernel/src/prompt.ts': `// ${planted('rea', 'shell', 'zzfix5')}\n`,
        'apps/desktop/e2e/a.spec.ts': `// per ${planted('codex', 'ui', 'zzfix6')}\n`,
        'scripts/x.mjs': `// ${planted('rea', 'diff', 'zzfix7')}\n`,
        'AGENTS.md': `${planted('codex', 'shell', 'zzfix8')}\n`,
      })
      try {
        expect(scanSources(root).toSorted()).toEqual(
          [
            `AGENTS.md:1: codex-(ui|shell|web)-* "${planted('codex', 'shell', 'zzfix8')}"`,
            `apps/desktop/e2e/a.spec.ts:1: codex-(ui|shell|web)-* "${planted('codex', 'ui', 'zzfix6')}"`,
            `apps/desktop/src/main/c.css:1: codex-(ui|shell|web)-* "${planted('codex', 'shell', 'zzfix4')}"`,
            `apps/desktop/src/renderer/src/a.tsx:1: codex-(ui|shell|web)-* "${planted('codex', 'web', 'zzfix2')}"`,
            `apps/server/src/b.ts:1: rea-(ui|shell|diff)-* "${planted('REA', 'Diff', 'zzfix3')}"`,
            `docs/ux/notes.md:2: rea-(ui|shell|diff)-* "${planted('rea', 'ui', 'zzfix1')}"`,
            `packages/kernel/src/prompt.ts:1: rea-(ui|shell|diff)-* "${planted('rea', 'shell', 'zzfix5')}"`,
            `scripts/x.mjs:1: rea-(ui|shell|diff)-* "${planted('rea', 'diff', 'zzfix7')}"`,
          ].toSorted(),
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('ignores near misses, ignored files, vendored code and binaries', () => {
      const lookalike = [
        `${planted('prea', 'ui', 'zzfix9')} ${planted('rea', 'ui', '')}`, // not whole identifiers
        'rea-ui and codex-web search and codex-cli-zzfix', // other words
        planted('rea', 'form', 'zzfix'), // another kind
      ].join('\n')
      const root = fixture({
        '.gitignore': '.env\nplaywright-report/\n',
        'docs/a.md': lookalike,
        'apps/desktop/src/a.ts': lookalike,
        '.env': planted('rea', 'ui', 'zzfix0'), // ignored: never read
        'playwright-report/index.html': planted('rea', 'ui', 'zzfix0'),
        'apps/desktop/node_modules/x/src/a.js': planted('rea', 'ui', 'zzfix0'),
        'apps/desktop/src/font.woff2': planted('rea', 'ui', 'zzfix0'),
        'apps/desktop/src/blob.dat': `${planted('rea', 'ui', 'zzfix0')}\0`,
      })
      try {
        expect(scanSources(root)).toEqual([])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('scans a tracked file under a directory it skips when untracked', () => {
      const root = fixture(
        {
          'build/notes.md': `${planted('rea', 'ui', 'zzfix1')}\n`,
          'apps/desktop/build/x.md': `${planted('codex', 'ui', 'zzfix2')}\n`,
        },
        ['build/notes.md'],
      )
      try {
        expect(scanSources(root)).toEqual([
          `build/notes.md:1: rea-(ui|shell|diff)-* "${planted('rea', 'ui', 'zzfix1')}"`,
        ])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('catches an injected class prefix and listed word, in any case and inside identifiers', () => {
      const title = FAKE_WORD[0].toUpperCase() + FAKE_WORD.slice(1)
      const root = fixture({
        'apps/desktop/src/styles/theme.css': `.${FAKE_PREFIX}-scroll-edge { color: red }\n`,
        'apps/desktop/src/renderer/src/a.tsx': `<div className="${FAKE_PREFIX.toUpperCase()}-x" />\n`,
        'docs/ux/notes.md': `fine\nthe ${FAKE_WORD} sidebar\n`,
        'apps/desktop/src/main/b.ts': `const ${FAKE_WORD}Enabled = true\n`,
        'scripts/c.mjs': `// ${title}_mode\n`,
      })
      try {
        expect(scanSources(root, FAKE_TABLES).toSorted()).toEqual(
          [
            `apps/desktop/src/main/b.ts:1: listed word "${FAKE_WORD}"`,
            `apps/desktop/src/renderer/src/a.tsx:1: fixture class prefix "${FAKE_PREFIX.toUpperCase()}-x"`,
            `apps/desktop/src/styles/theme.css:1: fixture class prefix "${FAKE_PREFIX}-s"`,
            `docs/ux/notes.md:2: listed word "${FAKE_WORD}"`,
            `scripts/c.mjs:1: listed word "${title}"`,
          ].toSorted(),
        )
        // The defaults list neither.
        expect(scanSources(root)).toEqual([])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('leaves alone what only looks like one: another prefix, a longer word, a short run', () => {
      const root = fixture({
        'docs/a.md': [
          `a${FAKE_PREFIX}-x and ${FAKE_PREFIX}_x and ${FAKE_PREFIX}-`, // not the prefix as a class
          `${FAKE_WORD}s and pre${FAKE_WORD}`, // other words
          `sha512-Zm9vYmFy+${FAKE_SHORT_WORD}== and ${FAKE_SHORT_WORD}Enabled`, // listed, but short
        ].join('\n'),
      })
      try {
        expect(scanSources(root, FAKE_TABLES)).toEqual([])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('tolerates an empty repository', () => {
      const root = fixture({})
      try {
        expect(scanSources(root)).toEqual([])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
})
