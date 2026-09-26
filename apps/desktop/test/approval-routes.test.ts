/**
 * The approval routes only forward (spec 02 §答复与投递; plan step 15): `approval.respond` to the
 * kernel's `answer`, with the document that answered as the origin, a refusal as `ok: false`;
 * `approval.current` to `currentPending`, through the contracts schema.
 */
import type { IpcMainLike } from '@tenon-app/contracts'
import type { AnswerCommand, PendingCard, RunOrigin, SessionService } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { registerApprovalRoutes } from '../src/main/approval-routes.js'

const SESSION = '7c4e9a2e-6b3d-4a71-9f52-0c8de7a11b37'
const REQUEST = 'tool:v1:decision:00000000-0000-4000-8000-000000000001:1:0'

type Handler = (event: unknown, payload: unknown) => unknown

function fakeIpc(): {
  ipcMain: IpcMainLike
  call(channel: string, payload: unknown, event?: unknown): Promise<unknown>
} {
  const handlers = new Map<string, Handler>()
  return {
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener as Handler)
      },
    },
    async call(channel, payload, event = {}) {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`no handler for ${channel}`)
      return handler(event, payload)
    },
  }
}

const CARD: PendingCard = {
  waitKind: 'approval',
  card: {
    requestId: REQUEST,
    sessionId: SESSION,
    kind: 'tool',
    reason: 'flagged',
    facts: { category: 'exfiltration', toolName: 'look' },
    reversibility: 'unknown',
    target: { type: 'tool', serverId: 'fs', toolName: 'look' },
  },
  callKey: '00000000-0000-4000-8000-000000000001:1:0',
  anchorCallKey: '00000000-0000-4000-8000-000000000001:1:0',
  allowScope: 'once',
}

function stubSessions(answerStatus: string): {
  sessions: SessionService
  answers: Array<AnswerCommand & { origin: RunOrigin | null }>
} {
  const answers: Array<AnswerCommand & { origin: RunOrigin | null }> = []
  const sessions = {
    answer: (q: AnswerCommand & { origin: RunOrigin | null }) => {
      answers.push(q)
      return Promise.resolve({ status: answerStatus })
    },
    currentPending: () => Promise.resolve(CARD),
  } as unknown as SessionService
  return { sessions, answers }
}

describe('approval routes', () => {
  it('forwards an answer with its document as the origin, and the kernel’s status back', async () => {
    const ipc = fakeIpc()
    const { sessions, answers } = stubSessions('applied')
    registerApprovalRoutes({ ipcMain: ipc.ipcMain, sessions })
    const sender = { on: () => undefined, off: () => undefined }
    const request = { kind: 'approval', sessionId: SESSION, requestId: REQUEST, decision: 'allow' }
    expect(await ipc.call('approval.respond', request, { sender })).toEqual({
      ok: true,
      data: { status: 'applied' },
    })
    expect(answers).toEqual([{ ...request, origin: sender }])
  })

  it('maps a refusal to ok: false, and refuses a session id that is not canonical', async () => {
    const ipc = fakeIpc()
    registerApprovalRoutes({ ipcMain: ipc.ipcMain, sessions: stubSessions('refused').sessions })
    const request = { kind: 'approval', sessionId: SESSION, requestId: REQUEST, decision: 'deny' }
    expect(await ipc.call('approval.respond', request)).toMatchObject({ ok: false })
    expect(
      await ipc.call('approval.respond', { ...request, sessionId: 'not-a-uuid' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('answers approval.current with the kernel’s card, and null without a store', async () => {
    const ipc = fakeIpc()
    registerApprovalRoutes({ ipcMain: ipc.ipcMain, sessions: stubSessions('applied').sessions })
    expect(await ipc.call('approval.current', { sessionId: SESSION })).toEqual({
      ok: true,
      data: CARD,
    })
    const empty = fakeIpc()
    registerApprovalRoutes({ ipcMain: empty.ipcMain, sessions: null })
    expect(await empty.call('approval.current', { sessionId: SESSION })).toEqual({
      ok: true,
      data: null,
    })
    expect(
      await empty.call('approval.respond', {
        kind: 'approval',
        sessionId: SESSION,
        requestId: REQUEST,
        decision: 'allow',
      }),
    ).toEqual({ ok: true, data: { status: 'not-found' } })
  })
})
