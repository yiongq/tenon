/** Spec 05 D57: deterministic child-stream semantics, independent of OS scheduling. */
import type { ChildHandle, HostProcess } from '@tenon-app/kernel'
import { describe, expect, it, vi } from 'vitest'
import { SnapshotGit } from '../src/main/host/snapshot-git.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

describe('05 git stdin', () => {
  it.each([
    { input: undefined, code: 0, expected: /^ok:result$/ },
    { input: 'paths\0', code: 0, expected: /^error:.*closed/i },
    {
      input: undefined,
      code: 7,
      expected: /^error:Snapshot subprocess failed \(7\): git diagnostic$/,
    },
    {
      input: 'paths\0',
      code: 7,
      expected: /^error:Snapshot subprocess failed \(7\): git diagnostic$/,
    },
  ])(
    '05 验收 11、45: closed stdin with input=$input exit=$code gives $expected',
    async ({ input, code, expected }) => {
      const stdin = new WritableStream<Uint8Array>()
      await stdin.close()
      const child: ChildHandle = {
        pid: 12345,
        stdin,
        stdout: stream('result'),
        stderr: stream('git diagnostic'),
        exited: Promise.resolve({ code, signal: null }),
        kill: async () => {},
      }
      const process: HostProcess = { spawn: async () => child }
      const git = new SnapshotGit({ process, sandbox: new PassthroughSandbox(() => {}) })
      const result = git.command(
        ['/usr/bin/git', '--version'],
        '/tmp',
        '/tmp',
        new AbortController().signal,
        input,
      )
      const observed = await result.then(
        (value) => `ok:${value}`,
        (error: unknown) => `error:${error instanceof Error ? error.message : String(error)}`,
      )
      expect(observed).toMatch(expected)
    },
  )
})

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
it.each(['exact', 'prefix', 'truncated', 'group-changed'])(
  '05 验收 45: recovery ignores mismatched process fields without degrading (%s)',
  async (kind) => {
    const repo = await mkdtemp(join(tmpdir(), 'tenon-process-'))
    const argv = ['/usr/bin/git', `--git-dir=${repo}`, 'write-tree']
    await writeFile(
      join(repo, 'process.json'),
      JSON.stringify({
        pid: 12345,
        pgid: 12345,
        argv,
        executable: argv[0],
        startedAt: Date.now() - 10_000,
      }),
    )
    const git = new SnapshotGit(
      {
        process: {
          spawn: async () => {
            throw new Error('not used')
          },
        },
        sandbox: new PassthroughSandbox(() => {}),
      },
      'darwin',
    )
    const command = vi.spyOn(git, 'command').mockImplementation(async (actual) => {
      if (actual[0] === '/bin/kill') return ''
      const executable = kind === 'prefix' ? '/usr/bin/git-neighbor' : argv[0]
      return kind === 'truncated'
        ? '12345 12345 00:10\n'
        : `12345 ${kind === 'group-changed' ? 888 : 12345} 00:10 ${executable}\n`
    })
    try {
      const observed = await git.recoverProcess(repo, new AbortController().signal).then(
        () => 'ok',
        (error: unknown) => String(error),
      )
      expect(observed).toBe('ok')
      expect(command.mock.calls.filter(([args]) => args[0] === '/bin/kill')).toHaveLength(
        kind === 'exact' ? 1 : 0,
      )
      const remains = await readFile(join(repo, 'process.json'), 'utf8').catch(() => null)
      expect(remains).toBeNull()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  },
)

it('05 验收 45: recovery forgets an exited PID without sending any kill', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'tenon-process-'))
  const argv = ['/usr/bin/git', `--git-dir=${repo}`, 'write-tree']
  await writeFile(
    join(repo, 'process.json'),
    JSON.stringify({
      pid: 12345,
      pgid: 12345,
      argv,
      executable: argv[0],
      startedAt: Date.now() - 10_000,
    }),
  )
  const git = new SnapshotGit(
    {
      process: {
        spawn: async () => {
          throw new Error('not used')
        },
      },
      sandbox: new PassthroughSandbox(() => {}),
    },
    'darwin',
  )
  const command = vi
    .spyOn(git, 'command')
    .mockRejectedValue(Object.assign(new Error('process has exited'), { exitCode: 1 }))
  try {
    await git.recoverProcess(repo, new AbortController().signal)
    expect(command).toHaveBeenCalledTimes(1)
    expect(command.mock.calls[0]![0][0]).toBe('/bin/ps')
    await expect(readFile(join(repo, 'process.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

it.each([
  'exact',
  'reused-pid',
  'group-changed',
  'other-executable',
  'truncated',
  'within-tolerance',
] as const)(
  '05 验收 45: mac recovery identifies a spaced executable by pid, pgid and start time (%s)',
  async (kind) => {
    const parent = await mkdtemp(join(tmpdir(), 'tenon-process-'))
    const repo = join(parent, 'Application Support', 'repo')
    await mkdir(repo, { recursive: true })
    const executable = '/Applications/Developer Tools/usr/bin/git'
    const argv = [executable, `--git-dir=${repo}`, 'write-tree']
    const now = Date.now()
    await writeFile(
      join(repo, 'process.json'),
      JSON.stringify({
        pid: 12345,
        pgid: 12345,
        argv,
        executable,
        startedAt:
          now - (kind === 'reused-pid' ? 90_000 : kind === 'within-tolerance' ? 12_000 : 10_000),
      }),
    )
    const git = new SnapshotGit(
      {
        process: {
          spawn: async () => {
            throw new Error('not used')
          },
        },
        sandbox: new PassthroughSandbox(() => {}),
      },
      'darwin',
    )
    const time = vi.spyOn(Date, 'now').mockReturnValue(now)
    const command = vi.spyOn(git, 'command').mockImplementation(async (actual) => {
      if (actual[0] === '/bin/kill') return ''
      return kind === 'truncated'
        ? '12345 12345 00:10\n'
        : ` 12345 ${kind === 'group-changed' ? 67890 : 12345} 00:10 ${kind === 'other-executable' ? '/bin/sleep' : executable}\n`
    })
    try {
      await git.recoverProcess(repo, new AbortController().signal)
      expect(command.mock.calls.filter(([args]) => args[0] === '/bin/kill')).toHaveLength(
        kind === 'exact' || kind === 'within-tolerance' ? 1 : 0,
      )
      await expect(readFile(join(repo, 'process.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      time.mockRestore()
      await rm(parent, { recursive: true, force: true })
    }
  },
)

it('05 验收 45: a tracked process records its absolute executable and start time before exit', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'tenon-process-'))
  const exit = Promise.withResolvers<{ code: number; signal: null }>()
  const child: ChildHandle = {
    pid: 12345,
    stdin: new WritableStream(),
    stdout: stream('ok'),
    stderr: stream(''),
    exited: exit.promise,
    kill: async () => {},
  }
  const git = new SnapshotGit({
    process: { spawn: async () => child },
    sandbox: new PassthroughSandbox(() => {}),
  })
  const before = Date.now()
  const path = join(repo, 'process.json')
  const work = git.command(
    ['/usr/bin/git', '--version'],
    repo,
    repo,
    new AbortController().signal,
    undefined,
    path,
  )
  try {
    await vi.waitFor(async () => {
      const record = JSON.parse(await readFile(path, 'utf8')) as { startedAt: number }
      expect(record).toMatchObject({
        pid: 12345,
        pgid: 12345,
        executable: '/usr/bin/git',
        argv: ['/usr/bin/git', '--version'],
      })
      expect(record.startedAt).toBeGreaterThanOrEqual(before)
      expect(record.startedAt).toBeLessThanOrEqual(Date.now())
    })
  } finally {
    exit.resolve({ code: 0, signal: null })
    await work
    await rm(repo, { recursive: true, force: true })
  }
})
