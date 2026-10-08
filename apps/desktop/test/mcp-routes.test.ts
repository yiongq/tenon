// IPC is validated by registerRoute; credentials remain solely in the memory keychain.
// oxlint-disable no-await-in-loop
import { afterEach, expect, it } from 'vitest'
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
    await h.mcp.store.save({
      draft: { ...d, transport: { ...d.transport, envs: { TOKEN: 'duplicate' } } },
      consent: 'persistent',
      secrets: { env: {}, headers: {} },
      mode: 'update',
    }),
  ).toEqual({ ok: false, code: 'duplicate-env' })
  const bad = { ...d, transport: { ...d.transport, envs: { DYLD_INSERT_LIBRARIES: 'fixture' } } }
  // Contract refuses injection before the handler, just as compromised renderer requests do.
  expect(
    await h.handlers.get('mcp.save')!(
      {},
      { draft: bad, mode: 'create', consent: 'persistent', secrets: { env: {}, headers: {} } },
    ),
  ).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
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
    expect(await save(h, { ...d, transport: { ...d.transport, url } })).toMatchObject({ ok: false })
  expect(
    await save(h, { ...d, transport: { ...d.transport, url: 'http://10.1.1.1/mcp#fragment' } }),
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
it('03 验收 36 / 37 / 38 (routes): builtin is refused; interaction and policy prevent always-allow; review cache absence is null and release rejects stale hashes', async () => {
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
  expect(await h.mcp.store.setToolSetting('builtin', 'Read', 'always-allow')).toEqual({
    ok: false,
    code: 'invalid-id',
  })
  expect(
    await h.call('mcp.setToolSetting', { id: 'notes', tool: 'echo', setting: 'always-allow' }),
  ).toEqual({ ok: false, code: 'interaction-required' })
  tool.requiresUserInteraction = false
  const original = h.host.policy.current
  h.host.policy.current = () => ({ status: 'unavailable' }) as ReturnType<typeof original>
  expect(
    await h.call('mcp.setToolSetting', { id: 'notes', tool: 'echo', setting: 'always-allow' }),
  ).toEqual({ ok: false, code: 'policy-asks' })
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
  h.providers.register({ ...template, id: 'fixture-configured', maxToolsPerRequest: 1 })
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
    { providerId: 'fixture-configured', omitted: 2 },
  ])
})
