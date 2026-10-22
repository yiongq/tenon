/** Receipt releases are Tape facts, never approvals or model-supplied capabilities (04 §放行). */
import type { AbsolutePath, HostAdapter } from '../host/adapter.js'
import { fromParts, isAbsolutePath, isWithin, normalizePath, pathParts } from '../host/path.js'
import { isCanonicalUuid } from '../ids.js'
import { sessionFactsOf, workspaceOf } from '../session/facts.js'
import type { ReleaseQuery, ReleaseResult } from '../session/service.js'
import type {
  ReceiptOverridePayload,
  SandboxOutcome,
  SandboxPlan,
  TapeEntry,
} from '../tape/entry.js'
import { receiptOverrideKey } from '../tape/provenance.js'
import type { Tape } from '../tape/tape.js'

const RECEIPT_OVERRIDE = 'tool/receipt_override'
export const isSandboxRelease = (entry: TapeEntry) => entry.name === RECEIPT_OVERRIDE

/** Own grants plus the parent's current incarnation; a child's grants never flow upward. */
export async function sandboxDomainHosts(
  read: (sessionId: string) => Promise<TapeEntry[]>,
  sessionId: string,
): Promise<string[]> {
  const own = await read(sessionId)
  const parent = sessionFactsOf(own).subagentOf
  const entries = parent === null ? own : [...(await read(parent.sessionId)), ...own]
  return [
    ...new Set(
      entries.filter(isSandboxRelease).flatMap((entry) => {
        const release = entry.payload as ReceiptOverridePayload
        return release.action === 'allow-domain' && release.target !== null ? [release.target] : []
      }),
    ),
  ]
}

/** Session domains persist; one-off releases expire on binding or the next started Run's end. */
export function validSandboxReleases(entries: readonly TapeEntry[]): TapeEntry[] {
  const used = new Set(
    entries
      .filter((e) => e.name === 'tool/permission_decided')
      .map((e) => (e.payload['sandbox'] as SandboxPlan | undefined)?.override?.key),
  )
  return entries.filter((entry, at) => {
    if (!isSandboxRelease(entry) || used.has(entry.provenanceKey ?? '')) return false
    const release = entry.payload as ReceiptOverridePayload
    if (release.action === 'allow-domain') return true
    // The current Run may bind it too. The expiry boundary is the terminal of the first
    // Run STARTED after the click, not the terminal of a Run that was already in progress.
    const after = entries.slice(at + 1)
    const next = after.find((e) => e.name === 'execution/run_started')
    return !after.some((e) => e.name === 'execution/run_terminal' && e.sourceId === next?.sourceId)
  })
}

/** Only an initial decision can acquire a release. Every decision binding consumes it permanently. */
export function unboundSandboxOverride(
  entries: readonly TapeEntry[],
  command: string,
  cwd: AbsolutePath,
): SandboxPlan['override'] {
  const candidates = validSandboxReleases(entries).filter((entry) => {
    const release = entry.payload as ReceiptOverridePayload
    return release.action !== 'allow-domain' && release.command === command && release.cwd === cwd
  })
  const entry = candidates.find((e) => e.payload['action'] === 'rerun-unsandboxed') ?? candidates[0]
  if (entry === undefined || entry.provenanceKey === null) return undefined
  const release = entry.payload as ReceiptOverridePayload
  return release.action === 'rerun-unsandboxed'
    ? { key: entry.provenanceKey, action: 'rerun-unsandboxed' }
    : { key: entry.provenanceKey, action: 'allow-path', path: release.target as AbsolutePath }
}

/** Kernel half of reading 35; host independently rechecks its complete deny lists at wrap. */
async function safePath(
  host: HostAdapter,
  target: string,
  home: string | undefined,
  protectedFiles: readonly AbsolutePath[],
): Promise<boolean> {
  if (
    !isAbsolutePath(target) ||
    normalizePath(target) !== target ||
    /[\n\r\0]/.test(target) ||
    target.endsWith('/')
  )
    return false
  const parts = pathParts(target)
  const parent = fromParts({ ...parts, segments: parts.segments.slice(0, -1) })
  try {
    if ((await host.fs.realpath(parent)) !== parent || !(await host.fs.stat(parent))?.isDir)
      return false
    const stat = await host.fs.stat(target)
    const real = await host.fs.realpath(target)
    if (stat?.isDir || (real !== null && real !== target)) return false
    const guarded = [
      host.identity.profileDir,
      ...protectedFiles,
      ...(home === undefined ? [] : [home]),
    ]
    return !guarded.some((path) => isAbsolutePath(path) && isWithin(path, target))
  } catch {
    return false
  }
}

/** Must be called in the root mailbox: validation, deduplication and append are one turn. */
export async function releaseReceipt(
  q: ReleaseQuery,
  ctx: {
    tape: Tape
    entries: readonly TapeEntry[]
    host: HostAdapter
    now: () => number
    home: () => Promise<string | undefined>
    protectedFiles: readonly AbsolutePath[]
  },
): Promise<ReleaseResult> {
  const [runId = '', seq = '', ordinal = '', extra] = q.callKey.split(':')
  if (
    !isCanonicalUuid(runId) ||
    !/^(0|[1-9]\d*)$/.test(seq) ||
    !/^(0|[1-9]\d*)$/.test(ordinal) ||
    extra !== undefined ||
    !Number.isSafeInteger(Number(seq)) ||
    !Number.isSafeInteger(Number(ordinal))
  )
    return { status: 'not-found' }
  const entries = ctx.entries
  const sameCall = entries.filter(
    (e) =>
      e.sourceId === runId &&
      e.sourceSeq === Number(seq) &&
      e.payload['ordinal'] === Number(ordinal),
  )
  const call = sameCall.find((e) => e.name === 'tool/call')
  if (
    call === undefined ||
    entries.some(
      (e) => e.name === 'message/retracted' && e.payload['messageId'] === call.payload['messageId'],
    )
  )
    return { status: 'not-found' }
  const sandbox = sameCall.find((e) => e.name === 'execution/tool_outcome')?.payload['sandbox'] as
    | SandboxOutcome
    | undefined
  if (call.payload['name'] !== 'Bash' || sandbox === undefined) return { status: 'stale' }
  const violation =
    q.action === 'rerun-unsandboxed'
      ? 0
      : sandbox.violations.findIndex((v) => v.target === q.target)
  const row = sandbox.violations[violation]
  if (
    q.action === 'rerun-unsandboxed'
      ? sandbox.anyProtected || q.target !== null
      : row === undefined ||
        row.target === null ||
        row.protected ||
        (q.action === 'allow-domain'
          ? row.release !== 'domain'
          : row.release !== 'path' || row.observed)
  )
    return { status: 'stale' }
  const key = receiptOverrideKey(runId, Number(seq), Number(ordinal), q.action, violation)
  if (entries.some((e) => e.provenanceKey === key)) return { status: 'already-released' }
  if (
    q.action === 'allow-path' &&
    !(await safePath(ctx.host, row!.target!, await ctx.home(), ctx.protectedFiles))
  )
    return { status: 'stale' }
  // Use the decision's original cwd, not a workspace the user may have changed since the call.
  const decision = sameCall.findLast((e) => e.name === 'tool/permission_decided')
  const originalTarget = decision?.payload['target'] as { cwd?: AbsolutePath } | undefined
  const confirm = decision?.payload['confirm'] as { target?: { cwd?: AbsolutePath } } | undefined
  const atCall = entries.filter((e) => e.entryId <= call.entryId)
  const workspace = await workspaceOf(ctx.tape, sessionFactsOf(atCall))
  const cwd = originalTarget?.cwd ?? confirm?.target?.cwd ?? workspace?.folders[0]
  const input = call.payload['input'] as { command?: string }
  if (cwd === undefined || typeof input.command !== 'string') return { status: 'stale' }
  const payload: ReceiptOverridePayload = {
    ordinal: Number(ordinal),
    providerToolCallId: String(call.payload['providerToolCallId']),
    action: q.action,
    target: q.action === 'rerun-unsandboxed' ? null : row!.target,
    violation,
    command: input.command,
    cwd,
    via: 'receipt-override',
    writer: { by: 'resolver' },
  }
  const head = await ctx.tape.head(q.sessionId)
  if (head === null) return { status: 'not-found' }
  await ctx.tape.writer('tool').write({
    sessionId: q.sessionId,
    incarnationId: head.incarnationId,
    fact: {
      name: RECEIPT_OVERRIDE,
      fields: {
        sourceType: 'runtime_event',
        sourceId: runId,
        sourceSeq: Number(seq),
        provenanceKey: key,
        payload,
        createdAt: ctx.now(),
      },
    },
  })
  return { status: 'released' }
}
