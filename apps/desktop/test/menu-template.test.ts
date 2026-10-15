/**
 * The application menu of a build users run has no developer entries: no 「重新加载」, no
 * 「开发者工具」 and no greyed-out Help. A development build keeps them (the harness and the
 * developer both use them).
 */
import type { MenuItemConstructorOptions } from 'electron'
import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import { applicationMenuTemplate } from '../src/main/menu-template.js'

const t = ((key: string) => key) as unknown as TFunction<'menu'>

function build(options: { isMac: boolean; packaged: boolean }): MenuItemConstructorOptions[] {
  return applicationMenuTemplate(t, { ...options, appName: 'Tenon', onNewChat: () => {} })
}

function submenuOf(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const menu = template.find((item) => item.label === label)
  return (menu?.submenu ?? []) as MenuItemConstructorOptions[]
}

function roles(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => (item.role === undefined ? [] : [item.role]))
}

describe('application menu', () => {
  for (const isMac of [true, false]) {
    const platform = isMac ? 'macOS' : 'other platforms'

    it(`packaged, ${platform}: no Reload, no Toggle Developer Tools, no Help`, () => {
      const template = build({ isMac, packaged: true })
      const view = submenuOf(template, 'view.title')
      expect(roles(view)).toEqual(['togglefullscreen'])
      expect(template.map((item) => item.label)).not.toContain('help.title')
      expect(template.some((item) => item.role === 'help')).toBe(false)
      // Nothing a user needs goes with them.
      expect(submenuOf(template, 'file.title').map((item) => item.label)).toContain('file.newChat')
      expect(roles(submenuOf(template, 'edit.title'))).toEqual(
        expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']),
      )
      expect(roles(submenuOf(template, 'window.title'))).toEqual(
        expect.arrayContaining(['minimize', 'zoom']),
      )
    })

    it(`development, ${platform}: keeps Reload, Toggle Developer Tools and Help`, () => {
      const template = build({ isMac, packaged: false })
      expect(roles(submenuOf(template, 'view.title'))).toEqual([
        'reload',
        'toggleDevTools',
        'togglefullscreen',
      ])
      const help = submenuOf(template, 'help.title')
      expect(help.map((item) => [item.label, item.enabled])).toEqual([['help.learnMore', false]])
    })
  }

  it('New Chat keeps its accelerator in both', () => {
    for (const packaged of [true, false]) {
      const item = submenuOf(build({ isMac: true, packaged }), 'file.title').find(
        (entry) => entry.label === 'file.newChat',
      )
      expect(item?.accelerator).toBe('CmdOrCtrl+N')
    }
  })

  it('the app menu only exists on macOS', () => {
    expect(build({ isMac: true, packaged: true })[0]?.label).toBe('Tenon')
    expect(build({ isMac: false, packaged: true })[0]?.label).toBe('file.title')
  })
})
