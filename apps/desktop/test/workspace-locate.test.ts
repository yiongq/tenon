/**
 * "Is this path in the workspace?" on the real disk (spec 02 §「在不在工作区里」 steps 3–4; plan step 11,
 * 旧 51, 旧 160): macOS hands out temporary folders under the /var → /private/var link, so a root has to
 * be stored resolved; a name typed in the wrong case resolves to the disk's spelling on a
 * case-insensitive volume; a link out of the workspace is outside.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absolutePath, locatePath, resolvePath } from '@tenon-app/kernel'
import type { AbsolutePath, PathScope } from '@tenon-app/kernel'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DesktopFs } from '../src/main/host/fs.js'

describe('locatePath on the desktop disk', () => {
  const fs = new DesktopFs()
  let raw = '' // as the OS handed it out, possibly under a link
  let scope: PathScope
  const at = (relative: string): AbsolutePath => absolutePath(join(raw, relative))

  beforeEach(async () => {
    raw = await mkdtemp(join(tmpdir(), 'tenon-locate-'))
    await mkdir(join(raw, 'ws', 'src'), { recursive: true })
    await writeFile(join(raw, 'ws', 'src', 'Main.ts'), 'x')
    await mkdir(join(raw, 'outside'))
    await writeFile(join(raw, 'outside', 'secret'), 's')
    await mkdir(join(raw, 'profile', 'tool-output', 's1'), { recursive: true })
    const resolved = async (relative: string): Promise<AbsolutePath> =>
      (await resolvePath(fs, at(relative))).path
    scope = {
      roots: [await resolved('ws')],
      profileDir: await resolved('profile'),
      ownSpillDir: await resolved('profile/tool-output/s1'),
      protectedFiles: [],
    }
  })
  afterEach(async () => {
    await rm(raw, { recursive: true, force: true })
  })

  it('stores a root resolved, so paths spelled through the temp-dir link are still inside', async () => {
    const real = await realpath(join(raw, 'ws'))
    expect(scope.roots[0]).toBe(real)
    expect(await locatePath(fs, at('ws/src/Main.ts'), scope)).toEqual({
      real: join(real, 'src', 'Main.ts'),
      place: 'workspace',
    })
    expect((await locatePath(fs, at('ws/new/dir/file.txt'), scope)).place).toBe('workspace')
    expect((await locatePath(fs, at('profile/tool-output/s1/out.txt'), scope)).place).toBe(
      'own-spill',
    )
    expect((await locatePath(fs, at('profile/other.json'), scope)).place).toBe('protected')
  })

  it('follows a link out of the workspace to outside', async () => {
    await symlink(join(raw, 'outside'), join(raw, 'ws', 'escape'))
    const verdict = await locatePath(fs, at('ws/escape/secret'), scope)
    expect(verdict).toEqual({
      real: await realpath(join(raw, 'outside', 'secret')),
      place: 'outside',
    })
  })

  it('resolves a wrong-case name to the disk’s spelling on a case-insensitive volume', async () => {
    const insensitive = await realpath(join(raw, 'ws', 'src', 'MAIN.TS')).then(
      () => true,
      () => false,
    )
    const verdict = await locatePath(fs, at('ws/src/MAIN.TS'), scope)
    // The recorded result for this machine (APFS, 2026-09-26): the disk's own spelling comes back; a
    // case-sensitive volume keeps the name as typed, a new file inside the workspace.
    const spelling = insensitive ? 'Main.ts' : 'MAIN.TS'
    expect(verdict).toEqual({
      real: join(scope.roots[0] ?? '', 'src', spelling),
      place: 'workspace',
    })
  })
})
