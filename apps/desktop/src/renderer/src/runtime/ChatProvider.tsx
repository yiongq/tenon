import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { useMemo } from 'react'
import type { JSX, ReactNode } from 'react'
import { ConversationContext } from './conversation'
import { createTenonChatAdapter } from './tenon-chat-adapter'

export interface ChatProviderProps {
  /** A new id remounts the provider: fresh thread in the UI, fresh session on the tape. */
  sessionId: string
  /**
   * The messages this session already has. Read once, at mount — which is exactly when a restored
   * session arrives, because the id changes with it and the key remounts this provider.
   */
  initialMessages?: readonly ThreadMessageLike[] | undefined
  /** Moves the window to a new, empty session (「用新模型开新会话」). */
  onStartSession?: ((sessionId: string) => void) | undefined
  children: ReactNode
}

export function ChatProvider({
  sessionId,
  initialMessages,
  onStartSession,
  children,
}: ChatProviderProps): JSX.Element {
  const adapter = useMemo(
    () => createTenonChatAdapter({ sessionId, bridge: window.tenon }),
    [sessionId],
  )
  const runtime = useLocalRuntime(adapter, { initialMessages })
  const conversation = useMemo(
    () => ({ sessionId, startSession: onStartSession ?? ((): void => {}) }),
    [sessionId, onStartSession],
  )
  return (
    <ConversationContext.Provider value={conversation}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </ConversationContext.Provider>
  )
}
