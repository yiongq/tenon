import type { LocaleSetting } from '@tenon-app/contracts'
import { DEFAULT_LOCALE } from './resources.js'
import type { Locale } from './resources.js'

/**
 * Electron's preference list carries script and region subtags that describe the user,
 * not the language ('zh-Hans-FI', 'en-US', 'es-419'), so only the primary subtag is
 * matched. `[-_]` rather than `\b`: `\b` treats `_` as a word character and would miss
 * the POSIX spelling `zh_CN`.
 */
const PRIMARY = /^([A-Za-z]{2,3})(?:[-_]|$)/

/** First entry of the OS list that Tenon speaks; English when none matches. */
export function resolveLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const primary = PRIMARY.exec(tag)?.[1]?.toLowerCase()
    if (primary === 'zh') return 'zh-CN'
    if (primary === 'en') return 'en'
  }
  return DEFAULT_LOCALE
}

/** The stored choice wins; 'auto' follows the OS. */
export function effectiveLocale(setting: LocaleSetting, preferred: readonly string[]): Locale {
  return setting === 'auto' ? resolveLocale(preferred) : setting
}
