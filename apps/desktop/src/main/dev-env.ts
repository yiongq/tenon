import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * Development convenience: read KEY=VALUE pairs from the nearest `.env.local` (the working
 * directory or up to three parents) into process.env. Variables already present in the
 * environment win. A packaged app never reads it, and `TENON_DEV_ENV=off` opts out (the
 * e2e suite does, so a developer's real key never reaches a test run by accident).
 */
export function loadDevEnv(): string | null {
  if (app.isPackaged || process.env['TENON_DEV_ENV'] === 'off') return null
  let dir = process.cwd()
  for (let depth = 0; depth < 4; depth += 1) {
    const file = join(dir, '.env.local')
    if (existsSync(file)) {
      process.loadEnvFile(file)
      return file
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
