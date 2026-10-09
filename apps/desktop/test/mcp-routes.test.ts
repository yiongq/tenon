// IPC is validated by registerRoute; credentials remain solely in the memory keychain.
// oxlint-disable no-await-in-loop
import { afterEach, expect, it, vi } from 'vitest'
import type { McpConnection } from '@tenon-app/kernel'
import { absolutePath } from '@tenon-app/kernel'
import { mcpDraft, mcpHarness } from './support/mcp-harness.js'
import { configPath, readConfig } from '../src/main/host/profile.js'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()))
})
async function setup() {
  const h = await mcpHarness()
  cleanup.push(h.close)
  return h
}
const save = (
  h: Awaited<ReturnType<typeof setup>>,
  draft = mcpDraft(),
  consent: 'run' | 'persistent' | null = 'persistent',
  secrets = { env: {}, headers: {} },
  mode: 'create' | 'update' = 'create',
) => h.call('mcp.save', { draft, consent, secrets, mode })
it('03 验收 7 / 24 / 27 / 03 不变量 4: validated writes require consent, refuse duplicate or blocked env, keep secrets out of every reply', async () => {
  const h = await setup(),
    d = mcpDraft()
  d.transport = {
    type: 'stdio',
    command: '/bin/node',
    args: ['arg'],
    envs: { NODE_OPTIONS: 'fixture' },
    env_keys: ['TOKEN'],
  }
  expect(await save(h, d, null)).toEqual({ ok: false, code: 'consent-required' })
  expect(
    await save(h, { ...d, id: 'other' }, 'persistent', {
      env: { TOKEN: '界'.repeat(854) },
      headers: {},
    }),
  ).toEqual({ ok: false, code: 'secret-too-long' })
  expect(
    await save(h, d, 'persistent', { env: { TOKEN: 'fixture-super-secret' }, headers: {} }),
  ).toEqual({ ok: true })
  const replies: unknown[] = []
  for (const [channel, payload] of [
    ['mcp.list', {}],
    ['mcp.preview', { draft: d }],
    ['mcp.readLog', { id: d.id }],
    ['mcp.reviewChange', { id: d.id, target: { tool: 'echo' } }],
    ['mcp.cancelLogin', { id: d.id }],
    ['mcp.setEnabled', { id: d.id, enabled: false }],
    ['mcp.connect', { id: d.id, consent: 'run' }],
    ['mcp.revoke', { id: d.id }],
  ] as const)
    replies.push(await h.call(channel, payload))
  expect(JSON.stringify(replies)).not.toContain('fixture-super-secret')
  expect(
    String(await h.host.fs.readFile(configPath(h.host.identity), { encoding: 'utf8' })),
  ).not.toContain('fixture-super-secret')
  expect(
    await h.call('mcp.save', {
      draft: { ...d, transport: { ...d.transport, envs: { TOKEN: 'duplicate' } } },
      consent: 'persistent',
      secrets: { env: {}, headers: {} },
      mode: 'update',
    }),
  ).toEqual({ ok: false, code: 'duplicate-env' })
  const bad = { ...d, transport: { ...d.transport, envs: { DYLD_INSERT_LIBRARIES: 'fixture' } } }
  expect(await save(h, bad)).toEqual({ ok: false, code: 'blocked-env' })
  expect(await h.call('mcp.revoke', { id: d.id })).toEqual({ ok: true })
  expect(h.mcp.pool.status()).toEqual([])
})
it('03 验收 10 / 23: address safety, normalization, and immutable update ids', async () => {
  const h = await setup(),
    d = mcpDraft()
  d.transport = {
    type: 'http',
    url: 'http://public.example',
    protocol: 'auto',
    header_keys: [],
    oauth: { ownClient: null },
  }
  expect(await save(h, d)).toEqual({ ok: false, code: 'https-required' })
  for (const url of ['https://u:p@public.example', 'not a url'])
    expect(await save(h, { ...d, transport: { ...d.transport, url } })).toEqual({
      ok: false,
      code: 'invalid-address',
    })
  expect(
    await save(h, { ...d, transport: { ...d.transport, url: 'http://10.1.1.1/mcp///#fragment' } }),
  ).toEqual({ ok: true })
  expect(
    await save(
      h,
      { ...d, id: 'changed', transport: { ...d.transport, url: 'https://mcp.example' } },
      'persistent',
      { env: {}, headers: {} },
      'update',
    ),
  ).toEqual({ ok: false, code: 'not-found' })
  expect((await readConfig(h.host.fs, h.host.identity)).mcpServers[0]?.transport).toMatchObject({
    url: 'http://10.1.1.1/mcp',
  })
  expect(
    await save(h, {
      ...d,
      id: 'loopback',
      transport: { ...d.transport, url: 'http://127.0.0.1/mcp' },
    }),
  ).toEqual({ ok: true })
})
it('03 验收 25: preview has complete visible argv, resolved path, every warning and no secret values', async () => {
  const h = await setup(),
    d = mcpDraft()
  d.transport = {
    type: 'stdio',
    command: '/usr/bin/sudo',
    args: ['rm', '-rf', '/home/fixture/.ssh', 'x\u200By', 'a'.repeat(3000)],
    envs: { NODE_OPTIONS: 'fixture' },
    env_keys: ['TOKEN'],
  }
  const view = await h.call('mcp.preview', { draft: d })
  if (!view.ok) throw new Error(view.code)
  expect(view.argv).toEqual([
    '/usr/bin/sudo',
    'rm',
    '-rf',
    '/home/fixture/.ssh',
    'x\\u{200B}y',
    'a'.repeat(3000),
  ])
  expect(view.resolved).toBe('/usr/bin/sudo')
  expect(view.warnings.map((w) => w.kind)).toEqual(
    expect.arrayContaining(['sudo', 'rm-rf', 'home-path', 'ssh-path', 'risky-env']),
  )
  for (const command of ['npx', 'uvx']) {
    const unpinned = await h.call('mcp.preview', {
      draft: { ...d, transport: { ...d.transport, command, args: ['package'] } },
    })
    if (!unpinned.ok) throw new Error(unpinned.code)
    expect(unpinned.warnings).toContainEqual({ kind: 'unpinned-package', package: 'package' })
    const pinned = await h.call('mcp.preview', {
      draft: {
        ...d,
        transport: {
          ...d.transport,
          command,
          args: [command === 'npx' ? 'package@1.2.3' : 'package==1.2.3'],
        },
      },
    })
    if (!pinned.ok) throw new Error(pinned.code)
    expect(pinned.warnings).not.toContainEqual(
      expect.objectContaining({ kind: 'unpinned-package' }),
    )
  }
})
it('03 验收 36 / 37 / 38 / 02 不变量 20 (routes): builtin is refused; interaction and policy prevent always-allow; review cache absence is null and release rejects stale hashes', async () => {
  const h = await setup()
  await save(h)
  const hash = 'a'.repeat(64),
    tool = {
      originalName: 'echo',
      mappedName: 'notes__echo',
      definitionHash: hash,
      definition: { name: 'echo', inputSchema: { type: 'object' }, description: 'new' },
      requiresUserInteraction: true,
      review: 'changed' as const,
    }
  const status = { ...h.mcp.pool.status()[0]!, tools: [tool] }
  h.mcp.pool.status = () => [status]
  await h.mcp.store.pin('notes', [{ name: 'echo', definitionHash: 'b'.repeat(64) }])
  expect(await h.mcp.store.setToolSetting('builtin', 'Read', 'always-allow')).toEqual({
    ok: false,
    code: 'invalid-id',
  })
  expect(
    await h.call('mcp.setToolSetting', { id: 'notes', tool: 'echo', setting: 'always-allow' }),
  ).toEqual({ ok: false, code: 'interaction-required' })
  expect((await h.call('mcp.list', {})).servers[0]?.toolViews[0]?.alwaysAllowOffered).toBe(false)
  tool.requiresUserInteraction = false
  const original = h.host.policy.current
  h.host.policy.current = () => ({ status: 'unavailable' }) as ReturnType<typeof original>
  expect(
    await h.call('mcp.setToolSetting', { id: 'notes', tool: 'echo', setting: 'always-allow' }),
  ).toEqual({ ok: false, code: 'policy-asks' })
  expect((await h.call('mcp.list', {})).servers[0]?.toolViews[0]?.alwaysAllowOffered).toBe(false)
  h.host.policy.current = original
  expect(
    await h.call('mcp.release', {
      id: 'notes',
      target: { tool: 'echo' },
      definitionHash: 'b'.repeat(64),
    }),
  ).toEqual({ ok: false, code: 'stale' })
  const cache = absolutePath(h.host.identity.profileDir + '/mcp/notes.json')
  await h.host.fs.mkdirp(absolutePath(h.host.identity.profileDir + '/mcp'))
  await h.host.fs.writeFile(
    cache,
    JSON.stringify({
      version: 1,
      pinnedDefinitions: { echo: { description: 'old' } },
      pinnedInstructions: 'old',
    }),
  )
  expect(await h.call('mcp.reviewChange', { id: 'notes', target: { tool: 'echo' } })).toMatchObject(
    { before: '{\n  "description": "old"\n}', after: expect.stringContaining('new') },
  )
  await h.host.fs.writeFile(cache, 'invalid-cache')
  expect(await h.call('mcp.reviewChange', { id: 'notes', target: { tool: 'echo' } })).toMatchObject(
    { before: null },
  )
})
it('03 验收 35: overLimit counts only configured capped providers using the cowork builtin table', async () => {
  const h = await setup()
  await save(h)
  // Both providers have a cap, but only one can actually send on this build.
  const template = h.providers.get('ollama')!
  h.providers.register({ ...template, id: 'fixture-configured', maxToolsPerRequest: 10 })
  h.providers.register({
    ...template,
    id: 'fixture-absent',
    maxToolsPerRequest: 1,
    configKeys: [{ name: 'API_KEY', secret: true, required: true, labelKey: 'fixture' }],
  })

  // No MCP means zero omitted even when the builtin count exceeds the provider cap.
  expect((await h.call('mcp.list', {})).overLimit).toEqual([])
  h.mcp.pool.routes = () => [
    {
      serverId: 'notes',
      connection: {
        listTools: async () =>
          ['one', 'two'].map((name) => ({ name, inputSchema: { type: 'object' as const } })),
      } as unknown as McpConnection,
    },
  ]
  expect((await h.call('mcp.list', {})).overLimit).toEqual([
    { providerId: 'fixture-configured', omitted: 1 },
  ])
})

it('03 验收 52: create and update return precise semantic codes without config or keychain changes; nested request objects are strict', async () => {
  const h = await setup(),
    d = mcpDraft()
  await save(h, d)
  const before = h.mcp.config(),
    set = vi.spyOn(h.host.secrets, 'set')
  for (const mode of ['create', 'update'] as const) {
    for (const [draft, code] of [
      [{ ...d, id: 'builtin' }, 'invalid-id'],
      [{ ...d, transport: { ...d.transport, envs: { ld_preload: 'fake' } } }, 'blocked-env'],
      [
        { ...d, transport: { ...d.transport, envs: { TOKEN: 'fake' }, env_keys: ['TOKEN'] } },
        'duplicate-env',
      ],
    ])
      expect(
        await save(h, draft as typeof d, 'persistent', { env: {}, headers: {} }, mode),
      ).toEqual({ ok: false, code })
  }
  expect(h.mcp.config()).toEqual(before)
  expect(set).not.toHaveBeenCalled()
  for (const bad of [
    { ...d, extra: true },
    { ...d, instructions: { enabled: false, extra: true } },
    { ...d, transport: { ...d.transport, extra: true } },
  ]) {
    expect(
      await h.handlers.get('mcp.save')!(
        {},
        { mode: 'update', draft: bad, secrets: { env: {}, headers: {} }, consent: null },
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  }
})
it('03 验收 24 / 38: launch update needs consent, unreviewed tools cannot set any setting, release resets ask with a fresh hash, and pin is one-time', async () => {
  const h = await setup(),
    d = mcpDraft()
  await save(h, d)
  const before = h.mcp.config()
  expect(
    await save(
      h,
      {
        ...d,
        transport: {
          ...d.transport,
          type: 'stdio',
          command: '/changed',
          args: [],
          envs: {},
          env_keys: [],
        },
      },
      null,
      { env: {}, headers: {} },
      'update',
    ),
  ).toEqual({ ok: false, code: 'consent-required' })
  expect(h.mcp.config()).toEqual(before)
  const hash = 'a'.repeat(64),
    tool = {
      originalName: 'new',
      mappedName: 'notes__new',
      definitionHash: hash,
      definition: { name: 'new', inputSchema: {} },
      requiresUserInteraction: false,
      review: 'new' as const,
    }
  const status = {
    ...h.mcp.pool.status()[0]!,
    tools: [tool],
    instructions: { hash, text: 'instructions' },
  }
  h.mcp.pool.status = () => [status]
  for (const setting of ['always-allow', 'ask'] as const)
    expect(await h.call('mcp.setToolSetting', { id: 'notes', tool: 'new', setting })).toEqual({
      ok: false,
      code: 'not-found',
    })
  expect(h.mcp.config()).toEqual(before)
  expect(
    await h.call('mcp.release', { id: 'notes', target: { tool: 'new' }, definitionHash: hash }),
  ).toEqual({ ok: true })
  expect(h.mcp.config().mcpServers[0]?.tools.new).toEqual({ setting: 'ask', definitionHash: hash })
  expect(
    await h.call('mcp.release', {
      id: 'notes',
      target: { instructions: true },
      definitionHash: 'b'.repeat(64),
    }),
  ).toEqual({ ok: false, code: 'stale' })
  await h.mcp.store.pin('notes', [{ name: 'new', definitionHash: hash }])
  const pinned = h.mcp.config()
  await h.mcp.store.pin('notes', [{ name: 'other', definitionHash: 'b'.repeat(64) }])
  expect(h.mcp.config()).toEqual(pinned)
  expect(
    await h.call('mcp.setToolSetting', { id: 'notes', tool: 'new', setting: 'always-allow' }),
  ).toEqual({ ok: true })
  tool.definitionHash = 'b'.repeat(64)
  expect(
    await h.call('mcp.release', {
      id: 'notes',
      target: { tool: 'new' },
      definitionHash: tool.definitionHash,
    }),
  ).toEqual({ ok: true })
  expect(h.mcp.config().mcpServers[0]?.tools.new).toEqual({
    setting: 'ask',
    definitionHash: tool.definitionHash,
  })
  const current = h.host.policy.current()
  if (current.status !== 'unavailable')
    h.host.policy.current = () => ({
      ...current,
      snapshot: {
        ...current.snapshot,
        tools: [{ policyId: 'fixture', serverId: 'notes', toolName: 'new', effect: 'ask' }],
      },
    })
  expect(
    await h.call('mcp.setToolSetting', { id: 'notes', tool: 'new', setting: 'always-allow' }),
  ).toEqual({ ok: false, code: 'policy-asks' })
  expect(await h.call('mcp.setInstructions', { id: 'notes', enabled: true })).toEqual({ ok: true })
  expect(h.mcp.config().mcpServers[0]?.instructions).toEqual({ enabled: true, pinHash: hash })
})
it('03 验收 25: separated rm flags, unpinned variants, home paths and secret env names are visible warnings', async () => {
  const h = await setup(),
    d = mcpDraft()
  const preview = async (command: string, args: string[], env_keys: string[] = []) =>
    h.call('mcp.preview', {
      draft: { ...d, transport: { type: 'stdio', command, args, envs: {}, env_keys } },
    })
  const view = await preview(
    'rm',
    ['-r', '-f', '~', '~/x', '~/.ssh/\u202Ex'],
    ['path', 'npm_config_registry'],
  )
  if (!view.ok) throw new Error(view.code)
  expect(view.warnings).toEqual(
    expect.arrayContaining([
      { kind: 'rm-rf' },
      { kind: 'home-path', arg: '~' },
      { kind: 'home-path', arg: '~/x' },
      { kind: 'ssh-path', arg: '~/.ssh/\\u{202E}x' },
      { kind: 'home-path', arg: '~/.ssh/\\u{202E}x' },
      { kind: 'risky-env', name: 'path' },
      { kind: 'risky-env', name: 'npm_config_registry' },
    ]),
  )
  for (const pkg of ['foo@latest', '@scope/pkg', 'foo@']) {
    const v = await preview('npx', [pkg])
    if (!v.ok) throw new Error(v.code)
    expect(v.warnings).toContainEqual({ kind: 'unpinned-package', package: pkg })
  }
  const resolved = await preview('sh', [])
  expect(resolved).toMatchObject({ ok: true, resolved: expect.stringMatching(/\/sh$/) })
})

it('unconfirmed server restart reports false and leaves it stopped', async () => {
  const h = await setup()
  await save(h)
  await h.call('mcp.revoke', { id: 'notes' })
  expect(await h.call('mcp.restart', { id: 'notes' })).toEqual({ restarted: false })
  expect(h.mcp.pool.status()[0]).toMatchObject({ phase: 'stopped', stopReason: 'needs-consent' })
})

it('03 验收 52: HTTP draft transport, oauth and own-client objects reject extra keys', async () => {
  const h = await setup(),
    d = mcpDraft()
  const transport = {
    type: 'http',
    url: 'https://example.com',
    protocol: 'auto',
    header_keys: [],
    oauth: { ownClient: { clientId: 'own', redirectPort: 53280, hasSecret: false } },
  }
  for (const bad of [
    { ...transport, extra: true },
    { ...transport, oauth: { ...transport.oauth, extra: true } },
    { ...transport, oauth: { ownClient: { ...transport.oauth.ownClient, extra: true } } },
  ]) {
    expect(
      await h.handlers.get('mcp.save')!(
        {},
        {
          mode: 'create',
          draft: { ...d, transport: bad },
          consent: 'persistent',
          secrets: { env: {}, headers: {} },
        },
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  }
  expect(h.mcp.config().mcpServers).toEqual([])
})

it('03 读法 67: reserved HTTP header names reach storage and return invalid-header without writes', async () => {
  const h = await setup(),
    d = mcpDraft()
  d.transport = {
    type: 'http',
    url: 'https://example.com',
    protocol: 'auto',
    header_keys: ['Content-Type'],
    oauth: { ownClient: null },
  }
  expect(await save(h, d, 'persistent', { env: {}, headers: {} })).toEqual({
    ok: false,
    code: 'invalid-header',
  })
  expect(h.mcp.config().mcpServers).toEqual([])
})

it('03 验收 44: disabled or never-pinned instructions have no pending change', async () => {
  const h = await setup()
  await save(h)
  const status = h.mcp.pool.status()[0]!
  h.mcp.pool.status = () => [{ ...status, instructions: { text: 'fixture', hash: 'a'.repeat(64) } }]
  expect((await h.call('mcp.list', {})).servers[0]?.instructionsView?.review).toBe('ok')
  await h.call('mcp.setInstructions', { id: 'notes', enabled: true })
  expect((await h.call('mcp.list', {})).servers[0]?.instructionsView?.review).toBe('ok')
})

it('03 验收 42: instructions that change after their pin show a pending review until released', async () => {
  const h = await setup()
  await save(h)
  const status = h.mcp.pool.status()[0]!
  let instructions = { text: 'fixture', hash: 'a'.repeat(64) }
  h.mcp.pool.status = () => [{ ...status, instructions }]
  const review = async () => (await h.call('mcp.list', {})).servers[0]?.instructionsView?.review
  await h.call('mcp.setInstructions', { id: 'notes', enabled: true })
  const release = (definitionHash: string) =>
    h.call('mcp.release', { id: 'notes', target: { instructions: true }, definitionHash })
  expect(await release('a'.repeat(64))).toEqual({ ok: true })
  expect(await review()).toBe('ok')
  instructions = { text: 'changed', hash: 'b'.repeat(64) }
  expect(await review()).toBe('changed')
  expect(await release('b'.repeat(64))).toEqual({ ok: true })
  expect(await review()).toBe('ok')
})

it('03 读法 67: reserved header with a supplied value returns invalid-header through validated IPC', async () => {
  const h = await setup(),
    d = mcpDraft()
  d.transport = {
    type: 'http',
    url: 'https://example.com',
    protocol: 'auto',
    header_keys: ['Content-Type'],
    oauth: { ownClient: null },
  }
  const write = vi.spyOn(h.host.fs, 'writeFile'),
    secret = vi.spyOn(h.host.secrets, 'set')
  expect(
    await save(h, d, 'persistent', { env: {}, headers: { 'Content-Type': 'fixture' } }),
  ).toEqual({ ok: false, code: 'invalid-header' })
  expect(write).not.toHaveBeenCalled()
  expect(secret).not.toHaveBeenCalled()
  expect(h.mcp.config().mcpServers).toEqual([])
})

it('03 验收 53: mcp.login supplies the application locale, display name and result to its retained callback', async () => {
  const h = await setup()
  await save(h, { ...mcpDraft(), displayName: 'Route Notes' })
  const { writeConfig } = await import('../src/main/host/profile.js')
  await writeConfig(h.host.fs, h.host.identity, { locale: 'zh-CN' })
  let response: Promise<Response> | undefined
  vi.spyOn(h.mcp.pool, 'login').mockImplementation(async (_id, ui) => {
    const listener = await ui.listen(0)
    const waiting = listener.waitForCallback('route-state', 120_000)
    response = fetch(`http://127.0.0.1:${listener.port}/callback?state=route-state`)
    await waiting
    await listener.close()
    return { ok: true }
  })
  expect(await h.call('mcp.login', { id: 'notes' })).toEqual({ ok: true })
  expect(await (await response!).text()).toContain('已登录 Route Notes，可以关闭这个页面回到 Tenon')
})
