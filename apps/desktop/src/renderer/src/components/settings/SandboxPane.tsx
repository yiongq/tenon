import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RouteRequest, SandboxView, sandboxSetSettings } from '@tenon-app/contracts'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  needsProxyWarning,
  observeSandbox,
  showsSandboxStatus,
  usernsFixCommands,
  writeSandboxSettings,
} from '@/lib/sandbox-settings'
import type { SandboxSettingsError } from '@/lib/sandbox-settings'
import { PaneFrame } from './PaneFrame'

export function SandboxPane() {
  const { t } = useTranslation()
  const [view, setView] = useState<SandboxView | null>(null)
  const [error, setError] = useState<SandboxSettingsError | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const observer = useRef<ReturnType<typeof observeSandbox> | null>(null)
  useEffect(() => {
    const current = observeSandbox(window.tenon, setView, () => setError({ code: 'load-failed' }))
    observer.current = current
    void current.refresh()
    return () => {
      current.dispose()
      observer.current = null
    }
  }, [])
  const save = async (patch: RouteRequest<typeof sandboxSetSettings>) => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setError(null)
    const failed = await writeSandboxSettings(window.tenon, patch)
    setError(failed)
    if (!failed) {
      if (patch.allowedDomains) setDraft('')
      await observer.current?.refresh()
    }
    saving.current = false
    setBusy(false)
  }
  return (
    <PaneFrame
      header={
        <DialogHeader>
          <DialogTitle>{t('sandbox.title')}</DialogTitle>
          <DialogDescription>{t('sandbox.description')}</DialogDescription>
        </DialogHeader>
      }
    >
      {view ? (
        <SandboxFields
          view={view}
          error={error}
          draft={draft}
          busy={busy}
          onDraft={setDraft}
          onSave={save}
        />
      ) : (
        <p>{t('sandbox.loading')}</p>
      )}
      {!view && error ? <p role="alert">{t(`sandbox.error.${error.code}`)}</p> : null}
    </PaneFrame>
  )
}

/** The settings controls, separate from their IPC subscription so they render from one snapshot. */
export function SandboxFields(props: {
  view: SandboxView
  error: SandboxSettingsError | null
  draft: string
  busy: boolean
  onDraft: (value: string) => void
  onSave: (patch: RouteRequest<typeof sandboxSetSettings>) => Promise<void>
}) {
  const { t } = useTranslation()
  const { view, error, draft, busy, onSave } = props
  return (
    <div data-testid="sandbox-pane" className="flex min-w-0 flex-col gap-4 font-sans text-ui-sm">
      {showsSandboxStatus(view) ? (
        <details
          data-testid="sandbox-status"
          className="rounded-lg border border-border-subtle p-3"
        >
          <summary className="cursor-pointer text-text-secondary">
            {t(`sandbox.state.${view.posture.state}`)}
            {view.reasons.map(({ code, detail }) => (
              <span key={`${code}:${detail}`} className="ml-1 before:mr-1 before:content-['·']">
                {t(`sandbox.reason.${code}`)}
              </span>
            ))}
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {view.reasons.map(({ code, detail }) => (
              <div
                key={`${code}:${detail}`}
                data-testid={`sandbox-reason-${code}`}
                className="flex flex-col gap-2"
              >
                <p>{t(`sandbox.fix.${code}`)}</p>
                {code === 'userns-restricted' && usernsFixCommands(detail) ? (
                  <pre className="whitespace-pre-wrap wrap-anywhere font-mono text-micro">
                    {usernsFixCommands(detail)}
                  </pre>
                ) : null}
                {detail ? (
                  <pre className="whitespace-pre-wrap wrap-anywhere font-mono text-micro text-text-muted">
                    {detail}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <section className="flex flex-col gap-2" aria-labelledby="sandbox-allowlist-title">
        <h3 id="sandbox-allowlist-title" className="font-medium">
          {t('sandbox.allowlist')}
        </h3>
        <p className="text-text-secondary">{t('sandbox.siteScope')}</p>
        <p className="text-text-secondary">{t('sandbox.commandScope')}</p>
        <p className="text-text-muted">{t('sandbox.nextCommand')}</p>
        <ul className="flex flex-col gap-2">
          {view.settings.allowedDomains.map((domain, index) => (
            <li key={domain} className="flex items-start gap-2" data-testid="sandbox-domain">
              <div className="min-w-0 flex-1">
                <p className="wrap-anywhere font-mono">{domain}</p>
                {needsProxyWarning(domain) ? (
                  <p className="text-micro text-text-muted">{t('sandbox.proxyWarning')}</p>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={t('sandbox.remove', { domain })}
                onClick={() =>
                  void onSave({
                    allowedDomains: view.settings.allowedDomains.filter((_, at) => at !== index),
                  })
                }
              >
                {t('sandbox.removeButton')}
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void onSave({ allowedDomains: [...view.settings.allowedDomains, draft.trim()] })
          }}
        >
          <label htmlFor="sandbox-domain">{t('sandbox.domainLabel')}</label>
          <div className="flex items-center gap-2">
            <Input
              id="sandbox-domain"
              data-testid="sandbox-domain-input"
              value={draft}
              disabled={busy}
              aria-invalid={error?.code === 'invalid-domain' || error?.code === 'too-many'}
              aria-describedby={error ? 'sandbox-error' : 'sandbox-domain-hint'}
              onChange={(event) => props.onDraft(event.target.value)}
            />
            <Button type="submit" disabled={busy || !draft.trim()}>
              {t('sandbox.add')}
            </Button>
          </div>
          <p id="sandbox-domain-hint" className="text-micro text-text-muted">
            {t('sandbox.domainHint')}
          </p>
        </form>
      </section>
      {error ? (
        <p id="sandbox-error" role="alert" className="text-destructive">
          {error.code === 'invalid-domain'
            ? t('sandbox.error.invalid-domain', { n: error.index + 1 })
            : t(`sandbox.error.${error.code}`)}
        </p>
      ) : null}
      <section className="flex flex-col gap-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="sandbox-package-managers"
            checked={view.settings.packageManagers}
            disabled={busy}
            onChange={(event) => void onSave({ packageManagers: event.target.checked })}
          />
          {t('sandbox.packageManagers')}
        </label>
        <details data-testid="sandbox-preset">
          <summary className="cursor-pointer">{t('sandbox.presetDetails')}</summary>
          <div className="mt-2 flex flex-col gap-2">
            <p>{t('sandbox.presetDomains')}</p>
            <ul>
              {view.preset.domains.map((domain) => (
                <li key={domain} className="wrap-anywhere font-mono">
                  {domain}
                </li>
              ))}
            </ul>
            <p>{t('sandbox.publishing')}</p>
            <p>{t('sandbox.presetWritable')}</p>
            <ul>
              {view.preset.writable.map((path) => (
                <li key={path} className="wrap-anywhere font-mono">
                  {path}
                </li>
              ))}
            </ul>
          </div>
        </details>
      </section>
      <details data-testid="sandbox-advanced">
        <summary className="cursor-pointer">{t('sandbox.advanced')}</summary>
        <fieldset disabled={busy} className="mt-3 flex flex-col gap-3">
          <legend className="mb-2 font-medium">{t('sandbox.profile')}</legend>
          {(['workspace-write', 'read-only'] as const).map((profile) => (
            <label key={profile} className="flex items-start gap-2">
              <input
                type="radio"
                name="sandbox-profile"
                value={profile}
                checked={view.settings.profile === profile}
                onChange={() => void onSave({ profile })}
              />
              <span>
                {t(`sandbox.profileLabel.${profile}`)}
                <span className="mt-1 block text-text-muted">
                  {t(`sandbox.profileHint.${profile}`)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      </details>
    </div>
  )
}
