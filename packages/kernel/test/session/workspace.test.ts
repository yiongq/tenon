/**
 * The profile, the draft before a session exists, the workspace and the environment note (spec 02
 * §会话形态「建立前暂存」, §工作区, §会话事实, §提示层「组装」「环境说明」; plan step 18: 旧 180–183, the
 * draft cases of open question 16, 旧 225's system half, 旧 151's language half).
 */
import { describe, expect, it } from 'vitest'
import {
  ProviderConfigMissingError,
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
} from '../../src/index.js'
import type {
  AbsolutePath,
  MemoryHost,
  ModelInfo,
  SessionEvent,
  SessionService,
  TapeEntry,
  TapeStore,
  Usage,
} from '../../src/index.js'
import { environmentText } from '../../src/loop/environment.js'
import { LOCALE_HINT, SYSTEM_PROMPTS, fill } from '../../src/prompts/index.js'
import { SESSION_DRAFT_CAP } from '../../src/session/draft.js'
import { readSessionFacts, workspaceOf } from '../../src/session/facts.js'
import { profileSetKey } from '../../src/tape/provenance.js'
import { createTape } from '../../src/tape/tape.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type { ScriptedProvider, TestLoopPorts } from '../../src/testing/index.js'
import { proxyStore } from '../loop/support.js'

const IDENTITY = { userId: 'ws-user', tenantId: 'ws-tenant', profileDir: '/tenon/ws' }
const SESSION = '7c1d9a2e-6b3d-4a71-9f52-0c8de7a11b41'
const OTHER = '7c1d9a2e-6b3d-4a71-9f52-0c8de7a11b42'
const DEDICATED = absolutePath(`/home/u/Tenon/workspaces/ws-user/ws-tenant/${SESSION}`)
const X = absolutePath('/work/x')
const Y = absolutePath('/work/y')

const MODEL: ModelInfo = {
  id: 'claude-ws-1',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}

const USAGE: Usage = {
  inputTokens: 5,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

interface Harness {
  readonly host: MemoryHost
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
}

async function harness(
  o: {
    locale?: 'zh-CN' | 'en'
    failing?: boolean
    onEvent?: (event: SessionEvent, loop: TestLoopPorts) => void
    /** The store the service is given, in place of the memory one (a case that holds a call back). */
    store?: (store: TapeStore) => TapeStore
  } = {},
): Promise<Harness> {
  const host = createMemoryHost({ identity: IDENTITY })
  await host.fs.mkdirp(X)
  await host.fs.mkdirp(Y)
  const memory = createMemoryTapeStore({ identity: IDENTITY })
  const store = o.store?.(memory) ?? memory
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop: TestLoopPorts = createTestLoopPorts({
    connector: { provider, model: MODEL },
    ...(o.locale === undefined ? {} : { locale: o.locale }),
    onEvent: (event) => o.onEvent?.(event, loop),
  })
  if (o.failing === true) {
    loop.connector.failProvider(new ProviderConfigMissingError('anthropic', 'apiKey'), 1)
  }
  const service = createTestSessionService(
    {
      host,
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [],
    },
    { tools: {} },
  )
  service.bindLoop(loop)
  return { host, store, service, loop, provider }
}

async function entries(store: TapeStore, sessionId = SESSION): Promise<TapeEntry[]> {
  return (await store.readRange({ sessionId, limit: 1000 })).entries
}

function named(all: readonly TapeEntry[], name: string): TapeEntry[] {
  return all.filter((entry) => entry.name === name)
}

async function send(h: Harness, text: string, sessionId = SESSION): Promise<string> {
  h.provider.script(scriptedTurn({ deltas: ['ok'], usage: USAGE }))
  const sent = await h.service.send({ sessionId, origin: null, text })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  await h.loop.runEnded({ runId: sent.runId })
  return sent.runId
}

const cowork = (h: Harness, sessionId = SESSION, dedicated: AbsolutePath = DEDICATED) =>
  h.service.selectProfile({ sessionId, profile: 'cowork', dedicated })

/** The request bodies the scripted provider was sent, as the Anthropic wire encodes them. */
function bodies(provider: ScriptedProvider): Array<{
  system?: string
  tools?: unknown
  messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>
}> {
  return provider.requests.map((request) => request.body as never)
}

describe('the draft before a session exists (open question 16)', () => {
  it('writes the draft’s profile and workspace with session/start, in one batch, and drops it', async () => {
    const h = await harness()
    expect(await cowork(h)).toEqual({
      ok: true,
      established: false,
      drafted: true,
      profile: 'cowork',
      workspace: { folders: [DEDICATED], origin: 'dedicated' },
      lastEndpointOrigin: null,
    })
    await send(h, 'hello')
    const all = await entries(h.store)
    expect(all.slice(0, 6).map((entry) => entry.name)).toEqual([
      'session/start',
      'session/profile_set',
      'session/workspace_set',
      'message/user',
      'execution/run_started',
      'session/model_selected',
    ])
    expect(all[1]?.payload).toEqual({ profile: 'cowork' })
    expect(all[2]?.payload).toEqual({ folders: [DEDICATED], origin: 'dedicated' })
    // One batch: one createdAt per fact, and nothing of another batch in between.
    expect(new Set(all.slice(0, 6).map((entry) => entry.entryId)).size).toBe(6)
    expect(await cowork(h)).toEqual({ ok: false, code: 'established' })
    // Where its one Run sent: what the model menu confirms a switch against (§模型选择「数据去向」).
    expect(await h.service.sessionFacts({ sessionId: SESSION })).toEqual({
      established: true,
      drafted: false,
      profile: 'cowork',
      workspace: { folders: [DEDICATED], origin: 'dedicated' },
      lastEndpointOrigin: 'https://connector.test',
    })
    // 旧 180: the dedicated folder is named, not made — until the first write or command.
    expect(await h.host.fs.stat(DEDICATED)).toBeNull()
  })

  it('answers a choice that arrives while the send prebuilds only once the session exists', async () => {
    const h = await harness()
    h.provider.script(scriptedTurn({ deltas: ['ok'], usage: USAGE }))
    const sending = h.service.send({ sessionId: SESSION, origin: null, text: 'first' })
    // Behind the holder: it runs only after the Run opened, and the session is a chat by then.
    const choosing = cowork(h)
    const sent = await sending
    expect(await choosing).toEqual({ ok: false, code: 'established' })
    if (sent.status === 'started') await h.loop.runEnded({ runId: sent.runId })
    expect(named(await entries(h.store), 'session/profile_set')[0]?.payload).toEqual({
      profile: 'chat',
    })
  })

  it('keeps the draft when a missing key writes nothing, and writes it on the next send', async () => {
    const h = await harness({ failing: true })
    await cowork(h)
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [X] },
      dedicated: DEDICATED,
    })
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'first' })
    expect(sent).toEqual({ status: 'not-sent', code: 'config-missing' })
    expect(await entries(h.store)).toEqual([])
    expect((await h.service.sessionFacts({ sessionId: SESSION })).drafted).toBe(true)
    await send(h, 'first')
    expect(named(await entries(h.store), 'session/workspace_set')[0]?.payload).toEqual({
      folders: [X],
      origin: 'picked',
    })
  })

  it('drops the folders when the draft goes back to chat, and starts cowork again from the dedicated folder', async () => {
    const h = await harness()
    await cowork(h)
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [X] },
      dedicated: DEDICATED,
    })
    expect(await h.service.selectProfile({ sessionId: SESSION, profile: 'chat' })).toMatchObject({
      ok: true,
      profile: 'chat',
      workspace: null,
    })
    expect(await cowork(h)).toMatchObject({
      workspace: { folders: [DEDICATED], origin: 'dedicated' },
    })
  })

  it('answers session facts for a draft, an established session, phase 1’s and an unknown one', async () => {
    const h = await harness()
    expect(await h.service.sessionFacts({ sessionId: SESSION })).toEqual({
      established: false,
      drafted: false,
      profile: 'chat',
      workspace: null,
      lastEndpointOrigin: null,
    })
    await cowork(h)
    expect(await h.service.sessionFacts({ sessionId: SESSION })).toMatchObject({
      established: false,
      drafted: true,
      profile: 'cowork',
    })
    // A session created the phase 1 way has no profile fact: it reads as an established chat.
    await h.service.createSession({ sessionId: OTHER })
    expect(await h.service.sessionFacts({ sessionId: OTHER })).toEqual({
      established: true,
      drafted: false,
      profile: 'chat',
      workspace: null,
      lastEndpointOrigin: null,
    })
    await send(h, 'in the old one', OTHER)
    expect(named(await entries(h.store, OTHER), 'view/tool_table').length).toBe(1)
    const table = named(await entries(h.store, OTHER), 'view/tool_table')[0]?.payload as {
      tools: Array<{ name: string }>
    }
    // A chat's candidates, under the test registry: no Write, Edit, Bash, Glob, Grep or Agent.
    expect(table.tools.map((tool) => tool.name)).not.toContain('Glob')
  })

  it('keeps at most SESSION_DRAFT_CAP drafts, dropping the oldest', async () => {
    const h = await harness()
    const ids = Array.from(
      { length: SESSION_DRAFT_CAP + 1 },
      (_, i) => `8d2e9a2e-6b3d-4a71-9f52-${String(i).padStart(12, '0')}`,
    )
    for (const id of ids) {
      // oxlint-disable-next-line no-await-in-loop -- in order: the first one is the oldest
      await h.service.selectProfile({ sessionId: id, profile: 'chat' })
    }
    expect((await h.service.sessionFacts({ sessionId: ids[0] as string })).drafted).toBe(false)
    expect((await h.service.sessionFacts({ sessionId: ids[1] as string })).drafted).toBe(true)
  })

  it('keeps an updated draft in its place: the one created first is still the first dropped', async () => {
    const h = await harness()
    const ids = Array.from(
      { length: SESSION_DRAFT_CAP + 1 },
      (_, i) => `8d2e9a2e-6b3d-4a71-9f52-${String(i).padStart(12, '0')}`,
    )
    for (const id of ids.slice(0, SESSION_DRAFT_CAP)) {
      // oxlint-disable-next-line no-await-in-loop -- in order: the first one is the oldest
      await h.service.selectProfile({ sessionId: id, profile: 'chat' })
    }
    // The oldest draft changes its profile: an update, not a new draft.
    await cowork(h, ids[0] as string)
    await h.service.selectProfile({ sessionId: ids[SESSION_DRAFT_CAP] as string, profile: 'chat' })
    expect((await h.service.sessionFacts({ sessionId: ids[0] as string })).drafted).toBe(false)
    expect((await h.service.sessionFacts({ sessionId: ids[1] as string })).drafted).toBe(true)
  })
})

describe('the workspace (§工作区; D11)', () => {
  it('writes the whole list on each change, resolved, and refuses what the rules refuse', async () => {
    const h = await harness()
    h.host.symlink(absolutePath('/link'), '/work')
    await cowork(h)
    await send(h, 'start')
    const add = await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [absolutePath('/link/x'), Y] },
      dedicated: DEDICATED,
    })
    // The dedicated folder gives way to the picked ones, each as its real path (D8).
    expect(add).toEqual({ ok: true, folders: [X, Y], origin: 'picked' })
    expect(
      await h.service.setWorkspace({
        sessionId: SESSION,
        change: { kind: 'remove', folder: '/work/z' },
        dedicated: DEDICATED,
      }),
    ).toEqual({ ok: false, code: 'not-in-list' })
    // The same folder again changes nothing, and writes nothing.
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [X] },
      dedicated: DEDICATED,
    })
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'remove', folder: X },
      dedicated: DEDICATED,
    })
    const last = await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'remove', folder: Y },
      dedicated: DEDICATED,
    })
    expect(last).toEqual({ ok: true, folders: [DEDICATED], origin: 'dedicated' })
    const facts = named(await entries(h.store), 'session/workspace_set')
    expect(facts.map((entry) => [entry.sourceSeq, entry.payload])).toEqual([
      [0, { folders: [DEDICATED], origin: 'dedicated' }],
      [1, { folders: [X, Y], origin: 'picked' }],
      [2, { folders: [Y], origin: 'picked' }],
      [3, { folders: [DEDICATED], origin: 'dedicated' }],
    ])
    // A chat has no workspace; a session neither made nor drafted is unknown.
    await h.service.selectProfile({ sessionId: OTHER, profile: 'chat' })
    const refused = { change: { kind: 'add' as const, folders: [X] }, dedicated: DEDICATED }
    expect(await h.service.setWorkspace({ sessionId: OTHER, ...refused })).toEqual({
      ok: false,
      code: 'not-cowork',
    })
    expect(
      await h.service.setWorkspace({
        sessionId: '9f3e9a2e-6b3d-4a71-9f52-0c8de7a11b49',
        ...refused,
      }),
    ).toEqual({ ok: false, code: 'unknown-session' })
  })

  it('tells the model of a change only with a new environment note: system and tools stay byte for byte', async () => {
    const h = await harness()
    await cowork(h)
    await send(h, 'first')
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [X, Y] },
      dedicated: DEDICATED,
    })
    await send(h, 'second')
    const [first, second] = bodies(h.provider)
    expect(second?.system).toBe(first?.system)
    expect(JSON.stringify(second?.tools)).toBe(JSON.stringify(first?.tools))
    // The later request's messages start with the earlier one's, block for block (§前缀纪律).
    expect(JSON.stringify(second?.messages.slice(0, first?.messages.length))).toBe(
      JSON.stringify(first?.messages),
    )
    const notes = named(await entries(h.store), 'message/environment')
    expect(notes.map((entry) => entry.payload['workspace'])).toEqual([
      { folders: [DEDICATED], origin: 'dedicated' },
      { folders: [X, Y], origin: 'picked' },
    ])
    // The earlier note stays where it was; the new one, with the whole list, follows the message.
    const texts = second?.messages.flatMap((message) =>
      message.content.map((block) => block.text ?? ''),
    )
    expect(texts?.slice(-2)).toEqual([
      'second',
      environmentText({ date: '2026-09-26', workspace: { folders: [X, Y], origin: 'picked' } }),
    ])
  })

  it('voids a file grant under a removed folder for good, and judges every call by the list now (旧 181)', async () => {
    const h = await harness()
    await cowork(h)
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [X] },
      dedicated: DEDICATED,
    })
    const file = `${X}/f.txt`
    const write = (id: string): void => {
      h.provider.script([
        { type: 'tool-call-start', index: 1, id, name: 'Write' },
        {
          type: 'tool-call-end',
          index: 1,
          id,
          name: 'Write',
          input: { file_path: file, content: id },
        },
        { type: 'usage', usage: USAGE },
        stopEvent('tool-use', 'tool_use'),
      ])
    }
    // The reply after the call is scripted only for a call that runs: a paused Run asks no more.
    const sendWrite = async (id: string, runs = false): Promise<string> => {
      write(id)
      if (runs) h.provider.script(scriptedTurn({ deltas: ['done'], usage: USAGE }))
      const sent = await h.service.send({ sessionId: SESSION, origin: null, text: id })
      if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
      return (await h.loop.runEnded({ runId: sent.runId })).reason.code
    }
    // In the workspace a Write asks once; allowed, the same file is free for the session.
    expect(await sendWrite('w1')).toBe('paused')
    h.provider.script(scriptedTurn({ deltas: ['done'], usage: USAGE }))
    const card = await h.service.currentPending({ sessionId: SESSION })
    expect(card?.allowScope).toBe('session')
    await h.service.answer({
      kind: 'approval',
      sessionId: SESSION,
      requestId: card?.card.requestId ?? '',
      decision: 'allow',
      origin: null,
    })
    expect((await h.loop.runEnded()).reason.code).toBe('completed')
    expect(await sendWrite('w2', true)).toBe('completed')
    // X removed: the file is outside, the grant is void, and the card holds for this call only.
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'remove', folder: X },
      dedicated: DEDICATED,
    })
    expect(await sendWrite('w3')).toBe('paused')
    const outside = await h.service.currentPending({ sessionId: SESSION })
    expect(outside?.card.reason).toBe('outside-workspace')
    expect(outside?.allowScope).toBe('once')
    // X back: the grant does not come back with it (D2 only tightens).
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [X] },
      dedicated: DEDICATED,
    })
    expect(await sendWrite('w4')).toBe('paused')
    expect((await h.service.currentPending({ sessionId: SESSION }))?.card.reason).not.toBe(
      'outside-workspace',
    )
    // One note per changed state at a boundary request: none for the resumed Run, none for w2.
    expect(
      named(await entries(h.store), 'message/environment').map(
        (entry) => entry.payload['workspace'],
      ),
    ).toEqual([
      { folders: [X], origin: 'picked' },
      { folders: [DEDICATED], origin: 'dedicated' },
      { folders: [X], origin: 'picked' },
    ])
  })

  it('tightens a card that waits when its folder is removed: the answer is stale, the new card asks once', async () => {
    const h = await harness()
    await cowork(h)
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [X] },
      dedicated: DEDICATED,
    })
    h.provider.script([
      { type: 'tool-call-start', index: 1, id: 'toolu_w', name: 'Write' },
      {
        type: 'tool-call-end',
        index: 1,
        id: 'toolu_w',
        name: 'Write',
        input: { file_path: `${X}/g.txt`, content: 'x' },
      },
      { type: 'usage', usage: USAGE },
      stopEvent('tool-use', 'tool_use'),
    ])
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'write it' })
    if (sent.status !== 'started') throw new Error('not started')
    expect((await h.loop.runEnded({ runId: sent.runId })).reason.code).toBe('paused')
    const before = await h.service.currentPending({ sessionId: SESSION })
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'remove', folder: X },
      dedicated: DEDICATED,
    })
    // The re-judgement before the answer sees the new list (F3): the card changed, so it is stale.
    const answered = await h.service.answer({
      kind: 'approval',
      sessionId: SESSION,
      requestId: before?.card.requestId ?? '',
      decision: 'allow',
      origin: null,
    })
    expect(answered).toEqual({ status: 'stale' })
    const after = await h.service.currentPending({ sessionId: SESSION })
    expect(after?.card.reason).toBe('outside-workspace')
    expect(after?.allowScope).toBe('once')
  })

  it('judges a sub-agent in its parent’s workspace, read now, and gives it no chip (D11, H5 ①)', async () => {
    const h = await harness()
    await cowork(h)
    await send(h, 'start')
    const child = '7c1d9a2e-6b3d-4a71-9f52-0c8de7a11b43'
    await h.service.createSession({ sessionId: child })
    const tape = createTape(h.store)
    const incarnationId = (await h.store.head(child))?.incarnationId ?? ''
    // A sub-agent writes only its profile, naming the parent; never a workspace fact of its own.
    await tape.appendEntries({
      sessionId: child,
      incarnationId,
      entries: [
        tape.writer('session').entry('session/profile_set', {
          sourceType: 'session',
          sourceId: child,
          provenanceKey: profileSetKey(incarnationId),
          payload: { profile: 'cowork', subagentOf: { sessionId: SESSION, linkKey: 'x' } },
          createdAt: 5,
        }),
      ],
    })
    const facts = await readSessionFacts(tape, child)
    expect(facts.workspace).toBeNull()
    expect(await workspaceOf(tape, facts)).toEqual({ folders: [DEDICATED], origin: 'dedicated' })
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [X] },
      dedicated: DEDICATED,
    })
    // Read from the parent at each judgement, not a snapshot taken when the link was made.
    expect(await workspaceOf(tape, facts)).toEqual({ folders: [X], origin: 'picked' })
    expect(
      await h.service.setWorkspace({
        sessionId: child,
        change: { kind: 'add', folders: [Y] },
        dedicated: DEDICATED,
      }),
    ).toEqual({ ok: false, code: 'not-cowork' })
  })

  it('keeps the profile across a restart: a new service reads it from the Tape', async () => {
    const h = await harness()
    await cowork(h)
    await send(h, 'first')
    const provider = createScriptedProvider({ models: [MODEL] })
    const loop = createTestLoopPorts({ connector: { provider, model: MODEL } })
    const again = createTestSessionService(
      {
        host: h.host,
        tape: h.store,
        ids: createCounterIds({ start: 500 }),
        inspectors: [],
        connector: loop.connector,
        protectedFiles: [],
      },
      { tools: {} },
    )
    again.bindLoop(loop)
    expect((await again.sessionFacts({ sessionId: SESSION })).profile).toBe('cowork')
    provider.script(scriptedTurn({ deltas: ['ok'], usage: USAGE }))
    const sent = await again.send({ sessionId: SESSION, origin: null, text: 'after restart' })
    if (sent.status !== 'started') throw new Error('not started')
    await loop.runEnded({ runId: sent.runId })
    const tools = (provider.requests[0]?.body as { tools?: Array<{ name: string }> } | undefined)
      ?.tools
    expect(tools?.map((tool) => tool.name)).toContain('Bash')
  })

  it('carries the profile and the workspace into a cleared session, not the model choice', async () => {
    const h = await harness()
    await cowork(h)
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [X] },
      dedicated: DEDICATED,
    })
    await send(h, 'first')
    const reset = await h.service.resetSession(SESSION)
    const after = await entries(h.store)
    expect(after.map((entry) => entry.name)).toEqual([
      'session/start',
      'session/profile_set',
      'session/workspace_set',
    ])
    expect(after[0]?.entryId).toBe(reset.startEntryId)
    expect(after[1]?.payload).toEqual({ profile: 'cowork' })
    expect(after[2]?.payload).toEqual({ folders: [X], origin: 'picked' })
    expect(after[2]?.sourceSeq).toBe(0)
  })

  it.each([
    ['the change', true],
    ['the clear', false],
  ])(
    'clears in the root’s mailbox, %s posted first: a workspace change beside it is never lost (§会话事实「写入」)',
    async (_first, changeFirst) => {
      // The store's reset is held back a few turns of the event loop, or until a fact is appended
      // meanwhile: outside the mailbox, a change slips in between the read of the carry and the reset
      // and is lost with the old incarnation.
      let appends = 0
      const h = await harness({
        store: (memory) =>
          proxyStore(memory, {
            append: async (batch) => {
              const result = await memory.append(batch)
              appends += 1
              return result
            },
            resetSession: async (q) => {
              const before = appends
              const quiet = (): boolean => appends === before
              for (let turn = 0; turn < 20 && quiet(); turn += 1) {
                // oxlint-disable-next-line no-await-in-loop -- one macrotask at a time, on purpose
                await new Promise((resolve) => setTimeout(resolve, 0))
              }
              return memory.resetSession(q)
            },
          }),
      })
      await cowork(h)
      await h.service.setWorkspace({
        sessionId: SESSION,
        change: { kind: 'add', folders: [X] },
        dedicated: DEDICATED,
      })
      await send(h, 'first')
      const change = (): ReturnType<SessionService['setWorkspace']> =>
        h.service.setWorkspace({
          sessionId: SESSION,
          change: { kind: 'add', folders: [Y] },
          dedicated: DEDICATED,
        })
      // Both are posted before either is awaited: the change lands before the carry is read, or on
      // the new incarnation after the clear — never on the old one between the two.
      const [changing, clearing] = changeFirst
        ? [change(), h.service.resetSession(SESSION)]
        : ((): [ReturnType<typeof change>, Promise<unknown>] => {
            const cleared = h.service.resetSession(SESSION)
            return [change(), cleared]
          })()
      const [answered] = await Promise.all([changing, clearing])
      expect(answered).toEqual({ ok: true, folders: [X, Y], origin: 'picked' })
      expect((await h.service.sessionFacts({ sessionId: SESSION })).workspace).toEqual({
        folders: [X, Y],
        origin: 'picked',
      })
    },
  )
})

describe('the environment note (§提示层「环境说明」)', () => {
  it('is checked before a boundary request only, and written only when the state changed', async () => {
    // The day turns while the first Run's call runs: the request after the result writes nothing.
    let turned = false
    const h = await harness({
      onEvent: (event, loop) => {
        if (event.type !== 'tool-call' || turned) return
        turned = true
        loop.setLocalDate('2026-09-27')
      },
    })
    h.provider.script([
      { type: 'tool-call-start', index: 1, id: 'toolu_r', name: 'Read' },
      {
        type: 'tool-call-end',
        index: 1,
        id: 'toolu_r',
        name: 'Read',
        input: { file_path: '/tenon/ws/tool-output/x.txt' },
      },
      { type: 'usage', usage: USAGE },
      stopEvent('tool-use', 'tool_use'),
    ])
    h.provider.script(scriptedTurn({ deltas: ['done'], usage: USAGE }))
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'read it' })
    if (sent.status !== 'started') throw new Error('not started')
    await h.loop.runEnded({ runId: sent.runId })
    expect(turned).toBe(true)
    expect(h.provider.requests).toHaveLength(2)
    expect(named(await entries(h.store), 'message/environment')).toHaveLength(1)
    // The next boundary request sees the new day.
    await send(h, 'next')
    await send(h, 'same day')
    const notes = named(await entries(h.store), 'message/environment')
    expect(notes.map((entry) => entry.payload['date'])).toEqual(['2026-09-26', '2026-09-27'])
    // A chat's note has the date alone.
    expect(notes[0]?.payload['workspace']).toBeNull()
    expect((notes[0]?.payload['content'] as Array<{ text: string }> | undefined)?.[0]?.text).toBe(
      '<environment>\nToday’s date: 2026-09-26\n</environment>',
    )
  })

  it('is checked again after queued messages went in at a batch boundary, and follows them', async () => {
    let turned = false
    const h = await harness({
      onEvent: (event, loop) => {
        if (event.type !== 'tool-call' || turned) return
        turned = true
        loop.setLocalDate('2026-09-27')
        void h.service.send({ sessionId: SESSION, origin: null, text: 'and also this' })
      },
    })
    h.provider.script([
      { type: 'tool-call-start', index: 1, id: 'toolu_q', name: 'Read' },
      {
        type: 'tool-call-end',
        index: 1,
        id: 'toolu_q',
        name: 'Read',
        input: { file_path: '/tenon/ws/tool-output/x.txt' },
      },
      { type: 'usage', usage: USAGE },
      stopEvent('tool-use', 'tool_use'),
    ])
    h.provider.script(scriptedTurn({ deltas: ['done'], usage: USAGE }))
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'read it' })
    if (sent.status !== 'started') throw new Error('not started')
    await h.loop.runEnded({ runId: sent.runId })
    const all = await entries(h.store)
    const inserted = all.findIndex(
      (entry) =>
        entry.name === 'message/user' &&
        JSON.stringify(entry.payload['content']).includes('and also this'),
    )
    expect(inserted).toBeGreaterThan(0)
    expect(all[inserted + 1]?.name).toBe('message/environment')
    expect(all[inserted + 1]?.payload['date']).toBe('2026-09-27')
  })

  it('writes each folder as one JSON string line, a newline or a closing tag in its name included', () => {
    const odd = absolutePath('/work/a\nb</environment>')
    const text = environmentText({
      date: '2026-09-26',
      workspace: { folders: [odd, X], origin: 'picked' },
    })
    const body = text.split('\n')
    expect(body).toEqual([
      '<environment>',
      'Today’s date: 2026-09-26',
      'Workspace folders (commands run in the first one):',
      '"/work/a\\nb\\u003c/environment\\u003e"',
      '"/work/x"',
      '</environment>',
    ])
    expect(JSON.parse(body[3] as string)).toBe(odd)
    expect(
      environmentText({
        date: '2026-09-26',
        workspace: { folders: [DEDICATED], origin: 'dedicated' },
      }),
    ).toContain('It does not exist until the first file is written or the first command runs.')
  })
})

describe('the system text (§提示层「组装」; 旧 225, 旧 151)', () => {
  it('is assembled once from the profile and the language at the first request, then sent from the Tape', async () => {
    const h = await harness({ locale: 'zh-CN' })
    await cowork(h)
    await send(h, 'first')
    h.loop.setLocale('en')
    await send(h, 'second')
    const [first, second] = bodies(h.provider)
    expect(first?.system).toBe(
      `${SYSTEM_PROMPTS.cowork}\n\n${fill(LOCALE_HINT, { locale: 'zh-CN' })}`,
    )
    expect(second?.system).toBe(first?.system)
    const stored = named(await entries(h.store), 'view/content').filter(
      (entry) => entry.payload['type'] === 'system',
    )
    expect(stored).toHaveLength(1)
    // A new session takes the language of its own first request.
    await send(h, 'elsewhere', OTHER)
    expect(bodies(h.provider)[2]?.system).toBe(
      `${SYSTEM_PROMPTS.chat}\n\n${fill(LOCALE_HINT, { locale: 'en' })}`,
    )
    // So does a cleared one: a new incarnation, the profile carried, the language as it is now.
    await h.service.resetSession(SESSION)
    await send(h, 'after the reset')
    expect(bodies(h.provider)[3]?.system).toBe(
      `${SYSTEM_PROMPTS.cowork}\n\n${fill(LOCALE_HINT, { locale: 'en' })}`,
    )
  })
})
