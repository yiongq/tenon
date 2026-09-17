import { app } from 'electron'

/**
 * The OS language preference list the locale resolver runs on.
 *
 * `TENON_LOCALE` seeds the SYSTEM half only — not the resolved locale — so an e2e can put
 * the app on a Chinese system without touching real OS settings, while `config.json`'s
 * override and its precedence stay the thing under test. Comma-separated, in preference
 * order, exactly like `app.getPreferredSystemLanguages()` returns.
 *
 * Splitting is load-bearing: main today wraps the whole variable in a single-element array,
 * so `TENON_LOCALE='fr-FR,zh-Hans-CN'` resolves to `en` instead of `zh-CN` (measured).
 *
 * Dev builds only: a packaged Tenon must never take its interface language from the
 * environment. `--lang=zh-CN` is not an alternative — on macOS it moves `app.getLocale()`
 * to 'zh-CN' but leaves `getPreferredSystemLanguages()` at ['en-CN','zh-Hans-CN'] and
 * `getSystemLocale()` at 'en-CN' (measured on Electron 44.4.1).
 */
export function preferredSystemLanguages(): readonly string[] {
  const seeded = app.isPackaged ? undefined : process.env['TENON_LOCALE']
  if (seeded === undefined || seeded === '') return app.getPreferredSystemLanguages()
  return seeded.split(',').filter((tag) => tag !== '')
}
