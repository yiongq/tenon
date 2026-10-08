import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)

it('03 验收 1: the kernel depends on @modelcontextprotocol/client 2.3.1 and server-everything 2026.8.31', () => {
  expect(require('../../node_modules/@modelcontextprotocol/client/package.json').version).toBe(
    '2.3.1',
  )
  expect(
    require('../../node_modules/@modelcontextprotocol/server-everything/package.json').version,
  ).toBe('2026.8.31')
})
