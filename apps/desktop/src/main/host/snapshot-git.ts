/** Spec 05 §快照怎么拍: all subprocesses use HostProcess + full-access sandbox wrapping. */
import { randomUUID } from 'node:crypto'
import { lstat, readFile, rm, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AbsolutePath, ChildHandle, HostProcess, HostSandbox } from '@tenon-app/kernel'
import { absolutePath } from '@tenon-app/kernel'
import { atomicJson, directory, errno, pathKey } from './snapshot-storage.js'

export const SNAPSHOT_PATH = '/usr/bin:/bin'
export interface GitPorts {
  process: HostProcess
  sandbox: HostSandbox
}
export interface VolumeTraits {
  ignorecase: boolean
  symlinks: boolean
  filemode: boolean
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = stream.getReader()
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- consume subprocess output as it arrives
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 64_000_000) throw new Error('Snapshot subprocess output exceeded its limit')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export class SnapshotGit {
  private readonly ports: GitPorts
  private readonly platform: NodeJS.Platform
  private readonly candidate: string
  private readonly pending = new Set<Promise<unknown>>()
  private git: string | null = null
  unavailableReason: string | null = null
  unavailableCause: unknown = null
  constructor(ports: GitPorts, platform = process.platform, candidate = '/usr/bin/git') {
    this.ports = ports
    this.platform = platform
    this.candidate = candidate
  }

  async command(
    argv: string[],
    cwd: string,
    home: string,
    signal: AbortSignal,
    input?: string,
    tracked?: string,
  ): Promise<string> {
    signal.throwIfAborted()
    const env = {
      PATH: SNAPSHOT_PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(home, 'empty'),
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_LITERAL_PATHSPECS: '1',
      LC_ALL: 'C',
      GIT_AUTHOR_NAME: 'Tenon',
      GIT_AUTHOR_EMAIL: 'snapshot@localhost',
      GIT_COMMITTER_NAME: 'Tenon',
      GIT_COMMITTER_EMAIL: 'snapshot@localhost',
    }
    const commandId = `snapshot-${randomUUID()}`
    const wrapped = await this.ports.sandbox.wrap({
      commandId,
      argv,
      env,
      cwd: absolutePath(cwd),
      profile: 'full-access',
      workspace: [],
    })
    const child = await this.ports.process.spawn(
      { ...wrapped, cwd: absolutePath(cwd), stdio: 'pipe' },
      signal,
    )
    const abort = () => {
      void child.kill('SIGKILL').catch(() => {})
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const work = this.finish(child, home, tracked, input, wrapped.argv)
    this.pending.add(work)
    try {
      const result = await work
      signal.throwIfAborted()
      return result
    } finally {
      this.pending.delete(work)
      signal.removeEventListener('abort', abort)
      await this.ports.sandbox.afterExit(commandId)
    }
  }

  private async finish(
    child: ChildHandle,
    home: string,
    tracked?: string,
    input?: string,
    argv?: readonly string[],
  ): Promise<string> {
    try {
      if (tracked !== undefined)
        await atomicJson(tracked, { pid: child.pid, pgid: child.pid, argv })
      const stdout = drain(child.stdout)
      const stderr = drain(child.stderr)
      const writer = child.stdin.getWriter()
      void writer.closed.catch(() => {})
      // A fast child may exit and close its stdin before close() runs (seen on Linux). Only a
      // failed write of real input is an error, and the exit code is checked first.
      const written = (async (): Promise<unknown> => {
        try {
          if (input !== undefined) await writer.write(new TextEncoder().encode(input))
        } catch (error) {
          return error
        }
        try {
          await writer.close()
        } catch {
          // Closing a stdin the child already closed loses nothing.
        }
        return undefined
      })().finally(() => writer.releaseLock())
      const [out, err, exit, stdinError] = await Promise.all([
        stdout,
        stderr,
        child.exited,
        written,
      ])
      if (exit.code === 0 && stdinError !== undefined) throw stdinError
      if (exit.code !== 0)
        throw Object.assign(
          new Error(
            `Snapshot subprocess failed (${exit.code}): ${new TextDecoder().decode(err).slice(0, 1000)}`,
          ),
          {
            exitCode: exit.code,
            // LC_ALL=C and an owned repo command make this a diagnostic storage classification.
            ...(/No space left on device/.test(new TextDecoder().decode(err))
              ? { code: 'ENOSPC', path: home }
              : {}),
          },
        )
      return new TextDecoder().decode(out)
    } catch (error) {
      await child.kill('SIGKILL').catch(() => {})
      await child.exited
      throw error
    } finally {
      if (tracked !== undefined) await rm(tracked, { force: true })
    }
  }

  async settled(): Promise<void> {
    await Promise.allSettled(this.pending)
  }

  async available(home: string, signal: AbortSignal): Promise<boolean> {
    if (this.platform === 'win32') {
      this.unavailableReason = 'Windows uses single-file snapshots'
      return false
    }
    if (this.git !== null) return true
    if (!this.candidate.startsWith('/')) {
      this.unavailableReason = 'Git executable is not absolute'
      return false
    }
    try {
      await directory(home)
      await writeFile(join(home, 'empty'), '')
      await directory(join(home, 'template'))
      if (this.platform === 'darwin')
        await this.command(['/usr/bin/xcode-select', '-p'], home, home, signal)
      const version = await this.command([this.candidate, '--version'], home, home, signal)
      const match = /git version (\d+)\.(\d+)/.exec(version)
      if (
        match === null ||
        Number(match[1]) < 2 ||
        (Number(match[1]) === 2 && Number(match[2]) < 43)
      ) {
        this.unavailableReason = `Git version is below 2.43: ${version.trim()}`
        return false
      }
      const probe = join(home, `init-${randomUUID()}`)
      try {
        await this.command(
          [this.candidate, 'init', '--bare', `--template=${join(home, 'template')}`, probe],
          home,
          home,
          signal,
        )
      } finally {
        await rm(probe, { recursive: true, force: true })
      }
      this.git = this.candidate
      return true
    } catch (error) {
      this.unavailableCause = error
      this.unavailableReason = error instanceof Error ? error.message : String(error)
      if (signal.aborted) throw error
      return false
    }
  }

  async run(
    repo: string,
    folder: string,
    args: string[],
    signal: AbortSignal,
    input?: string,
  ): Promise<string> {
    if (this.git === null) throw new Error('Snapshot git is unavailable')
    return this.command(
      [
        this.git,
        '-c',
        `safe.directory=${folder}`,
        `--git-dir=${repo}`,
        `--work-tree=${folder}`,
        ...args,
      ],
      repo,
      repo,
      signal,
      input,
      join(repo, 'process.json'),
    )
  }

  async init(repo: string, folder: AbsolutePath, signal: AbortSignal): Promise<VolumeTraits> {
    await directory(repo)
    await writeFile(join(repo, 'empty'), '')
    await directory(join(repo, 'template'))
    const traits = await probeVolume(folder, signal)
    if (this.git === null) throw new Error('Snapshot git is unavailable')
    await this.command(
      [
        this.git,
        '-c',
        `safe.directory=${folder}`,
        `--git-dir=${repo}`,
        'init',
        '--bare',
        `--template=${join(repo, 'template')}`,
        repo,
      ],
      repo,
      repo,
      signal,
      undefined,
      join(repo, 'process.json'),
    )
    await directory(join(repo, 'hooks-disabled'))
    const config: Record<string, string> = {
      'core.bare': 'false',
      // Keep the shadow index portable; rejected names are counted as skipped by captureTree.
      'core.protectNTFS': 'true',
      'core.worktree': folder,
      'core.hooksPath': join(repo, 'hooks-disabled'),
      'core.fsmonitor': 'false',
      'core.excludesFile': join(repo, 'empty'),
      'core.attributesFile': join(repo, 'empty'),
      'core.autocrlf': 'false',
      'core.safecrlf': 'false',
      'core.ignorecase': String(traits.ignorecase),
      'core.symlinks': String(traits.symlinks),
      'core.filemode': String(traits.filemode),
      'commit.gpgSign': 'false',
      'gc.auto': '0',
      'maintenance.auto': 'false',
      'core.logAllRefUpdates': 'false',
    }
    // One write avoids a subprocess per config key and excludes user include directives.
    const sections = new Map<string, string[]>()
    for (const [key, value] of Object.entries(config)) {
      const [section, name] = key.split('.')
      const entries = sections.get(section!) ?? []
      entries.push(`\t${name} = ${JSON.stringify(value)}`)
      sections.set(section!, entries)
    }
    await writeFile(
      join(repo, 'config'),
      [...sections].map(([name, entries]) => `[${name}]\n${entries.join('\n')}\n`).join(''),
    )
    await directory(join(repo, 'info'))
    await writeFile(
      join(repo, 'info', 'attributes'),
      '* -text -ident -filter -working-tree-encoding\n',
    )
    return traits
  }

  async recoverProcess(repo: string, signal: AbortSignal): Promise<void> {
    const recordPath = join(repo, 'process.json')
    let record: { pid: number; pgid: number; argv: string[] }
    try {
      record = JSON.parse(await readFile(recordPath, 'utf8')) as typeof record
    } catch (error) {
      if (errno(error, 'ENOENT')) return
      throw error
    }
    const { pid, pgid, argv } = record
    if (
      !Number.isSafeInteger(pid) ||
      pid < 2 ||
      pgid !== pid ||
      !Array.isArray(argv) ||
      !argv.every((arg) => typeof arg === 'string') ||
      !argv.includes(`--git-dir=${repo}`)
    )
      throw new Error('Cannot verify the previous snapshot process record')
    let output: string
    try {
      output = await this.command(
        ['/bin/ps', '-ww', '-p', String(pid), '-o', 'pgid=', '-o', 'command='],
        repo,
        repo,
        signal,
      )
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { exitCode?: number }).exitCode === 1
      ) {
        await rm(recordPath, { force: true })
        return
      }
      throw new Error('Cannot verify the previous snapshot process', { cause: error })
    }
    const match = /^\s*(\d+)\s+([^\n]+)\n?$/.exec(output)
    if (match === null || Number(match[1]) !== pgid)
      throw new Error('Cannot verify previous snapshot process group')
    let actual: string[]
    if (this.platform === 'linux') {
      try {
        actual = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean)
      } catch (error) {
        if (errno(error, 'ENOENT')) {
          await rm(recordPath, { force: true })
          return
        }
        throw error
      }
    } else {
      // ps has no argv delimiter on macOS. Ambiguous whitespace/escaping is never grounds to kill.
      if (argv.some((arg) => /[\s"'\\]/.test(arg)))
        throw new Error('Cannot verify ambiguous snapshot argv')
      actual = match[2]!.trim().split(/\s+/)
    }
    if (actual.length !== argv.length || actual.some((arg, i) => arg !== argv[i]))
      throw new Error('Cannot verify complete previous snapshot argv')
    await this.command(['/bin/kill', '-KILL', '--', `-${pgid}`], repo, repo, signal)
    await rm(recordPath, { force: true })
  }
}

/** Read-only volume traits: compare existing identities, never plant a probe in the workspace. */
export async function probeVolume(
  folder: AbsolutePath,
  signal: AbortSignal,
): Promise<VolumeTraits> {
  signal.throwIfAborted()
  const original = await lstat(folder, { bigint: true })
  let ignorecase = true
  for (let node: string = folder; dirname(node) !== node; node = dirname(node)) {
    // oxlint-disable-next-line no-await-in-loop -- only use a spelling whose parent is on the workspace volume
    if ((await lstat(dirname(node), { bigint: true })).dev !== original.dev) break
    const name = basename(node)
    const changed = name.replace(/[a-zA-Z]/, (letter) =>
      letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
    )
    if (changed === name) continue
    try {
      // oxlint-disable-next-line no-await-in-loop -- compare dev and inode under the alternate spelling
      const other = await lstat(join(dirname(node), changed), { bigint: true })
      // oxlint-disable-next-line no-await-in-loop -- compare this existing directory, not a different volume's ancestor
      const self = await lstat(node, { bigint: true })
      ignorecase = self.dev === other.dev && self.ino === other.ino
    } catch (error) {
      if (errno(error, 'ENOENT')) ignorecase = false
    }
    break
  }
  // APFS/HFS, ext, tmpfs, XFS, btrfs, overlayfs, ZFS and NFS expose POSIX links and mode bits.
  // Unknown/FAT/network emulations conservatively disable both capabilities.
  const posixTypes = new Set([
    0x1a, 0x11, 0xef53, 0x01021994, 0x58465342, 0x9123683e, 0x794c7630, 0x2fc12fc1, 0x6969,
  ])
  const type = await statfs(folder).then(
    (fs) => fs.type,
    () => -1,
  )
  signal.throwIfAborted()
  const posix = posixTypes.has(type)
  return { ignorecase, symlinks: posix, filemode: posix }
}

export function repoPath(sessionDir: string, folder: string): string {
  return join(sessionDir, 'repos', pathKey(folder))
}
