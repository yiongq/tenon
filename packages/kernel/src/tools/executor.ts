/**
 * Running an allowed call (spec 02 §一批工具怎么执行, §工具来源、命名与权限键). An executor gets the
 * frozen table's item and the model's input, and returns the result's content, whether it is an
 * error, and the execution state.
 *
 * Plan step 13 has two: connector tools, dispatched as `connection.callTool(originalName, args)` on
 * the Run's MCP source for that server; and the tests' fake builtin executor. The real builtin
 * executors land with their tools (plan steps 18 onward) in `BUILTIN_EXECUTORS`. A frozen tool with
 * no executor in this build — a server gone, an implementation removed — closes as
 * `tool-unavailable`, with its definition still in the table (E2).
 */
import type { McpToolSource } from '../loop/ports.js'
import type { ExecutionState, ResultContent } from '../loop/closure.js'
import { canonicalJson } from '../tape/canonical-json.js'
import type { BuiltinToolName } from './builtin/tool.js'
import { isBuiltinToolName } from './builtin/index.js'
import type { ToolTableItem } from './registry.js'

export interface ToolExecution {
  readonly content: ResultContent
  readonly isError: boolean
  readonly state: Exclude<ExecutionState, 'not-run'>
}

export interface ExecuteQuery {
  readonly item: ToolTableItem
  readonly input: Record<string, unknown>
  readonly signal: AbortSignal
}

export type ToolExecutor = (q: ExecuteQuery) => Promise<ToolExecution>

/** The builtin executors this build has. Empty until the tools land (plan steps 18, 22, 26–31). */
export const BUILTIN_EXECUTORS: Readonly<Partial<Record<BuiltinToolName, ToolExecutor>>> = {}

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
 * 「elicitation 一律拒绝」). Content the model can read is kept; anything else becomes its JSON.
 */
export function mcpExecutor(source: McpToolSource): ToolExecutor {
  return async (q) => {
    try {
      const result = await source.connection.callTool(q.item.originalName, q.input)
      return {
        content: mcpContent(result.content as unknown[]),
        isError: result.isError === true,
        state: 'completed',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `The tool call failed: ${message}` }],
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
  return content.length > 0 ? content : [{ type: 'text', text: '(no output)' }]
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
