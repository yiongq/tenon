/**
 * 「打开日志文件夹」 (docs/features/error-logs/spec.md §打开日志文件夹, §接口; acceptance 12): the
 * Help menu has it in both builds and both languages, the click reaches `onOpenLogs`, and
 * `openLogsFolder` hands the folder to the system and says where it is when the system cannot.
 *
 * This file only adds cases. The two older menu files (`menu-template.test.ts`, `menu.test.ts`)
 * assert that a packaged build has no Help at all, which this feature changes; they are the
 * implementer's to rewrite, with a 「测试改动」 line.
 *
 * - The catalogue is the real one (`createI18n`), so what is checked is the copy a user reads.
 * - `openPath` stands in for Electron's `shell.openPath`: it takes a path and resolves to '' when
 *   the system opened it, or to a message when it could not (Electron's documented contract, which
 *   the spec's interface restates). `showErrorBox` stands in for `dialog.showErrorBox`: a call that
 *   returns nothing. Neither does more than record.
 * - `electron` is mocked the way `menu.test.ts` does it, for `buildApplicationMenu`'s `app` and
 *   `Menu`; `Menu.buildFromTemplate` hands the template back.
 */
import type { MenuItemConstructorOptions } from 'electron'
import type { i18n as I18n } from 'i18next'
import { absolutePath } from '@tenon-app/kernel'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from '../src/i18n/create-instance.js'
import { applicationMenuTemplate } from '../src/main/menu-template.js'
import { buildApplicationMenu } from '../src/main/menu.js'
import { openLogsFolder } from './support/error-logs-startup.js'

// Hoisted above the import of menu.js, as vi.mock itself is.
const electron = vi.hoisted(() => ({ app: { isPackaged: true, name: 'Tenon' } }))

vi.mock('electron', () => ({
  app: electron.app,
  Menu: { buildFromTemplate: (template: MenuItemConstructorOptions[]) => template },
}))

const LABEL = { en: 'Open Logs Folder', 'zh-CN': '打开日志文件夹' } as const
type Locale = keyof typeof LABEL

const catalogue = {} as Record<Locale, I18n>

beforeAll(async () => {
  for (const locale of Object.keys(LABEL) as Locale[]) {
    // oxlint-disable-next-line no-await-in-loop -- two catalogues, one after the other
    catalogue[locale] = await createI18n(locale, (message) => {
      throw new Error(`i18n: ${message}`)
    })
  }
})

beforeEach(() => {
  electron.app.isPackaged = true
})

function helpItems(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const help = template.filter((item) => item.role === 'help')
  expect(help, 'exactly one Help menu').toHaveLength(1)
  return (help[0]?.submenu ?? []) as MenuItemConstructorOptions[]
}

/** A click as the menu makes it: item, window, key event (the handler takes none of them). */
function click(item: MenuItemConstructorOptions | undefined): void {
  item?.click?.({} as never, undefined, {} as never)
}

/** A template as `menu.test.ts` reads one: `Menu.buildFromTemplate` is mocked to hand it back. */
const asTemplate = (menu: unknown): MenuItemConstructorOptions[] =>
  menu as MenuItemConstructorOptions[]

/** What stands in for `shell.openPath` and `dialog.showErrorBox` (see the header). */
function hands(opened: string) {
  const openPath = vi.fn<(path: string) => Promise<string>>(() => Promise.resolve(opened))
  const boxes: Array<{ title: string; content: string }> = []
  const showErrorBox = (title: string, content: string): void => {
    boxes.push({ title, content })
  }
  return { openPath, boxes, showErrorBox }
}

describe('error-logs 验收 12: the Help menu', () => {
  it('error-logs 验收 12: Help has Open Logs Folder in both builds and a failed open shows the path', async () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      for (const packaged of [true, false]) {
        for (const isMac of [true, false]) {
          const where = `${locale}, ${packaged ? 'packaged' : 'development'}, ${isMac ? 'macOS' : 'other'}`
          const onOpenLogs = vi.fn<() => void>()
          const options = { isMac, packaged, appName: 'Tenon', onNewChat: () => {}, onOpenLogs }
          const template = applicationMenuTemplate(
            catalogue[locale].getFixedT(null, 'menu'),
            options,
          )
          const items = helpItems(template)
          const open = items.filter((item) => item.label === LABEL[locale])
          expect(open, `${where}: one ${LABEL[locale]} item`).toHaveLength(1)
          expect(open[0]?.enabled, `${where}`).not.toBe(false)

          // The click is the only thing that reaches the handler, once per click.
          expect(onOpenLogs, `${where}`).not.toHaveBeenCalled()
          click(open[0])
          expect(onOpenLogs, `${where}`).toHaveBeenCalledTimes(1)

          // A user's Help is this one entry and nothing else; a development build keeps 「了解更多」,
          // still greyed out, beside it.
          expect(items, `${where}`).toHaveLength(packaged ? 1 : 2)
          expect(
            items.filter((item) => item !== open[0]).map((item) => item.enabled),
            `${where}`,
          ).toEqual(packaged ? [] : [false])
        }
      }
    }

    // And the other half of the sentence: the system could not open it, so the box says where it is.
    const dir = absolutePath('/srv/tenon-e2e/profiles/local/personal/logs')
    const h = hands('Failed to open path')
    await openLogsFolder({
      dir,
      openPath: h.openPath,
      showErrorBox: h.showErrorBox,
      languages: ['en-US'],
    })
    expect(h.boxes).toHaveLength(1)
    expect(h.boxes[0]?.content).toContain('/srv/tenon-e2e/profiles/local/personal/logs')
  })

  it('error-logs 验收 12: buildApplicationMenu hands onOpenLogs to the Help item, packaged or not, by default or told', () => {
    const onOpenLogs = vi.fn<() => void>()
    const labelOf = (template: MenuItemConstructorOptions[]) =>
      helpItems(template).find((item) => item.label === LABEL.en)

    // No build kind given: the app's own `isPackaged`, as main calls it.
    const byDefault = asTemplate(buildApplicationMenu(catalogue.en, () => {}, onOpenLogs))
    click(labelOf(byDefault))
    expect(onOpenLogs).toHaveBeenCalledTimes(1)

    for (const packaged of [true, false]) {
      onOpenLogs.mockClear()
      const told = asTemplate(buildApplicationMenu(catalogue.en, () => {}, onOpenLogs, packaged))
      click(labelOf(told))
      expect(onOpenLogs, `packaged ${packaged}`).toHaveBeenCalledTimes(1)
    }
  })
})

describe('error-logs 验收 12: openLogsFolder', () => {
  const dir = absolutePath('/srv/tenon-e2e/profiles/local/personal/logs')
  const CJK = /[\u3400-\u9fff]/u

  it('error-logs 验收 12: Open Logs Folder gives the folder to the system as it is and shows nothing when it opens', async () => {
    const h = hands('')
    await openLogsFolder({
      dir,
      openPath: h.openPath,
      showErrorBox: h.showErrorBox,
      languages: ['en-US'],
    })
    expect(h.openPath).toHaveBeenCalledTimes(1)
    expect(h.openPath).toHaveBeenCalledWith('/srv/tenon-e2e/profiles/local/personal/logs')
    expect(h.boxes).toEqual([])
  })

  it('error-logs 验收 12: when the system cannot open the folder a box names its path, in the system language', async () => {
    for (const [languages, zh] of [
      [['en-US'], false],
      [['zh-CN'], true],
      [[], false],
    ] as const) {
      const h = hands('Failed to open path')
      // oxlint-disable-next-line no-await-in-loop -- one call at a time
      await openLogsFolder({
        dir,
        openPath: h.openPath,
        showErrorBox: h.showErrorBox,
        languages,
      })
      expect(h.openPath, `${languages.join()}`).toHaveBeenCalledTimes(1)
      expect(h.boxes, `${languages.join()}`).toHaveLength(1)
      const box = h.boxes[0]
      expect(box?.content, `${languages.join()}`).toContain(
        '/srv/tenon-e2e/profiles/local/personal/logs',
      )
      expect(CJK.test(`${box?.title}${box?.content}`), `${languages.join()}`).toBe(zh)
    }
  })

  it('error-logs 验收 12: with no log folder yet there is nothing to hand over', async () => {
    const h = hands('')
    await openLogsFolder({
      dir: null,
      openPath: h.openPath,
      showErrorBox: h.showErrorBox,
      languages: ['en-US'],
    })
    expect(h.openPath).not.toHaveBeenCalled()
  })
})
