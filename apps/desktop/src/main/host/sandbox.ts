import type { HostSandbox, SandboxRequest, SandboxViolation } from '@tenon-app/kernel'

export type SandboxLogger = (line: string) => void

/**
 * Phase 0: no sandbox yet. Commands pass through unchanged; anything that asked
 * for a restricted profile is logged as `sandbox: passthrough` so the gap is
 * visible. Phase 4 swaps this for sandbox-runtime behind the same interface.
 */
export class PassthroughSandbox implements HostSandbox {
  private readonly log: SandboxLogger

  constructor(log: SandboxLogger) {
    this.log = log
  }

  async wrap(request: SandboxRequest): Promise<{ argv: string[]; env: Record<string, string> }> {
    if (request.profile !== 'full-access') {
      this.log(`sandbox: passthrough ${request.commandId} ${request.profile}`)
    }
    return { argv: [...request.argv], env: { ...request.env } }
  }

  async afterExit(_commandId: string): Promise<void> {}

  async violations(_commandId: string): Promise<SandboxViolation[]> {
    return []
  }
}
