// Derives the spellings of the error-logs sentinels (spec §脱敏, 验收 3): the raw value, its base64,
// its URL encoding and its JSON-escaped form. Run once with `node derive-error-logs-spellings.mjs`
// and paste the output into error-logs-sentinels.ts as literals. It is deliberately a separate
// script that imports nothing from the app: the tests must not compute their expectations with the
// code that is under test, or with a helper that a refactor of it could change in step.
//
//   base64   standard alphabet, with padding, of the UTF-8 bytes
//   url      encodeURIComponent
//   json     JSON.stringify without the surrounding quotes
//
// Every raw value has a double quote, a backslash, a slash, a plus and an equals sign in it, so
// the four spellings differ from one another, and none starts like one of the generic token
// formats (sk-, ghp_, AKIA, …): a hit must come from registration, never from the format layer.
import { Buffer } from 'node:buffer'

const raw = {
  STORED: 'TSNT-stored"A7/Lp+9=zk\\M3vN8wT',
  CONFIGURED: 'TSNT-config"B8/Mq+2=yj\\N4wP9xU',
  ENVVAR: 'TSNT-envvar"C9/Nr+3=xh\\P5xQ2yV',
  OAUTH_ACCESS: 'TSNT-oaccess"D2/Ps+4=wg\\Q6yR3zW',
  OAUTH_REFRESH: 'TSNT-orefresh"E3/Qt+5=vf\\R7zS4aX',
  OAUTH_CLIENT: 'TSNT-oclient"F4/Ru+6=ue\\S8aT5bY',
  MCP_ENV_KEY: 'TSNT-mcpenvkey"G5/Sv+7=td\\T9bU6cZ',
  MCP_ENVS: 'TSNT-mcpenvs"H6/Tw+8=sc\\U2cV7dA',
  TABLE: 'TSNT-table"J7/Ux+9=rb\\V3dW8eB',
}

const spellings = (value) => ({
  raw: value,
  base64: Buffer.from(value, 'utf8').toString('base64'),
  url: encodeURIComponent(value),
  json: JSON.stringify(value).slice(1, -1),
})

// The output is TypeScript with single-quoted strings, exactly as the file it is pasted into.
const quote = (text) => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

const lines = []
for (const [name, value] of Object.entries(raw)) {
  const s = spellings(value)
  lines.push(
    `export const ${name}: Sentinel = {`,
    `  raw: ${quote(s.raw)},`,
    `  base64: ${quote(s.base64)},`,
    `  url: ${quote(s.url)},`,
    `  json: ${quote(s.json)},`,
    `}`,
    '',
  )
}
process.stdout.write(lines.join('\n'))
