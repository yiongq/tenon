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

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
it.each(['exact', 'prefix', 'truncated', 'group-changed'])(
  '05 验收 45: recovery checks recorded argv and process group (%s)',
  async (kind) => {
    const repo = await mkdtemp(join(tmpdir(), 'tenon-process-'))
    const argv = ['/usr/bin/git', `--git-dir=${repo}`, 'write-tree']
    await writeFile(join(repo, 'process.json'), JSON.stringify({ pid: 12345, pgid: 12345, argv }))
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
      const tokens =
        kind === 'prefix'
          ? [argv[0], `--git-dir=${repo}-neighbor`, 'write-tree']
          : kind === 'truncated'
            ? argv.slice(0, 2)
            : argv
      return `${kind === 'group-changed' ? 888 : 12345} ${tokens.join(' ')}\n`
    })
    try {
      const observed = await git.recoverProcess(repo, new AbortController().signal).then(
        () => 'ok',
        (error: unknown) => String(error),
      )
      expect(observed).toMatch(kind === 'exact' ? /^ok$/ : /verify/)
      expect(command.mock.calls.filter(([args]) => args[0] === '/bin/kill')).toHaveLength(
        kind === 'exact' ? 1 : 0,
      )
      const remains = await readFile(join(repo, 'process.json'), 'utf8').catch(() => null)
      expect(remains === null).toBe(kind === 'exact')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  },
)

it('05 验收 45: recovery forgets an exited PID without sending any kill', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'tenon-process-'))
  const argv = ['/usr/bin/git', `--git-dir=${repo}`, 'write-tree']
  await writeFile(join(repo, 'process.json'), JSON.stringify({ pid: 12345, pgid: 12345, argv }))
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
