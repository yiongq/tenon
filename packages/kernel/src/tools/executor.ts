/**
 * Running an allowed call (spec 02 §一批工具怎么执行, §工具来源、命名与权限键). An executor gets the
 * frozen table's item and the model's input, and returns the result's content, whether it is an
 * error, and the execution state.
 *
 * Connector tools are dispatched as `connection.callTool(originalName, args)` on the Run's MCP source
 * for that server (plan step 13); the tests have a fake builtin executor; the real builtin executors
 * land with their tools in `BUILTIN_EXECUTORS` — Read, Glob and Grep with plan step 18, Write, Edit
 * and Bash with step 22. A frozen tool
 * with no executor in this build — a server gone, an implementation removed — closes as
 * `tool-unavailable`, with its definition still in the table (E2).
 */
import type { AbsolutePath, FetchLike, HostClock, HostFs } from '../host/adapter.js'
import { McpServerUnavailableError, McpUnauthorizedError } from '../mcp/connection.js'
import type { McpToolSource } from '../loop/ports.js'
import type { ExecutionState, ResultContent } from '../loop/closure.js'
import type { PathScope } from '../permission/workspace.js'
import { MODEL_NOTES, fill } from '../prompts/index.js'
import { canonicalJson } from '../tape/canonical-json.js'
import type { BuiltinToolName } from './builtin/tool.js'
import { isBuiltinToolName } from './builtin/index.js'
import { bashExecutor } from './builtin/bash.js'
import type { CommandRun } from './builtin/bash.js'
import { editExecutor } from './builtin/edit.js'
import { globExecutor } from './builtin/glob.js'
import { grepExecutor } from './builtin/grep.js'
import { readExecutor } from './builtin/read.js'
import { writeExecutor } from './builtin/write.js'
import { webFetchExecutor } from './builtin/web-fetch.js'
import type { SearchBackend } from './search/types.js'
import { webSearchExecutor } from './builtin/web-search.js'
import type { ToolTableItem } from './registry.js'

export interface ToolExecution {
  readonly searchHitUrls?: readonly string[]
  readonly content: ResultContent
  readonly isError: boolean
  readonly state: ExecutionState
  /**
   * Why a call that did not complete ended, when the stop is not why: Bash's timeout or a host
   * refusal before WebFetch could connect (§原因码表 `timed-out`, `protected`). The batch writes that code's note, `content` as its second block.
   */
  readonly source?: 'timed-out' | 'protected' | 'tool-unavailable' | 'connector-unauthorized'
  readonly kernelAuthored?: boolean
  /** Host refusal after dispatch: the network boundary's blocked target. */
  readonly facts?: Readonly<Record<string, string>>
}

export interface ExecuteQuery {
  readonly search?: SearchBackend
  readonly item: ToolTableItem
  readonly input: Record<string, unknown>
  readonly signal: AbortSignal
  /**
   * Where a file tool acts: the real path its decision placed — the folder Glob and Grep search when
   * `path` is omitted (§「在不在工作区里」第 5 步). Null for every other tool.
   */
  readonly target: AbsolutePath | null
  /**
   * Where the call's paths were judged from (§「在不在工作区里」): a walk follows no link that leads
   * outside the roots, and skips what the scope places `protected` (§内置工具的默认档位).
   */
  readonly scope: PathScope
  readonly fs: HostFs
  /**
   * The Run's host clock: Grep reads its time budget and its turns of the event loop from it
   * (§内置工具与参数「时限」).
   */
  readonly clock: HostClock
  /**
   * What Bash runs with (§内置工具与参数「Bash」), its base environment awaited before the dispatch;
   * absent for every other tool.
   */
  readonly command?: CommandRun
  /** WebFetch only: one-hop host egress and the in-memory permission recheck for redirects. */
  readonly webFetch?: {
    readonly fetch: FetchLike
    readonly canFollow: (url: string) => Promise<boolean>
  }
}

export type ToolExecutor = (q: ExecuteQuery) => Promise<ToolExecution>

/** The builtin executors this build has: each lands with its tool (plan steps 18, 22, 26–31). */
export const BUILTIN_EXECUTORS: Readonly<Partial<Record<BuiltinToolName, ToolExecutor>>> = {
  Read: readExecutor,
  Write: writeExecutor,
  Edit: editExecutor,
  Bash: bashExecutor,
  Glob: globExecutor,
  Grep: grepExecutor,
  WebFetch: webFetchExecutor,
  WebSearch: webSearchExecutor,
}

/**
 * The tests' stand-in for a builtin tool (`TestToolRegistry` value `'fake'`): it does nothing and
 * says what it was asked, so a case can tell calls apart.
 */
export const fakeExecutor: ToolExecutor = (q) =>
  Promise.resolve({
    content: [{ type: 'text', text: `fake ${q.item.originalName} ${canonicalJson(q.input)}` }],
    isError: false,
    state: 'completed',
  })

/**
 * A connector call. A `callTool` that throws — an elicitation the client refuses, a result the SDK
 * cannot read, a server gone — is an is_error result of a call that did run (§工具来源、命名与权限键
 * 「elicitation 一律拒绝」). Content the model can read is kept; anything else becomes its JSON. Both
 * fixed texts come from the prompt layer (§提示层「规则与位置」), so its hash covers them.
 */
export function mcpExecutor(source: McpToolSource): ToolExecutor {
  return async (q) => {
    try {
      const result = await source.connection.callTool(q.item.originalName, q.input, {
        signal: q.signal,
        timeoutMs: 60_000,
        onprogress: () => {},
        resetTimeoutOnProgress: true,
        maxTotalTimeoutMs: 600_000,
      })
      return {
        content: mcpContent(result.content as unknown[]),
        isError: result.isError === true,
        state: 'completed',
      }
    } catch (error) {
      if (q.signal.aborted) return { state: 'uncertain', content: [], isError: true }
      if (error instanceof McpServerUnavailableError || error instanceof McpUnauthorizedError) {
        const failureSource =
          error instanceof McpUnauthorizedError ? 'connector-unauthorized' : 'tool-unavailable'
        return {
          state: 'not-run',
          content: [],
          isError: true,
          source: failureSource,
          kernelAuthored: true,
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: fill(MODEL_NOTES.connectorFailed, { message }) }],
        isError: true,
        state: 'completed',
      }
    }
  }
}

const IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

function mcpContent(blocks: readonly unknown[] | undefined): ResultContent {
  const content: ResultContent = []
  for (const block of blocks ?? []) {
    const b = block as Record<string, unknown>
    if (b['type'] === 'text' && typeof b['text'] === 'string') {
      content.push({ type: 'text', text: b['text'] })
    } else if (
      b['type'] === 'image' &&
      typeof b['data'] === 'string' &&
      typeof b['mimeType'] === 'string' &&
      IMAGE_TYPES.has(b['mimeType'])
    ) {
      content.push({
        type: 'image',
        mediaType: b['mimeType'] as Extract<ResultContent[number], { type: 'image' }>['mediaType'],
        data: b['data'],
      })
    } else {
      content.push({ type: 'text', text: canonicalJson(block) })
    }
  }
  return content.length > 0 ? content : [{ type: 'text', text: MODEL_NOTES.connectorEmpty }]
}

/**
 * Which executor runs an item: its server's source for a connector tool, and for a builtin the one
 * the registry names — `'fake'` (a missing key under a test registry), `'real'` (the landed
 * executor), `null` (none). Without a test registry, the build's own executor. Null means the call
 * closes as `tool-unavailable`.
 */
export function executorFor(q: {
  readonly item: ToolTableItem
  readonly mcpSources: readonly McpToolSource[]
  readonly testTools: Readonly<Partial<Record<BuiltinToolName, 'fake' | 'real' | null>>> | null
}): ToolExecutor | null {
  const { item } = q
  if (item.source === 'mcp') {
    const source = q.mcpSources.find((candidate) => candidate.serverId === item.serverId)
    return source === undefined ? null : mcpExecutor(source)
  }
  if (!isBuiltinToolName(item.originalName)) return null
  const name = item.originalName
  if (q.testTools === null) return BUILTIN_EXECUTORS[name] ?? null
  const choice = Object.hasOwn(q.testTools, name) ? q.testTools[name] : 'fake'
  if (choice === 'fake') return fakeExecutor
  if (choice === 'real') return BUILTIN_EXECUTORS[name] ?? null
  return null
}
