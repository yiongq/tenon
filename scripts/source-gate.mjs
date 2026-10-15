// Source gate (owner decision 2026-10-15): identifiers lifted from reverse-engineered apps must
// never enter this repository — not in docs, not in any source, test, script, workflow or root
// file. The public checks are SOURCE_PATTERNS; source-gate.test.mjs runs them as a vitest test in
// the `scripts` project, so the `pnpm test` step CI already runs enforces them with no workflow
// change. Private checks run outside the repo.
//
// The scan reads every file git would commit — tracked, plus untracked ones that are not ignored,
// so a new file is caught before its first commit — and names every offender as file:line.
// Ignored files (`.env`, build output, nested worktrees) are never read.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A class prefix as it leaks: the prefix, a hyphen, then the rest of a class name. */
export const classPrefix = (name, prefix) => ({
  name,
  re: new RegExp(`\\b${prefix}-[a-z0-9]`, 'i'),
})

// `i`: a shouted or title-cased copy of an identifier is the same leak.
export const SOURCE_PATTERNS = [
  { name: 'rea-(ui|shell|diff)-*', re: /\brea-(?:ui|shell|diff)-[0-9a-z]+\b/i },
  { name: 'codex-(ui|shell|web)-*', re: /\bcodex-(?:ui|shell|web)-[0-9a-z]+\b/i },
]

const hashOf = (word) => createHash('sha256').update(word.toLowerCase()).digest('hex').slice(0, 16)
/** Per hash set: word → listed. */
const wordMemo = new WeakMap()
/**
 * The first word of `line` whose hash is in `hashes`, or null. A word is a run of letters and
 * digits, a camelCase identifier split at its humps (`fooEnabled` holds `foo`). Words under five
 * letters are never matched: a short one turns up by chance inside base64 in a lockfile.
 */
function listedWordIn(line, hashes) {
  if (hashes.size === 0) return null
  let memo = wordMemo.get(hashes)
  if (memo === undefined) {
    memo = new Map()
    wordMemo.set(hashes, memo)
  }
  for (const run of line.split(/[^A-Za-z0-9]+/)) {
    for (const word of run.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
      if (word.length < 5) continue
      let listed = memo.get(word)
      if (listed === undefined) {
        listed = hashes.has(hashOf(word))
        memo.set(word, listed)
      }
      if (listed) return word
    }
  }
  return null
}

// Vendored or generated trees a checkout may hold without ignoring them. Only untracked files are
// skipped by these names: a file committed under any of them (an electron-builder `build/` resource,
// a licence text) is scanned like any other.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.vite', 'coverage'])
const BINARY_EXT =
  /\.(?:png|jpe?g|gif|webp|avif|ico|icns|woff2?|ttf|otf|eot|pdf|zip|gz|mp[34]|mov)$/i

/** Root-relative posix paths listed by `git ls-files` with `args`. */
function gitFiles(root, args) {
  return execFileSync('git', ['ls-files', '-z', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\0')
    .filter((rel) => rel !== '')
}

/** Every text file git would commit under `root`: tracked ones, and untracked ones not ignored. */
function* sourceFiles(root) {
  const tracked = new Set(gitFiles(root, ['--cached']))
  const untracked = gitFiles(root, ['--others', '--exclude-standard']).filter(
    (rel) => !rel.split('/').some((part) => SKIP_DIRS.has(part)),
  )
  for (const rel of new Set([...tracked, ...untracked])) {
    if (BINARY_EXT.test(rel)) continue
    yield { file: join(root, rel), rel }
  }
}

/**
 * One `rel:line: pattern "match"` string per offending line and pattern. `patterns` are
 * `{ name, re }` rows; `codenameHashes` lists words to flag, each as the first 16 hex digits of the
 * SHA-256 of the lower-cased word.
 */
export function scanSources(root, { patterns = SOURCE_PATTERNS, codenameHashes = new Set() } = {}) {
  const findings = []
  for (const { file, rel } of sourceFiles(root)) {
    let buffer
    try {
      buffer = readFileSync(file)
    } catch (error) {
      if (error?.code === 'ENOENT') continue // tracked, deleted in the working tree
      throw error
    }
    if (buffer.subarray(0, 8000).includes(0)) continue // a binary the extension list missed
    buffer
      .toString('utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const { name, re } of patterns) {
          const hit = re.exec(line)
          if (hit) findings.push(`${rel}:${i + 1}: ${name} "${hit[0]}"`)
        }
        const word = listedWordIn(line, codenameHashes)
        if (word !== null) findings.push(`${rel}:${i + 1}: listed word "${word}"`)
      })
  }
  return findings
}
