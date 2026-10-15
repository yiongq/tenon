import type { MenuItemConstructorOptions } from 'electron'
import type { TFunction } from 'i18next'

export interface MenuOptions {
  readonly isMac: boolean
  /** `app.isPackaged`: a build users run, as opposed to the one a developer runs from source. */
  readonly packaged: boolean
  readonly appName: string
  readonly onNewChat: () => void
}

/**
 * The application menu as data, so its shape can be tested without Electron.
 *
 * A packaged build carries no developer entries: no 「重新加载」 (it throws away the window's state
 * and replays the session from the tape, which a user has no reason to ask for), no 「开发者工具」,
 * and no Help menu while its only entry is a greyed-out placeholder. A development build keeps all
 * three.
 */
export function applicationMenuTemplate(
  t: TFunction<'menu'>,
  options: MenuOptions,
): MenuItemConstructorOptions[] {
  const { isMac, packaged } = options
  return [
    ...(isMac
      ? [
          {
            label: options.appName,
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
        { label: t('file.newChat'), accelerator: 'CmdOrCtrl+N', click: options.onNewChat },
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
        ...(packaged
          ? []
          : [
              { role: 'reload' as const, label: t('view.reload') },
              { role: 'toggleDevTools' as const, label: t('view.toggleDevTools') },
              { type: 'separator' as const },
            ]),
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
    ...(packaged
      ? []
      : [
          {
            label: t('help.title'),
            role: 'help' as const,
            submenu: [{ label: t('help.learnMore'), enabled: false }],
          },
        ]),
  ]
}
