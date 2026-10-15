/**
 * HostProcess for the Electron main process.
 *
 * Decisions proven by spikes (see plan.md, 2026-09-17):
 * - `detached: true` on POSIX makes the child a process-group leader, so the whole
 *   tree dies with `process.kill(-pid, sig)`. win32 uses `taskkill /T /F`.
 * - `exited` resolves on 'exit', never 'close': 'close' waits for every stdio stream
 *   to drain and never fires while an orphaned grandchild holds the pipe.
 * - `kill()` delivers the signal and resolves; escalation (SIGTERM → grace → SIGKILL)
 *   is the kernel's job through HostClock. Past `exited` it still reaches the group while
 *   the group has members — a stop's SIGKILL is unconditional because the leader's exit
 *   says nothing of its children (spec 02 §点停止时各状态怎么收「执行命令」) — and sends
 *   nothing to the group once it was found empty (darwin still reaches the descendants an earlier
 *   signal collected, see `killTree`).
 * - `exited` never rejects. `spawn()` rejects instead: a relative argv[0] never
 *   spawns, and a failed exec (ENOENT) surfaces as the rejection.
 * - `stream.Readable.toWeb()` is NOT used for stdout/stderr: it throws inside an
 *   event handler when a consumer cancels mid-flight and takes the main process down.
 */
import { execFile, spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { Writable } from 'node:stream'
import type { Readable } from 'node:stream'
import type { ChildHandle, HostProcess, SpawnSpec } from '@tenon-app/kernel'

/** Thrown before anything is spawned when the spec is malformed. */
export class SpawnSpecError extends Error {
  override name = 'SpawnSpecError'
}

const IS_WINDOWS = process.platform === 'win32'
const IS_DARWIN = process.platform === 'darwin'
const READ_HIGH_WATER_MARK = 64 * 1024
/**
 * How long `killTree` waits for `ps` before it signals the group alone (darwin). `ps` runs before
 * each signal and the stop's budget is 1 s for both (04 不变量 13); it takes ~20 ms (macOS 26.3).
 */
const PS_TIMEOUT_MS = 200

/** A line for the host's log: `killTree` reports a `ps` that failed or timed out (darwin). */
export type ProcessLog = (line: string) => void

export function createHostProcess(log?: ProcessLog): HostProcess {
  return { spawn: (spec, signal) => spawnChild(spec, signal, log) }
}

export async function spawnChild(
  spec: SpawnSpec,
  signal?: AbortSignal,
  log?: ProcessLog,
): Promise<ChildHandle> {
  const [exe, ...args] = spec.argv
  if (exe === undefined || exe.length === 0) {
    throw new SpawnSpecError('SpawnSpec.argv is empty; argv[0] must be the executable')
  }
  if (!isAbsolute(exe)) {
    throw new SpawnSpecError(
      `SpawnSpec.argv[0] must be an absolute path, got ${JSON.stringify(exe)}`,
    )
  }
  if (!isAbsolute(spec.cwd)) {
    throw new SpawnSpecError(
      `SpawnSpec.cwd must be an absolute path, got ${JSON.stringify(spec.cwd)}`,
    )
  }
  signal?.throwIfAborted()

  const child = nodeSpawn(exe, args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio === 'pipe' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
    detached: !IS_WINDOWS,
    windowsHide: true,
    shell: false,
  })

  // Race 'spawn' against 'error'. The 'error' listener is permanent so a post-spawn
  // error (EPIPE from kill, for instance) is never an uncaught exception.
  let settled = false
  await new Promise<void>((resolve, reject) => {
    child.on('error', (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      resolve()
    })
  })

  const pid = child.pid
  if (pid === undefined) throw new Error('child spawned without a pid')

  let hasExited = false
  // Whether the group outlived its leader: members a stop's SIGKILL must still reach (spec 02
  // §点停止时各状态怎么收「执行命令」). Read at the exit and after each signal sent past it.
  let groupLeft = false
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, sig) => {
      hasExited = true
      groupLeft = groupAlive(pid)
      resolve({ code, signal: sig })
    })
  })

  // darwin: the descendants an earlier signal reached, kept for the next one (see killTree).
  const collected: CollectedTree = new Map()
  const deliver = async (sig: 'SIGTERM' | 'SIGKILL'): Promise<void> => {
    // Once reaped, -pid names this group only while the group has members (POSIX reuses no pid that
    // is a live group's id); a group found empty may be someone else's by the next signal.
    const group = (): boolean => !hasExited || groupLeft
    if (!group() && collected.size === 0) return
    await killTree(pid, sig, { group, collected, log })
    // Once found empty it stays empty: a reused pid may start a group of the same id.
    if (hasExited && groupLeft) groupLeft = groupAlive(pid)
  }

  if (signal) {
    const onAbort = (): void => {
      void deliver('SIGTERM').catch(() => {})
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void exited.finally(() => signal.removeEventListener('abort', onAbort))
  }

  const streams =
    spec.stdio === 'pipe'
      ? pipeStreams(child)
      : { stdin: nullSink(), stdout: closedSource(), stderr: closedSource() }

  return {
    pid,
    stdin: streams.stdin,
    stdout: streams.stdout,
    stderr: streams.stderr,
    exited,
    kill: (sig: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') => deliver(sig),
  }
}

function pipeStreams(child: ChildProcess): Pick<ChildHandle, 'stdin' | 'stdout' | 'stderr'> {
  const cin = child.stdin
  const cout = child.stdout
  const cerr = child.stderr
  if (!cin || !cout || !cerr) throw new Error('stdio: "pipe" did not produce all three streams')
  // EPIPE on a child that exits while we still hold stdin must not become an uncaught 'error'.
  cin.on('error', () => {})
  // Caller contract: Node errors this WritableStream with an AbortError on every normal
  // child exit; whoever holds a writer must `void writer.closed.catch(() => {})`.
  return {
    stdin: Writable.toWeb(cin) as WritableStream<Uint8Array>,
    stdout: readableToWeb(cout),
    stderr: readableToWeb(cerr),
  }
}

/** Node Readable → web ReadableStream<Uint8Array>, cancel-safe (see file header). */
export function readableToWeb(r: Readable): ReadableStream<Uint8Array> {
  let done = false
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const finish = (err?: Error): void => {
    if (done) return
    done = true
    if (err) controller?.error(err)
    else controller?.close()
  }
  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c
        // A stream that already finished never emits 'end'/'close' again.
        if (r.destroyed || r.readableEnded) {
          finish(r.errored instanceof Error ? r.errored : undefined)
          return
        }
        r.pause()
        r.on('data', (chunk: Buffer) => {
          if (done) return
          controller?.enqueue(new Uint8Array(chunk))
          if ((controller?.desiredSize ?? 0) <= 0) r.pause()
        })
        r.on('end', () => finish())
        r.on('close', () => finish())
        r.on('error', (e: Error) => finish(e))
      },
      pull() {
        if (done) return
        r.resume()
      },
      cancel(reason) {
        done = true
        r.destroy(reason instanceof Error ? reason : undefined)
      },
    },
    new ByteLengthQueuingStrategy({
      highWaterMark: r.readableHighWaterMark || READ_HIGH_WATER_MARK,
    }),
  )
}

function closedSource(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
}

function nullSink(): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write() {
      /* /dev/null */
    },
  })
}

/**
 * Whether process group `pgid` has a member left, zombies included; never on win32, where taskkill
 * walks the tree from a pid that must still be running.
 */
function groupAlive(pgid: number): boolean {
  if (IS_WINDOWS) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** darwin: each descendant a signal reached, by pid, with the start time `ps` gave it. */
export type CollectedTree = Map<number, string>

/**
 * Kill the process tree rooted at `pid`. ESRCH (already gone) is not an error.
 *
 * On darwin a descendant that called `setsid()` has left the group, and a sandboxed command's does
 * not die with the shell (spec 04 §执行与收口, P6): the whole tree is collected from `/bin/ps` before
 * the signal, which goes to the group and then to each descendant. A stop signals twice (SIGTERM,
 * then SIGKILL): by the second the shell may be gone and a setsid one that ignored SIGTERM adopted by
 * launchd, out of the group and off the tree, so `collected` keeps what each call reached and the
 * next call signals those again — and walks the tree from them too — when `ps` still shows the same
 * pid with the same start time (never a reused pid). `group` false means the group was found empty
 * (the leader reaped, so `pid` and `-pid` may be someone else's): the tree is walked from
 * `pid` only when `group` holds both before and after `ps`, and `-pid` is signalled only when it
 * holds after. When `ps` fails or takes over 200 ms, the signal goes to the group alone and one
 * line goes to `log`. Linux needs none of it (bwrap's `--die-with-parent` and pid namespace take the
 * tree down).
 */
export async function killTree(
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL',
  q: {
    readonly group?: () => boolean
    readonly collected?: CollectedTree
    readonly log?: ProcessLog | undefined
  } = {},
): Promise<void> {
  if (IS_WINDOWS) {
    await killTreeWindows(pid)
    return
  }
  const ours = (): boolean => q.group?.() !== false
  const rooted = ours()
  const tree = IS_DARWIN
    ? await collectTree(pid, q.collected ?? new Map(), () => rooted && ours(), q.log)
    : []
  if (ours()) {
    try {
      process.kill(-pid, signal)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM') throw err
      if (code !== 'ESRCH') {
        try {
          process.kill(pid, signal)
        } catch {
          /* ignore */
        }
      }
    }
  }
  for (const member of tree) {
    try {
      process.kill(member, signal)
    } catch {
      /* gone already */
    }
  }
}

/**
 * The descendants of `pid` (only when `fromRoot()`, asked once `ps` returned) and of every
 * still-living member of `collected` in `/bin/ps -A -o pid=,ppid=,lstart=` (P6), deepest last;
 * `collected` is brought up to date (the dead and the reused dropped, the new added). Empty when
 * `ps` fails or times out, which leaves the group signal alone and says so in `log`. A
 * host-internal helper, like taskkill.
 */
async function collectTree(
  pid: number,
  collected: CollectedTree,
  fromRoot: () => boolean,
  log: ProcessLog | undefined,
): Promise<number[]> {
  let table: string
  try {
    table = await new Promise<string>((resolve, reject) => {
      execFile(
        '/bin/ps',
        ['-A', '-o', 'pid=,ppid=,lstart='],
        { timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
      )
    })
  } catch (error) {
    const timedOut = (error as { killed?: boolean }).killed === true
    const why = timedOut
      ? `took over ${String(PS_TIMEOUT_MS)} ms`
      : `failed: ${error instanceof Error ? error.message : String(error)}`
    log?.(`killTree: /bin/ps ${why}; no process outside the group is signalled`)
    return []
  }
  const children = new Map<number, number[]>()
  const started = new Map<number, string>()
  for (const row of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(row)
    if (match === null) continue
    const child = Number(match[1])
    const parent = Number(match[2])
    started.set(child, match[3] ?? '')
    children.set(parent, [...(children.get(parent) ?? []), child])
  }
  for (const [member, start] of collected) {
    if (started.get(member) !== start) collected.delete(member)
  }
  const found: number[] = [...collected.keys()]
  const queue = fromRoot() ? [pid, ...found] : [...found]
  for (let at = 0; at < queue.length; at += 1) {
    for (const child of children.get(queue[at] ?? -1) ?? []) {
      if (child === pid || found.includes(child)) continue
      found.push(child)
      queue.push(child)
      collected.set(child, started.get(child) ?? '')
    }
  }
  return found
}

function killTreeWindows(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const taskkill = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\taskkill.exe`
    const p = nodeSpawn(taskkill, ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    p.on('error', () => resolve())
    p.on('exit', () => resolve())
  })
}
