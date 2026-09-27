/**
 * Write and Edit (spec 02 §内置工具与参数「Write」「Edit」「执行期失败」; plan step 22): the executors,
 * on the memory host. Write replaces the whole file and makes a missing parent first; Edit replaces
 * `old_string` only when it occurs exactly once, or every occurrence with `replace_all`. What is
 * missing, a folder, not found or not unique is a call that ran: is_error, `completed`, fixed English.
 * Both act on the real path the decision placed, never `file_path` as the model wrote it, and refuse
 * that path when a link now leads from it elsewhere or nowhere (§「在不在工作区里」第 5 步).
 */
import { describe, expect, it } from 'vitest'
import { absolutePath, createMemoryHost } from '../../src/index.js'
import type { MemoryHost } from '../../src/index.js'
import { locatePath } from '../../src/permission/workspace.js'
import type { PathScope } from '../../src/permission/workspace.js'
import { fill } from '../../src/prompts/index.js'
import { EDIT_TEXTS, editExecutor } from '../../src/tools/builtin/edit.js'
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.js'
import { WRITE_TEXTS, writeExecutor } from '../../src/tools/builtin/write.js'
import type { ToolExecution, ToolExecutor } from '../../src/tools/executor.js'
import { BUILTIN_SERVER_ID } from '../../src/tools/registry.js'

const WS = absolutePath('/ws')
const SCOPE: PathScope = {
  roots: [WS],
  profileDir: absolutePath('/tenon/prof'),
  ownSpillDir: absolutePath('/tenon/prof/tool-output/s1'),
  protectedFiles: [absolutePath('/home/.zshrc'), absolutePath('/home/.zshenv')],
}

async function hostWith(files: Record<string, string | Uint8Array>): Promise<MemoryHost> {
  const host = createMemoryHost()
  await host.fs.mkdirp(WS)
  for (const [path, data] of Object.entries(files)) {
    const at = absolutePath(path)
    // oxlint-disable-next-line no-await-in-loop -- the folder before the file in it
    await host.fs.mkdirp(absolutePath(at.slice(0, at.lastIndexOf('/')) || '/'))
    // oxlint-disable-next-line no-await-in-loop -- one file at a time
    await host.fs.writeFile(at, data)
  }
  return host
}

/** Runs the executor on `target`, the decision's real path: by default `file_path` as given. */
function run(
  executor: ToolExecutor,
  host: MemoryHost,
  name: 'Write' | 'Edit',
  input: Record<string, unknown>,
  target = absolutePath(String(input['file_path'])),
): Promise<ToolExecution> {
  return executor({
    item: {
      source: 'builtin',
      serverId: BUILTIN_SERVER_ID,
      originalName: name,
      name,
      spec: BUILTIN_TOOLS[name].spec({ domainFilter: false }),
      requiresUserInteraction: false,
    },
    input,
    signal: new AbortController().signal,
    target,
    scope: SCOPE,
    fs: host.fs,
    clock: host.clock,
  })
}

async function textAt(host: MemoryHost, path: string): Promise<string> {
  return new TextDecoder().decode((await host.fs.readFile(absolutePath(path))) as Uint8Array)
}

function failure(text: string): ToolExecution {
  return { content: [{ type: 'text', text }], isError: true, state: 'completed' }
}

describe('Write', () => {
  it('creates a file, making its missing parent folders first', async () => {
    const host = await hostWith({})
    const path = '/ws/deep/er/notes.md'
    expect(await host.fs.stat(absolutePath('/ws/deep'))).toBeNull()
    expect(
      await run(writeExecutor, host, 'Write', { file_path: path, content: '# Notes\n' }),
    ).toEqual({
      content: [{ type: 'text', text: fill(WRITE_TEXTS.created, { path }) }],
      isError: false,
      state: 'completed',
    })
    expect(await host.fs.stat(absolutePath('/ws/deep/er'))).toMatchObject({ isDir: true })
    expect(await textAt(host, path)).toBe('# Notes\n')
  })

  it('replaces the whole content of a file that is there', async () => {
    const host = await hostWith({ '/ws/a.txt': 'a much longer first version\n' })
    const done = await run(writeExecutor, host, 'Write', { file_path: '/ws/a.txt', content: 'b' })
    expect(done).toEqual({
      content: [{ type: 'text', text: fill(WRITE_TEXTS.replaced, { path: '/ws/a.txt' }) }],
      isError: false,
      state: 'completed',
    })
    expect(await textAt(host, '/ws/a.txt')).toBe('b')
  })

  it('fails, having run, on a folder or under a file — and writes nothing', async () => {
    const host = await hostWith({ '/ws/sub/keep.txt': 'x', '/ws/plain': 'file' })
    expect(await run(writeExecutor, host, 'Write', { file_path: '/ws/sub', content: 'y' })).toEqual(
      failure(fill(WRITE_TEXTS.isDirectory, { path: '/ws/sub' })),
    )
    expect(await host.fs.stat(absolutePath('/ws/sub'))).toMatchObject({ isDir: true })
    expect(
      await run(writeExecutor, host, 'Write', { file_path: '/ws/plain/a.txt', content: 'y' }),
    ).toEqual(failure(fill(WRITE_TEXTS.notDirectory, { path: '/ws/plain' })))
    expect(await textAt(host, '/ws/plain')).toBe('file')
  })
})

describe('Edit', () => {
  const FILE = '/ws/app.ts'
  const SOURCE = 'const a = 1\nconst b = 1\nexport { a, b }\n'

  it('replaces old_string where it occurs exactly once', async () => {
    const host = await hostWith({ [FILE]: SOURCE })
    const done = await run(editExecutor, host, 'Edit', {
      file_path: FILE,
      old_string: 'const b = 1',
      new_string: 'const b = $&2',
    })
    expect(done).toEqual({
      content: [{ type: 'text', text: fill(EDIT_TEXTS.edited, { path: FILE }) }],
      isError: false,
      state: 'completed',
    })
    // new_string goes in as written: `$&` is not a replacement pattern.
    expect(await textAt(host, FILE)).toBe('const a = 1\nconst b = $&2\nexport { a, b }\n')
  })

  it('refuses an old_string that is not unique, unless replace_all, which replaces every one', async () => {
    const host = await hostWith({ [FILE]: SOURCE })
    const input = { file_path: FILE, old_string: '= 1', new_string: '= 2' }
    expect(await run(editExecutor, host, 'Edit', input)).toEqual(
      failure(fill(EDIT_TEXTS.notUnique, { path: FILE, count: '2' })),
    )
    expect(await textAt(host, FILE)).toBe(SOURCE)
    expect(await run(editExecutor, host, 'Edit', { ...input, replace_all: false })).toMatchObject({
      isError: true,
    })
    expect(await run(editExecutor, host, 'Edit', { ...input, replace_all: true })).toEqual({
      content: [{ type: 'text', text: fill(EDIT_TEXTS.editedAll, { path: FILE, count: '2' }) }],
      isError: false,
      state: 'completed',
    })
    expect(await textAt(host, FILE)).toBe('const a = 2\nconst b = 2\nexport { a, b }\n')
  })

  it('fails, having run, when old_string is not there, the file is missing or is a folder', async () => {
    const host = await hostWith({ [FILE]: SOURCE })
    const edit = (file_path: string): Promise<ToolExecution> =>
      run(editExecutor, host, 'Edit', { file_path, old_string: 'const c', new_string: 'const d' })
    expect(await edit(FILE)).toEqual(failure(fill(EDIT_TEXTS.noMatch, { path: FILE })))
    expect(await textAt(host, FILE)).toBe(SOURCE)
    expect(await edit('/ws/missing.ts')).toEqual(
      failure(fill(EDIT_TEXTS.notFound, { path: '/ws/missing.ts' })),
    )
    expect(await host.fs.stat(absolutePath('/ws/missing.ts'))).toBeNull()
    expect(await edit('/ws')).toEqual(failure(fill(EDIT_TEXTS.isDirectory, { path: '/ws' })))
  })

  it('refuses a file that is not valid UTF-8 rather than rewrite its other bytes, and keeps a BOM', async () => {
    const bad = new Uint8Array([0x61, 0x3d, 0x31, 0x0a, 0xff, 0xfe, 0x0a])
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a=1\n')])
    const host = await hostWith({ '/ws/bad.txt': bad, '/ws/bom.txt': bom })
    const input = { old_string: 'a=1', new_string: 'a=2' }
    expect(await run(editExecutor, host, 'Edit', { ...input, file_path: '/ws/bad.txt' })).toEqual(
      failure(fill(EDIT_TEXTS.notUtf8, { path: '/ws/bad.txt' })),
    )
    expect(await host.fs.readFile(absolutePath('/ws/bad.txt'))).toEqual(bad)
    expect(
      await run(editExecutor, host, 'Edit', { ...input, file_path: '/ws/bom.txt' }),
    ).toMatchObject({ isError: false })
    expect(await host.fs.readFile(absolutePath('/ws/bom.txt'))).toEqual(
      new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a=2\n')]),
    )
  })
})

describe('the path Write and Edit act on (§「在不在工作区里」第 5 步)', () => {
  it('is the decision’s real path, never file_path as the model wrote it', async () => {
    const host = await hostWith({ '/ws/real.txt': 'const a = 1\n' })
    const given = absolutePath('/ws/given.txt')
    const real = absolutePath('/ws/real.txt')
    expect(
      await run(
        editExecutor,
        host,
        'Edit',
        {
          file_path: given,
          old_string: 'a = 1',
          new_string: 'a = 2',
        },
        real,
      ),
    ).toEqual({
      content: [{ type: 'text', text: fill(EDIT_TEXTS.edited, { path: real }) }],
      isError: false,
      state: 'completed',
    })
    expect(await textAt(host, real)).toBe('const a = 2\n')
    expect(
      await run(writeExecutor, host, 'Write', { file_path: given, content: 'b' }, real),
    ).toEqual({
      content: [{ type: 'text', text: fill(WRITE_TEXTS.replaced, { path: real }) }],
      isError: false,
      state: 'completed',
    })
    expect(await textAt(host, real)).toBe('b')
    expect(await host.fs.stat(given)).toBeNull()
  })

  it('is refused, with nothing written, when a dangling link stands there (it would create the file it points at)', async () => {
    const host = await hostWith({})
    await host.fs.mkdirp(absolutePath('/home'))
    host.symlink(absolutePath('/ws/notes.md'), '/home/.zshenv')
    // Judged outside with its own path as real (step 2); an allow on its card reaches the executor.
    const judged = await locatePath(host.fs, absolutePath('/ws/notes.md'), SCOPE)
    expect(judged).toEqual({ real: '/ws/notes.md', place: 'outside' })
    const refused = failure(fill(WRITE_TEXTS.resolvesElsewhere, { path: judged.real }))
    expect(
      await run(writeExecutor, host, 'Write', { file_path: judged.real, content: 'x' }),
    ).toEqual(refused)
    expect(
      await run(editExecutor, host, 'Edit', {
        file_path: judged.real,
        old_string: 'a',
        new_string: 'b',
      }),
    ).toEqual(failure(fill(EDIT_TEXTS.resolvesElsewhere, { path: judged.real })))
    expect(await host.fs.stat(absolutePath('/home/.zshenv'))).toBeNull()
  })

  it('is refused when a link is made there after the judgement, at the file or at a folder above it', async () => {
    const host = await hostWith({ '/home/.zshrc': 'export A=1\n' })
    const file = await locatePath(host.fs, absolutePath('/ws/rc'), SCOPE)
    const nested = await locatePath(host.fs, absolutePath('/ws/sub/.zshenv'), SCOPE)
    expect([file.place, nested.place]).toEqual(['workspace', 'workspace'])
    host.symlink(absolutePath('/ws/rc'), '/home/.zshrc')
    host.symlink(absolutePath('/ws/sub'), '/home')
    expect(
      await run(editExecutor, host, 'Edit', {
        file_path: file.real,
        old_string: 'A=1',
        new_string: 'A=2',
      }),
    ).toEqual(failure(fill(EDIT_TEXTS.resolvesElsewhere, { path: file.real })))
    expect(await run(writeExecutor, host, 'Write', { file_path: file.real, content: 'x' })).toEqual(
      failure(fill(WRITE_TEXTS.resolvesElsewhere, { path: file.real })),
    )
    expect(await textAt(host, '/home/.zshrc')).toBe('export A=1\n')
    // The file is missing, and would be created where the folder now leads.
    expect(
      await run(writeExecutor, host, 'Write', { file_path: nested.real, content: 'x' }),
    ).toEqual(failure(fill(WRITE_TEXTS.resolvesElsewhere, { path: nested.real })))
    expect(await host.fs.stat(absolutePath('/home/.zshenv'))).toBeNull()
  })

  it('goes ahead on a path that still names itself: a file there, or one missing under the same folders', async () => {
    const host = await hostWith({ '/ws/a.txt': 'a' })
    host.symlink(absolutePath('/ws/link.txt'), '/ws/a.txt')
    const judged = await locatePath(host.fs, absolutePath('/ws/link.txt'), SCOPE)
    expect(judged.real).toBe('/ws/a.txt')
    expect(
      await run(
        writeExecutor,
        host,
        'Write',
        { file_path: '/ws/link.txt', content: 'b' },
        judged.real,
      ),
    ).toMatchObject({ isError: false })
    expect(await textAt(host, '/ws/a.txt')).toBe('b')
    expect(
      await run(writeExecutor, host, 'Write', { file_path: '/ws/new/b.txt', content: 'c' }),
    ).toMatchObject({ isError: false })
    expect(await textAt(host, '/ws/new/b.txt')).toBe('c')
  })
})
