/**
 * The environment a launched app process gets. Out of `launchTenon` and free of Playwright so that
 * apps/desktop/test/live-env.test.ts can pin it in CI, where nothing ever launches with a real key.
 */

/** Where a live run keeps the official Anthropic key: the runner's own environment, nothing else. */
export const OFFICIAL_KEY_ENV = 'TENON_LIVE_ANTHROPIC_OFFICIAL_KEY'

/** The one host an official Anthropic key may be sent to. */
export const OFFICIAL_HOST = 'api.anthropic.com'

/**
 * Never copied from the runner's environment into an app: every variable the desktop reads a
 * provider credential or endpoint from (`DEV_ENV_FALLBACK`, src/main/provider.ts — the unit test
 * keeps the two lists in step), the official key's own variable, and ELECTRON_RUN_AS_NODE, which is
 * set inside Electron-hosted terminals and would turn the electron binary into plain Node. A test's
 * credentials travel through `env` alone; a key exported in a developer's shell would otherwise
 * reach every app a test launches, next to whatever base URL that test points it at.
 */
export const NEVER_INHERITED: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ZHIPU_API_KEY',
  OFFICIAL_KEY_ENV,
  'ELECTRON_RUN_AS_NODE',
]

export interface AppEnvOptions {
  /** Extra environment for the app process, over what it inherits. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Default `memory`: see `LaunchOptions.secrets`. */
  readonly secrets?: 'memory' | 'keychain' | undefined
  /** Seeds the SYSTEM half of the locale resolver, comma-joined (`LaunchOptions.systemLanguages`). */
  readonly systemLanguages?: readonly string[] | undefined
}

/**
 * The runner's environment minus NEVER_INHERITED, the two test switches, then `options.env` on top.
 * TENON_DEV_ENV=off: the app must not pick up a developer's `.env.local` during tests. TENON_SECRETS:
 * `memory` unless the caller asks for the real keychain (spec 01 §desktop 接线, 「e2e 的机密接缝」).
 * Throws instead of returning an environment that would send an official key to another host.
 */
export function appEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  options: AppEnvOptions,
): Record<string, string> {
  const dropped = new Set(NEVER_INHERITED)
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && !dropped.has(name)) env[name] = value
  }
  env['TENON_DEV_ENV'] = 'off'
  env['TENON_SECRETS'] = options.secrets ?? 'memory'
  Object.assign(env, options.env)
  if (options.systemLanguages !== undefined && options.systemLanguages.length > 0) {
    env['TENON_LOCALE'] = options.systemLanguages.join(',')
  }
  assertOfficialKeyStaysHome(env)
  return env
}

/** Anthropic's own keys and tokens (`sk-ant-api…`, `sk-ant-oat…`, `sk-ant-admin…`) share a prefix. */
export function looksOfficial(value: string): boolean {
  return value.trim().startsWith('sk-ant-')
}

/** True for a base URL on the vendor's own host; an unparseable one is not. */
export function isOfficialBaseURL(baseURL: string): boolean {
  try {
    return new URL(baseURL.trim()).hostname === OFFICIAL_HOST
  } catch {
    return false
  }
}

/**
 * Refuses an app environment that holds a key that looks like Anthropic's own beside an
 * ANTHROPIC_BASE_URL on any other host (spec 02 §模型与密钥): the anthropic definition hands both
 * credentials to the SDK, so that key would travel to the other host. A blank base URL is the
 * default endpoint, as the desktop reads it. Names only in the message, never a value.
 */
export function assertOfficialKeyStaysHome(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const baseURL = env['ANTHROPIC_BASE_URL']?.trim() ?? ''
  if (baseURL === '' || isOfficialBaseURL(baseURL)) return
  const carriers = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].filter((name) =>
    looksOfficial(env[name] ?? ''),
  )
  if (carriers.length === 0) return
  throw new Error(
    `${carriers.join(' and ')} looks like an official Anthropic key, and ANTHROPIC_BASE_URL is not ` +
      `${OFFICIAL_HOST}: refusing to launch (spec 02 §模型与密钥)`,
  )
}
