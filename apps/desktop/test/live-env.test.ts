/**
 * The live suite's key separation (spec 02 §模型与密钥), pinned where CI can see it: the live suite
 * itself never runs there. What is proven is the environment each app process would get — the
 * group's variables composed over a runner environment that holds everything a careless shell or
 * `.env.local` could hold — so no path forwards an official Anthropic key next to a foreign base URL.
 * And M6 验收 27: the origin map test seam is never inherited, never shares an app environment with
 * an official-looking key, and stops the live suite; an official-looking key is never filled into
 * an instance on another host than api.anthropic.com. And the DeepSeek key (M6 验收 29, plan「开工前读」
 * key): never inherited, read from the runner's environment alone, refused in `.env.local`; typed
 * into a preset instance only once the card shows the address the guard read (第 12 步).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEEPSEEK_KEY_ENV,
  NEVER_INHERITED,
  OFFICIAL_KEY_ENV,
  ORIGIN_MAP_ENV,
  appEnvironment,
  assertInstanceKeyStaysHome,
  assertOfficialKeyStaysHome,
} from '../e2e/helpers/app-env.js'
import {
  OFFICIAL_MODEL_ENV,
  deepseekKey,
  officialGroup,
  originMapRefusal,
} from '../e2e/helpers/live-env.js'
import {
  createInstance,
  createInstanceInCard,
  saveInstanceKey,
  saveInstanceKeyInCard,
} from '../e2e/helpers/instances.js'
import liveGlobalSetup from '../e2e/helpers/live-global-setup.js'
import liveConfig from '../playwright.live.config.js'
import type { EnvRecord, LiveGroup } from '../e2e/helpers/live-env.js'
import { DEV_ENV_FALLBACK } from '../src/main/provider.js'

const OFFICIAL_KEY = 'sk-ant-api03-test-official-key-not-real'
/** Every kind of credential Anthropic issues shares the prefix: API key, OAuth token, admin key. */
const OFFICIAL_LOOKING = [
  OFFICIAL_KEY,
  'sk-ant-oat01-test-oauth-token-not-real',
  'sk-ant-admin01-test-admin-key-not-real',
]
const ZHIPU_KEY = 'zhipu-id.zhipu-secret-not-real'
const DEEPSEEK_KEY = 'sk-deepseek-test-key-not-real'
const EMULATION_URL = 'https://open.bigmodel.cn/api/anthropic'
/** Base URLs that only look like the official host, and one that does not parse (no scheme). */
const LOOKALIKE_URLS = [
  'https://api.anthropic.com.evil.test',
  'https://evil.test/api.anthropic.com',
  'https://proxy.anthropic.com',
  'open.bigmodel.cn/api/anthropic',
]

/** What an older `.env.local` holds (the emulation group's variables, M6 §点名 (d)). */
const FILE: EnvRecord = {
  ANTHROPIC_BASE_URL: EMULATION_URL,
  ANTHROPIC_AUTH_TOKEN: ZHIPU_KEY,
  TENON_LIVE_MODEL: 'glm-4.7-flash',
  ZHIPU_API_KEY: ZHIPU_KEY,
}

/**
 * A runner shell exporting the official key AND a foreign endpoint, a stray ANTHROPIC_API_KEY, and
 * the daily chat model.
 */
const RUNNER: EnvRecord = {
  PATH: '/usr/bin',
  HOME: '/Users/someone',
  TENON_MODEL: 'glm-5.3-flash',
  [OFFICIAL_KEY_ENV]: OFFICIAL_KEY,
  [DEEPSEEK_KEY_ENV]: DEEPSEEK_KEY,
  ANTHROPIC_BASE_URL: 'https://gateway.example.test',
  ANTHROPIC_AUTH_TOKEN: 'shell-token',
  ANTHROPIC_API_KEY: OFFICIAL_KEY,
  ZHIPU_API_KEY: 'shell-zhipu',
  [ORIGIN_MAP_ENV]: 'https://api.anthropic.com=http://127.0.0.1:4000',
  ELECTRON_RUN_AS_NODE: '1',
}

function lookupIn(...sources: EnvRecord[]): (...names: string[]) => string | undefined {
  return (...names) => {
    for (const name of names) {
      for (const source of sources) {
        const value = source[name]
        if (value) return value
      }
    }
    return undefined
  }
}

function ready(group: LiveGroup): Readonly<Record<string, string>> {
  if (group.kind !== 'ready') throw new Error(`expected a ready group, got ${group.kind}`)
  return group.env
}

/** The app environment `launchTenon` would build for this group on RUNNER. */
function launched(group: LiveGroup): Record<string, string> {
  return appEnvironment(RUNNER, { env: ready(group), secrets: 'memory' })
}

describe('appEnvironment', () => {
  it('inherits no provider credential or endpoint from the runner', () => {
    const env = appEnvironment(RUNNER, {})
    for (const name of NEVER_INHERITED) expect(env).not.toHaveProperty(name)
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/Users/someone',
      TENON_DEV_ENV: 'off',
      TENON_SECRETS: 'memory',
    })
  })

  it('M6 验收 27: never inherits the origin map; a test hands it in through env alone', () => {
    expect(NEVER_INHERITED).toContain(ORIGIN_MAP_ENV)
    expect(ORIGIN_MAP_ENV).toBe('TENON_TEST_ORIGIN_MAP')
    expect(appEnvironment(RUNNER, {})).not.toHaveProperty(ORIGIN_MAP_ENV)
    const map = 'https://open.bigmodel.cn=http://127.0.0.1:4100'
    expect(appEnvironment(RUNNER, { env: { [ORIGIN_MAP_ENV]: map } })[ORIGIN_MAP_ENV]).toBe(map)
  })

  it('M6 验收 29: never inherits the DeepSeek key, which no app is launched with', () => {
    expect(DEEPSEEK_KEY_ENV).toBe('TENON_LIVE_DEEPSEEK_KEY')
    expect(NEVER_INHERITED).toContain(DEEPSEEK_KEY_ENV)
    for (const secrets of ['memory', 'keychain'] as const) {
      expect(Object.values(appEnvironment(RUNNER, { secrets }))).not.toContain(DEEPSEEK_KEY)
    }
  })

  it('drops every variable the desktop reads provider settings from', () => {
    const readByDesktop = Object.values(DEV_ENV_FALLBACK).flatMap((names) => Object.values(names))
    expect(readByDesktop.length).toBeGreaterThan(0)
    for (const name of readByDesktop) expect(NEVER_INHERITED).toContain(name)
  })

  it('refuses an official-looking key beside a foreign base URL, naming no value', () => {
    for (const baseURL of [EMULATION_URL, ...LOOKALIKE_URLS]) {
      for (const value of OFFICIAL_LOOKING) {
        for (const carrier of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
          const env = { ANTHROPIC_BASE_URL: baseURL, [carrier]: ` ${value}` }
          expect(() => appEnvironment({}, { env })).toThrow(`${carrier} looks like an official`)
          expect(() => assertOfficialKeyStaysHome(env)).not.toThrow(value)
        }
      }
    }
    // The official host, a blank base URL (the default endpoint) and a non-official key all pass.
    const home = {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_API_KEY: OFFICIAL_KEY,
    }
    expect(() => assertOfficialKeyStaysHome(home)).not.toThrow()
    expect(() =>
      assertOfficialKeyStaysHome({ ANTHROPIC_BASE_URL: ' ', ANTHROPIC_API_KEY: OFFICIAL_KEY }),
    ).not.toThrow()
    expect(() =>
      assertOfficialKeyStaysHome({
        ANTHROPIC_BASE_URL: EMULATION_URL,
        ANTHROPIC_AUTH_TOKEN: ZHIPU_KEY,
      }),
    ).not.toThrow()
  })

  it('refuses the origin map beside any official-looking value, under any name, naming no value', () => {
    const map = 'https://api.anthropic.com=http://127.0.0.1:4000'
    for (const value of OFFICIAL_LOOKING) {
      for (const name of ['ANTHROPIC_API_KEY', 'SOME_OTHER_NAME']) {
        const env = { [ORIGIN_MAP_ENV]: map, [name]: ` ${value}` }
        expect(() => appEnvironment({}, { env })).toThrow(`${name} looks like an official`)
        expect(() => assertOfficialKeyStaysHome(env)).not.toThrow(value)
      }
      // Inherited from the runner's shell, the value is refused all the same.
      expect(() =>
        appEnvironment({ SOME_OTHER_NAME: value }, { env: { [ORIGIN_MAP_ENV]: map } }),
      ).toThrow(/SOME_OTHER_NAME looks like an official/)
    }
    // The e2e suite's own setup: the map, a test key, nothing official.
    expect(() =>
      appEnvironment({}, { env: { [ORIGIN_MAP_ENV]: map, ANTHROPIC_API_KEY: 'e2e-test-key' } }),
    ).not.toThrow()
  })

  it('refuses the origin map beside the keychain, which every profile shares (02 M4)', () => {
    // The key a developer keeps in the keychain is invisible to the check above, and the seam
    // would send it to the fake: the map goes with the in-memory store only.
    const env = { [ORIGIN_MAP_ENV]: 'https://api.anthropic.com=http://127.0.0.1:4000' }
    expect(() => appEnvironment({}, { secrets: 'keychain', env })).toThrow(
      `${ORIGIN_MAP_ENV} needs TENON_SECRETS=memory`,
    )
    expect(() => appEnvironment({}, { env: { ...env, TENON_SECRETS: 'keychain' } })).toThrow(
      `${ORIGIN_MAP_ENV} needs TENON_SECRETS=memory`,
    )
    expect(() => assertOfficialKeyStaysHome(env)).toThrow('needs TENON_SECRETS=memory')
    // Without the map the keychain is the live suite's to use.
    expect(() => appEnvironment({}, { secrets: 'keychain' })).not.toThrow()
    expect(() => appEnvironment({}, { secrets: 'memory', env })).not.toThrow()
  })
})

describe('the instance key guard (M6 §点名, 验收 27)', () => {
  it('refuses an official-looking key for an instance on any host but api.anthropic.com', () => {
    for (const value of OFFICIAL_LOOKING) {
      for (const baseURL of [EMULATION_URL, 'https://vendor.e2e.test', ...LOOKALIKE_URLS]) {
        expect(() => assertInstanceKeyStaysHome(baseURL, ` ${value}`)).toThrow(
          /looks like an official Anthropic key/,
        )
        expect(() => assertInstanceKeyStaysHome(baseURL, value)).not.toThrow(value)
      }
      expect(() => assertInstanceKeyStaysHome('https://api.anthropic.com', value)).not.toThrow()
    }
    // Any other key goes anywhere the instance points.
    expect(() => assertInstanceKeyStaysHome(EMULATION_URL, ZHIPU_KEY)).not.toThrow()
    expect(() => assertInstanceKeyStaysHome('http://127.0.0.1:8080/v1', 'local')).not.toThrow()
  })
})

const VENDOR = 'https://vendor.e2e.test'
/**
 * A Page whose `evaluate` records each bridge call and answers from `answers` in order; its
 * `getByTestId` records what a helper would have typed into or pressed on the settings card.
 */
function page(answers: unknown[]) {
  const evaluate = vi.fn<(...call: unknown[]) => Promise<unknown>>(async () => answers.shift())
  const getByTestId = vi.fn<(testId: string) => never>()
  return { page: { evaluate, getByTestId } as unknown as Page, evaluate, getByTestId }
}
/** `customVendor.list`'s answer with one instance at `baseURL`. */
function listing(baseURL: string) {
  return { ok: true, data: { instances: [{ id: 'custom-1', baseURL }] } }
}
const DEEPSEEK_URL = 'https://api.deepseek.com'
/** The DeepSeek live group's instance: the preset's openai-chat address (M6 §预设). */
const DEEPSEEK_PRESET = {
  displayName: 'DeepSeek',
  preset: 'deepseek',
  region: 'default',
  wire: 'openai-chat',
  baseURL: DEEPSEEK_URL,
  apiKey: DEEPSEEK_KEY,
} as const
/**
 * A Page with the create form on it: `evaluate` answers from `answers` in order, the preset's
 * read-only address reads `address`, the form closes on submit without a refusal, and `log` keeps
 * what was pressed, chosen, read and typed on the card, in order.
 */
function cardPage(answers: unknown[], address: string) {
  const log: string[] = []
  const evaluate = vi.fn<(...call: unknown[]) => Promise<unknown>>(async () => answers.shift())
  const locator = (testId: string) => ({
    click: async () => void log.push(`click ${testId}`),
    selectOption: async (value: string) => void log.push(`select ${testId} ${value}`),
    fill: async (value: string) => void log.push(`fill ${testId} ${value}`),
    textContent: async () => {
      log.push(`read ${testId}`)
      return address
    },
    or: () => ({ first: () => ({ waitFor: async () => undefined }) }),
    isVisible: async () => false,
  })
  return { page: { evaluate, getByTestId: vi.fn<typeof locator>(locator) } as unknown as Page, log }
}
/** The live global setup's refusal, or null when it lets the run go on. */
function globalSetupRefusal(): string | null {
  try {
    liveGlobalSetup()
    return null
  } catch (error) {
    return (error as Error).message
  }
}

describe('the helpers that fill an instance’s key run the guard first (M6 §点名, 验收 27)', () => {
  it('createInstance refuses an official-looking key for another host, invoking nothing', async () => {
    const { page: refused, evaluate } = page([])
    await expect(
      createInstance(refused, {
        displayName: 'Vendor',
        wire: 'anthropic-messages',
        baseURL: VENDOR,
        apiKey: OFFICIAL_KEY,
      }),
    ).rejects.toThrow(/official Anthropic key/)
    expect(evaluate).not.toHaveBeenCalled()
    // Any other key reaches customVendor.create.
    const { page: allowed, evaluate: sent } = page([{ ok: true, data: { ok: true, id: 'x' } }])
    await expect(
      createInstance(allowed, {
        displayName: 'Vendor',
        wire: 'anthropic-messages',
        baseURL: VENDOR,
        apiKey: ZHIPU_KEY,
      }),
    ).resolves.toBe('x')
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0]?.[1]).toMatchObject({
      source: { baseURL: VENDOR },
      apiKey: ZHIPU_KEY,
    })
  })

  it('saveInstanceKey reads where the key would go, and refuses before provider.configure', async () => {
    const { page: refused, evaluate } = page([listing(VENDOR)])
    await expect(saveInstanceKey(refused, 'custom-1', OFFICIAL_KEY)).rejects.toThrow(
      /official Anthropic key/,
    )
    // The list only: provider.configure was never invoked.
    expect(evaluate).toHaveBeenCalledTimes(1)
    const { page: allowed, evaluate: sent } = page([
      listing('https://api.anthropic.com'),
      { ok: true, data: { ok: true } },
    ])
    await expect(saveInstanceKey(allowed, 'custom-1', OFFICIAL_KEY)).resolves.toBeUndefined()
    expect(sent).toHaveBeenCalledTimes(2)
    expect(sent.mock.calls[1]?.[1]).toEqual({ id: 'custom-1', values: { apiKey: OFFICIAL_KEY } })
  })

  it('the settings card helpers refuse it before touching the card (第 10 步: the path a user takes)', async () => {
    const { page: creating, evaluate, getByTestId } = page([])
    await expect(
      createInstanceInCard(creating, {
        displayName: 'Vendor',
        wire: 'anthropic-messages',
        baseURL: VENDOR,
        apiKey: OFFICIAL_KEY,
      }),
    ).rejects.toThrow(/official Anthropic key/)
    expect(evaluate).not.toHaveBeenCalled()
    expect(getByTestId).not.toHaveBeenCalled()
    // The key field: the address is read first (the list), and nothing on the card is typed into.
    const { page: keying, evaluate: read, getByTestId: typed } = page([listing(VENDOR)])
    await expect(saveInstanceKeyInCard(keying, 'custom-1', OFFICIAL_KEY)).rejects.toThrow(
      /official Anthropic key/,
    )
    expect(read).toHaveBeenCalledTimes(1)
    expect(typed).not.toHaveBeenCalled()
    // A preset's address is guarded as a typed one is (第 12 步: DeepSeek from its preset).
    const { page: preset, evaluate: listed, getByTestId: chosen } = page([])
    await expect(
      createInstanceInCard(preset, { ...DEEPSEEK_PRESET, apiKey: OFFICIAL_KEY }),
    ).rejects.toThrow(/official Anthropic key/)
    expect(listed).not.toHaveBeenCalled()
    expect(chosen).not.toHaveBeenCalled()
  })
})

describe('a preset instance on the settings card (M6 验收 29, §预设)', () => {
  it('types the key only once the card shows the guarded address, and no address', async () => {
    const { page: shown, log } = cardPage(
      [{ ok: true, data: { instances: [] } }, listing(DEEPSEEK_URL)],
      DEEPSEEK_URL,
    )
    await expect(createInstanceInCard(shown, DEEPSEEK_PRESET)).resolves.toBe('custom-1')
    expect(log).toEqual([
      'click custom-vendor-new',
      'select custom-vendor-new-source deepseek',
      'select custom-vendor-new-region default',
      'select custom-vendor-new-wire openai-chat',
      'read custom-vendor-new-address',
      'fill custom-vendor-new-name DeepSeek',
      `fill custom-vendor-new-key ${DEEPSEEK_KEY}`,
      'click custom-vendor-new-submit',
    ])
  })

  it('types no key when the preset gives another address, naming no key', async () => {
    const { page: shown, log } = cardPage([{ ok: true, data: { instances: [] } }], VENDOR)
    const refused = createInstanceInCard(shown, DEEPSEEK_PRESET)
    await expect(refused).rejects.toThrow(/gives https:\/\/vendor\.e2e\.test, not .*typing no key/)
    await expect(refused).rejects.not.toThrow(DEEPSEEK_KEY)
    expect(log.filter((line) => line.startsWith('fill custom-vendor-new-key'))).toEqual([])
    expect(log).not.toContain('click custom-vendor-new-submit')
    // The same host on another path (the preset's anthropic-messages address) is another address.
    const { page: sameHost, log: tried } = cardPage(
      [{ ok: true, data: { instances: [] } }],
      `${DEEPSEEK_URL}/anthropic`,
    )
    await expect(createInstanceInCard(sameHost, DEEPSEEK_PRESET)).rejects.toThrow(
      /gives https:\/\/api\.deepseek\.com\/anthropic, not .*typing no key/,
    )
    expect(tried.filter((line) => line.startsWith('fill custom-vendor-new-key'))).toEqual([])
    expect(tried).not.toContain('click custom-vendor-new-submit')
  })

  it('refuses an instance main stored at another address than the preset showed', async () => {
    const { page: shown } = cardPage(
      [{ ok: true, data: { instances: [] } }, listing(VENDOR)],
      DEEPSEEK_URL,
    )
    await expect(createInstanceInCard(shown, DEEPSEEK_PRESET)).rejects.toThrow(
      /is at https:\/\/vendor\.e2e\.test, not https:\/\/api\.deepseek\.com/,
    )
    // The same host on another path is another address, as on the card.
    const { page: sameHost } = cardPage(
      [{ ok: true, data: { instances: [] } }, listing(`${DEEPSEEK_URL}/anthropic`)],
      DEEPSEEK_URL,
    )
    await expect(createInstanceInCard(sameHost, DEEPSEEK_PRESET)).rejects.toThrow(
      /is at https:\/\/api\.deepseek\.com\/anthropic, not https:\/\/api\.deepseek\.com/,
    )
  })

  it('a typed address never touches the preset fields', async () => {
    const { page: typed, log } = cardPage(
      [{ ok: true, data: { instances: [] } }, listing(VENDOR)],
      DEEPSEEK_URL,
    )
    await expect(
      createInstanceInCard(typed, {
        displayName: 'Vendor',
        wire: 'openai-chat',
        baseURL: VENDOR,
        apiKey: ZHIPU_KEY,
      }),
    ).resolves.toBe('custom-1')
    expect(log).toEqual([
      'click custom-vendor-new',
      'select custom-vendor-new-source ',
      'select custom-vendor-new-wire openai-chat',
      `fill custom-vendor-new-baseurl ${VENDOR}`,
      'fill custom-vendor-new-name Vendor',
      `fill custom-vendor-new-key ${ZHIPU_KEY}`,
      'click custom-vendor-new-submit',
    ])
  })
})

describe('the live suite and the origin map (验收 27)', () => {
  it('refuses to run when the runner’s environment or .env.local holds it, naming no value', () => {
    const map = 'https://api.anthropic.com=http://127.0.0.1:4000'
    expect(originMapRefusal({ PATH: '/usr/bin' }, FILE)).toBeNull()
    for (const [runner, file] of [
      [{ [ORIGIN_MAP_ENV]: map }, FILE],
      [{}, { ...FILE, [ORIGIN_MAP_ENV]: map }],
      [{ [ORIGIN_MAP_ENV]: '' }, {}],
    ] as const) {
      const refusal = originMapRefusal(runner, file)
      expect(refusal).toContain(ORIGIN_MAP_ENV)
      expect(refusal).not.toContain('127.0.0.1')
    }
  })

  describe('the live config’s global setup', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
    })

    it('is what `pnpm test:live` runs before any spec', () => {
      expect(liveConfig.globalSetup).toBe('./e2e/helpers/live-global-setup.ts')
    })

    it('throws on the map in the runner’s environment or the repo-root .env.local, naming no value', async () => {
      // apps/desktop's two parents are the repo root it reads `.env.local` from: a temp dir here,
      // never the developer's own file.
      const root = await mkdtemp(join(tmpdir(), 'tenon-live-setup-'))
      try {
        vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'a', 'b'))
        const map = 'https://api.anthropic.com=http://127.0.0.1:4000'
        vi.stubEnv(ORIGIN_MAP_ENV, undefined)
        expect(globalSetupRefusal()).toBeNull()
        vi.stubEnv(ORIGIN_MAP_ENV, map)
        const fromRunner = globalSetupRefusal()
        vi.stubEnv(ORIGIN_MAP_ENV, undefined)
        await writeFile(join(root, '.env.local'), `${ORIGIN_MAP_ENV}=${map}\n`)
        const fromFile = globalSetupRefusal()
        for (const message of [fromRunner, fromFile]) {
          expect(message).toContain(ORIGIN_MAP_ENV)
          expect(message).not.toContain('127.0.0.1')
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })
})

describe('the DeepSeek key (M6 验收 29, plan「开工前读」key)', () => {
  it('is read from the runner’s environment alone', () => {
    expect(deepseekKey({ [DEEPSEEK_KEY_ENV]: ` ${DEEPSEEK_KEY} ` }, FILE)).toEqual({
      kind: 'ready',
      key: DEEPSEEK_KEY,
    })
    for (const runner of [{}, { [DEEPSEEK_KEY_ENV]: '  ' }, { DEEPSEEK_API_KEY: DEEPSEEK_KEY }]) {
      expect(deepseekKey(runner, FILE)).toMatchObject({ kind: 'absent' })
    }
  })

  it('refuses the group when .env.local holds it, whatever it holds, naming no value', () => {
    const other = 'not-a-deepseek-value'
    for (const value of [DEEPSEEK_KEY, other, '']) {
      const file = { ...FILE, [DEEPSEEK_KEY_ENV]: value }
      // Refused even when this run's environment hands the key in as it should.
      for (const runner of [{}, { [DEEPSEEK_KEY_ENV]: DEEPSEEK_KEY }]) {
        const key = deepseekKey(runner, file)
        expect(key).toMatchObject({ kind: 'refused' })
        const said = JSON.stringify(key)
        expect(said).toContain(DEEPSEEK_KEY_ENV)
        expect(said).not.toContain(DEEPSEEK_KEY)
        expect(said).not.toContain(other)
      }
    }
  })
})

describe('the official group', () => {
  it('sends the runner-provided key to the default endpoint and nothing else', () => {
    const env = launched(officialGroup(RUNNER, FILE, lookupIn(RUNNER, FILE), '2048'))
    expect(env).toMatchObject({
      TENON_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: OFFICIAL_KEY,
      TENON_MAX_TOKENS: '2048',
    })
    // Forced to api.anthropic.com: the definition's default, since nothing names another host.
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL')
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
    expect(env).not.toHaveProperty(OFFICIAL_KEY_ENV)
    // Neither `.env.local`'s TENON_LIVE_MODEL nor the runner's daily TENON_MODEL is this group's:
    // blank, which the desktop reads as unset, means the definition's first row.
    expect(env['TENON_MODEL']).toBe('')
  })

  it('takes its model from its own variable only', () => {
    const lookup = lookupIn({ [OFFICIAL_MODEL_ENV]: 'claude-haiku-4-5-20251001' }, FILE)
    expect(ready(officialGroup(RUNNER, FILE, lookup, '1'))).toMatchObject({
      TENON_MODEL: 'claude-haiku-4-5-20251001',
    })
  })

  it('reads the key from the runner environment only, and refuses one in .env.local', () => {
    expect(officialGroup({}, FILE, lookupIn(FILE), '1')).toMatchObject({ kind: 'absent' })
    expect(officialGroup({ [OFFICIAL_KEY_ENV]: '  ' }, FILE, lookupIn(FILE), '1')).toMatchObject({
      kind: 'absent',
    })
    // Refused by the variable's name whatever it holds, and by any official-looking value.
    const files: { file: EnvRecord; value: string }[] = [
      {
        file: { ...FILE, [OFFICIAL_KEY_ENV]: 'not-an-sk-ant-value' },
        value: 'not-an-sk-ant-value',
      },
    ]
    for (const value of OFFICIAL_LOOKING) {
      files.push({ file: { ...FILE, [OFFICIAL_KEY_ENV]: value }, value })
      for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'SOME_OTHER_NAME']) {
        files.push({ file: { ...FILE, [name]: value }, value })
      }
    }
    for (const { file, value } of files) {
      const group = officialGroup(RUNNER, file, lookupIn(RUNNER, file), '1')
      expect(group).toMatchObject({ kind: 'refused' })
      expect(JSON.stringify(group)).not.toContain(value)
    }
  })

  it('runs on the official key alone when the old emulation variables are still in .env.local', () => {
    // The owner's setup: the official key exported for this one run, the rest in .env.local.
    const runner: EnvRecord = { PATH: '/usr/bin', [OFFICIAL_KEY_ENV]: OFFICIAL_KEY }
    const official = appEnvironment(runner, {
      env: ready(officialGroup(runner, FILE, lookupIn(runner, FILE), '1')),
      secrets: 'memory',
    })
    expect(Object.values(official)).not.toContain(ZHIPU_KEY)
    expect(official['ANTHROPIC_API_KEY']).toBe(OFFICIAL_KEY)
    expect(official['ANTHROPIC_BASE_URL']).toBeUndefined()
  })
})

it('03 验收 19: the OAuth test browser switch is never inherited and refuses a live run', () => {
  expect(NEVER_INHERITED).toContain('TENON_TEST_MCP_OPEN_URL')
  const marker = 'fixture-browser-switch'
  expect(
    appEnvironment({ TENON_TEST_MCP_OPEN_URL: marker }, { env: {}, secrets: 'memory' }),
  ).not.toHaveProperty('TENON_TEST_MCP_OPEN_URL')
  for (const [runner, file] of [
    [{ TENON_TEST_MCP_OPEN_URL: marker }, {}],
    [{}, { TENON_TEST_MCP_OPEN_URL: marker }],
  ]) {
    const refusal = originMapRefusal(runner!, file!)
    expect(refusal).toContain('TENON_TEST_MCP_OPEN_URL')
    expect(refusal).not.toContain(marker)
  }
})
