/**
 * `config.json` is replaced whole, never cut (M6 §写入规则): every write goes to a temporary file in
 * the same directory and is renamed over it, so a read outside the config lock sees the old file or
 * the new one, and a write that fails before the rename leaves the old file — and every instance in
 * it — as it was, with no temporary file behind. On the real disk, in a temporary profile directory;
 * `node:fs/promises`, wrapped below, can make the next write in that directory run out of space
 * halfway or have its rename refused.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
import type { HostIdentity } from '@tenon-app/kernel'
import type { Config, CustomVendorContract } from '@tenon-app/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopFs } from '../src/main/host/fs.js'
import { configPath, openProfile, readConfig, writeConfig } from '../src/main/host/profile.js'

/** The failure the next write into `dir` meets: halfway through its bytes, or at its rename. */
const fault = vi.hoisted(() => ({
  dir: '',
  next: null as { at: 'write' | 'rename'; code: string } | null,
}))

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: injected`), { code })
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>()
  return {
    ...real,
    async open(...args: Parameters<typeof real.open>) {
      const handle = await real.open(...args)
      const armed = fault.next
      if (armed?.at === 'write' && dirname(String(args[0])) === fault.dir) {
        const write = handle.write.bind(handle)
        // Half the bytes reach the disk, then the disk is full: whichever way the bytes are written.
        const halfThenFail = async (data: string | Uint8Array): Promise<never> => {
          fault.next = null
          const bytes = typeof data === 'string' ? Buffer.from(data) : data
          await write(bytes.subarray(0, Math.floor(bytes.length / 2)))
          throw errno(armed.code)
        }
        handle.writeFile = halfThenFail as typeof handle.writeFile
        handle.write = halfThenFail as typeof handle.write
      }
      return handle
    },
    async rename(...args: Parameters<typeof real.rename>) {
      const armed = fault.next
      if (armed?.at === 'rename' && dirname(String(args[1])) === fault.dir) {
        fault.next = null
        throw errno(armed.code)
      }
      return real.rename(...args)
    },
  }
})

/** What a profile directory holds when nothing else was left in it. */
const PROFILE_ENTRIES = ['config.json', 'logs', 'mcp', 'plugins', 'skills']

/** Instances with as many rows as the schema allows, so `config.json` is tens of KiB. */
function instances(): CustomVendorContract[] {
  return ['0b7e1c5a', '1c8f2d6b', '2d9a3e7c'].map((prefix, index) => ({
    id: `custom-${prefix}-3d2f-4e6a-9b8c-1d2e3f4a5b6c`,
    displayName: `Relay ${String(index)}`,
    wire: index === 1 ? 'anthropic-messages' : 'openai-chat',
    baseURL: `https://relay-${String(index)}.example/v1`,
    models: Array.from({ length: 200 }, (_, row) => ({
      id: `model-${String(row).padStart(3, '0')}`,
      contextLimit: 128_000,
      maxOutputTokens: 8_000,
    })),
  }))
}

/** A read as one line: its locale, then every instance with its row count. */
function summary(config: Pick<Config, 'locale' | 'customVendors'>): string {
  const rows = config.customVendors.map((entry) => `${entry.id}/${String(entry.models.length)}`)
  return `${config.locale} ${rows.join()}`
}

describe('config.json writes (M6 §写入规则)', () => {
  let root = ''
  const fs = new DesktopFs()

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tenon-config-replace-'))
  })
  afterEach(async () => {
    fault.next = null
    await rm(root, { recursive: true, force: true })
  })

  async function profileWithInstances(name: string): Promise<HostIdentity> {
    const identity = await openProfile(fs, absolutePath(root), 'local', name)
    await writeConfig(fs, identity, { locale: 'en', customVendors: instances() })
    return identity
  }

  it.each([
    { at: 'write', code: 'ENOSPC', what: 'runs out of space halfway' },
    { at: 'write', code: 'EFBIG', what: 'passes the size limit halfway' },
    { at: 'rename', code: 'EACCES', what: 'has its rename refused' },
  ] as const)(
    'leaves the previous file byte for byte, its instances readable, when a write $what',
    async ({ at, code }) => {
      const identity = await profileWithInstances(`failed-${at}-${code}`)
      const before = await readFile(configPath(identity))
      fault.dir = identity.profileDir
      fault.next = { at, code }

      await expect(
        writeConfig(fs, identity, { locale: 'zh-CN', customVendors: instances().slice(1) }),
      ).rejects.toMatchObject({ code })
      expect(fault.next).toBeNull()

      expect(await readFile(configPath(identity))).toEqual(before)
      const lines: string[] = []
      const config = await readConfig(fs, identity, (line) => lines.push(line))
      expect(config.locale).toBe('en')
      expect(config.customVendors).toEqual(instances())
      expect(lines).toEqual([])
      // No temporary file is left behind by the failure, nor by the next write, which succeeds.
      expect(await readdir(identity.profileDir)).toEqual(PROFILE_ENTRIES)
      await writeConfig(fs, identity, { locale: 'zh-CN' })
      expect(await readConfig(fs, identity)).toMatchObject({
        locale: 'zh-CN',
        customVendors: instances(),
      })
      expect(await readdir(identity.profileDir)).toEqual(PROFILE_ENTRIES)
    },
  )

  it('never shows a read outside the lock a cut or empty file while writes go on', async () => {
    // The reads take no lock (startup, run-assembly, the routes' quick looks); a cut file would read
    // as defaults with no instance, and the next write would persist that.
    const identity = await profileWithInstances('concurrent')
    const seen: Config[] = []
    const lines: string[] = []
    const writes = { done: false }

    async function reader(): Promise<void> {
      while (!writes.done) {
        // oxlint-disable-next-line no-await-in-loop -- one read after another, alongside the writes
        seen.push(await readConfig(fs, identity, (line) => lines.push(line)))
      }
    }
    async function writer(): Promise<void> {
      try {
        for (let round = 0; round < 40; round += 1) {
          // oxlint-disable-next-line no-await-in-loop -- the writes take the lock one at a time
          await writeConfig(fs, identity, { locale: round % 2 === 0 ? 'zh-CN' : 'en' })
        }
      } finally {
        writes.done = true
      }
    }
    await Promise.all([writer(), reader(), reader(), reader()])

    expect(seen.length).toBeGreaterThan(40)
    const whole = new Set(
      (['zh-CN', 'en'] as const).map((locale) => summary({ locale, customVendors: instances() })),
    )
    expect(seen.map(summary).filter((line) => !whole.has(line))).toEqual([])
    expect(lines).toEqual([])
    expect(await readdir(identity.profileDir)).toEqual(PROFILE_ENTRIES)
  })
})
