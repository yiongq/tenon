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
 */

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
  // Removal is a separately grantable capability and is not part of the base
  // interface; phase 4 adds HostFs.remove together with runtime authorisation.
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
}

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

/**
 * Required `facts` keys per reason. `irreversible` additionally requires
 * `path` when kind = 'file' and `command` when kind = 'command'.
 */
export const CONFIRM_FACT_KEYS: Readonly<Record<ConfirmReason, readonly string[]>> = {
  irreversible: ['toolName'],
  'outside-workspace': ['path', 'workspace'],
  network: ['host', 'toolName'],
  elevated: ['command'],
  default: ['toolName'],
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
}

/**
 * Rejected by the host when its egress policy refuses a request; providers normalise it
 * to a non-retryable `egress-denied`.
 */
export class HostNetworkDeniedError extends Error {}
