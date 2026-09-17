import { z } from 'zod'
import { defineEvent, defineRoute } from '../route.js'

export const localeSchema = z.enum(['zh-CN', 'en'])
export type Locale = z.infer<typeof localeSchema>

export const localeSettingSchema = z.enum(['auto', 'zh-CN', 'en'])
export type LocaleSetting = z.infer<typeof localeSettingSchema>

/** Non-secret settings stored in `<profileDir>/config.json`. */
export const configSchema = z.object({
  locale: localeSettingSchema.default('auto'),
  sidebarCollapsed: z.boolean().default(false),
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
