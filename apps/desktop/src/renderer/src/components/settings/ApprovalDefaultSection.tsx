import { configGet, configSet, invokeRoute } from '@tenon-app/contracts'
import type { ApprovalMode } from '@tenon-app/contracts'
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'

const MODES: readonly ApprovalMode[] = ['manual', 'auto']

/**
 * The first block of 「权限与网络」 (spec 06 §界面「设置」, D8): which mode a new task starts in,
 * kept in config.json's `approvalMode`. Changing it touches no open task — each has its own mode.
 */
export function ApprovalDefaultSection(): JSX.Element {
  const { t } = useTranslation()
  const [mode, setMode] = useState<ApprovalMode | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void invokeRoute(window.tenon, configGet, {}).then((result) => {
      if (live && result.ok) setMode(result.data.approvalMode)
    })
    return () => {
      live = false
    }
  }, [])
  const choose = async (next: ApprovalMode) => {
    setBusy(true)
    const result = await invokeRoute(window.tenon, configSet, { approvalMode: next })
    if (result.ok) setMode(result.data.approvalMode)
    setBusy(false)
  }
  return (
    <section
      data-testid="approval-default"
      aria-labelledby="approval-default-title"
      className="flex flex-col gap-2 font-sans text-ui-sm"
    >
      <h3 id="approval-default-title" className="font-medium">
        {t('approvalMode.settings.title')}
      </h3>
      <p className="text-text-secondary">{t('approvalMode.settings.hint')}</p>
      <fieldset disabled={busy || mode === null} className="flex flex-col gap-2">
        <legend className="sr-only">{t('approvalMode.settings.title')}</legend>
        {MODES.map((item) => (
          <label key={item} className="flex items-start gap-2">
            <input
              type="radio"
              name="approval-default"
              value={item}
              data-testid={`approval-default-${item}`}
              checked={mode === item}
              onChange={() => void choose(item)}
            />
            <span>
              {t(`approvalMode.${item}.name`)}
              <span className="mt-1 block text-text-muted">
                {t(`approvalMode.${item}.description`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  )
}
