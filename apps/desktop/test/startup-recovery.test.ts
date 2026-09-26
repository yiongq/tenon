/**
 * Startup recovery on the desktop (spec 02 §启动恢复与发送防护, §e2e 接缝; plan step 16): `recover()`
 * once, a gate that always opens, and a delay only a development build honours.
 */
import type { SessionService } from '@tenon-app/kernel'
import { describe, expect, it } from 'vitest'
import { RECOVERY_DELAY_ENV, recoveryDelayMs, startRecovery } from '../src/main/startup-recovery.js'

function stub(recover: SessionService['recover']): SessionService {
  return { recover } as unknown as SessionService
}

describe('startup recovery', () => {
  it('reads the e2e delay only in a development build, and only as a whole number', () => {
    expect(recoveryDelayMs(false, { [RECOVERY_DELAY_ENV]: '250' })).toBe(250)
    expect(recoveryDelayMs(true, { [RECOVERY_DELAY_ENV]: '250' })).toBe(0)
    expect(recoveryDelayMs(false, {})).toBe(0)
    expect(recoveryDelayMs(false, { [RECOVERY_DELAY_ENV]: 'soon' })).toBe(0)
  })

  it('opens the gate once recovery is done, and logs what it reported', async () => {
    const logs: string[] = []
    let calls = 0
    const gate = startRecovery({
      sessions: stub(() => {
        calls += 1
        return Promise.resolve({
          resumable: [{ rootSessionId: 'r', sessionId: 'r', runId: 'x' }],
          errors: ['[recovery] one broken call'],
        })
      }),
      delayMs: 0,
      log: (line) => logs.push(line),
    })
    await gate.ready
    expect(calls).toBe(1)
    expect(logs).toEqual([
      '[recovery] one broken call',
      '[recovery] 1 session(s) can be resumed when opened',
    ])
  })

  it('opens the gate even when recovery fails: only the log hears of it', async () => {
    const logs: string[] = []
    const gate = startRecovery({
      sessions: stub(() => Promise.reject(new Error('the store is gone'))),
      delayMs: 0,
      log: (line) => logs.push(line),
    })
    await expect(gate.ready).resolves.toBeUndefined()
    expect(logs).toEqual(['[recovery] failed: the store is gone'])
  })

  it('has nothing to wait for without a store', async () => {
    await expect(
      startRecovery({ sessions: null, delayMs: 0, log: () => {} }).ready,
    ).resolves.toBeUndefined()
  })
})
