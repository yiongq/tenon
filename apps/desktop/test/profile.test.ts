import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopFs } from '../src/main/host/fs.js'
import {
  configPath,
  countProviderSettingsWrite,
  openProfile,
  providerSettingsGeneration,
  readConfig,
  writeConfig,
} from '../src/main/host/profile.js'

/** Acceptance 5: two tenants write config.json to different, mutually invisible paths. */
describe('desktop profiles', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tenon-profile-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps two tenants of the same user apart on disk', async () => {
    const fs = new DesktopFs()
    const userData = absolutePath(root)
    const a = await openProfile(fs, userData, 'local', 'tenant-a')
    const b = await openProfile(fs, userData, 'local', 'tenant-b')

    await writeConfig(fs, a, { locale: 'zh-CN' })
    await writeConfig(fs, b, { locale: 'en' })

    expect(configPath(a)).not.toBe(configPath(b))
    expect(configPath(a)).toBe(join(root, 'profiles', 'local', 'tenant-a', 'config.json'))
    expect(await readConfig(fs, a)).toMatchObject({ locale: 'zh-CN' })
    expect(await readConfig(fs, b)).toMatchObject({ locale: 'en' })

    // Neither profile directory contains anything of the other.
    expect(await readdir(a.profileDir)).toEqual(['config.json', 'logs', 'mcp', 'plugins', 'skills'])
    expect(await readdir(b.profileDir)).toEqual(['config.json', 'logs', 'mcp', 'plugins', 'skills'])
    expect(await readdir(join(root, 'profiles', 'local'))).toEqual(['tenant-a', 'tenant-b'])
  })

  it('falls back to defaults when config.json is missing or corrupt', async () => {
    const fs = new DesktopFs()
    const identity = await openProfile(fs, absolutePath(root), 'local', 'personal')
    expect(await readConfig(fs, identity)).toMatchObject({ locale: 'auto' })
    await fs.writeFile(configPath(identity), '{not json')
    expect(await readConfig(fs, identity)).toMatchObject({ locale: 'auto' })
    await fs.writeFile(configPath(identity), '{"locale":"klingon"}')
    expect(await readConfig(fs, identity)).toMatchObject({ locale: 'auto' })
    // JSON that is not an object: defaults, never a throw (M6 §存储 takes the object apart).
    const notObjects = await Promise.all(
      ['null', '[]', '"x"', '5'].map(async (text, index) => {
        const other = await openProfile(fs, absolutePath(root), 'local', `not-an-object-${index}`)
        await fs.writeFile(configPath(other), text)
        return readConfig(fs, other)
      }),
    )
    for (const config of notObjects) {
      expect(config).toMatchObject({ locale: 'auto', customVendors: [] })
    }
  })

  it('reads a config.json written before M6 with no custom vendors and every other key kept', async () => {
    // M6 验收 11 (first half; T8): the file has no `customVendors`, and nothing migrates it.
    const fs = new DesktopFs()
    const identity = await openProfile(fs, absolutePath(root), 'local', 'personal')
    const before = {
      locale: 'en',
      sidebarCollapsed: true,
      provider: { id: 'zhipu', modelId: 'glm-5.3' },
      providerConfig: { zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4/' } },
      defaultModelByProfile: { cowork: { id: 'anthropic', modelId: 'my-model', source: 'user' } },
      lastWorkspaceFolders: ['/work/a'],
    }
    await fs.writeFile(configPath(identity), JSON.stringify(before))
    // 照常解析: and without a log line, which §存储 asks for only when an entry is dropped.
    const lines: string[] = []
    expect(await readConfig(fs, identity, (line) => lines.push(line))).toEqual({
      ...before,
      customVendors: [],
    })
    expect(lines).toEqual([])
  })

  it('lets one bad field cost that field and nothing else', async () => {
    const fs = new DesktopFs()
    const identity = await openProfile(fs, absolutePath(root), 'local', 'personal')
    // `provider` is all-or-nothing (`{ id, modelId }`), so a half-written or hand-edited entry
    // used to discard the whole file — and the next save persisted those defaults over what the
    // user had chosen.
    await fs.writeFile(
      configPath(identity),
      '{"locale":"zh-CN","sidebarCollapsed":true,"provider":{"id":"zhipu"},"providerConfig":7}',
    )
    expect(await readConfig(fs, identity)).toEqual({
      locale: 'zh-CN',
      sidebarCollapsed: true,
      provider: null,
      providerConfig: {},
      defaultModelByProfile: {},
      lastWorkspaceFolders: [],
      customVendors: [],
    })
    // And a save from that state keeps what survived.
    await writeConfig(fs, identity, { sidebarCollapsed: false })
    expect(await readConfig(fs, identity)).toMatchObject({
      locale: 'zh-CN',
      sidebarCollapsed: false,
    })
  })

  it('lets one bad custom vendor entry cost that entry and no other instance (M6 验收 11)', async () => {
    // §存储: entry by entry — a repeated model id keeps its first row, an entry the schema refuses
    // is dropped, a repeated instance id keeps its first entry; the log names the index and the
    // failing schema paths, never a value (so never an address).
    const fs = new DesktopFs()
    const identity = await openProfile(fs, absolutePath(root), 'local', 'personal')
    const a = { id: ID_A, displayName: 'A', wire: 'openai-chat', baseURL: 'https://a.example/v1' }
    const c = {
      id: ID_C,
      displayName: 'C',
      wire: 'anthropic-messages',
      baseURL: 'https://c.example/anthropic',
    }
    await fs.writeFile(
      configPath(identity),
      JSON.stringify({
        locale: 'en',
        customVendors: [
          { ...a, models: rows(64_000) },
          { ...a, id: ID_B, wire: 'grpc', baseURL: 'https://secret-host.example/v1', models: [] },
          { ...c, models: [...rows(128_000), ...rows(1)] },
          { ...a, displayName: 'A again', models: [] },
          'not an entry',
          // A row whose id is not a string is left for the schema, which drops the whole entry.
          {
            ...a,
            id: ID_D,
            models: [{ id: 5, contextLimit: 1, maxOutputTokens: 8_000 }, ...rows(64_000)],
          },
        ],
      }),
    )
    const lines: string[] = []
    const config = await readConfig(fs, identity, (line) => lines.push(line))
    expect(config.locale).toBe('en')
    expect(config.customVendors).toEqual([
      { ...a, models: rows(64_000) },
      { ...c, models: rows(128_000) },
    ])
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('customVendors[1]')
    expect(lines[0]).toContain('wire')
    expect(lines[1]).toContain('customVendors[3]')
    expect(lines[2]).toContain('customVendors[4]')
    expect(lines[3]).toContain('customVendors[5]')
    expect(lines.join('\n')).not.toMatch(/example/)

    // A list that is not one costs the instances and nothing else, and says so once.
    await fs.writeFile(configPath(identity), '{"locale":"zh-CN","customVendors":{"id":"x"}}')
    const notAList: string[] = []
    expect(await readConfig(fs, identity, (line) => notAList.push(line))).toMatchObject({
      locale: 'zh-CN',
      customVendors: [],
    })
    expect(notAList).toHaveLength(1)
    expect(notAList[0]).toContain('customVendors')
  })

  it('reads every instance when another field fails the schema, and the next write keeps them (M6 验收 11)', async () => {
    // §存储: the instances are read entry by entry whatever the rest of the file reads as.
    const fs = new DesktopFs()
    const identity = await openProfile(fs, absolutePath(root), 'local', 'personal')
    const models = rows(64_000)
    const entries = [
      { id: ID_A, displayName: 'A', wire: 'openai-chat', baseURL: 'https://a.example/v1', models },
      {
        id: ID_B,
        displayName: 'B',
        wire: 'anthropic-messages',
        baseURL: 'https://b.example/x',
        models,
      },
    ]
    await fs.writeFile(
      configPath(identity),
      JSON.stringify({ locale: 'klingon', customVendors: entries }),
    )
    expect(await readConfig(fs, identity)).toMatchObject({ locale: 'auto', customVendors: entries })
    await writeConfig(fs, identity, { sidebarCollapsed: true })
    const written = JSON.parse(
      (await fs.readFile(configPath(identity), { encoding: 'utf8' })) as string,
    )
    expect(written.customVendors).toEqual(entries)
  })

  it('judges the schema before repeated ids: a broken entry does not hide a valid one with its id', async () => {
    // §存储: entries the schema refuses are dropped first; the first of a repeated id is kept among
    // what is left (验收 11: only the broken entry is lost).
    const fs = new DesktopFs()
    const identity = await openProfile(fs, absolutePath(root), 'local', 'personal')
    const a = { id: ID_A, displayName: 'A', wire: 'openai-chat', baseURL: 'https://a.example/v1' }
    await fs.writeFile(
      configPath(identity),
      JSON.stringify({
        customVendors: [
          { ...a, wire: 'grpc', models: [] },
          { ...a, models: [] },
        ],
      }),
    )
    const lines: string[] = []
    expect((await readConfig(fs, identity, (line) => lines.push(line))).customVendors).toEqual([
      { ...a, models: [] },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('customVendors[0]')
  })

  it('logs a dropped entry through console.warn when the caller gives no log, without its address', async () => {
    // Main's own reads (startup, the store, run-assembly, the routes) pass no `log`.
    const fs = new DesktopFs()
    const identity = await openProfile(fs, absolutePath(root), 'local', 'personal')
    const broken = {
      id: ID_A,
      displayName: 'A',
      wire: 'grpc',
      baseURL: 'https://secret-host.example/v1',
      models: [],
    }
    await fs.writeFile(configPath(identity), JSON.stringify({ customVendors: [broken] }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await readConfig(fs, identity)).customVendors).toEqual([])
      const lines = warn.mock.calls.map((args) => args.map(String).join(' '))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('customVendors[0]')
      expect(lines[0]).not.toContain('secret-host')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('keeps an entry whose address fails the address checks: it reads as not configured instead', async () => {
    // §存储: only the schema drops an entry; a public http:// address (A9) or a subscription path
    // (Q13) stays, for the registry view to refuse (custom-vendor-registry.test.ts).
    const fs = new DesktopFs()
    const identity = await openProfile(fs, absolutePath(root), 'local', 'personal')
    const entries = [
      {
        id: ID_A,
        displayName: 'A',
        wire: 'openai-chat',
        baseURL: 'http://a.example/v1',
        models: [],
      },
      {
        id: ID_B,
        displayName: 'B',
        wire: 'openai-chat',
        baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
        models: [],
      },
    ]
    await fs.writeFile(configPath(identity), JSON.stringify({ customVendors: entries }))
    expect((await readConfig(fs, identity)).customVendors).toEqual(entries)
  })

  it("reads no instance's settings from providerConfig, and the next write leaves them out", async () => {
    // §注册表视图: an instance's address is its description's alone; providerConfig under its id
    // reads as absent (M6 不变量 3; the effect on the host it sends to is in
    // custom-vendor-registry.test.ts).
    const fs = new DesktopFs()
    const identity = await openProfile(fs, absolutePath(root), 'local', 'personal')
    const providerConfig = {
      zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
      [ID_A]: { baseURL: 'https://elsewhere.example/v1' },
      'custom-not-an-instance-id': { baseURL: 'https://kept.example' },
    }
    await fs.writeFile(configPath(identity), JSON.stringify({ providerConfig }))
    const expected = {
      zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
      'custom-not-an-instance-id': { baseURL: 'https://kept.example' },
    }
    expect((await readConfig(fs, identity)).providerConfig).toEqual(expected)
    // The same when another field fails the schema and the file is read field by field.
    await fs.writeFile(configPath(identity), JSON.stringify({ locale: 42, providerConfig }))
    expect((await readConfig(fs, identity)).providerConfig).toEqual(expected)
    await writeConfig(fs, identity, { locale: 'en' })
    const written = JSON.parse(
      (await fs.readFile(configPath(identity), { encoding: 'utf8' })) as string,
    )
    expect(written.providerConfig).toEqual(expected)
  })

  it("counts a write that changes an instance's entry as a change of that instance's settings", async () => {
    // §写入规则: `providerSettingsGeneration` is what a probe's save and the settled read look at.
    const fs = new DesktopFs()
    const identity = await openProfile(fs, absolutePath(root), 'local', 'counted')
    const entry = (displayName: string) => ({
      id: ID_A,
      displayName,
      wire: 'openai-chat' as const,
      baseURL: 'https://a.example/v1',
      models: [],
    })
    const other = { ...entry('B'), id: ID_B }
    const count = () => [
      providerSettingsGeneration(identity, ID_A),
      providerSettingsGeneration(identity, ID_B),
    ]
    const [a0 = 0, b0 = 0] = count()
    await writeConfig(fs, identity, { customVendors: [entry('A'), other] })
    expect(count()).toEqual([a0 + 1, b0 + 1])
    // The same entries again, and a write of something else: neither instance moved.
    await writeConfig(fs, identity, { customVendors: [entry('A'), other] })
    await writeConfig(fs, identity, { locale: 'en' })
    expect(count()).toEqual([a0 + 1, b0 + 1])
    await writeConfig(fs, identity, { customVendors: [entry('A renamed'), other] })
    expect(count()).toEqual([a0 + 2, b0 + 1])
    await writeConfig(fs, identity, { customVendors: [other] })
    expect(count()).toEqual([a0 + 3, b0 + 1])
    // A key save counts on its own, with no write of the file (§写入规则, 推出的读法 12).
    countProviderSettingsWrite(identity, ID_B)
    expect(count()).toEqual([a0 + 3, b0 + 2])
  })
})

const rows = (contextLimit: number) => [{ id: 'model-a', contextLimit, maxOutputTokens: 8_000 }]

const ID_A = 'custom-0b7e1c5a-3d2f-4e6a-9b8c-1d2e3f4a5b6c'
const ID_B = 'custom-1c8f2d6b-4e3a-4f7b-8c9d-2e3f4a5b6c7d'
const ID_C = 'custom-2d9a3e7c-5f4b-4a8c-9d0e-3f4a5b6c7d8e'
const ID_D = 'custom-3e0b4f8d-6a5c-4b9d-8e1f-4a5b6c7d8e9f'
