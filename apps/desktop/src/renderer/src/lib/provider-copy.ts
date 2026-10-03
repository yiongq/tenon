import type { ProviderRefusal, ProviderWriteErrorCode } from '@tenon-app/contracts'

/**
 * The settings card's copy for the provider contract's codes, as tables a node test can walk
 * (copy-coverage.test.ts): every code maps to a catalogue key, never to a sentence built here
 * (spec「国际化」). A code added to the contract without its row does not compile.
 */

/** `provider.configure` / `provider.select` refusals (01 §desktop 接线; M6 01 修补 4). */
export const PROVIDER_WRITE_ERROR_KEY = {
  'unknown-provider': 'settings.providers.error.unknownProvider',
  'unknown-key': 'settings.providers.error.unknownKey',
  'unknown-model': 'settings.providers.error.unknownModel',
  'invalid-value': 'settings.providers.error.invalidValue',
  'key-host-binding': 'settings.providers.error.keyHostBinding',
  'official-host-only': 'settings.providers.error.officialHostOnly',
  'subscription-endpoint': 'settings.providers.error.subscriptionEndpoint',
} as const satisfies Record<ProviderWriteErrorCode, string>

/**
 * Why an address in force reads as not configured (M6 01 修补 4 `refused`): a builtin's address off
 * its official origin or on zhipu's subscription path (§点名 (b), (c)), or an instance's address
 * that fails §地址校验 (§存储). The builtin's `official-host-only` line comes with the 「新建自定义厂商」
 * button; `subscription-endpoint` with none (§点名 (b)).
 */
export const REFUSAL_KEY = {
  'official-host-only': 'settings.providers.refused.official-host-only',
  'subscription-endpoint': 'settings.providers.refused.subscription-endpoint',
  'invalid-address': 'settings.providers.refused.invalid-address',
  'https-required': 'settings.providers.refused.https-required',
} as const satisfies Record<ProviderRefusal['code'], string>
