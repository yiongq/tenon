import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { startFakeOpenAI } from '../test/support/fake-openai.js'
import type { FakeOpenAI } from '../test/support/fake-openai.js'
import type { Page } from '@playwright/test'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import type { LaunchedApp } from './helpers/launch.js'
import { COUNT_ROUTES, routeCalls } from './helpers/navigation.js'
import { expect, test } from './helpers/test.js'
import { providerEnv, pushesOf, recordPushes, send } from './helpers/tools.js'

/** A `chat.queue` push as main sent it. */
interface QueuePush {
  readonly items: ReadonlyArray<{ readonly queuedId: string; readonly text: string }>
  readonly held?: { readonly host: string }
}

/** zhipu's default endpoint, which nothing here sends to. */
const ZHIPU_HOST = 'open.bigmodel.cn'
const HELD_FOR_ZHIPU = `Earlier messages will be sent to ${ZHIPU_HOST}`

/**
 * The model menu in the real shell (spec 02 §模型菜单与输入框; plan step 19: 旧 38, 旧 39, the menu
 * half of 旧 186 and 旧 37). A fake endpoint stands in for each provider that is sent to; zhipu keeps
 * its public default host, so the confirmation before history leaves this computer can be seen —
 * nothing here sends to it.
 */
let anthropic: FakeAnthropic | undefined
let ollama: FakeOpenAI | undefined

test.afterEach(async () => {
  await anthropic?.close()
  await ollama?.close()
  anthropic = undefined
  ollama = undefined
})

test('lists configured providers by host, greys the rest, and names the thinking level (旧 39, 旧 186)', async () => {
  anthropic = await startFakeAnthropic({ chunks: ['ok'], delayMs: 5 })
  const userData = makeUserDataDir('model-menu')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ANTHROPIC_BASE_URL: anthropic.baseURL, ANTHROPIC_API_KEY: 'e2e-anthropic-key' },
  })
  try {
    // Nothing chosen: the first row, and its default level.
    await expect(page.getByTestId('model-menu-current')).toHaveText('claude-opus-5-5 · Medium')
    await page.getByTestId('model-menu-trigger').click()
    const menu = page.getByTestId('model-menu')
    await expect(menu).toBeVisible()
    // The fake endpoint is on this computer; Ollama's default is too.
    await expect(page.getByTestId('model-row-anthropic-claude-sonnet-5')).toContainText(
      'This computer',
    )
    await expect(page.getByTestId('model-row-ollama-qwen3:8b')).toContainText(
      'This computer · text conversation only',
    )
    // No key for zhipu: one greyed row that opens the settings card, no zhipu model to pick.
    await expect(page.getByTestId('model-unconfigured-zhipu')).toHaveText(
      'Zhipu GLM · Add a key in Settings',
    )
    await expect(page.locator('[data-testid^="model-row-zhipu-"]')).toHaveCount(0)
    // Opus 5 waits under 更多模型 ›, not in the main list.
    await expect(page.getByTestId('model-row-anthropic-claude-opus-5')).toHaveCount(0)
    // Haiku thinks on a budget: once chosen, no thinking submenu.
    await page.getByTestId('model-row-anthropic-claude-haiku-4-5-20251001').click()
    await expect(page.getByTestId('model-menu-current')).toHaveText('claude-haiku-4-5-20251001')
    await page.getByTestId('model-menu-trigger').click()
    await expect(page.getByTestId('model-effort')).toHaveCount(0)
    await page.getByTestId('model-unconfigured-zhipu').click()
    await expect(page.getByTestId('provider-settings')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('names a private Ollama host by its address: only a loopback one reads as this computer (旧 185, 旧 219)', async () => {
  // Nothing is sent: the row's host line comes from `provider.list` alone.
  const userData = makeUserDataDir('model-menu-private')
  seedConfig(userData, {
    locale: 'en',
    providerConfig: { ollama: { baseURL: 'http://192.168.1.20:11434/v1/' } },
  })
  const { app, page } = await launchTenon({ userData })
  try {
    await page.getByTestId('model-menu-trigger').click()
    await expect(page.getByTestId('model-menu')).toBeVisible()
    const row = page.getByTestId('model-row-ollama-qwen3:8b')
    await expect(row).toContainText('192.168.1.20 · text conversation only')
    await expect(row).not.toContainText('This computer')
  } finally {
    await app.close()
  }
})

test('asks before history on this computer goes to a public host, and can open a new chat instead (旧 38)', async () => {
  ollama = await startFakeOpenAI({ chunks: ['local ', 'answer'], delayMs: 5 })
  const userData = makeUserDataDir('model-confirm')
  seedConfig(userData, {
    locale: 'en',
    provider: { id: 'ollama', modelId: 'qwen3:8b' },
    providerConfig: { ollama: { baseURL: ollama.baseURL } },
  })
  const { app, page } = await launchTenon({ userData, env: { ZHIPU_API_KEY: 'e2e-zhipu-key' } })
  try {
    await page.getByTestId('composer-input').fill('keep this local')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('assistant-message').getByTestId('assistant-text')).toHaveText(
      'local answer',
    )
    expect(ollama.requests).toHaveLength(1)
    // An Ollama request never carries tools (旧 41).
    expect(ollama.requests[0]?.body).not.toHaveProperty('tools')

    await page.getByTestId('model-menu-trigger').click()
    await page.getByTestId('model-row-zhipu-glm-5.3-flash').click()
    // The menu turns into the confirmation, in place: no native dialog.
    await expect(page.getByTestId('model-confirm')).toContainText(
      'Earlier messages will be sent to open.bigmodel.cn',
    )
    // Backing out leaves the session's choice as it was (旧 185).
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('model-menu')).toBeHidden()
    await expect(page.getByTestId('model-menu-current')).toHaveText('qwen3:8b')
    await page.getByTestId('model-menu-trigger').click()
    await page.getByTestId('model-row-zhipu-glm-5.3-flash').click()
    await page.getByTestId('model-confirm-new-chat').click()
    // A new, empty chat on the new model; the old one sent nothing more anywhere.
    await expect(page.getByTestId('thread-empty')).toBeVisible()
    await expect(page.getByTestId('model-menu-current')).toHaveText('glm-5.3-flash · Max')
    expect(ollama.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('asks by where the history went, not by the model in effect, and a typed model’s row names its host as the others do (A9, A15, s19-spec-1)', async () => {
  ollama = await startFakeOpenAI({ chunks: ['local ', 'answer'], delayMs: 5 })
  const userData = makeUserDataDir('model-public')
  seedConfig(userData, {
    locale: 'en',
    provider: { id: 'ollama', modelId: 'qwen3:8b' },
    providerConfig: { ollama: { baseURL: ollama.baseURL } },
  })
  // Anthropic on its own public host this time: a key and no base URL. Nothing is sent to it.
  const { app, page } = await launchTenon({
    userData,
    env: { ZHIPU_API_KEY: 'e2e-zhipu-key', ANTHROPIC_API_KEY: 'e2e-anthropic-key' },
  })
  try {
    await page.getByTestId('composer-input').fill('some history')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('assistant-text')).toHaveText('local answer')
    const current = page.getByTestId('model-menu-current')
    const trigger = page.getByTestId('model-menu-trigger')
    // This computer → a public host: the confirmation, then the switch.
    await trigger.click()
    await page.getByTestId('model-row-zhipu-glm-5.3-flash').click()
    await page.getByTestId('model-confirm-switch').click()
    await expect(current).toHaveText('glm-5.3-flash · Max')
    // A level of the session's own choice goes where the switch was just confirmed: asked nothing
    // more, though no Run has gone there yet (rrE-1).
    await trigger.click()
    await page.getByTestId('model-effort').hover()
    await page.getByTestId('model-effort-high').click()
    await expect(current).toHaveText('glm-5.3-flash · High')
    await expect(page.getByTestId('model-confirm')).toHaveCount(0)
    // Nothing has gone to zhipu yet, so another public host is asked about too, by its own name:
    // the menu compares with where the history went, not with the model in effect (a public host
    // to another after the history did go out asks nothing: renderer-data-flow.test.ts).
    await trigger.click()
    await page.getByTestId('model-row-anthropic-claude-sonnet-5').click()
    await expect(page.getByTestId('model-confirm')).toContainText(
      'Earlier messages will be sent to api.anthropic.com',
    )
    await page.getByTestId('model-confirm-switch').click()
    await expect(current).toHaveText('claude-sonnet-5 · High')

    // A model typed for Ollama: its row is unverified, on 「This computer」 like Ollama's own.
    await trigger.click()
    await page.getByTestId('model-more').click()
    await page.getByTestId('model-type-ollama').click()
    await page.getByTestId('type-model-input').fill('my-local-model')
    await page.getByTestId('type-model-use').click()
    await expect(current).toHaveText('my-local-model')
    await trigger.click()
    await expect(page.getByTestId('model-row-ollama-my-local-model')).toContainText(
      'Unverified · text conversation only · This computer',
    )
    expect(ollama.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('a round held for a public host opens the menu on the same confirmation (间接切公网, §模型菜单与输入框)', async () => {
  ollama = await startFakeOpenAI({ chunks: ['local ', 'answer'], delayMs: 5 })
  const userData = makeUserDataDir('model-held')
  seedConfig(userData, {
    locale: 'en',
    provider: { id: 'ollama', modelId: 'qwen3:8b' },
    providerConfig: { ollama: { baseURL: ollama.baseURL } },
  })
  const { app, page } = await launchTenon({ userData, env: { ZHIPU_API_KEY: 'e2e-zhipu-key' } })
  try {
    await page.getByTestId('composer-input').fill('keep this local')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('assistant-text')).toHaveText('local answer')
    // The default moves to a public host in the settings card — not through this session's menu.
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    await page.getByTestId('provider-select').selectOption('zhipu')
    await page.getByTestId('model-select').selectOption('glm-5.3-flash')
    await page.getByTestId('provider-save').click()
    await expect(page.getByTestId('provider-settings')).toBeHidden()
    await expect(page.getByTestId('model-menu')).toHaveCount(0)

    // The next message would take this history there: the kernel holds the round, and the menu
    // opens by itself on the confirmation the menu's own switch shows.
    await page.getByTestId('composer-input').fill('and this?')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('model-confirm')).toContainText(
      'Earlier messages will be sent to open.bigmodel.cn',
    )
    await expect(page.getByTestId('queued-bubble')).toContainText('and this?')
    expect(ollama.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

/**
 * The session of the held-round tests below: a conversation on Ollama (this computer), then the
 * default moved to zhipu's public host in the settings card, then a message the kernel holds for it —
 * the menu open on its confirmation, closed again with Esc, the message queued and held.
 */
async function heldRound(page: Page, server: FakeOpenAI): Promise<void> {
  await page.getByTestId('composer-input').fill('keep this local')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('assistant-text')).toHaveText('local answer')
  await page.getByTestId('account-row').click()
  await page.getByTestId('account-providers').click()
  await page.getByTestId('provider-select').selectOption('zhipu')
  await page.getByTestId('model-select').selectOption('glm-5.3-flash')
  await page.getByTestId('provider-save').click()
  await expect(page.getByTestId('provider-settings')).toBeHidden()

  await page.getByTestId('composer-input').fill('and this?')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('model-confirm')).toContainText(HELD_FOR_ZHIPU)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('model-menu')).toBeHidden()
  await expect(page.getByTestId('queued-bubble')).toContainText('and this?')
  expect(server.requests).toHaveLength(1)
}

async function launchHeld(tag: string): Promise<LaunchedApp & { server: FakeOpenAI }> {
  ollama = await startFakeOpenAI({ chunks: ['local ', 'answer'], delayMs: 5 })
  const server = ollama
  const userData = makeUserDataDir(tag)
  seedConfig(userData, {
    locale: 'en',
    provider: { id: 'ollama', modelId: 'qwen3:8b' },
    providerConfig: { ollama: { baseURL: server.baseURL } },
  })
  const launched = await launchTenon({ userData, env: { ZHIPU_API_KEY: 'e2e-zhipu-key' } })
  return { ...launched, server }
}

// A queue push while the round is held carries `held` again; the confirmation the user closed stays
// closed (§模型菜单与输入框: it opens once per hold).
test('editing the held message leaves the closed confirmation closed (间接切公网, §模型菜单与输入框)', async () => {
  const { app, page, server } = await launchHeld('model-held-edit')
  try {
    await heldRound(page, server)
    await recordPushes(app)
    const bubble = page.getByTestId('queued-bubble')
    await bubble.getByTestId('queued-edit').click()
    await bubble.getByTestId('queued-edit-input').fill('and this, edited?')
    await bubble.getByTestId('queued-edit-save').click()
    await expect(bubble).toContainText('and this, edited?')
    // main pushed the edited queue, still held for the same host...
    await expect
      .poll(async () => (await pushesOf<QueuePush>(app, 'chat.queue')).at(-1))
      .toMatchObject({ items: [{ text: 'and this, edited?' }], held: { host: ZHIPU_HOST } })
    // ...which is no new hold: the menu stays closed.
    await page.waitForTimeout(500)
    await expect(page.getByTestId('model-menu')).toBeHidden()
    await expect(page.getByTestId('model-confirm')).toHaveCount(0)
    expect(server.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('「立即发送」 on the held message is held again for the same host, and the confirmation opens again (间接切公网, §模型菜单与输入框)', async () => {
  // Each needsConfirm is a new hold (§主进程与 kernel 的循环接口「间接切公网」): the queue push names
  // the same host, so it is the route's own answer that reopens the menu (step 20 round 4).
  const { app, page, server } = await launchHeld('model-held-send-now')
  try {
    await heldRound(page, server)
    const bubble = page.getByTestId('queued-bubble')
    await bubble.getByTestId('queued-send-now').click()
    await expect(page.getByTestId('model-confirm')).toContainText(HELD_FOR_ZHIPU)
    await expect(bubble).toContainText('and this?')
    expect(server.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('withdrawing the held message clears the hold, and the next message held anew opens the confirmation again (间接切公网, §模型菜单与输入框)', async () => {
  const { app, page, server } = await launchHeld('model-held-again')
  try {
    await heldRound(page, server)
    await recordPushes(app)
    const bubble = page.getByTestId('queued-bubble')
    await bubble.getByTestId('queued-withdraw').click()
    await expect(bubble).toHaveCount(0)
    // With nothing left to hold, main pushes the empty queue with no hold.
    await expect
      .poll(async () => (await pushesOf<QueuePush>(app, 'chat.queue')).at(-1))
      .toEqual({ sessionId: expect.any(String), items: [] })
    await page.waitForTimeout(300)
    await expect(page.getByTestId('model-menu')).toBeHidden()

    await page.getByTestId('composer-input').fill('one more?')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('model-confirm')).toContainText(HELD_FOR_ZHIPU)
    await expect(bubble).toContainText('one more?')
    expect(server.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

// Where no provider is ever reached: `.invalid` never resolves (RFC 6761), so a regression that sent
// the history anyway would fail on the name, not reach a vendor. The e2e keychain is in memory.
const UNREACHABLE_ZHIPU = 'https://zhipu.invalid/api/paas/v4/'
const UNREACHABLE_ANTHROPIC = 'https://anthropic.invalid/'

test('a round held for one public host, confirmed after the default moved to another, names the host 「切换」 sends to (s19-safety-3)', async () => {
  // Held for zhipu, closed with Esc; then the default moves again, to a second public host, while
  // the round stays held. Back in the session the confirmation opens again and must name where the
  // choice 「切换」 commits sends now, not the host the kernel held for.
  const { app, page, server } = await launchHeld('model-held-moved')
  try {
    await heldRound(page, server)
    const saved = await page.evaluate(async (baseURL) => {
      const configured = await window.tenon.invoke('provider.configure', {
        id: 'anthropic',
        values: { baseURL, apiKey: 'e2e-anthropic-key' },
      })
      const selected = await window.tenon.invoke('provider.select', {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-5',
      })
      return [configured, selected]
    }, UNREACHABLE_ANTHROPIC)
    expect(saved).toEqual([
      { ok: true, data: { ok: true } },
      { ok: true, data: { ok: true } },
    ])
    // Back to the session: the reloaded window restores it, main replays its held queue, and the
    // menu opens by itself (phase 2 has no session list to leave and come back through).
    await page.reload()
    const confirm = page.getByTestId('model-confirm')
    await expect(confirm).toContainText('Earlier messages will be sent to anthropic.invalid')
    await expect(confirm).not.toContainText(ZHIPU_HOST)
    await expect(page.getByTestId('queued-bubble')).toContainText('and this?')
    await page.getByTestId('model-confirm-switch').click()
    // The held message went out on what the page named: the Run's record says anthropic.invalid,
    // and zhipu got nothing.
    const lastHost = (): Promise<string | undefined> =>
      page.evaluate(async () => {
        const latest = (await window.tenon.invoke('session.latest', { limit: 1 })) as {
          data: { sessionId: string } | null
        }
        if (latest.data === null) return undefined
        const facts = (await window.tenon.invoke('session.facts', {
          sessionId: latest.data.sessionId,
        })) as { data: { lastEndpoint?: { host: string } } }
        return facts.data.lastEndpoint?.host
      })
    await expect.poll(lastHost).toBe('anthropic.invalid')
    await expect(page.getByTestId('queued-bubble')).toHaveCount(0)
    expect(server.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('a session on this computer whose default moved to a public host asks on any row or level of it (s19-spec-1, 验收 34)', async () => {
  // The session never chose: it runs on the profile's default, which the settings card then moves
  // to zhipu. The model in effect is public, the history is not — every choice in its menu, the
  // ticked default's own row and a thinking level included, asks first, and nothing is sent.
  ollama = await startFakeOpenAI({ chunks: ['local ', 'answer'], delayMs: 5 })
  const server = ollama
  const userData = makeUserDataDir('model-indirect')
  seedConfig(userData, {
    locale: 'en',
    provider: { id: 'ollama', modelId: 'qwen3:8b' },
    providerConfig: { ollama: { baseURL: server.baseURL } },
  })
  const { app, page } = await launchTenon({ userData, env: COUNT_ROUTES })
  try {
    await page.getByTestId('composer-input').fill('keep this local')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('assistant-text')).toHaveText('local answer')
    const saved = await page.evaluate(async (baseURL) => {
      const configured = await window.tenon.invoke('provider.configure', {
        id: 'zhipu',
        values: { baseURL, apiKey: 'e2e-zhipu-key' },
      })
      const selected = await window.tenon.invoke('provider.select', {
        providerId: 'zhipu',
        modelId: 'glm-5.3-flash',
      })
      return [configured, selected]
    }, UNREACHABLE_ZHIPU)
    expect(saved).toEqual([
      { ok: true, data: { ok: true } },
      { ok: true, data: { ok: true } },
    ])
    const trigger = page.getByTestId('model-menu-trigger')
    const confirm = page.getByTestId('model-confirm')
    const asked = 'Earlier messages will be sent to zhipu.invalid'

    // The default's own row, ticked as the model in effect (the menu reads it on opening).
    await trigger.click()
    await expect(page.getByTestId('model-menu-current')).toHaveText('glm-5.3-flash · Max')
    await page.getByTestId('model-row-zhipu-glm-5.3-flash').click()
    await expect(confirm).toContainText(asked)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('model-menu')).toBeHidden()
    // A level of it. Its highest level is also its default, and says both (s19-spec-5).
    await trigger.click()
    await page.getByTestId('model-effort').hover()
    await expect(page.getByTestId('model-effort-max')).toHaveText('Max (default) · uses the most')
    await page.getByTestId('model-effort-high').click()
    await expect(confirm).toContainText(asked)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('model-menu')).toBeHidden()
    // A model typed for it.
    await trigger.click()
    await page.getByTestId('model-more').click()
    await page.getByTestId('model-type-zhipu').click()
    await page.getByTestId('type-model-input').fill('glm-own')
    await page.getByTestId('type-model-use').click()
    await expect(confirm).toContainText(asked)
    await page.keyboard.press('Escape')

    // Nothing was chosen and nothing sent: the session is where it was.
    await expect(page.getByTestId('model-menu-current')).toHaveText('glm-5.3-flash · Max')
    expect(await routeCalls(app, 'session.selectModel')).toBe(0)
    expect(await routeCalls(app, 'chat.send')).toBe(1)
    expect(server.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('in a task, the text-only rows are greyed and say why: Ollama’s and a typed model’s (旧 40, 旧 108, 验收 35)', async () => {
  anthropic = await startFakeAnthropic({ chunks: ['ok'], delayMs: 5 })
  const userData = makeUserDataDir('model-task-rows')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ANTHROPIC_BASE_URL: anthropic.baseURL, ANTHROPIC_API_KEY: 'e2e-anthropic-key' },
  })
  try {
    const trigger = page.getByTestId('model-menu-trigger')
    const current = page.getByTestId('model-menu-current')
    const reason = 'A task needs a model that can use tools'
    // A chat lists them as any other row.
    await trigger.click()
    await expect(page.getByTestId('model-row-ollama-qwen3:8b')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await page.keyboard.press('Escape')

    await page.getByTestId('mode-cowork').click()
    await expect(page.getByTestId('mode-switch')).toHaveAttribute('data-profile', 'cowork')
    await trigger.click()
    const ollamaRow = page.getByTestId('model-row-ollama-qwen3:8b')
    await expect(ollamaRow).toHaveAttribute('aria-disabled', 'true')
    await expect(ollamaRow).toContainText(reason)
    // A verified row stays selectable.
    await expect(page.getByTestId('model-row-anthropic-claude-sonnet-5')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    // A greyed row does nothing.
    await ollamaRow.click({ force: true })
    await expect(current).toHaveText('claude-opus-5-5 · Medium')

    // A typed id holds text conversations only: its row, once it is the session's, is greyed too.
    await page.getByTestId('model-more').click()
    await page.getByTestId('model-type-anthropic').click()
    await page.getByTestId('type-model-input').fill('claude-own-model')
    await page.getByTestId('type-model-use').click()
    await expect(current).toHaveText('claude-own-model')
    await trigger.click()
    const typedRow = page.getByTestId('model-row-anthropic-claude-own-model')
    await expect(typedRow).toHaveAttribute('aria-disabled', 'true')
    await expect(typedRow).toContainText(reason)
  } finally {
    await app.close()
  }
})

test('while a reply streams, the thinking levels say a change starts with the next message and restarts the cache (旧 186)', async () => {
  const hold = deferred()
  anthropic = await startFakeAnthropic({
    replies: [
      {
        steps: [
          { type: 'text', text: 'Still ' },
          { type: 'wait', until: hold.promise },
          { type: 'text', text: 'going.' },
        ],
        delayMs: 5,
      },
    ],
  })
  const userData = makeUserDataDir('model-cache-note')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(anthropic.baseURL) })
  try {
    await send(page, 'a long answer')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Still')
    await page.getByTestId('model-menu-trigger').click()
    await page.getByTestId('model-effort').hover()
    await expect(page.getByTestId('model-next-message-cache')).toHaveText(
      'Takes effect from the next message · Changing it makes the cache start over',
    )
    hold.resolve()
  } finally {
    hold.resolve()
    await app.close()
  }
})

test('「用新模型开新会话」 during a Run asks to leave first: staying keeps the session, stopping opens the empty one (旧 185)', async () => {
  // One reply on Ollama, held open after its first chunk: a Run in progress, history on this computer.
  ollama = await startFakeOpenAI({ chunks: ['local ', 'answer'], delayMs: 5, holdAfter: 1 })
  const server = ollama
  const userData = makeUserDataDir('model-new-chat-leave')
  seedConfig(userData, {
    locale: 'en',
    provider: { id: 'ollama', modelId: 'qwen3:8b' },
    providerConfig: { ollama: { baseURL: server.baseURL } },
  })
  const { app, page } = await launchTenon({ userData, env: { ZHIPU_API_KEY: 'e2e-zhipu-key' } })
  try {
    await send(page, 'keep this local')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('local')
    const dialog = page.getByTestId('leave-run')
    const newChatWithZhipu = async (): Promise<void> => {
      await page.getByTestId('model-menu-trigger').click()
      await page.getByTestId('model-row-zhipu-glm-5.3-flash').click()
      await expect(page.getByTestId('model-confirm')).toContainText(HELD_FOR_ZHIPU)
      await page.getByTestId('model-confirm-new-chat').click()
      await expect(dialog).toBeVisible()
    }
    await newChatWithZhipu()
    await dialog.getByTestId('leave-stay').click()
    await expect(dialog).toBeHidden()
    // Nothing moved: the same session, its Run still going.
    await expect(page.getByTestId('user-text')).toHaveText('keep this local')
    await expect(page.getByTestId('composer-stop')).toBeVisible()

    await newChatWithZhipu()
    await dialog.getByTestId('leave-stop').click()
    // A new, empty chat on the new model, none of the old content.
    await expect(page.getByTestId('thread-empty')).toBeVisible()
    await expect(page.getByTestId('user-message')).toHaveCount(0)
    await expect(page.getByTestId('model-menu-current')).toHaveText('glm-5.3-flash · Max')
    expect(server.requests).toHaveLength(1)
  } finally {
    server.release()
    await app.close()
  }
})

test('writes the default model only when the card’s model field changed (旧 187)', async () => {
  const userData = makeUserDataDir('model-card')
  seedConfig(userData, { locale: 'en', provider: { id: 'anthropic', modelId: 'claude-opus-5-5' } })
  const { app, page } = await launchTenon({ userData })
  try {
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    await page.getByTestId('provider-select').selectOption('zhipu')
    await page.getByTestId('provider-config-apiKey').fill('e2e-zhipu-key')
    await page.getByTestId('provider-save').click()
    await expect(page.getByTestId('provider-settings')).toBeHidden()
    const untouched = (await page.evaluate(() => window.tenon.invoke('config.get', {}))) as {
      data: { provider: unknown; defaultModelByProfile: unknown }
    }
    expect(untouched.data.provider).toEqual({ id: 'anthropic', modelId: 'claude-opus-5-5' })
    expect(untouched.data.defaultModelByProfile).toEqual({})
    // Changing the field writes both profiles' defaults and `provider`.
    await page.getByTestId('account-row').click()
    await page.getByTestId('account-providers').click()
    await page.getByTestId('provider-select').selectOption('zhipu')
    await page.getByTestId('model-select').selectOption('glm-5.3-flash')
    await page.getByTestId('provider-save').click()
    await expect(page.getByTestId('provider-settings')).toBeHidden()
    const changed = (await page.evaluate(() => window.tenon.invoke('config.get', {}))) as {
      data: { provider: unknown; defaultModelByProfile: unknown }
    }
    const selection = { id: 'zhipu', modelId: 'glm-5.3-flash' }
    expect(changed.data.provider).toEqual(selection)
    expect(changed.data.defaultModelByProfile).toEqual({ chat: selection, cowork: selection })
  } finally {
    await app.close()
  }
})

test('keeps a default per profile: a new session in each starts on it (旧 37)', async () => {
  anthropic = await startFakeAnthropic({ chunks: ['ok'], delayMs: 5 })
  const userData = makeUserDataDir('model-profiles')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ANTHROPIC_BASE_URL: anthropic.baseURL, ANTHROPIC_API_KEY: 'e2e-anthropic-key' },
  })
  try {
    // The chat on screen chooses X in the menu.
    await page.getByTestId('model-menu-trigger').click()
    await page.getByTestId('model-row-anthropic-claude-opus-5-5').click()
    await expect(page.getByTestId('model-menu-current')).toHaveText('claude-opus-5-5 · Medium')
    // A task session (the mode switch arrives with step 20: chosen over IPC here) chooses Y.
    const choice = await page.evaluate(async () => {
      const task = crypto.randomUUID()
      const chat = crypto.randomUUID()
      await window.tenon.invoke('session.selectProfile', { sessionId: task, profile: 'cowork' })
      await window.tenon.invoke('session.selectModel', {
        sessionId: task,
        providerId: 'anthropic',
        modelId: 'claude-haiku-4-5-20251001',
        effort: null,
      })
      // New sessions of each profile start on that profile's default.
      const nextTask = crypto.randomUUID()
      await window.tenon.invoke('session.selectProfile', { sessionId: nextTask, profile: 'cowork' })
      return {
        task: await window.tenon.invoke('session.modelChoice', { sessionId: nextTask }),
        chat: await window.tenon.invoke('session.modelChoice', { sessionId: chat }),
      }
    })
    expect(choice.task).toMatchObject({ ok: true, data: { modelId: 'claude-haiku-4-5-20251001' } })
    expect(choice.chat).toMatchObject({ ok: true, data: { modelId: 'claude-opus-5-5' } })
  } finally {
    await app.close()
  }
})
