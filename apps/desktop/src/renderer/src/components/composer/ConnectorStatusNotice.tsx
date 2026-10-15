import { useTranslation } from 'react-i18next'
import { visible } from '@/lib/visible'

/**
 * 「正在连接 …」, first connect only (03 §连接池「正在连接」: in the slot above the composer). It rests
 * on the composer's top edge but takes no room: it comes and goes without moving the thread above or
 * the box below.
 *
 * The strip it lands on is the row the 「回到最新」 pill keeps, and the pill sits at its centre — but
 * only shows while the transcript is scrolled up. Without the pill the notice has the whole row; with
 * it, the notice rises one row, above the pill, and still has the whole width. It is never cut short:
 * the sentence is interface copy and the name is content (03 acceptance 46; 02 §界面范围: names are
 * shown whole and may wrap), so a name too long for the row wraps upward instead of ending in an
 * ellipsis. Its own background keeps it readable over the transcript's faded bottom edge.
 */
export function ConnectorStatusNotice({ name }: { name: string }) {
  const { t } = useTranslation()
  return (
    <div className="relative h-0">
      <output
        data-testid="connector-status-notice"
        className="absolute bottom-1 left-0 max-w-full bg-surface-0 text-ui-sm text-text-muted [[data-testid=thread]:has([data-testid=scroll-to-bottom]:enabled)_&]:bottom-9"
      >
        {t('mcp.connecting', { name: visible(name) })}
      </output>
    </div>
  )
}
