import type { AbsolutePath, HostAdapter } from '@tenon-app/kernel'
import { SystemClock } from './clock.js'
import { IpcConfirm } from './confirm.js'
import type { EventSender } from './confirm.js'
import { DesktopFs } from './fs.js'
import { createDesktopNetwork } from './network.js'
import { createHostProcess } from './process.js'
import { openProfile } from './profile.js'
import { PassthroughSandbox } from './sandbox.js'
import { KeychainSecrets, MemorySecrets } from './secrets.js'

export interface DesktopHostOptions {
  /** Electron's `app.getPath('userData')`, already absolute. */
  userDataDir: AbsolutePath
  userId: string
  tenantId: string
  /** Pushes a main → renderer event; the host never touches BrowserWindow itself. */
  send: EventSender
  log: (line: string) => void
  /** `app.isPackaged`, passed in rather than read so this module stays free of electron. */
  isPackaged: boolean
}

/**
 * The e2e secrets seam (spec 01 §desktop 接线): a DEV build that was asked for it keeps its
 * secrets in this process instead of the OS keychain. Same shape of switch as `TENON_DEV_ENV=off`,
 * and refused outright once packaged — a shipped Tenon has exactly one credential store.
 */
export function useMemorySecrets(
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !isPackaged && env['TENON_SECRETS'] === 'memory'
}

/** Builds the desktop HostAdapter and creates the profile directory on the way. */
export async function createDesktopHost(options: DesktopHostOptions): Promise<HostAdapter> {
  const fs = new DesktopFs()
  const identity = await openProfile(fs, options.userDataDir, options.userId, options.tenantId)
  return {
    identity,
    fs,
    secrets: useMemorySecrets(options.isPackaged) ? new MemorySecrets() : new KeychainSecrets(),
    process: createHostProcess(),
    sandbox: new PassthroughSandbox(options.log),
    confirm: new IpcConfirm(options.send),
    clock: new SystemClock(),
    network: createDesktopNetwork(),
  }
}

export { DesktopFs } from './fs.js'
export { IpcConfirm } from './confirm.js'
export type { EventSender } from './confirm.js'
export { KeychainSecrets, MemorySecrets, KEYCHAIN_SERVICE } from './secrets.js'
export { PassthroughSandbox } from './sandbox.js'
export { SystemClock } from './clock.js'
export { createDesktopNetwork } from './network.js'
export {
  createHostProcess,
  spawnChild,
  killTree,
  readableToWeb,
  SpawnSpecError,
} from './process.js'
export { openProfile, readConfig, writeConfig, configPath } from './profile.js'
