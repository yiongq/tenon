/**
 * HostAdapter — the only boundary between the kernel and the outside world.
 *
 * The kernel depends on this interface alone and never learns whether it runs
 * inside Electron or inside a server-side sandbox. Shapes are fixed by
 * docs/architecture/00-foundation/spec.md §HostAdapter; change them there first.
 *
 * `network` is the eighth member, added by the amendment in
 * docs/architecture/01-provider-and-tape/spec.md ("the HostAdapter.network patch
 * to 00-foundation"). The phase 0 seven members are unchanged.
 *
 * `policy` is the ninth member, added by the amendment in
 * docs/architecture/02-agent-loop/spec.md (§对 00-foundation 的修补), which also adds
 * `HostFs.realpath`, four `ConfirmReason` values and `ConfirmRequest.reversibility` / `target`.
 */

import type { PolicyState } from './policy.js'

/** A string that has been checked to be an absolute filesystem path. */
export type AbsolutePath = string & { readonly __brand: 'AbsolutePath' }

export interface HostAdapter {
  readonly identity: HostIdentity
  readonly fs: HostFs
  readonly secrets: HostSecrets
  readonly process: HostProcess
  readonly sandbox: HostSandbox
  readonly confirm: HostConfirm
  readonly clock: HostClock
  readonly network: HostNetwork
  readonly policy: HostPolicy
}

/** The read-only entry to the tenant policy. The host fetches and caches it; the kernel only reads. */
export interface HostPolicy {
  /** Synchronous and never throws; when the latest policy is out of reach, the cached snapshot. */
  current(): PolicyState
  /** Called when the policy changes; returns the unsubscribe function (as HostClock.setTimeout). */
  subscribe(listener: (state: PolicyState) => void): () => void
}

export interface HostIdentity {
  userId: string
  /** Local: the profile's tenant. Server: the organisation. Never empty. */
  tenantId: string
  /** Root of local persistence; already contains the tenantId. */
  profileDir: string
}

export interface HostFs {
  readFile(path: AbsolutePath, opts?: { encoding?: 'utf8' }): Promise<Uint8Array | string>
  writeFile(path: AbsolutePath, data: Uint8Array | string): Promise<void>
  stat(path: AbsolutePath): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null>
  readdir(path: AbsolutePath): Promise<string[]>
  mkdirp(path: AbsolutePath): Promise<void>
  /**
   * The real absolute path, symbolic links resolved.
   * Null only when the directory entry itself does not exist (lstat reports ENOENT / ENOTDIR too).
   * An entry that exists but does not resolve (a dangling link, ELOOP, ...) and every other error
   * throw — a dangling link's realpath also reports ENOENT and must not read as "not there yet".
   * An entry that is there and can be followed, yet has no real path to give (macOS's
   * `/.vol/<dev>/<ino>`, and the host's other alias spellings: `/.nofollow`, `/.resolve`, `/dev/fd`),
   * throws `UnresolvableAliasError`.
   */
  realpath(path: AbsolutePath): Promise<AbsolutePath | null>
  // Removal is a separately grantable capability and is not part of the base
  // interface; phase 4 adds HostFs.remove together with runtime authorisation.
}

/**
 * `HostFs.realpath`'s one typed failure: lstat sees the entry and stat follows it to a file that is
 * there, yet realpath(3) cannot name it — macOS volfs's `/.vol/<dev>/<ino>`, which reaches any file
 * by its inode. What cannot be named cannot be compared with the protected list, so the kernel blocks
 * the path like the list, with no card (spec 02 §「在不在工作区里」 step 2; owner 2026-09-27). A
 * dangling link is not this: stat cannot follow it, and realpath throws the original error.
 */
export class UnresolvableAliasError extends Error {
  readonly path: AbsolutePath

  constructor(path: AbsolutePath, options?: ErrorOptions) {
    super(`realpath cannot name ${path}, though the entry is there`, options)
    this.name = 'UnresolvableAliasError'
    this.path = path
  }
}

export interface HostSecrets {
  /** `key` already carries the tenantId prefix (see keyFor). */
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface HostProcess {
  spawn(spec: SpawnSpec, signal?: AbortSignal): Promise<ChildHandle>
}

export interface SpawnSpec {
  /** argv[0] is the absolute path of the executable. */
  argv: string[]
  cwd: AbsolutePath
  env: Record<string, string>
  stdio: 'pipe' | 'ignore'
}

export interface ChildHandle {
  pid: number
  stdin: WritableStream<Uint8Array>
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<{ code: number | null; signal: string | null }>
  /** Must clean up the whole process tree. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>
}

export interface HostSandbox {
  /**
   * Turns "the command we want to run" into "the argv/env we actually spawn".
   * Desktop wires sandbox-runtime in phase 4; phase 0 passes through.
   */
  wrap(request: SandboxRequest): Promise<{ argv: string[]; env: Record<string, string> }>
  afterExit(commandId: string): Promise<void>
  violations(commandId: string): Promise<SandboxViolation[]>
}

export interface SandboxRequest {
  /** = tool-use id; used to attribute violations. */
  commandId: string
  argv: string[]
  cwd: AbsolutePath
  env: Record<string, string>
  /** full-access = no wrapping at all. */
  profile: 'read-only' | 'workspace-write' | 'full-access'
  workspace: AbsolutePath[]
}

export interface SandboxViolation {
  kind: 'fs' | 'network'
  line: string
}

export interface HostConfirm {
  /**
   * Phase 0 only fixes the shape. Phase 2's waiting model is "written to the
   * transcript, run paused"; this call merely delivers the request to the UI.
   */
  request(req: ConfirmRequest): Promise<void>
}

export interface ConfirmRequest {
  requestId: string
  sessionId: string
  kind: 'tool' | 'file' | 'command' | 'network'
  /** The UI picks copy from this; the kernel never produces sentences. */
  reason: ConfirmReason
  /** Slot values. Required keys per reason: see CONFIRM_FACT_KEYS. */
  facts: Record<string, string>
  /** Raw payload the UI must not render; logs only. Phase 2 decides its use. */
  redacted?: unknown
  /** Added by spec 02, required (E1). */
  reversibility: Reversibility
  /** Added by spec 02, required (E4). */
  target: ConfirmTarget
}

/**
 * Whether Tenon can undo the change this call makes. Only the change: data sent away is told by
 * the `network` reason and by `target`. Phase 2 produces `read-only`, `unknown` and `irreversible`.
 * Constraint: reason `irreversible` implies reversibility `irreversible`, not the other way round.
 */
export type Reversibility = 'read-only' | 'revertible' | 'snapshotted' | 'irreversible' | 'unknown'

/**
 * The only member the card's "object" line reads (H3). Discriminated by `type`, not `kind`, so it
 * does not blur with ConfirmRequest.kind. An MCP call names the tool, not its arguments: the card
 * shows the call's `input` separately, expanded (spec 02 open question 15).
 */
export type ConfirmTarget =
  | { type: 'command'; command: string; cwd: AbsolutePath } // the command verbatim + its cwd
  | { type: 'path'; path: AbsolutePath } // the real path after resolution (D8)
  | { type: 'url'; url: string } // the full URL (WebFetch)
  | { type: 'search'; query: string; host: string } // the query actually sent + the backend's host
  | { type: 'tool'; serverId: string; toolName: string } // MCP: serverId as in the permission key, the server's own tool name

/**
 * Phase 0 lists only the reasons an approval card must tell apart. Phase 2's
 * permission engine extends this list; entries are only ever added.
 */
export type ConfirmReason =
  | 'irreversible'
  | 'outside-workspace'
  | 'network'
  | 'elevated'
  | 'default'
  // added by spec 02 (§`ConfirmReason` 只增四个值)
  | 'policy'
  | 'flagged'
  | 'command'
  | 'interaction-required'

/**
 * Required `facts` keys per reason. `irreversible` additionally requires
 * `path` when kind = 'file' and `command` when kind = 'command'.
 * `flagged`'s `category` holds a FlaggedCategory (permission/inspector.ts); contracts refuse others.
 */
export const CONFIRM_FACT_KEYS: Readonly<Record<ConfirmReason, readonly string[]>> = {
  irreversible: ['toolName'],
  'outside-workspace': ['path', 'workspace'],
  network: ['host', 'toolName'],
  elevated: ['command'],
  default: ['toolName'],
  // added by spec 02
  policy: ['toolName'],
  flagged: ['toolName', 'category'],
  command: ['command', 'cwd'],
  'interaction-required': ['toolName'],
}

export interface HostClock {
  now(): number
  setTimeout(fn: () => void, ms: number): () => void
}

/**
 * The full web signature. Narrowing `input` to string stops it satisfying either SDK's
 * `ClientOptions.fetch`.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * The kernel's only way out. A property rather than a method: method shorthand is
 * bivariant under strictFunctionTypes.
 */
export interface HostNetwork {
  readonly fetch: FetchLike
  /** Fetch one untrusted hop; reject unsafe DNS addresses and pin the checked address. */
  readonly fetchUntrusted: FetchLike
}

/**
 * Rejected by the host when its egress policy refuses a request; providers normalise it
 * to a non-retryable `egress-denied`.
 */
export class HostNetworkDeniedError extends Error {}
