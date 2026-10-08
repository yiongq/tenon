import { expect, it } from 'vitest'
import { buildStdioEnv, redactLine, STDIO_ENV_ALLOW } from '../../src/mcp/env.js'

it('03 验收 6 / 03 不变量 5: the child env is exactly the allow-list, PATH, envs and env_keys', () => {
  const allowed = Object.fromEntries(STDIO_ENV_ALLOW.map((name) => [name, name.toLowerCase()]))
  const result = buildStdioEnv({
    base: {
      ...allowed,
      PATH: '/bin',
      LC_ALL: 'C',
      LC_MESSAGES: 'en',
      TENON_X: 'private',
      ELECTRON_Y: 'private',
      GITHUB_TOKEN: 'private',
      UNSET: undefined,
    },
    envs: { PATH: '/custom', PUBLIC: 'plain', OVERLAY: 'plain' },
    envKeyValues: { SECRET: 'fixture-secret', OVERLAY: 'keychain' },
  })
  expect(result).toEqual({
    ...allowed,
    PATH: '/custom',
    LC_ALL: 'C',
    LC_MESSAGES: 'en',
    PUBLIC: 'plain',
    SECRET: 'fixture-secret',
    OVERLAY: 'keychain',
  })
})
it('redactLine replaces every occurrence of a secret of 4+ characters and leaves envs values', () => {
  expect(
    redactLine('plain abc long-secret long-secret secret', ['abc', 'secret', 'long-secret']),
  ).toBe('plain abc *** *** ***')
  expect(redactLine('abcd abcd', ['abcd'])).toBe('*** ***')
})
it('03 验收 27 (multi-line): each line of a multi-line secret is redacted', () => {
  expect(
    redactLine('first-line and second-line then first-line', ['first-line\r\nsecond-line']),
  ).toBe('*** and *** then ***')
  expect(redactLine('abc final-line', ['abc\nfinal-line'])).toBe('abc ***')
})
