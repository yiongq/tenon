import type { LocaleSetting } from '@tenon-app/contracts'
import {
  CalendarClockIcon,
  FolderKanbanIcon,
  MessageSquarePlusIcon,
  PackageIcon,
  PanelLeftCloseIcon,
  PuzzleIcon,
} from 'lucide-react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AccountMenu } from './AccountMenu'
import { NavItem } from './NavItem'

export interface SidebarProps {
  onCollapse: () => void
  onNewChat: () => void
  locale: LocaleSetting
  onLocaleChange: (next: LocaleSetting) => void
}

/**
 * 264px, the shell's own background layer. Order follows master-reference §8.5: brand row ·
 * new chat · main navigation · chats and tasks · account row. Pages behind the navigation
 * items arrive with their backends; phase 0 keeps them as inert rows so the bilingual fit
 * regression covers their labels from day one.
 */
export function Sidebar({
  onCollapse,
  onNewChat,
  locale,
  onLocaleChange,
}: SidebarProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <aside
      data-testid="sidebar"
      className="flex h-full w-[264px] shrink-0 flex-col gap-1 bg-shell-bg px-2 py-2"
    >
      <div className="flex items-center justify-between px-2 pt-1 pb-2">
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
      <nav aria-label={t('sidebar.navigation')} className="flex flex-col gap-0.5">
        <NavItem icon={<FolderKanbanIcon />} label={t('sidebar.projects')} />
        <NavItem icon={<PackageIcon />} label={t('sidebar.artifacts')} />
        <NavItem icon={<CalendarClockIcon />} label={t('sidebar.scheduled')} />
        <NavItem icon={<PuzzleIcon />} label={t('sidebar.customize')} />
      </nav>

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <h2
          data-testid="sidebar-section"
          className="px-2 py-1 font-sans text-micro font-medium text-text-muted"
        >
          {t('sidebar.chats')}
        </h2>
        <p className="px-2 py-1 font-sans text-ui-sm text-text-disabled">
          {t('sidebar.chatsEmpty')}
        </p>
      </div>

      <AccountMenu locale={locale} onLocaleChange={onLocaleChange} />
    </aside>
  )
}
