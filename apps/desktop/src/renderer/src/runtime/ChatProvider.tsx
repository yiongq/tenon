import { useSnapshotRounds } from './SnapshotProvider'
import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import type { AppendMessage } from '@assistant-ui/react'
import type { MessageRowContract } from '@tenon-app/contracts'
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import type { JSX, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { sessionTitle } from '@/lib/session-title'
import { ConversationContext } from './conversation'
import { SessionStore } from './session-store'
import type { SessionSnapshot } from './session-store'
import { toThreadMessages } from './to-thread-messages'
import { readHistoryModel } from '../lib/snapshots'
import type { ThreadModel } from './thread-model'

export interface ChatProviderProps {
  /** A new id remounts the provider: fresh thread in the UI, fresh session on the tape. */
  sessionId: string
  /** The stored rows this session opens on (its tail), read once, at mount. */
  initialRows?: readonly MessageRowContract[] | undefined
  /**
   * Whether this session was opened by the user (switched to by id), which resumes what startup
   * recovery listed; the session a window restored by itself only offers 「继续」 (§离开会话).
   */
  resumeOnOpen?: boolean | undefined
  /** Moves the window to a new, empty session (「用新模型开新会话」). */
  onStartSession?: ((sessionId: string) => void) | undefined
  /** Called once the session on screen holds a message (the shell notes that a chat exists). */
  onHasMessages?: (() => void) | undefined
  /** The session's title (lib/session-title.ts), whenever it changes; empty while it has no message. */
  onTitle?: ((sessionId: string, title: string) => void) | undefined
  /** False while startup recovery's restore is in flight: nothing can be sent yet (B15). */
  canSend?: boolean | undefined
  children: ReactNode
}

const StoreContext = createContext<SessionStore | null>(null)

/** This session's store, for the components that act on it (cards, queue, stop). */
export function useSessionStore(): SessionStore {
  const store = useContext(StoreContext)
  if (store === null) throw new Error('useSessionStore outside a ChatProvider')
  return store
}

export function useSessionSnapshot(): SessionSnapshot {
  const store = useSessionStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

function textOf(message: AppendMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

/**
 * The thread's runtime (spec 02 plan step 20): assistant-ui's external-store runtime over this
 * session's store. Every Run lands in it — the ones the user starts and the ones the kernel opens —
 * because the store is fed by `chat.event`, not by an adapter the runtime drives. Stopping is only
 * ever the explicit `chat.stop`: unmounting (switching sessions) stops nothing.
 */
export function ChatProvider({
  sessionId,
  initialRows,
  resumeOnOpen,
  onStartSession,
  onHasMessages,
  onTitle,
  canSend,
  children,
}: ChatProviderProps): JSX.Element {
  const { i18n } = useTranslation()
  const store = useMemo(
    () => new SessionStore(sessionId, window.tenon, initialRows ?? [], canSend !== false),
    // The rows are the ones this session opened with: read once per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId],
  )
  useEffect(() => {
    const detach = store.attach()
    const focus = (): void => {
      void store.refreshModel()
    }
    window.addEventListener('focus', focus)
    void store.open({ resume: resumeOnOpen === true })
    return () => {
      window.removeEventListener('focus', focus)
      detach()
    }
  }, [store, resumeOnOpen])
  useEffect(() => store.setCanSend(canSend !== false), [store, canSend])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const hasMessages = snapshot.model.turns.length > 0
  useEffect(() => {
    if (hasMessages) onHasMessages?.()
  }, [hasMessages, onHasMessages])
  const title = sessionTitle(snapshot.model.turns, i18n.language)
  useEffect(() => onTitle?.(sessionId, title), [onTitle, sessionId, title])
  const { data: snapshotRounds } = useSnapshotRounds()
  const historyKey = JSON.stringify(
    snapshotRounds?.rounds
      .filter(
        (round) =>
          round.endMessageId !== null &&
          snapshot.model.turns.some(
            (turn) => turn.id === round.endMessageId && turn.end === undefined,
          ) &&
          !snapshot.model.turns.some(
            (turn) => turn.end !== undefined && round.runIds.includes(turn.end.runId ?? ''),
          ),
      )
      .map((round) => round.endMessageId) ?? [],
  )
  const [history, setHistory] = useState<{ key: string; model: ThreadModel } | null>(null)
  useEffect(() => {
    if (historyKey === '[]') return
    let current = true
    const refresh = () => {
      void readHistoryModel(window.tenon, sessionId)
        .then((model) => {
          if (current) setHistory({ key: historyKey, model })
        })
        .catch(() => {
          /* Never show partial counts; focus retries a failed read. */
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      current = false
      window.removeEventListener('focus', refresh)
    }
  }, [historyKey, sessionId])
  const messages = useMemo(
    () =>
      toThreadMessages(
        snapshot.model,
        history?.key === historyKey ? snapshotRounds?.rounds : [],
        history?.model,
      ),
    [snapshot.model, snapshotRounds, history, historyKey],
  )
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message) => message,
    // Sending stays possible while a Run is live: that is a queued message (H13). The stop button
    // and the leave dialog read `run.state`, not this.
    isRunning: false,
    // The store shares every send block with the composer, which says why.
    isSendDisabled: store.sendBlock() !== null,
    onNew: async (message) => {
      const raw = textOf(message)
      const text = store.getSnapshot().pending?.waitKind === 'question' ? raw : raw.trim()
      if (text.trim() !== '') await store.send(text)
    },
    onCancel: () => store.stop(),
    // assistant-ui's reload names the user message before the reply: the same resend as 「重试」.
    onReload: (parentId) => (parentId === null ? Promise.resolve() : store.retry(parentId)),
  })
  const conversation = useMemo(
    () => ({ sessionId, startSession: onStartSession ?? ((): void => {}) }),
    [sessionId, onStartSession],
  )
  return (
    <ConversationContext.Provider value={conversation}>
      <StoreContext.Provider value={store}>
        <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
      </StoreContext.Provider>
    </ConversationContext.Provider>
  )
}
