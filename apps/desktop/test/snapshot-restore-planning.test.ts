import { expect, it } from 'vitest'
import { absolutePath } from '@tenon-app/kernel'
import { planRestore } from '../src/main/host/snapshot-restore.js'
import { SnapshotGit } from '../src/main/host/snapshot-git.js'
import { createHostProcess } from '../src/main/host/process.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'
import type { SavedFile, SnapshotManifest } from '../src/main/host/snapshot-storage.js'

// From review-seg3-perf: one Bash call over an unchanged tree. Count lookups instead of timing CI.
it('05 验收 16: unchanged tree preview indexes paths with linear lookup work', async () => {
  const count = 500
  let lookups = 0
  const folder = absolutePath('/workspace')
  const manifest: SnapshotManifest = {
    version: 1,
    id: 'before',
    sessionId: 's',
    createdAt: 0,
    call: { sessionId: 's', roundRunId: 'r', runId: 'r', requestSeq: 1, ordinal: 0 },
    moment: 'before-call',
    bootstrap: false,
    skipped: 0,
    files: [],
    directories: {},
    trees: [
      {
        folder,
        commit: 'commit',
        directories: {},
        excluded: [],
        coverageComplete: true,
        entries: Array.from({ length: count }, (_, i) => ({
          get path() {
            lookups++
            return absolutePath(`/workspace/f${i}`)
          },
          identity: {
            kind: 'file' as const,
            mode: 0o644,
            size: 1,
            nlink: 1,
            mtimeNs: '0',
            dev: '1',
          },
          hash: 'same-content',
        })),
      },
    ],
  }
  const after = { ...manifest, id: 'after', moment: 'after-call' as const }
  const unrelated: SnapshotManifest = {
    ...manifest,
    id: 'another-round',
    trees: [
      {
        ...manifest.trees[0]!,
        get entries(): SavedFile[] {
          throw new Error('Unrelated round entries must not be scanned')
        },
      },
    ],
  }
  const git = new SnapshotGit({
    process: createHostProcess(),
    sandbox: new PassthroughSandbox(() => {}),
  })
  const plan = await planRestore(
    {
      sessionId: 's',
      roundRunId: 'r',
      calls: [{ callKey: 'bash', before: 'before', after: 'after' }],
    },
    [manifest, after, unrelated],
    [folder],
    '/profile',
    git,
  )
  expect(plan.items).toEqual([])
  expect(plan.preview.skipped).toEqual([])
  expect(lookups).toBeLessThan(count * 20)
})
