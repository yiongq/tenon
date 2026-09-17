import { describe, expect, it } from 'vitest'
import { createMemoryHost } from '../../src/host/memory.js'
import { absolutePath, joinPath } from '../../src/host/path.js'
import { PROFILE_CONFIG_FILE, profileDirFor } from '../../src/host/profile.js'

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
