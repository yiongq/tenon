/** Render the real feature components; replace only provider state and portal primitives for SSR. */
import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import type * as React from 'react'
import type * as Snapshots from '../src/renderer/src/lib/snapshots.js'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '../src/i18n/create-instance.js'
import type { Rounds, RestoreState } from '../src/renderer/src/lib/snapshots.js'
import type { MessageRowContract } from '@tenon-app/contracts'

const state = vi.hoisted(() => ({
  data: null as Rounds | null,
  flow: null as RestoreState | null,
  thread: false,
  index: 0,
  open: false,
  failed: false,
  record: null as {
    messages: MessageRowContract[]
    round: NonNullable<Rounds>['rounds'][number]
  } | null,
}))
vi.mock('react', async (original) => {
  const actual = await original<typeof React>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (!state.thread || state.index >= 3) return actual.useState(initial)
      return actual.useState([state.open, state.record, state.failed][state.index++])
    },
  }
})
vi.mock('../src/renderer/src/lib/snapshots', async (original) => {
  const actual = await original<typeof Snapshots>()
  return {
    ...actual,
    RestoreFlow: class extends actual.RestoreFlow {
      override getSnapshot = () => state.flow!
    },
  }
})
vi.mock('../src/renderer/src/runtime/SnapshotProvider', () => ({
  useSnapshotRounds: () => ({
    sessionId: 'session',
    data: state.data,
    refresh: async () => state.data,
  }),
}))
function content({ children }: { children?: ReactNode }) {
  return createElement('div', null, children)
}
vi.mock('../src/renderer/src/components/ui/dialog', () => {
  return {
    Dialog: ({ children, open }: { children?: ReactNode; open: boolean }) =>
      open ? content({ children }) : null,
    DialogContent: content,
    DialogTitle: content,
    DialogDescription: content,
    DialogFooter: content,
  }
})
vi.mock('../src/renderer/src/components/ui/dropdown-menu', () => {
  return {
    DropdownMenu: content,
    DropdownMenuContent: content,
    DropdownMenuTrigger: ({ render }: { render: ReactNode }) => render,
    DropdownMenuItem: ({ children }: { children?: ReactNode }) =>
      createElement('button', { role: 'menuitem' }, children),
  }
})
const restoreComponent = '../src/renderer/src/components/thread/RestoreDialog.tsx'
const titleComponent = '../src/renderer/src/components/thread/ThreadTitleMenu.tsx'
afterEach(() => {
  state.thread = false
  vi.unstubAllGlobals()
})

it('05 验收 16、18、52: RestoreDialog renders the full plan, promised skip reason and default keep choices', async () => {
  vi.stubGlobal('window', { tenon: {} })
  const { RestoreLink } = await import(restoreComponent)
  const i18n = await createI18n('zh-CN', () => {})
  state.flow = {
    phase: 'preview',
    error: null,
    done: null,
    selected: new Set(),
    preview: {
      previewKey: 'key',
      restore: ['/work/changed'],
      remove: ['/work/created'],
      conflicts: ['/work/changed'],
      skipped: [{ path: '/work/excluded', reason: 'excluded', promised: true }],
    },
  }
  const render = () =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(RestoreLink, { roundRunId: 'round', label: '可还原' }),
      ),
    )
  const html = render()
  for (const value of [
    '/work/changed',
    '/work/created',
    '/work/excluded',
    '卡上标过有快照',
    '确认还原',
  ])
    expect(html.replace(/<[^>]*>/g, '')).toContain(value)
  expect(html).toMatch(/checked=""[^>]*\/>保留/)
  expect(html).not.toMatch(/checked=""[^>]*\/>覆盖/)
  state.flow = { ...state.flow, selected: new Set(['/work/changed']) }
  expect(render()).toMatch(/checked=""[^>]*\/>覆盖/)
  state.flow = { ...state.flow, phase: 'applying' }
  expect(render()).toContain('disabled=""')
  state.flow = {
    phase: 'done',
    error: null,
    preview: null,
    selected: new Set(),
    done: {
      ok: true,
      undoSnapshotId: 'undo',
      restored: 1,
      removed: 1,
      kept: 0,
      skipped: 1,
      failed: ['/work/failed'],
    },
  }
  expect(render().replace(/<[^>]*>/g, '')).toContain('/work/failed')
  expect(render()).toContain('aria-live="polite"')
  expect(render()).not.toContain('确认还原')
  state.flow = { ...state.flow, phase: 'error', done: null, error: 'busy' }
  expect(render()).toContain('role="alert"')
  expect(render()).not.toContain('确认还原')
})

it('05 验收 34: ThreadTitleMenu renders only the record action and shows snapshot availability from the current round', async () => {
  const { ThreadTitleMenu } = await import(titleComponent)
  const i18n = await createI18n('zh-CN', () => {})
  state.thread = true
  state.open = false
  state.record = null
  state.failed = false
  state.data = null
  const render = () => {
    state.index = 0
    return renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(ThreadTitleMenu)),
    )
  }
  expect(render()).toBe('')
  const round = {
    roundRunId: 'run',
    runIds: ['run'],
    endMessageId: 'end',
    calls: [{ callKey: 'run:0:0', snapshotId: 'snapshot-before' }],
    canRestore: true,
    incompleteCoverage: false,
    commandsWithoutSnapshot: false,
  }
  state.data = { ok: true, status: 'tree', incompleteRestores: [], rounds: [round] }
  const menu = render()
  expect(menu.match(/role="menuitem"/g)).toHaveLength(1)
  expect(menu).toContain('查看本次记录')
  expect(menu).toContain('thread-title-menu')
  state.open = true
  state.record = {
    round,
    messages: [
      {
        sessionId: 'session',
        messageId: 'message',
        orderSeq: 1,
        entryId: 1,
        createdAt: 0,
        updatedAt: 0,
        role: 'assistant',
        status: 'complete',
        content: [
          { type: 'tool-request', name: 'Write', id: 'call', input: { file_path: '/work/a' } },
        ],
        calls: [
          {
            callKey: 'run:0:0',
            outcome: {
              state: 'completed',
              effect: 'write',
              isError: false,
              source: null,
              output: 'done',
              reversibility: 'snapshotted',
              permission: { verdict: 'allow', code: 'task-grant', facts: { toolName: 'Write' } },
            },
          },
        ],
      },
    ],
  }
  const record = render()
  expect(record).toContain('session-record')
  for (const value of ['Write', '/work/a', 'snapshot-before'])
    expect(record.replace(/<[^>]*>/g, '')).toContain(value)
  expect(record).toContain('<dd>可以</dd>')
  state.data = { ...state.data, rounds: [{ ...round, canRestore: false }] }
  expect(render()).toContain('<dd>不可以</dd>')
  state.failed = true
  expect(render()).toContain('role="alert"')
  expect(render()).not.toContain('session-record')
})
