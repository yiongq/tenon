import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_FRAME_TYPES,
  checkTenantAssertion,
  classifyFrameType,
  decodeFrame,
  derivedTenantIdFromCredential,
  negotiateVersion,
} from '../src/bridge/frame.js'

const envelope = {
  v: 1,
  id: 'f1',
  ts: 1_726_000_000_000,
  tenantId: 't1',
  deviceId: 'd1',
}

describe('decodeFrame', () => {
  it('decodes the five protocol frames', () => {
    expect([...PROTOCOL_FRAME_TYPES].toSorted()).toEqual([
      'error',
      'hello',
      'ping',
      'pong',
      'welcome',
    ])
    const hello = decodeFrame({
      ...envelope,
      type: 'hello',
      body: { vMin: 1, vMax: 2, capabilities: ['tape'] },
    })
    expect(hello).toEqual({
      ok: true,
      frame: { ...envelope, type: 'hello', body: { vMin: 1, vMax: 2, capabilities: ['tape'] } },
    })
    // Also a compile-time check: the union narrows `body` by `type`.
    const vMax = hello.ok && hello.frame.type === 'hello' ? hello.frame.body.vMax : undefined
    expect(vMax).toBe(2)
    expect(decodeFrame({ ...envelope, type: 'ping', body: {} }).ok).toBe(true)
  })

  it('routes an unknown type into the unsupported-frame path without throwing', () => {
    for (const type of ['handshake', 'ns/name', 'a//b']) {
      const result = decodeFrame({ ...envelope, type, body: { anything: true } })
      expect(result).toEqual({
        ok: false,
        error: { code: 'unsupported-frame', replyTo: 'f1' },
      })
    }
  })

  it('reports a malformed envelope as bad-frame, replying to the id when readable', () => {
    expect(decodeFrame({ ...envelope, type: 'ping', tenantId: '' })).toEqual({
      ok: false,
      error: { code: 'bad-frame', replyTo: 'f1' },
    })
    expect(decodeFrame({ type: 'ping' })).toEqual({ ok: false, error: { code: 'bad-frame' } })
    expect(decodeFrame(null)).toEqual({ ok: false, error: { code: 'bad-frame' } })
    expect(decodeFrame('hello')).toEqual({ ok: false, error: { code: 'bad-frame' } })
  })

  it('reports a bad body for a known type as bad-frame', () => {
    expect(decodeFrame({ ...envelope, type: 'hello', body: { vMin: 2, vMax: 1 } })).toEqual({
      ok: false,
      error: { code: 'bad-frame', replyTo: 'f1' },
    })
    expect(decodeFrame({ ...envelope, type: 'welcome', body: { v: 0, capabilities: [] } })).toEqual(
      {
        ok: false,
        error: { code: 'bad-frame', replyTo: 'f1' },
      },
    )
    expect(decodeFrame({ ...envelope, type: 'error', body: { code: 'teapot' } })).toEqual({
      ok: false,
      error: { code: 'bad-frame', replyTo: 'f1' },
    })
  })

  it('reports an exotic raw value as bad-frame instead of throwing', () => {
    const throwing = {
      ...envelope,
      type: 'ping',
      body: {},
      get id(): string {
        throw new Error('hostile accessor')
      },
    }
    expect(decodeFrame(throwing)).toEqual({ ok: false, error: { code: 'bad-frame' } })
  })
})

describe('frame type space', () => {
  it('reserves a type without a slash for the protocol and names no business frame', () => {
    expect(classifyFrameType('ping')).toBe('reserved')
    expect(classifyFrameType('ns/name')).toBe('namespaced')
    // Tape's only non-first-party name shape, so the classifier must accept three segments.
    expect(classifyFrameType('ext/acme/thing')).toBe('namespaced')
    expect(classifyFrameType('/append')).toBe('malformed')
    expect(classifyFrameType('ns/')).toBe('malformed')
    expect(classifyFrameType('')).toBe('malformed')
    // 'reserved' means a syntactically legal protocol type, not merely "contains no slash".
    expect(classifyFrameType('A B!!')).toBe('malformed')
    expect(classifyFrameType('Ping')).toBe('malformed')
    expect(PROTOCOL_FRAME_TYPES.every((type) => classifyFrameType(type) === 'reserved')).toBe(true)
  })

  it('freezes the protocol type list so no importer can grow it', () => {
    expect(Object.isFrozen(PROTOCOL_FRAME_TYPES)).toBe(true)
  })
})

describe('negotiateVersion', () => {
  const local = { vMin: 1, vMax: 3, capabilities: ['tape', 'files'] }

  it('picks the highest common version and the capability intersection', () => {
    expect(negotiateVersion({ vMin: 1, vMax: 2, capabilities: ['files', 'gpu'] }, local)).toEqual({
      ok: true,
      welcome: { v: 2, capabilities: ['files'] },
    })
    expect(negotiateVersion({ vMin: 3, vMax: 9, capabilities: ['tape'] }, local)).toEqual({
      ok: true,
      welcome: { v: 3, capabilities: ['tape'] },
    })
  })

  it('rejects a disjoint interval with unsupported-version', () => {
    expect(negotiateVersion({ vMin: 4, vMax: 5, capabilities: ['tape'] }, local, 'f1')).toEqual({
      ok: false,
      error: { code: 'unsupported-version', replyTo: 'f1' },
    })
    expect(negotiateVersion({ vMin: 1, vMax: 1, capabilities: [] }, { ...local, vMin: 2 })).toEqual(
      {
        ok: false,
        error: { code: 'unsupported-version' },
      },
    )
  })

  it('never returns a welcome its own schema would reject', () => {
    // The inferred types are plain numbers, so a caller that skipped decodeFrame can offer these.
    expect(negotiateVersion({ vMin: 1, vMax: 2.5, capabilities: [] }, local).ok).toBe(false)
    expect(negotiateVersion({ vMin: 0, vMax: 0, capabilities: [] }, local).ok).toBe(false)
    expect(
      negotiateVersion({ vMin: 1, vMax: Number.POSITIVE_INFINITY, capabilities: [] }, local),
    ).toEqual({ ok: false, error: { code: 'bad-frame' } })
    // A local range the welcome schema rejects is our own misconfiguration, not a bad frame.
    expect(
      negotiateVersion({ vMin: 1, vMax: 3, capabilities: [] }, { ...local, vMax: 2.5 }),
    ).toEqual({ ok: false, error: { code: 'unsupported-version' } })
  })
})

describe('checkTenantAssertion', () => {
  const frame = { id: 'f1', tenantId: 't1' }

  it('accepts only an assertion that matches the derived tenant', () => {
    expect(checkTenantAssertion(frame, derivedTenantIdFromCredential('t1'))).toEqual({ ok: true })
    expect(checkTenantAssertion(frame, derivedTenantIdFromCredential('t2'))).toEqual({
      ok: false,
      error: { code: 'unauthorized', replyTo: 'f1' },
    })
    expect(
      checkTenantAssertion({ id: '', tenantId: '' }, derivedTenantIdFromCredential('')),
    ).toEqual({ ok: false, error: { code: 'unauthorized' } })
  })

  it('cannot be handed the frame own tenantId as the derived one', () => {
    // Rule 3 as a type error: a frame may not authorise itself. If the parameter ever widens
    // back to `string`, this expectation goes unused and typecheck fails.
    // @ts-expect-error the derived tenant is nominally distinct from a frame field
    const selfAuthorised = checkTenantAssertion(frame, frame.tenantId)
    // Runtime cannot tell the two strings apart — the guarantee is the compile error above.
    expect(selfAuthorised.ok).toBe(true)
  })
})
