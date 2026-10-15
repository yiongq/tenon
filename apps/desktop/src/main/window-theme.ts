/**
 * The colour a window shows before the renderer has painted: the content column's own background
 * (`--t-surface-0`), so the first frame, a live resize and the moment a theme flips are not white.
 *
 * Read from the token sheet itself (the caller passes its text, bundled with `?raw`), never
 * restated here: tokens.css is the one place a colour value may be written (`pnpm colors:check`),
 * and a skin change then reaches the window for free. The
 * light value is the `:root` block, the dark one the explicit `[data-theme='dark']` block (the
 * `prefers-color-scheme` block repeats it; tokens.css's own test keeps the two equal).
 */
export function windowBackground(dark: boolean, css: string): string {
  const block = dark
    ? /\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/.exec(css)
    : /(?:^|\n):root\s*\{([\s\S]*?)\n\}/.exec(css)
  const value = /--t-surface-0:\s*(#[0-9a-fA-F]{6})\s*;/.exec(block?.[1] ?? '')?.[1]
  if (value === undefined) {
    throw new Error(`tokens.css has no ${dark ? 'dark' : 'light'} --t-surface-0 hex value`)
  }
  return value
}

/**
 * The window's frame, per platform. On macOS the title bar is hidden and the traffic lights sit
 * inset over the sidebar's own header, so the sidebar runs to the top of the window; the renderer
 * draws the drag region (`app-drag` in theme.css) and keeps the lights' corner clear (`mac:pl-*`). Windows and Linux keep the native frame.
 */
export interface WindowFrame {
  readonly titleBarStyle?: 'hiddenInset'
  readonly trafficLightPosition?: { readonly x: number; readonly y: number }
}

/** Where the lights' group starts: 20px in, vertically centred on the 44px header (`--t-h-control-lg`). */
export const TRAFFIC_LIGHT_POSITION = { x: 20, y: 15 } as const

export function windowFrame(platform: string): WindowFrame {
  return platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHT_POSITION }
    : {}
}

/**
 * Smallest window the shell is laid out for: at 800px wide the sidebar still leaves the thread and
 * the Composer a readable column, and a task's composer keeps its tool row and its folder row to
 * one line each (e2e/ux-craft.spec.ts measures it at 800x700).
 */
export const MIN_WINDOW_WIDTH = 800
export const MIN_WINDOW_HEIGHT = 520
