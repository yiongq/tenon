import { expect, it } from 'vitest'
import { composerSlot } from '../src/renderer/src/lib/composer-slots.js'
import { serverView } from './support/mcp-view.js'
it('正在连接 appears only during first connect, at the lowest slot priority', () => {
  const s = serverView()
  s.status = { ...s.status, phase: 'connecting', firstConnect: true }
  expect(composerSlot(false, [s])).toEqual({ kind: 'connecting', name: 'Notes' })
  expect(composerSlot(true, [s])).toEqual({ kind: 'question' })
  expect(composerSlot(false, [{ ...s, enabled: false }])).toBeNull()
  expect(composerSlot(false, [{ ...s, status: { ...s.status, firstConnect: false } }])).toBeNull()
  expect(composerSlot(false, [{ ...s, status: { ...s.status, phase: 'connected' } }])).toBeNull()
})
