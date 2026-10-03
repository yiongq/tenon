/**
 * The custom vendor presets (M6 §预设): pure data — a vendor's name, its regions, each region's base
 * URL per wire, its 「去取 key」 page and the default wire — and nothing per model (Q3). They live in the
 * main process (推出的读法 4): `customVendor.list` hands them to the renderer, and `customVendor.create`
 * looks a preset's address up here by `presetId` and `regionId`, so a renderer cannot hand in a
 * preset address of its own.
 *
 * Addresses and links as §预设's table has them, checked against the vendors' documents on 2026-10-02
 * (sources per row in the spec). Only pay-as-you-go addresses, never a subscription path (Q13).
 * Volcengine Ark has no anthropic-messages address in the first version (Q18, 2026-10-03: its two
 * documents disagree on the path); Z.ai only its openai-chat one (its `/api/anthropic` appears in
 * the GLM Coding Plan documents only).
 */
import type { RouteResponse, customVendorList } from '@tenon-app/contracts'
import type { CustomWire } from './address.js'

export type VendorPreset = RouteResponse<typeof customVendorList>['presets'][number]

const PRESETS: readonly VendorPreset[] = [
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
    // The shared DashScope hosts the documents say still work; the per-workspace hosts need a
    // WorkspaceId (§预设). Virginia and Hong Kong go through 「其他兼容端点」 (推出的读法 43).
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
    // One region in China; BytePlus ModelArk is another platform. No anthropic-messages address
    // (Q18): the two documents disagree on its path.
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
    // The vendor's recommended wire. The key page is 「接口密钥」, not the M Plan subscription page.
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

/** The presets in the order the settings card lists them; a fresh copy every call. */
export function vendorPresets(): VendorPreset[] {
  return structuredClone([...PRESETS])
}

/**
 * The address a preset region gives a wire, or null when the preset, the region or that wire's
 * address does not exist — which `customVendor.create` answers with `invalid-address` (§IPC).
 */
export function presetEndpoint(
  presetId: string,
  regionId: string,
  wire: CustomWire,
): string | null {
  const preset = PRESETS.find((candidate) => candidate.id === presetId)
  const region = preset?.regions.find((candidate) => candidate.id === regionId)
  return region?.endpoints[wire] ?? null
}
