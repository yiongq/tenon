/**
 * A custom vendor's address (M6 §地址校验) and the presets (§预设): the five rules in the table's
 * order, the address as it is stored, and the preset data — the address half of 验收 4 and all of
 * 验收 6. What a refused create leaves in the keychain and `config.json` is in
 * custom-vendor-store.test.ts.
 */
import { vendorPresetSchema } from '@tenon-app/contracts'
import { describe, expect, it } from 'vitest'
import { checkAddress, isSubscriptionPath } from '../src/main/custom-vendors/address.js'
import type { CustomWire } from '../src/main/custom-vendors/address.js'
import { presetEndpoint, vendorPresets } from '../src/main/custom-vendors/presets.js'

const code = (input: string, wire: CustomWire = 'openai-chat'): string => {
  const check = checkAddress(input, wire)
  return check.ok ? 'ok' : check.code
}

describe('M6 §地址校验', () => {
  it('stores new URL(input).href without its trailing slash', () => {
    expect(checkAddress('https://api.deepseek.com', 'openai-chat')).toEqual({
      ok: true,
      baseURL: 'https://api.deepseek.com',
    })
    expect(checkAddress(' HTTPS://API.Moonshot.CN/v1/ ', 'openai-chat')).toEqual({
      ok: true,
      baseURL: 'https://api.moonshot.cn/v1',
    })
    expect(checkAddress('https://relay.example:8443/a/../b//', 'anthropic-messages')).toEqual({
      ok: true,
      baseURL: 'https://relay.example:8443/b',
    })
  })

  it('rule 1: only an absolute http(s) URL', () => {
    for (const input of ['api.deepseek.com', 'not a url', 'ftp://api.example.com', 'file:///v1']) {
      expect(code(input)).toBe('invalid-address')
    }
  })

  it('rule 2: plain http only to this machine or a private network, by spelling', () => {
    expect(code('http://api.example.com/v1')).toBe('https-required')
    expect(code('http://8.8.8.8/v1')).toBe('https-required')
    for (const input of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8000/v1',
      'http://[::1]:8080',
      'http://192.168.1.20/v1',
      'http://10.0.0.7:1234',
      'http://gpu-box.lan/v1',
      'http://gpu-box:8000',
    ]) {
      expect(code(input)).toBe('ok')
    }
  })

  it('rule 3: no userinfo, and no ? or # in the address as typed', () => {
    for (const input of [
      'https://user:secret@api.example.com/v1',
      'https://user@api.example.com/v1',
      'https://:secret@api.example.com/v1',
      'https://api.example.com/v1?tenant=a',
      // Empty ones too: the parsed URL keeps no trace of them, the typed string does.
      'https://api.example.com/v1?',
      'https://api.example.com/v1#',
      'https://api.example.com/v1#frag',
    ]) {
      expect(code(input)).toBe('invalid-address')
    }
  })

  it('rule 4: the GLM Coding Plan path, however it is spelled, on either wire', () => {
    for (const input of [
      'https://open.bigmodel.cn/api/coding/paas/v4',
      'https://api.z.ai/api/coding/paas/v4/',
      'https://open.bigmodel.cn/API/Coding/PAAS/V4',
      'https://open.bigmodel.cn//api//coding///paas/v4',
      'https://open.bigmodel.cn/api/%63oding/paas/v4',
      'https://open.bigmodel.cn/api%2Fcoding%2Fpaas%2Fv4',
      // A repeated slash that only appears once decoded.
      'https://open.bigmodel.cn/api/coding%2F%2Fpaas/v4',
      'https://open.bigmodel.cn/api/cod\ting/paas/v4',
      'https://relay.example/prefix/api/coding/paas/v4/extra',
    ]) {
      expect(code(input)).toBe('subscription-endpoint')
      expect(code(input, 'anthropic-messages')).toBe('subscription-endpoint')
    }
    // The pay-as-you-go path and Zhipu's shared /api/anthropic address are not it (Q13: a reminder
    // only, in the settings card).
    expect(code('https://open.bigmodel.cn/api/paas/v4')).toBe('ok')
    expect(code('https://open.bigmodel.cn/api/anthropic', 'anthropic-messages')).toBe('ok')
    expect(isSubscriptionPath('/api/coding/paas')).toBe(false)
    // A segment that does not percent-decode is judged as typed: an answer, never a throw.
    expect(code('https://relay.example/v1/%zz')).toBe('ok')
    expect(code('https://open.bigmodel.cn/api/coding/paas/v4/%zz')).toBe('subscription-endpoint')
  })

  it("rule 5: an anthropic-messages address does not end in the SDK's own /v1", () => {
    for (const input of [
      'https://api.example.com/anthropic/v1',
      'https://api.example.com/anthropic/v1/',
      'https://api.example.com/v1',
      'https://api.example.com/%76%31',
    ]) {
      expect(code(input, 'anthropic-messages')).toBe('invalid-address')
      expect(code(input, 'openai-chat')).toBe('ok')
    }
    expect(code('https://api.example.com/v1/anthropic', 'anthropic-messages')).toBe('ok')
  })

  it('judges in the table order: the first rule failed is the code', () => {
    expect(code('http://api.example.com/v1?x=1')).toBe('https-required')
    expect(code('http://user@api.example.com/v1')).toBe('https-required')
    expect(code('https://user@open.bigmodel.cn/api/coding/paas/v4')).toBe('invalid-address')
    expect(code('http://api.example.com/api/coding/paas/v4')).toBe('https-required')
    expect(code('https://open.bigmodel.cn/api/coding/paas/v4?x=1')).toBe('invalid-address')
    expect(code('https://api.example.com/api/coding/paas/v4/v1', 'anthropic-messages')).toBe(
      'subscription-endpoint',
    )
  })
})

/** §预设's table, row by row (验收 6). */
const TABLE = [
  {
    id: 'deepseek',
    nameKey: 'customVendor.preset.deepseek',
    defaultWire: 'openai-chat',
    regions: [
      {
        id: 'default',
        labelKey: 'customVendor.region.default',
        keyPageURL: 'https://platform.deepseek.com/api_keys',
        endpoints: {
          'openai-chat': 'https://api.deepseek.com',
          'anthropic-messages': 'https://api.deepseek.com/anthropic',
        },
      },
    ],
  },
  {
    id: 'kimi',
    nameKey: 'customVendor.preset.kimi',
    defaultWire: 'openai-chat',
    regions: [
      {
        id: 'cn',
        labelKey: 'customVendor.region.cn',
        keyPageURL: 'https://platform.kimi.com/console/api-keys',
        endpoints: {
          'openai-chat': 'https://api.moonshot.cn/v1',
          'anthropic-messages': 'https://api.moonshot.cn/anthropic',
        },
      },
      {
        id: 'global',
        labelKey: 'customVendor.region.global',
        keyPageURL: 'https://platform.kimi.ai/console/api-keys',
        endpoints: {
          'openai-chat': 'https://api.moonshot.ai/v1',
          'anthropic-messages': 'https://api.moonshot.ai/anthropic',
        },
      },
    ],
  },
  {
    id: 'bailian',
    nameKey: 'customVendor.preset.bailian',
    defaultWire: 'openai-chat',
    regions: [
      {
        id: 'cn-beijing',
        labelKey: 'customVendor.region.cnBeijing',
        keyPageURL: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
        endpoints: {
          'openai-chat': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          'anthropic-messages': 'https://dashscope.aliyuncs.com/apps/anthropic',
        },
      },
      {
        id: 'ap-southeast-1',
        labelKey: 'customVendor.region.singapore',
        keyPageURL: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key',
        endpoints: {
          'openai-chat': 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
          'anthropic-messages': 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
        },
      },
    ],
  },
  {
    id: 'ark',
    nameKey: 'customVendor.preset.ark',
    defaultWire: 'openai-chat',
    regions: [
      {
        id: 'cn-beijing',
        labelKey: 'customVendor.region.cnBeijing',
        keyPageURL: 'https://ark.volcengine.com/region:cn-beijing/apiKey',
        endpoints: { 'openai-chat': 'https://ark.cn-beijing.volces.com/api/v3' },
      },
    ],
  },
  {
    id: 'minimax',
    nameKey: 'customVendor.preset.minimax',
    defaultWire: 'anthropic-messages',
    regions: [
      {
        id: 'cn',
        labelKey: 'customVendor.region.cn',
        keyPageURL: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
        endpoints: {
          'openai-chat': 'https://api.minimax.cn/v1',
          'anthropic-messages': 'https://api.minimax.cn/anthropic',
        },
      },
      {
        id: 'global',
        labelKey: 'customVendor.region.global',
        keyPageURL: 'https://platform.minimax.io/user-center/basic-information/interface-key',
        endpoints: {
          'openai-chat': 'https://api.minimax.io/v1',
          'anthropic-messages': 'https://api.minimax.io/anthropic',
        },
      },
    ],
  },
  {
    id: 'zai',
    nameKey: 'customVendor.preset.zai',
    defaultWire: 'openai-chat',
    regions: [
      {
        id: 'global',
        labelKey: 'customVendor.region.global',
        keyPageURL: 'https://z.ai/manage-apikey/apikey-list',
        endpoints: { 'openai-chat': 'https://api.z.ai/api/paas/v4' },
      },
    ],
  },
]

describe('M6 §预设 (验收 6)', () => {
  it("equals §预设's table, row by row, and each preset passes the contract", () => {
    const presets = vendorPresets()
    expect(presets).toEqual(TABLE)
    for (const preset of presets) expect(vendorPresetSchema.parse(preset)).toEqual(preset)
  })

  it('MiniMax defaults to anthropic-messages, Z.ai and Ark have no anthropic-messages address', () => {
    const byId = new Map(vendorPresets().map((preset) => [preset.id, preset]))
    expect(byId.get('minimax')?.defaultWire).toBe('anthropic-messages')
    expect(byId.get('minimax')?.regions.map((region) => region.id)).toEqual(['cn', 'global'])
    // Z.ai's /api/anthropic is only in the GLM Coding Plan documents; Ark's path is 开放问题 1.
    for (const id of ['zai', 'ark']) {
      for (const region of byId.get(id)?.regions ?? []) {
        expect(region.endpoints).not.toHaveProperty('anthropic-messages')
      }
    }
  })

  it('every preset address passes §地址校验 on its wire as stored, and none is a subscription path', () => {
    const addresses = vendorPresets().flatMap((preset) =>
      preset.regions.flatMap((region) =>
        (['openai-chat', 'anthropic-messages'] as const).flatMap((wire) => {
          const url = region.endpoints[wire]
          return url === undefined ? [] : [{ url, wire }]
        }),
      ),
    )
    expect(addresses).toHaveLength(16)
    for (const { url, wire } of addresses) {
      expect(checkAddress(url, wire)).toEqual({ ok: true, baseURL: url })
      expect(url).not.toMatch(/coding|token-plan|\/api\/plan/i)
    }
    // Every key link is the pay-as-you-go key page, over https (Q13).
    for (const region of vendorPresets().flatMap((preset) => preset.regions)) {
      expect(region.keyPageURL).toMatch(/^https:\/\//)
      expect(region.keyPageURL).not.toMatch(/coding|plan|subscri/i)
    }
  })

  it('looks a preset address up by preset, region and wire, and answers null for any miss', () => {
    expect(presetEndpoint('kimi', 'global', 'anthropic-messages')).toBe(
      'https://api.moonshot.ai/anthropic',
    )
    expect(presetEndpoint('bailian', 'ap-southeast-1', 'openai-chat')).toBe(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    )
    expect(presetEndpoint('ark', 'cn-beijing', 'anthropic-messages')).toBeNull()
    expect(presetEndpoint('kimi', 'cn-beijing', 'openai-chat')).toBeNull()
    expect(presetEndpoint('openai', 'global', 'openai-chat')).toBeNull()
  })

  it('hands out copies: a caller cannot change what the next create looks up', () => {
    const presets = vendorPresets()
    const region = presets[0]?.regions[0]
    if (region === undefined) throw new Error('no preset region')
    region.endpoints['openai-chat'] = 'https://attacker.example'
    expect(presetEndpoint('deepseek', 'default', 'openai-chat')).toBe('https://api.deepseek.com')
    expect(vendorPresets()).toEqual(TABLE)
  })
})
