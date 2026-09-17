import { configGet, configSet, registerRoute } from '@tenon-app/contracts'
import type { Config, IpcMainLike } from '@tenon-app/contracts'
import type { HostAdapter } from '@tenon-app/kernel'
import { readConfig, writeConfig } from './host/profile.js'

export function registerConfigRoutes(
  ipcMain: IpcMainLike,
  host: HostAdapter,
  onChange: (next: Config) => void,
): void {
  registerRoute(ipcMain, configGet, () => readConfig(host.fs, host.identity))
  registerRoute(ipcMain, configSet, async (patch) => {
    const next = await writeConfig(host.fs, host.identity, patch)
    onChange(next)
    return next
  })
}
