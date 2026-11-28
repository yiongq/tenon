import { constants } from 'node:fs'
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostIdentity } from '@tenon-app/kernel'
import { appLog } from '../log/app-log.js'

/** `mcp-<serverId>.log` and the two files it turns over into. */
const CONNECTOR_LOG = /^mcp-.+\.log(?:\.[12])?$/u

/**
 * Connector logs are for their owner alone (error-logs §对 03 的增补, 验收 18): the ones an older
 * Tenon made are tightened to 0600 when the sink starts. A file is opened without following a link
 * and left as it is unless it is a regular file of this user with one name only; a path that is
 * missing, a link, a second name or somebody else's file is skipped, never an error.
 */
async function tighten(logs: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(logs)
  } catch {
    return
  }
  const uid = process.getuid?.()
  const noFollow = (constants.O_NOFOLLOW as number | undefined) ?? 0
  const noBlock = (constants.O_NONBLOCK as number | undefined) ?? 0
  for (const name of names.filter((one) => CONNECTOR_LOG.test(one))) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a handful of files, one at a time
      const handle = await open(join(logs, name), constants.O_RDONLY | noFollow | noBlock)
      try {
        // oxlint-disable-next-line no-await-in-loop -- the check and the change on the one handle
        const st = await handle.stat()
        if (st.isFile() && st.nlink === 1 && (uid === undefined || st.uid === uid)) {
          // oxlint-disable-next-line no-await-in-loop -- the same handle
          await handle.chmod(0o600)
        }
      } finally {
        // oxlint-disable-next-line no-await-in-loop -- the same handle
        await handle.close()
      }
    } catch {
      // a link, a file in the way, a file that went: this one stays as it is
    }
  }
}

export function createMcpLogSink(identity: HostIdentity) {
  const pending = new Map<string, Promise<void>>()
  const logs = join(identity.profileDir, 'logs')
  const file = (id: string) => join(logs, `mcp-${id}.log`)
  const tightened = tighten(logs)
  return {
    append(id: string, line: string) {
      const path = file(id)
      const run = (pending.get(id) ?? tightened)
        .then(async () => {
          await mkdir(logs, { recursive: true, mode: 0o700 })
          const size = await stat(path).then(
            (s) => s.size,
            () => 0,
          )
          if (size + Buffer.byteLength(line + '\n') > 1024 * 1024) {
            await unlink(path + '.2').catch(() => {})
            await rename(path + '.1', path + '.2').catch(() => {})
            await rename(path, path + '.1').catch(() => {})
          }
          await appendFile(path, line + '\n', { encoding: 'utf8', mode: 0o600 })
        })
        .catch(() => {
          appLog.line('mcp', 'warn')(`[mcp] log write failed: ${id}`)
        })
      pending.set(id, run)
      return run
    },
    async read(id: string) {
      await pending.get(id)
      const bytes = await readFile(file(id)).catch(() => Buffer.alloc(0))
      return {
        text: bytes.subarray(-64 * 1024).toString('utf8'),
        truncated: bytes.length > 64 * 1024,
      }
    },
    async close() {
      await Promise.all(pending.values())
    },
  }
}
