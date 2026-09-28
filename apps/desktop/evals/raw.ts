/** Optional offline audit evidence. Never serializes transports, config or secrets. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readAll, sessionIdsOf } from './cost.js'
import { REPO_ROOT } from './format.js'
import type { RunInspection } from './runner.js'

/** Resolve even a not-yet-created directory through its nearest existing ancestor. */
function physical(path: string): string {
  let existing = path
  const tail: string[] = []
  while (!existsSync(existing)) {
    tail.unshift(basename(existing))
    const parent = dirname(existing)
    if (parent === existing) throw new Error('raw directory has no existing ancestor')
    existing = parent
  }
  return resolve(realpathSync(existing), ...tail)
}

export function validateRawDirectory(path: string): string {
  if (!isAbsolute(path))
    throw new Error('TENON_EVAL_RAW_DIR must be absolute and outside the repository')
  const target = physical(resolve(path))
  // Also reject the enclosing primary checkout when this module runs in a nested worktree.
  for (let root = realpathSync(REPO_ROOT); ; root = dirname(root)) {
    if (root === realpathSync(REPO_ROOT) || existsSync(join(root, '.git'))) {
      const rel = relative(root, target)
      if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
        throw new Error('TENON_EVAL_RAW_DIR must be outside the repository')
      }
    }
    if (dirname(root) === root) break
  }
  return target
}

export function redactEvidence(value: unknown, key: string): unknown {
  if (typeof value === 'string') return key === '' ? value : value.replaceAll(key, '[key]')
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item, key))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !/^(?:headers|authorization|x-api-key|apiKey|authToken)$/i.test(name))
        .map(([name, item]) => [redactEvidence(name, key), redactEvidence(item, key)]),
    )
  }
  return value
}

export async function writeRawInspection(
  directory: string,
  inspected: RunInspection,
  key: string,
): Promise<string> {
  const target = validateRawDirectory(directory)
  const sessions = []
  for (const sessionId of await sessionIdsOf(inspected.tape, inspected.sessionId)) {
    // oxlint-disable-next-line no-await-in-loop -- walk the persisted parent/child sessions in order
    sessions.push({ sessionId, entries: await readAll(inspected.tape, sessionId) })
  }
  const body = JSON.stringify(
    redactEvidence(
      {
        version: 1,
        rootSessionId: inspected.sessionId,
        sessions,
        cards: inspected.cards,
        fetched: inspected.fetched,
      },
      key,
    ),
    null,
    2,
  )
  mkdirSync(target, { recursive: true, mode: 0o700 })
  // Recheck after creation so an existing symlink cannot quietly redirect evidence into the repo.
  validateRawDirectory(target)
  const file = `eval-${randomUUID()}.json`
  writeFileSync(join(target, file), `${body}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return file
}
