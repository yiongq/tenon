/** Release notes join only at the environment checkpoints (04 §告诉模型, reading 17). */
import { isSandboxRelease, validSandboxReleases } from '../permission/sandbox-release.js'
import { MODEL_NOTES, fill } from '../prompts/index.js'
import type {
  NewEntry,
  ReceiptOverridePayload,
  SandboxReleasePayload,
  TapeEntry,
} from '../tape/entry.js'
import { messageRevisionKey } from '../tape/provenance.js'
import type { Tape } from '../tape/tape.js'
import { latestAnchor } from './compaction.js'

export function sandboxReleaseEntry(q: {
  readonly entries: readonly TapeEntry[]
  readonly tape: Pick<Tape, 'writer'>
  readonly now: () => number
  readonly messageId: () => string
}): NewEntry | null {
  const inContext = new Set<string>()
  const keepFrom = latestAnchor(q.entries)?.payload['keepFromEntryId'] as number | undefined
  for (const entry of q.entries) {
    if (entry.name !== 'message/sandbox_release') continue
    const { overrides } = entry.payload as SandboxReleasePayload
    for (const key of overrides) {
      if (entry.entryId >= (keepFrom ?? 0)) inContext.add(key)
    }
  }
  const valid = new Set(validSandboxReleases(q.entries).map((entry) => entry.provenanceKey))
  const releases = q.entries.filter(
    (entry) =>
      isSandboxRelease(entry) &&
      entry.provenanceKey !== null &&
      valid.has(entry.provenanceKey) &&
      !inContext.has(entry.provenanceKey),
  )
  if (releases.length === 0) return null
  const notes = MODEL_NOTES.sandbox.release
  const lines = releases.map((entry) => {
    const release = entry.payload as ReceiptOverridePayload
    return release.action === 'allow-domain'
      ? fill(notes.domain, { host: JSON.stringify(release.target) })
      : release.action === 'allow-path'
        ? fill(notes.path, {
            path: JSON.stringify(release.target),
            command: JSON.stringify(release.command),
          })
        : fill(notes.rerun, { command: JSON.stringify(release.command) })
  })
  const messageId = q.messageId()
  const payload: SandboxReleasePayload = {
    messageId,
    revision: 0,
    role: 'user',
    content: [{ type: 'text', text: fill(notes.wrap, { lines: lines.join('\n') }) }],
    status: 'complete',
    overrides: releases.map((entry) => entry.provenanceKey!),
  }
  return q.tape.writer('message').entry('message/sandbox_release', {
    sourceType: 'message',
    sourceId: messageId,
    sourceSeq: 0,
    provenanceKey: messageRevisionKey(messageId, 0),
    payload,
    createdAt: q.now(),
  })
}
