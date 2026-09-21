import { isEventChannel, isRouteChannel } from '@tenon-app/contracts'
import { contextBridge, ipcRenderer } from 'electron'

/**
 * The only surface the renderer sees. Channels not declared in @tenon-app/contracts are
 * refused here, before they reach main; payloads are validated by main (registerRoute)
 * and by the renderer (invokeRoute).
 */
const localeArg = process.argv.find((a) => a.startsWith('--tenon-locale='))

const api = {
  /** Interface language resolved by main before this window was created. */
  initialLocale: localeArg ? localeArg.slice('--tenon-locale='.length) : 'en',
  /**
   * True when main opened this window FOR a new chat ("New Chat" with no window open). The
   * renderer then skips the startup restore instead of reopening the conversation just left.
   */
  startsNewChat: process.argv.includes('--tenon-new-chat'),
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (!isRouteChannel(channel)) {
      return Promise.reject(new Error(`ipc: "${channel}" is not a declared route`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
    if (!isEventChannel(channel)) {
      throw new Error(`ipc: "${channel}" is not a declared event`)
    }
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
} as const

export type TenonBridge = typeof api

contextBridge.exposeInMainWorld('tenon', api)
