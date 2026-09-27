import { describe, expect, it } from 'vitest'
import { absolutePath } from '../../src/host/path.js'
import {
  PROFILE_SUBDIRS,
  assertProfileId,
  profileDirFor,
  toolOutputDirFor,
} from '../../src/host/profile.js'

const root = absolutePath('/Users/me/Library/Application Support/tenon')

describe('profileDirFor', () => {
  it('lays out <root>/profiles/<userId>/<tenantId>', () => {
    expect(profileDirFor(root, 'u1', 'personal')).toBe(
      '/Users/me/Library/Application Support/tenon/profiles/u1/personal',
    )
  })

  it('gives two tenants of the same user different directories', () => {
    const a = profileDirFor(root, 'u1', 'personal')
    const b = profileDirFor(root, 'u1', 'acme')
    expect(a).not.toBe(b)
    expect(a.startsWith(b)).toBe(false)
    expect(b.startsWith(a)).toBe(false)
  })

  it('refuses ids that could escape or collide as directory names', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '.hidden', 'a b', 'a:b']) {
      expect(() => assertProfileId('tenantId', bad)).toThrow(TypeError)
    }
    expect(() => profileDirFor(root, '../x', 't')).toThrow(/userId/)
  })

  it('declares the phase-0 sub-directories', () => {
    expect([...PROFILE_SUBDIRS]).toEqual(['logs', 'mcp', 'skills', 'plugins'])
  })
})

describe('toolOutputDirFor (spec 02 §大响应落盘; 旧 57, 旧 188)', () => {
  const profile = absolutePath('/Users/me/tenon/profiles/u1/personal')
  const session = '0f8e2d4c-6b1a-4c3e-9d7f-2a5b8c1e4f60'

  it('lays out <profileDir>/tool-output/<sessionId>', () => {
    expect(toolOutputDirFor(profile, session)).toBe(`${profile}/tool-output/${session}`)
  })

  it('throws TypeError for an id that is not a canonical UUID, before any path is made', () => {
    for (const bad of ['../x', session.toUpperCase(), `{${session}}`, `${session}/..`, '', 's1']) {
      expect(() => toolOutputDirFor(profile, bad)).toThrow(TypeError)
    }
  })
})
