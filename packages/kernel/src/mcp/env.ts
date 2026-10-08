/** Only login-shell context is inherited; explicit configuration supplies everything else. */
export const STDIO_ENV_ALLOW = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'TMPDIR',
] as const

export function buildStdioEnv(q: {
  readonly base: Readonly<Record<string, string | undefined>>
  readonly envs: Readonly<Record<string, string>>
  readonly envKeyValues: Readonly<Record<string, string>>
}): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [name, value] of Object.entries(q.base)) {
    if (
      value !== undefined &&
      (name === 'PATH' ||
        name.startsWith('LC_') ||
        STDIO_ENV_ALLOW.some((allowed) => name === allowed))
    )
      inherited[name] = value
  }
  return { ...inherited, ...q.envs, ...q.envKeyValues }
}

/** Replace complete values and each nontrivial line, longest first for overlapping secrets. */
export function redactLine(line: string, secrets: readonly string[]): string {
  const values = new Set(
    secrets
      .flatMap((value) => [value, ...value.split(/[\r\n]+/)])
      .filter((value) => value.length >= 4),
  )
  let redacted = line
  for (const value of [...values].toSorted((a, b) => b.length - a.length))
    redacted = redacted.split(value).join('***')
  return redacted
}
