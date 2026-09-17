import Anthropic, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
} from '@anthropic-ai/sdk'
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream'
import { chatEvent, chatSend, chatStop, registerRoute } from '@tenon-app/contracts'
import type { ChatEvent } from '@tenon-app/contracts'
import { keyFor } from '@tenon-app/kernel'
import type { HostAdapter } from '@tenon-app/kernel'
import type { IpcMain } from 'electron'
import type { EventSender } from './host/index.js'

/**
 * Phase 0: the smallest possible streaming call, deliberately not abstracted (the
 * provider layer is phase 1's decision). One in-flight reply per session; `chat.stop`
 * aborts it and the abort reaches the SDK's fetch through its AbortController.
 */

export const DEFAULT_MODEL = 'claude-opus-5'
const MAX_TOKENS = 64_000

export const ANTHROPIC_API_KEY_SECRET = ['provider', 'anthropic', 'apiKey'] as const

type MessageParam = Anthropic.MessageParam

export interface ChatDeps {
  host: HostAdapter
  send: EventSender
  ipcMain: IpcMain
}

export function registerChatRoutes({ host, send, ipcMain }: ChatDeps): void {
  const history = new Map<string, MessageParam[]>()
  const inFlight = new Map<string, MessageStream>()
  const emit = (event: ChatEvent): void => send(chatEvent.channel, event)

  registerRoute(ipcMain, chatSend, async ({ sessionId, text }) => {
    if (inFlight.has(sessionId)) throw new Error('a reply is already streaming for this session')

    // Keychain first (kernel-scoped key), then the SDK's own env resolution.
    const apiKey = await host.secrets.get(keyFor(host.identity, ...ANTHROPIC_API_KEY_SECRET))
    const client = new Anthropic(apiKey ? { apiKey } : {})
    const messages = history.get(sessionId) ?? []
    messages.push({ role: 'user', content: text })
    history.set(sessionId, messages)

    const stream = client.messages.stream({
      model: process.env['TENON_MODEL'] ?? DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      messages,
    })
    inFlight.set(sessionId, stream)
    stream.on('text', (delta) => emit({ type: 'text-delta', sessionId, delta }))

    void stream
      .finalMessage()
      .then((message) => {
        messages.push({ role: 'assistant', content: message.content })
        emit({ type: 'done', sessionId, stopReason: 'end-turn' })
      })
      .catch((error: unknown) => {
        if (error instanceof APIUserAbortError) {
          emit({ type: 'done', sessionId, stopReason: 'aborted' })
          return
        }
        // Keep the transcript consistent: the user turn that failed is dropped.
        messages.pop()
        emit({ type: 'error', sessionId, code: classify(error), detail: describe(error) })
      })
      .finally(() => {
        if (inFlight.get(sessionId) === stream) inFlight.delete(sessionId)
      })

    return { accepted: true as const }
  })

  registerRoute(ipcMain, chatStop, ({ sessionId }) => {
    const stream = inFlight.get(sessionId)
    if (!stream) return { stopped: false }
    stream.abort()
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
