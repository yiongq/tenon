import type { LocaleSetting } from '@tenon-app/contracts'
import type { JSX, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

export interface AppShellProps {
  collapsed: boolean
  onCollapsedChange: (next: boolean) => void
  onNewChat: () => void
  locale: LocaleSetting
  onLocaleChange: (next: LocaleSetting) => void
  children: ReactNode
}

/** Sidebar + top bar + content column; the right panel is an empty, hidden shell in phase 0. */
export function AppShell(props: AppShellProps): JSX.Element {
  const { collapsed, onCollapsedChange, onNewChat, locale, onLocaleChange, children } = props
  const { t } = useTranslation()
  return (
    <div data-testid="app-root" className="flex h-screen w-screen overflow-hidden bg-shell-bg">
      {collapsed ? null : (
        <Sidebar
          onCollapse={() => onCollapsedChange(true)}
          onNewChat={onNewChat}
          locale={locale}
          onLocaleChange={onLocaleChange}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col bg-surface-0">
        <TopBar
          collapsed={collapsed}
          onExpand={() => onCollapsedChange(false)}
          title={t('app.name')}
        />
        <main data-testid="content" className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          <aside data-testid="side-panel" hidden className="w-[400px] shrink-0 bg-surface-panel" />
        </main>
      </div>
    </div>
  )
}
