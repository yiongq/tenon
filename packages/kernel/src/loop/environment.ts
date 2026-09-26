/**
 * The environment note (spec 02 §提示层「环境说明」; open question 16, owner 2026-09-26; A13, D11):
 * the local date and the workspace reach the model only as `message/environment`, never through the
 * system text or the tool table.
 *
 * Checked before a boundary request (the first request of a `user-message` or `continue` Run) and
 * before the request that follows a batch boundary where queued messages went in — once per
 * `requestSeq`. Written only when the state differs from the latest note in this context (from the
 * latest `compaction/anchor` on), or there is none; each note carries the whole state.
 */
import type { EnvironmentPayload, NewEntry, WorkspaceSetPayload } from '../tape/entry.js'
import { messageRevisionKey } from '../tape/provenance.js'
import { MAX_READ_LIMIT } from '../tape/store.js'
import type { Tape } from '../tape/tape.js'
import { MODEL_NOTES, fill } from '../prompts/index.js'
import { readSessionFacts, workspaceOf } from '../session/facts.js'

/** What a note says: the date, and the workspace (null in the chat profile). */
export interface EnvironmentState {
  readonly date: string
  readonly workspace: WorkspaceSetPayload | null
}

/**
 * The note's English. Each folder is a JSON string on its own line, with `<` and `>` escaped too, so
 * a folder named with a newline or `</environment>` can neither forge a line nor close the block.
 */
export function environmentText(state: EnvironmentState): string {
  const notes = MODEL_NOTES.environment
  const lines = [fill(notes.date, { date: state.date })]
  const { workspace } = state
  if (workspace !== null) {
    lines.push(
      workspace.origin === 'dedicated'
        ? fill(notes.dedicated, { folder: jsonLine(workspace.folders[0] ?? '') })
        : fill(notes.folders, { folders: workspace.folders.map(jsonLine).join('\n') }),
    )
  }
  return fill(notes.wrap, { body: lines.join('\n') })
}

function jsonLine(path: string): string {
  return JSON.stringify(path).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
}

/** The state now: the host's local date, and the session's workspace (a sub-agent's parent's). */
export async function environmentNow(
  tape: Pick<Tape, 'readRange'>,
  sessionId: string,
  date: string,
): Promise<EnvironmentState> {
  const facts = await readSessionFacts(tape, sessionId)
  const workspace = facts.profile === 'cowork' ? await workspaceOf(tape, facts) : null
  return { date, workspace }
}

/** The latest note in the context up to `atEntryId`: none before the latest compaction counts. */
export async function latestEnvironment(
  tape: Pick<Tape, 'readRange'>,
  sessionId: string,
  atEntryId: number,
): Promise<EnvironmentState | null> {
  let latest: EnvironmentState | null = null
  let fromEntryId: number | undefined
  let incarnationId: string | undefined
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
    const page = await tape.readRange({
      sessionId,
      atEntryId,
      kinds: ['anchor', 'message'],
      limit: MAX_READ_LIMIT,
      ...(fromEntryId === undefined ? {} : { fromEntryId }),
      ...(incarnationId === undefined ? {} : { incarnationId }),
    })
    if (page.incarnationId === '') return null
    incarnationId = page.incarnationId
    for (const entry of page.entries) {
      if (entry.name === 'compaction/anchor') latest = null
      else if (entry.name === 'message/environment') {
        const payload = entry.payload as unknown as EnvironmentPayload
        latest = { date: payload.date, workspace: payload.workspace }
      }
    }
    if (page.nextFromEntryId === null) break
    fromEntryId = page.nextFromEntryId
  }
  return latest
}

export function sameEnvironment(a: EnvironmentState, b: EnvironmentState): boolean {
  if (a.date !== b.date) return false
  if (a.workspace === null || b.workspace === null) return a.workspace === b.workspace
  return (
    a.workspace.origin === b.workspace.origin &&
    a.workspace.folders.length === b.workspace.folders.length &&
    a.workspace.folders.every((folder, i) => folder === b.workspace?.folders[i])
  )
}

/** The note as a fact: a user message the model reads, never rendered, never a projection row. */
export function environmentEntry(q: {
  readonly tape: Pick<Tape, 'writer'>
  readonly now: () => number
  readonly messageId: string
  readonly state: EnvironmentState
}): NewEntry {
  const payload: EnvironmentPayload = {
    messageId: q.messageId,
    revision: 0,
    role: 'user',
    content: [{ type: 'text', text: environmentText(q.state) }],
    status: 'complete',
    date: q.state.date,
    workspace:
      q.state.workspace === null
        ? null
        : { folders: [...q.state.workspace.folders], origin: q.state.workspace.origin },
  }
  return q.tape.writer('message').entry('message/environment', {
    sourceType: 'message',
    sourceId: q.messageId,
    sourceSeq: 0,
    provenanceKey: messageRevisionKey(q.messageId, 0),
    payload,
    createdAt: q.now(),
  })
}
