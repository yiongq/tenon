/**
 * A session's own facts (spec 02 §会话事实; H1, D11, M5): the profile, the workspace and the model
 * choices of the current incarnation, read off the Tape.
 *
 * The profile is fixed when the session is created, in `session/start`'s batch; a session with no
 * `session/profile_set` — phase 1's — reads as `chat` (暂定: stricter, and it needs no workspace). The
 * workspace is the latest `session/workspace_set`; a sub-agent writes none and reads its parent's
 * latest instead, at every judgement (§授权、工作区与外带检查的继承). `<n>` of the next workspace or
 * model-choice fact is how many the incarnation already has, counted inside the root's mailbox (F3).
 */
import type {
  ModelChoiceSetPayload,
  NewEntry,
  ProfileSetPayload,
  TapeEntry,
  WorkspaceSetPayload,
} from '../tape/entry.js'
import { modelChoiceSetKey, profileSetKey, workspaceSetKey } from '../tape/provenance.js'
import { MAX_READ_LIMIT } from '../tape/store.js'
import type { Tape } from '../tape/tape.js'
import type { SessionDraft } from './draft.js'

export type Profile = ProfileSetPayload['profile']

export interface SessionFacts {
  /** Whether the session has a `session/start` at all. */
  readonly established: boolean
  /** Whether the profile was written (`session/profile_set`); phase 1's sessions have none. */
  readonly profileWritten: boolean
  readonly profile: Profile
  readonly subagentOf: NonNullable<ProfileSetPayload['subagentOf']> | null
  /** The latest `session/workspace_set` of this incarnation; null in the chat profile. */
  readonly workspace: WorkspaceSetPayload | null
  /** How many `session/workspace_set` facts the incarnation has: the next one's `<n>`. */
  readonly workspaceFacts: number
  /** The latest `session/model_choice_set`, and how many there are (the next `<n>`). */
  readonly modelChoice: ModelChoiceSetPayload | null
  readonly modelChoiceFacts: number
}

/** The facts of a session that does not exist: a chat with nothing chosen. */
export const NO_SESSION_FACTS: SessionFacts = {
  established: false,
  profileWritten: false,
  profile: 'chat',
  subagentOf: null,
  workspace: null,
  workspaceFacts: 0,
  modelChoice: null,
  modelChoiceFacts: 0,
}

/** Folds one incarnation's entries, in Tape order. */
export function sessionFactsOf(entries: readonly TapeEntry[]): SessionFacts {
  let established = false
  let profileWritten = false
  let profile: Profile = 'chat'
  let subagentOf: SessionFacts['subagentOf'] = null
  let workspace: WorkspaceSetPayload | null = null
  let workspaceFacts = 0
  let modelChoice: ModelChoiceSetPayload | null = null
  let modelChoiceFacts = 0
  for (const entry of entries) {
    if (entry.name === 'session/start') established = true
    else if (entry.name === 'session/profile_set') {
      const payload = entry.payload as unknown as ProfileSetPayload
      profileWritten = true
      profile = payload.profile
      subagentOf = payload.subagentOf ?? null
    } else if (entry.name === 'session/workspace_set') {
      workspace = entry.payload as unknown as WorkspaceSetPayload
      workspaceFacts += 1
    } else if (entry.name === 'session/model_choice_set') {
      modelChoice = entry.payload as unknown as ModelChoiceSetPayload
      modelChoiceFacts += 1
    }
  }
  return {
    established,
    profileWritten,
    profile,
    subagentOf,
    workspace,
    workspaceFacts,
    modelChoice,
    modelChoiceFacts,
  }
}

/** The current incarnation's session facts, paged over its events. */
export async function readSessionFacts(
  tape: Pick<Tape, 'readRange'>,
  sessionId: string,
): Promise<SessionFacts> {
  const entries: TapeEntry[] = []
  let fromEntryId: number | undefined
  let incarnationId: string | undefined
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
    const page = await tape.readRange({
      sessionId,
      kinds: ['anchor', 'event'],
      limit: MAX_READ_LIMIT,
      ...(fromEntryId === undefined ? {} : { fromEntryId }),
      ...(incarnationId === undefined ? {} : { incarnationId }),
    })
    // An unknown session reads as an empty page with no incarnation (01: absent, never an error).
    if (page.incarnationId === '') return NO_SESSION_FACTS
    incarnationId = page.incarnationId
    for (const entry of page.entries) if (entry.name.startsWith('session/')) entries.push(entry)
    if (page.nextFromEntryId === null) break
    fromEntryId = page.nextFromEntryId
  }
  return sessionFactsOf(entries)
}

/**
 * The workspace a session's calls are judged in: its own latest, or for a sub-agent its parent's
 * latest, read now (H5 ①, D11).
 */
export async function workspaceOf(
  tape: Pick<Tape, 'readRange'>,
  facts: SessionFacts,
): Promise<WorkspaceSetPayload | null> {
  if (facts.subagentOf === null) return facts.workspace
  return (await readSessionFacts(tape, facts.subagentOf.sessionId)).workspace
}

/** Writes the three session facts; `now` is a host clock reading per fact. */
export interface SessionFactWriter {
  readonly tape: Pick<Tape, 'writer'>
  readonly sessionId: string
  readonly incarnationId: string
  readonly now: () => number
}

export function profileEntry(w: SessionFactWriter, payload: ProfileSetPayload): NewEntry {
  return w.tape.writer('session').entry('session/profile_set', {
    sourceType: 'session',
    sourceId: w.sessionId,
    provenanceKey: profileSetKey(w.incarnationId),
    payload,
    createdAt: w.now(),
  })
}

export function workspaceEntry(
  w: SessionFactWriter,
  n: number,
  payload: WorkspaceSetPayload,
): NewEntry {
  return w.tape.writer('session').entry('session/workspace_set', {
    sourceType: 'session',
    sourceId: w.sessionId,
    sourceSeq: n,
    provenanceKey: workspaceSetKey(w.incarnationId, n),
    payload: { folders: [...payload.folders], origin: payload.origin },
    createdAt: w.now(),
  })
}

export function modelChoiceEntry(
  w: SessionFactWriter,
  n: number,
  payload: ModelChoiceSetPayload,
): NewEntry {
  return w.tape.writer('session').entry('session/model_choice_set', {
    sourceType: 'session',
    sourceId: w.sessionId,
    sourceSeq: n,
    provenanceKey: modelChoiceSetKey(w.incarnationId, n),
    payload,
    createdAt: w.now(),
  })
}

/**
 * What a new session's creating batch carries after `session/start` (§会话事实「建会话」): its profile,
 * its workspace in the cowork profile, and the draft's model choice as the 0th choice. No draft is a
 * chat with nothing chosen.
 */
export function creationEntries(w: SessionFactWriter, draft: SessionDraft | null): NewEntry[] {
  const profile = draft?.profile ?? 'chat'
  const entries = [profileEntry(w, { profile })]
  if (draft?.profile === 'cowork') entries.push(workspaceEntry(w, 0, draft.workspace))
  if (draft?.modelChoice != null) entries.push(modelChoiceEntry(w, 0, draft.modelChoice))
  return entries
}

/**
 * What a cleared session carries into its new incarnation (§会话事实「清空会话」): its profile and its
 * latest workspace, rewritten in the same transaction as the new `session/start`; the model choice
 * falls back to the default (M5). A phase 1 session with no profile carries nothing.
 */
export function carryEntries(w: SessionFactWriter, facts: SessionFacts): NewEntry[] {
  if (!facts.profileWritten) return []
  const entries = [
    profileEntry(w, {
      profile: facts.profile,
      ...(facts.subagentOf === null ? {} : { subagentOf: facts.subagentOf }),
    }),
  ]
  if (facts.workspace !== null) entries.push(workspaceEntry(w, 0, facts.workspace))
  return entries
}
