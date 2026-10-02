/**
 * The custom vendor contracts (M6 §IPC, §存储) and the kernel shapes they restate.
 *
 * Contracts may not import the kernel at runtime (see session-types.test.ts), so the instance id
 * pattern, the probe snapshot and the wire union are written twice. The type assertions below fail
 * to compile the moment either side gains or loses a member; the id pattern is a value, so it is
 * compared at runtime. The new values M6 adds to the kernel's existing unions (02 修补 2, 3) are
 * pinned against the facts that record them.
 */
import type {
  CapabilitySource,
  ModelSelectedPayload,
  ProbeReason,
  ProbeSnapshot,
  ProviderDefinition,
  RunAssembly,
  ToolsWithheldPayload,
} from '@tenon-app/kernel'
import { CUSTOM_PROVIDER_ID_PATTERN } from '@tenon-app/kernel'
import type { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  CUSTOM_ID_REGEX,
  customProviderIdSchema,
  customVendorCreate,
  customVendorSchema,
  customVendorUpdate,
  probeSnapshotSchema,
} from '../src/index.js'
import type { SessionModelChoice, probeReasonSchema, wireSchema } from '../src/index.js'
import { providerIdSchema } from '../src/ipc/provider.js'

type Assert<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

// Exported so `noUnusedLocals` keeps them; nothing imports them.
export type SnapshotIsKernelSnapshot = Assert<
  Equal<z.infer<typeof probeSnapshotSchema>, ProbeSnapshot>
>
export type ReasonIsKernelReason = Assert<Equal<z.infer<typeof probeReasonSchema>, ProbeReason>>
export type WireIsKernelWire = Assert<Equal<z.infer<typeof wireSchema>, ProviderDefinition['wire']>>
export type ChoiceSourceIsKernelSource = Assert<
  Equal<SessionModelChoice['capabilitySource'], CapabilitySource>
>
export type SelectedFactSourceIsKernelSource = Assert<
  Equal<NonNullable<ModelSelectedPayload['capabilitySource']>, CapabilitySource>
>
// 02 spec:366, 02 修补 3: the assembly's marks are exactly the fact's reasons other than
// 'model-without-tools', which the kernel decides alone (A15).
export type WithheldMarksAreTheFactReasons = Assert<
  Equal<
    NonNullable<RunAssembly['toolsWithheld']>,
    Exclude<ToolsWithheldPayload['reason'], 'model-without-tools'>
  >
>

const ID = 'custom-0f1d9a2e-6b3d-4a71-9f52-0c8de7a11b71'
const ROW = { id: 'deepseek-flash', contextLimit: 1_000_000, maxOutputTokens: 64_000 }

function create(source: Record<string, unknown>): boolean {
  return customVendorCreate.request.safeParse({
    displayName: 'DeepSeek',
    wire: 'openai-chat',
    source,
    apiKey: '',
  }).success
}

function vendor(models: readonly (typeof ROW)[], id = ID): boolean {
  return customVendorSchema.safeParse({
    id,
    displayName: 'DeepSeek',
    wire: 'openai-chat',
    baseURL: 'https://api.deepseek.com',
    models,
  }).success
}

describe('the custom vendor contracts', () => {
  it('restate the kernel instance id pattern character for character', () => {
    expect(CUSTOM_ID_REGEX.source).toBe(CUSTOM_PROVIDER_ID_PATTERN.source)
    expect(CUSTOM_ID_REGEX.flags).toBe(CUSTOM_PROVIDER_ID_PATTERN.flags)
  })

  it('take an instance id only as custom- and a lowercase canonical UUID (T1)', () => {
    expect(customProviderIdSchema.safeParse(ID).success).toBe(true)
    expect(ID).toHaveLength(43)
    expect(providerIdSchema.safeParse(ID).success).toBe(true)
    const refused = [
      ID.toUpperCase(),
      `custom-${ID.slice(7).toUpperCase()}`,
      ID.replace('custom-', 'custom:'),
      ID.slice(7),
      `${ID}0`,
      'custom-0f1d9a2e6b3d4a719f520c8de7a11b71',
      'zhipu',
    ]
    expect(refused.filter((id) => customProviderIdSchema.safeParse(id).success)).toEqual([])
  })

  it('take no address or wire in customVendor.update (T2)', () => {
    const update = (extra: Record<string, unknown>) =>
      customVendorUpdate.request.safeParse({ id: ID, displayName: 'DeepSeek', ...extra }).success
    expect(update({ models: [ROW] })).toBe(true)
    expect(update({ baseURL: 'https://api.deepseek.com' })).toBe(false)
    expect(update({ wire: 'anthropic-messages' })).toBe(false)
    // A row's probe is main's to write; the card cannot hand one in.
    const passed = {
      outcome: 'passed',
      reason: null,
      probedAt: 1,
      reasoningField: 'reasoning_content',
      maxTokensField: 'max_tokens',
      usageSeen: true,
      responseModelId: null,
      unknownFields: [],
    }
    expect(probeSnapshotSchema.safeParse(passed).success).toBe(true)
    expect(update({ models: [{ ...ROW, probe: passed }] })).toBe(false)
  })

  it('let a preset source name a preset and a region, never an address (§IPC)', () => {
    expect(create({ kind: 'preset', presetId: 'deepseek', regionId: 'default' })).toBe(true)
    expect(create({ kind: 'custom', baseURL: 'https://api.deepseek.com' })).toBe(true)
    expect(
      create({
        kind: 'preset',
        presetId: 'deepseek',
        regionId: 'default',
        baseURL: 'https://elsewhere.example',
      }),
    ).toBe(false)
  })

  it('store an entry only under an instance id, with distinct row ids (T1, §存储)', () => {
    expect(vendor([ROW, { ...ROW, id: 'deepseek-pro' }])).toBe(true)
    expect(vendor([ROW, { ...ROW, maxOutputTokens: 8_000 }])).toBe(false)
    // A stored entry is an instance (T1): a built-in id or an uppercase one does not read.
    expect(vendor([ROW], 'zhipu')).toBe(false)
    expect(vendor([ROW], `custom-${ID.slice(7).toUpperCase()}`)).toBe(false)
    expect(customVendorUpdate.request.safeParse({ id: ID, models: [ROW, ROW] }).success).toBe(false)
  })
})
