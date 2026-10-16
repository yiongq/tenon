/**
 * Spec 04 §afterExit、清理与违规: one sandbox-runtime violation line becomes one `SandboxViolation`,
 * or nothing when it is a Linux observer report the host drops (T10, T41; 读法 11, 18, 32, 35, 36,
 * 44, 53). srt's events carry only the line text, so the host reads the text, and only a line that
 * matches one of the table's shapes exactly earns a target, a release or `protected` (读法 44).
 *
 * The shapes are tried in a fixed order, each one anchored to the whole line:
 *
 * 1. srt's proxy, `deny network-outbound <host>:<port> (<reason>)`. srt records the host raw:
 *    an HTTP CONNECT host may hold parentheses (srt79 http-proxy.js:669-676 takes `[^:]+`; the
 *    SOCKS proxy refuses a malformed host before its filter and records nothing, socks-proxy.js:
 *    22-31), and any proxy-shaped text can be forged through the Linux observer, whose syscall
 *    is unchecked (shape 2). So this shape goes first.
 * 2. The Linux seccomp observer, `deny <syscall> <absolute path>`. Both its syscall and its path
 *    are the sandboxed process's own bytes: the observer socket is writable inside the sandbox
 *    (srt79 linux-violation-monitor.js:21-24, :76-82, :102-105).
 * 3. Seatbelt on macOS, `<process>(<pid>) deny(1) <operation>[ <rest>]`, the whole text after
 *    `Sandbox: ` in the log (macos-sandbox-utils.js:1158, :1176). A line starting with `deny ` is
 *    not read as one: srt's proxy and observer start every line that way, the observer's with a
 *    forgeable syscall, and the context carries no platform to tell them apart (on Linux nothing
 *    may earn a path release). The cost: on macOS a process whose name starts with `deny ` (the
 *    sandboxed program picks the basename) has its real denials read as unrecognized lines, as
 *    the spec already accepts for a name with parentheses (spec §afterExit, after the table).
 *    Nor is one holding a control character (srt cuts the log at newlines
 *    and its store turns the rest into spaces), a `Sandbox:` anywhere (读法 44), or a second
 *    `(<pid>) deny(1) `: the process name holds no parentheses, and a name that does must not
 *    make the line read as another operation.
 *
 * Anything else is `kind: 'fs'` with no target and not `observed`: it still counts towards the
 * denial cap (读法 44, 53, spec open question 8).
 *
 * A Seatbelt line's path is compared with the lists as macOS's default APFS volume compares names,
 * ignoring Unicode normalization and case under full case folding (`.zſhrc`, `.gitconﬁg` and
 * `straße` name `.zshrc`, `.gitconfig` and `strasse`): Seatbelt refuses `.ENVRC` under a `.envrc`
 * rule and logs the name as the command spelled it (P1 F11, F12), so "on a denyWrite entry" there
 * means the same file. Folding only adds matches, so folding more than APFS does only adds
 * `protected` and removes releases. The Linux observer's paths compare as bytes.
 */
import { isIP } from 'node:net'
import { posix } from 'node:path'
import type { SandboxViolation } from '@tenon-app/kernel'
import { walkLinks } from './sandbox-config.js'

/**
 * A filesystem list entry as it is handed to srt: a path marked literal, or a glob. Tenon's only
 * globs are macOS's `<root>/**\/<name>` (spec §档位到 srt 配置), so `**`, `*` and `?` are the
 * wildcards read here; the spec never passes a glob whose root holds `[`.
 */
export type SandboxPathEntry = string | { readonly path: string; readonly literal: true }

/** What `lstat` says about the last component of a path; a link is never followed. */
export interface PathKind {
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** The wrap a line belongs to, as the line arrives. */
export interface ViolationContext {
  /** This wrap's `filesystem` lists as handed to srt. */
  readonly allowWrite: readonly SandboxPathEntry[]
  readonly denyWrite: readonly SandboxPathEntry[]
  readonly denyRead: readonly SandboxPathEntry[]
  /**
   * The profile directory as written and as its real path, the two spellings every deny entry gets
   * (spec §档位到 srt 配置「链接」): Seatbelt logs the real path (`/private/var/folders/…` for a
   * profile under `/var/folders`), and a read there must stay `protected` (读法 36).
   */
  readonly profileDirs: readonly string[]
  readonly homeDir: string
  /**
   * `fs.lstatSync(path, { throwIfNoEntry: false })` in the app: undefined when nothing is there. It
   * may throw (ENOTDIR, EACCES, ENAMETOOLONG): classify reads a throw as "don't know", which drops
   * nothing and offers no release, and never lets it out (step 4 calls classify from srt's store
   * listener, which srt calls without a try).
   */
  readonly lstat: (path: string) => PathKind | undefined
  /**
   * `fs.readlinkSync` in the app: what a link holds; throws when the path is no link. With `lstat`
   * it resolves a Linux observer path to where the write landed (读法 11); a throw is "don't know".
   */
  readonly readlink: (path: string) => string
}

const PROXY_LINE = /^deny network-outbound (.+):(\d+) \(([^()]+)\)$/
const OBSERVER_LINE = /^deny ([a-z0-9_]+) (\/.*)$/
const SEATBELT_LINE = /^([^\s()][^()]*)\((\d+)\) deny\(1\) (\S+)(?: (.+))?$/
const SEATBELT_HEAD = /\(\d+\) deny\(1\) /g
const CONTROL = /\p{Cc}/u
const SEATBELT_DIRECT = /^remote:\*:\d+$/
const FILE_WRITE = /^file-write-[a-z]+(?:-[a-z]+)*$/
const FILE_READ = /^file-read-[a-z]+(?:-[a-z]+)*$/
/**
 * srt's isValidHost charset for a name (parent-proxy.js:369-381); an IP literal is checked apart.
 * A host outside it gets no target, and the receipt counts it among the lines with no object
 * (spec §afterExit, the table's first row).
 */
const HOST_NAME = /^[A-Za-z0-9._-]+$/
/**
 * A plain domain srt's config schema takes as an allowedDomains entry: at least one dot, neither
 * first nor last (srt79 sandbox-config.js:20-56); Tenon also refuses an empty label (spec
 * §afterExit, the table's first row).
 */
const DOMAIN_NAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/

/** How a path is compared: as bytes, or as a case-insensitive APFS volume does (header). */
type Fold = (text: string) => string
const AS_BYTES: Fold = (text) => text
/** Upper then lower case: `toLowerCase` alone keeps `ſ` and `ﬁ`, which APFS folds to s and fi. */
const APFS: Fold = (text) => text.normalize('NFC').toUpperCase().toLowerCase()

/** The proxy's only reason that leaves a domain button (读法 18). */
const NOT_ON_ALLOW_LIST = 'host is not on the allow list'

/** Seatbelt operations with no object that read as diagnostics only: a closed list (读法 53). */
const OBJECTLESS_OPERATIONS: ReadonlySet<string> = new Set([
  'mach-lookup',
  'sysctl-read',
  'network-bind',
])

/**
 * Classify one line from srt's violation store for the wrap `context` describes. `undefined`
 * means the line is dropped on arrival: a Linux observer report of a write that lands where the
 * wrap may write, or of a `mkdirat` (on x64 also the older `mkdir`) on a directory that is already
 * there (读法 11, 53).
 */
export function classify(line: string, context: ViolationContext): SandboxViolation | undefined {
  const proxy = PROXY_LINE.exec(line)
  if (proxy !== null) return proxyDenial(line, proxy[1] ?? '', proxy[3] ?? '')

  const observer = OBSERVER_LINE.exec(line)
  if (observer !== null) return observerReport(line, observer[1] ?? '', observer[2] ?? '', context)

  const seatbelt = seatbeltShape(line)
  if (seatbelt !== null) return seatbeltDenial(line, seatbelt[3] ?? '', seatbelt[4], context)

  return { kind: 'fs', line }
}

/** The Seatbelt shape, only for a line no other producer could have made (header, shape 3). */
function seatbeltShape(line: string): RegExpExecArray | null {
  if (line.startsWith('deny ') || CONTROL.test(line) || line.includes('Sandbox:')) return null
  if (line.match(SEATBELT_HEAD)?.length !== 1) return null
  return SEATBELT_LINE.exec(line)
}

function proxyDenial(line: string, rawHost: string, reason: string): SandboxViolation {
  const host = normalizeHost(rawHost)
  if (host === undefined) return { kind: 'network', line }
  if (reason === NOT_ON_ALLOW_LIST && isDomainName(host)) {
    return { kind: 'network', line, target: host, release: 'domain' }
  }
  return { kind: 'network', line, target: host }
}

function observerReport(
  line: string,
  syscall: string,
  path: string,
  context: ViolationContext,
): SandboxViolation | undefined {
  // Longer than the kernel takes, so the process wrote it itself: kept as spelled, never looked up.
  if (Buffer.byteLength(path) > MAX_OBSERVED_PATH_BYTES) {
    const spelled = posix.normalize(path)
    return context.denyWrite.some((entry) => covers(entry, spelled, AS_BYTES))
      ? { kind: 'fs', line, target: path, protected: true, observed: true }
      : { kind: 'fs', line, target: path, observed: true }
  }
  const ports = budgetedPorts(context)
  // That call did nothing: GNU `mkdir -p` reports every ancestor that already exists (读法 53).
  // x64's observer also watches the older `mkdir`, which glibc uses there for the same call.
  if (syscall === 'mkdirat' || syscall === 'mkdir') {
    const kind = lookUp(ports.lstat, path)
    if (kind !== 'unknown' && kind?.isDirectory() === true) return undefined
  }
  // srt's observer list is the empty one from initialize; this wrap's lists decide (读法 11). The
  // path is as the process spelled it (links not resolved, linux-violation-monitor.js:62) while
  // allowWrite holds real paths and bwrap refuses by where a write lands, so the path is resolved
  // first. denyWrite is matched by both the spelling and the landing: the sandbox may not see the
  // host's links (an existing denyRead directory is an empty tmpfs there).
  const spot = posix.normalize(path)
  // What this level resolved to may be another thing from now on (rm and ln -s in its place).
  if (REPLACES_LEVEL.has(syscall)) forgetDir(spot, context)
  const landings = landingsOf(syscall, spot, context, ports)
  const denied = [spot, ...landings].some(
    (place) =>
      place !== undefined && context.denyWrite.some((entry) => covers(entry, place, AS_BYTES)),
  )
  const resolved = landings.filter((place) => place !== undefined)
  if (
    !denied &&
    resolved.length === landings.length &&
    resolved.every((place) => mayWrite(place, context))
  ) {
    return undefined
  }
  // Where it landed when that is known; else as the process spelled it, never dropped.
  const target = resolved.length === landings.length ? (resolved[0] ?? path) : path
  return denied
    ? { kind: 'fs', line, target, protected: true, observed: true }
    : { kind: 'fs', line, target, observed: true }
}

/**
 * Observer calls that follow a link in the last place: open, truncate, chmod, chown, utimes, with
 * x64's older calls among them (its apply-seccomp watches `creat` … `utimes` too; arm64's only the
 * `*at` ones). The observer carries no flags, so `touch -h`, `chown -h` or O_NOFOLLOW read as
 * following too; that only touches a diagnostic.
 */
const FOLLOWS_LAST: ReadonlySet<string> = new Set([
  'openat',
  'openat2',
  'creat',
  'truncate',
  'fchmodat',
  'fchmodat2',
  'fchownat',
  'utimensat',
  'open',
  'chmod',
  'chown',
  'utime',
  'utimes',
])

/**
 * Observer calls that act on a link in the last place itself: unlink, rmdir, rename, mkdir, mknod,
 * symlink, link, lchown, x64's older calls among them.
 */
const KEEPS_LAST: ReadonlySet<string> = new Set([
  'unlinkat',
  'renameat',
  'renameat2',
  'mkdirat',
  'mknodat',
  'symlinkat',
  'linkat',
  'unlink',
  'rmdir',
  'rename',
  'symlink',
  'mkdir',
  'mknod',
  'link',
  'lchown',
])

/** Calls that may leave a link, or nothing, where a directory was: its cached resolution goes. */
const REPLACES_LEVEL: ReadonlySet<string> = new Set([
  'unlinkat',
  'renameat',
  'renameat2',
  'symlinkat',
  'linkat',
  'unlink',
  'rmdir',
  'rename',
  'symlink',
  'link',
])

/**
 * Where an observed write landed on the host (读法 11): its directory resolved as the kernel does,
 * then its last level, followed or not as the call does; a call in neither table (a name the
 * observer never sends; its line is the process's own bytes) gets both readings. `undefined` where
 * it cannot be told. A path is not resolved past `/proc` or `/dev`, spelled there or reached through
 * a link: on the host they lead into Tenon's own process and devices.
 */
function landingsOf(
  syscall: string,
  spot: string,
  context: ViolationContext,
  ports: LookupPorts,
): (string | undefined)[] {
  if (unresolved(spot)) return [spot]
  if (FOLLOWS_LAST.has(syscall)) return [landing(spot, true, context, ports)]
  if (KEEPS_LAST.has(syscall)) return [landing(spot, false, context, ports)]
  return [landing(spot, false, context, ports), landing(spot, true, context, ports)]
}

function landing(
  spot: string,
  followLast: boolean,
  context: ViolationContext,
  ports: LookupPorts,
): string | undefined {
  if (spot === '/') return spot
  const dir = realDirOf(posix.dirname(spot), context, ports)
  if (dir === undefined) return undefined
  const node = posix.join(dir, posix.basename(spot))
  if (!followLast || unresolved(node)) return node
  const kind = lookUp(ports.lstat, node)
  if (kind === 'unknown') return undefined
  return kind?.isSymbolicLink() === true ? walkLinks(node, ports, true, unresolved).real : node
}

/** Under `/proc` or `/dev`: never looked at on the host (landingsOf). */
function unresolved(path: string): boolean {
  return within(path, '/proc') || within(path, '/dev')
}

/**
 * Where bwrap lets the command write: this wrap's allowWrite, or a place srt keeps writable itself,
 * which srt's own observer drops as spelled (sandbox-utils.js:486-504, sandbox-manager.js:518-523):
 * the standard streams, `/dev/null`, `/dev/tty`, `/tmp/claude` and the two home directories.
 */
function mayWrite(place: string, context: ViolationContext): boolean {
  if (context.allowWrite.some((entry) => covers(entry, place, AS_BYTES))) return true
  const home = context.homeDir
  return [
    '/dev/stdout',
    '/dev/stderr',
    '/dev/null',
    '/dev/tty',
    '/tmp/claude',
    '/private/tmp/claude',
    posix.join(home, '.npm/_logs'),
    posix.join(home, '.claude/debug'),
  ].some((dir) => within(place, dir))
}

/**
 * Linux's PATH_MAX: the kernel refuses a longer path (ENAMETOOLONG), so an observer path longer
 * than this the process wrote itself. It is kept as spelled and never looked up.
 */
export const MAX_OBSERVED_PATH_BYTES = 4096
/** The directories one wrap keeps resolved; past it a line in a new one is kept, not resolved. */
export const MAX_RESOLVED_DIRS = 4096
/**
 * The `lstat` and `readlink` calls one wrap spends resolving observer paths, all on main's thread;
 * past it every line is kept as it is, observed. The observer socket is the process's to write
 * (header, shape 2), so a flood of forged lines must not grow the cache or the work without end;
 * keeping a line is the safe side (it is only a diagnostic), dropping one is not.
 */
export const MAX_PATH_LOOKUPS = 65_536

type LookupPorts = Pick<ViolationContext, 'lstat' | 'readlink'>

/**
 * A wrap's directories as resolved so far: an install reports thousands of writes into a few
 * hundred directories, and srt's listener runs them on main's thread, one by one. `children` lists
 * the cached directories right under each one, so a replaced level drops its subtree alone.
 * `ports` are the context's, counted against `MAX_PATH_LOOKUPS`.
 */
interface ResolvedDirs {
  readonly real: Map<string, string | undefined>
  readonly children: Map<string, Set<string>>
  readonly ports: LookupPorts
}

const RESOLVED_DIRS = new WeakMap<ViolationContext, ResolvedDirs>()

/** Thrown by a spent port: every caller reads a throwing port as "don't know", and keeps the line. */
const SPENT = new Error(`more than ${MAX_PATH_LOOKUPS} lookups in one wrap`)

function resolvedDirs(context: ViolationContext): ResolvedDirs {
  let known = RESOLVED_DIRS.get(context)
  if (known === undefined) {
    let lookups = 0
    const spend = (): void => {
      lookups += 1
      if (lookups > MAX_PATH_LOOKUPS) throw SPENT
    }
    known = {
      real: new Map(),
      children: new Map(),
      ports: {
        lstat: (path) => {
          spend()
          return context.lstat(path)
        },
        readlink: (path) => {
          spend()
          return context.readlink(path)
        },
      },
    }
    RESOLVED_DIRS.set(context, known)
  }
  return known
}

function budgetedPorts(context: ViolationContext): LookupPorts {
  return resolvedDirs(context).ports
}

/**
 * `dir` resolved as the kernel resolves it, one `lstat` per directory not seen before in this wrap;
 * undefined when it cannot be told, or when the cache is full and a level would have to be added.
 * Walked from the nearest cached level down, without recursion: a path may hold 2048 levels.
 */
function realDirOf(dir: string, context: ViolationContext, ports: LookupPorts): string | undefined {
  if (dir === '/') return dir
  const known = resolvedDirs(context)
  const pending: string[] = []
  let at = dir
  while (at !== '/' && !known.real.has(at)) {
    pending.push(at)
    at = posix.dirname(at)
  }
  let real = at === '/' ? at : known.real.get(at)
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (known.real.size >= MAX_RESOLVED_DIRS) return undefined
    const level = pending[index] ?? '/'
    if (real !== undefined) {
      const node = posix.join(real, posix.basename(level))
      const kind = unresolved(node) ? undefined : lookUp(ports.lstat, node)
      if (kind === 'unknown') real = undefined
      else if (kind?.isSymbolicLink() === true) real = walkLinks(node, ports, true, unresolved).real
      else real = node
    }
    known.real.set(level, real)
    const above = posix.dirname(level)
    const siblings = known.children.get(above) ?? new Set<string>()
    known.children.set(above, siblings.add(level))
  }
  return real
}

/** `dir` and every directory cached under it are resolved afresh when next reached. */
function forgetDir(dir: string, context: ViolationContext): void {
  const known = RESOLVED_DIRS.get(context)
  if (known === undefined || !known.real.has(dir)) return
  known.children.get(posix.dirname(dir))?.delete(dir)
  const stack = [dir]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    known.real.delete(next)
    stack.push(...(known.children.get(next) ?? []))
    known.children.delete(next)
  }
}

function seatbeltDenial(
  line: string,
  operation: string,
  rest: string | undefined,
  context: ViolationContext,
): SandboxViolation {
  if (operation === 'network-outbound' && (rest === undefined || SEATBELT_DIRECT.test(rest))) {
    // A direct connection that skipped the proxy; Seatbelt names no address (P1, P2).
    return { kind: 'network', line, observed: true }
  }
  if (rest?.startsWith('/') === true) {
    if (FILE_WRITE.test(operation)) return writeDenial(line, rest, context)
    if (FILE_READ.test(operation)) {
      // Only the profile is protected on read; a credential read may still be rerun (读法 36).
      const spot = APFS(posix.normalize(rest))
      return context.profileDirs.some((dir) => within(spot, APFS(posix.normalize(dir))))
        ? { kind: 'fs', line, target: rest, protected: true }
        : { kind: 'fs', line, target: rest }
    }
  }
  if (OBJECTLESS_OPERATIONS.has(operation)) return { kind: 'fs', line, observed: true }
  return { kind: 'fs', line }
}

/** A Seatbelt write denial, compared as APFS compares names (header). */
function writeDenial(line: string, target: string, context: ViolationContext): SandboxViolation {
  const spot = APFS(posix.normalize(target))
  if (context.denyWrite.some((entry) => covers(entry, spot, APFS))) {
    return { kind: 'fs', line, target, protected: true }
  }
  return offersPathRelease(target, context)
    ? { kind: 'fs', line, target, release: 'path' }
    : { kind: 'fs', line, target }
}

/**
 * 读法 35: an absolute, normalized path not ending in `/`, whose parent exists and is its own real
 * path, that is not an existing directory and is neither `/`, the home or profile directory, any
 * denyRead or denyWrite entry, nor an ancestor of one. Seatbelt allows a whole subtree, so a
 * denial on an ancestor (`chmod 700 ~`, a name cut at a newline) must never become the release.
 * An existing link is refused too (读法 35): allowWrite gets real paths only, so a link to a
 * directory (`/tmp`, `~/bin`; srt's store drops `<>`, so `touch '/tmp<'` names it) would give
 * its target's whole subtree.
 *
 * `DesktopSandbox.wrap` runs the same check on each workspace item outside the session's folders
 * (读法 35: the kernel checks a release, the host checks again on its own).
 */
export function offersPathRelease(target: string, context: ViolationContext): boolean {
  if (!target.startsWith('/') || target.endsWith('/') || posix.normalize(target) !== target) {
    return false
  }
  if (!isOwnRealDirectory(posix.dirname(target), context.lstat)) return false
  const kind = lookUp(context.lstat, target)
  if (kind === 'unknown' || kind?.isDirectory() === true || kind?.isSymbolicLink() === true) {
    return false
  }
  const anchors = [
    '/',
    context.homeDir,
    ...context.profileDirs,
    ...context.denyRead.map(anchorOf),
    ...context.denyWrite.map(anchorOf),
  ]
  const spot = APFS(target)
  return !anchors.some((anchor) => within(APFS(posix.normalize(anchor)), spot))
}

/** Every directory from `/` down to `dir` exists and none of them is a link. */
function isOwnRealDirectory(dir: string, lstat: ViolationContext['lstat']): boolean {
  let at = ''
  for (const part of dir.split('/')) {
    if (part === '') continue
    at += `/${part}`
    const kind = lookUp(lstat, at)
    if (kind === 'unknown' || kind === undefined || kind.isSymbolicLink() || !kind.isDirectory()) {
      return false
    }
  }
  return true
}

/** The lstat port's answer, or `'unknown'` when it threw. */
function lookUp(lstat: ViolationContext['lstat'], path: string): PathKind | undefined | 'unknown' {
  try {
    return lstat(path)
  } catch {
    return 'unknown'
  }
}

/** `path` is `dir` or lies under it. */
function within(path: string, dir: string): boolean {
  const base = dir.length > 1 ? dir.replace(/\/+$/, '') : dir
  if (base === '/') return path.startsWith('/')
  return path === base || path.startsWith(`${base}/`)
}

/**
 * The entry denies `spot`, a normalized path already folded by `fold`: a literal entry covers its
 * subtree, a glob each match's subtree.
 */
function covers(entry: SandboxPathEntry, spot: string, fold: Fold): boolean {
  if (typeof entry !== 'string') return within(spot, fold(posix.normalize(entry.path)))
  if (!hasWildcard(entry)) return within(spot, fold(posix.normalize(entry)))
  return globPattern(fold(entry)).test(spot)
}

/** The fixed directory an entry stands for: a glob's segments before its first wildcard. */
function anchorOf(entry: SandboxPathEntry): string {
  const spelling = typeof entry === 'string' ? entry : entry.path
  if (typeof entry !== 'string' || !hasWildcard(entry)) return spelling
  const segments = spelling.split('/')
  const fixed = segments.slice(0, segments.findIndex(hasWildcard)).join('/')
  return fixed === '' ? '/' : fixed
}

function hasWildcard(text: string): boolean {
  return /[*?[]/.test(text)
}

/** srt's glob reading for a deny rule: `**\/` any directories, `*` and `?` within a segment. */
function globPattern(glob: string): RegExp {
  let source = ''
  for (let at = 0; at < glob.length; at += 1) {
    const char = glob.charAt(at)
    if (char === '*' && glob.charAt(at + 1) === '*') {
      const slash = glob.charAt(at + 2) === '/'
      source += slash ? '(?:.*/)?' : '.*'
      at += slash ? 2 : 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[\\^$.|+()[\]{}]/g, '\\$&')
  }
  return new RegExp(`^${source}(?:/.*)?$`)
}

/**
 * The host as the WHATWG URL parser spells it, without brackets or a trailing dot: lower case,
 * numeric IPv4 forms written out (`2130706433`, `127.1` and `0x7f.1` are all `127.0.0.1`).
 * `undefined` when it is no host at all.
 */
function normalizeHost(raw: string): string | undefined {
  const bare = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  const ipv6 = isIP(bare) === 6
  if (!ipv6 && !HOST_NAME.test(bare)) return undefined
  let hostname: string
  try {
    hostname = new URL(`http://${ipv6 ? `[${bare}]` : bare}/`).hostname
  } catch {
    return undefined
  }
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname.replace(/\.$/, '')
  return host === '' ? undefined : host
}

/**
 * A name that may get a domain button: no IP literal, no `localhost` or `*.localhost` (读法 18),
 * and one srt's schema takes, or every later restricted wrap of the session would be refused.
 */
function isDomainName(host: string): boolean {
  return (
    isIP(host) === 0 &&
    host !== 'localhost' &&
    !host.endsWith('.localhost') &&
    DOMAIN_NAME.test(host)
  )
}
