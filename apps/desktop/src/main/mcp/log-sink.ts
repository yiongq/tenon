import { appendFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostIdentity } from '@tenon-app/kernel'
export function createMcpLogSink(identity: HostIdentity) {
  const pending = new Map<string, Promise<void>>()
  const file = (id: string) => join(identity.profileDir, 'logs', `mcp-${id}.log`)
  return {
    append(id: string, line: string) {
      const path = file(id)
      const run = (pending.get(id) ?? Promise.resolve())
        .then(async () => {
          await mkdir(join(identity.profileDir, 'logs'), { recursive: true })
          const size = await stat(path).then(
            (s) => s.size,
            () => 0,
          )
          if (size + Buffer.byteLength(line + '\n') > 1024 * 1024) {
            await unlink(path + '.2').catch(() => {})
            await rename(path + '.1', path + '.2').catch(() => {})
            await rename(path, path + '.1').catch(() => {})
          }
          await appendFile(path, line + '\n', 'utf8')
        })
        .catch(() => {
          console.warn(`[mcp] log write failed: ${id}`)
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
