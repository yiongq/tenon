/**
 * Custom vendors (M6 §实例描述与通用工厂): an instance is one generic factory plus pure data, never a
 * definition file per vendor (Q3; ADR-003 decision 3).
 *
 * The description is data that survives JSON (it is what `config.json`'s `customVendors` holds,
 * §存储), and both functions here are pure: no I/O, no clock. The only host capability a definition
 * touches is the `network` its `create()` is handed, and that one only through the two wire adapters
 * the kernel already has — wrapped so that no request follows a redirect (§实例描述与通用工厂
 * `create()`; M6 不变量 3).
 */
import type { HostNetwork } from '../../host/adapter.js'
import { ProviderInvalidArgumentError } from '../errors.js'
import type { ProbeSnapshot } from '../probe.js'
import type { ModelInfo, Provider, ProviderDefinition, ProviderId } from '../types.js'
import { AnthropicMessagesProvider } from '../wire/anthropic-messages.js'
import { OpenAIChatProvider } from '../wire/openai-chat.js'
import { configuredValue } from '../wire/transport.js'
import { frozenModels } from './models.js'

/**
 * An instance id (T1): `custom-` and a lowercase canonical UUID, minted by the main process and
 * never reused. 43 characters, inside `providerIdSchema`'s 64 and provenance's identity segment.
 * Contracts restates it as `CUSTOM_ID_REGEX`; a contracts test holds the two to the same source.
 */
export const CUSTOM_PROVIDER_ID_PATTERN =
  /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** At most this many tools in one request on an instance (T13; M6 §对 01 的修补 2). */
export const CUSTOM_TOOLS_PER_REQUEST = 128

/**
 * The key a loopback or private instance saved without one sends (§key): 01 spec:326 wants a
 * non-empty `apiKey` on the openai-chat wire, and a local server often checks none. Used only here,
 * in the factory (the model list sends no credential instead); a public instance
 * (`keyRequired: true`) never falls back to it.
 */
export const CUSTOM_LOCAL_API_KEY = 'tenon-local'

/** The generic i18n keys every instance shares; the user's own name travels as `displayName`. */
const NAME_KEY = 'provider.custom.name'
const API_KEY_LABEL = 'provider.custom.config.apiKey'
const BASE_URL_LABEL = 'provider.custom.config.baseURL'

export interface CustomVendorDescription {
  /** `custom-<uuid>` (T1). */
  readonly id: ProviderId
  readonly wire: 'openai-chat' | 'anthropic-messages'
  /** Fixed once the instance exists (T2): changing the address is a new instance. */
  readonly baseURL: string
  /** false only for a loopback or private instance (§key). */
  readonly keyRequired: boolean
  readonly models: readonly CustomModelRow[]
}

export interface CustomModelRow {
  readonly id: string
  /** A positive integer the user typed or /models prefilled (T6). */
  readonly contextLimit: number
  readonly maxOutputTokens: number
  /** §探测; absent = never probed. */
  readonly probe?: ProbeSnapshot
}

/**
 * One row's `ModelInfo` (§模型行「合成」). Only `probe.outcome === 'passed'` turns tools on (M6 不变量
 * 6); a snapshot that did not pass, or none, leaves the conservative row whatever else it says —
 * except `maxTokensField`, a fact of the wire rather than a capability, which an openai-chat row
 * writes whatever the outcome (§合成; 验收 16), so a row that fell back to text only still sends the
 * one output field its endpoint takes. `checksThinkingPrefix` is written false on every row, so an id
 * that happens to be one of 02's two prefix-checking models still reads false (Q2; M6 不变量 17).
 */
export function customModelInfo(
  d: Pick<CustomVendorDescription, 'id' | 'wire'>,
  row: CustomModelRow,
): ModelInfo {
  const passed = row.probe?.outcome === 'passed'
  const openAIChat = d.wire === 'openai-chat'
  // Read only off a passing snapshot, and only on the wire that has the field: an
  // anthropic-messages row writes neither this nor `maxTokensField` (T10), whatever a hand-edited
  // snapshot holds.
  const reasoningField = passed && openAIChat ? (row.probe?.reasoningField ?? null) : null
  const model: ModelInfo = {
    id: row.id,
    providerId: d.id,
    contextLimit: row.contextLimit,
    maxOutputTokens: row.maxOutputTokens,
    // Only the anthropic wire's `thinkingEffortSupport` reads it, and no level is ever sent (T5).
    reasoning: false,
    supportsToolCalling: passed,
    // The probe itself is a streamed tool call.
    supportsStreamingToolCalls: passed,
    supportsVision: false,
    supportsCacheControl: false,
    // Q2: a non-empty signature goes back verbatim on the anthropic wire whatever the probe said;
    // the openai-chat wire echoes only the thinking field the probe saw.
    thinkingPreservationFormat: openAIChat
      ? reasoningField === null
        ? 'drop'
        : 'reasoning-content'
      : 'signed-blocks',
    // §模型行「合成」: the openai-chat wire asks for usage (`stream_options.include_usage`) and
    // reads it on the standard path only; the anthropic encoder never reads this field.
    usageNeedsOptIn: openAIChat,
    checksThinkingPrefix: false,
  }
  if (reasoningField !== null) model.reasoningEchoField = reasoningField
  // §合成「maxTokensField」: not gated on `outcome` (验收 16): an endpoint that refused `max_tokens`
  // refuses it on a text-only request too.
  if (openAIChat && row.probe?.maxTokensField === 'max_completion_tokens') {
    model.maxTokensField = 'max_completion_tokens'
  }
  return model
}

/**
 * An instance's `ProviderDefinition` (§实例描述与通用工厂): one of the two wire adapters over the
 * description's own address. `baseURL` is declared as a config key with the description's address as
 * its default only so that 02's key binding, target-host display and `endpointOrigin` read it (01
 * 修补 6); `create()` never reads `config.baseURL`.
 */
export function customVendorDefinition(d: CustomVendorDescription): ProviderDefinition {
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(d.id)) {
    throw new ProviderInvalidArgumentError(
      `custom vendor id "${d.id}" is not custom- and a lowercase canonical UUID`,
    )
  }
  const wire = d.wire
  if (wire !== 'openai-chat' && wire !== 'anthropic-messages') {
    throw new ProviderInvalidArgumentError(`custom vendor ${d.id}: unknown wire "${String(wire)}"`)
  }
  const baseURL = d.baseURL
  const keyRequired = d.keyRequired
  const models = frozenModels(d.models.map((row) => customModelInfo(d, row)))
  return {
    id: d.id,
    nameKey: NAME_KEY,
    wire,
    configKeys: [
      { name: 'apiKey', required: keyRequired, secret: true, labelKey: API_KEY_LABEL },
      {
        name: 'baseURL',
        required: true,
        secret: false,
        default: baseURL,
        labelKey: BASE_URL_LABEL,
      },
    ],
    builtinModels: [...models],
    // No `finishReasons`: an instance reads only the wires' standard tables (T11).
    maxToolsPerRequest: CUSTOM_TOOLS_PER_REQUEST,
    create(args): Provider {
      const network = withoutRedirects(args.network)
      const apiKey =
        configuredValue(args.secrets['apiKey']) ?? (keyRequired ? null : CUSTOM_LOCAL_API_KEY)
      if (wire === 'openai-chat') {
        return new OpenAIChatProvider({
          id: d.id,
          network,
          clock: args.clock,
          apiKey,
          baseURL,
          models,
        })
      }
      // `x-api-key` only (§key): an instance declares no `authToken`.
      return new AnthropicMessagesProvider({
        id: d.id,
        network,
        clock: args.clock,
        apiKey,
        authToken: null,
        baseURL,
        models,
      })
    },
  }
}

/**
 * The network an instance sends through (§实例描述与通用工厂 `create()`): every request as given, but
 * with `redirect: 'error'`, so a 3xx is not followed and reads as a `network` failure (the search
 * backends' precedent, tools/search/backends.ts). The model list uses the same layer, and the probe
 * inherits it through `create()`. `fetchUntrusted` is WebFetch's door, which no provider opens.
 */
export function withoutRedirects(network: HostNetwork): HostNetwork {
  return {
    // Closures, not the bare properties: a host whose `fetch` is a method keeps its `this`.
    fetch: (input, init) => network.fetch(input, { ...init, redirect: 'error' }),
    fetchUntrusted: (input, init) => network.fetchUntrusted(input, init),
  }
}
