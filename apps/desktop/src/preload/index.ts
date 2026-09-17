import { contextBridge, ipcRenderer } from 'electron'

/**
 * The only surface the renderer sees. Channels are the ones declared in
 * @tenon-app/contracts; the renderer validates envelopes with invokeRoute.
 */
const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
} as const

export type TenonBridge = typeof api

contextBridge.exposeInMainWorld('tenon', api)
