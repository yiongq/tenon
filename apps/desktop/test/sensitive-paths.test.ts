/** Spec 05 step 5: real hardlinks and symlinks under disposable HOME/workspace only. */
import { mkdir, mkdtemp, realpath, rm, writeFile, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absolutePath, locatePath } from '@tenon-app/kernel'
import type { AbsolutePath, PathScope } from '@tenon-app/kernel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopFs } from '../src/main/host/fs.js'
import { desktopSensitivePaths } from '../src/main/host/sensitive-paths.js'
import { credentialPaths, protectionList } from '../src/main/host/sandbox-config.js'
import { protectedShellFiles } from '../src/main/workspace.js'

let root: string
let home: AbsolutePath
let workspace: AbsolutePath
const fs = new DesktopFs()
const p = absolutePath
async function scope(): Promise<PathScope> {
  return {
    roots: [home, workspace],
    profileDir: p(join(root, 'profile')),
    ownSpillDir: p(join(root, 'profile/tool-output/session')),
    protectedFiles: protectedShellFiles(home, p(join(root, 'zdot'))),
    sensitive: await desktopSensitivePaths(home, [home, workspace], p(join(root, 'zdot'))),
  }
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'tenon-sensitive-')))
  home = p(join(root, 'home'))
  workspace = p(join(home, 'project'))
  await mkdir(workspace, { recursive: true })
  await mkdir(join(root, 'zdot'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('05 shared protection on real disk', () => {
  it('05 验收 26、28: every shared credential asks for reads even under a home workspace', async () => {
    const paths = [
      join(home, '.ssh'),
      join(home, '.aws'),
      join(home, '.gnupg'),
      ...credentialPaths(process.platform === 'darwin' ? 'darwin' : 'linux', home),
      join(workspace, '.aws'),
    ]
    const current = await scope()
    for (const path of paths) {
      // oxlint-disable-next-line no-await-in-loop -- all names from the live shared list are checked
      expect(await locatePath(fs, p(join(path, 'credential')), current, 'Read')).toMatchObject({
        place: 'outside',
        sensitive: 'credential',
      })
    }
  })

  it.each(['Write', 'Edit', 'Delete'] as const)(
    '05 验收 27、28、52: %s recognizes every shared auto-run name at arbitrary depth and folded case',
    async (tool) => {
      const current = await scope()
      const list = protectionList({ home, zdotdir: null, credentials: [] })
      for (const name of list.autoRunNames) {
        // Missing .git pointers are included; partial segment matches must not count.
        // oxlint-disable-next-line no-await-in-loop -- each shared deny name must retain this boundary
        const located = await locatePath(
          fs,
          p(join(workspace, 'one/two', name.toUpperCase())),
          current,
          tool,
        )
        expect(located).toMatchObject({ place: 'outside', sensitive: 'auto-run' })
      }
      expect(await locatePath(fs, p(join(workspace, '.gitignore')), current, tool)).toMatchObject({
        place: 'workspace',
      })
      expect(
        await locatePath(fs, p(join(workspace, '.vscode-other/tasks.json')), current, tool),
      ).toMatchObject({ place: 'workspace' })
    },
  )

  it.each(['Read', 'Glob', 'Grep'] as const)(
    '05 验收 25、27: %s leaves auto-run names and real hardlinks as workspace reads',
    async (tool) => {
      await writeFile(join(workspace, 'a'), 'bytes')
      await link(join(workspace, 'a'), join(workspace, 'b'))
      const current = await scope()
      expect(await locatePath(fs, p(join(workspace, 'a')), current, tool)).toEqual({
        real: join(workspace, 'a'),
        place: 'workspace',
      })
      expect(await locatePath(fs, p(join(workspace, '.envrc')), current, tool)).toEqual({
        real: join(workspace, '.envrc'),
        place: 'workspace',
      })
    },
  )

  it.each(['Write', 'Edit', 'Delete'] as const)(
    '05 验收 25: %s marks real ordinary hardlinks but not directory link counts',
    async (tool) => {
      await writeFile(join(workspace, 'a'), 'bytes')
      await link(join(workspace, 'a'), join(workspace, 'b'))
      await mkdir(join(workspace, 'directory/child'), { recursive: true })
      const current = await scope()
      expect(await locatePath(fs, p(join(workspace, 'a')), current, tool)).toMatchObject({
        place: 'outside',
        sensitive: 'hardlink',
      })
      expect(await locatePath(fs, p(join(workspace, 'directory')), current, tool)).toMatchObject({
        place: 'workspace',
      })
    },
  )

  it('05 验收 27、55: written .git pointers and intermediate auto-run links remain sensitive', async () => {
    await mkdir(join(workspace, 'deep/agent-conf'), { recursive: true })
    await symlink('agent-conf', join(workspace, 'deep/middle'))
    await symlink('middle', join(workspace, 'deep/.claude'))
    await writeFile(join(workspace, '.git'), 'gitdir: somewhere')
    const current = await scope()
    expect(
      await locatePath(fs, p(join(workspace, 'deep/agent-conf/settings.json')), current, 'Write'),
    ).toMatchObject({ sensitive: 'auto-run' })
    expect(
      await locatePath(fs, p(join(workspace, 'deep/.claude/settings.json')), current, 'Edit'),
    ).toMatchObject({ sensitive: 'auto-run' })
    expect(await locatePath(fs, p(join(workspace, '.git')), current, 'Delete')).toMatchObject({
      sensitive: 'auto-run',
    })
  })

  it('05 验收 26、55: intermediate credential links protect direct targets and refresh after replacement', async () => {
    await mkdir(join(home, 'config-a/gh'), { recursive: true })
    await mkdir(join(home, 'config-b/gh'), { recursive: true })
    await symlink('config-a', join(home, 'middle'))
    await symlink('middle', join(home, '.config'))
    const before = await scope()
    expect(await locatePath(fs, p(join(home, 'config-a/gh/token')), before, 'Read')).toMatchObject({
      sensitive: 'credential',
    })
    await rm(join(home, 'middle'))
    await symlink('config-b', join(home, 'middle'))
    const after = await scope()
    expect(await locatePath(fs, p(join(home, 'config-b/gh/token')), after, 'Read')).toMatchObject({
      sensitive: 'credential',
    })
    expect(await locatePath(fs, p(join(home, 'config-a/gh/token')), after, 'Read')).toEqual({
      real: join(home, 'config-a/gh/token'),
      place: 'workspace',
    })
  })

  it('05 验收 28: ZDOTDIR shell files remain protected, while other workspace shell names ask', async () => {
    const current = await scope()
    expect(await locatePath(fs, p(join(root, 'zdot/.ZSHRC')), current, 'Write')).toMatchObject({
      place: 'protected',
    })
    expect(
      await locatePath(fs, p(join(workspace, 'nested/.ZSHRC')), current, 'Write'),
    ).toMatchObject({ sensitive: 'auto-run' })
  })

  it('05 验收 25、55: deleting a plain leaf symlink does not inspect its hardlinked target', async () => {
    await writeFile(join(workspace, 'a'), 'bytes')
    await link(join(workspace, 'a'), join(workspace, 'b'))
    await symlink('a', join(workspace, 'leaf'))
    expect(await locatePath(fs, p(join(workspace, 'leaf')), await scope(), 'Delete')).toEqual({
      real: join(workspace, 'leaf'),
      place: 'workspace',
    })
  })
})

it.skipIf(process.platform === 'win32')(
  '05 验收 28、52: sensitive names and hardlinks never release the own-spill write prohibition',
  async () => {
    const current = await scope()
    await mkdir(current.ownSpillDir, { recursive: true })
    await writeFile(join(current.ownSpillDir, 'a'), 'a')
    await link(join(current.ownSpillDir, 'a'), join(current.ownSpillDir, 'b'))
    const wide = { ...current, roots: [p(root)] }
    for (const tool of ['Write', 'Edit', 'Delete'] as const) {
      for (const name of ['a', '.envrc']) {
        // oxlint-disable-next-line no-await-in-loop -- own-spill is read-only even when another rule asks
        const result = await locatePath(fs, p(join(current.ownSpillDir, name)), wide, tool)
        expect(result).toMatchObject({ place: 'own-spill' })
        expect(result.sensitive).toBeUndefined()
      }
    }
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 55: ordinary directory links expose nested sensitive aliases in the target table',
  async () => {
    await mkdir(join(root, 'outside'))
    await mkdir(join(workspace, 'agent-conf'))
    await symlink(join(root, 'outside'), join(workspace, 'bridge'))
    await symlink(join(workspace, 'agent-conf'), join(root, 'outside', '.claude'))
    expect(
      await locatePath(fs, p(join(workspace, 'agent-conf/settings.json')), await scope(), 'Write'),
    ).toMatchObject({ sensitive: 'auto-run' })
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 25、55: ordinary single-name files stay local and aliases compare written OR real paths',
  async () => {
    await mkdir(join(home, '.ssh'))
    await writeFile(join(home, '.ssh/key'), 'fixture')
    await writeFile(join(workspace, '.envrc'), 'fixture')
    await writeFile(join(workspace, 'ordinary'), 'ordinary')
    await symlink(join(home, '.ssh/key'), join(workspace, 'alias-key'))
    await symlink('.envrc', join(workspace, 'alias-auto'))
    const current = await scope()
    expect(await locatePath(fs, p(join(workspace, 'ordinary')), current, 'Write')).toEqual({
      real: join(workspace, 'ordinary'),
      place: 'workspace',
    })
    expect(await locatePath(fs, p(join(workspace, 'alias-key')), current, 'Read')).toMatchObject({
      sensitive: 'credential',
    })
    expect(await locatePath(fs, p(join(workspace, 'alias-auto')), current, 'Write')).toMatchObject({
      sensitive: 'auto-run',
    })
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 55: differently cased sensitive aliases protect direct final targets on either volume case mode',
  async () => {
    await mkdir(join(workspace, 'editor-config'))
    await mkdir(join(home, 'keys'))
    await symlink('editor-config', join(workspace, '.VSCODE'))
    await symlink('keys', join(home, '.SSH'))
    const current = await scope()
    expect(
      await locatePath(fs, p(join(workspace, 'editor-config/tasks.json')), current, 'Write'),
    ).toMatchObject({ sensitive: 'auto-run' })
    expect(await locatePath(fs, p(join(home, 'keys/key')), current, 'Read')).toMatchObject({
      sensitive: 'credential',
    })
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 55: a profile table refresh picks up replaced links without rescanning on each lookup',
  async () => {
    const { createSensitivePathProvider } = await import('../src/main/host/sensitive-paths.js')
    await mkdir(join(home, 'first/gh'), { recursive: true })
    await mkdir(join(home, 'second/gh'), { recursive: true })
    await symlink('first', join(home, '.config'))
    const provider = createSensitivePathProvider(home)
    const before = await provider.get([home])
    expect(await provider.get([home])).toBe(before)
    await rm(join(home, '.config'))
    await symlink('second', join(home, '.config'))
    const after = await provider.refresh([home])
    expect(after.linkTargets).toContainEqual({
      real: join(home, 'second/gh'),
      category: 'credential',
    })
    expect(await provider.get([home])).toBe(after)
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 55: external alias scans stop at their budget and never publish a partial protection table',
  async () => {
    const { createSensitivePathProvider } = await import('../src/main/host/sensitive-paths.js')
    await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), join(workspace, 'bridge'))
    await mkdir(join(root, 'outside/deep'))
    const provider = createSensitivePathProvider(home, null, { maxEntries: 1 })
    await expect(provider.refresh([workspace])).rejects.toThrow(/sensitive path scan/)
    await expect(provider.get([workspace])).rejects.toThrow(/sensitive path scan/)
    await expect(
      desktopSensitivePaths(home, [workspace], null, undefined, { timeoutMs: 0 }),
    ).rejects.toThrow(/sensitive path scan/)
    const controller = new AbortController()
    controller.abort()
    await expect(
      desktopSensitivePaths(home, [workspace], null, undefined, { signal: controller.signal }),
    ).rejects.toThrow(/sensitive path scan/)
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 55: ordinary directory backlinks finish while retaining nested sensitive targets',
  async () => {
    await mkdir(join(root, 'outside'))
    await mkdir(join(workspace, 'agent-conf'))
    await symlink(join(root, 'outside'), join(workspace, 'bridge'))
    await symlink(workspace, join(root, 'outside/back'))
    await symlink(join(workspace, 'agent-conf'), join(root, 'outside/.claude'))
    expect(
      await locatePath(fs, p(join(workspace, 'agent-conf/settings.json')), await scope(), 'Write'),
    ).toMatchObject({ sensitive: 'auto-run' })
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 55: a pending metadata scan can be cancelled or timed out without waiting for the filesystem',
  async () => {
    const controller = new AbortController()
    const cancelled = desktopSensitivePaths(home, [workspace], null, undefined, {
      signal: controller.signal,
    })
    controller.abort()
    await expect(cancelled).rejects.toThrow(/sensitive path scan/)
    vi.useFakeTimers()
    try {
      const pending = desktopSensitivePaths(home, [workspace])
      vi.advanceTimersByTime(5000)
      await expect(pending).rejects.toThrow(/sensitive path scan/)
    } finally {
      vi.useRealTimers()
    }
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 26、28: the shared credential table contains the literal home and workspace entries',
  async () => {
    const current = await desktopSensitivePaths(home, [workspace])
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
    expect(current.credential).toEqual([
      ...protectionList({ home, zdotdir: null, credentials: credentialPaths(platform, home) })
        .credential,
      p(join(workspace, '.aws')),
    ])
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 28、55: home automatic startup aliases protect direct external targets',
  async () => {
    await mkdir(join(home, '.config'))
    await mkdir(join(root, 'startup'))
    await symlink(join(root, 'startup'), join(home, '.config/autostart'))
    expect(
      await locatePath(fs, p(join(root, 'startup/task.desktop')), await scope(), 'Write'),
    ).toMatchObject({
      sensitive: 'auto-run',
    })
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 26、55: discovery skips a credential directory through both its name and an ordinary alias',
  async () => {
    await mkdir(join(root, 'keys'))
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => writeFile(join(root, 'keys', `key-${i}`), 'fixture')),
    )
    await symlink(join(root, 'keys'), join(home, '.ssh'))
    await symlink(join(root, 'keys'), join(workspace, 'ordinary-alias'))
    const table = await desktopSensitivePaths(home, [workspace], null, undefined, { maxEntries: 3 })
    expect(table.linkTargets).toContainEqual({ real: join(root, 'keys'), category: 'credential' })
    const current = { ...(await scope()), sensitive: table }
    expect(await locatePath(fs, p(join(root, 'keys/key-0')), current, 'Read')).toMatchObject({
      sensitive: 'credential',
    })
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 55: removed roots, cyclic sensitive aliases and dangling ordinary links do not hide other protection targets',
  async () => {
    await symlink('.ssh', join(home, '.ssh'))
    await symlink('.claude', join(workspace, '.claude'))
    await symlink('missing-directory', join(workspace, 'dangling'))
    await mkdir(join(workspace, 'editor'))
    await symlink('editor', join(workspace, '.vscode'))
    const removed = p(join(root, 'removed'))
    await mkdir(removed)
    await rm(removed, { recursive: true })
    const current = {
      ...(await scope()),
      sensitive: await desktopSensitivePaths(home, [removed, home, workspace]),
    }
    expect(current.sensitive?.linkTargets).toContainEqual({
      real: join(workspace, 'editor'),
      category: 'auto-run',
    })
    expect(await locatePath(fs, p(join(home, '.ssh/key')), current, 'Read')).toMatchObject({
      sensitive: 'credential',
    })
    expect(
      await locatePath(fs, p(join(workspace, '.claude/settings.json')), current, 'Write'),
    ).toMatchObject({ sensitive: 'auto-run' })
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 55: a successful refresh after a budget failure replaces the failed protection table',
  async () => {
    const { createSensitivePathProvider } = await import('../src/main/host/sensitive-paths.js')
    const files = Array.from({ length: 3 }, (_, index) => join(workspace, `ordinary-${index}`))
    await Promise.all(files.map((file) => writeFile(file, 'fixture')))
    const provider = createSensitivePathProvider(home, null, { maxEntries: 2 })
    await expect(provider.refresh([workspace])).rejects.toThrow(/entry budget/)
    await Promise.all(files.map((file) => rm(file)))
    const recovered = await provider.refresh([workspace])
    expect(await provider.get([workspace])).toBe(recovered)
  },
)

it.skipIf(process.platform === 'win32')(
  '05 验收 26、28、55: a workspace AWS alias keeps credential priority over its automatic-name entry',
  async () => {
    await mkdir(join(root, 'keys'))
    await writeFile(join(root, 'keys/key'), 'fixture')
    await symlink(join(root, 'keys'), join(workspace, '.aws'))
    expect(await locatePath(fs, p(join(root, 'keys/key')), await scope(), 'Read')).toMatchObject({
      sensitive: 'credential',
    })
  },
)
