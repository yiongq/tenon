/** Spec 05 §一直要成立的规矩: compare the captured identity immediately before file access. */
import type { FileIdentity } from '../host/adapter.js'
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

export async function snapshotGuard(q: ExecuteQuery): Promise<ToolExecution | null> {
  if (q.snapshotTarget === undefined) return null
  if (q.signal.aborted) return ABORTED
  if (q.target === null) throw new Error('snapshot guard requires a file target')
  const current = await q.fs.identity(q.target)
  if (q.signal.aborted) return ABORTED
  return sameIdentity(q.snapshotTarget, current) ? null : failed(SNAPSHOT_CHANGED)
}
