/**
 * "Is this path in the workspace?" (spec 02 §「在不在工作区里」; plan step 11, 旧 51, 旧 160, 02 不变量
 * 21), on the memory host, which can hold links. The same algorithm on the real disk — macOS's /tmp
 * link, a name typed in the wrong case — is apps/desktop/test/workspace-locate.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { absolutePath, createMemoryHost } from '../../src/index.js'
import type { AbsolutePath, HostFs } from '../../src/index.js'
import { isWithin, normalizePath } from '../../src/host/path.js'
import { pathScopeOf } from '../../src/loop/batch.js'
import { locatePath, resolvePath } from '../../src/permission/workspace.js'
import type { PathScope } from '../../src/permission/workspace.js'
import { withVolfs } from '../support/volfs.js'

const p = (path: string): AbsolutePath => absolutePath(path)

describe('normalizePath', () => {
  it('drops . and resolves .., stopping at the root', () => {
    expect(normalizePath(p('/a/./b/../c'))).toBe('/a/c')
    expect(normalizePath(p('/a/../../..'))).toBe('/')
    expect(normalizePath(p('/a//b/'))).toBe('/a/b')
  })

  it('keeps a drive and a UNC share as roots', () => {
    expect(normalizePath(p('C:\\a\\..\\b'))).toBe('C:\\b')
    expect(normalizePath(p('C:/a/./b'))).toBe('C:/a/b')
    expect(normalizePath(p('C:\\..\\..'))).toBe('C:\\')
    expect(normalizePath(p('\\\\server\\share\\a\\..\\..\\b'))).toBe('\\\\server\\share\\b')
  })
})

describe('isWithin', () => {
  it('compares by segments, so /a/ws does not contain /a/ws2', () => {
    expect(isWithin(p('/a/ws/x'), p('/a/ws'))).toBe(true)
    expect(isWithin(p('/a/ws'), p('/a/ws'))).toBe(true)
    expect(isWithin(p('/a/ws2/x'), p('/a/ws'))).toBe(false)
    expect(isWithin(p('/anything'), p('/'))).toBe(true)
  })
})

/** A memory host with a workspace, a profile directory and a link or two. */
async function world(): Promise<{
  fs: HostFs
  scope: PathScope
  host: ReturnType<typeof createMemoryHost>
}> {
  const host = createMemoryHost()
  await host.fs.mkdirp(p('/ws/src'))
  await host.fs.writeFile(p('/ws/src/a.ts'), 'a')
  await host.fs.mkdirp(p('/profile/tool-output/s1'))
  await host.fs.mkdirp(p('/profile/tool-output/s2'))
  await host.fs.writeFile(p('/profile/config.json'), '{}')
  await host.fs.mkdirp(p('/home'))
  await host.fs.writeFile(p('/home/.zshrc'), '')
  await host.fs.mkdirp(p('/outside'))
  await host.fs.writeFile(p('/outside/secret'), 's')
  const scope: PathScope = {
    roots: [p('/ws')],
    profileDir: p('/profile'),
    ownSpillDir: p('/profile/tool-output/s1'),
    protectedFiles: [p('/home/.zshrc')],
  }
  return { fs: host.fs, scope, host }
}

describe('locatePath', () => {
  it('places the workspace, the session’s own spill, the protected list and the rest', async () => {
    const { fs, scope } = await world()
    expect(await locatePath(fs, p('/ws/src/a.ts'), scope)).toEqual({
      real: '/ws/src/a.ts',
      place: 'workspace',
    })
    expect(await locatePath(fs, p('/profile/tool-output/s1/out.txt'), scope)).toEqual({
      real: '/profile/tool-output/s1/out.txt',
      place: 'own-spill',
    })
    expect((await locatePath(fs, p('/profile/tool-output/s2/out.txt'), scope)).place).toBe(
      'protected',
    )
    expect((await locatePath(fs, p('/profile/config.json'), scope)).place).toBe('protected')
    expect((await locatePath(fs, p('/home/.zshrc'), scope)).place).toBe('protected')
    expect((await locatePath(fs, p('/outside/secret'), scope)).place).toBe('outside')
  })

  it('keeps the protected list protected when a chosen folder contains it (D2, D11)', async () => {
    const { fs, scope } = await world()
    const wide = { ...scope, roots: [p('/')] }
    expect((await locatePath(fs, p('/profile/config.json'), wide)).place).toBe('protected')
    expect((await locatePath(fs, p('/home/.zshrc'), wide)).place).toBe('protected')
    // …and the escape through `..` from the spill directory is caught: normalised first.
    expect(
      (await locatePath(fs, p('/profile/tool-output/s1/../../config.json'), scope)).place,
    ).toBe('protected')
  })

  it('compares the protected list without regard to case: a missing shell file in another case is protected', async () => {
    const { fs, scope } = await world()
    // ~/.zprofile does not exist: its name keeps the model's spelling (step 2), and on APFS a write
    // of `.ZPROFILE` creates `.zprofile`.
    const listed = { ...scope, roots: [p('/')], protectedFiles: [p('/home/.zprofile')] }
    for (const spelling of ['.ZPROFILE', '.zProfile', '.zpro\uFB01le']) {
      // oxlint-disable-next-line no-await-in-loop -- one path at a time
      expect(await locatePath(fs, p(`/home/${spelling}`), listed)).toEqual({
        real: `/home/${spelling}`,
        place: 'protected',
      })
    }
    // The letters APFS folds onto ASCII ones fold here too: ſ onto s, the Kelvin sign onto k.
    expect((await locatePath(fs, p('/home/.z\u017Fhrc'), scope)).place).toBe('protected')
    expect((await locatePath(fs, p('/HOME/.ZSHRC'), { ...scope, roots: [p('/')] })).place).toBe(
      'protected',
    )
    // Only the listed names: another file beside them is not.
    expect((await locatePath(fs, p('/home/.zprofile.bak'), listed)).place).toBe('workspace')
    expect((await locatePath(fs, p('/home/.zshrc2'), scope)).place).toBe('outside')
  })

  it('folds the protected list too: an entry in mixed case, as macOS’s /Users/<name> is, still protects', async () => {
    const { fs, host, scope } = await world()
    await host.fs.mkdirp(p('/Users/U'))
    await host.fs.writeFile(p('/Users/U/.zshrc'), '')
    const listed = { ...scope, roots: [p('/')], protectedFiles: [p('/Users/U/.zshrc')] }
    // The exact spelling, and one in another case (missing on this case-sensitive host).
    for (const path of ['/Users/U/.zshrc', '/Users/U/.ZSHRC']) {
      // oxlint-disable-next-line no-await-in-loop -- one path at a time
      expect(await locatePath(fs, p(path), listed)).toEqual({ real: path, place: 'protected' })
    }
  })

  it('places new files and new nested folders inside the workspace, keeping what the model wrote', async () => {
    const { fs, scope } = await world()
    expect(await locatePath(fs, p('/ws/new/deeper/file.txt'), scope)).toEqual({
      real: '/ws/new/deeper/file.txt',
      place: 'workspace',
    })
    expect(await locatePath(fs, p('/ws/src/../src/./b.ts'), scope)).toEqual({
      real: '/ws/src/b.ts',
      place: 'workspace',
    })
  })

  it('follows links: a link out of the workspace is outside, a link to the protected list is protected', async () => {
    const { fs, scope, host } = await world()
    host.symlink(p('/ws/escape'), '/outside')
    host.symlink(p('/ws/rc'), '/home/.zshrc')
    expect(await locatePath(fs, p('/ws/escape/secret'), scope)).toEqual({
      real: '/outside/secret',
      place: 'outside',
    })
    expect(await locatePath(fs, p('/ws/escape/new.txt'), scope)).toEqual({
      real: '/outside/new.txt',
      place: 'outside',
    })
    expect(await locatePath(fs, p('/ws/rc'), scope)).toEqual({
      real: '/home/.zshrc',
      place: 'protected',
    })
  })

  it('reads a dangling link, a loop or a missing root as outside, keeping the normalised path (旧 160)', async () => {
    const { fs, scope, host } = await world()
    host.symlink(p('/ws/dangling'), '/nowhere/at/all')
    host.symlink(p('/ws/loop-a'), '/ws/loop-b')
    host.symlink(p('/ws/loop-b'), '/ws/loop-a')
    expect(await locatePath(fs, p('/ws/dangling'), scope)).toEqual({
      real: '/ws/dangling',
      place: 'outside',
    })
    expect(await locatePath(fs, p('/ws/./loop-a/x'), scope)).toEqual({
      real: '/ws/loop-a/x',
      place: 'outside',
    })
    expect(await locatePath(fs, p('D:\\nothing\\here'), scope)).toEqual({
      real: 'D:\\nothing\\here',
      place: 'outside',
    })
    // A host that answers null all the way up to the root (the desktop host on a drive that is not
    // there): unresolved, and outside even under a root the scope names.
    const absent = { realpath: () => Promise.resolve(null) } as unknown as HostFs
    expect(await resolvePath(absent, p('/ws/src/a.ts'))).toEqual({
      path: '/ws/src/a.ts',
      resolved: false,
    })
    expect(await locatePath(absent, p('/ws/src/a.ts'), scope)).toEqual({
      real: '/ws/src/a.ts',
      place: 'outside',
    })
  })

  it('resolves roots the same way, so a workspace under a link is not everything-outside (D8)', async () => {
    const { fs, scope, host } = await world()
    await host.fs.mkdirp(p('/private/tmp/ws2'))
    host.symlink(p('/tmp'), '/private/tmp')
    const root = await resolvePath(fs, p('/tmp/ws2'))
    expect(root).toEqual({ path: '/private/tmp/ws2', resolved: true })
    const underLink = { ...scope, roots: [root.path] }
    expect((await locatePath(fs, p('/tmp/ws2/file.txt'), underLink)).place).toBe('workspace')
    // A dedicated folder that does not exist yet resolves through its nearest parent.
    expect(await resolvePath(fs, p('/tmp/not-yet/ws'))).toEqual({
      path: '/private/tmp/not-yet/ws',
      resolved: true,
    })
  })
})

describe('the scope a Run judges from (step 4)', () => {
  const SID = '0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f'

  it('resolves the profile, and takes the own spill under it as written: a profile under a link still reads its spill', async () => {
    const host = createMemoryHost({
      identity: { userId: 'u', tenantId: 't', profileDir: '/tmp/prof' },
    })
    await host.fs.mkdirp(p('/private/tmp/prof'))
    host.symlink(p('/tmp'), '/private/tmp')
    const scope = await pathScopeOf({ host, sessionId: SID, protectedFiles: [] }, null)
    expect(scope).toMatchObject({
      profileDir: '/private/tmp/prof',
      ownSpillDir: `/private/tmp/prof/tool-output/${SID}`,
    })
    // The note names the file through the profile's link; the folder is not there yet.
    const note = p(`/tmp/prof/tool-output/${SID}/r-1-0.txt`)
    expect((await locatePath(host.fs, note, scope)).place).toBe('own-spill')
  })

  it.each([
    ['tool-output/<id>', `/prof/tool-output/${SID}`, '/', 'prof/config.json', 'protected'],
    ['tool-output', '/prof/tool-output', '/outside', 'x.txt', 'outside'],
  ] as const)(
    'never follows a link planted at %s: what it leads to is placed as itself',
    async (_at, link, target, rest, place) => {
      const host = createMemoryHost({
        identity: { userId: 'u', tenantId: 't', profileDir: '/prof' },
      })
      await host.fs.mkdirp(p(link.slice(0, link.lastIndexOf('/'))))
      await host.fs.writeFile(p('/prof/config.json'), '{}')
      await host.fs.mkdirp(p(`/outside/${SID}`))
      host.symlink(p(link), target)
      const scope = await pathScopeOf({ host, sessionId: SID, protectedFiles: [] }, null)
      expect(scope.ownSpillDir).toBe(`/prof/tool-output/${SID}`)
      const through = p(`/prof/tool-output/${SID}/${rest}`)
      expect((await locatePath(host.fs, through, scope)).place).toBe(place)
    },
  )
})

describe('a path the host finds but cannot name (owner 2026-09-27, s11-safety-2)', () => {
  // macOS's /.vol/<dev>/<ino> reaches any file by inode, and realpath(3) cannot name it: nothing can be
  // compared, so it is blocked like the protected list — never outside with a card to allow it.
  it('places the volfs name of a workspace file, the shell file and the profile config as protected', async () => {
    const { fs: memory, scope } = await world()
    const fs = withVolfs(memory, {
      '10': '/ws',
      '11': '/ws/src/a.ts',
      '12': '/home/.zshrc',
      '13': '/profile/config.json',
    })
    for (const n of ['11', '12', '13']) {
      // oxlint-disable-next-line no-await-in-loop -- one path at a time
      expect(await locatePath(fs, p(`/.vol/1/${n}`), scope)).toEqual({
        real: `/.vol/1/${n}`,
        place: 'protected',
      })
    }
    // A new file under a folder's volfs name: the walk up meets the name it cannot resolve.
    expect(await locatePath(fs, p('/.vol/1/10/new.txt'), scope)).toEqual({
      real: '/.vol/1/10/new.txt',
      place: 'protected',
    })
    // A chosen folder that contains everything does not release it.
    expect((await locatePath(fs, p('/.vol/1/11'), { ...scope, roots: [p('/')] })).place).toBe(
      'protected',
    )
    expect(await resolvePath(fs, p('/.vol/1/11'))).toEqual({
      path: '/.vol/1/11',
      resolved: false,
      alias: true,
    })
  })

  it('keeps a missing path and a dangling link where they were', async () => {
    const { fs: memory, scope, host } = await world()
    host.symlink(p('/ws/dangling'), '/nowhere/at/all')
    const fs = withVolfs(memory, { '11': '/ws/src/a.ts' })
    expect(await locatePath(fs, p('/outside/missing.txt'), scope)).toEqual({
      real: '/outside/missing.txt',
      place: 'outside',
    })
    expect(await locatePath(fs, p('/ws/dangling'), scope)).toEqual({
      real: '/ws/dangling',
      place: 'outside',
    })
    // A volfs number nothing has is a missing path too.
    expect((await locatePath(fs, p('/.vol/1/99'), scope)).place).toBe('outside')
  })
})
