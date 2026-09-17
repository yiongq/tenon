import { createInstance } from 'i18next'
import type { i18n as I18n } from 'i18next'
import ICU from 'i18next-icu'
import {
  DEFAULT_LOCALE,
  DEFAULT_NS,
  NAMESPACES,
  SUPPORTED_LOCALES,
  resources,
} from './resources.js'
import type { Locale } from './resources.js'

export type I18nErrorHandler = (message: string) => void

/**
 * One i18next instance per process (never the global singleton). ICU MessageFormat
 * with a parse-error handler: without one a broken message renders its raw source.
 */
export async function createI18n(
  lng: Locale,
  onError: I18nErrorHandler,
  use?: Parameters<I18n['use']>[0],
): Promise<I18n> {
  const instance = createInstance()
  instance.use(
    new ICU({
      memoize: true,
      parseErrorHandler: (err: Error, key: string) => {
        onError(`${key}: ${err.message.split('\n')[0] ?? err.message}`)
        return `<<i18n-error:${key}>>`
      },
    }),
  )
  if (use) instance.use(use)
  await instance.init({
    lng,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NS,
    resources,
    returnNull: false,
    interpolation: { escapeValue: false },
  })
  return instance
}
