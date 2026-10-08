import type {
  ClosureSource,
  PendingApproval,
  ToolExclusionCode,
  ToolOutcomeView,
} from '@tenon-app/kernel'
import { expect, it } from 'vitest'
import type { z } from 'zod'
import { MCP_SERVER_ID_PATTERN as KERNEL_PATTERN } from '../../kernel/src/tools/registry.js'
import type { approvalCurrent, closureSourceSchema, toolOutcomeViewSchema } from '../src/index.js'
import { ipcRoutes } from '../src/index.js'
import type { mcpToolViewSchema } from '../src/ipc/mcp.js'
import {
  MCP_SERVER_ID_PATTERN,
  mcpServerIdSchema,
  mcpServerSchema,
  serverIdOfMappedName,
} from '../src/ipc/mcp.js'

type Assert<T extends true> = T
type Both<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Approval = Extract<
  NonNullable<z.infer<typeof approvalCurrent.response>>,
  { waitKind: 'approval' }
>
export type Sources = Assert<Both<ClosureSource, z.infer<typeof closureSourceSchema>>>
export type Reversibility = Assert<
  Both<ToolOutcomeView['reversibility'], z.infer<typeof toolOutcomeViewSchema>['reversibility']>
>
export type Changed = Assert<
  Both<PendingApproval['definitionChanged'], Approval['definitionChanged']>
>
export type Unavailable = Assert<
  Exclude<z.infer<typeof mcpToolViewSchema>['unavailable'], null> extends ToolExclusionCode
    ? true
    : false
>

it('03 验收 23: the server id schema refuses uppercase, _, :, more than 24 characters and builtin', () => {
  for (const id of ['Upper', 'a_b', 'a:b', 'a'.repeat(25), 'builtin', ''])
    expect(mcpServerIdSchema.safeParse(id).success).toBe(false)
  expect(mcpServerIdSchema.parse('notes-1')).toBe('notes-1')
  expect(KERNEL_PATTERN.source).toBe(MCP_SERVER_ID_PATTERN.source)
  expect(serverIdOfMappedName('notes-1__a__b')).toBe('notes-1')
  expect(serverIdOfMappedName('builtin__Read')).toBeNull()
})
it('03 验收 40 (routes): ipcRoutes has no prompts or resources route', () => {
  expect(Object.keys(ipcRoutes).some((n) => /mcp\.(prompts|resources)/.test(n))).toBe(false)
})
it('callTimeoutSec outside 1–3600 is clamped, not refused', () => {
  const server = {
    id: 'notes',
    displayName: 'Notes',
    source: 'manual',
    enabled: true,
    transport: { type: 'stdio', command: '/bin/node', args: [], envs: {}, env_keys: [] },
    handshakeTimeoutSec: null,
    callTimeoutSec: 0,
    instructions: { enabled: false, pinHash: null },
    consent: null,
    toolsPinned: false,
    tools: {},
  }
  expect(mcpServerSchema.parse(server).callTimeoutSec).toBe(1)
  expect(mcpServerSchema.parse({ ...server, callTimeoutSec: 3601 }).callTimeoutSec).toBe(3600)
  expect(
    mcpServerSchema.safeParse({
      ...server,
      transport: { ...server.transport, envs: { ld_preload: 'x' } },
    }).success,
  ).toBe(false)
})
