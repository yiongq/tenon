/**
 * The model menu's data-flow decisions (spec 02 §模型选择「数据去向」; A9, 验收 34; lib/data-flow.ts):
 * a choice is compared with where the session's history last went, whatever the choice in effect
 * is (s19-spec-1), and a held round's confirmation names the host its 「切换」 sends to
 * (s19-safety-3); a host the session's own choice already confirmed is not asked again (rrE-1). The
 * e2e half is model-menu.spec.ts.
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
    expect(confirmHostFor(LOCAL, ZHIPU, true, null)).toBe('open.bigmodel.cn')
    expect(confirmHostFor(LAN, ANTHROPIC, true, null)).toBe('api.anthropic.com')
  })

  it('asks by where the history went, not by the choice in effect (s19-spec-1)', () => {
    // A session on this machine whose default moved to a public host: whatever row is picked — the
    // default's own, another public one, a level of it — the history has not left yet.
    expect(confirmHostFor(LOCAL, ANTHROPIC, true, null)).toBe('api.anthropic.com')
    // Once it did go to a public host, another public host asks nothing (A9 is local → public).
    expect(confirmHostFor(ZHIPU, ANTHROPIC, true, null)).toBeNull()
  })

  it('asks nothing for a local target, or a session nothing was sent from', () => {
    expect(confirmHostFor(LOCAL, LAN, true, null)).toBeNull()
    expect(confirmHostFor(null, ZHIPU, false, null)).toBeNull()
    expect(confirmHostFor(LOCAL, undefined, true, null)).toBeNull()
  })

  it('asks when where the history went could not be read, as long as there is history', () => {
    expect(confirmHostFor(undefined, ZHIPU, true, null)).toBe('open.bigmodel.cn')
    expect(confirmHostFor(undefined, ZHIPU, false, null)).toBeNull()
  })
})

describe("confirmHostFor with the session's own choice (rrE-1)", () => {
  it('asks nothing again for the public host the session already confirmed choosing it', () => {
    // ① is zhipu, confirmed on its row; no Run since, so the history last went to this machine. A
    // level of it, its row again or a model typed for it goes where the user already said yes to.
    expect(confirmHostFor(LOCAL, ZHIPU, true, 'open.bigmodel.cn')).toBeNull()
    expect(confirmHostFor(undefined, ZHIPU, true, 'open.bigmodel.cn')).toBeNull()
  })

  it('still asks for another public host, and for a default nobody confirmed', () => {
    expect(confirmHostFor(LOCAL, ANTHROPIC, true, 'open.bigmodel.cn')).toBe('api.anthropic.com')
    expect(confirmHostFor(LAN, ZHIPU, true, null)).toBe('open.bigmodel.cn')
  })
})

describe('heldConfirmHost', () => {
  it('names where the committed choice sends now, not the host the round was held for', () => {
    // Held for api.anthropic.com; the default has since moved to zhipu, which 「切换」 commits.
    expect(heldConfirmHost('api.anthropic.com', ZHIPU)).toBe('open.bigmodel.cn')
    expect(heldConfirmHost('api.anthropic.com', undefined)).toBe('api.anthropic.com')
  })
})
