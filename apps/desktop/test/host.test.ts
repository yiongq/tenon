import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { policyStateSchema } from '@tenon-app/contracts'
import type { AbsolutePath, HostFs, PolicyState } from '@tenon-app/kernel'
import {
  EMPTY_POLICY,
  UnresolvableAliasError,
  absolutePath,
  createMemoryHost,
} from '@tenon-app/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IpcConfirm } from '../src/main/host/confirm.js'
import { DesktopFs } from '../src/main/host/fs.js'
import { createDesktopHost, useMemorySecrets } from '../src/main/host/index.js'
import { EmptyPolicy } from '../src/main/host/policy.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'
import { MemorySecrets } from '../src/main/host/secrets.js'

describe('PassthroughSandbox', () => {
  const base = {
    argv: ['/bin/ls', '-la'],
    cwd: absolutePath('/w'),
    env: { PATH: '/bin' },
    workspace: [absolutePath('/w')],
  }

  it('returns the command unchanged and logs every restricted profile', async () => {
    const lines: string[] = []
    const sandbox = new PassthroughSandbox((line) => lines.push(line))
    expect(await sandbox.wrap({ ...base, commandId: 'c1', profile: 'full-access' })).toEqual({
      argv: base.argv,
      env: base.env,
    })
    expect(lines).toEqual([])
    await sandbox.wrap({ ...base, commandId: 'c2', profile: 'workspace-write' })
    await sandbox.wrap({ ...base, commandId: 'c3', profile: 'read-only' })
    expect(lines).toEqual([
      'sandbox: passthrough c2 workspace-write',
      'sandbox: passthrough c3 read-only',
    ])
  })
})

describe('IpcConfirm', () => {
  const request = {
    requestId: 'r1',
    sessionId: 's1',
    kind: 'command' as const,
    reason: 'elevated' as const,
    facts: { command: 'sudo make install' },
    reversibility: 'unknown' as const,
    target: { type: 'command' as const, command: 'sudo make install', cwd: absolutePath('/w') },
  }

  it('never sends the redacted payload to the renderer', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const confirm = new IpcConfirm((channel, payload) => sent.push({ channel, payload }))
    await confirm.request({ ...request, redacted: { authorization: 'Bearer secret' } })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.channel).toBe('confirm.request')
    expect(sent[0]?.payload).toEqual(request)
    expect(JSON.stringify(sent[0]?.payload)).not.toContain('secret')
  })

  it('does not deliver a request that misses a required fact', async () => {
    const sent: unknown[] = []
    const confirm = new IpcConfirm((_channel, payload) => sent.push(payload))
    await expect(confirm.request({ ...request, facts: {} })).rejects.toThrow(/facts\.command/)
    expect(sent).toEqual([])
  })
})

/**
 * The e2e secrets seam (spec 01 §desktop 接线). It is a security boundary in both directions: a
 * packaged build must never take its credential store from the environment, and an automated run
 * must never write into the developer's login keychain.
 */
describe('the secrets seam', () => {
  it('leaves the OS keychain in place unless a dev build asks for memory', () => {
    expect(useMemorySecrets(false, {})).toBe(false)
    expect(useMemorySecrets(false, { TENON_SECRETS: 'memory' })).toBe(true)
    expect(useMemorySecrets(false, { TENON_SECRETS: 'keychain' })).toBe(false)
    expect(useMemorySecrets(true, { TENON_SECRETS: 'memory' })).toBe(false)
  })

  it('keeps memory secrets in this process and forgets a deleted one', async () => {
    const secrets = new MemorySecrets()
    expect(await secrets.get('tenant:provider:anthropic:apiKey')).toBeNull()
    await secrets.set('tenant:provider:anthropic:apiKey', 'k')
    expect(await secrets.get('tenant:provider:anthropic:apiKey')).toBe('k')
    await secrets.delete('tenant:provider:anthropic:apiKey')
    expect(await secrets.get('tenant:provider:anthropic:apiKey')).toBeNull()
  })
})

describe('the desktop policy', () => {
  const personal = { status: 'current', version: 'empty', snapshot: EMPTY_POLICY }

  it('is always the empty policy of a personal tenant, and passes policyStateSchema', () => {
    const policy = new EmptyPolicy()
    expect(policy.current()).toEqual(personal)
    const state = policy.current()
    expect(state.status === 'current' ? state.snapshot : null).toBe(EMPTY_POLICY)
    expect(policyStateSchema.parse(policy.current())).toEqual(personal)
  })

  it('never calls a subscriber', async () => {
    const policy = new EmptyPolicy()
    const seen: PolicyState[] = []
    const unsubscribe = policy.subscribe((state) => seen.push(state))
    policy.current()
    await new Promise((resolve) => setTimeout(resolve, 0))
    unsubscribe()
    expect(seen).toEqual([])
  })

  it('is the policy member of the desktop host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-host-'))
    try {
      const host = await createDesktopHost({
        userDataDir: absolutePath(root),
        userId: 'local',
        tenantId: 'tenant',
        send: () => {},
        log: () => {},
        isPackaged: false,
      })
      expect(host.policy).toBeInstanceOf(EmptyPolicy)
      expect(host.policy.current()).toEqual(personal)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

interface ProbeHost {
  readonly fs: HostFs
  /** `ws/` and `outside/` exist under it. */
  readonly root: string
  readonly link: (path: string, target: string) => Promise<void>
}

/** A call's outcome with the root masked, so two hosts on different roots compare equal. */
async function outcome(root: string, run: () => Promise<unknown>): Promise<unknown> {
  try {
    const value = await run()
    return typeof value === 'string' ? value.replace(root, '<root>') : value
  } catch (err) {
    return `throws ${(err as { code?: string }).code}`
  }
}

/** The same links and the same calls, in the same order, on one host; every outcome by name. */
async function linkProbes(host: ProbeHost): Promise<Record<string, unknown>> {
  const p = (relative: string) => absolutePath(`${host.root}/${relative}`)
  await host.fs.writeFile(p('outside/f.txt'), 'f')
  const links: Array<[string, string]> = [
    ['ws/evil', '../outside/new.txt'],
    ['ws/evil2', '../nowhere/x.txt'],
    ['ws/out', '../outside'],
    ['ws/out2', 'out'],
    ['ws/tofile', '../outside/f.txt'],
    ['ws/abs', `${host.root}/outside/f.txt`],
    ['ws/a', 'b'],
    ['ws/b', 'a'],
  ]
  await Promise.all(links.map(([path, target]) => host.link(path, target)))
  const probes: Array<[string, () => Promise<unknown>]> = []
  for (const path of [
    'ws/evil',
    'ws/evil/',
    'ws/evil/.',
    'ws/evil2',
    'ws/out',
    'ws/out2/f.txt',
    'ws/abs',
    'ws/tofile',
    'ws/a',
    'ws/a/x',
    'ws/missing',
    'ws/out/missing',
    'outside/f.txt/x',
  ]) {
    probes.push(
      [`realpath ${path}`, () => host.fs.realpath(p(path))],
      [
        `stat ${path}`,
        async () => {
          const s = await host.fs.stat(p(path))
          // A directory's size is the filesystem's business; only a file's is compared.
          return s === null ? null : { isDir: s.isDir, size: s.isDir ? 'dir' : s.size }
        },
      ],
      [`readFile ${path}`, () => host.fs.readFile(p(path), { encoding: 'utf8' })],
    )
  }
  for (const path of [
    'ws/evil',
    'ws/evil/sub',
    'ws/tofile',
    'ws/tofile/x',
    'ws/a',
    'ws/out/d1/d2',
  ]) {
    probes.push([`mkdirp ${path}`, () => host.fs.mkdirp(p(path))])
  }
  for (const path of ['ws/evil', 'ws/evil2', 'ws/out/via.txt', 'ws/a']) {
    probes.push([`writeFile ${path}`, () => host.fs.writeFile(p(path), 'w')])
  }
  probes.push(
    ['readdir ws', () => host.fs.readdir(p('ws'))],
    ['readdir ws/out', () => host.fs.readdir(p('ws/out'))],
    ['readdir ws/tofile', () => host.fs.readdir(p('ws/tofile'))],
    ['readdir outside/f.txt', () => host.fs.readdir(p('outside/f.txt'))],
    ['realpath ws/evil after the write', () => host.fs.realpath(p('ws/evil'))],
  )
  const seen: Record<string, unknown> = {}
  for (const [name, run] of probes) {
    // oxlint-disable-next-line no-await-in-loop -- writes change what later probes see
    seen[name] = await outcome(host.root, run)
  }
  return seen
}

/**
 * HostFs.realpath on the real disk (spec 02 §`HostFs.realpath`, D8). The first case reproduces the
 * 2026-09-25 finding that made the lstat fallback necessary; the last one runs the same link cases
 * through the memory host and requires the same outcome, since the kernel's link-escape tests rely
 * on the memory host behaving like this.
 */
describe('DesktopFs.realpath', () => {
  const fs = new DesktopFs()
  let root = ''
  const at = (relative: string): AbsolutePath => absolutePath(join(root, relative))

  beforeEach(async () => {
    // realpath first: macOS hands out /var/folders/... under the /var → /private/var link.
    root = await realpath(await mkdtemp(join(tmpdir(), 'tenon-realpath-')))
    await mkdir(join(root, 'ws'))
    await mkdir(join(root, 'outside'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('throws for the dangling ws/evil → ../outside/new.txt, not null', async () => {
    await symlink('../outside/new.txt', join(root, 'ws/evil'))
    // The disk facts: node's realpath says ENOENT, as for a missing path; lstat sees the entry;
    await expect(realpath(join(root, 'ws/evil'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(join(root, 'ws/evil'))).isSymbolicLink()).toBe(true)
    // so the host must throw rather than report "not there yet".
    await expect(fs.realpath(at('ws/evil'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.stat(at('ws/evil'))).toBeNull()
    // What reading it as "not there yet" would let through: writing creates a file outside.
    await fs.writeFile(at('ws/evil'), 'escaped')
    expect(await readdir(join(root, 'outside'))).toEqual(['new.txt'])
    expect(await fs.realpath(at('ws/evil'))).toBe(join(root, 'outside/new.txt'))
  })

  it('is null only when the entry itself is absent', async () => {
    await fs.writeFile(at('outside/f.txt'), 'f')
    expect(await fs.realpath(at('ws/new.txt'))).toBeNull()
    expect(await fs.realpath(at('ws/a/b/c'))).toBeNull()
    expect(await fs.realpath(at('outside/f.txt/x'))).toBeNull() // ENOTDIR
    expect(await fs.realpath(at('ws'))).toBe(join(root, 'ws'))
  })

  // macOS's volfs reaches a file by inode, and realpath(3) cannot name what it reaches that way
  // (§`HostFs.realpath`; owner 2026-09-27, s11-safety-2).
  it.runIf(process.platform === 'darwin' && existsSync('/.vol'))(
    'throws UnresolvableAliasError for a /.vol name, and keeps a missing name null',
    async () => {
      await fs.writeFile(at('ws/f.txt'), 'f')
      const vol = async (relative: string): Promise<AbsolutePath> => {
        const s = await stat(join(root, relative), { bigint: true })
        return absolutePath(`/.vol/${String(s.dev)}/${String(s.ino)}`)
      }
      const file = await vol('ws/f.txt')
      const folder = await vol('ws')
      // The disk facts: realpath says ENOENT, as for a missing path; lstat sees a file; it reads.
      await expect(realpath(file)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await lstat(file)).isFile()).toBe(true)
      expect(await readFile(file, 'utf8')).toBe('f')
      const thrown: unknown = await fs.realpath(file).catch((error: unknown) => error)
      expect(thrown).toBeInstanceOf(UnresolvableAliasError)
      expect(thrown).toMatchObject({ path: file, cause: { code: 'ENOENT' } })
      for (const named of [folder, absolutePath(`${folder}/f.txt`)]) {
        // oxlint-disable-next-line no-await-in-loop -- one path at a time
        await expect(fs.realpath(named)).rejects.toBeInstanceOf(UnresolvableAliasError)
      }
      // A name not there yet is missing, as anywhere else.
      expect(await fs.realpath(absolutePath(`${folder}/new.txt`))).toBeNull()
      // A link to a /.vol name is dangling: the OS does not follow it either, so its own error stays.
      await symlink(file, join(root, 'ws/to-vol'))
      await expect(readFile(join(root, 'ws/to-vol'))).rejects.toMatchObject({ code: 'ENOENT' })
      const linked: unknown = await fs.realpath(at('ws/to-vol')).catch((error: unknown) => error)
      expect(linked).not.toBeInstanceOf(UnresolvableAliasError)
      expect(linked).toMatchObject({ code: 'ENOENT' })
    },
  )

  it('throws on a link loop', async () => {
    await symlink('b', join(root, 'ws/a'))
    await symlink('a', join(root, 'ws/b'))
    await expect(fs.realpath(at('ws/a'))).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(fs.realpath(at('ws/a/x'))).rejects.toMatchObject({ code: 'ELOOP' })
  })

  it('resolves links, the tmp directory link included, to the real path', async () => {
    await symlink('../outside', join(root, 'ws/out'))
    await fs.writeFile(at('outside/f.txt'), 'f')
    expect(await fs.realpath(at('ws/out/f.txt'))).toBe(join(root, 'outside/f.txt'))
    const unresolved = await mkdtemp(join(tmpdir(), 'tenon-realpath-raw-'))
    try {
      expect(await fs.realpath(absolutePath(unresolved))).toBe(await realpath(unresolved))
    } finally {
      await rm(unresolved, { recursive: true, force: true })
    }
  })

  it('follows links in the memory host the way it does on disk', async () => {
    const memory = createMemoryHost()
    await memory.fs.mkdirp(absolutePath('/r/ws'))
    await memory.fs.mkdirp(absolutePath('/r/outside'))
    const onDisk = await linkProbes({
      fs,
      root,
      link: (path, target) => symlink(target, join(root, path)),
    })
    const inMemory = await linkProbes({
      fs: memory.fs,
      root: '/r',
      link: async (path, target) => memory.symlink(absolutePath(`/r/${path}`), target),
    })
    expect(inMemory).toEqual(onDisk)
    // Spot checks, so an agreement on the wrong behaviour still fails.
    expect(onDisk).toMatchObject({
      'realpath ws/evil': 'throws ENOENT',
      'realpath ws/evil/': 'throws ENOENT',
      'realpath ws/evil/.': 'throws ENOENT',
      'readdir ws/tofile': 'throws ENOTDIR',
      'stat ws/evil': null,
      'realpath ws/a': 'throws ELOOP',
      'realpath ws/missing': null,
      'writeFile ws/evil': undefined,
      'readdir ws/out': ['d1', 'f.txt', 'new.txt', 'via.txt'],
      'realpath ws/evil after the write': '<root>/outside/new.txt',
    })
  })
})
