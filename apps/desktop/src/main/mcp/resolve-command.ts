// oxlint-disable no-await-in-loop -- search executable candidates in PATH / PATHEXT order
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
export async function resolveMcpCommand(
  command: string,
  path: string,
  platform = process.platform,
  pathext = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD',
) {
  const windows = platform === 'win32'
  const absolute = windows ? win32.isAbsolute(command) : isAbsolute(command)
  const found = absolute
    ? command
    : /[\\/]/.test(command)
      ? null
      : await find(command, path, windows, pathext)
  if (found === null) return { ok: false, code: 'command-not-found' } as const
  if (windows && /\.(cmd|bat)$/i.test(found))
    return { ok: false, code: 'windows-unsupported' } as const
  return { ok: true, path: absolutePath(found) } as const
}
async function find(
  command: string,
  path: string,
  windows: boolean,
  pathext: string,
): Promise<string | null> {
  for (const directory of path.split(windows ? ';' : ':')) {
    if (!directory || !(windows ? win32.isAbsolute(directory) : isAbsolute(directory))) continue
    const candidates =
      windows && !win32.extname(command)
        ? pathext
            .split(';')
            .filter((ext) => /^\.[a-z0-9]+$/i.test(ext))
            .map((ext) => win32.join(directory, command + ext))
        : [windows ? win32.join(directory, command) : join(directory, command)]
    for (const candidate of candidates) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- PATH order is the resolution order
        await access(candidate, windows ? constants.F_OK : constants.X_OK)
        if ((await stat(candidate)).isFile()) return candidate
      } catch {
        /* try the next PATH entry */
      }
    }
  }
  return null
}
