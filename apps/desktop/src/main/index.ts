import { join } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { registerChatRoutes } from './chat.js'
import { registerConfigRoutes } from './config.js'
import { createDesktopHost } from './host/index.js'

// Phase 0 runs one local profile. Accounts and organisations arrive with the server host.
const LOCAL_USER_ID = 'local'
const LOCAL_TENANT_ID = 'personal'

// Placeholders, not implemented in phase 0: app.requestSingleInstanceLock() and the
// `tenon://` deep-link registration.

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      // .cjs: the preload is built as CommonJS because sandboxed preloads cannot be ESM.
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[preload-error]', preloadPath, error.message)
  })
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

async function main(): Promise<void> {
  await app.whenReady()
  const host = await createDesktopHost({
    userDataDir: absolutePath(app.getPath('userData')),
    userId: LOCAL_USER_ID,
    tenantId: LOCAL_TENANT_ID,
    send: broadcast,
    log: (line) => console.warn(line),
  })
  registerConfigRoutes(ipcMain, host, () => {})
  registerChatRoutes({ host, send: broadcast, ipcMain })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

void main().catch((error: unknown) => {
  console.error('[main] failed to start', error)
  app.exit(1)
})
