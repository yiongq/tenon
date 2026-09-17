import type { LocaleSetting } from '@tenon-app/contracts'
import { CircleUserIcon, LanguagesIcon } from 'lucide-react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

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

/** The account row is the single menu trigger; phase 0 offers only the language choice. */
export function AccountMenu({ locale, onLocaleChange }: AccountMenuProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
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
  )
}
