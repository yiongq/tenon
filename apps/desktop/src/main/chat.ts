import Anthropic, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
} from '@anthropic-ai/sdk'
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream'
import { chatEvent, chatSend, chatStop, registerRoute } from '@tenon-app/contracts'
import type { ChatEvent, IpcMainLike } from '@tenon-app/contracts'
import { keyFor } from '@tenon-app/kernel'
import type { HostAdapter } from '@tenon-app/kernel'
import type { EventSender } from './host/index.js'

/**
 * Phase 0: the smallest possible streaming call, deliberately not abstracted (the
 * provider layer is phase 1's decision). One run per session at a time.
 *
 * Main's transcript is what the provider sees, so it must never drift from what the user
 * sees: a stopped reply keeps its partial text, a failed turn stays in the transcript, and
 * re-sending the same text after a failure is a retry, not a second turn.
 */

export const DEFAULT_MODEL = 'claude-opus-5'
const MAX_TOKENS = 64_000

/** `TENON_MAX_TOKENS` caps one reply (and its cost); anything that is not a positive integer is ignored. */
function maxTokens(): number {
  const configured = Number(process.env['TENON_MAX_TOKENS'])
  return Number.isInteger(configured) && configured > 0 ? configured : MAX_TOKENS
}

export const ANTHROPIC_API_KEY_SECRET = ['provider', 'anthropic', 'apiKey'] as const

/** Diagnostic only (never rendered): why the run ended before any request was made. */
const NO_API_KEY = 'no api key configured'

type MessageParam = Anthropic.MessageParam

interface Run {
  readonly controller: AbortController
  stream?: MessageStream
}

export interface ChatDeps {
  host: HostAdapter
  send: EventSender
  ipcMain: IpcMainLike
}

export function registerChatRoutes({ host, send, ipcMain }: ChatDeps): void {
  const history = new Map<string, MessageParam[]>()
  const inFlight = new Map<string, Run>()
  const emit = (event: ChatEvent): void => send(chatEvent.channel, event)

  registerRoute(ipcMain, chatSend, async ({ sessionId, text }) => {
    if (inFlight.has(sessionId)) throw new Error('a reply is already streaming for this session')

    // Registered before the first await: a chat.stop that arrives while the keychain is
    // still being read must not be lost.
    const run: Run = { controller: new AbortController() }
    inFlight.set(sessionId, run)
    const release = (): void => {
      if (inFlight.get(sessionId) === run) inFlight.delete(sessionId)
    }

    try {
      // Keychain first (kernel-scoped key), then the SDK's own env resolution. An unreadable
      // store (locked keychain, no Secret Service on a headless Linux box) is logged and the
      // environment stays in charge.
      const apiKey = await host.secrets
        .get(keyFor(host.identity, ...ANTHROPIC_API_KEY_SECRET))
        .catch((error: unknown) => {
          console.warn('[chat] keychain unavailable, falling back to environment:', describe(error))
          return null
        })

      if (run.controller.signal.aborted) {
        release()
        emit({ type: 'done', sessionId, stopReason: 'aborted' })
        return { accepted: true as const }
      }

      // The SDK reports a missing credential as a plain Error, not an AuthenticationError;
      // decide it here so first-run users are told to configure a key.
      // `||`, not `??`: an empty ANTHROPIC_API_KEY= line must not hide a filled-in token.
      const envKey = process.env['ANTHROPIC_API_KEY'] || process.env['ANTHROPIC_AUTH_TOKEN']
      if (!apiKey && !envKey) {
        release()
        emit({ type: 'error', sessionId, code: 'auth', detail: NO_API_KEY })
        return { accepted: true as const }
      }

      const messages = history.get(sessionId) ?? []
      history.set(sessionId, messages)
      const last = messages.at(-1)
      const isRetry = last?.role === 'user' && last.content === text
      if (!isRetry) messages.push({ role: 'user', content: text })

      const client = new Anthropic(apiKey ? { apiKey } : {})
      const stream = client.messages.stream(
        {
          model: process.env['TENON_MODEL'] ?? DEFAULT_MODEL,
          max_tokens: maxTokens(),
          messages,
        },
        { signal: run.controller.signal },
      )
      run.stream = stream

      let partial = ''
      stream.on('text', (delta, snapshot) => {
        partial = snapshot
        emit({ type: 'text-delta', sessionId, delta })
      })

      void stream
        .finalMessage()
        // The session is released BEFORE the terminal event goes out: whoever reacts to
        // `done` / `error` by sending again must not be told a reply is still streaming.
        .then((message) => {
          release()
          messages.push({ role: 'assistant', content: message.content })
          emit({ type: 'done', sessionId, stopReason: 'end-turn' })
        })
        .catch((error: unknown) => {
          release()
          if (error instanceof APIUserAbortError) {
            // The user still sees the partial reply; the model must see it too.
            if (partial.length > 0) messages.push({ role: 'assistant', content: partial })
            emit({ type: 'done', sessionId, stopReason: 'aborted' })
            return
          }
          // The failed turn stays in the transcript: it is still on screen, and a retry
          // (same text) continues from it instead of duplicating it.
          emit({ type: 'error', sessionId, code: classify(error), detail: describe(error) })
        })

      return { accepted: true as const }
    } catch (error) {
      release()
      throw error
    }
  })

  registerRoute(ipcMain, chatStop, ({ sessionId }) => {
    const run = inFlight.get(sessionId)
    if (!run) return { stopped: false }
    run.controller.abort()
    run.stream?.abort()
    return { stopped: true }
  })
}

function classify(error: unknown): Extract<ChatEvent, { type: 'error' }>['code'] {
  if (error instanceof AuthenticationError) return 'auth'
  if (error instanceof RateLimitError) return 'rate-limit'
  if (error instanceof APIConnectionError) return 'network'
  if (error instanceof APIError) return 'provider'
  return 'unknown'
}

/** Diagnostic text for logs and the never-rendered `detail` field. SDK errors carry no key material. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
