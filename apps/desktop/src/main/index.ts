import { join } from 'node:path'
import { chatNew, configLocale } from '@tenon-app/contracts'
import { absolutePath } from '@tenon-app/kernel'
import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron'
import { registerChatRoutes } from './chat.js'
import { registerConfigRoutes } from './config.js'
import { createDesktopHost } from './host/index.js'
import { readConfig } from './host/profile.js'
import { createLocaleController } from './locale.js'
import { buildApplicationMenu } from './menu.js'
import { preferredSystemLanguages } from './preferred-languages.js'

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

function createWindow(locale: string, title: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title,
    webPreferences: {
      // .cjs: the preload is built as CommonJS because sandboxed preloads cannot be ESM.
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The resolved locale reaches the renderer before its first paint.
      additionalArguments: [`--tenon-locale=${locale}`],
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

  const preferred = preferredSystemLanguages()
  const locale = await createLocaleController(
    await readConfig(host.fs, host.identity),
    preferred,
    broadcast,
  )
  const appTitle = (): string => locale.i18n.t('app.name')
  const openWindow = (): BrowserWindow => createWindow(locale.current, appTitle())
  const newChat = (): void => {
    const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (target) target.webContents.send(chatNew.channel, {})
    else openWindow()
  }
  const installMenu = (): void => {
    Menu.setApplicationMenu(buildApplicationMenu(locale.i18n, newChat))
  }
  locale.onChange(() => {
    installMenu()
    for (const win of BrowserWindow.getAllWindows()) win.setTitle(appTitle())
  })
  installMenu()

  registerConfigRoutes(ipcMain, host, (next) => void locale.apply(next))
  registerChatRoutes({ host, send: broadcast, ipcMain })

  const win = openWindow()
  win.webContents.on('did-finish-load', () => {
    win.webContents.send(configLocale.channel, { locale: locale.current })
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

void main().catch((error: unknown) => {
  console.error('[main] failed to start', error)
  app.exit(1)
})
