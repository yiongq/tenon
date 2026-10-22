import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { chatEventSchema } from '@tenon-app/contracts'
import type { ChatEvent, RunEndReasonContract, ToolOutcomeViewContract } from '@tenon-app/contracts'
import { join } from 'node:path'
import en from '../src/i18n/locales/en/common.json' with { type: 'json' }
import zh from '../src/i18n/locales/zh-CN/common.json' with { type: 'json' }
import { startFakeAnthropic } from '../test/support/fake-anthropic.js'
import { startFakeOpenAI } from '../test/support/fake-openai.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { PAST_CLICK_GUARD_MS, newChatFromSidebar } from './helpers/navigation.js'
import { closeSettings, connected, connectorCall, stdioConfig } from './helpers/connectors.js'
import { createInstance } from './helpers/instances.js'
import { expect, test } from './helpers/test.js'
import { expectSingleLineUnclipped, expectWrappedUnclipped } from './helpers/text-fit.js'
import {
  bashCall,
  callsReply,
  editCall,
  makeFolderTree,
  originMap,
  providerEnv,
  pushesOf,
  readCall,
  recordPushes,
  send,
  startTask,
  textReply,
  ZHIPU_ORIGIN,
} from './helpers/tools.js'

/** Scroll before measuring: a long thread is reachable, not clipped by its viewport. */
async function fitEach(locator: Locator, content = false, minimum = 1): Promise<void> {
  await expect(locator).not.toHaveCount(0)
  const elements = await locator.all()
  expect(elements.length).toBeGreaterThanOrEqual(minimum)
  for (const element of elements) {
    // oxlint-disable-next-line no-await-in-loop -- each element needs its own scroll position
    await element.scrollIntoViewIfNeeded()
    // oxlint-disable-next-line no-await-in-loop -- measurements follow that element's scroll
    await expect(element).toBeVisible()
    // oxlint-disable-next-line no-await-in-loop -- actual text nodes, not a flex container's boxes
    if (content) await expectWrappedUnclipped(element)
    // oxlint-disable-next-line no-await-in-loop -- interface words must also stay on one line
    else await expectSingleLineUnclipped(element)
  }
}

async function fitCard(page: Page): Promise<void> {
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible()
  await fitEach(card.getByTestId('approval-title'))
  await fitEach(card.getByTestId('approval-allow'))
  await fitEach(card.getByTestId('approval-deny'))
  await fitEach(card.getByTestId('approval-object'), true)
}

async function denyCard(page: Page): Promise<void> {
  await page.waitForTimeout(PAST_CLICK_GUARD_MS)
  await page.getByTestId('approval-deny').click()
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
  await expect(page.getByTestId('approval-answered').last()).toHaveAttribute(
    'data-outcome',
    'denied',
  )
  await fitEach(page.getByTestId('approval-answered').last())
}

/**
 * Layout-only outcome fixtures travel through the existing, validated push contract into the real
 * components. They do not run tools or grant permissions. Rare states (inspector blocks, snapshots,
 * uncertain outcomes) should not require destructive commands or an external service to measure.
 */
async function pushEvents(app: ElectronApplication, events: readonly ChatEvent[]): Promise<void> {
  const checked = events.map((event) => chatEventSchema.parse(event))
  await app.evaluate(({ BrowserWindow }, payloads) => {
    for (const event of payloads) {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('chat.event', event)
    }
  }, checked)
}

function callEvents(
  sessionId: string,
  callKey: string,
  name: string,
  input: Record<string, unknown>,
  outcome: Partial<ToolOutcomeViewContract> = {},
): ChatEvent[] {
  return [
    { type: 'tool-call', sessionId, callKey, providerToolCallId: callKey, name, input },
    {
      type: 'tool-outcome',
      sessionId,
      callKey,
      providerToolCallId: callKey,
      state: 'completed',
      source: null,
      effect: 'read',
      reversibility: 'read-only',
      output: 'layout fixture',
      isError: false,
      ...outcome,
    },
  ]
}

async function fixtureSession(app: ElectronApplication, page: Page): Promise<string> {
  await recordPushes(app)
  await send(page, 'layout fixture')
  await expect(page.getByTestId('assistant-text').last()).toHaveText('ready')
  const events = await pushesOf<ChatEvent>(app, 'chat.event')
  const ended = events.find((event) => event.type === 'done')
  expect(ended).toBeDefined()
  return ended!.sessionId
}

const ROW_NAME = '[data-testid^="model-row-"] > span:last-child > span:first-child'
const ROW_LINE = '[data-testid^="model-row-"] > span:last-child > span:last-child'
const LONG_FOLDER = 'quarterly-planning-workspace-for-the-platform-team-2026'
const INSTANCE = 'custom-00000000-0000-4000-8000-000000000010'
const LONG_MODEL = 'local-text-model-with-a-long-identifier-for-layout-regression-2026'
const COPY = { en, 'zh-CN': zh }

async function resizeWindow(app: ElectronApplication, page: Page, width: number, height: number) {
  const size = { width, height }
  await app.evaluate(({ BrowserWindow }, target) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(target.width, target.height)
  }, size)
  await page.waitForFunction(
    (target) => innerWidth === target.width && innerHeight === target.height,
    size,
  )
}

async function fitBlockLine(page: Page): Promise<void> {
  const block = page.getByTestId('composer-send-block')
  // lead: the reason and actions may occupy separate rows at 800px. Each interface label is
  // still measured as a single line below; the complete group must remain wholly unclipped.
  await expectWrappedUnclipped(block)
}

for (const locale of ['zh-CN', 'en'] as const) {
  test(`presentation-r1 验收 13: approval reasons, undo, scoped buttons, changes and collapsed lines fit at 1280x800 in ${locale}`, async () => {
    const tree = makeFolderTree(`fit-r1-cards-${locale}`, {
      'ws/a.txt': 'alpha\n',
      [`outside/${LONG_FOLDER}/a.txt`]: 'outside\n',
    })
    const ws = join(tree.real, 'ws')
    const fake = await startFakeAnthropic({
      replies: [
        callsReply(readCall('fit_read', join(tree.real, 'outside', LONG_FOLDER, 'a.txt'))),
        textReply('read'),
        callsReply(editCall('fit_edit', join(ws, 'a.txt'), 'alpha', 'beta', { replace_all: true })),
        textReply('edited'),
        callsReply({
          type: 'tool_use',
          id: 'fit_url',
          name: 'WebFetch',
          input: { url: 'https://example.com/a/long/path/for/a/page' },
        }),
        callsReply(bashCall('fit_rm', 'rm a.txt')),
      ],
    })
    const userData = makeUserDataDir(`fit-r1-cards-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await startTask(app, page, ws)
      await send(page, 'read outside')
      await fitCard(page)
      await fitEach(page.getByTestId('approval-reason'))
      await fitEach(page.getByTestId('approval-undo'))
      await fitEach(page.getByTestId('composer-pending-hint'))
      await page.waitForTimeout(PAST_CLICK_GUARD_MS)
      await page.getByTestId('approval-allow').click()
      await expect(page.getByTestId('assistant-text').last()).toHaveText('read')
      // The real path is content even though it sits beside the collapsed interface sentence.
      await fitEach(page.getByTestId('approval-answered').last(), true)

      await send(page, 'edit')
      await fitCard(page)
      await fitEach(page.getByTestId('approval-undo'))
      await fitEach(page.getByTestId('approval-change-toggle'))
      await page.getByTestId('approval-change-toggle').click()
      await expect(page.getByTestId('approval-input')).toBeVisible()
      await fitEach(page.getByTestId('approval-change-toggle'))
      await fitEach(page.getByTestId('approval-change-label'), false, 2)
      await fitEach(page.getByTestId('approval-change-note'))
      await fitEach(page.getByTestId('approval-change-text'), true, 2)
      await page.waitForTimeout(PAST_CLICK_GUARD_MS)
      await page.getByTestId('approval-allow').click()
      await expect(page.getByTestId('assistant-text').last()).toHaveText('edited')
      await fitEach(page.getByTestId('approval-answered').last(), true)
      await page.getByTestId('tool-row').last().getByTestId('tool-row-line').click()
      await fitEach(page.getByTestId('tool-side-effects'))
      await fitEach(page.getByTestId('turn-summary').last())

      // The URL is denied before a fetch, so this test never contacts the web.
      await send(page, 'fetch')
      await fitCard(page)
      await fitEach(page.getByTestId('approval-reason'), true)
      await denyCard(page)
      await send(page, 'delete')
      await fitCard(page)
      await fitEach(page.getByTestId('approval-irreversible'))
      await denyCard(page)
    } finally {
      await app.close()
      await fake.close()
      tree.dispose()
    }
  })

  test(`presentation-r1 验收 13: connector sentence, card and expanded consequence fit at 1280x800 in ${locale}`, async () => {
    const fake = await startFakeAnthropic({
      replies: [callsReply(connectorCall('fit_connector', 'echo')), textReply('done')],
    })
    const userData = makeUserDataDir(`fit-r1-connector-${locale}`)
    seedConfig(userData, { locale, mcpServers: [stdioConfig()] })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await connected(page)
      await send(page, 'echo')
      await fitCard(page)
      await fitEach(page.getByTestId('approval-server'))
      await fitEach(page.getByTestId('approval-undo'))
      await fitEach(page.getByTestId('tool-row-line'), true)
      await page.waitForTimeout(PAST_CLICK_GUARD_MS)
      await page.getByTestId('approval-allow').click()
      await expect(page.getByTestId('assistant-text').last()).toHaveText('done')
      await fitEach(page.getByTestId('approval-answered'))
      await page.getByTestId('tool-row-line').click()
      await fitEach(page.getByTestId('tool-side-effects'))
      await fitEach(page.getByTestId('turn-summary'))
    } finally {
      await app.close()
      await fake.close()
    }
  })

  test(`presentation-r1 验收 13: block receipts, row consequences, irreversible tooltip, six summary counts and failure groups fit at 1280x800 in ${locale}`, async () => {
    const fake = await startFakeAnthropic({ chunks: ['ready'], delayMs: 5 })
    const tree = makeFolderTree(`fit-r1-outcomes-${locale}`, { 'ws/a.txt': 'a' })
    const userData = makeUserDataDir(`fit-r1-outcomes-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      await startTask(app, page, join(tree.real, 'ws'))
      const sessionId = await fixtureSession(app, page)
      const receipts = [
        ['policy', 'Read', {}],
        ['user-disabled', 'Write', {}],
        ['protected', 'Read', {}],
        ['protected', 'Write', {}],
        ['protected', 'WebFetch', {}],
        ['inspector', 'Read', { category: 'exfiltration' }],
        ['inspector', 'Read', { category: 'inspector-failed' }],
      ] as const
      await pushEvents(
        app,
        receipts.flatMap(([source, name, facts], n) =>
          callEvents(
            sessionId,
            `receipt-${n}`,
            name,
            { file_path: '/protected/a.txt' },
            {
              state: 'not-run',
              source,
              effect: 'blocked',
              facts,
              isError: true,
            },
          ),
        ),
      )
      await expect(page.getByTestId('blocked-notice')).toHaveCount(7)
      await fitEach(page.getByTestId('blocked-notice').locator('p'), false, 7)

      const calls = [
        ...callEvents(sessionId, 'read-one', 'Read', { file_path: '/one/a.txt' }),
        ...callEvents(sessionId, 'read-two', 'Read', { file_path: '/two/a.txt' }),
        ...callEvents(sessionId, 'read-again', 'Read', { file_path: '/one/a.txt' }),
        ...callEvents(sessionId, 'search', 'Grep', { pattern: 'layout' }),
        ...callEvents(
          sessionId,
          'write',
          'Edit',
          { file_path: '/one/a.txt' },
          {
            effect: 'write',
            reversibility: 'unknown',
          },
        ),
        ...callEvents(
          sessionId,
          'command',
          'Bash',
          { command: 'printf layout' },
          {
            effect: 'external',
            reversibility: 'irreversible',
          },
        ),
        ...callEvents(
          sessionId,
          'online',
          'WebFetch',
          { url: 'https://example.com/page' },
          {
            effect: 'external',
            reversibility: 'unknown',
          },
        ),
        ...callEvents(
          sessionId,
          'connector',
          'notes__echo',
          {},
          {
            effect: 'external',
            reversibility: 'unknown',
          },
        ),
      ]
      await pushEvents(app, [
        ...calls,
        {
          type: 'done',
          sessionId,
          stopReason: 'end-turn',
          endReason: { code: 'step-limit', limit: 20 },
        },
      ])
      const summary = page.getByTestId('turn-summary').last()
      await expect(summary).toHaveText(
        locale === 'en'
          ? 'Read 2 files · Searched files 1 time · Changed 1 file · Ran 1 command · Went online 1 time · Used connectors 1 time'
          : '读了 2 个文件 · 查找 1 次 · 改了 1 个文件 · 运行了 1 条命令 · 联网 1 次 · 用了连接器 1 次',
      )
      await fitEach(summary)
      for (const key of ['write', 'command', 'online', 'connector']) {
        const row = page.locator(`[data-testid="tool-row"][data-call-key="${key}"]`)
        // oxlint-disable-next-line no-await-in-loop -- expand one real row at a time
        await row.getByTestId('tool-row-line').click()
        // oxlint-disable-next-line no-await-in-loop -- its sentence is visible only when expanded
        await fitEach(row.getByTestId('tool-side-effects'))
      }
      const marker = page.getByTestId('tool-effect-marker')
      await expect(marker).toHaveCount(1)
      await marker.hover()
      const tooltip = page.getByRole('tooltip')
      await expect(tooltip).toHaveText(locale === 'en' ? "Can't be undone" : '撤不回')
      await fitEach(tooltip)
      // Move off the marker so its tooltip cannot cover a later action.
      await page.getByTestId('composer-input').hover()
      await expect(tooltip).toBeHidden()
      const failure = page.getByTestId('failure-card').last()
      await fitEach(failure.getByTestId('failure-what'))
      await fitEach(failure.getByTestId('failure-action'))
      await fitEach(failure.getByTestId('failure-effects').locator(':scope > p'))
      await fitEach(failure.getByTestId('failure-effects-done').locator('li'), true, 5)
      const more = failure.getByTestId('failure-effects-more')
      await fitEach(more.locator('summary'))
      await more.locator('summary').click()
      await expect(more.locator('li').first()).toBeVisible()
      await fitEach(more.locator('li'), true)

      // A chat's protected Read has its own receipt, distinct from the task's protected Read.
      await newChatFromSidebar(page)
      await expect(page.getByTestId('thread-empty')).toBeVisible()
      const chatSession = await fixtureSession(app, page)
      await pushEvents(
        app,
        callEvents(
          chatSession,
          'chat-read',
          'Read',
          { file_path: '/a.txt' },
          {
            state: 'not-run',
            source: 'protected',
            effect: 'blocked',
            isError: true,
          },
        ),
      )
      await expect(page.getByTestId('blocked-notice')).toHaveCount(1)
      await fitEach(page.getByTestId('blocked-notice').locator('p'))
      await pushEvents(app, [
        ...callEvents(
          chatSession,
          'allowed-command',
          'Bash',
          { command: 'printf layout' },
          {
            approval: {
              outcome: 'allowed',
              scope: 'once',
              target: {
                type: 'command',
                command: 'printf layout',
                cwd: '/a/long/folder/for/commands',
              },
            },
          },
        ),
        ...callEvents(
          chatSession,
          'allowed-search',
          'WebSearch',
          { query: 'layout' },
          {
            approval: {
              outcome: 'allowed',
              scope: 'session',
              target: {
                type: 'search',
                query: 'layout',
                host: 'search.e2e.test',
              },
            },
          },
        ),
        ...callEvents(
          chatSession,
          'allowed-url',
          'WebFetch',
          { url: 'https://аpple.com./x' },
          {
            approval: {
              outcome: 'allowed',
              scope: 'session',
              target: {
                type: 'url',
                url: 'https://аpple.com./x',
              },
            },
          },
        ),
      ])
      await expect(page.getByTestId('approval-answered')).toHaveCount(3)
      await fitEach(page.getByTestId('approval-answered'), true, 3)
    } finally {
      await app.close()
      await fake.close()
      tree.dispose()
    }
  })

  test(`presentation-r1 验收 13: provider failure sentences and the phase-one auth action fit at 1280x800 in ${locale}`, async () => {
    const fake = await startFakeAnthropic({ chunks: ['ready'], delayMs: 5 })
    const userData = makeUserDataDir(`fit-r1-failure-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({ userData, env: providerEnv(fake.baseURL) })
    try {
      const sessionId = await fixtureSession(app, page)
      const reasons: RunEndReasonContract[] = [
        { code: 'refusal', providerId: 'anthropic', modelId: 'claude-opus-5-5' },
        { code: 'content-filter', providerId: 'anthropic' },
        { code: 'quota-exhausted', providerId: 'anthropic', resetAt: null },
        { code: 'account-config', providerId: 'anthropic' },
        { code: 'no-progress', repeats: 3 },
        { code: 'usage-limit', tokenLimit: 100000 },
        { code: 'context-overflow', compactions: 2 },
        { code: 'output-truncated', maxTokens: 8192 },
        ...(
          [
            'auth',
            'rate-limit',
            'overloaded',
            'invalid-request',
            'context-overflow',
            'network',
            'egress-denied',
            'server',
            'unknown',
            'quota-exhausted',
            'account-config',
          ] as const
        ).map((errorCode) => ({
          code: 'provider-error' as const,
          providerId: 'anthropic',
          errorCode,
          providerReason: null,
          attempts: 1,
        })),
      ]
      for (const reason of reasons) {
        // oxlint-disable-next-line no-await-in-loop -- each terminal event starts a distinct card
        await pushEvents(app, [{ type: 'error', sessionId, code: 'provider', endReason: reason }])
        const card = page.getByTestId('failure-card').last()
        // oxlint-disable-next-line no-await-in-loop -- await the newly rendered card
        await expect(page.getByTestId('failure-card')).toHaveCount(reasons.indexOf(reason) + 1)
        if ('providerId' in reason) {
          // oxlint-disable-next-line no-await-in-loop -- wait for the asynchronous provider list
          await expect(card.getByTestId('failure-what')).toContainText('Anthropic')
        }
        // oxlint-disable-next-line no-await-in-loop -- provider/model names are data and may wrap
        await fitEach(card.getByTestId('failure-what'), true)
        // oxlint-disable-next-line no-await-in-loop -- the other two lines are interface copy
        await fitEach(card.getByTestId('failure-effects').locator('p'))
        // oxlint-disable-next-line no-await-in-loop -- measure each action in its own card
        await fitEach(card.getByTestId('failure-action'))
      }
      for (const code of ['auth', 'network', 'rate-limit', 'provider', 'unknown'] as const) {
        // oxlint-disable-next-line no-await-in-loop -- a separate rendered error for every code
        await pushEvents(app, [{ type: 'error', sessionId, code }])
        const error = page.getByTestId('message-error').last()
        // oxlint-disable-next-line no-await-in-loop -- wait for this code, not the previous error
        await expect(error).toHaveAttribute('data-error-code', code)
        // oxlint-disable-next-line no-await-in-loop -- each interface sentence is measured
        await fitEach(error.getByTestId('message-error-text'))
        // oxlint-disable-next-line no-await-in-loop -- auth adds the settings action
        if (code === 'auth') await fitEach(error.getByTestId('message-settings'))
      }
    } finally {
      await app.close()
      await fake.close()
    }
  })

  test(`presentation-r1 验收 13: folder popover, prefill, menu headers and text-only disabled reason fit at 1280x800 in ${locale}`, async () => {
    const fake = await startFakeAnthropic({ chunks: ['ready'], delayMs: 5 })
    const probe = await startFakeOpenAI({
      replies: [
        {
          steps: [
            { type: 'reasoning', text: 'Read the probe file.' },
            {
              type: 'tool_call',
              id: 'probe_read',
              name: 'Read',
              input: { file_path: '/tenon-probe/ping.txt' },
            },
          ],
        },
        { steps: [{ type: 'text', text: 'ok' }] },
      ],
      delayMs: 5,
    })
    const tree = makeFolderTree(`fit-r1-folders-${locale}`, { [`${LONG_FOLDER}/a.txt`]: 'a' })
    const userData = makeUserDataDir(`fit-r1-folders-${locale}`)
    seedConfig(userData, {
      locale,
      providerConfig: { zhipu: { baseURL: 'https://wrong.e2e.test' } },
    })
    const { app, page } = await launchTenon({
      userData,
      env: providerEnv(fake.baseURL, { 'https://layout.e2e.test': probe.baseURL }),
    })
    try {
      await page.getByTestId('folder-toggle').click()
      await expect(page.getByTestId('folder-chip')).toBeVisible()
      await fitEach(page.getByTestId('folder-chip-name'))
      await page.getByTestId('folder-chip').click()
      const popup = page.getByTestId('folder-popover')
      await expect(popup).toHaveAttribute('data-open', '')
      await fitEach(popup.getByTestId('folder-dedicated-note'))
      await fitEach(popup.getByTestId('folder-add'))
      await fitEach(popup.getByTestId('folder-cwd'))
      await fitEach(popup.getByTestId('folder-path'), true)
      await page.keyboard.press('Escape')
      await expect(popup).toHaveCount(0)
      await startTask(app, page, join(tree.real, LONG_FOLDER))
      await newChatFromSidebar(page)
      await expect(page.getByTestId('folder-toggle')).toHaveAttribute('aria-checked', 'false')
      await page.getByTestId('folder-toggle').click()
      await expect(popup).toHaveAttribute('data-open', '')
      await expect(popup.getByTestId('folder-prefill')).toBeVisible()
      await fitEach(popup.getByTestId('folder-prefill-offer').locator(':scope > p:first-child'))
      await fitEach(popup.getByTestId('folder-prefill'))
      await fitEach(popup.getByTestId('folder-prefill-path'), true)
      await page.keyboard.press('Escape')
      await expect(popup).toHaveCount(0)

      await page.getByTestId('model-menu-trigger').click()
      const menu = page.getByTestId('model-menu')
      await expect(menu).toBeVisible()
      await fitEach(menu.locator('[data-testid^="model-group-"] > :first-child'))
      await fitEach(menu.getByTestId('model-unconfigured-zhipu'))
      await fitEach(menu.locator(ROW_NAME), true, 5)
      await fitEach(menu.locator(ROW_LINE), false, 5)
      const local = menu.getByTestId('model-row-ollama-qwen3:8b')
      await expect(local).toHaveAttribute('aria-disabled', 'true')
      await expect(local).toContainText(COPY[locale].model.row.textOnlyInTask)
      // Both missing-key and refused-address group headers, and official host descriptions.
      const row = menu.getByTestId('model-row-anthropic-claude-opus-5-5')
      await row.hover()
      const tooltip = page.getByTestId('model-row-host-tooltip').and(page.locator('[data-open]'))
      await expect(tooltip).toHaveText(
        locale === 'en' ? 'Sends to api.anthropic.com' : '发往 api.anthropic.com',
      )
      await fitEach(tooltip, true)
      // Hovering a tooltip does not focus its row; Escape may only dismiss that tooltip.
      // Toggle the owning menu, then wait for its exit animation to finish before reopening it.
      await page.getByTestId('model-menu-trigger').click()
      await expect(menu).toHaveCount(0)
      expect(
        await page.evaluate(() =>
          window.tenon.invoke('provider.configure', {
            id: 'zhipu',
            values: { baseURL: 'https://open.bigmodel.cn/api/paas/v4/' },
          }),
        ),
      ).toMatchObject({ ok: true, data: { ok: true } })
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.getByTestId('model-menu-trigger').click()
      await expect(menu).toBeVisible()
      await expect(menu.getByTestId('model-unconfigured-zhipu')).toContainText(
        locale === 'en' ? 'Add an API key in Settings' : '去设置填 API 密钥',
      )
      await fitEach(menu.getByTestId('model-unconfigured-zhipu'))
      await page.getByTestId('model-menu-trigger').click()
      await expect(menu).toHaveCount(0)

      const instance = await createInstance(page, {
        displayName: 'Layout provider',
        wire: 'openai-chat',
        baseURL: 'https://layout.e2e.test/v1',
        apiKey: 'e2e-layout-probe-key',
      })
      expect(
        await page.evaluate(
          (id) =>
            window.tenon.invoke('customVendor.update', {
              id,
              models: ['probed-row', 'text-row'].map((modelId) => ({
                id: modelId,
                contextLimit: 32768,
                maxOutputTokens: 2048,
              })),
            }),
          instance,
        ),
      ).toMatchObject({ ok: true, data: { ok: true } })
      expect(
        await page.evaluate(
          (id) =>
            window.tenon.invoke('customVendor.probe', {
              id,
              modelId: 'probed-row',
            }),
          instance,
        ),
      ).toMatchObject({
        ok: true,
        data: { status: 'done', saved: true, snapshot: { outcome: 'passed' } },
      })
      await page.getByTestId('model-menu-trigger').click()
      await expect(menu).toBeVisible()
      const probed = menu.getByTestId(`model-row-${instance}-probed-row`)
      await expect(probed).toContainText(
        locale === 'en'
          ? 'Probe passed · not guaranteed · layout.e2e.test'
          : '探测通过 · 不保证 · layout.e2e.test',
      )
      await fitEach(probed.locator('span:last-child > span:last-child'), true)
      await fitEach(
        menu
          .getByTestId(`model-row-${instance}-text-row`)
          .locator('span:last-child > span:last-child'),
      )
      await menu.getByTestId('model-manage').click()
      await expect(page.getByTestId('provider-settings')).toBeVisible()
      await expect(menu).toHaveCount(0)
      await expect(page.getByTestId('custom-vendors')).toBeVisible()
      // The sole instance opens expanded on the settings read. Do not fold it before measuring
      // its already-passed probe; with several instances, expand only when it is actually closed.
      const toggle = page.getByTestId(`custom-vendor-toggle-${instance}`)
      await expect(toggle).toBeVisible()
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      const status = page.getByTestId(`custom-vendor-probe-status-${instance}-probed-row`)
      await expect(status).toHaveAttribute('data-outcome', 'passed')
      await fitEach(status)
      await closeSettings(page)
    } finally {
      await app.close()
      await fake.close()
      await probe.close()
      tree.dispose()
    }
  })
}

/** Icon controls have no text to wrap; their boxes must still fit beside the text chips. */
async function fitTools(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar')).toBeVisible()
  await fitEach(page.getByTestId('model-menu-current'), true)
  await expectWrappedUnclipped(page.getByTestId('composer-tools'))
  const row = (await page.getByTestId('composer-tools').boundingBox())!
  for (const id of [
    'folder-toggle',
    'folder-chip',
    'composer-stop',
    'model-menu-trigger',
    'composer-send',
  ]) {
    const control = page.getByTestId(id)
    // oxlint-disable-next-line no-await-in-loop -- optional controls depend on the current state
    if (!(await control.isVisible())) continue
    // oxlint-disable-next-line no-await-in-loop -- all controls must be inside the same tool row
    const box = (await control.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(row.x)
    expect(box.x + box.width).toBeLessThanOrEqual(row.x + row.width + 1)
    expect(box.y).toBeGreaterThanOrEqual(row.y)
    expect(box.y + box.height).toBeLessThanOrEqual(row.y + row.height + 1)
  }
}

for (const locale of ['zh-CN', 'en'] as const) {
  test(`presentation-r1 验收 13: the tool row, long folder chip, stop and pending line fit at 800x520 with the sidebar expanded in ${locale}`, async () => {
    const tree = makeFolderTree(`fit-r1-narrow-${locale}`, {
      [`${LONG_FOLDER}/a.txt`]: 'a',
      'outside/a.txt': 'outside',
    })
    const fake = await startFakeAnthropic({
      replies: [callsReply(readCall('narrow_card', join(tree.real, 'outside/a.txt')))],
    })
    const userData = makeUserDataDir(`fit-r1-narrow-${locale}`)
    seedConfig(userData, { locale })
    const { app, page } = await launchTenon({
      userData,
      env: providerEnv(fake.baseURL),
      contentSize: { width: 800, height: 520 },
    })
    try {
      await expect(page.getByTestId('folder-toggle')).toBeVisible()
      await fitEach(page.getByTestId('folder-toggle').locator('xpath=..').locator('span').last())
      await fitTools(page)
      await startTask(app, page, join(tree.real, LONG_FOLDER))
      await fitEach(page.getByTestId('folder-chip-name'), true)
      await fitTools(page)
      await send(page, 'read outside')
      await expect(page.getByTestId('approval-card')).toBeVisible()
      await expect(page.getByTestId('composer-stop')).toBeVisible()
      await fitTools(page)
      await fitEach(page.getByTestId('composer-pending-hint'))
      await denyCard(page)
      await fitEach(page.getByTestId('composer-disclaimer'))
    } finally {
      await app.close()
      await fake.close()
      tree.dispose()
    }
  })

  for (const reason of [
    'noKey',
    'addressRefused',
    'modelRemoved',
    'textOnlyTask',
    'textOnlyTaskEstablished',
  ] as const) {
    test(`presentation-r1 验收 13: ${reason}, switch and settings fit at 1280x800 and 800x520 with the sidebar expanded in ${locale}`, async () => {
      const fake = await startFakeAnthropic({ chunks: ['ready'], delayMs: 5 })
      const local = await startFakeOpenAI({ chunks: ['ready'], delayMs: 5 })
      const userData = makeUserDataDir(`fit-r1-${reason}-${locale}`)
      const textOnly = reason === 'textOnlyTask' || reason === 'textOnlyTaskEstablished'
      seedConfig(userData, {
        locale,
        provider:
          reason === 'modelRemoved' || reason === 'textOnlyTask'
            ? { id: INSTANCE, modelId: LONG_MODEL }
            : { id: 'anthropic', modelId: 'claude-opus-5-5' },
        providerConfig:
          reason === 'addressRefused' ? { anthropic: { baseURL: 'https://wrong.e2e.test' } } : {},
        customVendors: [
          {
            id: INSTANCE,
            displayName: 'Layout fixture',
            wire: 'openai-chat',
            baseURL: local.baseURL,
            models: [
              {
                id: LONG_MODEL,
                contextLimit: 32768,
                maxOutputTokens: 2048,
              },
            ],
          },
        ],
      })
      const { app, page } = await launchTenon({
        userData,
        env: textOnly
          ? providerEnv(fake.baseURL)
          : {
              ZHIPU_API_KEY: 'e2e-layout-zhipu-key',
              ...originMap({ [ZHIPU_ORIGIN]: local.baseURL }),
            },
        contentSize: { width: 800, height: 520 },
      })
      try {
        if (reason === 'modelRemoved') {
          const sessionId = await fixtureSession(app, page)
          // A removed default falls back normally. Pin the session's own choice first, as in
          // custom-vendor.spec.ts, so deletion leaves an actual removed selection to measure.
          expect(
            await page.evaluate(
              ({ sessionId: id, providerId, modelId }) =>
                window.tenon.invoke('session.selectModel', {
                  sessionId: id,
                  providerId,
                  modelId,
                  effort: null,
                }),
              { sessionId, providerId: INSTANCE, modelId: LONG_MODEL },
            ),
          ).toMatchObject({ ok: true, data: { ok: true } })
          expect(
            await page.evaluate(
              (id) => window.tenon.invoke('customVendor.delete', { id }),
              INSTANCE,
            ),
          ).toMatchObject({ ok: true, data: { ok: true } })
        }
        if (textOnly) {
          if (reason === 'textOnlyTaskEstablished') {
            // The existing route can move a task to a text-only row (e.g. another settings
            // surface); the menu disables that row. Here we measure the established-task hint.
            await page.getByTestId('folder-toggle').click()
            await expect(page.getByTestId('folder-chip')).toBeVisible()
            const establishedSession = await fixtureSession(app, page)
            expect(
              await page.evaluate(
                ({ sessionId, providerId, modelId }) =>
                  window.tenon.invoke('session.selectModel', {
                    sessionId,
                    providerId,
                    modelId,
                    effort: null,
                  }),
                { sessionId: establishedSession, providerId: INSTANCE, modelId: LONG_MODEL },
              ),
            ).toMatchObject({ ok: true, data: { ok: true } })
          } else {
            await page.getByTestId('folder-toggle').click()
            await expect(page.getByTestId('folder-chip')).toBeVisible()
          }
        }
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        const block = page.getByTestId('composer-send-block')
        await expect(block).toHaveAttribute(
          'data-reason',
          textOnly ? 'textOnlyTask' : reason === 'noKey' ? 'modelUnusable' : reason,
        )
        await expect(page.getByTestId('composer-block-reason')).toHaveText(
          COPY[locale].composer[reason],
        )
        // Stress the data slot X with the longest builtin provider + model display names. The
        // actual switch's selection semantics are covered by provider-settings/model-menu.spec;
        // here only its data text changes, retaining the real button and its surrounding layout.
        const change = page.getByTestId('composer-switch-model')
        if (!textOnly) {
          await expect(change).toBeVisible()
          await expect(change).toHaveText(
            locale === 'en' ? 'Switch to Zhipu GLM GLM-5.3' : '改用 智谱 GLM GLM-5.3',
          )
          await expect(change).toHaveAccessibleDescription(
            locale === 'en' ? 'Sends to open.bigmodel.cn' : '发往 open.bigmodel.cn',
          )
          const common = COPY[locale]
          const pairs = [
            ...['opus55', 'sonnet5', 'opus5', 'haiku45', 'fable51'].map((key) => ({
              provider: common.provider.anthropic.name,
              model: common.model.name[key as keyof typeof common.model.name],
            })),
            ...['glm53', 'glm53flash', 'glm53flashx', 'glm46'].map((key) => ({
              provider: common.provider.zhipu.name,
              model: common.model.name[key as keyof typeof common.model.name],
            })),
            { provider: common.provider.ollama.name, model: 'qwen3:8b' },
          ]
          const widest = await change.evaluate(
            (element, { candidates, template }) => {
              const ctx = document.createElement('canvas').getContext('2d')!
              ctx.font = getComputedStyle(element).font
              const best = candidates.toSorted(
                (a, b) =>
                  ctx.measureText(`${b.provider} ${b.model}`).width -
                  ctx.measureText(`${a.provider} ${a.model}`).width,
              )[0]!
              element.textContent = template
                .replace('{provider}', best.provider)
                .replace('{model}', best.model)
              return best
            },
            { candidates: pairs, template: common.composer.switchModel },
          )
          // The stress label must stay on the real target provider, keeping its destination true.
          expect(widest.provider).toBe(common.provider.zhipu.name)
          await fitEach(change)
          await change.hover()
          const tooltip = page.getByTestId('composer-switch-tooltip')
          await expect(tooltip).toHaveText(
            locale === 'en' ? 'Sends to open.bigmodel.cn' : '发往 open.bigmodel.cn',
          )
          await fitEach(tooltip, true)
          await page.getByTestId('composer-input').hover()
          await expect(tooltip).toBeHidden()
        }
        for (const size of [
          { width: 1280, height: 800 },
          { width: 800, height: 520 },
        ]) {
          // oxlint-disable-next-line no-await-in-loop -- the same actual components at both sizes
          await resizeWindow(app, page, size.width, size.height)
          if (reason === 'noKey' || reason === 'addressRefused') {
            // oxlint-disable-next-line no-await-in-loop -- measure after the viewport change
            await fitEach(page.getByTestId('composer-settings'))
          }
          // oxlint-disable-next-line no-await-in-loop -- none of the three reasons may wrap
          await fitEach(page.getByTestId('composer-block-reason'))
          // oxlint-disable-next-line no-await-in-loop -- rows may wrap, but no text may be clipped
          await fitBlockLine(page)
          // oxlint-disable-next-line no-await-in-loop -- also check the chips and icon bounds
          await fitTools(page)
        }
      } finally {
        await app.close()
        await fake.close()
        await local.close()
      }
    })
  }
}
