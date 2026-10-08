import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { McpServerView, McpServer } from '@tenon-app/contracts'
import { mcpServerSchema } from '@tenon-app/contracts'
import { launchHash } from '../../src/main/mcp/runtime.js'
import { expect } from './test.js'
export const MODERN_FIXTURE = resolve(
  '../../packages/kernel/test/support/fixtures/modern-server.mjs',
)
export function stdioConfig(id = 'notes', args: string[] = []): McpServer {
  const s = mcpServerSchema.parse({
    id,
    displayName: 'Notes fixture',
    source: 'manual',
    enabled: true,
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [MODERN_FIXTURE, ...args],
      envs: {},
      env_keys: [],
    },
    handshakeTimeoutSec: null,
    callTimeoutSec: null,
    instructions: { enabled: false, pinHash: null },
    consent: null,
    toolsPinned: false,
    tools: {},
  })
  s.consent = { launchHash: launchHash(s) }
  return s
}
export async function openConnectors(page: Page) {
  await page.getByTestId('account-row').click()
  await page.getByTestId('account-connectors').click()
  await expect(page.getByTestId('connectors-pane')).toBeVisible()
}
export async function closeSettings(page: Page) {
  await page.getByTestId('provider-settings').locator('[data-slot="dialog-close"]').click()
  await expect(page.getByTestId('provider-settings')).toBeHidden()
}
export async function addStdio(page: Page, id: string, args: string[] = []) {
  await page.getByTestId('connector-add').click()
  await page.getByTestId('mcp-id').fill(id)
  await page.getByTestId('mcp-displayName').fill('Notes ' + id)
  await page.getByTestId('mcp-command').fill(process.execPath)
  await page.getByTestId('mcp-args').fill(JSON.stringify([MODERN_FIXTURE, ...args]))
}
export async function mcpServers(page: Page): Promise<McpServerView[]> {
  return page.evaluate(async () => {
    const r = (await window.tenon.invoke('mcp.list', {})) as {
      ok: boolean
      data: { servers: McpServerView[] }
    }
    if (!r.ok) throw new Error('mcp.list failed')
    return r.data.servers
  })
}
export async function connected(page: Page, id = 'notes') {
  await expect
    .poll(async () => (await mcpServers(page)).find((s) => s.id === id)?.status.phase)
    .toBe('connected')
}
export async function setAlways(page: Page, tool: string, id = 'notes') {
  expect(
    await page.evaluate(
      ({ id: serverId, tool: toolName }) =>
        window.tenon.invoke('mcp.setToolSetting', {
          id: serverId,
          tool: toolName,
          setting: 'always-allow',
        }),
      { id, tool },
    ),
  ).toEqual({ ok: true, data: { ok: true } })
}
export function connectorCall(id: string, name: string) {
  return { type: 'tool_use', id, name: `notes__${name}`, input: {} } as const
}

export function resultOf(
  body: unknown,
  callId: string,
): { is_error?: boolean; content: { type: string; text?: string }[] } {
  const request = body as { messages: { content: unknown }[] }
  const results = request.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  )
  const result = results.find(
    (block) => block.type === 'tool_result' && block.tool_use_id === callId,
  )
  if (!result) throw new Error('Missing result for ' + callId)
  return result
}
