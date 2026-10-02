/**
 * Custom vendor instances for e2e and live specs (M6 §IPC), set up over the renderer's own bridge.
 * Every helper that puts a key into an instance runs `assertInstanceKeyStaysHome` first and fills
 * nothing when it throws: an official-looking key goes into an instance on api.anthropic.com only
 * (M6 §点名; 02 M4). The launch-time check (`assertOfficialKeyStaysHome`) never sees an instance's
 * key, which is typed into the app rather than handed in its environment.
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
  /** «其他兼容端点»: the address as typed. Presets are chosen on the settings card. */
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

/** `provider.configure` with an instance's new key, after the guard reads where it would go. */
export async function saveInstanceKey(page: Page, id: string, apiKey: string): Promise<void> {
  const listed = (await page.evaluate(
    async () => await (globalThis as unknown as Renderer).tenon.invoke('customVendor.list', {}),
  )) as { ok: boolean; data?: { instances: { id: string; baseURL: string }[] } }
  const baseURL = listed.data?.instances.find((entry) => entry.id === id)?.baseURL
  if (baseURL === undefined) throw new Error(`no custom vendor instance ${id}`)
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
