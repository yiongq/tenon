import { z } from 'zod'
import { defineRoute } from '../route.js'

/**
 * Provider settings over IPC (spec 01 §desktop 接线): what the settings card reads, what it
 * writes, and which provider a run uses.
 *
 * The rule this file exists to make structural: **no secret value ever crosses back**. Not
 * masked, not hashed, not its length — `provider.list` carries no value field at all, only
 * `configured: boolean` per declared key. The non-secret values the card prefills come from
 * `config.get`'s `providerConfig`, which is the file they live in; a schema that cannot express a
 * secret cannot leak one by a handler's oversight.
 *
 * The shapes restate the kernel's `ConfigKey` / `ModelInfo` rather than importing them, for the
 * reason `session.ts` gives: contracts is bundled into the sandboxed preload and an import of the
 * kernel would drag the kernel in with it.
 *
 * Nothing here is a sentence. `nameKey` and `labelKey` are catalogue keys the renderer resolves,
 * and a failure is a `code` the renderer maps to copy — adding a provider is adding a definition
 * plus its catalogue entries, never a change to this file or to the card.
 */

/** A bound on a typed setting: a key or a URL, never a document. */
export const PROVIDER_VALUE_MAX_LENGTH = 4096

const providerIdSchema = z.string().min(1).max(64)
const configKeyNameSchema = z.string().min(1).max(64)
const modelIdSchema = z.string().min(1).max(200)

/**
 * One declared `ConfigKey` as the card renders it. `configured` is what replaces the value: for a
 * secret it means the keychain holds one, for the rest that `config.json` or the declared
 * `default` supplies one.
 */
export const providerConfigKeySchema = z
  .object({
    name: configKeyNameSchema,
    required: z.boolean(),
    secret: z.boolean(),
    /** The credential to ask for first where a definition marks one. */
    primary: z.boolean(),
    labelKey: z.string().min(1),
    /** The DECLARED default — definition data, never anything a user typed. */
    default: z.string().optional(),
    configured: z.boolean(),
  })
  /**
   * A secret carries no default ON THE WIRE. Nothing in the kernel's `ConfigKey` forbids a
   * definition from declaring one, and `default` is the single field here that holds a value at
   * all — so without this rule the "no field a secret could travel in" guarantee would rest on
   * definition authors rather than on the schema. Enforced rather than documented: a handler that
   * copied one through would fail response validation instead of shipping it.
   */
  .refine((key) => !(key.secret && key.default !== undefined), {
    error: 'a secret config key must not carry a default value',
    path: ['default'],
  })
export type ProviderConfigKeyContract = z.infer<typeof providerConfigKeySchema>

/** A builtin model, by id: the card offers the list, the run records what it used. */
export const providerModelSchema = z.object({ id: modelIdSchema })

/** One registered definition. `configured` = this provider could run as it stands. */
export const providerEntrySchema = z.object({
  id: providerIdSchema,
  nameKey: z.string().min(1),
  configKeys: z.array(providerConfigKeySchema),
  models: z.array(providerModelSchema),
  configured: z.boolean(),
})
export type ProviderEntryContract = z.infer<typeof providerEntrySchema>

export const providerList = defineRoute('provider.list', {
  request: z.object({}),
  response: z.array(providerEntrySchema),
})

/**
 * Why a write was refused, as a code the card turns into copy. `invalid-value` is the one a user
 * can cause by typing (a base URL the wire cannot use); the other three are a renderer asking for
 * something no definition declares, which the data-driven card never does.
 */
export const providerWriteErrorCodeSchema = z.enum([
  'unknown-provider',
  'unknown-key',
  'unknown-model',
  'invalid-value',
])
export type ProviderWriteErrorCode = z.infer<typeof providerWriteErrorCodeSchema>

/** `configKey` names the field to point at, when the failure belongs to one. */
export const providerWriteResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: providerWriteErrorCodeSchema,
    configKey: configKeyNameSchema.nullable(),
  }),
])
export type ProviderWriteResult = z.infer<typeof providerWriteResultSchema>

/**
 * Saves what the card collected: keys declared `secret` go to `HostAdapter.secrets`, the rest
 * merge key by key into `config.json`'s `providerConfig[id]`.
 *
 * An EMPTY value deletes a secret. The spec's §desktop 接线 does not state this — it is step 14's
 * reading, taken because the card is the only place a stored credential can be removed at all and
 * a blank one on the wire answers 401 (which reads as a wrong key rather than as none). For a
 * non-secret key an empty value is stored as the empty string, which every definition's `create()`
 * already reads as "use the declared default".
 *
 * Only the keys the user actually edited are sent, so a save never rewrites a field it did not
 * touch — and a value that no client could be built from is refused BEFORE anything is written.
 */
export const providerConfigure = defineRoute('provider.configure', {
  request: z.object({
    id: providerIdSchema,
    values: z.record(configKeyNameSchema, z.string().max(PROVIDER_VALUE_MAX_LENGTH)),
  }),
  response: providerWriteResultSchema,
})

/**
 * The provider and model the next run uses. It writes `config.json` and NO Tape fact: what a run
 * actually used is recorded by the run itself (`session/model_selected`), which is the only
 * reading that stays true when this setting changes mid-conversation.
 */
export const providerSelect = defineRoute('provider.select', {
  request: z.object({ providerId: providerIdSchema, modelId: modelIdSchema }),
  response: providerWriteResultSchema,
})
