/** Glob (spec 02 §内置工具与参数「Glob、Grep」). The executor arrives in plan step 18. */
import type { BuiltinTool } from './tool.js'
import { COWORK_ONLY, absolutePathCheck } from './tool.js'

const DESCRIPTION = [
  'Finds files whose paths match a glob pattern, such as `**/*.ts` or `src/**/test_*.py`.',
  'It searches under path, or under the first workspace folder when path is omitted.',
  'Matching paths are returned sorted by path.',
].join(' ')

export const GLOB_TOOL: BuiltinTool = {
  name: 'Glob',
  spec: () => ({
    name: 'Glob',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', minLength: 1, description: 'The glob pattern to match.' },
        path: {
          type: 'string',
          description:
            'The absolute path of the folder to search. Omit it to search the workspace.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  }),
  effect: 'read',
  profiles: COWORK_ONLY,
  check: (args) => absolutePathCheck(args, 'path'),
}
