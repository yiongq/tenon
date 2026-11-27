import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { i18n as I18n } from 'i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { configSchema } from '@tenon-app/contracts'
import type { SessionFactsResponse } from '@tenon-app/contracts'
import { createI18n } from '../src/i18n/create-instance.js'
import { modeMenuItems, showsAutoBanner } from '../src/renderer/src/lib/approval-mode.js'
import type { Downgrade } from '../src/renderer/src/lib/approval-mode.js'

// 06 第三段的档位界面（§界面「档位菜单」「横幅」「说明条」「降档提示」「设置」）。组件在一次真实的
// 渲染里当函数调用，拿到它返回的元素树，再直接点树上的 handler；store 那一半在 session-store 的测试里。
let language: I18n
let zh: I18n
let en: I18n
const store = {
  sessionId: 'session-1',
  setApprovalMode: vi.fn<(mode: 'manual' | 'auto') => Promise<boolean>>(async () => true),
  dismissAutoNotice: vi.fn<() => Promise<void>>(async () => {}),
  dismissDowngrade: vi.fn<() => void>(),
}
const context: {
  facts: SessionFactsResponse | null
  autoNotice: boolean
  downgrade: Downgrade | null
  status: 'tree' | 'warming' | 'file-only' | 'unavailable' | null
} = { facts: null, autoNotice: false, downgrade: null, status: null }
const refresh = vi.fn<() => Promise<null>>(async () => null)
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: language.t.bind(language) }) }))
vi.mock('../src/renderer/src/runtime/ChatProvider', () => ({
  useSessionStore: () => store,
  useSessionSnapshot: () => ({
    facts: context.facts,
    autoNotice: context.autoNotice,
    downgrade: context.downgrade,
  }),
}))
vi.mock('../src/renderer/src/runtime/SnapshotProvider', () => ({
  useSnapshotRounds: () => ({
    sessionId: 'session-1',
    data: context.status === null ? null : { status: context.status },
    refresh,
  }),
}))

const menuPath = '../src/renderer/src/components/composer/ApprovalModeMenu.tsx'
const bannerPath = '../src/renderer/src/components/composer/ComposerBanner.tsx'
const sectionPath = '../src/renderer/src/components/settings/ApprovalDefaultSection.tsx'

function fail(message: string): never {
  throw new Error(message)
}
beforeAll(async () => {
  zh = await createI18n('zh-CN', fail)
  en = await createI18n('en', fail)
})
beforeEach(() => {
  language = zh
  context.facts = null
  context.autoNotice = false
  context.downgrade = null
  context.status = null
  vi.clearAllMocks()
})

function task(
  approvalMode: 'manual' | 'auto',
  extra: Partial<SessionFactsResponse> = {},
): SessionFactsResponse {
  return {
    established: false,
    profile: 'cowork',
    workspace: { folders: ['/dedicated/session-1'], origin: 'dedicated' },
    approvalMode,
    ...extra,
  }
}
const CHAT: SessionFactsResponse = {
  established: false,
  profile: 'chat',
  workspace: null,
  approvalMode: 'manual',
}

/** What a component returns, from inside a real render (so its hooks run). */
function treeOf(component: () => ReactElement | null): ReactElement | null {
  let out: ReactElement | null = null
  renderToStaticMarkup(
    createElement(() => {
      out = component()
      return null
    }),
  )
  return out
}
type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>
function walk(node: ReactNode, visit: (element: Element) => void): void {
  if (Array.isArray(node)) for (const child of node) walk(child, visit)
  else if (isValidElement(node)) {
    const element = node as Element
    visit(element)
    walk(element.props.children, visit)
    if (isValidElement(element.props.render)) walk(element.props.render, visit)
  }
}
function byTestId(root: ReactNode, id: string): Element[] {
  const found: Element[] = []
  walk(root, (element) => {
    if (element.props['data-testid'] === id) found.push(element)
  })
  return found
}
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node as Element).props.children)
  return ''
}
function radioValue(root: ReactNode): unknown {
  let value: unknown
  walk(root, (element) => {
    if (typeof element.props.onValueChange === 'function') value = element.props.value
  })
  return value
}
function onValueChange(root: ReactNode): (value: string) => void {
  let handler: ((value: string) => void) | undefined
  walk(root, (element) => {
    if (typeof element.props.onValueChange === 'function') {
      handler = element.props.onValueChange as (value: string) => void
    }
  })
  return handler!
}

describe('06 验收 31: the mode menu shows two modes in task sessions only', () => {
  it('has no menu outside a task, and both modes, the current one ticked, in a task draft', async () => {
    const { ApprovalModeMenu } = await import(menuPath)
    context.facts = CHAT
    expect(treeOf(ApprovalModeMenu)).toBeNull()
    expect(modeMenuItems(CHAT)).toEqual([])
    expect(modeMenuItems(null)).toEqual([])

    for (const mode of ['manual', 'auto'] as const) {
      context.facts = task(mode)
      const tree = treeOf(ApprovalModeMenu)
      expect(byTestId(tree, 'approval-mode-trigger')[0]?.props['data-mode']).toBe(mode)
      expect(radioValue(tree)).toBe(mode)
      expect(byTestId(tree, 'approval-mode-manual')).toHaveLength(1)
      expect(byTestId(tree, 'approval-mode-auto')).toHaveLength(1)
    }
    const tree = treeOf(ApprovalModeMenu)
    expect(textOf(byTestId(tree, 'approval-mode-manual'))).toBe('手动会改动的都先问你。')
    expect(textOf(byTestId(tree, 'approval-mode-auto'))).toBe(
      '自动工作区里能还原的改动和沙箱里的命令不再问你；撤不回的、越出文件夹的、按规则拦下的照样问。',
    )
  })

  it('keeps auto choosable with the no-snapshot line, refreshing the state as the menu opens', async () => {
    const { ApprovalModeMenu } = await import(menuPath)
    context.facts = task('manual')
    for (const status of ['tree', 'warming', 'file-only'] as const) {
      context.status = status
      expect(byTestId(treeOf(ApprovalModeMenu), 'approval-mode-no-snapshot')).toEqual([])
    }
    context.status = 'unavailable'
    const tree = treeOf(ApprovalModeMenu)
    const line = byTestId(byTestId(tree, 'approval-mode-auto'), 'approval-mode-no-snapshot')
    expect(textOf(line)).toBe('这个任务没法留底，改动照样问你')
    expect(byTestId(tree, 'approval-mode-auto')[0]?.props.disabled).toBeUndefined()
    let opened: ((open: boolean) => void) | undefined
    walk(tree, (element) => {
      if (
        element.props['data-testid'] === undefined &&
        typeof element.props.onOpenChange === 'function'
      )
        opened = element.props.onOpenChange as (open: boolean) => void
    })
    opened?.(true)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('writes a choice only when it changes', async () => {
    const { ApprovalModeMenu } = await import(menuPath)
    context.facts = task('manual')
    const choose = onValueChange(treeOf(ApprovalModeMenu))
    choose('manual')
    expect(store.setApprovalMode).not.toHaveBeenCalled()
    choose('auto')
    expect(store.setApprovalMode).toHaveBeenCalledWith('auto')
  })

  it('has no auto item, and no banner, while the policy turns auto off (D40)', async () => {
    const { ApprovalModeMenu } = await import(menuPath)
    const { ComposerBanner } = await import(bannerPath)
    context.facts = task('manual', { autoModeDisabled: true })
    const tree = treeOf(ApprovalModeMenu)
    expect(byTestId(tree, 'approval-mode-manual')).toHaveLength(1)
    expect(byTestId(tree, 'approval-mode-auto')).toEqual([])
    expect(renderToStaticMarkup(createElement(ComposerBanner))).toBe('')
    // Even a fact the kernel has not folded yet never shows the banner.
    expect(showsAutoBanner(task('auto', { autoModeDisabled: true }))).toBe(false)
  })
})

describe('06 验收 32: the auto banner stays and clicking it returns to manual', () => {
  it('shows in auto with no way to close it, and is one button back to manual', async () => {
    const { AutoBanner, ComposerBanner } = await import(bannerPath)
    context.facts = task('auto', { established: true })
    const markup = renderToStaticMarkup(createElement(ComposerBanner))
    expect(markup).toContain('data-testid="auto-banner"')
    expect(markup).toContain('自动档：能还原的改动不再问你')
    expect(markup).toContain('切回手动')
    expect(markup).not.toContain('downgrade-close')
    expect(markup.match(/<button/g)).toHaveLength(1)
    const banner = treeOf(AutoBanner)!
    ;(banner.props as { onClick: () => void }).onClick()
    expect(store.setApprovalMode).toHaveBeenCalledWith('manual')
    // Once the task is manual the banner is gone.
    context.facts = task('manual', { established: true })
    expect(renderToStaticMarkup(createElement(ComposerBanner))).toBe('')
    expect(showsAutoBanner(CHAT)).toBe(false)
  })
})

describe('06 验收 33: the auto notice shows once and links to the permissions pane', () => {
  it('says what goes unasked, what is still asked and how to restore; 「设置」 opens 「权限与网络」', async () => {
    const { AutoNotice, ComposerBanner } = await import(bannerPath)
    context.facts = task('auto')
    context.autoNotice = true
    const markup = renderToStaticMarkup(createElement(ComposerBanner))
    expect(markup).toContain('data-testid="auto-notice"')
    expect(markup).toContain('href="#settings/permissions"')
    for (const key of ['title', 'unasked', 'asked', 'restore', 'settings', 'dismiss'] as const) {
      expect(markup).toContain(zh.t(`approvalMode.notice.${key}`))
    }
    let dismiss: (() => void) | undefined
    walk(treeOf(AutoNotice), (element) => {
      if (element.props['data-testid'] === 'auto-notice-dismiss')
        dismiss = element.props.onClick as () => void
    })
    dismiss?.()
    expect(store.dismissAutoNotice).toHaveBeenCalledTimes(1)
    // A notice left over once the task went back to manual does not show.
    context.facts = task('manual')
    expect(renderToStaticMarkup(createElement(ComposerBanner))).toBe('')
  })
})

describe('06 验收 34: the downgrade line says consecutive or round, can close, without the banner', () => {
  it.each([
    ['zh-CN', 'consecutive', 3, '连着被拦了 3 次，已停下并切回手动档'],
    ['zh-CN', 'round', 20, '这一轮被拦了 20 次，已停下并切回手动档'],
    ['en', 'consecutive', 3, 'Blocked 3 times in a row. Stopped and switched back to manual.'],
    ['en', 'round', 20, 'Blocked 20 times this round. Stopped and switched back to manual.'],
  ] as const)('%s %s', async (locale, scope, count, sentence) => {
    const { ComposerBanner, DowngradeLine } = await import(bannerPath)
    language = locale === 'en' ? en : zh
    context.facts = task('manual', { established: true })
    context.downgrade = { scope, count }
    const markup = renderToStaticMarkup(createElement(ComposerBanner))
    expect(markup).toContain(sentence)
    expect(markup).not.toContain('auto-banner')
    let close: (() => void) | undefined
    walk(treeOf(DowngradeLine), (element) => {
      if (element.props['data-testid'] === 'downgrade-close')
        close = element.props.onClick as () => void
    })
    close?.()
    expect(store.dismissDowngrade).toHaveBeenCalledTimes(1)
  })
})

describe('06 验收 35: the permissions pane lists mode, folder access, allowlist, advanced', () => {
  it('changes only the new-task default through config.set', async () => {
    const { ApprovalDefaultSection } = await import(sectionPath)
    const invoked: Array<{ channel: string; input: unknown }> = []
    vi.stubGlobal('window', {
      tenon: {
        invoke: async (channel: string, input: unknown) => {
          invoked.push({ channel, input })
          return { ok: true, data: configSchema.parse({ approvalMode: 'auto' }) }
        },
      },
    })
    const tree = treeOf(ApprovalDefaultSection)
    const markup = renderToStaticMarkup(createElement(ApprovalDefaultSection))
    expect(markup).toContain('审批档')
    expect(markup).toContain('新任务默认用这一档；正在用的任务不变。')
    const auto = byTestId(tree, 'approval-default-auto')[0]!
    ;(auto.props.onChange as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(invoked).toEqual([{ channel: 'config.set', input: { approvalMode: 'auto' } }])
    vi.unstubAllGlobals()
  })
})
