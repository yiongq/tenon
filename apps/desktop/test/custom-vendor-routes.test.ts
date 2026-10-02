/**
 * The custom vendor routes and the instance half of the provider and model routes (M6 §IPC; plan
 * step 6): what the settings card and the menu get over IPC, what each route writes, and the probe's
 * run — one per instance, stored only while nothing changed since its read, and stopped by a cancel,
 * a key save, a delete or the quit.
 *
 * Every call goes through `registerRoute`, so an answer here has passed its response schema. The
 * keychain is a fake that can hold or fail a write; the network is `fakeNetwork`; nothing touches the
 * OS keychain or a real profile directory.
 */
import { randomUUID } from 'node:crypto'
import {
  ANTHROPIC_PROVIDER_ID,
  OLLAMA_PROVIDER_ID,
  ZHIPU_PROVIDER_ID,
  createMemoryHost,
  createMemoryTapeStore,
  createProviderRegistry,
  createSessionService,
  keyFor,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type {
  AbsolutePath,
  HostAdapter,
  HostFs,
  HostSecrets,
  RunConnector,
  SessionService,
} from '@tenon-app/kernel'
import {
  createCounterIds,
  createStreamGate,
  createTestLoopPorts,
  fakeNetwork,
} from '@tenon-app/kernel/testing'
import type {
  FakeExchange,
  FakeNetwork,
  StreamGate,
  TestLoopPorts,
} from '@tenon-app/kernel/testing'
import type {
  Config,
  CustomVendorContract,
  IpcMainLike,
  IpcResult,
  ProviderEntryContract,
} from '@tenon-app/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createProviderView } from '../src/main/custom-vendors/registry.js'
import { createProbeRuns, registerCustomVendorRoutes } from '../src/main/custom-vendors/routes.js'
import { vendorPresets } from '../src/main/custom-vendors/presets.js'
import { configPath, countProviderSettingsWrite, readConfig } from '../src/main/host/profile.js'
import { registerModelRoutes } from '../src/main/model-routes.js'
import { registerProviderRoutes } from '../src/main/provider-routes.js'
import { DEFAULT_MAX_TOKENS } from '../src/main/provider.js'
import type { EnvLike } from '../src/main/provider.js'
import { createRunConnector } from '../src/main/run-assembly.js'

const ID = 'custom-2d7c4a1e-5b6f-4c8d-9e0f-1a2b3c4d5e6f'
const SECOND_ID = 'custom-5a0f7d4b-8e9c-4f1a-ab3c-4d5e6f7a8b92'
const LOCAL_ID = 'custom-3e8d5b2f-6c7a-4d9e-8f1a-2b3c4d5e6f70'
const PRIVATE_ID = 'custom-4f9e6c3a-7d8b-4e0f-9a2b-3c4d5e6f7a81'
const SESSION = '6d2e0b3f-7c4a-4b82-9a63-1d9ef8b22c02'
const KEY = 'sk-m6-routes-test-5e2a91'
const NEW_KEY = 'sk-m6-routes-new-8c3f07'
const BASE = 'https://vendor.test/v1'
const MODEL = 'vendor-model'
const ROW = { id: MODEL, contextLimit: 128_000, maxOutputTokens: 8_000 }
const OTHER_ROW = { id: 'vendor-model-mini', contextLimit: 64_000, maxOutputTokens: 4_000 }

const FAILED = {
  outcome: 'failed' as const,
  reason: 'service' as const,
  probedAt: 1,
  reasoningField: null,
  maxTokensField: 'max_completion_tokens' as const,
  usageSeen: false,
  responseModelId: null,
  unknownFields: [],
}
const PASSED = { ...FAILED, outcome: 'passed' as const, reason: null }

function instance(
  over: Partial<CustomVendorContract> & Pick<CustomVendorContract, 'id'>,
): CustomVendorContract {
  return { displayName: 'Vendor', wire: 'openai-chat', baseURL: BASE, models: [ROW], ...over }
}

// ----- an openai-chat endpoint that passes the probe ---------------------------------------------

const frame = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`
const chunk = (delta: unknown, finish: string | null = null): string =>
  frame({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
const USAGE = frame({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: MODEL,
  choices: [],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
})
const DONE = 'data: [DONE]\n\n'
/** ①: one Read of the probe's path. */
const CALL_FRAMES = [
  chunk({ role: 'assistant', content: '' }),
  chunk({
    tool_calls: [
      {
        index: 0,
        id: 'call_probe',
        type: 'function',
        function: { name: 'Read', arguments: '{"file_path":"/tenon-probe/ping.txt"}' },
      },
    ],
  }),
  chunk({}, 'tool_calls'),
  USAGE,
  DONE,
]
/** ②: a sentence, and a normal end. */
const ANSWER_FRAMES = [
  chunk({ role: 'assistant', content: 'It said ok.' }),
  chunk({}, 'stop'),
  USAGE,
  DONE,
]
const CALL: FakeExchange = { kind: 'sse', frames: CALL_FRAMES }
const ANSWER: FakeExchange = { kind: 'sse', frames: ANSWER_FRAMES }

function gatedCall(): { exchange: FakeExchange; gate: StreamGate } {
  const gate = createStreamGate()
  return { exchange: { kind: 'sse', frames: CALL_FRAMES, gate }, gate }
}

// ----- the harness ----------------------------------------------------------------------------

/**
 * A keychain whose next write, or next read of one key, can be held — a write then let through or
 * failed — and that says what it holds.
 */
class Keychain implements HostSecrets {
  readonly values = new Map<string, string>()
  /** Runs on every read, before the value is looked up. */
  onGet: ((key: string) => void) | null = null
  #hold: { reached: () => void; gate: Promise<boolean> } | null = null
  #holdGet: { key: string; reached: () => void; gate: Promise<void> } | null = null

  async get(key: string): Promise<string | null> {
    this.onGet?.(key)
    const hold = this.#holdGet
    if (hold !== null && hold.key === key) {
      this.#holdGet = null
      hold.reached()
      await hold.gate
    }
    return this.values.get(key) ?? null
  }

  /** The next read of `key` waits for `release`, then reads what is stored by then. */
  holdNextGet(key: string): { held: Promise<void>; release: () => void } {
    const reached = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    this.#holdGet = { key, reached: reached.resolve, gate: gate.promise }
    return { held: reached.promise, release: gate.resolve }
  }

  async set(key: string, value: string): Promise<void> {
    const hold = this.#hold
    this.#hold = null
    if (hold !== null) {
      hold.reached()
      if (!(await hold.gate)) throw new Error('keychain locked')
    }
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }

  /** The next `set` waits; `release(true)` stores it, `release(false)` fails it. */
  holdNextSet(): { held: Promise<void>; release: (stored: boolean) => void } {
    const reached = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<boolean>()
    this.#hold = { reached: reached.resolve, gate: gate.promise }
    return { held: reached.promise, release: gate.resolve }
  }
}

interface Harness {
  readonly host: HostAdapter
  readonly keychain: Keychain
  readonly network: FakeNetwork
  readonly sessions: SessionService
  readonly loop: TestLoopPorts
  readonly connector: RunConnector
  readonly lines: string[]
  /** The route's answer as the renderer receives it: `ok: false` for a refused request. */
  call(channel: string, payload: unknown): Promise<IpcResult<unknown>>
  /** The route's data; fails the test unless the call went through its schemas. */
  ok<T = unknown>(channel: string, payload: unknown): Promise<T>
  list(): Promise<ProviderEntryContract[]>
  entry(id: string): Promise<ProviderEntryContract | undefined>
  config(): Promise<Config>
  /** `config.json` byte for byte, or null before the first write. */
  file(): Promise<string | null>
  /** Holds the next `config.json` write before any byte reaches the file. */
  holdNextWrite(): { held: Promise<void>; release: () => void }
  keyOf(id: string): string
}

let profiles = 0

interface HarnessOptions {
  readonly file?: unknown
  readonly script?: readonly FakeExchange[]
  readonly signal?: AbortSignal
  /** A packaged build unless false; only a development build reads `env` (`devEnv`). */
  readonly isPackaged?: boolean
  readonly env?: EnvLike
}

async function harness(o: HarnessOptions = {}): Promise<Harness> {
  profiles += 1
  const network = fakeNetwork(o.script ?? [])
  const memory = createMemoryHost({
    identity: { profileDir: `/profiles/user/vendor-routes-${profiles}` },
    network,
  })
  await memory.fs.mkdirp(memory.identity.profileDir as AbsolutePath)
  if (o.file !== undefined) {
    await memory.fs.writeFile(configPath(memory.identity), JSON.stringify(o.file))
  }
  let hold: { reached: () => void; gate: Promise<void> } | null = null
  const fs: HostFs = {
    readFile: (path, opts) => memory.fs.readFile(path, opts),
    writeFile: async (path, data) => {
      const held = hold
      hold = null
      if (held !== null) {
        held.reached()
        await held.gate
      }
      await memory.fs.writeFile(path, data)
    },
    stat: (path) => memory.fs.stat(path),
    readdir: (path) => memory.fs.readdir(path),
    mkdirp: (path) => memory.fs.mkdirp(path),
    realpath: (path) => memory.fs.realpath(path),
  }
  const keychain = new Keychain()
  const host: HostAdapter = { ...memory, fs, secrets: keychain }
  const lines: string[] = []
  const log = (line: string): void => void lines.push(line)
  const builtin = createProviderRegistry()
  registerBuiltinProviders(builtin)
  const providers = createProviderView({
    builtin,
    identity: host.identity,
    config: await readConfig(host.fs, host.identity, log),
  })
  const isPackaged = o.isPackaged ?? true
  const env = o.env ?? {}
  const connector = createRunConnector({ host, providers, isPackaged, env, log })
  const sessions = createSessionService({
    host,
    tape: createMemoryTapeStore({ identity: host.identity }),
    ids: createCounterIds(),
    inspectors: [],
    connector,
    protectedFiles: [],
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
  registerProviderRoutes({ ipcMain, host, providers, isPackaged, env, log, probes })
  registerCustomVendorRoutes({
    ipcMain,
    host,
    providers,
    probes,
    uuid: () => randomUUID(),
    isPackaged,
    env,
    log,
    ...(o.signal === undefined ? {} : { signal: o.signal }),
  })
  registerModelRoutes({ ipcMain, sessions, providers, host })

  const call = async (channel: string, payload: unknown): Promise<IpcResult<unknown>> => {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error(`${channel} is not registered`)
    return (await handler({}, payload)) as IpcResult<unknown>
  }
  const ok = async <T>(channel: string, payload: unknown): Promise<T> => {
    const result = await call(channel, payload)
    if (!result.ok) throw new Error(`${channel}: ${JSON.stringify(result.error)}`)
    return result.data as T
  }
  const list = (): Promise<ProviderEntryContract[]> => ok('provider.list', {})
  return {
    host,
    keychain,
    network,
    sessions,
    loop,
    connector,
    lines,
    call,
    ok,
    list,
    entry: async (id) => (await list()).find((entry) => entry.id === id),
    config: () => readConfig(host.fs, host.identity, log),
    async file() {
      const path = configPath(host.identity)
      if ((await memory.fs.stat(path)) === null) return null
      return (await memory.fs.readFile(path, { encoding: 'utf8' })) as string
    },
    holdNextWrite() {
      const reached = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      hold = { reached: reached.resolve, gate: gate.promise }
      return { held: reached.promise, release: gate.resolve }
    },
    keyOf: (id) => keyFor(host.identity, 'provider', id, 'apiKey'),
  }
}

/** A profile holding `entries`, with the public ones' key stored. */
async function seeded(
  entries: readonly CustomVendorContract[],
  o: Omit<HarnessOptions, 'file'> & { rest?: Partial<Config> } = {},
): Promise<Harness> {
  const h = await harness({ ...o, file: { ...o.rest, customVendors: entries } })
  for (const entry of entries) {
    if (entry.id !== LOCAL_ID && entry.id !== PRIVATE_ID)
      h.keychain.values.set(h.keyOf(entry.id), KEY)
  }
  return h
}

/** Lets every task queued so far, and the microtasks behind it, run. */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 5; hop += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one macrotask after another
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

type ProbeAnswer =
  | { status: 'done'; snapshot: Record<string, unknown>; saved: boolean }
  | { status: 'refused'; code: string }

function probe(h: Harness, modelId = MODEL, id = ID): Promise<ProbeAnswer> {
  return h.ok<ProbeAnswer>('customVendor.probe', { id, modelId })
}

const builtinIds = [ANTHROPIC_PROVIDER_ID, ZHIPU_PROVIDER_ID, OLLAMA_PROVIDER_ID]

// ----- the tests ---------------------------------------------------------------------------------

describe('customVendor.list, create, update and delete (M6 §IPC)', () => {
  it('验收 3: create, rename, change the rows and delete show in provider.list at once; the builtins stay as they were', async () => {
    const h = await harness()
    const builtins = (await h.list()).filter((entry) => builtinIds.includes(entry.id))
    expect(builtins.map((entry) => entry.id)).toEqual(builtinIds)
    const unchanged = async (): Promise<void> =>
      expect((await h.list()).filter((entry) => builtinIds.includes(entry.id))).toEqual(builtins)

    const created = await h.ok<{ ok: true; id: string }>('customVendor.create', {
      displayName: 'Relay',
      wire: 'openai-chat',
      source: { kind: 'custom', baseURL: BASE },
      apiKey: KEY,
    })
    expect(created.ok).toBe(true)
    expect((await h.list()).map((entry) => entry.id)).toEqual([...builtinIds, created.id])
    expect(await h.entry(created.id)).toMatchObject({
      displayName: 'Relay',
      nameKey: 'provider.custom.name',
      models: [],
      configured: true,
      endpoint: { host: 'vendor.test', reach: 'public' },
    })
    await unchanged()

    // The rename (验收 3「改名」): the card's name follows without a restart.
    expect(await h.ok('customVendor.update', { id: created.id, displayName: 'Relay Two' })).toEqual(
      { ok: true },
    )
    expect((await h.entry(created.id))?.displayName).toBe('Relay Two')

    expect(await h.ok('customVendor.update', { id: created.id, models: [ROW] })).toEqual({
      ok: true,
    })
    expect((await h.entry(created.id))?.models).toEqual([
      { id: MODEL, mark: 'unverified-text-only', listing: 'main' },
    ])
    await unchanged()

    expect(await h.ok('customVendor.delete', { id: created.id })).toEqual({ ok: true })
    expect((await h.list()).map((entry) => entry.id)).toEqual(builtinIds)
    expect(h.keychain.values.has(h.keyOf(created.id))).toBe(false)
    await unchanged()
    expect(await h.ok('customVendor.delete', { id: created.id })).toEqual({
      ok: false,
      code: 'not-found',
    })
  })

  it('lists the presets and every instance, one whose address fails §地址校验 with its code (§存储)', async () => {
    const refusedEntry = instance({ id: LOCAL_ID, baseURL: 'http://api.example.com/v1' })
    const h = await seeded([instance({ id: ID, presetId: 'deepseek' }), refusedEntry])
    const listed = await h.ok<{ presets: unknown; instances: unknown }>('customVendor.list', {})
    expect(listed.presets).toEqual(vendorPresets())
    expect(listed.instances).toEqual([
      instance({ id: ID, presetId: 'deepseek' }),
      { ...refusedEntry, refused: { code: 'https-required' } },
    ])
  })

  it('refuses a row id with surrounding whitespace, writing nothing (§列表与上限; Revisions 2026-10-02)', async () => {
    // A new session's default trims a saved model id (resolveChoice) and `assemble` looks the row up
    // by exact id: a padded row could never be reached from ② / ③.
    const h = await seeded([instance({ id: ID })])
    await h.ok('customVendor.update', { id: ID, displayName: 'Vendor' })
    const before = await h.file()
    const result = await h.call('customVendor.update', {
      id: ID,
      models: [{ ...ROW, id: `${MODEL} ` }],
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(await h.file()).toBe(before)
    expect([...h.keychain.values]).toEqual([[h.keyOf(ID), KEY]])
  })
})

describe('provider.list for instances (M6 01 修补 4, 6; §运行时「行标记」)', () => {
  it('marks each row by its probe and its reach, with no thinking levels; a key-less local instance is configured (验收 18, 19)', async () => {
    const h = await seeded([
      instance({
        id: ID,
        models: [
          { ...ROW, probe: PASSED },
          { ...OTHER_ROW, probe: FAILED },
          { id: 'vendor-model-new', contextLimit: 32_000, maxOutputTokens: 2_000 },
        ],
      }),
      // A passing snapshot a hand edit put on a local instance does not make its row `probed` (Q7).
      instance({
        id: LOCAL_ID,
        baseURL: 'http://127.0.0.1:8000/v1',
        models: [{ ...ROW, probe: PASSED }],
      }),
      instance({ id: PRIVATE_ID, baseURL: 'http://192.168.1.20/v1' }),
    ])
    const vendor = await h.entry(ID)
    expect(vendor?.models).toEqual([
      { id: MODEL, mark: 'probed', listing: 'main' },
      { id: OTHER_ROW.id, mark: 'unverified-text-only', listing: 'main' },
      { id: 'vendor-model-new', mark: 'unverified-text-only', listing: 'main' },
    ])
    expect(vendor).toMatchObject({ displayName: 'Vendor', configured: true })
    expect(vendor?.refused).toBeUndefined()
    // §key: no key stored, and configured all the same — only the binding would count.
    for (const id of [LOCAL_ID, PRIVATE_ID]) {
      // oxlint-disable-next-line no-await-in-loop -- one entry at a time
      const local = await h.entry(id)
      expect(local?.models).toEqual([{ id: MODEL, mark: 'local-text-only', listing: 'main' }])
      expect(local?.configured).toBe(true)
    }
    // A public instance with no key is not.
    h.keychain.values.delete(h.keyOf(ID))
    expect((await h.entry(ID))?.configured).toBe(false)
  })

  it('leaves out an instance deleted while it was being described (验收 3)', async () => {
    // The view listed it; the delete landed between that and the read of its entry and key. What is
    // described is the read's entry — never the stale definition dressed as a builtin.
    const h = await seeded([instance({ id: ID, models: [{ ...ROW, probe: PASSED }] })])
    const read = h.keychain.holdNextGet(h.keyOf(ID))
    const listing = h.list()
    await read.held
    expect(await h.ok('customVendor.delete', { id: ID })).toEqual({ ok: true })
    read.release()
    expect((await listing).map((entry) => entry.id)).toEqual(builtinIds)
  })

  it('M6 不变量 3: an address that fails §地址校验 is listed refused and not configured, and sends nothing — no model list, no probe', async () => {
    const stored = instance({ id: ID, baseURL: 'http://api.example.com/v1' })
    const h = await seeded([stored])
    expect(await h.entry(ID)).toMatchObject({
      configured: false,
      refused: { code: 'https-required' },
      endpoint: { host: 'api.example.com', reach: 'public' },
    })
    expect(await h.ok('customVendor.fetchModels', { id: ID })).toEqual({
      ok: false,
      code: 'config',
    })
    const probed = await probe(h)
    expect(probed).toMatchObject({
      status: 'done',
      snapshot: { outcome: 'failed', reason: 'config' },
    })
    expect(h.network.callCount).toBe(0)
  })
})

describe('provider.configure for an instance (§IPC; T2, T3)', () => {
  it('验收 5, M6 不变量 2: no route changes the wire or the address; config.json and the keychain stay as they were', async () => {
    const h = await seeded([instance({ id: ID })])
    // A write the config holds: the bytes below are the file as the app wrote it.
    await h.ok('customVendor.update', { id: ID, displayName: 'Vendor' })
    const before = await h.file()
    for (const change of [
      { baseURL: 'https://elsewhere.example/v1' },
      { wire: 'anthropic-messages' },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const result = await h.call('customVendor.update', { id: ID, ...change })
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    }
    for (const values of [
      { baseURL: 'https://elsewhere.example/v1' },
      { baseURL: 'https://elsewhere.example/v1', apiKey: NEW_KEY },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      expect(await h.ok('provider.configure', { id: ID, values })).toEqual({
        ok: false,
        code: 'invalid-value',
        configKey: 'baseURL',
      })
    }
    expect(await h.ok('provider.configure', { id: ID, values: { authToken: NEW_KEY } })).toEqual({
      ok: false,
      code: 'unknown-key',
      configKey: 'authToken',
    })
    expect(await h.file()).toBe(before)
    expect([...h.keychain.values]).toEqual([[h.keyOf(ID), KEY]])
  })

  it('M6 不变量 3: a refused baseURL leaves endpointOrigin, provider.list’s endpoint and config.json as they were', async () => {
    const h = await seeded([instance({ id: ID })])
    await h.ok('customVendor.update', { id: ID, displayName: 'Vendor' })
    const before = await h.file()
    expect(h.connector.endpointOrigin(ID)).toBe('https://vendor.test')
    await h.ok('provider.configure', {
      id: ID,
      values: { baseURL: 'https://elsewhere.example/v1' },
    })
    expect(h.connector.endpointOrigin(ID)).toBe('https://vendor.test')
    expect((await h.entry(ID))?.endpoint).toEqual({ host: 'vendor.test', reach: 'public' })
    expect(await h.file()).toBe(before)
    expect((await h.config()).providerConfig[ID]).toBeUndefined()
  })

  it('saves the key after clearing every snapshot, writing no providerConfig; blank deletes it (验收 10)', async () => {
    const h = await seeded([
      instance({
        id: ID,
        models: [
          { ...ROW, probe: PASSED },
          { ...OTHER_ROW, probe: FAILED },
        ],
      }),
    ])
    expect(
      await h.ok('provider.configure', { id: ID, values: { apiKey: ` ${NEW_KEY} ` } }),
    ).toEqual({
      ok: true,
    })
    const config = await h.config()
    expect(config.customVendors[0]?.models).toEqual([ROW, OTHER_ROW])
    expect(config.providerConfig).toEqual({})
    expect(h.keychain.values.get(h.keyOf(ID))).toBe(NEW_KEY)
    expect((await h.entry(ID))?.models.map((row) => row.mark)).toEqual([
      'unverified-text-only',
      'unverified-text-only',
    ])

    expect(await h.ok('provider.configure', { id: ID, values: { apiKey: '' } })).toEqual({
      ok: true,
    })
    expect(h.keychain.values.has(h.keyOf(ID))).toBe(false)
    expect((await h.entry(ID))?.configured).toBe(false)
  })
})

describe('choosing an instance’s model (验收 12, 25)', () => {
  it('provider.select and session.selectModel answer unknown-model for an id the instance does not list, writing nothing', async () => {
    const h = await seeded([instance({ id: ID })])
    const unknown = { ok: false, code: 'unknown-model', configKey: null }
    expect(await h.ok('provider.select', { providerId: ID, modelId: 'typed-by-hand' })).toEqual(
      unknown,
    )
    expect(
      await h.ok('session.selectModel', {
        sessionId: SESSION,
        providerId: ID,
        modelId: 'typed-by-hand',
        effort: null,
      }),
    ).toEqual(unknown)
    // A level: an instance's rows list none (T5).
    expect(
      await h.ok('session.selectModel', {
        sessionId: SESSION,
        providerId: ID,
        modelId: MODEL,
        effort: 'high',
      }),
    ).toEqual({ ok: false, code: 'invalid-value', configKey: null })
    const config = await h.config()
    expect(config.provider).toBeNull()
    expect(config.defaultModelByProfile).toEqual({})
    expect((await h.sessions.effectiveModelChoice({ sessionId: SESSION })).providerId).not.toBe(ID)

    // A row it lists is an ordinary choice, never marked hand-typed.
    expect(await h.ok('provider.select', { providerId: ID, modelId: MODEL })).toEqual({ ok: true })
    expect((await h.config()).provider).toEqual({ id: ID, modelId: MODEL })
    expect(
      await h.ok('session.selectModel', {
        sessionId: SESSION,
        providerId: ID,
        modelId: MODEL,
        effort: null,
      }),
    ).toEqual({ ok: true })
    expect(await h.sessions.effectiveModelChoice({ sessionId: SESSION })).toMatchObject({
      providerId: ID,
      modelId: MODEL,
    })
  })

  it.each([
    ['a delete', 'unknown-provider'],
    ['a row removal', 'unknown-model'],
  ] as const)(
    'a choice waiting on %s that holds the lock writes nothing, and new sessions fall back to ④⑤',
    async (removal, code) => {
      const selected = { id: ID, modelId: MODEL }
      const h = await seeded([instance({ id: ID, models: [ROW, OTHER_ROW] })], {
        rest: { provider: selected, defaultModelByProfile: { chat: selected, cowork: selected } },
      })
      const held = h.holdNextWrite()
      const removing =
        removal === 'a delete'
          ? h.ok('customVendor.delete', { id: ID })
          : h.ok('customVendor.update', { id: ID, models: [OTHER_ROW] })
      await held.held
      // Both pass the view (the removal is not written yet), then wait for the lock.
      const selecting = h.ok('provider.select', { providerId: ID, modelId: MODEL })
      const choosing = h.ok('session.selectModel', {
        sessionId: SESSION,
        providerId: ID,
        modelId: MODEL,
        effort: null,
      })
      await settle()
      held.release()
      expect(await removing).toEqual({ ok: true })
      expect(await selecting).toEqual({ ok: false, code, configKey: null })
      expect(await choosing).toEqual({ ok: false, code, configKey: null })
      const config = await h.config()
      expect(config.provider).toBeNull()
      expect(config.defaultModelByProfile).toEqual({})
      // ④ (none on a packaged build), ⑤ the first builtin.
      const resolved = await h.connector.resolveChoice({
        sessionId: SESSION,
        profile: 'chat',
        sessionChoice: null,
        previousOrigin: null,
      })
      expect(resolved).toMatchObject({ providerId: ANTHROPIC_PROVIDER_ID })
      expect((await h.sessions.effectiveModelChoice({ sessionId: SESSION })).providerId).toBe(
        ANTHROPIC_PROVIDER_ID,
      )
    },
  )
})

describe('session.selectModel and the profile’s lock (provider.ts readSettledInputs)', () => {
  it('waits behind a prebuilding send without holding the lock: a save goes through meanwhile', async () => {
    const selected = { id: ID, modelId: MODEL }
    const h = await seeded([instance({ id: ID, models: [ROW, OTHER_ROW] })], {
      script: [ANSWER],
      rest: { provider: selected, defaultModelByProfile: { chat: selected, cowork: selected } },
    })
    // The send's prebuild reads the instance's key — a keychain prompt on an unsigned build.
    const prompt = h.keychain.holdNextGet(h.keyOf(ID))
    const sending = h.sessions.send({ sessionId: SESSION, origin: null, text: 'hello' })
    await prompt.held
    const choosing = h.ok('session.selectModel', {
      sessionId: SESSION,
      providerId: ID,
      modelId: OTHER_ROW.id,
      effort: null,
    })
    await settle()
    const renaming = h.ok('customVendor.update', { id: ID, displayName: 'Renamed' })
    await vi.waitFor(async () =>
      expect((await h.config()).customVendors[0]?.displayName).toBe('Renamed'),
    )
    expect(await renaming).toEqual({ ok: true })
    prompt.release()
    expect(await choosing).toEqual({ ok: true })
    const sent = await sending
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    await h.loop.runEnded({ runId: sent.runId })
    expect((await h.config()).provider).toEqual({ id: ID, modelId: OTHER_ROW.id })
  })

  it('a delete while the choice waits behind that send leaves the defaults cleared (验收 25)', async () => {
    const selected = { id: ID, modelId: MODEL }
    const h = await seeded([instance({ id: ID, models: [ROW, OTHER_ROW] })], {
      rest: { provider: selected, defaultModelByProfile: { chat: selected, cowork: selected } },
    })
    const prompt = h.keychain.holdNextGet(h.keyOf(ID))
    const sending = h.sessions.send({ sessionId: SESSION, origin: null, text: 'hello' })
    await prompt.held
    // Past its first check: the instance is still there.
    const choosing = h.ok('session.selectModel', {
      sessionId: SESSION,
      providerId: ID,
      modelId: OTHER_ROW.id,
      effort: null,
    })
    await settle()
    expect(await h.ok('customVendor.delete', { id: ID })).toEqual({ ok: true })
    prompt.release()
    // The choice came first: the session holds it, a removed instance's from now on (T12).
    expect(await choosing).toEqual({ ok: true })
    expect(await sending).toEqual({ status: 'not-sent', code: 'config-missing' })
    const config = await h.config()
    expect(config.provider).toBeNull()
    expect(config.defaultModelByProfile).toEqual({})
    expect(
      await h.connector.resolveChoice({
        sessionId: '7e3f1c4a-8d5b-4c93-8b74-2e0fa9c33d13',
        profile: 'chat',
        sessionChoice: null,
        previousOrigin: null,
      }),
    ).toMatchObject({ providerId: ANTHROPIC_PROVIDER_ID })
  })
})

describe('customVendor.fetchModels (§列表与上限; T6, T7)', () => {
  it('验收 12: no /models request until it is asked for; the limits come back to prefill, a code when it fails', async () => {
    const h = await harness({
      script: [
        {
          kind: 'json',
          body: {
            data: [
              { id: 'vendor-model', context_length: 131_072, max_output_tokens: 8_192 },
              { id: 'vendor-model-mini' },
            ],
          },
        },
        { kind: 'json', status: 401, body: { error: { message: 'bad key' } } },
      ],
    })
    const created = await h.ok<{ ok: true; id: string }>('customVendor.create', {
      displayName: 'Relay',
      wire: 'openai-chat',
      source: { kind: 'custom', baseURL: BASE },
      apiKey: KEY,
    })
    await h.ok('customVendor.list', {})
    await h.list()
    await h.ok('customVendor.update', { id: created.id, models: [ROW] })
    expect(h.network.callCount).toBe(0)

    expect(await h.ok('customVendor.fetchModels', { id: created.id })).toEqual({
      ok: true,
      models: [
        { id: 'vendor-model', contextLimit: 131_072, maxOutputTokens: 8_192 },
        { id: 'vendor-model-mini' },
      ],
    })
    expect(h.network.requests.map((request) => [request.method, request.url])).toEqual([
      ['GET', `${BASE}/models`],
    ])
    expect(h.network.requests[0]?.headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(await h.ok('customVendor.fetchModels', { id: created.id })).toEqual({
      ok: false,
      code: 'auth',
    })
    // The list prefills only: the rows are what the user saved.
    expect((await h.config()).customVendors[0]?.models).toEqual([ROW])
    expect(await h.ok('customVendor.fetchModels', { id: ID })).toEqual({
      ok: false,
      code: 'not-found',
    })
  })

  it('lists a key-less loopback instance’s models with no credential header (§key)', async () => {
    const local = 'http://127.0.0.1:8000/v1'
    const h = await seeded([instance({ id: LOCAL_ID, baseURL: local })], {
      script: [{ kind: 'json', body: { data: [{ id: 'local-model' }] } }],
    })
    expect(await h.ok('customVendor.fetchModels', { id: LOCAL_ID })).toEqual({
      ok: true,
      models: [{ id: 'local-model' }],
    })
    expect(h.network.requests.map((request) => request.url)).toEqual([`${local}/models`])
    expect(h.network.requests[0]?.headers['authorization']).toBeUndefined()
  })

  it('stops on the app’s quit: the list is never answered (§列表与上限「应用退出时经 signal 中止」)', async () => {
    const h = await seeded([instance({ id: ID })], {
      signal: AbortSignal.abort(),
      script: [{ kind: 'json', body: { data: [{ id: MODEL }] } }],
    })
    // The answer union has no code for it: the route fails as the window closes.
    expect(await h.call('customVendor.fetchModels', { id: ID })).toMatchObject({
      ok: false,
      error: { code: 'handler-failed' },
    })
  })
})

describe('customVendor.probe (§探测)', () => {
  it('验收 14: sends only when asked, two requests through the instance, and stores what passed', async () => {
    const h = await seeded([instance({ id: ID, models: [ROW, OTHER_ROW] })], {
      script: [CALL, ANSWER],
    })
    await h.list()
    await h.ok('customVendor.list', {})
    expect(h.network.callCount).toBe(0)

    const answer = await probe(h)
    expect(answer).toMatchObject({
      status: 'done',
      saved: true,
      snapshot: { outcome: 'passed', reason: null, maxTokensField: 'max_tokens', usageSeen: true },
    })
    expect(h.network.requests.map((request) => request.url)).toEqual([
      `${BASE}/chat/completions`,
      `${BASE}/chat/completions`,
    ])
    // The limit a send of this row would ask for (RunAssembly.maxTokens): the row's own 8 000.
    const first = h.network.requests[0]?.body as { max_tokens?: number } | undefined
    expect(first?.max_tokens).toBe(8_000)
    const rows = (await h.config()).customVendors[0]?.models
    expect(rows?.[0]?.probe).toEqual(answer.status === 'done' ? answer.snapshot : null)
    expect(rows?.[1]).toEqual(OTHER_ROW)
    expect((await h.entry(ID))?.models.map((row) => row.mark)).toEqual([
      'probed',
      'unverified-text-only',
    ])
  })

  it('Q7, 验收 18: a loopback or private instance answers local-endpoint and sends nothing; an unknown instance or row is refused', async () => {
    const h = await seeded([
      instance({ id: ID }),
      instance({ id: LOCAL_ID, baseURL: 'http://localhost:11434/v1' }),
      instance({ id: PRIVATE_ID, baseURL: 'http://10.0.0.8:8000/v1' }),
    ])
    expect(await probe(h, MODEL, LOCAL_ID)).toEqual({ status: 'refused', code: 'local-endpoint' })
    expect(await probe(h, MODEL, PRIVATE_ID)).toEqual({ status: 'refused', code: 'local-endpoint' })
    expect(await probe(h, 'not-a-row')).toEqual({ status: 'refused', code: 'unknown-model' })
    expect(await probe(h, MODEL, 'custom-ffffffff-ffff-4fff-8fff-ffffffffffff')).toEqual({
      status: 'refused',
      code: 'not-found',
    })
    expect(h.network.callCount).toBe(0)
  })

  it('runs one probe per instance: a second answers busy; cancelProbe stops the first, which stores nothing and leaves the snapshot (验收 14)', async () => {
    const { exchange } = gatedCall()
    const h = await seeded([instance({ id: ID, models: [{ ...ROW, probe: FAILED }, OTHER_ROW] })], {
      script: [exchange],
    })
    await h.ok('customVendor.update', { id: ID, displayName: 'Vendor' })
    const before = await h.file()
    const running = probe(h)
    await vi.waitFor(() => expect(h.network.callCount).toBe(1))
    expect(await probe(h, OTHER_ROW.id)).toEqual({ status: 'refused', code: 'busy' })

    expect(await h.ok('customVendor.cancelProbe', { id: ID })).toEqual({ cancelled: true })
    expect(await running).toEqual({ status: 'refused', code: 'aborted' })
    expect(await h.file()).toBe(before)
    expect(await h.ok('customVendor.cancelProbe', { id: ID })).toEqual({ cancelled: false })
    expect(h.network.callCount).toBe(1)
  })

  it('a key save aborts the running probe: aborted, nothing stored, every snapshot cleared (验收 10, 14)', async () => {
    const { exchange } = gatedCall()
    const h = await seeded([instance({ id: ID, models: [{ ...ROW, probe: PASSED }] })], {
      script: [exchange],
    })
    const running = probe(h)
    await vi.waitFor(() => expect(h.network.callCount).toBe(1))
    expect(await h.ok('provider.configure', { id: ID, values: { apiKey: NEW_KEY } })).toEqual({
      ok: true,
    })
    expect(await running).toEqual({ status: 'refused', code: 'aborted' })
    expect((await h.config()).customVendors[0]?.models).toEqual([ROW])
    expect(h.keychain.values.get(h.keyOf(ID))).toBe(NEW_KEY)
  })

  it('a delete aborts the running probe, which answers not-found (验收 14)', async () => {
    const { exchange } = gatedCall()
    const h = await seeded([instance({ id: ID })], { script: [exchange] })
    const running = probe(h)
    await vi.waitFor(() => expect(h.network.callCount).toBe(1))
    expect(await h.ok('customVendor.delete', { id: ID })).toEqual({ ok: true })
    expect(await running).toEqual({ status: 'refused', code: 'not-found' })
    expect((await h.config()).customVendors).toEqual([])
    expect(h.keychain.values.size).toBe(0)
  })

  it('the quit aborts the running probe: aborted, and config.json is not written for it', async () => {
    const quit = new AbortController()
    const { exchange } = gatedCall()
    const h = await seeded([instance({ id: ID })], { script: [exchange], signal: quit.signal })
    await h.ok('customVendor.update', { id: ID, displayName: 'Vendor' })
    const before = await h.file()
    const running = probe(h)
    await vi.waitFor(() => expect(h.network.callCount).toBe(1))
    quit.abort()
    expect(await running).toEqual({ status: 'refused', code: 'aborted' })
    expect(await h.file()).toBe(before)
  })

  it('a cancel while the result waits for the lock: aborted, nothing stored (§何时「锁内先看 signal.aborted」)', async () => {
    const h = await seeded([instance({ id: ID })], { script: [CALL, ANSWER] })
    // Another write holds the profile's lock — one that leaves the instance's settings alone.
    const held = h.holdNextWrite()
    const choosing = h.ok('provider.select', { providerId: ZHIPU_PROVIDER_ID, modelId: 'glm-4.6' })
    await held.held
    const running = probe(h)
    await vi.waitFor(() => expect(h.network.callCount).toBe(2))
    await settle()
    expect(await h.ok('customVendor.cancelProbe', { id: ID })).toEqual({ cancelled: true })
    held.release()
    expect(await choosing).toEqual({ ok: true })
    expect(await running).toEqual({ status: 'refused', code: 'aborted' })
    expect((await h.config()).customVendors[0]?.models).toEqual([ROW])
  })

  it('a rename while it ran: the result answers, saved: false (§何时「保存」)', async () => {
    const { exchange, gate } = gatedCall()
    const h = await seeded([instance({ id: ID })], { script: [exchange, ANSWER] })
    const running = probe(h)
    await vi.waitFor(() => expect(h.network.callCount).toBe(1))
    expect(await h.ok('customVendor.update', { id: ID, displayName: 'Renamed' })).toEqual({
      ok: true,
    })
    gate.release(CALL_FRAMES.length)
    gate.end()
    expect(await running).toMatchObject({
      status: 'done',
      saved: false,
      snapshot: { outcome: 'passed' },
    })
    expect((await h.config()).customVendors[0]).toEqual(
      instance({ id: ID, displayName: 'Renamed' }),
    )
  })

  it.each([
    ['stored', true],
    ['failed', false],
  ] as const)(
    'M6 不变量 12: a probe begun before a key save keeps nothing — the key %s — and the next probe does',
    async (_outcome, stored) => {
      const h = await seeded([instance({ id: ID, models: [{ ...ROW, probe: PASSED }] })], {
        script: [CALL, ANSWER, CALL, ANSWER],
      })
      const write = h.keychain.holdNextSet()
      const saving = h.call('provider.configure', { id: ID, values: { apiKey: NEW_KEY } })
      await write.held
      // The snapshots are already cleared; the old key is still the stored one.
      expect((await h.config()).customVendors[0]?.models).toEqual([ROW])
      const early = probe(h)
      await vi.waitFor(() => expect(h.network.callCount).toBe(2))
      expect(h.network.requests[0]?.headers['authorization']).toBe(`Bearer ${KEY}`)
      write.release(stored)
      const saved = await saving
      expect(saved.ok).toBe(stored)
      expect(await early).toMatchObject({
        status: 'done',
        saved: false,
        snapshot: { outcome: 'passed' },
      })
      expect((await h.config()).customVendors[0]?.models).toEqual([ROW])

      // A probe begun after the save is the one that stores (and reads the key in force).
      expect(await probe(h)).toMatchObject({ status: 'done', saved: true })
      expect(h.network.requests[2]?.headers['authorization']).toBe(
        `Bearer ${stored ? NEW_KEY : KEY}`,
      )
      expect((await h.config()).customVendors[0]?.models[0]?.probe?.outcome).toBe('passed')
    },
  )

  it('a cancel once the result is being stored answers cancelled: false, and the result is stored (§何时、走哪条路)', async () => {
    const h = await seeded([instance({ id: ID })], { script: [CALL, ANSWER] })
    // The probe's save is the first config.json write: held past its last abort check.
    const write = h.holdNextWrite()
    const running = probe(h)
    await write.held
    expect(await h.ok('customVendor.cancelProbe', { id: ID })).toEqual({ cancelled: false })
    // Still the instance's one probe until the write is done.
    expect(await probe(h)).toEqual({ status: 'refused', code: 'busy' })
    write.release()
    const answer = await running
    expect(answer).toMatchObject({ status: 'done', saved: true, snapshot: { outcome: 'passed' } })
    expect((await h.config()).customVendors[0]?.models[0]?.probe).toEqual(
      answer.status === 'done' ? answer.snapshot : null,
    )
  })

  it('stores on the row and the instance it probed, and nowhere else (§何时、走哪条路「保存」)', async () => {
    const first = instance({ id: ID, models: [ROW, OTHER_ROW] })
    const second = instance({
      id: SECOND_ID,
      displayName: 'Second',
      models: [{ ...ROW, probe: FAILED }, OTHER_ROW],
    })
    const h = await seeded([first, second], { script: [CALL, ANSWER] })
    const answer = await probe(h, OTHER_ROW.id, SECOND_ID)
    if (answer.status !== 'done') throw new Error(`probe answered ${JSON.stringify(answer)}`)
    expect(answer.saved).toBe(true)
    expect((await h.config()).customVendors).toEqual([
      first,
      {
        ...second,
        models: [
          { ...ROW, probe: FAILED },
          { ...OTHER_ROW, probe: answer.snapshot },
        ],
      },
    ])
  })

  it.each([
    ['a packaged build', true, {}, DEFAULT_MAX_TOKENS],
    ['a development build with TENON_MAX_TOKENS', false, { TENON_MAX_TOKENS: '1234' }, 1234],
  ] as const)(
    'asks for the output limit a send of the row would, on %s (§探测 maxTokens)',
    async (_build, isPackaged, env, limit) => {
      const big = { id: MODEL, contextLimit: 200_000, maxOutputTokens: 128_000 }
      const h = await seeded([instance({ id: ID, models: [big] })], {
        script: [CALL, ANSWER],
        isPackaged,
        env,
      })
      const assembly = await h.connector.assemble({
        sessionId: SESSION,
        rootSessionId: SESSION,
        choice: { providerId: ID, modelId: MODEL, effort: null, capabilitySource: 'user' },
        signal: new AbortController().signal,
      })
      expect(assembly.maxTokens).toBe(limit)
      expect(await probe(h)).toMatchObject({ status: 'done', saved: true })
      const asked = h.network.requests.map(
        (request) => (request.body as { max_tokens?: number } | undefined)?.max_tokens,
      )
      expect(asked).toEqual([limit, limit])
    },
  )

  it('a save landing in every read of the key: failed / config, no request, nothing stored; T10’s field carried over', async () => {
    // §结果与原因码「发出之前…读到一半有保存」: probeModel is handed a definition that builds no
    // client, and the kernel keeps the row's learned `maxTokensField` as it does for any probe that
    // ends before the endpoint answered (§两步 T10).
    const h = await seeded([instance({ id: ID, models: [{ ...ROW, probe: FAILED }] })], {
      script: [CALL, ANSWER],
    })
    h.keychain.onGet = (key) => {
      if (key === h.keyOf(ID)) countProviderSettingsWrite(h.host.identity, ID)
    }
    expect(await probe(h)).toMatchObject({
      status: 'done',
      saved: false,
      snapshot: { outcome: 'failed', reason: 'config', maxTokensField: 'max_completion_tokens' },
    })
    expect(h.network.callCount).toBe(0)
    expect((await h.config()).customVendors[0]?.models[0]?.probe).toEqual(FAILED)
  })
})

describe('createProbeRuns (§何时、走哪条路)', () => {
  it.each([
    [['delete', 'cancel']],
    [['cancel', 'delete']],
    [['delete', 'key']],
    [['key', 'delete']],
  ] as const)(
    'a delete outranks the other stop, in either order: %j answers not-found',
    (order) => {
      const runs = createProbeRuns()
      const run = runs.begin(ID, undefined)
      if (run === null) throw new Error('no probe was running')
      for (const why of order) expect(runs.abort(ID, why)).toBe(true)
      expect(run.why).toBe('delete')
      expect(run.signal.aborted).toBe(true)
    },
  )
})

describe('验收 8: no answer carries the key', () => {
  it('every custom vendor route, provider.list and provider.configure answer through their schemas without it', async () => {
    const h = await harness({
      script: [{ kind: 'json', body: { data: [{ id: MODEL }] } }, CALL, ANSWER],
    })
    const answers: unknown[] = []
    const keep = async (channel: string, payload: unknown): Promise<unknown> => {
      const data = await h.ok(channel, payload)
      answers.push(data)
      return data
    }
    const created = (await keep('customVendor.create', {
      displayName: 'Relay',
      wire: 'openai-chat',
      source: { kind: 'custom', baseURL: BASE },
      apiKey: KEY,
    })) as { id: string }
    await keep('customVendor.update', { id: created.id, models: [ROW] })
    await keep('customVendor.fetchModels', { id: created.id })
    await keep('customVendor.probe', { id: created.id, modelId: MODEL })
    await keep('customVendor.cancelProbe', { id: created.id })
    await keep('customVendor.list', {})
    await keep('provider.list', {})
    await keep('provider.configure', { id: created.id, values: { apiKey: NEW_KEY } })
    await keep('provider.list', {})
    await keep('customVendor.delete', { id: created.id })
    const seen = JSON.stringify([answers, h.lines, await h.file()])
    for (const key of [KEY, NEW_KEY]) {
      expect(seen).not.toContain(key)
      expect(seen).not.toContain(key.slice(0, 12))
    }
  })
})
