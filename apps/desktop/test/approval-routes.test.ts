/**
 * The approval routes only forward (spec 02 §答复与投递; plan steps 15 and 26): `approval.respond`
 * to the kernel's `answer`, with the document that answered as the origin, a refusal as `ok: false`;
 * `approval.current` to `currentPending` (an approval or a question), through the
 * contracts schema.
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

const QUESTION: Extract<
  NonNullable<Awaited<ReturnType<SessionService['currentPending']>>>,
  { waitKind: 'question' }
> = {
  waitKind: 'question',
  requestId: REQUEST,
  sessionId: SESSION,
  toolRequestId: 'toolu_ask',
  callKey: '00000000-0000-4000-8000-000000000001:1:0',
}

function stubSessions(
  answerStatus: string,
  pending: PendingCard | null = CARD,
): {
  sessions: SessionService
  answers: Array<AnswerCommand & { origin: RunOrigin | null }>
} {
  const answers: Array<AnswerCommand & { origin: RunOrigin | null }> = []
  const sessions = {
    answer: (q: AnswerCommand & { origin: RunOrigin | null }) => {
      answers.push(q)
      return Promise.resolve({ status: answerStatus })
    },
    currentPending: () => Promise.resolve(pending),
    listPendingRoots: (q: { limit: number }) =>
      Promise.resolve(
        [
          { sessionId: SESSION, waitKind: 'resume' },
          { sessionId: '8d5f9a2e-6b3d-4a71-9f52-0c8de7a11b38', waitKind: 'approval' },
        ].slice(0, q.limit),
      ),
    resume: () => Promise.resolve({ status: answerStatus === 'refused' ? 'refused' : 'started' }),
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

describe('a question through the approval routes (plan step 26)', () => {
  it('forwards the pending question, approval, or empty state', async () => {
    const asked = fakeIpc()
    registerApprovalRoutes({
      ipcMain: asked.ipcMain,
      sessions: stubSessions('applied', QUESTION).sessions,
    })
    expect(await asked.call('approval.current', { sessionId: SESSION })).toEqual({
      ok: true,
      data: QUESTION,
    })
    // The kernel owns which call waits; the route forwards the selected approval unchanged.
    const both = fakeIpc()
    registerApprovalRoutes({
      ipcMain: both.ipcMain,
      sessions: stubSessions('applied', CARD).sessions,
    })
    expect(await both.call('approval.current', { sessionId: SESSION })).toEqual({
      ok: true,
      data: CARD,
    })
    const none = fakeIpc()
    registerApprovalRoutes({
      ipcMain: none.ipcMain,
      sessions: stubSessions('applied', null).sessions,
    })
    expect(await none.call('approval.current', { sessionId: SESSION })).toEqual({
      ok: true,
      data: null,
    })
  })

  it('passes a question’s answers through to the kernel as they came, nulls and all', async () => {
    const ipc = fakeIpc()
    const { sessions, answers } = stubSessions('applied', QUESTION)
    registerApprovalRoutes({ ipcMain: ipc.ipcMain, sessions })
    const sender = { on: () => undefined, off: () => undefined }
    const request = {
      kind: 'question',
      sessionId: SESSION,
      requestId: REQUEST,
      // A label may hold 「, 」 itself: the kernel joins, the route never splits or joins.
      answers: { 'Which colour?': ['red, dark', 'blue'], 'Which size?': null },
    }
    expect(await ipc.call('approval.respond', request, { sender })).toEqual({
      ok: true,
      data: { status: 'applied' },
    })
    expect(answers).toEqual([{ ...request, origin: sender }])
    // The kernel's `invalid` (a key that is not a question) goes back as it is.
    const refusing = fakeIpc()
    registerApprovalRoutes({
      ipcMain: refusing.ipcMain,
      sessions: stubSessions('invalid', QUESTION).sessions,
    })
    expect(await refusing.call('approval.respond', request)).toEqual({
      ok: true,
      data: { status: 'invalid' },
    })
  })
})

describe('approval.list, approval.resume and the recovery gate (plan step 16)', () => {
  it('lists the rows the kernel gives, bounded by the limit', async () => {
    const ipc = fakeIpc()
    registerApprovalRoutes({ ipcMain: ipc.ipcMain, sessions: stubSessions('applied').sessions })
    expect(await ipc.call('approval.list', { limit: 1 })).toEqual({
      ok: true,
      data: [{ sessionId: SESSION, waitKind: 'resume' }],
    })
  })

  it('forwards a resume, and maps its refusal to ok: false', async () => {
    const ipc = fakeIpc()
    registerApprovalRoutes({ ipcMain: ipc.ipcMain, sessions: stubSessions('applied').sessions })
    expect(await ipc.call('approval.resume', { sessionId: SESSION })).toEqual({
      ok: true,
      data: { status: 'started' },
    })
    const refusing = fakeIpc()
    registerApprovalRoutes({
      ipcMain: refusing.ipcMain,
      sessions: stubSessions('refused').sessions,
    })
    expect(await refusing.call('approval.resume', { sessionId: SESSION })).toMatchObject({
      ok: false,
    })
  })

  it('answers nothing, and asks the kernel nothing, until startup recovery is done', async () => {
    // Plan step 16: `approval.*` 都先 await — recovery's rewrites land before any answer reads the
    // Tape (§启动恢复与发送防护).
    const ipc = fakeIpc()
    const gate = Promise.withResolvers<void>()
    const { sessions } = stubSessions('applied')
    const reached: string[] = []
    const recording = new Proxy(sessions, {
      get(target, key, receiver): unknown {
        const value: unknown = Reflect.get(target, key, receiver)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          reached.push(String(key))
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    })
    registerApprovalRoutes({ ipcMain: ipc.ipcMain, sessions: recording, gate: gate.promise })
    let answered = 0
    const settled = (call: Promise<unknown>): Promise<unknown> =>
      call.then((result) => {
        answered += 1
        return result
      })
    const calls = [
      settled(ipc.call('approval.list', { limit: 20 })),
      settled(
        ipc.call('approval.respond', {
          kind: 'approval',
          sessionId: SESSION,
          requestId: REQUEST,
          decision: 'allow',
        }),
      ),
      settled(ipc.call('approval.current', { sessionId: SESSION })),
      settled(ipc.call('approval.resume', { sessionId: SESSION })),
    ]
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
    expect({ answered, reached }).toEqual({ answered: 0, reached: [] })
    gate.resolve()
    for (const result of await Promise.all(calls)) expect(result).toMatchObject({ ok: true })
    expect(reached.toSorted()).toEqual(['answer', 'currentPending', 'listPendingRoots', 'resume'])
  })
})
