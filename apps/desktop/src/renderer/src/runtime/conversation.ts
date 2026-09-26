import { createContext, useContext } from 'react'

/**
 * The conversation on screen, as the composer's controls need it (spec 02 §模型菜单与输入框): its
 * session id, and how to move to a new one — 「用新模型开新会话」 opens a session whose draft already
 * holds the chosen model.
 */
export interface Conversation {
  readonly sessionId: string
  /** Shows a new, empty session with this id (minted by the caller). */
  readonly startSession: (sessionId: string) => void
}

export const ConversationContext = createContext<Conversation | null>(null)

export function useConversation(): Conversation {
  const conversation = useContext(ConversationContext)
  if (conversation === null) throw new Error('useConversation outside a ChatProvider')
  return conversation
}
