import { invokeRoute, sessionSelectProfile } from '@tenon-app/contracts'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessionSnapshot, useSessionStore } from '@/runtime/ChatProvider'

/**
 * 「对话 / 任务」 (spec 02 §界面范围 `ModeSwitch`; H1): switchable before the session's first message,
 * shown and fixed once it exists.
 */
export function ModeSwitch(): JSX.Element | null {
  const { t } = useTranslation()
  const store = useSessionStore()
  const snapshot = useSessionSnapshot()
  const facts = snapshot.facts
  if (facts === null) return null
  const choose = (profile: 'chat' | 'cowork'): void => {
    if (facts.established || facts.profile === profile) return
    void invokeRoute(window.tenon, sessionSelectProfile, {
      sessionId: store.sessionId,
      profile,
    }).then(() => store.refreshFacts())
  }
  return (
    <fieldset
      aria-label={t('mode.label')}
      data-testid="mode-switch"
      data-profile={facts.profile}
      className="flex min-w-0 items-center gap-1 border-0 p-0 font-sans text-micro"
    >
      {(['chat', 'cowork'] as const).map((profile) => (
        <button
          key={profile}
          type="button"
          aria-pressed={facts.profile === profile}
          disabled={facts.established && facts.profile !== profile}
          data-testid={`mode-${profile}`}
          onClick={() => choose(profile)}
          className={
            facts.profile === profile
              ? 'rounded-sm bg-fill-neutral px-2 py-0.5 text-text-primary'
              : 'rounded-sm px-2 py-0.5 text-text-muted disabled:hidden'
          }
        >
          {t(profile === 'chat' ? 'mode.chat' : 'mode.cowork')}
        </button>
      ))}
    </fieldset>
  )
}
