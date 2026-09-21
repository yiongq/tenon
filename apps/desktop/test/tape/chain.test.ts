/**
 * The chain as it lives on disk (spec 01 acceptance 12, and the timings plan.md asks for).
 *
 * The conformance suite proves the POSITIVE half through the port for both stores. What needs SQLite is
 * the negative half: tampering. The spec is explicit that the append-only triggers stop program bugs,
 * not a writer with DDL rights (§哈希链, 「诚实的边界」: `DROP TRIGGER` on the same connection succeeds,
 * measured), so this test becomes that writer, flips ONE byte of one `payload_json`, and requires
 * `verifyChain` to name exactly that row — then restores it and requires the chain to verify again.
 *
 * It also carries the independent cross-check the spec asks `apps/desktop` for: the seal that
 * @noble/hashes wrote inside the append transaction, recomputed byte for byte with `node:crypto`.
 */
import { createHash } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  clockFrom,
  extFact,
  ids,
  openStore,
  rawConnection,
  removeTempProfiles,
  startFact,
} from './fixtures.js'

afterAll(() => {
  removeTempProfiles()
})

const TOTAL = 10_000
const BATCH = 500
const PAGE = 1000

/** ONE byte of the stored text, changed in place: same length, different content. */
function flipLastDigit(text: string): string {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const character = text[index] ?? ''
    if (character >= '0' && character <= '9') {
      const next = String((Number(character) + 1) % 10)
      return `${text.slice(0, index)}${next}${text.slice(index + 1)}`
    }
  }
  throw new Error(`no digit to flip in ${text}`)
}

/** `field(x) = u32be(byteLength(utf8(x))) ‖ utf8(x)`; `field(null) = 0xFFFFFFFF`. */
function field(value: string | Uint8Array | null): Buffer {
  if (value === null) return Buffer.of(0xff, 0xff, 0xff, 0xff)
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  return Buffer.concat([length, bytes])
}

describe('the hash chain on disk (acceptance 12)', () => {
  it('verifies 10 000 entries, names a flipped byte, and passes again once restored', async () => {
    const opened = openStore({ label: 'tape-chain' })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    await opened.store.append({
      sessionId,
      incarnationId,
      entries: [startFact(sessionId, incarnationId, at)],
    })
    for (let base = 1; base < TOTAL; base += BATCH) {
      const entries = []
      for (let offset = 0; offset < BATCH && base + offset < TOTAL; offset += 1) {
        entries.push(extFact(sessionId, base + offset, at))
      }
      // oxlint-disable-next-line no-await-in-loop -- one transaction per batch, in order
      await opened.store.append({ sessionId, incarnationId, entries })
    }
    const head = await opened.store.head(sessionId)
    expect(head?.lastEntryId).toBe(TOTAL)
    expect(head?.entryCount).toBe(TOTAL)

    // `session_head.last_hash` is the last entry's `entry_hash`.
    const lastPage = await opened.store.readRange({ sessionId, fromEntryId: TOTAL, limit: 1 })
    const lastEntry = lastPage.entries[0]
    if (lastEntry === undefined) throw new Error('the last entry is missing')
    expect(lastEntry.entryHash).toEqual(head?.lastHash)

    // ----- the two timings plan.md asks to record ------------------------------------------------
    const readStartedAt = performance.now()
    const collected: number[] = []
    let readFrom: number | undefined
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
      const page = await opened.store.readRange({
        sessionId,
        atEntryId: 5000,
        limit: PAGE,
        ...(readFrom === undefined ? {} : { fromEntryId: readFrom }),
        incarnationId,
      })
      for (const entry of page.entries) collected.push(entry.entryId)
      if (page.nextFromEntryId === null) break
      readFrom = page.nextFromEntryId
    }
    const readMs = performance.now() - readStartedAt
    expect(collected.length).toBe(5000)
    expect(collected.at(-1)).toBe(5000)

    const verifyStartedAt = performance.now()
    let checked = 0
    let verifyFrom: number | undefined
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
      const page = await opened.store.verifyChain({
        sessionId,
        limit: PAGE,
        ...(verifyFrom === undefined ? {} : { fromEntryId: verifyFrom }),
        incarnationId,
      })
      expect(page.firstBadEntryId).toBeNull()
      checked += page.checked
      if (page.nextFromEntryId === null) break
      verifyFrom = page.nextFromEntryId
    }
    expect(checked).toBe(TOTAL)
    console.log(
      `[acceptance 12/15] paged read of 5000 entries: ${readMs.toFixed(0)} ms; ` +
        `paged verifyChain over ${TOTAL} entries: ${(performance.now() - verifyStartedAt).toFixed(0)} ms`,
    )

    // ----- the byte flip --------------------------------------------------------------------------
    const target = 5000
    const raw = rawConnection(opened.file)
    const stored = raw
      .prepare(
        'SELECT payload_json FROM tape_entry WHERE tenant_id = ? AND session_id = ? AND entry_id = ?',
      )
      .get('tenant-a', sessionId, target) as { payload_json: string }
    const flipped = flipLastDigit(stored.payload_json)
    expect(flipped).not.toBe(stored.payload_json)
    expect(flipped.length).toBe(stored.payload_json.length)

    // The trigger is the program's guard, not a defence against DDL rights; taking it away for a
    // moment is exactly how the spec says to write this test.
    raw.exec('DROP TRIGGER tape_entry_no_update')
    const update = raw.prepare(
      'UPDATE tape_entry SET payload_json = ? WHERE tenant_id = ? AND session_id = ? AND entry_id = ?',
    )
    expect(update.run(flipped, 'tenant-a', sessionId, target).changes).toBe(1)

    // The page that contains the row names it, and a walk from the start stops there.
    const tampered = await opened.store.verifyChain({
      sessionId,
      fromEntryId: target,
      limit: 10,
      incarnationId,
    })
    expect(tampered.firstBadEntryId).toBe(target)
    let walkFrom: number | undefined
    let firstBad: number | null = null
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- the walk stops at the first bad link
      const page = await opened.store.verifyChain({
        sessionId,
        limit: PAGE,
        ...(walkFrom === undefined ? {} : { fromEntryId: walkFrom }),
        incarnationId,
      })
      if (page.firstBadEntryId !== null) {
        firstBad = page.firstBadEntryId
        break
      }
      if (page.nextFromEntryId === null) break
      walkFrom = page.nextFromEntryId
    }
    expect(firstBad).toBe(target)

    // Restored byte for byte, the chain verifies again: the detector reports the DATA, not a latch.
    expect(update.run(stored.payload_json, 'tenant-a', sessionId, target).changes).toBe(1)
    raw.exec(
      'CREATE TRIGGER tape_entry_no_update BEFORE UPDATE ON tape_entry ' +
        "BEGIN SELECT RAISE(ABORT, 'tape_entry is append-only'); END",
    )
    const healed = await opened.store.verifyChain({
      sessionId,
      fromEntryId: target - 1,
      limit: 10,
      incarnationId,
    })
    expect(healed.firstBadEntryId).toBeNull()
    raw.close()
    await opened.store.close()
  }, 120_000)

  it('reports a row whose hash_ver this build does not know as the bad link', async () => {
    // The reading plan.md 「Open」 records and `isStoredEntryProvable` implements: the port's result has
    // no "this build cannot verify" state, so an unknown recipe version is reported as
    // `firstBadEntryId` rather than called healthy. Through the port there is no way to write such a
    // row — this is the only place the branch can be exercised on real data.
    const opened = openStore({ label: 'tape-hashver' })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    await opened.store.append({
      sessionId,
      incarnationId,
      entries: [
        startFact(sessionId, incarnationId, at),
        extFact(sessionId, 1, at),
        extFact(sessionId, 2, at),
      ],
    })
    expect((await opened.store.verifyChain({ sessionId, limit: 10 })).firstBadEntryId).toBeNull()
    const raw = rawConnection(opened.file)
    raw.exec('DROP TRIGGER tape_entry_no_update')
    raw
      .prepare(
        'UPDATE tape_entry SET hash_ver = 2 WHERE tenant_id = ? AND session_id = ? AND entry_id = ?',
      )
      .run('tenant-a', sessionId, 2)
    expect((await opened.store.verifyChain({ sessionId, limit: 10 })).firstBadEntryId).toBe(2)
    raw.close()
    await opened.store.close()
  })

  it('recomputes a stored seal with node:crypto, byte for byte', async () => {
    // The independent implementation the spec asks `apps/desktop` for: @noble/hashes sealed this row
    // inside the append transaction (the kernel may not import `node:crypto`), and the recipe is six
    // lines that any language can follow.
    const opened = openStore({ label: 'tape-crosscheck' })
    const seq = ids(1)
    const at = clockFrom()
    const sessionId = seq.uuid()
    const incarnationId = seq.uuid()
    await opened.store.append({
      sessionId,
      incarnationId,
      entries: [startFact(sessionId, incarnationId, at), extFact(sessionId, 1, at)],
    })
    const raw = rawConnection(opened.file)
    const rows = raw
      .prepare(
        'SELECT entry_id, incarnation_id, kind, name, source_type, source_id, source_seq, ' +
          'provenance_key, payload_json, meta_json, created_at, content_hash, prev_hash, ' +
          'entry_hash, hash_ver FROM tape_entry WHERE tenant_id = ? AND session_id = ? ' +
          'ORDER BY entry_id',
      )
      .all('tenant-a', sessionId) as {
      entry_id: number
      incarnation_id: string
      kind: string
      name: string
      source_type: string
      source_id: string | null
      source_seq: number | null
      provenance_key: string
      payload_json: string
      meta_json: string
      created_at: number
      content_hash: Buffer
      prev_hash: Buffer | null
      entry_hash: Buffer
      hash_ver: number
    }[]
    expect(rows.length).toBe(2)
    for (const row of rows) {
      const contentHash = createHash('sha256')
        .update(field(row.payload_json))
        .update(field(row.meta_json))
        .digest()
      expect(contentHash.equals(row.content_hash)).toBe(true)
      const entryHash = createHash('sha256')
        .update(field(`tenon.tape.v${row.hash_ver}`))
        .update(field('tenant-a'))
        .update(field(sessionId))
        .update(field(row.incarnation_id))
        .update(field(String(row.entry_id)))
        .update(field(row.kind))
        .update(field(row.name))
        .update(field(row.source_type))
        .update(field(row.source_id))
        .update(field(row.source_seq === null ? null : String(row.source_seq)))
        .update(field(row.provenance_key))
        .update(field(String(row.created_at)))
        .update(field(row.content_hash))
        .update(field(row.prev_hash))
        .digest()
      expect(entryHash.equals(row.entry_hash)).toBe(true)
    }
    raw.close()
    await opened.store.close()
  })
})
