import type { LocaleSetting } from '@tenon-app/contracts'
import type { JSX, ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

export interface AppShellProps {
  collapsed: boolean
  onCollapsedChange: (next: boolean) => void
  onNewChat: () => void
  locale: LocaleSetting
  onLocaleChange: (next: LocaleSetting) => void
  /** Whether any chat exists: the sidebar's empty hint is for when none does. */
  hasChats: boolean
  /** The session on screen, by its first message (lib/session-title.ts); empty while it has none. */
  title: string
  children: ReactNode
}

/**
 * Sidebar + top bar + content column; the right panel is an empty, hidden shell in phase 0.
 *
 * `relative` on the root is the second line of defence against the `sr-only` escape fixed in
 * Thread.tsx: positioned, it is the containing block of last resort, so no absolutely
 * positioned descendant can extend the document past `overflow-hidden` and scroll the shell.
 */
export function AppShell(props: AppShellProps): JSX.Element {
  const {
    collapsed,
    onCollapsedChange,
    onNewChat,
    locale,
    onLocaleChange,
    hasChats,
    title,
    children,
  } = props
  return (
    <div
      data-testid="app-root"
      className="relative flex h-screen w-screen overflow-hidden bg-shell-bg"
    >
      {collapsed ? null : (
        <Sidebar
          onCollapse={() => onCollapsedChange(true)}
          onNewChat={onNewChat}
          locale={locale}
          onLocaleChange={onLocaleChange}
          hasChats={hasChats}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col bg-surface-0">
        <TopBar collapsed={collapsed} onExpand={() => onCollapsedChange(false)} title={title} />
        <main data-testid="content" className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          <aside data-testid="side-panel" hidden className="w-[400px] shrink-0 bg-surface-panel" />
        </main>
      </div>
    </div>
  )
}
