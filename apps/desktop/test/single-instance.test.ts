import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { startSingleInstance } from '../src/main/single-instance.js'

function fixture(ownsLock: boolean) {
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: vi.fn<() => boolean>(() => ownsLock),
    quit: vi.fn<() => void>(),
  })
  const window = {
    isMinimized: vi.fn<() => boolean>(() => true),
    restore: vi.fn<() => void>(),
    show: vi.fn<() => void>(),
    focus: vi.fn<() => void>(),
  }
  const createWindow = vi.fn<() => typeof window>(() => window)
  const startSandboxPosture = vi.fn<() => void>()
  const start = vi.fn<() => Promise<void>>(async () => {
    startSandboxPosture()
    createWindow()
  })
  return { app, window, createWindow, startSandboxPosture, start }
}

describe('04 step 12a: the userData single-instance lock', () => {
  it('quits without creating a window or starting sandbox posture when the lock is refused', async () => {
    const f = fixture(false)
    await startSingleInstance(f.app, () => f.window, f.start)
    expect(f.app.requestSingleInstanceLock).toHaveBeenCalledOnce()
    expect(f.app.quit).toHaveBeenCalledOnce()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.createWindow).not.toHaveBeenCalled()
    expect(f.startSandboxPosture).not.toHaveBeenCalled()
    expect(f.app.listenerCount('second-instance')).toBe(0)
  })

  it('starts only after acquiring the lock and restores and focuses the existing window', async () => {
    const f = fixture(true)
    await startSingleInstance(f.app, () => f.window, f.start)
    expect(f.app.quit).not.toHaveBeenCalled()
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.app.requestSingleInstanceLock.mock.invocationCallOrder[0]).toBeLessThan(
      f.start.mock.invocationCallOrder[0]!,
    )
    f.app.emit('second-instance')
    expect(f.window.restore).toHaveBeenCalledOnce()
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.window.focus).toHaveBeenCalledOnce()
    expect(f.window.restore.mock.invocationCallOrder[0]).toBeLessThan(
      f.window.focus.mock.invocationCallOrder[0]!,
    )
    expect(f.createWindow).toHaveBeenCalledOnce()
  })

  it('focuses an unminimized window and tolerates a second launch with no window open', async () => {
    const f = fixture(true)
    f.window.isMinimized.mockReturnValue(false)
    let opened: typeof f.window | undefined = f.window
    await startSingleInstance(f.app, () => opened, f.start)
    f.app.emit('second-instance')
    expect(f.window.restore).not.toHaveBeenCalled()
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.window.focus).toHaveBeenCalledOnce()
    opened = undefined
    expect(() => f.app.emit('second-instance')).not.toThrow()
    expect(f.window.focus).toHaveBeenCalledOnce()
    expect(f.createWindow).toHaveBeenCalledOnce()
  })
})
