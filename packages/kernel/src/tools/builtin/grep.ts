/** Grep (spec 02 §内置工具与参数「Glob、Grep」). The executor arrives in plan step 18. */
import type { BuiltinTool } from './tool.js'
import { COWORK_ONLY, absolutePathCheck } from './tool.js'

const DESCRIPTION = [
  'Searches file contents with a regular expression, using ripgrep syntax.',
  'It searches under path, or under the first workspace folder when path is omitted; glob and type narrow the files searched.',
  'output_mode is files_with_matches by default (the paths of matching files); content shows the matching lines, and count the number of matches per file.',
  '-n (line numbers, on by default), -o, -A, -B, -C and context apply to content mode only.',
  'head_limit caps the entries returned (default 250, 0 for no limit) and offset skips entries first.',
].join(' ')

const flag = (description: string): Record<string, unknown> => ({ type: 'boolean', description })
const lines = (description: string): Record<string, unknown> => ({
  type: 'integer',
  minimum: 0,
  description,
})

export const GREP_TOOL: BuiltinTool = {
  name: 'Grep',
  spec: () => ({
    name: 'Grep',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          minLength: 1,
          description: 'The regular expression to search for.',
        },
        path: {
          type: 'string',
          description:
            'The absolute path of the file or folder to search. Omit it to search the workspace.',
        },
        glob: {
          type: 'string',
          description: 'Only search files matching this glob, such as `*.ts`.',
        },
        type: {
          type: 'string',
          description: 'Only search files of this ripgrep type, such as `py`.',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'What to return (default files_with_matches).',
        },
        '-i': flag('Match case-insensitively.'),
        '-n': flag('Show line numbers (content mode; default true).'),
        '-o': flag('Show only the matching part of each line (content mode).'),
        '-A': lines('Lines of context after each match (content mode).'),
        '-B': lines('Lines of context before each match (content mode).'),
        '-C': lines('Lines of context before and after each match (content mode).'),
        context: lines('The same as -C.'),
        head_limit: lines('Return at most this many entries (default 250; 0 for no limit).'),
        offset: lines('Skip this many entries first (default 0).'),
        multiline: flag('Let the pattern match across lines (default false).'),
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  }),
  effect: 'read',
  profiles: COWORK_ONLY,
  check: (args) => absolutePathCheck(args, 'path'),
}
