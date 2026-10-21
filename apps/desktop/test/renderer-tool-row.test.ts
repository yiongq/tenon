import { beforeAll, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18n } from 'i18next'
import type { ToolOutcomeViewContract } from '@tenon-app/contracts'
import { createI18n } from '../src/i18n/create-instance.js'
import type { Answered } from '../src/renderer/src/runtime/session-store.js'
import { toolRowEffect } from '../src/renderer/src/lib/tool-row-effect.js'
import * as toolCopy from '../src/renderer/src/lib/tool-sentence.js'
it('03 验收 45: side effects, write/external markers, and unauthorized-only relogin use mapped server ID', () => {
  for (const effect of ['read', 'write', 'external', 'blocked'] as const)
    for (const reversibility of [
      'read-only',
      'revertible',
      'snapshotted',
      'irreversible',
      'unknown',
    ] as const) {
      const out: ToolOutcomeViewContract = {
        effect,
        reversibility,
        state: 'completed',
        source: null,
        output: 'x',
      }
      expect(toolRowEffect(out, 'notes__echo')).toEqual({
        effectKey: `mcp.effects.${effect}`,
        reversibilityKey: `mcp.reversibility.${reversibility}`,
        marker:
          (effect === 'write' || effect === 'external') &&
          (reversibility === 'irreversible' || reversibility === 'unknown'),
        loginServerId: null,
      })
    }
  const denied: ToolOutcomeViewContract = {
    effect: 'blocked',
    state: 'not-run',
    source: 'connector-unauthorized',
    output: '',
  }
  expect(toolRowEffect(denied, 'notes__echo')?.loginServerId).toBe('notes')
  expect(toolRowEffect({ ...denied, source: 'protected' }, 'notes__echo')?.loginServerId).toBeNull()
  expect(toolRowEffect(denied, 'Read')?.loginServerId).toBeNull()
  expect(toolRowEffect(null, 'notes__echo')).toBeNull()
})

it('write without reversibility defaults to unknown and carries a side-effect marker', () => {
  expect(
    toolRowEffect(
      { effect: 'write', state: 'completed', source: null, output: 'ok' },
      'notes__echo',
    ),
  ).toMatchObject({ reversibilityKey: 'mcp.reversibility.unknown', marker: true })
})

// Render the real rows and translations; only the session and connector external stores are mocked.
const context = vi.hoisted(() => ({ answered: new Map<string, Answered>() }))
vi.mock('../src/renderer/src/runtime/ChatProvider', () => ({
  useSessionStore: () => ({ sessionId: 'session-1' }),
  useSessionSnapshot: () => ({
    pending: null,
    answered: context.answered,
    asked: new Map(),
  }),
}))
vi.mock('../src/renderer/src/runtime/mcp-store', () => ({ useMcp: () => ({ servers: [] }) }))

let en: I18n
let zh: I18n
beforeAll(async () => {
  en = await createI18n('en', () => {})
  zh = await createI18n('zh-CN', () => {})
})

const componentPath = '../src/renderer/src/components/thread/ToolRow.tsx'
const strip = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&')

async function renderRow(
  answered: Answered | null,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  i18n: I18n,
  persisted = false,
  result: ToolOutcomeViewContract | null = null,
): Promise<string> {
  context.answered = new Map(answered === null || persisted ? [] : [['call-1', answered]])
  const outcome =
    result ??
    (answered === null
      ? null
      : {
          effect: 'blocked' as const,
          state: answered.outcome === 'denied' ? ('not-run' as const) : ('completed' as const),
          source: answered.outcome === 'denied' ? ('user-rejected' as const) : null,
          output: '',
          ...(persisted
            ? {
                approval: {
                  outcome: answered.outcome,
                  scope: answered.scope,
                  target: answered.target,
                },
              }
            : {}),
        })
  const { ToolRow } = await import(componentPath)
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ToolRow, {
        toolCallId: 'call-1',
        toolName,
        args: input,
        result: outcome,
      }),
    ),
  )
}

function collapsed(html: string): string {
  return strip(/data-testid="approval-answered"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '')
}

it('presentation-r1 验收 4: an allowed main-session card collapses to one line without what the row already says; a command keeps its cwd, a search its backend host, a URL its punycode host; a subtask card keeps the object', async () => {
  const rows: {
    name: string
    input: Record<string, unknown>
    target: Answered['target']
    en: string
    zh: string
  }[] = [
    {
      name: 'Bash',
      input: { command: 'echo hello' },
      target: { type: 'command', command: 'echo hello', cwd: '/real/work' },
      en: ' · in /real/work',
      zh: ' · 位于 /real/work',
    },
    {
      name: 'WebSearch',
      input: { query: 'search words' },
      target: { type: 'search', query: 'search words', host: 'search.example' },
      en: ' · sent to search.example',
      zh: ' · 发往 search.example',
    },
    {
      name: 'WebFetch',
      input: { url: 'https://аpple.com./x' },
      target: { type: 'url', url: 'https://аpple.com./x' },
      en: ' · sent to xn--pple-43d.com',
      zh: ' · 发往 xn--pple-43d.com',
    },
    {
      name: 'notes__echo',
      input: {},
      target: { type: 'tool', serverId: 'notes', toolName: 'echo' },
      en: '',
      zh: '',
    },
  ]
  for (const i18n of [en, zh]) {
    for (const row of rows) {
      const answered: Answered = {
        outcome: 'allowed',
        scope: 'session',
        target: row.target,
        subtask: false,
      }
      const label =
        i18n === en
          ? `Allowed (${row.target.type === 'url' ? 'This domain, this session' : 'This session'})`
          : `已允许（${row.target.type === 'url' ? '本会话里这个域名' : '本会话'}）`
      for (const persisted of [false, true]) {
        // oxlint-disable-next-line no-await-in-loop -- live and persisted answers in both locales
        const html = await renderRow(answered, row.name, row.input, i18n, persisted)
        expect(collapsed(html)).toBe(label + (i18n === en ? row.en : row.zh))
      }
      // Subtask rows retain their own object, not the parent Agent's prompt.
      for (const outcome of ['allowed', 'denied'] as const) {
        // oxlint-disable-next-line no-await-in-loop -- each target and answer in both locales
        const html = await renderRow(
          { ...answered, subtask: true, outcome },
          'Agent',
          { description: 'parent prompt' },
          i18n,
        )
        const text = collapsed(html)
        expect(text).not.toContain(i18n === en ? 'this round stops here' : '这一轮到此为止')
        const object =
          row.target.type === 'command'
            ? 'echo hello'
            : row.target.type === 'search'
              ? 'search words'
              : row.target.type === 'url'
                ? row.target.url
                : 'echo'
        expect(text).toContain(object)
        expect(text).toContain(
          outcome === 'denied'
            ? i18n === en
              ? 'Denied'
              : '已拒绝'
            : i18n === en
              ? row.target.type === 'url'
                ? 'This domain, this subtask'
                : 'This subtask'
              : row.target.type === 'url'
                ? '本次子任务里这个域名'
                : '本次子任务',
        )
      }
    }
    // A live card uses its own host fact, even when it differs from the parsed URL.
    // oxlint-disable-next-line no-await-in-loop -- both locale catalogues
    const { AnsweredRow } = await import(componentPath)
    const target = { type: 'url', url: 'https://аpple.com/x' } as const
    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AnsweredRow, {
          answered: { outcome: 'allowed', scope: 'session', target, subtask: false },
          toolName: 'WebFetch',
          input: { url: target.url },
          host: 'frozen.example',
        }),
      ),
    )
    expect(collapsed(html)).toBe(
      i18n === en
        ? 'Allowed (This domain, this session) · sent to frozen.example'
        : '已允许（本会话里这个域名） · 发往 frozen.example',
    )
  }
})

it('presentation-r1 验收 4: a Write with a relative file_path collapses with the real path; one with the same absolute path does not repeat it', async () => {
  for (const i18n of [en, zh]) {
    for (const path of ['/real/notes.txt', '/real/se\u202Ecret.txt']) {
      for (const filePath of ['notes.txt', '/link/notes.txt', path]) {
        const answered: Answered = {
          outcome: 'allowed',
          scope: 'session',
          target: { type: 'path', path },
          subtask: false,
        }
        for (const persisted of [false, true]) {
          // oxlint-disable-next-line no-await-in-loop -- real versus displayed paths, live and redraw
          const html = await renderRow(answered, 'Write', { file_path: filePath }, i18n, persisted)
          const label = i18n === en ? 'Allowed (This session)' : '已允许（本会话）'
          const shown = path.replace('\u202E', '\\u{202E}')
          expect(collapsed(html)).toBe(label + (filePath === path ? '' : ` · ${shown}`))
        }
      }
    }
  }
})

it('presentation-r1 验收 4: the collapsed real path follows the tool sentence’s displayed slot value', async () => {
  const path = '/real/notes/today.md'
  const input = { file_path: path }
  const { AnsweredRow } = await import(componentPath)
  const originalSlotValue = toolCopy.toolSlotValue
  const displayedSlot = vi.spyOn(toolCopy, 'toolSlotValue')
  try {
    for (const i18n of [en, zh]) {
      // Before any display change, the slot and the real sentence agree; no path is repeated.
      displayedSlot.mockImplementation(originalSlotValue)
      expect(toolCopy.toolSentence(i18n.t, 'Write', input)).toBe(
        i18n.t('tool.Write', { path: toolCopy.toolSlotValue('Write', input) }),
      )
      const render = (): string =>
        renderToStaticMarkup(
          createElement(
            I18nextProvider,
            { i18n },
            createElement(AnsweredRow, {
              answered: {
                outcome: 'allowed',
                scope: 'session',
                target: { type: 'path', path },
                subtask: false,
              },
              toolName: 'Write',
              input,
            }),
          ),
        )
      const label = i18n === en ? 'Allowed (This session)' : '已允许（本会话）'
      expect(collapsed(render())).toBe(label)
      // Simulate 4d shortening the displayed slot while input.file_path stays absolute.
      displayedSlot.mockReturnValue('notes/today.md')
      expect(collapsed(render())).toBe(`${label} · ${path}`)
      expect(displayedSlot).toHaveBeenCalledWith('Write', input)
    }
  } finally {
    displayedSlot.mockRestore()
  }
})

it('presentation-r1 验收 4: a denied card is the only feedback: no closure line', async () => {
  for (const i18n of [en, zh]) {
    const answered: Answered = {
      outcome: 'denied',
      scope: null,
      target: { type: 'path', path: '/real/notes.txt' },
      subtask: false,
    }
    for (const persisted of [false, true]) {
      // oxlint-disable-next-line no-await-in-loop -- live and redraw in both locales
      const html = await renderRow(answered, 'Write', { file_path: 'notes.txt' }, i18n, persisted)
      expect(collapsed(html)).toBe(
        i18n === en ? 'Denied · this round stops here' : '已拒绝 · 这一轮到此为止',
      )
      expect(html).not.toContain('tool-row-closure')
      expect(collapsed(html)).not.toContain('notes.txt')
    }
    // Later calls in the batch have no answer of their own and still say 「未执行」.
    // oxlint-disable-next-line no-await-in-loop -- both locales
    const later = await renderRow(null, 'Read', { file_path: '/later.txt' }, i18n, false, {
      state: 'not-run',
      source: 'user-rejected',
      effect: 'blocked',
      output: '',
    })
    expect(later).toContain('tool-row-closure')
    expect(strip(later)).toContain(i18n === en ? 'Not run' : '未执行')
    expect(later).not.toContain('approval-answered')
  }
})
