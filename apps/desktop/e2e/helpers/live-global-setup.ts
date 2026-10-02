/**
 * The live suite's global setup (`playwright.live.config.ts`): before any live spec launches an
 * app, the run is refused when the origin map test seam is in the runner's environment or in the
 * repo-root `.env.local` (M6 §点名「测试接缝」, 验收 27; helpers/live-env.ts `originMapRefusal`).
 * `.env.local` is parsed here into an object, never into `process.env`, as the live specs read it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { originMapRefusal } from './live-env.js'

export default function liveGlobalSetup(): void {
  const envFile = resolve(process.cwd(), '../../.env.local')
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}
  const refusal = originMapRefusal(process.env, fromFile)
  if (refusal !== null) throw new Error(refusal)
}
