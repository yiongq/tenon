/**
 * macOS's /.vol on the real disk, through the loop (spec 02 §「在不在工作区里」 step 2; owner 2026-09-27,
 * s11-safety-2): `/.vol/<dev>/<ino>` reaches any file by inode and realpath(3) cannot name it, so
 * DesktopFs throws `UnresolvableAliasError` and the kernel blocks the call like the protected list,
 * with no card. packages/kernel/test/loop/protected-paths.test.ts is the same on a fake volfs, and runs
 * everywhere.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  locatePath,
  resolvePath,
} from '@tenon-app/kernel'
import type {
  AbsolutePath,
  ModelInfo,
  PermissionDecidedPayload,
  StreamEvent,
  Usage,
} from '@tenon-app/kernel'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '@tenon-app/kernel/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DesktopFs } from '../src/main/host/fs.js'
import { protectedShellFiles } from '../src/main/workspace.js'

const SESSION = '7a2c4e1b-3d5f-4a60-8b71-9c0d1e2f3a01'

const MODEL: ModelInfo = {
  id: 'claude-volfs-1',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}

const USAGE: Usage = {
  inputTokens: 5,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

type Call = { readonly name: string; readonly input: Record<string, unknown> }

function reply(calls: readonly Call[]): StreamEvent[] {
  return [
    ...calls.flatMap((call, i): StreamEvent[] => {
      const id = `toolu_${String(i)}_${call.name}`
      return [
        { type: 'tool-call-start', index: i + 1, id, name: call.name },
        { type: 'tool-call-end', index: i + 1, id, name: call.name, input: call.input },
      ]
    }),
    { type: 'usage', usage: USAGE },
    stopEvent('tool-use', 'tool_use'),
  ]
}

describe.runIf(process.platform === 'darwin' && existsSync('/.vol'))(
  '/.vol on the desktop disk',
  () => {
    const fs = new DesktopFs()
    let home = '' // the user's home, as far as this case knows: resolved, under a temp folder
    const at = (relative: string): AbsolutePath => absolutePath(join(home, relative))
    /** The name volfs gives a file or folder: by device and inode. */
    const vol = async (relative: string): Promise<string> => {
      const s = await stat(join(home, relative), { bigint: true })
      return `/.vol/${String(s.dev)}/${String(s.ino)}`
    }

    beforeEach(async () => {
      home = await realpath(await mkdtemp(join(tmpdir(), 'tenon-volfs-')))
      await mkdir(join(home, 'prof'))
      await writeFile(join(home, 'prof', 'config.json'), '{"token":"SECRET-config"}\n')
      await writeFile(join(home, '.zshrc'), 'export TOKEN=SECRET-rc\n')
      await mkdir(join(home, 'proj'))
      await writeFile(join(home, 'proj', 'a.ts'), 'const x = 1\n')
    })
    afterEach(async () => {
      await rm(home, { recursive: true, force: true })
    })

    it('blocks the /.vol names of a workspace file, the shell file and the config without a card', async () => {
      const identity = { userId: 'volfs-user', tenantId: 'volfs-tenant', profileDir: at('prof') }
      const memory = createMemoryHost({ identity })
      const provider = createScriptedProvider({ models: [MODEL] })
      const loop = createTestLoopPorts({ connector: { provider, model: MODEL } })
      const tape = createMemoryTapeStore({ identity })
      const service = createTestSessionService(
        {
          host: { ...memory, fs },
          tape,
          ids: createCounterIds(),
          inspectors: [],
          connector: loop.connector,
          protectedFiles: protectedShellFiles(absolutePath(home)),
        },
        { tools: { Read: 'real' } },
      )
      service.bindLoop(loop)
      const dedicated = at(`Tenon/workspaces/${SESSION}`)
      await service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated })
      await service.setWorkspace({
        sessionId: SESSION,
        change: { kind: 'add', folders: [at('proj')] },
        dedicated,
      })
      const names = {
        file: await vol('proj/a.ts'),
        rc: await vol('.zshrc'),
        config: await vol('prof/config.json'),
        folder: await vol('proj'),
      }
      // An allowed read between the blocked ones: three machine denials in a row would end the Run.
      const read = { name: 'Read', input: { file_path: join(home, 'proj', 'a.ts') } }
      provider.script(
        reply([
          { name: 'Read', input: { file_path: names.file } },
          read,
          { name: 'Read', input: { file_path: names.rc } },
          read,
          { name: 'Read', input: { file_path: names.config } },
          read,
          { name: 'Write', input: { file_path: `${names.folder}/new.txt`, content: 'x' } },
        ]),
      )
      provider.script(scriptedTurn({ deltas: ['Done.'], usage: USAGE }))
      const sent = await service.send({ sessionId: SESSION, origin: null, text: 'go' })
      if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
      expect((await loop.runEnded({ runId: sent.runId })).reason.code).toBe('completed')

      const { entries } = await tape.readRange({ sessionId: SESSION, limit: 1000 })
      const decisions = entries
        .filter((entry) => entry.name === 'tool/permission_decided')
        .map((entry) => entry.payload as unknown as PermissionDecidedPayload)
      expect(
        decisions.map((decision) => [decision.record.verdict, decision.record.decidedBy]),
      ).toEqual([
        ['deny', 'protected'],
        ['allow', 'user-grant'],
        ['deny', 'protected'],
        ['allow', 'user-grant'],
        ['deny', 'protected'],
        ['allow', 'user-grant'],
        ['deny', 'protected'],
      ])
      expect(decisions.flatMap((decision) => decision.block ?? [])).toEqual([
        { reason: 'protected', facts: { toolName: 'Read', target: names.file } },
        { reason: 'protected', facts: { toolName: 'Read', target: names.rc } },
        { reason: 'protected', facts: { toolName: 'Read', target: names.config } },
        { reason: 'protected', facts: { toolName: 'Write', target: `${names.folder}/new.txt` } },
      ])
      const results = entries
        .filter((entry) => entry.name === 'tool/result')
        .map((entry) => JSON.stringify(entry.payload['content']))
      expect(results.some((text) => text.includes('SECRET'))).toBe(false)
      // No card, no answer, so no grant of any kind.
      expect(memory.confirmRequests).toEqual([])
      expect(entries.filter((entry) => entry.name === 'tool/approval_resolved')).toEqual([])
    })

    it('keeps a missing path and a dangling link outside', async () => {
      const scope = {
        roots: [at('proj')],
        profileDir: (await resolvePath(fs, at('prof'))).path,
        ownSpillDir: at(`prof/tool-output/${SESSION}`),
        protectedFiles: protectedShellFiles(absolutePath(home)),
      }
      await symlink(join(home, 'nowhere'), join(home, 'proj', 'dangling'))
      expect(await locatePath(fs, at('elsewhere/missing.txt'), scope)).toEqual({
        real: at('elsewhere/missing.txt'),
        place: 'outside',
      })
      expect(await locatePath(fs, at('proj/dangling'), scope)).toEqual({
        real: at('proj/dangling'),
        place: 'outside',
      })
    })
  },
)
