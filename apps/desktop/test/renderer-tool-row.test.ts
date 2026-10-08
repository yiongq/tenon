import { expect, it } from 'vitest'
import type { ToolOutcomeViewContract } from '@tenon-app/contracts'
import { toolRowEffect } from '../src/renderer/src/lib/tool-row-effect.js'
it('03 验收 45: side effects, write/external markers, and unauthorized-only relogin use mapped server ID', () => {
  for (const effect of ['read', 'write', 'external', 'blocked'] as const)
    for (const reversibility of [
      'read-only',
      'revertible',
      'snapshotted',
      'irreversible',
      'unknown',
    ] as const) {
      const out: ToolOutcomeViewContract = {
        effect,
        reversibility,
        state: 'completed',
        source: null,
        output: 'x',
      }
      expect(toolRowEffect(out, 'notes__echo')).toEqual({
        effectKey: `mcp.effects.${effect}`,
        reversibilityKey: `mcp.reversibility.${reversibility}`,
        marker:
          (effect === 'write' || effect === 'external') &&
          (reversibility === 'irreversible' || reversibility === 'unknown'),
        loginServerId: null,
      })
    }
  const denied: ToolOutcomeViewContract = {
    effect: 'blocked',
    state: 'not-run',
    source: 'connector-unauthorized',
    output: '',
  }
  expect(toolRowEffect(denied, 'notes__echo')?.loginServerId).toBe('notes')
  expect(toolRowEffect({ ...denied, source: 'protected' }, 'notes__echo')?.loginServerId).toBeNull()
  expect(toolRowEffect(denied, 'Read')?.loginServerId).toBeNull()
  expect(toolRowEffect(null, 'notes__echo')).toBeNull()
})

it('write without reversibility defaults to unknown and carries a side-effect marker', () => {
  expect(
    toolRowEffect(
      { effect: 'write', state: 'completed', source: null, output: 'ok' },
      'notes__echo',
    ),
  ).toMatchObject({ reversibilityKey: 'mcp.reversibility.unknown', marker: true })
})
