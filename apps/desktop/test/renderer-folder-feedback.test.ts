/** Spec 05 acceptance 13: invoke the real chip handlers and render their resulting feedback. */
import { isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type * as React from 'react'
import type * as Contracts from '@tenon-app/contracts'
import { beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from '../src/i18n/create-instance.js'

const state = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  refresh: vi.fn<() => Promise<void>>(),
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useEffect: () => {},
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const index = state.cursor++
    if (!(index in state.values)) state.values[index] = initial
    return [
      state.values[index],
      (next: unknown) => {
        state.values[index] = next
      },
    ]
  },
}))
let language = await createI18n('zh-CN', () => {})
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: language.t.bind(language) }) }))
vi.mock('@tenon-app/contracts', async (original) => ({
  ...(await original<typeof Contracts>()),
  invokeRoute: state.invoke,
}))
vi.mock('../src/renderer/src/runtime/ChatProvider', () => ({
  useSessionStore: () => ({ sessionId: 'session-1', refreshFacts: state.refresh }),
  useSessionSnapshot: () => ({
    facts: { profile: 'cowork', workspace: { origin: 'picked', folders: ['/work'] } },
  }),
}))
const component = '../src/renderer/src/components/composer/FolderChip.tsx'
async function render() {
  state.cursor = 0
  const { FolderChip } = await import(component)
  return FolderChip({}) as ReactElement<{ children: ReactNode }>
}
function find(tree: ReactNode, id: string): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(tree)) return tree.map((child) => find(child, id)).find(Boolean)
  if (!isValidElement<Record<string, unknown>>(tree)) return undefined
  if (tree.props['data-testid'] === id) return tree
  return find(tree.props['children'] as ReactNode, id)
}
beforeEach(() => {
  state.values = [['/prefill']]
  state.invoke.mockReset()
  state.refresh.mockReset()
})
it.each(['zh-CN', 'en'] as const)(
  '05 验收 13: chip pick/prefill display root refusal or home warning in %s',
  async (locale) => {
    language = await createI18n(locale, () => {})
    const globals = { tenon: {} }
    vi.stubGlobal('window', globals)
    try {
      state.invoke.mockResolvedValue({ ok: true, data: { ok: false, code: 'root-folder' } })
      const pick = find(await render(), 'folder-add')
      await (pick!.props['onClick'] as () => Promise<void>)()
      await vi.waitFor(async () =>
        expect(find(await render(), 'folder-feedback')?.props['children']).toBe(
          language.t('folder.rootRefused'),
        ),
      )
      expect(state.refresh).not.toHaveBeenCalled()
      state.invoke.mockResolvedValue({
        ok: true,
        data: { ok: true, folders: ['/home'], origin: 'picked', warning: 'home' },
      })
      const prefill = find(await render(), 'folder-prefill')
      await (prefill!.props['onClick'] as () => Promise<void>)()
      await vi.waitFor(async () =>
        expect(find(await render(), 'folder-feedback')?.props['children']).toBe(
          language.t('folder.homeWarning'),
        ),
      )
      expect(state.refresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  },
)
