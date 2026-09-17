// One resource tree, statically bundled into BOTH processes. The English bundle is the
// key type; `pnpm i18n:check` keeps zh-CN's key set identical.
import enCommon from './locales/en/common.json'
import enMenu from './locales/en/menu.json'
import zhCommon from './locales/zh-CN/common.json'
import zhMenu from './locales/zh-CN/menu.json'

export const SUPPORTED_LOCALES = ['zh-CN', 'en'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'
export const DEFAULT_NS = 'common' as const
export const NAMESPACES = ['common', 'menu'] as const

export const enResources = { common: enCommon, menu: enMenu } as const
export type EnResources = typeof enResources

export const resources: Record<Locale, { common: object; menu: object }> = {
  en: enResources,
  'zh-CN': { common: zhCommon, menu: zhMenu },
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}
