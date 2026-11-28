// PROBE (probe/packaging, never merged): the self-check behind TENON_PROBE=1. It prints one JSON
// document between TENON_PROBE_BEGIN / TENON_PROBE_END lines (and writes it to TENON_PROBE_OUT when
// set), then exits. It touches no real credential store and uses none of the repository's test seams.
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { crashReporter } from 'electron'
import type { App, BrowserWindow } from 'electron'
import { toolOutputDirFor } from '@tenon-app/kernel'
import type { AbsolutePath } from '@tenon-app/kernel'
import type { createDesktopHost } from './host/index.js'
import { helperPaths } from './host/sandbox-config.js'

type ProbeHost = Awaited<ReturnType<typeof createDesktopHost>>

/**
 * error-logs P1: a real crash from inside the app, once the window has loaded
 * (TENON_PROBE_CRASH=renderer or main). A kill -SEGV from outside may not reach Crashpad on macOS,
 * which listens for Mach exceptions; a real fault does.
 */
export function probeSelfCrash(win: BrowserWindow): void {
  const mode = process.env['TENON_PROBE_CRASH']
  if (mode !== 'renderer' && mode !== 'main') return
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (mode === 'renderer') win.webContents.forcefullyCrashRenderer()
      else process.crash()
    }, 5_000)
  })
}

/**
 * error-logs P1's positive control: the same crash with collection switched on. Off unless
 * TENON_PROBE_CRASHREPORTER=1; nothing in the app starts the crash reporter otherwise.
 */
export function probeCrashControl(): void {
  if (process.env['TENON_PROBE_CRASHREPORTER'] !== '1') return
  crashReporter.start({ submitURL: 'http://127.0.0.1:9/', uploadToServer: false })
}
type Section = Record<string, unknown>

const message = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

/** Runs one section; a failure becomes data instead of ending the probe. */
async function section(work: () => unknown): Promise<unknown> {
  try {
    return await work()
  } catch (error) {
    return { error: message(error) }
  }
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}

/** What a file is: existence, mode, X_OK and (off asar) what `file` says. Never throws. */
function inspectFile(path: string): Section {
  const info: Section = { path, inAsar: path.includes('.asar') }
  try {
    const stat = statSync(path)
    info['exists'] = true
    info['isFile'] = stat.isFile()
    info['mode'] = (stat.mode & 0o777).toString(8)
    info['size'] = stat.size
  } catch (error) {
    info['exists'] = false
    info['statError'] = message(error)
  }
  try {
    accessSync(path, constants.X_OK)
    info['xOk'] = true
  } catch {
    info['xOk'] = false
  }
  try {
    info['realpath'] = realpathSync(path)
  } catch (error) {
    info['realpathError'] = message(error)
  }
  try {
    info['file'] = execFileSync('/usr/bin/file', ['-b', path], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim()
  } catch (error) {
    info['fileError'] = message(error)
  }
  return info
}

/** Runs a path once with --help: what spawn makes of it (ENOTDIR for a path inside app.asar). */
function tryExec(path: string): Section {
  const result = spawnSync(path, ['--help'], { encoding: 'utf8', timeout: 5_000 })
  return {
    status: result.status,
    signal: result.signal,
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
    errorMessage: result.error?.message ?? null,
  }
}

/** The two helpers as the packaged build resolves them, and as the unpatched code did (inside asar). */
function helperSection(app: App): Section {
  const arch = process.arch
  const inUse = helperPaths(arch, app.isPackaged ? process.resourcesPath : undefined)
  const legacySection = (): Section => {
    try {
      const legacy = helperPaths(arch)
      return {
        packageDir: legacy.packageDir,
        applySeccomp: { ...inspectFile(legacy.applySeccomp), spawn: tryExec(legacy.applySeccomp) },
        javaAgentJar: inspectFile(legacy.javaAgentJar),
      }
    } catch (error) {
      return { error: message(error) }
    }
  }
  return {
    inUse: {
      packageDir: inUse.packageDir,
      applySeccomp: inspectFile(inUse.applySeccomp),
      javaAgentJar: inspectFile(inUse.javaAgentJar),
    },
    // What an unpatched build would hand srt: where the path goes, and what spawn makes of it.
    legacy: legacySection(),
  }
}

function resourcesSection(): Section {
  const resources = process.resourcesPath
  const find = (dir: string): string[] => {
    try {
      return execFileSync('/usr/bin/find', [dir, '-name', '*.node'], {
        encoding: 'utf8',
        timeout: 20_000,
      })
        .split('\n')
        .filter((line) => line !== '')
    } catch (error) {
      return [message(error)]
    }
  }
  const unpacked = join(resources, 'app.asar.unpacked')
  const asarList = (): string[] => {
    // Electron's patched readdirSync lists inside app.asar.
    try {
      return readdirSync(join(resources, 'app.asar', 'node_modules')).toSorted()
    } catch (error) {
      return [message(error)]
    }
  }
  return {
    resourcesPath: resources,
    entries: readdirSync(resources).toSorted(),
    unpackedExists: existsSync(unpacked),
    unpackedNodeFiles: existsSync(unpacked) ? find(unpacked) : [],
    asarNodeModules: asarList(),
  }
}

async function nativeSection(): Promise<Section> {
  const require = createRequire(import.meta.url)
  const out: Section = {}
  out['sqlite'] = await section(async () => {
    const mod = (await import('better-sqlite3')) as unknown as {
      default: new (path: string) => {
        prepare(sql: string): { get(): unknown }
        close(): void
      }
    }
    const db = new mod.default(':memory:')
    try {
      return {
        resolved: require.resolve('better-sqlite3'),
        row: db.prepare('select sqlite_version() as version, 1 + 1 as two').get(),
      }
    } finally {
      db.close()
    }
  })
  out['keyring'] = await section(async () => {
    const mod = (await import('@napi-rs/keyring')) as unknown as {
      Entry: new (service: string, user: string) => unknown
    }
    // Construct only: no get, set or delete, so no keychain item is read or written.
    const entry = mod.Entry
    const started = Date.now()
    const made = new entry('tenon-probe-service', 'tenon-probe-account')
    return {
      resolved: require.resolve('@napi-rs/keyring'),
      exports: Object.keys(mod).toSorted(),
      constructed: made !== null && typeof made === 'object',
      constructMs: Date.now() - started,
      dbusSessionAddressSet: process.env['DBUS_SESSION_BUS_ADDRESS'] !== undefined,
    }
  })
  return out
}

/** Linux only: is Chromium's own sandbox on? seccomp mode 2 in the renderer says it is. */
function chromiumSection(app: App, win: BrowserWindow): Section {
  const status = (pid: number): Section => {
    try {
      const text = readFileSync(`/proc/${pid}/status`, 'utf8')
      const pick = (key: string): string | null =>
        new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(text)?.[1] ?? null
      return {
        seccomp: pick('Seccomp'),
        noNewPrivs: pick('NoNewPrivs'),
        userNs: readlinkSync(`/proc/${pid}/ns/user`),
        cmdline: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, 6).join(' '),
      }
    } catch (error) {
      return { error: message(error) }
    }
  }
  const out: Section = {
    noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'),
    argvHasNoSandbox: process.argv.includes('--no-sandbox'),
  }
  if (process.platform !== 'linux') return out
  out['self'] = { pid: process.pid, ...status(process.pid) }
  out['renderer'] = (() => {
    const pid = win.isDestroyed() ? null : win.webContents.getOSProcessId()
    return pid === null ? null : { pid, ...status(pid) }
  })()
  out['metrics'] = app
    .getAppMetrics()
    .map((one) => Object.assign({ type: one.type, pid: one.pid }, status(one.pid)))
  return out
}

/** Real commands through the real wrapper, as the Bash tool sends them. */
async function commandsSection(host: ProbeHost): Promise<Section> {
  // Under the home directory, not /tmp: the Linux sandbox gives its commands a fresh /tmp.
  const workspace = realpathSync(mkdtempSync(join(homedir(), 'tenon-probe-ws-'))) as AbsolutePath
  const outside = join(homedir(), 'tenon-probe-denied.txt')
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: homedir(),
  }
  // The sandbox only accepts a workspace that is one of a session's folders (读法 35): make this
  // one a session of its own, with its tool-output folder, as the session service would.
  const sessionId = randomUUID()
  mkdirSync(toolOutputDirFor(host.identity.profileDir as AbsolutePath, sessionId), {
    recursive: true,
  })
  host.sandbox.bindSessionFolders((id) => Promise.resolve(id === sessionId ? [workspace] : []))
  const run = async (id: string, script: string): Promise<Section> => {
    const commandId = `probe-${id}`
    try {
      host.sandbox.beforeWrap({ commandId, sessionId, hosts: [] })
      const wrapped = await host.sandbox.wrap({
        commandId,
        argv: ['/bin/sh', '-c', script],
        cwd: workspace,
        env,
        profile: 'workspace-write',
        workspace: [workspace],
      })
      const child = await host.process.spawn({
        argv: wrapped.argv,
        cwd: workspace,
        env: wrapped.env,
        stdio: 'pipe',
      })
      const [stdout, stderr, exit] = await within(
        Promise.all([drain(child.stdout), drain(child.stderr), child.exited]),
        30_000,
        id,
      )
      await host.sandbox.afterExit(commandId)
      const violations = await host.sandbox.violations(commandId)
      return {
        argv0: wrapped.argv[0],
        exit,
        stdout: stdout.slice(0, 400),
        stderr: stderr.slice(0, 400),
        violations: violations.map((one) => ({ kind: one.kind, target: one.target ?? null })),
      }
    } catch (error) {
      return { error: message(error) }
    }
  }
  return {
    workspace,
    echo: await run('echo', 'echo ok'),
    writeInside: await run('inside', `echo x > ${workspace}/inside.txt && echo wrote-inside`),
    // Must be refused: the home directory is outside the workspace.
    writeOutside: await run('outside', `( echo x > ${outside} ) 2>&1; echo exit=$?`),
    outsideFileExists: existsSync(outside),
  }
}

export async function runProbe(q: {
  app: App
  host: ProbeHost
  win: BrowserWindow
}): Promise<void> {
  const { app, host, win } = q
  const started = Date.now()
  const result: Section = { probe: 1, at: new Date().toISOString() }
  try {
    result['app'] = {
      name: app.name,
      getName: app.getName(),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      exe: app.getPath('exe'),
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
      logs: app.getPath('logs'),
      crashDumps: app.getPath('crashDumps'),
      resourcesPath: process.resourcesPath,
    }
    result['process'] = {
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions['electron'],
        node: process.versions.node,
        chrome: process.versions['chrome'],
      },
      argv: process.argv,
      env: {
        PATH: process.env['PATH'] ?? null,
        HOME: process.env['HOME'] ?? null,
        DISPLAY: process.env['DISPLAY'] ?? null,
      },
    }
    result['packageJson'] = await section(() => {
      const manifest = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
        name?: string
        productName?: string
        version?: string
      }
      return { name: manifest.name, productName: manifest.productName, version: manifest.version }
    })
    result['resources'] = await section(resourcesSection)
    result['helpers'] = await section(() => helperSection(app))
    result['native'] = await section(nativeSection)
    // The window has to be there before Chromium's renderer can be looked at.
    await section(() =>
      win.webContents.isLoading()
        ? within(
            new Promise<void>((resolve) =>
              win.webContents.once('did-finish-load', () => resolve()),
            ),
            30_000,
            'did-finish-load',
          )
        : undefined,
    )
    result['chromium'] = await section(() => chromiumSection(app, win))
    result['sandbox'] = await section(async () => {
      const outcome = await within(host.sandbox.start().outcome, 90_000, 'sandbox startup')
      const view = host.sandbox.view()
      return {
        state: outcome.state,
        posture: view.posture,
        platform: view.platform,
        reasons: view.reasons,
        commands: await commandsSection(host),
      }
    })
  } catch (error) {
    result['fatal'] = message(error)
  } finally {
    result['elapsedMs'] = Date.now() - started
    const text = JSON.stringify(result, null, 2)
    process.stdout.write(`TENON_PROBE_BEGIN\n${text}\nTENON_PROBE_END\n`)
    const out = process.env['TENON_PROBE_OUT']
    if (out !== undefined && out !== '') writeFileSync(out, text)
    await within(host.sandbox.dispose(), 10_000, 'sandbox dispose').catch(() => undefined)
    app.exit(0)
  }
}
