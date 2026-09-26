import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chatNew, configLocale } from '@tenon-app/contracts'
import {
  absolutePath,
  createProviderRegistry,
  createSessionService,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import { app, BrowserWindow, Menu, ipcMain, session, shell } from 'electron'
import { createDesktopLoop, registerChatRoutes } from './chat.js'
import { registerConfigRoutes } from './config.js'
import { loadDevEnv } from './dev-env.js'
import { createDesktopHost } from './host/index.js'
import { readConfig } from './host/profile.js'
import { desktopInspectors } from './inspectors.js'
import { createLocaleController } from './locale.js'
import { buildApplicationMenu } from './menu.js'
import { hardenWebContents } from './navigation.js'
import { preferredSystemLanguages } from './preferred-languages.js'
import { registerProviderRoutes } from './provider-routes.js'
import { createRunConnector } from './run-assembly.js'
import { registerSessionRoutes } from './session.js'
import { registerApprovalRoutes } from './approval-routes.js'
import { recoveryDelayMs, startRecovery } from './startup-recovery.js'
import { openSessionStore } from './tape/open.js'

// Phase 0 runs one local profile. Accounts and organisations arrive with the server host.
const LOCAL_USER_ID = 'local'
const LOCAL_TENANT_ID = 'personal'

/** Read by the preload (the literal is repeated there, as `--tenon-locale=` already is). */
const NEW_CHAT_ARG = '--tenon-new-chat'

// Placeholders, not implemented in phase 0: app.requestSingleInstanceLock() and the
// `tenon://` deep-link registration.

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** The one document a Tenon window may show: the dev server in development, the built file otherwise. */
function appUrl(): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) return devUrl
  return pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
}

/**
 * `fresh` = this window must open on an EMPTY conversation instead of restoring the newest one.
 * It rides the same channel as the locale because it has to be true before the renderer's first
 * paint: "New Chat" with no window open opens one, and a window that then restored the previous
 * conversation would be the opposite of what was asked for.
 */
function createWindow(locale: string, title: string, fresh: boolean): BrowserWindow {
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
      additionalArguments: [`--tenon-locale=${locale}`, ...(fresh ? [NEW_CHAT_ARG] : [])],
    },
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[preload-error]', preloadPath, error.message)
  })
  void win.loadURL(appUrl())
  return win
}

// Every webContents, including ones created later, is pinned to the app document.
app.on('web-contents-created', (_event, contents) => {
  hardenWebContents(contents, appUrl(), (url) => void shell.openExternal(url))
})

async function main(): Promise<void> {
  const devEnv = loadDevEnv()
  if (devEnv) console.warn('[dev-env] loaded', devEnv)
  await app.whenReady()
  // Phase 0 needs no web permissions (camera, geolocation, notifications…): deny them all.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  session.defaultSession.setPermissionCheckHandler(() => false)
  const host = await createDesktopHost({
    userDataDir: absolutePath(app.getPath('userData')),
    userId: LOCAL_USER_ID,
    tenantId: LOCAL_TENANT_ID,
    send: broadcast,
    log: (line) => console.warn(line),
    isPackaged: app.isPackaged,
  })

  // The conversation store, the provider table and the one kernel service that writes facts. The
  // store is handed straight to the service and no reference is kept: `apps/*` never calls
  // `TapeStore.append` itself (spec 01 §保留命名空间). Ids are drawn HERE — the kernel takes an
  // `IdSource` precisely so that it draws no randomness of its own.
  const tape = openSessionStore({
    identity: host.identity,
    now: () => host.clock.now(),
    log: (line) => console.error(line),
  })
  const providers = createProviderRegistry()
  registerBuiltinProviders(providers)
  const preferred = preferredSystemLanguages()
  const locale = await createLocaleController(
    await readConfig(host.fs, host.identity),
    preferred,
    broadcast,
  )
  // The agent loop is the kernel's (spec 02 §主进程与 kernel 的循环接口): the connector goes in at
  // construction, the host's run-time half — the RunRegistry, the queue, the events — through
  // bindLoop, before anything can send. The protected shell files arrive with the tools that touch
  // files (plan step 18).
  const sessions =
    tape === null
      ? null
      : createSessionService({
          host,
          tape,
          ids: { uuid: (): string => randomUUID() },
          inspectors: desktopInspectors(),
          connector: createRunConnector({
            host,
            providers,
            isPackaged: app.isPackaged,
            log: (line) => console.warn(line),
          }),
          protectedFiles: [],
          // A call reaching a request with no result: a thrown bug in development, a repair closure
          // and a log line in the packaged build (spec 02 §崩溃、服务端调用块与兜底).
          onUnansweredCall: app.isPackaged ? 'repair' : 'throw',
          log: (line) => console.error(line),
        })
  const loop =
    sessions === null
      ? null
      : createDesktopLoop({
          clock: host.clock,
          send: broadcast,
          locale: () => (locale.current === 'zh-CN' ? 'zh-CN' : 'en'),
          log: (line) => console.warn(line),
        })
  if (sessions !== null && loop !== null) sessions.bindLoop(loop.ports)
  // Right after bindLoop: the routes below wait for it (spec 02 §启动恢复与发送防护).
  const recovery = startRecovery({
    sessions,
    delayMs: recoveryDelayMs(app.isPackaged, process.env),
    log: (line) => console.error(line),
  })
  if (tape !== null) {
    // WAL: the last connection to close is what checkpoints the file.
    app.on('will-quit', () => void tape.close())
  }

  const appTitle = (): string => locale.i18n.t('app.name')
  const openWindow = (fresh = false): BrowserWindow =>
    createWindow(locale.current, appTitle(), fresh)
  const newChat = (): void => {
    const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (target) target.webContents.send(chatNew.channel, {})
    // No window to tell (macOS keeps the menu bar alive after the last one closed): open one, and
    // tell it up front that it is a new chat, or it would restore the conversation just left.
    else openWindow(true)
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
  registerChatRoutes({ send: broadcast, ipcMain, sessions, loop, gate: recovery.ready })
  registerSessionRoutes({ ipcMain, sessions, gate: recovery.ready })
  registerApprovalRoutes({ ipcMain, sessions, gate: recovery.ready })
  registerProviderRoutes({ ipcMain, host, providers, log: (line) => console.warn(line) })

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
