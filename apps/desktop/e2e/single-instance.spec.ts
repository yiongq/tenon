import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appEnvironment } from './helpers/app-env.js'
import { launchTenon, makeUserDataDir } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'

// This case deliberately starts two Electron processes; run with no other Electron tests in flight.
test('04 step 12a: a second launch with the same userData exits and brings the first window forward', async () => {
  const userData = makeUserDataDir('single-instance')
  const first = await launchTenon({ userData })
  try {
    await first.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      // Xvfb without a window manager cannot minimize; hiding still proves the window is re-shown.
      if (process.platform === 'darwin') window.minimize()
      else window.hide()
    })
    await expect
      .poll(() =>
        first.app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]!
          return window.isMinimized() || !window.isVisible()
        }),
      )
      .toBe(true)

    // Playwright's Electron launcher waits for a debugger connection. The losing instance exits
    // before that connection, so spawn its executable directly and assert its real exit status.
    const second = spawn(
      first.app.process().spawnfile,
      [
        // Match Playwright's Linux launch flags (CI runs without Chromium's outer sandbox).
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        './out/main/index.js',
        `--user-data-dir=${userData}`,
      ],
      { cwd: process.cwd(), env: appEnvironment(process.env, {}), stdio: 'ignore' },
    )
    try {
      const [code, signal] = await once(second, 'exit', { signal: AbortSignal.timeout(10_000) })
      expect({ code, signal }).toEqual({ code: 0, signal: null })
      await expect
        .poll(() =>
          first.app.evaluate(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows()
            const window = windows[0]!
            return {
              count: windows.length,
              minimized: window.isMinimized(),
              visible: window.isVisible(),
              focused: window.isFocused(),
            }
          }),
        )
        .toEqual({ count: 1, minimized: false, visible: true, focused: true })
    } finally {
      if (second.exitCode === null && second.signalCode === null) {
        const exited = once(second, 'exit')
        second.kill('SIGKILL')
        await exited
      }
    }
  } finally {
    await first.app.close()
  }
})
