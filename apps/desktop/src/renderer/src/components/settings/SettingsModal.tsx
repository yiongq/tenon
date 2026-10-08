import { useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ProviderSettings } from './ProviderSettings'
import type { ProviderSettingsProps } from './ProviderSettings'
import { ConnectorsPane } from './ConnectorsPane'
export type SettingsPane = 'providers' | 'connectors'
export function SettingsModal(props: ProviderSettingsProps & { pane?: SettingsPane }): JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        data-testid="provider-settings"
        closeLabel={t('settings.providers.close')}
        finalFocus={props.finalFocus}
        className="sm:max-w-3xl max-h-[calc(100vh-2rem)] overflow-y-auto"
      >
        {props.open ? <SettingsBody key={props.pane ?? 'providers'} {...props} /> : null}
      </DialogContent>
    </Dialog>
  )
}
function SettingsBody(props: ProviderSettingsProps & { pane?: SettingsPane }) {
  const { t } = useTranslation(),
    [pane, setPane] = useState<SettingsPane>(props.pane ?? 'providers')
  return (
    <div className="grid min-w-0 grid-cols-[9rem_minmax(0,1fr)] gap-4">
      <nav aria-label={t('mcp.settings')}>
        <ToggleGroup
          orientation="vertical"
          value={[pane]}
          onValueChange={(values) => {
            const next = values[0]
            if (next === 'providers' || next === 'connectors') setPane(next)
          }}
          className="flex flex-col gap-1 items-stretch"
        >
          <ToggleGroupItem value="providers" data-testid="settings-providers">
            {t('settings.providers.title')}
          </ToggleGroupItem>
          <ToggleGroupItem value="connectors" data-testid="settings-connectors">
            {t('mcp.title')}
          </ToggleGroupItem>
        </ToggleGroup>
      </nav>
      <section className="flex min-w-0 flex-col gap-4">
        {pane === 'providers' ? (
          <ProviderSettings {...props} embedded />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('mcp.title')}</DialogTitle>
              <DialogDescription>{t('mcp.description')}</DialogDescription>
            </DialogHeader>
            <ConnectorsPane />
          </>
        )}
      </section>
    </div>
  )
}
