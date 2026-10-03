import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { deferred, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { completionRequests, startFakeOpenAI } from '../test/support/fake-openai.js'
import type { FakeOpenAI, OpenAIReply } from '../test/support/fake-openai.js'
import { createInstance, createInstanceInCard, saveInstanceKeyInCard } from './helpers/instances.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import type { SeededInstance } from './helpers/launch.js'
import { named, tapeFacts } from './helpers/tape.js'
import { expect, test } from './helpers/test.js'
import {
  ZHIPU_ORIGIN,
  makeFolderTree,
  originMap,
  providerEnv,
  send,
  startTask,
} from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/**
 * Custom vendor instances in the real shell (M6 plan step 10): the settings card's instance
 * section, the model menu's instance group and the failure card, against fake endpoints.
 *
 * A public instance lives at `https://vendor.e2e.test`, a public-shaped host: the origin map test
 * seam (M6 §点名「测试接缝」) sends its requests to a fake on this machine, while the app keeps
 * judging, binding the key to and showing the address it was given. Keys are made up and go into
 * `TENON_SECRETS=memory`; nothing here touches the OS keychain or sends anything off this machine.
 */
const VENDOR_ORIGIN = 'https://vendor.e2e.test'
const VENDOR_HOST = 'vendor.e2e.test'
const VENDOR_URL = `${VENDOR_ORIGIN}/v1`
const FIRST_KEY = 'e2e-vendor-key-1f04'
const SECOND_KEY = 'e2e-vendor-key-2b7c'

/** packages/kernel/src/provider/probe.ts PROBE_PROMPT's opening: the probe's fixed user message. */
const PROBE_PROMPT = 'This is a connection check.'
const PROBE_THINKING = 'The check asks for one Read.'

/** Probe ①: the one Read call the fixed prompt asks for, after a thinking field (M6 §两步). */
function probeCall(): OpenAIReply {
  return {
    steps: [
      { type: 'reasoning', text: PROBE_THINKING },
      {
        type: 'tool_call',
        id: 'call_probe',
        name: 'Read',
        input: { file_path: '/tenon-probe/ping.txt' },
      },
    ],
    delayMs: 5,
  }
}

/** A reply of text only (finish reason `stop`): probe ② or the end of a round. */
function textAnswer(...chunks: string[]): OpenAIReply {
  return { steps: [{ type: 'text', text: chunks }], delayMs: 5 }
}

/** The names of the tools a /chat/completions body offers. */
function toolNames(body: unknown): string[] {
  const tools = (body as { tools?: Array<{ function: { name: string } }> }).tools ?? []
  return tools.map((tool) => tool.function.name)
}

/** The messages of a /chat/completions body. */
function messagesOf(body: unknown): Array<Record<string, unknown>> {
  return (body as { messages: Array<Record<string, unknown>> }).messages
}

interface ListedInstance {
  readonly id: string
  readonly displayName: string
  readonly models: ReadonlyArray<{
    readonly id: string
    readonly contextLimit: number
    readonly probe?: Readonly<Record<string, unknown>>
  }>
}

/** `customVendor.list`'s instances, as main has them. */
async function instances(page: Page): Promise<ListedInstance[]> {
  const answer = (await page.evaluate(() => window.tenon.invoke('customVendor.list', {}))) as {
    ok: boolean
    data: { instances: ListedInstance[] }
  }
  return answer.data.instances
}

/** The settings card, opened from the account row. */
async function openCard(page: Page): Promise<void> {
  await page.getByTestId('account-row').click()
  await page.getByTestId('account-providers').click()
  await expect(page.getByTestId('provider-settings')).toBeVisible()
  await expect(page.getByTestId('custom-vendors')).toBeVisible()
}

/**
 * The settings card, opened from the model menu's 「管理模型」: closing it makes the menu read
 * `provider.list` again, so the trigger and the send block follow what the card changed.
 */
async function openCardFromMenu(page: Page): Promise<void> {
  await page.getByTestId('model-menu-trigger').click()
  await page.getByTestId('model-manage').click()
  await expect(page.getByTestId('provider-settings')).toBeVisible()
  await expect(page.getByTestId('custom-vendors')).toBeVisible()
}

async function closeCard(page: Page): Promise<void> {
  await page.getByTestId('provider-cancel').click()
  await expect(page.getByTestId('provider-settings')).toBeHidden()
}

/**
 * 「创建」 on the open card with an address §地址校验 refuses (M6 验收 4): the form stays open and says
 * why in the code's own words; then it is cancelled.
 */
async function refusedInCard(
  page: Page,
  baseURL: string,
  code: 'https-required' | 'subscription-endpoint',
  text: string,
): Promise<void> {
  const typed = { displayName: NAME, wire: 'openai-chat', baseURL, apiKey: FIRST_KEY } as const
  await expect(createInstanceInCard(page, typed)).rejects.toThrow(`customVendor.error.${code}`)
  await expect(page.getByTestId('custom-vendor-new-error')).toHaveText(text)
  await page.getByTestId('custom-vendor-new-cancel').click()
}

let vendor: FakeOpenAI | undefined
let local: FakeOpenAI | undefined
let anthropic: FakeAnthropic | undefined
let gateway: FakeAnthropic | undefined
let zhipu: FakeOpenAI | undefined
let tree: FolderTree | undefined

test.afterEach(async () => {
  await vendor?.close()
  await local?.close()
  await anthropic?.close()
  await gateway?.close()
  await zhipu?.close()
  tree?.dispose()
  vendor = undefined
  local = undefined
  anthropic = undefined
  gateway = undefined
  zhipu = undefined
  tree = undefined
})

const NAME = 'E2E 中转'
const RENAMED = 'E2E 中转（改名后）'
const MODEL_A = 'vendor-model-a'
const MODEL_B = 'vendor-model-b'
const NOTE = 'VENDOR-NOTE-5521'
const TASK_DONE = 'vendor-read-7f3a'

test('建实例 → 获取列表 → 探测通过 → 任务一次工具往返 → 保存 key 变回仅文字 → 改名、改模型 → 删行、删实例 → 失败卡说已删除（M6 验收 3、4、9、12、14、19、21、25）', async () => {
  test.setTimeout(120_000)
  const folders = makeFolderTree('vendor-task', { 'ws/notes.txt': `${NOTE}\n` })
  tree = folders
  const workspace = join(folders.real, 'ws')
  const notes = join(workspace, 'notes.txt')
  // anthropic has a key, so the menu has a builtin to type a model for; nothing goes to it.
  anthropic = await startFakeAnthropic({ chunks: ['unused'] })
  vendor = await startFakeOpenAI({
    models: [
      { id: MODEL_A, object: 'model', context_length: 131_072, max_output_tokens: 8_192 },
      { id: 'vendor-model-z', object: 'model' },
    ],
    replies: [
      // The probe of MODEL_A: ① the Read call, ② the answer.
      probeCall(),
      textAnswer('It said ok.'),
      // The task's round: a Read of a file in its workspace, then the answer.
      {
        steps: [{ type: 'tool_call', id: 'call_notes', name: 'Read', input: { file_path: notes } }],
        delayMs: 5,
      },
      textAnswer('vendor-read-', '7f3a'),
    ],
  })
  const server = vendor
  const userData = makeUserDataDir('vendor-flow')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({
    userData,
    env: providerEnv(anthropic.baseURL, { [VENDOR_ORIGIN]: server.baseURL }),
  })
  try {
    // 建实例: 「其他兼容端点」, typed on the card. Creating it sends nothing anywhere (T7).
    await openCard(page)
    await expect(page.getByTestId('custom-vendors-no-search')).toHaveText(
      '自定义厂商不提供网络搜索；网页抓取照常。',
    )
    // Addresses §地址校验 refuses: nothing stored, nothing sent (验收 4). The second is the fake's
    // own origin, so a request let through would show up on it.
    await refusedInCard(
      page,
      `http://${VENDOR_HOST}/v1`,
      'https-required',
      '公网地址必须用 https；http 只给本机或局域网。',
    )
    await refusedInCard(
      page,
      `${VENDOR_ORIGIN}/api/coding/paas/v4`,
      'subscription-endpoint',
      '这是 GLM Coding Plan 的订阅地址，不能用于 Tenon。请改用按量付费的地址。',
    )
    expect(await instances(page)).toEqual([])
    expect(server.requests).toHaveLength(0)
    const id = await createInstanceInCard(page, {
      displayName: NAME,
      wire: 'openai-chat',
      baseURL: VENDOR_URL,
      apiKey: FIRST_KEY,
    })
    await expect(page.getByTestId(`custom-vendor-address-${id}`)).toHaveText(VENDOR_URL)
    await expect(page.getByTestId(`custom-vendor-key-status-${id}`)).toHaveText(
      '已存有密钥。要更换请直接填入新的。',
    )
    expect(server.requests).toHaveLength(0)
    // 获取列表: one GET, with the instance's key, only now (验收 12); picking prefills the limits.
    await page.getByTestId(`custom-vendor-fetch-${id}`).click()
    const fetched = page.getByTestId(`custom-vendor-fetched-${id}`)
    await expect(fetched).toBeVisible()
    expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /v1/models',
    ])
    expect(server.requests[0]?.headers['authorization']).toBe(`Bearer ${FIRST_KEY}`)
    await fetched.selectOption(MODEL_A)
    await expect(page.getByTestId(`custom-vendor-row-id-${id}`)).toHaveValue(MODEL_A)
    await expect(page.getByTestId(`custom-vendor-row-context-${id}`)).toHaveValue('131072')
    await expect(page.getByTestId(`custom-vendor-row-output-${id}`)).toHaveValue('8192')
    await page.getByTestId(`custom-vendor-row-save-${id}`).click()
    const statusA = page.getByTestId(`custom-vendor-probe-status-${id}-${MODEL_A}`)
    await expect(statusA).toHaveAttribute('data-outcome', 'none')
    await expect(statusA).toHaveText('尚未探测 · 仅文字对话')

    // A typed id with spaces around it is stored without them (§列表与上限; 第 9 步 S9-5).
    await page.getByTestId(`custom-vendor-row-id-${id}`).fill(`  ${MODEL_B}  `)
    await page.getByTestId(`custom-vendor-row-context-${id}`).fill('32000')
    await page.getByTestId(`custom-vendor-row-output-${id}`).fill('4096')
    await page.getByTestId(`custom-vendor-row-save-${id}`).click()
    await expect(page.getByTestId(`custom-vendor-row-${id}-${MODEL_B}`)).toBeVisible()
    await expect(page.getByTestId(`custom-vendor-row-id-${id}`)).toHaveValue('')
    expect((await instances(page))[0]?.models.map((row) => row.id)).toEqual([MODEL_A, MODEL_B])

    // 探测通过: the button says what it costs (T4); two requests, the fixed prompt and nothing else.
    const probeA = page.getByTestId(`custom-vendor-probe-${id}-${MODEL_A}`)
    const cost = page.getByTestId(`custom-vendor-probe-note-${id}`)
    await expect(cost).toHaveText('会用你的 key 发 2–3 次请求，思考模型每次可能较长')
    await expect(probeA).toHaveAttribute('aria-describedby', (await cost.getAttribute('id')) ?? '')
    await probeA.click()
    await expect(statusA).toHaveAttribute('data-outcome', 'passed')
    await expect(statusA).toHaveText('本机探测通过 · 不保证')
    const probes = completionRequests(server)
    expect(probes).toHaveLength(2)
    for (const request of probes) {
      expect(request.path).toBe('/v1/chat/completions')
      expect(request.headers['authorization']).toBe(`Bearer ${FIRST_KEY}`)
      expect(request.body).toMatchObject({
        model: MODEL_A,
        stream_options: { include_usage: true },
      })
      expect(toolNames(request.body)).toContain('Read')
    }
    const [one, two] = probes.map((request) => messagesOf(request.body))
    expect(one?.map((message) => message.role)).toEqual(['user'])
    expect(JSON.stringify(one)).toContain(PROBE_PROMPT)
    // ② carries ①'s turn back, its thinking under the field ① used (验收 28's shape).
    expect(two?.map((message) => message.role)).toEqual(['user', 'assistant', 'tool'])
    expect(two?.[1]?.['reasoning_content']).toBe(PROBE_THINKING)
    expect((await instances(page))[0]?.models[0]?.probe).toMatchObject({
      outcome: 'passed',
      reasoningField: 'reasoning_content',
      usageSeen: true,
      responseModelId: 'fake-model',
    })
    await closeCard(page)

    // The menu: one group named as the user named it, after the builtins; no hand-typed id for it.
    const trigger = page.getByTestId('model-menu-trigger')
    await trigger.click()
    const group = page.getByTestId(`model-group-${id}`)
    await expect(group.locator('[data-slot="dropdown-menu-label"]')).toHaveText(NAME)
    const rowA = page.getByTestId(`model-row-${id}-${MODEL_A}`)
    const rowB = page.getByTestId(`model-row-${id}-${MODEL_B}`)
    await expect(rowA).toContainText(`本机探测 · 不保证 · ${VENDOR_HOST}`)
    await expect(rowB).toContainText(`尚未通过探测 · 仅文字对话 · ${VENDOR_HOST}`)
    await page.getByTestId('model-more').click()
    await expect(page.getByTestId('model-type-anthropic')).toBeVisible()
    await expect(page.getByTestId(`model-type-${id}`)).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    const menu = page.getByTestId('model-menu')
    await expect(menu).toBeHidden()

    // A task: the probed row can be chosen, the unprobed one is greyed and says why (Q6, 验收 19).
    await startTask(app, page, workspace)
    await trigger.click()
    await expect(rowA).not.toHaveAttribute('aria-disabled', 'true')
    await expect(rowB).toHaveAttribute('aria-disabled', 'true')
    await expect(rowB).toContainText('任务需要能用工具的模型')
    await rowA.click()
    await expect(menu).toBeHidden()
    await expect(page.getByTestId('model-menu-current')).toHaveText(MODEL_A)
    await expect(page.getByTestId('composer-send-block')).toHaveCount(0)
    // An instance row has no thinking levels to pick (验收 19, T5).
    await trigger.click()
    await expect(menu).toBeVisible()
    await expect(rowA).toBeVisible()
    await expect(page.getByTestId('model-effort')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()

    // 任务一次往返: the round offers the tools, the Read runs in the workspace, the answer follows.
    await send(page, '读一下 notes.txt')
    await expect(page.getByTestId('assistant-text').last()).toHaveText(TASK_DONE)
    await expect(page.getByTestId('tool-row')).toHaveCount(1)
    const rounds = completionRequests(server).slice(2)
    expect(rounds).toHaveLength(2)
    for (const request of rounds) {
      const offered = toolNames(request.body)
      expect(offered).toEqual(expect.arrayContaining(['Read', 'Write', 'WebFetch']))
      // No search backend on an instance (Q10, M6 不变量 15); no thinking parameters (M6 不变量 11).
      expect(offered).not.toContain('WebSearch')
      expect(request.body).not.toHaveProperty('reasoning_effort')
      expect(request.body).not.toHaveProperty('thinking')
      expect(request.headers['authorization']).toBe(`Bearer ${FIRST_KEY}`)
    }
    expect(JSON.stringify(rounds[1]?.body)).toContain(NOTE)
    const facts = tapeFacts(userData)
    // Judged by the address the app was given, not where the seam sent it (M6 不变量 19).
    expect(named(facts, 'session/model_selected').map((fact) => fact.payload)).toEqual([
      {
        providerId: id,
        modelId: MODEL_A,
        capabilitySource: 'probed',
        endpointOrigin: VENDOR_ORIGIN,
      },
    ])
    expect(named(facts, 'view/tools_withheld')).toHaveLength(0)

    // 保存 key 变回仅文字: the new key clears every probe of the instance (T3, 验收 10).
    await openCardFromMenu(page)
    // The builtin form above the instances lists the builtins only, read as the card opens: an
    // instance is no provider to choose there (§IPC; 第 9 步读法 (1)).
    const providers = page.getByTestId('provider-select').locator('option')
    await expect(providers).not.toHaveCount(0)
    await expect(
      page.getByTestId('provider-select').locator('option[value^="custom-"]'),
    ).toHaveCount(0)
    await saveInstanceKeyInCard(page, id, SECOND_KEY)
    await expect(statusA).toHaveAttribute('data-outcome', 'none')
    await expect(page.getByTestId(`custom-vendor-probe-status-${id}-${MODEL_B}`)).toHaveAttribute(
      'data-outcome',
      'none',
    )
    expect((await instances(page))[0]?.models.map((row) => row.probe)).toEqual([
      undefined,
      undefined,
    ])
    await closeCard(page)
    await expect(page.getByTestId('composer-send-block')).toHaveAttribute(
      'data-reason',
      'textOnlyTask',
    )
    await trigger.click()
    await expect(rowA).toHaveAttribute('aria-disabled', 'true')
    await expect(rowA).toContainText('任务需要能用工具的模型')
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()

    // 改名: written at once; the listing and the menu's group read the new name (验收 3).
    await openCardFromMenu(page)
    await page.getByTestId(`custom-vendor-name-${id}`).fill(RENAMED)
    await page.getByTestId(`custom-vendor-rename-${id}`).click()
    await expect(page.getByTestId(`custom-vendor-rename-${id}`)).toHaveCount(0)
    await expect(page.getByTestId(`custom-vendor-toggle-${id}`)).toContainText(RENAMED)
    expect((await instances(page))[0]?.displayName).toBe(RENAMED)
    // 改模型: a row's limits edited in the row form, the row kept in its place.
    await page.getByTestId(`custom-vendor-row-edit-${id}-${MODEL_B}`).click()
    await expect(page.getByTestId(`custom-vendor-row-id-${id}`)).toHaveValue(MODEL_B)
    await page.getByTestId(`custom-vendor-row-context-${id}`).fill('48000')
    await page.getByTestId(`custom-vendor-row-save-${id}`).click()
    await expect(page.getByTestId(`custom-vendor-row-id-${id}`)).toHaveValue('')
    expect(
      (await instances(page))[0]?.models.map((row) => `${row.id} ${row.contextLimit}`),
    ).toEqual([`${MODEL_A} 131072`, `${MODEL_B} 48000`])
    await closeCard(page)
    await trigger.click()
    await expect(group.locator('[data-slot="dropdown-menu-label"]')).toHaveText(RENAMED)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()

    // 删行: the session's row taken off the list; the trigger names it removed (§实例被删或改坏),
    // and the send is not held as text-only.
    await openCardFromMenu(page)
    await page.getByTestId(`custom-vendor-row-remove-${id}-${MODEL_A}`).click()
    await expect(page.getByTestId(`custom-vendor-row-${id}-${MODEL_A}`)).toHaveCount(0)
    expect((await instances(page))[0]?.models.map((row) => row.id)).toEqual([MODEL_B])
    await closeCard(page)
    const current = page.getByTestId('model-menu-current')
    await expect(current).toHaveText(`${MODEL_A}（已删除）`)
    await expect(page.getByTestId('composer-send-block')).toHaveCount(0)

    // 会话失败卡: refused as a missing key, nothing sent; the card says what was removed (验收 25).
    const cards = page.getByTestId('failure-card')
    const gone = '这个会话用的自定义厂商或模型已删除。在模型菜单里换一个模型再发送。'
    await send(page, '还在吗？')
    await expect(cards).toHaveCount(1)
    await expect(cards.last()).toHaveAttribute('data-code', 'provider-error')
    await expect(cards.last().getByTestId('failure-what')).toHaveAttribute(
      'data-custom-vendor-gone',
      'true',
    )
    await expect(cards.last().getByTestId('failure-what')).toHaveText(gone)
    expect(completionRequests(server)).toHaveLength(4)

    // 删实例: two steps on the card; the instance and its rows are gone at once (验收 3), the
    // builtins stay (验收 9).
    await openCardFromMenu(page)
    await page.getByTestId(`custom-vendor-delete-${id}`).click()
    await page.getByTestId(`custom-vendor-delete-confirm-${id}`).click()
    await expect(page.getByTestId(`custom-vendor-${id}`)).toHaveCount(0)
    expect(await instances(page)).toEqual([])
    await closeCard(page)
    await expect(current).toHaveText(`${MODEL_A}（已删除）`)
    await expect(page.getByTestId('composer-send-block')).toHaveCount(0)
    await trigger.click()
    await expect(group).toHaveCount(0)
    await expect(page.getByTestId('model-group-anthropic')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()

    await send(page, '还在吗？')
    await expect(cards).toHaveCount(2)
    await expect(cards.last()).toHaveAttribute('data-code', 'provider-error')
    await expect(cards.last().getByTestId('failure-what')).toHaveAttribute(
      'data-custom-vendor-gone',
      'true',
    )
    await expect(cards.last().getByTestId('failure-what')).toHaveText(gone)
    expect(completionRequests(server)).toHaveLength(4)
    expect(server.unscripted).toBe(0)
    expect(anthropic.requests).toHaveLength(0)
  } finally {
    await app.close()
  }
})

test('a probe that fails says why on its row: the tool result refused with a 400, then fields Tenon cannot send back (M6 验收 15, 17)', async () => {
  vendor = await startFakeOpenAI({
    replies: [
      // MODEL_A: ① calls Read, ② is refused.
      probeCall(),
      {
        failWith: {
          status: 400,
          type: 'invalid_request_error',
          code: 'invalid_request_error',
          message: 'messages with role "tool" are not supported',
        },
      },
      // MODEL_B: ① carries a field the decoder would drop (Q14).
      {
        steps: [
          { type: 'delta', delta: { encrypted_content: 'opaque-blob-91c2' } },
          {
            type: 'tool_call',
            id: 'call_probe',
            name: 'Read',
            input: { file_path: '/tenon-probe/ping.txt' },
          },
        ],
        delayMs: 5,
      },
    ],
  })
  const server = vendor
  const userData = makeUserDataDir('vendor-probe-fail')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: originMap({ [VENDOR_ORIGIN]: server.baseURL }),
  })
  try {
    const id = await createInstance(page, {
      displayName: 'Relay',
      wire: 'openai-chat',
      baseURL: VENDOR_URL,
      apiKey: FIRST_KEY,
    })
    const models = [MODEL_A, MODEL_B].map((model) => ({
      id: model,
      contextLimit: 64_000,
      maxOutputTokens: 4_096,
    }))
    const updated = await page.evaluate(
      (request) => window.tenon.invoke('customVendor.update', request),
      { id, models },
    )
    expect(updated).toEqual({ ok: true, data: { ok: true } })
    await openCard(page)

    await page.getByTestId(`custom-vendor-probe-${id}-${MODEL_A}`).click()
    const statusA = page.getByTestId(`custom-vendor-probe-status-${id}-${MODEL_A}`)
    await expect(statusA).toHaveAttribute('data-outcome', 'failed')
    await expect(statusA).toHaveText('The endpoint refused the tool result or the thinking echo')
    expect(completionRequests(server)).toHaveLength(2)

    // A failed ① sends no ② (验收 14), and the line names the field, never its value.
    await page.getByTestId(`custom-vendor-probe-${id}-${MODEL_B}`).click()
    const statusB = page.getByTestId(`custom-vendor-probe-status-${id}-${MODEL_B}`)
    await expect(statusB).toHaveAttribute('data-outcome', 'failed')
    await expect(statusB).toHaveText('It returns fields Tenon cannot send back: encrypted_content')
    expect(completionRequests(server)).toHaveLength(3)
    expect((await instances(page))[0]?.models.map((row) => row.probe?.['reason'])).toEqual([
      'echo-rejected',
      'opaque-fields',
    ])
    expect(JSON.stringify(await instances(page))).not.toContain('opaque-blob-91c2')

    // Neither row holds tools: both read 「尚未通过探测」 in the menu.
    await closeCard(page)
    await page.getByTestId('model-menu-trigger').click()
    const unprobed = `No passing probe · text conversation only · ${VENDOR_HOST}`
    await expect(page.getByTestId(`model-row-${id}-${MODEL_A}`)).toContainText(unprobed)
    await expect(page.getByTestId(`model-row-${id}-${MODEL_B}`)).toContainText(unprobed)
  } finally {
    await app.close()
  }
})

test('「取消」 stops a running probe; a probe left running by a closed card is found again as busy and cancelled from there (M6 验收 14; 第 9 步 S9-2)', async () => {
  const held = deferred()
  vendor = await startFakeOpenAI({
    replies: [{ hold: held.promise }, { hold: held.promise }, probeCall(), textAnswer('ok')],
  })
  const server = vendor
  const userData = makeUserDataDir('vendor-cancel')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: originMap({ [VENDOR_ORIGIN]: server.baseURL }),
  })
  try {
    const id = await createInstance(page, {
      displayName: 'Slow relay',
      wire: 'openai-chat',
      baseURL: VENDOR_URL,
      apiKey: FIRST_KEY,
    })
    const updated = await page.evaluate(
      (request) => window.tenon.invoke('customVendor.update', request),
      { id, models: [{ id: MODEL_A, contextLimit: 64_000, maxOutputTokens: 4_096 }] },
    )
    expect(updated).toEqual({ ok: true, data: { ok: true } })
    const probe = page.getByTestId(`custom-vendor-probe-${id}-${MODEL_A}`)
    const cancel = page.getByTestId(`custom-vendor-cancel-${id}-${MODEL_A}`)
    const status = page.getByTestId(`custom-vendor-probe-status-${id}-${MODEL_A}`)
    const answer = page.getByTestId(`custom-vendor-probe-answer-${id}-${MODEL_A}`)
    const stopped = 'Probe stopped; nothing was saved.'

    // The card's own probe: 「取消」 beside 「探测中…」; the probe answers `aborted` and keeps nothing.
    await openCard(page)
    await probe.click()
    await expect(page.getByTestId(`custom-vendor-probing-${id}-${MODEL_A}`)).toHaveText('Probing…')
    await expect.poll(() => completionRequests(server).length).toBe(1)
    await cancel.click()
    await expect(answer).toHaveAttribute('data-message', 'customVendor.probe.refused.aborted')
    await expect(answer).toHaveText(stopped)
    await expect(status).toHaveAttribute('data-outcome', 'none')
    await expect(cancel).toHaveCount(0)
    await expect.poll(() => server.aborts).toBe(1)

    // A probe that outlives its card: closing does not wait for it, and reopening forgets it.
    await probe.click()
    await expect.poll(() => completionRequests(server).length).toBe(2)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('provider-settings')).toBeHidden()
    await openCard(page)
    await expect(cancel).toHaveCount(0)
    // 「探测」 finds it running (`busy`, nothing sent), and 「取消」 shows on the row that asked.
    await probe.click()
    await expect(answer).toHaveAttribute('data-message', 'customVendor.probe.refused.busy')
    await expect(answer).toHaveText(
      'A probe of this provider is already running. Cancel it, or try again when it is done.',
    )
    await expect(cancel).toBeVisible()
    expect(completionRequests(server)).toHaveLength(2)
    await cancel.click()
    await expect(answer).toHaveText(stopped)
    await expect(cancel).toHaveCount(0)
    await expect(status).toHaveAttribute('data-outcome', 'none')
    await expect.poll(() => server.aborts).toBe(2)
    expect((await instances(page))[0]?.models[0]?.probe).toBeUndefined()

    // The instance is free again: the next probe runs and passes.
    await probe.click()
    await expect(status).toHaveAttribute('data-outcome', 'passed')
    expect(completionRequests(server)).toHaveLength(4)
  } finally {
    held.resolve()
    await app.close()
  }
})

const LOCAL_ID = 'custom-0b7e3c1a-5d2f-4e8b-9a61-3f0c2d4e5a6b'
const LOCAL_MODEL = 'qwen-local'
/** On a local network (Q7): never reached here — nothing is sent to it. */
const PRIVATE_ID = 'custom-1c8f4d2e-6a3b-4f7c-8d9e-0a1b2c3d4e5f'
const PRIVATE_HOST = '192.168.77.10'
const PRIVATE_MODEL = 'qwen-lan'

test('an instance on this computer or a local network has no 「探测」, holds text conversations only, and sends no tools (M6 验收 18, Q7)', async () => {
  local = await startFakeOpenAI({ chunks: ['local ', 'reply'], delayMs: 5 })
  const server = local
  const userData = makeUserDataDir('vendor-local')
  seedConfig(userData, {
    locale: 'en',
    customVendors: [
      {
        id: LOCAL_ID,
        displayName: 'Box under the desk',
        wire: 'openai-chat',
        baseURL: server.baseURL,
        models: [{ id: LOCAL_MODEL, contextLimit: 32_000, maxOutputTokens: 4_096 }],
      },
      {
        id: PRIVATE_ID,
        displayName: 'Box down the hall',
        wire: 'openai-chat',
        baseURL: `http://${PRIVATE_HOST}:8000/v1`,
        models: [{ id: PRIVATE_MODEL, contextLimit: 32_000, maxOutputTokens: 4_096 }],
      },
    ],
  })
  const { app, page } = await launchTenon({ userData })
  try {
    await openCard(page)
    // Two instances start folded.
    for (const [id, model] of [
      [LOCAL_ID, LOCAL_MODEL],
      [PRIVATE_ID, PRIVATE_MODEL],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one card at a time
      await page.getByTestId(`custom-vendor-toggle-${id}`).click()
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(page.getByTestId(`custom-vendor-row-${id}-${model}`)).toBeVisible()
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(page.getByTestId(`custom-vendor-probe-note-${id}`)).toHaveText(
        'An endpoint on this computer or a local network holds text conversations only and is not probed.',
      )
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(page.getByTestId(`custom-vendor-probe-${id}-${model}`)).toHaveCount(0)
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(page.getByTestId(`custom-vendor-probe-status-${id}-${model}`)).toHaveCount(0)
    }
    await closeCard(page)
    // Main refuses one asked for anyway, before anything is sent.
    for (const [id, model] of [
      [LOCAL_ID, LOCAL_MODEL],
      [PRIVATE_ID, PRIVATE_MODEL],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one probe at a time
      const refused = await page.evaluate(
        (request) => window.tenon.invoke('customVendor.probe', request),
        { id, modelId: model },
      )
      expect(refused).toMatchObject({
        ok: true,
        data: { status: 'refused', code: 'local-endpoint' },
      })
    }
    expect(server.requests).toHaveLength(0)

    // No key and still configured: a chat can pick it; a task greys it.
    const trigger = page.getByTestId('model-menu-trigger')
    const row = page.getByTestId(`model-row-${LOCAL_ID}-${LOCAL_MODEL}`)
    const lan = page.getByTestId(`model-row-${PRIVATE_ID}-${PRIVATE_MODEL}`)
    await page.getByTestId('mode-cowork').click()
    await trigger.click()
    for (const each of [row, lan]) {
      // oxlint-disable-next-line no-await-in-loop -- one row at a time
      await expect(each).toHaveAttribute('aria-disabled', 'true')
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(each).toContainText('A task needs a model that can use tools')
    }
    await page.keyboard.press('Escape')
    await page.getByTestId('mode-chat').click()
    await expect(page.getByTestId('mode-switch')).toHaveAttribute('data-profile', 'chat')
    await trigger.click()
    await expect(lan).not.toHaveAttribute('aria-disabled', 'true')
    await expect(lan).toContainText(`${PRIVATE_HOST} · text conversation only`)
    await expect(row).not.toHaveAttribute('aria-disabled', 'true')
    await expect(row).toContainText('This computer · text conversation only')
    await row.click()
    await expect(page.getByTestId('model-menu-current')).toHaveText(LOCAL_MODEL)

    await send(page, 'hello')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('local reply')
    expect(completionRequests(server)).toHaveLength(1)
    expect(completionRequests(server)[0]?.body).not.toHaveProperty('tools')
  } finally {
    await app.close()
  }
})

const ZHIPU_INSTANCE = 'custom-2d9a5e3f-7b4c-4a8d-9e0f-1b2c3d4e5f60'
const MINIMAX_INSTANCE = 'custom-3e0b6f4a-8c5d-4b9e-8f1a-2c3d4e5f6a71'
const PLAIN_INSTANCE = 'custom-4f1c7a5b-9d6e-4c0f-9a2b-3d4e5f6a7b82'
/** §地址校验's two sentences, zh-CN. */
const ZHIPU_REMINDER =
  '只能填按量付费的 key；GLM Coding Plan 的 key 不得用于 Tenon（订阅协议第六条第 2 款）'
const MINIMAX_REMINDER = '填『接口密钥』页的按量 key，不要填 Token Plan / M Plan 的订阅 key'

test('the pay-as-you-go reminder shows under the key field of an instance on a Zhipu or MiniMax host and of the new form on those addresses, and nowhere else (M6 验收 7, Q13)', async () => {
  const userData = makeUserDataDir('vendor-reminder')
  // No key stored and no row: nothing here is ever sent anywhere.
  seedConfig(userData, {
    locale: 'zh-CN',
    customVendors: [
      {
        id: ZHIPU_INSTANCE,
        displayName: 'GLM 按量',
        wire: 'anthropic-messages',
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
        models: [],
      },
      {
        id: MINIMAX_INSTANCE,
        displayName: 'MiniMax 按量',
        wire: 'anthropic-messages',
        baseURL: 'https://api.minimaxi.com/anthropic',
        models: [],
      },
      {
        id: PLAIN_INSTANCE,
        displayName: NAME,
        wire: 'openai-chat',
        baseURL: VENDOR_URL,
        models: [],
      },
    ],
  })
  const { app, page } = await launchTenon({ userData })
  try {
    await openCard(page)
    for (const [id, text] of [
      [ZHIPU_INSTANCE, ZHIPU_REMINDER],
      [MINIMAX_INSTANCE, MINIMAX_REMINDER],
      [PLAIN_INSTANCE, null],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one card at a time
      await page.getByTestId(`custom-vendor-toggle-${id}`).click()
      const card = page.getByTestId(`custom-vendor-${id}`)
      const key = card.getByTestId(`custom-vendor-key-${id}`)
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(key).toBeVisible()
      const reminder = card.getByTestId(`custom-vendor-reminder-${id}`)
      if (text === null) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        await expect(reminder).toHaveCount(0)
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(reminder).toHaveText(text)
      // oxlint-disable-next-line no-await-in-loop -- as above
      const [field, line] = await Promise.all([key.boundingBox(), reminder.boundingBox()])
      expect(line?.y).toBeGreaterThan(field?.y ?? Number.POSITIVE_INFINITY)
    }

    // The new form: the reminder follows the address the form would store.
    await page.getByTestId('custom-vendor-new').click()
    const source = page.getByTestId('custom-vendor-new-source')
    const region = page.getByTestId('custom-vendor-new-region')
    const wire = page.getByTestId('custom-vendor-new-wire')
    const shown = page.getByTestId('custom-vendor-new-address')
    const reminder = page.getByTestId('custom-vendor-new-reminder')
    await source.selectOption('zai')
    await expect(shown).toHaveText('https://api.z.ai/api/paas/v4')
    await expect(reminder).toHaveText(ZHIPU_REMINDER)
    await source.selectOption('minimax')
    for (const [where, address] of [
      ['cn', 'https://api.minimax.cn/anthropic'],
      ['global', 'https://api.minimax.io/anthropic'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one region at a time
      await region.selectOption(where)
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(shown).toHaveText(address)
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(reminder).toHaveText(MINIMAX_REMINDER)
    }
    await source.selectOption('deepseek')
    await expect(shown).toHaveText('https://api.deepseek.com')
    await expect(reminder).toHaveCount(0)
    // 「其他兼容端点」: the typed address decides.
    await source.selectOption('')
    await wire.selectOption('openai-chat')
    const typed = page.getByTestId('custom-vendor-new-baseurl')
    await typed.fill('https://open.bigmodel.cn/api/paas/v4')
    await expect(reminder).toHaveText(ZHIPU_REMINDER)
    await typed.fill(VENDOR_URL)
    await expect(reminder).toHaveCount(0)
    await page.getByTestId('custom-vendor-new-cancel').click()
    expect(await instances(page)).toHaveLength(3)
  } finally {
    await app.close()
  }
})

const GATEWAY_ORIGIN = 'https://gateway.e2e.test'

test('a builtin whose saved address is off its official one reads as not configured and offers 「新建自定义厂商」; a subscription path does not (M6 验收 26, §点名 (b))', async () => {
  gateway = await startFakeAnthropic({ chunks: ['should not'] })
  zhipu = await startFakeOpenAI({ chunks: ['should not'] })
  const userData = makeUserDataDir('vendor-builtin-refused')
  seedConfig(userData, {
    locale: 'en',
    providerConfig: {
      anthropic: { baseURL: GATEWAY_ORIGIN },
      zhipu: { baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' },
    },
  })
  // Keys for both, and both addresses mapped to fakes: a refusal that let a request through would
  // show up on a fake, not on the network.
  const { app, page } = await launchTenon({
    userData,
    env: {
      ANTHROPIC_API_KEY: 'e2e-test-key',
      ZHIPU_API_KEY: 'e2e-zhipu-key',
      ...originMap({ [GATEWAY_ORIGIN]: gateway.baseURL, [ZHIPU_ORIGIN]: zhipu.baseURL }),
    },
  })
  try {
    await openCard(page)
    const refused = page.getByTestId('provider-refused')
    await expect(page.getByTestId('provider-select')).toHaveValue('anthropic')
    await expect(refused).toHaveAttribute('data-refusal-code', 'official-host-only')
    await expect(refused).toContainText(
      "The saved address is not this provider's official one, so the provider reads as not configured. That address can only be added as a custom provider.",
    )
    await page.getByTestId('provider-select').selectOption('zhipu')
    await expect(refused).toHaveAttribute('data-refusal-code', 'subscription-endpoint')
    await expect(refused).toContainText(
      'The saved address is the GLM Coding Plan subscription address, which Tenon cannot use',
    )
    await expect(page.getByTestId('provider-refused-new-custom')).toHaveCount(0)
    await page.getByTestId('provider-select').selectOption('anthropic')
    await page.getByTestId('provider-refused-new-custom').click()
    await expect(page.getByTestId('custom-vendor-create')).toBeVisible()
    await expect(page.getByTestId('custom-vendor-new-source')).toBeFocused()
    await page.getByTestId('custom-vendor-new-cancel').click()
    await closeCard(page)

    await page.getByTestId('model-menu-trigger').click()
    await expect(page.getByTestId('model-unconfigured-anthropic')).toBeVisible()
    await expect(page.getByTestId('model-unconfigured-zhipu')).toBeVisible()
    await page.keyboard.press('Escape')
    await send(page, 'hello')
    await expect(page.getByTestId('failure-card')).toHaveAttribute('data-code', 'provider-error')
    expect(gateway.requests).toHaveLength(0)
    expect(zhipu.requests).toHaveLength(0)
  } finally {
    await app.close()
  }
})

/** 百炼's Singapore compatible-mode address (M6 §预设): the longest a preset hands out. */
const LONG_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
const LONG_MODEL =
  'qwen3-max-2026-09-23-preview-long-context-instruct-experimental-build-for-the-research-workspace'
const LONG_NAME = {
  'zh-CN':
    '阿里云百炼新加坡站：数据团队共用的研究工作区，名称很长，用来看实例卡片在弹窗里会不会被撑出右边缘，以及底部的保存按钮是否依然可见',
  en: 'Model Studio Singapore: the shared research workspace, data team',
} as const
const LONG_ID = 'custom-6a1f0e2d-3c4b-4a59-8e7d-1b2c3d4e5f60'
const REFUSED_ID = 'custom-7b2e1f3c-4d5a-4b6c-9f8e-2c3d4e5f6a71'

/** The two instances of the layout check: long everything, and one whose address is refused. */
function layoutInstances(name: string): SeededInstance[] {
  return [
    {
      id: LONG_ID,
      displayName: name,
      wire: 'openai-chat',
      baseURL: LONG_URL,
      presetId: 'bailian',
      models: [
        { id: LONG_MODEL, contextLimit: 1_000_000, maxOutputTokens: 65_536 },
        {
          id: 'qwen3-max',
          contextLimit: 262_144,
          maxOutputTokens: 32_768,
          probe: {
            outcome: 'failed',
            reason: 'opaque-fields',
            probedAt: 1_791_000_000_000,
            reasoningField: null,
            maxTokensField: 'max_tokens',
            usageSeen: true,
            responseModelId: 'qwen3-max',
            unknownFields: ['encrypted_content', 'reasoning_details', 'extra_content'],
          },
        },
      ],
    },
    {
      id: REFUSED_ID,
      displayName: 'Old relay',
      wire: 'openai-chat',
      baseURL: 'http://relay.e2e.test/v1',
      models: [],
    },
  ]
}

/**
 * Everything in the settings card that crosses its left or right edge, or that clips or scrolls its
 * content sideways — text the card would cut, or a row a user would have to scroll to reach. Not
 * counted: a box whose overflow is visible (its content is drawn, and the edge check sees it escape
 * the card — the footer's full-bleed margins live there), a line cut short on purpose
 * (`text-overflow: ellipsis`), and a form control scrolling its own value.
 */
async function sideways(card: Locator): Promise<string[]> {
  return await card.evaluate((root) => {
    const edge = root.getBoundingClientRect()
    const found: string[] = []
    for (const element of [root, ...root.querySelectorAll('*')]) {
      const box = element.getBoundingClientRect()
      // Not drawn, or a screen reader's 1px box (`sr-only`), which clips its text on purpose.
      if (box.width <= 1 || box.height <= 1) continue
      const name =
        element.getAttribute('data-testid') ??
        `${element.tagName.toLowerCase()} ${(element.textContent ?? '').slice(0, 40)}`
      if (box.left < edge.left - 0.5 || box.right > edge.right + 0.5) {
        found.push(
          `${name} crosses the card (${box.left}–${box.right} of ${edge.left}–${edge.right})`,
        )
      }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) continue
      const style = getComputedStyle(element)
      if (style.overflowX === 'visible' || style.textOverflow === 'ellipsis') continue
      const over = element.scrollWidth - element.clientWidth
      if (over > 1) found.push(`${name} scrolls sideways by ${over}px`)
    }
    return found
  })
}

for (const locale of ['zh-CN', 'en'] as const) {
  test(`long names, addresses and model ids stay inside the settings card, and Save stays in view (第 9 步 S9-1, ${locale})`, async () => {
    const userData = makeUserDataDir(`vendor-layout-${locale}`)
    seedConfig(userData, { locale, customVendors: layoutInstances(LONG_NAME[locale]) })
    const { app, page } = await launchTenon({ userData })
    try {
      await openCard(page)
      const card = page.getByTestId('provider-settings')
      // Two instances start folded: the refusal shows on the folded card, then both open.
      await expect(page.getByTestId(`custom-vendor-refused-${REFUSED_ID}`)).toHaveAttribute(
        'data-refusal-code',
        'https-required',
      )
      await page.getByTestId(`custom-vendor-toggle-${LONG_ID}`).click()
      await page.getByTestId(`custom-vendor-toggle-${REFUSED_ID}`).click()
      await expect(page.getByTestId(`custom-vendor-name-${LONG_ID}`)).toHaveValue(LONG_NAME[locale])
      // The whole address, wrapped rather than cut.
      await expect(page.getByTestId(`custom-vendor-address-${LONG_ID}`)).toHaveText(LONG_URL)
      await expect(
        page.getByTestId(`custom-vendor-probe-status-${LONG_ID}-qwen3-max`),
      ).toContainText('encrypted_content, reasoning_details, extra_content')
      await expect(page.getByTestId(`custom-vendor-row-${LONG_ID}-${LONG_MODEL}`)).toBeVisible()
      expect(await sideways(card)).toEqual([])
      await expect(page.getByTestId('provider-save')).toBeInViewport({ ratio: 1 })
      await expect(page.getByTestId('provider-cancel')).toBeInViewport({ ratio: 1 })

      // The create form on the same preset: its address is read-only and as long.
      await page.getByTestId('custom-vendor-new').click()
      await page.getByTestId('custom-vendor-new-source').selectOption('bailian')
      await page.getByTestId('custom-vendor-new-region').selectOption('ap-southeast-1')
      await expect(page.getByTestId('custom-vendor-new-address')).toHaveText(LONG_URL)
      await page.getByTestId('custom-vendor-new-name').fill(LONG_NAME[locale])
      expect(await sideways(card)).toEqual([])
      await expect(page.getByTestId('provider-save')).toBeInViewport({ ratio: 1 })
    } finally {
      await app.close()
    }
  })
}
