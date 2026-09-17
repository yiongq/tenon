/**
 * Test-only HostProcess backed by node:child_process. Lives outside src/ on purpose:
 * the kernel itself never spawns. Mirrors the desktop host's stream handling so the
 * transport is exercised against real pipes.
 */
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { Writable } from 'node:stream'
import type { Readable } from 'node:stream'
import type { ChildHandle, HostProcess, SpawnSpec } from '../../src/index.js'

export function createNodeProcess(): HostProcess {
  return {
    async spawn(spec: SpawnSpec, signal?: AbortSignal): Promise<ChildHandle> {
      const [exe, ...args] = spec.argv
      if (exe === undefined || !isAbsolute(exe)) {
        throw new TypeError(`argv[0] must be an absolute path, got ${JSON.stringify(exe)}`)
      }
      signal?.throwIfAborted()
      const child = spawn(exe, args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: spec.stdio === 'pipe' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
        detached: process.platform !== 'win32',
      })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      child.on('error', () => {})
      let hasExited = false
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.once('exit', (code, sig) => {
          hasExited = true
          resolve({ code, signal: sig })
        })
      })
      const kill = async (sig: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> => {
        if (hasExited || child.pid === undefined) return
        try {
          process.kill(process.platform === 'win32' ? child.pid : -child.pid, sig)
        } catch {
          /* already gone */
        }
      }
      signal?.addEventListener('abort', () => void kill('SIGTERM'), { once: true })
      child.stdin?.on('error', () => {})
      return {
        pid: child.pid ?? -1,
        stdin: child.stdin
          ? (Writable.toWeb(child.stdin) as WritableStream<Uint8Array>)
          : new WritableStream(),
        stdout: child.stdout ? readableToWeb(child.stdout) : closedSource(),
        stderr: child.stderr ? readableToWeb(child.stderr) : closedSource(),
        exited,
        kill,
      }
    },
  }
}

function readableToWeb(r: Readable): ReadableStream<Uint8Array> {
  let done = false
  let controller: ReadableStreamDefaultController<Uint8Array>
  const finish = (err?: Error): void => {
    if (done) return
    done = true
    if (err) controller.error(err)
    else controller.close()
  }
  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      r.pause()
      r.on('data', (chunk: Buffer) => {
        if (done) return
        controller.enqueue(new Uint8Array(chunk))
        if ((controller.desiredSize ?? 0) <= 0) r.pause()
      })
      r.on('end', () => finish())
      r.on('close', () => finish())
      r.on('error', (e: Error) => finish(e))
    },
    pull() {
      r.resume()
    },
    cancel(reason) {
      done = true
      r.destroy(reason instanceof Error ? reason : undefined)
    },
  })
}

function closedSource(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
}
