/** Edit (spec 02 §内置工具与参数「Edit」). The executor arrives in plan step 22. */
import type { BuiltinTool } from './tool.js'
import { COWORK_ONLY, absolutePathCheck } from './tool.js'

const DESCRIPTION = [
  'Replaces text in an existing file.',
  'old_string must appear in the file exactly once, unless replace_all is true, in which case every occurrence is replaced.',
  'Copy old_string from the file itself: the line-number prefix that Read puts on each line is not part of the file and must not be included.',
  'file_path must be an absolute path.',
].join(' ')

/** Fixed English for the one check the schema cannot state (§参数校验与失败). */
export const EDIT_SAME_STRINGS =
  'old_string and new_string are the same, so there is nothing to change.'

export const EDIT_TOOL: BuiltinTool = {
  name: 'Edit',
  spec: () => ({
    name: 'Edit',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path of the file to change.' },
        old_string: { type: 'string', minLength: 1, description: 'The text to replace.' },
        new_string: { type: 'string', description: 'The text to put in its place.' },
        replace_all: {
          type: 'boolean',
          default: false,
          description: 'Replace every occurrence of old_string instead of exactly one.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  }),
  effect: 'write',
  profiles: COWORK_ONLY,
  check: (args) =>
    absolutePathCheck(args, 'file_path') ??
    (args['old_string'] === args['new_string'] ? EDIT_SAME_STRINGS : null),
}
