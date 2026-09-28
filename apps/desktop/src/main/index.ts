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
import { app, autoUpdater, BrowserWindow, Menu, dialog, ipcMain, session, shell } from 'electron'
import { createDesktopLoop, registerChatRoutes } from './chat.js'
import { registerConfigRoutes } from './config.js'
import { loadDevEnv } from './dev-env.js'
import { createDesktopHost } from './host/index.js'
import { pickShell, snapshotEnv, startCommandShell } from './host/shell-env.js'
import { readConfig } from './host/profile.js'
import { compactionTestOptions } from './compaction-test-seam.js'
import { desktopInspectors } from './inspectors.js'
import { createLocaleController } from './locale.js'
import { buildApplicationMenu } from './menu.js'
import { hardenWebContents, isSameDocument } from './navigation.js'
import { preferredSystemLanguages } from './preferred-languages.js'
import { registerProviderRoutes } from './provider-routes.js'
import { createRunConnector } from './run-assembly.js'
import { registerSessionRoutes } from './session.js'
import { registerApprovalRoutes } from './approval-routes.js'
import { recoveryDelayMs, startRecovery } from './startup-recovery.js'
import { e2eRouteSeam } from './e2e-routes.js'
import { openSessionStore } from './tape/open.js'
import { protectedShellFiles, registerWorkspaceRoutes } from './workspace.js'
import { replayOnLoad } from './window-replay.js'
import { registerModelRoutes } from './model-routes.js'
import { createShutdown, refuseWhileShuttingDown } from './shutdown.js'
import {
  createSessionRemoval,
  exposeSessionRemoval,
  refuseWhileRemoving,
} from './session-removal.js'

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
  // First, before loadDevEnv: Bash's fallback environment is the one Tenon was started with, never
  // `.env.local` (spec 02 §内置工具与参数「Bash」).
  const startupEnv = snapshotEnv(process.env)
  const devEnv = loadDevEnv()
  if (devEnv) console.warn('[dev-env] loaded', devEnv)
  await app.whenReady()
  // No web permissions (camera, geolocation, notifications…) but one: the app's own document may
  // write the clipboard, for the failure card's 「复制诊断信息」 (spec 02 §失败卡与结束原因). Reading it
  // stays denied.
  const mayWriteClipboard = (url: string, permission: string): boolean =>
    permission === 'clipboard-sanitized-write' && isSameDocument(url, appUrl())
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) =>
    callback(mayWriteClipboard(contents.getURL(), permission)),
  )
  session.defaultSession.setPermissionCheckHandler((contents, permission) =>
    mayWriteClipboard(contents?.getURL() ?? '', permission),
  )
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
  const startupConfig = await readConfig(host.fs, host.identity)
  const locale = await createLocaleController(startupConfig, preferred, broadcast)
  // The agent loop is the kernel's (spec 02 §主进程与 kernel 的循环接口): the connector goes in at
  // construction, the host's run-time half — the RunRegistry, the queue, the events — through
  // bindLoop, before anything can send. The protected shell files are computed in the user's home:
  // the kernel reads no home of its own (§「在不在工作区里」).
  const home = absolutePath(app.getPath('home'))
  // Bash's shell and the user's terminal environment, resolved once in the background from now on;
  // a Bash call before it answers waits for it (host/shell-env.ts).
  const commandShell = startCommandShell({
    host,
    shell: pickShell(),
    startupEnv,
    home,
    isPackaged: app.isPackaged,
    log: (line) => console.warn(line),
  })
  const sessions =
    tape === null
      ? null
      : createSessionService({
          host,
          tape,
          ids: { uuid: (): string => randomUUID() },
          inspectors: desktopInspectors(),
          ...compactionTestOptions(app.isPackaged, process.env),
          connector: createRunConnector({
            host,
            providers,
            isPackaged: app.isPackaged,
            log: (line) => console.warn(line),
            // Before bindLoop and recover(): a resume's endpointOrigin is the configured host.
            config: startupConfig,
          }),
          protectedFiles: protectedShellFiles(home),
          // A call reaching a request with no result: a thrown bug in development, a repair closure
          // and a log line in the packaged build (spec 02 §崩溃、服务端调用块与兜底).
          onUnansweredCall: app.isPackaged ? 'repair' : 'throw',
          log: (line) => console.error(line),
        })
  // Clearing and deleting a session, its tool-output folder with it (spec 02 §大响应落盘): its live
  // Run stopped first, and until one completes, the session takes no send and opens no Run.
  const removal =
    sessions === null
      ? null
      : createSessionRemoval({
          sessions,
          // Bound late: the loop below takes this removal's `removing`.
          runs: () => loop?.registry ?? null,
          profileDir: absolutePath(host.identity.profileDir),
          log: (line) => console.warn(line),
        })
  const removing = (sessionId: string): boolean => removal?.removing(sessionId) ?? false
  exposeSessionRemoval(removal, app.isPackaged, process.env)
  const loop =
    sessions === null
      ? null
      : createDesktopLoop({
          clock: host.clock,
          send: broadcast,
          locale: () => (locale.current === 'zh-CN' ? 'zh-CN' : 'en'),
          commandShell,
          removing,
          log: (line) => console.warn(line),
        })
  if (sessions !== null && loop !== null) sessions.bindLoop(loop.ports)
  // Right after bindLoop: the routes below wait for it (spec 02 §启动恢复与发送防护).
  const recovery = startRecovery({
    sessions,
    delayMs: recoveryDelayMs(app.isPackaged, process.env),
    log: (line) => console.error(line),
  })
  // Closing a window and quitting (spec 02 §停止与退出): a Run in progress asks first, and the quit
  // runs the six steps — its fifth closes the store (WAL: the last connection to close is what
  // checkpoints the file), after the Runs it aborted have settled.
  const shutdown = createShutdown<BrowserWindow>({
    app,
    dialog,
    registry: loop?.registry ?? null,
    tape,
    t: (key) => locale.i18n.t(key),
    parent: () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null,
    log: (line) => console.warn(line),
  })
  // Before the windows close: `quitAndInstall` sends no `before-quit` until they have (there is no
  // auto-update yet; this is where it would stop the Runs).
  try {
    autoUpdater.on('before-quit-for-update', () => shutdown.beforeQuitForUpdate())
  } catch (error) {
    console.warn(
      `[shutdown] no autoUpdater: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const appTitle = (): string => locale.i18n.t('app.name')
  const openWindow = (fresh = false): BrowserWindow => {
    const opened = createWindow(locale.current, appTitle(), fresh)
    opened.on('close', (event) => shutdown.onClose(opened, event))
    // A document that loads — the first one, a new window, a reload — gets the state it missed.
    replayOnLoad(opened.webContents, loop)
    return opened
  }
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

  // `ipcMain` itself, except in a development build an e2e asked to count or fail routes (e2e-routes.ts).
  // Once the quit's third step ran, a route that opens a Run or writes a fact answers ok: false; so
  // does a send to a session being cleared or deleted.
  const routes = refuseWhileRemoving(
    refuseWhileShuttingDown(
      e2eRouteSeam(ipcMain, app.isPackaged, process.env),
      () => shutdown.started,
    ),
    removing,
  )
  registerConfigRoutes(routes, host, (next) => void locale.apply(next))
  registerChatRoutes({ send: broadcast, ipcMain: routes, sessions, loop, gate: recovery.ready })
  registerSessionRoutes({ ipcMain: routes, sessions, gate: recovery.ready })
  registerApprovalRoutes({ ipcMain: routes, sessions, gate: recovery.ready })
  registerWorkspaceRoutes({
    ipcMain: routes,
    sessions,
    host,
    home,
    gate: recovery.ready,
    // Main's own dialog, over the window that asked: the only way a folder is added (A9).
    pickFolders: async (event) => {
      const sender = (event as { sender?: Electron.WebContents } | undefined)?.sender
      const owner = sender === undefined ? null : BrowserWindow.fromWebContents(sender)
      const options: Electron.OpenDialogOptions = {
        properties: ['openDirectory', 'multiSelections', 'createDirectory'],
      }
      const picked =
        owner === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(owner, options)
      return picked.canceled ? null : picked.filePaths
    },
  })
  registerProviderRoutes({
    ipcMain: routes,
    host,
    providers,
    isPackaged: app.isPackaged,
    log: (line) => console.warn(line),
  })
  registerModelRoutes({ ipcMain: routes, sessions, providers, host, gate: recovery.ready })

  const win = openWindow()
  win.webContents.on('did-finish-load', () => {
    win.webContents.send(configLocale.channel, { locale: locale.current })
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
}

// Off macOS the last window closing quits. A Run it stopped is aborted, so the quit does not ask
// again, but its fourth step still waits for that Run to settle (spec 02 §停止与退出).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

void main().catch((error: unknown) => {
  console.error('[main] failed to start', error)
  app.exit(1)
})
