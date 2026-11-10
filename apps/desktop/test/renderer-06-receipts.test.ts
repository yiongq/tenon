import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { i18n as I18n } from 'i18next'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ToolOutcomeViewContract } from '@tenon-app/contracts'
import { createI18n } from '../src/i18n/create-instance.js'
import { objectParts, whyKey } from '../src/renderer/src/lib/approval-card.js'
import { runEndKey } from '../src/renderer/src/lib/end-card.js'
import { tx } from '../src/renderer/src/lib/tx.js'

// 06 第二段的界面（§界面「第二段」、§从回执允许一次）：卡上的类别句、对象行的写法、回执的「允许这一次」、
// 本轮累计的结束文案。组件当函数调用，`useState` 由测试控制，同 04 回执的测试。
let language: I18n
let zh: I18n
let en: I18n
let releaseState: string | undefined
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: language.t.bind(language) }) }))
vi.mock('react', async (original) => {
  const actual = await original<typeof React>()
  return {
    ...actual,
    useState: (initial: unknown) =>
      initial === undefined
        ? [
            releaseState,
            (next: string) => {
              releaseState = next
            },
          ]
        : actual.useState(initial),
  }
})
vi.mock('../src/renderer/src/runtime/ChatProvider', () => ({
  useSessionStore: () => ({ sessionId: 'session-1' }),
  useSessionSnapshot: () => ({
    pending: null,
    facts: { profile: 'cowork' },
    answered: new Map(),
    asked: new Map(),
  }),
}))
vi.mock('../src/renderer/src/runtime/mcp-store', () => ({ useMcp: () => ({ servers: [] }) }))

type Outcome = ToolOutcomeViewContract
const rowPath = '../src/renderer/src/components/thread/ToolRow.tsx'
let BlockedNotice: (props: {
  callKey: string
  outcome: Outcome
  toolName: string
  profile: 'chat' | 'cowork'
}) => ReactElement
let InspectorRelease: (props: { callKey: string }) => ReactElement

function fail(message: string): never {
  throw new Error(message)
}
function card(reason: string, kind: string, facts: Record<string, string>): string | null {
  return whyKey({
    reason,
    kind,
    facts,
    target: { type: 'command', command: 'x', cwd: '/w' },
  } as Parameters<typeof whyKey>[0])
}

beforeAll(async () => {
  ;({ BlockedNotice, InspectorRelease } = await import(rowPath))
  zh = await createI18n('zh-CN', fail)
  en = await createI18n('en', fail)
  language = en
})

afterEach(() => {
  vi.unstubAllGlobals()
  releaseState = undefined
  language = en
})

function blocked(source: Outcome['source'], facts: Record<string, string>): string {
  const outcome: Outcome = {
    effect: 'blocked',
    state: 'not-run',
    source,
    output: '',
    facts: { toolName: 'Bash', ...facts },
  }
  return renderToStaticMarkup(
    createElement(BlockedNotice, {
      callKey: 'run:1:0',
      outcome,
      toolName: 'Bash',
      profile: 'cowork',
    }),
  )
}
function texts(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim()
}
function nodes(
  tree: ReactNode,
  match: (props: Record<string, unknown>) => boolean,
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, match))
  if (!isValidElement<Record<string, unknown>>(tree)) return []
  return [...(match(tree.props) ? [tree] : []), ...nodes(tree.props.children as ReactNode, match)]
}
function allowOnce(tree: ReactElement): ReactElement<Record<string, unknown>> {
  const found = nodes(tree, (props) => props['data-testid'] === 'receipt-allow-once')[0]
  expect(found).toBeDefined()
  return found!
}
async function click(status: string | Error): Promise<ReturnType<typeof vi.fn>> {
  const invoke = vi.fn<(channel: string, input: unknown) => Promise<unknown>>()
  if (status instanceof Error) invoke.mockRejectedValue(status)
  else invoke.mockResolvedValue({ ok: true, data: { status } })
  vi.stubGlobal('window', { tenon: { invoke } })
  await (allowOnce(InspectorRelease({ callKey: 'run:1:0' })).props.onClick as () => Promise<void>)()
  return invoke
}

describe('06 第二段的卡与回执', () => {
  it('06 验收 20: an inspector-failed receipt offers allow once', async () => {
    // Only a check's block can be released; the organization, a protected place and a setting the
    // user turned off never offer it.
    for (const source of ['policy', 'protected', 'user-disabled'] as const)
      expect(blocked(source, {})).not.toContain('receipt-allow-once')
    for (const category of ['inspector-failed', 'control-characters']) {
      const html = blocked('inspector', { category })
      expect(html).toContain('data-testid="receipt-allow-once"')
      expect(texts(html)).toContain('Allow once')
      expect(texts(html)).toContain(
        'Applies once when this exact step is sent again in this task. Unused permission expires at the end of the next reply.',
      )
    }

    // A click sends only the session and the call; released and already-released both read 已放行.
    for (const status of ['released', 'already-released']) {
      releaseState = undefined
      // oxlint-disable-next-line no-await-in-loop -- each click uses its own controlled bridge response
      const invoke = await click(status)
      expect(invoke.mock.calls).toEqual([
        ['inspector.release', { sessionId: 'session-1', callKey: 'run:1:0' }],
      ])
      const after = InspectorRelease({ callKey: 'run:1:0' })
      expect(allowOnce(after).props.disabled).toBe(true)
      expect(texts(renderToStaticMarkup(after))).toContain('Allowed')
    }

    // A refusal says why inline and leaves the button usable; none of the lines names a command.
    for (const [status, expected] of [
      ['stale', 'This step can no longer be allowed. If you still need it, have it done again.'],
      ['not-found', 'This step was not found. If you still need it, have it done again.'],
      ['refused', 'Permission cannot be granted now. Try again later.'],
    ] as const) {
      releaseState = undefined
      // oxlint-disable-next-line no-await-in-loop -- each click uses its own controlled bridge response
      await click(status)
      const after = InspectorRelease({ callKey: 'run:1:0' })
      expect(allowOnce(after).props.disabled).toBe(false)
      expect(texts(renderToStaticMarkup(after))).toContain(expected)
    }
    releaseState = undefined
    await click(new Error('bridge down'))
    expect(texts(renderToStaticMarkup(InspectorRelease({ callKey: 'run:1:0' })))).toContain(
      'Permission could not be granted. Try again.',
    )
  })

  it('06 验收 26: second-segment cards and receipts carry their sentences, marks and allow once', async () => {
    // ③: the hidden-characters sentence; a command card a check asked about says its category,
    // otherwise nothing (D36).
    expect(card('flagged', 'file', { category: 'hidden-characters' })).toBe(
      'confirm.reason.flagged.hidden-characters',
    )
    expect(card('command', 'command', { category: 'hidden-characters' })).toBe(
      'confirm.reason.flagged.hidden-characters',
    )
    expect(card('command', 'command', { category: 'exfiltration' })).toBe(
      'confirm.reason.flagged.exfiltration',
    )
    expect(card('command', 'command', {})).toBeNull()
    expect(zh.t('confirm.reason.flagged.hidden-characters')).toBe(
      '路径或命令里有看不见的字符，已经标出来，先给你看一眼。',
    )
    expect(en.t('confirm.reason.flagged.hidden-characters')).toBe(
      'This path or command contains invisible characters. They are marked so you can check it first.',
    )

    // ②: the object line keeps 02 ②′'s `\u{XXXX}` for zero-width and tag characters (D25).
    expect(objectParts(en.t, { type: 'path', path: '/w/a​b.txt' })[0]!.text).toBe(
      '/w/a\\u{200B}b.txt',
    )
    expect(
      objectParts(en.t, { type: 'command', command: 'echo \u{E0041}hi', cwd: '/w' })[0]!.text,
    ).toBe('echo \\u{E0041}hi')

    // The receipt: the control-characters sentence, 「允许这一次」 with its note, then 已放行.
    for (const [i18n, sentence, button, note] of [
      [
        zh,
        '路径或命令里有控制字符，已拦下。',
        '允许这一次',
        '在这个任务里再发出完全相同的这一步时生效一次；到下一轮回复结束还没用上就作废',
      ],
      [
        en,
        'This path or command contains control characters, so it was stopped.',
        'Allow once',
        'Applies once when this exact step is sent again in this task. Unused permission expires at the end of the next reply.',
      ],
    ] as const) {
      language = i18n
      releaseState = undefined
      expect(texts(blocked('inspector', { category: 'control-characters' }))).toBe(
        `${sentence} ${button} ${note}`,
      )
      releaseState = 'released'
      expect(texts(renderToStaticMarkup(InspectorRelease({ callKey: 'run:1:0' })))).toContain(
        i18n === zh ? '已放行' : 'Allowed',
      )
    }

    // The run end of a round's cumulative blocks has its own sentence; the run of three keeps 02's.
    expect(runEndKey({ code: 'blocked-repeatedly', count: 20, scope: 'round' })).toBe(
      'runEnd.blocked-repeatedly-round',
    )
    expect(runEndKey({ code: 'blocked-repeatedly', count: 3 })).toBe('runEnd.blocked-repeatedly')
    expect(tx(zh.t, 'runEnd.blocked-repeatedly-round', { count: 20 })).toBe(
      '这一轮被拦了 20 次，任务已结束。',
    )
    expect(tx(en.t, 'runEnd.blocked-repeatedly-round', { count: 20 })).toBe(
      'Calls were blocked 20 times in this round, so the task ended.',
    )

    // Both catalogues have every new key, and none of them names the model, the sandbox or a check's
    // internal name.
    const keys = [
      'confirm.reason.flagged.hidden-characters',
      'confirm.reason.flagged.control-characters',
      'blocked.inspector.hidden-characters',
      'blocked.inspector.control-characters',
      'receipt.action.allow-once',
      'receipt.note.allow-once',
      'receipt.error.step-stale',
      'receipt.error.step-not-found',
      'runEnd.blocked-repeatedly-round',
      'snapshot.decision.inspector-flagged',
    ]
    for (const key of keys) {
      expect([key, zh.exists(key, { lng: 'zh-CN', fallbackLng: false })]).toEqual([key, true])
      expect([key, en.exists(key, { lng: 'en', fallbackLng: false })]).toEqual([key, true])
      expect(String(zh.t(key as never, { count: 20 } as never))).not.toMatch(/模型|沙箱|inspector/i)
      expect(String(en.t(key as never, { count: 20 } as never))).not.toMatch(
        /model|sandbox|inspector/i,
      )
    }
  })
})
