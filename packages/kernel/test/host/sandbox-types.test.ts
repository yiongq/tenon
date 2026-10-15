/**
 * Spec 04 §对 00 的修补 1–2: `HostSandbox` gains only the optional `posture`, `SandboxViolation`
 * only four optional members, and `SandboxPosture` is exported from the package root. These are
 * type pins, checked by `pnpm typecheck`; the expected shapes are copied from the spec, not derived.
 */
import { describe, expectTypeOf, it } from 'vitest'
import type { HostSandbox, SandboxPosture, SandboxViolation } from '../../src/index.js'

describe('04 对 00 的修补 (types)', () => {
  it('04 对 00 的修补 1: SandboxPosture, and HostSandbox only gains the optional posture()', () => {
    expectTypeOf<SandboxPosture>().toEqualTypeOf<{
      readonly state: 'pending' | 'active' | 'degraded' | 'unavailable'
      readonly profile: 'read-only' | 'workspace-write'
    }>()
    expectTypeOf<keyof HostSandbox>().toEqualTypeOf<
      'wrap' | 'afterExit' | 'violations' | 'posture'
    >()
    expectTypeOf<HostSandbox['posture']>().toEqualTypeOf<(() => SandboxPosture) | undefined>()
  })

  it('04 对 00 的修补 2: SandboxViolation gains exactly four optional members', () => {
    expectTypeOf<SandboxViolation>().toEqualTypeOf<{
      kind: 'fs' | 'network'
      line: string
      target?: string
      release?: 'domain' | 'path'
      protected?: true
      observed?: true
    }>()
  })
})
