/** Write (spec 02 §内置工具与参数「Write」). The executor arrives in plan step 22. */
import type { BuiltinTool } from './tool.js'
import { COWORK_ONLY, NOT_ABSOLUTE, absolutePathCheck } from './tool.js'

const DESCRIPTION = [
  'Writes a file to the local filesystem, replacing its whole content if it already exists.',
  'Missing parent folders are created.',
  'file_path must be an absolute path.',
  'To change part of an existing file, prefer Edit.',
].join(' ')

export const WRITE_TOOL: BuiltinTool = {
  name: 'Write',
  spec: () => ({
    name: 'Write',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path of the file to write.' },
        content: { type: 'string', description: 'The whole content of the file.' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
  }),
  effect: 'write',
  profiles: COWORK_ONLY,
  check: (args) => absolutePathCheck(args, 'file_path'),
  texts: { notAbsolute: NOT_ABSOLUTE },
}
