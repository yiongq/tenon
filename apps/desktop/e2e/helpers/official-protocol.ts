/** Actual host-wire evidence. Strict instrumentation changes the wire after Tape encoding. */
import type { ElectronApplication } from '@playwright/test'
import type { OfficialProtocolRecord } from '../../src/main/host/official-protocol-test-seam.js'

export async function officialProtocolRecords(
  app: ElectronApplication,
): Promise<OfficialProtocolRecord[]> {
  return app.evaluate(() => globalThis.tenonOfficialProtocolRecords ?? [])
}

/** Missing fields are not an empty transformation list and cannot prove strict prefix acceptance. */
export function acceptedWithoutTransformations(record: OfficialProtocolRecord): boolean {
  return (
    record.status === 200 &&
    record.complete &&
    record.transformations.length > 0 &&
    record.transformations.every((value) => Array.isArray(value) && value.length === 0)
  )
}
