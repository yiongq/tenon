import { describe, expect, it } from 'vitest'
import type { HostAdapter } from '../../src/host/adapter.js'
import { createMemoryHost } from '../../src/host/memory.js'
import type { MemoryHost } from '../../src/host/memory.js'
import { absolutePath, joinPath } from '../../src/host/path.js'
import { EMPTY_POLICY } from '../../src/host/policy.js'
import type { PolicyState } from '../../src/host/policy.js'
import { PROFILE_CONFIG_FILE, profileDirFor } from '../../src/host/profile.js'
import { fakeNetwork } from '../../src/testing/index.js'

describe('MemoryHost fs', () => {
  it('requires the parent directory to exist, like a real filesystem', async () => {
    const host = createMemoryHost()
    const file = absolutePath('/a/b/config.json')
    await expect(host.fs.writeFile(file, '{}')).rejects.toThrow(/ENOENT/)
    await host.fs.mkdirp(absolutePath('/a/b'))
    await host.fs.writeFile(file, '{"locale":"en"}')
    expect(await host.fs.readFile(file, { encoding: 'utf8' })).toBe('{"locale":"en"}')
    expect(await host.fs.readdir(absolutePath('/a/b'))).toEqual(['config.json'])
    expect(await host.fs.stat(file)).toMatchObject({ size: 15, isDir: false })
    expect(await host.fs.stat(absolutePath('/a'))).toMatchObject({ isDir: true })
    expect(await host.fs.stat(absolutePath('/nope'))).toBeNull()
  })

  it('returns bytes by default and copies them', async () => {
    const host = createMemoryHost()
    const file = absolutePath('/blob')
    const data = new Uint8Array([1, 2, 3])
    await host.fs.writeFile(file, data)
    data[0] = 9
    const read = (await host.fs.readFile(file)) as Uint8Array
    expect([...read]).toEqual([1, 2, 3])
  })

  it('rejects relative and non-POSIX paths', async () => {
    const host = createMemoryHost()
    await expect(host.fs.stat('relative' as never)).rejects.toThrow(TypeError)
    await expect(host.fs.stat('C:\\x' as never)).rejects.toThrow(/POSIX/)
  })

  it('keeps two profiles (different tenantId) in different, invisible paths', async () => {
    const root = absolutePath('/data')
    const host = createMemoryHost()
    const dirA = profileDirFor(root, 'u1', 'tenant-a')
    const dirB = profileDirFor(root, 'u1', 'tenant-b')
    await host.fs.mkdirp(dirA)
    await host.fs.mkdirp(dirB)
    await host.fs.writeFile(joinPath(dirA, PROFILE_CONFIG_FILE), '{"locale":"zh-CN"}')
    await host.fs.writeFile(joinPath(dirB, PROFILE_CONFIG_FILE), '{"locale":"en"}')
    expect(dirA).not.toBe(dirB)
    expect(await host.fs.readFile(joinPath(dirA, PROFILE_CONFIG_FILE), { encoding: 'utf8' })).toBe(
      '{"locale":"zh-CN"}',
    )
    expect(await host.fs.readFile(joinPath(dirB, PROFILE_CONFIG_FILE), { encoding: 'utf8' })).toBe(
      '{"locale":"en"}',
    )
    expect(await host.fs.readdir(dirA)).toEqual([PROFILE_CONFIG_FILE])
    expect(await host.fs.readdir(joinPath(root, 'profiles', 'u1'))).toEqual([
      'tenant-a',
      'tenant-b',
    ])
  })
})

describe('MemoryHost secrets, sandbox, confirm', () => {
  it('stores secrets by key', async () => {
    const host = createMemoryHost()
    expect(await host.secrets.get('t:k')).toBeNull()
    await host.secrets.set('t:k', 'v')
    expect(await host.secrets.get('t:k')).toBe('v')
    await host.secrets.delete('t:k')
    expect(await host.secrets.get('t:k')).toBeNull()
  })

  it('passes commands through unchanged and logs non-full-access wraps', async () => {
    const host = createMemoryHost()
    const base = {
      argv: ['/bin/ls', '-la'],
      cwd: absolutePath('/w'),
      env: { PATH: '/bin' },
      workspace: [absolutePath('/w')],
    }
    const full = await host.sandbox.wrap({ ...base, commandId: 'c1', profile: 'full-access' })
    expect(full).toEqual({ argv: ['/bin/ls', '-la'], env: { PATH: '/bin' } })
    const ro = await host.sandbox.wrap({ ...base, commandId: 'c2', profile: 'read-only' })
    expect(ro).toEqual({ argv: ['/bin/ls', '-la'], env: { PATH: '/bin' } })
    expect(host.sandboxLog).toEqual(['sandbox: passthrough c2 read-only'])
    expect(await host.sandbox.violations('c2')).toEqual([])
  })

  it('records confirm requests instead of answering them', async () => {
    const host = createMemoryHost()
    await host.confirm.request({
      requestId: 'r1',
      sessionId: 's1',
      kind: 'command',
      reason: 'elevated',
      facts: { command: 'sudo rm' },
      reversibility: 'irreversible',
      target: { type: 'command', command: 'sudo rm', cwd: absolutePath('/w') },
    })
    expect(host.confirmRequests).toHaveLength(1)
    expect(host.confirmRequests[0]?.reason).toBe('elevated')
  })

  it('has no way to spawn unless a HostProcess is injected', async () => {
    const host = createMemoryHost()
    await expect(
      host.process.spawn({ argv: ['/bin/true'], cwd: absolutePath('/'), env: {}, stdio: 'pipe' }),
    ).rejects.toThrow(/inject/)
  })
})

describe('MemoryHost network', () => {
  it('has no way out unless a HostNetwork is injected', async () => {
    const host = createMemoryHost()
    await expect(host.network.fetch('https://api.example.test/v1')).rejects.toThrow(/inject/)
  })

  it('uses the injected network and nothing else', async () => {
    const net = fakeNetwork({ kind: 'json', body: { ok: true } })
    const host = createMemoryHost({ network: net })
    const response = await host.network.fetch('https://api.example.test/v1', {
      method: 'POST',
      body: '{"model":"m"}',
    })
    expect(await response.json()).toEqual({ ok: true })
    expect(net.requests).toMatchObject([
      { url: 'https://api.example.test/v1', method: 'POST', body: { model: 'm' } },
    ])
  })
})

describe('MemoryHost clock', () => {
  it('is manual and fires timers in due order', () => {
    const host = createMemoryHost({ now: 1_000 })
    const fired: string[] = []
    host.clock.setTimeout(() => fired.push('b'), 20)
    const cancel = host.clock.setTimeout(() => fired.push('cancelled'), 5)
    host.clock.setTimeout(() => fired.push('a'), 10)
    cancel()
    expect(host.clock.now()).toBe(1_000)
    host.advance(15)
    expect(fired).toEqual(['a'])
    expect(host.clock.now()).toBe(1_015)
    host.advance(100)
    expect(fired).toEqual(['a', 'b'])
    expect(host.clock.now()).toBe(1_115)
  })
})

/** A host with every member but `policy`: what spec 02 acceptance 5 says must not compile. */
function withoutPolicy(host: MemoryHost): Omit<HostAdapter, 'policy'> {
  return host
}

describe('MemoryHost policy', () => {
  const orgPolicy: PolicyState = {
    status: 'current',
    version: 'v2',
    snapshot: { tools: [{ policyId: 'p1', serverId: 'builtin', effect: 'deny' }] },
  }

  it('is a required HostAdapter member', () => {
    // @ts-expect-error — `policy` is the ninth member (spec 02 §对 00-foundation 的修补).
    const host: HostAdapter = withoutPolicy(createMemoryHost())
    expect(host).toBeDefined()
  })

  it('defaults to the empty policy of a personal tenant', () => {
    expect(createMemoryHost().policy.current()).toEqual({
      status: 'current',
      version: 'empty',
      snapshot: EMPTY_POLICY,
    })
    expect(EMPTY_POLICY).toEqual({ tools: [] })
  })

  it('takes an injected policy', () => {
    const host = createMemoryHost({ policy: { status: 'unavailable' } })
    expect(host.policy.current()).toEqual({ status: 'unavailable' })
  })

  it('setPolicy replaces current() and tells every subscriber before it returns', () => {
    const host = createMemoryHost()
    const seen: string[] = []
    const record = (tag: string) => (state: PolicyState) => {
      seen.push(`${tag}:${state.status === 'unavailable' ? state.status : state.version}`)
    }
    host.policy.subscribe(record('a'))
    const listener = record('b')
    host.policy.subscribe(listener)
    host.policy.subscribe(listener) // a second subscription of the same function is its own
    host.setPolicy(orgPolicy)
    expect(seen).toEqual(['a:v2', 'b:v2', 'b:v2'])
    expect(host.policy.current()).toBe(orgPolicy)
    host.setPolicy({ status: 'cached', version: 'v2', snapshot: orgPolicy.snapshot })
    expect(host.policy.current()).toMatchObject({ status: 'cached', version: 'v2' })
    expect(seen).toHaveLength(6)
  })

  it('stops calling a listener once its unsubscribe function ran', () => {
    const host = createMemoryHost()
    const seen: PolicyState[] = []
    const unsubscribe = host.policy.subscribe((state) => seen.push(state))
    const kept: PolicyState[] = []
    host.policy.subscribe((state) => kept.push(state))
    host.setPolicy(orgPolicy)
    unsubscribe()
    host.setPolicy({ status: 'unavailable' })
    unsubscribe() // calling it twice is harmless
    host.setPolicy(orgPolicy)
    expect(seen).toEqual([orgPolicy])
    expect(kept).toEqual([orgPolicy, { status: 'unavailable' }, orgPolicy])
  })

  it('does not call a listener that an earlier listener unsubscribed during the same change', () => {
    const host = createMemoryHost()
    const seen: string[] = []
    let unsubscribeSecond: (() => void) | undefined
    host.policy.subscribe(() => {
      seen.push('first')
      unsubscribeSecond?.()
    })
    unsubscribeSecond = host.policy.subscribe(() => seen.push('second'))
    host.setPolicy(orgPolicy)
    expect(seen).toEqual(['first'])
  })
})

/**
 * Links in the memory host (spec 02 §内存宿主): followed like node follows them on a real disk, and
 * realpath per the HostFs contract. The link-escape cases run here, in the kernel, without a disk;
 * apps/desktop/test/host.test.ts runs the same cases against the real filesystem.
 */
async function tree(): Promise<MemoryHost> {
  const host = createMemoryHost()
  await host.fs.mkdirp(absolutePath('/ws'))
  await host.fs.mkdirp(absolutePath('/outside'))
  await host.fs.writeFile(absolutePath('/outside/f.txt'), 'outside')
  return host
}

describe('MemoryHost symbolic links', () => {
  it('realpath throws for the dangling ws/evil → ../outside/new.txt, not null', async () => {
    const host = await tree()
    const evil = absolutePath('/ws/evil')
    host.symlink(evil, '../outside/new.txt')
    // The 2026-09-25 disk facts: realpath fails like a missing path, the entry is there...
    await expect(host.fs.realpath(evil)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await host.fs.stat(evil)).toBeNull()
    expect(await host.fs.readdir(absolutePath('/ws'))).toEqual(['evil'])
    // ...and writing through it creates a file outside the workspace.
    await host.fs.writeFile(evil, 'escaped')
    expect([...host.files.keys()].toSorted()).toEqual(['/outside/f.txt', '/outside/new.txt'])
    expect(await host.fs.readFile(absolutePath('/outside/new.txt'), { encoding: 'utf8' })).toBe(
      'escaped',
    )
    expect(await host.fs.realpath(evil)).toBe('/outside/new.txt')
  })

  it('realpath throws for a link whose target directory is missing too', async () => {
    const host = await tree()
    host.symlink(absolutePath('/ws/evil'), '../nowhere/x.txt')
    await expect(host.fs.realpath(absolutePath('/ws/evil'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(host.fs.writeFile(absolutePath('/ws/evil'), 'x')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('realpath is null only when the entry itself is absent', async () => {
    const host = await tree()
    expect(await host.fs.realpath(absolutePath('/ws/new.txt'))).toBeNull()
    expect(await host.fs.realpath(absolutePath('/ws/a/b/c'))).toBeNull()
    expect(await host.fs.realpath(absolutePath('/outside/f.txt/x'))).toBeNull() // ENOTDIR
    expect(await host.fs.realpath(absolutePath('/ws'))).toBe('/ws')
    expect(await host.fs.realpath(absolutePath('/'))).toBe('/')
  })

  it('realpath throws on a link loop, and so does everything that follows it', async () => {
    const host = await tree()
    host.symlink(absolutePath('/ws/a'), 'b')
    host.symlink(absolutePath('/ws/b'), '/ws/a')
    host.symlink(absolutePath('/ws/self'), 'self')
    const loops = ['/ws/a', '/ws/b', '/ws/self', '/ws/a/x'].map((path) => absolutePath(path))
    const calls = loops.flatMap((path) => [
      host.fs.realpath(path),
      host.fs.stat(path),
      host.fs.readFile(path),
      host.fs.writeFile(path, 'x'),
      host.fs.mkdirp(path),
    ])
    const codes = await Promise.all(
      calls.map((call) =>
        call.then(
          () => 'resolved',
          (err: { code?: string }) => err.code,
        ),
      ),
    )
    expect(codes).toEqual(Array.from({ length: loops.length * 5 }, () => 'ELOOP'))
    expect(host.files.size).toBe(1)
  })

  it('resolves relative, absolute and chained links to the real path', async () => {
    const host = await tree()
    host.symlink(absolutePath('/ws/out'), '../outside')
    host.symlink(absolutePath('/ws/out2'), 'out')
    host.symlink(absolutePath('/ws/abs'), '/outside/f.txt')
    host.symlink(absolutePath('/ws/up'), './out/..')
    expect(await host.fs.realpath(absolutePath('/ws/out'))).toBe('/outside')
    expect(await host.fs.realpath(absolutePath('/ws/out2/f.txt'))).toBe('/outside/f.txt')
    expect(await host.fs.realpath(absolutePath('/ws/abs'))).toBe('/outside/f.txt')
    // `..` applies to the directory the link reached, not to the path as written.
    expect(await host.fs.realpath(absolutePath('/ws/out/../ws'))).toBe('/ws')
    expect(await host.fs.realpath(absolutePath('/ws/up'))).toBe('/')
    expect(await host.fs.realpath(absolutePath('/ws/out/missing.txt'))).toBeNull()
  })

  it('reads, lists, writes and creates directories through a directory link', async () => {
    const host = await tree()
    host.symlink(absolutePath('/ws/out'), '../outside')
    expect(await host.fs.stat(absolutePath('/ws/out'))).toMatchObject({ isDir: true })
    expect(await host.fs.readFile(absolutePath('/ws/out/f.txt'), { encoding: 'utf8' })).toBe(
      'outside',
    )
    await host.fs.writeFile(absolutePath('/ws/out/viadir.txt'), 'v')
    await host.fs.mkdirp(absolutePath('/ws/out/d1/d2'))
    expect(await host.fs.readdir(absolutePath('/ws/out'))).toEqual(['d1', 'f.txt', 'viadir.txt'])
    expect(await host.fs.readdir(absolutePath('/outside'))).toEqual(['d1', 'f.txt', 'viadir.txt'])
    expect(await host.fs.readdir(absolutePath('/ws'))).toEqual(['out'])
    expect(await host.fs.stat(absolutePath('/outside/d1/d2'))).toMatchObject({ isDir: true })
    expect(host.files.has('/outside/viadir.txt')).toBe(true)
    await host.fs.mkdirp(absolutePath('/ws/out')) // a link to a directory already is one
  })

  it('mkdirp never creates what a dangling link points to', async () => {
    const host = await tree()
    host.symlink(absolutePath('/ws/evil'), '../outside/new')
    host.symlink(absolutePath('/ws/tofile'), '../outside/f.txt')
    await expect(host.fs.mkdirp(absolutePath('/ws/evil'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(host.fs.mkdirp(absolutePath('/ws/evil/sub'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
    await expect(host.fs.mkdirp(absolutePath('/ws/tofile'))).rejects.toMatchObject({
      code: 'EEXIST',
    })
    await expect(host.fs.mkdirp(absolutePath('/ws/tofile/x'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
    expect(await host.fs.stat(absolutePath('/outside/new'))).toBeNull()
  })

  it('refuses a link over an existing entry or under a missing directory', async () => {
    const host = await tree()
    host.symlink(absolutePath('/ws/l'), 'x')
    expect(() => host.symlink(absolutePath('/ws/l'), 'y')).toThrow(/EEXIST/)
    expect(() => host.symlink(absolutePath('/outside/f.txt'), 'y')).toThrow(/EEXIST/)
    expect(() => host.symlink(absolutePath('/ws'), 'y')).toThrow(/EEXIST/)
    expect(() => host.symlink(absolutePath('/nope/l'), 'y')).toThrow(/ENOENT/)
    expect(() => host.symlink(absolutePath('/ws/empty'), '')).toThrow(/ENOENT/)
  })
})
