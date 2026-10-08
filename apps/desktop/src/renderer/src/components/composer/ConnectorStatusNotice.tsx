import { useTranslation } from 'react-i18next'
import { visible } from '@/lib/visible'
export function ConnectorStatusNotice({ name }: { name: string }) {
  const { t } = useTranslation()
  return (
    <output
      data-testid="connector-status-notice"
      className="mb-2 break-all text-ui-sm text-text-muted"
    >
      {t('mcp.connecting', { name: visible(name) })}
    </output>
  )
}
