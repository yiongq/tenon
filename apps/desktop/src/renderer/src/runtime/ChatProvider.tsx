import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { useMemo } from 'react'
import type { JSX, ReactNode } from 'react'
import { createTenonChatAdapter } from './tenon-chat-adapter'

export interface ChatProviderProps {
  /** A new id remounts the provider: fresh thread in the UI, fresh session on the tape. */
  sessionId: string
  /**
   * The messages this session already has. Read once, at mount — which is exactly when a restored
   * session arrives, because the id changes with it and the key remounts this provider.
   */
  initialMessages?: readonly ThreadMessageLike[] | undefined
  children: ReactNode
}

export function ChatProvider({
  sessionId,
  initialMessages,
  children,
}: ChatProviderProps): JSX.Element {
  const adapter = useMemo(
    () => createTenonChatAdapter({ sessionId, bridge: window.tenon }),
    [sessionId],
  )
  const runtime = useLocalRuntime(adapter, { initialMessages })
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
