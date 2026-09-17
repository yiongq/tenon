import { MessagePrimitive } from '@assistant-ui/react'
import type { JSX } from 'react'
import { blockRegistry, userBlockRegistry } from './block-registry'
import { ThreadError } from './ThreadError'

/** Right-aligned bubble, width-capped; interface font, because it is the user's own text. */
export function UserMessage(): JSX.Element {
  return (
    <MessagePrimitive.Root
      data-testid="user-message"
      className="mb-6 flex w-full flex-col items-end"
    >
      <div className="max-w-[80%] rounded-md bg-role-user-bubble px-4 py-2 font-sans text-ui text-text-primary">
        <MessagePrimitive.Parts components={userBlockRegistry} />
      </div>
    </MessagePrimitive.Root>
  )
}

/** Full-width prose; serif body font per AGENTS.md「界面无衬线 / 助手正文衬线」. */
export function AssistantMessage(): JSX.Element {
  return (
    <MessagePrimitive.Root
      data-testid="assistant-message"
      className="mb-6 flex w-full flex-col items-start"
    >
      <div className="w-full text-text-primary">
        <MessagePrimitive.Parts components={blockRegistry} />
      </div>
      <MessagePrimitive.Error>
        <ThreadError />
      </MessagePrimitive.Error>
    </MessagePrimitive.Root>
  )
}
