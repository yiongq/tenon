import { createElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import type { SessionFactsResponse } from '@tenon-app/contracts'
import { beforeAll, expect, it, vi } from 'vitest'
import { createI18n } from '../src/i18n/create-instance.js'

const context = vi.hoisted(() => ({ facts: null as SessionFactsResponse | null }))
vi.mock('../src/renderer/src/runtime/ChatProvider', () => ({
  useSessionStore: () => ({ sessionId: 'session-1' }),
  useSessionSnapshot: () => ({ facts: context.facts }),
}))

let zh: Awaited<ReturnType<typeof createI18n>>
let en: Awaited<ReturnType<typeof createI18n>>
beforeAll(async () => {
  zh = await createI18n('zh-CN', (message) => {
    throw new Error(message)
  })
  en = await createI18n('en', (message) => {
    throw new Error(message)
  })
})

const leadPath = '../src/renderer/src/components/composer/ComposerLead.tsx'
async function render(
  facts: SessionFactsResponse | null,
  locale: 'zh-CN' | 'en' = 'zh-CN',
): Promise<string> {
  context.facts = facts
  const { ComposerLead } = await import(leadPath)
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: locale === 'en' ? en : zh },
      createElement(ComposerLead),
    ),
  )
}

it.each([
  { established: false, profile: 'chat' },
  { established: false, profile: 'cowork' },
  { established: true, profile: 'chat' },
  { established: true, profile: 'cowork' },
] as const)(
  'presentation-r1 验收 10: no toggle after the first message; a task keeps its chip ($profile, established=$established)',
  async ({ established, profile }) => {
    const markup = await render({
      established,
      profile,
      workspace:
        profile === 'chat' ? null : { origin: 'dedicated', folders: ['/dedicated/session-1'] },
    })
    expect(markup.includes('data-testid="folder-toggle"')).toBe(!established)
    expect(markup.includes('data-testid="folder-chip"')).toBe(profile === 'cowork')
    expect(markup.includes('role="switch"')).toBe(!established)
    expect(markup.includes(`aria-checked="${String(profile === 'cowork')}"`)).toBe(!established)
    expect(markup.includes('在文件夹里工作')).toBe(!established)
    expect(markup.includes('专用文件夹')).toBe(profile === 'cowork')
  },
)

it('presentation-r1 验收 10: no folder controls before the facts arrive', async () => {
  expect(await render(null)).toBe('')
})

it('presentation-r1 验收 10: facts refreshes keep the toggle and open folder chip at the same React identity', async () => {
  const { ComposerLead } = await import(leadPath)
  const identities = (facts: SessionFactsResponse) => {
    context.facts = facts
    // React preserves mounted state for the same type + key at the same sibling position.
    const children = (ComposerLead() as ReactElement<{ children: ReactNode[] }>).props.children
    return children.map((child) => {
      if (child === null) return null
      const element = child as ReactElement
      return { type: element.type, key: element.key }
    })
  }
  const chat = identities({ established: false, profile: 'chat', workspace: null })
  const task = identities({
    established: false,
    profile: 'cowork',
    workspace: { origin: 'dedicated', folders: ['/dedicated/session-1'] },
  })
  const refreshed = identities({
    established: false,
    profile: 'cowork',
    workspace: { origin: 'picked', folders: ['/work/project'] },
  })
  expect(task[0]).toEqual(chat[0])
  expect(refreshed).toEqual(task)
})

it('presentation-r1 验收 10: the folder switch keeps its hit pseudo-element inside the clickable label', async () => {
  const markup = await render({ established: false, profile: 'chat', workspace: null })
  const toggle = /<[^>]*data-testid="folder-toggle"[^>]*>/.exec(markup)?.[0]
  expect(toggle).toBeDefined()
  expect(toggle).toContain('after:inset-x-0')
  expect(toggle).toContain('after:inset-y-0')
  expect(toggle).not.toContain('after:-inset-')
})

it('presentation-r1 验收 10: a folder chip names the complete first folder, counts the rest, and exposes every full path', async () => {
  const name = 'quarterly-planning-workspace-for-the-platform-team-2026'
  const folder = `/work/${name}`
  const single = await render(
    { established: false, profile: 'cowork', workspace: { origin: 'picked', folders: [folder] } },
    'en',
  )
  expect(single).toContain('Work in a folder')
  expect(single).toContain(`>${name}</span>`)
  expect(single).toContain(`title="${folder}"`)
  expect(single).toContain(`aria-label="${folder}"`)
  const multiple = await render({
    established: true,
    profile: 'cowork',
    workspace: { origin: 'picked', folders: [folder, '/other/two', '/other/three'] },
  })
  expect(multiple).toContain(`>${name}</span>`)
  expect(multiple).toContain('>+2</span>')
  expect(multiple).toContain(`title="${folder}\n/other/two\n/other/three"`)
  expect(multiple).toContain(`aria-label="${folder}\n/other/two\n/other/three"`)
})
