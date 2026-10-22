import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Tabs } from '@base-ui/react/tabs'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { isSettingsPane, paneOfHash, settingsHash } from '@/lib/settings-sections'
import type { SettingsPane } from '@/lib/settings-sections'
import type { ProviderSettingsProps } from './ProviderSettings'
import { settingsClosed } from '@/runtime/session-store'
import { SECTIONS } from './sections'

export type { SettingsPane }

/**
 * The settings dialog: a fixed-size frame (744px wide, up to 640px tall, whatever its panel holds),
 * a left rail with the sections and, to its right, the panel of the section in view — which brings
 * its own header, its one scroll area and its footer (PaneFrame). Opening it puts no field in focus:
 * focus rests on the dialog itself, so no control wears a focus ring before the user has touched
 * anything.
 */
export function SettingsModal(props: ProviderSettingsProps & { pane?: SettingsPane }): JSX.Element {
  const { t } = useTranslation()
  const wasOpen = useRef(props.open)
  useEffect(() => {
    if (wasOpen.current && !props.open) settingsClosed()
    wasOpen.current = props.open
  }, [props.open])
  const [busy, setBusy] = useState(false),
    busyRef = useRef(false)
  const reportBusy = useCallback((value: boolean) => {
    busyRef.current = value
    setBusy(value)
  }, [])
  const popup = useRef<HTMLDivElement | null>(null)
  const [hashContext, setHashContext] = useState('')
  const hashOwner = props.pane !== undefined
  const hashOpen = useEffectEvent((event?: Event) => {
    if (
      !props.open &&
      !document.querySelector('[data-testid="provider-settings"]') &&
      paneOfHash(window.location.hash) !== null
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
        ref={popup}
        data-testid="provider-settings"
        closeLabel={t('settings.providers.close')}
        finalFocus={props.finalFocus}
        initialFocus={popup}
        className="h-[min(640px,calc(100vh-4rem))] grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[min(744px,calc(100vw-2rem))]"
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
      paneOfHash(window.location.hash) === 'connectors'
        ? 'connectors'
        : (props.pane ?? 'providers'),
    )
  const onHash = useEffectEvent(() => {
    const next = paneOfHash(window.location.hash)
    if (props.busy) {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search + settingsHash(pane),
      )
      return
    }
    if (next !== null) setPane(next)
    else props.onOpenChange(false)
  })
  const { hashContext } = props
  useEffect(() => {
    const previous = paneOfHash(window.location.hash) !== null ? hashContext : window.location.hash
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
      window.location.pathname + window.location.search + settingsHash(pane),
    )
  }, [pane])
  return (
    <Tabs.Root
      orientation="vertical"
      value={pane}
      onValueChange={(value) => {
        if (!props.busy && isSettingsPane(value)) setPane(value)
      }}
      className="grid h-full min-h-0 min-w-0 grid-cols-[11rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"
    >
      <Tabs.List
        aria-label={t('mcp.settings')}
        className="flex flex-col items-stretch gap-1 border-r border-border-subtle bg-muted/50 p-2"
      >
        {SECTIONS.map(({ id, Icon, labelKey }) => (
          <Tabs.Tab
            key={id}
            value={id}
            data-testid={'settings-' + id}
            disabled={props.busy}
            className="flex items-center justify-start gap-2 rounded-md px-2 py-2 text-left text-ui-sm text-text-secondary data-active:bg-surface-2 data-active:text-text-primary focus-visible:outline focus-visible:outline-ring"
          >
            <Icon className="size-4 shrink-0 text-text-muted" />
            <span className="truncate">{t(labelKey)}</span>
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {SECTIONS.map((section) => (
        <Tabs.Panel key={section.id} value={section.id} className="flex min-h-0 min-w-0 flex-col">
          {section.render(props)}
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  )
}
