/**
 * Writing custom vendor instances (M6 §写入规则, §key, §地址校验): create, rename and change rows,
 * delete, save the key. Every write is driven through a failure at each of its steps — the keychain
 * write, the keychain delete, the `config.json` write — and judged by the state it leaves: which keys
 * the keychain holds, what `config.json` says, what was logged. A failed `config.json` write here is
 * one refused before any byte reaches the file (see `failWrites`); one that fails partway on the real
 * disk is config-replace.test.ts's.
 *
 * The keychain here is a fake that can fail on demand; nothing touches the OS keychain or a real
 * profile directory.
 */
import { randomUUID } from 'node:crypto'
import {
  CUSTOM_PROVIDER_ID_PATTERN,
  ZHIPU_PROVIDER_ID,
  createMemoryHost,
  createProviderRegistry,
  keyFor,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type {
  AbsolutePath,
  HostAdapter,
  HostFs,
  HostSecrets,
  ProviderRegistry,
} from '@tenon-app/kernel'
import type {
  Config,
  CustomVendorContract,
  IpcMainLike,
  ProviderEntryContract,
} from '@tenon-app/contracts'
import { describe, expect, it } from 'vitest'
import { createProviderView } from '../src/main/custom-vendors/registry.js'
import {
  createCustomVendor,
  deleteCustomVendor,
  saveCustomVendorKey,
  updateCustomVendor,
} from '../src/main/custom-vendors/store.js'
import type { CreateRequest, CreateResult } from '../src/main/custom-vendors/store.js'
import {
  configPath,
  providerSettingsGeneration,
  readConfig,
  writeConfig,
} from '../src/main/host/profile.js'
import { registerProviderRoutes } from '../src/main/provider-routes.js'

/** A keychain that fails the next set or delete on demand, and says what it holds. */
class FakeKeychain implements HostSecrets {
  readonly values = new Map<string, string>()
  failing: 'set' | 'delete' | 'both' | null = null
  /** Runs inside every successful `set`, before the value is stored. */
  onSet: (() => void) | null = null

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    if (this.failing === 'set' || this.failing === 'both') throw new Error('keychain locked')
    this.onSet?.()
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    if (this.failing === 'delete' || this.failing === 'both') throw new Error('keychain locked')
    this.values.delete(key)
  }
}

interface Harness {
  readonly host: HostAdapter
  readonly keychain: FakeKeychain
  readonly lines: string[]
  readonly deps: { host: HostAdapter; log: (line: string) => void; uuid: () => string }
  readonly view: ProviderRegistry
  /**
   * Every `writeFile` rejects while true, the way a refusal at open does (EACCES): before any byte
   * reaches the file, so the file stays as it was. A write that fails partway (disk full) is
   * config-replace.test.ts's, on the real disk.
   */
  failWrites: boolean
  /**
   * Holds the next `writeFile` before any byte reaches the file: `held` settles once a write is
   * waiting there, `release` lets it through.
   */
  holdNextWrite(): { held: Promise<void>; release: () => void }
  /** `config.json` as it is on disk, or null before the first write. */
  file(): Promise<string | null>
  config(): Promise<Config>
  keyOf(id: string): string
  /** provider.list as the settings card receives it. */
  list(): Promise<ProviderEntryContract[]>
}

let profiles = 0

async function harness(): Promise<Harness> {
  // A profile of its own: the config lock, the generations and the watchers are per profile.
  profiles += 1
  const memory = createMemoryHost({ identity: { profileDir: `/profiles/user/store-${profiles}` } })
  await memory.fs.mkdirp(memory.identity.profileDir as AbsolutePath)
  const keychain = new FakeKeychain()
  const state = { failWrites: false }
  let hold: { reached: () => void; gate: Promise<void> } | null = null
  const fs: HostFs = {
    readFile: (path, opts) => memory.fs.readFile(path, opts),
    writeFile: async (path, data) => {
      if (state.failWrites) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
          code: 'EACCES',
        })
      }
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
  const host: HostAdapter = { ...memory, fs, secrets: keychain }
  const lines: string[] = []
  const builtin = createProviderRegistry()
  registerBuiltinProviders(builtin)
  const view = createProviderView({ builtin, identity: host.identity })
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
  }
  registerProviderRoutes({ ipcMain, host, providers: view, log: (line) => lines.push(line) })
  return {
    host,
    keychain,
    lines,
    deps: { host, log: (line) => lines.push(line), uuid: () => randomUUID() },
    view,
    get failWrites() {
      return state.failWrites
    },
    set failWrites(value: boolean) {
      state.failWrites = value
    },
    holdNextWrite() {
      const reached = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      hold = { reached: reached.resolve, gate: gate.promise }
      return { held: reached.promise, release: gate.resolve }
    },
    async file() {
      const path = configPath(host.identity)
      if ((await memory.fs.stat(path)) === null) return null
      return (await memory.fs.readFile(path, { encoding: 'utf8' })) as string
    },
    config: () => readConfig(host.fs, host.identity, (line) => lines.push(line)),
    keyOf: (id) => keyFor(host.identity, 'provider', id, 'apiKey'),
    async list() {
      const handler = handlers.get('provider.list')
      if (handler === undefined) throw new Error('provider.list is not registered')
      const result = (await handler({}, {})) as { ok: boolean; data: ProviderEntryContract[] }
      expect(result.ok).toBe(true)
      return result.data
    },
  }
}

const KEY = 'sk-m6-store-test-7c1e9a'
const OTHER_KEY = 'sk-m6-store-other-3b5d'

function custom(baseURL: string, apiKey = KEY, wire: CreateRequest['wire'] = 'openai-chat') {
  return { displayName: 'Relay', wire, source: { kind: 'custom' as const, baseURL }, apiKey }
}

async function created(h: Harness, request: CreateRequest = custom('https://relay.example/v1')) {
  const result = await createCustomVendor(h.deps, request)
  if (!result.ok) throw new Error(`create refused: ${result.code}`)
  return result.id
}

/** M6 不变量 13: every key the keychain holds belongs to an instance `config.json` lists. */
async function everyKeyBelongsToAnInstance(h: Harness): Promise<void> {
  const owned = new Set((await h.config()).customVendors.map((entry) => h.keyOf(entry.id)))
  const builtin = keyFor(h.host.identity, 'provider', ZHIPU_PROVIDER_ID, 'apiKey')
  const strays = [...h.keychain.values.keys()].filter((key) => key !== builtin && !owned.has(key))
  expect(strays).toEqual([])
}

const PASSED = {
  outcome: 'passed' as const,
  reason: null,
  probedAt: 1,
  reasoningField: 'reasoning_content' as const,
  maxTokensField: 'max_tokens' as const,
  usageSeen: true,
  responseModelId: 'model-a',
  unknownFields: [],
}

/** A row with the same limits as every other `plainRow`, never probed. */
function plainRow(modelId: string) {
  return { id: modelId, contextLimit: 64_000, maxOutputTokens: 8_000 }
}

/** An instance's rows, written the way a probe's save will write them. */
async function withRows(
  h: Harness,
  id: string,
  models: CustomVendorContract['models'],
): Promise<void> {
  const config = await h.config()
  const index = config.customVendors.findIndex((entry) => entry.id === id)
  const entry = config.customVendors[index]
  if (entry === undefined) throw new Error(`no instance ${id}`)
  await writeConfig(h.host.fs, h.host.identity, {
    customVendors: config.customVendors.with(index, { ...entry, models }),
  })
}

/** An instance whose two rows were probed and passed. */
function probed(h: Harness, id: string): Promise<void> {
  return withRows(h, id, [
    { id: 'model-a', contextLimit: 128_000, maxOutputTokens: 8_000, probe: PASSED },
    { id: 'model-b', contextLimit: 64_000, maxOutputTokens: 4_000, probe: PASSED },
  ])
}

describe('customVendor.create (M6 §写入规则「新建」)', () => {
  it('mints custom-<uuid>, stores the trimmed key under the instance, the normalised address in config.json', async () => {
    // 验收 1 (the minting half), T1. A key pasted with blanks around it is stored without them.
    const h = await harness()
    const id = await created(h, custom(' https://Relay.example/v1/ ', ` ${KEY}\n`))
    expect(id).toMatch(CUSTOM_PROVIDER_ID_PATTERN)
    expect((await h.config()).customVendors).toEqual([
      {
        id,
        displayName: 'Relay',
        wire: 'openai-chat',
        baseURL: 'https://relay.example/v1',
        models: [],
      },
    ])
    expect([...h.keychain.values]).toEqual([[`tenant:provider:${id}:apiKey`, KEY]])

    // A preset: main looks the address up, and records the preset it came from.
    const second = await createCustomVendor(h.deps, {
      displayName: ' MiniMax ',
      wire: 'anthropic-messages',
      source: { kind: 'preset', presetId: 'minimax', regionId: 'global' },
      apiKey: OTHER_KEY,
    })
    if (!second.ok) throw new Error(second.code)
    expect(second.id).not.toBe(id)
    expect((await h.config()).customVendors[1]).toEqual({
      id: second.id,
      displayName: 'MiniMax',
      wire: 'anthropic-messages',
      baseURL: 'https://api.minimax.io/anthropic',
      presetId: 'minimax',
      models: [],
    })
  })

  it('refuses every §地址校验 failure, a missing preset address and a public instance without a key, writing nothing', async () => {
    // 验收 4.
    const h = await harness()
    const cases: [CreateRequest, string][] = [
      [custom('http://relay.example/v1'), 'https-required'],
      [custom('https://user:pw@relay.example/v1'), 'invalid-address'],
      [custom('https://relay.example/v1?tenant=a'), 'invalid-address'],
      [custom('https://relay.example/v1#top'), 'invalid-address'],
      [custom('https://relay.example/anthropic/v1', KEY, 'anthropic-messages'), 'invalid-address'],
      [custom('https://open.bigmodel.cn/api/coding/paas/v4'), 'subscription-endpoint'],
      [custom('relay.example/v1'), 'invalid-address'],
      [
        { ...custom(''), source: { kind: 'preset', presetId: 'nope', regionId: 'cn' } },
        'invalid-address',
      ],
      [
        { ...custom(''), source: { kind: 'preset', presetId: 'kimi', regionId: 'eu' } },
        'invalid-address',
      ],
      [
        {
          ...custom('', KEY, 'anthropic-messages'),
          source: { kind: 'preset', presetId: 'ark', regionId: 'cn-beijing' },
        },
        'invalid-address',
      ],
      [custom('https://relay.example/v1', ' \t '), 'key-required'],
      // 1 514 characters typed, within the schema; percent-encoded, the path alone is 9 000, and the
      // next read would drop what was stored.
      [custom(`https://relay.example/${'é'.repeat(1_500)}`), 'invalid-address'],
    ]
    const results = await Promise.all(cases.map(([request]) => createCustomVendor(h.deps, request)))
    expect(results).toEqual(cases.map(([, code]) => ({ ok: false, code })))
    expect(h.keychain.values.size).toBe(0)
    expect(await h.file()).toBeNull()
  })

  it('creates a loopback or private instance without a key, storing none; a typed one is stored', async () => {
    // 验收 4: a loopback or private http address is accepted; §key: its key is optional, and only
    // a blank one is skipped (§IPC) — 「私网服务可能真要 key」.
    const h = await harness()
    const local = await created(h, custom('http://127.0.0.1:8000/v1', '   '))
    const lan = await created(h, custom('http://gpu-box.lan/anthropic', '', 'anthropic-messages'))
    expect((await h.config()).customVendors.map((entry) => entry.id)).toEqual([local, lan])
    expect(h.keychain.values.size).toBe(0)
    const keyed = await created(h, custom('http://gpu-box.lan/v1', KEY))
    expect(h.keychain.values.get(h.keyOf(keyed))).toBe(KEY)
  })

  it('never reuses an id: a UUID source that draws a held one fails the create, changing nothing (T1)', async () => {
    const h = await harness()
    const fixed = randomUUID()
    const deps = { ...h.deps, uuid: () => fixed }
    expect(await createCustomVendor(deps, custom('https://relay.example/v1'))).toEqual({
      ok: true,
      id: `custom-${fixed}`,
    })
    const before = await h.file()
    await expect(
      createCustomVendor(deps, custom('https://two.example/v1', OTHER_KEY)),
    ).rejects.toThrow('unusable instance id')
    expect(await h.file()).toBe(before)
    // The held instance's key is still the one typed for it, not the second vendor's.
    expect([...h.keychain.values]).toEqual([[h.keyOf(`custom-${fixed}`), KEY]])
  })

  it('M6 不变量 13: a failed key write or config write leaves no key outside an instance', async () => {
    const h = await harness()
    const kept = await created(h)
    const before = await h.file()

    // The keychain refuses: nothing changed.
    h.keychain.failing = 'set'
    expect(await createCustomVendor(h.deps, custom('https://two.example/v1'))).toEqual({
      ok: false,
      code: 'keychain',
    })
    h.keychain.failing = null
    expect(await h.file()).toBe(before)
    expect([...h.keychain.values.keys()]).toEqual([h.keyOf(kept)])

    // config.json refuses: the key just written is deleted again, the failure goes up, and the id it
    // would have had counts no change of settings.
    const fixed = randomUUID()
    const unsaved = `custom-${fixed}`
    const generation = providerSettingsGeneration(h.host.identity, unsaved)
    h.failWrites = true
    await expect(
      createCustomVendor({ ...h.deps, uuid: () => fixed }, custom('https://two.example/v1')),
    ).rejects.toThrow('EACCES')
    expect([...h.keychain.values.keys()]).toEqual([h.keyOf(kept)])
    expect(providerSettingsGeneration(h.host.identity, unsaved)).toBe(generation)

    // Both refuse: one log line naming the id only, and an orphan under an id config.json does not
    // hold and the next create does not mint.
    h.keychain.onSet = () => {
      h.keychain.failing = 'delete'
    }
    await expect(createCustomVendor(h.deps, custom('https://two.example/v1'))).rejects.toThrow(
      'EACCES',
    )
    h.failWrites = false
    h.keychain.failing = null
    h.keychain.onSet = null
    expect(await h.file()).toBe(before)
    const orphans = [...h.keychain.values.keys()].filter((key) => key !== h.keyOf(kept))
    expect(orphans).toHaveLength(1)
    const orphan = orphans[0]?.split(':')[2] ?? ''
    expect(orphan).toMatch(CUSTOM_PROVIDER_ID_PATTERN)
    expect(h.lines).toHaveLength(2)
    expect(h.lines[1]).toContain(orphan)
    expect(h.lines.join('\n')).not.toMatch(/two\.example|sk-m6/)
    const next = await created(h, custom('https://two.example/v1', OTHER_KEY))
    expect(next).not.toBe(orphan)
    expect(h.view.get(orphan)).toBeNull()
  })
})

describe('customVendor.update (M6 §写入规则「改名与模型」)', () => {
  it('keeps a kept row with its snapshot, clears one whose output limit changed, drops a removed one and the defaults naming it', async () => {
    const h = await harness()
    const id = await created(h)
    const other = await created(h, custom('https://other.example/v1', OTHER_KEY))
    await probed(h, id)
    const selection = (modelId: string) => ({ id, modelId })
    await writeConfig(h.host.fs, h.host.identity, {
      provider: selection('model-b'),
      // Another instance's row of the removed row's id is not this instance's row.
      defaultModelByProfile: {
        chat: selection('model-a'),
        cowork: { id: other, modelId: 'model-b' },
      },
    })
    const generation = providerSettingsGeneration(h.host.identity, id)
    const untouched = providerSettingsGeneration(h.host.identity, other)

    expect(
      await updateCustomVendor(h.deps, {
        id,
        displayName: ' Renamed ',
        models: [
          // The context limit is not what the probe measured against; the snapshot stays.
          { id: 'model-a', contextLimit: 100_000, maxOutputTokens: 8_000 },
          // In removed model-b's place with model-b's output limit: a new id, so no snapshot.
          { id: 'model-c', contextLimit: 32_000, maxOutputTokens: 4_000 },
        ],
      }),
    ).toEqual({ ok: true })
    const config = await h.config()
    expect(config.customVendors[0]).toMatchObject({
      id,
      displayName: 'Renamed',
      baseURL: 'https://relay.example/v1',
      models: [
        { id: 'model-a', contextLimit: 100_000, maxOutputTokens: 8_000, probe: PASSED },
        { id: 'model-c', contextLimit: 32_000, maxOutputTokens: 4_000 },
      ],
    })
    expect(config.customVendors[0]?.models[1]).not.toHaveProperty('probe')
    // model-b is gone and the default that named it with it; the one naming model-a stays, and so
    // does the other instance's.
    expect(config.provider).toBeNull()
    expect(config.defaultModelByProfile).toEqual({
      chat: selection('model-a'),
      cowork: { id: other, modelId: 'model-b' },
    })
    expect(providerSettingsGeneration(h.host.identity, id)).toBe(generation + 1)
    expect(providerSettingsGeneration(h.host.identity, other)).toBe(untouched)

    // A changed output limit clears that row's snapshot (推出的读法 20).
    await updateCustomVendor(h.deps, {
      id,
      models: [{ id: 'model-a', contextLimit: 100_000, maxOutputTokens: 4_000 }],
    })
    expect((await h.config()).customVendors[0]?.models).toEqual([
      { id: 'model-a', contextLimit: 100_000, maxOutputTokens: 4_000 },
    ])
    // The view follows: the row is text only again.
    expect(h.view.get(id)?.builtinModels[0]?.supportsToolCalling).toBe(false)
  })

  it("finds a kept row's snapshot by its id wherever the row moves; a new row in another's place has none", async () => {
    const h = await harness()
    const id = await created(h)
    const ofA = { ...PASSED, probedAt: 1, responseModelId: 'model-a' }
    const ofB = { ...PASSED, probedAt: 2, responseModelId: 'model-b' }
    await withRows(h, id, [
      { ...plainRow('model-a'), probe: ofA },
      { ...plainRow('model-b'), probe: ofB },
    ])
    const models = async () => (await h.config()).customVendors[0]?.models

    await updateCustomVendor(h.deps, { id, models: [plainRow('model-b'), plainRow('model-a')] })
    expect(await models()).toEqual([
      { ...plainRow('model-b'), probe: ofB },
      { ...plainRow('model-a'), probe: ofA },
    ])

    // A new id first, in kept model-b's place and with its limits: never probed, so text only.
    await updateCustomVendor(h.deps, { id, models: [plainRow('model-c'), plainRow('model-a')] })
    expect(await models()).toEqual([plainRow('model-c'), { ...plainRow('model-a'), probe: ofA }])
    expect((await models())?.[0]).not.toHaveProperty('probe')
    expect(h.view.get(id)?.builtinModels.map((info) => info.supportsToolCalling)).toEqual([
      false,
      true,
    ])
  })

  it('changes only what it is given: a rename keeps rows, snapshots and defaults; a row change keeps the name', async () => {
    // T2: the name and the rows, nothing else — the preset it came from, its wire and address
    // stay through a rename, a row change and a key save.
    const h = await harness()
    const id = await created(h, {
      displayName: 'MiniMax',
      wire: 'anthropic-messages',
      source: { kind: 'preset', presetId: 'minimax', regionId: 'global' },
      apiKey: KEY,
    })
    const origin = {
      presetId: 'minimax',
      wire: 'anthropic-messages',
      baseURL: 'https://api.minimax.io/anthropic',
    }
    await probed(h, id)
    await writeConfig(h.host.fs, h.host.identity, {
      provider: { id, modelId: 'model-b' },
      defaultModelByProfile: { chat: { id, modelId: 'model-a' } },
    })
    const before = await h.config()
    expect(before.customVendors[0]).toMatchObject(origin)

    expect(await updateCustomVendor(h.deps, { id, displayName: 'Renamed' })).toEqual({ ok: true })
    const renamed = await h.config()
    expect(renamed.customVendors).toEqual([{ ...before.customVendors[0], displayName: 'Renamed' }])
    expect(renamed.provider).toEqual(before.provider)
    expect(renamed.defaultModelByProfile).toEqual(before.defaultModelByProfile)

    await updateCustomVendor(h.deps, {
      id,
      models: [{ id: 'model-a', contextLimit: 128_000, maxOutputTokens: 8_000 }],
    })
    const changed = (await h.config()).customVendors[0]
    expect(changed).toMatchObject({ ...origin, displayName: 'Renamed' })
    // model-a kept its output limit and so its snapshot: the key save below writes config.json.
    expect(changed?.models[0]?.probe).toEqual(PASSED)

    expect(await saveCustomVendorKey(h.deps, id, OTHER_KEY)).toEqual({ ok: true })
    const saved = (await h.config()).customVendors[0]
    expect(saved).toMatchObject({ ...origin, displayName: 'Renamed' })
    expect(saved?.models.some((row) => 'probe' in row)).toBe(false)
  })

  it('updates the instance it names: the others keep their entries and their places', async () => {
    const h = await harness()
    const a = await created(h)
    const b = await created(h, custom('https://other.example/v1', OTHER_KEY))
    await probed(h, a)
    const first = (await h.config()).customVendors[0]

    expect(
      await updateCustomVendor(h.deps, { id: b, displayName: 'B2', models: [plainRow('model-z')] }),
    ).toEqual({ ok: true })
    const after = (await h.config()).customVendors
    expect(after.map((entry) => entry.id)).toEqual([a, b])
    expect(after[0]).toEqual(first)
    expect(after[1]).toMatchObject({ displayName: 'B2', models: [plainRow('model-z')] })
    await everyKeyBelongsToAnInstance(h)
  })

  it('refuses an unknown instance, and a failed config write changes nothing', async () => {
    const h = await harness()
    const id = await created(h)
    await probed(h, id)
    const before = await h.file()
    const generation = providerSettingsGeneration(h.host.identity, id)
    expect(
      await updateCustomVendor(h.deps, { id: 'custom-00000000-0000-4000-8000-000000000000' }),
    ).toEqual({ ok: false, code: 'not-found' })
    h.failWrites = true
    await expect(
      updateCustomVendor(h.deps, { id, displayName: 'Other', models: [] }),
    ).rejects.toThrow('EACCES')
    h.failWrites = false
    expect(await h.file()).toBe(before)
    // Not counted: a probe that began before it may still keep what it read.
    expect(providerSettingsGeneration(h.host.identity, id)).toBe(generation)
  })

  it('counts a change of the settings once config.json holds it, and never before', async () => {
    // profile.ts's rule for `configGeneration`, which a probe's save and assemble's settled read
    // compare by (推出的读法 20): a reader that saw the old generation must not read the old entry.
    const h = await harness()
    const id = await created(h)
    const generation = providerSettingsGeneration(h.host.identity, id)
    const { held, release } = h.holdNextWrite()
    const update = updateCustomVendor(h.deps, { id, displayName: 'Renamed' })
    await held
    expect(providerSettingsGeneration(h.host.identity, id)).toBe(generation)
    release()
    expect(await update).toEqual({ ok: true })
    expect(providerSettingsGeneration(h.host.identity, id)).toBe(generation + 1)
    expect((await h.config()).customVendors[0]?.displayName).toBe('Renamed')
  })
})

describe('customVendor.delete (M6 §写入规则「删除」, T8)', () => {
  it('removes the key and the entry and the defaults naming it; other instances and builtins untouched (验收 9)', async () => {
    const h = await harness()
    const zhipuKey = keyFor(h.host.identity, 'provider', ZHIPU_PROVIDER_ID, 'apiKey')
    await h.host.secrets.set(zhipuKey, OTHER_KEY)
    const gone = await created(h)
    const kept = await created(h, custom('https://other.example/v1', OTHER_KEY))
    const keptEntry = (await h.config()).customVendors[1]
    await writeConfig(h.host.fs, h.host.identity, {
      provider: { id: gone, modelId: 'model-a' },
      defaultModelByProfile: {
        chat: { id: gone, modelId: 'model-a' },
        cowork: { id: ZHIPU_PROVIDER_ID, modelId: 'glm-5.3' },
      },
    })

    expect(await deleteCustomVendor(h.deps, gone)).toEqual({ ok: true })
    const config = await h.config()
    expect(config.customVendors).toEqual([keptEntry])
    expect(config.provider).toBeNull()
    expect(config.defaultModelByProfile).toEqual({
      cowork: { id: ZHIPU_PROVIDER_ID, modelId: 'glm-5.3' },
    })
    expect(new Map(h.keychain.values)).toEqual(
      new Map([
        [zhipuKey, OTHER_KEY],
        [h.keyOf(kept), OTHER_KEY],
      ]),
    )
    expect(h.view.get(gone)).toBeNull()
    expect((await h.list()).map((entry) => entry.id)).toEqual([
      'anthropic',
      'zhipu',
      'ollama',
      kept,
    ])
    expect(await deleteCustomVendor(h.deps, gone)).toEqual({ ok: false, code: 'not-found' })
  })

  it('deletes the key without reading it: a keychain that cannot read still loses it (验收 9)', async () => {
    // 「先删钥匙串里该实例声明的每个机密键，不看读出了什么」.
    const h = await harness()
    const id = await created(h)
    h.keychain.get = () => Promise.reject(new Error('access denied'))
    expect(await deleteCustomVendor(h.deps, id)).toEqual({ ok: true })
    expect(h.keychain.values.has(h.keyOf(id))).toBe(false)
    expect((await h.config()).customVendors).toEqual([])
  })

  it('M6 不变量 13: a failed key delete refuses the whole delete; a failed config write leaves no key behind', async () => {
    const h = await harness()
    const id = await created(h)
    const before = await h.file()
    h.keychain.failing = 'delete'
    expect(await deleteCustomVendor(h.deps, id)).toEqual({ ok: false, code: 'keychain' })
    h.keychain.failing = null
    expect(await h.file()).toBe(before)
    expect(h.keychain.values.get(h.keyOf(id))).toBe(KEY)

    // The key is gone first, so the entry that stays reads as not configured — never 「条目已删、
    // key 还在」.
    const generation = providerSettingsGeneration(h.host.identity, id)
    h.failWrites = true
    await expect(deleteCustomVendor(h.deps, id)).rejects.toThrow('EACCES')
    h.failWrites = false
    expect(await h.file()).toBe(before)
    expect(providerSettingsGeneration(h.host.identity, id)).toBe(generation)
    expect(h.keychain.values.size).toBe(0)
    await everyKeyBelongsToAnInstance(h)
    expect((await h.list()).find((entry) => entry.id === id)?.configured).toBe(false)
    expect(h.lines.join('\n')).not.toMatch(/relay\.example|sk-m6/)
  })
})

describe("saving an instance's key (M6 §写入规则「保存实例的 key」, T3)", () => {
  it('clears every snapshot first, stores the key, then counts the save (验收 10, M6 不变量 12)', async () => {
    const h = await harness()
    // The key saved is the second instance's: the first keeps its entry, snapshots included.
    const other = await created(h, custom('https://other.example/v1', OTHER_KEY))
    const id = await created(h)
    await probed(h, other)
    await probed(h, id)
    const otherBefore = (await h.config()).customVendors[0]
    expect(h.view.get(id)?.builtinModels.every((row) => row.supportsToolCalling)).toBe(true)
    // What a probe that began just before the keychain write would have read.
    let read = -1
    h.keychain.onSet = () => {
      read = providerSettingsGeneration(h.host.identity, id)
    }

    expect(await saveCustomVendorKey(h.deps, id, ` ${OTHER_KEY} `)).toEqual({ ok: true })
    const config = await h.config()
    expect(config.customVendors.map((entry) => entry.id)).toEqual([other, id])
    expect(config.customVendors[0]).toEqual(otherBefore)
    expect(config.customVendors[1]?.models.map((row) => row.probe)).toEqual([undefined, undefined])
    expect(h.keychain.values.get(h.keyOf(id))).toBe(OTHER_KEY)
    expect(h.view.get(id)?.builtinModels.some((row) => row.supportsToolCalling)).toBe(false)
    expect(providerSettingsGeneration(h.host.identity, id)).toBe(read + 1)
  })

  it('clears a failed snapshot as well as a passed one, with rows never probed beside them (验收 10)', async () => {
    const h = await harness()
    const id = await created(h)
    const failed = {
      ...PASSED,
      outcome: 'failed' as const,
      reason: 'auth' as const,
      reasoningField: null,
      usageSeen: false,
      responseModelId: null,
    }
    await withRows(h, id, [
      { id: 'model-a', contextLimit: 128_000, maxOutputTokens: 8_000, probe: PASSED },
      { id: 'model-b', contextLimit: 64_000, maxOutputTokens: 4_000, probe: failed },
      { id: 'model-c', contextLimit: 32_000, maxOutputTokens: 2_000 },
    ])
    expect(await saveCustomVendorKey(h.deps, id, OTHER_KEY)).toEqual({ ok: true })
    const models = (await h.config()).customVendors[0]?.models
    expect(models?.map((row) => row.probe)).toEqual([undefined, undefined, undefined])
    expect(models?.some((row) => 'probe' in row)).toBe(false)
    expect(h.view.get(id)?.builtinModels.some((row) => row.supportsToolCalling)).toBe(false)
  })

  it('a failed key write stops with the snapshots cleared and the old key in place, and still counts', async () => {
    const h = await harness()
    const id = await created(h)
    await probed(h, id)
    h.keychain.failing = 'set'
    const generation = providerSettingsGeneration(h.host.identity, id)
    await expect(saveCustomVendorKey(h.deps, id, OTHER_KEY)).rejects.toThrow('keychain locked')
    expect((await h.config()).customVendors[0]?.models.every((row) => !('probe' in row))).toBe(true)
    expect(h.keychain.values.get(h.keyOf(id))).toBe(KEY)
    expect(h.view.get(id)?.builtinModels.some((row) => row.supportsToolCalling)).toBe(false)
    // One for the cleared snapshots, one for the keychain write, failed or not.
    expect(providerSettingsGeneration(h.host.identity, id)).toBe(generation + 2)

    // Clearing the key: a failed delete is the same — and with no snapshot left, only the count.
    h.keychain.failing = 'delete'
    await expect(saveCustomVendorKey(h.deps, id, '  ')).rejects.toThrow('keychain locked')
    expect(providerSettingsGeneration(h.host.identity, id)).toBe(generation + 3)
    h.keychain.failing = null
    expect(await saveCustomVendorKey(h.deps, id, '  ')).toEqual({ ok: true })
    expect(h.keychain.values.has(h.keyOf(id))).toBe(false)
  })

  it('a failed config write leaves the key and the snapshots as they were', async () => {
    const h = await harness()
    const id = await created(h)
    await probed(h, id)
    const before = await h.file()
    const generation = providerSettingsGeneration(h.host.identity, id)
    h.failWrites = true
    await expect(saveCustomVendorKey(h.deps, id, OTHER_KEY)).rejects.toThrow('EACCES')
    h.failWrites = false
    expect(await h.file()).toBe(before)
    expect(h.keychain.values.get(h.keyOf(id))).toBe(KEY)
    expect(providerSettingsGeneration(h.host.identity, id)).toBe(generation)
    expect(
      await saveCustomVendorKey(h.deps, 'custom-00000000-0000-4000-8000-000000000000', KEY),
    ).toEqual({ ok: false, code: 'not-found' })
  })
})

describe('M6 §写入规则: one config lock per profile, config.json read again inside it', () => {
  it('two creates at once both land, each with its own key (M6 不变量 13)', async () => {
    const h = await harness()
    const [a, b] = await Promise.all([
      createCustomVendor(h.deps, custom('https://one.example/v1')),
      createCustomVendor(h.deps, custom('https://two.example/v1', OTHER_KEY)),
    ])
    if (!a.ok || !b.ok) throw new Error('create refused')
    expect((await h.config()).customVendors.map((entry) => entry.id)).toEqual([a.id, b.id])
    expect(new Map(h.keychain.values)).toEqual(
      new Map([
        [h.keyOf(a.id), KEY],
        [h.keyOf(b.id), OTHER_KEY],
      ]),
    )
    await everyKeyBelongsToAnInstance(h)
  })

  it('a rename at the same time as a create loses neither', async () => {
    const h = await harness()
    const id = await created(h)
    const [renamed, made] = await Promise.all([
      updateCustomVendor(h.deps, { id, displayName: 'Renamed' }),
      createCustomVendor(h.deps, custom('https://two.example/v1', OTHER_KEY)),
    ])
    expect(renamed).toEqual({ ok: true })
    if (!made.ok) throw new Error(made.code)
    const names = (await h.config()).customVendors.map((entry) => [entry.id, entry.displayName])
    expect(names).toEqual([
      [id, 'Renamed'],
      [made.id, 'Relay'],
    ])
    await everyKeyBelongsToAnInstance(h)
  })

  it('a delete at the same time as a create removes only the deleted one (M6 不变量 13)', async () => {
    const h = await harness()
    const gone = await created(h)
    const [deleted, made] = await Promise.all([
      deleteCustomVendor(h.deps, gone),
      createCustomVendor(h.deps, custom('https://two.example/v1', OTHER_KEY)),
    ])
    expect(deleted).toEqual({ ok: true })
    if (!made.ok) throw new Error(made.code)
    expect((await h.config()).customVendors.map((entry) => entry.id)).toEqual([made.id])
    expect([...h.keychain.values]).toEqual([[h.keyOf(made.id), OTHER_KEY]])
    await everyKeyBelongsToAnInstance(h)
  })

  it.each(['the other write', 'the create'])(
    "shares writeConfig's lock (01 修补 6): a create and another route's write at once, %s held mid-write, lose neither",
    async (first) => {
      // Any route's write — locale, sidebar, provider.select, a default model — goes through
      // writeConfig; one that read config.json before a create landed would drop the instance and
      // leave its key behind (M6 不变量 13), or the create would drop that write.
      const h = await harness()
      /** Starts `a` and holds its write; starts `b`, lets it run as far as a lock lets it; releases. */
      async function interleaved<A, B>(a: () => Promise<A>, b: () => Promise<B>): Promise<[A, B]> {
        const { held, release } = h.holdNextWrite()
        const pending = a()
        await held
        const second = b()
        await new Promise((resolve) => setImmediate(resolve))
        release()
        return Promise.all([pending, second])
      }
      const write = () => writeConfig(h.host.fs, h.host.identity, { locale: 'en' })
      const create = () => createCustomVendor(h.deps, custom('https://relay.example/v1'))
      let other: Config
      let made: CreateResult
      if (first === 'the other write') [other, made] = await interleaved(write, create)
      else [made, other] = await interleaved(create, write)
      expect(other.locale).toBe('en')
      if (!made.ok) throw new Error(made.code)
      const config = await h.config()
      expect(config.locale).toBe('en')
      expect(config.customVendors.map((entry) => entry.id)).toEqual([made.id])
      expect(h.keychain.values.get(h.keyOf(made.id))).toBe(KEY)
      await everyKeyBelongsToAnInstance(h)
    },
  )

  it.each(['the key save', 'the rename'])(
    'a key save and a rename at once, %s started first: renamed, no snapshot, the new key (M6 不变量 12)',
    async (first) => {
      const h = await harness()
      const id = await created(h)
      await probed(h, id)
      const save = () => saveCustomVendorKey(h.deps, id, OTHER_KEY)
      const rename = () => updateCustomVendor(h.deps, { id, displayName: 'Renamed' })
      const results =
        first === 'the key save'
          ? await Promise.all([save(), rename()])
          : await Promise.all([rename(), save()])
      expect(results).toEqual([{ ok: true }, { ok: true }])
      const entry = (await h.config()).customVendors[0]
      expect(entry?.displayName).toBe('Renamed')
      expect(entry?.models.map((row) => row.probe)).toEqual([undefined, undefined])
      expect(h.keychain.values.get(h.keyOf(id))).toBe(OTHER_KEY)
    },
  )
})

describe('M6 不变量 14: an instance key lives in the keychain only, under its tenant', () => {
  it('appears in no config.json, no provider.list response and no log line, failures included', async () => {
    // 验收 8 (customVendor.list joins this in plan step 6).
    const h = await harness()
    const id = await created(h)
    expect([...h.keychain.values.keys()]).toEqual([`tenant:provider:${id}:apiKey`])
    await probed(h, id)
    await saveCustomVendorKey(h.deps, id, OTHER_KEY)
    h.keychain.failing = 'both'
    h.failWrites = true
    await createCustomVendor(h.deps, custom('https://two.example/v1')).catch(() => undefined)
    await saveCustomVendorKey(h.deps, id, KEY).catch(() => undefined)
    await deleteCustomVendor(h.deps, id).catch(() => undefined)
    h.keychain.failing = null
    h.failWrites = false

    const entry = (await h.list()).find((candidate) => candidate.id === id)
    expect(entry?.configKeys.find((key) => key.name === 'apiKey')?.configured).toBe(true)
    const exposed = [await h.file(), JSON.stringify(await h.list()), h.lines.join('\n')].join('\n')
    for (const key of [KEY, OTHER_KEY]) {
      expect(exposed).not.toContain(key)
      expect(exposed).not.toContain(key.slice(0, 8))
    }
  })
})
