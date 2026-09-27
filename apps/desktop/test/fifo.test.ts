/**
 * A named pipe (FIFO) on the real disk (s22 plat-3). open(2) on a FIFO blocks until the other end is
 * opened, inside libuv's threadpool where no stop reaches it, so a file tool that opened one the plain
 * way never returned — and spec 02 §参数校验与失败「执行期失败」 has every call that ran end as a
 * result. DesktopFs reads and writes regular files only; Write, Edit and Read answer a FIFO as is_error
 * / `completed`, and Grep's walk skips it. The path is stat'ed before anything opens it, so a peer
 * waiting on the pipe keeps waiting; the handle's fstat still refuses what is swapped in after that
 * stat, which `node:fs/promises`' stat, wrapped below, can do on demand. Each case is bounded by
 * `promptly`, and `afterEach` opens both ends of the pipe so that a regressed build fails the case
 * instead of wedging the worker.
 */
import { execFileSync, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
import type { AbsolutePath } from '@tenon-app/kernel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editExecutor } from '../../../packages/kernel/src/tools/builtin/edit.js'
import { grepExecutor } from '../../../packages/kernel/src/tools/builtin/grep.js'
import { BUILTIN_TOOLS } from '../../../packages/kernel/src/tools/builtin/index.js'
import { readExecutor } from '../../../packages/kernel/src/tools/builtin/read.js'
import { writeExecutor } from '../../../packages/kernel/src/tools/builtin/write.js'
import type { ToolExecution, ToolExecutor } from '../../../packages/kernel/src/tools/executor.js'
import { BUILTIN_SERVER_ID } from '../../../packages/kernel/src/tools/registry.js'
import { DesktopFs } from '../src/main/host/fs.js'

/** What runs right after the next stat of `path` returns: the file swapped between stat and open. */
const gap = vi.hoisted(() => ({ path: '', swap: null as (() => Promise<void>) | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>()
  return {
    ...real,
    async stat(...args: Parameters<typeof real.stat>) {
      const stats = await real.stat(...args)
      const swap = gap.swap
      if (swap !== null && args[0] === gap.path) {
        gap.swap = null
        await swap()
      }
      return stats
    },
  }
})

/** Well past an open that fails at once, well inside vitest's own 5 s. */
const PROMPTLY_MS = 2000

/** How long a peer on the pipe must stay waiting to count as not let go. */
const STILL_WAITING_MS = 300

/** The promise's value, or a rejection naming the call once it has been pending for too long. */
function promptly<T>(what: string, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} still pending after ${String(PROMPTLY_MS)} ms`))
    }, PROMPTLY_MS)
  })
  return Promise.race([pending, late]).finally(() => clearTimeout(timer))
}

/**
 * A shell that says it is ready and then runs `script`, which blocks on the pipe: `stillWaiting`
 * throws if it has ended within `STILL_WAITING_MS`.
 */
function peer(script: string) {
  const child = spawn('/bin/sh', ['-c', `echo ready >&2; ${script}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8')
  })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  const ready = new Promise<void>((resolve) => child.stderr.once('data', () => resolve()))
    // A moment more for the shell to get from its echo into the open(2) of the pipe.
    .then(() => new Promise((resolve) => setTimeout(resolve, 100)))
  return {
    child,
    ready,
    exited,
    stdout: () => out,
    async stillWaiting(): Promise<void> {
      const ended = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), STILL_WAITING_MS)),
      ])
      if (ended) throw new Error(`the peer was let go: ${JSON.stringify(out)}`)
    },
  }
}

/** A result's text blocks, joined. */
function textOf(result: ToolExecution): string {
  return result.content.map((block) => ('text' in block ? block.text : '')).join('\n')
}

describe.runIf(process.platform !== 'win32')(
  'a named pipe on the desktop disk (s22 plat-3)',
  () => {
    const fs = new DesktopFs()
    let root = ''
    let pipe: AbsolutePath
    const at = (relative: string): AbsolutePath => absolutePath(join(root, 'ws', relative))

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'tenon-fifo-')))
      await mkdir(join(root, 'ws'))
      pipe = at('pipe')
      execFileSync('mkfifo', [pipe])
    })
    afterEach(async () => {
      gap.swap = null
      // Both ends at once: whatever still waits on the pipe (only a regressed build) is let go.
      const both = await open(pipe, constants.O_RDWR | constants.O_NONBLOCK)
      await new Promise((resolve) => setTimeout(resolve, 50))
      await both.close()
      await rm(root, { recursive: true, force: true })
    })

    function run(
      executor: ToolExecutor,
      name: 'Read' | 'Write' | 'Edit' | 'Grep',
      input: Record<string, unknown>,
      target: AbsolutePath,
    ): Promise<ToolExecution> {
      return executor({
        item: {
          source: 'builtin',
          serverId: BUILTIN_SERVER_ID,
          originalName: name,
          name,
          spec: BUILTIN_TOOLS[name].spec({ domainFilter: false }),
          requiresUserInteraction: false,
        },
        input,
        signal: new AbortController().signal,
        target,
        scope: {
          roots: [absolutePath(join(root, 'ws'))],
          profileDir: absolutePath(join(root, 'prof')),
          ownSpillDir: absolutePath(join(root, 'prof', 'tool-output', 's1')),
          protectedFiles: [],
        },
        fs,
      })
    }

    it('DesktopFs refuses the pipe at once, with no one on the other end', async () => {
      await expect(promptly('writeFile', fs.writeFile(pipe, 'x'))).rejects.toThrow(
        'not a regular file',
      )
      await expect(promptly('readFile', fs.readFile(pipe))).rejects.toThrow(
        'is a named pipe, not a regular file',
      )
      await expect(
        promptly('readFile utf8', fs.readFile(pipe, { encoding: 'utf8' })),
      ).rejects.toThrow('is a named pipe, not a regular file')
      expect((await lstat(pipe)).isFIFO()).toBe(true)
    })

    it('DesktopFs refuses the pipe at once while another process holds it open', async () => {
      // Held for reading and writing: open(2) would no longer block, so the check has to stop the
      // read from waiting for data that never comes and the write from landing in the pipe.
      const held = await open(pipe, constants.O_RDWR | constants.O_NONBLOCK)
      try {
        await expect(promptly('readFile', fs.readFile(pipe))).rejects.toThrow(
          'is a named pipe, not a regular file',
        )
        await expect(promptly('writeFile', fs.writeFile(pipe, 'x'))).rejects.toThrow(
          'is a named pipe, not a regular file',
        )
        // Nothing was written into it.
        await expect(held.read(Buffer.alloc(8), 0, 8, null)).rejects.toMatchObject({
          code: 'EAGAIN',
        })
      } finally {
        await held.close()
      }
    })

    it('DesktopFs leaves a writer waiting on the pipe for its real reader', async () => {
      const writer = peer(`printf 'payload\\n' > '${pipe}'`)
      try {
        await writer.ready
        await expect(promptly('readFile', fs.readFile(pipe))).rejects.toThrow(
          'is a named pipe, not a regular file',
        )
        await writer.stillWaiting()
        await expect(promptly('the real reader', readFile(pipe, 'utf8'))).resolves.toBe('payload\n')
        await expect(promptly('the writer', writer.exited)).resolves.toBe(0)
      } finally {
        writer.child.kill('SIGKILL')
      }
    })

    it('DesktopFs leaves a reader waiting on the pipe for its real writer', async () => {
      const reader = peer(`cat '${pipe}'`)
      try {
        await reader.ready
        await expect(promptly('writeFile', fs.writeFile(pipe, 'x'))).rejects.toThrow(
          'is a named pipe, not a regular file',
        )
        await reader.stillWaiting()
        await promptly('the real writer', writeFile(pipe, 'payload\n'))
        await expect(promptly('the reader', reader.exited)).resolves.toBe(0)
        expect(reader.stdout()).toBe('payload\n')
      } finally {
        reader.child.kill('SIGKILL')
      }
    })

    it('DesktopFs refuses a device, reading and writing', async () => {
      // /dev/null answers a read with nothing and swallows a write, so a regressed build fails here
      // at once instead of reading /dev/zero without end.
      const device = absolutePath('/dev/null')
      await expect(promptly('readFile', fs.readFile(device))).rejects.toThrow(
        'is a device, not a regular file',
      )
      await expect(promptly('writeFile', fs.writeFile(device, 'x'))).rejects.toThrow(
        'is a device, not a regular file',
      )
      // Refused by the path's stat, before any open: a regular file swapped in after it is never
      // reached, and the handle's fstat is not what said no.
      const link = at('null')
      for (const call of ['readFile', 'writeFile'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await symlink('/dev/null', link)
        gap.path = link
        gap.swap = async () => {
          await rm(link)
          await writeFile(link, 'regular when opened\n')
        }
        const pending: Promise<unknown> =
          call === 'readFile' ? fs.readFile(link) : fs.writeFile(link, 'x')
        // oxlint-disable-next-line no-await-in-loop
        await expect(promptly(call, pending)).rejects.toThrow('is a device, not a regular file')
        // oxlint-disable-next-line no-await-in-loop
        expect(await readFile(link, 'utf8')).toBe('regular when opened\n')
        // oxlint-disable-next-line no-await-in-loop
        await rm(link)
      }
    })

    it('DesktopFs refuses what is swapped in between its stat and its open', async () => {
      const file = at('swapped')
      const swapTo = async (to: 'device' | 'pipe'): Promise<void> => {
        await rm(file, { force: true })
        await writeFile(file, 'regular when stat looks\n')
        gap.path = file
        gap.swap = async () => {
          await rm(file)
          if (to === 'device') await symlink('/dev/null', file)
          else execFileSync('mkfifo', [file])
        }
      }
      await swapTo('device')
      await expect(promptly('readFile', fs.readFile(file))).rejects.toThrow(
        'is a device, not a regular file',
      )
      await swapTo('device')
      await expect(promptly('writeFile', fs.writeFile(file, 'x'))).rejects.toThrow(
        'is a device, not a regular file',
      )
      await swapTo('pipe')
      await expect(promptly('readFile', fs.readFile(file))).rejects.toThrow(
        'is a named pipe, not a regular file',
      )
      // No one reads the pipe: the non-blocking open fails before there is a handle to look at.
      await swapTo('pipe')
      await expect(promptly('writeFile', fs.writeFile(file, 'x'))).rejects.toThrow(
        'is a named pipe or another special file, not a regular file',
      )
      expect(gap.swap).toBeNull()
    })

    it('DesktopFs still reads and writes a regular file, a second write replacing the whole content', async () => {
      const file = at('notes.txt')
      await fs.writeFile(file, 'a much longer first version\n')
      await fs.writeFile(file, 'b')
      expect(await fs.readFile(file, { encoding: 'utf8' })).toBe('b')
      expect(await fs.readFile(file)).toEqual(new Uint8Array([0x62]))
      expect(await readFile(file, 'utf8')).toBe('b')
      await fs.writeFile(file, new Uint8Array([0x63, 0x64]))
      expect(await readFile(file, 'utf8')).toBe('cd')
      // Made with the mode node's own writeFile gives a new file (0o666 less the umask).
      await writeFile(at('reference.txt'), '')
      expect((await stat(file)).mode).toBe((await stat(at('reference.txt'))).mode)
    })

    it('Write on the pipe is is_error / completed, promptly', async () => {
      const result = await promptly(
        'Write',
        run(writeExecutor, 'Write', { file_path: pipe, content: 'x' }, pipe),
      )
      expect(result).toMatchObject({ isError: true, state: 'completed' })
      expect(textOf(result)).toContain(`Writing ${pipe} failed:`)
      expect(textOf(result)).toContain('not a regular file')
      expect((await lstat(pipe)).isFIFO()).toBe(true)
    })

    it('Edit on the pipe is is_error / completed, promptly', async () => {
      const input = { file_path: pipe, old_string: 'a', new_string: 'b' }
      const result = await promptly('Edit', run(editExecutor, 'Edit', input, pipe))
      expect(result).toMatchObject({ isError: true, state: 'completed' })
      expect(textOf(result)).toContain(`Reading ${pipe} failed:`)
      expect(textOf(result)).toContain('is a named pipe, not a regular file')
    })

    it('Read on the pipe is is_error / completed, promptly', async () => {
      const result = await promptly('Read', run(readExecutor, 'Read', { file_path: pipe }, pipe))
      expect(result).toMatchObject({ isError: true, state: 'completed' })
      expect(textOf(result)).toContain(`Reading ${pipe} failed:`)
      expect(textOf(result)).toContain('is a named pipe, not a regular file')
    })

    it('Grep over a folder holding the pipe skips it and searches the files on either side', async () => {
      // Sorted walk: a.txt, then the pipe, then z.txt.
      await writeFile(at('a.txt'), 'needle\n')
      await writeFile(at('z.txt'), 'another needle\n')
      const folder = absolutePath(join(root, 'ws'))
      const result = await promptly(
        'Grep',
        run(grepExecutor, 'Grep', { pattern: 'needle' }, folder),
      )
      expect(result).toMatchObject({ isError: false, state: 'completed' })
      expect(textOf(result)).toContain(at('a.txt'))
      expect(textOf(result)).toContain(at('z.txt'))
      expect(textOf(result)).not.toContain(pipe)
    })
  },
)
