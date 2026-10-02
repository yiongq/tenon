/**
 * The probe of a custom vendor's row (M6 §探测): two round trips through the instance's own Provider
 * that decide whether the row may carry tools.
 *
 * The snapshot is data stored next to its model row in `config.json` (§存储, T3) and restated by
 * contracts' `probeSnapshotSchema`; a contracts test assigns the two both ways, so a field added on
 * either side is a compile error there.
 *
 * What a probe touches (M6 不变量 8): the definition's `create()`, then that Provider's `encode()` and
 * `stream()`, which reach the world only through the `HostNetwork` handed in. It holds no Tape, no
 * tool executor and no session: the tool call ① asks for is never dispatched, and ② answers it with
 * a fixed `ok`. On the openai-chat wire the network is wrapped once more, read-only: each successful
 * response body is `tee()`d to a checker that reads the SSE events the way the decoder does, for the
 * thinking field (①) and for fields the wire cannot send back (§不认识的字段, Q14), and never past
 * what the adapter itself read. Web standard APIs only (01 spec:109).
 */
import type { HostClock, HostNetwork } from '../host/adapter.js'
import type { PolicyState } from '../host/policy.js'
import { PRODUCT_BUILTINS, builtinCandidates } from '../tools/registry.js'
import { openToolTable } from '../tools/table.js'
import { createBlockAccumulator } from './base.js'
import { customModelInfo } from './definitions/custom.js'
import type { CustomModelRow } from './definitions/custom.js'
import { ProviderConfigMissingError, ProviderInvalidArgumentError } from './errors.js'
import { thinkingModelId } from './thinking.js'
import { configuredValue } from './wire/transport.js'
import type {
  ContentBlock,
  EncodedRequest,
  InternalMessage,
  ModelInfo,
  Provider,
  ProviderDefinition,
  StreamEvent,
} from './types.js'

/** §探测「结果与原因码」: one code per row of the table, each with its own copy in both locales. */
export type ProbeReason =
  | 'no-tool-call'
  | 'output-limit'
  | 'no-finish'
  | 'config'
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'request-rejected'
  | 'echo-rejected'
  | 'bad-tool-call'
  | 'opaque-fields'
  | 'service'

export type ProbeSnapshot = {
  /** Passed; not detected (try again); failed (with a reason, and also worth another try). */
  outcome: 'passed' | 'not-detected' | 'failed'
  /** null when passed. */
  reason: ProbeReason | null
  /** `HostClock` epoch ms; shown, never compared. */
  probedAt: number
  /** The thinking field the openai-chat wire saw; always null on anthropic-messages. */
  reasoningField: NonNullable<ModelInfo['reasoningEchoField']> | null
  /**
   * The output-limit key the endpoint takes (§两步 T10): what ① learned, or the row's previous
   * snapshot's when ① ended before the endpoint answered; always null on anthropic-messages.
   */
  maxTokensField: NonNullable<ModelInfo['maxTokensField']> | null
  /** A final usage reading arrived on the standard path (T10). */
  usageSeen: boolean
  /** The model name the vendor reported, shown and never judged (Q5). */
  responseModelId: string | null
  /** Q14: the names of the fields Tenon cannot send back, never their values. */
  unknownFields: string[]
}

export interface ProbeQuery {
  /** The instance's definition: what `customVendorDefinition` made. */
  readonly definition: ProviderDefinition
  readonly row: CustomModelRow
  /** `host.network`; the probe wraps it in a read-only split of its own. */
  readonly network: HostNetwork
  readonly clock: Pick<HostClock, 'now' | 'setTimeout'>
  readonly config: Record<string, string>
  /** Read in the same settled read run-assembly uses. */
  readonly secrets: Record<string, string>
  /** What `RunAssembly.maxTokens` would give this row: the probe sets no limit of its own. */
  readonly maxTokens: number
  /** `host.policy.current()`. */
  readonly policy: PolicyState
  /** `host.identity.tenantId`. */
  readonly tenantId: string
  /** The probe's runId. */
  readonly ids: { uuid(): string }
  /** Aborted on app exit, on delete and on a key save. */
  readonly signal: AbortSignal
}

/**
 * The fixed user message of both requests (§两步「提示」): no session content ever (T4). The path
 * exists nowhere, which does not matter — the call is never run.
 */
export const PROBE_PROMPT =
  'This is a connection check. Call the Read tool exactly once with file_path ' +
  '"/tenon-probe/ping.txt", then say in one sentence what you read.'

/** The synthetic result ② answers every complete call of ① with. */
export const PROBE_TOOL_RESULT = 'ok'

/** Q14's bounds on what a snapshot records: 16 names, each cut to 64 characters. */
const MAX_UNKNOWN_FIELDS = 16
const MAX_FIELD_NAME = 64
/** `probeSnapshotSchema.responseModelId`'s bound. */
const MAX_RESPONSE_MODEL_ID = 200
/** The incarnation the probe's never-written table is keyed under. */
const PROBE_INCARNATION = '00000000-0000-4000-8000-000000000000'

/**
 * Runs the two steps (§两步, Q5) and returns the snapshot to store. Resolves for every outcome the
 * table names, `config` included (no request sent) and a ① turn ② cannot encode (`bad-tool-call`,
 * ② not sent); rejects only when `q.signal` aborts — a stop on `aborted` included — and then builds
 * no snapshot (§何时、走哪条路).
 */
export async function probeModel(q: ProbeQuery): Promise<ProbeSnapshot> {
  q.signal.throwIfAborted()
  const scan = q.definition.wire === 'openai-chat' ? createResponseScan(q.signal) : null
  try {
    return await runProbe(q, scan)
  } finally {
    scan?.close()
  }
}

interface Attempt {
  /** What the turn folds to: a call the decoder dropped (no `tool-call-end`) is not in it. */
  readonly content: ContentBlock[]
  readonly stop: Extract<StreamEvent, { type: 'stop' }> | null
  readonly error: Extract<StreamEvent, { type: 'error' }> | null
}

async function runProbe(q: ProbeQuery, scan: ResponseScan | null): Promise<ProbeSnapshot> {
  const openAIChat = q.definition.wire === 'openai-chat'
  let usageSeen = false
  let responseModelId: string | null = null
  /**
   * §两步 T10: the field ① learns — `max_completion_tokens` after the resend, `max_tokens` when ①
   * came back without an error. A probe that ends before that (nothing sent, or ① failing without
   * the resend) keeps the row's previous snapshot's, so a row that learned `max_completion_tokens`
   * does not lose it to a 429; `max_tokens` when there is none.
   */
  let maxTokensField: NonNullable<ProbeSnapshot['maxTokensField']> =
    q.row.probe?.maxTokensField ?? 'max_tokens'
  /** What ① saw; ② is built from it, so the stored snapshot says the same (M6 不变量 9). */
  let reasoningField: ProbeSnapshot['reasoningField'] = null
  const snapshot = (
    outcome: ProbeSnapshot['outcome'],
    reason: ProbeReason | null,
  ): ProbeSnapshot => ({
    outcome,
    reason,
    probedAt: q.clock.now(),
    reasoningField: openAIChat ? reasoningField : null,
    maxTokensField: openAIChat ? maxTokensField : null,
    usageSeen,
    responseModelId,
    unknownFields: [...(scan?.unknownFields ?? [])],
  })
  const failed = (reason: ProbeReason): ProbeSnapshot => snapshot('failed', reason)
  const notDetected = (reason: ProbeReason): ProbeSnapshot => snapshot('not-detected', reason)

  // §结果与原因码 `config`「发出之前」(推出): a stored key no header can carry (a line break or a
  // character past U+00FF inside it) means nothing can be sent, as the model list reads it. Whether
  // a value fits does not depend on the header's name, so this one check covers `x-api-key` too. The
  // refusal is dropped: its message quotes the key. No key: the factory decides (below).
  const key = configuredValue(q.secrets['apiKey'])
  if (key !== null && !fitsHeader(`Bearer ${key}`)) return failed('config')

  let provider: Provider
  try {
    provider = q.definition.create({
      network: scan === null ? q.network : scan.network(q.network),
      clock: q.clock,
      config: q.config,
      secrets: q.secrets,
    })
  } catch (error) {
    // Before anything is sent (§结果与原因码 `config`): a missing key, or an address the adapter
    // refuses. Anything else is a bug and stays one.
    if (
      error instanceof ProviderConfigMissingError ||
      error instanceof ProviderInvalidArgumentError
    )
      return failed('config')
    throw error
  }

  const table = probeTable(q)
  const tools = table.items.map((item) => item.spec)
  const names = new Set(table.items.map((item) => item.name))
  const runId = q.ids.uuid()
  let requestSeq = 0

  // No system, thinking, effort or temperature (T5), no requestParams (Q9), tool_choice left to the
  // encoders, which write none (auto).
  const request = (model: ModelInfo, messages: InternalMessage[]): EncodedRequest =>
    provider.encode({ model, messages, tools, maxTokens: q.maxTokens })
  const send = async (model: ModelInfo, encoded: EncodedRequest): Promise<Attempt> => {
    requestSeq += 1
    const fold = createBlockAccumulator({
      provider: provider.id,
      providerModel: thinkingModelId(model),
    })
    let stop: Attempt['stop'] = null
    let error: Attempt['error'] = null
    const identity = { runId, requestSeq, physicalAttempt: 1 }
    for await (const event of provider.stream(encoded, { signal: q.signal, identity })) {
      fold.apply(event)
      if (event.type === 'usage' && event.usage.final) usageSeen = true
      else if (event.type === 'response-model' && responseModelId === null) {
        responseModelId = event.modelId.slice(0, MAX_RESPONSE_MODEL_ID)
      } else if (event.type === 'stop') stop = event
      else if (event.type === 'error') error = event
    }
    // The checker's copy of this response is read as far as the adapter read it before anything
    // is judged on it.
    await scan?.settle()
    if (q.signal.aborted || stop?.reason === 'aborted') {
      q.signal.throwIfAborted()
      throw new DOMException('the probe was aborted', 'AbortError')
    }
    return { content: fold.content(), stop, error }
  }

  // ① — the row as it stands, tools on (no history yet, so the echo format moves no byte).
  const ask: InternalMessage = { role: 'user', content: [{ type: 'text', text: PROBE_PROMPT }] }
  const { probe: _previous, ...bare } = q.row
  let first: ModelInfo = { ...customModelInfo(q.definition, bare), supportsToolCalling: true }
  // ①'s body is fixed data (the prompt, the table, the row): a throw from its encode is a bug.
  let one = await send(first, request(first, [ask]))
  if (openAIChat && scan?.found() !== true && rejectsMaxTokens(one.error)) {
    // T10: resent once under the field the error named; refused again, it is judged as it stands.
    first = { ...first, maxTokensField: 'max_completion_tokens' }
    one = await send(first, request(first, [ask]))
    maxTokensField = 'max_completion_tokens'
  } else if (one.error === null) {
    // The endpoint took `max_tokens` (§两步 T10).
    maxTokensField = 'max_tokens'
  }
  reasoningField = scan?.reasoningField ?? null
  // Q14 first: a response with fields the wire would drop is never a pass, whatever else it says.
  if (scan?.found() === true) return failed('opaque-fields')
  // §结果与原因码 `bad-tool-call`: the anthropic-messages wire reports a tool_use whose input is not
  // a JSON object as an error, where the openai-chat decoder drops the call; both are no complete
  // call, not the service failing.
  if (!openAIChat && one.error?.providerCode === 'malformed_tool_input') {
    return failed('bad-tool-call')
  }
  if (one.error !== null) return failed(errorReason(one.error, 'request-rejected'))
  if (one.stop?.reason === 'max-tokens') return notDetected('output-limit')
  const calls = one.content.filter(
    (block): block is Extract<ContentBlock, { type: 'tool-request' }> =>
      block.type === 'tool-request',
  )
  if (calls.length === 0) {
    return one.stop?.reason === 'tool-use' ? failed('bad-tool-call') : notDetected('no-tool-call')
  }
  // §结果与原因码 `bad-tool-call`: no complete call (above), or a call outside the table. A call the
  // decoder dropped beside a complete one is not in `calls`, and ② answers the complete ones only
  // (§两步 ②「给 ① 的每个完整调用各一个」).
  if (calls.some((call) => !names.has(call.name))) return failed('bad-tool-call')

  // ② — the row a pass would store, sent with ①'s turn and a synthetic result for each call.
  const assumed: ProbeSnapshot = snapshot('passed', null)
  const second = customModelInfo(q.definition, { ...q.row, probe: assumed })
  let echo: EncodedRequest
  try {
    echo = request(second, [
      ask,
      { role: 'assistant', content: one.content },
      {
        role: 'user',
        content: calls.map((call) => ({
          type: 'tool-response' as const,
          id: call.id,
          content: [{ type: 'text' as const, text: PROBE_TOOL_RESULT }],
          isError: false,
        })),
      },
    ])
  } catch (error) {
    // §结果与原因码: ①'s turn holds what the encoder refuses to carry back (a tool input or a vendor
    // block canonicalJson refuses: a `toJSON` key, nesting past 100 levels) — Tenon cannot send the
    // call back, so ② is not sent.
    if (error instanceof ProviderInvalidArgumentError) return failed('bad-tool-call')
    throw error
  }
  const two = await send(second, echo)
  if (scan?.found() === true) return failed('opaque-fields')
  if (two.error !== null) return failed(errorReason(two.error, 'echo-rejected'))
  if (two.stop?.reason === 'end-turn' || two.stop?.reason === 'tool-use') {
    return snapshot('passed', null)
  }
  if (two.stop?.reason === 'max-tokens') return notDetected('output-limit')
  return notDetected('no-finish')
}

/**
 * The table the task profile would freeze on this instance (§两步「公共部分」): the product's builtin
 * candidates, through the table's own exclusions and the definition's cap, with no search backend —
 * so WebSearch is `no-search-backend`, as it always is on an instance (Q10). Opened, never written
 * (no `view/tool_table`): the key it carries names a fixed incarnation only because a key needs one.
 */
function probeTable(q: ProbeQuery): ReturnType<typeof openToolTable> {
  return openToolTable({
    providerId: q.definition.id,
    incarnationId: PROBE_INCARNATION,
    generation: 0,
    reason: 'first-use',
    candidates: builtinCandidates({
      profile: 'cowork',
      available: (name) => PRODUCT_BUILTINS.has(name),
      search: null,
    }),
    policy: q.policy,
    tenantId: q.tenantId,
    userSetting: () => null,
    hasSearchBackend: false,
    toolsPerRequest: q.definition.maxToolsPerRequest ?? null,
  })
}

/** Whether `Headers` takes this value; its refusal, which quotes the value, is never surfaced. */
function fitsHeader(value: string): boolean {
  try {
    return new Headers([['authorization', value]]).has('authorization')
  } catch {
    return false
  }
}

/**
 * T10's one retry: a 400 `invalid-request` that names the other field — OpenAI's
 * `unsupported_parameter` about `max_tokens`, or a message carrying both names ("Unsupported
 * parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.").
 * A 400 that names only `max_tokens` (out of range, over the window) is the request being refused,
 * and is not retried.
 */
function rejectsMaxTokens(error: Attempt['error']): boolean {
  if (error === null || error.code !== 'invalid-request' || error.status !== 400) return false
  // The code alone is not enough: OpenAI sends it for any parameter (`tools` included), and a resend
  // records `max_completion_tokens` for a row whose endpoint never refused `max_tokens` (§两步 T10).
  // 'max_completion_tokens' does not contain 'max_tokens', so both arms need the field named.
  if (error.providerCode === 'unsupported_parameter' && error.detail.includes('max_tokens')) {
    return true
  }
  return error.detail.includes('max_tokens') && error.detail.includes('max_completion_tokens')
}

/**
 * An error event's code (§结果与原因码). 402 comes before `invalid-request`, and a 429 the vocabulary
 * read as `invalid-request` (Bailian's throttling `insufficient_quota`) is a rate limit here, though
 * the runtime keeps reading it as `invalid-request` (T11).
 */
function errorReason(
  error: Extract<StreamEvent, { type: 'error' }>,
  refused: 'request-rejected' | 'echo-rejected',
): ProbeReason {
  if (error.status === 402) return 'quota'
  if (error.status === 429 && error.code === 'invalid-request') return 'rate-limit'
  switch (error.code) {
    case 'auth':
      return 'auth'
    case 'quota-exhausted':
      return 'quota'
    case 'rate-limit':
      return 'rate-limit'
    case 'invalid-request':
    case 'context-overflow':
    case 'account-config':
      return refused
    case 'overloaded':
    case 'server':
    case 'network':
    case 'egress-denied':
    case 'unknown':
      return 'service'
  }
}

// -------------------------------------------------------------------------------------------------
// The read-only split (§何时、走哪条路; §不认识的字段)
// -------------------------------------------------------------------------------------------------

/**
 * §不认识的字段: the keys the openai-chat decoder reads, without the tool call's `custom` (a call
 * carrying it is skipped, so it cannot round-trip) and with `role` and the participant `name` (MiniMax
 * sends `name: "MiniMax AI"` on every frame), which need no echo.
 */
const MESSAGE_KEYS: ReadonlySet<string> = new Set([
  'role',
  'name',
  'content',
  'reasoning_content',
  'reasoning',
  'tool_calls',
])
const TOOL_CALL_KEYS: ReadonlySet<string> = new Set(['index', 'id', 'type', 'function'])
/** A byte-order mark: the SDK decodes each SSE line on its own, dropping one from its start. */
const BOM = '\uFEFF'
const FUNCTION_KEYS: ReadonlySet<string> = new Set(['name', 'arguments'])

interface ResponseScan {
  /** `inner`, with every successful response body split to the checker. */
  network(inner: HostNetwork): HostNetwork
  /** Every body split so far, read as far as the adapter read it. */
  settle(): Promise<void>
  /** The first thinking field seen with text in it. */
  readonly reasoningField: ProbeSnapshot['reasoningField']
  /** In order of first appearance, at most 16, each cut to 64 characters. */
  readonly unknownFields: readonly string[]
  /** A method, not a getter: it changes while the probe runs. */
  found(): boolean
  /** Cancels whatever is still being read (an abort, or the probe being over). */
  close(): void
}

/** One response body, split between the adapter and the checker. */
interface Split {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>
  /** Bytes the adapter's side has pulled. */
  adapterBytes: number
  /** Bytes the checker has read. */
  scanBytes: number
  /** `settle()` ran: the adapter is done with this body, so the checker reads no further than it. */
  bounded: boolean
  /** The checker is parked in `read()`. */
  waiting: boolean
}

/**
 * The checker (§何时、走哪条路; §不认识的字段): it judges exactly what the openai-chat decoder reads.
 * It parses whole SSE events as the SDK's decoder does — the `data:` lines of one event joined with
 * "\n", one leading byte-order mark dropped from each line (the SDK decodes line by line), an event
 * still open when the body ends flushed — stops at the `[DONE]` event after which the decoder reads
 * nothing, and never waits for bytes the adapter did not get: the adapter's own cancel bounds it, so
 * a vendor that keeps the body open after `[DONE]` (whatever its line endings), or a body the adapter
 * stopped reading at its idle watchdog, cannot hold the probe (or the instance's probe lock) open.
 * An error response is not split: its body has no `choices`, and the adapter reads it alone.
 */
function createResponseScan(signal: AbortSignal): ResponseScan {
  const unknown: string[] = []
  let reasoningField: ProbeSnapshot['reasoningField'] = null
  const reads: Promise<void>[] = []
  const splits = new Set<Split>()
  const cancelAll = (): void => {
    for (const split of splits) split.reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancelAll, { once: true })

  const note = (key: string): void => {
    const name = key.slice(0, MAX_FIELD_NAME)
    if (unknown.length < MAX_UNKNOWN_FIELDS && !unknown.includes(name)) unknown.push(name)
  }
  const checkKeys = (object: Record<string, unknown>, known: ReadonlySet<string>): void => {
    for (const [key, value] of Object.entries(object)) {
      if (!known.has(key) && present(value)) note(key)
    }
  }
  /**
   * §不认识的字段: `choices[*].delta` of an SSE event, `choices[*].message` of a body that came back
   * whole — only that one object per choice: the other is a choice-level key the decoder never reads
   * there, as `logprobs` is.
   */
  const inspect = (chunk: unknown, key: 'delta' | 'message'): void => {
    if (!isRecord(chunk)) return
    // The decoder reads `chunk.choices?.[0]`, which also finds a `choices` sent as an object keyed
    // "0" (M6 不变量 10): an array is read whole (§不认识的字段 `choices[*]`), a record where the
    // decoder reads it.
    const choices = chunk['choices']
    const list = Array.isArray(choices) ? choices : isRecord(choices) ? [choices['0']] : []
    for (const [at, choice] of list.entries()) {
      if (!isRecord(choice)) continue
      const message = choice[key]
      if (!isRecord(message)) continue
      if (at === 0 && reasoningField === null) {
        // §两步 ①: the decoder's own expression (wire/openai-chat.ts) on the one choice it reads,
        // and the key it took the text from.
        const text = message['reasoning_content'] ?? message['reasoning']
        if (typeof text === 'string' && text !== '') {
          reasoningField = message['reasoning_content'] != null ? 'reasoning_content' : 'reasoning'
        }
      }
      checkKeys(message, MESSAGE_KEYS)
      const calls = message['tool_calls']
      if (!Array.isArray(calls)) continue
      for (const call of calls) {
        if (!isRecord(call)) continue
        checkKeys(call, TOOL_CALL_KEYS)
        const fn = call['function']
        if (isRecord(fn)) checkKeys(fn, FUNCTION_KEYS)
      }
    }
  }
  const read = async (split: Split): Promise<void> => {
    const { reader } = split
    // The BOM is dropped per line in line(), as the SDK's per-line decode drops it.
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    let carry = ''
    /** The `data:` values of the event being read. */
    let data: string[] = []
    /** The `[DONE]` event arrived: nothing after it is the decoder's, so nothing is judged. */
    let done = false
    let sawData = false
    /** The body as text until a `data:` line shows it is a stream, for one that came back whole. */
    let whole = ''
    const dispatch = (): void => {
      if (data.length === 0) return
      const payload = data.join('\n')
      data = []
      if (payload === '[DONE]') {
        done = true
        return
      }
      // An event that does not parse is skipped: a broken frame is the adapter's to report.
      const parsed = parseJson(payload)
      if (parsed !== undefined) inspect(parsed, 'delta')
    }
    const line = (raw: string): void => {
      const text = raw.startsWith(BOM) ? raw.slice(1) : raw
      // A blank line ends an event; a line starting with ':' is a comment.
      if (text === '') return dispatch()
      if (text.startsWith(':')) return
      const colon = text.indexOf(':')
      if ((colon === -1 ? text : text.slice(0, colon)) !== 'data') return
      const value = colon === -1 ? '' : text.slice(colon + 1)
      sawData = true
      whole = ''
      data.push(value.startsWith(' ') ? value.slice(1) : value)
    }
    /**
     * The open line's later pieces, joined only once a line break arrives: re-joining and re-splitting
     * the whole open line on every chunk would cost the square of its length (the SDK's decoder only
     * searches the new bytes).
     */
    let pending: string[] = []
    /** A '\r' ended the last chunk: it may be the first half of a '\r\n' still on its way. */
    let heldCR = false
    const take = (text: string, end: boolean): void => {
      if (!sawData) whole += text
      if (!end && !heldCR && !/[\r\n]/.test(text)) {
        pending.push(text)
        return
      }
      let buffer = carry + pending.join('') + (heldCR ? '\r' : '') + text
      pending = []
      heldCR = !end && buffer.endsWith('\r')
      if (heldCR) buffer = buffer.slice(0, -1)
      const lines = buffer.split(/\r\n|\r|\n/)
      carry = lines.pop() ?? ''
      for (const each of lines) {
        line(each)
        if (done) return
      }
    }
    try {
      for (;;) {
        if (split.bounded && split.scanBytes >= split.adapterBytes) break
        split.waiting = true
        // oxlint-disable-next-line no-await-in-loop -- a body is read chunk by chunk
        const step = await reader.read()
        split.waiting = false
        // A chunk that arrived after settle() cut the split is past what the adapter had.
        if (step.done || (split.bounded && split.scanBytes >= split.adapterBytes)) break
        split.scanBytes += step.value.byteLength
        take(decoder.decode(step.value, { stream: true }), false)
        if (done) return
      }
      // The body ended, or the adapter stopped reading it: like the decoder, the last line and an
      // event without its closing blank line still count.
      take(decoder.decode(), true)
      if (done) return
      if (carry !== '') line(carry)
      dispatch()
      if (!sawData) {
        const parsed = parseJson(whole.startsWith(BOM) ? whole.slice(1) : whole)
        if (parsed !== undefined) inspect(parsed, 'message')
      }
    } catch {
      // A body that failed or was cancelled is the adapter's to report; what was read still counts.
    } finally {
      split.waiting = false
      splits.delete(split)
      // Releases this side of the split, so the adapter's own cancel can complete.
      reader.cancel().catch(() => undefined)
    }
  }

  return {
    network: (inner) => ({
      fetch: async (input, init) => {
        const response = await inner.fetch(input, init)
        if (response.body === null || !response.ok) return response
        const [forAdapter, forScan] = response.body.tee()
        const split: Split = {
          reader: forScan.getReader(),
          adapterBytes: 0,
          scanBytes: 0,
          bounded: false,
          waiting: false,
        }
        splits.add(split)
        reads.push(read(split))
        return new Response(counted(forAdapter, split), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      },
      fetchUntrusted: (input, init) => inner.fetchUntrusted(input, init),
    }),
    async settle(): Promise<void> {
      for (const split of splits) bound(split)
      await Promise.all(reads)
    },
    get reasoningField() {
      return reasoningField
    },
    get unknownFields() {
      return unknown
    },
    found(): boolean {
      return unknown.length > 0
    },
    close(): void {
      signal.removeEventListener('abort', cancelAll)
      cancelAll()
    },
  }
}

/**
 * The adapter is done with this body: the checker reads no further than the adapter did, and one
 * parked with everything the adapter had already read has nothing more to wait for.
 */
function bound(split: Split): void {
  split.bounded = true
  if (split.waiting && split.scanBytes >= split.adapterBytes) {
    split.reader.cancel().catch(() => undefined)
  }
}

/**
 * The adapter's side of a split, counting the bytes it pulls (pull-driven: nothing read ahead). Its
 * cancel bounds the checker first: a `tee()` branch's cancel completes only once the other branch is
 * cancelled too, so a checker still parked in `read()` (a line ending it holds back, say) would
 * otherwise hold the adapter's cancel, and with it the probe.
 */
function counted(body: ReadableStream<Uint8Array>, split: Split): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const step = await reader.read()
        if (step.done) {
          controller.close()
          return
        }
        split.adapterBytes += step.value.byteLength
        controller.enqueue(step.value)
      },
      cancel: (reason) => {
        bound(split)
        return reader.cancel(reason)
      },
    },
    { highWaterMark: 0 },
  )
}

/** A key whose value is null, '', [] or {} has not appeared (§不认识的字段). */
function present(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
