/** Spec 05 D57: deterministic child-stream semantics, independent of OS scheduling. */
import type { ChildHandle, HostProcess } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
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
