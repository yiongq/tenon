/**
 * Spec 04 §包装契约 and §退出: `DesktopSandbox` against a fake sandbox-runtime and a fake disk (04 验收
 * 3 the host half, 4, 8, 9 the host half, 11 the Linux link check, 15 the host half, 23 the host half;
 * 04 不变量 2, 3, 7, 8). The fake srt records every call; its violation store keeps the last 100
 * events and keys them by the first 100 characters of the id, as srt79's does
 * (sandbox-violation-store.js:9, :22-24; sandbox-utils.js:903-921). Every expected value below is a
 * literal from the spec, never computed by the code under test.
 */
import type { SandboxRuntimeConfig, SandboxViolationEvent } from '@anthropic-ai/sandbox-runtime'
import type { AbsolutePath, SandboxRequest } from '@tenon-app/kernel'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  DesktopSandbox,
  SandboxUnavailableError,
  type SandboxFileStat,
  type SandboxFs,
  type SandboxSettings,
  type SandboxStartup,
  type SrtSandbox,
  type SrtViolationStore,
} from '../../src/main/host/sandbox.js'
import {
  credentialPaths,
  SandboxConfigError,
  sessionConfig,
  type SandboxHostPaths,
  type SandboxPlatform,
} from '../../src/main/host/sandbox-config.js'

const p = (path: string): AbsolutePath => path as AbsolutePath

const SESSION = '6f1c2a4e-3b5d-4c7e-9f80-1a2b3c4d5e6f'
const TOOL_USE = 'toolu_01Hx7ZbQe2fXkq3VJt9Lw4Rn'
const SELF: Readonly<Record<SandboxPlatform, number>> = { darwin: 501, linux: 1000 }
const ANOTHER_USER = 0

/** What srt hands back as env: main's own `process.env`, which Tenon must never forward (T6). */
const SRT_ENV = {
  PATH: '/usr/bin:/bin',
  SECRET_FROM_DOTENV: 'sk-test-not-a-key',
  HTTPS_PROXY: 'http://srt:proxy-token@localhost:51000',
  ELECTRON_RUN_AS_NODE: '1',
}

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------------------------
// A fake disk

interface Node {
  readonly kind: 'dir' | 'file' | 'link'
  readonly uid: number
  readonly mode: number
  readonly target?: string
  readonly text?: string
}

function errno(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code })
}

/** Paths resolve like the kernel's: every link on the way followed, the last one only if asked. */
class FakeDisk implements SandboxFs {
  readonly nodes = new Map<string, Node>([['/', { kind: 'dir', uid: 0, mode: 0o755 }]])

  private readonly self: number

  constructor(self: number) {
    this.self = self
  }

  /** A directory and any missing ancestor (root's, 0755); the directory itself as given. */
  dir(path: string, own: { uid?: number; mode?: number } = {}): void {
    let at = ''
    for (const part of path.split('/').filter(Boolean)) {
      at += `/${part}`
      if (!this.nodes.has(at)) this.nodes.set(at, { kind: 'dir', uid: 0, mode: 0o755 })
    }
    this.nodes.set(path, { kind: 'dir', uid: own.uid ?? this.self, mode: own.mode ?? 0o755 })
  }

  file(path: string, text = '', mode = 0o644): void {
    this.nodes.set(path, { kind: 'file', uid: this.self, mode, text })
  }

  link(path: string, target: string): void {
    this.nodes.set(path, { kind: 'link', uid: this.self, mode: 0o755, target })
  }

  remove(path: string): void {
    for (const key of this.nodes.keys()) {
      if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key)
    }
  }

  lstat(path: string): SandboxFileStat | undefined {
    const found = this.find(path, false)
    return found?.node === undefined ? undefined : statOf(found.node)
  }

  stat(path: string): SandboxFileStat | undefined {
    const found = this.find(path, true)
    return found?.node === undefined ? undefined : statOf(found.node)
  }

  realpath(path: string): string {
    const { real, node } = this.walk(path, true)
    if (node === undefined) throw errno('ENOENT', path)
    return real
  }

  readlink(path: string): string {
    const { node } = this.walk(path, false)
    if (node?.kind !== 'link' || node.target === undefined) throw errno('EINVAL', path)
    return node.target
  }

  mkdirPrivate(path: string): void {
    let at = ''
    for (const part of path.split('/').filter(Boolean)) {
      at += `/${part}`
      const { real, node } = this.walk(at, true)
      if (node === undefined) this.nodes.set(real, { kind: 'dir', uid: this.self, mode: 0o700 })
      else if (node.kind !== 'dir') throw errno('EEXIST', at)
    }
  }

  readFile(path: string): string | undefined {
    const found = this.find(path, true)
    if (found?.node === undefined) return undefined
    if (found.node.kind !== 'file') throw errno('EISDIR', path)
    return found.node.text ?? ''
  }

  writeFile(path: string, text: string): void {
    const { real } = this.walk(path, true)
    this.nodes.set(real, { kind: 'file', uid: this.self, mode: 0o600, text })
  }

  /** `walk`, with a missing ancestor read as nothing there (node's `throwIfNoEntry: false`). */
  private find(path: string, follow: boolean): { node: Node | undefined } | undefined {
    try {
      return this.walk(path, follow)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private walk(path: string, followLast: boolean): { real: string; node: Node | undefined } {
    let parts = path.split('/').filter(Boolean)
    let at = ''
    let hops = 0
    for (let i = 0; i < parts.length; i += 1) {
      const next = `${at}/${parts[i]}`
      const node = this.nodes.get(next)
      const last = i === parts.length - 1
      if (node === undefined) {
        if (last) return { real: next, node: undefined }
        throw errno('ENOENT', path)
      }
      if (node.kind === 'link' && (!last || followLast)) {
        hops += 1
        if (hops > 40) throw errno('ELOOP', path)
        const target = node.target ?? ''
        const base = target.startsWith('/') ? [] : at.split('/').filter(Boolean)
        parts = [...base, ...target.split('/').filter(Boolean), ...parts.slice(i + 1)]
        at = ''
        i = -1
        continue
      }
      if (!last && node.kind !== 'dir') throw errno('ENOTDIR', path)
      at = next
    }
    const real = at === '' ? '/' : at
    return { real, node: this.nodes.get(real) }
  }
}

function statOf(node: Node): SandboxFileStat {
  return {
    isDirectory: () => node.kind === 'dir',
    isSymbolicLink: () => node.kind === 'link',
    uid: node.uid,
    mode: node.mode,
  }
}

// ---------------------------------------------------------------------------------------------
// A fake srt

/** srt79's store, cut down: the last 100 events, a running total, listeners told everything. */
class FakeStore implements SrtViolationStore {
  private events: SandboxViolationEvent[] = []
  private total = 0
  private readonly listeners = new Set<(events: SandboxViolationEvent[]) => void>()

  /**
   * An event as srt's producers record it: keyed by the first 100 characters of the id, and
   * unattributed when that key base64s past the 251 bytes a carrier holds (the proxy's username
   * and the Linux observer's socket, sandbox-utils.js:938-971, linux-violation-monitor.js:106-109).
   */
  add(id: string, line: string): void {
    const key = encoded(id)
    this.events.push(
      Buffer.byteLength(key) <= 251
        ? { line, encodedCommand: key, timestamp: new Date(0) }
        : { line, timestamp: new Date(0) },
    )
    this.total += 1
    if (this.events.length > 100) this.events = this.events.slice(-100)
    for (const listener of this.listeners) listener([...this.events])
  }

  getTotalCount(): number {
    return this.total
  }

  subscribe(listener: (events: SandboxViolationEvent[]) => void): () => void {
    this.listeners.add(listener)
    listener([...this.events])
    return () => this.listeners.delete(listener)
  }

  /** srt's own lookup, what the host must not wait for (读法 39). */
  getViolationsForCommand(id: string): SandboxViolationEvent[] {
    return this.events.filter((event) => event.encodedCommand === encoded(id))
  }
}

function encoded(id: string): string {
  return Buffer.from(id.slice(0, 100)).toString('base64')
}

interface WrapCall {
  readonly command: string
  readonly binShell: string
  readonly customConfig: Partial<SandboxRuntimeConfig>
  readonly cwd: string
  readonly id: string
}

function fakeSrt() {
  const store = new FakeStore()
  const calls: WrapCall[] = []
  const failures: Error[] = []
  const srt = {
    wrapWithSandboxArgv: vi.fn<SrtSandbox['wrapWithSandboxArgv']>(
      async (command, binShell, customConfig, _abort, cwd, options) => {
        calls.push({ command, binShell, customConfig, cwd, id: options.commandId })
        const failure = failures.shift()
        if (failure !== undefined) throw failure
        return {
          argv: ['/usr/bin/sandbox-exec', '-p', '(srt profile)', binShell, '-c', command],
          env: { ...SRT_ENV },
        }
      },
    ),
    cleanupAfterCommand: vi.fn<() => void>(),
    getSandboxViolationStore: () => store,
    reset: vi.fn<() => Promise<void>>(async () => {}),
  }
  return { srt, store, calls, failures }
}

// ---------------------------------------------------------------------------------------------
// The host around it

function layout(platform: SandboxPlatform) {
  const home = platform === 'darwin' ? '/Users/u' : '/home/u'
  const userData =
    platform === 'darwin' ? `${home}/Library/Application Support/Tenon` : `${home}/.config/Tenon`
  return {
    home,
    userData,
    profile: `${userData}/profiles/u1/t1`,
    cache: `${userData}/sandbox-cache`,
    cwdDir: `${userData}/sandbox-cwd`,
    ws: `${home}/code/app`,
    tmp: platform === 'darwin' ? '/private/tmp/claude' : '/tmp/claude',
  }
}

interface HarnessOptions {
  /** The startup outcome `start` gets; `'none'` leaves it unstarted. */
  readonly startup?: Partial<SandboxStartup> | 'none'
  /** Whether `initialize` returned (default: it did); false leaves `initialized` pending. */
  readonly initialized?: boolean
  /** False for the eval host, which never chdirs (读法 50). */
  readonly chdir?: boolean
}

function harness(platform: SandboxPlatform, options: HarnessOptions = {}) {
  const at = layout(platform)
  const uid = SELF[platform]
  const disk = new FakeDisk(uid)
  disk.dir(at.home, { mode: 0o750 })
  disk.dir(at.ws)
  disk.dir(at.profile, { mode: 0o700 })
  disk.dir(at.cwdDir, { mode: 0o700 })
  disk.dir(platform === 'darwin' ? '/private/tmp' : '/tmp', { uid: 0, mode: 0o777 })
  disk.dir('/opt/srt', { uid: 0 })

  const fake = fakeSrt()
  const settings: { -readonly [K in keyof SandboxSettings]: SandboxSettings[K] } = {
    profile: 'workspace-write',
    packageManagers: false,
  }
  const folders = new Map<string, AbsolutePath[]>([[SESSION, [p(at.ws)]]])
  const logs: string[] = []
  const killed: number[] = []
  const processes: { table: string; list: Mock<() => Promise<string>> } = {
    table: '',
    list: vi.fn<() => Promise<string>>(async () => processes.table),
  }
  const signals: (() => void)[] = []
  const paths: Omit<SandboxHostPaths, 'noSeccomp'> = {
    platform,
    home: p(at.home),
    zdotdir: null,
    profileDir: p(at.profile),
    cacheDir: p(at.cache),
    chdirDir: options.chdir === false ? null : p(at.cwdDir),
    srtPackageDir: p('/opt/srt'),
    credentials: credentialPaths(platform, p(at.home)),
    uid,
    xdgRuntimeDir: null,
    sshAuthSock: null,
  }
  const sandbox = new DesktopSandbox({
    srt: fake.srt,
    paths,
    settings: () => settings,
    sessionFolders: async (sessionId) => folders.get(sessionId) ?? [],
    fs: disk,
    processes: { list: processes.list, kill: (pid) => killed.push(pid) },
    onSignal: (listener) => signals.push(listener),
    log: (line) => logs.push(line),
  })
  const session = sessionConfig(
    {
      ...paths,
      noSeccomp: false,
      allowedDomains: [],
      applySeccompPath: p('/opt/srt/vendor/seccomp/arm64/apply-seccomp'),
      javaAgentJarPath: p('/opt/srt/vendor/java-proxy-agent/srt-proxy-agent.jar'),
      linuxBinaries:
        platform === 'linux'
          ? { bwrap: p('/usr/bin/bwrap'), socat: p('/usr/bin/socat'), rg: p('/usr/bin/rg') }
          : null,
    },
    disk,
  )
  if (options.startup !== 'none') {
    sandbox.start({
      initialized: options.initialized === false ? new Promise<void>(() => {}) : Promise.resolve(),
      outcome: Promise.resolve({ state: 'active', session, noSeccomp: false, ...options.startup }),
    })
  }

  const request = (overrides: Partial<SandboxRequest> = {}): SandboxRequest => ({
    commandId: TOOL_USE,
    argv: ['/bin/zsh', '-c', 'eval "$1"', '/bin/zsh', "echo it's"],
    cwd: p(at.ws),
    env: { PATH: '/usr/bin:/bin', HOME: at.home },
    profile: 'workspace-write',
    workspace: [p(at.ws)],
    ...overrides,
  })
  /** The kernel's order: `beforeWrap`, then `wrap`. */
  const run = (overrides: Partial<SandboxRequest> = {}) => {
    const req = request(overrides)
    sandbox.beforeWrap({ commandId: req.commandId, sessionId: SESSION })
    return sandbox.wrap(req)
  }
  return {
    at,
    disk,
    sandbox,
    settings,
    folders,
    logs,
    killed,
    processes,
    signals,
    session,
    request,
    run,
    ...fake,
  }
}

type Harness = ReturnType<typeof harness>

/** Lets settled promises' callbacks run (fake timers here fake only setTimeout). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/** How a wrap ended: wrapped, refused (`SandboxUnavailableError`) or another throw. */
function outcomeOf(wrapping: Promise<unknown>): Promise<string> {
  return wrapping.then(
    () => 'wrapped',
    (error: unknown) =>
      error instanceof SandboxUnavailableError ? 'refused' : `threw ${String(error)}`,
  )
}

/** Runs `step` for each item, one after another: the cases share one harness and its order. */
async function inTurn<T>(items: readonly T[], step: (item: T) => Promise<void>): Promise<void> {
  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop -- one case at a time, in order
    await step(item)
  }
}

/** Runs one fresh harness per platform. */
function onBoth(test: (platform: SandboxPlatform) => Promise<void>): Promise<void[]> {
  return Promise.all(PLATFORMS.map(test))
}

const PLATFORMS: readonly SandboxPlatform[] = ['darwin', 'linux']

/** An arrangement on a fresh harness, named so a failure says which. */
type Case = readonly [what: string, arrange: (h: Harness) => void]

/** Each case on a fresh harness: how the wrap ended and whether srt was reached. */
function refusals(
  platform: SandboxPlatform,
  cases: readonly Case[],
  prepare: (h: Harness) => void = () => {},
): Promise<[string, string, number][]> {
  return Promise.all(
    cases.map(async ([what, arrange]): Promise<[string, string, number]> => {
      const h = harness(platform)
      prepare(h)
      arrange(h)
      const outcome = await outcomeOf(h.run())
      return [what, outcome, h.srt.wrapWithSandboxArgv.mock.calls.length]
    }),
  )
}

/** The one wrap's `customConfig`, which must hold `filesystem` alone (spec §wrap 第 3 步). */
function tables(h: Harness): Partial<SandboxRuntimeConfig>['filesystem'] {
  expect(h.calls.map((call) => Object.keys(call.customConfig))).toEqual([['filesystem']])
  return h.calls[0]?.customConfig.filesystem
}

/** Turns the 「包管理器」 preset on. */
function presetOn(h: Harness): void {
  h.settings.packageManagers = true
}

const STUBS_LINUX = '/home/u/.config/Tenon/profiles/u1/t1/sandbox/stubs.json'

/** A promise that never settles. */
function pending(): Promise<never> {
  return new Promise(() => {})
}

/**
 * srt79's mount point cleanup, on the fake disk (linux-sandbox-utils.js:755-760, :797-833): a wrap
 * counts as running until its `cleanupAfterCommand`; the points go only when none is running, in
 * the order they were made, a directory only if empty at that moment. Returns one wrap's bwrap
 * starting: it makes the given points on the host.
 */
function srtMountPoints(h: Harness): (made: { dirs?: string[]; files?: string[] }) => void {
  let running = 0
  const points: string[] = []
  h.srt.cleanupAfterCommand.mockImplementation(() => {
    if (running > 0) running -= 1
    if (running > 0) return
    for (const point of points) {
      if (![...h.disk.nodes.keys()].some((key) => key.startsWith(`${point}/`))) h.disk.remove(point)
    }
    points.length = 0
  })
  return (made) => {
    running += 1
    for (const dir of made.dirs ?? []) {
      h.disk.dir(dir)
      points.push(dir)
    }
    for (const file of made.files ?? []) {
      h.disk.file(file)
      points.push(file)
    }
  }
}

/** What `refusals` returns when every case is refused before srt. */
function allRefused(cases: readonly Case[]): [string, string, number][] {
  return cases.map(([what]) => [what, 'refused', 0])
}

// ---------------------------------------------------------------------------------------------

describe('04 DesktopSandbox (spec 04 §包装契约)', () => {
  it('04 验收 4: full-access returns argv and env untouched and never reaches srt', async () => {
    await onBoth(async (platform) => {
      // Not even started: full-access never waits for the sandbox either (00:161).
      const h = harness(platform, { startup: 'none' })
      const req = h.request({ profile: 'full-access', workspace: [] })
      const result = await h.sandbox.wrap(req)
      expect(result).toEqual({
        argv: ['/bin/zsh', '-c', 'eval "$1"', '/bin/zsh', "echo it's"],
        env: { PATH: '/usr/bin:/bin', HOME: layout(platform).home },
      })
      expect(result.argv).not.toBe(req.argv)
      expect(result.env).not.toBe(req.env)
      expect(h.srt.wrapWithSandboxArgv).not.toHaveBeenCalled()
      expect(h.logs).toEqual([])
      expect(h.disk.lstat(layout(platform).tmp)).toBeUndefined()
    })
  })

  it('04 验收 4: a restricted request throws when the sandbox is unavailable or not ready in 15 s', async () => {
    const down = harness('darwin', { startup: { state: 'unavailable' }, initialized: false })
    expect(
      await Promise.all([
        outcomeOf(down.run({ commandId: 'toolu_1', profile: 'workspace-write' })),
        outcomeOf(down.run({ commandId: 'toolu_2', profile: 'read-only' })),
      ]),
    ).toEqual(['refused', 'refused'])
    expect(down.srt.wrapWithSandboxArgv).not.toHaveBeenCalled()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const never = harness('linux', { startup: 'none' })
    expect(never.sandbox.posture().state).toBe('pending')
    let outcome = 'waiting'
    void outcomeOf(never.run()).then((result) => (outcome = result))
    await vi.advanceTimersByTimeAsync(14_999)
    expect(outcome).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toBe('refused')
    expect(never.srt.wrapWithSandboxArgv).not.toHaveBeenCalled()

    // Startup that settles inside the 15 s is waited for.
    const late = harness('linux', { startup: 'none' })
    const startup = Promise.withResolvers<SandboxStartup>()
    late.sandbox.start({ initialized: Promise.resolve(), outcome: startup.promise })
    let lateOutcome = 'waiting'
    void outcomeOf(late.run()).then((result) => (lateOutcome = result))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(lateOutcome).toBe('waiting')
    startup.resolve({ state: 'active', session: late.session, noSeccomp: false })
    await flush()
    expect(lateOutcome).toBe('wrapped')
    expect(late.sandbox.posture().state).toBe('active')
  })

  it('04 验收 4: a non-shell argv[0] is refused', async () => {
    const h = harness('darwin')
    const refused = ['zsh', 'bin/bash', '/usr/bin/env', '/usr/local/bin/fish', '/bin/zsh-5.9']
    // One tool-use id each: a refused wrap forgets its id's session (读法 7), which would make a
    // case that shares the id fail 读法 35 instead.
    expect(
      await Promise.all(
        refused.map(async (shell) => [
          shell,
          await outcomeOf(
            h.run({ commandId: `toolu_${shell}`, argv: [shell, '-c', 'eval "$1"', shell, 'true'] }),
          ),
        ]),
      ),
    ).toEqual(refused.map((shell) => [shell, 'refused']))
    expect(h.logs).toEqual([
      'sandbox: refused toolu_zsh: argv[0] "zsh" is not zsh, bash or sh',
      'sandbox: refused toolu_bin/bash: argv[0] "bin/bash" is not zsh, bash or sh',
      'sandbox: refused toolu_/usr/bin/env: argv[0] "/usr/bin/env" is not zsh, bash or sh',
      'sandbox: refused toolu_/usr/local/bin/fish: argv[0] "/usr/local/bin/fish" is not zsh, bash or sh',
      'sandbox: refused toolu_/bin/zsh-5.9: argv[0] "/bin/zsh-5.9" is not zsh, bash or sh',
    ])
    expect(h.srt.wrapWithSandboxArgv).not.toHaveBeenCalled()
    await inTurn(['/bin/zsh', '/bin/bash', '/bin/sh', '/opt/homebrew/bin/zsh'], async (shell) => {
      await h.run({ argv: [shell, '-c', 'eval "$1"', shell, 'true'] })
    })
    expect(h.calls.map((call) => call.binShell)).toEqual([
      '/bin/zsh',
      '/bin/bash',
      '/bin/sh',
      '/opt/homebrew/bin/zsh',
    ])
  })

  it('04 验收 8: two wraps of one tool-use id get distinct ids under 100 chars', async () => {
    const long = `toolu_${'x'.repeat(144)}`
    await Promise.all(
      [TOOL_USE, long].map(async (commandId) => {
        const h = harness('linux')
        await h.run({ commandId })
        await h.sandbox.afterExit(commandId)
        await h.sandbox.violations(commandId)
        await h.run({ commandId })
        const [first = '', second = ''] = h.calls.map((call) => call.id)
        expect(first).not.toBe(second)
        expect([first.length <= 100, second.length <= 100]).toEqual([true, true])
        expect([first, second].map((id) => id.slice(0, -33))).toEqual([
          commandId.slice(0, 67),
          commandId.slice(0, 67),
        ])
        expect(first).toMatch(/^.{1,67}\.[0-9a-f]{32}$/)
        expect(second).toMatch(/^.{1,67}\.[0-9a-f]{32}$/)
        // A late line of the first wrap is not the second's (srt compares 100 characters).
        h.store.add(
          first,
          'deny network-outbound late.example.com:443 (host is not on the allow list)',
        )
        h.store.add(
          second,
          'deny network-outbound now.example.com:443 (host is not on the allow list)',
        )
        await h.sandbox.afterExit(commandId)
        expect(await h.sandbox.violations(commandId)).toEqual([
          {
            kind: 'network',
            line: 'deny network-outbound now.example.com:443 (host is not on the allow list)',
            target: 'now.example.com',
            release: 'domain',
          },
        ])
      }),
    )
  })

  it("04 验收 8: a tool-use id of multibyte characters is cut on a code point to 67 bytes, fits srt's 251-byte carriers and keeps its denials", async () => {
    const cases = [
      // 3 bytes each: 22 of them (66 bytes).
      ['调'.repeat(80), /^调{22}\.[0-9a-f]{32}$/u],
      // 4 bytes and two UTF-16 units each: 16 of them (64 bytes), never half of one.
      ['😀'.repeat(40), /^😀{16}\.[0-9a-f]{32}$/u],
    ] as const
    await inTurn(cases, async ([commandId, shape]) => {
      const h = harness('linux')
      await h.run({ commandId })
      const id = h.calls[0]?.id ?? ''
      expect(id).toMatch(shape)
      expect(Buffer.from(id).toString('base64').length).toBeLessThanOrEqual(251)
      h.store.add(id, 'deny network-outbound evil.example.com:443 (host is not on the allow list)')
      await h.sandbox.afterExit(commandId)
      expect(await h.sandbox.violations(commandId)).toEqual([
        {
          kind: 'network',
          line: 'deny network-outbound evil.example.com:443 (host is not on the allow list)',
          target: 'evil.example.com',
          release: 'domain',
        },
      ])
    })
  })

  it('04 验收 8: a write-heavy command keeps its one real denial', async () => {
    const h = harness('linux')
    await h.run()
    const id = h.calls[0]?.id ?? ''
    h.store.add(id, 'deny network-outbound evil.example.com:443 (host is not on the allow list)')
    // npm install: the observer reports every normal write in the workspace (读法 11, 39).
    for (let i = 0; i < 300; i += 1) {
      h.store.add(id, `deny openat /home/u/code/app/node_modules/pkg${i}/index.js`)
    }
    expect(h.store.getViolationsForCommand(id)).toHaveLength(100)
    await h.sandbox.afterExit(TOOL_USE)
    expect(await h.sandbox.violations(TOOL_USE)).toEqual([
      {
        kind: 'network',
        line: 'deny network-outbound evil.example.com:443 (host is not on the allow list)',
        target: 'evil.example.com',
        release: 'domain',
      },
    ])
  })

  it('04 读法 9: afterExit settles VIOLATION_SETTLE_MS (50 ms) after it begins; a line that comes later goes to the log only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // Both platforms wait (§afterExit); macOS's log monitor is the one whose lines come late. One
    // platform at a time: the fake clock is shared.
    const lines: Record<SandboxPlatform, { inTime: string; tooLate: string; expected: unknown }> = {
      darwin: {
        inTime: 'node(123) deny(1) file-write-create /Users/u/outside/x',
        tooLate: 'node(123) deny(1) file-write-create /Users/u/outside/y',
        expected: {
          kind: 'fs',
          line: 'node(123) deny(1) file-write-create /Users/u/outside/x',
          target: '/Users/u/outside/x',
          release: 'path',
        },
      },
      linux: {
        inTime: 'deny network-outbound in-time.example.com:443 (host is not on the allow list)',
        tooLate: 'deny network-outbound too-late.example.com:443 (host is not on the allow list)',
        expected: {
          kind: 'network',
          line: 'deny network-outbound in-time.example.com:443 (host is not on the allow list)',
          target: 'in-time.example.com',
          release: 'domain',
        },
      },
    }
    await inTurn(PLATFORMS, async (platform) => {
      const h = harness(platform)
      // 读法 35 offers a path release only under an existing directory.
      h.disk.dir(`${h.at.home}/outside`)
      await h.run()
      const id = h.calls[0]?.id ?? ''
      let settled = false
      void h.sandbox.afterExit(TOOL_USE).then(() => (settled = true))
      // darwin reads the process table first; the wait starts once that is done.
      await flush()
      await vi.advanceTimersByTimeAsync(49)
      await flush()
      expect([platform, settled]).toEqual([platform, false])
      // The process exited 49 ms ago and afterExit is still waiting: a line that lands now counts.
      h.store.add(id, lines[platform].inTime)
      await vi.advanceTimersByTimeAsync(1)
      await flush()
      expect([platform, settled]).toEqual([platform, true])
      h.store.add(id, lines[platform].tooLate)
      expect(await h.sandbox.violations(TOOL_USE)).toEqual([lines[platform].expected])
      // With its key and its line, so a late one can still be looked into.
      expect(h.logs).toEqual([
        `sandbox: a violation for no open command (key "${id}"): ${lines[platform].tooLate}`,
      ])
    })
  })

  it('04 §afterExit: violations hands over only settled wraps, and across two wraps of one id every protected one comes first', async () => {
    // Two wraps of one tool-use id before its afterExit: an ordinary denial in the first, one on a
    // denyWrite entry in the second.
    const h = harness('linux')
    await h.run()
    await h.run()
    const [first = '', second = ''] = h.calls.map((call) => call.id)
    h.store.add(first, 'deny openat /home/u/outside/f')
    h.store.add(second, 'deny openat /home/u/.bashrc')
    await h.sandbox.afterExit(TOOL_USE)
    expect(await h.sandbox.violations(TOOL_USE)).toEqual([
      {
        kind: 'fs',
        line: 'deny openat /home/u/.bashrc',
        target: '/home/u/.bashrc',
        protected: true,
        observed: true,
      },
      {
        kind: 'fs',
        line: 'deny openat /home/u/outside/f',
        target: '/home/u/outside/f',
        observed: true,
      },
    ])
    expect(await h.sandbox.violations(TOOL_USE)).toEqual([])

    // Asked while afterExit still waits: nothing yet, and nothing taken away.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const early = harness('linux')
    await early.run()
    early.store.add(early.calls[0]?.id ?? '', 'deny openat /home/u/outside/g')
    const exiting = early.sandbox.afterExit(TOOL_USE)
    await vi.advanceTimersByTimeAsync(10)
    expect(await early.sandbox.violations(TOOL_USE)).toEqual([])
    await vi.advanceTimersByTimeAsync(40)
    await exiting
    expect(await early.sandbox.violations(TOOL_USE)).toEqual([
      {
        kind: 'fs',
        line: 'deny openat /home/u/outside/g',
        target: '/home/u/outside/g',
        observed: true,
      },
    ])
  })

  it('04 §afterExit: with userData behind a link, a Seatbelt read denial reported at the profile dir’s real path is protected', async () => {
    const h = harness('darwin')
    // userData lives on another volume, reached through a link (step 3 r2: the classifier gets the
    // profile dir as written and as its real path).
    h.disk.remove('/Users/u/Library/Application Support/Tenon')
    h.disk.dir('/Volumes/x/Tenon/profiles/u1/t1', { mode: 0o700 })
    h.disk.dir('/Volumes/x/Tenon/sandbox-cwd', { mode: 0o700 })
    h.disk.link('/Users/u/Library/Application Support/Tenon', '/Volumes/x/Tenon')
    await h.run()
    h.store.add(
      h.calls[0]?.id ?? '',
      'cat(1) deny(1) file-read-data /Volumes/x/Tenon/profiles/u1/t1/x',
    )
    await h.sandbox.afterExit(TOOL_USE)
    expect(await h.sandbox.violations(TOOL_USE)).toEqual([
      {
        kind: 'fs',
        line: 'cat(1) deny(1) file-read-data /Volumes/x/Tenon/profiles/u1/t1/x',
        target: '/Volumes/x/Tenon/profiles/u1/t1/x',
        protected: true,
      },
    ])
  })

  it('04 读法 39: a wrap keeps at most 200 violations, every protected one first', async () => {
    const h = harness('linux')
    await h.run()
    const id = h.calls[0]?.id ?? ''
    for (let i = 0; i < 250; i += 1) h.store.add(id, `deny openat /home/u/outside/f${i}`)
    for (let i = 0; i < 3; i += 1) h.store.add(id, 'deny openat /home/u/.bashrc')
    await h.sandbox.afterExit(TOOL_USE)
    const result = await h.sandbox.violations(TOOL_USE)
    expect(result).toHaveLength(200)
    expect(result.slice(0, 3)).toEqual(
      Array.from({ length: 3 }, () => ({
        kind: 'fs',
        line: 'deny openat /home/u/.bashrc',
        target: '/home/u/.bashrc',
        protected: true,
        observed: true,
      })),
    )
    expect(result[3]).toEqual({
      kind: 'fs',
      line: 'deny openat /home/u/outside/f0',
      target: '/home/u/outside/f0',
      observed: true,
    })
    expect(result.slice(3).filter((v) => v.protected !== undefined)).toEqual([])
    expect(h.logs).toContain('sandbox: 53 violations over 200 not kept')
  })

  it('04 验收 9 (host): afterExit cleans up exactly once per wrap', async () => {
    const h = harness('linux')
    await h.run()
    await Promise.all([h.sandbox.afterExit(TOOL_USE), h.sandbox.afterExit(TOOL_USE)])
    await h.sandbox.afterExit(TOOL_USE)
    expect(h.srt.cleanupAfterCommand).toHaveBeenCalledTimes(1)

    // A full-access wrap and an id never wrapped have nothing to clean up.
    await h.run({ commandId: 'toolu_full', profile: 'full-access', workspace: [] })
    await h.sandbox.afterExit('toolu_full')
    await h.sandbox.afterExit('toolu_never')
    expect(h.srt.cleanupAfterCommand).toHaveBeenCalledTimes(1)

    // Two wraps of one id before its afterExit: one cleanup each.
    await h.run({ commandId: 'toolu_twice' })
    await h.run({ commandId: 'toolu_twice' })
    await h.sandbox.afterExit('toolu_twice')
    expect(h.srt.cleanupAfterCommand).toHaveBeenCalledTimes(3)
  })

  it("04 验收 4: /tmp/claude that is a link, another user's or not 0700 is refused; a missing one is made", async () => {
    await onBoth(async (platform) => {
      const tmp = platform === 'darwin' ? '/private/tmp/claude' : '/tmp/claude'
      const made = harness(platform)
      await made.run()
      expect(made.disk.nodes.get(tmp)).toEqual({ kind: 'dir', uid: SELF[platform], mode: 0o700 })

      const cases: Case[] = [
        [
          'a link to a private dir of yours',
          (h) => {
            h.disk.dir(`${h.at.home}/private`, { mode: 0o700 })
            h.disk.link(tmp, `${h.at.home}/private`)
          },
        ],
        ["another user's", (h) => h.disk.dir(tmp, { uid: ANOTHER_USER, mode: 0o700 })],
        ['0755', (h) => h.disk.dir(tmp, { mode: 0o755 })],
        ['0770', (h) => h.disk.dir(tmp, { mode: 0o770 })],
        // Yours and 0700: only the directory test stops it.
        ['a file', (h) => h.disk.file(tmp, '', 0o700)],
      ]
      expect(await refusals(platform, cases)).toEqual(allRefused(cases))
    })
  })

  it("04 验收 4: with the preset on in workspace-write, a preset cache dir that is a link, another user's or not 0700 is refused and a missing one is made; with the preset off none is touched", async () => {
    const managers: Record<SandboxPlatform, string[]> = {
      darwin: ['npm', 'pnpm', 'uv', 'cargo'],
      linux: ['npm', 'pnpm', 'pip', 'uv', 'cargo'],
    }
    await onBoth(async (platform) => {
      const made = harness(platform)
      made.settings.packageManagers = true
      await made.run()
      expect(
        managers[platform].map((manager) => made.disk.nodes.get(`${made.at.cache}/${manager}`)),
      ).toEqual(managers[platform].map(() => ({ kind: 'dir', uid: SELF[platform], mode: 0o700 })))

      const cases: Case[] = [
        [
          'npm: a link to your own ~/.npm',
          (h) => {
            h.disk.dir(`${h.at.home}/.npm`, { mode: 0o700 })
            h.disk.dir(h.at.cache, { mode: 0o700 })
            h.disk.link(`${h.at.cache}/npm`, `${h.at.home}/.npm`)
          },
        ],
        [
          "uv: another user's",
          (h) => h.disk.dir(`${h.at.cache}/uv`, { uid: ANOTHER_USER, mode: 0o700 }),
        ],
        ['cargo: 0755', (h) => h.disk.dir(`${h.at.cache}/cargo`, { mode: 0o755 })],
      ]
      expect(await refusals(platform, cases, presetOn)).toEqual(allRefused(cases))

      // Off, read-only, or a release under your read-only profile: nothing there is looked at.
      const untouched: (readonly [string, (h: Harness) => Partial<SandboxRequest>])[] = [
        ['the preset off', () => ({})],
        [
          'a read-only request',
          (h) => {
            presetOn(h)
            return { profile: 'read-only' }
          },
        ],
        [
          'your profile read-only',
          (h) => {
            presetOn(h)
            h.settings.profile = 'read-only'
            return { workspace: [p(`${h.at.home}/notes.txt`)] }
          },
        ],
      ]
      const seen = await Promise.all(
        untouched.map(async ([what, arrange]) => {
          const h = harness(platform)
          h.disk.dir(`${h.at.home}/.npm`, { mode: 0o700 })
          h.disk.dir(h.at.cache, { mode: 0o700 })
          h.disk.link(`${h.at.cache}/npm`, `${h.at.home}/.npm`)
          const outcome = await outcomeOf(h.run(arrange(h)))
          const under = [...h.disk.nodes.keys()].filter((path) => path.startsWith(`${h.at.cache}/`))
          return [what, outcome, under]
        }),
      )
      expect(seen).toEqual(
        untouched.map(([what]) => [what, 'wrapped', [`${layout(platform).cache}/npm`]]),
      )
    })
  })

  it('04 验收 4: a chdir dir removed, replaced by a link or loosened since startup makes a restricted wrap throw', async () => {
    await onBoth(async (platform) => {
      const fine = harness(platform)
      expect(await outcomeOf(fine.run())).toBe('wrapped')

      const cases: Case[] = [
        ['removed', (h) => h.disk.remove(h.at.cwdDir)],
        [
          'replaced by a link',
          (h) => {
            h.disk.remove(h.at.cwdDir)
            h.disk.dir(`${h.at.home}/private`, { mode: 0o700 })
            h.disk.link(h.at.cwdDir, `${h.at.home}/private`)
          },
        ],
        ['loosened', (h) => h.disk.dir(h.at.cwdDir, { mode: 0o755 })],
      ]
      expect(await refusals(platform, cases)).toEqual(allRefused(cases))

      // A removed one is not made again: only startup makes it.
      const removed = harness(platform)
      removed.disk.remove(removed.at.cwdDir)
      expect(await outcomeOf(removed.run())).toBe('refused')
      expect(removed.disk.lstat(removed.at.cwdDir)).toBeUndefined()

      // The eval host never chdirs, so there is nothing to check.
      const evals = harness(platform, { chdir: false })
      evals.disk.remove(evals.at.cwdDir)
      expect(await outcomeOf(evals.run())).toBe('wrapped')
    })
  })

  it("04 验收 11 (host): on linux a link on a deny entry's way removed or replaced during the call yields one protected violation targeting it; an unchanged one yields none; darwin compares nothing", async () => {
    const arrange = (): Harness => {
      const h = harness('linux')
      h.disk.dir('/home/u/dotfiles/aws', { mode: 0o700 })
      h.disk.link('/home/u/.aws', '/home/u/dotfiles/aws')
      return h
    }
    const changed = {
      kind: 'fs',
      line: 'link changed during the command: /home/u/.aws',
      target: '/home/u/.aws',
      protected: true,
    }

    const unchanged = arrange()
    await unchanged.run()
    await unchanged.sandbox.afterExit(TOOL_USE)
    expect(await unchanged.sandbox.violations(TOOL_USE)).toEqual([])

    const removed = arrange()
    await removed.run()
    removed.disk.remove('/home/u/.aws')
    removed.disk.file('/home/u/.aws', '[default]\ncredential_process = /tmp/x\n')
    await removed.sandbox.afterExit(TOOL_USE)
    expect(await removed.sandbox.violations(TOOL_USE)).toEqual([changed])

    const replaced = arrange()
    await replaced.run()
    replaced.disk.dir('/home/u/elsewhere')
    replaced.disk.link('/home/u/.aws', '/home/u/elsewhere')
    await replaced.sandbox.afterExit(TOOL_USE)
    expect(await replaced.sandbox.violations(TOOL_USE)).toEqual([changed])

    // darwin passes the link itself in denyWrite instead; until step 6 says otherwise (spec「链接」)
    // nothing is recorded or compared there.
    const darwin = harness('darwin')
    darwin.disk.dir('/Users/u/dotfiles/aws', { mode: 0o700 })
    darwin.disk.link('/Users/u/.aws', '/Users/u/dotfiles/aws')
    await darwin.run()
    darwin.disk.remove('/Users/u/.aws')
    darwin.disk.file('/Users/u/.aws', '[default]\ncredential_process = /tmp/x\n')
    await darwin.sandbox.afterExit(TOOL_USE)
    expect(await darwin.sandbox.violations(TOOL_USE)).toEqual([])
  })

  it('04 验收 23 (host): a workspace item outside the session folders that fails 读法 35 (home or above it, an existing dir) is refused', async () => {
    const h = harness('darwin')
    h.disk.dir('/Users/u/code/other')
    const items = ['/Users/u', '/Users', '/', '/Users/u/code/other']
    expect(
      await Promise.all(
        items.map(async (item) => [
          item,
          await outcomeOf(h.run({ workspace: [p(h.at.ws), p(item)] })),
        ]),
      ),
    ).toEqual(items.map((item) => [item, 'refused']))
    expect(h.srt.wrapWithSandboxArgv).not.toHaveBeenCalled()

    // A path release that passes 读法 35, with or without the folders.
    await h.run({ workspace: [p(h.at.ws), p('/Users/u/notes.txt')] })
    await h.run({ workspace: [p('/Users/u/notes.txt')] })
    // Your home as one of the session's folders is the session's choice.
    h.folders.set(SESSION, [p('/Users/u')])
    await h.run({ workspace: [p('/Users/u')] })
    expect(h.srt.wrapWithSandboxArgv).toHaveBeenCalledTimes(3)

    // A command no session was named for has no folders: its directory items are refused.
    expect(await outcomeOf(h.sandbox.wrap(h.request({ commandId: 'toolu_unnamed' })))).toBe(
      'refused',
    )
  })

  it('04 不变量 3: the returned env equals request.env, except that with the preset in effect every case spelling of each preset variable is replaced by exactly one pointing at its dir, and on darwin exactly one TENON_SANDBOX_MARK is added; full-access never gets either', async () => {
    const requestEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/u',
      LANG: 'C.UTF-8',
      NPM_CONFIG_CACHE: '/elsewhere/a',
      npm_config_cache: '/elsewhere/b',
      Npm_Config_Store_Dir: '/elsewhere/c',
      uv_cache_dir: '/elsewhere/d',
      CARGO_HOME: '/elsewhere/e',
      PIP_CACHE_DIR: '/elsewhere/f',
    }

    const darwin = harness('darwin')
    darwin.settings.packageManagers = true
    const d = await darwin.run({ env: { ...requestEnv } })
    const cache = '/Users/u/Library/Application Support/Tenon/sandbox-cache'
    expect(d.env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/u',
      LANG: 'C.UTF-8',
      PIP_CACHE_DIR: '/elsewhere/f',
      npm_config_cache: `${cache}/npm`,
      npm_config_store_dir: `${cache}/pnpm/store`,
      UV_CACHE_DIR: `${cache}/uv`,
      CARGO_HOME: `${cache}/cargo`,
      TENON_SANDBOX_MARK: darwin.calls[0]?.id,
    })

    const linux = harness('linux')
    linux.settings.packageManagers = true
    const l = await linux.run({ env: { ...requestEnv } })
    const linuxCache = '/home/u/.config/Tenon/sandbox-cache'
    expect(l.env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/u',
      LANG: 'C.UTF-8',
      npm_config_cache: `${linuxCache}/npm`,
      npm_config_store_dir: `${linuxCache}/pnpm/store`,
      PIP_CACHE_DIR: `${linuxCache}/pip`,
      UV_CACHE_DIR: `${linuxCache}/uv`,
      CARGO_HOME: `${linuxCache}/cargo`,
    })

    // The preset off, a read-only request, your profile read-only: request.env (and the mark).
    await onBoth(async (platform) => {
      const cases: (readonly [string, (h: Harness) => Partial<SandboxRequest>])[] = [
        ['the preset off', () => ({})],
        [
          'a read-only request',
          (h) => {
            h.settings.packageManagers = true
            return { profile: 'read-only' }
          },
        ],
        [
          'your profile read-only',
          (h) => {
            h.settings.packageManagers = true
            h.settings.profile = 'read-only'
            return { workspace: [p(`${h.at.home}/notes.txt`)] }
          },
        ],
      ]
      const seen = await Promise.all(
        cases.map(async ([what, arrange]) => {
          const h = harness(platform)
          const result = await h.run({ ...arrange(h), env: { ...requestEnv } })
          // Wrapped through srt, once, under an id of the right shape — so the mark below is real.
          expect([what, h.calls.length]).toEqual([what, 1])
          const id = h.calls[0]?.id ?? ''
          expect(id).toMatch(/^.{1,67}\.[0-9a-f]{32}$/)
          return [what, result.env, id] as const
        }),
      )
      for (const [what, env, id] of seen) {
        expect([what, env]).toStrictEqual([
          what,
          platform === 'darwin' ? { ...requestEnv, TENON_SANDBOX_MARK: id } : requestEnv,
        ])
      }

      // full-access: request.env as it is, the preset on or not.
      const full = harness(platform)
      full.settings.packageManagers = true
      const f = await full.run({ profile: 'full-access', env: { ...requestEnv } })
      expect(f.env).toEqual(requestEnv)
    })
  })

  it('04 验收 9: on linux a wrap records the absent intermediate dir that will become a mount point in stubs.json and afterExit removes the entry', async () => {
    const h = harness('linux')
    const stubs = '/home/u/.config/Tenon/profiles/u1/t1/sandbox/stubs.json'
    h.disk.dir('/home/u/.config/Tenon/profiles/u1/t1/sandbox', { mode: 0o700 })
    h.disk.file(stubs, '{"socat":[{"pid":4242}]}\n')
    await h.run()
    const id = h.calls[0]?.id ?? ''
    // `.claude/` is missing: srt binds an empty directory there (linux-sandbox-utils.js:2159-2181).
    // `.envrc` and the like are missing leaves (an empty file srt takes back itself), and the
    // home's `.config/autostart` is not under this wrap's allowWrite.
    expect(JSON.parse(h.disk.readFile(stubs) ?? '')).toEqual({
      socat: [{ pid: 4242 }],
      mountPoints: { [id]: ['/home/u/code/app/.claude'] },
    })
    await h.sandbox.afterExit(TOOL_USE)
    expect(JSON.parse(h.disk.readFile(stubs) ?? '')).toEqual({
      socat: [{ pid: 4242 }],
      mountPoints: {},
    })

    // With `.claude/` there, nothing is recorded; macOS has no mount points at all.
    const there = harness('linux')
    there.disk.dir('/home/u/code/app/.claude')
    await there.run()
    expect(there.disk.readFile(stubs)).toBeUndefined()
    const darwin = harness('darwin')
    await darwin.run()
    expect(
      darwin.disk.readFile(
        '/Users/u/Library/Application Support/Tenon/profiles/u1/t1/sandbox/stubs.json',
      ),
    ).toBeUndefined()

    // `.claude` a dangling link: srt resolves it before it masks (linux-sandbox-utils.js:50-112,
    // :2042), so the empty directory lands under the link's target, not on the link.
    const dangling = harness('linux')
    dangling.disk.link('/home/u/code/app/.claude', 'claude-real')
    await dangling.run()
    expect(JSON.parse(dangling.disk.readFile(stubs) ?? '')).toEqual({
      mountPoints: { [dangling.calls[0]?.id ?? '']: ['/home/u/code/app/claude-real'] },
    })

    // A wrap srt refuses leaves no entry behind.
    const refused = harness('linux')
    refused.failures.push(new Error('srt refused'))
    expect(await outcomeOf(refused.run())).toBe('threw Error: srt refused')
    expect(JSON.parse(refused.disk.readFile(stubs) ?? '')).toEqual({ mountPoints: {} })
  })

  it('04 验收 9: on linux a mount point stays in stubs.json while another wrap keeps srt from removing it, and leaves once it is gone from the host', async () => {
    const h = harness('linux')
    const bwrap = srtMountPoints(h)
    h.disk.dir('/home/u/code/two')
    h.folders.set(SESSION, [p('/home/u/code/app'), p('/home/u/code/two')])
    await h.run({ commandId: 'toolu_a' })
    bwrap({ dirs: ['/home/u/code/app/.claude'] })
    await h.run({
      commandId: 'toolu_b',
      cwd: p('/home/u/code/two'),
      workspace: [p('/home/u/code/two')],
    })
    bwrap({ dirs: ['/home/u/code/two/.claude'] })
    const [a = '', b = ''] = h.calls.map((call) => call.id)
    const record = () => JSON.parse(h.disk.readFile(STUBS_LINUX) ?? '') as unknown

    // A exits while B runs: srt keeps A's mount point, so the record keeps it too (a SIGKILL now
    // leaves it for startup).
    await h.sandbox.afterExit('toolu_a')
    expect(h.disk.lstat('/home/u/code/app/.claude')).toBeDefined()
    expect(record()).toEqual({
      mountPoints: { [a]: ['/home/u/code/app/.claude'], [b]: ['/home/u/code/two/.claude'] },
    })
    // B exits: srt removes both, and both leave the record.
    await h.sandbox.afterExit('toolu_b')
    expect(h.disk.lstat('/home/u/code/app/.claude')).toBeUndefined()
    expect(record()).toEqual({ mountPoints: {} })
  })

  it('04 验收 9: on linux a mount point srt leaves behind because a later wrap filled it stays in stubs.json for startup', async () => {
    const h = harness('linux')
    const bwrap = srtMountPoints(h)
    await h.run({ commandId: 'toolu_a' })
    bwrap({ dirs: ['/home/u/code/app/.claude'] })
    // B begins while A runs: `.claude/` is there now, so B's denials under it are leaves (an empty
    // file each, nothing to record); srt makes them inside A's directory.
    await h.run({ commandId: 'toolu_b' })
    bwrap({
      files: [
        '/home/u/code/app/.claude/settings.json',
        '/home/u/code/app/.claude/settings.local.json',
      ],
    })
    const [a = ''] = h.calls.map((call) => call.id)
    await h.sandbox.afterExit('toolu_a')
    await h.sandbox.afterExit('toolu_b')
    // srt met `.claude/` before B's files, not empty then, and left it; it is empty now.
    expect(h.disk.lstat('/home/u/code/app/.claude')?.isDirectory()).toBe(true)
    expect(h.disk.lstat('/home/u/code/app/.claude/settings.json')).toBeUndefined()
    expect(JSON.parse(h.disk.readFile(STUBS_LINUX) ?? '')).toEqual({
      mountPoints: { [a]: ['/home/u/code/app/.claude'] },
    })
  })

  it("04 验收 15 (host): on darwin afterExit SIGKILLs exactly the processes carrying this wrap's mark", async () => {
    const h = harness('darwin')
    await h.run({ commandId: 'toolu_a' })
    await h.run({ commandId: 'toolu_b' })
    const [a, b] = h.calls.map((call) => call.id)
    h.processes.table = [
      `  4101 /bin/sleep 600 PATH=/usr/bin TENON_SANDBOX_MARK=${a} HOME=/Users/u`,
      `  4102 /usr/bin/python3 -c import os,time; os.setsid(); time.sleep(601) TENON_SANDBOX_MARK=${a}`,
      `  4103 /bin/sleep 602 TENON_SANDBOX_MARK=${b}`,
      `  4104 /bin/sleep 603 TENON_SANDBOX_MARK=${a}0`,
      `  4105 /bin/sleep 604 OTHER=TENON_SANDBOX_MARK=${a}`,
      '  4106 /bin/zsh -l',
      '',
    ].join('\n')
    await h.sandbox.afterExit('toolu_a')
    expect(h.killed).toEqual([4101, 4102])
    await h.sandbox.afterExit('toolu_b')
    expect(h.killed).toEqual([4101, 4102, 4103])

    // A provider's tool-call id may hold spaces, and `ps -E` prints the mark unquoted.
    await h.run({ commandId: 'call 7 x' })
    const spaced = h.calls[2]?.id ?? ''
    h.processes.table = [
      `  4107 /bin/sleep 605 TENON_SANDBOX_MARK=${spaced} HOME=/Users/u`,
      '  4108 /bin/sleep 606 TENON_SANDBOX_MARK=call',
      '',
    ].join('\n')
    await h.sandbox.afterExit('call 7 x')
    expect(h.killed).toEqual([4101, 4102, 4103, 4107])

    // Linux leaves its processes to bwrap's --die-with-parent and the process group (P6).
    const linux = harness('linux')
    await linux.run()
    await linux.sandbox.afterExit(TOOL_USE)
    expect(linux.processes.list).not.toHaveBeenCalled()
  })

  it('04 不变量 2: a command runs unwrapped only when it asked for full-access; DesktopSandbox never passes a restricted profile through', async () => {
    await onBoth(async (platform) => {
      const h = harness(platform)
      const wrapped = [
        await h.run({ profile: 'workspace-write' }),
        await h.run({ profile: 'read-only' }),
      ]
      expect(wrapped.map((result) => result.argv)).toEqual(
        wrapped.map(() => [
          '/usr/bin/sandbox-exec',
          '-p',
          '(srt profile)',
          '/bin/zsh',
          '-c',
          `'/bin/zsh' '-c' 'eval "$1"' '/bin/zsh' 'echo it'\\''s'`,
        ]),
      )
      // srt gets the request's cwd, not the workspace's first root (spec §wrap 第 3 步).
      h.disk.dir(`${h.at.ws}/src`)
      await h.run({ cwd: p(`${h.at.ws}/src`) })
      const src = platform === 'darwin' ? '/Users/u/code/app/src' : '/home/u/code/app/src'
      expect(h.calls.map((call) => [call.binShell, call.cwd])).toEqual([
        ['/bin/zsh', layout(platform).ws],
        ['/bin/zsh', layout(platform).ws],
        ['/bin/zsh', src],
      ])
      const full = await h.run({ profile: 'full-access' })
      expect(full.argv).toEqual(['/bin/zsh', '-c', 'eval "$1"', '/bin/zsh', "echo it's"])
      expect(h.srt.wrapWithSandboxArgv).toHaveBeenCalledTimes(3)

      // Unavailable: refused, never run as asked.
      const down = harness(platform, { startup: { state: 'unavailable' } })
      expect(
        await Promise.all([
          outcomeOf(down.run({ commandId: 'toolu_1', profile: 'workspace-write' })),
          outcomeOf(down.run({ commandId: 'toolu_2', profile: 'read-only' })),
        ]),
      ).toEqual(['refused', 'refused'])
    })
  })

  it("04 验收 5 (host): srt gets this wrap's filesystem and nothing else; a degraded no-seccomp startup still wraps, its denyRead carrying the socket paths; a config srt's schema refuses never reaches srt", async () => {
    const sockets = [
      { path: '/run/user/1000', literal: true },
      { path: '/var/run/docker.sock', literal: true },
      { path: '/run/docker.sock', literal: true },
      { path: '/tmp/.X11-unix', literal: true },
    ]
    const hooks = { path: '/home/u/code/app/.git/hooks', literal: true }

    // 读法 42 at the host: the posture startup settled on decides the socket paths.
    const degraded = harness('linux', { startup: { state: 'degraded', noSeccomp: true } })
    expect(await outcomeOf(degraded.run())).toBe('wrapped')
    const fs = tables(degraded)
    expect(fs?.denyRead).toEqual(expect.arrayContaining(sockets))
    expect(fs?.allowWrite).toEqual([{ path: '/home/u/code/app', literal: true }])
    expect(fs?.allowRead).toEqual([
      {
        path: '/home/u/.config/Tenon/profiles/u1/t1/tool-output/6f1c2a4e-3b5d-4c7e-9f80-1a2b3c4d5e6f',
        literal: true,
      },
    ])
    // Linux: no `.git` under the root, no `.git/hooks` mount point (it would break `git init`).
    expect(fs?.denyWrite).not.toContainEqual(hooks)

    const active = harness('linux')
    active.disk.dir('/home/u/code/app/.git')
    await active.run()
    const activeFs = tables(active)
    const denied = new Set(
      (activeFs?.denyRead ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.path)),
    )
    expect(sockets.filter((entry) => denied.has(entry.path))).toEqual([])
    expect(activeFs?.denyWrite).toContainEqual(hooks)

    const darwin = harness('darwin', { startup: { state: 'degraded', noSeccomp: true } })
    expect(await outcomeOf(darwin.run())).toBe('wrapped')

    // 04 不变量 4: each wrap's config is checked against the listed keys and srt's schema.
    const refused = await Promise.all(
      [
        (h: Harness) => ({
          ...h.session,
          network: { ...h.session.network, allowedDomains: ['*.com'] },
        }),
        (h: Harness) => ({ ...h.session, allowPty: true }),
      ].map(async (session) => {
        const h = harness('linux', { startup: 'none' })
        h.sandbox.start({
          initialized: Promise.resolve(),
          outcome: Promise.resolve({ state: 'active', session: session(h), noSeccomp: false }),
        })
        const error = await h.run().then(
          () => undefined,
          (thrown: unknown) => thrown,
        )
        return [error instanceof SandboxConfigError, h.srt.wrapWithSandboxArgv.mock.calls.length]
      }),
    )
    expect(refused).toEqual([
      [true, 0],
      [true, 0],
    ])
  })

  it('04 不变量 7: each successful wrapWithSandboxArgv is cleaned up exactly once', async () => {
    const h = harness('linux')
    await h.run({ commandId: 'toolu_ok' })
    h.failures.push(new Error('srt refused'))
    expect(await outcomeOf(h.run({ commandId: 'toolu_failed' }))).toBe('threw Error: srt refused')
    await h.sandbox.afterExit('toolu_ok')
    await h.sandbox.afterExit('toolu_ok')
    await h.sandbox.afterExit('toolu_failed')
    expect(h.srt.wrapWithSandboxArgv).toHaveBeenCalledTimes(2)
    expect(h.srt.cleanupAfterCommand).toHaveBeenCalledTimes(1)
  })

  it('04 不变量 8: the ids srt receives are pairwise distinct and at most 100 characters', async () => {
    const h = harness('darwin')
    const ids = ['', 'a', TOOL_USE, 'x'.repeat(66), 'y'.repeat(67), 'z'.repeat(68), 'w'.repeat(500)]
    await inTurn([...ids, ...ids], async (commandId) => {
      await h.run({ commandId })
    })
    const sent = h.calls.map((call) => call.id)
    expect(sent).toHaveLength(14)
    expect(new Set(sent).size).toBe(14)
    expect(sent.filter((id) => id.length > 100)).toEqual([])
    expect(Math.max(...sent.map((id) => id.length))).toBe(100)
  })

  it('04 验收 3 (host): dispose resets once, waits at most 2 s, logs a throw and never resets a sandbox that was not initialized', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness('darwin')
    await flush()
    h.srt.reset.mockImplementation(() => new Promise<void>(() => {}))
    let done = false
    void h.sandbox.dispose().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(1_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    await h.sandbox.dispose()
    expect(h.srt.reset).toHaveBeenCalledTimes(1)

    const throwing = harness('linux')
    await flush()
    throwing.srt.reset.mockRejectedValue(new Error('socat would not stop'))
    await throwing.sandbox.dispose()
    expect(throwing.logs).toContain('sandbox: reset failed: socat would not stop')

    const uninitialized = harness('darwin', {
      startup: { state: 'unavailable' },
      initialized: false,
    })
    const unstarted = harness('darwin', { startup: 'none' })
    await flush()
    await Promise.all([uninitialized.sandbox.dispose(), unstarted.sandbox.dispose()])
    expect(uninitialized.srt.reset).not.toHaveBeenCalled()
    expect(unstarted.srt.reset).not.toHaveBeenCalled()
  })

  it('04 验收 3 (host): after SIGTERM or SIGINT the posture is unavailable, a restricted wrap throws and dispose does not reset again', async () => {
    const h = harness('linux')
    await flush()
    expect(h.signals).toHaveLength(1)
    expect(h.sandbox.posture()).toEqual({ state: 'active', profile: 'workspace-write' })
    expect(h.sandbox.reasons()).toEqual([])
    h.signals[0]?.()
    expect(h.sandbox.posture()).toEqual({ state: 'unavailable', profile: 'workspace-write' })
    // §退出: unavailable / init-failed.
    expect(h.sandbox.reasons()).toEqual([{ code: 'init-failed', detail: 'reset by a signal' }])
    expect(await outcomeOf(h.run())).toBe('refused')
    expect(h.srt.wrapWithSandboxArgv).not.toHaveBeenCalled()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    h.srt.reset.mockImplementation(() => new Promise<void>(() => {}))
    let done = false
    void h.sandbox.dispose().then(() => (done = true))
    await flush()
    expect(done).toBe(true)
    expect(h.srt.reset).not.toHaveBeenCalled()

    // initialize did not return: DesktopSandbox adds no listener of its own (§退出).
    const never = harness('darwin', { startup: { state: 'unavailable' }, initialized: false })
    await flush()
    expect(never.signals).toEqual([])
  })

  it('04 验收 3 (host): once initialize has returned, before the self-test settles startup, dispose resets and a signal makes the sandbox unavailable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // The dependency check and the self-test are still running (up to 10 s).
    const quitting = harness('linux', { startup: 'none' })
    quitting.sandbox.start({ initialized: Promise.resolve(), outcome: new Promise(() => {}) })
    await flush()
    expect(quitting.sandbox.posture().state).toBe('pending')
    quitting.srt.reset.mockImplementation(() => new Promise<void>(() => {}))
    let done = false
    void quitting.sandbox.dispose().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(1_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(quitting.srt.reset).toHaveBeenCalledTimes(1)

    const h = harness('linux', { startup: 'none' })
    const outcome = Promise.withResolvers<SandboxStartup>()
    h.sandbox.start({ initialized: Promise.resolve(), outcome: outcome.promise })
    await flush()
    expect(h.signals).toHaveLength(1)
    h.signals[0]?.()
    // The self-test still passes: srt's own listener has reset it all the same.
    outcome.resolve({ state: 'active', session: h.session, noSeccomp: false })
    await flush()
    expect(h.sandbox.posture()).toEqual({ state: 'unavailable', profile: 'workspace-write' })
    expect(await outcomeOf(h.run())).toBe('refused')
    expect(h.srt.wrapWithSandboxArgv).not.toHaveBeenCalled()
  })

  it('04 验收 3 (host): dispose while initialize still runs waits for it, within the same 2 s, and then resets once; an initialize that threw is not waited out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    // initialize returns 1 s into dispose: reset once, right then.
    const h = harness('linux', { startup: 'none' })
    const initialized = Promise.withResolvers<void>()
    h.sandbox.start({ initialized: initialized.promise, outcome: pending() })
    let done = false
    void h.sandbox.dispose().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(1_000)
    expect([done, h.srt.reset.mock.calls.length]).toEqual([false, 0])
    initialized.resolve()
    await flush()
    expect([done, h.srt.reset.mock.calls.length]).toEqual([true, 1])
    await h.sandbox.dispose()
    expect(h.srt.reset).toHaveBeenCalledTimes(1)

    // initialize threw: startup settles unavailable and dispose is done, without a reset.
    const threw = harness('linux', { startup: 'none' })
    const outcome = Promise.withResolvers<SandboxStartup>()
    threw.sandbox.start({ initialized: pending(), outcome: outcome.promise })
    let threwDone = false
    void threw.sandbox.dispose().then(() => (threwDone = true))
    await vi.advanceTimersByTimeAsync(500)
    expect(threwDone).toBe(false)
    outcome.resolve({ state: 'unavailable', session: null, noSeccomp: false })
    await flush()
    expect(threwDone).toBe(true)
    expect(threw.srt.reset).not.toHaveBeenCalled()

    // initialize returns at 1.5 s and reset hangs: 2 s in all, the wait and the reset together.
    const late = harness('linux', { startup: 'none' })
    const lateInitialized = Promise.withResolvers<void>()
    late.sandbox.start({ initialized: lateInitialized.promise, outcome: pending() })
    late.srt.reset.mockImplementation(pending)
    let lateDone = false
    void late.sandbox.dispose().then(() => (lateDone = true))
    await vi.advanceTimersByTimeAsync(1_500)
    lateInitialized.resolve()
    await vi.advanceTimersByTimeAsync(499)
    expect([lateDone, late.srt.reset.mock.calls.length]).toEqual([false, 1])
    await vi.advanceTimersByTimeAsync(1)
    expect(lateDone).toBe(true)

    // initialize never returns: done at 2 s, no reset.
    const stuck = harness('linux', { startup: 'none' })
    stuck.sandbox.start({ initialized: pending(), outcome: pending() })
    let stuckDone = false
    void stuck.sandbox.dispose().then(() => (stuckDone = true))
    await vi.advanceTimersByTimeAsync(1_999)
    expect(stuckDone).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect([stuckDone, stuck.srt.reset.mock.calls.length]).toEqual([true, 0])
  })
})
