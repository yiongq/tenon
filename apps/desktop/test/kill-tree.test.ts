/**
 * desktop's `killTree` on darwin (spec 04 §执行与收口「停止后无残留」, P6; plan step 6) with `/bin/ps`
 * faked: a stop's SIGTERM collects the descendants it reached, and the SIGKILL after it signals
 * them again. Once the leader is reaped and its group found empty, the leader's pid may already be
 * someone else's: nothing may be walked from it, and `-pid` may not be signalled. The fake pids lie
 * above macOS's pid range, so a signal that reaches one hits nothing.
 */
import type * as ChildProcess from 'node:child_process'
import { tmpdir } from 'node:os'
import { absolutePath } from '@tenon-app/kernel'
import { describe, expect, it, vi } from 'vitest'
import { createHostProcess, killTree, spawnChild } from '../src/main/host/process.js'

/** What each `/bin/ps` call answers, in turn: a table, or the error it fails with. */
const fakePs = vi.hoisted(() => ({ tables: [] as (string | Error)[] }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  const execFile = (...args: unknown[]): unknown => {
    if (args[0] !== '/bin/ps') return Reflect.apply(actual.execFile, undefined, args)
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void
    const table = fakePs.tables.shift()
    setImmediate(() =>
      table === undefined || table instanceof Error
        ? callback(table ?? new Error('no fake ps table left'), '')
        : callback(null, table),
    )
    return undefined
  }
  return { ...actual, execFile }
})

/** A descendant the stop's SIGTERM collected (it setsid'd out of the group). */
const COLLECTED = 999_991
/** The child of whoever holds the leader's pid once the leader was reaped. */
const STRANGER = 999_992

describe.skipIf(process.platform !== 'darwin')('killTree on darwin, ps faked', () => {
  it('04 验收 15: once the group is found empty, later signals reach what the SIGTERM collected, walk nothing from the reaped leader’s pid and never signal -pid, even when that pid leads a group again', async () => {
    const child = await spawnChild({
      // The leader alone in its group: nothing else keeps the group alive past its exit.
      argv: ['/bin/sleep', '30'],
      cwd: absolutePath(tmpdir()),
      env: { PATH: '/usr/bin:/bin' },
      stdio: 'ignore',
    })
    const pid = String(child.pid)
    const later = [
      `${String(COLLECTED)} 1 Thu Oct 15 10:00:01 2026`,
      `${pid} 1 Thu Oct 15 10:05:00 2026`,
      `${String(STRANGER)} ${pid} Thu Oct 15 10:05:01 2026`,
    ].join('\n')
    fakePs.tables.push(
      // At the SIGTERM: the leader and the descendant it started.
      [
        `${pid} 1 Thu Oct 15 10:00:00 2026`,
        `${String(COLLECTED)} ${pid} Thu Oct 15 10:00:01 2026`,
      ].join('\n'),
      // At each later signal: the descendant, now launchd's, and the leader's pid reused with a child.
      later,
      later,
    )
    const realKill = process.kill.bind(process)
    let reused = false
    const kill = vi.spyOn(process, 'kill').mockImplementation((target, signal) =>
      // Once reused, the pid leads a group of its own: `kill(-pid, 0)` finds a member.
      reused && target === -child.pid && signal === 0 ? true : realKill(target, signal),
    )
    try {
      await child.kill('SIGTERM')
      expect(await child.exited).toEqual({ code: null, signal: 'SIGTERM' })
      reused = true
      await child.kill('SIGKILL')
      await child.kill('SIGKILL')
      expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [-child.pid, 'SIGTERM'],
        [COLLECTED, 'SIGTERM'],
        [COLLECTED, 'SIGKILL'],
        [COLLECTED, 'SIGKILL'],
      ])
      expect(fakePs.tables).toEqual([])
    } finally {
      kill.mockRestore()
    }
  })

  it('04 验收 15: a collected pid reused before SIGKILL is dropped and neither it nor unrelated processes receive a signal', async () => {
    const leader = 999_990
    const collected = new Map<number, string>()
    fakePs.tables.push(
      [
        `${String(leader)} 1 Thu Oct 15 10:00:00 2026`,
        `${String(COLLECTED)} ${String(leader)} Thu Oct 15 10:00:01 2026`,
        `${String(STRANGER)} 1 Thu Oct 15 10:00:02 2026`,
      ].join('\n'),
      [
        `${String(COLLECTED)} 1 Thu Oct 15 10:05:00 2026`,
        `${String(STRANGER)} ${String(COLLECTED)} Thu Oct 15 10:05:01 2026`,
      ].join('\n'),
    )
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    try {
      await killTree(leader, 'SIGTERM', { collected })
      expect([...collected]).toEqual([[999_991, 'Thu Oct 15 10:00:01 2026']])
      expect(kill.mock.calls).toEqual([
        [-999_990, 'SIGTERM'],
        [999_991, 'SIGTERM'],
      ])
      kill.mockClear()
      await killTree(leader, 'SIGKILL', { group: () => false, collected })
      expect(kill.mock.calls).toEqual([])
      expect([...collected]).toEqual([])
      expect(fakePs.tables).toEqual([])
    } finally {
      kill.mockRestore()
    }
  })

  it('04 验收 15: when ps fails or takes over 200 ms, the signal goes to the group alone and the host log gets one line saying which', async () => {
    const lines: string[] = []
    // Through the host's process port, as desktop and the eval host spawn: it hands its log on.
    const child = await createHostProcess((line) => lines.push(line)).spawn({
      argv: ['/bin/sleep', '30'],
      cwd: absolutePath(tmpdir()),
      env: { PATH: '/usr/bin:/bin' },
      stdio: 'ignore',
    })
    // execFile's own error for a ps it killed at the timeout carries `killed`.
    const timedOut = Object.assign(new Error('Command failed: /bin/ps'), { killed: true })
    fakePs.tables.push(new Error('spawn /bin/ps EAGAIN'), timedOut)
    const realKill = process.kill.bind(process)
    const kill = vi.spyOn(process, 'kill').mockImplementation(realKill)
    try {
      await child.kill('SIGTERM')
      expect(await child.exited).toEqual({ code: null, signal: 'SIGTERM' })
      await killTree(STRANGER, 'SIGKILL', { log: (line) => lines.push(line) })
      expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [-child.pid, 'SIGTERM'],
        [-STRANGER, 'SIGKILL'],
      ])
      expect(lines).toEqual([
        'killTree: /bin/ps failed: spawn /bin/ps EAGAIN; no process outside the group is signalled',
        'killTree: /bin/ps took over 200 ms; no process outside the group is signalled',
      ])
      expect(fakePs.tables).toEqual([])
    } finally {
      kill.mockRestore()
    }
  })
})
