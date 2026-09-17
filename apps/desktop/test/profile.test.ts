import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DesktopFs } from '../src/main/host/fs.js'
import { configPath, openProfile, readConfig, writeConfig } from '../src/main/host/profile.js'

/** Acceptance 5: two tenants write config.json to different, mutually invisible paths. */
describe('desktop profiles', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tenon-profile-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps two tenants of the same user apart on disk', async () => {
    const fs = new DesktopFs()
    const userData = absolutePath(root)
    const a = await openProfile(fs, userData, 'local', 'tenant-a')
    const b = await openProfile(fs, userData, 'local', 'tenant-b')

    await writeConfig(fs, a, { locale: 'zh-CN' })
    await writeConfig(fs, b, { locale: 'en' })

    expect(configPath(a)).not.toBe(configPath(b))
    expect(configPath(a)).toBe(join(root, 'profiles', 'local', 'tenant-a', 'config.json'))
    expect(await readConfig(fs, a)).toEqual({ locale: 'zh-CN' })
    expect(await readConfig(fs, b)).toEqual({ locale: 'en' })

    // Neither profile directory contains anything of the other.
    expect(await readdir(a.profileDir)).toEqual(['config.json', 'logs', 'mcp', 'plugins', 'skills'])
    expect(await readdir(b.profileDir)).toEqual(['config.json', 'logs', 'mcp', 'plugins', 'skills'])
    expect(await readdir(join(root, 'profiles', 'local'))).toEqual(['tenant-a', 'tenant-b'])
  })

  it('falls back to defaults when config.json is missing or corrupt', async () => {
    const fs = new DesktopFs()
    const identity = await openProfile(fs, absolutePath(root), 'local', 'personal')
    expect(await readConfig(fs, identity)).toEqual({ locale: 'auto' })
    await fs.writeFile(configPath(identity), '{not json')
    expect(await readConfig(fs, identity)).toEqual({ locale: 'auto' })
    await fs.writeFile(configPath(identity), '{"locale":"klingon"}')
    expect(await readConfig(fs, identity)).toEqual({ locale: 'auto' })
  })
})
