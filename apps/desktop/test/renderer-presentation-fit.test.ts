import { cloneElement, createElement, isValidElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { expect, it, vi } from 'vitest'
import { createI18n } from '../src/i18n/create-instance.js'

function group({ children }: { children?: ReactNode }) {
  return createElement('div', null, children)
}

// Keep the actual components, tooltip wrapper and translations. Portals are rendered in place to
// inspect their layout classes without a window; placement and clipping are still e2e assertions.
vi.mock('@base-ui/react/tooltip', () => ({
  Tooltip: {
    Root: group,
    Portal: group,
    Positioner: group,
    Trigger: ({ render, children, ...props }: { render?: ReactNode; children?: ReactNode }) =>
      isValidElement<{ children?: ReactNode }>(render)
        ? cloneElement(render, props, children ?? render.props.children)
        : createElement('span', props, children),
    Popup: ({ children, ...props }: { children?: ReactNode }) =>
      createElement('div', props, children),
    Arrow: (props: { 'data-slot'?: string }) => createElement('span', props),
  },
}))
vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({}),
  ComposerPrimitive: {
    Root: ({ children, ...props }: { children?: ReactNode }) =>
      createElement('div', props, children),
    Input: (props: object) => createElement('textarea', props),
    Send: ({ children, ...props }: { children?: ReactNode }) =>
      createElement('button', props, children),
  },
}))
vi.mock('../src/renderer/src/components/composer/ComposerLead', () => ({
  ComposerLead: () => null,
}))
vi.mock('../src/renderer/src/components/composer/ModelMenu', () => ({ ModelMenu: () => null }))
vi.mock('../src/renderer/src/components/settings/SettingsModal', () => ({
  SettingsModal: () => null,
}))
vi.mock('../src/renderer/src/runtime/mcp-store', () => ({ useMcp: () => ({ servers: [] }) }))
vi.mock('../src/renderer/src/runtime/ChatProvider', () => ({
  useSessionStore: () => ({ sessionId: 'session-1', sendBlock: () => 'modelUnusable' }),
  useSessionSnapshot: () => ({
    running: false,
    pending: null,
    resumable: false,
    facts: { profile: 'chat' },
    answered: new Map(),
    asked: new Map(),
    providers: [
      {
        id: 'anthropic',
        nameKey: 'provider.anthropic.name',
        configured: false,
        configKeys: [{ secret: true, configured: false }],
        endpoint: { host: 'api.anthropic.com', reach: 'public' },
        models: [],
      },
      {
        id: 'zhipu',
        nameKey: 'provider.zhipu.name',
        configured: true,
        configKeys: [{ secret: true, configured: true }],
        endpoint: { host: 'open.bigmodel.cn', reach: 'public' },
        models: [{ id: 'glm-5.3', nameKey: 'model.name.glm53', listing: 'main', mark: 'verified' }],
      },
    ],
  }),
}))

const composerPath = '../src/renderer/src/components/thread/Composer.tsx'
const rowPath = '../src/renderer/src/components/thread/ToolRow.tsx'

it.each(['zh-CN', 'en'] as const)(
  'presentation-r1 验收 13: the irreversible tooltip keeps its short text on one line without an overflowing arrow (%s)',
  async (locale) => {
    const i18n = await createI18n(locale, (message) => {
      throw new Error(message)
    })
    const { ToolRow } = await import(rowPath)
    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(ToolRow, {
          toolCallId: 'call-1',
          toolName: 'Bash',
          args: { command: 'layout' },
          result: {
            state: 'completed',
            effect: 'external',
            source: null,
            output: '',
            reversibility: 'irreversible',
          },
        }),
      ),
    )
    const popup = /<div\b[^>]*role="tooltip"[^>]*>(.*?)<span/.exec(html)
    expect(popup).not.toBeNull()
    expect(popup![0]).toContain('w-max')
    expect(popup![0]).toContain('max-w-none')
    expect(popup![0]).toContain('whitespace-nowrap')
    expect(popup![0]).toContain('[&amp;&gt;[data-slot=tooltip-arrow]]:hidden')
    expect(popup![1]).toBe(locale === 'en' ? 'Can&#x27;t be undone' : '撤不回')
  },
)

it.each(['zh-CN', 'en'] as const)(
  'presentation-r1 验收 13: send-block labels can move to another row without shrinking; the Zhipu switch describes open.bigmodel.cn outside the visual group (%s)',
  async (locale) => {
    const i18n = await createI18n(locale, (message) => {
      throw new Error(message)
    })
    const { Composer } = await import(composerPath)
    const html = renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(Composer)),
    )
    const block = /<p\b[^>]*data-testid="composer-send-block"[^>]*>([\s\S]*?)<\/p>/.exec(html)
    expect(block).not.toBeNull()
    expect(block![0]).toContain('flex-wrap')
    expect(block![0]).not.toContain('sr-only')
    const reason = /<span\b[^>]*data-testid="composer-block-reason"[^>]*>/.exec(block![0])![0]
    const settings = /<button\b[^>]*data-testid="composer-settings"[^>]*>/.exec(block![0])![0]
    expect(reason).toContain('shrink-0 whitespace-nowrap')
    expect(settings).toContain('shrink-0 whitespace-nowrap')
    const change = /<button\b[^>]*data-testid="composer-switch-model"[^>]*>(.*?)<\/button>/.exec(
      block![0],
    )!
    expect(change[0]).toContain('shrink-0')
    expect(change[0]).toContain('wrap-anywhere whitespace-normal')
    expect(change[1]).toBe(
      locale === 'en' ? 'Switch to Zhipu GLM GLM-5.3' : '改用 智谱 GLM GLM-5.3',
    )
    const descriptionId = /aria-describedby="([^"]*)"/.exec(change[0])![1]!
    expect(html).toContain(
      `<span id="${descriptionId}" class="sr-only">${locale === 'en' ? 'Sends to open.bigmodel.cn' : '发往 open.bigmodel.cn'}</span>`,
    )
    expect(html).not.toContain(
      locale === 'en' ? 'Sends to api.anthropic.com' : '发往 api.anthropic.com',
    )
  },
)
