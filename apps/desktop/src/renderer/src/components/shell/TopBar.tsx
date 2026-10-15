import { PanelLeftOpenIcon } from 'lucide-react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface TopBarProps {
  collapsed: boolean
  onExpand: () => void
  title: string
}

/**
 * No background of its own: left the current session's title (nothing while there is none),
 * right actions (empty in phase 0). On macOS it is the window's drag handle, and with the sidebar
 * folded away it keeps the traffic lights' corner clear.
 */
export function TopBar({ collapsed, onExpand, title }: TopBarProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <header
      data-testid="topbar"
      className={cn(
        'app-drag ctl-h-lg flex shrink-0 items-center gap-2 px-3',
        collapsed && 'mac:pl-20',
      )}
    >
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
      {title === '' ? null : (
        <h1
          data-testid="app-title"
          title={title}
          className="truncate font-sans text-ui font-medium text-text-primary"
        >
          {title}
        </h1>
      )}
    </header>
  )
}
