import { beforeAll, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18n } from 'i18next'
import type { ToolOutcomeViewContract } from '@tenon-app/contracts'
import { createI18n } from '../src/i18n/create-instance.js'
import type { Answered } from '../src/renderer/src/runtime/session-store.js'
import { messageRowSchema } from '@tenon-app/contracts'
import { toolRowEffect, writeResultError } from '../src/renderer/src/lib/tool-row-effect.js'
import * as toolCopy from '../src/renderer/src/lib/tool-sentence.js'
it('03 验收 45: the expanded sentence uses tool names, only irreversible rows carry markers, and unauthorized-only relogin uses the mapped server ID (R25)', () => {
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
        didKey: 'tool.did.connector',
        undoKey:
          reversibility === 'irreversible'
            ? 'confirm.irreversible'
            : `confirm.undo.${reversibility}`,
        marker: reversibility === 'irreversible',
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

it('presentation-r1 验收 6: write without reversibility defaults to unknown without a marker', () => {
  expect(
    toolRowEffect(
      { effect: 'write', state: 'completed', source: null, output: 'ok' },
      'notes__echo',
    ),
  ).toMatchObject({ undoKey: 'confirm.undo.unknown', marker: false })
})

// Render the real rows and translations; stores and the local expansion/result state are controlled.
const context = vi.hoisted(() => ({
  answered: new Map<string, Answered>(),
  expanded: false,
  profile: 'cowork',
  writeError: undefined as boolean | undefined,
}))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useState: (initial: unknown) =>
      actual.useState(
        initial === false
          ? context.expanded
          : initial === undefined && context.writeError !== undefined
            ? { sessionId: 'session-1', callKey: 'call-1', isError: context.writeError }
            : initial,
      ),
  }
})
vi.mock('../src/renderer/src/runtime/ChatProvider', () => ({
  useSessionStore: () => ({ sessionId: 'session-1' }),
  useSessionSnapshot: () => ({
    pending: null,
    facts: { profile: context.profile },
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
  const tooltipPath = '../src/renderer/src/components/ui/tooltip.tsx'
  const { TooltipProvider } = await import(tooltipPath)
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        TooltipProvider,
        null,
        createElement(ToolRow, {
          toolCallId: 'call-1',
          toolName,
          args: input,
          result: outcome,
        }),
      ),
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

it('presentation-r1 验收 5: each of the four block codes is one line without 已告诉模型 or a tool name; protected reads, writes and fetches each have their own', async () => {
  const cases: readonly (readonly [
    NonNullable<ToolOutcomeViewContract['source']>,
    string,
    Record<string, unknown>,
    string,
    string,
  ])[] = [
    ['policy', 'Bash', {}, '你的组织不允许这一步。', "Your organization doesn't allow this step."],
    [
      'user-disabled',
      'notes__echo',
      {},
      '你在设置里关掉了它。',
      'You turned this off in Settings.',
    ],
    ...['Read', 'Glob', 'Grep'].map(
      (name) =>
        [
          'protected',
          name,
          {},
          '这个位置受保护，Tenon 不读它。',
          "This location is protected; Tenon doesn't read it.",
        ] as const,
    ),
    ...['Write', 'Edit'].map(
      (name) =>
        [
          'protected',
          name,
          {},
          '这个位置受保护，Tenon 不改它。',
          "This location is protected; Tenon doesn't change it.",
        ] as const,
    ),
    [
      'protected',
      'WebFetch',
      {},
      'Tenon 只抓取公网上的网页，这个地址不在其中。',
      "Tenon only fetches public web pages; this isn't one.",
    ],
    [
      'inspector',
      'Bash',
      { category: 'exfiltration' },
      '这一步可能把你的数据带到别处，已拦下。',
      'This step might take your data elsewhere, so it was stopped.',
    ],
    [
      'inspector',
      'Bash',
      { category: 'inspector-failed' },
      'Tenon 没能确认这一步是否安全，已拦下。',
      "Tenon couldn't check that this step is safe, so it was stopped.",
    ],
  ]
  for (const i18n of [zh, en]) {
    for (const [source, name, facts, chinese, english] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- each source and protected target in both locales
      const html = await renderRow(null, name, {}, i18n, false, {
        effect: 'blocked',
        state: 'not-run',
        source,
        output: '',
        facts: { toolName: name, target: '/private/object', ...facts },
      })
      const notice = /data-testid="blocked-notice"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
      expect(strip(notice)).toBe(i18n === zh ? chinese : english)
      expect(notice.match(/<p[ >]/g)).toHaveLength(1)
      expect(strip(notice)).not.toMatch(
        /已告诉|model|Read|Write|Edit|Glob|Grep|Bash|WebFetch|notes__echo|\/private\/object/,
      )
    }
    context.profile = 'chat'
    try {
      // oxlint-disable-next-line no-await-in-loop -- both locales
      const html = await renderRow(null, 'Read', {}, i18n, false, {
        effect: 'blocked',
        state: 'not-run',
        source: 'protected',
        output: '',
        facts: { toolName: 'Read', target: '/private/object' },
      })
      const notice = /data-testid="blocked-notice"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
      expect(strip(notice)).toBe(
        i18n === zh
          ? '对话里只能打开 Tenon 为这个对话保存的文件。'
          : 'In a chat, only files Tenon saved for this chat can be opened.',
      )
      expect(notice.match(/<p[ >]/g)).toHaveLength(1)
    } finally {
      context.profile = 'cowork'
    }
  }
})

function didText(html: string): string | null {
  const content = /data-testid="tool-side-effects"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1]
  return content === undefined ? null : strip(content)
}

it('presentation-r1 验收 6: the expanded line says what it did and whether it can be undone; none for a read, an Agent, an AskUserQuestion or a call that did not complete; online says only 联网', async () => {
  context.expanded = true
  try {
    for (const i18n of [zh, en]) {
      for (const name of [
        'Write',
        'Edit',
        'Bash',
        'WebSearch',
        'WebFetch',
        'notes__echo',
        'Read',
        'Glob',
        'Grep',
        'Agent',
        'AskUserQuestion',
      ]) {
        for (const state of ['completed', 'not-run', 'aborted', 'uncertain'] as const) {
          for (const reversibility of [
            'read-only',
            'revertible',
            'snapshotted',
            'irreversible',
            'unknown',
          ] as const) {
            // Deliberately contradict the tool name: presentation must never classify by effect.
            const outcome: ToolOutcomeViewContract = {
              effect: 'read',
              reversibility,
              state,
              source: state === 'completed' ? null : 'user-rejected',
              output: 'ok',
            }
            context.writeError = false
            // oxlint-disable-next-line no-await-in-loop -- table of rendered outcomes in both locales
            const html = await renderRow(null, name, {}, i18n, false, outcome)
            const did = ['Write', 'Edit'].includes(name)
              ? 'write'
              : name === 'Bash'
                ? 'command'
                : ['WebSearch', 'WebFetch'].includes(name)
                  ? 'online'
                  : name === 'notes__echo'
                    ? 'connector'
                    : null
            let expected: string | null = null
            if (state === 'completed' && did !== null) {
              const base = i18n.t(`tool.did.${did}` as never)
              const undo =
                reversibility === 'irreversible'
                  ? 'confirm.irreversible'
                  : reversibility === 'unknown' && did === 'write'
                    ? 'confirm.undo.unknownFile'
                    : `confirm.undo.${reversibility}`
              expected = did === 'online' ? base : `${base} · ${i18n.t(undo as never)}`
            }
            expect(didText(html), `${name}/${state}/${reversibility}`).toBe(expected)
            expect(strip(html)).not.toMatch(/副作用|Side effects/)
          }
        }
      }
    }
  } finally {
    context.expanded = false
    context.writeError = undefined
  }
})

it('presentation-r1 验收 6: an Edit that came back with an error does not say 改了', async () => {
  context.expanded = true
  try {
    for (const i18n of [zh, en]) {
      for (const name of ['Edit', 'Write']) {
        for (const isError of [true, undefined, false]) {
          context.writeError = isError
          // oxlint-disable-next-line no-await-in-loop -- success, failure and live result lacking isError
          const html = await renderRow(null, name, {}, i18n, false, {
            effect: 'write',
            state: 'completed',
            source: null,
            output: 'result',
          })
          expect(didText(html)).toBe(
            isError === false
              ? i18n === zh
                ? '改了这个文件 · Tenon 没法替你撤回这次改动。'
                : "Changed this file · Tenon can't undo this change for you."
              : null,
          )
        }
      }
    }
  } finally {
    context.expanded = false
    context.writeError = undefined
  }
})

it('presentation-r1 验收 6: only an irreversible row carries the marker, with its tooltip and screen-reader text', async () => {
  for (const i18n of [zh, en]) {
    for (const effect of ['read', 'write', 'external', 'blocked'] as const) {
      for (const reversibility of [
        'read-only',
        'revertible',
        'snapshotted',
        'irreversible',
        'unknown',
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- marker table with actual Tooltip trigger and sr-only text
        const html = await renderRow(null, 'notes__echo', {}, i18n, false, {
          effect,
          reversibility,
          state: 'completed',
          source: null,
          output: '',
        })
        expect(html.includes('data-testid="tool-effect-marker"')).toBe(
          reversibility === 'irreversible',
        )
        expect(html.includes('data-slot="tooltip-trigger"')).toBe(reversibility === 'irreversible')
        const screenReader = /<span class="sr-only">(.*?)<\/span>/.exec(html)?.[1] ?? null
        expect(screenReader).toBe(
          reversibility === 'irreversible'
            ? i18n === zh
              ? '撤不回'
              : 'Can&#x27;t be undone'
            : null,
        )
        // The portalled popup is exercised by E/tools.spec.ts.
      }
    }
  }
})

const request = (name: string) => ({ type: 'tool-request', id: 'reused-id', name, input: {} })
const response = (isError: boolean) => ({
  type: 'tool-response',
  id: 'reused-id',
  content: [],
  isError,
})
it('presentation-r1 验收 6: an expanded write reads isError from session.messages, pages for old calls and never reuses a provider ID from another call', async () => {
  const sessionId = '11111111-1111-4111-8111-111111111111'
  const row = (orderSeq: number, content: unknown[], calls?: unknown[]) =>
    messageRowSchema.parse({
      sessionId,
      messageId: `message-${orderSeq}`,
      orderSeq,
      role: calls ? 'assistant' : 'user',
      status: 'complete',
      entryId: orderSeq,
      createdAt: 0,
      updatedAt: 0,
      content,
      ...(calls ? { calls } : {}),
    })
  const rows = [
    row(1, [request('Write')], [{ callKey: 'old-call', outcome: null }]),
    row(2, [response(false)]),
    row(3, [request('Edit')], [{ callKey: 'new-call', outcome: null }]),
    row(4, [response(true)]),
  ]
  expect(writeResultError(rows, 'old-call')).toBe(false)
  expect(writeResultError(rows, 'new-call')).toBe(true)
  expect(writeResultError(rows, 'missing')).toBeUndefined()
  expect(writeResultError(rows.slice(0, 1), 'old-call')).toBeUndefined()
  const { readWriteError } = await import(componentPath)
  const invoke = vi
    .fn<(channel: string, payload: unknown) => Promise<unknown>>()
    .mockResolvedValueOnce({ ok: true, data: rows.slice(2) })
    .mockResolvedValueOnce({ ok: true, data: rows.slice(0, 2) })
  const bridge = { invoke } as unknown as Parameters<typeof readWriteError>[0]
  expect(await readWriteError(bridge, sessionId, 'old-call')).toBe(false)
  expect(invoke.mock.calls).toEqual([
    ['session.messages', { sessionId, limit: 1000 }],
    ['session.messages', { sessionId, limit: 1000, beforeOrderSeq: 3 }],
  ])
  invoke.mockReset().mockResolvedValueOnce({ ok: true, data: rows })
  expect(await readWriteError(bridge, sessionId, 'new-call')).toBe(true)
  invoke.mockReset().mockResolvedValue({ ok: true, data: [] })
  expect(await readWriteError(bridge, sessionId, 'missing')).toBeUndefined()
  invoke
    .mockReset()
    .mockResolvedValue({ ok: false, error: { code: 'internal', message: 'unavailable' } })
  expect(await readWriteError(bridge, sessionId, 'old-call')).toBeUndefined()
})
