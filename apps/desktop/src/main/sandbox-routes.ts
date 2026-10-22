import { isDeepStrictEqual } from 'node:util'
import {
  registerRoute,
  sandboxChanged,
  sandboxDomainSchema,
  sandboxGet,
  sandboxRelease,
  sandboxSetSettings,
} from '@tenon-app/contracts'
import type { IpcMainLike, RouteResponse } from '@tenon-app/contracts'
import type { HostAdapter, SessionService } from '@tenon-app/kernel'
import type { DesktopSandboxRuntime } from './host/sandbox-runtime.js'
import { readConfig, watchConfig, withConfigLock, writeConfigHeld } from './host/profile.js'

/** Settings stay in config; receipt validation and all fact writes belong to the kernel. */
export function registerSandboxRoutes(q: {
  readonly ipcMain: IpcMainLike
  readonly host: Pick<HostAdapter, 'fs' | 'identity'>
  readonly sandbox: Pick<DesktopSandboxRuntime, 'view'>
  readonly sessions: Pick<SessionService, 'release'> | null
  readonly send: (channel: string, payload: unknown) => void
  readonly gate?: Promise<void>
}): { changed(): void } {
  const changed = (): void => {
    q.send(sandboxChanged.channel, sandboxChanged.payload.parse(q.sandbox.view()))
  }
  let settings = q.sandbox.view().settings
  watchConfig(q.host.identity, (config) => {
    if (isDeepStrictEqual(settings, config.sandbox)) return
    settings = config.sandbox
    changed()
  })

  registerRoute(q.ipcMain, sandboxGet, () => q.sandbox.view())
  registerRoute(
    q.ipcMain,
    sandboxSetSettings,
    async (patch): Promise<RouteResponse<typeof sandboxSetSettings>> => {
      let allowedDomains: string[] | undefined
      if (patch.allowedDomains !== undefined) {
        if (patch.allowedDomains.length > 256) return { ok: false, code: 'too-many' }
        allowedDomains = []
        for (const [index, entry] of patch.allowedDomains.entries()) {
          const parsed = sandboxDomainSchema.safeParse(entry)
          if (!parsed.success) return { ok: false, code: 'invalid-domain', index }
          if (!allowedDomains.includes(parsed.data)) allowedDomains.push(parsed.data)
        }
      }
      try {
        await withConfigLock(q.host.identity, async () => {
          const previous = await readConfig(q.host.fs, q.host.identity)
          await writeConfigHeld(q.host.fs, q.host.identity, {
            sandbox: {
              profile: patch.profile ?? previous.sandbox.profile,
              allowedDomains: allowedDomains ?? previous.sandbox.allowedDomains,
              packageManagers: patch.packageManagers ?? previous.sandbox.packageManagers,
            },
          })
        })
        return { ok: true }
      } catch {
        return { ok: false, code: 'write-failed' }
      }
    },
  )
  registerRoute(q.ipcMain, sandboxRelease, async (request) => {
    await q.gate
    if (q.sessions === null) return { status: 'not-found' as const }
    return q.sessions.release(request)
  })
  return { changed }
}
