/**
 * Edit (spec 02 §内置工具与参数「Edit」). The executor lands with plan step 22: `old_string` is
 * replaced only when it occurs exactly once, or every occurrence with `replace_all` (sdk-tools:854),
 * at the real path its decision placed (§「在不在工作区里」第 5 步). A target that is missing or a
 * folder, an `old_string` not found, or one that is not unique without `replace_all`, is an
 * execution-time failure: the call ran, is_error, `completed` (§参数校验与失败「执行期失败」).
 *
 * The file is read as UTF-8 and written back as UTF-8, so a file that is not valid UTF-8 is refused
 * rather than rewritten with U+FFFD where its bad bytes were; a byte order mark is kept.
 */
import { fill } from '../../prompts/index.js'
import type { ToolExecutor } from '../executor.js'
import {
  BINARY_SNIFF_BYTES,
  FILE_READ_MAX_BYTES,
  FILE_TEXTS,
  checkSignal,
  failed,
  succeeded,
  whenThrown,
} from './files.js'
import type { BuiltinTool } from './tool.js'
import { COWORK_ONLY, NOT_ABSOLUTE, absolutePathCheck } from './tool.js'
import { messageOf } from './write.js'

const DESCRIPTION = [
  'Replaces text in an existing file.',
  'old_string must appear in the file exactly once, unless replace_all is true, in which case every occurrence is replaced.',
  'Copy old_string from the file itself: the line-number prefix that Read puts on each line is not part of the file and must not be included.',
  'file_path must be an absolute path.',
].join(' ')

/** Fixed English for the one check the schema cannot state (§参数校验与失败). */
export const EDIT_SAME_STRINGS =
  'old_string and new_string are the same, so there is nothing to change.'

/** Edit's result templates and its own errors (§提示层: they are part of the layer). */
export const EDIT_TEXTS = {
  notAbsolute: NOT_ABSOLUTE,
  sameStrings: EDIT_SAME_STRINGS,
  notFound: FILE_TEXTS.notFound,
  isDirectory: FILE_TEXTS.isDirectory,
  notText: FILE_TEXTS.notText,
  tooLarge: FILE_TEXTS.tooLarge,
  hostError: FILE_TEXTS.hostError,
  notUtf8: '{path} is not valid UTF-8 text, so Edit cannot change it without changing other bytes.',
  noMatch: 'old_string was not found in {path}. Read the file again and copy old_string exactly.',
  notUnique:
    'old_string occurs {count} times in {path}. Include more of the surrounding text so it occurs once, or set replace_all to true.',
  edited: 'Edited {path}: replaced the one occurrence of old_string.',
  editedAll: 'Edited {path}: replaced all {count} occurrences of old_string.',
  writeError: 'Writing {path} failed: {message}',
} as const

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
  texts: EDIT_TEXTS,
}

/** Changes the decision's real path, never the path as the model wrote it. */
export const editExecutor: ToolExecutor = async (q) => {
  const path = q.target
  if (path === null) throw new Error('Edit: a call reached its executor with no target path')
  const oldString = String(q.input['old_string'])
  const newString = String(q.input['new_string'])
  const replaceAll = q.input['replace_all'] === true
  let text: string
  try {
    const stat = await q.fs.stat(path)
    checkSignal(q.signal)
    if (stat === null) return failed(fill(EDIT_TEXTS.notFound, { path }))
    if (stat.isDir) return failed(fill(EDIT_TEXTS.isDirectory, { path }))
    if (stat.size > FILE_READ_MAX_BYTES) {
      const slots = { path, bytes: String(stat.size), max: String(FILE_READ_MAX_BYTES) }
      return failed(fill(EDIT_TEXTS.tooLarge, slots))
    }
    const data = await q.fs.readFile(path)
    checkSignal(q.signal)
    const decoded = decodeForEdit(data)
    if (decoded === 'binary') return failed(fill(EDIT_TEXTS.notText, { path }))
    if (decoded === 'not-utf8') return failed(fill(EDIT_TEXTS.notUtf8, { path }))
    text = decoded.text
  } catch (error) {
    return whenThrown(error, path)
  }
  const pieces = text.split(oldString)
  const count = pieces.length - 1
  if (count === 0) return failed(fill(EDIT_TEXTS.noMatch, { path }))
  if (count > 1 && !replaceAll) {
    return failed(fill(EDIT_TEXTS.notUnique, { path, count: String(count) }))
  }
  try {
    // Joined, not `replace`: new_string goes in as written, `$&` and the rest included.
    await q.fs.writeFile(path, pieces.join(newString))
  } catch (error) {
    return failed(fill(EDIT_TEXTS.writeError, { path, message: messageOf(error) }))
  }
  return succeeded(
    count === 1
      ? fill(EDIT_TEXTS.edited, { path })
      : fill(EDIT_TEXTS.editedAll, { path, count: String(count) }),
  )
}

/** A file's text as Edit may rewrite it: strict UTF-8 with the byte order mark kept; else why not. */
function decodeForEdit(data: Uint8Array | string): { text: string } | 'binary' | 'not-utf8' {
  if (typeof data === 'string') {
    return data.slice(0, BINARY_SNIFF_BYTES).includes('\0') ? 'binary' : { text: data }
  }
  if (data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return 'binary'
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) }
  } catch {
    return 'not-utf8'
  }
}
