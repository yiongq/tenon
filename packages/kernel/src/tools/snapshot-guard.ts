/** Spec 05 §一直要成立的规矩: compare the captured identity immediately before file access. */
import type { AbsolutePath, FileIdentity, HostFs } from '../host/adapter.js'
import type { ToolOutcomePayload } from '../tape/entry.js'
import type { ExecuteQuery, ToolExecution } from './executor.js'
import { ABORTED, failed } from './builtin/files.js'

// Registered prompt-layer templates are updated together in 05 step 11.
export const SNAPSHOT_FAILED = 'Tenon could not take the promised snapshot. Nothing was written.'
export const SNAPSHOT_CHANGED =
  'The file changed after its snapshot was taken. Nothing was written. Read the file again before retrying.'

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

// 05 step 11 registers these runtime notes with the prompt layer.
export const FILE_CHANGED =
  'The file changed since it was last read or written. Nothing was written. Read the file again with Read before retrying.'
export const HARDLINK_CHANGED =
  'The file now has multiple names. Nothing was written or deleted. Ask for approval again before retrying.'

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
