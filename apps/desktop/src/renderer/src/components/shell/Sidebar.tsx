import type { LocaleSetting } from '@tenon-app/contracts'
import { MessageSquarePlusIcon, PanelLeftCloseIcon } from 'lucide-react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { sidebarChats } from '@/lib/sidebar-chats'
import { AccountMenu } from './AccountMenu'
import { NavItem } from './NavItem'

export interface SidebarProps {
  onCollapse: () => void
  onNewChat: () => void
  locale: LocaleSetting
  onLocaleChange: (next: LocaleSetting) => void
  /** Whether any chat exists (lib/sidebar-chats.ts). */
  hasChats: boolean
}

/**
 * 264px, the shell's own background layer, from the top of the window down. On macOS the title bar
 * is hidden, so the traffic lights sit over the brand row's left end (`mac:pl-18` keeps them clear)
 * and the row is the window's drag handle. Order follows master-reference §8.5: brand row ·
 * new chat · chats and tasks · account row. The navigation rows for projects, artifacts, scheduled
 * tasks and skills and connectors (`sidebar.projects` ... `sidebar.customize` in the catalogues) are
 * not drawn: each was an inert button, and a row that does nothing reads as a bug. They come back,
 * one by one, with the page each opens.
 */
export function Sidebar({
  onCollapse,
  onNewChat,
  locale,
  onLocaleChange,
  hasChats,
}: SidebarProps): JSX.Element {
  const { t } = useTranslation()
  const chats = sidebarChats(hasChats)
  return (
    <aside
      data-testid="sidebar"
      className="flex h-full w-[264px] shrink-0 flex-col gap-1 bg-shell-bg px-2 py-2 mac:pt-0"
    >
      <div className="app-drag flex items-center justify-between px-2 pt-1 pb-2 mac:ctl-h-lg mac:py-0 mac:pl-18">
        <span data-testid="brand" className="font-sans text-ui font-semibold text-text-primary">
          {t('app.name')}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid="sidebar-collapse"
                aria-label={t('sidebar.collapse')}
                onClick={onCollapse}
              />
            }
          >
            <PanelLeftCloseIcon />
          </TooltipTrigger>
          <TooltipContent>{t('sidebar.collapse')}</TooltipContent>
        </Tooltip>
      </div>

      <NavItem
        icon={<MessageSquarePlusIcon />}
        label={t('sidebar.newChat')}
        onClick={onNewChat}
        testId="nav-item"
      />

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        {chats.heading ? (
          <h2
            data-testid="sidebar-section"
            className="px-2 py-1 font-sans text-micro font-medium text-text-secondary"
          >
            {t('sidebar.chats')}
          </h2>
        ) : null}
        {chats.emptyHint ? (
          // Information, not a disabled control: muted (4.8:1 on the shell), not disabled (1.9:1).
          // Under the heading, not level with it: the heading is darker, the hint no larger.
          <p
            data-testid="sidebar-chats-empty"
            className="px-2 py-1 font-sans text-micro text-text-muted"
          >
            {t('sidebar.chatsEmpty')}
          </p>
        ) : null}
      </div>

      <AccountMenu locale={locale} onLocaleChange={onLocaleChange} />
    </aside>
  )
}
