/**
 * The protected list in the loop (spec 02 §内置工具的默认档位「保护名单」「Glob、Grep 的遍历」「对话形态」,
 * §「在不在工作区里」; plan step 11: 旧 158, 旧 159, 旧 179 — their loop halves). Real Runs on the
 * memory host, with the real Read, Glob and Grep: the workspace is the home folder, which holds the
 * profile directory and a shell file, the case the spec names (所选文件夹包含 profile 目录或家目录).
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

async function harness(): Promise<Harness> {
  const memory = createMemoryHost({ identity: IDENTITY })
  for (const [path, text] of Object.entries(FILES)) {
    // oxlint-disable-next-line no-await-in-loop -- the folder before the file in it
    await memory.fs.mkdirp(absolutePath(path.slice(0, path.lastIndexOf('/'))))
    // oxlint-disable-next-line no-await-in-loop -- one file at a time
    await memory.fs.writeFile(absolutePath(path), text)
  }
  memory.symlink(absolutePath(`${HOME}/proj/rc`), `${HOME}/.zshrc`)
  const store = createMemoryTapeStore({ identity: IDENTITY })
  const provider = createScriptedProvider({ models: [MODEL] })
  const loop = createTestLoopPorts({ connector: { provider, model: MODEL } })
  const service = createTestSessionService(
    {
      host: memory,
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
