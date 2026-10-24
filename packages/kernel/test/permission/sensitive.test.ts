/** Spec 05 step 5: sensitivity is an ask boundary even with old grants and injected auto mode. */
import { describe, expect, it } from 'vitest'
import { absolutePath, createMemoryHost, EMPTY_POLICY } from '../../src/index.js'
import { decide } from '../../src/permission/decide.js'
import { answerScope } from '../../src/permission/grants.js'
import { callReasonOf } from '../../src/permission/reversibility.js'
import { locatePath, sensitiveName } from '../../src/permission/workspace.js'
import { walkFiles } from '../../src/tools/builtin/files.js'
import type { PathScope } from '../../src/permission/workspace.js'

const p = absolutePath
const scope: PathScope = {
  roots: [p('/home')],
  profileDir: p('/profile'),
  ownSpillDir: p('/profile/tool-output/s'),
  protectedFiles: [],
  sensitive: { credential: [p('/home/.ssh')], autoRunNames: ['.envrc', '.git'], linkTargets: [] },
}

describe('05 sensitive permission boundaries', () => {
  it.each(['credential', 'auto-run', 'hardlink'] as const)(
    '05 验收 25、26、27: %s ignores own, inherited, task and auto grants and keeps the category',
    (category) => {
      for (const inherited of [false, true]) {
        const tool = {
          name: 'Write',
          source: 'builtin' as const,
          serverId: 'builtin',
          originalName: 'Write',
        }
        const reason = callReasonOf({
          tool,
          args: {},
          real: p('/home/a'),
          place: 'outside',
          sensitive: category,
          workspace: p('/home'),
          searchHost: null,
        })
        const result = decide({
          call: { tool, args: {}, reversibility: 'unknown' },
          callReason: reason,
          inspectors: [],
          layers: {
            policy: { status: 'current', version: 'empty', snapshot: EMPTY_POLICY },
            place: 'workspace',
            sensitive: category,
            reversibility: { value: 'unknown', source: 'host' },
            requiresUserInteraction: false,
            sessionGrant: {
              kind: 'session',
              grantFrom: { sessionId: 'old', approvalKey: 'key' },
              ...(inherited ? { inherited: true as const } : {}),
            },
            taskGrant: true,
            approvalMode: 'auto',
            userSetting: 'always-allow',
          },
        })
        expect(result.record.verdict).toBe('ask')
        expect(result.record.steps.filter((step) => step.by === 'user-grant')).toEqual([
          { by: 'user-grant', said: 'none', status: 'ok' },
        ])
        expect(result.confirm).toEqual({
          reason: 'sensitive-path',
          facts: { path: '/home/a', category },
        })
        expect(
          answerScope({
            decision: result,
            reversibility: 'unknown',
            source: 'builtin',
            toolName: 'Write',
            place: 'workspace',
          }),
        ).toBe('once')
      }
    },
  )

  it('05 验收 26: traversal skips credentials without opening them and keeps automatic names and multiple names', async () => {
    const host = createMemoryHost()
    await host.fs.mkdirp(p('/home/.ssh'))
    await host.fs.writeFile(p('/home/.ssh/id_test'), 'credential')
    await host.fs.writeFile(p('/home/.envrc'), 'auto')
    await host.fs.writeFile(p('/home/ordinary'), 'ordinary')
    const visited: string[] = []
    const fs = new Proxy(host.fs, {
      get(target, key) {
        if (key === 'readdir')
          return async (path: ReturnType<typeof p>) => {
            visited.push(path)
            return target.readdir(path)
          }
        const value: unknown = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    expect(
      (await walkFiles(fs, p('/home'), scope, new AbortController().signal)).map(
        (file) => file.relative,
      ),
    ).toEqual(['.envrc', 'ordinary'])
    expect(visited).not.toContain('/home/.ssh')
    expect(
      (await walkFiles(fs, p('/home/.ssh'), scope, new AbortController().signal)).map(
        (file) => file.relative,
      ),
    ).toEqual(['id_test'])
    expect(visited).toContain('/home/.ssh')
  })
})

it('05 验收 28: a home shell deny wins over shared auto-run names in the same workspace', async () => {
  const host = createMemoryHost()
  await host.fs.mkdirp(p('/home'))
  await host.fs.writeFile(p('/home/.zshrc'), 'fixture')
  const combined: PathScope = {
    ...scope,
    protectedFiles: [p('/home/.zshrc')],
    sensitive: { ...scope.sensitive!, autoRunNames: ['.zshrc'] },
  }
  expect(await locatePath(host.fs, p('/home/.zshrc'), combined, 'Write')).toEqual({
    real: '/home/.zshrc',
    place: 'protected',
  })
})

it('05 验收 27、55: multi-segment names require every segment and either written or real path may match', () => {
  const specific: PathScope = {
    ...scope,
    sensitive: { ...scope.sensitive!, autoRunNames: ['.claude/settings.json', '.envrc'] },
  }
  expect(
    sensitiveName(p('/home/.claude/notes.txt'), p('/home/.claude/notes.txt'), specific, true),
  ).toBeUndefined()
  expect(
    sensitiveName(
      p('/home/elsewhere/settings.json'),
      p('/home/elsewhere/settings.json'),
      specific,
      true,
    ),
  ).toBeUndefined()
  expect(sensitiveName(p('/home/plain-link'), p('/home/.ssh/id_test'), specific, false)).toBe(
    'credential',
  )
  expect(sensitiveName(p('/home/plain-link'), p('/home/.envrc'), specific, true)).toBe('auto-run')
  expect(sensitiveName(p('/home/.envrc'), p('/outside/plain-target'), specific, true)).toBe(
    'auto-run',
  )
})

it.each(['profile', 'protected-file'] as const)(
  '05 验收 28、55: a plain alias into a %s stays blocked even when its target is also sensitive',
  async (kind) => {
    const host = createMemoryHost()
    const target = p(kind === 'profile' ? '/profile/key' : '/home/shell-config')
    await host.fs.mkdirp(p('/profile'))
    await host.fs.mkdirp(p('/home'))
    await host.fs.writeFile(target, 'fixture')
    host.symlink(p('/home/ordinary-alias'), target)
    const combined: PathScope = {
      ...scope,
      protectedFiles: kind === 'protected-file' ? [target] : [],
      sensitive: { credential: [target], autoRunNames: [], linkTargets: [] },
    }
    expect(await locatePath(host.fs, p('/home/ordinary-alias'), combined, 'Write')).toEqual({
      real: target,
      place: 'protected',
    })
  },
)

it('05 验收 26、55: any one credential or resolved auto-run target suffices, with ordinary negative controls', () => {
  const table: PathScope = {
    ...scope,
    sensitive: {
      credential: [p('/home/.ssh'), p('/home/.aws')],
      autoRunNames: [],
      linkTargets: [{ real: p('/outside/config'), category: 'auto-run' }],
    },
  }
  expect(sensitiveName(p('/home/.aws/key'), p('/home/.aws/key'), table, false)).toBe('credential')
  expect(sensitiveName(p('/home/safe'), p('/home/safe'), table, true)).toBeUndefined()
  expect(sensitiveName(p('/home/alias'), p('/outside/config/tasks.json'), table, true)).toBe(
    'auto-run',
  )
  expect(
    sensitiveName(p('/home/alias'), p('/outside/config/tasks.json'), table, false),
  ).toBeUndefined()
  expect(
    sensitiveName(p('/outside/config-neighbor'), p('/outside/config-neighbor'), table, true),
  ).toBeUndefined()
})

it('05 验收 25: failed identity metadata blocks writes, while reads do not request that metadata', async () => {
  const host = createMemoryHost()
  await host.fs.mkdirp(p('/home'))
  await host.fs.writeFile(p('/home/ordinary'), 'fixture')
  let requested = 0
  const fs = new Proxy(host.fs, {
    get(target, key) {
      if (key === 'identity')
        return () => {
          requested++
          return Promise.reject(new Error('metadata unavailable'))
        }
      const value: unknown = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  for (const tool of ['Write', 'Edit', 'Delete'] as const) {
    // oxlint-disable-next-line no-await-in-loop -- each writing tool fails closed independently
    expect(await locatePath(fs, p('/home/ordinary'), scope, tool)).toEqual({
      real: '/home/ordinary',
      place: 'protected',
    })
  }
  expect(requested).toBe(3)
  expect(await locatePath(fs, p('/home/ordinary'), scope, 'Read')).toEqual({
    real: '/home/ordinary',
    place: 'workspace',
  })
  expect(requested).toBe(3)
})

it('05 验收 27: automatic names only match segments below a workspace root', () => {
  expect(sensitiveName(p('/outside/.envrc'), p('/outside/.envrc'), scope, true)).toBeUndefined()
  const nested: PathScope = {
    ...scope,
    roots: [p('/home/.vscode/project')],
    sensitive: { credential: [], autoRunNames: ['.vscode'], linkTargets: [] },
  }
  expect(
    sensitiveName(
      p('/home/.vscode/project/ordinary'),
      p('/home/.vscode/project/ordinary'),
      nested,
      true,
    ),
  ).toBeUndefined()
})

it('05 验收 26、28: credential reads in own-spill still ask, while writes retain the own-spill prohibition', async () => {
  const host = createMemoryHost()
  await host.fs.mkdirp(scope.ownSpillDir)
  const target = p(`${scope.ownSpillDir}/credential`)
  await host.fs.writeFile(target, 'fixture')
  const combined: PathScope = {
    ...scope,
    sensitive: { credential: [scope.ownSpillDir], autoRunNames: [], linkTargets: [] },
  }
  expect(await locatePath(host.fs, target, combined, 'Read')).toEqual({
    real: target,
    place: 'outside',
    sensitive: 'credential',
  })
  for (const tool of ['Write', 'Edit', 'Delete'] as const) {
    // oxlint-disable-next-line no-await-in-loop -- the prohibition is independent of the write tool
    expect(await locatePath(host.fs, target, combined, tool)).toEqual({
      real: target,
      place: 'own-spill',
    })
  }
})

it.each(['ordinary-file', 'legacy-command', 'rerun-command'] as const)(
  'shared grant processing preserves the %s authorization boundary',
  (kind) => {
    const command = kind !== 'ordinary-file'
    const tool = {
      name: command ? 'Bash' : 'Write',
      originalName: command ? 'Bash' : 'Write',
      source: 'builtin' as const,
      serverId: 'builtin',
    }
    const rerun = kind === 'rerun-command'
    const decision = decide({
      call: { tool, args: {}, reversibility: 'unknown' },
      callReason: {
        reason: rerun ? 'elevated' : 'default',
        facts: { command: 'echo fixture', cwd: '/home' },
      },
      inspectors: [],
      layers: {
        policy: { status: 'current', version: 'empty', snapshot: EMPTY_POLICY },
        place: 'workspace',
        reversibility: { value: 'unknown', source: 'host' },
        requiresUserInteraction: false,
        approvalMode: 'auto',
        ...(command
          ? {
              sandbox: {
                profile: 'full-access' as const,
                chosen: 'workspace-write' as const,
                ...(rerun
                  ? { override: { key: 'rerun', action: 'rerun-unsandboxed' as const } }
                  : {}),
              },
            }
          : {}),
        sessionGrant: {
          kind: 'session',
          grantFrom: { sessionId: 'owner', approvalKey: 'ordinary' },
          ...(rerun
            ? {
                sandbox: {
                  profile: 'full-access' as const,
                  chosen: 'workspace-write' as const,
                  unavailable: true as const,
                },
              }
            : {}),
        },
      },
    })
    const grant = decision.record.steps.find((step) => step.by === 'user-grant')
    expect(grant?.said).toBe(command ? 'none' : 'allow')
    expect(grant?.basis).toEqual(
      command
        ? undefined
        : { grant: 'session', grantFrom: { sessionId: 'owner', approvalKey: 'ordinary' } },
    )
    expect(decision.record.verdict).toBe(command ? 'ask' : 'allow')
    expect(decision.confirm?.reason).toBe(command ? (rerun ? 'elevated' : 'command') : undefined)
  },
)

it('05 验收 55: a failing sensitive provider preserves name checks without failing call facts', async () => {
  const { pathScopeOf } = await import('../../src/loop/batch.js')
  const host = createMemoryHost()
  const current = await pathScopeOf(
    {
      host,
      sessionId: '3a1d9a2e-6b3d-4a71-9f52-0c8de7a11b61',
      protectedFiles: [],
      sensitivePaths: async () => {
        throw new Error('metadata failed')
      },
      sensitiveFallback: () => scope.sensitive,
    },
    { folders: [p('/home')], origin: 'picked' },
  )
  expect(sensitiveName(p('/home/.envrc'), p('/home/.envrc'), current, true)).toBe('auto-run')
})

it('05 验收 26: an explicitly approved credential root is searched, but traversal from its parent skips it', async () => {
  const host = createMemoryHost()
  await host.fs.mkdirp(p('/home/.ssh'))
  await host.fs.writeFile(p('/home/.ssh/key'), 'needle')
  await host.fs.writeFile(p('/home/ordinary'), 'ordinary')
  const signal = new AbortController().signal
  expect(
    (await walkFiles(host.fs, p('/home/.ssh'), scope, signal)).map((file) => file.relative),
  ).toEqual(['key'])
  expect(
    (await walkFiles(host.fs, p('/home'), scope, signal)).map((file) => file.relative),
  ).toEqual(['ordinary'])
})

it('05 验收 25、26、27: answerScope accepts a decision without a confirmation card', () => {
  const result = decide({
    call: {
      tool: { name: 'Read', originalName: 'Read', source: 'builtin', serverId: 'builtin' },
      args: {},
      reversibility: 'read-only',
    },
    callReason: { reason: 'default', facts: { toolName: 'Read' } },
    inspectors: [],
    layers: {
      policy: { status: 'current', version: 'empty', snapshot: EMPTY_POLICY },
      place: 'workspace',
      reversibility: { value: 'read-only', source: 'host' },
      requiresUserInteraction: false,
      sessionGrant: null,
      approvalMode: 'manual',
    },
  })
  expect(result.confirm).toBeUndefined()
  expect(
    answerScope({
      decision: result,
      reversibility: 'read-only',
      source: 'builtin',
      toolName: 'Read',
      place: 'workspace',
    }),
  ).toBe('once')
})

it('05 验收 26、27: a failing sensitive provider without fallback fails closed', async () => {
  const { pathScopeOf } = await import('../../src/loop/batch.js')
  await expect(
    pathScopeOf(
      {
        host: createMemoryHost(),
        sessionId: '3a1d9a2e-6b3d-4a71-9f52-0c8de7a11b61',
        protectedFiles: [],
        sensitivePaths: async () => {
          throw new Error('provider failure')
        },
      },
      { folders: [p('/home')], origin: 'picked' },
    ),
  ).rejects.toThrow('provider failure')
})
