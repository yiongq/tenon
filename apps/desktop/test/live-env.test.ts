/**
 * The live suite's key separation (spec 02 §模型与密钥), pinned where CI can see it: the live suite
 * itself never runs there. What is proven is the environment each app process would get — the
 * group's variables composed over a runner environment that holds everything a careless shell or
 * `.env.local` could hold — so no path forwards an official Anthropic key next to a foreign base URL.
 */
import { describe, expect, it } from 'vitest'
import {
  NEVER_INHERITED,
  OFFICIAL_KEY_ENV,
  appEnvironment,
  assertOfficialKeyStaysHome,
} from '../e2e/helpers/app-env.js'
import { OFFICIAL_MODEL_ENV, emulationGroup, officialGroup } from '../e2e/helpers/live-env.js'
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
const EMULATION_URL = 'https://open.bigmodel.cn/api/anthropic'
/** Base URLs that only look like the official host, and one that does not parse (no scheme). */
const LOOKALIKE_URLS = [
  'https://api.anthropic.com.evil.test',
  'https://evil.test/api.anthropic.com',
  'https://proxy.anthropic.com',
  'open.bigmodel.cn/api/anthropic',
]

/** Everything `.env.local` holds for the emulation group, plus the mistakes the rule is about. */
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
  ANTHROPIC_BASE_URL: 'https://gateway.example.test',
  ANTHROPIC_AUTH_TOKEN: 'shell-token',
  ANTHROPIC_API_KEY: OFFICIAL_KEY,
  ZHIPU_API_KEY: 'shell-zhipu',
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
})

describe('the emulation group', () => {
  it('forwards the base URL and auth token only, never an official key', () => {
    const env = launched(emulationGroup(lookupIn({}, FILE), '2048'))
    expect(env).toMatchObject({
      TENON_PROVIDER: 'anthropic',
      ANTHROPIC_BASE_URL: EMULATION_URL,
      ANTHROPIC_AUTH_TOKEN: ZHIPU_KEY,
      TENON_MODEL: 'glm-4.7-flash',
      TENON_MAX_TOKENS: '2048',
    })
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(env).not.toHaveProperty(OFFICIAL_KEY_ENV)
    expect(Object.values(env)).not.toContain(OFFICIAL_KEY)
  })

  it('never reads ANTHROPIC_API_KEY or OFFICIAL_KEY_ENV, even where the lookup would find one', () => {
    const group = emulationGroup(lookupIn({ ANTHROPIC_API_KEY: OFFICIAL_KEY }, FILE), '2048')
    expect(Object.values(ready(group))).not.toContain(OFFICIAL_KEY)
    // Neither is a fallback for a missing auth token: with only one of them, the group skips.
    for (const only of [
      { ANTHROPIC_API_KEY: 'not-official-key' },
      { [OFFICIAL_KEY_ENV]: OFFICIAL_KEY },
    ]) {
      const alone = emulationGroup(lookupIn({ ANTHROPIC_BASE_URL: EMULATION_URL, ...only }), '1')
      expect(alone).toMatchObject({ kind: 'absent' })
      expect(JSON.stringify(alone)).not.toContain('not-official-key')
      expect(JSON.stringify(alone)).not.toContain(OFFICIAL_KEY)
    }
  })

  it('refuses a token that looks official, or a base URL that is missing or official', () => {
    for (const value of OFFICIAL_LOOKING) {
      // Exported in the runner's shell, the token is found ahead of `.env.local`'s.
      const official = emulationGroup(lookupIn({ ANTHROPIC_AUTH_TOKEN: value }, FILE), '1')
      expect(official).toMatchObject({ kind: 'refused' })
      expect(JSON.stringify(official)).not.toContain(value)
    }
    const noBase = emulationGroup(lookupIn({ ANTHROPIC_AUTH_TOKEN: ZHIPU_KEY }), '1')
    expect(noBase).toMatchObject({ kind: 'refused' })
    const home = emulationGroup(
      lookupIn({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }, FILE),
      '1',
    )
    expect(home).toMatchObject({ kind: 'refused' })
    // A host that only looks official is foreign: the endpoint the group emulates, not refused.
    const lookalike = emulationGroup(
      lookupIn({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com.evil.test' }, FILE),
      '1',
    )
    expect(lookalike).toMatchObject({ kind: 'ready' })
  })

  it('skips when no token is configured', () => {
    expect(emulationGroup(lookupIn({ ANTHROPIC_BASE_URL: EMULATION_URL }), '1')).toMatchObject({
      kind: 'absent',
    })
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
    // Neither the emulation group's model nor the runner's daily TENON_MODEL is this group's:
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

  it('coexists with the emulation group in one run without either seeing the other key', () => {
    // The owner's setup: the official key exported for this one run, the rest in .env.local.
    const runner: EnvRecord = { PATH: '/usr/bin', [OFFICIAL_KEY_ENV]: OFFICIAL_KEY }
    const lookup = lookupIn(runner, FILE)
    const inRun = (group: LiveGroup): Record<string, string> =>
      appEnvironment(runner, { env: ready(group), secrets: 'memory' })
    const emulation = inRun(emulationGroup(lookup, '1'))
    const official = inRun(officialGroup(runner, FILE, lookup, '1'))
    expect(Object.values(emulation)).not.toContain(OFFICIAL_KEY)
    expect(emulation['ANTHROPIC_BASE_URL']).toBe(EMULATION_URL)
    expect(Object.values(official)).not.toContain(ZHIPU_KEY)
    expect(official['ANTHROPIC_API_KEY']).toBe(OFFICIAL_KEY)
    expect(official['ANTHROPIC_BASE_URL']).toBeUndefined()
  })
})
