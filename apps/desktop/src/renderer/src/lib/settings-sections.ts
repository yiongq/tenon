/**
 * The sections of the settings dialog, as data: one place that names them, in the order the left
 * rail lists them. The rail, the panels, the account menu's entries and the `#settings/<id>` hash
 * that makes a section linkable all read this list, so adding a section is one entry here plus its
 * icon and panel in components/settings/sections.tsx (a `Record` over the ids, so a section
 * without a panel does not compile) — not four edits that can disagree.
 */
export const SETTINGS_SECTIONS = [
  {
    id: 'providers',
    /** The rail's label. */
    labelKey: 'settings.providers.title',
    /** The account menu's label for the same section. */
    menuKey: 'account.providers',
  },
  { id: 'connectors', labelKey: 'mcp.title', menuKey: 'mcp.title' },
] as const

export type SettingsPane = (typeof SETTINGS_SECTIONS)[number]['id']

export const SETTINGS_PANES: readonly SettingsPane[] = SETTINGS_SECTIONS.map(({ id }) => id)

export function isSettingsPane(value: unknown): value is SettingsPane {
  return SETTINGS_PANES.some((pane) => pane === value)
}

const PREFIX = '#settings/'

/** The location hash that opens `pane` (`#settings/providers`). */
export function settingsHash(pane: SettingsPane): string {
  return `${PREFIX}${pane}`
}

/** The section a location hash names, or null for any other hash. */
export function paneOfHash(hash: string): SettingsPane | null {
  if (!hash.startsWith(PREFIX)) return null
  const id = hash.slice(PREFIX.length)
  return isSettingsPane(id) ? id : null
}
