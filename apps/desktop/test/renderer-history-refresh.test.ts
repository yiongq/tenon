/** SSR harness retains ChatProvider state between refreshes, as the mounted session does. */
import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import type * as React from 'react'
import type * as Snapshots from '../src/renderer/src/lib/snapshots.js'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { createI18n } from '../src/i18n/create-instance.js'
import type { Rounds, RestoreFlow } from '../src/renderer/src/lib/snapshots.js'
import type { ThreadModel } from '../src/renderer/src/runtime/thread-model.js'
import { threadFromRows } from '../src/renderer/src/runtime/thread-model.js'
import { SnapshotRefresh } from '../src/renderer/src/runtime/snapshot-refresh.js'

const state = vi.hoisted(() => ({
  sessionId: '11111111-1111-4111-8111-111111111111',
  data: null as Rounds | null,
  model: null as ThreadModel | null,
  messages: [] as ThreadMessageLike[],
  provider: false,
  index: 0,
  slots: [] as unknown[],
  effects: [] as React.EffectCallback[],
  flow: null as RestoreFlow | null,
}))
vi.mock('react', async (original) => {
  const actual = await original<typeof React>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (!state.provider) return actual.useState(initial)
      const slot = state.index++
      if (!(slot in state.slots)) state.slots[slot] = initial
      return [
        state.slots[slot],
        (next: unknown) => {
          state.slots[slot] = typeof next === 'function' ? next(state.slots[slot]) : next
        },
      ]
    },
    useEffect: (effect: React.EffectCallback, deps: React.DependencyList) => {
      if (state.provider) state.effects.push(effect)
      else actual.useEffect(effect, deps)
    },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  }
})
vi.mock('@assistant-ui/react', () => ({
  useExternalStoreRuntime: ({ messages }: { messages: ThreadMessageLike[] }) => {
    state.messages = messages
    state.provider = false
    return {}
  },
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => children,
  useAuiState: () => state.messages.find((message) => message.id === 'end')?.metadata?.custom,
}))
vi.mock('../src/renderer/src/runtime/SnapshotProvider', () => ({
  useSnapshotRounds: () => ({
    sessionId: state.sessionId,
    data: state.data,
    refresh: async () => state.data,
  }),
}))
vi.mock('../src/renderer/src/runtime/session-store', () => ({
  SessionStore: class {
    getSnapshot = () => ({ model: state.model, running: false })
    subscribe = () => () => {}
    attach = () => () => {}
    open = async () => {}
    setCanSend = () => {}
    sendBlock = () => null
  },
}))
vi.mock('../src/renderer/src/lib/snapshots', async (original) => {
  const actual = await original<typeof Snapshots>()
  return {
    ...actual,
    readHistoryModel: async () => state.model,
    // SSR has no mounted memo cache. Retain the real flow across these renders.
    RestoreFlow: class extends actual.RestoreFlow {
      constructor(...args: ConstructorParameters<typeof actual.RestoreFlow>) {
        super(...args)
        state.flow ??= this
        return state.flow
      }
    },
  }
})
function content({ children }: { children?: ReactNode }) {
  return createElement('div', null, children)
}
vi.mock('../src/renderer/src/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open: boolean }) =>
    open ? createElement('div', { role: 'dialog' }, children) : null,
  DialogContent: content,
  DialogTitle: content,
  DialogDescription: content,
  DialogFooter: content,
}))
const runId = '22222222-2222-4222-8222-222222222222'
const data: Rounds = {
  ok: true,
  status: 'tree',
  incompleteRestores: [],
  rounds: [
    {
      roundRunId: runId,
      runIds: [runId],
      endMessageId: 'end',
      calls: [],
      canRestore: true,
      incompleteCoverage: false,
      commandsWithoutSnapshot: false,
    },
  ],
}
async function harness() {
  const provider = '../src/renderer/src/runtime/ChatProvider.tsx'
  const component = '../src/renderer/src/components/thread/RunEndCard.tsx'
  const { ChatProvider } = await import(provider)
  const { RunEndCard } = await import(component)
  const i18n = await createI18n('zh-CN', () => {})
  const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>()
  vi.stubGlobal('window', { tenon: { invoke }, addEventListener() {}, removeEventListener() {} })
  const base = {
    sessionId: state.sessionId,
    role: 'assistant' as const,
    status: 'complete' as const,
    createdAt: 0,
    updatedAt: 0,
  }
  state.model = threadFromRows([
    {
      ...base,
      messageId: 'tools',
      orderSeq: 1,
      entryId: 1,
      content: [{ type: 'tool-request', id: 'write', name: 'Write', input: { file_path: '/f' } }],
      calls: [
        {
          callKey: `${runId}:0:0`,
          outcome: {
            state: 'completed',
            isError: false,
            effect: 'write',
            source: null,
            output: 'ok',
          },
        },
      ],
    },
    {
      ...base,
      messageId: 'end',
      orderSeq: 2,
      entryId: 2,
      content: [{ type: 'text', text: 'done' }],
    },
  ])
  function Provider() {
    state.index = 0
    state.provider = true
    return ChatProvider({ sessionId: state.sessionId, children: createElement(RunEndCard) })
  }
  const cleanups: (() => void)[] = []
  const render = async () => {
    const html = renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(Provider)),
    )
    for (const effect of state.effects.splice(0)) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
    }
    await Promise.resolve()
    return html
  }
  const refresh = new SnapshotRefresh({ invoke }, state.sessionId, (next) => {
    state.data = next
  })
  return {
    invoke,
    refresh,
    render,
    close: () => {
      refresh.dispose()
      cleanups.forEach((cleanup) => cleanup())
    },
  }
}
afterEach(() => {
  state.provider = false
  state.data = null
  state.flow = null
  state.slots = []
  state.effects = []
  vi.unstubAllGlobals()
})

it('05 验收 18 复现: a historical settlement and its open restore dialog survive a failed background refresh', async () => {
  const h = await harness()
  try {
    h.invoke.mockResolvedValueOnce({ ok: true, data })
    await h.refresh.refresh()
    await h.render()
    expect(await h.render()).toContain('turn-summary')
    h.invoke.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: true,
        preview: { previewKey: 'key', restore: ['/f'], remove: [], conflicts: [], skipped: [] },
      },
    })
    await state.flow!.open(runId)
    expect(await h.render()).toContain('role="dialog"')
    h.invoke.mockRejectedValueOnce(new Error('offline'))
    expect(await h.refresh.refresh()).toBeNull()
    expect(state.data).toBeNull()
    const failed = await h.render()
    expect(failed).toContain('turn-summary')
    expect(failed).toContain('role="dialog"')
    expect(failed).toContain('确认还原')
    h.invoke.mockResolvedValueOnce({
      ok: true,
      data: {
        ...data,
        rounds: [{ ...data.rounds[0]!, canRestore: false, commandsWithoutSnapshot: true }],
      },
    })
    await h.refresh.refresh()
    const recovered = await h.render()
    expect(recovered).toContain('turn-summary')
    expect(recovered).toContain('role="dialog"')
    expect(recovered).not.toContain('可还原')
    expect(recovered).toContain('命令的改动可能无法还原')
    state.flow!.cancel()
    expect(await h.render()).not.toContain('role="dialog"')
    h.invoke.mockResolvedValueOnce({ ok: true, data: { ...data, rounds: [] } })
    await h.refresh.refresh()
    expect(await h.render()).not.toContain('turn-summary')
    h.invoke.mockRejectedValueOnce(new Error('offline again'))
    await h.refresh.refresh()
    expect(await h.render()).not.toContain('turn-summary')
  } finally {
    h.close()
  }
})

it('05 验收 18: switching sessions never reuses historical rounds; first-load failure stays empty', async () => {
  const h = await harness()
  try {
    h.invoke.mockRejectedValueOnce(new Error('offline'))
    await h.refresh.refresh()
    await h.render()
    expect(await h.render()).not.toContain('turn-summary')
    h.invoke.mockResolvedValueOnce({ ok: true, data })
    await h.refresh.refresh()
    await h.render()
    expect(await h.render()).toContain('turn-summary')
    // Keep the provider's hook state to exercise its session guard too. App normally remounts it.
    const previousSession = state.sessionId
    state.sessionId = '33333333-3333-4333-8333-333333333333'
    state.data = null
    const next = new SnapshotRefresh({ invoke: h.invoke }, state.sessionId, (value) => {
      state.data = value
    })
    try {
      h.invoke.mockRejectedValueOnce(new Error('new session offline'))
      await next.refresh()
      expect(await h.render()).not.toContain('turn-summary')
      expect(await h.render()).not.toContain('turn-summary')
      expect(
        state.messages.find((message) => message.id === 'end')?.metadata?.custom,
      ).not.toHaveProperty('historicalSummary')
      const nextRun = '44444444-4444-4444-8444-444444444444'
      h.invoke.mockResolvedValueOnce({
        ok: true,
        data: {
          ...data,
          rounds: [{ ...data.rounds[0]!, roundRunId: nextRun, runIds: [nextRun] }],
        },
      })
      await next.refresh()
      await h.render()
      expect(await h.render()).toContain('可还原')
      expect(
        state.messages.find((message) => message.id === 'end')?.metadata?.custom,
      ).toHaveProperty('historicalSummary.runId', nextRun)
    } finally {
      next.dispose()
      state.sessionId = previousSession
    }
  } finally {
    h.close()
  }
})
