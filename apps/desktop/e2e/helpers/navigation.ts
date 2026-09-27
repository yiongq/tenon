/**
 * What the navigation, queue and recovery specs share: the main process's own count of each route it
 * received (the e2e route seam, src/main/e2e-routes.ts), the ways out of a session (sidebar, the
 * menu's New Chat, the banner's 「回去」), and the Run ends main pushed.
 */
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@playwright/test'
import { configPathIn } from './launch.js'
import { expect } from './test.js'
import { pushesOf } from './tools.js'

/** Turns the route counter on (`TENON_E2E_ROUTE_COUNTS`, development builds only). */
export const COUNT_ROUTES: Readonly<Record<string, string>> = { TENON_E2E_ROUTE_COUNTS: '1' }

/**
 * How many times main received `channel` since launch. Throws when the counter is off, so a spec that
 * forgot `COUNT_ROUTES` fails loudly instead of reading a vacuous 0.
 */
export async function routeCalls(app: ElectronApplication, channel: string): Promise<number> {
  const counted = await app.evaluate((_electron, wanted) => {
    const table = (globalThis as { tenonRouteCalls?: Record<string, number> }).tenonRouteCalls
    return table === undefined ? null : (table[wanted] ?? 0)
  }, channel)
  if (counted === null) throw new Error('the route counter is off: launch with COUNT_ROUTES')
  return counted
}

/** The sidebar's 「新对话」: the first row, above the navigation. */
export async function newChatFromSidebar(page: Page): Promise<void> {
  await page.getByTestId('nav-item').first().click()
}

/** File › New Chat (`chat.new`), found by its accelerator so it works in either language. */
export async function newChatFromMenu(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()?.items.flatMap((item) => item.submenu?.items ?? [])
    const newChat = items?.find((item) => item.accelerator === 'CmdOrCtrl+N')
    if (newChat === undefined) throw new Error('New Chat is not in the application menu')
    newChat.click()
  })
}

/** A Run's terminal `chat.event` as main pushed it (`recordPushes` must be on). */
export interface EndPush {
  readonly type: 'done' | 'error'
  readonly sessionId: string
  readonly endReason?: { readonly code: string }
}

/** The end codes main pushed so far, in order. */
export async function endCodes(app: ElectronApplication): Promise<string[]> {
  const events = await pushesOf<EndPush>(app, 'chat.event')
  return events
    .filter((event) => event.type === 'done' || event.type === 'error')
    .map((event) => event.endReason?.code ?? event.type)
}

/** Every root session waiting on something, as `approval.list` answers it. */
export async function waitingSessions(
  page: Page,
): Promise<Array<{ sessionId: string; waitKind: string }>> {
  return await page.evaluate(async () => {
    const list = (await window.tenon.invoke('approval.list', { limit: 20 })) as {
      ok: boolean
      data: Array<{ sessionId: string; waitKind: string }>
    }
    return list.ok ? list.data : []
  })
}

/** Clicks on a card that just appeared are ignored this long (ApprovalCard.tsx's guard is 400). */
export const PAST_CLICK_GUARD_MS = 600

/** Allows the one card on screen once its click guard has passed. */
export async function allowCard(page: Page): Promise<void> {
  const card = page.getByTestId('approval-card')
  await expect(card).toHaveCount(1)
  await page.waitForTimeout(PAST_CLICK_GUARD_MS)
  await card.getByTestId('approval-allow').click()
}

/** Points the symbolic link `link` at `target` instead (what a startup re-judgement then reads). */
export function repoint(link: string, target: string): void {
  rmSync(link)
  symlinkSync(target, link, 'dir')
}

/**
 * Rewrites the default model of every profile in a profile root's `config.json` between two launches
 * (and, with `providerConfig`, that provider's settings), keeping whatever else the app wrote there.
 */
export function setDefaultModel(
  userData: string,
  choice: { readonly id: string; readonly modelId: string },
  providerConfig?: Readonly<Record<string, string>>,
): void {
  const file = configPathIn(userData)
  const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  config['provider'] = choice
  config['defaultModelByProfile'] = { chat: choice, cowork: choice }
  if (providerConfig !== undefined) {
    const before = (config['providerConfig'] ?? {}) as Record<string, unknown>
    config['providerConfig'] = { ...before, [choice.id]: providerConfig }
  }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
}
