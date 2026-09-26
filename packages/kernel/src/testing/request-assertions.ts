/**
 * Request-body assertions for what a provider actually sent. Each one takes a `RecordedRequest`
 * off `fakeNetwork` — as its `checkRequest`, or on `net.requests` afterwards — and throws a
 * `RequestAssertionError` listing every violation it found:
 *
 *   assertToolPairing         02 不变量 23: each client tool call has exactly one result, before
 *                             the next user text (spec 02 §工具调用的收口)
 *   assertLastTurnIsUser      02 不变量 2: the request ends on a user turn
 *   assertHeaderNamesAllowed  02 不变量 3: every header name is inside an allowed set, which the
 *                             caller passes (the whitelist function itself is plan step 7)
 *   assertImagesInline        02 不变量 10: images only as base64 or `data:` URLs
 *
 * The wire is read off the URL path, as the adapters split it (`requestWire`): `…/messages` is
 * anthropic-messages, `…/chat/completions` is openai-chat. The two wire-bound assertions throw
 * on any other path rather than pass it — a `checkRequest` that also sees non-model requests (a
 * search backend) filters on `requestWire(request) !== null` first.
 *
 * Messages name indexes, ids and header NAMES only, never a header value: that is where a
 * credential would be.
 */
import type { RecordedRequest } from './fake-network.js'

export class RequestAssertionError extends Error {
  /** One line per violation, in body order. */
  readonly problems: readonly string[]

  constructor(assertion: string, request: RecordedRequest, problems: readonly string[]) {
    super(`${assertion} (${request.method} ${request.url}):\n  - ${problems.join('\n  - ')}`)
    this.name = 'RequestAssertionError'
    this.problems = problems
  }
}

export type RequestWire = 'anthropic-messages' | 'openai-chat'

/** Which wire a recorded request is on, from its URL path; null for anything else. */
export function requestWire(request: RecordedRequest): RequestWire | null {
  let path: string
  try {
    path = new URL(request.url).pathname
  } catch {
    return null
  }
  if (path.endsWith('/messages')) return 'anthropic-messages'
  if (path.endsWith('/chat/completions')) return 'openai-chat'
  return null
}

/**
 * Every client tool call is followed by exactly one result, placed before the next user text.
 *
 * - anthropic-messages: each `tool_use` of an assistant turn is answered by one `tool_result` in
 *   the user message(s) right after it (consecutive user messages are one turn to this API), and
 *   every `tool_result` there comes before the turn's first other block.
 * - openai-chat: each `tool_calls[]` entry is answered by one `role: 'tool'` message in the run of
 *   tool messages right after the assistant message.
 *
 * Both ways round: a result that answers no call right before it fails too. Server-executed calls
 * are not client calls and need no result: `server_tool_use` / `mcp_tool_use` blocks, a `tool_use`
 * whose `caller` is not direct, a `tool_calls[]` entry of `type: 'mcp'`.
 */
export function assertToolPairing(request: RecordedRequest): void {
  const { wire, messages } = modelRequest('assertToolPairing', request)
  const problems =
    wire === 'anthropic-messages' ? anthropicPairing(messages) : openAIPairing(messages)
  if (problems.length > 0) throw new RequestAssertionError('assertToolPairing', request, problems)
}

/**
 * The last message is a user turn. On openai-chat a user turn made of tool results is encoded as
 * `role: 'tool'` messages, so a trailing tool message counts as the user's.
 */
export function assertLastTurnIsUser(request: RecordedRequest): void {
  const { wire, messages } = modelRequest('assertLastTurnIsUser', request)
  const last = messages.at(-1)
  const role = isObject(last) ? last['role'] : undefined
  const userRoles = wire === 'openai-chat' ? ['user', 'tool'] : ['user']
  if (userRoles.includes(String(role))) return
  const problem =
    last === undefined
      ? 'there are no messages'
      : `messages[${messages.length - 1}] is ${JSON.stringify(role)}, not a user turn`
  throw new RequestAssertionError('assertLastTurnIsUser', request, [problem])
}

/** The names a request may carry: a set or list (any casing), or a predicate on lowercase names. */
export type AllowedHeaderNames =
  | ReadonlySet<string>
  | readonly string[]
  | ((name: string) => boolean)

/** Every header name the request carried is allowed. Any request, not only model requests. */
export function assertHeaderNamesAllowed(
  request: RecordedRequest,
  allowed: AllowedHeaderNames,
): void {
  const allows = typeof allowed === 'function' ? allowed : lowercaseMembership(allowed)
  const refused = Object.keys(request.headers)
    .map((name) => name.toLowerCase())
    .filter((name) => !allows(name))
    .toSorted()
  if (refused.length === 0) return
  throw new RequestAssertionError(
    'assertHeaderNamesAllowed',
    request,
    refused.map((name) => `header ${name} is not allowed`),
  )
}

/**
 * Images travel inline only: every Anthropic `image` block has a `base64` source (no `url`, no
 * `file`), every OpenAI `image_url` is a `data:` URL. Searched anywhere in the body, tool results
 * included. A request without a JSON body has no images and passes.
 */
export function assertImagesInline(request: RecordedRequest): void {
  const problems: string[] = []
  visitObjects(request.body, 'body', (node, path) => {
    if (node['type'] === 'image') {
      const source = node['source']
      const kind = isObject(source) ? source['type'] : undefined
      if (kind !== 'base64') {
        problems.push(`${path}: image source is ${JSON.stringify(kind)}, not base64`)
      }
    } else if (node['type'] === 'image_url') {
      const image = node['image_url']
      const url = typeof image === 'string' ? image : isObject(image) ? image['url'] : undefined
      if (typeof url !== 'string' || !url.startsWith('data:')) {
        problems.push(`${path}: image_url is not a data: URL`)
      }
    }
  })
  if (problems.length > 0) throw new RequestAssertionError('assertImagesInline', request, problems)
}

type JsonObject = Readonly<Record<string, unknown>>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function modelRequest(
  assertion: string,
  request: RecordedRequest,
): { wire: RequestWire; messages: readonly unknown[] } {
  const wire = requestWire(request)
  if (wire === null) {
    throw new RequestAssertionError(assertion, request, [
      'not a model request: the path ends in neither /messages nor /chat/completions',
    ])
  }
  const messages = isObject(request.body) ? request.body['messages'] : undefined
  if (!Array.isArray(messages)) {
    throw new RequestAssertionError(assertion, request, ['the body has no messages array'])
  }
  return { wire, messages }
}

/** A message's content as blocks; string content is one text block. */
function blocksOf(message: JsonObject): readonly JsonObject[] {
  const content = message['content']
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter(isObject) : []
}

/** `caller` absent is the direct shape: the field is newer than the wire (anthropic-messages.ts). */
function isDirectCaller(caller: unknown): boolean {
  return caller == null || (isObject(caller) && caller['type'] === 'direct')
}

function anthropicPairing(messages: readonly unknown[]): string[] {
  const problems: string[] = []
  const answered = new Set<JsonObject>()
  messages.forEach((message, i) => {
    if (!isObject(message) || message['role'] !== 'assistant') return
    const known = new Set<string>()
    const calls: string[] = []
    blocksOf(message).forEach((block, k) => {
      // server_tool_use / mcp_tool_use carry their own result block types, never tool_result.
      if (block['type'] !== 'tool_use') return
      const id = String(block['id'])
      if (known.has(id)) problems.push(`messages[${i}].content[${k}] repeats tool_use id ${id}`)
      known.add(id)
      if (isDirectCaller(block['caller'])) calls.push(id)
    })
    const counts = new Map<string, number>()
    let otherBlockAt: string | null = null
    for (let j = i + 1; j < messages.length; j += 1) {
      const next = messages[j]
      if (!isObject(next) || next['role'] !== 'user') break
      blocksOf(next).forEach((block, k) => {
        const where = `messages[${j}].content[${k}]`
        if (block['type'] !== 'tool_result') {
          otherBlockAt ??= where
          return
        }
        const id = String(block['tool_use_id'])
        if (!known.has(id)) return // left for the orphan sweep below
        answered.add(block)
        if (otherBlockAt !== null) {
          problems.push(`${where}: tool_result ${id} comes after user content at ${otherBlockAt}`)
        }
        counts.set(id, (counts.get(id) ?? 0) + 1)
      })
    }
    for (const id of calls) problems.push(...countProblem(`messages[${i}]`, 'tool_use', id, counts))
  })
  messages.forEach((message, j) => {
    if (!isObject(message)) return
    blocksOf(message).forEach((block, k) => {
      if (block['type'] !== 'tool_result' || answered.has(block)) return
      problems.push(
        `messages[${j}].content[${k}]: tool_result ${String(block['tool_use_id'])} answers ` +
          'no tool_use of the assistant turn right before it',
      )
    })
  })
  return problems
}

function openAIPairing(messages: readonly unknown[]): string[] {
  const problems: string[] = []
  const answered = new Set<number>()
  messages.forEach((message, i) => {
    if (!isObject(message) || message['role'] !== 'assistant') return
    const toolCalls = message['tool_calls']
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return
    const known = new Set<string>()
    const calls: string[] = []
    toolCalls.forEach((call, k) => {
      if (!isObject(call)) return
      const id = String(call['id'])
      if (known.has(id)) problems.push(`messages[${i}].tool_calls[${k}] repeats id ${id}`)
      known.add(id)
      // Zhipu's vendor-run MCP calls are answered by the vendor, not by a tool message.
      if (call['type'] !== 'mcp') calls.push(id)
    })
    const counts = new Map<string, number>()
    for (let j = i + 1; j < messages.length; j += 1) {
      const next = messages[j]
      if (!isObject(next) || next['role'] !== 'tool') break
      const id = String(next['tool_call_id'])
      if (!known.has(id)) continue // left for the orphan sweep below
      answered.add(j)
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    for (const id of calls)
      problems.push(...countProblem(`messages[${i}]`, 'tool_call', id, counts))
  })
  messages.forEach((message, j) => {
    if (!isObject(message) || message['role'] !== 'tool' || answered.has(j)) return
    problems.push(
      `messages[${j}]: tool message ${String(message['tool_call_id'])} answers no tool_call ` +
        'of the assistant message right before its run of tool messages',
    )
  })
  return problems
}

function countProblem(
  where: string,
  kind: string,
  id: string,
  counts: ReadonlyMap<string, number>,
): string[] {
  const count = counts.get(id) ?? 0
  if (count === 1) return []
  return [
    count === 0
      ? `${where}: ${kind} ${id} has no result before the next user text`
      : `${where}: ${kind} ${id} has ${count} results`,
  ]
}

function lowercaseMembership(names: Iterable<string>): (name: string) => boolean {
  const set = new Set<string>()
  for (const name of names) set.add(name.toLowerCase())
  return (name) => set.has(name)
}

function visitObjects(
  value: unknown,
  path: string,
  visit: (node: JsonObject, path: string) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => visitObjects(item, `${path}[${i}]`, visit))
    return
  }
  if (!isObject(value)) return
  visit(value, path)
  for (const [key, child] of Object.entries(value)) visitObjects(child, `${path}.${key}`, visit)
}
