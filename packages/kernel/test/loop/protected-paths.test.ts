/**
 * The protected list in the loop (spec 02 §内置工具的默认档位「保护名单」「Glob、Grep 的遍历」「对话形态」,
 * §「在不在工作区里」; plan step 11: 旧 158, 旧 159, 旧 179 — their loop halves). Real Runs on the
 * memory host, with the real Read, Glob and Grep: the workspace is the home folder, which holds the
 * profile directory and a shell file, the case the spec names (所选文件夹包含 profile 目录或家目录).
 * Then the own spill with a link planted in its place (§「在不在工作区里」第 4 步; §大响应落盘「谁能读」).
 */
import { describe, expect, it } from 'vitest'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '../../src/index.js'
import type {
  MemoryHost,
  ModelInfo,
  PermissionDecidedPayload,
  SessionService,
  StreamEvent,
  TapeEntry,
  TapeStore,
  Usage,
} from '../../src/index.js'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '../../src/testing/index.js'
import type { ScriptedProvider, TestLoopPorts } from '../../src/testing/index.js'
import { GREP_TEXTS } from '../../src/tools/builtin/grep.js'
import { withVolfs } from '../support/volfs.js'

const HOME = '/home/u'
const PROFILE = `${HOME}/prof`
const IDENTITY = { userId: 'guard-user', tenantId: 'guard-tenant', profileDir: PROFILE }
const SESSION = '6d3e9a2e-6b3d-4a71-9f52-0c8de7a11d01'
const OTHER = '6d3e9a2e-6b3d-4a71-9f52-0c8de7a11d02'
const OWN_SPILL = `${PROFILE}/tool-output/${SESSION}`
const DEDICATED = absolutePath(`${HOME}/Tenon/workspaces/guard-user/guard-tenant/${SESSION}`)

const MODEL: ModelInfo = {
  id: 'claude-guard-1',
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

const FILES: Readonly<Record<string, string>> = {
  [`${HOME}/.zshrc`]: 'export TOKEN=SECRET-rc\n',
  [`${PROFILE}/config.json`]: '{"token":"SECRET-config"}\n',
  [`${PROFILE}/sessions.db`]: 'SECRET-sessions\n',
  [`${PROFILE}/tool-output/${OTHER}/r-1-0.txt`]: 'other session SECRET-spill\n',
  [`${OWN_SPILL}/r-1-0.txt`]: 'own SECRET-own\n',
  [`${HOME}/proj/a.ts`]: 'const x = 1\n',
}

interface Harness {
  readonly memory: MemoryHost
  readonly store: TapeStore
  readonly service: SessionService
  readonly loop: TestLoopPorts
  readonly provider: ScriptedProvider
}

/**
 * `volfs`: the host's fs also names files by number, as macOS's /.vol does (support/volfs.ts).
 * `spillLink`: the session's own spill folder is a link to this path, as an approved command could
 * leave it, and holds nothing of its own.
 */
async function harness(
  o: { readonly volfs?: Readonly<Record<string, string>>; readonly spillLink?: string } = {},
): Promise<Harness> {
  const memory = createMemoryHost({ identity: IDENTITY })
  for (const [path, text] of Object.entries(FILES)) {
    if (o.spillLink !== undefined && path.startsWith(`${OWN_SPILL}/`)) continue
    // oxlint-disable-next-line no-await-in-loop -- the folder before the file in it
    await memory.fs.mkdirp(absolutePath(path.slice(0, path.lastIndexOf('/'))))
    // oxlint-disable-next-line no-await-in-loop -- one file at a time
    await memory.fs.writeFile(absolutePath(path), text)
  }
  memory.symlink(absolutePath(`${HOME}/proj/rc`), `${HOME}/.zshrc`)
  if (o.spillLink !== undefined) memory.symlink(absolutePath(OWN_SPILL), o.spillLink)
  const store = createMemoryTapeStore({ identity: IDENTITY })
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({ connector: { provider, model: MODEL } })
  const service = createTestSessionService(
    {
      host: o.volfs === undefined ? memory : { ...memory, fs: withVolfs(memory.fs, o.volfs) },
      tape: store,
      ids: createCounterIds(),
      inspectors: [],
      connector: loop.connector,
      protectedFiles: [absolutePath(`${HOME}/.zshrc`)],
    },
    { tools: { Read: 'real', Glob: 'real', Grep: 'real' } },
  )
  service.bindLoop(loop)
  return { memory, store, service, loop, provider }
}

type Call = { readonly name: string; readonly input: Record<string, unknown> }

function reply(...calls: readonly Call[]): StreamEvent[] {
  const events: StreamEvent[] = []
  calls.forEach((call, i) => {
    const id = `toolu_${String(i)}_${call.name}`
    events.push(
      { type: 'tool-call-start', index: i + 1, id, name: call.name },
      { type: 'tool-call-end', index: i + 1, id, name: call.name, input: call.input },
    )
  })
  events.push({ type: 'usage', usage: USAGE }, stopEvent('tool-use', 'tool_use'))
  return events
}

async function runOnce(h: Harness, ...calls: readonly Call[]): Promise<string> {
  h.provider.script(reply(...calls))
  h.provider.script(scriptedTurn({ deltas: ['Done.'], usage: USAGE }))
  const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'go' })
  if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
  return (await h.loop.runEnded({ runId: sent.runId })).reason.code
}

/** Each call, in `<i>` order: its decision (null when none), its outcome and its result's text. */
async function closed(h: Harness) {
  const entries: TapeEntry[] = (await h.store.readRange({ sessionId: SESSION, limit: 1000 }))
    .entries
  const byOrdinal = (name: string) =>
    new Map(
      entries
        .filter((entry) => entry.name === name)
        .map((entry) => [entry.payload['ordinal'] as number, entry.payload]),
    )
  const decisions = byOrdinal('tool/permission_decided')
  const outcomes = byOrdinal('execution/tool_outcome')
  const results = byOrdinal('tool/result')
  return {
    entries,
    calls: [...outcomes.keys()]
      .toSorted((a, b) => a - b)
      .map((i) => {
        const decision = decisions.get(i) as unknown as PermissionDecidedPayload | undefined
        const result = results.get(i) as { isError: boolean; content: { text?: string }[] }
        return {
          decision:
            decision === undefined
              ? null
              : [decision.record.verdict, decision.record.decidedBy, decision.reversibility],
          outcome: [outcomes.get(i)?.['state'], outcomes.get(i)?.['source']],
          isError: result.isError,
          text: result.content.map((block) => block.text ?? '').join('\n'),
        }
      }),
  }
}

describe('the protected list in a task whose workspace is the home folder (旧 158, 旧 159)', () => {
  it('blocks the profile directory, other spills and the shell file without a card, and walks past them', async () => {
    const h = await harness()
    await h.service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: DEDICATED })
    expect(
      await h.service.setWorkspace({
        sessionId: SESSION,
        change: { kind: 'add', folders: [absolutePath(HOME)] },
        dedicated: DEDICATED,
      }),
    ).toMatchObject({ ok: true })
    // Allowed calls come between the blocked ones: three machine denials in a row would end the Run.
    const code = await runOnce(
      h,
      { name: 'Read', input: { file_path: `${PROFILE}/config.json` } },
      { name: 'Read', input: { file_path: `${OWN_SPILL}/r-1-0.txt` } },
      { name: 'Write', input: { file_path: `${OWN_SPILL}/new.txt`, content: 'x' } },
      { name: 'Read', input: { file_path: `${PROFILE}/tool-output/${OTHER}/r-1-0.txt` } },
      { name: 'Grep', input: { pattern: 'SECRET-config', output_mode: 'content' } },
      { name: 'Write', input: { file_path: `${HOME}/.zshrc`, content: 'x' } },
      { name: 'Write', input: { file_path: `${HOME}/proj/rc`, content: 'x' } },
      { name: 'Glob', input: { pattern: 'prof/**' } },
    )
    expect(code).toBe('completed')
    const { entries, calls } = await closed(h)
    const blocked = ['not-run', 'protected']
    expect(calls.map((call) => [call.decision, call.outcome])).toEqual([
      // The config: blocked, and its decision still records a read as read-only (旧 158).
      [['deny', 'protected', 'read-only'], blocked],
      // The session's own spill: the one narrow way in, for reading only.
      [
        ['allow', 'protected', 'read-only'],
        ['completed', null],
      ],
      [['deny', 'protected', 'unknown'], blocked],
      // Another session's spill.
      [['deny', 'protected', 'read-only'], blocked],
      // Grep over the workspace: allowed, and the config's string is not found (旧 159).
      [
        ['allow', 'user-grant', 'read-only'],
        ['completed', null],
      ],
      // The shell file, directly and through a link in the workspace.
      [['deny', 'protected', 'unknown'], blocked],
      [['deny', 'protected', 'unknown'], blocked],
      [
        ['allow', 'user-grant', 'read-only'],
        ['completed', null],
      ],
    ])
    expect(calls[1]?.text).toContain('own SECRET-own')
    expect(calls[4]).toMatchObject({ isError: false, text: GREP_TEXTS.none })
    // Glob under the profile directory lists this session's spill and nothing else there.
    expect(calls[7]?.text).toBe(`${OWN_SPILL}/r-1-0.txt`)
    // No card, no answer, so no grant of any kind.
    expect(h.memory.confirmRequests).toEqual([])
    expect(entries.filter((entry) => entry.name === 'tool/approval_resolved')).toEqual([])
  })
})

describe('the shell file in another case, in a task whose workspace is the home folder', () => {
  // The file is missing in that spelling, which it keeps (§「在不在工作区里」 step 2); on a
  // case-insensitive volume the write would land on the protected file, so the compare folds case.
  it('blocks the Write without a card, as it blocks the file itself', async () => {
    const h = await harness()
    await h.service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: DEDICATED })
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [absolutePath(HOME)] },
      dedicated: DEDICATED,
    })
    const code = await runOnce(
      h,
      { name: 'Write', input: { file_path: `${HOME}/.ZSHRC`, content: 'x' } },
      { name: 'Read', input: { file_path: `${HOME}/proj/a.ts` } },
      { name: 'Write', input: { file_path: `${HOME}/.ZshRc`, content: 'x' } },
    )
    expect(code).toBe('completed')
    const blocked = [
      ['deny', 'protected', 'unknown'],
      ['not-run', 'protected'],
    ]
    expect((await closed(h)).calls.map((call) => [call.decision, call.outcome])).toEqual([
      blocked,
      [
        ['allow', 'user-grant', 'read-only'],
        ['completed', null],
      ],
      blocked,
    ])
    expect(h.memory.confirmRequests).toEqual([])
    expect(await h.memory.fs.stat(absolutePath(`${HOME}/.ZSHRC`))).toBeNull()
  })
})

describe('a path the host finds but cannot name, in a task (owner 2026-09-27, s11-safety-2)', () => {
  // §「在不在工作区里」 step 2: realpath cannot name a /.vol path, so nothing can be compared with the
  // protected list. It is blocked like the list — not placed outside, where a card would offer allow.
  it('blocks the volfs names of a workspace file, the shell file and the config without a card', async () => {
    const h = await harness({
      volfs: {
        '10': `${HOME}/proj`,
        '11': `${HOME}/proj/a.ts`,
        '12': `${HOME}/.zshrc`,
        '13': `${PROFILE}/config.json`,
      },
    })
    await h.service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: DEDICATED })
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [absolutePath(`${HOME}/proj`)] },
      dedicated: DEDICATED,
    })
    // An allowed read between the blocked ones: three machine denials in a row would end the Run.
    const read = { name: 'Read', input: { file_path: `${HOME}/proj/a.ts` } }
    const code = await runOnce(
      h,
      { name: 'Read', input: { file_path: '/.vol/1/11' } },
      read,
      { name: 'Read', input: { file_path: '/.vol/1/12' } },
      read,
      { name: 'Read', input: { file_path: '/.vol/1/13' } },
      read,
      { name: 'Write', input: { file_path: '/.vol/1/10/new.txt', content: 'x' } },
    )
    expect(code).toBe('completed')
    const { entries, calls } = await closed(h)
    const blocked = ['not-run', 'protected']
    const allowed = [
      ['allow', 'user-grant', 'read-only'],
      ['completed', null],
    ]
    expect(calls.map((call) => [call.decision, call.outcome])).toEqual([
      [['deny', 'protected', 'read-only'], blocked],
      allowed,
      [['deny', 'protected', 'read-only'], blocked],
      allowed,
      [['deny', 'protected', 'read-only'], blocked],
      allowed,
      [['deny', 'protected', 'unknown'], blocked],
    ])
    // The block names the path as the model wrote it, normalised: the only name there is.
    const targets = entries
      .filter((entry) => entry.name === 'tool/permission_decided')
      .map((entry) => (entry.payload as unknown as PermissionDecidedPayload).block)
      .filter((block) => block !== undefined)
    expect(targets).toEqual([
      { reason: 'protected', facts: { toolName: 'Read', target: '/.vol/1/11' } },
      { reason: 'protected', facts: { toolName: 'Read', target: '/.vol/1/12' } },
      { reason: 'protected', facts: { toolName: 'Read', target: '/.vol/1/13' } },
      { reason: 'protected', facts: { toolName: 'Write', target: '/.vol/1/10/new.txt' } },
    ])
    expect(calls[2]?.text).toContain('/.vol/1/12')
    expect(calls.some((call) => call.text.includes('SECRET'))).toBe(false)
    // No card, no answer, so no grant of any kind.
    expect(h.memory.confirmRequests).toEqual([])
    expect(entries.filter((entry) => entry.name === 'tool/approval_resolved')).toEqual([])
  })
})

describe('a walk rooted outside the workspace, allowed on its card (旧 159; §内置工具的默认档位)', () => {
  // The protected list has no way to be allowed: an `outside-workspace` card lets the walk run, and
  // the walk still skips what the list holds (「保护名单…直接拦下，不给放行入口」).
  it.each([
    [
      'Grep',
      { pattern: 'SECRET', output_mode: 'content', path: HOME },
      `${OWN_SPILL}/r-1-0.txt:1:own SECRET-own`,
    ],
    ['Glob', { pattern: '**', path: HOME }, `${OWN_SPILL}/r-1-0.txt\n${HOME}/proj/a.ts`],
  ])('%s over the home folder finds nothing the list holds', async (name, input, text) => {
    const h = await harness()
    await h.service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: DEDICATED })
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [absolutePath(`${HOME}/proj`)] },
      dedicated: DEDICATED,
    })
    h.provider.script(reply({ name, input }))
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'go' })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    expect((await h.loop.runEnded({ runId: sent.runId })).reason.code).toBe('paused')
    const pending = await h.service.currentPending({ sessionId: SESSION })
    expect(pending?.card.reason).toBe('outside-workspace')
    h.provider.script(scriptedTurn({ deltas: ['Done.'], usage: USAGE }))
    expect(
      await h.service.answer({
        kind: 'approval',
        sessionId: SESSION,
        requestId: pending?.card.requestId ?? '',
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'applied' })
    expect((await h.loop.runEnded()).reason.code).toBe('completed')
    const { calls } = await closed(h)
    expect(calls).toEqual([
      {
        decision: ['ask', 'default', 'read-only'],
        outcome: ['completed', null],
        isError: false,
        text,
      },
    ])
  })
})

describe('the chat profile reads only its own spill (旧 179)', () => {
  it('reads there without a card, and blocks everything else at the call, the way back up included', async () => {
    const h = await harness()
    const code = await runOnce(
      h,
      { name: 'Read', input: { file_path: `${OWN_SPILL}/r-1-0.txt` } },
      { name: 'Read', input: { file_path: `${OWN_SPILL}/../config.json` } },
      { name: 'Read', input: { file_path: `${HOME}/proj/a.ts` } },
    )
    expect(code).toBe('completed')
    const { calls } = await closed(h)
    expect(calls.map((call) => [call.decision, call.outcome, call.isError])).toEqual([
      [['allow', 'protected', 'read-only'], ['completed', null], false],
      [['deny', 'protected', 'read-only'], ['not-run', 'protected'], true],
      [['deny', 'protected', 'read-only'], ['not-run', 'protected'], true],
    ])
    expect(calls[0]?.text).toContain('own SECRET-own')
    expect(calls[1]?.text).toContain(`${PROFILE}/tool-output/config.json`)
    // Never a card, and never outside-workspace: nothing reaches HostConfirm.
    expect(h.memory.confirmRequests).toEqual([])
  })
})

describe('a link planted in place of the own spill folder (§「在不在工作区里」第 4 步; §大响应落盘「谁能读」)', () => {
  // The own spill is tool-output/<id> under the profile, as written: what a link there leads to is
  // placed where it lands, and never gets the spill's free read — the one narrow way in.
  const LINKS = [
    ['the Tape', `${PROFILE}/sessions.db`, OWN_SPILL],
    ['another session’s spill', `${PROFILE}/tool-output/${OTHER}`, `${OWN_SPILL}/r-1-0.txt`],
    ['the shell file', `${HOME}/.zshrc`, OWN_SPILL],
  ] as const

  it.each(LINKS)(
    'blocks a Read and a Glob through a link to %s without a card, in a task',
    async (_what, target, read) => {
      const h = await harness({ spillLink: target })
      await h.service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: DEDICATED })
      await h.service.setWorkspace({
        sessionId: SESSION,
        change: { kind: 'add', folders: [absolutePath(`${HOME}/proj`)] },
        dedicated: DEDICATED,
      })
      const code = await runOnce(
        h,
        { name: 'Read', input: { file_path: read } },
        { name: 'Glob', input: { pattern: '**', path: OWN_SPILL } },
      )
      expect(code).toBe('completed')
      const { calls } = await closed(h)
      const blocked = [
        ['deny', 'protected', 'read-only'],
        ['not-run', 'protected'],
      ]
      expect(calls.map((call) => [call.decision, call.outcome])).toEqual([blocked, blocked])
      expect(calls.some((call) => call.text.includes('SECRET'))).toBe(false)
      expect(h.memory.confirmRequests).toEqual([])
    },
  )

  it('asks for a Read through a link to a folder outside, as it would for that folder', async () => {
    const h = await harness({ spillLink: '/srv/shared' })
    await h.memory.fs.mkdirp(absolutePath('/srv/shared'))
    await h.memory.fs.writeFile(absolutePath('/srv/shared/notes.txt'), 'SECRET-shared\n')
    await h.service.selectProfile({ sessionId: SESSION, profile: 'cowork', dedicated: DEDICATED })
    await h.service.setWorkspace({
      sessionId: SESSION,
      change: { kind: 'add', folders: [absolutePath(`${HOME}/proj`)] },
      dedicated: DEDICATED,
    })
    h.provider.script(reply({ name: 'Read', input: { file_path: `${OWN_SPILL}/notes.txt` } }))
    const sent = await h.service.send({ sessionId: SESSION, origin: null, text: 'go' })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    expect((await h.loop.runEnded({ runId: sent.runId })).reason.code).toBe('paused')
    const pending = await h.service.currentPending({ sessionId: SESSION })
    expect(pending?.card.reason).toBe('outside-workspace')
    expect(pending?.card.target).toEqual({ type: 'path', path: '/srv/shared/notes.txt' })
  })

  it.each(LINKS)(
    'blocks a Read through a link to %s in the chat profile',
    async (_what, target, read) => {
      const h = await harness({ spillLink: target })
      expect(await runOnce(h, { name: 'Read', input: { file_path: read } })).toBe('completed')
      const { calls } = await closed(h)
      expect(calls.map((call) => [call.decision, call.outcome, call.isError])).toEqual([
        [['deny', 'protected', 'read-only'], ['not-run', 'protected'], true],
      ])
      expect(calls.some((call) => call.text.includes('SECRET'))).toBe(false)
      expect(h.memory.confirmRequests).toEqual([])
    },
  )
})
