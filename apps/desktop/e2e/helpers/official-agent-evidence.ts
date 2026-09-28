/** Read-only live evidence: bodies/status, never request headers or credentials. */
import type { ChildProcess } from 'node:child_process'
import type { ElectronApplication } from '@playwright/test'
const ownedProcesses = new WeakMap<ElectronApplication, ChildProcess>()
function ownedProcess(app: ElectronApplication): ChildProcess {
  const cached = ownedProcesses.get(app)
  if (cached !== undefined) return cached
  // Playwright disposes this channel on close; retain the OS process handle beforehand.
  const child = app.process()
  ownedProcesses.set(app, child)
  return child
}

export interface OfficialWire {
  url: string
  method: string
  body: Record<string, unknown> | null
  status: number | null
}
export interface ProtocolEvidence {
  mode: 'strict' | 'record'
  requestBody?: Record<string, unknown>
  model: unknown
  status: number | null
  complete: boolean
  transformations: unknown[]
}
export async function recordOfficialWire(app: ElectronApplication): Promise<void> {
  ownedProcess(app)
  await app.evaluate(() => {
    const store = globalThis as unknown as { liveRequests?: unknown[] }
    if (store.liveRequests !== undefined) return
    const requests: Array<{ url: string; method: string; body: unknown; status: number | null }> =
      []
    store.liveRequests = requests
    /** undici's own request object, as its channels publish it: only the fields read here. */
    interface Sent {
      readonly origin: string | URL
      readonly path: string
      readonly method: string
    }
    const open = new WeakMap<object, { record: (typeof requests)[number]; chunks: Buffer[] }>()
    const channels = process.getBuiltinModule('node:diagnostics_channel')
    channels.subscribe('undici:request:create', (message) => {
      const { request } = message as { request: Sent }
      const url = `${new URL(String(request.origin)).origin}${request.path}`
      const record: (typeof requests)[number] = {
        url,
        method: request.method,
        body: null,
        status: null,
      }
      requests.push(record)
      open.set(request, { record, chunks: [] })
    })
    channels.subscribe('undici:request:bodyChunkSent', (message) => {
      const { request, chunk } = message as { request: object; chunk: Uint8Array | string }
      open.get(request)?.chunks.push(Buffer.from(chunk))
    })
    channels.subscribe('undici:request:bodySent', (message) => {
      const entry = open.get((message as { request: object }).request)
      if (entry === undefined || entry.chunks.length === 0) return
      try {
        entry.record.body = JSON.parse(Buffer.concat(entry.chunks).toString('utf8')) as unknown
      } catch {
        entry.record.body = null
      }
    })
    channels.subscribe('undici:request:headers', (message) => {
      const { request, response } = message as { request: object; response: { statusCode: number } }
      const entry = open.get(request)
      if (entry !== undefined) entry.record.status = response.statusCode
    })
  })
}

export async function officialWire(app: ElectronApplication): Promise<OfficialWire[]> {
  return app.evaluate(
    () => (globalThis as unknown as { liveRequests?: OfficialWire[] }).liveRequests ?? [],
  )
}
export async function protocolEvidence(app: ElectronApplication): Promise<ProtocolEvidence[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { tenonOfficialProtocolRecords?: ProtocolEvidence[] })
        .tenonOfficialProtocolRecords ?? [],
  )
}
/** Missing input_transformations cannot stand in for an explicit empty list. */
export function strictAccepted(records: readonly ProtocolEvidence[]): boolean {
  return (
    records.length > 0 &&
    records.every(
      (record) =>
        record.mode === 'strict' &&
        record.status === 200 &&
        record.complete &&
        record.transformations.length > 0 &&
        record.transformations.every((value) => Array.isArray(value) && value.length === 0),
    )
  )
}

/** A stalled Electron main process must not prevent evidence persistence and teardown. */
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('fixture-operation-deadline')), milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** One replaceable snapshot per process: collecting again never duplicates previous requests. */
export function createOfficialEvidence() {
  const launches = new Map<
    ElectronApplication,
    { wire: OfficialWire[]; protocol: ProtocolEvidence[] }
  >()
  const failures: string[] = []
  return {
    get wire() {
      return [...launches.values()].flatMap((row) => row.wire)
    },
    get protocol() {
      return [...launches.values()].flatMap((row) => row.protocol)
    },
    failures,
    async capture(app: ElectronApplication) {
      const prior = launches.get(app) ?? { wire: [], protocol: [] }
      const [wire, protocol] = await Promise.allSettled([
        bounded(officialWire(app), 5_000),
        bounded(protocolEvidence(app), 5_000),
      ])
      if (wire.status === 'fulfilled') prior.wire = wire.value
      else failures.push('wire-snapshot-unavailable')
      if (protocol.status === 'fulfilled') prior.protocol = protocol.value
      else failures.push('protocol-snapshot-unavailable')
      launches.set(app, prior)
      return prior
    },
  }
}
export type OfficialEvidence = ReturnType<typeof createOfficialEvidence>

/** Checks this fixture's ChildProcess handle, never a name or a global process list. */
export function ownedProcessStopped(app: ElectronApplication): boolean {
  const child = ownedProcess(app)
  return child.exitCode !== null || child.signalCode !== null
}

async function waitOwnedExit(app: ElectronApplication): Promise<void> {
  if (ownedProcessStopped(app)) return
  const child = ownedProcess(app)
  let onExit: (() => void) | undefined
  try {
    await bounded(
      new Promise<void>((resolve) => {
        onExit = resolve
        child.once('exit', onExit)
        if (ownedProcessStopped(app)) resolve()
      }),
      5_000,
    )
  } finally {
    if (onExit !== undefined) child.off('exit', onExit)
  }
}

/** Capture is bounded too. A failed graceful close kills only the process this fixture owns. */
export async function closeWithEvidence(app: ElectronApplication, journal: OfficialEvidence) {
  if (ownedProcessStopped(app)) return true
  await journal.capture(app)
  try {
    await bounded(app.close(), 20_000)
    await waitOwnedExit(app)
    return true
  } catch {
    journal.failures.push('electron-close-failed-or-unsettled')
    if (!ownedProcessStopped(app)) {
      const child = ownedProcess(app)
      try {
        if (!child.kill('SIGKILL')) journal.failures.push('owned-electron-kill-not-delivered')
      } catch {
        journal.failures.push('owned-electron-kill-failed')
      }
    }
    try {
      await waitOwnedExit(app)
    } catch {
      journal.failures.push('owned-electron-exit-unconfirmed')
      throw new Error('Owned fixture Electron exit could not be confirmed')
    }
    return false
  }
}
