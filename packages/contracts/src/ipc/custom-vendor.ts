import { z } from 'zod'
import { defineRoute } from '../route.js'
import { PROVIDER_VALUE_MAX_LENGTH, modelIdSchema, providerRefusalSchema } from './provider.js'

/**
 * Custom vendors over IPC (M6 §IPC, §存储): the instances in `config.json`, the presets, and the
 * seven routes the settings card's instance section uses.
 *
 * The rule of `provider.ts` holds here too: a key travels renderer → main only, inside
 * `customVendor.create`'s request, and no response has a field one could travel back in. A later
 * key is saved through `provider.configure`, where an instance declares `apiKey` alone.
 *
 * T2 at the route layer (§IPC): `customVendor.update` is `.strict()`, so a request naming `wire`
 * or `baseURL` fails the schema; `provider.configure` takes any key name in its schema, and its
 * handler refuses `baseURL` for an instance with `invalid-value` (provider-routes.ts).
 *
 * The shapes restate the kernel's (`CUSTOM_PROVIDER_ID_PATTERN`, `ProbeSnapshot`, the wire union)
 * rather than importing them, for the reason `session.ts` gives; a contracts test holds each pair
 * to one shape.
 */

/** T1: `custom-` and a lowercase canonical UUID — the kernel's `CUSTOM_PROVIDER_ID_PATTERN`. */
export const CUSTOM_ID_REGEX =
  /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const customProviderIdSchema = z.string().regex(CUSTOM_ID_REGEX)

export const wireSchema = z.enum(['openai-chat', 'anthropic-messages'])

/** §探测「结果与原因码」; each code has `customVendor.probe.reason.<code>` in both locales. */
export const probeReasonSchema = z.enum([
  'no-tool-call',
  'output-limit',
  'no-finish',
  'config',
  'auth',
  'quota',
  'rate-limit',
  'request-rejected',
  'echo-rejected',
  'bad-tool-call',
  'opaque-fields',
  'service',
])

/** One probe's result, stored per (instance, model) (T3): no expiry, no key fingerprint. */
export const probeSnapshotSchema = z.object({
  outcome: z.enum(['passed', 'not-detected', 'failed']),
  /** null when passed. */
  reason: probeReasonSchema.nullable(),
  /** `HostClock` epoch ms, shown only. */
  probedAt: z.number().int().nonnegative(),
  /** The thinking field the openai-chat wire saw; always null on anthropic-messages. */
  reasoningField: z.enum(['reasoning_content', 'reasoning']).nullable(),
  /** Always null on anthropic-messages (T10). */
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).nullable(),
  /** A usage reading arrived on the standard path. */
  usageSeen: z.boolean(),
  /** Shown only, never judged (Q5). */
  responseModelId: z.string().max(200).nullable(),
  /** Q14: key names only, never values. */
  unknownFields: z.array(z.string().max(64)).max(16),
})

/** A model row: its limits are the user's (T6), its probe is optional (none = never probed). */
export const customModelSchema = z.object({
  id: modelIdSchema,
  contextLimit: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  probe: probeSnapshotSchema.optional(),
})

/** Rows are addressed by id, so the ids of one instance are distinct (§存储). */
const distinctIds = (rows: readonly { id: string }[]): boolean =>
  new Set(rows.map((row) => row.id)).size === rows.length

/** One entry of `config.json`'s `customVendors` (T8); written by the main process only. */
export const customVendorSchema = z.object({
  id: customProviderIdSchema,
  displayName: z.string().trim().min(1).max(64),
  wire: wireSchema,
  baseURL: z.string().min(1).max(PROVIDER_VALUE_MAX_LENGTH),
  /** Only to show which preset it was created from. */
  presetId: z.string().min(1).max(64).optional(),
  models: z
    .array(customModelSchema)
    .max(200)
    .refine(distinctIds, { error: 'model ids must be distinct within an instance' }),
})
export type CustomVendorContract = z.infer<typeof customVendorSchema>

export const customVendorErrorCodeSchema = z.enum([
  // §地址校验
  'invalid-address',
  'https-required',
  'subscription-endpoint',
  // A public instance created without a key.
  'key-required',
  // The instance no longer exists.
  'not-found',
  // A keychain read, write or delete failed; nothing changed, or §写入规则 rolled it back.
  'keychain',
])
export type CustomVendorErrorCode = z.infer<typeof customVendorErrorCodeSchema>

export const customVendorWriteResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: customVendorErrorCodeSchema }),
])

/** §预设: a vendor's name, its regions, each region's base URL per wire and its key page. */
export const vendorPresetSchema = z.object({
  id: z.string().min(1),
  nameKey: z.string().min(1),
  defaultWire: wireSchema,
  regions: z.array(
    z.object({
      id: z.string().min(1),
      labelKey: z.string().min(1),
      keyPageURL: z.string().url().nullable(),
      endpoints: z.object({
        'openai-chat': z.string().url().optional(),
        'anthropic-messages': z.string().url().optional(),
      }),
    }),
  ),
})

/** The presets and the instances; `refused` marks an entry whose address fails §地址校验 (§存储). */
export const customVendorList = defineRoute('customVendor.list', {
  request: z.object({}),
  response: z.object({
    presets: z.array(vendorPresetSchema),
    instances: z.array(customVendorSchema.extend({ refused: providerRefusalSchema.optional() })),
  }),
})

/**
 * A preset source names a preset and a region, and main looks the address up (§IPC): the renderer
 * cannot hand in a preset address of its own.
 */
export const customVendorCreate = defineRoute('customVendor.create', {
  request: customVendorSchema
    .pick({ displayName: true, wire: true })
    .extend({
      source: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('preset'),
            presetId: z.string().min(1).max(64),
            regionId: z.string().min(1).max(64),
          })
          .strict(),
        z.object({ kind: z.literal('custom'), baseURL: customVendorSchema.shape.baseURL }).strict(),
      ]),
      apiKey: z.string().max(PROVIDER_VALUE_MAX_LENGTH),
    })
    .strict(),
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), id: customProviderIdSchema }),
    z.object({ ok: z.literal(false), code: customVendorErrorCodeSchema }),
  ]),
})

/** The name and the model rows; there is no address and no wire to change (T2). */
export const customVendorUpdate = defineRoute('customVendor.update', {
  request: z
    .object({
      id: customProviderIdSchema,
      displayName: customVendorSchema.shape.displayName.optional(),
      models: z
        .array(customModelSchema.omit({ probe: true }).strict())
        .max(200)
        .refine(distinctIds, { error: 'model ids must be distinct within an instance' })
        .optional(),
    })
    .strict(),
  response: customVendorWriteResultSchema,
})

export const customVendorDelete = defineRoute('customVendor.delete', {
  request: z.object({ id: customProviderIdSchema }).strict(),
  response: customVendorWriteResultSchema,
})

/** T7: only when the user presses 「获取模型列表」; the limits only prefill (T6). */
export const customVendorFetchModels = defineRoute('customVendor.fetchModels', {
  request: z.object({ id: customProviderIdSchema }).strict(),
  response: z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      models: z.array(
        z.object({
          id: modelIdSchema,
          contextLimit: z.number().int().positive().optional(),
          maxOutputTokens: z.number().int().positive().optional(),
        }),
      ),
    }),
    z.object({
      ok: z.literal(false),
      code: z.enum(['not-found', 'config', 'auth', 'unsupported', 'service']),
    }),
  ]),
})

/** One (instance, model) probe (§探测); `saved` is false when the result could not be kept. */
export const customVendorProbe = defineRoute('customVendor.probe', {
  request: z.object({ id: customProviderIdSchema, modelId: modelIdSchema }).strict(),
  response: z.discriminatedUnion('status', [
    z.object({ status: z.literal('done'), snapshot: probeSnapshotSchema, saved: z.boolean() }),
    z.object({
      status: z.literal('refused'),
      code: z.enum(['not-found', 'unknown-model', 'local-endpoint', 'busy', 'aborted']),
    }),
  ]),
})

/**
 * The user cancels a running probe (§探测「何时、走哪条路」; Revisions 2026-10-02): main aborts that
 * probe's signal, and `customVendor.probe` answers `refused` / `aborted` with nothing stored.
 * `cancelled` is false, and nothing happens, when the instance has no probe running.
 */
export const customVendorCancelProbe = defineRoute('customVendor.cancelProbe', {
  request: z.object({ id: customProviderIdSchema }).strict(),
  response: z.object({ cancelled: z.boolean() }),
})
