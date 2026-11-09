/** Spec 06 §免问命令的环境. Only the dispatching decision opts into this filter. */
const TOKEN_NAMES: ReadonlySet<string> = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'HF_TOKEN',
  'VAULT_TOKEN',
  'PGPASSWORD',
  'OP_SERVICE_ACCOUNT_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZHIPU_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
])
const TOKEN_SUFFIX = /_(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)$/i

export function autoCommandEnvironment(
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !TOKEN_NAMES.has(name) && !name.startsWith('OP_SESSION_') && !TOKEN_SUFFIX.test(name),
    ),
  )
}
