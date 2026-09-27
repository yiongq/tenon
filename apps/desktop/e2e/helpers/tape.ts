/**
 * A profile's Tape read straight from `sessions.db`, the way live-provider.spec.ts and retry.spec.ts
 * read it: what was written, not what the renderer shows. Read-only; the app may still hold the file
 * (WAL lets a reader in).
 */
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { configPathIn } from './launch.js'

export interface Fact {
  readonly name: string
  readonly payload: Readonly<Record<string, unknown>>
}

/** Every fact of the profile, session by session, in the order written. */
export function tapeFacts(userData: string): Fact[] {
  const db = new Database(join(dirname(configPathIn(userData)), 'sessions.db'), {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const rows = db
      .prepare('SELECT name, payload_json FROM tape_entry ORDER BY session_id, entry_id')
      .all() as Array<{ name: string; payload_json: string }>
    return rows.map((row) => ({
      name: row.name,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }))
  } finally {
    db.close()
  }
}

export function named(facts: readonly Fact[], name: string): Fact[] {
  return facts.filter((fact) => fact.name === name)
}

/** Each Run's end reason, in the order written (spec 02 §结束原因词表). */
export function runEnds(facts: readonly Fact[]): Array<Readonly<Record<string, unknown>>> {
  return named(facts, 'execution/run_terminal').map(
    (fact) => fact.payload['reason'] as Readonly<Record<string, unknown>>,
  )
}

/** Each dispatched call's closure, by its provider call id: `state`, `source`, `effect`. */
export function dispatchedOutcomes(
  facts: readonly Fact[],
): Array<{ readonly call: string; readonly state: unknown; readonly source: unknown }> {
  const outcomes = named(facts, 'execution/tool_outcome')
  return named(facts, 'execution/dispatch_committed').map((dispatch) => {
    const call = String(dispatch.payload['providerToolCallId'])
    const outcome = outcomes.find((fact) => fact.payload['providerToolCallId'] === call)
    return { call, state: outcome?.payload['state'], source: outcome?.payload['source'] }
  })
}

/** The text of every `message/user`, in the order written. */
export function userTexts(facts: readonly Fact[]): string[] {
  return named(facts, 'message/user').map((fact) =>
    (fact.payload['content'] as Array<{ type: string; text?: string }>)
      .map((block) => block.text ?? '')
      .join(''),
  )
}
