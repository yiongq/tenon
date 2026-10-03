/**
 * The custom vendor decisions the interface makes (M6 plan step 9), against the pure functions the
 * settings card and the model menu call (lib/custom-vendor.ts): which pay-as-you-go reminder a key
 * field carries (§地址校验, Q13; 验收 7), which rows a task can send with and what each row's second
 * line says (§运行时「行标记、菜单与任务形态」; Q6), when a session's instance reads as removed
 * (§实例被删或改坏, T12), what a probe's stored result says (§结果与原因码), and what a typed model
 * row sends (§列表与上限, T6).
 */
import {
  customVendorErrorCodeSchema,
  customVendorUpdate,
  probeReasonSchema,
  providerModelSchema,
  providerRefusalSchema,
  providerWriteErrorCodeSchema,
} from '@tenon-app/contracts'
import type { CustomVendorContract, ProviderEntryContract } from '@tenon-app/contracts'
import { describe, expect, it } from 'vitest'
import { resources } from '../src/i18n/resources.js'
import type { Locale } from '../src/i18n/resources.js'
import { vendorPresets } from '../src/main/custom-vendors/presets.js'
import {
  FETCH_MODELS_KEY,
  KEY_REMINDER_KEY,
  PROBE_REASON_KEY,
  PROBE_REFUSED_KEY,
  VENDOR_ERROR_KEY,
  customVendorGone,
  draftOf,
  holdsTools,
  keyReminderOf,
  markLineKey,
  probeLineOf,
  rowOf,
  withRow,
  withoutRow,
} from '../src/renderer/src/lib/custom-vendor.js'
import type { ProbeReason, ProbeSnapshot } from '../src/renderer/src/lib/custom-vendor.js'
import { PROVIDER_WRITE_ERROR_KEY, REFUSAL_KEY } from '../src/renderer/src/lib/provider-copy.js'

/** Against the raw bundles, as the catalogue tests read them. */
function text(locale: Locale, key: string): string {
  let node: unknown = resources[locale].common
  for (const segment of key.split('.')) node = (node as Record<string, unknown>)[segment]
  if (typeof node !== 'string') throw new Error(`${locale}: ${key} is not a string`)
  return node
}

const INSTANCE = 'custom-0b5c2f4e-8a1d-4c3b-9e7f-2a6d8c0e4f11'
const OTHER_INSTANCE = 'custom-7f3e9a2b-1c4d-4e5f-8a6b-9c0d1e2f3a4b'

describe('验收 7: the pay-as-you-go reminder under a key field, by host', () => {
  it('reminds of the GLM Coding Plan on open.bigmodel.cn and api.z.ai', () => {
    for (const address of [
      'https://open.bigmodel.cn/api/paas/v4',
      'https://open.bigmodel.cn/api/anthropic',
      'https://api.z.ai/api/paas/v4',
      'https://OPEN.BIGMODEL.CN/api/anthropic',
      ' https://api.z.ai/api/anthropic ',
    ]) {
      expect([address, keyReminderOf(address)]).toEqual([address, 'zhipu'])
    }
  })

  it('reminds of the Interface Key page on api.minimax.cn, api.minimax.io and api.minimaxi.com', () => {
    for (const address of [
      'https://api.minimax.cn/v1',
      'https://api.minimax.io/anthropic',
      'https://api.minimaxi.com/anthropic',
    ]) {
      expect([address, keyReminderOf(address)]).toEqual([address, 'minimax'])
    }
  })

  it('says nothing for any other host, a look-alike, or an address that does not parse', () => {
    for (const address of [
      'https://api.deepseek.com',
      'https://api.moonshot.cn/v1',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'https://bigmodel.cn/api/paas/v4',
      'https://open.bigmodel.cn.example.com/v1',
      'https://relay.example/open.bigmodel.cn/v1',
      'https://minimax.io/v1',
      'https://www.api.minimax.io/v1',
      'open.bigmodel.cn/api/paas/v4',
      '',
    ]) {
      expect([address, keyReminderOf(address)]).toEqual([address, null])
    }
  })

  it('puts the reminder on exactly the presets whose hosts the spec names', () => {
    // §预设: Z.ai's one address is Zhipu's; both MiniMax regions, on either wire, are MiniMax's.
    const reminded = new Map<string, Set<string | null>>()
    for (const preset of vendorPresets()) {
      for (const region of preset.regions) {
        for (const address of Object.values(region.endpoints)) {
          if (address === undefined) continue
          const seen = reminded.get(preset.id) ?? new Set()
          seen.add(keyReminderOf(address))
          reminded.set(preset.id, seen)
        }
      }
    }
    expect(Object.fromEntries([...reminded].map(([id, seen]) => [id, [...seen]]))).toEqual({
      deepseek: [null],
      kimi: [null],
      bailian: [null],
      ark: [null],
      minimax: ['minimax'],
      zai: ['zhipu'],
    })
  })

  it('words both reminders as §地址校验 does, in both languages', () => {
    expect(text('zh-CN', KEY_REMINDER_KEY.zhipu)).toBe(
      '只能填按量付费的 key；GLM Coding Plan 的 key 不得用于 Tenon（订阅协议第六条第 2 款）',
    )
    expect(text('zh-CN', KEY_REMINDER_KEY.minimax)).toBe(
      '填『接口密钥』页的按量 key，不要填 Token Plan / M Plan 的订阅 key',
    )
    expect(text('en', KEY_REMINDER_KEY.zhipu)).toMatch(/pay-as-you-go.*GLM Coding Plan/)
    expect(text('en', KEY_REMINDER_KEY.minimax)).toMatch(/pay-as-you-go.*M Plan/)
  })
})

describe('the model menu rows (§运行时「行标记、菜单与任务形态」; Q6)', () => {
  it('lets a task send with a verified or a probed row and greys every other mark', () => {
    // ModelMenu.tsx greys a row in a task and holds 「发送」 for its model when this is false:
    // 「`verified` 与 `probed` 以外置灰」, replacing 02's 「非 `verified` 置灰」.
    const marks = providerModelSchema.shape.mark.options
    expect(Object.fromEntries(marks.map((mark) => [mark, holdsTools(mark)]))).toEqual({
      verified: true,
      probed: true,
      'local-text-only': false,
      'unverified-text-only': false,
    })
  })

  it('reads 「尚未通过探测」 for an instance row without a passing probe, 02’s line for a builtin', () => {
    expect(markLineKey('unverified-text-only', true)).toBe('model.mark.unprobed')
    expect(markLineKey('unverified-text-only', false)).toBe('model.mark.unverified')
    expect(markLineKey('probed', true)).toBe('model.mark.probed')
    expect(markLineKey('local-text-only', true)).toBe('model.mark.localTextOnly')
    expect(markLineKey('verified', false)).toBe('model.row.line')
    expect(text('zh-CN', 'model.mark.probed')).toBe('本机探测 · 不保证 · {host}')
    expect(text('zh-CN', 'model.mark.unprobed')).toBe('尚未通过探测 · 仅文字对话 · {host}')
  })
})

describe('§实例被删或改坏: a session’s instance or row reads as removed', () => {
  const listed: Pick<ProviderEntryContract, 'id' | 'models'>[] = [
    { id: 'anthropic', models: [{ id: 'claude-sonnet-5', mark: 'verified', listing: 'main' }] },
    {
      id: INSTANCE,
      models: [{ id: 'deepseek-flash', mark: 'probed', listing: 'main' }],
    },
  ]

  it('when provider.list no longer has the instance', () => {
    const choice = { providerId: OTHER_INSTANCE, modelId: 'deepseek-flash' }
    expect(customVendorGone(OTHER_INSTANCE, choice, listed)).toBe(true)
    // Whatever the session chose since: the end names the instance that is gone.
    expect(customVendorGone(OTHER_INSTANCE, null, listed)).toBe(true)
  })

  it('when the instance is listed but not the row the session chose on it', () => {
    expect(
      customVendorGone(INSTANCE, { providerId: INSTANCE, modelId: 'deepseek-old' }, listed),
    ).toBe(true)
  })

  it('never for a listed row — a cleared key or a refused address keeps it listed — nor a builtin', () => {
    expect(
      customVendorGone(INSTANCE, { providerId: INSTANCE, modelId: 'deepseek-flash' }, listed),
    ).toBe(false)
    // The session moved to another provider: only whether the instance is listed counts.
    expect(
      customVendorGone(INSTANCE, { providerId: 'anthropic', modelId: 'claude-sonnet-5' }, listed),
    ).toBe(false)
    expect(customVendorGone(INSTANCE, null, listed)).toBe(false)
    // A builtin missing from the list is 02's business, not this copy's.
    expect(customVendorGone('zhipu', { providerId: 'zhipu', modelId: 'glm-5.3' }, listed)).toBe(
      false,
    )
  })

  it('says so in both languages as the spec words it', () => {
    expect(text('zh-CN', 'error.customVendorGone')).toBe(
      '这个会话用的自定义厂商或模型已删除。在模型菜单里换一个模型再发送。',
    )
    expect(text('en', 'error.customVendorGone')).toBe(
      "This conversation's custom provider or model was removed. Pick another model in the model menu and send again.",
    )
    expect(text('zh-CN', 'model.trigger.removed')).toBe('{model}（已删除）')
  })
})

const PASSED: ProbeSnapshot = {
  outcome: 'passed',
  reason: null,
  probedAt: 1_759_400_000_000,
  reasoningField: 'reasoning_content',
  maxTokensField: 'max_tokens',
  usageSeen: true,
  responseModelId: 'deepseek-flash',
  unknownFields: [],
}

describe('a stored probe as one line (§结果与原因码)', () => {
  it('passed, never probed, and each reason by its own sentence', () => {
    expect(probeLineOf(PASSED)).toEqual({ key: 'customVendor.probe.passed' })
    expect(probeLineOf(undefined)).toEqual({ key: 'customVendor.probe.none' })
    for (const [reason, key] of Object.entries(PROBE_REASON_KEY)) {
      if (reason === 'opaque-fields') continue
      const snapshot: ProbeSnapshot = {
        ...PASSED,
        outcome: 'failed',
        reason: reason as keyof typeof PROBE_REASON_KEY,
      }
      expect([reason, probeLineOf(snapshot)]).toEqual([reason, { key }])
    }
    expect(text('zh-CN', 'customVendor.probe.passed')).toBe('本机探测通过 · 不保证')
  })

  it('reads a row that was not detected by its reason, never as passed (Q14 three states)', () => {
    // §结果与原因码「没测出来」: the middle state carries its reason; reading it as passed would
    // label a row that never showed a tool round trip as 「本机探测通过」.
    for (const reason of ['no-tool-call', 'output-limit', 'no-finish'] as const) {
      const snapshot: ProbeSnapshot = { ...PASSED, outcome: 'not-detected', reason }
      expect([reason, probeLineOf(snapshot)]).toEqual([
        reason,
        { key: `customVendor.probe.reason.${reason}` },
      ])
    }
  })

  it('keys each reason as customVendor.probe.reason.<code>, worded as the table words it', () => {
    // §结果与原因码: 「原因码与界面文案一一对应，两份 locale 各有一键 `customVendor.probe.reason.<code>`」.
    // A swapped row would show another code's sentence and still find a key.
    const table = {
      'no-tool-call': [
        '模型这次没有调用工具，可以再试一次',
        'The model did not call a tool this time; try again',
      ],
      'output-limit': [
        '输出上限内没答完，可以再试或调大输出上限',
        'It ran out of output tokens; try again or raise the output limit',
      ],
      'no-finish': [
        '带上工具结果后没有正常收尾',
        'It did not finish normally after the tool result',
      ],
      config: ['key 没配好', 'The key is not set up'],
      auth: ['key 无效或没有权限', 'The key was rejected'],
      quota: ['额度或余额不足', 'Out of quota or balance'],
      'rate-limit': ['请求太频繁，稍后再试', 'Rate limited; try again later'],
      'request-rejected': ['端点拒绝了带工具的请求', 'The endpoint refused a request with tools'],
      'echo-rejected': [
        '端点拒绝了工具结果或思考回传',
        'The endpoint refused the tool result or the thinking echo',
      ],
      'bad-tool-call': ['模型发出的工具调用不完整', "The model's tool call was malformed"],
      'opaque-fields': [
        '有无法回传的字段：{fields}',
        'It returns fields Tenon cannot send back: {fields}',
      ],
      service: ['服务出错或连不上', 'The service failed or could not be reached'],
    } as const satisfies Record<ProbeReason, readonly [string, string]>
    expect(Object.keys(PROBE_REASON_KEY).toSorted()).toEqual(probeReasonSchema.options.toSorted())
    for (const code of probeReasonSchema.options) {
      const key = PROBE_REASON_KEY[code]
      expect([code, key, text('zh-CN', key), text('en', key)]).toEqual([
        code,
        `customVendor.probe.reason.${code}`,
        ...table[code],
      ])
    }
    expect(text('en', 'customVendor.probe.passed')).toBe('Probed on this computer · not guaranteed')
  })

  it('gives every refusal and failure code the sentence named after it', () => {
    // The other code tables (§IPC, M6 01 修补 4): the key's last segment is the code, so a row
    // pointing at a neighbour's sentence shows here rather than as wrong copy on the card.
    const tables: readonly (readonly [
      string,
      Readonly<Record<string, string>>,
      readonly string[],
    ])[] = [
      [
        'customVendor.probe.refused',
        PROBE_REFUSED_KEY,
        ['not-found', 'unknown-model', 'local-endpoint', 'busy', 'aborted'],
      ],
      [
        'customVendor.models.fetchError',
        FETCH_MODELS_KEY,
        ['not-found', 'config', 'auth', 'unsupported', 'service'],
      ],
      ['customVendor.error', VENDOR_ERROR_KEY, customVendorErrorCodeSchema.options],
      ['settings.providers.refused', REFUSAL_KEY, providerRefusalSchema.shape.code.options],
    ]
    for (const [prefix, keys, codes] of tables) {
      expect([prefix, Object.keys(keys).toSorted()]).toEqual([prefix, codes.toSorted()])
      for (const code of codes) expect([code, keys[code]]).toEqual([code, `${prefix}.${code}`])
    }
    // provider.configure's codes keep 01's camel-cased keys.
    for (const code of providerWriteErrorCodeSchema.options) {
      const camel = code.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())
      expect([code, PROVIDER_WRITE_ERROR_KEY[code]]).toEqual([
        code,
        `settings.providers.error.${camel}`,
      ])
    }
  })

  it('names the fields Tenon cannot send back (验收 17)', () => {
    const snapshot: ProbeSnapshot = {
      ...PASSED,
      outcome: 'failed',
      reason: 'opaque-fields',
      unknownFields: ['encrypted_content', 'reasoning_details'],
    }
    expect(probeLineOf(snapshot)).toEqual({
      key: 'customVendor.probe.reason.opaque-fields',
      fields: 'encrypted_content, reasoning_details',
    })
  })
})

const ROWS: CustomVendorContract['models'] = [
  { id: 'deepseek-flash', contextLimit: 1_000_000, maxOutputTokens: 64_000, probe: PASSED },
  { id: 'deepseek-pro', contextLimit: 1_000_000, maxOutputTokens: 64_000 },
]

describe('a typed model row (§列表与上限, T6)', () => {
  it('drops the id’s surrounding whitespace before it is sent', () => {
    // customVendor.update refuses a padded id (Revisions 2026-10-02, step 7 round 2).
    expect(
      rowOf({ id: '  glm-5.3-flashx \n', contextLimit: ' 200000', maxOutputTokens: '128000 ' }),
    ).toEqual({
      ok: true,
      row: { id: 'glm-5.3-flashx', contextLimit: 200_000, maxOutputTokens: 128_000 },
    })
    expect(rowOf({ id: ' \t', contextLimit: '1', maxOutputTokens: '1' })).toEqual({
      ok: false,
      problem: 'id',
    })
    expect(rowOf({ id: 'x'.repeat(201), contextLimit: '1', maxOutputTokens: '1' })).toEqual({
      ok: false,
      problem: 'id',
    })
  })

  it('cannot be saved without both limits as positive whole numbers, and falls back to none', () => {
    // T6: no row is saved on 01 spec:708's 128000 / 4096.
    for (const [contextLimit, maxOutputTokens] of [
      ['', '4096'],
      ['128000', ''],
      ['0', '4096'],
      ['128000', '-1'],
      ['128000.5', '4096'],
      ['1e5', '4096'],
      ['128k', '4096'],
      ['9007199254740993', '4096'],
    ] as const) {
      expect([
        contextLimit,
        maxOutputTokens,
        rowOf({ id: 'm', contextLimit, maxOutputTokens }),
      ]).toEqual([contextLimit, maxOutputTokens, { ok: false, problem: 'limits' }])
    }
  })

  it('sends the rows without snapshots: a saved row in its own place, a new one last', () => {
    const edited = withRow(ROWS, {
      id: 'deepseek-flash',
      contextLimit: 900_000,
      maxOutputTokens: 64_000,
    })
    expect(edited).toEqual([
      { id: 'deepseek-flash', contextLimit: 900_000, maxOutputTokens: 64_000 },
      { id: 'deepseek-pro', contextLimit: 1_000_000, maxOutputTokens: 64_000 },
    ])
    const added = withRow(ROWS, {
      id: 'deepseek-lite',
      contextLimit: 128_000,
      maxOutputTokens: 8_000,
    })
    expect(added.map((row) => row.id)).toEqual(['deepseek-flash', 'deepseek-pro', 'deepseek-lite'])
    const removed = withoutRow(ROWS, 'deepseek-flash')
    expect(removed).toEqual([
      { id: 'deepseek-pro', contextLimit: 1_000_000, maxOutputTokens: 64_000 },
    ])
    // The contract's request is strict: a snapshot carried along would fail it (§IPC; only main
    // writes a probe).
    for (const models of [edited, added, removed]) {
      expect(customVendorUpdate.request.safeParse({ id: INSTANCE, models }).success).toBe(true)
    }
  })

  it('prefills only the limits /models gave (T6, T7)', () => {
    expect(draftOf({ id: 'kimi-k3', contextLimit: 262_144 })).toEqual({
      id: 'kimi-k3',
      contextLimit: '262144',
      maxOutputTokens: '',
    })
    expect(draftOf({ id: 'qwen4-max' })).toEqual({
      id: 'qwen4-max',
      contextLimit: '',
      maxOutputTokens: '',
    })
  })
})
