/**
 * Custom vendor instances for e2e and live specs (M6 §IPC), set up over the renderer's own bridge
 * (`createInstance`, `saveInstanceKey`) or typed into the settings card the way a user does
 * (`createInstanceInCard`, `saveInstanceKeyInCard`; Playwright locators only, no DOM types, so the
 * unit tests can import them too). Every helper that puts a key into an instance runs
 * `assertInstanceKeyStaysHome` first and fills nothing when it throws: an official-looking key
 * goes into an instance on api.anthropic.com only (M6 §点名; 02 M4). The launch-time check
 * (`assertOfficialKeyStaysHome`) never sees an instance's key, which is typed into the app rather
 * than handed in its environment.
 */
import type { Page } from '@playwright/test'
import type { TenonBridge } from '../../src/preload/index.js'
import { assertInstanceKeyStaysHome } from './app-env.js'

/**
 * The renderer's global, spelled without the DOM lib so the unit tests (test/live-env.test.ts) can
 * import these helpers too: in the page `globalThis` is `window`.
 */
type Renderer = { readonly tenon: TenonBridge }

export interface NewInstance {
  readonly displayName: string
  readonly wire: 'openai-chat' | 'anthropic-messages'
  /** «其他兼容端点»: the address as typed; a `PresetInstance`'s, the one its region gives. */
  readonly baseURL: string
  readonly apiKey: string
}

/** `customVendor.create` with a typed address; resolves to the new instance's id. */
export async function createInstance(page: Page, instance: NewInstance): Promise<string> {
  assertInstanceKeyStaysHome(instance.baseURL, instance.apiKey)
  const answer = (await page.evaluate(
    async (request) =>
      await (globalThis as unknown as Renderer).tenon.invoke('customVendor.create', request),
    {
      displayName: instance.displayName,
      wire: instance.wire,
      source: { kind: 'custom', baseURL: instance.baseURL },
      apiKey: instance.apiKey,
    },
  )) as { ok: boolean; data?: { ok: boolean; id?: string; code?: string } }
  if (!answer.ok || answer.data?.ok !== true || answer.data.id === undefined) {
    throw new Error(`customVendor.create was refused: ${JSON.stringify(answer.data ?? null)}`)
  }
  return answer.data.id
}

/** The instances `customVendor.list` answers, in their order: ids and addresses only. */
async function listInstances(page: Page): Promise<{ id: string; baseURL: string }[]> {
  const listed = (await page.evaluate(
    async () => await (globalThis as unknown as Renderer).tenon.invoke('customVendor.list', {}),
  )) as { ok: boolean; data?: { instances: { id: string; baseURL: string }[] } }
  if (!listed.ok || listed.data === undefined) throw new Error('customVendor.list failed')
  return listed.data.instances
}

/** Where an instance's key would go: its fixed address (T2), read from main. */
async function addressOf(page: Page, id: string): Promise<string> {
  const baseURL = (await listInstances(page)).find((entry) => entry.id === id)?.baseURL
  if (baseURL === undefined) throw new Error(`no custom vendor instance ${id}`)
  return baseURL
}

/** `provider.configure` with an instance's new key, after the guard reads where it would go. */
export async function saveInstanceKey(page: Page, id: string, apiKey: string): Promise<void> {
  const baseURL = await addressOf(page, id)
  assertInstanceKeyStaysHome(baseURL, apiKey)
  const answer = (await page.evaluate(
    async (request) =>
      await (globalThis as unknown as Renderer).tenon.invoke('provider.configure', request),
    { id, values: { apiKey } },
  )) as { ok: boolean; data?: { ok: boolean } }
  if (!answer.ok || answer.data?.ok !== true) {
    throw new Error(`provider.configure was refused for ${id}: ${JSON.stringify(answer.data)}`)
  }
}

/** How long a settings card write may take before a helper gives up on it. */
const CARD_WRITE_MS = 10_000

/**
 * A preset's region on the settings card (M6 §预设): main looks its address up by the two ids, so
 * `baseURL` here is the address the test expects that region to give for `wire` — what the guard
 * reads, and what the card must show before the key is typed.
 */
export interface PresetInstance extends NewInstance {
  readonly preset: string
  readonly region: string
}

/**
 * 「新建自定义厂商」 on the settings card, which must be open: 「其他兼容端点」 with the address typed,
 * or a preset with its region, then the wire, the name and the key, then 「创建」 (M6 §IPC
 * `customVendor.create`, the path a user takes). A preset's read-only address must be `baseURL`
 * before the key is typed, and the instance main stored must be at it. Resolves to the new
 * instance's id once the form has closed; throws with the form's own refusal (its catalogue key)
 * when it stays open.
 */
export async function createInstanceInCard(
  page: Page,
  instance: NewInstance | PresetInstance,
): Promise<string> {
  assertInstanceKeyStaysHome(instance.baseURL, instance.apiKey)
  const before = new Set((await listInstances(page)).map((entry) => entry.id))
  await page.getByTestId('custom-vendor-new').click()
  const preset = 'preset' in instance ? instance : null
  if (preset === null) {
    // 「其他兼容端点」 is the source with no preset id (CustomVendorSection.tsx `OTHER`).
    await page.getByTestId('custom-vendor-new-source').selectOption('')
    await page.getByTestId('custom-vendor-new-wire').selectOption(instance.wire)
    await page.getByTestId('custom-vendor-new-baseurl').fill(instance.baseURL)
  } else {
    await page.getByTestId('custom-vendor-new-source').selectOption(preset.preset)
    await page.getByTestId('custom-vendor-new-region').selectOption(preset.region)
    await page.getByTestId('custom-vendor-new-wire').selectOption(preset.wire)
    // The guard read `baseURL`: a preset that gives another address gets no key typed for it.
    const shown = await page.getByTestId('custom-vendor-new-address').textContent()
    if (shown !== preset.baseURL) {
      throw new Error(
        `preset ${preset.preset} (${preset.region}, ${preset.wire}) gives ${String(shown)}, ` +
          `not ${preset.baseURL}: typing no key`,
      )
    }
  }
  await page.getByTestId('custom-vendor-new-name').fill(instance.displayName)
  await page.getByTestId('custom-vendor-new-key').fill(instance.apiKey)
  await page.getByTestId('custom-vendor-new-submit').click()
  // Created: the form closes and its 「新建自定义厂商」 button is back. Refused: the form says why.
  const error = page.getByTestId('custom-vendor-new-error')
  await page.getByTestId('custom-vendor-new').or(error).first().waitFor({ timeout: CARD_WRITE_MS })
  if (await error.isVisible()) {
    throw new Error(`the card refused the instance: ${await error.getAttribute('data-message')}`)
  }
  const created = (await listInstances(page)).filter((entry) => !before.has(entry.id))
  if (created.length !== 1) throw new Error(`expected one new instance, found ${created.length}`)
  const [made] = created
  // Main resolved the preset itself (§预设): its key goes where it stored, so that must be it too.
  if (preset !== null && made?.baseURL !== preset.baseURL) {
    throw new Error(`the preset instance is at ${String(made?.baseURL)}, not ${preset.baseURL}`)
  }
  return made?.id ?? ''
}

/**
 * Types an instance's key into its card on the open settings card and presses 「保存 key」 (M6 §key:
 * `provider.configure`, which clears every probe of it). The guard reads where the key would go
 * first and types nothing when it throws. Resolves once the card took it — the field empties —
 * and throws with the card's own refusal otherwise.
 */
export async function saveInstanceKeyInCard(page: Page, id: string, apiKey: string): Promise<void> {
  // An empty field would read as saved at once: clearing a key is a step of a test's own.
  if (apiKey === '') throw new Error('saveInstanceKeyInCard types a key; it does not clear one')
  assertInstanceKeyStaysHome(await addressOf(page, id), apiKey)
  const toggle = page.getByTestId(`custom-vendor-toggle-${id}`)
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  const field = page.getByTestId(`custom-vendor-key-${id}`)
  await field.fill(apiKey)
  await page.getByTestId(`custom-vendor-key-save-${id}`).click()
  const message = page.getByTestId(`custom-vendor-message-${id}`)
  const deadline = Date.now() + CARD_WRITE_MS
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polled until the write answers
    if (await message.isVisible()) {
      // oxlint-disable-next-line no-await-in-loop -- once, on the way out
      throw new Error(`the card refused the key: ${await message.getAttribute('data-message')}`)
    }
    // oxlint-disable-next-line no-await-in-loop -- polled until the write answers
    if ((await field.inputValue()) === '') return
    if (Date.now() > deadline) throw new Error(`the key of ${id} was not saved in time`)
    // oxlint-disable-next-line no-await-in-loop -- polled until the write answers
    await page.waitForTimeout(50)
  }
}
