import type {
  AbsolutePath,
  ChildHandle,
  ConfirmRequest,
  HostAdapter,
  HostClock,
  HostConfirm,
  HostFs,
  HostIdentity,
  HostNetwork,
  HostPolicy,
  HostProcess,
  HostSandbox,
  HostSecrets,
  SandboxRequest,
  SandboxViolation,
  SpawnSpec,
} from './adapter.js'
import { absolutePath } from './path.js'
import { EMPTY_POLICY } from './policy.js'
import type { PolicyState } from './policy.js'

/**
 * In-memory HostAdapter for tests. Everything is deterministic and inspectable;
 * nothing touches the real machine. `process.spawn` and `network.fetch` are not
 * available unless injected — the memory host neither runs programs nor opens sockets.
 */
export interface MemoryHostOptions {
  identity?: Partial<HostIdentity>
  process?: HostProcess
  /** Tests inject `fakeNetwork()` from @tenon-app/kernel/testing; the default rejects. */
  network?: HostNetwork
  /** Initial clock reading in ms since epoch. Default 0. */
  now?: number
  /** Default `{ status: 'current', version: 'empty', snapshot: EMPTY_POLICY }`, a personal tenant. */
  policy?: PolicyState
}

export interface MemoryHost extends HostAdapter {
  readonly files: ReadonlyMap<string, Uint8Array>
  readonly confirmRequests: readonly ConfirmRequest[]
  /** One line per non-full-access sandbox wrap, mirroring the desktop passthrough log. */
  readonly sandboxLog: readonly string[]
  /** Moves the clock forward and fires timers that became due, in order. */
  advance(ms: number): void
  /** Replaces what policy.current() returns and notifies every subscriber synchronously. */
  setPolicy(state: PolicyState): void
  /** Creates a symbolic link. `target` may be relative, and may point at nothing (a dangling link). */
  symlink(link: AbsolutePath, target: string): void
}

const DEFAULT_IDENTITY: HostIdentity = {
  userId: 'user',
  tenantId: 'tenant',
  profileDir: '/profiles/user/tenant',
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Symbolic links are followed the way node's `fs.promises` follows them on a real disk: every link
 * before the last segment always, the last one by readFile / writeFile / stat / readdir / mkdirp /
 * realpath. So writeFile through a dangling link creates the file where the link points, stat of a
 * dangling link is null, and realpath of a dangling link or a loop throws (spec 02 §内存宿主).
 * `.` and `..` apply to the directory actually reached, as they do in a kernel's path lookup.
 */
class MemoryFs implements HostFs {
  readonly files = new Map<string, Uint8Array>()
  readonly mtimes = new Map<string, number>()
  readonly dirs = new Set<string>(['/'])
  /** Link path (its parent resolved) → the target exactly as given. */
  readonly links = new Map<string, string>()
  private readonly clock: HostClock

  constructor(clock: HostClock) {
    this.clock = clock
  }

  async readFile(path: AbsolutePath, opts?: { encoding?: 'utf8' }): Promise<Uint8Array | string> {
    const key = this.lookup(normalize(path), true)
    if (this.dirs.has(key)) throw fsError('EISDIR', 'illegal operation on a directory', path)
    const data = this.files.get(key)
    if (data === undefined) throw notFound(path)
    return opts?.encoding === 'utf8' ? decoder.decode(data) : data.slice()
  }

  async writeFile(path: AbsolutePath, data: Uint8Array | string): Promise<void> {
    // lookup() has already required every directory on the way, so the parent exists.
    const key = this.lookup(normalize(path), true)
    if (this.dirs.has(key)) throw fsError('EISDIR', 'is a directory', path)
    this.files.set(key, typeof data === 'string' ? encoder.encode(data) : data.slice())
    this.mtimes.set(key, this.clock.now())
  }

  async stat(
    path: AbsolutePath,
  ): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null> {
    let key: string
    try {
      key = this.lookup(normalize(path), true)
    } catch (err) {
      // The desktop host's answer to the same errors; ELOOP and the rest throw, as there.
      if (hasCode(err, 'ENOENT') || hasCode(err, 'ENOTDIR')) return null
      throw err
    }
    if (this.dirs.has(key)) return { size: 0, mtimeMs: this.mtimes.get(key) ?? 0, isDir: true }
    const data = this.files.get(key)
    if (data === undefined) return null
    return { size: data.byteLength, mtimeMs: this.mtimes.get(key) ?? 0, isDir: false }
  }

  async readdir(path: AbsolutePath): Promise<string[]> {
    const key = this.lookup(normalize(path), true)
    // node: ENOTDIR for a file (or a link to one), ENOENT for nothing there.
    if (this.files.has(key)) throw fsError('ENOTDIR', 'not a directory', path)
    if (!this.dirs.has(key)) throw notFound(path)
    const prefix = key === '/' ? '/' : `${key}/`
    const names = new Set<string>()
    for (const candidate of [...this.dirs, ...this.files.keys(), ...this.links.keys()]) {
      if (candidate === key || !candidate.startsWith(prefix)) continue
      const rest = candidate.slice(prefix.length)
      const first = rest.split('/')[0]
      if (first !== undefined && first.length > 0) names.add(first)
    }
    return [...names].toSorted()
  }

  async mkdirp(path: AbsolutePath): Promise<void> {
    const pending = segmentsOf(normalize(path))
    let current: string[] = []
    let hops = 0
    for (let segment = pending.shift(); segment !== undefined; segment = pending.shift()) {
      if (segment === '..') {
        current.pop()
        continue
      }
      const candidate = keyOf([...current, segment])
      const last = pending.length === 0
      if (this.links.has(candidate)) {
        // Like node's recursive mkdir, never create what a link points to: it must reach a directory.
        hops += 1
        if (hops > MAX_LINK_HOPS) throw fsError('ELOOP', 'too many symbolic links', path)
        const reached = this.reach(candidate)
        if (reached !== null && this.dirs.has(reached)) {
          current = segmentsOf(reached)
          continue
        }
        if (!last) throw fsError('ENOTDIR', 'not a directory', path)
        throw reached !== null && this.files.has(reached)
          ? fsError('EEXIST', 'file exists', path)
          : notFound(path)
      }
      if (this.files.has(candidate)) {
        throw last
          ? fsError('EEXIST', 'file exists', path)
          : fsError('ENOTDIR', 'not a directory', path)
      }
      if (!this.dirs.has(candidate)) {
        this.dirs.add(candidate)
        this.mtimes.set(candidate, this.clock.now())
      }
      current.push(segment)
    }
  }

  async realpath(path: AbsolutePath): Promise<AbsolutePath | null> {
    const key = normalize(path)
    try {
      const real = this.lookup(key, true)
      if (this.dirs.has(real) || this.files.has(real)) return absolutePath(real)
      throw notFound(path)
    } catch (err) {
      if (!hasCode(err, 'ENOENT') && !hasCode(err, 'ENOTDIR')) throw err
      // The desktop host's lstat fallback: null only when the entry itself is absent.
      let entry: string
      try {
        entry = this.lookup(key, false)
      } catch (lstatErr) {
        if (hasCode(lstatErr, 'ENOENT') || hasCode(lstatErr, 'ENOTDIR')) return null
        throw err
      }
      if (!this.dirs.has(entry) && !this.files.has(entry) && !this.links.has(entry)) return null
      throw err
    }
  }

  symlink(link: AbsolutePath, target: string): void {
    const key = this.lookup(normalize(link), false)
    if (this.dirs.has(key) || this.files.has(key) || this.links.has(key)) {
      throw fsError('EEXIST', 'file exists', link)
    }
    if (target.length === 0) throw notFound(link)
    this.links.set(key, target)
  }

  /**
   * Walks `path` one segment at a time and returns the physical key it names. Links before the
   * last segment are always followed, the last one only when `followLast`; the last segment itself
   * need not exist. Throws ENOENT / ENOTDIR when a directory on the way is missing or is a file,
   * ELOOP after MAX_LINK_HOPS links.
   */
  private lookup(path: string, followLast: boolean): string {
    const pending = segmentsOf(path)
    const current: string[] = []
    let hops = 0
    for (let segment = pending.shift(); segment !== undefined; segment = pending.shift()) {
      if (segment === '..') {
        current.pop()
        continue
      }
      const candidate = keyOf([...current, segment])
      const last = pending.length === 0
      const target = this.links.get(candidate)
      if (target !== undefined && (!last || followLast)) {
        hops += 1
        if (hops > MAX_LINK_HOPS) throw fsError('ELOOP', 'too many symbolic links', path)
        if (target.startsWith('/')) current.length = 0
        pending.unshift(...segmentsOf(target))
        continue
      }
      if (!last && !this.dirs.has(candidate)) {
        throw this.files.has(candidate)
          ? fsError('ENOTDIR', 'not a directory', path)
          : notFound(path)
      }
      current.push(segment)
    }
    return keyOf(current)
  }

  /** Where the link at `key` leads, or null when it leads nowhere (ELOOP still throws). */
  private reach(key: string): string | null {
    try {
      const real = this.lookup(key, true)
      return this.dirs.has(real) || this.files.has(real) ? real : null
    } catch (err) {
      if (hasCode(err, 'ENOENT') || hasCode(err, 'ENOTDIR')) return null
      throw err
    }
  }
}

/** Linux's MAXSYMLINKS; macOS stops at 32. Any bound turns a loop into ELOOP. */
const MAX_LINK_HOPS = 40

function normalize(path: AbsolutePath): string {
  absolutePath(path)
  if (!path.startsWith('/')) {
    throw new TypeError(`MemoryHost supports POSIX paths only, got "${path}"`)
  }
  const collapsed = path.replace(/\/+/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed
}

/** The segments of a path or link target, empty ones and `.` dropped; `..` kept for the walk. */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0 && s !== '.')
}

function keyOf(segments: readonly string[]): string {
  return `/${segments.join('/')}`
}

function fsError(code: string, message: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${message}, ${path}`), { code })
}

function notFound(path: string): Error {
  return fsError('ENOENT', 'no such file or directory', path)
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code
}

class MemorySecrets implements HostSecrets {
  private readonly store = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}

const noProcess: HostProcess = {
  async spawn(_spec: SpawnSpec, _signal?: AbortSignal): Promise<ChildHandle> {
    throw new Error('MemoryHost: process.spawn is unavailable; inject a HostProcess')
  },
}

const noNetwork: HostNetwork = {
  fetch: async () => {
    throw new Error('MemoryHost: network.fetch is unavailable; inject a HostNetwork (fakeNetwork)')
  },
}

class PassthroughSandbox implements HostSandbox {
  readonly log: string[] = []
  async wrap(request: SandboxRequest): Promise<{ argv: string[]; env: Record<string, string> }> {
    if (request.profile !== 'full-access') {
      this.log.push(`sandbox: passthrough ${request.commandId} ${request.profile}`)
    }
    return { argv: [...request.argv], env: { ...request.env } }
  }
  async afterExit(_commandId: string): Promise<void> {}
  async violations(_commandId: string): Promise<SandboxViolation[]> {
    return []
  }
}

const PERSONAL_TENANT: PolicyState = { status: 'current', version: 'empty', snapshot: EMPTY_POLICY }

class MemoryPolicy implements HostPolicy {
  private state: PolicyState
  /** One entry per subscribe() call, so subscribing the same function twice is two subscriptions. */
  private readonly listeners = new Set<{ readonly listener: (state: PolicyState) => void }>()

  constructor(state: PolicyState) {
    this.state = state
  }

  current(): PolicyState {
    return this.state
  }

  subscribe(listener: (state: PolicyState) => void): () => void {
    const entry = { listener }
    this.listeners.add(entry)
    return () => {
      this.listeners.delete(entry)
    }
  }

  set(state: PolicyState): void {
    this.state = state
    // A live Set: a listener unsubscribed by an earlier one during this loop is not called.
    for (const entry of this.listeners) entry.listener(state)
  }
}

class RecordingConfirm implements HostConfirm {
  readonly requests: ConfirmRequest[] = []
  async request(req: ConfirmRequest): Promise<void> {
    this.requests.push(req)
  }
}

interface Timer {
  id: number
  due: number
  fn: () => void
}

class ManualClock implements HostClock {
  private current: number
  private nextId = 0
  private timers: Timer[] = []

  constructor(start: number) {
    this.current = start
  }

  now(): number {
    return this.current
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const timer: Timer = { id: this.nextId++, due: this.current + Math.max(0, ms), fn }
    this.timers.push(timer)
    return () => {
      this.timers = this.timers.filter((t) => t !== timer)
    }
  }

  advance(ms: number): void {
    const target = this.current + Math.max(0, ms)
    for (;;) {
      const due = this.timers
        .filter((t) => t.due <= target)
        .toSorted((a, b) => a.due - b.due || a.id - b.id)[0]
      if (due === undefined) break
      this.timers = this.timers.filter((t) => t !== due)
      this.current = due.due
      due.fn()
    }
    this.current = target
  }
}

export function createMemoryHost(options: MemoryHostOptions = {}): MemoryHost {
  const identity: HostIdentity = { ...DEFAULT_IDENTITY, ...options.identity }
  if (identity.tenantId.length === 0) throw new TypeError('MemoryHost: tenantId must not be empty')
  absolutePath(identity.profileDir)
  const clock = new ManualClock(options.now ?? 0)
  const fs = new MemoryFs(clock)
  const sandbox = new PassthroughSandbox()
  const confirm = new RecordingConfirm()
  const policy = new MemoryPolicy(options.policy ?? PERSONAL_TENANT)
  return {
    identity,
    fs,
    secrets: new MemorySecrets(),
    process: options.process ?? noProcess,
    sandbox,
    confirm,
    clock,
    network: options.network ?? noNetwork,
    policy,
    files: fs.files,
    confirmRequests: confirm.requests,
    sandboxLog: sandbox.log,
    advance: (ms) => clock.advance(ms),
    setPolicy: (state) => policy.set(state),
    symlink: (link, target) => fs.symlink(link, target),
  }
}
