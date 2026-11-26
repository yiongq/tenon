/** Shared lifecycle for 04 sandbox and 06 inspector releases; all state comes from the Tape. */
import type {
  PermissionDecidedPayload,
  RunStartedPayload,
  RunTerminalPayload,
  TapeEntry,
} from '../tape/entry.js'

export function validReceiptReleases(
  entries: readonly TapeEntry[],
  isRelease: (entry: TapeEntry) => boolean,
): TapeEntry[] {
  const used = new Set(
    entries
      .filter((entry) => entry.name === 'tool/permission_decided')
      .flatMap((entry) => {
        const decision = entry.payload as PermissionDecidedPayload
        return [decision.sandbox?.override?.key, decision.inspectorOverride?.key]
      }),
  )
  return entries.filter((entry, at) => {
    if (!isRelease(entry) || used.has(entry.provenanceKey)) return false
    if (entry.payload['action'] === 'allow-domain') return true
    const after = entries.slice(at + 1)
    const reply = new Set<string>()
    for (const fact of after) {
      if (fact.name !== 'execution/run_started' || fact.sourceId === null) continue
      const cause = (fact.payload as RunStartedPayload).cause
      if (
        reply.size === 0
          ? cause.kind !== 'resume'
          : cause.kind === 'resume' && reply.has(cause.pausedRunId)
      )
        reply.add(fact.sourceId)
    }
    return !after.some(
      (fact) =>
        fact.name === 'execution/run_terminal' &&
        reply.has(fact.sourceId ?? '') &&
        (fact.payload as RunTerminalPayload).reason.code !== 'paused',
    )
  })
}
