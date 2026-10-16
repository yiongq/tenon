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
import type { AbsolutePath, ChildHandle, HostProcess, HostSandbox } from '@tenon-app/kernel'
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
import {
  SANDBOX_TESTS_VARIABLE,
  assertSandboxActive,
  holdTmpClaudeLock,
  killMarked,
  markedProcesses,
  newMark,
  sandboxTestsGate,
  startSandboxRig,
  type SandboxLab,
  type SandboxRig,
} from './sandbox/support.js'

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
  // `exec`: the fixture's shell is the direct child itself, whatever `sh -c` does with its last
  // command (bash and dash exec it; the spec does not say either must).
  return bashCommand(`exec /bin/sh '${fixture}'`, {
    ...q,
    sandbox: new PassthroughSandbox(() => {}),
    commandId: 'toolu_stop_tree',
    folder: cwd,
  })
}

/** Runs `command` through the kernel's Bash executor, on desktop's host and the given sandbox. */
function bashCommand(
  command: string,
  q: {
    readonly process: HostProcess
    readonly signal: AbortSignal
    readonly timeout?: number
    readonly sandbox: HostSandbox
    readonly commandId: string
    readonly folder: AbsolutePath
  },
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
    input: {
      command,
      ...(q.timeout === undefined ? {} : { timeout: q.timeout }),
    },
    signal: q.signal,
    target: null,
    scope: {
      roots: [q.folder],
      profileDir: absolutePath('/tenon/prof'),
      ownSpillDir: absolutePath('/tenon/prof/tool-output/s1'),
      protectedFiles: [],
    },
    fs: new DesktopFs(),
    clock: new SystemClock(),
    command: {
      commandId: q.commandId,
      shell: SH,
      env: { PATH: '/usr/bin:/bin' },
      folders: [q.folder],
      dedicated: false,
      host: {
        process: q.process,
        sandbox: q.sandbox,
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

/**
 * Spec 04 验收 15, the stop part, with 04 不变量 13 (plan step 6; T11, P6): the kernel's Bash executor
 * on desktop's HostProcess and a real `DesktopSandbox` over sandbox-runtime. Every process a command
 * leaves carries a marker in its argv, and the host's process table is read for it. The half "a
 * command that exits leaves nothing in its process group" waits for plan step 10's kernel change.
 * Runs where `TENON_SANDBOX_TESTS=required` (plan 开工前读「沙箱外」); skipped otherwise.
 */
const sandboxGate = sandboxTestsGate(process.env[SANDBOX_TESTS_VARIABLE])
if (!sandboxGate.run) console.warn(sandboxGate.reason)

describe.skipIf(!sandboxGate.run || process.platform === 'win32')(
  'the stop on a real sandboxed process tree (04 验收 15)',
  () => {
    let rig: SandboxRig
    let lab: SandboxLab
    let folder: AbsolutePath
    let releaseTmpClaude: (() => void) | undefined
    const marks: string[] = []

    beforeAll(async () => {
      // escape.test.ts's mktemp case sets srt's shared /tmp/claude aside and every wrap here makes it
      // again: under S the two take turns (support.ts holdTmpClaudeLock).
      releaseTmpClaude = await holdTmpClaudeLock()
      rig = await startSandboxRig()
      assertSandboxActive(rig.outcome)
      lab = rig.lab()
      folder = absolutePath(lab.dir('ws'))
      lab.folders = [folder]
    }, CASE_TIMEOUT_MS * 7)

    afterEach(async () => {
      await Promise.all(marks.splice(0).map(killMarked))
    })

    afterAll(async () => {
      try {
        await rig?.dispose()
      } finally {
        releaseTmpClaude?.()
      }
    })

    /**
     * Polls the process table until a process of each `<mark>_<kind>` runs; rejects past
     * `PATIENCE_MS`. A process whose argv holds the marker more than once is a shell or the
     * sandbox-exec wrapper carrying the whole command text, not one of the processes it starts.
     */
    async function allUp(mark: string, kinds: readonly string[]): Promise<void> {
      const deadline = now() + PATIENCE_MS
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- one ps at a time
        const args = (await markedProcesses(mark))
          .map((row) => row.args)
          .filter((one) => one.split(mark).length === 2)
        const up = (kind: string): boolean =>
          args.some((one) => new RegExp(`${mark}_${kind}(?:\\s|$)`).test(one))
        if (kinds.every(up)) return
        if (now() > deadline) {
          throw new Error(`not all of ${kinds.join(', ')} came up: ${JSON.stringify(args)}`)
        }
        // oxlint-disable-next-line no-await-in-loop -- the poll's pace
        await delay(10)
      }
    }

    /** When `ps` first found no process carrying `mark`; null when one still did past `deadline`. */
    async function goneAt(mark: string, deadline: number): Promise<number | null> {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- one ps at a time
        const left = await markedProcesses(mark)
        const at = now()
        if (left.length === 0) return at
        if (at > deadline) return null
        // oxlint-disable-next-line no-await-in-loop -- the poll's pace
        await delay(10)
      }
    }

    function sandboxedCall(
      command: string,
      signal: AbortSignal,
    ): { readonly call: Promise<ToolExecution>; readonly commandId: string } {
      const commandId = `toolu_stop_tree_sandboxed_${String(Math.floor(now()))}`
      // The kernel's `beforeWrap` (LoopPorts.sandbox, plan step 13c): the session and its folder.
      lab.sandbox.beforeWrap({ commandId, sessionId: lab.sessionId })
      const call = bashCommand(command, {
        process: createHostProcess(),
        signal,
        sandbox: lab.sandbox,
        commandId,
        folder,
      })
      return { call, commandId }
    }

    it(
      '04 验收 15: a stop leaves none of the command’s processes — the & child, the grandchild & left behind, the setsid one, the foreground one — within 1 s (04 不变量 13)',
      async () => {
        const mark = newMark('stop')
        marks.push(mark)
        const stop = new AbortController()
        // The grandchild and the setsid one drop TENON_SANDBOX_MARK, so on darwin only the process
        // group and the tree collected before the signal can reach them, not afterExit's mark scan.
        const { call } = sandboxedCall(
          [
            `perl -e 'sleep 600' ${mark}_bg &`,
            `( env -u TENON_SANDBOX_MARK perl -e 'sleep 600' ${mark}_grandchild & )`,
            `env -u TENON_SANDBOX_MARK perl -MPOSIX -e 'POSIX::setsid(); sleep 601' ${mark}_setsid &`,
            `perl -e 'sleep 602' ${mark}_fg`,
          ].join('\n'),
          stop.signal,
        )
        await allUp(mark, ['bg', 'grandchild', 'setsid', 'fg'])

        const stoppedAt = now()
        stop.abort()
        const gone = await goneAt(mark, stoppedAt + PATIENCE_MS)
        const execution = await call
        expect(gone).not.toBeNull()
        expect((gone ?? Infinity) - stoppedAt).toBeLessThan(TREE_CLEAR_MS)
        expect(execution).toMatchObject({ isError: true, state: 'aborted' })
      },
      CASE_TIMEOUT_MS,
    )

    it(
      '04 验收 15: a stop leaves no setsid process that ignores SIGTERM and dropped its mark within 1 s (04 不变量 13)',
      async () => {
        const mark = newMark('stopterm')
        marks.push(mark)
        const stop = new AbortController()
        // perl is an Apple platform binary and drops TENON_SANDBOX_MARK, so on darwin afterExit's
        // mark scan cannot find it; it outlives the SIGTERM, and by the SIGKILL the shell is gone
        // and launchd has it: only the tree killTree collected at the SIGTERM still names it.
        const { call } = sandboxedCall(
          [
            `env -u TENON_SANDBOX_MARK perl -MPOSIX -e '$SIG{TERM} = "IGNORE"; POSIX::setsid(); sleep 603' ${mark}_setsidterm &`,
            `perl -e 'sleep 604' ${mark}_fg`,
          ].join('\n'),
          stop.signal,
        )
        await allUp(mark, ['setsidterm', 'fg'])

        const stoppedAt = now()
        stop.abort()
        const gone = await goneAt(mark, stoppedAt + PATIENCE_MS)
        const execution = await call
        expect(gone).not.toBeNull()
        expect((gone ?? Infinity) - stoppedAt).toBeLessThan(TREE_CLEAR_MS)
        expect(execution).toMatchObject({ isError: true, state: 'aborted' })
      },
      CASE_TIMEOUT_MS,
    )

    // On darwin only afterExit's TENON_SANDBOX_MARK scan (and the process group of each process it
    // finds) reaches a process that left the command's group and outlives a call that ended on its
    // own, and `ps -E` shows no environment for an Apple platform binary (perl, sleep, the shells).
    // So these cases use python3 (as in P6), which is not one; the darwin case after them records
    // what is left: a platform binary that left the group by itself outlives the call (setsid-mac A,
    // 2026-10-16: 验收 15 and 不变量 13 narrowed on darwin, §已知限制). `: <mark>_decoy` puts the
    // mark twice in the command text, so the shell and the sandbox-exec wrapper carrying it are never
    // taken for one of the processes it starts.
    it(
      '04 验收 15: a command that setsids a non-platform binary (python3) and exits leaves it running nowhere once the call ends (04 不变量 13; on darwin found by its TENON_SANDBOX_MARK)',
      async () => {
        const mark = newMark('exit')
        marks.push(mark)
        const { call } = sandboxedCall(
          [
            `: ${mark}_decoy`,
            `python3 -c 'import os, time; os.setsid(); time.sleep(605)' ${mark}_setsid >/dev/null 2>&1 &`,
            'sleep 1',
            'exit 0',
          ].join('\n'),
          new AbortController().signal,
        )
        await allUp(mark, ['setsid'])
        const execution = await call
        const endedAt = now()
        expect(execution).toMatchObject({ isError: false, state: 'completed' })
        const gone = await goneAt(mark, endedAt + PATIENCE_MS)
        expect(gone).not.toBeNull()
        expect((gone ?? Infinity) - endedAt).toBeLessThan(TREE_CLEAR_MS)
      },
      CASE_TIMEOUT_MS,
    )

    it(
      '04 验收 15: a command whose setsid python3 starts perl in its new group and exits leaves neither running once the call ends (04 不变量 13; on darwin perl goes with the group of the python found by its TENON_SANDBOX_MARK)',
      async () => {
        const mark = newMark('group')
        marks.push(mark)
        // perl's marker is python's own with `_setsid` swapped for `_perl`, so neither argv holds
        // the mark twice.
        const python = [
          'import os, subprocess, sys, time',
          'os.setsid()',
          'subprocess.Popen(["perl", "-e", "sleep 607", sys.argv[1].replace("_setsid", "_perl")])',
          'time.sleep(606)',
        ].join('; ')
        const { call } = sandboxedCall(
          [
            `: ${mark}_decoy`,
            `python3 -c '${python}' ${mark}_setsid >/dev/null 2>&1 &`,
            'sleep 1',
            'exit 0',
          ].join('\n'),
          new AbortController().signal,
        )
        await allUp(mark, ['setsid', 'perl'])
        const execution = await call
        const endedAt = now()
        expect(execution).toMatchObject({ isError: false, state: 'completed' })
        const gone = await goneAt(mark, endedAt + PATIENCE_MS)
        expect(gone).not.toBeNull()
        expect((gone ?? Infinity) - endedAt).toBeLessThan(TREE_CLEAR_MS)
      },
      CASE_TIMEOUT_MS,
    )

    // What setsid-mac A (2026-10-16) leaves on darwin, as it is: a setsid Apple platform binary
    // carries the mark where `ps -E` cannot show it and has left the command's group, so nothing
    // finds it once the call ends on its own (§已知限制). This case goes red the day it is killed;
    // then 验收 15 and 不变量 13 can drop their darwin narrowing. afterEach kills it.
    it.skipIf(process.platform !== 'darwin')(
      '04 验收 15 (darwin, as it is): a command that setsids an Apple platform binary (perl) and exits leaves it running 1 s after the call ends (§已知限制)',
      async () => {
        const mark = newMark('platform')
        marks.push(mark)
        const { call } = sandboxedCall(
          [
            `: ${mark}_decoy`,
            `perl -MPOSIX -e 'POSIX::setsid(); sleep 608' ${mark}_setsid >/dev/null 2>&1 &`,
            'sleep 1',
            'exit 0',
          ].join('\n'),
          new AbortController().signal,
        )
        await allUp(mark, ['setsid'])
        const execution = await call
        const endedAt = now()
        expect(execution).toMatchObject({ isError: false, state: 'completed' })
        expect(await goneAt(mark, endedAt + TREE_CLEAR_MS)).toBeNull()
      },
      CASE_TIMEOUT_MS,
    )
  },
)
