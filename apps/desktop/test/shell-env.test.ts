/**
 * Bash's shell and base environment (spec 02 §内置工具与参数「Bash」「desktop 怎么算」; plan step 22,
 * 暂定与待定). The shells are small `/bin/sh` scripts in a temp dir, run through the real desktop
 * HostProcess and PassthroughSandbox; only the clock is fake, so the 10 s limit fires on demand.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
import type { AbsolutePath, HostClock, SandboxRequest } from '@tenon-app/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostProcess } from '../src/main/host/process.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'
import {
  pickShell,
  snapshotEnv,
  startCommandShell,
  withoutTenonVars,
} from '../src/main/host/shell-env.js'
import type { EnvRecord } from '../src/main/host/shell-env.js'
import { DEV_ENV_FALLBACK } from '../src/main/provider.js'

const DEV_KEY_NAMES = Object.values(DEV_ENV_FALLBACK).flatMap((names) => Object.values(names))

/** What main() would have snapshotted: Tenon's and Electron's own variables, a dev key, a user token. */
function startupEnvIn(home: string): EnvRecord {
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    STARTUP_ONLY: 'kept',
    GH_TOKEN: 'user-token',
    ELECTRON_RUN_AS_NODE: '1',
    TENON_DEV_ENV: 'off',
    ...Object.fromEntries(DEV_KEY_NAMES.map((name) => [name, `dev-${name}`])),
  }
}

function fakeClock(): { clock: HostClock; timers: { fn: () => void; ms: number }[] } {
  const timers: { fn: () => void; ms: number }[] = []
  return {
    timers,
    clock: {
      now: () => 0,
      setTimeout(fn, ms) {
        timers.push({ fn, ms })
        return () => {}
      },
    },
  }
}

/** The real passthrough, with what it was asked recorded. */
class RecordingSandbox extends PassthroughSandbox {
  readonly wrapped: SandboxRequest[] = []
  readonly exited: string[] = []
  constructor() {
    super(() => {})
  }
  override wrap(request: SandboxRequest): Promise<{ argv: string[]; env: Record<string, string> }> {
    this.wrapped.push(request)
    return super.wrap(request)
  }
  override afterExit(commandId: string): Promise<void> {
    this.exited.push(commandId)
    return super.afterExit(commandId)
  }
}

async function eventually(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  // oxlint-disable-next-line no-await-in-loop
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let dir: AbsolutePath

beforeEach(async () => {
  dir = absolutePath(await mkdtemp(join(tmpdir(), 'tenon-shell-env-')))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function fakeShell(name: string, body: string): Promise<AbsolutePath> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return absolutePath(path)
}

function start(shell: AbsolutePath, isPackaged = false) {
  const sandbox = new RecordingSandbox()
  const { clock, timers } = fakeClock()
  const logged: string[] = []
  const startupEnv = startupEnvIn(dir)
  const commandShell = startCommandShell({
    host: { process: createHostProcess(), sandbox, clock },
    shell,
    startupEnv,
    home: dir,
    isPackaged,
    log: (line) => logged.push(line),
  })
  return { commandShell, sandbox, timers, logged, startupEnv }
}

function expectNoTenonVars(env: EnvRecord): void {
  const names = Object.keys(env)
  expect(names.filter((name) => name.startsWith('TENON_') || name.startsWith('ELECTRON_'))).toEqual(
    [],
  )
  expect(names).not.toContain('ELECTRON_RUN_AS_NODE')
  expect(names.filter((name) => DEV_KEY_NAMES.includes(name))).toEqual([])
}

describe('the shell env (-i -l -c, env -0 between two markers)', () => {
  it('takes the env printed between the markers, and none of what the rc files printed around it', async () => {
    const argvFile = join(dir, 'argv')
    const outFile = join(dir, 'out')
    const shell = await fakeShell(
      'zsh',
      [
        `printf '%s\\n' "$@" > '${argvFile}'`,
        // rc-file noise on both streams, shaped like env entries on purpose: one write of its own,
        // then one write holding noise, the marked env and more noise, so no chunk edge helps.
        `printf 'EARLY_JUNK=1\\000rc says hello\\n'`,
        `printf 'rc noise on stderr\\n' >&2`,
        `export FROM_RC='from rc`,
        `second line'`,
        `export TENON_FROM_RC=1 ELECTRON_FROM_RC=1`,
        `{ printf 'JUNK_BEFORE=1\\000'; /bin/sh -c "$4"; printf '\\000JUNK_AFTER=1\\000'; } > '${outFile}'`,
        `cat '${outFile}'`,
      ].join('\n'),
    )
    const { commandShell, sandbox, logged, startupEnv } = start(shell)

    const env = await commandShell.env()

    expect(commandShell.path).toBe(shell)
    const argv = (await readFile(argvFile, 'utf8')).split('\n')
    expect(argv.slice(0, 3)).toEqual(['-i', '-l', '-c'])
    expect(argv[3]).toContain('/usr/bin/env -0')
    expect(env['FROM_RC']).toBe('from rc\nsecond line')
    // All of the startup env the shell passed on, the first variable env -0 prints included: none
    // is filed under a name with the start marker (32 lowercase hex digits) left in front of it.
    expect(env).toMatchObject(withoutTenonVars(startupEnv, false))
    expect(Object.keys(env).filter((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name))).toEqual([])
    expect(env['STARTUP_ONLY']).toBe('kept')
    expect(env['GH_TOKEN']).toBe('user-token')
    expect(env).not.toHaveProperty('EARLY_JUNK')
    expect(env).not.toHaveProperty('JUNK_BEFORE')
    expect(env).not.toHaveProperty('JUNK_AFTER')
    expectNoTenonVars(env)
    expect(logged).toEqual([])
    // Through the sandbox wrapper, with the startup snapshot as its env; resolved once.
    expect(await commandShell.env()).toBe(env)
    expect(sandbox.wrapped).toHaveLength(1)
    expect(sandbox.wrapped[0]?.argv[0]).toBe(shell)
    expect(sandbox.wrapped[0]?.env).toEqual(startupEnv)
    await eventually(() => sandbox.exited.length === 1)
  })

  it('falls back to the startup env with one log line when the shell does not answer in 10 s, and kills its tree', async () => {
    const pidFile = join(dir, 'pids')
    const shell = await fakeShell(
      'bash',
      [
        `sleep 30 &`,
        `printf '%s\\n' "$$" "$!" > '${pidFile}.tmp'`,
        `mv '${pidFile}.tmp' '${pidFile}'`,
        `wait`,
      ].join('\n'),
    )
    const { commandShell, timers, logged, startupEnv } = start(shell)
    await eventually(async () => (await readFile(pidFile, 'utf8').catch(() => '')).length > 0)
    const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number)
    expect(pids).toHaveLength(2)

    // env() waits for the answer while the shell is still running.
    let answered = false
    const pending = commandShell.env().then((env) => {
      answered = true
      return env
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(answered).toBe(false)

    // The spec's 「10 秒没完就经 kill 清整棵进程树」, as a literal: not the constant it is checking.
    expect(timers.map((timer) => timer.ms)).toEqual([10_000])
    timers[0]?.fn()
    const env = await pending

    expect(env).toEqual(withoutTenonVars(startupEnv, false))
    expect(env['STARTUP_ONLY']).toBe('kept')
    expectNoTenonVars(env)
    expect(logged).toHaveLength(1)
    await eventually(() => pids.every((pid) => !isAlive(pid)))
    expect(logged).toHaveLength(1)
  })

  it('falls back to the startup env with one log line when the shell exits without an answer', async () => {
    const shell = await fakeShell('sh', `printf 'no env here\\n'\nexit 3`)
    const { commandShell, logged, startupEnv } = start(shell)

    const env = await commandShell.env()

    expect(env).toEqual(withoutTenonVars(startupEnv, false))
    expectNoTenonVars(env)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('exited (3)')
  })

  it('falls back to the startup env with one log line when the shell cannot be started', async () => {
    const { commandShell, logged, startupEnv } = start(absolutePath(join(dir, 'missing', 'zsh')))

    const env = await commandShell.env()

    expect(env).toEqual(withoutTenonVars(startupEnv, false))
    expect(logged).toHaveLength(1)
  })
})

describe('withoutTenonVars', () => {
  const env: EnvRecord = {
    PATH: '/usr/bin',
    TENON_MODEL: 'm',
    ELECTRON_RUN_AS_NODE: '1',
    GH_TOKEN: 'g',
    NPM_TOKEN: 'n',
    OPENAI_API_KEY: 'o',
    ...Object.fromEntries(DEV_KEY_NAMES.map((name) => [name, 'v'])),
  }

  it('drops TENON_*, ELECTRON_* and, in a dev build, every DEV_ENV_FALLBACK name', () => {
    expect(DEV_KEY_NAMES).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'ZHIPU_API_KEY']))
    const dev = withoutTenonVars(env, false)
    expectNoTenonVars(dev)
    expect(dev).toEqual({ PATH: '/usr/bin', GH_TOKEN: 'g', NPM_TOKEN: 'n', OPENAI_API_KEY: 'o' })
  })

  it("keeps the dev key names in a packaged build, where they are the user's own", () => {
    const packaged = withoutTenonVars(env, true)
    for (const name of DEV_KEY_NAMES) expect(packaged[name]).toBe('v')
    expect(Object.keys(packaged).filter((name) => /^(TENON|ELECTRON)_/.test(name))).toEqual([])
  })
})

describe('snapshotEnv', () => {
  it('is a copy: what loadDevEnv writes into process.env afterwards is not in it', () => {
    const snapshot = snapshotEnv(process.env)
    process.env['TENON_SHELL_ENV_LATE'] = 'late'
    try {
      expect(snapshot).not.toHaveProperty('TENON_SHELL_ENV_LATE')
      expect(Object.isFrozen(snapshot)).toBe(true)
    } finally {
      delete process.env['TENON_SHELL_ENV_LATE']
    }
  })
})

/** An `isFile` that sees exactly these paths. */
function only(...paths: string[]): (path: string) => boolean {
  return (path) => paths.includes(path)
}

describe('pickShell', () => {
  it('uses the login shell when it is an absolute path to zsh, bash or sh that exists', () => {
    expect(pickShell('/usr/local/bin/bash', only('/usr/local/bin/bash', '/bin/zsh'))).toBe(
      '/usr/local/bin/bash',
    )
  })

  it('falls back to the first of /bin/zsh, /bin/bash, /bin/sh when the login shell is fish', () => {
    const fish = '/opt/homebrew/bin/fish'
    expect(pickShell(fish, only(fish, '/bin/zsh', '/bin/bash', '/bin/sh'))).toBe('/bin/zsh')
    expect(pickShell(fish, only(fish, '/bin/bash', '/bin/sh'))).toBe('/bin/bash')
  })

  it('falls back when the login shell is a relative path, missing, or unset', () => {
    expect(pickShell('zsh', () => true)).toBe('/bin/zsh')
    expect(pickShell('bin/bash', () => true)).toBe('/bin/zsh')
    expect(pickShell('/gone/zsh', only('/bin/sh'))).toBe('/bin/sh')
    expect(pickShell(null, only('/bin/bash'))).toBe('/bin/bash')
  })

  it('takes only a file: a directory named zsh is not a shell', async () => {
    const notAShell = join(dir, 'zsh')
    await mkdir(notAShell)
    expect(pickShell(notAShell)).not.toBe(notAShell)
  })
})
