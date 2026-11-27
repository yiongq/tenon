/**
 * A decision summary code this build does not know (spec 06 rule 14, §点名 (j), 验收 44's read half;
 * D32): `session.messages`, `session.latest` and the `tool-outcome` event still come back, the code
 * reads `unknown`, and the verdict and slots stay as stored. The sentence the interface shows for it
 * is the renderer's (plan step 18).
 */
import {
  chatEvent,
  chatEventSchema,
  invokeRoute,
  sessionLatest,
  sessionMessages,
} from '@tenon-app/contracts'
import type { ChatEvent, IpcMainLike } from '@tenon-app/contracts'
import type { SessionMessageRow, SessionService, ToolOutcomeView } from '@tenon-app/kernel'
import { expect, it } from 'vitest'
import { createRunEvents } from '../src/main/run-events.js'
import { registerSessionRoutes } from '../src/main/session.js'

const SESSION = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'
const KEY = '00000000-0000-4000-8000-000000000001:1:0'
const FUTURE_CODE = 'a-code-from-a-later-build'

/** What a later build stored: the kernel's type is closed, a stored value is not. */
function outcomeWith(verdict: 'allow' | 'ask' | 'deny'): ToolOutcomeView {
  return {
    effect: 'write',
    state: 'completed',
    source: null,
    output: 'done',
    permission: { verdict, code: FUTURE_CODE as never, facts: { toolName: 'Write' } },
  }
}

/** The renderer's end of the bridge: it reads whatever main answered. */
const renderer = (answer: unknown) => ({ invoke: async () => answer })

function row(outcome: ToolOutcomeView): SessionMessageRow {
  return {
    sessionId: SESSION,
    messageId: 'm1',
    orderSeq: 1,
    role: 'assistant',
    status: 'complete',
    content: [{ type: 'tool-request', id: 'toolu_1', name: 'Write', input: { file_path: '/a' } }],
    entryId: 1,
    createdAt: 0,
    updatedAt: 0,
    calls: [{ callKey: KEY, outcome }],
  }
}

it.each(['allow', 'ask', 'deny'] as const)(
  '06 验收 44: an unknown summary code under %s verdict reads as unknown in messages, latest and tool events',
  async (verdict) => {
    const outcome = outcomeWith(verdict)
    const stored = row(outcome)
    const sessions = {
      latestSession: async () => ({ sessionId: SESSION, messages: [stored] }),
      listMessages: async () => [stored],
    } as unknown as SessionService
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
    const ipcMain: IpcMainLike = {
      handle: (channel, listener) => void handlers.set(channel, listener),
    }
    registerSessionRoutes({ ipcMain, sessions })
    const read = { verdict, code: 'unknown', facts: { toolName: 'Write' } }
    const expected = [{ callKey: KEY, outcome: { permission: read } }]

    // The two reads, as main answers them and as the renderer's own invoker reads that answer.
    const asked = await handlers.get(sessionMessages.channel)!(
      {},
      { sessionId: SESSION, limit: 10 },
    )
    expect(asked).toMatchObject({ ok: true, data: [{ calls: expected }] })
    const latest = await handlers.get(sessionLatest.channel)!({}, { limit: 10 })
    expect(latest).toMatchObject({
      ok: true,
      data: { sessionId: SESSION, messages: [{ calls: expected }] },
    })
    expect(
      await invokeRoute(renderer(asked), sessionMessages, { sessionId: SESSION, limit: 10 }),
    ).toMatchObject({ ok: true, data: [{ calls: expected }] })
    expect(await invokeRoute(renderer(latest), sessionLatest, { limit: 10 })).toMatchObject({
      ok: true,
      data: { messages: [{ calls: expected }] },
    })

    // The live event, as main forwards it and as the renderer parses it.
    const sent: ChatEvent[] = []
    const handle = createRunEvents({
      send: (channel, payload) => {
        expect(channel).toBe(chatEvent.channel)
        sent.push(payload as ChatEvent)
      },
      onRunStarted: () => {},
      onHeld: () => {},
      log: () => {},
    })
    handle({
      rootSessionId: SESSION,
      sessionId: SESSION,
      type: 'tool-outcome',
      callKey: KEY,
      providerToolCallId: 'toolu_1',
      outcome,
    })
    expect(sent).toHaveLength(1)
    expect(chatEventSchema.parse(sent[0])).toMatchObject({
      type: 'tool-outcome',
      callKey: KEY,
      permission: read,
    })
    // The kernel's own value is untouched: nothing here rewrote what the Tape holds.
    expect(outcome.permission).toEqual({ verdict, code: FUTURE_CODE, facts: { toolName: 'Write' } })
  },
)
