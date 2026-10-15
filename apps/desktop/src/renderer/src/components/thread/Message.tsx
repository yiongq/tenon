import { MessagePrimitive } from '@assistant-ui/react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { blockRegistry, userBlockRegistry } from './block-registry'
import { AssistantActionBar, UserActionBar } from './MessageActions'
import { RunEndCard } from './RunEndCard'

/*
 * Vertical rhythm: a message owns no outer margin. The space between the items of the transcript
 * comes from the container (Thread.tsx: 24px between messages, 8px between a Run's message and the
 * next one of the same round), and the space between the parts of one message from the flex gap
 * below (8px). Nothing here stacks a margin on top of either.
 */

/** Right-aligned bubble, width-capped; interface font, because it is the user's own text. */
export function UserMessage(): JSX.Element {
  const { t } = useTranslation()
  return (
    <MessagePrimitive.Root
      data-testid="user-message"
      data-role="user"
      className="group/msg flex w-full flex-col items-end"
    >
      <h3 className="sr-only">{t('thread.you')}</h3>
      <div className="max-w-[80%] rounded-md bg-role-user-bubble px-4 py-2 font-sans text-ui text-text-primary">
        <MessagePrimitive.Parts components={userBlockRegistry} />
      </div>
      <output className="sr-only" />
      <UserActionBar />
    </MessagePrimitive.Root>
  )
}

/** Full-width prose; serif body font per AGENTS.md「界面无衬线 / 助手正文衬线」. */
export function AssistantMessage(): JSX.Element {
  const { t } = useTranslation()
  return (
    <MessagePrimitive.Root
      data-testid="assistant-message"
      data-role="assistant"
      className="group/msg flex w-full flex-col items-start gap-2"
    >
      <h3 className="sr-only">{t('thread.assistant')}</h3>
      <div className="flex w-full flex-col gap-2 text-text-primary">
        <MessagePrimitive.Parts components={blockRegistry} />
      </div>
      <RunEndCard />
      <AssistantActionBar />
    </MessagePrimitive.Root>
  )
}
