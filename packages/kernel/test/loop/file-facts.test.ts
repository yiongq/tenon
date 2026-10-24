/** Spec 05: compatibility and failure handling for persisted file facts and snapshot ancestry. */
import { describe, expect, it } from 'vitest'
import { absolutePath } from '../../src/index.js'
import type { TapeEntry } from '../../src/tape/entry.js'
import { latestFileStamp } from '../../src/loop/file-stamps.js'
import { snapshotRequest } from '../../src/loop/snapshots.js'

function entry(
  name: string,
  payload: Record<string, unknown>,
  over: Partial<TapeEntry> = {},
): TapeEntry {
  return {
    tenantId: 'tenant',
    sessionId: 'session',
    entryId: 1,
    incarnationId: 'incarnation',
    kind: 'event',
    sourceType: 'runtime_event',
    sourceId: 'run',
    sourceSeq: 1,
    provenanceKey: name,
    name,
    payload,
    meta: {},
    createdAt: 0,
    contentHash: new Uint8Array(32),
    entryHash: new Uint8Array(32),
    prevHash: null,
    hashVer: 1,
    ...over,
  }
}
const FILE = absolutePath('/work/a.txt')
const STAMP = { mtimeNs: '123', size: 6 }
const decision = (payload: Record<string, unknown> = {}) =>
  entry('tool/permission_decided', payload, { provenanceKey: 'decision' })
const dispatch = () =>
  entry('execution/dispatch_committed', { ordinal: 0, decisionKey: 'decision' })
const outcome = (payload: Record<string, unknown> = {}) =>
  entry('execution/tool_outcome', { ordinal: 0, state: 'completed', ...payload })

describe('05 persisted fact compatibility', () => {
  it.each(['runId', 'requestSeq', 'ordinal'] as const)(
    '05 验收 23、24: interleaved calls differing only in %s keep stamps on their own real paths',
    (field) => {
      const other = absolutePath('/work/b.txt')
      const second = {
        sourceId: field === 'runId' ? 'other-run' : 'run',
        sourceSeq: field === 'requestSeq' ? 2 : 1,
      }
      const ordinal = field === 'ordinal' ? 1 : 0
      const entries = [
        decision({ target: { type: 'path', path: FILE } }),
        decision({ target: { type: 'path', path: other } }),
      ]
      entries[1]!.provenanceKey = 'other-decision'
      entries.push(
        dispatch(),
        entry('execution/dispatch_committed', { ordinal, decisionKey: 'other-decision' }, second),
        outcome({ file: STAMP }),
        entry(
          'execution/tool_outcome',
          { ordinal, state: 'completed', file: { mtimeNs: '456', size: 9 } },
          second,
        ),
      )
      expect(latestFileStamp(entries, FILE)).toEqual(STAMP)
      expect(latestFileStamp(entries, other)).toEqual({ mtimeNs: '456', size: 9 })
    },
  )

  it('05 验收 23、24: a legacy decision without target does not break the next file stamp', () => {
    const old = [decision(), dispatch(), outcome()]
    expect(latestFileStamp(old, FILE)).toBeUndefined()
    expect(
      latestFileStamp(
        [
          ...old,
          decision({ target: { type: 'path', path: FILE } }),
          dispatch(),
          outcome({ file: STAMP }),
        ],
        FILE,
      ),
    ).toEqual(STAMP)
  })

  it('05 验收 24: a legacy confirm.target still identifies the stamped path', () => {
    expect(
      latestFileStamp(
        [
          decision({ confirm: { target: { type: 'path', path: FILE } } }),
          dispatch(),
          outcome({ file: STAMP }),
        ],
        FILE,
      ),
    ).toEqual(STAMP)
  })

  it.each(['completed', 'aborted', 'uncertain', 'not-run'])(
    '05 验收 23: a later %s outcome without a stamp cannot erase the last successful observation',
    (state) => {
      expect(
        latestFileStamp(
          [
            decision({ target: { type: 'path', path: FILE } }),
            dispatch(),
            outcome({ file: STAMP }),
            outcome({ state }),
          ],
          FILE,
        ),
      ).toEqual(STAMP)
    },
  )
})

describe('05 snapshot ancestry failures', () => {
  const call = {
    sessionId: 'child',
    runId: 'A',
    requestSeq: 1,
    ordinal: 0,
    providerToolCallId: 'call',
  }
  it('05 验收 1: a cyclic resume chain fails with cyclic resume chain', () => {
    const entries = [
      entry(
        'execution/run_started',
        { cause: { kind: 'resume', pausedRunId: 'B' } },
        { sourceId: 'A' },
      ),
      entry(
        'execution/run_started',
        { cause: { kind: 'resume', pausedRunId: 'A' } },
        { sourceId: 'B' },
      ),
    ]
    expect(() =>
      snapshotRequest({ sessionId: 'child', call, entries, parentEntries: [], folders: [] }),
    ).toThrow('snapshot round has a cyclic resume chain')
  })

  it.each(['missing', 'wrong name', 'missing sourceId'])(
    '05 验收 1、37: a child with %s parent identity fails with the fixed error',
    (problem) => {
      const entries = [
        entry('session/profile_set', {
          profile: 'cowork',
          subagentOf: { sessionId: 'parent', linkKey: 'parent-link' },
        }),
      ]
      const parentEntries =
        problem === 'missing'
          ? []
          : [
              entry(
                problem === 'wrong name' ? 'tool/result' : 'session/parent_link',
                {},
                {
                  provenanceKey: 'parent-link',
                  sourceId: problem === 'missing sourceId' ? null : 'parent-run',
                },
              ),
            ]
      expect(() =>
        snapshotRequest({ sessionId: 'child', call, entries, parentEntries, folders: [] }),
      ).toThrow('snapshot child has no parent call identity')
    },
  )
})
