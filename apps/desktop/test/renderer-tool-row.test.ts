import { beforeAll, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18n } from 'i18next'
import type { ToolOutcomeViewContract } from '@tenon-app/contracts'
import { createI18n } from '../src/i18n/create-instance.js'
import type { Answered } from '../src/renderer/src/runtime/session-store.js'
import { toolRowEffect } from '../src/renderer/src/lib/tool-row-effect.js'
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
          reversibility === 'revertible'
            ? null
            : reversibility === 'irreversible'
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

// Render the real rows and translations; stores and the local expansion state are controlled.
const context = vi.hoisted(() => ({
  answered: new Map<string, Answered>(),
  expanded: false,
  profile: 'cowork',
  // The root session's snapshot numbers by call; none unless a test sets them.
  snapshotCalls: [] as { callKey: string; snapshotId: string }[],
  snapshotStatus: 'tree' as 'tree' | 'warming' | 'file-only' | 'unavailable',
  canRestore: true,
  // Another round of the same session, put before or after round-1, when a test sets one.
  otherRound: null as null | {
    readonly at: 'before' | 'after'
    readonly calls: { callKey: string; snapshotId: string }[]
    readonly canRestore: boolean
  },
}))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useState: (initial: unknown) => actual.useState(initial === false ? context.expanded : initial),
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
const snapshotRound = vi.hoisted(
  () => (id: string, calls: { callKey: string; snapshotId: string }[], canRestore: boolean) => ({
    roundRunId: id,
    runIds: [id],
    endMessageId: null,
    calls,
    canRestore,
    incompleteCoverage: false,
    commandsWithoutSnapshot: false,
  }),
)
vi.mock('../src/renderer/src/runtime/SnapshotProvider', () => {
  return {
    useSnapshotRounds: () => {
      const own = snapshotRound('round-1', context.snapshotCalls, context.canRestore)
      const other =
        context.otherRound === null
          ? null
          : snapshotRound('round-2', context.otherRound.calls, context.otherRound.canRestore)
      return {
        sessionId: 'session-1',
        data:
          context.snapshotCalls.length === 0
            ? null
            : {
                ok: true,
                status: context.snapshotStatus,
                rounds:
                  other === null
                    ? [own]
                    : context.otherRound?.at === 'before'
                      ? [other, own]
                      : [own, other],
                incompleteRestores: [],
              },
        refresh: async () => null,
      }
    },
  }
})

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

it('presentation-r1 验收 4 / presentation-r1 不变量 3: an allowed main-session card collapses to one line without what the row already says; a command keeps its cwd, a search its backend host, a URL its punycode host; a subtask card keeps the object', async () => {
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

it('presentation-r1 验收 4: a Write through a linked workspace keeps the real path live and on redraw; the same absolute path does not repeat it', async () => {
  for (const i18n of [en, zh]) {
    for (const path of ['/real/ws/notes/today.md', '/real/ws/notes/se\u202Ecret.txt']) {
      for (const filePath of ['/link/ws/notes/today.md', path]) {
        const answered: Answered = {
          outcome: 'allowed',
          scope: 'session',
          target: { type: 'path', path },
          subtask: false,
        }
        for (const persisted of [false, true]) {
          // oxlint-disable-next-line no-await-in-loop -- real versus displayed paths, live and redraw
          const html = await renderRow(answered, 'Write', { file_path: filePath }, i18n, persisted)
          expect(collapsed(html)).toBe(
            filePath === path
              ? i18n === en
                ? 'Allowed (This session)'
                : '已允许（本会话）'
              : path === '/real/ws/notes/today.md'
                ? i18n === en
                  ? 'Allowed (This session) · /real/ws/notes/today.md'
                  : '已允许（本会话） · /real/ws/notes/today.md'
                : i18n === en
                  ? 'Allowed (This session) · /real/ws/notes/se\\u{202E}cret.txt'
                  : '已允许（本会话） · /real/ws/notes/se\\u{202E}cret.txt',
          )
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
              isError: false,
            }
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
              expected =
                did === 'online' || reversibility === 'revertible'
                  ? base
                  : `${base} · ${i18n.t(undo as never)}`
            }
            expect(didText(html), `${name}/${state}/${reversibility}`).toBe(expected)
            expect(strip(html)).not.toMatch(/副作用|Side effects/)
          }
        }
      }
    }
  } finally {
    context.expanded = false
  }
})

it('presentation-r1 验收 6: an Edit that came back with an error does not say 改了', async () => {
  context.expanded = true
  try {
    for (const i18n of [zh, en]) {
      for (const name of ['Edit', 'Write']) {
        for (const isError of [true, undefined, false]) {
          // oxlint-disable-next-line no-await-in-loop -- success, failure and live result lacking isError
          const html = await renderRow(null, name, {}, i18n, false, {
            effect: 'write',
            state: 'completed',
            source: null,
            output: 'result',
            ...(isError === undefined ? {} : { isError }),
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

it('presentation-r1 验收 5 (sandbox): a call with a sandbox member never renders the four-code notice', async () => {
  const markup = await renderRow(null, 'Bash', { command: 'echo test' }, en, false, {
    effect: 'blocked',
    state: 'completed',
    source: 'policy',
    output: 'ok',
    sandbox: {
      violations: [
        { kind: 'network', target: 'example.com', release: null, observed: true, protected: false },
      ],
      more: 0,
      anyProtected: false,
    },
  })
  expect(markup).toContain('data-testid="sandbox-notice"')
  expect(markup).not.toContain('data-testid="blocked-notice"')
  expect(strip(markup)).not.toContain("Your organization doesn't allow this step.")
  expect(strip(markup)).toContain('Could not connect to example.com')
})

it('05 验收 47: the failure icon has failure screen-reader text, never irreversible text, and receipts suppress it', async () => {
  context.expanded = false
  const outcome: ToolOutcomeViewContract = {
    effect: 'write',
    state: 'completed',
    source: null,
    output: 'failed',
    isError: true,
    reversibility: 'irreversible',
  }
  const failed = await renderRow(null, 'Delete', { file_path: '/work/a' }, zh, false, outcome)
  expect(failed).toContain('data-testid="tool-effect-marker"')
  expect(failed).toContain('没做成')
  expect(failed).not.toContain('撤不回')
  const receipt = await renderRow(null, 'Delete', { file_path: '/work/a' }, zh, false, {
    ...outcome,
    sandbox: { violations: [], more: 0, anyProtected: false },
  })
  expect(receipt).not.toContain('data-testid="tool-effect-marker"')
})

it('05 验收 48: successful Delete renders the file and consequence in both locales; failures do not claim deletion', async () => {
  context.expanded = true
  const outcome: ToolOutcomeViewContract = {
    effect: 'write',
    state: 'completed',
    source: null,
    output: 'ok',
    isError: false,
    reversibility: 'snapshotted',
  }
  const zhRow = await renderRow(null, 'Delete', { file_path: '/work/a' }, zh, false, outcome)
  expect(strip(zhRow)).toContain('/work/a')
  expect(didText(zhRow)).toBe('删了这个文件 · 有快照，这一轮可以一键还原。')
  expect(
    didText(await renderRow(null, 'Delete', { file_path: '/work/a' }, en, false, outcome)),
  ).toBe('Deleted this file · Snapshot taken first; you can undo this round.')
  expect(
    didText(
      await renderRow(null, 'Delete', { file_path: '/work/a' }, en, false, {
        ...outcome,
        isError: true,
      }),
    ),
  ).toBeNull()
})

function allowedWrite(code: string): ToolOutcomeViewContract {
  return {
    effect: 'write',
    reversibility: 'snapshotted',
    state: 'completed',
    source: null,
    output: 'ok',
    permission: { verdict: 'allow', code: code as never, facts: { toolName: 'Write' } },
  }
}

it('06 验收 38: an expanded allowed row shows why it was not asked; a folded one, a carded one and an asked one do not', async () => {
  const allowed = allowedWrite
  const input = { file_path: '/work/a.txt', content: 'x' }
  const why = (html: string) =>
    strip(/data-testid="tool-row-why"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '')
  try {
    context.expanded = true
    expect(why(await renderRow(null, 'Write', input, zh, false, allowed('auto-mode')))).toBe(
      '为什么没问 · 自动档放行',
    )
    expect(why(await renderRow(null, 'Write', input, en, false, allowed('session-allowed')))).toBe(
      'Why it wasn’t asked · You allowed this for the session',
    )
    // A call a card asked about, or one that was not allowed, adds nothing.
    const carded: ToolOutcomeViewContract = {
      ...allowed('default-ask'),
      approval: {
        outcome: 'allowed',
        scope: 'once',
        target: { type: 'path', path: '/work/a.txt' },
      },
    }
    expect(await renderRow(null, 'Write', input, zh, false, carded)).not.toContain('tool-row-why')
    const denied: ToolOutcomeViewContract = {
      ...allowed('org-policy'),
      permission: { verdict: 'deny', code: 'org-policy', facts: { toolName: 'Write' } },
    }
    expect(await renderRow(null, 'Write', input, zh, false, denied)).not.toContain('tool-row-why')
    // Folded, the row is as it was.
    context.expanded = false
    expect(await renderRow(null, 'Write', input, zh, false, allowed('auto-mode'))).not.toContain(
      'tool-row-why',
    )
  } finally {
    context.expanded = false
  }
})

it.each(['allow', 'ask', 'deny'] as const)(
  '06 验收 44: an unknown summary code under %s verdict changes the expanded row only where it already shows a reason',
  async (verdict) => {
    const outcome: ToolOutcomeViewContract = {
      effect: 'write',
      state: verdict === 'deny' ? 'not-run' : 'completed',
      source: verdict === 'deny' ? 'policy' : null,
      output: '',
      permission: { verdict, code: 'unknown' as never, facts: { toolName: 'Write' } },
    }
    try {
      context.expanded = true
      const html = await renderRow(null, 'Write', { file_path: '/work/a.txt' }, zh, false, outcome)
      // Only an allowed call already has a reason line; there it is the neutral sentence.
      expect(/data-testid="tool-row-why"/.test(html)).toBe(verdict === 'allow')
      expect(html.includes('这一步已放行。')).toBe(verdict === 'allow')
    } finally {
      context.expanded = false
    }
  },
)

function bash(reversibility: 'unknown' | 'irreversible'): ToolOutcomeViewContract {
  return {
    effect: 'write',
    reversibility,
    state: 'completed',
    source: null,
    output: 'ok',
    isError: false,
  }
}

it('command-undo-copy 验收 3: an expanded Bash row whose round can still be restored says its task-folder files can be; without a number, with a round that cannot, or irreversible, it keeps its sentence; other tools are unchanged', async () => {
  expect(toolRowEffect(bash('unknown'), 'Bash', true)?.undoKey).toBe('confirm.undo.commandRestored')
  expect(toolRowEffect(bash('unknown'), 'Bash', false)?.undoKey).toBe('confirm.undo.unknown')
  expect(toolRowEffect(bash('unknown'), 'Bash')?.undoKey).toBe('confirm.undo.unknown')
  expect(toolRowEffect(bash('irreversible'), 'Bash', true)?.undoKey).toBe('confirm.irreversible')
  for (const name of ['Write', 'Edit', 'Delete', 'notes__echo', 'WebFetch']) {
    for (const reversibility of [
      'read-only',
      'revertible',
      'snapshotted',
      'irreversible',
      'unknown',
    ] as const) {
      const outcome = { ...bash('unknown'), reversibility }
      expect(toolRowEffect(outcome, name, true), `${name}/${reversibility}`).toEqual(
        toolRowEffect(outcome, name, false),
      )
    }
  }
  const expected = {
    'zh-CN': {
      restored:
        '运行了这条命令 · 它在任务文件夹里改的文件能随这一轮还原；文件夹外的、联网发出的、.git 里的和被排除的文件撤不回。',
      old: '运行了这条命令 · 如果它改了东西，Tenon 没法替你撤回。',
    },
    en: {
      restored:
        "Ran this command · Files it changed in the task folder can be restored with this round; anything outside the folder, sent online, in .git, or excluded can't.",
      old: "Ran this command · If this changes anything, Tenon can't undo it.",
    },
  } as const
  context.expanded = true
  try {
    for (const i18n of [zh, en]) {
      const copy = expected[i18n.language as keyof typeof expected]
      context.snapshotCalls = [{ callKey: 'call-1', snapshotId: 'snapshot-1' }]
      // oxlint-disable-next-line no-await-in-loop -- with and without a snapshot number, both locales
      expect(didText(await renderRow(null, 'Bash', {}, i18n, false, bash('unknown')))).toBe(
        copy.restored,
      )
      context.snapshotCalls = [{ callKey: 'another-call', snapshotId: 'snapshot-1' }]
      // oxlint-disable-next-line no-await-in-loop -- another call's number is not this call's
      expect(didText(await renderRow(null, 'Bash', {}, i18n, false, bash('unknown')))).toBe(
        copy.old,
      )
      // Its own number, but the round can no longer be restored (snapshots cleared, or already
      // restored): the settlement line has no 「可还原」, so neither does the row.
      context.snapshotCalls = [{ callKey: 'call-1', snapshotId: 'snapshot-1' }]
      context.canRestore = false
      // oxlint-disable-next-line no-await-in-loop -- a round that cannot be restored
      expect(didText(await renderRow(null, 'Bash', {}, i18n, false, bash('unknown')))).toBe(
        copy.old,
      )
      // Another round of the session, before or after this call's, never decides for this row: an
      // earlier round cleared or restored while a later one can, and the other way round.
      for (const at of ['before', 'after'] as const) {
        for (const own of [false, true]) {
          context.canRestore = own
          context.otherRound = {
            at,
            calls: [{ callKey: 'other-call', snapshotId: 'snapshot-2' }],
            canRestore: !own,
          }
          // oxlint-disable-next-line no-await-in-loop -- this call's round against the other one
          expect(didText(await renderRow(null, 'Bash', {}, i18n, false, bash('unknown')))).toBe(
            own ? copy.restored : copy.old,
          )
        }
      }
      context.otherRound = null
      context.canRestore = true
      // The row reads its own call and round, not the session's snapshot state now.
      for (const status of ['warming', 'file-only', 'unavailable'] as const) {
        context.snapshotStatus = status
        // oxlint-disable-next-line no-await-in-loop -- the session's current state does not matter
        expect(didText(await renderRow(null, 'Bash', {}, i18n, false, bash('unknown')))).toBe(
          copy.restored,
        )
      }
      context.snapshotStatus = 'tree'
      context.snapshotCalls = []
      // oxlint-disable-next-line no-await-in-loop -- no snapshot read model at all
      expect(didText(await renderRow(null, 'Bash', {}, i18n, false, bash('unknown')))).toBe(
        copy.old,
      )
    }
  } finally {
    context.expanded = false
    context.snapshotCalls = []
    context.snapshotStatus = 'tree'
    context.canRestore = true
    context.otherRound = null
  }
})
