import { z } from 'zod'
import { defineEvent, defineRoute } from '../route.js'
import { mcpServerSchema } from './mcp.js'
import { customVendorSchema } from './custom-vendor.js'

export const localeSchema = z.enum(['zh-CN', 'en'])
export type Locale = z.infer<typeof localeSchema>

export const localeSettingSchema = z.enum(['auto', 'zh-CN', 'en'])
export type LocaleSetting = z.infer<typeof localeSettingSchema>

/**
 * Which provider and model the next run uses (spec 01 §desktop 接线). `null` = nothing chosen
 * yet, which is what every file written before the settings card existed says; the chat path
 * then falls back to the development environment and finally to the first builtin provider.
 */
export const providerSelectionSchema = z.object({
  id: z.string().min(1),
  modelId: z.string().min(1),
  /** A hand-typed id no builtin table has (spec 02 01 修补 6; M6, A15). */
  source: z.literal('user').optional(),
})
export type ProviderSelection = z.infer<typeof providerSelectionSchema>

/**
 * Non-secret settings stored in `<profileDir>/config.json`.
 *
 * `providerConfig` is keyed by `ProviderId`, then by `ConfigKey.name`, and holds ONLY the keys a
 * definition declares `secret: false` (spec 01 §desktop 接线) — a secret lives in the OS keychain
 * and never in this file. Which provider is selected is `provider`.
 *
 * Both fields carry a default, so a `config.json` written by an older build — one with neither
 * key — parses into a valid Config rather than being discarded as corrupt.
 */
export const configSchema = z.object({
  mcpServers: z.array(mcpServerSchema).default([]),
  locale: localeSettingSchema.default('auto'),
  sidebarCollapsed: z.boolean().default(false),
  provider: providerSelectionSchema.nullable().default(null),
  providerConfig: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /**
   * The default of a new session, by profile (spec 02 01 修补 6; M5): the menu writes the profile
   * it chose in, the settings card both. Main writes it; `config.set` does not take it.
   */
  defaultModelByProfile: z
    .object({
      chat: providerSelectionSchema.optional(),
      cowork: providerSelectionSchema.optional(),
    })
    .default({}),
  /**
   * The task profile's prefill (spec 02 §工作区「来源」; D11): the folder list as it last changed,
   * written by the main process after the kernel accepted a change — never through `config.set`,
   * since the renderer cannot hand a path in (A9). Falling back to the dedicated folder leaves it.
   */
  lastWorkspaceFolders: z.array(z.string().min(1)).default([]),
  /**
   * M6 01 修补 5 (T8): the custom vendor instances, in the order the menu lists them. Main writes
   * it; `config.set` does not take it. A file from before M6 has none and reads as `[]`; a build
   * from before M6 drops it on its next write (no configVersion, T8).
   */
  customVendors: z.array(customVendorSchema).default([]),
})
export type Config = z.infer<typeof configSchema>

export const configGet = defineRoute('config.get', {
  request: z.object({}),
  response: configSchema,
})

/** Any subset of the file, as the MAIN process writes it. Not what a renderer may ask for. */
export const configPatchSchema = configSchema.partial()
export type ConfigPatch = z.infer<typeof configPatchSchema>

/**
 * What the renderer owns, spelled out rather than derived.
 *
 * `provider` and `providerConfig` are deliberately absent: those are checked against the
 * registered definitions (`provider.configure` / `provider.select` refuse an unknown id, an
 * undeclared key, or a value no client could be built from), and a second, unchecked way in would
 * make every one of those checks optional. `config.get` still returns both — the settings card
 * prefills the non-secret values from it.
 *
 * And it is written out because `configSchema.partial()` would NOT do: `.partial()` wraps each
 * field in `optional()` but leaves its `.default()` underneath, so a patch carrying only `locale`
 * parses into every other field at its default — and a one-field save from the renderer would
 * write those over whatever the user had chosen (measured: zod 4.6.5). A key absent from the
 * request must stay absent all the way to `writeConfig`.
 */
export const configSetRequestSchema = z.object({
  locale: localeSettingSchema.optional(),
  sidebarCollapsed: z.boolean().optional(),
})
export type ConfigSetRequest = z.infer<typeof configSetRequestSchema>

export const configSet = defineRoute('config.set', {
  request: configSetRequestSchema,
  response: configSchema,
})

/** Emitted once at start and whenever the resolved interface language changes. */
export const configLocale = defineEvent('config.locale', z.object({ locale: localeSchema }))
