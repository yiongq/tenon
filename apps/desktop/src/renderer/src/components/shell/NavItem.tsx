import type { JSX, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface NavItemProps {
  icon: ReactNode
  label: string
  current?: boolean
  onClick?: () => void
  testId?: string
}

/** One sidebar row: interface font, one line, never wraps (acceptance 12 measures this). */
export function NavItem({ icon, label, current, onClick, testId }: NavItemProps): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid={testId ?? 'nav-item'}
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'w-full justify-start gap-2 px-2 font-sans text-ui text-text-primary hover:bg-shell-row-hover',
        current && 'bg-shell-row-selected',
      )}
    >
      <span className="text-text-muted">{icon}</span>
      <span className="truncate">{label}</span>
    </Button>
  )
}
