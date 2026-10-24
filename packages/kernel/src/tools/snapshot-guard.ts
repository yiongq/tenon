/** Spec 05 §一直要成立的规矩: compare the captured identity immediately before file access. */
import type { AbsolutePath, FileIdentity, HostFs } from '../host/adapter.js'
import type { ToolOutcomePayload } from '../tape/entry.js'
import { MODEL_NOTES } from '../prompts/index.js'
import type { ExecuteQuery, ToolExecution } from './executor.js'
import { ABORTED, failed } from './builtin/files.js'

/** Fixed English from the prompt layer (spec 05 §提示层与评测). */
export const SNAPSHOT_FAILED = MODEL_NOTES.file.snapshotFailed
export const SNAPSHOT_CHANGED = MODEL_NOTES.file.snapshotChanged
export const FILE_CHANGED = MODEL_NOTES.file.changed
export const HARDLINK_CHANGED = MODEL_NOTES.file.hardlinkChanged

function sameIdentity(a: FileIdentity | null, b: FileIdentity | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.kind === b.kind &&
    a.size === b.size &&
    a.nlink === b.nlink &&
    a.mtimeNs === b.mtimeNs &&
    a.mode === b.mode &&
    a.dev === b.dev
  )
}

export async function snapshotGuard(
  q: ExecuteQuery,
): Promise<{ identity: FileIdentity | null } | { failure: ToolExecution }> {
  if (q.signal.aborted) return { failure: ABORTED }
  if (q.target === null) throw new Error('file guard requires a target')
  const current = await q.fs.identity(q.target)
  if (q.signal.aborted) return { failure: ABORTED }
  if (
    current?.kind === 'file' &&
    current.nlink > 1 &&
    !(q.fileTarget?.kind === 'file' && q.fileTarget.nlink > 1)
  ) {
    return { failure: failed(HARDLINK_CHANGED) }
  }
  if (q.snapshotTarget !== undefined && !sameIdentity(q.snapshotTarget, current)) {
    return { failure: failed(SNAPSHOT_CHANGED) }
  }
  if (
    q.item.originalName !== 'Delete' &&
    current !== null &&
    q.fileStamp !== undefined &&
    (current.mtimeNs.toString() !== q.fileStamp.mtimeNs || current.size !== q.fileStamp.size)
  ) {
    return { failure: failed(FILE_CHANGED) }
  }
  return { identity: current }
}

export function fileStampOf(identity: FileIdentity | null): ToolOutcomePayload['file'] {
  return identity?.kind === 'file'
    ? { mtimeNs: identity.mtimeNs.toString(), size: identity.size }
    : undefined
}

/** Stamp failures cannot turn an already completed write into a claimed write failure. */
export async function writtenFileStamp(
  fs: HostFs,
  path: AbsolutePath,
): Promise<ToolOutcomePayload['file']> {
  try {
    return fileStampOf(await fs.identity(path))
  } catch {
    return undefined
  }
}

export function alreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}
