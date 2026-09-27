/**
 * Write (spec 02 §内置工具与参数「Write」). The executor lands with plan step 22: the whole file is
 * replaced at the real path its decision placed (§「在不在工作区里」第 5 步), once that path, resolved
 * again just before the write, still names itself (a path a link now leads away from is refused and
 * nothing is written); a missing parent folder is made first with `HostFs.mkdirp` — which is also how
 * the session's dedicated folder comes to exist (§工作区). A target that is a folder, or a parent
 * that is a file, is an execution-time failure: the call ran, is_error, `completed`
 * (§参数校验与失败「执行期失败」).
 *
 * The write is not interrupted by a stop: `HostFs` takes no AbortSignal, so one in flight finishes and
 * is recorded as it went (§点停止时各状态怎么收「进程内写操作」).
 */
import { fromParts, pathParts } from '../../host/path.js'
import type { AbsolutePath } from '../../host/adapter.js'
import { fill } from '../../prompts/index.js'
import type { ToolExecutor } from '../executor.js'
import { FILE_TEXTS, failed, stillNamesItself, succeeded } from './files.js'
import type { BuiltinTool } from './tool.js'
import { COWORK_ONLY, NOT_ABSOLUTE, absolutePathCheck } from './tool.js'

const DESCRIPTION = [
  'Writes a file to the local filesystem, replacing its whole content if it already exists.',
  'Missing parent folders are created.',
  'file_path must be an absolute path.',
  'To change part of an existing file, prefer Edit.',
].join(' ')

/** Write's result templates and its own errors (§提示层: they are part of the layer). */
export const WRITE_TEXTS = {
  notAbsolute: NOT_ABSOLUTE,
  isDirectory: FILE_TEXTS.isDirectory,
  notDirectory: FILE_TEXTS.notDirectory,
  resolvesElsewhere: FILE_TEXTS.resolvesElsewhere,
  created: 'Created {path}.',
  replaced: 'Replaced the whole content of {path}.',
  hostError: 'Writing {path} failed: {message}',
} as const

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
  texts: WRITE_TEXTS,
}

/** Writes the decision's real path, never the path as the model wrote it. */
export const writeExecutor: ToolExecutor = async (q) => {
  const path = q.target
  if (path === null) throw new Error('Write: a call reached its executor with no target path')
  const content = typeof q.input['content'] === 'string' ? q.input['content'] : ''
  try {
    if (!(await stillNamesItself(q.fs, path))) {
      return failed(fill(WRITE_TEXTS.resolvesElsewhere, { path }))
    }
    const existing = await q.fs.stat(path)
    if (existing?.isDir === true) return failed(fill(WRITE_TEXTS.isDirectory, { path }))
    const parent = parentOf(path)
    if (parent !== null) {
      const folder = await q.fs.stat(parent)
      if (folder === null) await q.fs.mkdirp(parent)
      else if (!folder.isDir) return failed(fill(WRITE_TEXTS.notDirectory, { path: parent }))
    }
    await q.fs.writeFile(path, content)
    return succeeded(fill(existing === null ? WRITE_TEXTS.created : WRITE_TEXTS.replaced, { path }))
  } catch (error) {
    return failed(fill(WRITE_TEXTS.hostError, { path, message: messageOf(error) }))
  }
}

/** The folder a path is in; null for a root. */
export function parentOf(path: AbsolutePath): AbsolutePath | null {
  const parts = pathParts(path)
  if (parts.segments.length === 0) return null
  return fromParts({ ...parts, segments: parts.segments.slice(0, -1) })
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
