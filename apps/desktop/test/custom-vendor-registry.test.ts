/**
 * The provider registry main hands out (M6 §注册表视图): the builtins, then the instances of
 * `config.json`'s `customVendors`, made by the kernel's factory from the entry as it stands — and
 * what that means for the three consumers main wires it into (01 修补 6「desktop 接线」): run assembly,
 * provider.list, and through them where a request goes (M6 不变量 3).
 *
 * The rows' marks, `displayName` and `refused` on provider.list are plan step 6's; rebuilding an
 * instance's rows from the settled read in `assemble` is step 7's.
 */
import { randomUUID } from 'node:crypto'
import {
  ANTHROPIC_PROVIDER_ID,
  OLLAMA_PROVIDER_ID,
  ProviderConfigMissingError,
  ProviderInvalidArgumentError,
  ZHIPU_PROVIDER_ID,
  createMemoryHost,
  createProviderRegistry,
  keyFor,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type {
  AbsolutePath,
  HostAdapter,
  ModelInfo,
  Provider,
  ProviderDefinition,
  ProviderRegistry,
  StreamEvent,
} from '@tenon-app/kernel'
import { fakeNetwork } from '@tenon-app/kernel/testing'
import type { FakeNetwork } from '@tenon-app/kernel/testing'
import type { CustomVendorContract, IpcMainLike, ProviderEntryContract } from '@tenon-app/contracts'
import { describe, expect, it } from 'vitest'
import {
  createProviderView,
  instanceDefinition,
  instanceRefusal,
} from '../src/main/custom-vendors/registry.js'
import {
  createCustomVendor,
  deleteCustomVendor,
  updateCustomVendor,
} from '../src/main/custom-vendors/store.js'
import { configPath, readConfig, writeConfig } from '../src/main/host/profile.js'
import { registerProviderRoutes } from '../src/main/provider-routes.js'
import { createRunConnector } from '../src/main/run-assembly.js'

const ID_A = 'custom-0b7e1c5a-3d2f-4e6a-9b8c-1d2e3f4a5b6c'
const ID_B = 'custom-1c8f2d6b-4e3a-4f7b-8c9d-2e3f4a5b6c7d'
const KEY = 'sk-m6-registry-test-41d0'

const ROW = { id: 'deepseek-flash', contextLimit: 128_000, maxOutputTokens: 8_000 }

function entry(over: Partial<CustomVendorContract> & Pick<CustomVendorContract, 'id'>) {
  return {
    displayName: 'Vendor',
    wire: 'openai-chat' as const,
    baseURL: 'https://api.deepseek.com',
    models: [ROW],
    ...over,
  }
}

let profiles = 0

interface Harness {
  readonly host: HostAdapter
  readonly network: FakeNetwork
  readonly view: ProviderRegistry
  /** Moves the host clock forward. */
  advance(ms: number): void
  list(): Promise<ProviderEntryContract[]>
}

/**
 * A profile whose `config.json` holds `file` before main starts, read once the way main reads it
 * at startup, then handed to the view, the routes and the connector.
 */
async function started(file: unknown, network = fakeNetwork([])): Promise<Harness> {
  profiles += 1
  const memory = createMemoryHost({
    identity: { profileDir: `/profiles/user/registry-${profiles}` },
    network,
  })
  await memory.fs.mkdirp(memory.identity.profileDir as AbsolutePath)
  await memory.fs.writeFile(configPath(memory.identity), JSON.stringify(file))
  const host: HostAdapter = memory
  const builtin = createProviderRegistry()
  registerBuiltinProviders(builtin)
  const view = createProviderView({
    builtin,
    identity: host.identity,
    config: await readConfig(host.fs, host.identity),
  })
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
  }
  registerProviderRoutes({ ipcMain, host, providers: view, isPackaged: true, log: () => {} })
  return {
    host,
    network,
    view,
    advance: (ms) => memory.advance(ms),
    async list() {
      const handler = handlers.get('provider.list')
      if (handler === undefined) throw new Error('provider.list is not registered')
      const result = (await handler({}, {})) as { ok: boolean; data: ProviderEntryContract[] }
      expect(result.ok).toBe(true)
      return result.data
    },
  }
}

const frame = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`

/** One short openai-chat answer. */
function answer(): string[] {
  const chunk = (delta: unknown, finish: string | null = null): string =>
    frame({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: ROW.id,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })
  return [chunk({ role: 'assistant', content: 'hi' }), chunk({}, 'stop'), 'data: [DONE]\n\n']
}

/** A new round on `providerId`'s first row, the way the kernel drives the connector. */
async function assembled(h: Harness, providerId: string) {
  const connector = createRunConnector({ host: h.host, providers: h.view, isPackaged: true })
  const assembly = await connector.assemble({
    sessionId: 's',
    rootSessionId: 's',
    choice: { providerId, modelId: ROW.id, effort: null, capabilitySource: 'user' },
    signal: new AbortController().signal,
  })
  return { connector, assembly }
}

async function send(provider: Provider, model: ModelInfo): Promise<StreamEvent[]> {
  const encoded = provider.encode({
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 16,
  })
  const identity = { runId: 'r1', requestSeq: 1, physicalAttempt: 1 }
  // Draining is what sends.
  const events: StreamEvent[] = []
  for await (const event of provider.stream(encoded, { identity })) events.push(event)
  return events
}

describe('M6 §注册表视图', () => {
  it('lists the builtins first and unchanged, then the instances in customVendors order', async () => {
    const h = await started({
      customVendors: [entry({ id: ID_B }), entry({ id: ID_A, displayName: 'Second' })],
    })
    const builtin = createProviderRegistry()
    registerBuiltinProviders(builtin)
    expect(h.view.list().map((definition) => definition.id)).toEqual([
      ANTHROPIC_PROVIDER_ID,
      ZHIPU_PROVIDER_ID,
      OLLAMA_PROVIDER_ID,
      ID_B,
      ID_A,
    ])
    for (const definition of builtin.list()) {
      expect(h.view.get(definition.id)?.builtinModels).toEqual(definition.builtinModels)
    }
    const instance = h.view.get(ID_A)
    expect(instance).toMatchObject({ id: ID_A, wire: 'openai-chat', maxToolsPerRequest: 128 })
    expect(instance?.builtinModels.map((row) => row.id)).toEqual([ROW.id])
    expect(h.view.get('custom-ffffffff-ffff-4fff-8fff-ffffffffffff')).toBeNull()
  })

  it('registers builtin definitions through to the builtin registry, never one under a custom- id', async () => {
    const h = await started({})
    const zhipu = h.view.get(ZHIPU_PROVIDER_ID) as ProviderDefinition
    h.view.register({ ...zhipu, id: 'relay' })
    expect(h.view.list().map((definition) => definition.id)).toContain('relay')
    expect(() => h.view.register({ ...zhipu, id: ID_A })).toThrow(ProviderInvalidArgumentError)
    // Any id under the prefix, not only one an instance could have.
    expect(() => h.view.register({ ...zhipu, id: 'custom-relay' })).toThrow(
      ProviderInvalidArgumentError,
    )
    expect(h.view.get(ID_A)).toBeNull()
  })

  it('lists an entry whose path does not percent-decode, and every other provider with it (§存储)', async () => {
    // A bad entry costs at most itself (验收 11): `%zz` is left as typed, never a throw.
    const odd = 'https://relay.example/v1/%zz'
    const h = await started({
      customVendors: [entry({ id: ID_A, baseURL: odd }), entry({ id: ID_B })],
    })
    const expected = [ANTHROPIC_PROVIDER_ID, ZHIPU_PROVIDER_ID, OLLAMA_PROVIDER_ID, ID_A, ID_B]
    expect(h.view.list().map((definition) => definition.id)).toEqual(expected)
    expect((await h.list()).map((listed) => listed.id)).toEqual(expected)
    expect(h.view.get(ID_B)?.id).toBe(ID_B)
    expect(instanceRefusal(entry({ id: ID_A, baseURL: odd }))).toBeNull()
  })

  it('judges a stored address by §地址校验 rules 1–5 alone, not the length a new one is held to (§存储)', async () => {
    // Within customVendorSchema.baseURL as stored; percent-encoded it would not be, which only a
    // create refuses (store.ts).
    const long = entry({ id: ID_A, baseURL: `https://relay.example/${'é'.repeat(1_500)}` })
    const h = await started({ customVendors: [long] })
    expect(h.view.get(ID_A)?.id).toBe(ID_A)
    expect(instanceRefusal(long)).toBeNull()
  })

  it('follows every create, row change and delete without a restart (验收 3, view part)', async () => {
    const h = await started({ customVendors: [entry({ id: ID_A })] })
    const deps = { host: h.host, log: () => {}, uuid: () => randomUUID() }
    const created = await createCustomVendor(deps, {
      displayName: 'Kimi',
      wire: 'openai-chat',
      source: { kind: 'preset', presetId: 'kimi', regionId: 'cn' },
      apiKey: KEY,
    })
    if (!created.ok) throw new Error(created.code)
    const ids = async () => (await h.list()).map((listed) => listed.id)
    expect(await ids()).toEqual([
      ANTHROPIC_PROVIDER_ID,
      ZHIPU_PROVIDER_ID,
      OLLAMA_PROVIDER_ID,
      ID_A,
      created.id,
    ])

    await updateCustomVendor(deps, {
      id: created.id,
      models: [{ id: 'kimi-k3', contextLimit: 256_000, maxOutputTokens: 32_000 }],
    })
    // The second instance's update leaves the first where it was.
    expect(await ids()).toEqual([
      ANTHROPIC_PROVIDER_ID,
      ZHIPU_PROVIDER_ID,
      OLLAMA_PROVIDER_ID,
      ID_A,
      created.id,
    ])
    expect(h.view.get(created.id)?.builtinModels).toMatchObject([
      { id: 'kimi-k3', providerId: created.id, contextLimit: 256_000, maxOutputTokens: 32_000 },
    ])
    expect((await h.list()).find((listed) => listed.id === created.id)?.models).toMatchObject([
      { id: 'kimi-k3' },
    ])

    expect(await deleteCustomVendor(deps, ID_A)).toEqual({ ok: true })
    expect(await ids()).toEqual([
      ANTHROPIC_PROVIDER_ID,
      ZHIPU_PROVIDER_ID,
      OLLAMA_PROVIDER_ID,
      created.id,
    ])
    expect(h.view.get(ID_A)).toBeNull()
  })

  it('requires a key of a public instance only (§key)', () => {
    const required = (baseURL: string): boolean | undefined =>
      instanceDefinition(entry({ id: ID_A, baseURL })).configKeys.find(
        (key) => key.name === 'apiKey',
      )?.required
    expect(required('https://api.deepseek.com')).toBe(true)
    expect(required('http://127.0.0.1:8000/v1')).toBe(false)
    expect(required('http://192.168.1.20/v1')).toBe(false)
    // A refused public http address stays public.
    expect(required('http://api.example.com/v1')).toBe(true)
  })

  it('keeps a passing snapshot whatever time has passed (T3; 验收 10)', async () => {
    const passed = {
      outcome: 'passed' as const,
      reason: null,
      probedAt: 0,
      reasoningField: null,
      maxTokensField: 'max_tokens' as const,
      usageSeen: true,
      responseModelId: null,
      unknownFields: [],
    }
    const h = await started({
      customVendors: [entry({ id: ID_A, models: [{ ...ROW, probe: passed }] })],
    })
    h.advance(10 * 365 * 24 * 3_600_000)
    expect(h.view.get(ID_A)?.builtinModels[0]?.supportsToolCalling).toBe(true)
  })
})

describe('M6 不变量 3: an instance sends to its own address, whatever providerConfig says', () => {
  it('ignores a hand-written providerConfig.baseURL: request host, provider.list endpoint, endpointOrigin', async () => {
    const network = fakeNetwork({ kind: 'sse', frames: answer() })
    const h = await started(
      {
        provider: { id: ID_A, modelId: ROW.id },
        providerConfig: { [ID_A]: { baseURL: 'https://elsewhere.example/v1' } },
        customVendors: [entry({ id: ID_A })],
      },
      network,
    )
    await h.host.secrets.set(keyFor(h.host.identity, 'provider', ID_A, 'apiKey'), KEY)

    const listed = (await h.list()).find((candidate) => candidate.id === ID_A)
    expect(listed?.endpoint).toEqual({ host: 'api.deepseek.com', reach: 'public' })
    expect(listed?.configured).toBe(true)
    const { connector, assembly } = await assembled(h, ID_A)
    expect(connector.endpointOrigin(ID_A)).toBe('https://api.deepseek.com')
    expect(assembly.endpointOrigin).toBe('https://api.deepseek.com')
    expect((await send(assembly.provider(), assembly.model)).at(-1)).toMatchObject({ type: 'stop' })
    expect(network.requests.map((request) => new URL(request.url).host)).toEqual([
      'api.deepseek.com',
    ])
    expect(network.requests[0]?.headers['authorization']).toBe(`Bearer ${KEY}`)
  })

  it('drops providerConfig under an instance id from a write too: endpointOrigin and config.json', async () => {
    // Whichever route writes it, the entry reaches neither the file nor the snapshot the synchronous
    // endpointOrigin answers from (run-assembly's `stored`, fed by every write).
    const h = await started({ customVendors: [entry({ id: ID_A })] })
    const connector = createRunConnector({ host: h.host, providers: h.view, isPackaged: true })
    await writeConfig(h.host.fs, h.host.identity, {
      providerConfig: { [ID_A]: { baseURL: 'https://elsewhere.example/v1' } },
    })
    expect(connector.endpointOrigin(ID_A)).toBe('https://api.deepseek.com')
    const file = await h.host.fs.readFile(configPath(h.host.identity), { encoding: 'utf8' })
    expect(file).not.toContain('elsewhere')
  })

  it('sends nothing to an address that fails §地址校验, a hand-edited public http:// included', async () => {
    const refused: [CustomVendorContract, string][] = [
      [entry({ id: ID_A, baseURL: 'http://api.example.com/v1' }), 'https-required'],
      [entry({ id: ID_A, baseURL: 'https://api.example.com/v1?x=1' }), 'invalid-address'],
      [
        entry({ id: ID_A, baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' }),
        'subscription-endpoint',
      ],
      [
        entry({ id: ID_A, wire: 'anthropic-messages', baseURL: 'https://api.example.com/v1' }),
        'invalid-address',
      ],
    ]
    for (const [stored, code] of refused) {
      const network = fakeNetwork([])
      // oxlint-disable-next-line no-await-in-loop -- one profile per refused address
      const h = await started({ customVendors: [stored] }, network)
      // oxlint-disable-next-line no-await-in-loop -- the same case
      await h.host.secrets.set(keyFor(h.host.identity, 'provider', ID_A, 'apiKey'), KEY)
      expect(instanceRefusal(stored)).toEqual({ code })
      // Listed, its rows answering — only building a client is refused.
      const definition = h.view.get(ID_A)
      expect(definition?.builtinModels.map((row) => row.id)).toEqual([ROW.id])
      expect(() =>
        definition?.create({
          network,
          clock: { now: () => 0, setTimeout: () => () => {} },
          config: {},
          secrets: { apiKey: KEY },
        }),
      ).toThrow(ProviderConfigMissingError)
      // oxlint-disable-next-line no-await-in-loop -- the same case
      const { assembly } = await assembled(h, ID_A)
      expect(() => assembly.provider()).toThrow(ProviderConfigMissingError)
      expect(network.callCount).toBe(0)
    }
  })
})
