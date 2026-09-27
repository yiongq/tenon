/**
 * The Bash executor (spec 02 §内置工具与参数「Bash」「输出」「超时」, §点停止时各状态怎么收「执行命令」;
 * plan step 22). Against a real `/bin/sh` through the test HostProcess: stderr joins stdout at the fd
 * level, a non-zero exit heads the output, an empty one is `(no output)`, and a process left in the
 * background holding the pipe does not hold the call past `STOP_EXIT_CONFIRM_MS`. Against a fake
 * ChildHandle on the memory host's clock: what is spawned, and the basic stop while it runs (the basic
 * timeout is test/loop/write-bash.test.ts's; plan step 23 calibrates the constants and tests the rest
 * of the kill sequence).
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { absolutePath, createMemoryHost } from '../../src/index.js'
import type {
  AbsolutePath,
  ChildHandle,
  HostClock,
  HostProcess,
  HostSandbox,
  SandboxRequest,
  SpawnSpec,
} from '../../src/index.js'
import { STOP_EXIT_CONFIRM_MS, STOP_TERM_GRACE_MS } from '../../src/loop/limits.js'
import { BASH_TEXTS, bashExecutor } from '../../src/tools/builtin/bash.js'
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.js'
import type { ToolExecution } from '../../src/tools/executor.js'
import { BUILTIN_SERVER_ID } from '../../src/tools/registry.js'
import { createNodeProcess } from '../support/node-process.js'

const SH = absolutePath('/bin/sh')
const HERE = absolutePath(realpathSync(tmpdir()))

const realClock: HostClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}

/** A pass-through sandbox that records what it was asked to wrap and which commands exited. */
function recordingSandbox(): HostSandbox & {
  readonly wrapped: SandboxRequest[]
  readonly exited: string[]
} {
  const wrapped: SandboxRequest[] = []
  const exited: string[] = []
  return {
    wrapped,
    exited,
    wrap: (request) => {
      wrapped.push(request)
      return Promise.resolve({ argv: [...request.argv], env: { ...request.env } })
    },
    afterExit: (commandId) => {
      exited.push(commandId)
      return Promise.resolve()
    },
    violations: () => Promise.resolve([]),
  }
}

interface Bash {
  readonly input: Record<string, unknown>
  readonly process: HostProcess
  readonly clock: HostClock
  readonly sandbox?: HostSandbox
  readonly signal?: AbortSignal
  readonly env?: Readonly<Record<string, string>>
  readonly folders?: readonly AbsolutePath[]
  readonly shell?: AbsolutePath
}

function bash(b: Bash): Promise<ToolExecution> {
  const host = createMemoryHost()
  return bashExecutor({
    item: {
      source: 'builtin',
      serverId: BUILTIN_SERVER_ID,
      originalName: 'Bash',
      name: 'Bash',
      spec: BUILTIN_TOOLS.Bash.spec({ domainFilter: false }),
      requiresUserInteraction: false,
    },
    input: b.input,
    signal: b.signal ?? new AbortController().signal,
    target: null,
    scope: {
      roots: [...(b.folders ?? [HERE])],
      profileDir: absolutePath('/tenon/prof'),
      ownSpillDir: absolutePath('/tenon/prof/tool-output/s1'),
      protectedFiles: [],
    },
    fs: host.fs,
    command: {
      commandId: 'toolu_1',
      shell: b.shell ?? SH,
      env: b.env ?? { PATH: '/usr/bin:/bin' },
      folders: b.folders ?? [HERE],
      dedicated: false,
      host: { process: b.process, sandbox: b.sandbox ?? recordingSandbox(), clock: b.clock },
    },
  })
}

function textOf(execution: ToolExecution): string {
  return execution.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

describe('Bash on a real /bin/sh', () => {
  const leftovers: number[] = []
  afterEach(() => {
    // A background process a case left behind: its whole group goes.
    for (const pid of leftovers.splice(0)) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  })

  it('reads stdout and stderr as one stream, in the order the shell wrote them', async () => {
    const done = await bash({
      input: { command: "printf 'a\\n'; printf 'b\\n' >&2; printf 'c\\n'" },
      process: createNodeProcess(),
      clock: realClock,
    })
    expect(done).toEqual({
      content: [{ type: 'text', text: 'a\nb\nc\n' }],
      isError: false,
      state: 'completed',
    })
  })

  it('heads a non-zero exit with `Exit code: N`, and says `(no output)` for nothing', async () => {
    const failed = await bash({
      input: { command: "printf 'nope\\n' >&2; exit 3" },
      process: createNodeProcess(),
      clock: realClock,
    })
    expect(failed).toEqual({
      content: [{ type: 'text', text: 'Exit code: 3\nnope\n' }],
      isError: true,
      state: 'completed',
    })
    const quiet = await bash({
      input: { command: 'true' },
      process: createNodeProcess(),
      clock: realClock,
    })
    expect(quiet).toEqual({
      content: [{ type: 'text', text: BASH_TEXTS.noOutput }],
      isError: false,
      state: 'completed',
    })
    expect(BASH_TEXTS.noOutput).toBe('(no output)')
  })

  it('decodes the output as UTF-8, bad bytes as U+FFFD', async () => {
    const done = await bash({
      input: { command: "printf '\\377ok \\344\\270\\255\\n'" },
      process: createNodeProcess(),
      clock: realClock,
    })
    expect(textOf(done)).toBe('�ok 中\n')
  })

  it('returns within STOP_EXIT_CONFIRM_MS of the exit while `sleep 30 &` holds the pipe', async () => {
    const node = createNodeProcess()
    let exitedAt = 0
    const watching: HostProcess = {
      spawn: async (spec, signal) => {
        const child = await node.spawn(spec, signal)
        leftovers.push(child.pid)
        void child.exited.then(() => {
          exitedAt = Date.now()
        })
        return child
      },
    }
    const done = await bash({
      input: { command: "sleep 30 & printf 'started\\n'" },
      process: watching,
      clock: realClock,
    })
    const returnedAt = Date.now()
    expect(done).toEqual({
      content: [{ type: 'text', text: 'started\n' }],
      isError: false,
      state: 'completed',
    })
    expect(exitedAt).toBeGreaterThan(0)
    // The window, and some room for the test host's own scheduling.
    expect(returnedAt - exitedAt).toBeLessThan(STOP_EXIT_CONFIRM_MS + 300)
  })
})

/** A child that prints what a case writes, exits when told, and dies on SIGKILL. */
function fakeChild(): {
  readonly child: ChildHandle
  readonly write: (bytes: string | Uint8Array) => void
  readonly exit: (code: number | null, signal?: string | null) => void
  readonly kills: string[]
  readonly stdinClosed: () => boolean
} {
  let out: ReadableStreamDefaultController<Uint8Array> | undefined
  const exited = Promise.withResolvers<{ code: number | null; signal: string | null }>()
  const kills: string[] = []
  let stdinClosed = false
  const exit = (code: number | null, signal: string | null = null): void => {
    out?.close()
    exited.resolve({ code, signal })
  }
  return {
    child: {
      pid: 4242,
      stdin: new WritableStream<Uint8Array>({
        close: () => {
          stdinClosed = true
        },
      }),
      stdout: new ReadableStream<Uint8Array>({
        start: (controller) => {
          out = controller
        },
      }),
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      exited: exited.promise,
      kill: (signal = 'SIGTERM') => {
        kills.push(signal)
        if (signal === 'SIGKILL') exit(null, 'SIGKILL')
        return Promise.resolve()
      },
    },
    write: (bytes) =>
      out?.enqueue(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes),
    exit,
    kills,
    stdinClosed: () => stdinClosed,
  }
}

function returning(child: ChildHandle, spawned: SpawnSpec[] = []): HostProcess {
  return {
    spawn: (spec) => {
      spawned.push(spec)
      return Promise.resolve(child)
    },
  }
}

/** Lets every promise the executor has in flight settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Bash against a fake child', () => {
  it('spawns the shell with `exec 2>&1` before the command, the given env alone, stdin closed', async () => {
    const host = createMemoryHost()
    const fake = fakeChild()
    const spawned: SpawnSpec[] = []
    const sandbox = recordingSandbox()
    const folders = [absolutePath('/work/a'), absolutePath('/work/b')]
    const env = { PATH: '/opt/bin:/usr/bin', HOME: '/Users/u' }
    const done = bash({
      input: { command: 'make test', description: 'runs the tests' },
      process: returning(fake.child, spawned),
      clock: host.clock,
      sandbox,
      env,
      folders,
      shell: absolutePath('/bin/zsh'),
    })
    await settle()
    const argv = ['/bin/zsh', '-c', 'exec 2>&1\nmake test']
    expect(spawned).toEqual([{ argv, cwd: '/work/a', env, stdio: 'pipe' }])
    expect(sandbox.wrapped).toEqual([
      {
        commandId: 'toolu_1',
        argv,
        cwd: '/work/a',
        env,
        profile: 'workspace-write',
        workspace: folders,
      },
    ])
    expect(fake.stdinClosed()).toBe(true)
    // A character split across two reads comes out whole.
    fake.write(new Uint8Array([0xe4, 0xb8]))
    fake.write(new Uint8Array([0xad, 0x0a]))
    fake.exit(2)
    expect(await done).toEqual({
      content: [{ type: 'text', text: 'Exit code: 2\n中\n' }],
      isError: true,
      state: 'completed',
    })
    expect(sandbox.exited).toEqual(['toolu_1'])
  })

  it('heads a death by a signal it did not send with `Killed by signal: SIGxxx`', async () => {
    const host = createMemoryHost()
    const fake = fakeChild()
    const done = bash({
      input: { command: './crash' },
      process: returning(fake.child),
      clock: host.clock,
    })
    await settle()
    fake.exit(null, 'SIGSEGV')
    expect(await done).toEqual({
      content: [{ type: 'text', text: 'Killed by signal: SIGSEGV\n(no output)' }],
      isError: true,
      state: 'completed',
    })
    expect(fake.kills).toEqual([])
  })

  it('on a stop while it runs sends the same sequence and records aborted with its output', async () => {
    const host = createMemoryHost()
    const fake = fakeChild()
    const stop = new AbortController()
    const done = bash({
      input: { command: 'make' },
      process: returning(fake.child),
      clock: host.clock,
      signal: stop.signal,
    })
    await settle()
    fake.write('half')
    await settle()
    stop.abort('user-stop')
    await settle()
    expect(fake.kills).toEqual(['SIGTERM'])
    host.advance(STOP_TERM_GRACE_MS)
    await settle()
    expect(fake.kills).toEqual(['SIGTERM', 'SIGKILL'])
    const stopped = await done
    expect(stopped).toEqual({
      content: [{ type: 'text', text: 'half' }],
      isError: true,
      state: 'aborted',
    })
    expect(stopped.source).toBeUndefined()
  })
})
