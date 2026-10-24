/** Spec 05 §Delete 工具: remove one leaf, with the parent resolved and the leaf left literal. */
import { pathParts } from '../../host/path.js'
import { deleteLeafPath, resolvePath } from '../../permission/workspace.js'
import { fill } from '../../prompts/index.js'
import type { ToolExecutor } from '../executor.js'
import { snapshotGuard } from '../snapshot-guard.js'
import { ABORTED, FILE_TEXTS, failed, succeeded } from './files.js'
import type { BuiltinTool } from './tool.js'
import { COWORK_ONLY, NOT_ABSOLUTE, absolutePathCheck } from './tool.js'
import { messageOf, parentOf } from './write.js'

/** Delete's result templates and errors (§提示层: they are part of the layer). */
export const DELETE_TEXTS = {
  notAbsolute: NOT_ABSOLUTE,
  notFound: FILE_TEXTS.notFound,
  isDirectory: FILE_TEXTS.isDirectory,
  parentChanged: 'The parent folder changed after approval. Nothing was deleted.',
  targetChanged: 'The file or link changed after approval. Nothing was deleted.',
  deleted: 'Deleted {path}.',
  hostError: 'Deleting {path} failed: {message}',
} as const

export const DELETE_TOOL: BuiltinTool = {
  name: 'Delete',
  spec: () => ({
    name: 'Delete',
    description:
      'Deletes one file or symbolic link from the local filesystem. Does not delete directories or follow the symbolic link target. file_path must be an absolute path.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path of the file or symbolic link to delete.',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  }),
  effect: 'write',
  profiles: COWORK_ONLY,
  check: (args) => absolutePathCheck(args, 'file_path'),
  texts: DELETE_TEXTS,
}

export const deleteExecutor: ToolExecutor = async (q) => {
  const path = q.target
  if (path === null) throw new Error('Delete requires its approved target')
  let fileMutationAttempted = false
  try {
    if (q.deleteAmbiguous === true) return failed(DELETE_TEXTS.targetChanged)
    const parent = parentOf(path)
    if (parent === null) return failed(fill(DELETE_TEXTS.isDirectory, { path }))
    const resolved = await resolvePath(q.fs, parent)
    if (q.signal.aborted) return ABORTED
    if (!resolved.resolved || resolved.path !== parent) return failed(DELETE_TEXTS.parentChanged)
    const leaf = pathParts(path).segments.at(-1)!
    const actual = await deleteLeafPath(q.fs, parent, leaf)
    if (q.signal.aborted) return ABORTED
    if (actual.kind === 'error') throw actual.error
    if (actual.kind === 'ambiguous' || (actual.kind === 'found' && actual.path !== path))
      return failed(DELETE_TEXTS.targetChanged)
    if (actual.kind === 'missing') return failed(fill(DELETE_TEXTS.notFound, { path }))
    const guarded = await snapshotGuard(q)
    if ('failure' in guarded) return guarded.failure
    if (guarded.identity === null) return failed(fill(DELETE_TEXTS.notFound, { path }))
    if (q.fileTarget !== undefined && guarded.identity.kind !== q.fileTarget?.kind)
      return failed(DELETE_TEXTS.targetChanged)
    if (guarded.identity.kind === 'dir') return failed(fill(DELETE_TEXTS.isDirectory, { path }))
    if (q.signal.aborted) return ABORTED
    fileMutationAttempted = q.snapshotTarget !== undefined
    await q.fs.remove(path)
    return {
      ...succeeded(fill(DELETE_TEXTS.deleted, { path })),
      ...(fileMutationAttempted ? { fileMutationAttempted: true as const } : {}),
    }
  } catch (error) {
    return {
      ...failed(fill(DELETE_TEXTS.hostError, { path, message: messageOf(error) })),
      ...(fileMutationAttempted ? { fileMutationAttempted: true as const } : {}),
    }
  }
}
