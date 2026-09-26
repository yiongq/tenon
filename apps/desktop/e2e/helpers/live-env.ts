/**
 * What each Anthropic-wire live group hands the app it launches (spec 02 §模型与密钥; plan step 4).
 *
 * An official Anthropic key never shares an environment with a base URL other than
 * api.anthropic.com, and here that holds by construction rather than by care:
 *
 *   - `appEnvironment` drops every provider variable the runner exports (NEVER_INHERITED), so an
 *     app sees only what its group sets — and it refuses to launch an official-looking key beside
 *     a foreign base URL, whoever put them there;
 *   - the emulation group (glm-4.7-flash behind Zhipu's /api/anthropic) forwards a base URL and an
 *     auth token only: it never reads ANTHROPIC_API_KEY or OFFICIAL_KEY_ENV, and refuses a token
 *     that looks official or a base URL on the official host;
 *   - the official group takes its key from OFFICIAL_KEY_ENV in the runner's own environment —
 *     never from `.env.local`, which it refuses to find the key in — and sets ANTHROPIC_API_KEY
 *     alone: no base URL, no auth token, so the definition's default endpoint is the only one it
 *     can reach.
 *
 * Both groups run on the in-memory secrets seam. With the real keychain, a key saved through the
 * settings card in daily use would be read ahead of these variables, and that is how an official
 * key could reach the emulation endpoint after all. The zhipu group keeps the keychain path covered.
 *
 * Pure: every input is an argument, so apps/desktop/test/live-env.test.ts pins it in CI.
 */
import { OFFICIAL_KEY_ENV, isOfficialBaseURL, looksOfficial } from './app-env.js'

/** The model the official group runs on; unset, the anthropic definition's first builtin row. */
export const OFFICIAL_MODEL_ENV = 'TENON_LIVE_ANTHROPIC_OFFICIAL_MODEL'

/** The first of `names` set in the runner's environment or `.env.local`, as the live spec reads. */
export type Lookup = (...names: string[]) => string | undefined

export type EnvRecord = Readonly<Record<string, string | undefined>>

export type LiveGroup =
  | { readonly kind: 'ready'; readonly env: Readonly<Record<string, string>> }
  /** Not configured: the group skips. */
  | { readonly kind: 'absent'; readonly reason: string }
  /** Configured in a way that could leak a key: the group fails instead of running. */
  | { readonly kind: 'refused'; readonly reason: string }

/** glm-4.7-flash (TENON_LIVE_MODEL) on Zhipu's Anthropic-compatible endpoint, from `.env.local`. */
export function emulationGroup(pick: Lookup, maxTokens: string): LiveGroup {
  const token = pick('TENON_LIVE_AUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN')
  if (token === undefined) {
    return { kind: 'absent', reason: 'no ANTHROPIC_AUTH_TOKEN (or TENON_LIVE_AUTH_TOKEN) found' }
  }
  if (looksOfficial(token)) {
    return {
      kind: 'refused',
      reason: `the emulation group's token looks like an official Anthropic key; that key travels only as ${OFFICIAL_KEY_ENV}`,
    }
  }
  const baseURL = pick('ANTHROPIC_BASE_URL')
  if (baseURL === undefined || isOfficialBaseURL(baseURL)) {
    return {
      kind: 'refused',
      reason:
        'the emulation group needs ANTHROPIC_BASE_URL on the endpoint it emulates, not on ' +
        `api.anthropic.com (the official API has its own group, ${OFFICIAL_KEY_ENV})`,
    }
  }
  return {
    kind: 'ready',
    env: compact({
      TENON_PROVIDER: 'anthropic',
      ANTHROPIC_BASE_URL: baseURL,
      ANTHROPIC_AUTH_TOKEN: token,
      TENON_MODEL: pick('TENON_LIVE_MODEL', 'TENON_MODEL'),
      TENON_MAX_TOKENS: maxTokens,
    }),
  }
}

/**
 * The official API with a prepaid Console key. `runner` is the runner's own environment, the only
 * place the key is read from; `file` is `.env.local`, read only to refuse a key found there.
 */
export function officialGroup(
  runner: EnvRecord,
  file: EnvRecord,
  pick: Lookup,
  maxTokens: string,
): LiveGroup {
  const inFile = Object.keys(file).filter(
    (name) => name === OFFICIAL_KEY_ENV || looksOfficial(file[name] ?? ''),
  )
  if (inFile.length > 0) {
    return {
      kind: 'refused',
      reason: `.env.local holds an official Anthropic key (${inFile.join(', ')}); it never goes there — remove it and pass ${OFFICIAL_KEY_ENV} in this run's environment only`,
    }
  }
  const key = runner[OFFICIAL_KEY_ENV]?.trim()
  if (key === undefined || key === '') {
    return {
      kind: 'absent',
      reason: `no ${OFFICIAL_KEY_ENV} in this run's environment (never in .env.local or a shell profile)`,
    }
  }
  return {
    kind: 'ready',
    env: compact({
      TENON_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: key,
      // Always set, so a TENON_MODEL exported in the runner's shell cannot ride in; blank is "not
      // configured" to the desktop, which then takes the definition's first builtin row.
      TENON_MODEL: pick(OFFICIAL_MODEL_ENV) ?? '',
      TENON_MAX_TOKENS: maxTokens,
    }),
  }
}

export function compact(wanted: EnvRecord): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(wanted)) {
    if (value !== undefined) env[name] = value
  }
  return env
}
