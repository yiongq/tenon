/**
 * The connector log files are for their owner alone (docs/features/error-logs/spec.md §对 03 的增补,
 * 规矩 第 8 条; acceptance 18): `mcp-<serverId>.log` and the two archives it rotates into are made
 * 0600, those that already exist are tightened when the sink starts, and a log that is a link,
 * has a second name or is somebody else's is left as it is.
 *
 * Real files in a real temp folder, the real `createMcpLogSink`. The process umask is cleared so
 * that a file made without an explicit mode would come out 0666 and fail. Not covered here: a
 * file owned by someone else (a test cannot make one without being root; the app log has the
 * `uid` seam for that, the MCP sink has none).
 */
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createMemoryHost } from '@tenon-app/kernel'
import { afterEach, expect, it, vi } from 'vitest'
import { createMcpLogSink } from '../src/main/mcp/log-sink.js'
import { makeTempRoot, sweepTempRoots } from './support/error-logs.js'

afterEach(sweepTempRoots)

const mode = (path: string): number => statSync(path).mode & 0o777
/** A log file as an older Tenon left it: readable by everyone, whatever the umask. */
function loose(path: string, content = 'old\n'): void {
  writeFileSync(path, content, { mode: 0o644 })
  chmodSync(path, 0o644)
}
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

it('error-logs 验收 18: MCP log files are created 0600, existing ones are tightened, and links, hard links or foreign files are skipped', async () => {
  const umask = process.umask(0)
  try {
    const root = makeTempRoot('mcp-files')
    const profileDir = join(root, 'profile')
    const logs = join(profileDir, 'logs')
    mkdirSync(logs, { recursive: true, mode: 0o755 })

    // What is there when the app starts: three loose logs of one connector, a link, a second name.
    for (const name of ['mcp-old.log', 'mcp-old.log.1', 'mcp-old.log.2']) loose(join(logs, name))
    const victim = join(root, 'victim.txt')
    loose(victim, 'VICTIM\n')
    symlinkSync(victim, join(logs, 'mcp-link.log'))
    loose(join(logs, 'mcp-hard.log'))
    linkSync(join(logs, 'mcp-hard.log'), join(root, 'other-name'))

    const sink = createMcpLogSink({ ...createMemoryHost().identity, profileDir })
    await vi.waitFor(() => {
      for (const name of ['mcp-old.log', 'mcp-old.log.1', 'mcp-old.log.2']) {
        expect([name, mode(join(logs, name))]).toEqual([name, 0o600])
      }
    })
    // Whatever the sink was going to do to the others, it has done by now.
    await settle(150)
    expect(mode(victim)).toBe(0o644)
    expect(lstatSync(join(logs, 'mcp-link.log')).isSymbolicLink()).toBe(true)
    expect(mode(join(logs, 'mcp-hard.log'))).toBe(0o644)
    expect(mode(join(root, 'other-name'))).toBe(0o644)

    // A log made now is 0600, and so are the archives it rotates into.
    await sink.append('fresh', 'hello')
    expect(mode(join(logs, 'mcp-fresh.log'))).toBe(0o600)
    const big = 'a'.repeat(700_000)
    await sink.append('big', big)
    await sink.append('big', big)
    await sink.append('big', big)
    await sink.append('big', big)
    await sink.close()
    for (const name of ['mcp-big.log', 'mcp-big.log.1', 'mcp-big.log.2']) {
      expect([name, mode(join(logs, name))]).toEqual([name, 0o600])
    }
  } finally {
    process.umask(umask)
  }
})
