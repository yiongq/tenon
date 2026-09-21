import { chatNew, configGet, configSet, invokeRoute, sessionLatest } from '@tenon-app/contracts'
import type { Config, LocaleSetting } from '@tenon-app/contracts'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { AppShell } from './components/shell/AppShell'
import { Thread } from './components/thread/Thread'
import { ChatProvider } from './runtime/ChatProvider'
import { RESTORE_LIMIT, toThreadMessages } from './runtime/restore'

/** The conversation on screen: its tape session and the messages it opened with. */
interface Conversation {
  readonly sessionId: string
  readonly messages: readonly ThreadMessageLike[]
}

/**
 * The renderer mints the session id and main creates that session on the first send. It is a
 * canonical UUID because every id on the tape is one.
 */
function freshConversation(): Conversation {
  return { sessionId: crypto.randomUUID(), messages: [] }
}

export function App(): JSX.Element {
  const [conversation, setConversation] = useState<Conversation>(freshConversation)
  const [config, setConfig] = useState<Config>({
    locale: 'auto',
    sidebarCollapsed: false,
    providerConfig: {},
  })

  /**
   * A conversation the user chose supersedes the one being restored. The window is on screen
   * before the restore round trip resolves, so without this a New Chat taken in that gap would be
   * silently undone by the answer to a question nobody is asking any more — the id would flip
   * back, the provider would remount, and anything typed would be gone.
   */
  const superseded = useRef(false)
  const startFresh = useCallback(() => {
    superseded.current = true
    setConversation(freshConversation())
  }, [])

  useEffect(() => {
    void invokeRoute(window.tenon, configGet, {}).then((result) => {
      if (result.ok) setConfig(result.data)
    })
    // The flag belongs to this run of the effect (StrictMode mounts it twice).
    superseded.current = window.tenon.startsNewChat
    // The window opens where the user left it: the newest stored conversation, tail first. A
    // profile with nothing in it keeps the empty session this component started with — and so
    // does a window main opened FOR a new chat.
    if (!superseded.current) {
      void invokeRoute(window.tenon, sessionLatest, { limit: RESTORE_LIMIT }).then((result) => {
        if (superseded.current || !result.ok || result.data === null) return
        setConversation({
          sessionId: result.data.sessionId,
          messages: toThreadMessages(result.data.messages),
        })
      })
    }
    const unsubscribe = window.tenon.on(chatNew.channel, startFresh)
    return () => {
      superseded.current = true
      unsubscribe()
    }
  }, [startFresh])

  const patch = useCallback((changes: Partial<Config>) => {
    setConfig((current) => ({ ...current, ...changes }))
    void invokeRoute(window.tenon, configSet, changes).then((result) => {
      if (result.ok) setConfig(result.data)
    })
  }, [])

  return (
    <AppShell
      collapsed={config.sidebarCollapsed}
      onCollapsedChange={(sidebarCollapsed) => patch({ sidebarCollapsed })}
      onNewChat={startFresh}
      locale={config.locale}
      onLocaleChange={(locale: LocaleSetting) => patch({ locale })}
    >
      <ChatProvider
        key={conversation.sessionId}
        sessionId={conversation.sessionId}
        initialMessages={conversation.messages}
      >
        <Thread />
      </ChatProvider>
    </AppShell>
  )
}
