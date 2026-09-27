/**
 * The stop and the Bash timeout on real process trees (spec 02 §点停止时各状态怎么收「执行命令」,
 * §内置工具与参数「Bash」「超时」, §上限、守卫与用量 the STOP constants; plan step 23, 旧 7, 旧 142's
 * process half, 旧 177's process-group half). The kernel's real Bash executor runs on desktop's real
 * HostProcess, sandbox and clock, and each case runs one of two fork fixtures
 * (test/support/fixtures): a direct child that dies on SIGTERM while its child ignores it, and a
 * direct child and child that both ignore it. The sequence — SIGTERM, `STOP_TERM_GRACE_MS`, SIGKILL
 * to the group unconditionally, then `exited` within `STOP_EXIT_CONFIRM_MS` — must leave no living
 * process in the command's group within §13's 1 second of the stop or the timeout, and the call is
 * written aborted only once the group is empty.
 *
 * The group is read from `ps`, the only view that shows a member nobody printed the pid of; a zombie
 * has exited and only waits for its reaper, so it is not alive. Every process of a fixture holds the
 * output pipe, so the pipe's end is the moment the last of them exited. Nothing sleeps on an outcome:
 * a loaded CI runner makes a case slower, and the bound checked is the spec's own second, of which
 * the sequence uses about half (macOS 26.3, 2026-09-27: SIGKILL 500–503 ms after the stop, the group
 * empty 1–3 ms later, `ps` seeing it empty by 512–542 ms).
 */
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { absolutePath } from '@tenon-app/kernel'
import type { AbsolutePath, ChildHandle, HostProcess } from '@tenon-app/kernel'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { closureContent } from '../../../packages/kernel/src/loop/closure.js'
import {
  STOP_EXIT_CONFIRM_MS,
  STOP_TERM_GRACE_MS,
} from '../../../packages/kernel/src/loop/limits.js'
import { MODEL_NOTES } from '../../../packages/kernel/src/prompts/index.js'
import { bashExecutor } from '../../../packages/kernel/src/tools/builtin/bash.js'
import { BUILTIN_TOOLS } from '../../../packages/kernel/src/tools/builtin/index.js'
import type { ToolExecution } from '../../../packages/kernel/src/tools/executor.js'
import { BUILTIN_SERVER_ID } from '../../../packages/kernel/src/tools/registry.js'
import { SystemClock } from '../src/main/host/clock.js'
import { DesktopFs } from '../src/main/host/fs.js'
import { createHostProcess, spawnChild } from '../src/main/host/process.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'

const execFileAsync = promisify(execFile)

/** §13's 1 second: from the stop, or from the timeout firing, to an empty process tree. */
const TREE_CLEAR_MS = 1000

/** How long a case waits for a fixture to print both markers, or for a group to empty, at most. */
const PATIENCE_MS = 5000

/** Room for a timer that fires on the millisecond it was due, rounded down. */
const TIMER_SLACK_MS = 2

/** A case's own bound: a loaded runner makes a case slower, never shorter than the spec's second. */
const CASE_TIMEOUT_MS = 20_000

const FIXTURES = fileURLToPath(new URL('./support/fixtures/', import.meta.url))
/** The direct child dies on SIGTERM; its child ignores SIGTERM and holds the pipe (旧 177). */
const LEADER_EXITS = join(FIXTURES, 'tree-leader-exits.sh')
/** The direct child and its child both ignore SIGTERM (旧 7, 旧 142). */
const TERM_IGNORED = join(FIXTURES, 'tree-term-ignored.sh')

const SH = absolutePath('/bin/sh')

const now = (): number => performance.now()

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The living members of process group `pgid`, sorted; `ps` lists the zombies too, and skips them. */
async function living(pgid: number): Promise<number[]> {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,pgid=,stat='])
  return stdout
    .split('\n')
    .flatMap((line) => {
      const [pid, group, stat] = line.trim().split(/\s+/)
      if (pid === undefined || group === undefined || stat === undefined) return []
      return Number(group) === pgid && !stat.startsWith('Z') ? [Number(pid)] : []
    })
    .toSorted((a, b) => a - b)
}

/** When `ps` first found group `pgid` with no living member; null when it had one past `deadline`. */
async function emptiedAt(pgid: number, deadline: number): Promise<number | null> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one ps at a time, each reading the group anew
    const members = await living(pgid)
    const at = now()
    if (members.length === 0) return at
    if (at > deadline) return null
    // oxlint-disable-next-line no-await-in-loop -- the poll's pace, not a wait for an outcome
    await delay(10)
  }
}

/** Resolves once `ready()` holds, polled; rejects past `PATIENCE_MS`. */
async function until(what: string, ready: () => boolean): Promise<void> {
  const deadline = now() + PATIENCE_MS
  while (!ready()) {
    if (now() > deadline) throw new Error(`${what}: not after ${String(PATIENCE_MS)} ms`)
    // oxlint-disable-next-line no-await-in-loop -- polled, not slept on
    await delay(5)
  }
}

/** One Bash call's child as the test sees it: its pid, what it printed, how and when it ended. */
interface Watched {
  readonly pid: number
  readonly spawnedAt: number
  readonly kills: { readonly signal: string; readonly at: number }[]
  exit: { readonly code: number | null; readonly signal: string | null; readonly at: number } | null
  seen: string
  /** The pipe reached its end: every process that held it has exited. */
  pipeEnded: boolean
}

/**
 * Desktop's HostProcess, unchanged but for what the test reads: the child's stdout is teed as it
 * arrives, and each `kill` the executor asks for, and the exit, are timed.
 */
function watchedProcess(): { readonly process: HostProcess; readonly child: Promise<Watched> } {
  const real = createHostProcess()
  const spawned = Promise.withResolvers<Watched>()
  const host: HostProcess = {
    spawn: async (spec, signal) => {
      const child = await real.spawn(spec, signal)
      const watched: Watched = {
        pid: child.pid,
        spawnedAt: now(),
        kills: [],
        exit: null,
        seen: '',
        pipeEnded: false,
      }
      groups.push(child.pid)
      void child.exited.then((exit) => {
        watched.exit = { ...exit, at: now() }
      })
      const decoder = new TextDecoder()
      const stdout = child.stdout.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, controller) => {
            watched.seen += decoder.decode(chunk, { stream: true })
            controller.enqueue(chunk)
          },
          flush: () => {
            watched.pipeEnded = true
          },
        }),
      )
      spawned.resolve(watched)
      const handle: ChildHandle = {
        ...child,
        stdout,
        kill: (sig = 'SIGTERM') => {
          watched.kills.push({ signal: sig, at: now() })
          return child.kill(sig)
        },
      }
      return handle
    },
  }
  return { process: host, child: spawned.promise }
}

let cwd: AbsolutePath

/** Every group a case started: one a failed case left behind is killed whole. */
const groups: number[] = []

beforeAll(async () => {
  cwd = absolutePath(await realpath(await mkdtemp(join(tmpdir(), 'tenon-stop-tree-'))))
})

afterEach(() => {
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      /* already empty */
    }
  }
})

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true })
})

/** Runs `fixture` through the kernel's Bash executor, on desktop's host, in its own shell. */
function bash(
  fixture: string,
  q: { readonly process: HostProcess; readonly signal: AbortSignal; readonly timeout?: number },
): Promise<ToolExecution> {
  return bashExecutor({
    item: {
      source: 'builtin',
      serverId: BUILTIN_SERVER_ID,
      originalName: 'Bash',
      name: 'Bash',
      spec: BUILTIN_TOOLS.Bash.spec({ domainFilter: false }),
      requiresUserInteraction: false,
    },
    // `exec`: the fixture's shell is the direct child itself, whatever `sh -c` does with its last
    // command (bash and dash exec it; the spec does not say either must).
    input: {
      command: `exec /bin/sh '${fixture}'`,
      ...(q.timeout === undefined ? {} : { timeout: q.timeout }),
    },
    signal: q.signal,
    target: null,
    scope: {
      roots: [cwd],
      profileDir: absolutePath('/tenon/prof'),
      ownSpillDir: absolutePath('/tenon/prof/tool-output/s1'),
      protectedFiles: [],
    },
    fs: new DesktopFs(),
    clock: new SystemClock(),
    command: {
      commandId: 'toolu_stop_tree',
      shell: SH,
      env: { PATH: '/usr/bin:/bin' },
      folders: [cwd],
      dedicated: false,
      host: {
        process: q.process,
        sandbox: new PassthroughSandbox(() => {}),
        clock: new SystemClock(),
      },
    },
  })
}

/** The fixture's `parent` and `child` pids, once both have printed them. */
async function markers(seen: () => string): Promise<{ parent: number; child: number }> {
  const pidOf = (role: string): number | null => {
    const found = new RegExp(`^${role} (\\d+)$`, 'm').exec(seen())
    return found?.[1] === undefined ? null : Number(found[1])
  }
  await until('both markers', () => pidOf('parent') !== null && pidOf('child') !== null)
  return { parent: pidOf('parent') ?? 0, child: pidOf('child') ?? 0 }
}

/** How the call returned, and when `ps` first found the group empty. */
interface Settled {
  readonly execution: ToolExecution
  readonly returnedAt: number
  /** At the return: whether `exited` had arrived and the pipe had ended, and who `ps` found after. */
  readonly atReturn: {
    readonly exited: boolean
    readonly pipeEnded: boolean
    readonly left: number[]
  }
  readonly emptied: number | null
}

async function settle(child: Watched, call: Promise<ToolExecution>): Promise<Settled> {
  const [returned, emptied] = await Promise.all([
    call.then(async (execution) => {
      const returnedAt = now()
      const { exit, pipeEnded } = child
      return {
        execution,
        returnedAt,
        atReturn: { exited: exit !== null, pipeEnded, left: await living(child.pid) },
      }
    }),
    emptiedAt(child.pid, now() + PATIENCE_MS),
  ])
  return { ...returned, emptied }
}

/** The result the batch writes for this execution (loop/batch.ts `execute`): the note, the output. */
function closed(execution: ToolExecution): string[] {
  const output = execution.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
  return closureContent({
    source: execution.source ?? 'stopped',
    state: execution.state,
    ...(output === '' ? {} : { detail: output }),
  }).map((block) => (block.type === 'text' ? block.text : `<${block.type}>`))
}

describe.skipIf(process.platform === 'win32')('the stop on a real process tree', () => {
  it("leaves the two STOP waits inside §13's 1 second", () => {
    expect(STOP_TERM_GRACE_MS + STOP_EXIT_CONFIRM_MS).toBeLessThanOrEqual(TREE_CLEAR_MS)
  })

  it.each([
    {
      name: 'the direct child dies on SIGTERM and its child ignores it (旧 177)',
      fixture: LEADER_EXITS,
      directChildEnds: 'SIGTERM',
    },
    {
      name: 'the direct child and its child both ignore SIGTERM (旧 7)',
      fixture: TERM_IGNORED,
      directChildEnds: 'SIGKILL',
    },
  ])(
    'empties the whole group within 1 s of the stop when $name',
    async ({ fixture, directChildEnds }) => {
      const watched = watchedProcess()
      const stop = new AbortController()
      const call = bash(fixture, { process: watched.process, signal: stop.signal })
      const child = await watched.child
      const pids = await markers(() => child.seen)
      // The tree is the fixture's two processes, in the command's own group, and nothing else.
      expect(pids.parent).toBe(child.pid)
      expect(await living(child.pid)).toEqual([pids.parent, pids.child].toSorted((a, b) => a - b))

      const stoppedAt = now()
      stop.abort()
      const { execution, returnedAt, atReturn, emptied } = await settle(child, call)

      expect(emptied).not.toBeNull()
      expect((emptied ?? Infinity) - stoppedAt).toBeLessThan(TREE_CLEAR_MS)
      // Written only once the tree is gone (旧 7): nothing of it outlives the result.
      expect(atReturn).toEqual({ exited: true, pipeEnded: true, left: [] })
      expect(returnedAt - stoppedAt).toBeLessThan(TREE_CLEAR_MS)
      // SIGTERM at once, SIGKILL a grace later whether or not the direct child is still there.
      expect(child.kills.map((kill) => kill.signal)).toEqual(['SIGTERM', 'SIGKILL'])
      const [term, kill] = child.kills
      expect((kill?.at ?? 0) - (term?.at ?? 0)).toBeGreaterThanOrEqual(
        STOP_TERM_GRACE_MS - TIMER_SLACK_MS,
      )
      expect(child.exit).toMatchObject({ code: null, signal: directChildEnds })
      // `exited` arrived inside the confirm window: aborted, with what it printed before the stop.
      expect((child.exit?.at ?? Infinity) - (kill?.at ?? 0)).toBeLessThan(STOP_EXIT_CONFIRM_MS)
      expect(execution).toEqual({
        content: [{ type: 'text', text: child.seen }],
        isError: true,
        state: 'aborted',
      })
      expect(child.seen).toContain(`parent ${String(pids.parent)}\n`)
      expect(child.seen).toContain(`child ${String(pids.child)}\n`)
      expect(closed(execution)).toEqual([MODEL_NOTES.closure.stopped.aborted, child.seen])
      expect(MODEL_NOTES.closure.stopped.aborted).toContain(
        'Changes it made before the stop are still in place.',
      )
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'empties the group within 1 s of a `timeout: 1000` firing, and records aborted / timed-out (旧 142)',
    async () => {
      const watched = watchedProcess()
      const call = bash(TERM_IGNORED, {
        process: watched.process,
        signal: new AbortController().signal,
        timeout: 1000,
      })
      const child = await watched.child
      const pids = await markers(() => child.seen)
      expect(await living(child.pid)).toEqual([pids.parent, pids.child].toSorted((a, b) => a - b))

      const { execution, atReturn, emptied } = await settle(child, call)

      // The timeout starts the sequence: SIGTERM once 1000 ms have passed since the spawn.
      expect(child.kills.map((kill) => kill.signal)).toEqual(['SIGTERM', 'SIGKILL'])
      const [term, kill] = child.kills
      const firedAt = term?.at ?? Infinity
      expect(firedAt - child.spawnedAt).toBeGreaterThanOrEqual(1000 - TIMER_SLACK_MS)
      expect((kill?.at ?? 0) - firedAt).toBeGreaterThanOrEqual(STOP_TERM_GRACE_MS - TIMER_SLACK_MS)
      expect(child.exit).toMatchObject({ code: null, signal: 'SIGKILL' })
      expect((child.exit?.at ?? Infinity) - (kill?.at ?? 0)).toBeLessThan(STOP_EXIT_CONFIRM_MS)
      expect(emptied).not.toBeNull()
      expect((emptied ?? Infinity) - firedAt).toBeLessThan(TREE_CLEAR_MS)
      expect(atReturn).toEqual({ exited: true, pipeEnded: true, left: [] })
      expect(execution).toEqual({
        content: [{ type: 'text', text: child.seen }],
        isError: true,
        state: 'aborted',
        source: 'timed-out',
      })
      expect(child.seen).toContain(`parent ${String(pids.parent)}\n`)
      expect(closed(execution)).toEqual([MODEL_NOTES.closure['timed-out'].aborted, child.seen])
      expect(MODEL_NOTES.closure['timed-out'].aborted).toContain(
        'Changes it made are still in place.',
      )
    },
    CASE_TIMEOUT_MS,
  )
})

/**
 * desktop's `kill` after the direct child was reaped (process.ts): `exited` says nothing of the
 * group, so a signal still reaches the members the group has left; once the group is found empty,
 * `-pid` may name someone else's group later and nothing more is sent.
 */
describe.skipIf(process.platform === 'win32')("desktop's kill once the direct child exited", () => {
  it(
    'still reaches the child that outlived it in its group',
    async () => {
      const child = await spawnChild({
        argv: [SH, LEADER_EXITS],
        cwd,
        env: { PATH: '/usr/bin:/bin' },
        stdio: 'pipe',
      })
      groups.push(child.pid)
      let seen = ''
      const decoder = new TextDecoder()
      void child.stdout.pipeTo(
        new WritableStream({
          write: (chunk) => {
            seen += decoder.decode(chunk, { stream: true })
          },
        }),
      )
      const pids = await markers(() => seen)
      await child.kill('SIGTERM')
      expect(await child.exited).toEqual({ code: null, signal: 'SIGTERM' })
      expect(await living(child.pid)).toEqual([pids.child])
      await child.kill('SIGKILL')
      expect(await emptiedAt(child.pid, now() + PATIENCE_MS)).not.toBeNull()
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'sends nothing to a group it found empty',
    async () => {
      const child = await spawnChild({
        argv: [SH, '-c', 'exit 0'],
        cwd,
        env: { PATH: '/usr/bin:/bin' },
        stdio: 'pipe',
      })
      expect(await child.exited).toEqual({ code: 0, signal: null })
      const kill = vi.spyOn(process, 'kill')
      try {
        await child.kill('SIGTERM')
        await child.kill('SIGKILL')
        expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
      } finally {
        kill.mockRestore()
      }
    },
    CASE_TIMEOUT_MS,
  )
})
