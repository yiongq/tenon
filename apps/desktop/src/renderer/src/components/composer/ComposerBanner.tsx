import { XIcon } from 'lucide-react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { showsAutoBanner } from '@/lib/approval-mode'
import { settingsHash } from '@/lib/settings-sections'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'

/**
 * The strips above the composer, as wide as it (spec 06 §界面; components.md `ComposerBanner`): the
 * one-time notice, then the downgrade line or the auto banner — never both, since a downgrade has
 * already left auto. In flow, 6px above the box, so the thread above makes room for them.
 */
export function ComposerBanner(): JSX.Element | null {
  const snapshot = useSessionSnapshot()
  const banner = showsAutoBanner(snapshot.facts)
  const downgrade = snapshot.downgrade !== null && !banner
  const notice = snapshot.autoNotice && banner
  if (!notice && !banner && !downgrade) return null
  return (
    <div data-testid="composer-banner" className="mb-1.5 flex flex-col gap-1.5 font-sans">
      {notice ? <AutoNotice /> : null}
      {banner ? <AutoBanner /> : null}
      {downgrade ? <DowngradeLine /> : null}
    </div>
  )
}

/**
 * Always there in auto, with no close (D9): the whole strip is one button back to manual, written
 * `by: 'user'`. The brand dot is the menu trigger's, so the two read as one state.
 */
export function AutoBanner(): JSX.Element {
  const { t } = useTranslation()
  const store = useSessionStore()
  return (
    <button
      type="button"
      data-testid="auto-banner"
      onClick={() => void store.setApprovalMode('manual')}
      className="group flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-lg bg-fill-brand-quiet px-3 py-1 text-left text-ui-sm text-text-primary focus-visible:outline-2 focus-visible:outline-border-focus"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-pill bg-fill-brand" />
      <span className="min-w-0 flex-1">
        {t('approvalMode.banner.text')}
        <span aria-hidden className="whitespace-pre text-text-muted">
          {t('summary.separator')}
        </span>
        <span className="whitespace-nowrap text-text-accent underline-offset-2 group-hover:underline">
          {t('approvalMode.banner.back')}
        </span>
      </span>
    </button>
  )
}

/**
 * Once, on the first switch to auto (D9): what goes unasked, what is still asked, how one click
 * restores. 「设置」 opens 「权限与网络」 by its hash; 「知道了」 writes `autoModeNoticeSeen`.
 */
export function AutoNotice(): JSX.Element {
  const { t } = useTranslation()
  const store = useSessionStore()
  return (
    <section
      data-testid="auto-notice"
      aria-labelledby="auto-notice-title"
      className="flex flex-col gap-2 rounded-lg border border-border-default bg-surface-1 px-3 py-2.5 text-ui-sm"
    >
      <h2 id="auto-notice-title" className="font-medium text-text-primary">
        {t('approvalMode.notice.title')}
      </h2>
      <ul className="flex flex-col gap-1 text-text-secondary">
        <li>{t('approvalMode.notice.unasked')}</li>
        <li>{t('approvalMode.notice.asked')}</li>
        <li>{t('approvalMode.notice.restore')}</li>
      </ul>
      <div className="flex items-center justify-end gap-2">
        <a
          data-testid="auto-notice-settings"
          href={settingsHash('permissions')}
          className="rounded-sm px-2 py-1 text-text-accent underline-offset-2 hover:underline"
        >
          {t('approvalMode.notice.settings')}
        </a>
        <Button
          size="sm"
          data-testid="auto-notice-dismiss"
          onClick={() => void store.dismissAutoNotice()}
        >
          {t('approvalMode.notice.dismiss')}
        </Button>
      </div>
    </section>
  )
}

/** After blocks ended a Run in auto (§熔断): which kind, how many; it can be closed. */
export function DowngradeLine(): JSX.Element | null {
  const { t } = useTranslation()
  const store = useSessionStore()
  const { downgrade } = useSessionSnapshot()
  if (downgrade === null) return null
  return (
    <output
      data-testid="downgrade-line"
      data-scope={downgrade.scope}
      className="flex min-h-8 items-center gap-2 rounded-lg border border-border-subtle bg-surface-1 py-1 pr-1 pl-3 text-ui-sm text-text-warning"
    >
      <span className="min-w-0 flex-1">
        {t(`approvalMode.downgrade.${downgrade.scope}`, { count: downgrade.count })}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="downgrade-close"
        aria-label={t('approvalMode.downgrade.close')}
        onClick={() => store.dismissDowngrade()}
      >
        <XIcon aria-hidden className="size-4" />
      </Button>
    </output>
  )
}
