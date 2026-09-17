import { configLocale } from '@tenon-app/contracts'
import type { Config } from '@tenon-app/contracts'
import type { i18n as I18n } from 'i18next'
import { createI18n } from '../i18n/create-instance.js'
import { effectiveLocale } from '../i18n/resolve-locale.js'
import type { Locale } from '../i18n/resources.js'
import type { EventSender } from './host/index.js'

export interface LocaleController {
  readonly i18n: I18n
  readonly current: Locale
  /** Re-resolves from the stored setting and applies the result everywhere. */
  apply(config: Config): Promise<void>
  onChange(listener: (locale: Locale) => void): void
}

/**
 * Main resolves the interface language exactly once per change and pushes the result;
 * the renderer never guesses. `preferred` is app.getPreferredSystemLanguages().
 */
export async function createLocaleController(
  initial: Config,
  preferred: readonly string[],
  send: EventSender,
): Promise<LocaleController> {
  let current = effectiveLocale(initial.locale, preferred)
  const i18n = await createI18n(current, (m) => console.error('[i18n]', m))
  const listeners = new Set<(locale: Locale) => void>()
  return {
    i18n,
    get current() {
      return current
    },
    async apply(config) {
      const next = effectiveLocale(config.locale, preferred)
      if (next === current) return
      current = next
      await i18n.changeLanguage(next)
      for (const listener of listeners) listener(next)
      send(configLocale.channel, { locale: next })
    },
    onChange(listener) {
      listeners.add(listener)
    },
  }
}
