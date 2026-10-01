/** Paid-fixture teardown must work after Playwright has disposed its Electron channel. */
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import {
  closeWithEvidence,
  createOfficialEvidence,
  ownedProcessStopped,
  recordOfficialWire,
} from './helpers/official-agent-evidence.js'
import { providerEnv, send } from './helpers/tools.js'
import { test, expect } from './helpers/test.js'

test('official evidence survives repeated close of its own Electron process', async () => {
  const fake = await startFakeAnthropic({ chunks: ['LOCAL_CLEANUP_DONE'], delayMs: 1 })
  const userData = makeUserDataDir('official-evidence-cleanup')
  seedConfig(userData, { locale: 'en', provider: { id: 'anthropic', modelId: 'claude-sonnet-5' } })
  const launch = await launchTenon({ userData, secrets: 'memory', env: providerEnv(fake.baseURL) })
  const journal = createOfficialEvidence()
  try {
    await recordOfficialWire(launch.app)
    await send(launch.page, 'Reply LOCAL_CLEANUP_DONE.')
    await expect(launch.page.getByTestId('assistant-text').last()).toContainText(
      'LOCAL_CLEANUP_DONE',
    )
    await expect(launch.page.getByTestId('composer-stop')).toHaveCount(0)
    expect(await closeWithEvidence(launch.app, journal)).toBe(true)
    expect(ownedProcessStopped(launch.app)).toBe(true)
    const captured = JSON.stringify(journal.wire)
    expect(journal.wire.some((row) => row.status === 200)).toBe(true)
    expect(await closeWithEvidence(launch.app, journal)).toBe(true)
    expect(JSON.stringify(journal.wire)).toBe(captured)
    expect(journal.failures).toEqual([])
  } finally {
    try {
      await closeWithEvidence(launch.app, journal)
    } finally {
      await fake.close()
    }
  }
})
