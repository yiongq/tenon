/**
 * The settings dialog's sections are one list: the rail, the panels, the account menu and the
 * `#settings/<id>` hash all read it, so they cannot disagree about which sections exist.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SETTINGS_PANES,
  SETTINGS_SECTIONS,
  isSettingsPane,
  paneOfHash,
  settingsHash,
} from '../src/renderer/src/lib/settings-sections.js'

const locales = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n', 'locales')

function catalogue(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(locales, locale, 'common.json'), 'utf8'))
}

function lookup(tree: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree)
}

describe('settings sections', () => {
  it('lists each pane once, in the order the rail shows them', () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([...SETTINGS_PANES])
    expect(new Set(SETTINGS_PANES).size).toBe(SETTINGS_PANES.length)
    expect(SETTINGS_PANES).toEqual(['providers', 'connectors'])
  })

  it('names every section in both catalogues, for the rail and for the account menu', () => {
    for (const locale of ['zh-CN', 'en']) {
      const tree = catalogue(locale)
      for (const section of SETTINGS_SECTIONS) {
        for (const key of [section.labelKey, section.menuKey]) {
          const text = lookup(tree, key)
          expect(typeof text === 'string' && text !== '', `${locale} ${key}`).toBe(true)
        }
      }
    }
  })

  it('round-trips the location hash', () => {
    for (const pane of SETTINGS_PANES) expect(paneOfHash(settingsHash(pane))).toBe(pane)
    expect(settingsHash('providers')).toBe('#settings/providers')
    expect(paneOfHash('#settings/nope')).toBeNull()
    expect(paneOfHash('#settings/')).toBeNull()
    expect(paneOfHash('#other/providers')).toBeNull()
    // Same length as the prefix, so only the prefix check tells them apart from a real hash.
    expect(paneOfHash('#settingz/providers')).toBeNull()
    expect(paneOfHash('#SETTINGS/connectors')).toBeNull()
    expect(paneOfHash('')).toBeNull()
    expect(isSettingsPane('connectors')).toBe(true)
    expect(isSettingsPane('nope')).toBe(false)
  })
})
