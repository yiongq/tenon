import { randomUUID } from 'node:crypto'
import type { PendingGrant } from '@tenon-app/contracts'
import type { AbsolutePath } from '@tenon-app/kernel'

/**
 * The pending folder grants (spec 06 §界面「文件夹授权」; D42). A pick or the prefill that names a
 * folder never 「以后都允许」ed adds nothing: main keeps the chosen paths here, under a random token,
 * and the renderer hands back only the token. In main's memory alone — a restart voids every grant —
 * and bound to the session it was minted for. At most one per session: minting another, a new pick, a
 * new prefill or a clear of the session voids the old one. A token is used once.
 */
export interface FolderGrants {
  /** Keeps `folders` — main's own copy — for the session; any grant it had before is void. */
  mint(sessionId: string, folders: readonly AbsolutePath[]): PendingGrant
  /** Voids the session's pending grant, if it has one. */
  invalidate(sessionId: string): void
  /**
   * Uses the session's grant: the folders main kept, and the grant is gone. Null for a token that is
   * another session's, already used, voided or never minted — nothing is added then.
   */
  take(sessionId: string, token: string): readonly AbsolutePath[] | null
}

export function createFolderGrants(newToken: () => string = randomUUID): FolderGrants {
  const pending = new Map<string, { readonly token: string; readonly folders: AbsolutePath[] }>()
  return {
    mint(sessionId, folders) {
      const kept = [...new Set(folders)]
      const token = newToken()
      pending.set(sessionId, { token, folders: kept })
      // A copy: the renderer's list is never the one main keeps.
      return { token, folders: [...kept] }
    },
    invalidate(sessionId) {
      pending.delete(sessionId)
    },
    take(sessionId, token) {
      const found = pending.get(sessionId)
      if (found?.token !== token) return null
      // Deleted in the same synchronous stretch as the check: a second call with it finds nothing.
      pending.delete(sessionId)
      return found.folders
    },
  }
}
