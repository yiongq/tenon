/** Read (spec 02 §内置工具与参数「Read」). The executor arrives in plan step 18. */
import type { BuiltinTool } from './tool.js'
import { BOTH_PROFILES, absolutePathCheck } from './tool.js'

const DESCRIPTION = [
  'Reads a text file from the local filesystem.',
  'file_path must be an absolute path.',
  'Each line of the result starts with its line number (from 1) and a tab; that prefix is not part of the file.',
  'By default it reads from the first line. A result has a size limit: when it stops before the end of the file, it says how many lines the file has and which offset to continue from.',
  'Give offset and limit only for a file too large to read at once.',
].join(' ')

export const READ_TOOL: BuiltinTool = {
  name: 'Read',
  spec: () => ({
    name: 'Read',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path of the file to read.' },
        offset: {
          type: 'integer',
          minimum: 1,
          description: 'The line number to start reading from; 1 is the first line.',
        },
        limit: { type: 'integer', minimum: 1, description: 'How many lines to read.' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  }),
  effect: 'read',
  profiles: BOTH_PROFILES,
  check: (args) => absolutePathCheck(args, 'file_path'),
}
