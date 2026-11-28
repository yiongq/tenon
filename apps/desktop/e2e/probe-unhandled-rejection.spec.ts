// oxlint-disable no-await-in-loop -- one Electron at a time
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { appEnvironment } from './helpers/app-env.js'
import { makeUserDataDir } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'

/**
 * 临时探针，plan 2.0，段二前删除 (docs/features/error-logs/plan.md step 2.0; spec §开放问题 1).
 *
 * Does adding an `unhandledRejection` listener change what the terminal shows (the
 * UnhandledPromiseRejectionWarning line) or the exit code, for an unhandled Promise rejection in
 * the main process of the development build? Two runs of `out/main/index.js`, spawned directly as
 * `single-instance.spec.ts` spawns its second instance: one as it is, one with an empty listener
 * registered; in each a rejection is made in the main process and the app is quit the ordinary
 * way. The code that does that is a preload file (helpers/probe-unhandled-rejection-preload.cjs)
 * loaded with NODE_OPTIONS=--require, so no production source is touched.
 *
 * It asserts nothing that can fail: it prints each run's stderr and exit status and attaches them,
 * and the people reading the run's output decide. (If the preload did not run, the stderr has no
 * "[probe]" line, and `preloadRan` says false.)
 */

const electronPath = createRequire(import.meta.url)('electron') as string
const preload = fileURLToPath(
  new URL('./helpers/probe-unhandled-rejection-preload.cjs', import.meta.url),
)

interface Outcome {
  readonly mode: 'plain' | 'listener'
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly preloadRan: boolean
  readonly rejectionMade: boolean
  readonly stderr: string
  readonly stdout: string
}

async function run(mode: 'plain' | 'listener'): Promise<Outcome> {
  const userData = makeUserDataDir(`probe-${mode}`)
  const child = spawn(
    electronPath,
    [
      // Match Playwright's Linux launch flags (CI runs without Chromium's outer sandbox).
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      './out/main/index.js',
      `--user-data-dir=${userData}`,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...appEnvironment(process.env, {}),
        NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
        PROBE_MODE: mode,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stderr = ''
  let stdout = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  let exitCode: number | null = null
  let signal: string | null = null
  let timedOut = false
  try {
    const [code, sig] = (await once(child, 'exit', { signal: AbortSignal.timeout(45_000) })) as [
      number | null,
      string | null,
    ]
    exitCode = code
    signal = sig
  } catch {
    timedOut = true
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
  return {
    mode,
    exitCode,
    signal,
    timedOut,
    preloadRan: stderr.includes('[probe] preload ran'),
    rejectionMade: stderr.includes('[probe] making an unhandled rejection'),
    stderr,
    stdout,
  }
}

test('probe (temporary): an unhandled rejection in the main process, as it is and with an empty listener', async () => {
  test.setTimeout(150_000)
  for (const mode of ['plain', 'listener'] as const) {
    const outcome = await run(mode)
    const summary = JSON.stringify({ ...outcome, stderr: undefined, stdout: undefined })
    console.log(`[probe ${mode}] ${summary}`)
    console.log(`[probe ${mode}] stderr:\n${outcome.stderr}`)
    await test.info().attach(`stderr-${mode}`, { body: outcome.stderr, contentType: 'text/plain' })
    await test.info().attach(`summary-${mode}`, { body: summary, contentType: 'application/json' })
  }
  // Nothing here can fail on purpose.
  expect(true).toBe(true)
})
