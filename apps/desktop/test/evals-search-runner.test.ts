/** The eval wrapper must preserve search target binding through an actual approval and resume. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SearchBackend, TapeEntry } from '@tenon-app/kernel'
import { afterEach, expect, it, vi } from 'vitest'
import { readAll } from '../evals/cost.js'
import { fakeSearchBackend } from '../evals/host.js'
import type * as EvalHostModule from '../evals/host.js'
import type * as AssemblyModule from '../src/main/run-assembly.js'
import { EVAL_GLM_53_ANTHROPIC } from '../evals/models.js'
import { runTask } from '../evals/runner.js'
import { startFakeAnthropic } from './support/fake-anthropic.js'

const state = vi.hoisted(() => ({
  hook: null as SearchBackend | null,
  inner: null as SearchBackend | null,
  target:
    vi.fn<
      (
        providerId: string,
        query: string,
      ) => { host: SearchBackend['host']; query: string; truncated: boolean } | null
    >(),
}))

// The conversation uses the real desktop connector against a localhost SSE server. Only the
// search transport is replaced, so neither branch can contact a real search service.
vi.mock('../evals/host.js', async (load) => {
  const actual = await load<typeof EvalHostModule>()
  return {
    ...actual,
    createEvalHost: async (...args: Parameters<typeof actual.createEvalHost>) => ({
      ...(await actual.createEvalHost(...args)),
      search: state.hook,
    }),
  }
})
vi.mock('../src/main/run-assembly.js', async (load) => {
  const actual = await load<typeof AssemblyModule>()
  return {
    ...actual,
    createRunConnector: (...args: Parameters<typeof actual.createRunConnector>) => {
      const inner = actual.createRunConnector(...args)
      return {
        ...inner,
        searchTarget: state.target,
        assemble: async (...query: Parameters<typeof inner.assemble>) => ({
          ...(await inner.assemble(...query)),
          search: state.inner,
        }),
      }
    },
  }
})

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const clean of cleanup.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- release each local server and fixture in order
    await clean()
  }
  state.hook = null
  state.inner = null
  state.target.mockReset()
})

it.each([true, false])(
  'approves the bound query and sends successful search results to the model (fake hook=%s)',
  async (useHook) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tenon-eval-search-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'workspace'))
    writeFileSync(join(root, 'workspace', 'notes.txt'), 'fixed\n')
    const query = '🚉'.repeat(75)
    const prepared = '🚉'.repeat(70)
    const hit = { title: 'offline binding evidence', url: 'https://example.test/evidence' }
    const backend = fakeSearchBackend([hit], 'open.bigmodel.cn')
    const search = vi.fn<SearchBackend['search']>(backend.search)
    const recording = { ...backend, search }
    state.hook = useHook ? recording : null
    state.inner = useHook ? null : recording
    // A fake hook must take precedence even over an incompatible underlying provider target.
    state.target.mockImplementation((_providerId: string, raw: string) =>
      useHook
        ? { host: 'api.anthropic.com', query: raw, truncated: false }
        : { host: backend.host, ...backend.prepareQuery(raw) },
    )
    const server = await startFakeAnthropic({
      delayMs: 1,
      replies: [
        { steps: [{ type: 'tool_use', id: 'search_1', name: 'WebSearch', input: { query } }] },
        { steps: [{ type: 'text', text: 'Search received.' }] },
      ],
    })
    cleanup.push(() => server.close())
    let facts: TapeEntry[] = []
    let cards: unknown[] = []
    const record = await runTask({
      task: {
        id: '08-search-binding',
        profile: 'cowork',
        workspace: 'workspace',
        turns: ['Search for the station.'],
        host: { answers: { network: 'allow' } },
        checks: [{ kind: 'script', id: 'notes-fixed' }],
        from: ['H8', 'H15'],
      },
      run: 1,
      column: {
        providerId: 'anthropic',
        modelId: EVAL_GLM_53_ANTHROPIC.id,
        baseURL: server.baseURL,
        keyEnv: 'ZHIPU_API_KEY',
        keyFromProcessOnly: false,
        effort: null,
      },
      key: 'offline-search-fixture',
      date: '2026-09-28',
      clientVersion: 'test-version',
      fixturesDir: root,
      checksDir: join(import.meta.dirname, 'support', 'eval-checks'),
      runWaitMs: 5000,
      deadlineMs: 10000,
      inspect: async (run) => {
        facts = await readAll(run.tape, run.sessionId)
        cards = [...run.cards]
      },
    })
    expect(record.verdict).toBe('pass')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      reason: 'network',
      target: { type: 'search', host: backend.host, query: prepared },
    })
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0]?.[0]).toMatchObject({ query: prepared })
    expect(facts.filter((entry) => entry.name === 'tool/approval_resolved')).toHaveLength(1)
    expect(facts.find((entry) => entry.name === 'tool/approval_resolved')?.payload).toMatchObject({
      outcome: 'allowed',
    })
    expect(facts.find((entry) => entry.name === 'tool/result')?.payload).toMatchObject({
      isError: false,
    })
    expect(server.requests).toHaveLength(2)
    const body = server.requests[1]?.body as {
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    const result = body.messages
      .flatMap((message) => message.content)
      .find((block) => block['type'] === 'tool_result' && block['tool_use_id'] === 'search_1')
    expect(result).toMatchObject({ is_error: false })
    expect(JSON.stringify(result)).toContain(hit.title)
    expect(JSON.stringify(result)).toContain(hit.url)
    const forwarded = expect.arrayContaining([['anthropic', query]])
    expect(state.target.mock.calls).toEqual(useHook ? [] : forwarded)
  },
)
