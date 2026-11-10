/**
 * What an inspector sees (spec 02 §挂点与会话视图): the call, and a read-only view of the session
 * computed from the tape — never accumulated in memory, and never holding a tool result's text.
 *
 * Plan step 9 declared these, because `InspectorRegistration` references them; plan step 12 computes
 * the view. Its fields only ever grow.
 *
 * Everything is read by SOURCE, never by scanning content (F10, F5): a result counts as untrusted
 * because WebSearch, WebFetch or a connector produced it; a call counts because it was dispatched
 * (it has an `execution/dispatch_committed`), not because it was asked for. The range is the current
 * incarnation from `session/start` on, compaction anchors ignored and retracted calls counted.
 */
import type { AbsolutePath, Reversibility } from '../host/adapter.js'
import type {
  PermissionDecidedPayload,
  TapeEntry,
  ToolOrigin,
  ToolTablePayload,
  ViewAssembledPayload,
} from '../tape/entry.js'
import type { ToolTableItem } from '../tools/registry.js'

export interface InspectedCall {
  readonly canReachNetwork?: boolean // Bash only; sampled live, never part of SessionView
  readonly tool: Pick<ToolTableItem, 'name' | 'source' | 'serverId' | 'originalName'> // §内置工具与工具来源；serverId 供第 1 层按 (serverId, originalName) 匹配规则
  readonly args: Readonly<Record<string, unknown>>
  readonly reversibility: Reversibility // host 判定（E1）
}

export interface BeforeCallInput {
  readonly call: InspectedCall
  readonly view: SessionView
}

export interface SessionView {
  readonly firstUserText: string // 你最初的请求：第一条真人 message/user 的文本块；子会话里为 ''
  readonly recentUserTexts: readonly string[] // 最近几条真人 message/user 的文本块，旧→新；暂取 8 条，待校准
  readonly nonReadOnlyCalls: readonly {
    readonly toolName: string
    readonly reversibility: Reversibility
  }[] // 已派发、可逆性不是 read-only 的调用
  readonly untrustedSources: readonly string[] // WebSearch / WebFetch、mcp:<serverId>、unresolved:<name>，去重
  readonly privateSources: readonly string[] // local、mcp:<serverId>、unresolved:<name>，去重
  readonly touchedPrivateData: boolean // = privateSources 非空
  readonly fetchUrlVouched?: boolean // 只在 WebFetch 调用时有：URL 出现在本会话真人 message/user 里，或在本会话 WebSearch 结果的 searchHitUrls 里；子会话只算父、子两边的 searchHitUrls
}

export interface AfterResultInput {
  readonly call: InspectedCall
  readonly result: { readonly isError: boolean; readonly bytes: number; readonly text?: string } // text 只给 WebSearch、WebFetch
}

export interface ResultMarker {
  readonly code: string // 例：'looks-like-injection'、'private-data'
}

/** How many of the latest human messages the view carries (暂定, to be calibrated). */
export const RECENT_USER_TEXTS = 8

export interface SessionViewQuery {
  readonly call: InspectedCall
  readonly profile: 'chat' | 'cowork'
  /** The session's own `tool-output/<sessionId>/`, resolved: reads there are not private data. */
  readonly ownSpillDir: AbsolutePath
  /**
   * A sub-agent session: its first `message/user` is the parent model's prompt, not a person's, so it
   * has no human texts (the parent's searches are merged in with plan step 31).
   */
  readonly child?: boolean
}

/** The view one call is judged with, from the session's facts in Tape order. */
export function buildSessionView(entries: readonly TapeEntry[], q: SessionViewQuery): SessionView {
  const texts = humanTexts(entries)
  const byKey = new Map(entries.map((entry) => [entry.provenanceKey, entry]))
  const outcomes = new Map(
    entries
      .filter((entry) => entry.name === 'execution/tool_outcome')
      .map((entry) => [callKey(entry), entry]),
  )
  const assembledByRequest = new Map<string, TapeEntry>()
  const toolTables = new Map<string, TapeEntry>()
  for (const entry of entries) {
    // Retain the first matching fact, just as the former per-dispatch find did.
    if (entry.name === 'view/assembled') {
      const key = `${entry.sourceId}:${entry.sourceSeq}`
      if (!assembledByRequest.has(key)) assembledByRequest.set(key, entry)
    } else if (entry.name === 'view/tool_table' && !toolTables.has(entry.provenanceKey)) {
      toolTables.set(entry.provenanceKey, entry)
    }
  }
  const nonReadOnlyCalls: { toolName: string; reversibility: Reversibility }[] = []
  const untrusted = new Set<string>()
  const privateSources = new Set<string>()
  for (const dispatch of entries.filter((entry) => entry.name === 'execution/dispatch_committed')) {
    const name = String(dispatch.payload['name'] ?? '')
    const decision = byKey.get(String(dispatch.payload['decisionKey'] ?? ''))
    const reversibility = (decision?.payload['reversibility'] ?? 'unknown') as Reversibility
    if (reversibility !== 'read-only') nonReadOnlyCalls.push({ toolName: name, reversibility })
    const origin = originOf(assembledByRequest, toolTables, dispatch)
    if (origin === null || origin.source === 'mcp') {
      const source = origin === null ? `unresolved:${name}` : `mcp:${origin.serverId}`
      untrusted.add(source)
      privateSources.add(source)
      continue
    }
    const outcome = outcomes.get(callKey(dispatch))
    // DNS refusal is recorded after dispatch, but is still a protected, not-run call (F5).
    const dnsBlocked =
      origin.originalName === 'WebFetch' &&
      outcome?.payload['state'] === 'not-run' &&
      outcome.payload['source'] === 'protected'
    if (['WebSearch', 'WebFetch'].includes(origin.originalName) && !dnsBlocked) {
      untrusted.add(origin.originalName)
    }
    if (q.profile === 'cowork' && privateRead(origin.originalName, decision)) {
      privateSources.add('local')
    }
  }
  const view: SessionView = {
    firstUserText: q.child === true ? '' : (texts[0] ?? ''),
    recentUserTexts: q.child === true ? [] : texts.slice(-RECENT_USER_TEXTS),
    nonReadOnlyCalls,
    untrustedSources: [...untrusted],
    privateSources: [...privateSources],
    touchedPrivateData: privateSources.size > 0,
  }
  if (q.call.tool.source !== 'builtin' || q.call.tool.originalName !== 'WebFetch') return view
  return {
    ...view,
    fetchUrlVouched: vouched(q.call.args['url'], q.child === true ? [] : texts, entries),
  }
}

/** Resolve a dispatch through its request's frozen tool table, never through its name alone. */
function originOf(
  assembledByRequest: ReadonlyMap<string, TapeEntry>,
  toolTables: ReadonlyMap<string, TapeEntry>,
  dispatch: TapeEntry,
): ToolOrigin | null {
  const assembled = assembledByRequest.get(`${dispatch.sourceId}:${dispatch.sourceSeq}`)
  const tools = (assembled?.payload as ViewAssembledPayload | undefined)?.tools
  if (tools == null) return null
  const table = toolTables.get(tools.tableKey)
  return (
    (table?.payload as ToolTablePayload | undefined)?.tools.find(
      (tool) => tool.name === dispatch.payload['name'],
    ) ?? null
  )
}

/**
 * The URLs a message's text holds (§外带检查「豁免」): a fragment starting with `http://` or `https://`,
 * case-insensitive, up to the first whitespace, full-width punctuation, `<>"'` or backtick, then with
 * `.,;:!?)]}` stripped from its end again and again. A fragment without a scheme is not a URL here.
 */
export function urlsInText(text: string): string[] {
  const urls: string[] = []
  for (const match of text.matchAll(
    /https?:\/\/[^\s，。、；：！？（）【】「」《》“”‘’<>"'`]+/giu,
  )) {
    let url = match[0]
    while (/[.,;:!?)\]}]$/u.test(url)) url = url.slice(0, -1)
    urls.push(url)
  }
  return urls
}

/** Both sides parsed as WHATWG URLs, the fragment dropped, `href` compared exactly. */
export function comparableUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.href
  } catch {
    return null
  }
}

function vouched(url: unknown, texts: readonly string[], entries: readonly TapeEntry[]): boolean {
  if (typeof url !== 'string') return false
  const target = comparableUrl(url)
  if (target === null) return false
  const known = new Set<string>()
  for (const text of texts) {
    for (const candidate of urlsInText(text)) {
      const href = comparableUrl(candidate)
      if (href !== null) known.add(href)
    }
  }
  for (const entry of entries) {
    if (entry.name !== 'tool/result') continue
    const hits = entry.payload['searchHitUrls']
    if (!Array.isArray(hits)) continue
    for (const hit of hits) {
      const href = typeof hit === 'string' ? comparableUrl(hit) : null
      if (href !== null) known.add(href)
    }
  }
  return known.has(target)
}

/**
 * The text of every human message, oldest first: `message/user` only (not the continuation or
 * environment notes), the latest revision of each message in the place it first appeared.
 */
function humanTexts(entries: readonly TapeEntry[]): string[] {
  const texts = new Map<string, string>()
  for (const entry of entries) {
    if (entry.name !== 'message/user') continue
    const id = String(entry.payload['messageId'] ?? entry.entryId)
    const content = entry.payload['content']
    const text = Array.isArray(content)
      ? content
          .filter(
            (block): block is { type: 'text'; text: string } =>
              typeof block === 'object' &&
              block !== null &&
              (block as { type?: unknown }).type === 'text',
          )
          .map((block) => block.text)
          .join('\n')
      : ''
    texts.set(id, text)
  }
  return [...texts.values()]
}

/**
 * A dispatched private read: any Bash, or Read/Grep unless its referenced decision placed its real
 * target in the session's own spill directory. Glob returns paths only and never counts.
 */
function privateRead(name: string, decision: TapeEntry | undefined): boolean {
  if (name === 'Bash') return true
  if (name !== 'Read' && name !== 'Grep') return false
  // The referenced decision classified the real target. Raw input can name a symlink, and a
  // resumed call stays pinned to the answered card's target even if a later recheck loosens.
  const record = (decision?.payload as PermissionDecidedPayload | undefined)?.record
  return !record?.steps.some(
    (step) => step.by === 'protected' && step.said === 'allow' && step.status === 'ok',
  )
}

/** A call's identity across its tool/ and execution/ facts: (runId, requestSeq, ordinal). */
function callKey(entry: TapeEntry): string {
  return `${String(entry.sourceId)}:${String(entry.sourceSeq)}:${String(entry.payload['ordinal'])}`
}
