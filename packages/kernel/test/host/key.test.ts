import { describe, expect, it } from 'vitest'
import { keyFor } from '../../src/host/key.js'

describe('keyFor', () => {
  it('prefixes every key with the tenantId', () => {
    expect(keyFor({ tenantId: 't1' }, 'provider', 'anthropic', 'apiKey')).toBe(
      't1:provider:anthropic:apiKey',
    )
  })

  it('keeps two tenants apart for the same logical key', () => {
    const a = keyFor({ tenantId: 'acme' }, 'provider', 'apiKey')
    const b = keyFor({ tenantId: 'globex' }, 'provider', 'apiKey')
    expect(a).not.toBe(b)
  })

  it('rejects an empty tenantId', () => {
    expect(() => keyFor({ tenantId: '' }, 'x')).toThrow(/tenantId/)
  })

  it('rejects a tenantId containing the separator', () => {
    expect(() => keyFor({ tenantId: 'a:b' }, 'x')).toThrow(/tenantId/)
  })

  it('rejects missing or empty parts', () => {
    expect(() => keyFor({ tenantId: 't' })).toThrow(/part/)
    expect(() => keyFor({ tenantId: 't' }, 'a', '')).toThrow(/part/)
  })
})
