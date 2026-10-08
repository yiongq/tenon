/**
 * What the Anthropic-wire live group hands the app it launches (spec 02 §模型与密钥; plan step 4).
 *
 * An official Anthropic key never shares an environment with a base URL other than
 * api.anthropic.com, and here that holds by construction rather than by care:
 *
 *   - `appEnvironment` drops every provider variable the runner exports (NEVER_INHERITED), so an
 *     app sees only what its group sets — and it refuses to launch an official-looking key beside
 *     a foreign base URL, whoever put them there;
 *   - the official group takes its key from OFFICIAL_KEY_ENV in the runner's own environment —
 *     never from `.env.local`, which it refuses to find the key in — and sets ANTHROPIC_API_KEY
 *     alone: no base URL, no auth token, so the definition's default endpoint is the only one it
 *     can reach.
 *
 * The emulation group that ran glm-4.7-flash behind Zhipu's /api/anthropic through
 * ANTHROPIC_BASE_URL is gone (M6 §点名 (c), (d)): anthropic now reads that address as not
 * configured, and the Anthropic wire to Zhipu is a custom vendor instance (step 11's live group).
 *
 * The whole live suite refuses to run while the origin map test seam is in sight
 * (`originMapRefusal`): it would send the official key's requests to this machine (02 M4).
 *
 * The DeepSeek key (`deepseekKey`, M6 验收 29) follows the official key's rule: the runner's own
 * environment only, refused when `.env.local` holds it. It is typed into an instance's settings
 * card, never handed to an app's environment.
 *
 * The group runs on the in-memory secrets seam. With the real keychain, a key saved through the
 * settings card in daily use would be read ahead of these variables. The zhipu group keeps the
 * keychain path covered.
 *
 * Pure: every input is an argument, so apps/desktop/test/live-env.test.ts pins it in CI.
 */
import { DEEPSEEK_KEY_ENV, OFFICIAL_KEY_ENV, ORIGIN_MAP_ENV, looksOfficial } from './app-env.js'

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

/** A live key a group types into an instance's settings card, never into an app's environment. */
export type InstanceKey =
  | { readonly kind: 'ready'; readonly key: string }
  /** Not handed in: the group skips. */
  | { readonly kind: 'absent'; readonly reason: string }
  /** Kept where it never goes: the group fails instead of running. */
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * The DeepSeek group's key (M6 plan「开工前读」key; 验收 29): DEEPSEEK_KEY_ENV in `runner`, the
 * runner's own environment, which the lead fills from the login keychain for that one run. Found in
 * `file` (`.env.local`) under that name, whatever it holds, the group is refused rather than run,
 * as the official group is: that key never goes there. Names the variable, never a value.
 */
export function deepseekKey(runner: EnvRecord, file: EnvRecord): InstanceKey {
  if (file[DEEPSEEK_KEY_ENV] !== undefined) {
    return {
      kind: 'refused',
      reason: `.env.local holds ${DEEPSEEK_KEY_ENV}; it never goes there — remove it and pass it in this run's environment only`,
    }
  }
  const key = runner[DEEPSEEK_KEY_ENV]?.trim()
  if (key === undefined || key === '') {
    return {
      kind: 'absent',
      reason: `no ${DEEPSEEK_KEY_ENV} in this run's environment (never in .env.local or a shell profile)`,
    }
  }
  return { kind: 'ready', key }
}

export function compact(wanted: EnvRecord): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(wanted)) {
    if (value !== undefined) env[name] = value
  }
  return env
}

/**
 * Why the live suite must not run here, or null (M6 §点名「测试接缝」, 验收 27): the origin map
 * test seam in the runner's environment or in `.env.local` (`file`). Launched apps never inherit
 * it, but a live run is no place for a switch that sends api.anthropic.com's requests elsewhere —
 * the official key would follow them (02 M4). Names the variable, never a value.
 */
export function originMapRefusal(runner: EnvRecord, file: EnvRecord): string | null {
  for (const name of ['TENON_TEST_MCP_OPEN_URL', 'TENON_TEST_MCP_CALLBACK_PORT'])
    if (runner[name] !== undefined || file[name] !== undefined)
      return `${name} is unsafe in a live run`
  const where = [
    ...(runner[ORIGIN_MAP_ENV] === undefined ? [] : ["this run's environment"]),
    ...(file[ORIGIN_MAP_ENV] === undefined ? [] : ['.env.local']),
  ]
  return where.length === 0
    ? null
    : `${ORIGIN_MAP_ENV} is set in ${where.join(' and ')}: the live suite refuses to run with ` +
        'the test seam that redirects requests to this machine (remove it)'
}
