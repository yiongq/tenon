import { PanelLeftOpenIcon } from 'lucide-react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export interface TopBarProps {
  collapsed: boolean
  onExpand: () => void
  title: string
}

/** No background of its own: left title, right actions (empty in phase 0). */
export function TopBar({ collapsed, onExpand, title }: TopBarProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <header data-testid="topbar" className="ctl-h-lg flex shrink-0 items-center gap-2 px-3">
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid="sidebar-expand"
                aria-label={t('sidebar.expand')}
                onClick={onExpand}
              />
            }
          >
            <PanelLeftOpenIcon />
          </TooltipTrigger>
          <TooltipContent>{t('sidebar.expand')}</TooltipContent>
        </Tooltip>
      ) : null}
      <h1
        data-testid="app-title"
        className="truncate font-sans text-ui font-medium text-text-primary"
        aria-label={title}
      >
        {title}
      </h1>
    </header>
  )
}
