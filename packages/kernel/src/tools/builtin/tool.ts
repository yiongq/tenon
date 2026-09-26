/**
 * The shape every builtin tool module exports (spec 02 §内置工具与参数). The names, parameter names
 * and meanings follow `@anthropic-ai/claude-agent-sdk` 0.3.281 `sdk-tools.d.ts`; the descriptions are
 * Tenon's own (H7). A parameter the table does not take is not in the schema, and no schema has a
 * field for the model to rate its own danger or ask for a looser mode (E4).
 *
 * Descriptions, result templates and fixed error texts are part of the prompt layer (§提示层): they
 * live in their tool's module and are versioned with it.
 */
import { isAbsolutePath } from '../../host/path.js'
import type { ToolSpec } from '../../provider/types.js'
import type { SideEffectClass } from '../../tape/entry.js'

export type BuiltinToolName =
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'Bash'
  | 'Glob'
  | 'Grep'
  | 'Agent'
  | 'AskUserQuestion'
  | 'WebSearch'
  | 'WebFetch'

/** The two session profiles phase 2 has (H1). */
export type ToolProfile = 'chat' | 'cowork'

export interface BuiltinTool {
  readonly name: BuiltinToolName
  /**
   * The definition sent to the provider. `domainFilter` is the search backend's: only WebSearch
   * reads it (its two domain parameters exist only when the backend supports them, H8).
   */
  spec(o: { readonly domainFilter: boolean }): ToolSpec
  /** What `execution/tool_outcome.effect` records once it is dispatched; undispatched is `blocked`. */
  readonly effect: Exclude<SideEffectClass, 'blocked'>
  /** The profiles whose candidate set holds it (H1). */
  readonly profiles: readonly ToolProfile[]
  /**
   * The checks beyond the schema that need no disk (§内置工具与参数「参数校验与失败」): the fixed
   * English sent back as the reason, or null when the arguments pass. Only called on arguments the
   * schema already accepted.
   */
  check(args: Readonly<Record<string, unknown>>): string | null
}

/** Both profiles: the chat profile's four tools. */
export const BOTH_PROFILES: readonly ToolProfile[] = ['chat', 'cowork']
/** The cowork profile only. */
export const COWORK_ONLY: readonly ToolProfile[] = ['cowork']

/** A tool with no checks beyond its schema. */
export function noChecks(): string | null {
  return null
}

/** The fixed reason for a path argument that is not absolute; null when it is or is absent. */
export function absolutePathCheck(
  args: Readonly<Record<string, unknown>>,
  key: 'file_path' | 'path',
): string | null {
  const value = args[key]
  if (value === undefined) return null
  return typeof value === 'string' && isAbsolutePath(value)
    ? null
    : `${key} must be an absolute path.`
}
