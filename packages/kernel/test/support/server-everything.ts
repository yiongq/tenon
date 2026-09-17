/**
 * Locates @modelcontextprotocol/server-everything's real entry file. pnpm's
 * node_modules/.bin entries are shell shims, so the executable path has to come from
 * the package manifest; argv[0] is then the current Node binary (always absolute).
 */
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { SpawnSpec } from '../../src/index.js'
import { absolutePath } from '../../src/index.js'

const require = createRequire(import.meta.url)

export function serverEverythingSpawnSpec(): SpawnSpec {
  const manifestPath = require.resolve('@modelcontextprotocol/server-everything/package.json')
  const manifest = require('@modelcontextprotocol/server-everything/package.json') as {
    bin?: string | Record<string, string>
  }
  const rel =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['mcp-server-everything']
  if (!rel) throw new Error('server-everything has no mcp-server-everything bin')
  const entry = resolve(dirname(manifestPath), rel)
  return {
    argv: [process.execPath, entry, 'stdio'],
    cwd: absolutePath(dirname(manifestPath)),
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
    },
    stdio: 'pipe',
  }
}
