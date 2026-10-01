/**
 * Manual paid product-path acceptance 54. No .env files or keychain reads.
 * Requires BOTH TENON_LIVE=1 and TENON_LIVE_OFFICIAL_AGENT=1 plus a process-only official key.
 * Collection wiring is intentionally owned by the lead: default e2e MUST exclude this file.
 * Dependencies: step 33 official-protocol-test-seam and step 30 compaction threshold seam.
 * Tool disable uses a separate real-kernel case; restart changes only the isolated build artifact.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { disabledToolEvidence } from './helpers/official-disabled-tool.js'
import { CHANGED_TOOL_SUFFIX, changeReadDescription } from './helpers/changed-tool-build.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import {
  createOfficialEvidence,
  closeWithEvidence,
  ownedProcessStopped,
  recordOfficialWire,
  strictAccepted,
} from './helpers/official-agent-evidence.js'
import type { OfficialEvidence } from './helpers/official-agent-evidence.js'
import { newChatFromSidebar } from './helpers/navigation.js'
import { named, tapeFacts } from './helpers/tape.js'
import { expect, test } from './helpers/test.js'
import { makeFolderTree, send, startTask, waitingApproval } from './helpers/tools.js'

const ENABLED =
  process.env['TENON_LIVE'] === '1' && process.env['TENON_LIVE_OFFICIAL_AGENT'] === '1'
const TURN_MS = 180_000
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5'
const ZHIPU = process.env['TENON_LIVE_ZHIPU_MODEL'] ?? 'glm-5.3-flash'
const HOST = 'https://api.anthropic.com/v1/messages'

function credentials(mode: 'strict' | 'record'): Record<string, string> {
  const key = process.env['TENON_LIVE_ANTHROPIC_OFFICIAL_KEY']
  if (!key) throw new Error('TENON_LIVE_ANTHROPIC_OFFICIAL_KEY must be supplied to this process')
  return {
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    TENON_TEST_OFFICIAL_PROTOCOL: mode,
    TENON_MAX_TOKENS: '4096',
    ...(process.env['TENON_LIVE_ZHIPU_KEY']
      ? { ZHIPU_API_KEY: process.env['TENON_LIVE_ZHIPU_KEY'] }
      : {}),
  }
}
async function completed(page: Page, marker: string) {
  await expect(page.getByTestId('assistant-text').last()).toContainText(marker, {
    timeout: TURN_MS,
  })
  await expect(page.getByTestId('composer-stop')).toHaveCount(0, { timeout: TURN_MS })
  await expect(page.getByTestId('failure-card')).toHaveCount(0)
}
async function allow(page: Page) {
  await expect(page.getByTestId('approval-card')).toBeVisible({ timeout: TURN_MS })
  await page.waitForTimeout(600)
  await page.getByTestId('approval-allow').click()
}
async function choose(page: Page, providerId: string, modelId: string) {
  const result = await page.evaluate(
    async ({ providerId: selectedProvider, modelId: selectedModel }) => {
      const latest = (await window.tenon.invoke('session.latest', { limit: 1 })) as {
        ok: boolean
        data: { sessionId: string } | null
      }
      if (!latest.ok || latest.data === null) throw new Error('No active persisted session')
      return window.tenon.invoke('session.selectModel', {
        sessionId: latest.data.sessionId,
        providerId: selectedProvider,
        modelId: selectedModel,
        effort: null,
      })
    },
    { providerId, modelId },
  )
  expect(result).toMatchObject({ ok: true, data: { ok: true } })
}
async function evidence(app: ElectronApplication, strict: boolean, journal: OfficialEvidence) {
  const { wire, protocol } = await journal.capture(app)
  const official = wire.filter((request) => request.url === HOST)
  expect(official.length).toBeGreaterThan(0)
  const received = official.filter((request) => request.status !== null)
  expect(received.length).toBeGreaterThan(0)
  expect(received.every((request) => request.status === 200)).toBe(true)
  const failed = official.filter((request) => request.status === null)
  const failedProtocol = protocol.filter((record) => record.status === null)
  // Match this launch's exact emitted body. A prior run/provider cannot explain a missing response.
  expect(failedProtocol).toHaveLength(failed.length)
  expect(
    failedProtocol.every(
      (record) =>
        record.requestBody !== undefined &&
        protocol
          .slice(protocol.indexOf(record) + 1)
          .some(
            (retry) =>
              retry.status === 200 &&
              retry.complete &&
              JSON.stringify(retry.requestBody) === JSON.stringify(record.requestBody),
          ),
    ),
  ).toBe(true)
  const completedProtocol = protocol.filter((record) => record.status !== null)
  const streams = received.filter((request) => request.body?.['stream'] === true)
  expect(completedProtocol).toHaveLength(streams.length)
  if (strict) expect(strictAccepted(completedProtocol)).toBe(true)
  else
    expect(completedProtocol.every((record) => record.status === 200 && record.complete)).toBe(true)
  return { wire: wire.filter((request) => request.status !== null), protocol: completedProtocol }
}
function save(info: TestInfo, journal: OfficialEvidence, userData: string) {
  let facts: ReturnType<typeof tapeFacts> = []
  try {
    facts = tapeFacts(userData)
  } catch {
    journal.failures.push('tape-snapshot-unavailable')
  }
  const dir = process.env['TENON_LIVE_RECORD_DIR'] ?? '/tmp/tenon-official-agent-records'
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${info.title.replaceAll(/[^a-zA-Z0-9]+/g, '-')}.json`),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        title: info.title,
        status: info.status,
        host: 'api.anthropic.com',
        wire: journal.wire,
        protocol: journal.protocol,
        captureFailures: journal.failures,
        facts,
      },
      null,
      2,
    ),
  )
}

test.describe('official agent product paths · acceptance 54', () => {
  test.skip(!ENABLED, 'Paid suite requires explicit TENON_LIVE_OFFICIAL_AGENT=1 and TENON_LIVE=1')
  test.describe.configure({ timeout: 900_000, mode: 'serial' })

  test('Opus 5.5 keeps frozen tools while a policy-disabled Read is not run', async () => {
    const env = credentials('strict')
    const directory = process.env['TENON_LIVE_RECORD_DIR'] ?? '/tmp/tenon-official-agent-records'
    mkdirSync(directory, { recursive: true })
    const result = await disabledToolEvidence(env['ANTHROPIC_API_KEY'] ?? '', (snapshot) => {
      writeFileSync(
        join(directory, 'official-disabled-tool.json'),
        JSON.stringify(
          {
            date: new Date().toISOString(),
            model: OPUS,
            host: HOST,
            ...snapshot,
          },
          null,
          2,
        ),
      )
    })
    expect(result.failure).toBeNull()
    expect(result.cleanupComplete).toBe(true)
    expect(result.firstEnd?.reason).toEqual({ code: 'completed' })
    expect(result.secondEnd?.reason).toEqual({ code: 'completed' })
    expect(strictAccepted(result.protocol)).toBe(true)
    expect(result.protocol).toHaveLength(result.wire.length)
    expect(result.wire.every((row) => row.url === HOST && row.status === 200)).toBe(true)
    expect(result.firstCount).toBeGreaterThanOrEqual(2)
    expect(result.wire.length - result.firstCount).toBeGreaterThanOrEqual(2)
    const tools = result.wire[0]?.body?.['tools']
    expect(Array.isArray(tools) && tools.length > 0).toBe(true)
    expect(
      result.wire.every((row) => JSON.stringify(row.body?.['tools']) === JSON.stringify(tools)),
    ).toBe(true)
    const outcomes = named(result.facts, 'execution/tool_outcome')
    expect(
      outcomes.some(
        (row) => row.payload['source'] === 'policy' && row.payload['state'] === 'not-run',
      ),
    ).toBe(true)
    expect(JSON.stringify(named(result.facts, 'tool/result'))).toContain('LIVE_READ_VALUE_A')
    expect(JSON.stringify(named(result.facts, 'tool/result'))).not.toContain(
      'LIVE_READ_VALUE_B_MUST_NOT_BE_READ',
    )
  })

  test('Opus 5.5 crosses Run approval and real Zhipu tools before returning to Anthropic', async () => {
    const info = test.info()
    if (!process.env['TENON_LIVE_ZHIPU_KEY'])
      throw new Error('Process TENON_LIVE_ZHIPU_KEY required for actual cross-provider acceptance')
    const tree = makeFolderTree('official-cross', {
      'ws/value.txt': 'CROSS_PROVIDER_FILE_VALUE_42',
    })
    const userData = makeUserDataDir('official-cross')
    seedConfig(userData, { locale: 'en', provider: { id: 'anthropic', modelId: OPUS } })
    const launched = await launchTenon({ userData, secrets: 'memory', env: credentials('strict') })
    const journal = createOfficialEvidence()
    try {
      await recordOfficialWire(launched.app)
      await startTask(launched.app, launched.page, join(tree.real, 'ws'))
      const target = join(tree.real, 'ws', 'created.txt')
      await send(
        launched.page,
        `Use Write exactly once to create ${target} containing APPROVED_FILE. After approval reply OPUS_WRITE_DONE. Do not use Bash or Agent.`,
      )
      await allow(launched.page)
      await completed(launched.page, 'OPUS_WRITE_DONE')
      expect(readFileSync(target, 'utf8')).toBe('APPROVED_FILE')
      await choose(launched.page, 'zhipu', ZHIPU)
      await send(
        launched.page,
        `Use Read exactly once on ${join(tree.real, 'ws', 'value.txt')}. Reply ZHIPU_READ_DONE and its exact content. Do not guess or use other tools.`,
      )
      await completed(launched.page, 'ZHIPU_READ_DONE')
      await expect(launched.page.getByTestId('assistant-text').last()).toContainText(
        'CROSS_PROVIDER_FILE_VALUE_42',
      )
      await choose(launched.page, 'anthropic', OPUS)
      await send(
        launched.page,
        'Reply OPUS_RETURN_DONE, preserving the preceding tool results. Do not call tools.',
      )
      await completed(launched.page, 'OPUS_RETURN_DONE')
      const { wire } = await evidence(launched.app, true, journal)
      const zhipu = wire.filter((request) => new URL(request.url).hostname === 'open.bigmodel.cn')
      expect(zhipu.length).toBeGreaterThanOrEqual(2)
      expect(zhipu.every((request) => request.status === 200)).toBe(true)
      const zhipuMessages = zhipu.flatMap((request) =>
        Array.isArray(request.body?.['messages'])
          ? (request.body['messages'] as Array<Record<string, unknown>>)
          : [],
      )
      expect(zhipuMessages.some((message) => message['role'] === 'tool')).toBe(true)
      const official = wire.filter((request) => request.url === HOST)
      expect(official.at(-1)?.body?.['model']).toBe(OPUS)
      expect(official.at(-1)?.body?.['tools']).toEqual(official[0]?.body?.['tools'])
      const facts = tapeFacts(userData)
      expect(
        named(facts, 'execution/run_started').some(
          (fact) => (fact.payload['cause'] as { kind: string }).kind === 'resume',
        ),
      ).toBe(true)
    } finally {
      try {
        await closeWithEvidence(launched.app, journal)
      } finally {
        if (!ownedProcessStopped(launched.app))
          journal.failures.push(`workspace-retained:${tree.real}`)
        try {
          save(info, journal, userData)
        } finally {
          if (ownedProcessStopped(launched.app)) tree.dispose()
        }
      }
    }
    expect(journal.failures).toEqual([])
  })

  test('Opus 5.5 performs actual threshold compaction in the product loop', async () => {
    const info = test.info()
    const userData = makeUserDataDir('official-compaction')
    seedConfig(userData, { locale: 'en', provider: { id: 'anthropic', modelId: OPUS } })
    const env = credentials('strict')
    let launch = await launchTenon({ userData, secrets: 'memory', env })
    const journal = createOfficialEvidence()
    try {
      await recordOfficialWire(launch.app)
      for (const marker of ['FIRST', 'SECOND', 'THIRD']) {
        // oxlint-disable-next-line no-await-in-loop -- each completed turn provides compactable history
        await send(
          launch.page,
          `Remember ${marker}: the project label is ${marker}. Reply only ${marker}_DONE.`,
        )
        // oxlint-disable-next-line no-await-in-loop -- preserve chronological run boundaries
        await completed(launch.page, `${marker}_DONE`)
      }
      await evidence(launch.app, true, journal)
      expect(await closeWithEvidence(launch.app, journal)).toBe(true)
      launch = await launchTenon({
        userData,
        secrets: 'memory',
        env: { ...env, TENON_E2E_COMPACTION_THRESHOLD: '1' },
      })
      await recordOfficialWire(launch.app)
      await send(launch.page, 'Reply only COMPACTION_DONE. Do not use tools.')
      await completed(launch.page, 'COMPACTION_DONE')
      const last = await evidence(launch.app, true, journal)
      const facts = tapeFacts(userData)
      expect(named(facts, 'compaction/anchor')).toHaveLength(1)
      const summaries = named(facts, 'provider/attempt_completed').filter(
        (fact) => fact.payload['compaction'] !== undefined,
      )
      expect(summaries).toHaveLength(1)
      expect(last.wire.filter((request) => request.url === HOST)).toHaveLength(2)
      expect(last.wire[0]?.body?.['tools']).toBeUndefined()
    } finally {
      try {
        await closeWithEvidence(launch.app, journal)
      } finally {
        save(info, journal, userData)
      }
    }
    expect(journal.failures).toEqual([])
  })

  test('restart resumes the frozen Opus model and tool originals after the selected model changes', async () => {
    const info = test.info()
    let restoreBuild: (() => void) | undefined
    const tree = makeFolderTree('official-resume', { 'ws/keep.txt': 'KEEP' })
    const userData = makeUserDataDir('official-resume')
    seedConfig(userData, { locale: 'en', provider: { id: 'anthropic', modelId: OPUS } })
    const env = credentials('strict')
    let launch = await launchTenon({ userData, secrets: 'memory', env })
    const journal = createOfficialEvidence()
    try {
      await recordOfficialWire(launch.app)
      await startTask(launch.app, launch.page, join(tree.real, 'ws'))
      await send(
        launch.page,
        `Use Write exactly once to create ${join(tree.real, 'ws', 'resume.txt')} containing RESUMED. Reply RESUME_DONE after approval.`,
      )
      await expect(launch.page.getByTestId('approval-card')).toBeVisible({ timeout: TURN_MS })
      const pending = await waitingApproval(launch.page)
      const before = await evidence(launch.app, true, journal)
      expect(await closeWithEvidence(launch.app, journal)).toBe(true)
      restoreBuild = changeReadDescription()
      const configPath = configPathIn(userData)
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      config['provider'] = { id: 'anthropic', modelId: SONNET }
      writeFileSync(configPath, JSON.stringify(config))
      launch = await launchTenon({ userData, secrets: 'memory', env })
      await recordOfficialWire(launch.app)
      expect((await waitingApproval(launch.page)).card.requestId).toBe(pending.card.requestId)
      await allow(launch.page)
      await completed(launch.page, 'RESUME_DONE')
      const after = await evidence(launch.app, true, journal)
      expect(
        after.wire
          .filter((request) => request.url === HOST)
          .every((request) => request.body?.['model'] === OPUS),
      ).toBe(true)
      expect(after.wire[0]?.body?.['tools']).toEqual(before.wire[0]?.body?.['tools'])
      expect(JSON.stringify(after.wire[0]?.body?.['tools'])).not.toContain(CHANGED_TOOL_SUFFIX)
      // A genuinely new tool table proves the changed bundle is loaded, rather than a no-op edit.
      const previousRequests = after.wire.length
      await newChatFromSidebar(launch.page)
      await startTask(launch.app, launch.page, join(tree.real, 'ws'))
      await send(launch.page, 'Do not call any tools. Reply only CONTROL_DONE.')
      await completed(launch.page, 'CONTROL_DONE')
      const control = await evidence(launch.app, true, journal)
      const fresh = control.wire.slice(previousRequests).filter((request) => request.url === HOST)
      expect(fresh).toHaveLength(1)
      const freshTools = fresh[0]?.body?.['tools'] as
        | Array<{ name: string; description?: string }>
        | undefined
      expect(freshTools?.find((tool) => tool.name === 'Read')?.description).toContain(
        CHANGED_TOOL_SUFFIX,
      )
    } finally {
      try {
        await closeWithEvidence(launch.app, journal)
      } finally {
        try {
          if (ownedProcessStopped(launch.app)) restoreBuild?.()
          else {
            journal.failures.push('build-restore-deferred-until-owned-process-exits')
          }
        } finally {
          if (!ownedProcessStopped(launch.app))
            journal.failures.push(`workspace-retained:${tree.real}`)
          try {
            save(info, journal, userData)
          } finally {
            if (ownedProcessStopped(launch.app)) tree.dispose()
          }
        }
      }
    }
    expect(journal.failures).toEqual([])
  })

  for (const model of [SONNET, 'claude-opus-5']) {
    test(`${model} performs a real WebSearch round trip and workspace Read smoke`, async () => {
      const info = test.info()
      const tree = makeFolderTree('official-search', { 'ws/code.txt': 'OFFICIAL_SMOKE_VALUE_73' })
      const userData = makeUserDataDir('official-search')
      seedConfig(userData, { locale: 'en', provider: { id: 'anthropic', modelId: model } })
      const launch = await launchTenon({ userData, secrets: 'memory', env: credentials('record') })
      const journal = createOfficialEvidence()
      try {
        await recordOfficialWire(launch.app)
        await startTask(launch.app, launch.page, join(tree.real, 'ws'))
        await send(
          launch.page,
          'Use WebSearch exactly once to find the official TypeScript website. Reply SEARCH_DONE and one URL from the result. Do not call other tools.',
        )
        await expect(launch.page.getByTestId('approval-card')).toContainText('api.anthropic.com', {
          timeout: TURN_MS,
        })
        await allow(launch.page)
        await completed(launch.page, 'SEARCH_DONE')
        await send(
          launch.page,
          `Use Read exactly once on ${join(tree.real, 'ws', 'code.txt')}. Reply SMOKE_DONE and the exact content. Do not use other tools.`,
        )
        await completed(launch.page, 'SMOKE_DONE')
        await expect(launch.page.getByTestId('assistant-text').last()).toContainText(
          'OFFICIAL_SMOKE_VALUE_73',
        )
        const { wire } = await evidence(launch.app, false, journal)
        const search = wire.filter(
          (request) => request.url === HOST && request.body?.['stream'] === false,
        )
        expect(search).toHaveLength(1)
        expect(search[0]?.body).toMatchObject({
          model: SONNET,
          max_tokens: 4096,
          tool_choice: { type: 'any' },
        })
        const results = named(tapeFacts(userData), 'tool/result')
        expect(
          results.some(
            (fact) =>
              Array.isArray(fact.payload['searchHitUrls']) &&
              fact.payload['searchHitUrls'].length > 0,
          ),
        ).toBe(true)
      } finally {
        try {
          await closeWithEvidence(launch.app, journal)
        } finally {
          if (!ownedProcessStopped(launch.app))
            journal.failures.push(`workspace-retained:${tree.real}`)
          try {
            save(info, journal, userData)
          } finally {
            if (ownedProcessStopped(launch.app)) tree.dispose()
          }
        }
      }
      expect(journal.failures).toEqual([])
    })
  }
})
