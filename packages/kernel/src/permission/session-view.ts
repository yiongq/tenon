/**
 * What an inspector sees (spec 02 §挂点与会话视图): the call, and a read-only view of the session
 * computed from the tape — never accumulated in memory, and never holding a tool result's text.
 *
 * Plan step 9 declared these, because `InspectorRegistration` references them; plan step 12 computes
 * the view. Its fields only ever grow.
 *
 * Everything is read by SOURCE, never by scanning content (F10, F5): a result counts as untrusted
 * because WebSearch or WebFetch produced it; a call counts because it was dispatched (it has an
 * `execution/dispatch_committed`), not because it was asked for. The range is the current
 * incarnation from `session/start` on, compaction anchors ignored and retracted calls counted.
 */
import type { AbsolutePath, Reversibility } from '../host/adapter.js'
import { isWithin, isAbsolutePath, normalizePath } from '../host/path.js'
import type { TapeEntry } from '../tape/entry.js'
import type { ToolTableItem } from '../tools/registry.js'

export interface InspectedCall {
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
  readonly untrustedSources: readonly string[] // 结果来自不可信来源的工具名，去重；02 里只可能是 WebSearch、WebFetch
  readonly touchedPrivateData: boolean // 定义见 §外带检查
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
  const calls = new Map<string, TapeEntry>()
  for (const entry of entries) {
    if (entry.name === 'tool/call') calls.set(callKey(entry), entry)
  }
  const nonReadOnlyCalls: { toolName: string; reversibility: Reversibility }[] = []
  const untrusted = new Set<string>()
  let touchedPrivateData = false
  for (const dispatch of entries.filter((entry) => entry.name === 'execution/dispatch_committed')) {
    const name = String(dispatch.payload['name'] ?? '')
    const decision = byKey.get(String(dispatch.payload['decisionKey'] ?? ''))
    const reversibility = (decision?.payload['reversibility'] ?? 'unknown') as Reversibility
    if (reversibility !== 'read-only') nonReadOnlyCalls.push({ toolName: name, reversibility })
    if (name === 'WebSearch' || name === 'WebFetch') untrusted.add(name)
    if (q.profile === 'cowork' && privateRead(name, calls.get(callKey(dispatch)), q.ownSpillDir)) {
      touchedPrivateData = true
    }
  }
  const view: SessionView = {
    firstUserText: q.child === true ? '' : (texts[0] ?? ''),
    recentUserTexts: q.child === true ? [] : texts.slice(-RECENT_USER_TEXTS),
    nonReadOnlyCalls,
    untrustedSources: [...untrusted],
    touchedPrivateData,
  }
  if (q.call.tool.source !== 'builtin' || q.call.tool.originalName !== 'WebFetch') return view
  return {
    ...view,
    fetchUrlVouched: vouched(q.call.args['url'], q.child === true ? [] : texts, entries),
  }
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
 * A dispatched call that reads private data (§外带检查「碰过私有数据」): any Bash, or a Read or Grep
 * whose target is not under the session's own spill directory. Glob returns paths only and does not
 * count. A Grep without a path searches the workspace.
 */
function privateRead(
  name: string,
  call: TapeEntry | undefined,
  ownSpillDir: AbsolutePath,
): boolean {
  if (name === 'Bash') return true
  if (name !== 'Read' && name !== 'Grep') return false
  const input = call?.payload['input'] as Record<string, unknown> | undefined
  const target = input?.[name === 'Read' ? 'file_path' : 'path']
  if (typeof target !== 'string' || !isAbsolutePath(target)) return true
  return !isWithin(normalizePath(target), ownSpillDir)
}

/** A call's identity across its tool/ and execution/ facts: (runId, requestSeq, ordinal). */
function callKey(entry: TapeEntry): string {
  return `${String(entry.sourceId)}:${String(entry.sourceSeq)}:${String(entry.payload['ordinal'])}`
}
