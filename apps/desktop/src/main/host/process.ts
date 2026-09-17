/**
 * HostProcess for the Electron main process.
 *
 * Decisions proven by spikes (see plan.md, 2026-09-17):
 * - `detached: true` on POSIX makes the child a process-group leader, so the whole
 *   tree dies with `process.kill(-pid, sig)`. win32 uses `taskkill /T /F`.
 * - `exited` resolves on 'exit', never 'close': 'close' waits for every stdio stream
 *   to drain and never fires while an orphaned grandchild holds the pipe.
 * - `kill()` delivers the signal and resolves; escalation (SIGTERM → grace → SIGKILL)
 *   is the kernel's job through HostClock.
 * - `exited` never rejects. `spawn()` rejects instead: a relative argv[0] never
 *   spawns, and a failed exec (ENOENT) surfaces as the rejection.
 * - `stream.Readable.toWeb()` is NOT used for stdout/stderr: it throws inside an
 *   event handler when a consumer cancels mid-flight and takes the main process down.
 */
import { spawn as nodeSpawn } from 'node:child_process'
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
const READ_HIGH_WATER_MARK = 64 * 1024

export function createHostProcess(): HostProcess {
  return { spawn: spawnChild }
}

export async function spawnChild(spec: SpawnSpec, signal?: AbortSignal): Promise<ChildHandle> {
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
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, sig) => {
      hasExited = true
      resolve({ code, signal: sig })
    })
  })

  const deliver = async (sig: 'SIGTERM' | 'SIGKILL'): Promise<void> => {
    // Once reaped, -pid may name a different group.
    if (hasExited) return
    await killTree(pid, sig)
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

/** Kill the process tree rooted at `pid`. ESRCH (already gone) is not an error. */
export async function killTree(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  if (IS_WINDOWS) {
    await killTreeWindows(pid)
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return
    if (code === 'EPERM') throw err
    try {
      process.kill(pid, signal)
    } catch {
      /* ignore */
    }
  }
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
