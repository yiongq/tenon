import { z } from 'zod'
import { defineEvent, defineRoute } from '../route.js'

export const localeSchema = z.enum(['zh-CN', 'en'])
export type Locale = z.infer<typeof localeSchema>

export const localeSettingSchema = z.enum(['auto', 'zh-CN', 'en'])
export type LocaleSetting = z.infer<typeof localeSettingSchema>

/**
 * Non-secret settings stored in `<profileDir>/config.json`.
 *
 * `providerConfig` is keyed by `ProviderId`, then by `ConfigKey.name`, and holds ONLY the keys a
 * definition declares `secret: false` (spec 01 §desktop 接线) — a secret lives in the OS keychain
 * and never in this file. Which provider is selected is `provider`, which arrives with the
 * settings card.
 */
export const configSchema = z.object({
  locale: localeSettingSchema.default('auto'),
  sidebarCollapsed: z.boolean().default(false),
  providerConfig: z.record(z.string(), z.record(z.string(), z.string())).default({}),
})
export type Config = z.infer<typeof configSchema>

export const configGet = defineRoute('config.get', {
  request: z.object({}),
  response: configSchema,
})

export const configPatchSchema = configSchema.partial()
export type ConfigPatch = z.infer<typeof configPatchSchema>

export const configSet = defineRoute('config.set', {
  request: configPatchSchema,
  response: configSchema,
})

/** Emitted once at start and whenever the resolved interface language changes. */
export const configLocale = defineEvent('config.locale', z.object({ locale: localeSchema }))
