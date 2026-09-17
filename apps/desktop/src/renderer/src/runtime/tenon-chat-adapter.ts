import { chatEvent, chatEventSchema, chatSend, chatStop, invokeRoute } from '@tenon-app/contracts'
import type { ChatEvent } from '@tenon-app/contracts'
import type { ChatModelAdapter, ChatModelRunOptions, ThreadMessage } from '@assistant-ui/react'
import type { TenonBridge } from '../../../preload/index'
import { createAsyncChannel } from './async-channel'

/**
 * The error codes `chatEventSchema` can carry.
 * NOTE the shape: a conditional type over the union (`ChatEvent extends { type: 'error' } ? … : never`)
 * silently collapses to `never`, because `ChatEvent` is not a naked type parameter there.
 */
export type ChatErrorCode = Extract<ChatEvent, { type: 'error' }>['code']

/**
 * Every failure the UI can see carries a code, never a sentence (spec「内核不产生用户可见的句子」).
 *
 * `message` is deliberately the code itself. assistant-ui's `toAssistantError` returns any
 * object with string `code` + `message` UNCHANGED, and an `Error` instance with a `code`
 * field satisfies that check — so `status.error` is this very instance and the structured
 * code survives. Anything that leaks through a default renderer (which prints
 * `error.message`) is therefore still a code, not prose.
 */
export class ChatStreamError extends Error {
  readonly code: ChatErrorCode
  /** Diagnostic only. Never rendered; goes to the log. */
  readonly detail: string | undefined

  constructor(code: ChatErrorCode, detail?: string) {
    super(code)
    this.name = 'ChatStreamError'
    this.code = code
    this.detail = detail
  }
}

function lastUserText(messages: readonly ThreadMessage[]): string {
  const last = messages.at(-1)
  if (!last) return ''
  return last.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim()
}

export interface TenonChatAdapterOptions {
  readonly sessionId: string
  readonly bridge: TenonBridge
}

/**
 * Bridges assistant-ui's `useLocalRuntime` onto the two chat routes and the one chat event
 * of @tenon-app/contracts. No fetch, no endpoint: the reply is produced by main and arrives
 * as `chat.event` deltas.
 */
export function createTenonChatAdapter(options: TenonChatAdapterOptions): ChatModelAdapter {
  const { sessionId, bridge } = options

  return {
    async *run({ messages, abortSignal }: ChatModelRunOptions) {
      const text = lastUserText(messages)
      if (text.length === 0) return

      const channel = createAsyncChannel<ChatEvent>()

      // Subscribe BEFORE invoking: main may start emitting inside the invoke turn.
      const unsubscribe = bridge.on(chatEvent.channel, (payload) => {
        const parsed = chatEventSchema.safeParse(payload)
        if (!parsed.success) return
        const event = parsed.data
        if (event.sessionId !== sessionId) return
        channel.push(event)
        if (event.type === 'done' || event.type === 'error') channel.close()
      })

      const onAbort = (): void => {
        void invokeRoute(bridge, chatStop, { sessionId })
        // Close locally too: otherwise the generator hangs on its pending await if main is
        // slow to emit done{stopReason:'aborted'}.
        channel.close()
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })

      try {
        const accepted = await invokeRoute(bridge, chatSend, { sessionId, text })
        if (!accepted.ok) throw new ChatStreamError('unknown', accepted.error.code)

        let assembled = ''
        for await (const event of channel.drain()) {
          switch (event.type) {
            case 'text-delta': {
              assembled += event.delta
              // assistant-ui replaces the whole message state per yield: send cumulative
              // text, not the delta.
              yield { content: [{ type: 'text' as const, text: assembled }] }
              break
            }
            case 'error': {
              throw new ChatStreamError(event.code, event.detail)
            }
            case 'done': {
              if (event.stopReason === 'error') throw new ChatStreamError('unknown')
              return
            }
          }
        }
      } finally {
        abortSignal.removeEventListener('abort', onAbort)
        unsubscribe()
      }
    },
  }
}
