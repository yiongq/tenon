import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainLike } from '@tenon-app/contracts'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createSessionService,
  createTape,
  permissionDecidedKey,
  toolCallKey,
  toolOutcomeKey,
} from '@tenon-app/kernel'
import type { SessionService } from '@tenon-app/kernel'
import { createCounterIds, createTestLoopPorts } from '@tenon-app/kernel/testing'
import { readConfig, watchConfig, writeConfig } from '../src/main/host/profile.js'
import { reason } from '../src/main/host/sandbox-posture.js'
import { registerSandboxRoutes } from '../src/main/sandbox-routes.js'
import { refuseWhileShuttingDown } from '../src/main/shutdown.js'
import { wiringFixture } from './sandbox/wiring-support.js'

const SESSION = 'b6e30bed-0e02-4f29-8e20-0010e83e2190'
const RUN = 'b6e30bed-0e02-4f29-8e20-0010e83e2193'
const CALL = 'b6e30bed-0e02-4f29-8e20-0010e83e2193:0:0'
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
})

const VIEW = {
  posture: { state: 'active', profile: 'workspace-write' },
  platform: 'darwin',
  reasons: [],
  settings: { profile: 'workspace-write', allowedDomains: [], packageManagers: false },
  preset: {
    domains: [
      'registry.npmjs.org',
      'pypi.org',
      'files.pythonhosted.org',
      'index.crates.io',
      'static.crates.io',
    ],
    writable: [
      '/data/sandbox-cache/npm',
      '/data/sandbox-cache/pnpm',
      '/data/sandbox-cache/uv',
      '/data/sandbox-cache/cargo',
    ],
  },
}

async function harness(
  options: {
    sessions?: Pick<SessionService, 'release'> | null
    gate?: Promise<void>
  } = {},
) {
  const host = createMemoryHost({ identity: { profileDir: `/profiles/${randomUUID()}` } })
  await host.fs.mkdirp(absolutePath(host.identity.profileDir))
  const sandbox = wiringFixture()
  cleanup.push(watchConfig(host.identity, (next) => sandbox.setSettings(next.sandbox)))
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc: IpcMainLike = {
    handle: (channel, listener) => void handlers.set(channel, listener),
  }
  let shuttingDown = false
  const send = vi.fn<(channel: string, payload: unknown) => void>()
  const release = vi.fn<SessionService['release']>(async () => ({ status: 'refused' }))
  const routes = registerSandboxRoutes({
    ipcMain: refuseWhileShuttingDown(ipc, () => shuttingDown),
    host,
    sandbox: sandbox.runtime,
    sessions: options.sessions === undefined ? { release } : options.sessions,
    send,
    ...(options.gate === undefined ? {} : { gate: options.gate }),
  })
  return {
    ...sandbox,
    host,
    send,
    release,
    routes,
    shutdown: () => {
      shuttingDown = true
    },
    async start() {
      await sandbox.runtime.start().outcome
      routes.changed()
    },
    async call(channel: string, payload: unknown = {}) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`missing handler: ${channel}`)
      return handler({}, payload)
    },
  }
}

/** Seed an actual kernel receipt so the route's security test cannot pass with a stale-only stub. */
async function receiptService() {
  const host = createMemoryHost()
  const store = createMemoryTapeStore({ identity: host.identity })
  const loop = createTestLoopPorts()
  const sessions = createSessionService({
    host,
    tape: store,
    ids: createCounterIds(),
    inspectors: [],
    connector: loop.connector,
    protectedFiles: [],
  })
  sessions.bindLoop(loop)
  const head = await sessions.createSession({ sessionId: SESSION })
  const tape = createTape(store)
  const fields = { sourceType: 'runtime_event' as const, sourceId: RUN, sourceSeq: 0, createdAt: 1 }
  const ref = { ordinal: 0, providerToolCallId: 'receipt-call' }
  await tape.appendEntries({
    sessionId: SESSION,
    incarnationId: head.incarnationId,
    entries: [
      tape.writer('tool').entry('tool/call', {
        ...fields,
        provenanceKey: toolCallKey(RUN, 0, 0),
        payload: {
          ...ref,
          messageId: 'b6e30bed-0e02-4f29-8e20-0010e83e2194',
          name: 'Bash',
          input: { command: 'echo hello' },
          argsHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      }),
      tape.writer('tool').entry('tool/permission_decided', {
        ...fields,
        provenanceKey: permissionDecidedKey(RUN, 0, 0),
        payload: {
          ...ref,
          argsHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          reversibility: 'unknown',
          record: { verdict: 'allow', decidedBy: 'user-grant', steps: [] },
          summary: { verdict: 'allow', code: 'session-allowed', facts: { toolName: 'Bash' } },
          target: { type: 'command', command: 'echo hello', cwd: absolutePath('/work/project') },
          policyVersion: 'test',
          writer: { by: 'resolver' },
        },
      }),
      tape.writer('execution').entry('execution/tool_outcome', {
        ...fields,
        provenanceKey: toolOutcomeKey(RUN, 0, 0),
        payload: {
          ...ref,
          state: 'completed',
          effect: 'external',
          source: 'sandbox',
          kernelAuthored: false,
          sandbox: {
            violations: [
              {
                kind: 'network',
                target: 'registry.example.com',
                release: 'domain',
                protected: false,
                observed: false,
              },
            ],
            more: 0,
            anyProtected: false,
          },
          writer: { by: 'resolver' },
        },
      }),
    ],
  })
  return { sessions, tape }
}

describe('04 sandbox IPC routes', () => {
  it('04 验收 31: release with a forged target answers stale and writes nothing', async () => {
    const { sessions, tape } = await receiptService()
    const h = await harness({ sessions })
    const before = await tape.readRange({ sessionId: SESSION, limit: 100 })
    expect(
      await h.call('sandbox.release', {
        sessionId: SESSION,
        callKey: CALL,
        action: 'allow-domain',
        target: 'forged.example.com',
      }),
    ).toEqual({ ok: true, data: { status: 'stale' } })
    expect(await tape.readRange({ sessionId: SESSION, limit: 100 })).toEqual(before)
    expect(
      await h.call('sandbox.release', {
        sessionId: SESSION,
        callKey: CALL,
        action: 'allow-domain',
        target: 'registry.example.com',
      }),
    ).toEqual({ ok: true, data: { status: 'released' } })
    expect(
      await h.call('sandbox.release', {
        sessionId: SESSION,
        callKey: CALL,
        action: 'allow-domain',
        target: 'registry.example.com',
      }),
    ).toEqual({ ok: true, data: { status: 'already-released' } })
    const written = await tape.readRange({ sessionId: SESSION, limit: 100 })
    expect(written.entries.filter((entry) => entry.name === 'tool/receipt_override')).toHaveLength(
      1,
    )
    expect(written.entries.at(-1)?.payload).toEqual({
      ordinal: 0,
      providerToolCallId: 'receipt-call',
      action: 'allow-domain',
      target: 'registry.example.com',
      violation: 0,
      command: 'echo hello',
      cwd: '/work/project',
      via: 'receipt-override',
      writer: { by: 'resolver' },
    })
  })

  it('04 验收 31: setSettings refuses an invalid domain with its index', async () => {
    const h = await harness()
    const before = await readConfig(h.host.fs, h.host.identity)
    expect(
      await h.call('sandbox.setSettings', {
        profile: 'read-only',
        allowedDomains: ['valid.example.com', '*.com', 'other.example.com'],
      }),
    ).toEqual({ ok: true, data: { ok: false, code: 'invalid-domain', index: 1 } })
    expect(await readConfig(h.host.fs, h.host.identity)).toEqual(before)
    expect(h.send).not.toHaveBeenCalled()
    expect(
      await h.call('sandbox.setSettings', { allowedDomains: Array(257).fill('example.com') }),
    ).toEqual({ ok: true, data: { ok: false, code: 'too-many' } })
    expect(await readConfig(h.host.fs, h.host.identity)).toEqual(before)
  })

  it('04 验收 31: setSettings normalizes entries and merges concurrent patches under the config lock', async () => {
    const h = await harness()
    await h.start()
    await writeConfig(h.host.fs, h.host.identity, { locale: 'en' })
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(
      await Promise.all([
        h.call('sandbox.setSettings', {
          profile: 'read-only',
          allowedDomains: ['EXAMPLE.COM', 'example.com', 'localhost:3000'],
        }),
        h.call('sandbox.setSettings', { packageManagers: true }),
      ]),
    ).toEqual([
      { ok: true, data: { ok: true } },
      { ok: true, data: { ok: true } },
    ])
    expect((await readConfig(h.host.fs, h.host.identity)).sandbox).toEqual({
      profile: 'read-only',
      allowedDomains: ['example.com', 'localhost:3000'],
      packageManagers: true,
    })
    expect((await readConfig(h.host.fs, h.host.identity)).locale).toBe('en')
    expect(h.send).toHaveBeenCalledTimes(3)
    expect(h.send).toHaveBeenLastCalledWith('sandbox.changed', {
      ...VIEW,
      posture: { state: 'active', profile: 'read-only' },
      settings: {
        profile: 'read-only',
        allowedDomains: ['example.com', 'localhost:3000'],
        packageManagers: true,
      },
    })
  })

  it('04 验收 31: a failed settings write reports write-failed without a change event', async () => {
    const h = await harness()
    const write = vi.spyOn(h.host.fs, 'writeFile').mockRejectedValue(new Error('disk full'))
    try {
      expect(await h.call('sandbox.setSettings', { packageManagers: true })).toEqual({
        ok: true,
        data: { ok: false, code: 'write-failed' },
      })
      expect(h.send).not.toHaveBeenCalled()
      expect((await readConfig(h.host.fs, h.host.identity)).sandbox).toEqual({
        profile: 'workspace-write',
        allowedDomains: [],
        packageManagers: false,
      })
    } finally {
      write.mockRestore()
    }
  })

  it('04 验收 31: release answers the envelope error once shutdown began; setSettings still answers', async () => {
    const h = await harness()
    h.shutdown()
    expect(
      await h.call('sandbox.release', {
        sessionId: SESSION,
        callKey: CALL,
        action: 'allow-domain',
        target: 'registry.example.com',
      }),
    ).toEqual({
      ok: false,
      error: { code: 'handler-failed', message: 'the app is shutting down' },
    })
    expect(h.release).not.toHaveBeenCalled()
    expect(await h.call('sandbox.setSettings', { profile: 'read-only' })).toEqual({
      ok: true,
      data: { ok: true },
    })
    expect(await h.call('sandbox.get')).toMatchObject({
      ok: true,
      data: { settings: { profile: 'read-only' } },
    })
  })

  it('04 验收 31: release passes the callKey to the kernel unparsed', async () => {
    const gate = Promise.withResolvers<void>()
    const h = await harness({ gate: gate.promise })
    const request = {
      sessionId: SESSION,
      callKey: 'opaque:call:key:with:extra:parts',
      action: 'allow-domain',
      target: 'MixedCase.example.com',
    }
    const answer = h.call('sandbox.release', request)
    await Promise.resolve()
    expect(h.release).not.toHaveBeenCalled()
    gate.resolve()
    expect(await answer).toEqual({ ok: true, data: { status: 'refused' } })
    expect(h.release).toHaveBeenCalledExactlyOnceWith({
      sessionId: SESSION,
      callKey: 'opaque:call:key:with:extra:parts',
      action: 'allow-domain',
      target: 'MixedCase.example.com',
    })
  })

  it('04 验收 31: release without a session store answers not-found', async () => {
    const h = await harness({ sessions: null })
    expect(
      await h.call('sandbox.release', {
        sessionId: SESSION,
        callKey: CALL,
        action: 'rerun-unsandboxed',
        target: null,
      }),
    ).toEqual({ ok: true, data: { status: 'not-found' } })
  })

  it('04 不变量 12 (IPC): no response carries the proxy port or token', async () => {
    const h = await harness()
    // Private srt state and wrapper internals must never become a response or event field.
    Object.assign(h.outcome.session!, { httpProxyPort: 49123, proxyToken: 'private-proxy-token' })
    Object.assign(h.runtime, { proxyPort: 49123, proxyToken: 'private-proxy-token' })
    await h.start()
    expect(await h.call('sandbox.get')).toEqual({ ok: true, data: VIEW })
    expect(h.send.mock.calls).toEqual([['sandbox.changed', VIEW]])
    expect(await h.call('sandbox.setSettings', {})).toEqual({ ok: true, data: { ok: true } })
    expect(h.send).toHaveBeenCalledTimes(1)
    const wire = JSON.stringify([await h.call('sandbox.get'), h.send.mock.calls])
    expect(wire).not.toContain('49123')
    expect(wire).not.toContain('private-proxy-token')
  })

  it('04 验收 31: get includes startup reasons and the signal reset reason', async () => {
    const h = await harness()
    Object.assign(h.outcome, {
      state: 'degraded',
      reasons: [reason('old-bwrap', 'bwrap is older than 0.8.0')],
    })
    await h.start()
    expect(h.send).toHaveBeenLastCalledWith('sandbox.changed', {
      ...VIEW,
      posture: { state: 'degraded', profile: 'workspace-write' },
      reasons: [{ code: 'old-bwrap', detail: 'bwrap is older than 0.8.0' }],
    })
    for (const signal of h.signals) signal()
    expect(await h.call('sandbox.get')).toEqual({
      ok: true,
      data: {
        ...VIEW,
        posture: { state: 'unavailable', profile: 'workspace-write' },
        reasons: [
          { code: 'old-bwrap', detail: 'bwrap is older than 0.8.0' },
          { code: 'init-failed', detail: 'reset by a signal' },
        ],
      },
    })
  })
})
