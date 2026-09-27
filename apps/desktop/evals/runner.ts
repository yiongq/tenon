/**
 * The eval runner (spec 02 §评测集与测试宿主, §记录格式与费用口径, §同题对比; H15, M8, D7): one task,
 * one run, one `EvalRecord`.
 *
 * A run is the product's path with the test host under it. The Run connector is the desktop's own
 * (`createRunConnector`, run-assembly.ts) over the runner's provider registry (models.ts adds the
 * eval-only row), reading `config.json` and the secrets as the settings card leaves them: the
 * column's provider and model chosen, its base URL saved beside its key — so the key-bound-host check
 * (A9) runs before every send as it does for a user. No development fallback is read (`env: {}`),
 * so nothing in the runner's shell can redirect a request. The loop's host half is the desktop's
 * (`createDesktopLoop`); the kernel service is the product's, with H11's token limit only when the
 * task sets `usageLimitTokens` (`createEvalSessionService`).
 *
 * Each turn is sent as a user message; a Run that pauses on a card is answered by the host
 * (host.ts's `autoAnswer`), one that pauses on a question has it skipped, and the next turn goes when
 * the chain of Runs ends. Then the task's script checks run against the Tape, and the record is built
 * from the Tape and from what the host saw. The key is handed in by the caller, which read it inside
 * the eval process; it goes to the memory secrets and nowhere else, and no line of a record, a note
 * or a log names more than its variable.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  PROMPT_LAYER_HASH,
  PROMPT_LAYER_VERSION,
  createMemoryTapeStore,
  toolCallKey,
} from '@tenon-app/kernel'
import type {
  AnswerCommand,
  ConfirmRequest,
  Provider,
  RunConnector,
  SearchBackend,
  SessionEvent,
  SessionService,
  StreamEvent,
  TapeEntry,
  TapeStore,
} from '@tenon-app/kernel'
import { createEvalSessionService } from '@tenon-app/kernel/testing'
import { createDesktopLoop } from '../src/main/chat.js'
import { writeConfig } from '../src/main/host/profile.js'
import { desktopInspectors } from '../src/main/inspectors.js'
import { localDateOf } from '../src/main/locale.js'
import { providerSecretKey } from '../src/main/provider.js'
import { createRunConnector } from '../src/main/run-assembly.js'
import { protectedShellFiles } from '../src/main/workspace.js'
import { readAll, tapeCost } from './cost.js'
import { autoAnswer, createEvalHost, disabledToolPolicy } from './host.js'
import type { EvalHost } from './host.js'
import { CHECKS_DIR, loadCheck } from './load-check.js'
import { columnSlug, endpointOf, evalProviderRegistry, readKey, resolveColumn } from './models.js'
import type { EnvRecord, EvalColumn } from './models.js'
import type { EvalRecord } from './record.js'
import { evalRecordSchema } from './record.js'
import type { EvalTask } from './task.js'
import { EVALS_DOCS_DIR } from './task.js'
import { taskSetProblems } from './format.js'

export const FIXTURES_DIR = join(EVALS_DOCS_DIR, 'fixtures')
export const TASKS_DIR = join(EVALS_DOCS_DIR, 'tasks')
export const RESULTS_DIR = join(EVALS_DOCS_DIR, 'results')

/** The machine denials of §原因码表 (「拦截」): what F2's cap counts. */
const BLOCK_SOURCES: ReadonlySet<string> = new Set([
  'policy',
  'user-disabled',
  'protected',
  'inspector',
])

/** How long one Run may take before the runner stops it and records the task as not finished. */
export const RUN_WAIT_MS = 15 * 60_000

export interface RunTaskOptions {
  readonly task: EvalTask
  /** 1-based, within this invocation. */
  readonly run: number
  readonly column: EvalColumn
  /** Read by the caller inside the eval process (models.ts `readKey`); never written anywhere. */
  readonly key: string
  /** The record's date, YYYY-MM-DD. */
  readonly date: string
  readonly clientVersion: string
  /** Record `timing` (a speed run, like flashx's). */
  readonly timing?: boolean
  readonly fixturesDir?: string
  readonly checksDir?: string
  /** The interface language the kernel's language hint names. The owner's: zh-CN. */
  readonly locale?: 'zh-CN' | 'en'
  readonly runWaitMs?: number
  readonly runnerEnv?: EnvRecord
  readonly log?: (line: string) => void
  /** Called after the checks, before the run's directory is removed: what a test reads the run by. */
  readonly inspect?: (run: RunInspection) => Promise<void> | void
}

/** A finished run as `inspect` sees it: the check context, plus the run's directory. */
export interface RunInspection {
  readonly tape: TapeStore
  readonly sessionId: string
  readonly workspaceDir: string
  readonly cards: readonly ConfirmRequest[]
  readonly dir: string
  readonly fetched: readonly string[]
}

type RunEnded = Extract<SessionEvent, { type: 'run-ended' }>

/** One attempt's clock readings, for `timing`. */
interface TimingSample {
  readonly start: number
  first: number | null
  end: number | null
  output: number
}

/** What the runner sees of the loop while a task runs. */
class Watch {
  readonly ended: RunEnded[] = []
  /** Every batch with a closed call, as `<runId>:<requestSeq>`: the rounds done so far. */
  readonly rounds = new Set<string>()
  #wake: (() => void) | null = null
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  event(e: SessionEvent): void {
    if (e.rootSessionId !== this.#root) return
    if (e.type === 'tool-outcome') this.rounds.add(e.callKey.slice(0, e.callKey.lastIndexOf(':')))
    if (e.type === 'run-ended' && e.sessionId === this.#root) {
      this.ended.push(e)
      this.#wake?.()
    }
  }

  /** The `index`-th run-ended of the root, or null once `ms` passed without it. */
  async nth(index: number, ms: number): Promise<RunEnded | null> {
    const deadline = performance.now() + ms
    while (this.ended.length <= index) {
      const left = deadline - performance.now()
      if (left <= 0) return null
      // oxlint-disable-next-line no-await-in-loop -- woken by the next run-ended, or by the deadline
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.#wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.#wake = null
    }
    return this.ended[index] ?? null
  }
}

/**
 * The desktop's connector, seen through: the fake search backend of a `web` task goes into the
 * assembly, and each request passes `beforeStream` — where `disableTool` swaps the policy — and, for a
 * speed run, a clock.
 */
function watchedConnector(
  inner: RunConnector,
  hooks: {
    readonly search: SearchBackend | null
    readonly beforeStream: () => void
    readonly timing: TimingSample[] | null
  },
): RunConnector {
  return {
    endpointOrigin: (providerId) => inner.endpointOrigin(providerId),
    resolveChoice: (q) => inner.resolveChoice(q),
    async assemble(q) {
      const assembly = await inner.assemble(q)
      let provider: Provider | null = null
      return {
        ...assembly,
        search: hooks.search ?? assembly.search,
        provider: () => (provider ??= watchedProvider(assembly.provider(), hooks)),
      }
    },
  }
}

function watchedProvider(
  provider: Provider,
  hooks: { readonly beforeStream: () => void; readonly timing: TimingSample[] | null },
): Provider {
  return new Proxy(provider, {
    get(target, property) {
      if (property === 'stream') {
        return (...args: Parameters<Provider['stream']>): AsyncIterable<StreamEvent> => {
          hooks.beforeStream()
          const events = target.stream(...args)
          return hooks.timing === null ? events : timed(events, hooks.timing)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value
    },
  })
}

async function* timed(
  events: AsyncIterable<StreamEvent>,
  samples: TimingSample[],
): AsyncIterable<StreamEvent> {
  const sample: TimingSample = { start: performance.now(), first: null, end: null, output: 0 }
  samples.push(sample)
  for await (const event of events) {
    if (
      sample.first === null &&
      (event.type === 'text-delta' ||
        event.type === 'thinking-delta' ||
        event.type === 'tool-call-start')
    ) {
      sample.first = performance.now()
    }
    if (event.type === 'usage') sample.output = event.usage.outputTokens
    yield event
  }
  sample.end = performance.now()
}

/** `timing` over the attempts that produced anything: the first's TTFT, output tokens per second. */
function timingOf(samples: readonly TimingSample[]): EvalRecord['timing'] {
  const done = samples.filter(
    (s): s is TimingSample & { first: number; end: number } => s.first !== null && s.end !== null,
  )
  const first = done[0]
  if (first === undefined) return undefined
  const seconds = done.reduce((sum, s) => sum + (s.end - s.first) / 1000, 0)
  const output = done.reduce((sum, s) => sum + s.output, 0)
  return {
    ttftMs: Math.round(first.first - first.start),
    outputTokensPerSec: seconds > 0 ? Math.round((output / seconds) * 10) / 10 : 0,
  }
}

/** The answer that skips every question of the call a root waits on, or null when none waits. */
async function skipQuestions(store: TapeStore): Promise<AnswerCommand | null> {
  const [row] = await store.listPendingApprovals({ limit: 1 })
  if (row?.waitKind !== 'question') return null
  const entries = await readAll(store, row.sessionId)
  const decision = entries.find((entry) => entry.entryId === row.entryId)
  const call = entries.find(
    (entry) => entry.provenanceKey === toolCallKey(row.runId, row.requestSeq, row.callOrdinal),
  )
  const input = call?.payload['input'] as { questions?: { question?: unknown }[] } | undefined
  if (decision === undefined) return null
  const answers: Record<string, null> = {}
  for (const q of input?.questions ?? [])
    if (typeof q.question === 'string') answers[q.question] = null
  return { kind: 'question', sessionId: row.sessionId, requestId: decision.provenanceKey, answers }
}

/** Sends each turn and answers what its Runs pause on; the notes say what did not go to plan. */
async function driveTurns(o: {
  readonly task: EvalTask
  readonly sessionId: string
  readonly sessions: SessionService
  readonly store: TapeStore
  readonly watch: Watch
  readonly waitMs: number
}): Promise<string[]> {
  const { task, sessionId, sessions, store, watch } = o
  const notes: string[] = []
  let seen = 0
  for (const [turn, text] of task.turns.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- turns go one after another, as a user sends them
    const sent = await sessions.send({ sessionId, origin: null, text })
    // `queued`: the last Run's lease was still settling; the kernel sends it when that Run is done.
    if (sent.status !== 'started' && sent.status !== 'queued') {
      notes.push(`turn ${String(turn + 1)} not sent: ${JSON.stringify(sent)}`)
      return notes
    }
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one Run of the chain after another
      const ended = await watch.nth(seen, o.waitMs)
      if (ended === null) {
        notes.push(
          `turn ${String(turn + 1)}: a Run did not end within ${String(o.waitMs)} ms; stopped`,
        )
        // oxlint-disable-next-line no-await-in-loop -- the stop, then its Run's end
        await sessions.stop({ rootSessionId: sessionId })
        // oxlint-disable-next-line no-await-in-loop -- the stopped Run ends before the record is read
        await watch.nth(seen, 10_000)
        return notes
      }
      seen += 1
      if (ended.reason.code !== 'paused') break
      let answer: AnswerCommand | null = null
      if (ended.reason.waitingFor === 'approval') {
        // oxlint-disable-next-line no-await-in-loop -- the card this Run paused on
        const pending = await sessions.currentPending({ sessionId })
        if (pending !== null) {
          answer = {
            kind: 'approval',
            sessionId: pending.card.sessionId,
            requestId: pending.card.requestId,
            decision: autoAnswer(pending.card.reason, task),
          }
        }
      } else if (ended.reason.waitingFor === 'question') {
        // oxlint-disable-next-line no-await-in-loop -- the question this Run paused on
        answer = await skipQuestions(store)
      }
      if (answer === null) {
        notes.push(
          `turn ${String(turn + 1)}: paused on ${ended.reason.waitingFor}, nothing to answer`,
        )
        return notes
      }
      // oxlint-disable-next-line no-await-in-loop -- the answer opens the next Run of the chain
      const result = await sessions.answer({ ...answer, origin: null })
      if (result.status !== 'applied') {
        notes.push(`turn ${String(turn + 1)}: answer ${result.status}`)
        return notes
      }
    }
  }
  return notes
}

/** Runs a task's script checks; a check that throws fails with what it threw. */
async function runChecks(o: {
  readonly task: EvalTask
  readonly checksDir: string
  readonly ctx: Parameters<Awaited<ReturnType<typeof loadCheck>>>[0]
}): Promise<{ id: string; pass: boolean; note: string }[]> {
  const results: { id: string; pass: boolean; note: string }[] = []
  for (const check of o.task.checks) {
    if (check.kind !== 'script') continue
    try {
      // oxlint-disable-next-line no-await-in-loop -- checks one after another, on the same Tape
      const run = await loadCheck(check.id, o.checksDir)
      // oxlint-disable-next-line no-await-in-loop -- same
      results.push({ id: check.id, ...(await run(o.ctx)) })
    } catch (error) {
      results.push({ id: check.id, pass: false, note: `threw: ${messageOf(error)}` })
    }
  }
  return results
}

export async function runTask(o: RunTaskOptions): Promise<EvalRecord> {
  const { task, column } = o
  const log = o.log ?? ((): void => {})
  const sessionId = randomUUID()
  const evalHost = await createEvalHost({
    task,
    sessionId,
    fixturesDir: o.fixturesDir ?? FIXTURES_DIR,
    baseURL: column.baseURL,
    log,
    ...(o.runnerEnv === undefined ? {} : { runnerEnv: o.runnerEnv }),
  })
  try {
    return await runOn(evalHost, sessionId, o, log)
  } finally {
    evalHost.dispose()
  }
}

async function runOn(
  evalHost: EvalHost,
  sessionId: string,
  o: RunTaskOptions,
  log: (line: string) => void,
): Promise<EvalRecord> {
  const { task, column } = o
  const host = evalHost.adapter
  // The column as the settings card leaves it: provider and model chosen, the base URL saved with
  // the key it is bound to.
  const config = await writeConfig(host.fs, host.identity, {
    provider: { id: column.providerId, modelId: column.modelId },
    providerConfig: { [column.providerId]: { baseURL: column.baseURL } },
  })
  await evalHost.secrets.set(providerSecretKey(host, column.providerId, 'apiKey'), o.key)
  const store = createMemoryTapeStore({ identity: host.identity })
  const watch = new Watch(sessionId)
  const disable = task.host?.disableTool
  let disabled = false
  const samples: TimingSample[] | null = o.timing === true ? [] : null
  const connector = watchedConnector(
    createRunConnector({ host, providers: evalProviderRegistry(), env: {}, log, config }),
    {
      search: evalHost.search,
      beforeStream: () => {
        if (disable !== undefined && !disabled && watch.rounds.size >= disable.afterRound) {
          evalHost.policy.set(disabledToolPolicy(disable.name))
          disabled = true
        }
      },
      timing: samples,
    },
  )
  const limit = task.host?.usageLimitTokens
  const sessions = createEvalSessionService(
    {
      host,
      tape: store,
      ids: { uuid: (): string => randomUUID() },
      inspectors: desktopInspectors(),
      connector,
      protectedFiles: protectedShellFiles(evalHost.home),
      onUnansweredCall: 'repair',
      log,
    },
    limit === undefined ? {} : { tokenLimit: limit },
  )
  const locale = o.locale ?? 'zh-CN'
  const loop = createDesktopLoop({
    clock: host.clock,
    send: () => {},
    locale: () => locale,
    commandShell: evalHost.commandShell,
    log,
  })
  sessions.bindLoop({
    ...loop.ports,
    events: (e) => {
      watch.event(e)
      loop.ports.events(e)
    },
  })
  if (task.profile === 'cowork') {
    await sessions.selectProfile({ sessionId, profile: 'cowork', dedicated: evalHost.dedicated })
    if (evalHost.picked !== null) {
      const set = await sessions.setWorkspace({
        sessionId,
        change: { kind: 'add', folders: [evalHost.picked] },
        dedicated: evalHost.dedicated,
      })
      if (!set.ok) throw new Error(`the workspace was refused: ${set.code}`)
    }
  } else {
    await sessions.selectProfile({ sessionId, profile: 'chat' })
  }
  await sessions.selectModel({
    sessionId,
    choice: { providerId: column.providerId, modelId: column.modelId, effort: column.effort },
    origin: null,
  })

  const started = performance.now()
  const notes = await driveTurns({
    task,
    sessionId,
    sessions,
    store,
    watch,
    waitMs: o.runWaitMs ?? RUN_WAIT_MS,
  })
  const durationMs = Math.round(performance.now() - started)

  const cards = evalHost.confirm.cards
  const checks = await runChecks({
    task,
    checksDir: o.checksDir ?? CHECKS_DIR,
    ctx: { tape: store, sessionId, workspaceDir: evalHost.workspaceDir, cards },
  })
  await o.inspect?.({
    tape: store,
    sessionId,
    workspaceDir: evalHost.workspaceDir,
    cards,
    dir: evalHost.dir,
    fetched: evalHost.fetched,
  })
  const entries = await readAll(store, sessionId)
  const costs = await tapeCost(store, sessionId)
  const endReason = watch.ended.at(-1)?.reason.code ?? null
  const last = costs.attempts.findLast((a) => a.sessionId === sessionId)
  const judged = verdictOf(task, checks, endReason, notes)
  const timing = samples === null ? undefined : timingOf(samples)
  const calib: NonNullable<EvalRecord['calib']> = {
    machineDenials: named(entries, 'execution/tool_outcome').filter((e) =>
      BLOCK_SOURCES.has(String(e.payload['source'])),
    ).length,
    ...(disable === undefined ? {} : { blockedRecalls: blockedRecalls(entries, disable.name) }),
    ...(costs.perRequest === null ? {} : { perRequest: costs.perRequest }),
  }
  const record: EvalRecord = {
    taskId: task.id,
    run: o.run,
    date: o.date,
    column: { client: 'tenon', model: column.modelId, endpoint: endpointOf(column.baseURL) },
    clientVersion: o.clientVersion,
    auth: 'api-key',
    effort: column.effort,
    prompt:
      last === undefined
        ? null
        : {
            version: PROMPT_LAYER_VERSION,
            hash: PROMPT_LAYER_HASH,
            systemHash: last.systemHash,
            toolDefinitionsHash: last.toolDefinitionsHash,
          },
    ...judged,
    endReason,
    toolRounds: named(entries, 'execution/run_terminal').reduce(
      (sum, e) => sum + Number(e.payload['steps'] ?? 0),
      0,
    ),
    cards: countByReason(cards),
    usage: costs.usage,
    cost: costs.cost,
    durationMs,
    ...(timing === undefined ? {} : { timing }),
    calib,
  }
  return evalRecordSchema.parse(record)
}

/**
 * 判分: all-script tasks are judged by script and pass only when every check passes; a task with a
 * human check is judged by a human, who sets the verdict — until then it reads `fail`, and the note
 * carries the script results for reference. A run that ended over `usageLimitTokens` fails.
 */
export function verdictOf(
  task: Pick<EvalTask, 'checks'>,
  checks: readonly { id: string; pass: boolean; note: string }[],
  endReason: string | null,
  notes: readonly string[],
): Pick<EvalRecord, 'verdict' | 'judgedBy' | 'note'> {
  const humans = task.checks.flatMap((c) => (c.kind === 'human' ? [c.text] : []))
  const overLimit = endReason === 'usage-limit'
  const lines = [
    ...(overLimit ? ['ended over usageLimitTokens (usage-limit)'] : []),
    ...notes,
    ...checks.map(
      (c) => `${c.id}: ${c.pass ? 'pass' : 'fail'}${c.note === '' ? '' : ` — ${c.note}`}`,
    ),
    ...humans.map((text) => `awaiting human: ${text}`),
  ]
  const scriptsPass = checks.every((c) => c.pass) && notes.length === 0 && !overLimit
  return {
    verdict: humans.length === 0 && scriptsPass ? 'pass' : 'fail',
    judgedBy: humans.length === 0 ? 'script' : 'human',
    note: lines.join('; '),
  }
}

/** Calls to the disabled tool after the first one the policy blocked (E2). */
function blockedRecalls(entries: readonly TapeEntry[], toolName: string): number {
  const calls = new Set(
    named(entries, 'tool/call')
      .filter((e) => e.payload['name'] === toolName)
      .map((e) => e.provenanceKey.replace('tool:v1:call:', '')),
  )
  const blocked = named(entries, 'execution/tool_outcome').filter(
    (e) =>
      e.payload['source'] === 'policy' &&
      calls.has(e.provenanceKey.replace('execution:v1:outcome:', '')),
  ).length
  return Math.max(0, blocked - 1)
}

function named(entries: readonly TapeEntry[], name: string): TapeEntry[] {
  return entries.filter((entry) => entry.name === name)
}

function countByReason(cards: readonly ConfirmRequest[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const card of cards) counts[card.reason] = (counts[card.reason] ?? 0) + 1
  return counts
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `git describe --always --dirty` of this checkout, taken once before anything is written. */
export function clientVersion(): string {
  return execFileSync('git', ['describe', '--always', '--dirty'], {
    cwd: EVALS_DOCS_DIR,
    encoding: 'utf8',
  }).trim()
}

/** Today in this machine's time zone, as the desktop writes `message/environment`'s date. */
export function today(): string {
  return localDateOf(Date.now())
}

/** Every task of `tasks/`, checked; throws listing every problem. */
export function loadTasks(
  tasksDir: string = TASKS_DIR,
  fixturesDir: string = FIXTURES_DIR,
  checksDir: string = CHECKS_DIR,
): EvalTask[] {
  const { tasks, problems } = taskSetProblems({ tasksDir, fixturesDir, checksDir })
  if (problems.length > 0) throw new Error(`the task set has problems:\n${problems.join('\n')}`)
  return tasks
}

/** `TENON_EVAL_TASKS` (ids, or their `NN` prefixes, comma-separated) and `TENON_EVAL_COMPARE_ONLY`. */
export function selectTasks(tasks: readonly EvalTask[], env: EnvRecord): EvalTask[] {
  const wanted = (env['TENON_EVAL_TASKS'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  const compareOnly = ['1', 'true'].includes(env['TENON_EVAL_COMPARE_ONLY']?.trim() ?? '')
  return tasks.filter(
    (task) =>
      (wanted.length === 0 || wanted.some((w) => task.id === w || task.id.startsWith(`${w}-`))) &&
      (!compareOnly || task.compare === true),
  )
}

/** `TENON_EVAL_RUNS`: a positive integer, 3 when unset. */
export function runsOf(env: EnvRecord): number {
  const raw = env['TENON_EVAL_RUNS']?.trim() ?? ''
  if (raw === '') return 3
  const runs = Number(raw)
  if (!Number.isInteger(runs) || runs < 1)
    throw new Error(`TENON_EVAL_RUNS=${raw} is not a positive integer`)
  return runs
}

export interface LivePlan {
  readonly column: EvalColumn
  readonly key: string
  readonly runs: number
  readonly tasks: readonly EvalTask[]
  readonly timing: boolean
}

/**
 * What `pnpm eval` runs, from the runner's environment and `.env.local` (`file`, parsed inside this
 * process only): the column, its key, the runs and the tasks. `TENON_EVAL_TIMING=1` records `timing`.
 */
export function livePlan(runner: EnvRecord, file: EnvRecord, tasks: readonly EvalTask[]): LivePlan {
  const merged: Record<string, string | undefined> = { ...file, ...runner }
  const column = resolveColumn(merged)
  return {
    column,
    key: readKey(column, runner, file),
    runs: runsOf(merged),
    tasks: selectTasks(tasks, merged),
    timing: ['1', 'true'].includes(merged['TENON_EVAL_TIMING']?.trim() ?? ''),
  }
}

/** Appends a record to `<resultsDir>/<date>-<column>.jsonl`, checked first. Returns the file. */
export function appendRecord(
  record: EvalRecord,
  column: Pick<EvalColumn, 'modelId' | 'baseURL'>,
  resultsDir: string = RESULTS_DIR,
): string {
  const line = JSON.stringify(evalRecordSchema.parse(record))
  mkdirSync(resultsDir, { recursive: true })
  const file = join(resultsDir, `${record.date}-${columnSlug(column)}.jsonl`)
  appendFileSync(file, `${line}\n`)
  return file
}
