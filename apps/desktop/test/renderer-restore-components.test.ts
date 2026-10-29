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
  controller: null as Snapshots.RestoreFlow | null,
  dismiss: null as (() => void) | null,
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
      override getSnapshot = () => state.controller?.getSnapshot() ?? state.flow!
      override cancel = () => state.controller?.cancel()
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
    Dialog: ({
      children,
      open,
      onOpenChange,
    }: {
      children?: ReactNode
      open: boolean
      onOpenChange: (open: boolean) => void
    }) => {
      if (open) state.dismiss = () => onOpenChange(false)
      return open ? content({ children }) : null
    },
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
  state.controller = null
  state.dismiss = null
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

it.each(
  (['success', 'preview gone'] as const).flatMap((result) =>
    (['none', 'unavailable', 'failed'] as const).map((background) => ({ result, background })),
  ),
)(
  '05 验收 15: $result stays visible until closing refreshes away the restore link (background refresh: $background)',
  async ({ result, background }) => {
    const { RestoreFlow } = await vi.importActual<typeof Snapshots>(
      '../src/renderer/src/lib/snapshots.js',
    )
    const component = '../src/renderer/src/components/thread/RunEndCard.tsx'
    const { SummaryLine } = await import(component)
    const i18n = await createI18n('zh-CN', () => {})
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const runId = '22222222-2222-4222-8222-222222222222'
    const round = {
      roundRunId: runId,
      runIds: [runId],
      endMessageId: null,
      calls: [],
      canRestore: true,
      incompleteCoverage: false,
      commandsWithoutSnapshot: false,
    }
    state.data = { ok: true, status: 'tree', incompleteRestores: [], rounds: [round] }
    const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>()
    invoke.mockResolvedValueOnce(
      result === 'preview gone'
        ? { ok: true, data: { ok: false, code: 'gone' } }
        : {
            ok: true,
            data: {
              ok: true,
              preview: {
                previewKey: 'key',
                restore: ['/work/file'],
                remove: [],
                conflicts: [],
                skipped: [],
              },
            },
          },
    )
    invoke.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: true,
        undoSnapshotId: 'undo',
        restored: 1,
        removed: 0,
        kept: 0,
        skipped: 0,
        failed: [],
      },
    })
    // Model the provider refresh after the restore/retention change. The real controller drives
    // the real SummaryLine + RestoreLink; portal dismissal invokes their onOpenChange callback.
    const refresh = vi.fn<() => void>(() => {
      state.data = {
        ok: true,
        status: 'tree',
        incompleteRestores: [],
        rounds: [{ ...round, canRestore: false }],
      }
    })
    const flow = new RestoreFlow({ invoke }, sessionId, refresh)
    state.controller = flow
    vi.stubGlobal('window', { tenon: { invoke } })
    const render = () =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(SummaryLine, {
            summary: background === 'none' ? { write: 1 } : null,
            runId,
          }),
        ),
      )
    await flow.open(runId)
    if (result === 'success') await flow.confirm()
    // Focus and timer refreshes may also observe the now-empty list while this dialog is open.
    if (background === 'unavailable')
      state.data = { ...state.data, rounds: [{ ...round, canRestore: false }] }
    else if (background === 'failed') state.data = null
    const html = render()
    expect(html).toContain(result === 'success' ? '已还原 1 个' : i18n.t('snapshot.error.gone'))
    expect(html).toContain('关闭')
    expect(refresh).not.toHaveBeenCalled()
    expect(state.dismiss).not.toBeNull()
    state.dismiss!()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(state.data?.rounds[0]?.canRestore).toBe(false)
    expect(render()).not.toContain('可还原')
    expect(render()).not.toContain('关闭')
    flow.cancel()
    expect(refresh).toHaveBeenCalledTimes(1)
  },
)
