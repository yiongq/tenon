/**
 * What the sandbox's self-test leaves in the logs (docs/features/error-logs/spec.md 验收 17: a
 * normal start has no warn or error line; spec 04 §启动 step 5). The self-test writes a path it must
 * not and the sandbox stops it: that is the self-test passing, and srt reports the stop as a
 * violation keyed by the command id the self-test gave it. The real startup and the real
 * `DesktopSandbox` run over fake srt ports (the wiring of `allowlist.test.ts`), so the id the
 * self-test hands srt is the one the host sandbox meets in the violation store.
 *
 * The three log destinations are the ones main wires: `log` is the warn level of the `host` source,
 * `info` its information level, `unattributedLog` the `sandbox-unattributed` source at warn.
 */
import type { SandboxViolationEvent } from '@anthropic-ai/sandbox-runtime'
import { absolutePath, createMemoryHost } from '@tenon-app/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as sandboxPorts from '../../src/main/host/sandbox.js'
import type { SrtViolationStore } from '../../src/main/host/sandbox.js'
import * as posturePorts from '../../src/main/host/sandbox-posture.js'
import { createDesktopSandboxRuntime } from '../../src/main/host/sandbox-runtime.js'
import { snapshotEnv } from '../../src/main/host/shell-env.js'
import { wiringFixture } from './wiring-support.js'

afterEach(() => {
  vi.restoreAllMocks()
})

/** What srt's log monitor says about the stopped write (macOS wording, the path replaced). */
const SELF_TEST_LINE =
  'sh(4242) deny(1) file-write-create /private/tmp/tenon-sandbox-self-test-0123456789abcdef'

/** srt's violation store, cut down: events kept, a running total, listeners told everything. */
function violationStore(): SrtViolationStore & {
  /** An event as srt records one: the command id, when there is one, travels base64 encoded. */
  add(line: string, id?: string): void
} {
  const events: SandboxViolationEvent[] = []
  const listeners = new Set<(events: SandboxViolationEvent[]) => void>()
  return {
    add(line, id) {
      events.push({
        line,
        ...(id === undefined ? {} : { encodedCommand: Buffer.from(id).toString('base64') }),
        timestamp: new Date(0),
      })
      for (const listener of listeners) listener([...events])
    },
    getTotalCount: () => events.length,
    subscribe(listener) {
      listeners.add(listener)
      listener([...events])
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

interface Started {
  /** What the startup said about the sandbox. */
  readonly state: string
  readonly reasons: readonly string[]
  readonly store: ReturnType<typeof violationStore>
  /** The command ids the self-test handed srt. */
  readonly ids: readonly string[]
  readonly lines: {
    readonly warn: readonly string[]
    readonly info: readonly string[]
    readonly unattributed: readonly string[]
  }
}

/**
 * The desktop's real startup. `blocked and reported`: the sandbox stops the self-test's write and
 * srt reports it under the self-test's id. `blocked`: stopped, and nothing reported (no events yet,
 * or a platform that reports none). `not blocked`: the write gets through.
 */
async function startDesktop(
  selfTest: 'blocked and reported' | 'blocked' | 'not blocked',
): Promise<Started> {
  const h = wiringFixture()
  const host = createMemoryHost()
  const store = violationStore()
  const ids: string[] = []
  const lines = {
    warn: [] as string[],
    info: [] as string[],
    unattributed: [] as string[],
  }
  const fs = {
    ...h.fs,
    lstat: () => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: process.getuid?.() ?? 0,
      mode: 0o700,
    }),
    stat: () => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: process.getuid?.() ?? 0,
      mode: 0o700,
    }),
  }
  const startupSrt = {
    initialize: vi.fn<posturePorts.SrtStartup['initialize']>(async () => {}),
    checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
    wrapWithSandboxArgv: vi.fn<posturePorts.SrtStartup['wrapWithSandboxArgv']>(
      async (_command, _shell, _config, _abort, _cwd, options) => {
        ids.push(options.commandId)
        return { argv: ['/bin/sh', '-c', 'true'], env: {} }
      },
    ),
    cleanupAfterCommand: () => {},
    getWslVersion: () => undefined,
  }
  vi.spyOn(sandboxPorts, 'desktopSandboxFs').mockReturnValue(fs)
  vi.spyOn(sandboxPorts, 'desktopProcessTable').mockReturnValue(h.options.processes)
  vi.spyOn(posturePorts, 'desktopSrtSandbox').mockReturnValue({
    ...h.srt,
    getSandboxViolationStore: () => store,
  })
  vi.spyOn(posturePorts, 'desktopSrtStartup').mockReturnValue(startupSrt)
  vi.spyOn(posturePorts, 'desktopPostureFs').mockReturnValue({
    ...fs,
    lstat: (path) =>
      // The self-test's target is on the disk only when the sandbox did not stop the write.
      path.includes('tenon-sandbox-self-test-') && selfTest !== 'not blocked'
        ? undefined
        : { ...fs.lstat(), isFile: () => false, size: 0, nlink: 1 },
    stat: (path) => ({
      ...fs.stat(),
      isDirectory: () => !path.endsWith('.jar') && !path.endsWith('/apply-seccomp'),
    }),
    readdir: () => [],
    isExecutable: () => true,
    removeEmptyDir: () => {},
    removeFile: () => {},
    removeTree: () => {},
  })
  vi.spyOn(posturePorts, 'desktopPostureProcesses').mockReturnValue({
    list: async () => [],
    kill: () => {},
  })
  vi.spyOn(posturePorts, 'desktopPostureRunner').mockReturnValue(async () => {
    if (selfTest === 'blocked and reported') store.add(SELF_TEST_LINE, ids.at(-1))
    return { code: 0, signal: null, stderr: '', timedOut: false }
  })
  vi.spyOn(process, 'chdir').mockImplementation(() => {})

  const runtime = await createDesktopSandboxRuntime({
    host,
    userDataDir: absolutePath('/data'),
    isPackaged: false,
    startupEnv: snapshotEnv({}),
    log: (line) => lines.warn.push(line),
    info: (line) => lines.info.push(line),
    unattributedLog: (line) => lines.unattributed.push(line),
  })
  runtime.bindSessionFolders(async () => [absolutePath('/work/project')])
  const outcome = await runtime.start().outcome
  return {
    state: outcome.state,
    reasons: outcome.reasons.map((reason) => reason.code),
    store,
    ids,
    lines,
  }
}

describe('error-logs 验收 17: the sandbox self-test in the logs', () => {
  it('error-logs 验收 17: 复现 a self-test that the sandbox stops as meant leaves no line, at warn or at error, in the unattributed log or the shared one', async () => {
    const started = await startDesktop('blocked and reported')
    expect(started.state).toBe('active')
    // The stop did reach the store: the self-test gave srt one id, and the event was keyed by it.
    expect(started.ids).toHaveLength(1)
    expect(started.lines).toEqual({
      warn: [],
      info: ['sandbox: active'],
      unattributed: [],
    })
    // macOS's log monitor delivers late: the same stop arriving after startup has settled is the same.
    started.store.add(SELF_TEST_LINE, started.ids[0])
    expect(started.lines).toEqual({
      warn: [],
      info: ['sandbox: active'],
      unattributed: [],
    })
  })

  it('error-logs 验收 17: a self-test that the sandbox does not stop is still reported: unavailable, self-test-failed, one warn line, and no violation to log', async () => {
    const started = await startDesktop('not blocked')
    expect({ state: started.state, reasons: started.reasons }).toEqual({
      state: 'unavailable',
      reasons: ['self-test-failed'],
    })
    expect(started.lines).toEqual({
      warn: ['sandbox: unavailable (self-test-failed)'],
      info: [],
      unattributed: [],
    })
  })

  it('error-logs 验收 17: every other violation that fits no open command still goes to the unattributed log at warn: a look-alike of the self-test id, no id, an id of no open command, and the self-test id in another case', async () => {
    const started = await startDesktop('blocked')
    const [selfTestId = ''] = started.ids
    expect(selfTestId).toMatch(/^tenon-sandbox-self-test\.[0-9a-f]{32}$/)
    const lookAlike = `tenon-sandbox-self-test.${'0'.repeat(32)}`
    const upper = selfTestId.toUpperCase()
    started.store.add(
      'deny network-outbound a.example.com:443 (host is not on the allow list)',
      lookAlike,
    )
    started.store.add('deny network-outbound b.example.com:443 (host is not on the allow list)')
    started.store.add(
      'deny network-outbound c.example.com:443 (host is not on the allow list)',
      'toolu_01Hx7ZbQe2fXkq3VJt9Lw4Rn',
    )
    started.store.add(
      'deny network-outbound d.example.com:443 (host is not on the allow list)',
      upper,
    )
    expect(started.lines.unattributed).toEqual([
      `sandbox: a violation for no open command (key "${lookAlike}"): deny network-outbound a.example.com:443 (host is not on the allow list)`,
      'sandbox: a violation for no open command (key none): deny network-outbound b.example.com:443 (host is not on the allow list)',
      'sandbox: a violation for no open command (key "toolu_01Hx7ZbQe2fXkq3VJt9Lw4Rn"): deny network-outbound c.example.com:443 (host is not on the allow list)',
      `sandbox: a violation for no open command (key "${upper}"): deny network-outbound d.example.com:443 (host is not on the allow list)`,
    ])
    expect(started.lines.warn).toEqual([])
  })
})
