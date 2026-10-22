interface InstanceApp {
  requestSingleInstanceLock(): boolean
  quit(): void
  on(event: 'second-instance', listener: () => void): unknown
}

interface InstanceWindow {
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

/** Acquire Electron's userData lock before any host, sandbox posture or window starts (04 §00.4). */
export async function startSingleInstance(
  app: InstanceApp,
  window: () => InstanceWindow | undefined,
  start: () => Promise<void>,
): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    const opened = window()
    if (opened === undefined) return
    if (opened.isMinimized()) opened.restore()
    opened.show()
    opened.focus()
  })
  await start()
}
