/** Real discovery ports, without starting sandbox-runtime or Electron. */
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { desktopSandboxFs } from '../../src/main/host/sandbox.js'

const roots: string[] = []
const fs = desktopSandboxFs()
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-git-ports-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('auto-tier-hardening 验收 15: real readText enforces a byte limit at the boundary', async () => {
  const root = await fixture()
  const file = join(root, 'config')
  const text = '配置'
  const bytes = Buffer.byteLength(text)
  await writeFile(file, text)
  await expect(fs.readText(file, bytes)).resolves.toBe(text)
  await expect(fs.readText(file, bytes - 1)).rejects.toThrow('git metadata exceeds read limit')
})

it('auto-tier-hardening 验收 15: real discovery ports accept missing and ENOTDIR paths', async () => {
  const root = await fixture()
  const file = join(root, 'file')
  await writeFile(file, '')
  for (const path of [join(root, 'missing'), join(file, 'child')]) {
    // oxlint-disable-next-line no-await-in-loop -- each real filesystem error is checked separately
    await expect(fs.readText(path, 64)).resolves.toBeNull()
    // oxlint-disable-next-line no-await-in-loop -- each real filesystem error is checked separately
    await expect(fs.readdir(path)).resolves.toEqual([])
  }
  await expect(fs.readdir(root)).resolves.toEqual(['file'])
})

it.each(['directory', 'fifo'] as const)(
  'auto-tier-hardening 验收 15: real readText rejects a %s without waiting for a writer',
  async (kind) => {
    const path = join(await fixture(), kind)
    if (kind === 'directory') await mkdir(path)
    else execFileSync('/usr/bin/mkfifo', [path], { timeout: 1000 })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        fs.readText(path, 64).then(
          () => 'read',
          () => 'rejected',
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('hung'), 1000)
        }),
      ])
      expect(result).toBe('rejected')
    } finally {
      clearTimeout(timer)
    }
  },
)

it('auto-tier-hardening 验收 15: real readText reports permission denied', async () => {
  const path = join(await fixture(), 'private-config')
  await writeFile(path, '[core]\n')
  await chmod(path, 0)
  try {
    await expect(fs.readText(path, 64)).rejects.toMatchObject({ code: 'EACCES' })
  } finally {
    await chmod(path, 0o600)
  }
})
