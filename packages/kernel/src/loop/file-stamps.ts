/** Spec 05 §mtime 守卫: only this session's committed outcomes supply the last observed stamp. */
import type { AbsolutePath } from '../host/adapter.js'
import type { PermissionDecidedPayload, TapeEntry, ToolOutcomePayload } from '../tape/entry.js'

export function latestFileStamp(
  entries: readonly TapeEntry[],
  path: AbsolutePath,
): ToolOutcomePayload['file'] {
  const decisions = new Map<string, PermissionDecidedPayload>()
  const targets = new Map<string, string>()
  let latest: ToolOutcomePayload['file']
  for (const entry of entries) {
    const callKey = `${entry.sourceId}:${entry.sourceSeq}:${String(entry.payload['ordinal'])}`
    if (entry.name === 'tool/permission_decided')
      decisions.set(entry.provenanceKey, entry.payload as PermissionDecidedPayload)
    else if (entry.name === 'execution/dispatch_committed') {
      const decision = decisions.get(String(entry.payload['decisionKey']))
      const target = decision?.target ?? decision?.confirm?.target
      if (target?.type === 'path') targets.set(callKey, target.path)
    } else if (entry.name === 'execution/tool_outcome' && targets.get(callKey) === path) {
      const outcome = entry.payload as ToolOutcomePayload
      if (outcome.state === 'completed' && outcome.file !== undefined) latest = outcome.file
    }
  }
  return latest
}
