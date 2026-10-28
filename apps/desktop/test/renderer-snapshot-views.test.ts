import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { createI18n } from '../src/i18n/create-instance.js'
import type { Rounds } from '../src/renderer/src/lib/snapshots.js'
import type { TurnCustom } from '../src/renderer/src/runtime/to-thread-messages.js'
import type { ThreadModel } from '../src/renderer/src/runtime/thread-model.js'

const state = vi.hoisted(() => ({ data: null as Rounds | null, custom: {} as TurnCustom }))
vi.mock('@assistant-ui/react', () => ({ useAuiState: () => state.custom }))
vi.mock('../src/renderer/src/runtime/SnapshotProvider', () => ({
  useSnapshotRounds: () => ({
    sessionId: 'session',
    data: state.data,
    refresh: async () => state.data,
  }),
}))
vi.mock('../src/renderer/src/runtime/ChatProvider', () => ({
  useSessionStore: () => ({}),
  useSessionSnapshot: () => ({ model: { turns: [{ end: state.custom.end }] } }),
}))
vi.mock('../src/renderer/src/runtime/conversation', () => ({
  useConversation: () => ({ sessionId: 'session' }),
}))
beforeAll(() => {
  vi.stubGlobal('window', { tenon: {} })
})
afterAll(() => vi.unstubAllGlobals())
const component = '../src/renderer/src/components/thread/RunEndCard.tsx'

it('05 验收 33: a settled round with snapshots offers restore even when every file call failed; retention removes it', async () => {
  const { RunEndCard } = await import(component)
  const i18n = await createI18n('zh-CN', () => {})
  state.custom = {
    turnId: 'end',
    end: { runId: 'resume', endReason: { code: 'completed' }, errorCode: null, retryOf: null },
  }
  state.data = {
    ok: true,
    status: 'tree',
    incompleteRestores: [],
    rounds: [
      {
        roundRunId: 'root',
        runIds: ['root', 'resume'],
        endMessageId: null,
        calls: [],
        canRestore: true,
        incompleteCoverage: false,
        commandsWithoutSnapshot: false,
      },
    ],
  }
  const render = () =>
    renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(RunEndCard)))
  expect(render()).toContain('可还原')
  state.data = {
    ...state.data,
    rounds: [{ ...state.data.rounds[0]!, incompleteCoverage: true, commandsWithoutSnapshot: true }],
  }
  expect(render()).toContain('可还原（不含被排除的文件）')
  expect(render()).toContain('命令的改动可能无法还原')
  state.data = {
    ...state.data,
    rounds: [{ ...state.data.rounds[0]!, canRestore: false, commandsWithoutSnapshot: false }],
  }
  expect(render()).not.toContain('turn-summary')
  state.data = { ...state.data, rounds: [{ ...state.data.rounds[0]!, canRestore: true }] }
  state.custom = {
    ...state.custom,
    end: { ...state.custom.end!, endReason: { code: 'paused', waitingFor: 'approval' } },
  }
  expect(render()).not.toContain('可还原')
})

// D63 starts with persisted rows only: no synthetic live events or RunEnd metadata.
async function historyFixture() {
  const { threadFromRows } = await import('../src/renderer/src/runtime/thread-model.js')
  const base = {
    sessionId: 'session',
    orderSeq: 1,
    entryId: 1,
    createdAt: 0,
    updatedAt: 0,
    role: 'assistant' as const,
    status: 'complete' as const,
  }
  const success = {
    state: 'completed' as const,
    isError: false,
    effect: 'write' as const,
    source: null,
    output: 'ok',
  }
  const rows = [
    {
      ...base,
      messageId: 'tools',
      content: [
        {
          type: 'tool-request' as const,
          id: 'write',
          name: 'Write',
          input: { file_path: '/root.txt' },
        },
        { type: 'tool-request' as const, id: 'agent', name: 'Agent', input: {} },
      ],
      calls: [
        { callKey: 'root:0:0', outcome: success },
        {
          callKey: 'resume:0:0',
          outcome: {
            ...success,
            handoff: {
              outcome: 'completed' as const,
              childEndReason: 'completed',
              childSessionId: 'child',
              finalReply: 'done',
            },
          },
        },
      ],
    },
    {
      ...base,
      messageId: 'text-end',
      orderSeq: 2,
      entryId: 2,
      content: [{ type: 'text' as const, text: 'Text-only resumed reply' }],
    },
    {
      ...base,
      messageId: 'next-round',
      orderSeq: 3,
      entryId: 3,
      content: [
        {
          type: 'tool-request' as const,
          id: 'other',
          name: 'Write',
          input: { file_path: '/other.txt' },
        },
      ],
      calls: [{ callKey: 'other:0:0', outcome: success }],
    },
  ]
  const child = threadFromRows([
    {
      ...base,
      sessionId: 'child',
      messageId: 'child-end',
      content: [
        {
          type: 'tool-request',
          id: 'child-write',
          name: 'Write',
          input: { file_path: '/child.txt' },
        },
        {
          type: 'tool-request',
          id: 'child-delete',
          name: 'Delete',
          input: { file_path: '/deleted.txt' },
        },
        {
          type: 'tool-request',
          id: 'failed-write',
          name: 'Write',
          input: { file_path: '/failed.txt' },
        },
      ],
      calls: [
        { callKey: 'child:0:0', outcome: success },
        { callKey: 'child:0:1', outcome: success },
        { callKey: 'child:0:2', outcome: { ...success, isError: true } },
      ],
    },
  ])
  const model = { ...threadFromRows(rows), childSessions: new Map([['child', child.turns]]) }
  const data: Rounds = {
    ok: true,
    status: 'tree',
    incompleteRestores: [],
    rounds: [
      {
        roundRunId: 'root',
        runIds: ['root', 'resume'],
        endMessageId: 'text-end',
        calls: [{ callKey: 'root:0:0', snapshotId: 'before' }],
        canRestore: true,
        incompleteCoverage: true,
        commandsWithoutSnapshot: true,
      },
    ],
  }
  return { model, data }
}

async function renderHistory(model: ThreadModel, data: Rounds | null) {
  const { toThreadMessages } = await import('../src/renderer/src/runtime/to-thread-messages.js')
  const { RunEndCard } = await import(component)
  const i18n = await createI18n('zh-CN', () => {})
  state.data = data
  return toThreadMessages(model, data?.rounds).map((message) => {
    state.custom = message.metadata!.custom as unknown as TurnCustom
    return {
      id: message.id,
      html: renderToStaticMarkup(
        createElement(I18nextProvider, { i18n }, createElement(RunEndCard)),
      ),
    }
  })
}

it('05 验收 33: restored rows place history settlement under the kernel text-only ending, count its child calls, and refresh retention', async () => {
  const { model, data } = await historyFixture()
  const rendered = await renderHistory(model, data)
  expect(
    rendered.filter((item) => item.html.includes('turn-summary')).map((item) => item.id),
  ).toEqual(['text-end'])
  const html = rendered.find((item) => item.id === 'text-end')!.html
  expect(html).toContain('改了 2 个文件')
  expect(html).toContain('删了 1 个文件')
  expect(html).toContain('可还原（不含被排除的文件）')
  expect(html).toContain('命令的改动可能无法还原')
  const collected = await renderHistory(model, {
    ...data,
    rounds: [{ ...data.rounds[0]!, canRestore: false }],
  })
  expect(collected.find((item) => item.id === 'text-end')!.html).toContain('改了 2 个文件')
  expect(collected.some((item) => item.html.includes('可还原'))).toBe(false)
})

it('05 验收 33: null endings and chat history never receive a settlement', async () => {
  const { model, data } = await historyFixture()
  expect(
    (
      await renderHistory(model, { ...data, rounds: [{ ...data.rounds[0]!, endMessageId: null }] })
    ).every((item) => item.html === ''),
  ).toBe(true)
  expect((await renderHistory(model, null)).every((item) => item.html === '')).toBe(true)
})

it('05 验收 33: a live settlement is not duplicated when snapshot rounds later supplies its history anchor', async () => {
  const { model, data } = await historyFixture()
  const turns = [...model.turns]
  const index = turns.findIndex((turn) => turn.id === 'text-end')
  turns[index] = {
    ...turns[index]!,
    runId: 'resume',
    end: {
      runId: 'resume',
      endReason: { code: 'completed' },
      errorCode: null,
      retryOf: null,
    },
  }
  const live = { ...model, turns }
  const { toThreadMessages } = await import('../src/renderer/src/runtime/to-thread-messages.js')
  const before = toThreadMessages(live)
  const after = toThreadMessages(live, data.rounds)
  expect(after).toEqual(before)
  expect(
    after.filter(
      (message) => (message.metadata!.custom as unknown as TurnCustom).summary !== undefined,
    ),
  ).toHaveLength(1)
  expect(
    (await renderHistory(live, data))
      .filter((item) => item.html.includes('turn-summary'))
      .map((item) => item.id),
  ).toEqual(['text-end'])
})
