import { setTimeout as sleep } from 'node:timers/promises'
import type { SessionService } from '@tenon-app/kernel'

/**
 * Startup recovery (spec 02 §启动恢复与发送防护): `recover()` right after `bindLoop`, as a promise that
 * always resolves. Every write route — and `session.latest`, `approval.*` — awaits it first, so what
 * a crash left open is closed on the Tape before any request goes out. A failure only reaches the
 * log and the gate opens anyway: before each request the kernel checks the pairing again (B1).
 */
export interface RecoveryGate {
  readonly ready: Promise<void>
}

/**
 * The e2e seam: how many milliseconds recovery waits before it starts, so a test can reach the
 * window while the gate is still shut. Development builds only, like `TENON_SECRETS=memory`.
 */
export const RECOVERY_DELAY_ENV = 'TENON_E2E_RECOVERY_DELAY_MS'

export function recoveryDelayMs(
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
): number {
  if (isPackaged) return 0
  const raw = env[RECOVERY_DELAY_ENV]
  if (raw === undefined || !/^\d+$/.test(raw)) return 0
  return Number(raw)
}

export function startRecovery(q: {
  readonly sessions: SessionService | null
  readonly delayMs: number
  readonly log: (line: string) => void
}): RecoveryGate {
  const { sessions } = q
  if (sessions === null) return { ready: Promise.resolve() }
  const ready = (async (): Promise<void> => {
    if (q.delayMs > 0) await sleep(q.delayMs)
    const recovered = await sessions.recover()
    for (const error of recovered.errors) q.log(error)
    if (recovered.resumable.length > 0) {
      q.log(
        `[recovery] ${String(recovered.resumable.length)} session(s) can be resumed when opened`,
      )
    }
  })().catch((error: unknown) => {
    q.log(`[recovery] failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  return { ready }
}
