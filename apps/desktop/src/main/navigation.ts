import type { WebContents } from 'electron'

/** Schemes main will hand to the OS. Everything else (file:, smb:, custom handlers) is refused. */
export const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(['https:', 'http:', 'mailto:'])

export function isAllowedExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/** True only for the app's own document (hash and query may differ). */
export function isSameDocument(url: string, appUrl: string): boolean {
  try {
    const a = new URL(url)
    const b = new URL(appUrl)
    return a.origin === b.origin && a.pathname === b.pathname
  } catch {
    return false
  }
}

/**
 * Pins a webContents to the app document. Without this a renderer-side navigation to a
 * remote origin would load that page WITH the preload, handing it the whole IPC surface.
 */
export function hardenWebContents(
  contents: WebContents,
  appUrl: string,
  openExternal: (url: string) => void,
): void {
  contents.on('will-navigate', (event, url) => {
    if (!isSameDocument(url, appUrl)) event.preventDefault()
  })
  contents.on('will-frame-navigate', (event) => {
    if (!isSameDocument(event.url, appUrl)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) openExternal(url)
    else console.warn('[window-open] refused a non-web URL')
    return { action: 'deny' }
  })
}
