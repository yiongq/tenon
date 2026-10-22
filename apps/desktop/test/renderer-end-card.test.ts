/**
 * What each Run end shows (spec 02 §失败卡与结束原因, the table at spec.md:2805; plan step 20, 旧 221).
 * The table below is the spec's, row by row, written without looking at the switch: 中性 = neutral,
 * 红 = danger, 琥珀 = warning; 「继续」 = continue, 「重试」 = retry, 「去设置」 = settings, 复制诊断信息 =
 * copy. Every end code the contract has must be in it exactly once.
 */
import { providerErrorCodeSchema, runEndReasonSchema } from '@tenon-app/contracts'
import type { ProviderEntryContract, RunEndReasonContract } from '@tenon-app/contracts'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  aggregateDone,
  cardOf,
  effectLineOf,
  providerErrorKey,
} from '../src/renderer/src/lib/end-card.js'

type Code = RunEndReasonContract['code']
type Row = { readonly visual: string; readonly action: string } | null

/** One valid member per code: the rows are checked against real contract values. */
const SAMPLE: { readonly [C in Code]: Extract<RunEndReasonContract, { code: C }> } = {
  completed: { code: 'completed' },
  paused: { code: 'paused', waitingFor: 'approval' },
  'step-limit': { code: 'step-limit', limit: 100 },
  'output-truncated': { code: 'output-truncated', maxTokens: 1024 },
  'user-stopped': { code: 'user-stopped' },
  'shutdown-aborted': { code: 'shutdown-aborted', trigger: 'quit' },
  'user-rejected': { code: 'user-rejected', toolName: 'Write' },
  'usage-limit': { code: 'usage-limit', tokenLimit: 200_000 },
  recovered: { code: 'recovered' },
  'time-limit': { code: 'time-limit', limitMs: 600_000 },
  'blocked-repeatedly': { code: 'blocked-repeatedly', count: 3 },
  'provider-error': {
    code: 'provider-error',
    providerId: 'anthropic',
    errorCode: 'server',
    providerReason: null,
    attempts: 3,
  },
  refusal: { code: 'refusal', providerId: 'anthropic', modelId: 'claude-x' },
  'content-filter': { code: 'content-filter', providerId: 'zhipu' },
  'context-overflow': { code: 'context-overflow', compactions: 1 },
  'no-progress': { code: 'no-progress', repeats: 4 },
  'quota-exhausted': { code: 'quota-exhausted', providerId: 'zhipu', resetAt: null },
  'account-config': { code: 'account-config', providerId: 'anthropic' },
}

const NEUTRAL_CONTINUE: Row = { visual: 'neutral', action: 'continue' }
const NEUTRAL_COPY: Row = { visual: 'neutral', action: 'copy' }
const DANGER_COPY: Row = { visual: 'danger', action: 'copy' }

/** Every row of the spec's table whose answer does not depend on the Run (all but provider-error). */
const TABLE: ReadonlyArray<readonly [codes: readonly Exclude<Code, 'provider-error'>[], row: Row]> =
  [
    // `completed`: only the summary line; `paused`: no card, the card or the question is in view.
    [['completed'], null],
    [['paused'], null],
    [['user-rejected'], null],
    [['step-limit', 'output-truncated'], NEUTRAL_CONTINUE],
    [['user-stopped', 'shutdown-aborted', 'usage-limit', 'recovered', 'time-limit'], NEUTRAL_COPY],
    [['blocked-repeatedly'], { visual: 'warning', action: 'copy' }],
    [
      [
        'refusal',
        'content-filter',
        'context-overflow',
        'no-progress',
        'quota-exhausted',
        'account-config',
      ],
      DANGER_COPY,
    ],
  ]

describe('cardOf (§失败卡与结束原因)', () => {
  it('has a row for every end code of the contract, and only those', () => {
    const contract = runEndReasonSchema.options.map((option) => option.shape.code.value).toSorted()
    const table = [...TABLE.flatMap(([codes]) => codes), 'provider-error'].toSorted()
    expect(table).toEqual(contract)
    expect(contract).toHaveLength(18)
    for (const reason of Object.values(SAMPLE)) runEndReasonSchema.parse(reason)
  })

  for (const [codes, row] of TABLE) {
    for (const code of codes) {
      it(`${code} → ${row === null ? 'no card' : `${row.visual} / ${row.action}`}, whatever the Run`, () => {
        // Only a provider error looks at whether the Run could be resent.
        expect(cardOf(SAMPLE[code], true)).toEqual(row)
        expect(cardOf(SAMPLE[code], false)).toEqual(row)
      })
    }
  }

  it('provider-error with errorCode auth → danger / settings, even when the Run could be resent', () => {
    const auth = { ...SAMPLE['provider-error'], errorCode: 'auth' as const }
    expect(cardOf(auth, true)).toEqual({ visual: 'danger', action: 'settings' })
    expect(cardOf(auth, false)).toEqual({ visual: 'danger', action: 'settings' })
  })

  it('any other provider-error → danger / retry when the Run can be resent, else copy', () => {
    const others = [...providerErrorCodeSchema.options.filter((code) => code !== 'auth'), null]
    expect(others).toHaveLength(providerErrorCodeSchema.options.length)
    for (const errorCode of others) {
      const reason = { ...SAMPLE['provider-error'], errorCode }
      expect([errorCode, cardOf(reason, true)]).toEqual([
        errorCode,
        { visual: 'danger', action: 'retry' },
      ])
      expect([errorCode, cardOf(reason, false)]).toEqual([errorCode, DANGER_COPY])
    }
  })
})

describe('② of the card: where each call of the round goes (§失败卡与结束原因, §点停止时各状态怎么收)', () => {
  it('a stopped command wrote nothing after it; a stopped request may have reached the other side', () => {
    // 旧 7's interface half: Bash's effect is `external`, but only a command whose `exited` came in
    // the window is `aborted`, so 「后续写入未发生」 is written for it and for nothing still running.
    expect(effectLineOf('Bash', { state: 'aborted', effect: 'external' })).toBe('stopped')
    expect(effectLineOf('Bash', { state: 'uncertain', effect: 'external' })).toBe('uncertain')
    expect(effectLineOf('Write', { state: 'aborted', effect: 'write' })).toBe('stopped')
    expect(effectLineOf('Read', { state: 'aborted', effect: 'read' })).toBe('stopped')
    // WebSearch / WebFetch in flight: 请求可能已到对方，不写「未发生」; a connector's tool the same.
    for (const name of ['WebFetch', 'WebSearch', 'mcp__everything__echo']) {
      expect([name, effectLineOf(name, { state: 'aborted', effect: 'external' })]).toEqual([
        name,
        'stopped-sent',
      ])
    }
    expect(effectLineOf('Bash', { state: 'completed', effect: 'external' })).toBe('done')
    expect(effectLineOf('Bash', { state: 'not-run', effect: 'blocked' })).toBe('not-run')
  })
})

it('presentation-r1 验收 4: user-rejected shows no failure card', () => {
  expect(cardOf(SAMPLE['user-rejected'], false)).toBeNull()
  expect(cardOf(SAMPLE['user-rejected'], true)).toBeNull()
})

// Render the real card with translations; only the conversation boundary is supplied by the test.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18n } from 'i18next'
import { createI18n } from '../src/i18n/create-instance.js'
const component = '../src/renderer/src/components/thread/RunEndCard.tsx'
let RunEndCard: () => ReturnType<typeof createElement> | null
let slotsOf: (
  reason: RunEndReasonContract,
  locale: string,
  t: I18n['t'],
  providers: readonly ProviderEntryContract[],
) => Record<string, unknown>
import type { ToolPart, RunEnd } from '../src/renderer/src/runtime/thread-model.js'

const context = vi.hoisted(() => ({
  end: null as RunEnd | null,
  parts: [] as ToolPart[],
}))
vi.mock('@assistant-ui/react', () => ({
  useAuiState: () => ({ turnId: 'end', end: context.end }),
}))
vi.mock('../src/renderer/src/runtime/ChatProvider', () => ({
  useSessionStore: () => ({}),
  useSessionSnapshot: () => ({
    model: {
      turns: [
        { id: 'user', role: 'user', parts: [] },
        { id: 'end', role: 'assistant', parts: context.parts },
      ],
    },
    running: false,
    queue: [],
    held: null,
  }),
}))
vi.mock('../src/renderer/src/runtime/conversation', () => ({
  useConversation: () => ({ sessionId: 'session' }),
}))
vi.mock('../src/renderer/src/components/settings/SettingsModal', () => ({
  SettingsModal: () => null,
}))
let zh: I18n
let en: I18n
beforeAll(async () => {
  ;({ RunEndCard, slotsOf } = await import(component))
  ;[zh, en] = await Promise.all([createI18n('zh-CN', () => {}), createI18n('en', () => {})])
})

function renderEnd(reason: RunEndReasonContract | null, parts: ToolPart[] = [], i18n = zh): string {
  context.end = {
    runId: 'run',
    retryOf: null,
    endReason: reason,
    errorCode: reason === null ? 'auth' : null,
  }
  context.parts = parts
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(RunEndCard)))
}
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
}
function read(path: string, n: number, name = 'Read'): ToolPart {
  return {
    kind: 'tool',
    callKey: `call-${n}`,
    name,
    input: { file_path: path, limit: n },
    run: null,
    outcome: { state: 'completed', effect: 'read', source: null, output: '' },
  }
}

it('presentation-r1 验收 8: one sentence per errorCode; 401 and 400 differ', () => {
  const sentences = {
    auth: '模型服务 的 API 密钥无效或没有填。',
    'rate-limit': '模型服务 现在请求太多，稍后再试。',
    overloaded: '模型服务 的服务正忙，稍后再试。',
    network: '连不上 模型服务，请检查网络。',
    'egress-denied': '这次请求不允许发往 模型服务。',
    'invalid-request': '模型服务 拒绝了这次请求。',
    server: '模型服务 的服务出错了。',
    'context-overflow': '对话太长，模型服务 接不下了。',
    'quota-exhausted': '模型服务 的额度或花费上限已用尽。',
    'account-config': '你的 模型服务 账号或组织设置不满足这次请求。',
    unknown: '模型服务 出错了。',
  }
  const english = {
    auth: 'The API key for the model service is missing or not valid.',
    'rate-limit': 'the model service is getting too many requests. Try again shortly.',
    overloaded: 'the model service is busy right now. Try again shortly.',
    network: 'Can’t reach the model service. Check your connection.',
    'egress-denied': 'This request isn’t allowed to go to the model service.',
    'invalid-request': 'the model service turned down this request.',
    server: 'the model service had a server error.',
    'context-overflow': 'The conversation is too long for the model service.',
    'quota-exhausted': 'The quota or spending limit on the model service is used up.',
    'account-config':
      'The account or organization on the model service is not set up for this request.',
    unknown: 'the model service ran into an error.',
  }
  for (const errorCode of providerErrorCodeSchema.options) {
    const englishHtml = renderEnd({ ...SAMPLE['provider-error'], errorCode, attempts: 1 }, [], en)
    expect(
      textOf(englishHtml.match(/<p data-testid="failure-what"[^>]*>(.*?)<\/p>/s)?.[1] ?? ''),
    ).toBe(english[errorCode])
    const html = renderEnd({ ...SAMPLE['provider-error'], errorCode, attempts: 1 })
    expect(textOf(html.match(/<p data-testid="failure-what"[^>]*>(.*?)<\/p>/s)?.[1] ?? '')).toBe(
      sentences[errorCode],
    )
    expect(html).not.toContain('anthropic')
    expect(html).toContain(`data-action="${errorCode === 'auth' ? 'settings' : 'copy'}"`)
  }
  expect(providerErrorKey(null)).toBe('runEnd.provider-error.unknown')
  expect(
    textOf(renderEnd({ ...SAMPLE['provider-error'], errorCode: null, attempts: 3 })),
  ).toContain('模型服务 出错了。已试 3 次。')
  expect(textOf(renderEnd({ ...SAMPLE['provider-error'], attempts: 3 }, [], en))).toContain(
    'the model service had a server error. Tried 3 times.',
  )
  const message = renderEnd(null)
  expect(textOf(message)).toBe('API 密钥无效或没有填。去设置')
  expect(message).toContain('data-testid="message-settings"')
  expect(message).not.toContain('message-retry')
})

it('presentation-r1 验收 8: provider and model slots come from display names, with only their own fields added', () => {
  const entry: ProviderEntryContract = {
    id: 'anthropic',
    nameKey: 'provider.anthropic.name',
    configKeys: [],
    configured: true,
    endpoint: { host: 'api.anthropic.com', reach: 'public' },
    models: [{ id: 'claude-x', nameKey: 'model.name.opus55', listing: 'main', mark: 'verified' }],
  }
  const slots = slotsOf(SAMPLE.refusal, 'zh-CN', zh.t, [entry])
  expect(slots).toEqual({
    providerId: 'anthropic',
    modelId: 'claude-x',
    provider: 'Anthropic',
    model: 'Opus 5.5',
  })
  expect(zh.t('runEnd.refusal', slots)).toBe('Anthropic 的 Opus 5.5 拒绝回答。')
  expect(
    slotsOf(SAMPLE.refusal, 'en', en.t, [{ ...entry, displayName: 'My provider' }]),
  ).toMatchObject({ provider: 'My provider' })
  expect(slotsOf(SAMPLE.refusal, 'en', en.t, [])).toMatchObject({
    provider: 'the model service',
    model: 'claude-x',
  })
  expect(slotsOf(SAMPLE['step-limit'], 'en', en.t, [entry])).toEqual({ limit: 100 })
  expect(slotsOf(SAMPLE['quota-exhausted'], 'en', en.t, [])).toEqual({
    providerId: 'zhipu',
    provider: 'the model service',
    resetAt: 'unknown',
  })
})

it('presentation-r1 验收 8: aggregates 100 reads of a.txt into one line ×100; same name, different paths stay apart in full; over five groups the rest fold', () => {
  const hundred = Array.from({ length: 100 }, (_, n) => read('/work/a.txt', n))
  expect(
    aggregateDone(hundred).visible.map(({ count, object, fullObject }) => ({
      count,
      object,
      fullObject,
    })),
  ).toEqual([{ count: 100, object: 'a.txt', fullObject: '/work/a.txt' }])
  const html = renderEnd(SAMPLE['step-limit'], hundred)
  expect(textOf(html)).toContain('读取 a.txt ×100')
  expect(html).toContain('aria-label="读取 /work/a.txt ×100"')
  expect(html.match(/<li>/g)).toHaveLength(1)
  const parts = [
    hundred[0]!,
    read('/other/a.txt', 101),
    read('/work/a.txt', 102, 'Write'),
    ...['b', 'c', 'd', 'e'].map((file, i) => read(`/work/${file}.txt`, 103 + i)),
  ]
  const groups = aggregateDone(parts)
  expect(groups.visible.map((g) => [g.part.name, g.object, g.count])).toEqual([
    ['Read', '/work/a.txt', 1],
    ['Read', '/other/a.txt', 1],
    ['Write', '/work/a.txt', 1],
    ['Read', 'b.txt', 1],
    ['Read', 'c.txt', 1],
  ])
  expect(groups.folded.map((g) => g.object)).toEqual(['d.txt', 'e.txt'])
  const folded = renderEnd(SAMPLE['step-limit'], parts)
  expect(textOf(folded)).toContain('展开全部（7 项）')
  expect(folded).toMatch(/<details data-testid="failure-effects-more"><summary/)
  expect(folded).not.toContain('<details open')
  expect(aggregateDone([])).toEqual({ visible: [], folded: [] })
  for (const [name, input, object] of [
    ['Bash', { command: 'echo hello world' }, 'echo hello world'],
    ['WebFetch', { url: 'https://example.com/a/b' }, 'https://example.com/a/b'],
    ['WebSearch', { query: 'a long search' }, 'a long search'],
  ] as const) {
    expect(aggregateDone([{ ...hundred[0]!, name, input }]).visible[0]?.object).toBe(object)
  }
})
