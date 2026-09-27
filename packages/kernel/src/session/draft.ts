/**
 * A session's draft before it is established (spec 02 §会话形态「建立前暂存」; open question 16,
 * owner 2026-09-26: the draft lives in the kernel).
 *
 * The renderer mints the session id, and the session is created only when the first `send` that
 * opens a Run takes its turn. Until then the home page's profile, folder and model choice are kept
 * here per session id, read and written by that session's mailbox in arrival order. A kernel-internal
 * type: nothing outside the kernel sees it, and the package does not export it.
 *
 * Plan step 9 declared the shape; plan step 18 the store, `selectProfile` and the workspace writing
 * it and `send` reading it; `selectModel` writes its choice from plan step 19. A new session with no
 * draft is created in the chat profile with no model choice.
 */
import type { ModelChoiceSetPayload, WorkspaceSetPayload } from '../tape/entry.js'

// 存的就是建会话时要写的载荷，照抄
export type SessionDraft =
  | { profile: 'chat'; modelChoice: ModelChoiceSetPayload | null }
  | {
      profile: 'cowork'
      workspace: WorkspaceSetPayload
      modelChoice: ModelChoiceSetPayload | null
    }

/** At most this many drafts are kept; past it the oldest is dropped. */
export const SESSION_DRAFT_CAP = 16

/**
 * The drafts, by session id, oldest first. Only the root's mailbox writes them, so two commands of one
 * session never interleave; a read outside the mailbox sees the store as the last task left it.
 */
export interface DraftStore {
  get(sessionId: string): SessionDraft | null
  /** Sets a session's draft; a new one past the cap drops the oldest. */
  set(sessionId: string, draft: SessionDraft): void
  delete(sessionId: string): void
}

export function createDraftStore(cap: number = SESSION_DRAFT_CAP): DraftStore {
  const drafts = new Map<string, SessionDraft>()
  return {
    get: (sessionId) => drafts.get(sessionId) ?? null,
    set(sessionId, draft): void {
      // An update keeps the draft's place: "oldest" is the one created first.
      drafts.set(sessionId, draft)
      while (drafts.size > cap) {
        const oldest = drafts.keys().next()
        if (oldest.done === true) break
        drafts.delete(oldest.value)
      }
    },
    delete(sessionId): void {
      drafts.delete(sessionId)
    },
  }
}
