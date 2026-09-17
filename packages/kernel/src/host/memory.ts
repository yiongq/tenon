import type {
  AbsolutePath,
  ChildHandle,
  ConfirmRequest,
  HostAdapter,
  HostClock,
  HostConfirm,
  HostFs,
  HostIdentity,
  HostProcess,
  HostSandbox,
  HostSecrets,
  SandboxRequest,
  SandboxViolation,
  SpawnSpec,
} from './adapter.js'
import { absolutePath } from './path.js'

/**
 * In-memory HostAdapter for tests. Everything is deterministic and inspectable;
 * nothing touches the real machine. `process.spawn` is not available unless a
 * HostProcess is injected — the memory host has no way to run a program.
 */
export interface MemoryHostOptions {
  identity?: Partial<HostIdentity>
  process?: HostProcess
  /** Initial clock reading in ms since epoch. Default 0. */
  now?: number
}

export interface MemoryHost extends HostAdapter {
  readonly files: ReadonlyMap<string, Uint8Array>
  readonly confirmRequests: readonly ConfirmRequest[]
  /** One line per non-full-access sandbox wrap, mirroring the desktop passthrough log. */
  readonly sandboxLog: readonly string[]
  /** Moves the clock forward and fires timers that became due, in order. */
  advance(ms: number): void
}

const DEFAULT_IDENTITY: HostIdentity = {
  userId: 'user',
  tenantId: 'tenant',
  profileDir: '/profiles/user/tenant',
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

class MemoryFs implements HostFs {
  readonly files = new Map<string, Uint8Array>()
  readonly mtimes = new Map<string, number>()
  readonly dirs = new Set<string>(['/'])
  private readonly clock: HostClock

  constructor(clock: HostClock) {
    this.clock = clock
  }

  async readFile(path: AbsolutePath, opts?: { encoding?: 'utf8' }): Promise<Uint8Array | string> {
    const key = normalize(path)
    const data = this.files.get(key)
    if (data === undefined) throw notFound(path)
    return opts?.encoding === 'utf8' ? decoder.decode(data) : data.slice()
  }

  async writeFile(path: AbsolutePath, data: Uint8Array | string): Promise<void> {
    const key = normalize(path)
    if (this.dirs.has(key)) throw new Error(`EISDIR: is a directory, ${path}`)
    if (!this.dirs.has(parentOf(key))) throw notFound(path)
    this.files.set(key, typeof data === 'string' ? encoder.encode(data) : data.slice())
    this.mtimes.set(key, this.clock.now())
  }

  async stat(
    path: AbsolutePath,
  ): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null> {
    const key = normalize(path)
    if (this.dirs.has(key)) return { size: 0, mtimeMs: this.mtimes.get(key) ?? 0, isDir: true }
    const data = this.files.get(key)
    if (data === undefined) return null
    return { size: data.byteLength, mtimeMs: this.mtimes.get(key) ?? 0, isDir: false }
  }

  async readdir(path: AbsolutePath): Promise<string[]> {
    const key = normalize(path)
    if (!this.dirs.has(key)) throw notFound(path)
    const prefix = key === '/' ? '/' : `${key}/`
    const names = new Set<string>()
    for (const candidate of [...this.dirs, ...this.files.keys()]) {
      if (candidate === key || !candidate.startsWith(prefix)) continue
      const rest = candidate.slice(prefix.length)
      const first = rest.split('/')[0]
      if (first !== undefined && first.length > 0) names.add(first)
    }
    return [...names].toSorted()
  }

  async mkdirp(path: AbsolutePath): Promise<void> {
    const key = normalize(path)
    if (this.files.has(key)) throw new Error(`EEXIST: file exists, ${path}`)
    let current = ''
    for (const segment of key.split('/').filter((s) => s.length > 0)) {
      current = `${current}/${segment}`
      if (this.files.has(current)) throw new Error(`ENOTDIR: not a directory, ${current}`)
      if (!this.dirs.has(current)) {
        this.dirs.add(current)
        this.mtimes.set(current, this.clock.now())
      }
    }
  }
}

function normalize(path: AbsolutePath): string {
  absolutePath(path)
  if (!path.startsWith('/')) {
    throw new TypeError(`MemoryHost supports POSIX paths only, got "${path}"`)
  }
  const collapsed = path.replace(/\/+/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed
}

function parentOf(key: string): string {
  const idx = key.lastIndexOf('/')
  return idx <= 0 ? '/' : key.slice(0, idx)
}

function notFound(path: string): Error {
  return new Error(`ENOENT: no such file or directory, ${path}`)
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
  return {
    identity,
    fs,
    secrets: new MemorySecrets(),
    process: options.process ?? noProcess,
    sandbox,
    confirm,
    clock,
    files: fs.files,
    confirmRequests: confirm.requests,
    sandboxLog: sandbox.log,
    advance: (ms) => clock.advance(ms),
  }
}
