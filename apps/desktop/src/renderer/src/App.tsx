import {
  chatNew,
  chatStop,
  configGet,
  configSet,
  invokeRoute,
  sessionLatest,
  sessionMessages,
} from '@tenon-app/contracts'
import type { Config, LocaleSetting, MessageRowContract } from '@tenon-app/contracts'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { AppShell } from './components/shell/AppShell'
import { LeaveRunDialog } from './components/shell/LeaveRunDialog'
import { Thread } from './components/thread/Thread'
import { ChatProvider } from './runtime/ChatProvider'
import { NavigationContext } from './runtime/conversation'
import { RESTORE_LIMIT } from './runtime/restore'
import { runStateOf } from './runtime/run-state'

/** The conversation on screen: its tape session, the rows it opened with, and how it was opened. */
interface Conversation {
  readonly sessionId: string
  readonly rows: readonly MessageRowContract[]
  /** Switched to by the user: what startup recovery listed for it resumes (§离开会话 第 4 条). */
  readonly resumeOnOpen: boolean
}

/**
 * The renderer mints the session id and main creates that session on the first send. It is a
 * canonical UUID because every id on the tape is one.
 */
function freshConversation(sessionId: string = crypto.randomUUID()): Conversation {
  return { sessionId, rows: [], resumeOnOpen: false }
}

export function App(): JSX.Element {
  const [conversation, setConversation] = useState<Conversation>(() => freshConversation())
  const [config, setConfig] = useState<Config>({
    locale: 'auto',
    sidebarCollapsed: false,
    provider: null,
    providerConfig: {},
    defaultModelByProfile: {},
    lastWorkspaceFolders: [],
  })
  /** Until `session.latest` answers, nothing can be sent (spec 02 §启动恢复与发送防护, B15). */
  const [restoring, setRestoring] = useState(() => !window.tenon.startsNewChat)
  /** A move that waits on the leave dialog: taken on 「停止任务」, dropped on 「留在这里」. */
  const [leaving, setLeaving] = useState<(() => void) | null>(null)

  /**
   * A conversation the user chose supersedes the one being restored. The window is on screen
   * before the restore round trip resolves, so without this a New Chat taken in that gap would be
   * silently undone by the answer to a question nobody is asking any more.
   */
  const superseded = useRef(false)
  const current = useRef(conversation.sessionId)
  useLayoutEffect(() => {
    current.current = conversation.sessionId
  }, [conversation.sessionId])

  /** Bumped by every move: an answer that arrives after a later move is not applied. */
  const moves = useRef(0)

  const show = useCallback((next: Conversation) => {
    superseded.current = true
    moves.current += 1
    setRestoring(false)
    setConversation(next)
  }, [])

  /**
   * Every way out of the session on screen: through the leave dialog when its Run is in progress
   * (as main says — `run.state`, never assistant-ui's `running`), at once when it is paused or idle.
   */
  const leave = useCallback((move: () => void) => {
    if (runStateOf(current.current).running) setLeaving(() => move)
    else move()
  }, [])

  const startFresh = useCallback(() => leave(() => show(freshConversation())), [leave, show])
  /** 「用新模型开新会话」: a session whose draft already holds the choice. */
  const startSession = useCallback(
    (sessionId: string) => leave(() => show(freshConversation(sessionId))),
    [leave, show],
  )
  /** By id (the banner's 「回去」): its tail first, then the provider remounts on it. */
  const switchTo = useCallback(
    (sessionId: string) =>
      leave(() => {
        // Taken now, while its tail is read: a New Chat or another 「回去」 in the meantime wins,
        // and this one neither shows nor resumes (§离开会话 第 1、4 条).
        const move = (moves.current += 1)
        void invokeRoute(window.tenon, sessionMessages, { sessionId, limit: RESTORE_LIMIT }).then(
          (result) => {
            if (move !== moves.current) return
            show({ sessionId, rows: result.ok ? result.data : [], resumeOnOpen: true })
          },
        )
      }),
    [leave, show],
  )

  const navigation = useMemo(() => ({ switchTo }), [switchTo])

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
        // Answered — whatever the answer: sending is possible from here (B15).
        setRestoring(false)
        if (superseded.current || !result.ok || result.data === null) return
        setConversation({
          sessionId: result.data.sessionId,
          rows: result.data.messages,
          resumeOnOpen: false,
        })
      })
    }
    const unsubscribe = window.tenon.on(chatNew.channel, startFresh)
    return () => {
      superseded.current = true
      unsubscribe()
    }
  }, [startFresh])

  // The fields this side owns: the provider settings travel through their own routes, which are
  // the only ones that check a value against a definition.
  const patch = useCallback((changes: Partial<Pick<Config, 'locale' | 'sidebarCollapsed'>>) => {
    setConfig((before) => ({ ...before, ...changes }))
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
      <NavigationContext.Provider value={navigation}>
        <ChatProvider
          key={conversation.sessionId}
          sessionId={conversation.sessionId}
          initialRows={conversation.rows}
          resumeOnOpen={conversation.resumeOnOpen}
          onStartSession={startSession}
          canSend={!restoring}
        >
          <Thread />
        </ChatProvider>
      </NavigationContext.Provider>
      <LeaveRunDialog
        open={leaving !== null}
        onStay={() => setLeaving(null)}
        onStop={() => {
          const move = leaving
          setLeaving(null)
          void invokeRoute(window.tenon, chatStop, { sessionId: current.current }).then(() =>
            move?.(),
          )
        }}
      />
    </AppShell>
  )
}
