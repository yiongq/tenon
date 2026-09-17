import { configLocale } from '@tenon-app/contracts'
import type { i18n as I18n } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { createI18n } from '../../i18n/create-instance.js'
import { isLocale } from '../../i18n/resources.js'
import type { Locale } from '../../i18n/resources.js'

function syncHtmlLang(lng: string): void {
  document.documentElement.lang = lng
  document.documentElement.dataset['lang'] = lng.startsWith('zh') ? 'zh' : 'en'
}

/** Starts the renderer instance on the locale main resolved, then follows `config.locale`. */
export async function startRendererI18n(): Promise<I18n> {
  const initial = window.tenon.initialLocale
  const lng: Locale = isLocale(initial) ? initial : 'en'
  const i18n = await createI18n(lng, (m) => console.error('[i18n]', m), initReactI18next)
  syncHtmlLang(i18n.resolvedLanguage ?? lng)
  i18n.on('languageChanged', (l) => syncHtmlLang(i18n.resolvedLanguage ?? l))
  window.tenon.on(configLocale.channel, (payload) => {
    const parsed = configLocale.payload.safeParse(payload)
    if (parsed.success && parsed.data.locale !== i18n.resolvedLanguage) {
      void i18n.changeLanguage(parsed.data.locale)
    }
  })
  return i18n
}
