import { KeyRoundIcon, PlugIcon, ShieldCheckIcon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SETTINGS_SECTIONS } from '@/lib/settings-sections'
import type { SettingsPane } from '@/lib/settings-sections'
import { ConnectorsPane } from './ConnectorsPane'
import { SandboxPane } from './SandboxPane'
import { PaneFrame } from './PaneFrame'
import { ProviderSettings } from './ProviderSettings'
import type { ProviderSettingsProps } from './ProviderSettings'

/** What a section looks like and shows; its id, order and labels are lib/settings-sections.ts. */
interface SectionView {
  readonly Icon: LucideIcon
  readonly render: (props: ProviderSettingsProps) => JSX.Element
}

/** A `Record` over the ids: a section added to the list without its view does not compile. */
const VIEWS: Record<SettingsPane, SectionView> = {
  permissions: { Icon: ShieldCheckIcon, render: () => <SandboxPane /> },
  providers: {
    Icon: KeyRoundIcon,
    render: (props) => <ProviderSettings {...props} embedded />,
  },
  connectors: {
    Icon: PlugIcon,
    render: () => <ConnectorsSection />,
  },
}

/** The dialog's sections in order, each with its labels (for the rail and the account menu) and view. */
export const SECTIONS = SETTINGS_SECTIONS.map((section) =>
  Object.assign({}, section, VIEWS[section.id]),
)

function ConnectorsSection(): JSX.Element {
  const { t } = useTranslation()
  return (
    <PaneFrame
      header={
        <DialogHeader>
          <DialogTitle>{t('mcp.title')}</DialogTitle>
          <DialogDescription>{t('mcp.description')}</DialogDescription>
        </DialogHeader>
      }
    >
      <ConnectorsPane />
    </PaneFrame>
  )
}
