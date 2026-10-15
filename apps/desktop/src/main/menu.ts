import { Menu, app } from 'electron'
import type { i18n as I18n } from 'i18next'
import { applicationMenuTemplate } from './menu-template.js'

/** The application menu is rebuilt from the catalogue on every locale change. */
export function buildApplicationMenu(
  i18n: I18n,
  onNewChat: () => void,
  packaged: boolean = app.isPackaged,
): Menu {
  return Menu.buildFromTemplate(
    applicationMenuTemplate(i18n.getFixedT(null, 'menu'), {
      isMac: process.platform === 'darwin',
      packaged,
      appName: app.name,
      onNewChat,
    }),
  )
}
