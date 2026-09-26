/**
 * Glob (spec 02 §内置工具与参数「Glob、Grep」). The executor lands with plan step 18: in process, over
 * `HostFs`, sorted by path in code units, following no link that leads outside the workspace (暂定).
 */
import { fill } from '../../prompts/index.js'
import type { ToolExecutor } from '../executor.js'
import { FILE_TEXTS, failed, globToRegExp, succeeded, walkFiles, whenThrown } from './files.js'
import type { BuiltinTool } from './tool.js'
import { COWORK_ONLY, NOT_ABSOLUTE, absolutePathCheck } from './tool.js'

const DESCRIPTION = [
  'Finds files whose paths match a glob pattern, such as `**/*.ts` or `src/**/test_*.py`.',
  'It searches under path, or under the first workspace folder when path is omitted.',
  'Matching paths are returned sorted by path.',
].join(' ')

/** At most this many paths come back; the note says when there were more. */
export const GLOB_RESULT_LIMIT = 1000

/** Glob's result texts and its own errors (§提示层). */
export const GLOB_TEXTS = {
  notAbsolute: NOT_ABSOLUTE,
  ...FILE_TEXTS,
  none: 'No files matched.',
  over: 'More than {limit} files matched; only the first {limit} by path are shown. Narrow the pattern or the path to see the rest.',
  invalidPattern: '{pattern} is not a glob pattern Glob can read: {message}',
} as const

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
  texts: GLOB_TEXTS,
}

/** Walks the decision's real path: `path`, or the first workspace folder. */
export const globExecutor: ToolExecutor = async (q) => {
  if (q.target === null) throw new Error('Glob: a call reached its executor with no target path')
  const pattern = String(q.input['pattern'] ?? '')
  let matcher: RegExp
  try {
    matcher = globToRegExp(pattern)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failed(fill(GLOB_TEXTS.invalidPattern, { pattern, message }))
  }
  try {
    const stat = await q.fs.stat(q.target)
    if (stat === null) return failed(fill(GLOB_TEXTS.notFound, { path: q.target }))
    if (!stat.isDir) return failed(fill(GLOB_TEXTS.notDirectory, { path: q.target }))
    const files = await walkFiles(q.fs, q.target, q.roots, q.signal)
    const matched = files.filter((file) => matcher.test(file.relative)).map((file) => file.path)
    if (matched.length === 0) return succeeded(GLOB_TEXTS.none)
    if (matched.length <= GLOB_RESULT_LIMIT) return succeeded(matched.join('\n'))
    const note = fill(GLOB_TEXTS.over, { limit: String(GLOB_RESULT_LIMIT) })
    return succeeded(`${matched.slice(0, GLOB_RESULT_LIMIT).join('\n')}\n\n${note}`)
  } catch (error) {
    return whenThrown(error, q.target)
  }
}
