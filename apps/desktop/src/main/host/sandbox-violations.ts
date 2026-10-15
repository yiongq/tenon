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
 *    the spec already accepts for a name with parentheses (plan Open 2026-10-15「进程名以 deny
 *    开头的 Seatbelt 行」). Nor is one holding a control character (srt cuts the log at newlines
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
 * A host outside it gets no target, past the spec table's "the host name, normalized" (plan Open
 * 2026-10-15「HOST_NAME 外的主机名不给 target」).
 */
const HOST_NAME = /^[A-Za-z0-9._-]+$/
/**
 * A plain domain srt's config schema takes as an allowedDomains entry: at least one dot, neither
 * first nor last (srt79 sandbox-config.js:20-56); Tenon also refuses an empty label. Past the spec
 * table's "a domain, not localhost" (plan Open 2026-10-15「域名按钮只给 srt schema 收的名字」).
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
 * means the line is dropped on arrival: a Linux observer report of a write the wrap may make, or
 * of a `mkdirat` on a directory that is already there (读法 11, 53).
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
  // That call did nothing: GNU `mkdir -p` reports every ancestor that already exists (读法 53).
  if (syscall === 'mkdirat') {
    const kind = lookUp(context.lstat, path)
    if (kind !== 'unknown' && kind?.isDirectory() === true) return undefined
  }
  const spot = posix.normalize(path)
  const denied = context.denyWrite.some((entry) => covers(entry, spot, AS_BYTES))
  // srt's observer list is the empty one from initialize; this wrap's lists decide (读法 11). The
  // path is as the process spelled it (links not resolved, linux-violation-monitor.js:62) and
  // allowWrite holds real paths, so a write through a workspace link that leads out is dropped
  // here though bwrap refused it: a spec gap (plan Open 2026-10-15「Linux 观测器经链接的写」).
  if (!denied && context.allowWrite.some((entry) => covers(entry, spot, AS_BYTES))) return undefined
  return denied
    ? { kind: 'fs', line, target: path, protected: true, observed: true }
    : { kind: 'fs', line, target: path, observed: true }
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
 * An existing link is refused too, past 读法 35's "not an existing directory": allowWrite gets
 * real paths only, so a link to a directory (`/tmp`, `~/bin`; srt's store drops `<>`, so
 * `touch '/tmp<'` names it) would give its target's whole subtree (plan Open 2026-10-15「已存在的
 * 链接不给仅此路径」).
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
