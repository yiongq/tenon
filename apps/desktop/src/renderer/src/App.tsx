import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'

export function App(): JSX.Element {
  const { t } = useTranslation()
  return (
    <main data-testid="app-root">
      <h1 data-testid="app-title">{t('app.name')}</h1>
    </main>
  )
}
