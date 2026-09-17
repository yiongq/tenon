import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import type { AbsolutePath, HostFs } from '@tenon-app/kernel'
import { absolutePath } from '@tenon-app/kernel'

/** Real filesystem access for the desktop host. Every path is re-checked to be absolute. */
export class DesktopFs implements HostFs {
  async readFile(path: AbsolutePath, opts?: { encoding?: 'utf8' }): Promise<Uint8Array | string> {
    absolutePath(path)
    if (opts?.encoding === 'utf8') return readFile(path, 'utf8')
    const buf = await readFile(path)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  async writeFile(path: AbsolutePath, data: Uint8Array | string): Promise<void> {
    absolutePath(path)
    await writeFile(path, data)
  }

  async stat(
    path: AbsolutePath,
  ): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null> {
    absolutePath(path)
    try {
      const s = await stat(path)
      return { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory() }
    } catch (err) {
      if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return null
      throw err
    }
  }

  async readdir(path: AbsolutePath): Promise<string[]> {
    absolutePath(path)
    return (await readdir(path)).toSorted()
  }

  async mkdirp(path: AbsolutePath): Promise<void> {
    absolutePath(path)
    await mkdir(path, { recursive: true })
  }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code
}
