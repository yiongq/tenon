import { chatEvent, chatNew, chatSend, chatStop } from './ipc/chat.js'
import { configGet, configLocale, configSet } from './ipc/config.js'
import { confirmRequestEvent } from './ipc/confirm.js'

/**
 * Every channel that may cross the renderer ↔ main boundary. The preload only forwards
 * channels listed here; main only registers handlers for routes listed here.
 */
export const ipcRoutes = { chatSend, chatStop, configGet, configSet } as const
export const ipcEvents = { chatEvent, chatNew, configLocale, confirmRequestEvent } as const

export const ROUTE_CHANNELS: readonly string[] = Object.values(ipcRoutes).map((r) => r.channel)
export const EVENT_CHANNELS: readonly string[] = Object.values(ipcEvents).map((e) => e.channel)

export function isRouteChannel(channel: string): boolean {
  return ROUTE_CHANNELS.includes(channel)
}

export function isEventChannel(channel: string): boolean {
  return EVENT_CHANNELS.includes(channel)
}
