import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

export type Locale = 'zh-CN' | 'en'
export type LocaleSetting = 'auto' | Locale

/** `<userData>/profiles/<userId>/<tenantId>/config.json` - the kernel's profileDirFor layout. */
export function configPathIn(userData: string): string {
  return join(userData, 'profiles', 'local', 'personal', 'config.json')
}

/**
 * A fresh, empty profile root. Keep the handle: acceptance 9 relaunches into it.
 *
 * realpathSync matters: on macOS mkdtemp hands back `/var/folders/...` while
 * `app.getPath('userData')` reports the resolved `/private/var/folders/...`, so an
 * un-resolved path makes every equality assertion fail for the wrong reason.
 */
export function makeUserDataDir(tag: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `tenon-e2e-${tag}-`)))
}

/** Seeds `config.json` before the first launch, as if the user had already chosen. */
export function seedConfig(userData: string, config: { locale: LocaleSetting }): void {
  const file = configPathIn(userData)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
}

export interface LaunchOptions {
  /** Isolated profile root. Reuse the same one to prove a choice persisted. */
  readonly userData: string
  /**
   * Seeds `app.getPreferredSystemLanguages()` - the SYSTEM half of the resolver, never the
   * final locale, so `config.json`'s override stays the thing under test. Requires the
   * `preferredSystemLanguages()` seam in main (it splits on ','), which also gates the
   * variable on `!app.isPackaged`.
   */
  readonly systemLanguages?: readonly string[]
  /** Extra environment for the app process (e.g. a fake provider endpoint). */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Where the app keeps credentials. `memory` (the default) is the e2e seam; `keychain` is the
   * real path, which the spec assigns to the manual `pnpm test:live` and to daily use — an
   * unattended run must never write into a developer's login keychain, and CI's Linux has no
   * Secret Service at all.
   */
  readonly secrets?: 'memory' | 'keychain'
  /** CSS pixels of the web contents, not of the window: macOS puts a 32px title bar inside the bounds. */
  readonly contentSize?: { readonly width: number; readonly height: number }
}

export interface LaunchedApp {
  readonly app: ElectronApplication
  readonly page: Page
}

/**
 * Launches the built app against an isolated profile, sized to an exact CSS viewport.
 *
 * - `--user-data-dir` is a Chromium switch Electron forwards: `app.getPath('userData')`
 *   returns it, so no main-process flag parsing is needed (measured on Electron 44.4.1,
 *   against this repo's own `out/main/index.js`).
 * - ELECTRON_RUN_AS_NODE is set inside Electron-hosted terminals and would turn the
 *   electron binary into plain Node.
 */
export async function launchTenon(options: LaunchOptions): Promise<LaunchedApp> {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...rest } = process.env
  // TENON_DEV_ENV=off: the app must not pick up a developer's `.env.local` during tests;
  // a spec that wants real credentials passes them explicitly through `options.env`.
  // TENON_SECRETS=memory: and it must not read or write the real OS keychain either — on macOS
  // an unsigned dev build asking for one pops a system dialog, and CI's Linux has no Secret
  // Service at all. Credentials for a test therefore always travel through `options.env`. The
  // one exception is the opt-in live suite, which asks for `keychain` and so keeps the real
  // path covered by something (spec 01 §desktop 接线, 「e2e 的机密接缝」).
  const env: Record<string, string> = {
    ...(rest as Record<string, string>),
    TENON_DEV_ENV: 'off',
    TENON_SECRETS: options.secrets ?? 'memory',
    ...options.env,
  }
  if (options.systemLanguages !== undefined && options.systemLanguages.length > 0) {
    env['TENON_LOCALE'] = options.systemLanguages.join(',')
  }

  const app = await electron.launch({
    args: ['./out/main/index.js', `--user-data-dir=${options.userData}`],
    cwd: process.cwd(),
    env,
  })
  const page = await app.firstWindow()
  await page.getByTestId('app-root').waitFor()

  // page.setViewportSize() would NOT resize the window: it installs a CDP device-metrics
  // override that also forces devicePixelRatio from 2 to 1 and then ignores the real
  // window, so a later setContentSize does nothing. Size the BrowserWindow instead.
  const size = options.contentSize ?? { width: 1280, height: 800 }
  await app.evaluate(({ BrowserWindow }, target) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(target.width, target.height)
  }, size)
  await page.waitForFunction(
    (target) => globalThis.innerWidth === target.width && globalThis.innerHeight === target.height,
    size,
  )
  return { app, page }
}

/**
 * The application menu's top-level labels - the cheapest proof that MAIN switched language,
 * not just the renderer.
 *
 * `items[0]` is the app name ('Electron' for an unpackaged build, 'Tenon' only once
 * packaged/renamed), so assert on a later label: 'File' / '文件'.
 */
export async function applicationMenuLabels(app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    return menu === null ? [] : menu.items.map((item) => item.label)
  })
}
