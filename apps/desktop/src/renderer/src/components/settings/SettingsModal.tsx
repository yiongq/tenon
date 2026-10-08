import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Tabs } from '@base-ui/react/tabs'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { ProviderSettings } from './ProviderSettings'
import type { ProviderSettingsProps } from './ProviderSettings'
import { ConnectorsPane } from './ConnectorsPane'
export type SettingsPane = 'providers' | 'connectors'
export function SettingsModal(props: ProviderSettingsProps & { pane?: SettingsPane }): JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false),
    busyRef = useRef(false)
  const reportBusy = useCallback((value: boolean) => {
    busyRef.current = value
    setBusy(value)
  }, [])
  const [hashContext, setHashContext] = useState('')
  const hashOwner = props.pane !== undefined
  const hashOpen = useEffectEvent((event?: Event) => {
    if (
      !props.open &&
      !document.querySelector('[data-testid="provider-settings"]') &&
      /^#settings\/(providers|connectors)$/.test(window.location.hash)
    ) {
      setHashContext(event instanceof HashChangeEvent ? new URL(event.oldURL).hash : '')
      props.onOpenChange(true)
    }
  })
  useEffect(() => {
    if (!hashOwner) return
    window.addEventListener('hashchange', hashOpen)
    queueMicrotask(() => hashOpen())
    return () => window.removeEventListener('hashchange', hashOpen)
  }, [hashOwner])
  const changeOpen = (open: boolean) => {
    if (open || !busyRef.current) props.onOpenChange(open)
  }
  return (
    <Dialog open={props.open} onOpenChange={changeOpen}>
      <DialogContent
        data-testid="provider-settings"
        closeLabel={t('settings.providers.close')}
        finalFocus={props.finalFocus}
        className="sm:max-w-3xl max-h-[calc(100vh-2rem)] overflow-y-auto"
      >
        {props.open ? (
          <SettingsBody
            key={props.pane ?? 'providers'}
            {...props}
            onOpenChange={changeOpen}
            hashContext={hashContext}
            busy={busy}
            onBusyChange={reportBusy}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
function SettingsBody(
  props: ProviderSettingsProps & { pane?: SettingsPane; busy: boolean; hashContext: string },
) {
  const { t } = useTranslation(),
    [pane, setPane] = useState<SettingsPane>(
      window.location.hash === '#settings/connectors' ? 'connectors' : (props.pane ?? 'providers'),
    )
  const onHash = useEffectEvent(() => {
    const next = window.location.hash
    if (props.busy) {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search + '#settings/' + pane,
      )
      return
    }
    if (next === '#settings/providers' || next === '#settings/connectors')
      setPane(next.endsWith('connectors') ? 'connectors' : 'providers')
    else props.onOpenChange(false)
  })
  const { hashContext } = props
  useEffect(() => {
    const previous = window.location.hash.startsWith('#settings/')
      ? hashContext
      : window.location.hash
    window.addEventListener('hashchange', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search + previous,
      )
    }
  }, [hashContext])
  useEffect(() => {
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search + '#settings/' + pane,
    )
  }, [pane])
  return (
    <Tabs.Root
      orientation="vertical"
      value={pane}
      onValueChange={(value) => {
        if (!props.busy && (value === 'providers' || value === 'connectors')) setPane(value)
      }}
      className="grid min-w-0 grid-cols-[9rem_minmax(0,1fr)] gap-4"
    >
      <Tabs.List aria-label={t('mcp.settings')} className="flex flex-col gap-1 items-stretch">
        {(['providers', 'connectors'] as const).map((value) => (
          <Tabs.Tab
            key={value}
            value={value}
            data-testid={'settings-' + value}
            disabled={props.busy}
            className="rounded-md px-2 py-2 text-ui-sm data-active:bg-surface-2 focus-visible:outline focus-visible:outline-ring"
          >
            {t(value === 'providers' ? 'settings.providers.title' : 'mcp.title')}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      <Tabs.Panel value="providers" className="flex min-w-0 flex-col gap-4">
        <ProviderSettings {...props} embedded />
      </Tabs.Panel>
      <Tabs.Panel value="connectors" className="flex min-w-0 flex-col gap-4">
        <DialogHeader>
          <DialogTitle>{t('mcp.title')}</DialogTitle>
          <DialogDescription>{t('mcp.description')}</DialogDescription>
        </DialogHeader>
        <ConnectorsPane />
      </Tabs.Panel>
    </Tabs.Root>
  )
}
