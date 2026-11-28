import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  countEvents,
  exitWithin,
  helperFile,
  killSpawnedApps,
  rendererPidOf,
  spawnTenon,
} from './helpers/app-process.js'
import { makeUserDataDir } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'

/**
 * Tenon leaves no crash dump (docs/features/error-logs/spec.md §崩溃转储, D5; acceptance 15; plan
 * step 3.1). A dump can hold memory, command lines and environments (evidence.md E3), and
 * Electron has no way to delete one, so the safe state is that none is ever written: the app never
 * starts the reporter. What this case shows is that the safe state is real and not an accident of
 * how the crash was made:
 *
 *  - Playwright's launcher adds `--disable-breakpad` to the command line, so an app it started
 *    would write no dump whatever the code did (E7). Every process here is spawned directly
 *    (`helpers/app-process.ts`), without Playwright and without that switch.
 *  - The positive control comes first. The test's own entry script (`helpers/crash-reporter-entry.cjs`)
 *    starts the crash reporter and then loads the main process's bundle; the same crash, made the
 *    same way, must then write a `.dmp` under the data folder. If it does not, the way of
 *    crashing proves nothing and the case fails at the control, not at the check that follows it.
 *  - Then the same crash with the app as it is, and the data folder is searched for any `.dmp`.
 *    Only `.dmp` counts: on Linux Electron makes a `Crashpad` folder holding a `client_id` file
 *    without ever collecting anything, which is no dump (P1).
 *  - A crash is a SIGSEGV from outside (the way P1 made it), to the renderer process and to the
 *    main process, each in both runs.
 *
 * Where the system keeps crash records of its own (`.ips` reports, systemd-coredump, apport) is
 * not Tenon's and not looked at (§已知限制与代价).
 */

test.skip(
  process.platform !== 'linux',
  'real crashes: run on CI (Linux, a virtual display); a desktop would show the system crash dialog',
)

test.afterEach(async () => {
  await killSpawnedApps()
})

/** Every `.dmp` under `dir`, as relative paths. */
function dumpsIn(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) =>
      name.endsWith('.dmp'),
    )
  } catch {
    return []
  }
}

/** Everything under `dir`, for the message of a case that fails: what was there when it looked. */
function listing(dir: string): string {
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => /crash|\.dmp/iu.test(name))
      .join('\n')
  } catch {
    return '(the folder cannot be read)'
  }
}

type Victim = 'renderer' | 'main'

/** One run: start, wait for the window, crash `victim` with SIGSEGV, and say which dumps were left. */
async function crash(
  victim: Victim,
  reporter: 'on' | 'off',
): Promise<{ dumps: string[]; listing: string }> {
  const userData = makeUserDataDir(`dump-${reporter}-${victim}`)
  const app = spawnTenon({
    userData,
    ...(reporter === 'on'
      ? {
          entry: { script: helperFile('crash-reporter-entry.cjs') },
          env: { TENON_E2E_MAIN_BUNDLE: resolve('out/main/index.js') },
        }
      : {}),
  })
  await expect
    .poll(() => countEvents(userData, 'window.shown'), {
      timeout: 45_000,
      message: `reporter ${reporter}, ${victim}: the window did not come up\n${app.output()}`,
    })
    .toBe(1)
  let target = app.pid
  if (victim === 'renderer') {
    await expect.poll(() => rendererPidOf(app.pid), { timeout: 15_000 }).not.toBeNull()
    target = rendererPidOf(app.pid) ?? app.pid
  }
  process.kill(target, 'SIGSEGV')
  if (victim === 'main') await exitWithin(app, 20_000)
  if (reporter === 'on') {
    // The handler process writes the dump a moment after the crash.
    await expect
      .poll(() => dumpsIn(userData).length, {
        timeout: 30_000,
        message: `reporter on, ${victim}: no dump\n${listing(userData)}`,
      })
      .toBeGreaterThan(0)
  } else {
    // An absence is only worth anything after a wait as long as the control needed to show a dump.
    await new Promise((done) => setTimeout(done, 8_000))
  }
  const found = { dumps: dumpsIn(userData), listing: listing(userData) }
  await app.kill()
  return found
}

test('error-logs 验收 15: a real crash writes a .dmp with the reporter on and none without it', async () => {
  test.setTimeout(300_000)
  for (const victim of ['renderer', 'main'] as const) {
    // The control first: the same crash, with the reporter on, must leave a dump.
    // oxlint-disable-next-line no-await-in-loop -- one Electron at a time
    const control = await crash(victim, 'on')
    expect(
      control.dumps.length,
      `the control for the ${victim} left no dump, so the crash proves nothing\n${control.listing}`,
    ).toBeGreaterThan(0)
    // oxlint-disable-next-line no-await-in-loop -- one Electron at a time
    const actual = await crash(victim, 'off')
    expect(
      actual.dumps,
      `a ${victim} crash left a dump with the app as it is\n${actual.listing}`,
    ).toEqual([])
  }
})
