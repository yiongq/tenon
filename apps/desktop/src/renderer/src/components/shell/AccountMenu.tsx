import type { LocaleSetting } from '@tenon-app/contracts'
import { CircleUserIcon, LanguagesIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { SECTIONS } from '@/components/settings/sections'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { SettingsPane } from '@/lib/settings-sections'

const LOCALE_OPTIONS: readonly LocaleSetting[] = ['auto', 'zh-CN', 'en']
const LOCALE_LABEL_KEY = {
  auto: 'account.languageAuto',
  'zh-CN': 'account.languageZhCN',
  en: 'account.languageEn',
} as const

export interface AccountMenuProps {
  locale: LocaleSetting
  onLocaleChange: (next: LocaleSetting) => void
}

/**
 * The account row is the single menu trigger. Phase 0 offered only the language choice; phase 1
 * adds「模型与密钥」, which is the entry the spec gives the provider settings card.
 */
export function AccountMenu({ locale, onLocaleChange }: AccountMenuProps): JSX.Element {
  const { t } = useTranslation()
  const [providersOpen, setProvidersOpen] = useState(false)
  const [pane, setPane] = useState<SettingsPane>('providers')
  // The menu is gone by the time the card opens, so the card returns focus here itself.
  const accountRow = useRef<HTMLButtonElement | null>(null)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={accountRow}
              variant="ghost"
              size="sm"
              data-testid="account-row"
              aria-label={t('account.menu')}
              className="w-full justify-start gap-2 px-2 font-sans text-ui text-text-primary hover:bg-shell-row-hover"
            />
          }
        >
          <CircleUserIcon className="text-text-muted" />
          <span className="truncate">{t('account.localUser')}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="min-w-48">
          {SECTIONS.map(({ id, Icon, menuKey }) => (
            <DropdownMenuItem
              key={id}
              data-testid={`account-${id}`}
              onClick={() => {
                setPane(id)
                setProvidersOpen(true)
              }}
            >
              <Icon />
              {t(menuKey)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="account-language">
              <LanguagesIcon />
              {t('account.language')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={locale}
                onValueChange={(value) => {
                  if (LOCALE_OPTIONS.includes(value as LocaleSetting)) {
                    onLocaleChange(value as LocaleSetting)
                  }
                }}
              >
                {LOCALE_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem
                    key={option}
                    value={option}
                    data-testid={`account-language-${option}`}
                  >
                    {t(LOCALE_LABEL_KEY[option])}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      <SettingsModal
        pane={pane}
        open={providersOpen}
        onOpenChange={setProvidersOpen}
        finalFocus={accountRow}
      />
    </>
  )
}
