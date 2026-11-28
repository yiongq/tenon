/**
 * Where a secret is first seen, and that it is never written afterwards (docs/features/error-logs/
 * spec.md §脱敏 层 2, §一直要成立的规矩 第 5 条; acceptance 3): each registration point is driven by
 * its real path, with a planted value that no generic format would catch, and then the value is
 * written through every kind of write entry in all four spellings.
 *
 * The process-wide `appLog` is the real one, swapped for a real `createAppLog` on this file's own
 * folder with a small size limit (the module is mocked only to hand out that instance), because
 * the code under test registers through that one: `host/index.ts`, `provider.ts`, `mcp/`. What is
 * driven, and how it gets to the log:
 *
 *   1. a key saved by the last run, only ever `get` from the memory keychain: `readProviderSecret`
 *      over `rememberingSecrets(seeded memory secrets)`, the wrap `createDesktopHost` puts on;
 *   2. a key saved on the settings card: `provider.configure` over the host `createDesktopHost`
 *      builds (TENON_SECRETS=memory: no keychain is touched);
 *   3. a development build's environment variable: `readProviderInputs` with `ZHIPU_API_KEY`;
 *   4. an OAuth access token and refresh token, cut into shards in the keychain by the real
 *      token store and put together again by the real OAuth provider; 5. the client secret,
 *      inside the one JSON value of the stored client — the provider's `addSecret` is given
 *      `appLog.remember`, as the pool's `onSecret` is by `createDesktopMcp` (the pool half is the
 *      kernel's `pool-on-secret.test.ts`);
 *   6. a connector's `env_keys` value and 7. its `envs` value: `mcp.save` through the real
 *      `registerMcpRoutes` and `createDesktopMcp`, whose memory host is not wrapped, so only the
 *      pool's `onSecret` and `mcpRuntimes` can have registered them.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ANTHROPIC_PROVIDER_ID,
  ZHIPU_PROVIDER_ID,
  absolutePath,
  createMemoryHost,
  createProviderRegistry,
  keyFor,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type { IpcMainLike } from '@tenon-app/contracts'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createProviderView } from '../src/main/custom-vendors/registry.js'
import { firstKeyDefaults } from '../src/main/custom-vendors/store.js'
import { createDesktopHost, useMemorySecrets } from '../src/main/host/index.js'
import { readConfig } from '../src/main/host/profile.js'
import { snapshotEnv } from '../src/main/host/shell-env.js'
import { MemorySecrets } from '../src/main/host/secrets.js'
import { readProviderInputs, readProviderSecret } from '../src/main/provider.js'
import { registerProviderRoutes } from '../src/main/provider-routes.js'
import { createMcpOAuthProvider } from '../../../packages/kernel/src/mcp/oauth.js'
import { createMcpTokenStore } from '../../../packages/kernel/src/mcp/token-store.js'
import { mcpDraft, mcpHarness } from './support/mcp-harness.js'
import {
  APP_DIR,
  HOME,
  appLog,
  leaksIn,
  makeTempRoot,
  rememberingSecrets,
  sweepTempRoots,
} from './support/error-logs.js'
import {
  CONFIGURED,
  ENVVAR,
  EVENT_INJECTORS,
  FIRST_KEY_ENV,
  EVENT_LEVELS,
  MCP_ENVS,
  MCP_ENV_KEY,
  OAUTH_ACCESS,
  OAUTH_CLIENT,
  OAUTH_REFRESH,
  STORED,
  payloadOf,
  spellingsOf,
} from './support/error-logs-sentinels.js'
import type { Sentinel } from './support/error-logs-sentinels.js'

vi.mock('../src/main/log/app-log.js', async (importOriginal) => {
  const actual = await importOriginal<{
    createAppLog: (options: {
      now: () => Date
      pid: number
      uid: number
      stderr: (text: string) => void
      maxBytes?: number
    }) => unknown
  }>()
  return {
    ...actual,
    appLog: actual.createAppLog({
      now: () => new Date(),
      pid: 4242,
      uid: process.getuid?.() ?? 0,
      stderr: () => {},
      maxBytes: 131_072,
    }),
  }
})

let dir = ''
const cleanup: Array<() => Promise<unknown>> = []

beforeAll(() => {
  // No test here may reach the OS keychain: the memory secrets are the only store `createDesktopHost` may pick.
  vi.stubEnv('TENON_SECRETS', 'memory')
  if (!useMemorySecrets(false))
    throw new Error('TENON_SECRETS=memory did not take: refusing to go on')
  dir = join(makeTempRoot('secrets'), 'logs')
  const opened = appLog.open(absolutePath(dir), {
    version: '0.0.0',
    packaged: true,
    home: absolutePath(HOME),
    appDir: absolutePath(APP_DIR),
  })
  if (!opened.ok) throw new Error(`the app log did not open: ${opened.reason}`)
})

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()))
})

afterAll(() => {
  appLog.close()
  vi.unstubAllEnvs()
  sweepTempRoots()
})

/** Not yet known to the log: the value comes back as it is, so what follows is the registration's doing. */
function expectUnregistered(sentinel: Sentinel): void {
  expect(appLog.redact(`x ${sentinel.raw} y`)).toBe(`x ${sentinel.raw} y`)
}

/** Registered: the value, and each way it may be spelled, goes. */
function expectRegistered(sentinel: Sentinel): void {
  for (const spelling of spellingsOf(sentinel)) {
    expect([spelling, appLog.redact(`x ${spelling} y`)]).toEqual([spelling, 'x [redacted] y'])
  }
}

it('error-logs 验收 3: sentinels from every registration point, including a key stored before the wrap and only read, never reach the app log files', async () => {
  const registry = createProviderRegistry()
  registerBuiltinProviders(registry)

  // 1. Stored by the last run, in the keychain before this run wrapped it; only read now.
  {
    expectUnregistered(STORED)
    const host = createMemoryHost()
    const seeded = new MemorySecrets()
    await seeded.set(keyFor(host.identity, 'provider', ANTHROPIC_PROVIDER_ID, 'apiKey'), STORED.raw)
    const wrapped = { ...host, secrets: rememberingSecrets(seeded, appLog) }
    expect(await readProviderSecret(wrapped, ANTHROPIC_PROVIDER_ID, 'apiKey', () => {})).toBe(
      STORED.raw,
    )
    expectRegistered(STORED)
  }

  // 2. Saved on the settings card, into the host `createDesktopHost` builds.
  {
    expectUnregistered(CONFIGURED)
    const root = makeTempRoot('desktop-host')
    const host = await createDesktopHost({
      userDataDir: absolutePath(root),
      userId: 'local',
      tenantId: 'personal',
      send: () => {},
      log: () => {},
      isPackaged: false,
      startupEnv: snapshotEnv({}),
    })
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipcMain: IpcMainLike = {
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
    }
    registerProviderRoutes({
      ipcMain,
      host,
      providers: createProviderView({
        builtin: registry,
        identity: host.identity,
        config: await readConfig(host.fs, host.identity),
      }),
      env: {},
      isPackaged: false,
      log: () => {},
    })
    const answer = await handlers.get('provider.configure')?.(
      {},
      { id: ANTHROPIC_PROVIDER_ID, values: { apiKey: CONFIGURED.raw } },
    )
    expect(answer).toMatchObject({ ok: true })
    expectRegistered(CONFIGURED)
  }

  // 3. A development build's environment variable, the key of a provider that has none stored.
  {
    expectUnregistered(ENVVAR)
    const definition = registry.get(ZHIPU_PROVIDER_ID)
    if (definition === null) throw new Error('zhipu is not registered')
    const inputs = await readProviderInputs({
      host: createMemoryHost(),
      definition,
      env: { ZHIPU_API_KEY: ENVVAR.raw },
      log: () => {},
    })
    expect(inputs.sources['apiKey']).toBe('env')
    expectRegistered(ENVVAR)
  }

  // 4, 5. OAuth: the tokens in shards, the client secret in one JSON value, both read back.
  {
    expectUnregistered(OAUTH_ACCESS)
    expectUnregistered(OAUTH_REFRESH)
    expectUnregistered(OAUTH_CLIENT)
    const host = createMemoryHost()
    const issuer = { hash: '00000000000000a1', url: 'https://issuer.example.test' }
    const store = createMcpTokenStore({
      secrets: host.secrets,
      identity: host.identity,
      serverId: 'oauth-sentinels',
      ids: { uuid: randomUUID },
      onIssuer: async () => {},
      deleting: () => false,
      log: () => {},
    })
    await store.saveTokens(issuer, {
      access_token: OAUTH_ACCESS.raw,
      refresh_token: OAUTH_REFRESH.raw,
      token_type: 'Bearer',
    })
    await store.saveClient(issuer, { client_id: 'client-1', client_secret: OAUTH_CLIENT.raw })
    const provider = createMcpOAuthProvider({
      serverId: 'oauth-sentinels',
      ids: { uuid: randomUUID },
      serverUrl: 'https://mcp.example.test/mcp',
      fetch: async () => {
        throw new Error('offline')
      },
      runtime: () => ({
        issuers: [issuer.hash],
        ownClient: null,
        clientMetadataUrl: null,
        dcrRedirectPort: 53280,
      }),
      identity: host.identity,
      secrets: host.secrets,
      store,
      currentIssuerHash: () => issuer.hash,
      onUnauthorized: () => {},
      addSecret: (value: string): void => appLog.remember(value),
    })
    expect((await provider.tokens())?.access_token).toBe(OAUTH_ACCESS.raw)
    expect((await provider.clientInformation())?.client_secret).toBe(OAUTH_CLIENT.raw)
    expectRegistered(OAUTH_ACCESS)
    expectRegistered(OAUTH_REFRESH)
    expectRegistered(OAUTH_CLIENT)
  }

  // 6, 7. A connector saved with a secret value for an `env_keys` name and a plain `envs` value.
  {
    expectUnregistered(MCP_ENV_KEY)
    expectUnregistered(MCP_ENVS)
    const harness = await mcpHarness()
    cleanup.push(harness.close)
    const draft = mcpDraft('sentinels')
    draft.transport = {
      type: 'stdio',
      command: process.execPath,
      args: [],
      envs: { PLAIN_SETTING: MCP_ENVS.raw },
      env_keys: ['SENTINEL_TOKEN'],
    }
    await harness.call('mcp.save', {
      draft,
      consent: 'persistent',
      secrets: { env: { SENTINEL_TOKEN: MCP_ENV_KEY.raw }, headers: {} },
      mode: 'create',
    })
    await vi.waitFor(() => {
      expectRegistered(MCP_ENV_KEY)
      expectRegistered(MCP_ENVS)
    })
  }

  // Now every one of them, in all four spellings, through every kind of write entry.
  const planted: Array<[string, Sentinel]> = [
    ['stored before the wrap', STORED],
    ['saved on the card', CONFIGURED],
    ['environment variable', ENVVAR],
    ['oauth access token', OAUTH_ACCESS],
    ['oauth refresh token', OAUTH_REFRESH],
    ['oauth client secret', OAUTH_CLIENT],
    ['connector env_keys', MCP_ENV_KEY],
    ['connector envs', MCP_ENVS],
  ]
  for (const [label, sentinel] of planted) {
    for (const kind of Object.keys(EVENT_INJECTORS) as Array<keyof typeof EVENT_INJECTORS>) {
      appLog.write(EVENT_LEVELS[kind], EVENT_INJECTORS[kind](payloadOf(sentinel)))
    }
    appLog.line('kernel', 'error')(`${label}: ${payloadOf(sentinel)}`)
    expect({ label, leaks: leaksIn(dir, spellingsOf(sentinel)) }).toEqual({ label, leaks: [] })
  }
  // Turn the log over, so that the archives and the lines copied to the top of the new file are looked in too.
  for (let i = 0; i < 150; i += 1) {
    appLog.line(`f${String(i).padStart(3, '0')}`, 'info')('f'.repeat(1900))
  }
  expect(existsSync(join(dir, 'main.1.jsonl'))).toBe(true)
  expect(
    leaksIn(
      dir,
      planted.flatMap(([, sentinel]) => spellingsOf(sentinel)),
    ),
  ).toEqual([])
})

it('error-logs 验收 3: the host the desktop builds registers a value the moment it is set', async () => {
  const root = makeTempRoot('host-wrap')
  const host = await createDesktopHost({
    userDataDir: absolutePath(root),
    userId: 'local',
    tenantId: 'personal',
    send: () => {},
    log: () => {},
    isPackaged: false,
    startupEnv: snapshotEnv({}),
  })
  const written = 'host-wrap-written-secret-77'
  expect(appLog.redact(written)).toBe(written)
  await host.secrets.set(
    keyFor(host.identity, 'provider', ANTHROPIC_PROVIDER_ID, 'apiKey'),
    written,
  )
  expect(appLog.redact(written)).toBe('[redacted]')
})

it('error-logs 验收 3: 复现 a key that firstKeyDefaults finds in the environment is registered', async () => {
  expectUnregistered(FIRST_KEY_ENV)
  const registry = createProviderRegistry()
  registerBuiltinProviders(registry)
  const definition = registry.get(ANTHROPIC_PROVIDER_ID)
  if (definition === null) throw new Error('anthropic is not registered')
  const host = createMemoryHost()
  await host.fs.mkdirp(absolutePath(host.identity.profileDir))
  const config = await readConfig(host.fs, host.identity)
  // The `apiKey` is typed on the settings card; the vendor's other secret, `authToken`, is not, and
  // the first-key defaults resolve it the way a send would: from the environment of a dev build.
  firstKeyDefaults(
    config,
    definition,
    { apiKey: 'typed-on-the-card-0001' },
    { ANTHROPIC_AUTH_TOKEN: FIRST_KEY_ENV.raw },
    {},
  )
  for (const spelling of spellingsOf(FIRST_KEY_ENV)) {
    expect([spelling, appLog.redact(`x ${spelling} y`)]).toEqual([spelling, 'x [redacted] y'])
  }
})
