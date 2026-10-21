import { invokeRoute, sessionSelectProfile } from '@tenon-app/contracts'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@/components/ui/switch'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'

/** The profile can only be chosen before the first message (presentation-r1 R7). */
export function FolderToggle(): JSX.Element | null {
  const { t } = useTranslation()
  const store = useSessionStore()
  const { facts } = useSessionSnapshot()
  if (facts === null || facts.established !== false) return null
  return (
    <label className="flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap font-sans text-micro text-text-secondary">
      <Switch
        size="sm"
        data-testid="folder-toggle"
        checked={facts.profile === 'cowork'}
        onCheckedChange={(checked) => {
          void invokeRoute(window.tenon, sessionSelectProfile, {
            sessionId: store.sessionId,
            profile: checked ? 'cowork' : 'chat',
          }).then(() => store.refreshFacts())
        }}
      />
      <span>{t('folder.toggle')}</span>
    </label>
  )
}
