/**
 * The last of acceptance 17's three SIGTERMs (docs/features/error-logs/spec.md §怎么写「SIGTERM
 * 有三种情形」; evidence.md E7): once Tenon's `registerSandboxSignals` has registered, a SIGTERM
 * goes the whole ordinary way out: the shutdown runs, the app quits, the log ends with `app.quit`
 * and the running marker is gone.
 *
 * The other two are not tests of Tenon's code: before srt installs its listeners Electron treats a
 * SIGTERM as a native quit (the e2e case in `e2e/error-logs.spec.ts` covers it with the fake
 * sandbox), and between srt's install and Tenon's registration the signal only resets srt, and
 * the process does not leave.
 *
 * What is real: `registerSandboxSignals`, `createShutdown`, the app log on a real folder. What is
 * stood in for:
 *
 *  - `process` is an EventEmitter: it reproduces `process.on('SIGTERM' | 'SIGINT', listener)` and
 *    that an emit calls the listeners synchronously, in order;
 *  - `app` reproduces the part of Electron's quit that matters here: `quit()` emits `before-quit`
 *    to its listeners, a listener's `preventDefault()` keeps the quit from going on, and a quit
 *    that goes on emits `will-quit`, which is where main closes the log (`index.ts`:
 *    `app.on('will-quit', () => appLog.close())`; that one line is what this file repeats);
 *  - the sandbox is a record of `signalReset` calls; there is no Run in progress and no store, so
 *    the shutdown waits on nothing.
 */
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createShutdown, registerSandboxSignals } from '../src/main/shutdown.js'
import type { SandboxPostureRun } from '../src/main/host/sandbox-posture.js'
import { openLog, readRecords, sweepTempRoots } from './support/error-logs.js'

afterEach(sweepTempRoots)

/** Electron's `app` as `quit()` meets it (see the header). */
class FakeApp extends EventEmitter {
  quits = 0
  willQuit = 0

  quit(): void {
    this.quits += 1
    let prevented = false
    this.emit('before-quit', { preventDefault: () => (prevented = true) })
    if (prevented) return
    this.willQuit += 1
    this.emit('will-quit')
  }
}

it('error-logs 验收 17: a SIGTERM after registerSandboxSignals quits through the shutdown and the log ends with app.quit', async () => {
  const { log, dir } = openLog({ packaged: true })
  log.write('info', {
    event: 'app.start',
    packaged: true,
    platform: 'linux',
    arch: 'x64',
    userData: '/data',
  })
  log.write('info', { event: 'window.shown' })
  expect(existsSync(join(dir, 'running.json'))).toBe(true)

  const app = new FakeApp()
  // `will-quit` is registered after `open`, as in main.
  app.on('will-quit', () => log.close())
  createShutdown({
    app,
    dialog: { showMessageBox: () => Promise.resolve({ response: 0 }) },
    registry: null,
    tape: null,
    t: (key) => key,
    parent: () => null,
    log: () => {},
  })

  const processPort = new EventEmitter()
  const signalReset = vi.fn<() => void>()
  const run: SandboxPostureRun = {
    initialized: Promise.resolve(),
    outcome: new Promise(() => {}),
  }
  registerSandboxSignals({ process: processPort, app, sandbox: { signalReset }, run })
  // Registration is the sandbox having initialized: not before.
  expect(processPort.listenerCount('SIGTERM')).toBe(0)
  await Promise.resolve()
  expect(processPort.listenerCount('SIGTERM')).toBe(1)

  processPort.emit('SIGTERM')
  // The signal resets srt and asks the app to quit; the shutdown holds that quit, finishes its
  // steps, and quits again.
  expect(signalReset).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(app.willQuit).toBe(1), { timeout: 2_000 })

  // main's two quits: the signal's, and the one the shutdown makes when it is done.
  expect(app.quits).toBe(2)
  const records = readRecords(join(dir, 'main.jsonl'))
  expect(records.at(-1)).toMatchObject({ event: 'app.quit', level: 'info' })
  expect(records.filter((record) => record.event === 'app.quit')).toHaveLength(1)
  expect(existsSync(join(dir, 'running.json'))).toBe(false)
})
