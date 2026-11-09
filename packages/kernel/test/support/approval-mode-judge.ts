/** Host inputs for spec 06 decisions, also used to capture the pre-06 manual baseline. */
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createTape,
} from '../../src/index.js'
import type { SandboxPosture, SnapshotCoverage, SnapshotStatus } from '../../src/index.js'
import type { JudgeContext } from '../../src/loop/batch.js'
import { judgeCall } from '../../src/loop/batch.js'
import { grantKey } from '../../src/permission/grants.js'
import {
  approvalResolvedKey,
  permissionDecidedKey,
  profileSetKey,
  sessionStartKey,
  workspaceSetKey,
} from '../../src/tape/provenance.js'

export const MODE_SESSION = '11111111-1111-4111-8111-111111111111'
const INC = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'
export const MODE_WORK = absolutePath('/work')

export interface ManualFixture {
  name: string
  source?: 'builtin' | 'mcp'
  path?: string
  sensitive?: boolean
  coverage?: SnapshotCoverage
  grant?: boolean
  posture?: SandboxPosture['state']
  profile?: 'read-only' | 'workspace-write'
  snapshotStatus: SnapshotStatus
  platform: 'yes' | 'linux' | 'no' | 'missing-query' | 'missing-port'
  command?: string
  policy?: 'ask' | 'deny' | 'disable-auto'
}

export async function modeJudgeFixture(query: ManualFixture, mode: 'manual' | 'auto' = 'auto') {
  const memory = createMemoryHost()
  await memory.fs.mkdirp(MODE_WORK)
  await memory.fs.mkdirp(absolutePath('/outside'))
  await memory.fs.writeFile(absolutePath('/work/a'), 'before')
  await memory.fs.writeFile(absolutePath('/outside/a'), 'outside')
  memory.snapshots.setStatus(MODE_SESSION, query.snapshotStatus)
  if (query.coverage !== undefined) memory.snapshots.coverage = async () => query.coverage!
  const host = {
    ...memory,
    sandbox: {
      wrap: memory.sandbox.wrap.bind(memory.sandbox),
      afterExit: memory.sandbox.afterExit.bind(memory.sandbox),
      violations: memory.sandbox.violations.bind(memory.sandbox),
      ...(query.posture === undefined
        ? {}
        : {
            posture: () => ({ state: query.posture!, profile: query.profile ?? 'workspace-write' }),
          }),
    },
  }
  const source = query.source ?? 'builtin'
  const serverId = source === 'builtin' ? 'builtin' : 'fixture-server'
  if (query.policy !== undefined)
    memory.setPolicy({
      status: 'current',
      version: query.policy,
      snapshot: {
        tools:
          query.policy === 'disable-auto'
            ? []
            : [
                {
                  policyId: 'fixture-policy',
                  serverId,
                  toolName: query.name,
                  effect: query.policy,
                },
              ],
        ...(query.policy === 'disable-auto' ? { disableAutoMode: true } : {}),
      },
    })
  const tape = createTape(createMemoryTapeStore({ identity: host.identity }))
  await tape.appendEntries({
    sessionId: MODE_SESSION,
    incarnationId: INC,
    entries: [
      tape.writer('session').entry('session/start', {
        sourceType: 'session',
        sourceId: MODE_SESSION,
        sourceSeq: 0,
        provenanceKey: sessionStartKey(INC),
        payload: { incarnationId: INC },
        createdAt: 0,
      }),
      tape.writer('session').entry('session/profile_set', {
        sourceType: 'session',
        sourceId: MODE_SESSION,
        provenanceKey: profileSetKey(INC),
        payload: { profile: 'cowork' },
        createdAt: 0,
      }),
      tape.writer('session').entry('session/workspace_set', {
        sourceType: 'session',
        sourceId: MODE_SESSION,
        sourceSeq: 0,
        provenanceKey: workspaceSetKey(INC, 0),
        payload: { folders: [MODE_WORK], origin: 'dedicated' },
        createdAt: 0,
      }),
    ],
  })
  let modeFacts = 0
  const setMode = async (approvalMode: 'manual' | 'auto') => {
    await tape.appendEntries({
      sessionId: MODE_SESSION,
      incarnationId: INC,
      entries: [
        tape.writer('session').entry('session/approval_mode_set', {
          sourceType: 'session',
          sourceId: MODE_SESSION,
          sourceSeq: modeFacts,
          provenanceKey: `session:v1:approval_mode:${INC}:${modeFacts}`,
          payload: { mode: approvalMode, by: 'user', writer: { by: 'resolver' } },
          createdAt: 0,
        }),
      ],
    })
    modeFacts++
  }
  if (mode === 'auto') await setMode(mode)
  const path = absolutePath(query.path ?? '/work/a')
  const command = query.command ?? 'echo stable'
  if (query.grant) {
    const key = permissionDecidedKey(RUN, 0, 0)
    await tape.appendEntries({
      sessionId: MODE_SESSION,
      incarnationId: INC,
      entries: [
        tape.writer('tool').entry('tool/permission_decided', {
          sourceType: 'runtime_event',
          sourceId: RUN,
          sourceSeq: 0,
          provenanceKey: key,
          createdAt: 0,
          payload: {
            ordinal: 0,
            providerToolCallId: 'previous',
            argsHash: 'fixture-hash',
            reversibility: 'unknown',
            record: { verdict: 'ask', decidedBy: 'approval-mode', steps: [] },
            summary: { verdict: 'ask', code: 'default-ask', facts: { toolName: query.name } },
            policyVersion: 'empty',
            writer: { by: 'run', runId: RUN },
          },
        }),
        tape.writer('tool').entry('tool/approval_resolved', {
          sourceType: 'runtime_event',
          sourceId: RUN,
          sourceSeq: 0,
          provenanceKey: approvalResolvedKey(RUN, 0, 0),
          createdAt: 0,
          payload: {
            ordinal: 0,
            providerToolCallId: 'previous',
            decisionKey: key,
            outcome: 'allowed',
            via: 'card',
            grant: {
              scope: 'session',
              key: grantKey(
                serverId,
                query.name,
                query.name === 'Bash'
                  ? { kind: 'command', command, cwd: MODE_WORK }
                  : { kind: 'file', path },
              ),
            },
            writer: { by: 'run', runId: RUN },
          },
        }),
      ],
    })
  }
  const item = {
    name: query.name,
    originalName: query.name,
    source,
    serverId,
    requiresUserInteraction: false,
    spec: { name: query.name, description: '', inputSchema: { type: 'object' } },
  }
  const sandbox =
    query.platform === 'missing-port'
      ? undefined
      : {
          beforeWrap: () => {},
          grantsChanged: () => {},
          ...(['yes', 'linux', 'no'].includes(query.platform)
            ? { autoCommands: () => query.platform as 'yes' | 'linux' | 'no' }
            : {}),
        }
  const ctx: JudgeContext = {
    host,
    tape,
    sessionId: MODE_SESSION,
    inspectors: [],
    protectedFiles: [],
    userSetting: () => null,
    searchHost: 'search.example.com',
    signal: new AbortController().signal,
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(query.sensitive
      ? { sensitivePaths: async () => ({ credential: [path], autoRunNames: [], linkTargets: [] }) }
      : {}),
  }
  const input =
    query.name === 'Bash'
      ? { command }
      : query.name === 'WebFetch'
        ? { url: 'https://example.com/page' }
        : query.name === 'WebSearch'
          ? { query: 'fixture' }
          : { file_path: path, path, content: 'after', old_string: 'before', new_string: 'after' }
  const judge = async (over: Partial<JudgeContext> = {}) => {
    const result = await judgeCall({ ...ctx, ...over }, item, { input })
    if (result.kind !== 'judged') throw new Error('fixture judgement stopped')
    return result
  }
  return { memory, host, tape, ctx, judge, setMode }
}
