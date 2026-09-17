import { MessagePrimitive } from '@assistant-ui/react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { blockRegistry, userBlockRegistry } from './block-registry'
import { ThreadError } from './ThreadError'

/** Right-aligned bubble, width-capped; interface font, because it is the user's own text. */
export function UserMessage(): JSX.Element {
  const { t } = useTranslation()
  return (
    <MessagePrimitive.Root
      data-testid="user-message"
      className="mb-6 flex w-full flex-col items-end"
    >
      <h3 className="sr-only">{t('thread.you')}</h3>
      <div className="max-w-[80%] rounded-md bg-role-user-bubble px-4 py-2 font-sans text-ui text-text-primary">
        <MessagePrimitive.Parts components={userBlockRegistry} />
      </div>
      <output className="sr-only" />
    </MessagePrimitive.Root>
  )
}

/** Full-width prose; serif body font per AGENTS.md「界面无衬线 / 助手正文衬线」. */
export function AssistantMessage(): JSX.Element {
  const { t } = useTranslation()
  return (
    <MessagePrimitive.Root
      data-testid="assistant-message"
      className="mb-6 flex w-full flex-col items-start"
    >
      <h3 className="sr-only">{t('thread.assistant')}</h3>
      <div className="w-full text-text-primary">
        <MessagePrimitive.Parts components={blockRegistry} />
      </div>
      <MessagePrimitive.Error>
        <ThreadError />
      </MessagePrimitive.Error>
    </MessagePrimitive.Root>
  )
}
