/** Spec 05 §一键还原: process-wide, real-folder shared/exclusive leases, including cleanup. */
import { dirname } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { ChildHandle, SandboxRequest } from '@tenon-app/kernel'
import { absolutePath } from '@tenon-app/kernel'
import { contains, targetPath } from './snapshot-storage.js'

type Release = () => void
const overlaps = (a: string, b: string): boolean => contains(a, b) || contains(b, a)

export class WorkspaceLeases {
  private readonly held = new Set<{ roots: readonly string[]; exclusive: boolean }>()
  private readonly folders = new Map<object, readonly string[]>()

  setFolders(owner: object, roots: readonly string[]): void {
    this.folders.set(owner, roots)
  }
  forget(owner: object): void {
    this.folders.delete(owner)
  }

  commandRoots(paths: readonly string[]): string[] {
    return [
      ...new Set([
        ...paths,
        ...[...this.folders.values()]
          .flat()
          .filter((root) => paths.some((path) => contains(root, path))),
      ]),
    ]
  }

  private readonly waiters = new Set<() => void>()

  exclusive(roots: readonly string[]): Release | null {
    if ([...this.held].some((lease) => lease.roots.some((a) => roots.some((b) => overlaps(a, b)))))
      return null
    return this.hold(roots, true)
  }

  async shared(roots: readonly string[]): Promise<Release> {
    for (;;) {
      if (
        ![...this.held].some(
          (lease) => lease.exclusive && lease.roots.some((a) => roots.some((b) => overlaps(a, b))),
        )
      )
        return this.hold(roots, false)
      // oxlint-disable-next-line no-await-in-loop -- retry only when an exclusive owner releases
      await new Promise<void>((resolve) => this.waiters.add(resolve))
    }
  }

  private hold(roots: readonly string[], exclusive: boolean): Release {
    const lease = { roots, exclusive }
    this.held.add(lease)
    return () => {
      if (!this.held.delete(lease)) return
      for (const wake of this.waiters) wake()
      this.waiters.clear()
    }
  }

  async write<T>(path: Parameters<typeof targetPath>[0], work: () => Promise<T>): Promise<T> {
    absolutePath(path)
    const target = await targetPath(path)
    const roots = [
      ...new Set([...this.folders.values()].flat().filter((root) => contains(root, target))),
    ]
    const release = await this.shared(roots.length === 0 ? [dirname(target)] : roots)
    try {
      return await work()
    } finally {
      release()
    }
  }
}

export const workspaceLeases = new WorkspaceLeases()
interface CommandLease {
  release: Release
  exited: boolean
  started: boolean
  cleaned: boolean
  cleanup?: () => Promise<void>
}
// Only the host-owned git runner can mark these argument arrays. Never infer this from command text.
const snapshotCommands = new WeakSet<readonly string[]>()
export function markSnapshotCommand(argv: readonly string[]): void {
  snapshotCommands.add(argv)
}
// D64: only the desktop connector adapter may mark a connector's argument array.
const connectorCommands = new WeakSet<readonly string[]>()
export function markConnectorCommand(argv: readonly string[]): void {
  connectorCommands.add(argv)
}
const commandLeases = new Map<string, CommandLease[]>()
const argvLeases = new WeakMap<readonly string[], CommandLease>()
function finish(lease: CommandLease): void {
  if (lease.exited && lease.cleaned) lease.release()
}

/** Called at the sandbox boundary, before either sandbox setup or spawn can write. */
export async function leaseCommand<T extends { argv: string[] }>(
  q: SandboxRequest,
  wrap: () => Promise<T>,
  resolve: (folder: string) => string | Promise<string> = realpath,
  cleanup?: () => Promise<void>,
): Promise<T> {
  const internal = snapshotCommands.has(q.argv) || connectorCommands.has(q.argv)
  const resolved = internal ? [] : [q.cwd, ...q.workspace].map((folder) => resolve(folder))
  const roots = resolved.every((root): root is string => typeof root === 'string')
    ? resolved
    : await Promise.all(resolved)
  const lease: CommandLease = {
    release: await workspaceLeases.shared(internal ? [] : workspaceLeases.commandRoots(roots)),
    exited: false,
    started: false,
    cleaned: false,
    ...(cleanup === undefined ? {} : { cleanup }),
  }
  const leases = commandLeases.get(q.commandId) ?? []
  leases.push(lease)
  commandLeases.set(q.commandId, leases)
  try {
    const result = await wrap()
    argvLeases.set(result.argv, lease)
    return result
  } catch (error) {
    const remaining = (commandLeases.get(q.commandId) ?? []).filter(
      (candidate) => candidate !== lease,
    )
    if (remaining.length === 0) commandLeases.delete(q.commandId)
    else commandLeases.set(q.commandId, remaining)
    lease.release()
    throw error
  }
}

/** Spawn failures release too; an abort alone never releases a running process's lease. */
export async function leaseSpawn(
  argv: readonly string[],
  spawn: () => Promise<ChildHandle>,
): Promise<ChildHandle> {
  const lease = argvLeases.get(argv)
  if (lease?.cleaned) throw new Error('Command already cleaned before spawn')
  if (lease !== undefined) lease.started = true
  try {
    const child = await spawn()
    if (lease !== undefined)
      void child.exited.then(() => {
        lease.exited = true
        finish(lease)
      })
    return child
  } catch (error) {
    if (lease !== undefined) {
      lease.exited = true
      // A few existing callers only arrange afterExit after a successful spawn. Clean here too.
      await lease.cleanup?.().catch(() => {})
      finish(lease)
    }
    throw error
  }
}

export function commandCleaned(commandId: string): void {
  const leases = commandLeases.get(commandId)
  const lease = leases?.shift()
  if (lease === undefined) return
  if (leases!.length === 0) commandLeases.delete(commandId)
  lease.cleaned = true
  if (!lease.started) lease.exited = true
  finish(lease)
}
