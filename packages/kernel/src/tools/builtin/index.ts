/**
 * The ten builtin tools (spec 02 §内置工具与参数), one name set for every provider. Keyed by name, in
 * the table's order; the tool table sorts by name anyway (E2).
 */
import { AGENT_TOOL } from './agent.js'
import { ASK_USER_QUESTION_TOOL } from './ask-user-question.js'
import { BASH_TOOL } from './bash.js'
import { EDIT_TOOL } from './edit.js'
import { GLOB_TOOL } from './glob.js'
import { GREP_TOOL } from './grep.js'
import { READ_TOOL } from './read.js'
import type { BuiltinTool, BuiltinToolName } from './tool.js'
import { WEB_FETCH_TOOL } from './web-fetch.js'
import { WEB_SEARCH_TOOL } from './web-search.js'
import { WRITE_TOOL } from './write.js'

export const BUILTIN_TOOLS: Readonly<Record<BuiltinToolName, BuiltinTool>> = {
  Read: READ_TOOL,
  Write: WRITE_TOOL,
  Edit: EDIT_TOOL,
  Bash: BASH_TOOL,
  Glob: GLOB_TOOL,
  Grep: GREP_TOOL,
  Agent: AGENT_TOOL,
  AskUserQuestion: ASK_USER_QUESTION_TOOL,
  WebSearch: WEB_SEARCH_TOOL,
  WebFetch: WEB_FETCH_TOOL,
}

export const BUILTIN_TOOL_NAMES: readonly BuiltinToolName[] = Object.keys(
  BUILTIN_TOOLS,
) as BuiltinToolName[]

export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return Object.hasOwn(BUILTIN_TOOLS, name)
}
