import { Menu, app } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { i18n as I18n } from 'i18next'

/** The application menu is rebuilt from the catalogue on every locale change. */
export function buildApplicationMenu(i18n: I18n, onNewChat: () => void): Menu {
  const t = i18n.getFixedT(null, 'menu')
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const, label: t('app.about') },
              { type: 'separator' as const },
              { role: 'hide' as const, label: t('app.hide') },
              { role: 'hideOthers' as const, label: t('app.hideOthers') },
              { role: 'unhide' as const, label: t('app.showAll') },
              { type: 'separator' as const },
              { role: 'quit' as const, label: t('app.quit') },
            ],
          },
        ]
      : []),
    {
      label: t('file.title'),
      submenu: [
        { label: t('file.newChat'), accelerator: 'CmdOrCtrl+N', click: onNewChat },
        { type: 'separator' },
        isMac
          ? { role: 'close', label: t('file.closeWindow') }
          : { role: 'quit', label: t('app.quit') },
      ],
    },
    {
      label: t('edit.title'),
      submenu: [
        { role: 'undo', label: t('edit.undo') },
        { role: 'redo', label: t('edit.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('edit.cut') },
        { role: 'copy', label: t('edit.copy') },
        { role: 'paste', label: t('edit.paste') },
        { role: 'selectAll', label: t('edit.selectAll') },
      ],
    },
    {
      label: t('view.title'),
      submenu: [
        { role: 'reload', label: t('view.reload') },
        { role: 'toggleDevTools', label: t('view.toggleDevTools') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('view.toggleFullscreen') },
      ],
    },
    {
      label: t('window.title'),
      role: 'window',
      submenu: [
        { role: 'minimize', label: t('window.minimize') },
        { role: 'zoom', label: t('window.zoom') },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const, label: t('window.front') }]
          : []),
      ],
    },
    {
      label: t('help.title'),
      role: 'help',
      submenu: [{ label: t('help.learnMore'), enabled: false }],
    },
  ]
  return Menu.buildFromTemplate(template)
}
