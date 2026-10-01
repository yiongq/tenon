/** Step 33 old 65: the complete prefix-binding sequence stays in one session. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { combinedSessionEvidence } from './helpers/official-combined-session.js'
import { test, expect } from './helpers/test.js'

const enabled =
  process.env['TENON_LIVE'] === '1' && process.env['TENON_LIVE_OFFICIAL_AGENT'] === '1'

test('Opus 5.5 same-session disable approval Zhipu replay and compaction', async () => {
  test.skip(!enabled, 'Requires explicit official product acceptance opt-in')
  test.setTimeout(950_000)
  const anthropic = process.env['TENON_LIVE_ANTHROPIC_OFFICIAL_KEY']
  const zhipu = process.env['TENON_LIVE_ZHIPU_KEY']
  if (!anthropic || !zhipu) throw new Error('Both process-only provider keys are required')
  const directory = process.env['TENON_LIVE_RECORD_DIR'] ?? '/tmp/tenon-official-agent-records'
  mkdirSync(directory, { recursive: true })
  const result = await combinedSessionEvidence({ anthropic, zhipu }, (snapshot) => {
    writeFileSync(join(directory, 'combined-session.json'), JSON.stringify(snapshot, null, 2))
  })
  expect(result.failure).toBeNull()
  expect(result.cleanupComplete).toBe(true)
  expect(result.stages.map((stage) => stage.name)).toEqual([
    'initial-read',
    'disable-read',
    'write-approval',
    'zhipu-tool',
    'anthropic-return-before-compaction',
    'same-session-compaction',
  ])
})
