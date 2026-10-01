/**
 * The session's model choice across IPC (spec 02 验收 13; plan step 19): `session.modelChoice`'s
 * response restates the kernel's `ModelChoice`, and `session.selectModel`'s request its fields; both
 * directions are checked, so a field added on either side is a compile error here.
 */
import type { ModelChoice } from '@tenon-app/kernel'
import type { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { sessionModelChoiceResponse, sessionSelectModel } from '../src/index.js'
import type { SessionModelChoice } from '../src/index.js'

type Assert<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export type ChoiceIsKernelChoice = Assert<Equal<SessionModelChoice, Mutable<ModelChoice>>>
export type SelectCarriesTheChoice = Assert<
  Equal<
    Omit<z.infer<typeof sessionSelectModel.request>, 'sessionId'>,
    Omit<Mutable<ModelChoice>, 'capabilitySource'>
  >
>

describe('the session model choice', () => {
  it('takes a hand-typed id and a null effort, and names where the capabilities came from', () => {
    expect(
      sessionSelectModel.request.safeParse({
        sessionId: '0f1d9a2e-6b3d-4a71-9f52-0c8de7a11b71',
        providerId: 'anthropic',
        modelId: 'my-own-model',
        effort: null,
      }).success,
    ).toBe(true)
    // M6 02 修补 2: `probed` is a custom instance's row that passed its probe; nothing else joins.
    const custom = 'custom-0f1d9a2e-6b3d-4a71-9f52-0c8de7a11b71'
    const answer = (capabilitySource: string) =>
      sessionModelChoiceResponse.safeParse({
        providerId: custom,
        modelId: 'deepseek-flash',
        effort: null,
        capabilitySource,
      }).success
    expect(answer('probed')).toBe(true)
    expect(answer('guessed')).toBe(false)
  })
})
