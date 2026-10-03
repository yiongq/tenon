/**
 * A custom vendor instance at run time (M6 §运行时, §注册表视图; plan step 7), driven end to end: the
 * session service and its mailbox, the desktop's Run connector and registry view, the provider,
 * custom vendor and model routes, the kernel's real loop and tools, and `fakeNetwork` for the
 * endpoints. What is asserted is what reaches the wire and the Tape: whether a request carries tools,
 * `session/model_selected`'s `capabilitySource`, `view/tools_withheld`, the tool table, and the
 * failure a send or a resume ends with.
 *
 * The keychain is a fake whose read of one key can be held, which is how a key save lands inside an
 * assembly's read; nothing touches the OS keychain or a real profile directory, and no request leaves
 * the process.
 */
import { randomUUID } from 'node:crypto'
import {
  ANTHROPIC_PROVIDER_ID,
  createMemoryHost,
  createMemoryTapeStore,
  createProviderRegistry,
  createSessionService,
  keyFor,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type {
  AbsolutePath,
  CapabilitySource,
  HostAdapter,
  HostSecrets,
  RunConnector,
  SessionService,
  TapeEntry,
  TapeStore,
} from '@tenon-app/kernel'
import { createCounterIds, createTestLoopPorts, fakeNetwork } from '@tenon-app/kernel/testing'
import type {
  FakeExchange,
  FakeNetwork,
  RecordedRequest,
  TestLoopPorts,
} from '@tenon-app/kernel/testing'
import type { Config, CustomVendorContract, IpcMainLike, IpcResult } from '@tenon-app/contracts'
import { describe, expect, it } from 'vitest'
import {
  BAILIAN_THROTTLED,
  DEEPSEEK_WRONG_KEY,
  KIMI_BALANCE_EXHAUSTED,
} from '../../../packages/kernel/test/provider/fixtures/probe-documented.js'
import { createProviderView } from '../src/main/custom-vendors/registry.js'
import { createProbeRuns, registerCustomVendorRoutes } from '../src/main/custom-vendors/routes.js'
import { configPath, readConfig, writeConfig } from '../src/main/host/profile.js'
import { registerModelRoutes } from '../src/main/model-routes.js'
import { registerProviderRoutes } from '../src/main/provider-routes.js'
import { createRunConnector } from '../src/main/run-assembly.js'

const ID = 'custom-2d7c4a1e-5b6f-4c8d-9e0f-1a2b3c4d5e6f'
const RELAY_ID = 'custom-5a0f7d4b-8e9c-4f1a-ab3c-4d5e6f7a8b92'
const LOCAL_ID = 'custom-3e8d5b2f-6c7a-4d9e-8f1a-2b3c4d5e6f70'
const PRIVATE_ID = 'custom-4f9e6c3a-7d8b-4e0f-9a2b-3c4d5e6f7a81'
const SESSION = '6d2e0b3f-7c4a-4b82-9a63-1d9ef8b22c02'
const OTHER_SESSION = '7e3f1c4a-8d5b-4c93-8b74-2e0fa9c33d13'
const NEW_SESSION = '8f4a2d5b-9e6c-4da4-9c85-3f1ab0d44e24'
const KEY = 'sk-m6-runtime-test-5e2a91'
const NEW_KEY = 'sk-m6-runtime-new-8c3f07'
const ANTHROPIC_KEY = 'anthropic-runtime-test-key-not-real'
const BASE = 'https://vendor.test/v1'
const COMPLETIONS = `${BASE}/chat/completions`

const PASSED = {
  outcome: 'passed' as const,
  reason: null,
  probedAt: 1,
  reasoningField: null,
  maxTokensField: 'max_tokens' as const,
  usageSeen: true,
  responseModelId: null,
  unknownFields: [],
}
/** A row whose probe passed: the factory gives it tools (M6 不变量 6). */
const TOOL_ROW = {
  id: 'vendor-model',
  contextLimit: 128_000,
  maxOutputTokens: 8_000,
  probe: PASSED,
}
/** A row never probed: text only. */
const TEXT_ROW = { id: 'vendor-text', contextLimit: 64_000, maxOutputTokens: 4_000 }

function instance(
  over: Partial<CustomVendorContract> & Pick<CustomVendorContract, 'id'>,
): CustomVendorContract {
  return {
    displayName: 'Vendor',
    wire: 'openai-chat',
    baseURL: BASE,
    models: [TOOL_ROW, TEXT_ROW],
    ...over,
  }
}

/** A keyless loopback instance whose row carries a passing snapshot written into the file by hand. */
const LOCAL = instance({
  id: LOCAL_ID,
  displayName: 'Local',
  baseURL: 'http://127.0.0.1:11434/v1',
  models: [TOOL_ROW],
})

/** The same on a private network (Q7): no key stored, no tools sent. */
const PRIVATE = instance({
  id: PRIVATE_ID,
  displayName: 'Private',
  baseURL: 'http://192.168.1.20:8000/v1',
  models: [TOOL_ROW],
})

/** The instances the harness stores no key for (§key). */
const KEYLESS: ReadonlySet<string> = new Set([LOCAL_ID, PRIVATE_ID])

// ----- the endpoints ---------------------------------------------------------------------------

const frame = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`
const chunk = (delta: unknown, finish: string | null = null): string =>
  frame({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: TOOL_ROW.id,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
const USAGE = frame({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: TOOL_ROW.id,
  choices: [],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
})
const DONE = 'data: [DONE]\n\n'

/** An openai-chat reply of one sentence. */
function answer(text = 'Done.'): FakeExchange {
  return {
    kind: 'sse',
    frames: [chunk({ role: 'assistant', content: text }), chunk({}, 'stop'), USAGE, DONE],
  }
}

/** An openai-chat reply whose one tool call is `name` with `args`. */
function callOf(name: string, args: unknown): FakeExchange {
  return {
    kind: 'sse',
    frames: [
      chunk({ role: 'assistant', content: '' }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call_${name}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
      USAGE,
      DONE,
    ],
  }
}

const QUESTION = 'Go ahead?'
/** An openai-chat reply that asks the user a question: the Run pauses on it (AskUserQuestion). */
const ASK = callOf('AskUserQuestion', {
  questions: [
    {
      question: QUESTION,
      header: 'Confirm',
      multiSelect: false,
      options: [
        { label: 'Yes', description: 'Carry on' },
        { label: 'No', description: 'Stop here' },
      ],
    },
  ],
})

/** An anthropic-messages reply of one sentence. */
const ANTHROPIC_ANSWER: FakeExchange = {
  kind: 'sse',
  frames: [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: TOOL_ROW.id,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1 },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Done.' },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ].map(([event, data]) => `event: ${String(event)}\ndata: ${JSON.stringify(data)}\n\n`),
}

/** A 429 whose body names the account's condition by an OpenAI-style error code, as zhipu's does. */
function throttled(code: string, message: string): FakeExchange {
  return { kind: 'json', status: 429, body: { error: { code, message, type: code, param: null } } }
}

// ----- the harness -----------------------------------------------------------------------------

/** A keychain whose next read of one key can be held, then let through to what is stored by then. */
class Keychain implements HostSecrets {
  readonly values = new Map<string, string>()
  #hold: { key: string; reached: () => void; gate: Promise<void> } | null = null

  async get(key: string): Promise<string | null> {
    const hold = this.#hold
    if (hold !== null && hold.key === key) {
      this.#hold = null
      hold.reached()
      await hold.gate
    }
    return this.values.get(key) ?? null
  }

  holdNextGet(key: string): { held: Promise<void>; release: () => void } {
    const reached = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    this.#hold = { key, reached: reached.resolve, gate: gate.promise }
    return { held: reached.promise, release: gate.resolve }
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }
}

interface Harness {
  readonly host: HostAdapter
  readonly keychain: Keychain
  readonly network: FakeNetwork
  readonly tape: TapeStore
  readonly sessions: SessionService
  readonly loop: TestLoopPorts
  readonly connector: RunConnector
  /** The route's data; fails the test unless the call went through its schemas. */
  ok<T = unknown>(channel: string, payload: unknown): Promise<T>
  keyOf(id: string): string
  /** Moves the host clock, which a resend's backoff waits on. */
  advance(ms: number): void
}

let profiles = 0

/** Nothing here reads the main process's log lines. */
function log(): void {}

/** A profile whose `config.json` holds `vendors` (and `rest`), with the public ones' key stored. */
async function harness(
  vendors: readonly CustomVendorContract[],
  script: readonly FakeExchange[],
  rest: Partial<Config> = {},
): Promise<Harness> {
  profiles += 1
  const network = fakeNetwork(script)
  const memory = createMemoryHost({
    identity: { profileDir: `/profiles/user/vendor-runtime-${profiles}` },
    network,
  })
  await memory.fs.mkdirp(memory.identity.profileDir as AbsolutePath)
  await memory.fs.writeFile(
    configPath(memory.identity),
    JSON.stringify({ ...rest, customVendors: vendors }),
  )
  const keychain = new Keychain()
  const host: HostAdapter = { ...memory, secrets: keychain }
  const keyOf = (id: string): string => keyFor(host.identity, 'provider', id, 'apiKey')
  for (const entry of vendors) {
    if (!KEYLESS.has(entry.id)) keychain.values.set(keyOf(entry.id), KEY)
  }
  const builtin = createProviderRegistry()
  registerBuiltinProviders(builtin)
  const providers = createProviderView({
    builtin,
    identity: host.identity,
    config: await readConfig(host.fs, host.identity, log),
  })
  // A packaged build: no development variable reaches the connector.
  const connector = createRunConnector({ host, providers, isPackaged: true, env: {}, log })
  const tape = createMemoryTapeStore({ identity: host.identity })
  const sessions = createSessionService({
    host,
    tape,
    ids: createCounterIds(),
    inspectors: [],
    connector,
    protectedFiles: [],
    log,
  })
  const loop = createTestLoopPorts({})
  sessions.bindLoop(loop)
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener as (event: unknown, payload: unknown) => unknown)
    },
  }
  const probes = createProbeRuns()
  registerProviderRoutes({ ipcMain, host, providers, isPackaged: true, env: {}, log, probes })
  registerCustomVendorRoutes({
    ipcMain,
    host,
    providers,
    probes,
    uuid: () => randomUUID(),
    isPackaged: true,
    env: {},
    log,
  })
  registerModelRoutes({ ipcMain, sessions, providers, host })
  const ok = async <T>(channel: string, payload: unknown): Promise<T> => {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error(`${channel} is not registered`)
    const result = (await handler({}, payload)) as IpcResult<unknown>
    if (!result.ok) throw new Error(`${channel}: ${JSON.stringify(result.error)}`)
    return result.data as T
  }
  const advance = (ms: number): void => memory.advance(ms)
  return { host, keychain, network, tape, sessions, loop, connector, ok, keyOf, advance }
}

/** The session's choice of an instance's row, as the model menu makes it. */
async function choose(
  h: Harness,
  modelId: string,
  o: { providerId?: string; sessionId?: string } = {},
): Promise<void> {
  expect(
    await h.ok('session.selectModel', {
      sessionId: o.sessionId ?? SESSION,
      providerId: o.providerId ?? ID,
      modelId,
      effort: null,
    }),
  ).toEqual({ ok: true })
}

type RunEnd = Awaited<ReturnType<TestLoopPorts['runEnded']>>

/** A message that starts a Run, and how the Run ended. */
async function send(h: Harness, text: string, sessionId = SESSION): Promise<RunEnd> {
  const sent = await h.sessions.send({ sessionId, origin: null, text })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  return h.loop.runEnded({ runId: sent.runId })
}

async function entries(h: Harness, sessionId = SESSION): Promise<TapeEntry[]> {
  return [...(await h.tape.readRange({ sessionId, limit: 1000 })).entries]
}

async function payloads(
  h: Harness,
  name: string,
  sessionId = SESSION,
): Promise<Record<string, unknown>[]> {
  return (await entries(h, sessionId))
    .filter((entry) => entry.name === name)
    .map((entry) => entry.payload)
}

/** The model requests sent so far, as JSON bodies. */
function bodies(h: Harness): Record<string, unknown>[] {
  return h.network.requests.map((request) => request.body as Record<string, unknown>)
}

/** The tool names a model request offered, or null when it carried none. */
function toolNames(body: Record<string, unknown> | undefined): string[] | null {
  const tools = body?.['tools'] as { function?: { name?: string }; name?: string }[] | undefined
  if (tools === undefined) return null
  return tools.map((tool) => tool.function?.name ?? tool.name ?? '').toSorted()
}

/** The ModelInfo each Run froze on the Tape (`view/content` of type `model_info`). */
async function frozenModels(h: Harness, sessionId = SESSION): Promise<unknown[]> {
  return (await payloads(h, 'view/content', sessionId))
    .filter((content) => content['type'] === 'model_info')
    .map((content) => content['model'])
}

/**
 * An instance's address or wire edited by hand in config.json (§存储): written in place, so no write
 * is heard and the view keeps the old until the app's next write.
 */
async function editByHand(
  h: Harness,
  id: string,
  change: Partial<Pick<CustomVendorContract, 'baseURL' | 'wire'>>,
): Promise<void> {
  const path = configPath(h.host.identity)
  const config = JSON.parse(String(await h.host.fs.readFile(path, { encoding: 'utf8' }))) as {
    customVendors: CustomVendorContract[]
  }
  config.customVendors = config.customVendors.map((entry) =>
    entry.id === id ? { ...entry, ...change } : entry,
  )
  await h.host.fs.writeFile(path, JSON.stringify(config))
}

async function modelChoice(h: Harness, sessionId = SESSION): Promise<string> {
  const choice = await h.ok<{ capabilitySource: string }>('session.modelChoice', { sessionId })
  return choice.capabilitySource
}

/** The paused Run's question, answered: the Run resumes. */
async function answerQuestion(h: Harness): Promise<void> {
  const pending = await h.sessions.currentPending({ sessionId: SESSION })
  if (pending?.waitKind !== 'question') throw new Error('no question is waiting')
  expect(
    await h.sessions.answer({
      kind: 'question',
      sessionId: SESSION,
      requestId: pending.requestId,
      answers: { [QUESTION]: ['Yes'] },
      origin: null,
    }),
  ).toEqual({ status: 'applied' })
}

/** What the Run connector assembles for `providerId`'s TOOL_ROW, the choice carrying `source`. */
function assembleRow(
  h: Harness,
  providerId: string,
  source: CapabilitySource,
): ReturnType<RunConnector['assemble']> {
  return h.connector.assemble({
    sessionId: SESSION,
    rootSessionId: SESSION,
    choice: { providerId, modelId: TOOL_ROW.id, effort: null, capabilitySource: source },
    signal: new AbortController().signal,
  })
}

/** `pending`'s outcome, the host clock moved a second at a time meanwhile: a resend's backoff waits on it. */
async function whileAdvancing<T>(h: Harness, pending: Promise<T>): Promise<T> {
  const tick = Symbol('tick')
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one tick of the clock after another, as time passes
    const settled = await Promise.race([
      pending,
      new Promise<typeof tick>((resolve) => setTimeout(() => resolve(tick), 0)),
    ])
    if (settled !== tick) return settled as T
    h.advance(1000)
  }
}

const CHAT_TOOLS = ['AskUserQuestion', 'Read', 'WebFetch']
const COWORK_TOOLS = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'Read',
  'WebFetch',
  'Write',
]

// ----- the tests -------------------------------------------------------------------------------

describe('a row’s tools and capabilitySource come from its probe (M6 §运行时「行标记」「不发工具」)', () => {
  it('验收 19, M6 不变量 6: a passing row is probed and sends its tools; a row with no passing snapshot is user, sends none and records not-probed once', async () => {
    const h = await harness([instance({ id: ID })], [answer(), answer(), answer()])
    await choose(h, TOOL_ROW.id)
    expect(await modelChoice(h)).toBe('probed')
    expect((await send(h, 'hello')).reason.code).toBe('completed')
    expect(toolNames(bodies(h)[0])).toEqual(CHAT_TOOLS)
    // §注册表视图: the row's own output limit, below phase 0's cap in this packaged build.
    expect(bodies(h)[0]?.['max_tokens']).toBe(TOOL_ROW.maxOutputTokens)
    expect(await payloads(h, 'session/model_selected')).toEqual([
      {
        providerId: ID,
        modelId: TOOL_ROW.id,
        capabilitySource: 'probed',
        endpointOrigin: 'https://vendor.test',
      },
    ])
    expect(await payloads(h, 'view/tools_withheld')).toEqual([])

    await choose(h, TEXT_ROW.id, { sessionId: OTHER_SESSION })
    expect(await modelChoice(h, OTHER_SESSION)).toBe('user')
    expect((await send(h, 'hello', OTHER_SESSION)).reason.code).toBe('completed')
    expect((await send(h, 'again', OTHER_SESSION)).reason.code).toBe('completed')
    expect(h.network.requests.map((request) => request.url)).toEqual([
      COMPLETIONS,
      COMPLETIONS,
      COMPLETIONS,
    ])
    expect(toolNames(bodies(h)[1])).toBeNull()
    expect(toolNames(bodies(h)[2])).toBeNull()
    expect(
      (await payloads(h, 'session/model_selected', OTHER_SESSION)).map(
        (selected) => selected['capabilitySource'],
      ),
    ).toEqual(['user', 'user'])
    // The table is still opened and frozen; only the first request that carried none says so (T9).
    expect(await payloads(h, 'view/tools_withheld', OTHER_SESSION)).toEqual([
      expect.objectContaining({ providerId: ID, modelId: TEXT_ROW.id, reason: 'not-probed' }),
    ])
    expect(await payloads(h, 'view/tool_table', OTHER_SESSION)).toHaveLength(1)
  })

  it('验收 19: in 任务形态 a passing row sends the task table and its call waits on approval as usual; a row with no passing snapshot sends none', async () => {
    const dedicated = '/home/u/Tenon/workspaces/vendor' as AbsolutePath
    const note = `${dedicated}/note.txt` as AbsolutePath
    const write = callOf('Write', { file_path: note, content: 'from the instance' })
    const h = await harness([instance({ id: ID })], [write, answer(), answer()])
    await h.sessions.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated })
    await choose(h, TOOL_ROW.id)
    expect(await modelChoice(h)).toBe('probed')
    expect((await send(h, 'write a note')).reason).toEqual({
      code: 'paused',
      waitingFor: 'approval',
    })
    expect(toolNames(bodies(h)[0])).toEqual(COWORK_TOOLS)

    // The approval card is 02's, unchanged for an instance: allowing it resumes the Run.
    const pending = await h.sessions.currentPending({ sessionId: SESSION })
    if (pending?.waitKind !== 'approval') throw new Error('no approval is waiting')
    expect(
      await h.sessions.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: pending.card.requestId,
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason.code).toBe('completed')
    expect(String(await h.host.fs.readFile(note, { encoding: 'utf8' }))).toBe('from the instance')
    expect(toolNames(bodies(h)[1])).toEqual(COWORK_TOOLS)
    expect(
      (await payloads(h, 'session/model_selected')).map((selected) => selected['capabilitySource']),
    ).toEqual(['probed', 'probed'])
    expect(await payloads(h, 'view/tools_withheld')).toEqual([])

    await h.sessions.selectProfile({
      sessionId: OTHER_SESSION,
      profile: 'cowork',
      dedicated: '/home/u/Tenon/workspaces/text' as AbsolutePath,
    })
    await choose(h, TEXT_ROW.id, { sessionId: OTHER_SESSION })
    expect((await send(h, 'hello', OTHER_SESSION)).reason.code).toBe('completed')
    expect(toolNames(bodies(h)[2])).toBeNull()
    expect(await payloads(h, 'session/model_selected', OTHER_SESSION)).toEqual([
      expect.objectContaining({ providerId: ID, modelId: TEXT_ROW.id, capabilitySource: 'user' }),
    ])
    expect(await payloads(h, 'view/tools_withheld', OTHER_SESSION)).toEqual([
      expect.objectContaining({ providerId: ID, modelId: TEXT_ROW.id, reason: 'not-probed' }),
    ])
  })

  // On zhipu's own hosts too, where the host alone would pick zhipu's search backend: what keeps it
  // off an instance is that it is not the builtin (M6 §搜索, Q10).
  it.each([
    ['openai-chat', 'https://vendor.test/v1', '/chat/completions', answer()],
    ['openai-chat', 'https://open.bigmodel.cn/api/paas/v4', '/chat/completions', answer()],
    [
      'anthropic-messages',
      'https://open.bigmodel.cn/api/anthropic',
      '/v1/messages',
      ANTHROPIC_ANSWER,
    ],
  ] as const)(
    'M6 不变量 15, 验收 21: an %s instance at %s has WebFetch and no WebSearch, excluded as no-search-backend',
    async (wire, baseURL, path, reply) => {
      const h = await harness([instance({ id: ID, wire, baseURL })], [reply])
      await choose(h, TOOL_ROW.id)
      expect((await send(h, 'hello')).reason.code).toBe('completed')
      expect(h.network.requests.map((request) => request.url)).toEqual([`${baseURL}${path}`])
      const [table] = await payloads(h, 'view/tool_table')
      const tools = (table?.['tools'] as { name: string }[] | undefined)?.map((tool) => tool.name)
      expect(tools).toContain('WebFetch')
      expect(tools).not.toContain('WebSearch')
      expect(table?.['excluded']).toEqual([
        expect.objectContaining({ originalName: 'WebSearch', code: 'no-search-backend' }),
      ])
      // No search target either: the instance's key never reaches a search backend.
      expect(h.connector.searchTarget?.(ID, 'q')).toBeNull()
    },
  )

  // The twin on api.anthropic.com: a row named like one the Anthropic search backend picks still
  // gets none, because the instance is not the builtin anthropic (M6 §搜索, Q10).
  it('M6 不变量 15, 验收 21: an anthropic-messages instance at https://api.anthropic.com listing claude-sonnet-5 has no WebSearch', async () => {
    const row = { ...TOOL_ROW, id: 'claude-sonnet-5' }
    const h = await harness(
      [
        instance({
          id: ID,
          wire: 'anthropic-messages',
          baseURL: 'https://api.anthropic.com',
          models: [row],
        }),
      ],
      [ANTHROPIC_ANSWER],
    )
    await choose(h, row.id)
    expect((await send(h, 'hello')).reason.code).toBe('completed')
    expect(h.network.requests.map((request) => request.url)).toEqual([
      'https://api.anthropic.com/v1/messages',
    ])
    const [table] = await payloads(h, 'view/tool_table')
    const tools = (table?.['tools'] as { name: string }[] | undefined)?.map((tool) => tool.name)
    expect(tools).toContain('WebFetch')
    expect(tools).not.toContain('WebSearch')
    expect(table?.['excluded']).toEqual([
      expect.objectContaining({ originalName: 'WebSearch', code: 'no-search-backend' }),
    ])
    expect(h.connector.searchTarget?.(ID, 'q')).toBeNull()
  })

  it.each([
    ['loopback', LOCAL],
    ['private', PRIVATE],
  ] as const)(
    'M6 不变量 7, 验收 18: a %s instance sends no tools in either profile, even off a passing snapshot written by hand, and is never probed',
    async (_reach, local) => {
      const h = await harness([local], [answer(), answer()])
      await choose(h, TOOL_ROW.id, { providerId: local.id })
      expect(await modelChoice(h)).toBe('user')
      expect((await send(h, 'hello')).reason.code).toBe('completed')
      await h.sessions.selectProfile({
        sessionId: OTHER_SESSION,
        profile: 'cowork',
        dedicated: '/home/u/Tenon/workspaces/local' as AbsolutePath,
      })
      await choose(h, TOOL_ROW.id, { providerId: local.id, sessionId: OTHER_SESSION })
      expect((await send(h, 'hello', OTHER_SESSION)).reason.code).toBe('completed')
      const completions = `${local.baseURL}/chat/completions`
      expect(h.network.requests.map((request) => request.url)).toEqual([completions, completions])
      expect(bodies(h).map(toolNames)).toEqual([null, null])
      for (const sessionId of [SESSION, OTHER_SESSION]) {
        // oxlint-disable-next-line no-await-in-loop -- one session at a time keeps a failure readable
        expect(await payloads(h, 'view/tools_withheld', sessionId)).toEqual([
          expect.objectContaining({ providerId: local.id, reason: 'provider-text-only' }),
        ])
        // oxlint-disable-next-line no-await-in-loop -- as above
        expect(await payloads(h, 'session/model_selected', sessionId)).toEqual([
          expect.objectContaining({
            capabilitySource: 'user',
            endpointOrigin: new URL(local.baseURL).origin,
          }),
        ])
      }
      expect(await h.ok('customVendor.probe', { id: local.id, modelId: TOOL_ROW.id })).toEqual({
        status: 'refused',
        code: 'local-endpoint',
      })
      expect(h.network.callCount).toBe(2)
    },
  )

  it('M6 不变量 11: an instance’s requests carry no thinking, no level and no header outside the wire’s own', async () => {
    const relay = instance({
      id: RELAY_ID,
      displayName: 'Relay',
      wire: 'anthropic-messages',
      baseURL: 'https://relay.test/anthropic',
      models: [TOOL_ROW],
    })
    const h = await harness([instance({ id: ID }), relay], [answer(), ANTHROPIC_ANSWER])
    await choose(h, TOOL_ROW.id)
    await send(h, 'hello')
    await choose(h, TOOL_ROW.id, { providerId: RELAY_ID, sessionId: OTHER_SESSION })
    expect((await send(h, 'hello', OTHER_SESSION)).reason.code).toBe('completed')
    const [openAI, anthropic] = h.network.requests
    expect(openAI?.url).toBe(COMPLETIONS)
    expect(anthropic?.url).toBe('https://relay.test/anthropic/v1/messages')
    // The row lists no thinking shape and the menu offers it no level (T5): neither wire's
    // thinking or level field is written, and no request parameter of the row's own (Q9).
    const fields = ['thinking', 'reasoning_effort', 'output_config', 'extra_body']
    for (const request of [openAI, anthropic]) {
      const body = request?.body as Record<string, unknown>
      for (const field of fields) expect(body).not.toHaveProperty(field)
    }
    expect(Object.keys(openAI?.body as object).toSorted()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'stream',
      'stream_options',
      'tools',
    ])
    expect(Object.keys(anthropic?.body as object).toSorted()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'stream',
      'system',
      'tools',
    ])
    // A6's lists (openai-chat.ts, anthropic-messages.ts `ALLOWED_HEADERS`): the protocol headers, the
    // instance's credential and the SDK's own `x-stainless-*`.
    expect(unlistedHeaders(openAI, ['authorization'])).toEqual([])
    expect(unlistedHeaders(anthropic, ['x-api-key', 'anthropic-version'])).toEqual([])
    expect(openAI?.headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(anthropic?.headers['x-api-key']).toBe(KEY)
    expect(anthropic?.headers).not.toHaveProperty('authorization')
  })

  it('验收 23: an instance caps a request at 128 tools, by its definition', async () => {
    const h = await harness([instance({ id: ID })], [])
    expect(h.connector.toolsPerRequest?.(ID)).toBe(128)
    expect(await h.ok('customVendor.delete', { id: ID })).toEqual({ ok: true })
    expect(h.connector.toolsPerRequest?.(ID)).toBeNull()
  })
})

describe('a key save and the row assemble sends (M6 §注册表视图; 推出的读法 32, 44)', () => {
  it('M6 不变量 18: a Run paused on a passing row resumes after a key save with the frozen row’s tools; the next message sends none', async () => {
    const h = await harness([instance({ id: ID })], [ASK, answer(), answer()])
    await choose(h, TOOL_ROW.id)
    expect((await send(h, 'ask me')).reason).toEqual({ code: 'paused', waitingFor: 'question' })
    expect(toolNames(bodies(h)[0])).toEqual(CHAT_TOOLS)

    // The settings card saves a new key: every snapshot of the instance is cleared (T3).
    expect(await h.ok('provider.configure', { id: ID, values: { apiKey: NEW_KEY } })).toEqual({
      ok: true,
    })
    expect((await readConfig(h.host.fs, h.host.identity)).customVendors[0]?.models[0]).toEqual({
      id: TOOL_ROW.id,
      contextLimit: TOOL_ROW.contextLimit,
      maxOutputTokens: TOOL_ROW.maxOutputTokens,
    })
    expect(await modelChoice(h)).toBe('user')
    // What a resume's or a reopened table's assembly answers for the frozen `probed` (§行标记): a
    // subagent child's `session/model_selected` is written from it (mailbox.ts dispatchChild).
    expect(await assembleRow(h, ID, 'probed')).toMatchObject({
      capabilitySource: 'probed',
      toolsWithheld: null,
    })

    // The resume keeps the frozen row and its `probed`: the tools go out again, under the new key.
    await answerQuestion(h)
    expect((await h.loop.runEnded()).reason.code).toBe('completed')
    expect(toolNames(bodies(h)[1])).toEqual(CHAT_TOOLS)
    expect(h.network.requests[1]?.headers['authorization']).toBe(`Bearer ${NEW_KEY}`)
    expect(await payloads(h, 'view/tools_withheld')).toEqual([])

    // The next message is a new round: the row as it stands now, text only.
    expect((await send(h, 'again')).reason.code).toBe('completed')
    expect(toolNames(bodies(h)[2])).toBeNull()
    // The Run, its resume (its entry copied from the Tape's frozen one), the new round.
    expect(
      (await payloads(h, 'session/model_selected')).map((selected) => selected['capabilitySource']),
    ).toEqual(['probed', 'probed', 'user'])
    expect(await payloads(h, 'view/tools_withheld')).toEqual([
      expect.objectContaining({ providerId: ID, modelId: TOOL_ROW.id, reason: 'not-probed' }),
    ])
  })

  it('a key save landing inside the assembly’s read: the new key’s request carries no tools and records not-probed', async () => {
    const h = await harness([instance({ id: ID })], [answer()])
    await choose(h, TOOL_ROW.id)
    // The prebuild has read config.json — the row still passed — and waits on the keychain.
    const prompt = h.keychain.holdNextGet(h.keyOf(ID))
    const sending = h.sessions.send({ sessionId: SESSION, origin: null, text: 'hello' })
    await prompt.held
    expect(await h.ok('provider.configure', { id: ID, values: { apiKey: NEW_KEY } })).toEqual({
      ok: true,
    })
    prompt.release()
    const sent = await sending
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    expect((await h.loop.runEnded({ runId: sent.runId })).reason.code).toBe('completed')
    expect(h.network.requests).toHaveLength(1)
    expect(h.network.requests[0]?.headers['authorization']).toBe(`Bearer ${NEW_KEY}`)
    expect(toolNames(bodies(h)[0])).toBeNull()
    expect(await payloads(h, 'session/model_selected')).toEqual([
      expect.objectContaining({ providerId: ID, capabilitySource: 'user' }),
    ])
    expect(await payloads(h, 'view/tools_withheld')).toEqual([
      expect.objectContaining({ providerId: ID, reason: 'not-probed' }),
    ])
    // The frozen row is the one the request was encoded against: the cleared one, text only.
    expect(await frozenModels(h)).toEqual([
      expect.objectContaining({ id: TOOL_ROW.id, supportsToolCalling: false }),
    ])
  })

  it('a probe’s save landing inside the assembly’s read: the request carries the passing row’s tools and records probed', async () => {
    const h = await harness([instance({ id: ID })], [answer()])
    await choose(h, TEXT_ROW.id)
    // The prebuild has read config.json — the row had no snapshot — and waits on the keychain.
    const prompt = h.keychain.holdNextGet(h.keyOf(ID))
    const sending = h.sessions.send({ sessionId: SESSION, origin: null, text: 'hello' })
    await prompt.held
    // What the probe route saves for a row that passed (§探测).
    await writeConfig(h.host.fs, h.host.identity, {
      customVendors: [instance({ id: ID, models: [TOOL_ROW, { ...TEXT_ROW, probe: PASSED }] })],
    })
    prompt.release()
    const sent = await sending
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    expect((await h.loop.runEnded({ runId: sent.runId })).reason.code).toBe('completed')
    expect(toolNames(bodies(h)[0])).toEqual(CHAT_TOOLS)
    expect(
      (await payloads(h, 'session/model_selected')).map((selected) => selected['capabilitySource']),
    ).toEqual(['probed'])
    expect(await payloads(h, 'view/tools_withheld')).toEqual([])
    expect(await frozenModels(h)).toEqual([
      expect.objectContaining({ id: TEXT_ROW.id, supportsToolCalling: true }),
    ])
  })
})

describe('an instance deleted or broken under a session (§实例被删或改坏, T12; 验收 25)', () => {
  const removals = [
    ['the instance is deleted', (h: Harness) => h.ok('customVendor.delete', { id: ID })],
    [
      'its row is removed',
      (h: Harness) =>
        h.ok('customVendor.update', {
          id: ID,
          models: [{ id: TEXT_ROW.id, contextLimit: 64_000, maxOutputTokens: 4_000 }],
        }),
    ],
    // A public instance: a loopback or private one needs no key (§key), so clearing it breaks nothing.
    [
      'its key is cleared',
      (h: Harness) => h.ok('provider.configure', { id: ID, values: { apiKey: '' } }),
    ],
  ] as const

  it.each(removals)(
    'when %s, a new message is not sent and writes nothing: no conservative row, and assemble resolves',
    async (_removal, remove) => {
      const h = await harness([instance({ id: ID })], [answer()])
      await choose(h, TOOL_ROW.id)
      expect((await send(h, 'hello')).reason.code).toBe('completed')
      expect(await remove(h)).toEqual({ ok: true })
      // plan step 7 读法 (2): a row that is gone answers as one with no passing probe; a cleared key
      // cleared the snapshot with it (T3).
      expect(await modelChoice(h)).toBe('user')
      const before = await entries(h)

      expect(await h.sessions.send({ sessionId: SESSION, origin: null, text: 'again' })).toEqual({
        status: 'not-sent',
        code: 'config-missing',
      })
      expect((await h.loop.runEnded()).reason).toEqual({
        code: 'provider-error',
        providerId: ID,
        errorCode: 'auth',
        providerReason: null,
        attempts: 0,
      })
      expect(await entries(h)).toEqual(before)
      expect(h.network.callCount).toBe(1)
      // ① still names the instance's row: the session keeps it, it does not fall back (T12).
      expect(await h.sessions.effectiveModelChoice({ sessionId: SESSION })).toMatchObject({
        providerId: ID,
        modelId: TOOL_ROW.id,
      })

      const assembly = await assembleRow(h, ID, 'builtin')
      expect(assembly.model).toMatchObject({ id: TOOL_ROW.id, supportsToolCalling: false })
      // plan step 7 读法 (1): gone from the view or only from the read, the same answer; the row a
      // cleared key left has no snapshot.
      expect(assembly).toMatchObject({ capabilitySource: 'user', toolsWithheld: 'not-probed' })
      expect(() => assembly.provider()).toThrow(
        expect.objectContaining({ name: 'ProviderConfigMissingError' }),
      )
    },
  )

  it.each(removals)(
    'when %s while a Run waits on a question, the resume ends as a provider error and keeps its model',
    async (_removal, remove) => {
      const h = await harness([instance({ id: ID })], [ASK])
      await choose(h, TOOL_ROW.id)
      expect((await send(h, 'ask me')).reason).toEqual({ code: 'paused', waitingFor: 'question' })
      expect(await remove(h)).toEqual({ ok: true })
      expect(await modelChoice(h)).toBe('user')
      await answerQuestion(h)
      expect((await h.loop.runEnded()).reason).toEqual({
        code: 'provider-error',
        providerId: ID,
        errorCode: 'auth',
        providerReason: null,
        attempts: 0,
      })
      expect(h.network.callCount).toBe(1)
      expect(
        (await payloads(h, 'session/model_selected')).map((selected) => selected['modelId']),
      ).toEqual([TOOL_ROW.id, TOOL_ROW.id])
      expect(await h.sessions.effectiveModelChoice({ sessionId: SESSION })).toMatchObject({
        providerId: ID,
        modelId: TOOL_ROW.id,
      })
    },
  )

  it.each(removals.slice(0, 2))(
    '验收 25: when %s while it is new sessions’ default, a new session falls back to ④⑤ and sends as usual',
    async (_removal, remove) => {
      const selected = { id: ID, modelId: TOOL_ROW.id }
      const h = await harness([instance({ id: ID })], [ANTHROPIC_ANSWER], {
        provider: selected,
        defaultModelByProfile: { chat: selected, cowork: selected },
      })
      h.keychain.values.set(h.keyOf(ANTHROPIC_PROVIDER_ID), ANTHROPIC_KEY)
      expect(await remove(h)).toEqual({ ok: true })
      const config = await readConfig(h.host.fs, h.host.identity, log)
      expect(config.provider).toBeNull()
      expect(config.defaultModelByProfile).toEqual({})

      // A session that never chose: ② and ③ are gone, ④ is nothing on a packaged build, ⑤ answers.
      expect((await send(h, 'hello', NEW_SESSION)).reason.code).toBe('completed')
      expect(h.network.requests.map((request) => request.url)).toEqual([
        'https://api.anthropic.com/v1/messages',
      ])
      expect(await payloads(h, 'session/model_selected', NEW_SESSION)).toEqual([
        expect.objectContaining({ providerId: ANTHROPIC_PROVIDER_ID }),
      ])
    },
  )

  it('when its row is removed while the send’s assembly waits on the keychain, the read the key came from decides: not sent, nothing written', async () => {
    const h = await harness([instance({ id: ID })], [answer()])
    await choose(h, TOOL_ROW.id)
    const before = await entries(h)
    // The prebuild has read config.json — the row was still there — and waits on the keychain.
    const prompt = h.keychain.holdNextGet(h.keyOf(ID))
    const sending = h.sessions.send({ sessionId: SESSION, origin: null, text: 'hello' })
    await prompt.held
    expect(await removals[1][1](h)).toEqual({ ok: true })
    prompt.release()
    expect(await sending).toEqual({ status: 'not-sent', code: 'config-missing' })
    expect(h.network.callCount).toBe(0)
    expect(await entries(h)).toEqual(before)
  })
})

describe('a probe beside the sessions (§探测; M6 不变量 8)', () => {
  it('M6 不变量 8, 验收 14: a probe writes no fact to any session’s Tape, begins no Run and runs no tool', async () => {
    const h = await harness(
      [instance({ id: ID })],
      [
        // The session's round on the passing row.
        answer(),
        // The probe of the text row: ① the Read its prompt asks for, ② an answer.
        callOf('Read', { file_path: '/tenon-probe/ping.txt' }),
        answer('It said ok.'),
      ],
    )
    await choose(h, TOOL_ROW.id)
    expect((await send(h, 'hello')).reason.code).toBe('completed')
    await choose(h, TEXT_ROW.id, { sessionId: OTHER_SESSION })
    const tapes = async (): Promise<[string, TapeEntry[]][]> => {
      const sessions = await h.tape.listSessions({ limit: 100 })
      return Promise.all(
        sessions.map(async ({ sessionId }): Promise<[string, TapeEntry[]]> => [
          sessionId,
          await entries(h, sessionId),
        ]),
      )
    }
    const before = await tapes()
    expect(before.map(([sessionId]) => sessionId)).toContain(SESSION)
    const events = h.loop.recorded.length
    const leases = h.loop.leaseLog.length

    expect(await h.ok('customVendor.probe', { id: ID, modelId: TEXT_ROW.id })).toMatchObject({
      status: 'done',
      saved: true,
      snapshot: { outcome: 'passed' },
    })
    expect(h.network.callCount).toBe(3)
    // No session gained, lost or changed a fact; the loop saw no Run and no event.
    expect(await tapes()).toEqual(before)
    expect(h.loop.recorded).toHaveLength(events)
    expect(h.loop.leaseLog).toHaveLength(leases)
    // ①: the fixed prompt alone, no session content (T4); ②: the call answered with the probe's
    // fixed text — no executor ran the Read, which would have come back as a missing file.
    const [, one, two] = bodies(h)
    expect(one?.['messages']).toEqual([{ role: 'user', content: expect.any(String) }])
    expect((two?.['messages'] as unknown[] | undefined)?.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_Read',
      content: 'ok',
    })
  })
})

describe('an instance’s address or wire edited by hand in config.json (§存储)', () => {
  it.each([
    [
      'a public instance moved to another public host',
      instance({ id: ID }),
      'https://other.test/v1',
      'not-probed',
    ],
    // The view still holds the loopback address, which withholds tools by its host.
    [
      'a loopback instance holding a key moved to a public host',
      LOCAL,
      'https://evil.test/v1',
      'provider-text-only',
    ],
  ] as const)(
    'M6 不变量 3: %s sends nothing there until the app sees the edit; the send is a configuration error',
    async (_what, vendor, edited, withheld) => {
      const h = await harness([vendor], [answer(), answer()])
      h.keychain.values.set(h.keyOf(vendor.id), KEY)
      await choose(h, TOOL_ROW.id, { providerId: vendor.id })
      expect((await send(h, 'hello')).reason.code).toBe('completed')
      await editByHand(h, vendor.id, { baseURL: edited })
      const before = await entries(h)

      // ① went through no data-flow check: without the guard this would start, keyed, to `edited`.
      expect(await h.sessions.send({ sessionId: SESSION, origin: null, text: 'again' })).toEqual({
        status: 'not-sent',
        code: 'config-missing',
      })
      expect(h.network.requests.map((request) => request.url)).toEqual([
        `${vendor.baseURL}/chat/completions`,
      ])
      expect(await entries(h)).toEqual(before)

      // plan step 7 读法 (4), (1): the edited read is a row that is gone, answered as one with no
      // passing probe, whatever the view's row says.
      const assembly = await assembleRow(h, vendor.id, 'builtin')
      expect(assembly).toMatchObject({ capabilitySource: 'user', toolsWithheld: withheld })
      expect(() => assembly.provider()).toThrow(
        expect.objectContaining({ name: 'ProviderConfigMissingError' }),
      )
    },
  )

  it('plan step 7 读法 (4): a wire changed by hand reads as a row that is gone: not sent, nothing written', async () => {
    // A path both wires take: under `/v1` the anthropic address rule 5 would refuse the edit itself.
    const api = 'https://vendor.test/api'
    const h = await harness([instance({ id: ID, baseURL: api })], [answer(), ANTHROPIC_ANSWER])
    await choose(h, TOOL_ROW.id)
    expect((await send(h, 'hello')).reason.code).toBe('completed')
    await editByHand(h, ID, { wire: 'anthropic-messages' })
    const before = await entries(h)

    // Without the guard this would start, with the instance's key, on the other wire.
    expect(await h.sessions.send({ sessionId: SESSION, origin: null, text: 'again' })).toEqual({
      status: 'not-sent',
      code: 'config-missing',
    })
    expect(h.network.requests.map((request) => request.url)).toEqual([`${api}/chat/completions`])
    expect(await entries(h)).toEqual(before)

    // plan step 7 读法 (4), (1): as for a row that is gone.
    const assembly = await assembleRow(h, ID, 'builtin')
    expect(assembly).toMatchObject({ capabilitySource: 'user', toolsWithheld: 'not-probed' })
    expect(() => assembly.provider()).toThrow(
      expect.objectContaining({ name: 'ProviderConfigMissingError' }),
    )
  })

  // Plan step 7 读法 (3): a public instance's paused Run carries the frozen `probed`; an address
  // edited by hand to this machine or a private network, which the view takes in at the app's next
  // write, still sends that resume no tools (Q7).
  it.each([
    ['loopback', 'http://127.0.0.1:11434/v1'],
    ['private', 'http://192.168.1.20:8000/v1'],
  ] as const)(
    'M6 不变量 7: a Run paused on a public instance resumes with no tools once its address is edited to a %s one',
    async (_reach, edited) => {
      const h = await harness([instance({ id: ID })], [ASK, answer()])
      await choose(h, TOOL_ROW.id)
      expect((await send(h, 'ask me')).reason).toEqual({ code: 'paused', waitingFor: 'question' })
      expect(toolNames(bodies(h)[0])).toEqual(CHAT_TOOLS)
      await editByHand(h, ID, { baseURL: edited })
      // Any write of the app's: the view follows the file.
      expect(await h.ok('customVendor.update', { id: ID, displayName: 'Renamed' })).toEqual({
        ok: true,
      })

      await answerQuestion(h)
      expect((await h.loop.runEnded()).reason.code).toBe('completed')
      expect(h.network.requests.map((request) => request.url)).toEqual([
        COMPLETIONS,
        `${edited}/chat/completions`,
      ])
      expect(toolNames(bodies(h)[1])).toBeNull()
      expect(await payloads(h, 'view/tools_withheld')).toEqual([
        expect.objectContaining({ providerId: ID, reason: 'provider-text-only' }),
      ])
    },
  )
})

describe('验收 20: an instance’s host and 02’s data-flow check', () => {
  it('a session that sent to a loopback instance holds its next round for a public instance until the menu confirms it, sending nothing meanwhile', async () => {
    const local = { id: LOCAL_ID, modelId: TOOL_ROW.id }
    const h = await harness([LOCAL, instance({ id: ID })], [answer(), answer()], {
      provider: local,
      defaultModelByProfile: { chat: local },
    })
    expect((await send(h, 'hello')).reason.code).toBe('completed')
    expect(await h.ok('provider.select', { providerId: ID, modelId: TOOL_ROW.id })).toEqual({
      ok: true,
    })
    const held = await h.sessions.send({ sessionId: SESSION, origin: null, text: 'again' })
    expect(held).toMatchObject({ status: 'held' })
    expect(h.loop.recorded).toContainEqual(
      expect.objectContaining({ type: 'queue-held', host: 'vendor.test' }),
    )
    expect(h.network.callCount).toBe(1)

    // The menu's choice confirms it: the held message goes to the instance's host.
    await choose(h, TOOL_ROW.id)
    expect((await h.loop.runEnded()).reason.code).toBe('completed')
    expect(h.network.requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:11434/v1/chat/completions',
      COMPLETIONS,
    ])
    expect(
      (await payloads(h, 'session/model_selected')).map((selected) => selected['endpointOrigin']),
    ).toEqual(['http://127.0.0.1:11434', 'https://vendor.test'])
  })
})

describe('T11 at run time (验收 24: the shared vocabulary’s known limit)', () => {
  it.each([
    // zhipu's own numeric code, from any vendor on this wire (openai-chat.ts ERROR_VOCABULARY).
    [
      'zhipu’s 1113',
      throttled('1113', '余额不足或无可用资源包,请充值。'),
      { code: 'quota-exhausted', providerId: ID, resetAt: null },
    ],
    // Bailian's TPM throttling: the kernel's documented fixture (its header carries the 按文档、未实测
    // mark and the source), the one the probe records as `rate-limit` (probe.test.ts).
    [
      'Bailian’s 429 insufficient_quota (按文档、未实测)',
      { kind: 'json', ...BAILIAN_THROTTLED } as FakeExchange,
      { code: 'provider-error', providerId: ID, errorCode: 'invalid-request' },
    ],
    // DeepSeek's wrong-key 401, recorded live (the fixture says where): the 401 is read before its
    // generic `code`, so `auth` (M6 §点名 (h)); the probe records `auth` too (probe.test.ts).
    [
      'DeepSeek’s live wrong-key 401 (code invalid_request_error)',
      { kind: 'json', ...DEEPSEEK_WRONG_KEY } as FakeExchange,
      { code: 'provider-error', providerId: ID, errorCode: 'auth' },
    ],
  ] as const)('an instance answering %s ends the Run, not retried', async (_what, reply, end) => {
    const h = await harness([instance({ id: ID })], [reply])
    await choose(h, TOOL_ROW.id)
    expect((await send(h, 'hello')).reason).toMatchObject(end)
    expect(h.network.callCount).toBe(1)
  })

  // Kimi's empty balance, the kernel's documented fixture (按文档、未实测): the 429 status decides, so
  // the Run resends what no wait clears and ends on the rate-limit card; the probe records
  // `rate-limit` (probe.test.ts).
  it('an instance answering Kimi’s 429 exceeded_current_quota_error (按文档、未实测) is retried as a rate limit', async () => {
    const reply = { kind: 'json', ...KIMI_BALANCE_EXHAUSTED } as FakeExchange
    const h = await harness([instance({ id: ID })], [reply, reply, reply])
    await choose(h, TOOL_ROW.id)
    const sent = await h.sessions.send({ sessionId: SESSION, origin: null, text: 'hello' })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    expect((await whileAdvancing(h, h.loop.runEnded({ runId: sent.runId }))).reason).toEqual({
      code: 'provider-error',
      providerId: ID,
      errorCode: 'rate-limit',
      providerReason: 'exceeded_current_quota_error',
      attempts: 3,
    })
    expect(h.network.callCount).toBe(3)
  })
})

/** The header names a request carried beyond its wire's protocol headers and `extra`. */
function unlistedHeaders(request: RecordedRequest | undefined, extra: readonly string[]): string[] {
  const listed = new Set(['content-type', 'accept', 'user-agent', ...extra])
  return Object.keys(request?.headers ?? {}).filter(
    (name) => !listed.has(name) && !name.startsWith('x-stainless-'),
  )
}
