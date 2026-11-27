/**
 * `session.setApprovalMode`, the facts it shows and the default it reads (spec 06 §档位怎么存、怎么切,
 * §接口; 验收 12, 13, 15 and 31's facts half; D40, D41): the route over the kernel's choice, through
 * the real routes of main on a memory host. The kernel's own table of cases is in
 * `packages/kernel/test/loop/approval-modes.test.ts`; these are the route's answers, the facts a route
 * reports, and the config.json the default comes from.
 */
import type { IpcMainLike } from '@tenon-app/contracts'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createTape,
  profileSetKey,
  sessionStartKey,
} from '@tenon-app/kernel'
import type { MemoryHost, TapeStore } from '@tenon-app/kernel'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
} from '@tenon-app/kernel/testing'
import { expect, it } from 'vitest'
import {
  registerApprovalModeRoutes,
  trackApprovalModeDefault,
} from '../src/main/approval-mode-routes.js'
import { registerConfigRoutes } from '../src/main/config.js'
import { readConfig } from '../src/main/host/profile.js'
import { refuseWhileShuttingDown } from '../src/main/shutdown.js'
import { registerWorkspaceRoutes } from '../src/main/workspace.js'

const HOME = absolutePath('/Users/someone')
const TASK = '11111111-1111-4111-8111-111111111111'
const OTHER_TASK = '22222222-2222-4222-8222-222222222222'
const CHAT = '33333333-3333-4333-8333-333333333333'
const CHILD = '44444444-4444-4444-8444-444444444444'
const UNKNOWN = '55555555-5555-4555-8555-555555555555'
const MODEL = {
  id: 'mode-route-model',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: false,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop' as const,
  usageNeedsOptIn: false,
}

type Handler = (event: unknown, payload: unknown) => unknown

let profiles = 0
/** One memory host and store per case; `boot` can be called again on them, as a restart does. */
async function rig() {
  profiles += 1
  const identity = {
    userId: 'local',
    tenantId: 'personal',
    profileDir: `/Users/someone/profile-${profiles}`,
  }
  const memory = createMemoryHost({ identity })
  await memory.fs.mkdirp(absolutePath(identity.profileDir))
  const inner = createMemoryTapeStore({ identity: memory.identity })
  // The batches written together, by their names: the creation batch is one of them.
  const batches: string[][] = []
  const store: TapeStore = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'append') {
        return (batch: Parameters<TapeStore['append']>[0]) => {
          batches.push(batch.entries.map((entry) => entry.name))
          return target.append(batch)
        }
      }
      if (property === 'resetSession') {
        return (q: Parameters<TapeStore['resetSession']>[0]) => {
          batches.push([q.start.name, ...(q.carry ?? []).map((entry) => entry.name)])
          return target.resetSession(q)
        }
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const ids = createCounterIds()
  const boot = (options: { gate?: Promise<void>; shutdownGuard?: () => boolean } = {}) =>
    bootOn(memory, store, ids, options)
  const entries = async (sessionId: string, name: string) =>
    (await store.readRange({ sessionId, limit: 1000 })).entries.filter((e) => e.name === name)
  return { memory, store, batches, boot, entries }
}

type Rig = Awaited<ReturnType<typeof rig>>

async function bootOn(
  memory: MemoryHost,
  store: TapeStore,
  ids: ReturnType<typeof createCounterIds>,
  options: { gate?: Promise<void>; shutdownGuard?: () => boolean },
) {
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({ connector: { provider, model: MODEL } })
  // Main reads the file once at startup (index.ts); a restart reads what the last run left.
  const startup = await readConfig(memory.fs, memory.identity)
  const sessions = createTestSessionService({
    host: memory,
    tape: store,
    ids,
    connector: loop.connector,
    inspectors: [],
    protectedFiles: [],
    // The default as main wires it: the file's value at startup, then what every write of it left.
    approvalModeDefault: trackApprovalModeDefault(memory.identity, startup.approvalMode),
  })
  sessions.bindLoop(loop)
  const handlers = new Map<string, Handler>()
  const raw: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener as Handler)
    },
  }
  const ipcMain =
    options.shutdownGuard === undefined ? raw : refuseWhileShuttingDown(raw, options.shutdownGuard)
  registerConfigRoutes(ipcMain, memory, () => {})
  registerApprovalModeRoutes({
    ipcMain,
    sessions,
    ...(options.gate === undefined ? {} : { gate: options.gate }),
  })
  registerWorkspaceRoutes({
    ipcMain,
    sessions,
    host: memory,
    home: HOME,
    pickFolders: () => Promise.resolve(null),
  })
  const call = async (channel: string, payload: unknown): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error(`no handler for ${channel}`)
    return handler({}, payload)
  }
  const setMode = (sessionId: string, mode: 'manual' | 'auto') =>
    call('session.setApprovalMode', { sessionId, mode })
  const facts = async (sessionId: string) =>
    ((await call('session.facts', { sessionId })) as { data: Record<string, unknown> }).data
  const task = async (sessionId: string): Promise<void> => {
    await call('session.selectProfile', { sessionId, profile: 'cowork' })
  }
  /** The first send of a task (it creates the session), or a later one, to the end of its Run. */
  const send = async (sessionId: string): Promise<void> => {
    provider.script(scriptedTurn({ deltas: ['done'] }))
    const sent = await sessions.send({ sessionId, origin: null, text: 'go' })
    if (sent.status !== 'started') throw new Error(`send: ${sent.status}`)
    await loop.runEnded({ runId: sent.runId })
  }
  return { sessions, loop, call, setMode, facts, task, send }
}

const OK = (mode: 'manual' | 'auto') => ({ ok: true, data: { ok: true, mode } })
const REFUSED = (code: string) => ({ ok: true, data: { ok: false, code } })

async function modeFacts(r: Rig, sessionId: string) {
  return (await r.entries(sessionId, 'session/approval_mode_set')).map((entry) => entry.payload)
}

it('06 验收 12: the route sets an established task’s mode, it survives a restart, and chat, child and unknown ids are refused', async () => {
  const r = await rig()
  const first = await r.boot()
  await first.task(TASK)
  await first.send(TASK)
  expect(await modeFacts(r, TASK)).toEqual([])
  expect(await first.setMode(TASK, 'auto')).toEqual(OK('auto'))
  expect(await modeFacts(r, TASK)).toMatchObject([
    { mode: 'auto', by: 'user', writer: { by: 'resolver' } },
  ])
  expect(await first.facts(TASK)).toMatchObject({ established: true, approvalMode: 'auto' })

  // A restart: another service on the same store reads the mode back from the Tape.
  const second = await r.boot()
  await second.sessions.recover()
  expect(await second.facts(TASK)).toMatchObject({ established: true, approvalMode: 'auto' })
  expect(await second.setMode(TASK, 'manual')).toEqual(OK('manual'))
  expect(await second.facts(TASK)).toMatchObject({ approvalMode: 'manual' })

  // A chat, a sub-agent's session and a session nobody made.
  await second.call('session.selectProfile', { sessionId: CHAT, profile: 'chat' })
  await second.send(CHAT)
  expect(await second.setMode(CHAT, 'auto')).toEqual(REFUSED('not-cowork'))
  const tape = createTape(r.store)
  const incarnation = '66666666-6666-4666-8666-666666666666'
  await tape.appendEntries({
    sessionId: CHILD,
    incarnationId: incarnation,
    entries: [
      tape.writer('session').entry('session/start', {
        sourceType: 'session',
        sourceId: CHILD,
        sourceSeq: 0,
        provenanceKey: sessionStartKey(incarnation),
        payload: { incarnationId: incarnation },
        createdAt: 0,
      }),
      tape.writer('session').entry('session/profile_set', {
        sourceType: 'session',
        sourceId: CHILD,
        provenanceKey: profileSetKey(incarnation),
        payload: { profile: 'cowork', subagentOf: { sessionId: TASK, linkKey: 'a-link' } },
        createdAt: 0,
      }),
    ],
  })
  expect(await second.setMode(CHILD, 'auto')).toEqual(REFUSED('not-cowork'))
  expect(await modeFacts(r, CHILD)).toEqual([])
  expect(await second.setMode(UNKNOWN, 'auto')).toEqual(REFUSED('unknown-session'))
  expect(await modeFacts(r, UNKNOWN)).toEqual([])

  // The request is the session and the mode, nothing else; a mode that is not one fails to parse.
  expect(
    await second.call('session.setApprovalMode', { sessionId: TASK, mode: 'yolo' }),
  ).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  expect(
    await second.call('session.setApprovalMode', { sessionId: TASK, mode: 'auto', by: 'policy' }),
  ).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
})

it('06 验收 12: a shutdown refuses a choice: the kernel answers refused, and the route table refuses it before the kernel', async () => {
  const r = await rig()
  const live = await r.boot()
  await live.task(TASK)
  await live.send(TASK)
  const written = await modeFacts(r, TASK)
  live.loop.beginShutdown()
  // The kernel's own answer (D41): the same code on the wire, and no fact.
  expect(await live.setMode(TASK, 'auto')).toEqual(REFUSED('refused'))
  expect(await modeFacts(r, TASK)).toEqual(written)
  // In the app the route table answers first, at shutdown's step 3, before the handler and the gate.
  let shuttingDown = false
  const guarded = await r.boot({ gate: new Promise(() => {}), shutdownGuard: () => shuttingDown })
  shuttingDown = true
  expect(await guarded.setMode(TASK, 'manual')).toEqual({
    ok: false,
    error: { code: 'handler-failed', message: 'the app is shutting down' },
  })
  expect(await modeFacts(r, TASK)).toEqual(written)
})

it('06 验收 12: the route waits for startup recovery, and with no store there is no session to choose for', async () => {
  const r = await rig()
  const gate = Promise.withResolvers<void>()
  const waiting = await r.boot({ gate: gate.promise })
  await waiting.task(TASK)
  let answered = false
  const pending = waiting.setMode(TASK, 'auto').then((answer) => {
    answered = true
    return answer
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(answered).toBe(false)
  gate.resolve()
  expect(await pending).toEqual(OK('auto'))
  const handlers = new Map<string, Handler>()
  registerApprovalModeRoutes({
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener as Handler) },
    sessions: null,
  })
  expect(
    await handlers.get('session.setApprovalMode')!({}, { sessionId: TASK, mode: 'auto' }),
  ).toEqual(REFUSED('unknown-session'))
})

it('06 验收 13: a draft’s mode chosen through the route is written as by user in the creation batch, and the first send keeps it', async () => {
  const r = await rig()
  const app = await r.boot()
  await app.task(TASK)
  // Before the session exists: the draft takes the choice, and the facts show it.
  expect(await app.facts(TASK)).toMatchObject({ established: false, approvalMode: 'manual' })
  expect(await app.setMode(TASK, 'auto')).toEqual(OK('auto'))
  expect(await app.facts(TASK)).toMatchObject({ established: false, approvalMode: 'auto' })
  expect(await modeFacts(r, TASK)).toEqual([])
  await app.send(TASK)
  expect(await modeFacts(r, TASK)).toMatchObject([
    { mode: 'auto', by: 'user', writer: { by: 'resolver' } },
  ])
  const creation = r.batches.find((batch) => batch.includes('session/start'))
  expect(creation).toEqual(
    expect.arrayContaining([
      'session/start',
      'session/profile_set',
      'session/workspace_set',
      'session/approval_mode_set',
    ]),
  )
  expect(await app.facts(TASK)).toMatchObject({ established: true, approvalMode: 'auto' })
})

it('06 验收 13: the default is read from config.json when send starts, and a draft’s choice overrides it', async () => {
  const r = await rig()
  const app = await r.boot()
  // config.set persists the mode, and the file is what the default follows.
  expect(await app.call('config.set', { approvalMode: 'auto' })).toMatchObject({
    ok: true,
    data: { approvalMode: 'auto' },
  })
  expect((await readConfig(r.memory.fs, r.memory.identity)).approvalMode).toBe('auto')
  await app.task(TASK)
  expect(await app.facts(TASK)).toMatchObject({ approvalMode: 'auto' })
  await app.send(TASK)
  expect(await modeFacts(r, TASK)).toMatchObject([{ mode: 'auto', by: 'default' }])

  // Taken back before the next task's first send: that send reads manual and writes no fact.
  await app.call('config.set', { approvalMode: 'manual' })
  await app.task(OTHER_TASK)
  await app.send(OTHER_TASK)
  expect(await modeFacts(r, OTHER_TASK)).toEqual([])

  // The draft's own choice beats the default, either way.
  const third = '77777777-7777-4777-8777-777777777777'
  await app.call('config.set', { approvalMode: 'auto' })
  await app.task(third)
  expect(await app.setMode(third, 'manual')).toEqual(OK('manual'))
  expect(await app.facts(third)).toMatchObject({ approvalMode: 'manual' })
  await app.send(third)
  expect(await modeFacts(r, third)).toMatchObject([{ mode: 'manual', by: 'user' }])

  // A restart reads the same file back: a new task's default is what config.json says.
  const restarted = await r.boot()
  const fourth = '88888888-8888-4888-8888-888888888888'
  await restarted.task(fourth)
  expect(await restarted.facts(fourth)).toMatchObject({ approvalMode: 'auto' })
  await restarted.send(fourth)
  expect(await modeFacts(r, fourth)).toMatchObject([{ mode: 'auto', by: 'default' }])
})

it('06 验收 13: config.set persists approvalMode and autoModeNoticeSeen and takes no folderAccess', async () => {
  const r = await rig()
  const app = await r.boot()
  expect(await app.call('config.get', {})).toMatchObject({
    ok: true,
    data: { approvalMode: 'manual', autoModeNoticeSeen: false, folderAccess: [] },
  })
  expect(
    await app.call('config.set', { approvalMode: 'auto', autoModeNoticeSeen: true }),
  ).toMatchObject({ ok: true, data: { approvalMode: 'auto', autoModeNoticeSeen: true } })
  // Read back from the file, as a restart does, and through config.get.
  expect(await readConfig(r.memory.fs, r.memory.identity)).toMatchObject({
    approvalMode: 'auto',
    autoModeNoticeSeen: true,
  })
  expect(await app.call('config.get', {})).toMatchObject({
    data: { approvalMode: 'auto', autoModeNoticeSeen: true },
  })
  // The notice is only ever marked seen; the kept folders are main's alone.
  expect(await app.call('config.set', { autoModeNoticeSeen: false })).toMatchObject({
    ok: false,
    error: { code: 'invalid-request' },
  })
  await app.call('config.set', { folderAccess: ['/etc'], approvalMode: 'manual' })
  expect((await readConfig(r.memory.fs, r.memory.identity)).folderAccess).toEqual([])
  expect((await readConfig(r.memory.fs, r.memory.identity)).approvalMode).toBe('manual')
})

it('06 验收 31: an unavailable policy leaves the facts readable and names no policy fold', async () => {
  // 02 fails closed without a policy (every call is denied); the facts still answer, so the folder
  // controls and the mode menu stay on screen.
  const r = await rig()
  const app = await r.boot()
  await app.task(TASK)
  await app.send(TASK)
  expect(await app.setMode(TASK, 'auto')).toEqual(OK('auto'))
  r.memory.setPolicy({ status: 'unavailable' })
  const facts = await app.facts(TASK)
  expect(facts).toMatchObject({ established: true, profile: 'cowork', approvalMode: 'auto' })
  expect(facts).not.toHaveProperty('autoModeDisabled')
  await app.task(OTHER_TASK)
  expect(await app.facts(OTHER_TASK)).toMatchObject({ established: false, approvalMode: 'manual' })
})

it('06 验收 15: with the policy turning auto off, the route refuses auto, still sets manual, and the facts report manual with autoModeDisabled', async () => {
  const r = await rig()
  const app = await r.boot()
  await app.task(TASK)
  await app.send(TASK)
  expect(await app.setMode(TASK, 'auto')).toEqual(OK('auto'))
  expect(await app.facts(TASK)).toMatchObject({ approvalMode: 'auto' })
  expect(await app.facts(TASK)).not.toHaveProperty('autoModeDisabled')
  // A draft that chose auto itself, before the policy came.
  await app.task(OTHER_TASK)
  expect(await app.setMode(OTHER_TASK, 'auto')).toEqual(OK('auto'))
  expect(await app.facts(OTHER_TASK)).toMatchObject({ established: false, approvalMode: 'auto' })

  r.memory.setPolicy({
    status: 'current',
    version: 'disabled',
    snapshot: { tools: [], disableAutoMode: true },
  })
  // The Tape's last fact still says auto (the policy fact is written by the next judgement), but
  // what the facts show, and what the menu and the banner follow, is manual (D40).
  expect((await modeFacts(r, TASK)).at(-1)).toMatchObject({ mode: 'auto', by: 'user' })
  expect(await app.facts(TASK)).toMatchObject({
    established: true,
    approvalMode: 'manual',
    autoModeDisabled: true,
  })
  expect(await app.setMode(TASK, 'auto')).toEqual(REFUSED('policy'))
  expect(await modeFacts(r, TASK)).toHaveLength(1)
  // The draft is told the same, though its own choice was auto.
  expect(await app.facts(OTHER_TASK)).toMatchObject({
    established: false,
    approvalMode: 'manual',
    autoModeDisabled: true,
  })
  expect(await app.setMode(OTHER_TASK, 'auto')).toEqual(REFUSED('policy'))
  // Manual is never refused by the policy.
  expect(await app.setMode(TASK, 'manual')).toEqual(OK('manual'))
  expect((await modeFacts(r, TASK)).at(-1)).toMatchObject({ mode: 'manual', by: 'user' })
  expect(await app.facts(TASK)).toMatchObject({ approvalMode: 'manual', autoModeDisabled: true })

  // The policy lifted: auto is available again, and the facts follow the Tape.
  r.memory.setPolicy({ status: 'current', version: 'open', snapshot: { tools: [] } })
  expect(await app.facts(TASK)).not.toHaveProperty('autoModeDisabled')
  expect(await app.setMode(TASK, 'auto')).toEqual(OK('auto'))
})
