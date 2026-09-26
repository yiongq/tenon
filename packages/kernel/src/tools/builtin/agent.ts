/** Agent (spec 02 §内置工具与参数, §子 agent 契约). The executor arrives in plan step 31. */
import type { BuiltinTool } from './tool.js'
import { COWORK_ONLY, noChecks } from './tool.js'

const DESCRIPTION = [
  'Starts a sub-agent that works on a self-contained task in a session of its own and returns a report of what it did, call by call, ending with its last reply.',
  'It runs in the foreground: this conversation waits until it is done.',
  'It does not see this conversation, so the prompt must say everything it needs.',
  'It cannot ask the user questions or start sub-agents of its own.',
].join(' ')

export const AGENT_TOOL: BuiltinTool = {
  name: 'Agent',
  spec: () => ({
    name: 'Agent',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          minLength: 1,
          description: 'What the sub-agent is for, in three to five words.',
        },
        prompt: {
          type: 'string',
          minLength: 1,
          description: 'The complete task for the sub-agent.',
        },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    },
  }),
  // 暂定 (§内置工具与参数, owner 2026-09-25): a sub-agent reaches beyond this session.
  effect: 'external',
  profiles: COWORK_ONLY,
  check: noChecks,
}
