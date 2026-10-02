/**
 * A custom vendor's model list (M6 §列表与上限, T7): one GET, sent only when the user presses
 * 「获取模型列表」, read for the ids and six limit keys and nothing else.
 *
 * openai-chat asks `<baseURL>/models`, anthropic-messages `<baseURL>/v1/models`, each with its wire's
 * credential header and through that wire's request-header allowlist (A6) and `fetchThroughHost`,
 * on the same no-redirect network the instance's requests use, under the same idle watchdog. 02's
 * key binding is checked by the caller before it calls. A loopback or private instance saved without
 * a key sends no credential header: the `tenon-local` placeholder is the factory's alone (§key). A
 * failure answers a code and the HTTP status only: the response body is neither logged nor returned,
 * and neither is the key.
 *
 * Three limits end a list that does not come (§列表与上限): the response headers within 30 s, a body
 * of at most 8 MiB, and the idle watchdog between body bytes. The caller's `signal` (application
 * exit) aborts at any point.
 */
import type { HostClock, HostNetwork } from '../host/adapter.js'
import { withoutRedirects } from './definitions/custom.js'
import type { CustomVendorDescription } from './definitions/custom.js'
import { ProviderInvalidArgumentError } from './errors.js'
import { ALLOWED_HEADERS as ANTHROPIC_HEADERS } from './wire/anthropic-messages.js'
import { ALLOWED_HEADERS as OPENAI_CHAT_HEADERS } from './wire/openai-chat.js'
import {
  allowedRequestInit,
  assertBaseUrl,
  configuredValue,
  fetchThroughHost,
  idleMsFor,
} from './wire/transport.js'

export interface RemoteModel {
  readonly id: string
  /** Prefill only (T6); absent when the list states no usable value. */
  readonly contextLimit?: number
  readonly maxOutputTokens?: number
}

export type RemoteModelsResult =
  | { readonly ok: true; readonly models: readonly RemoteModel[] }
  | {
      readonly ok: false
      /**
       * `config`: nothing was sent (no key, a key no header can carry, or an address no request
       * could reach); `auth`: 401 or 403; `unsupported`: the endpoint has no list to give (a 4xx
       * other than those and 408 / 429, a body past 8 MiB, a body that is not JSON, no `data`
       * array); `service`: 408, 429, 5xx, no response headers within 30 s, or no answer at all.
       */
      readonly code: 'config' | 'auth' | 'unsupported' | 'service'
      /** null when no response arrived. */
      readonly status: number | null
    }

export interface RemoteModelsQuery {
  readonly vendor: Pick<CustomVendorDescription, 'id' | 'wire' | 'baseURL' | 'keyRequired'>
  readonly secrets: Record<string, string>
  /** `host.network`; wrapped here so no redirect is followed (M6 不变量 3). */
  readonly network: HostNetwork
  /** Arms the byte-level idle watchdog every provider request runs under (02 A5, 01 修补 4). */
  readonly clock: Pick<HostClock, 'setTimeout'>
  readonly signal?: AbortSignal
}

/**
 * A model row id's bounds (contracts custom-vendor.ts `customModelSchema`): an id outside them could
 * not be saved anyway — at most 200 characters, and no surrounding whitespace (§列表与上限).
 */
const MAX_MODEL_ID = 200

function isRowId(id: unknown): id is string {
  return typeof id === 'string' && id !== '' && id.length <= MAX_MODEL_ID && id === id.trim()
}

/** §列表与上限: the response headers must arrive within this, or the list answers `service`. */
const HEADERS_MS = 30_000

/** §列表与上限: a body past this many bytes is not read further and answers `unsupported`. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** §列表与上限: the first positive integer among these keys of `data[i]`, in this order. */
const CONTEXT_KEYS = ['context_window', 'context_length', 'max_model_len'] as const
const OUTPUT_KEYS = ['max_output_tokens', 'max_completions_tokens'] as const

/**
 * Lists the instance's models. Rejects only when `signal` aborts; every other failure is a result.
 */
export async function fetchRemoteModels(q: RemoteModelsQuery): Promise<RemoteModelsResult> {
  const { vendor } = q
  const anthropic = vendor.wire === 'anthropic-messages'
  const apiKey = configuredValue(q.secrets['apiKey'])
  if (apiKey === null && vendor.keyRequired) return { ok: false, code: 'config', status: null }
  try {
    assertBaseUrl(vendor.id, vendor.baseURL, { wire: vendor.wire, refuseV1Suffix: anthropic })
  } catch (error) {
    if (error instanceof ProviderInvalidArgumentError) {
      return { ok: false, code: 'config', status: null }
    }
    throw error
  }
  const url = `${vendor.baseURL.replace(/\/+$/, '')}${anthropic ? '/v1/models' : '/models'}`
  // The request's own signal, so the header limit can let go of it; the caller's aborts it too.
  const headersLate = new AbortController()
  const signal =
    q.signal === undefined ? headersLate.signal : AbortSignal.any([q.signal, headersLate.signal])
  let init: RequestInit
  try {
    init = allowedRequestInit(
      { method: 'GET', headers: credentialHeader(anthropic, apiKey), signal },
      anthropic ? ANTHROPIC_HEADERS : OPENAI_CHAT_HEADERS,
    )
  } catch {
    // A key `Headers` refuses (a line break or a character past U+00FF inside it): nothing can be
    // sent, and the refusal, whose message quotes the key, is dropped here.
    return { ok: false, code: 'config', status: null }
  }
  let response: Response | null
  let disarm: (() => void) | undefined
  try {
    // §列表与上限: armed before the request goes out, disarmed when the headers arrive. It answers
    // even from a host whose fetch does not honour the signal.
    const late = new Promise<null>((resolve) => {
      disarm = q.clock.setTimeout(() => resolve(null), HEADERS_MS)
    })
    // 02 A5 (01 修补 4): a body that stops arriving ends as `service` once no byte came for the
    // limit the instance's own requests use, rather than leaving the list pending.
    const sent = fetchThroughHost(withoutRedirects(q.network), url, init, {
      clock: q.clock,
      idleMs: idleMsFor(vendor.baseURL),
    })
    response = await Promise.race([sent, late])
    if (response === null) {
      headersLate.abort()
      // Headers that come after all only release their body.
      void sent.then(
        (lateResponse) => lateResponse.body?.cancel().catch(() => undefined),
        () => undefined,
      )
    }
  } catch {
    q.signal?.throwIfAborted()
    // A refused egress, a dropped connection or a redirect that was not followed.
    return { ok: false, code: 'service', status: null }
  } finally {
    disarm?.()
  }
  if (response === null) {
    q.signal?.throwIfAborted()
    return { ok: false, code: 'service', status: null }
  }
  const status = response.status
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    if (status === 401 || status === 403) return { ok: false, code: 'auth', status }
    if (status === 408 || status === 429 || status >= 500) {
      return { ok: false, code: 'service', status }
    }
    return { ok: false, code: 'unsupported', status }
  }
  let text: string | null
  try {
    text = await readCapped(response.body, MAX_BODY_BYTES)
  } catch {
    // A dropped connection, or the idle watchdog.
    q.signal?.throwIfAborted()
    return { ok: false, code: 'service', status }
  }
  if (text === null) return { ok: false, code: 'unsupported', status }
  const body = parseJson(text)
  const data = isRecord(body) ? body['data'] : undefined
  if (!Array.isArray(data)) return { ok: false, code: 'unsupported', status }
  const models: RemoteModel[] = []
  const seen = new Set<string>()
  for (const item of data) {
    if (!isRecord(item)) continue
    const id = item['id']
    if (!isRowId(id) || seen.has(id)) continue
    seen.add(id)
    const contextLimit = firstPositive(CONTEXT_KEYS.map((key) => item[key]))
    const topProvider = item['top_provider']
    const maxOutputTokens = firstPositive([
      ...OUTPUT_KEYS.map((key) => item[key]),
      isRecord(topProvider) ? topProvider['max_completion_tokens'] : undefined,
    ])
    models.push({
      id,
      ...(contextLimit === null ? {} : { contextLimit }),
      ...(maxOutputTokens === null ? {} : { maxOutputTokens }),
    })
  }
  return { ok: true, models }
}

/** The wire's credential header, or none for a keyless loopback or private instance (§key). */
function credentialHeader(anthropic: boolean, apiKey: string | null): Record<string, string> {
  if (apiKey === null) return {}
  return anthropic ? { 'x-api-key': apiKey } : { authorization: `Bearer ${apiKey}` }
}

/**
 * The body as UTF-8 text (a leading BOM dropped, as `Response.text()` does), or null once more than
 * `limit` bytes arrived: the rest is never read, and the stream is cancelled (§列表与上限).
 */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string | null> {
  if (body === null) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a body is read chunk by chunk
    const step = await reader.read()
    if (step.done) return text + decoder.decode()
    bytes += step.value.byteLength
    if (bytes > limit) {
      reader.cancel().catch(() => undefined)
      return null
    }
    text += decoder.decode(step.value, { stream: true })
  }
}

function firstPositive(values: readonly unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  }
  return null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
