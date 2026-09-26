/**
 * A session's draft before it is established (spec 02 §会话形态「建立前暂存」; open question 16,
 * owner 2026-09-26: the draft lives in the kernel).
 *
 * The renderer mints the session id, and the session is created only when the first `send` that
 * opens a Run takes its turn. Until then the home page's profile, folder and model choice are kept
 * here per session id, read and written by that session's mailbox in arrival order. A kernel-internal
 * type: nothing outside the kernel sees it, and the package does not export it.
 *
 * Plan step 9 declares the shape only. The store, `session.selectProfile` / `session.selectModel`
 * writing it and `send` reading it arrive in plan steps 18 and 19; until then a new session is
 * created in the chat profile with no model choice, which is what a missing draft means anyway.
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
