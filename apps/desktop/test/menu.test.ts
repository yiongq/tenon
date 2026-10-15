/**
 * The menu a user's build shows follows `app.isPackaged` by default: `buildApplicationMenu` is called
 * with no third argument (main/index.ts), so this default is the only thing that drops 「重新加载」,
 * 「开发者工具」 and Help from a packaged build. The template itself is menu-template.test.ts's; e2e runs
 * an unpackaged build, where the default is false either way, so only this test sees the wiring.
 */
import type { MenuItemConstructorOptions } from 'electron'
import type { i18n as I18n } from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApplicationMenu } from '../src/main/menu.js'

// Hoisted above the import of menu.js, as vi.mock itself is.
const electron = vi.hoisted(() => ({ app: { isPackaged: true, name: 'Tenon' } }))

vi.mock('electron', () => ({
  app: electron.app,
  Menu: { buildFromTemplate: (template: MenuItemConstructorOptions[]) => template },
}))

const i18n = { getFixedT: () => (key: string) => key } as unknown as I18n

function built(): MenuItemConstructorOptions[] {
  return buildApplicationMenu(i18n, () => {}) as unknown as MenuItemConstructorOptions[]
}

function viewRoles(template: MenuItemConstructorOptions[]): string[] {
  const view = template.find((item) => item.label === 'view.title')
  return ((view?.submenu ?? []) as MenuItemConstructorOptions[]).flatMap((item) =>
    item.role === undefined ? [] : [item.role],
  )
}

describe('buildApplicationMenu without an explicit build kind', () => {
  beforeEach(() => {
    electron.app.isPackaged = true
  })

  it('a packaged app gets the user menu: full screen only under View, no Help', () => {
    const template = built()
    expect(viewRoles(template)).toEqual(['togglefullscreen'])
    expect(template.some((item) => item.role === 'help')).toBe(false)
    expect(template.map((item) => item.label)).not.toContain('help.title')
  })

  it('an unpackaged app keeps Reload, Toggle Developer Tools and Help', () => {
    electron.app.isPackaged = false
    const template = built()
    expect(viewRoles(template)).toEqual(['reload', 'toggleDevTools', 'togglefullscreen'])
    expect(template.map((item) => item.label)).toContain('help.title')
  })
})
