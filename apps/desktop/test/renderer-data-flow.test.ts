/**
 * The model menu's data-flow decisions (spec 02 §模型选择「数据去向」; A9, 验收 34; lib/data-flow.ts):
 * a choice is compared with where the session's history last went, whatever the choice in effect
 * is (s19-spec-1), and a held round's confirmation names the host its 「切换」 sends to
 * (s19-safety-3). The e2e half is model-menu.spec.ts.
 */
import type { ProviderEndpoint } from '@tenon-app/contracts'
import { describe, expect, it } from 'vitest'
import { confirmHostFor, heldConfirmHost } from '../src/renderer/src/lib/data-flow.js'

const LOCAL: ProviderEndpoint = { host: '127.0.0.1', reach: 'loopback' }
const LAN: ProviderEndpoint = { host: '192.168.1.20', reach: 'private' }
const ZHIPU: ProviderEndpoint = { host: 'open.bigmodel.cn', reach: 'public' }
const ANTHROPIC: ProviderEndpoint = { host: 'api.anthropic.com', reach: 'public' }

describe('confirmHostFor', () => {
  it('asks before history that went to this machine or a private host goes to a public one', () => {
    expect(confirmHostFor(LOCAL, ZHIPU, true)).toBe('open.bigmodel.cn')
    expect(confirmHostFor(LAN, ANTHROPIC, true)).toBe('api.anthropic.com')
  })

  it('asks by where the history went, not by the choice in effect (s19-spec-1)', () => {
    // A session on this machine whose default moved to a public host: whatever row is picked — the
    // default's own, another public one, a level of it — the history has not left yet.
    expect(confirmHostFor(LOCAL, ANTHROPIC, true)).toBe('api.anthropic.com')
    // Once it did go to a public host, another public host asks nothing (A9 is local → public).
    expect(confirmHostFor(ZHIPU, ANTHROPIC, true)).toBeNull()
  })

  it('asks nothing for a local target, or a session nothing was sent from', () => {
    expect(confirmHostFor(LOCAL, LAN, true)).toBeNull()
    expect(confirmHostFor(null, ZHIPU, false)).toBeNull()
    expect(confirmHostFor(LOCAL, undefined, true)).toBeNull()
  })

  it('asks when where the history went could not be read, as long as there is history', () => {
    expect(confirmHostFor(undefined, ZHIPU, true)).toBe('open.bigmodel.cn')
    expect(confirmHostFor(undefined, ZHIPU, false)).toBeNull()
  })
})

describe('heldConfirmHost', () => {
  it('names where the committed choice sends now, not the host the round was held for', () => {
    // Held for api.anthropic.com; the default has since moved to zhipu, which 「切换」 commits.
    expect(heldConfirmHost('api.anthropic.com', ZHIPU)).toBe('open.bigmodel.cn')
    expect(heldConfirmHost('api.anthropic.com', undefined)).toBe('api.anthropic.com')
  })
})
