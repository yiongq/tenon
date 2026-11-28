import type { AbsolutePath } from '@tenon-app/kernel'
import { appLog, logsDirOf } from './log/app-log.js'
import { summarizeError } from './log/redact.js'
import { logRouteFailures, watchRendererConsole } from './log/watch.js'
import { createSensitivePathProvider } from './host/sensitive-paths.js'
// oxlint-disable-next-line import/default -- electron-vite emits this worker factory from the query
import SchemaThread from './mcp/schema-thread.mjs?nodeWorker'
import { createSchemaWorker } from './mcp/schema-worker.js'
import { createDesktopMcp } from './mcp/controller.js'
import { registerMcpRoutes } from './mcp/routes.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chatNew, configLocale, mcpChanged } from '@tenon-app/contracts'
import {
  absolutePath,
  createProviderRegistry,
  createSessionService,
  profileDirFor,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import {
  app,
  autoUpdater,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
} from 'electron'
import { createDesktopLoop, registerChatRoutes } from './chat.js'
import { createProviderView } from './custom-vendors/registry.js'
import { createProbeRuns, registerCustomVendorRoutes } from './custom-vendors/routes.js'
import { registerConfigRoutes } from './config.js'
import { loadDevEnv } from './dev-env.js'
import { createDesktopHost } from './host/index.js'
import { startSandboxAfterWindow } from './host/sandbox-runtime.js'
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
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  windowBackground,
  windowFrame,
} from './window-theme.js'
import tokensCss from '../styles/tokens.css?raw'
import { registerModelRoutes } from './model-routes.js'
import { createShutdown, refuseWhileShuttingDown, registerSandboxSignals } from './shutdown.js'
import { startSingleInstance } from './single-instance.js'
import { registerApprovalModeRoutes, trackApprovalModeDefault } from './approval-mode-routes.js'
import { createFolderGrants } from './folder-grants.js'
import { registerInspectorRoutes } from './inspector-routes.js'
import { registerSandboxRoutes } from './sandbox-routes.js'
import { registerSnapshotRoutes, snapshotWindowCanAccess } from './snapshot-routes.js'
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

// Placeholder, not implemented in phase 0: the `tenon://` deep-link registration.

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** The colour behind the page for the system's current theme, read from the token sheet. */
function background(): string {
  return windowBackground(nativeTheme.shouldUseDarkColors, tokensCss)
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
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    backgroundColor: background(),
    show: false,
    title,
    ...windowFrame(process.platform),
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

  // The renderer follows the system theme; the native layer behind it has to follow too.
  const paintBackground = (): void => {
    if (!win.isDestroyed()) win.setBackgroundColor(background())
  }
  nativeTheme.on('updated', paintBackground)
  win.once('closed', () => nativeTheme.off('updated', paintBackground))

  win.on('ready-to-show', () => {
    win.show()
    appLog.write('info', { event: 'window.shown' })
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    appLog.line('preload', 'error')(`[preload-error] ${preloadPath} ${error.message}`)
  })
  watchRendererConsole(win.webContents, appLog)
  void win.loadURL(appUrl())
  return win
}

// Every webContents, including ones created later, is pinned to the app document.
app.on('web-contents-created', (_event, contents) => {
  hardenWebContents(contents, appUrl(), (url) => void shell.openExternal(url))
})

async function main(): Promise<void> {
  // The app log, before anything that can fail or has something to say (error-logs §怎么写「打开」):
  // the start is the first line of this launch, written to the buffer ahead of what other code says
  // before the file is there; `open` writes the note about an unclean last exit in front of it.
  const userData = app.getPath('userData')
  appLog.write('info', {
    event: 'app.start',
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    userData,
  })
  appLog.open(logsDirOf(profileDirFor(absolutePath(userData), LOCAL_USER_ID, LOCAL_TENANT_ID)), {
    version: app.getVersion(),
    packaged: app.isPackaged,
    home: absolutePath(app.getPath('home')),
    // The folder the app lives in: the resources of an installed Tenon, the package in development.
    appDir: absolutePath(app.isPackaged ? process.resourcesPath : app.getAppPath()),
  })
  app.on('will-quit', () => appLog.close())
  // First, before loadDevEnv: Bash's fallback environment is the one Tenon was started with, never
  // `.env.local` (spec 02 §内置工具与参数「Bash」); so is the origin map seam's (M6 §点名「测试接缝」).
  const startupEnv = snapshotEnv(process.env)
  const devEnv = loadDevEnv()
  if (devEnv) appLog.line('dev-env', 'info')(`[dev-env] loaded ${devEnv}`)
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
    userDataDir: absolutePath(userData),
    userId: LOCAL_USER_ID,
    tenantId: LOCAL_TENANT_ID,
    send: broadcast,
    log: appLog.line('host', 'warn'),
    // `sandbox: active …` is the sandbox as it should be: information, same source (error-logs §记什么).
    info: appLog.line('host', 'info'),
    unattributedLog: appLog.line('sandbox-unattributed', 'warn'),
    isPackaged: app.isPackaged,
    startupEnv,
  })

  // The conversation store, the provider table and the one kernel service that writes facts. The
  // store is handed straight to the service and no reference is kept: `apps/*` never calls
  // `TapeStore.append` itself (spec 01 §保留命名空间). Ids are drawn HERE — the kernel takes an
  // `IdSource` precisely so that it draws no randomness of its own.
  const tape = openSessionStore({
    identity: host.identity,
    now: () => host.clock.now(),
    log: appLog.line('tape', 'error'),
  })
  const builtin = createProviderRegistry()
  registerBuiltinProviders(builtin)
  const preferred = preferredSystemLanguages()
  const startupConfig = await readConfig(host.fs, host.identity)
  const approvalModeDefault = trackApprovalModeDefault(host.identity, startupConfig.approvalMode)
  // Spec 06 D42: the pending folder grants, in this process's memory only.
  const folderGrants = createFolderGrants()
  // M6 §注册表视图 (01 修补 6「desktop 接线」): run assembly, the provider routes and the model routes
  // all take the builtin definitions plus the custom vendor instances, the latter following every
  // write of `config.json` from this startup read on.
  const providers = createProviderView({ builtin, identity: host.identity, config: startupConfig })
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
    log: appLog.line('shell', 'warn'),
  })
  const schemaValidator = createSchemaWorker({ createWorker: () => SchemaThread({}) })
  const mcp = createDesktopMcp({
    host,
    config: startupConfig,
    home,
    baseEnv: commandShell.env,
    uuid: randomUUID,
    schemaValidator,
    changed: () => broadcast(mcpChanged.channel, mcpChanged.payload.parse({})),
  })
  const pathProtection = createSensitivePathProvider(
    home,
    startupEnv['ZDOTDIR']?.startsWith('/') ? absolutePath(startupEnv['ZDOTDIR']) : null,
    { xdgConfigHome: startupEnv['XDG_CONFIG_HOME'] ?? null },
  )
  const workspaceLog = appLog.line('workspace', 'warn')
  const refreshSensitive = (folders: readonly AbsolutePath[]): void => {
    void pathProtection
      .refresh(folders)
      .catch((error: unknown) =>
        workspaceLog(
          '[workspace] sensitive targets refresh failed: ' +
            (error instanceof Error ? error.message : String(error)),
        ),
      )
  }
  host.snapshots.bindSensitiveRefresh(refreshSensitive)
  const sessions =
    tape === null
      ? null
      : createSessionService({
          host,
          // Spec 06 §档位怎么存、怎么切: read when a send starts, from config.json's `approvalMode`.
          approvalModeDefault,
          schemaValidator,
          userSetting: mcp.userSetting,
          tape,
          ids: { uuid: (): string => randomUUID() },
          inspectors: desktopInspectors(),
          ...compactionTestOptions(app.isPackaged, process.env),
          connector: createRunConnector({
            host,
            mcpPool: mcp.pool,
            providers,
            isPackaged: app.isPackaged,
            log: appLog.line('provider', 'warn'),
            // Before bindLoop and recover(): a resume's endpointOrigin is the configured host.
            config: startupConfig,
          }),
          sensitivePaths: pathProtection.get,
          sensitiveFallback: pathProtection.fallback,
          protectedFiles: protectedShellFiles(
            home,
            startupEnv['ZDOTDIR']?.startsWith('/') ? absolutePath(startupEnv['ZDOTDIR']) : null,
          ),
          // A call reaching a request with no result: a thrown bug in development, a repair closure
          // and a log line in the packaged build (spec 02 §崩溃、服务端调用块与兜底).
          onUnansweredCall: app.isPackaged ? 'repair' : 'throw',
          // The kernel's own lines, and the failed model requests among them (loop/run.ts).
          log: appLog.line('kernel', 'error'),
        })
  // Clearing and deleting a session, its tool-output folder with it (spec 02 §大响应落盘): its live
  // Run stopped first, and until one completes, the session takes no send and opens no Run.
  const removal =
    sessions === null
      ? null
      : createSessionRemoval({
          sessions,
          ...(tape === null ? {} : { tape }),
          // Bound late: the loop below takes this removal's `removing`.
          runs: () => loop?.registry ?? null,
          profileDir: absolutePath(host.identity.profileDir),
          removeSnapshots: (sessionId) => host.snapshots.removeSession(sessionId),
          // Spec 06 D42: a clear starts a new incarnation; the folder grant for the old one is void.
          onRemoval: (sessionId) => folderGrants.invalidate(sessionId),
          log: appLog.line('removal', 'warn'),
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
          sandbox: host.sandbox,
          removing,
          log: appLog.line('chat', 'warn'),
        })
  if (sessions !== null && loop !== null) sessions.bindLoop(loop.ports)
  host.snapshots.bindActiveRounds(() => loop?.registry.snapshot() ?? [])
  host.snapshots.bindSessionFolders(
    async (sessionId) => (await sessions?.sessionFacts({ sessionId }))?.workspace?.folders ?? [],
  )
  host.sandbox.bindSessionFolders(
    async (sessionId) => (await sessions?.sessionFacts({ sessionId }))?.workspace?.folders ?? [],
  )
  // Right after bindLoop: the routes below wait for it (spec 02 §启动恢复与发送防护).
  const recovery = startRecovery({
    sessions,
    delayMs: recoveryDelayMs(app.isPackaged, process.env),
    log: appLog.line('recovery', 'error'),
    info: appLog.line('recovery', 'info'),
  })
  // Closing a window and quitting (spec 02 §停止与退出): a Run in progress asks first, and the quit
  // runs the six steps — its fifth closes the store (WAL: the last connection to close is what
  // checkpoints the file), after the Runs it aborted have settled.
  const shutdownLog = appLog.line('shutdown', 'warn')
  const shutdown = createShutdown<BrowserWindow>({
    app,
    dialog,
    sandbox: host.sandbox,
    registry: loop?.registry ?? null,
    mcp,
    tape,
    t: (key) => locale.i18n.t(key),
    parent: () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null,
    log: shutdownLog,
  })
  // Before the windows close: `quitAndInstall` sends no `before-quit` until they have (there is no
  // auto-update yet; this is where it would stop the Runs).
  try {
    autoUpdater.on('before-quit-for-update', () => shutdown.beforeQuitForUpdate())
  } catch (error) {
    shutdownLog(
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
  // The log's wrapper goes outermost, closest to `registerRoute`: what the other wrappers refuse never
  // reaches it, and a request that failed in its own handler is one line (error-logs 验收 6).
  const routes = logRouteFailures(
    refuseWhileRemoving(
      refuseWhileShuttingDown(
        e2eRouteSeam(ipcMain, app.isPackaged, process.env),
        () => shutdown.started,
      ),
      removing,
    ),
    appLog,
  )
  registerMcpRoutes({
    locale: () => locale.current,
    ipcMain: routes,
    mcp,
    host,
    providers,
    home,
    baseEnv: commandShell.env,
    isPackaged: app.isPackaged,
    env: process.env,
    openExternal: (url) => shell.openExternal(url),
  })
  registerConfigRoutes(routes, host, (next) => void locale.apply(next))
  const sandboxRoutes = registerSandboxRoutes({
    ipcMain: routes,
    host,
    sandbox: host.sandbox,
    sessions,
    send: broadcast,
    gate: recovery.ready,
  })
  registerChatRoutes({ send: broadcast, ipcMain: routes, sessions, loop, gate: recovery.ready })
  registerSessionRoutes({ ipcMain: routes, sessions, gate: recovery.ready })
  registerSnapshotRoutes({
    ipcMain: routes,
    sessions,
    gate: recovery.ready,
    canAccessSession: (event) =>
      snapshotWindowCanAccess(event, BrowserWindow.getAllWindows(), appUrl()),
  })
  registerInspectorRoutes({ ipcMain: routes, sessions, gate: recovery.ready })
  registerApprovalModeRoutes({ ipcMain: routes, sessions, gate: recovery.ready })
  registerApprovalRoutes({ ipcMain: routes, sessions, gate: recovery.ready })
  registerWorkspaceRoutes({
    ipcMain: routes,
    sessions,
    host,
    home,
    gate: recovery.ready,
    grants: folderGrants,
    // Main's own dialog, over the window that asked: the only way a folder is added (A9).
    onWorkspaceChanged: (sessionId, folders) => {
      refreshSensitive(folders)
      return host.snapshots.setWorkspace(sessionId, folders)
    },
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
  // M6 §探测: one probe per instance at a time; a key save (provider.configure) and a delete abort it.
  const probes = createProbeRuns()
  registerProviderRoutes({
    ipcMain: routes,
    host,
    providers,
    isPackaged: app.isPackaged,
    log: appLog.line('provider', 'warn'),
    probes,
  })
  registerCustomVendorRoutes({
    ipcMain: routes,
    host,
    providers,
    probes,
    uuid: () => randomUUID(),
    // Shutdown step 3: a probe or a model list does not outlive the quit (§探测, §列表与上限).
    signal: shutdown.signal,
    isPackaged: app.isPackaged,
    log: appLog.line('custom-vendor', 'warn'),
  })
  registerModelRoutes({ ipcMain: routes, sessions, providers, host, gate: recovery.ready })

  const win = startSandboxAfterWindow(openWindow, host.sandbox)
  // start() returns the same run: signal handling observes startup without awaiting it here.
  registerSandboxSignals({ process, app, sandbox: host.sandbox, run: host.sandbox.start() })
  void host.sandbox.start().outcome.then((outcome) => {
    // What the sandbox came to, and the helper programs it was given (error-logs §记什么「生命周期」).
    appLog.write('info', {
      event: 'sandbox.posture',
      state: outcome.state,
      reasons: outcome.reasons.map((one) =>
        one.detail === null ? one.code : `${one.code}: ${one.detail}`,
      ),
    })
    // The notice goes out whatever the line after it does; the paths are the ones handed to the sandbox.
    sandboxRoutes.changed()
    appLog.write('info', { event: 'sandbox.helpers', ...host.sandbox.helpers })
  })
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

void startSingleInstance(
  app,
  () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0],
  main,
).catch((error: unknown) => {
  appLog.write('error', {
    event: 'app.startup-failed',
    error: summarizeError(error, appLog.redact),
  })
  app.exit(1)
})
