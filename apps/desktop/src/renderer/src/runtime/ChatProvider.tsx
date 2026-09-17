import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react'
import { useMemo } from 'react'
import type { JSX, ReactNode } from 'react'
import { createTenonChatAdapter } from './tenon-chat-adapter'

export interface ChatProviderProps {
  /** A new id remounts the provider: fresh thread in the UI, fresh history in main. */
  sessionId: string
  children: ReactNode
}

export function ChatProvider({ sessionId, children }: ChatProviderProps): JSX.Element {
  const adapter = useMemo(
    () => createTenonChatAdapter({ sessionId, bridge: window.tenon }),
    [sessionId],
  )
  const runtime = useLocalRuntime(adapter)
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
