import { describe, expect, it } from 'vitest'
import { isCanonicalUuid } from '../src/index.js'
import { createCounterIds } from '../src/testing/index.js'

describe('isCanonicalUuid', () => {
  it('accepts lowercase 8-4-4-4-12 and nothing else', () => {
    expect(isCanonicalUuid('6f1a5b4c-2d3e-4f50-8a9b-0c1d2e3f4a5b')).toBe(true)
    expect(isCanonicalUuid('6F1A5B4C-2D3E-4F50-8A9B-0C1D2E3F4A5B')).toBe(false)
    expect(isCanonicalUuid('{6f1a5b4c-2d3e-4f50-8a9b-0c1d2e3f4a5b}')).toBe(false)
    expect(isCanonicalUuid('urn:uuid:6f1a5b4c-2d3e-4f50-8a9b-0c1d2e3f4a5b')).toBe(false)
    expect(isCanonicalUuid('6f1a5b4c2d3e4f508a9b0c1d2e3f4a5b')).toBe(false)
    expect(isCanonicalUuid('6f1a5b4c-2d3e-4f50-8a9b-0c1d2e3f4a5')).toBe(false)
    expect(isCanonicalUuid('')).toBe(false)
  })
})

describe('createCounterIds', () => {
  it('is deterministic, canonical and reproducible across instances', () => {
    const ids = createCounterIds()
    expect(ids.uuid()).toBe('00000000-0000-4000-8000-000000000001')
    expect(ids.uuid()).toBe('00000000-0000-4000-8000-000000000002')
    expect(ids.issued).toBe(2)
    expect([ids.uuid(), ids.uuid()].every(isCanonicalUuid)).toBe(true)
    const fresh = createCounterIds()
    expect(fresh.uuid()).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('starts where the fixture asks it to', () => {
    const ids = createCounterIds({ start: 0x10 })
    expect(ids.uuid()).toBe('00000000-0000-4000-8000-000000000010')
    expect(ids.issued).toBe(1)
    expect(() => createCounterIds({ start: -1 })).toThrow(RangeError)
    expect(() => createCounterIds({ start: 1.5 })).toThrow(RangeError)
  })
})
