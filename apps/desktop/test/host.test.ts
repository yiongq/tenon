import { absolutePath } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { IpcConfirm } from '../src/main/host/confirm.js'
import { useMemorySecrets } from '../src/main/host/index.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'
import { MemorySecrets } from '../src/main/host/secrets.js'

describe('PassthroughSandbox', () => {
  const base = {
    argv: ['/bin/ls', '-la'],
    cwd: absolutePath('/w'),
    env: { PATH: '/bin' },
    workspace: [absolutePath('/w')],
  }

  it('returns the command unchanged and logs every restricted profile', async () => {
    const lines: string[] = []
    const sandbox = new PassthroughSandbox((line) => lines.push(line))
    expect(await sandbox.wrap({ ...base, commandId: 'c1', profile: 'full-access' })).toEqual({
      argv: base.argv,
      env: base.env,
    })
    expect(lines).toEqual([])
    await sandbox.wrap({ ...base, commandId: 'c2', profile: 'workspace-write' })
    await sandbox.wrap({ ...base, commandId: 'c3', profile: 'read-only' })
    expect(lines).toEqual([
      'sandbox: passthrough c2 workspace-write',
      'sandbox: passthrough c3 read-only',
    ])
  })
})

describe('IpcConfirm', () => {
  const request = {
    requestId: 'r1',
    sessionId: 's1',
    kind: 'command' as const,
    reason: 'elevated' as const,
    facts: { command: 'sudo make install' },
  }

  it('never sends the redacted payload to the renderer', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = []
    const confirm = new IpcConfirm((channel, payload) => sent.push({ channel, payload }))
    await confirm.request({ ...request, redacted: { authorization: 'Bearer secret' } })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.channel).toBe('confirm.request')
    expect(sent[0]?.payload).toEqual(request)
    expect(JSON.stringify(sent[0]?.payload)).not.toContain('secret')
  })

  it('does not deliver a request that misses a required fact', async () => {
    const sent: unknown[] = []
    const confirm = new IpcConfirm((_channel, payload) => sent.push(payload))
    await expect(confirm.request({ ...request, facts: {} })).rejects.toThrow(/facts\.command/)
    expect(sent).toEqual([])
  })
})

/**
 * The e2e secrets seam (spec 01 §desktop 接线). It is a security boundary in both directions: a
 * packaged build must never take its credential store from the environment, and an automated run
 * must never write into the developer's login keychain.
 */
describe('the secrets seam', () => {
  it('leaves the OS keychain in place unless a dev build asks for memory', () => {
    expect(useMemorySecrets(false, {})).toBe(false)
    expect(useMemorySecrets(false, { TENON_SECRETS: 'memory' })).toBe(true)
    expect(useMemorySecrets(false, { TENON_SECRETS: 'keychain' })).toBe(false)
    expect(useMemorySecrets(true, { TENON_SECRETS: 'memory' })).toBe(false)
  })

  it('keeps memory secrets in this process and forgets a deleted one', async () => {
    const secrets = new MemorySecrets()
    expect(await secrets.get('tenant:provider:anthropic:apiKey')).toBeNull()
    await secrets.set('tenant:provider:anthropic:apiKey', 'k')
    expect(await secrets.get('tenant:provider:anthropic:apiKey')).toBe('k')
    await secrets.delete('tenant:provider:anthropic:apiKey')
    expect(await secrets.get('tenant:provider:anthropic:apiKey')).toBeNull()
  })
})
