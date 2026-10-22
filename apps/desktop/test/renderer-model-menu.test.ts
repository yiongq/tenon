import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { expect, it, vi } from 'vitest'
import { createI18n } from '../src/i18n/create-instance.js'

function group({ children }: { children?: ReactNode }) {
  return createElement('div', null, children)
}

// Render highlighted rows without a browser. Menu placement and pointer behavior remain e2e's job.
vi.mock('../src/renderer/src/components/ui/dropdown-menu', () => {
  return {
    DropdownMenu: group,
    DropdownMenuContent: group,
    DropdownMenuGroup: group,
    DropdownMenuLabel: group,
    DropdownMenuSeparator: () => null,
    DropdownMenuSub: group,
    DropdownMenuSubContent: group,
    DropdownMenuSubTrigger: group,
    DropdownMenuTrigger: group,
    DropdownMenuItem: ({
      children,
      render,
    }: {
      children?: ReactNode
      render?: (props: { children?: ReactNode }, state: { highlighted: boolean }) => ReactNode
    }) => (render ? render({ children }, { highlighted: true }) : group({ children })),
  }
})

vi.mock('@base-ui/react/tooltip', () => {
  return {
    Tooltip: {
      Root: group,
      Portal: group,
      Positioner: group,
      Trigger: ({ render }: { render: ReactNode }) => render,
      Popup: ({ children, ...props }: { children?: ReactNode }) =>
        createElement('div', props, children),
      Arrow: (props: { 'data-slot'?: string }) =>
        createElement('span', {
          'aria-hidden': true,
          'data-slot': props['data-slot'],
          'data-test-arrow': '',
        }),
    },
  }
})
vi.mock('../src/renderer/src/components/settings/SettingsModal', () => ({
  SettingsModal: () => null,
}))
vi.mock('../src/renderer/src/components/composer/TypeModelDialog', () => ({
  TypeModelDialog: () => null,
}))
vi.mock('@assistant-ui/react', () => ({ useAuiState: () => false }))
vi.mock('../src/renderer/src/runtime/conversation', () => ({
  useConversation: () => ({ sessionId: 'session-1' }),
}))
vi.mock('../src/renderer/src/runtime/ChatProvider', () => ({
  useSessionStore: () => ({}),
  useSessionSnapshot: () => ({
    running: false,
    pending: null,
    modelChoice: null,
    facts: { profile: 'chat' },
    heldSeq: 0,
    providers: [
      {
        id: 'anthropic',
        nameKey: 'provider.anthropic.name',
        configured: true,
        configKeys: [{ name: 'baseURL', default: 'https://api.anthropic.com' }],
        endpoint: { host: 'api.anthropic.com', reach: 'public' },
        models: [{ id: 'test-model', mark: 'verified', listing: 'main' }],
      },
    ],
  }),
}))

const componentPath = '../src/renderer/src/components/composer/ModelMenu.tsx'
it.each(['zh-CN', 'en'] as const)(
  'presentation-r1 验收 13: the destination tooltip fits its unwrapped text with no decorative arrow overflowing its box (%s)',
  async (locale) => {
    const i18n = await createI18n(locale, (message) => {
      throw new Error(message)
    })
    const { ModelMenu } = await import(componentPath)
    const markup = renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(ModelMenu)),
    )
    const tooltip = /<div[^>]*data-testid="model-row-host-tooltip"[^>]*>(.*?)<\/div>/.exec(markup)
    expect(tooltip).not.toBeNull()
    expect(tooltip?.[0]).toContain('w-max')
    expect(tooltip?.[0]).toContain('max-w-none')
    expect(tooltip?.[0]).toContain('[&amp;&gt;[data-slot=tooltip-arrow]]:hidden')
    expect(tooltip?.[1]).toBe(
      `<span class="whitespace-nowrap">${locale === 'en' ? 'Sends to' : '发往'} api.anthropic.com</span><span aria-hidden="true" data-slot="tooltip-arrow" data-test-arrow=""></span>`,
    )
  },
)
