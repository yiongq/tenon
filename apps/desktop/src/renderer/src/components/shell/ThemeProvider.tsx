import { useEffect } from 'react'
import type { JSX, ReactNode } from 'react'

/**
 * Stamps `data-theme` on <html> so both token blocks and the `dark:` variant have one
 * source of truth. Phase 0 follows the system; an explicit toggle lands with Settings.
 */
export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.dataset['theme'] = query.matches ? 'dark' : 'light'
    }
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])
  return <>{children}</>
}
