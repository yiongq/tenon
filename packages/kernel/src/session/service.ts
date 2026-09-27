/**
 * The kernel session service (spec 01 §所有权与依赖方向, §entry 模型, §投影与重放; spec 02
 * §主进程与 kernel 的循环接口).
 *
 * It creates, resets and deletes sessions, reads the two projections back for a renderer, and owns
 * the agent loop: every command a host routes — send, stop, continue, answer, resume — is judged by
 * the loop in `loop/`, one serial point (the mailbox) per root session. Spec 02 removed phase 1's
 * `runRequest`: a request is no longer something a caller runs, it is what a Run the loop opened
 * sends (`loop/run.ts`).
 *
 * Four ownership rules it exists to keep:
 *
 *   - **`tape` is a `TapeStore` INSTANCE**, wrapped in the kernel facade in here. This service is the
 *     only thing that writes through that facade; the rule it keeps — 「`apps/*` 的代码不直接调
 *     `TapeStore.append`，只经 kernel 的门面」 (§保留命名空间) — is a rule about app code, not something
 *     the type system closes: the desktop main process constructs the SQLite store and therefore holds
 *     `append`. What a caller owes is to hand the store straight into `createSessionService` and keep
 *     no reference to it. Routing an incognito session to a memory store is then a different instance
 *     rather than a change in the kernel (§删除语义).
 *   - **`ids` is the only randomness.** `sessionId`, `incarnationId`, `messageId` and `runId` are
 *     canonical UUIDs from it; the kernel draws none of its own, which is what makes the conformance
 *     suite and every fixture reproducible. It is deliberately not a `HostAdapter` member.
 *   - **every `createdAt` is a host clock reading**, taken per fact. The tape has no clock of its own.
 *   - **the loop reaches the host only through its ports**: `connector` at construction (the one
 *     loop member, because a Run the kernel opens itself has no route to hand it one), the rest —
 *     queue, leases, events, locale, date, shell — through `bindLoop`, once.
 *
 * What a crash cannot break. A Run's user turn, `run_started` and `session/model_selected` land in one
 * transaction BEFORE the request, and `message/assistant` (when there is one) with
 * `provider/attempt_completed` in one transaction after it. Die in between and a later reader sees a
 * user message with no attempt fact under that `runId` — the user's turn is not lost, the transcript
 * still replays, and resending the same text is recognised as a retry of that same message. Spec 02's
 * recovery (plan step 16) turns "a Run with no terminal fact" into its own classification.
 */
import type { AbsolutePath, HostAdapter } from '../host/adapter.js'
import { isCanonicalUuid } from '../ids.js'
import type { IdSource } from '../ids.js'
import { createLoop } from '../loop/mailbox.js'
import type {
  SelectModelQuery,
  SelectProfileQuery,
  SelectProfileResult,
  SessionFactsView,
  WorkspaceChange,
  WorkspaceResult,
} from '../loop/mailbox.js'
import type { LoopPorts, ModelChoice, RunConnector, RunOrigin } from '../loop/ports.js'
import type { Profile } from './facts.js'
import type { PendingCard, PendingRoot } from '../loop/answer.js'
import type { AnswerCommand } from '../loop/waiting.js'
import type { UserToolSetting } from '../permission/decide.js'
import type { InspectorRegistration } from '../permission/inspector.js'
import type { BuiltinToolName } from '../tools/builtin/tool.js'
import { PRODUCT_BUILTINS } from '../tools/registry.js'
import type { ToolKey } from '../tools/table.js'
import type { ForkOrigin, SessionStartPayload } from '../tape/entry.js'
import { sessionStartKey } from '../tape/provenance.js'
import type { MessageRow, TapeStore } from '../tape/store.js'
import { callsByMessage } from '../loop/calls.js'
import type { RowCall } from '../loop/calls.js'
import { readSessionEntries } from '../loop/batch.js'
import { createTape } from '../tape/tape.js'
import type { TapeFact } from '../tape/tape.js'
import { carryEntries, readSessionFacts } from './facts.js'

/**
 * How far down the newest-first session list `latestSession` looks for one with messages. A page, not
 * a scan: a user with more than this many freshly opened empty sessions ahead of their last
 * conversation gets the newest of them, which is no worse than the answer before the skip existed.
 */
const LATEST_SESSION_SCAN = 20

export interface SessionServiceOptions {
  /**
   * The whole host (01 spec:82): the loop reads `policy`, `fs`, `process`, `confirm`,
   * `network.fetchUntrusted` and `clock.setTimeout` from it. Phase 1's code took a clock reading only;
   * spec 02 returns it to what 01's spec wrote.
   */
  readonly host: HostAdapter
  /**
   * The store this service writes through. An INSTANCE, not a `HostAdapter` member: one process holds
   * several (SQLite for normal sessions, memory for incognito ones), and which one a session gets is
   * settled before this call.
   */
  readonly tape: TapeStore
  readonly ids: IdSource
  /** Registered at construction, beside `tape` and `ids`, never through `HostAdapter` (F1). */
  readonly inspectors: readonly InspectorRegistration[]
  /** The loop's one constructor member (§主进程与 kernel 的循环接口). */
  readonly connector: RunConnector
  /** The shell configuration files of the protected list, computed and resolved by the host. */
  readonly protectedFiles: readonly AbsolutePath[]
  /** A result missing before a request: throw (the default), or repair and log (§工具调用的收口). */
  readonly onUnansweredCall?: 'throw' | 'repair'
  readonly log?: (line: string) => void
}

/** A session's identity after it was created or reset, plus the `session/start` that opened it. */
export interface SessionIncarnation {
  readonly sessionId: string
  readonly incarnationId: string
  /** `entryId` of the `session/start` anchor — the first fact of this incarnation. */
  readonly startEntryId: number
}

/**
 * A message row as a renderer reads it: the projection's row, and on an assistant row with tool
 * calls, `calls[i]` for its i-th `tool-request` block (spec 02 01 修补 6).
 */
export type SessionMessageRow = MessageRow & { readonly calls?: readonly RowCall[] }

/** What a renderer opens on: the newest session and the tail of its messages. */
export interface LatestSession {
  readonly sessionId: string
  readonly messages: readonly SessionMessageRow[]
}

/** A message to send: its text, or the queued item to send now (plan step 17). */
export type SendQuery = {
  readonly sessionId: string
  readonly origin: RunOrigin | null
  /** The Run the user saw when they pressed send-now; the send stops it (plan step 17). */
  readonly urgent?: { readonly runId: string }
} & ({ readonly text: string } | { readonly queuedId: string })

export type SendResult =
  | { readonly status: 'started'; readonly runId: string }
  | { readonly status: 'queued' | 'held'; readonly queuedId: string }
  | { readonly status: 'answered' }
  | { readonly status: 'not-sent'; readonly code: 'config-missing' | 'stopped' | 'app-exit' }
  | { readonly status: 'not-found' }
  | { readonly status: 'refused'; readonly code: 'shutting-down' | 'not-bound' }

export type ContinueRunResult =
  | { readonly status: 'started' | 'not-available' | 'refused' }
  | { readonly status: 'not-sent'; readonly code: 'config-missing' | 'stopped' | 'app-exit' }
  | { readonly status: 'held'; readonly host: string }

export interface AnswerResult {
  readonly status: 'applied' | 'already-resolved' | 'stale' | 'not-found' | 'invalid' | 'refused'
}

export interface ResumeResult {
  readonly status: 'started' | 'none' | 'refused'
}

export interface RecoverResult {
  readonly resumable: readonly {
    readonly rootSessionId: string
    readonly sessionId: string
    readonly runId: string
  }[]
  readonly errors: readonly string[]
}

export interface ListMessagesQuery {
  readonly sessionId: string
  readonly limit: number
  readonly afterOrderSeq?: number
  readonly beforeOrderSeq?: number
}

/** What `createSession` takes: an id the caller already owns, a lineage pointer, or neither. */
export interface CreateSessionQuery {
  /**
   * The session id, when the CALLER already minted one — the desktop renderer mints its own and
   * filters every `chat.event` on it, so main would otherwise have to keep a renderer-id → tape-id
   * map, which is the in-process state phase 1 exists to delete. Omitted ⇒ minted from `ids`. It must
   * be a canonical UUID either way: the spec fixes that shape for every id on the tape, and a store
   * that accepts any non-empty string would take a typo as a new session.
   */
  readonly sessionId?: string
  readonly forkedFrom?: ForkOrigin
}

export interface SessionService {
  /** Mints what the caller did not supply and writes `session/start` as the FIRST fact of it. */
  createSession(q?: CreateSessionQuery): Promise<SessionIncarnation>
  /**
   * Clears a session: a new incarnation, and the kernel-built `session/start` handed to the store
   * (§删除语义), with the profile and the workspace carried in the same transaction (spec 02
   * §会话事实「清空会话」). The facts of the previous incarnation are physically gone.
   */
  resetSession(sessionId: string): Promise<SessionIncarnation>
  /**
   * A session's profile and workspace (`session.facts`): the Tape's once it is established, the
   * draft's before (§会话形态「建立前暂存」). An unknown session is a chat with no workspace.
   */
  sessionFacts(q: { sessionId: string }): Promise<SessionFactsView>
  /** `session.selectProfile`: into the draft; `established` once the session exists. */
  selectProfile(q: SelectProfileQuery): Promise<SelectProfileResult>
  /**
   * `session.selectModel` (spec 02 §模型选择): the session's choice fact — the draft's before it
   * exists — then what a switch to a public host held goes out. Answers the profile it was made in.
   */
  selectModel(q: SelectModelQuery): Promise<{ readonly profile: Profile }>
  /** `session.modelChoice`: the choice the session's next Run takes, by the five layers. */
  effectiveModelChoice(q: { sessionId: string }): Promise<ModelChoice>
  /**
   * `workspace.*` (§工作区): folders the host's own dialog or prefill gave, or one removed. `dedicated`
   * is the session's own folder, computed by the host; the kernel resolves every folder before it
   * writes it.
   */
  setWorkspace(q: {
    sessionId: string
    change: WorkspaceChange
    dedicated: AbsolutePath
  }): Promise<WorkspaceResult>
  /** Physical delete: facts, head, projections, cursors. */
  deleteSession(sessionId: string): Promise<void>
  /**
   * What a renderer opens on after a restart: the newest session that HAS messages and the last
   * `limit` of them, or null when the store holds none at all.
   */
  latestSession(q: { readonly limit: number }): Promise<LatestSession | null>
  /** One page of a session's messages. No cursor = the tail, which is where a reader opens. */
  listMessages(q: ListMessagesQuery): Promise<SessionMessageRow[]>
  /**
   * Hands the loop the host's run-time ports. Called once, before `recover()`; a second call throws.
   * Before it, every loop command is `refused` (`send` with `not-bound`) and `stop` answers
   * `stopped: false`, with nothing written.
   */
  bindLoop(ports: LoopPorts): void
  /** Startup recovery: 0 model requests, no `assemble`, no keychain (plan step 16). */
  recover(): Promise<RecoverResult>
  /** Resumes what startup recovery listed for this root, when its session is opened (plan step 16). */
  resume(q: { rootSessionId: string; origin: RunOrigin | null }): Promise<ResumeResult>
  /**
   * A message from the user. A session that does not exist yet is created by the first send that
   * opens a Run, in the same batch as the message (§会话形态「建立前暂存」).
   */
  send(q: SendQuery): Promise<SendResult>
  /** 「继续」 after a truncated or limited Run (plan step 13). */
  continueRun(q: { sessionId: string; origin: RunOrigin | null }): Promise<ContinueRunResult>
  /** An answer to an approval card or a question (plan steps 15 and 26). */
  answer(q: AnswerCommand & { origin: RunOrigin | null }): Promise<AnswerResult>
  /** The card a root waits on, for `approval.current` (§答复与投递); null when nothing waits. */
  currentPending(q: { sessionId: string }): Promise<PendingCard | null>
  /** Each root that waits on an answer or can be resumed, for `approval.list` (§离开会话). */
  listPendingRoots(q: { limit: number }): Promise<readonly PendingRoot[]>
  stop(q: { rootSessionId: string }): Promise<{ stopped: boolean }>
}

export function createSessionService(options: SessionServiceOptions): SessionService {
  return constructSessionService(options, {})
}

/**
 * What only `@tenon-app/kernel/testing`'s `createTestSessionService` passes: the product entry has
 * neither, and `SessionServiceOptions` carries neither (§主进程与 kernel 的循环接口「测试与 6b」).
 */
export interface TestServiceExtras {
  /** Every builtin tool is a candidate, whatever the product offers yet; the value is its executor. */
  readonly tools?: TestToolRegistry
  /** Layer 3 readings, which phase 2 has no producer for (§不带 tools 的请求与冻结后的变化). */
  readonly userSetting?: (key: ToolKey) => UserToolSetting | null
  /** A token limit on every Run (H11): the product has none; evals and sub-agents set their own. */
  readonly tokenLimit?: number
}

/**
 * The test tool registry: keyed by builtin name. `'fake'` (the default for a missing key) is a fake
 * executor, `'real'` the landed executor of a tool not yet in the product table, `null` no
 * implementation at all — the tool is still in the table, and a call closes as `tool-unavailable`.
 * The executors run from the per-round loop on (plan step 13).
 */
export type TestToolRegistry = Readonly<Partial<Record<BuiltinToolName, 'fake' | 'real' | null>>>

/** The one construction both entries share. */
export function constructSessionService(
  options: SessionServiceOptions,
  extras: TestServiceExtras,
): SessionService {
  assertInspectors(options.inspectors)
  const tape = createTape(options.tape)
  const ids = options.ids
  const now = (): number => options.host.clock.now()
  const log = options.log ?? ((): void => {})
  const sessionSlice = tape.writer('session')
  const loop = createLoop({
    tape,
    ids,
    now,
    host: options.host,
    connector: options.connector,
    log,
    inspectors: options.inspectors,
    protectedFiles: options.protectedFiles,
    builtinAvailable:
      extras.tools === undefined ? (name) => PRODUCT_BUILTINS.has(name) : () => true,
    testTools: extras.tools ?? null,
    userSetting: extras.userSetting ?? ((): null => null),
    tokenLimit: extras.tokenLimit ?? null,
    onUnansweredCall: options.onUnansweredCall ?? 'throw',
  })

  /**
   * The root of a session: a sub-agent's is its parent (only two levels, H5), read off the first
   * page of the session's own facts, where `session/profile_set` shares `session/start`'s batch; a
   * session with no `profile_set` (phase 1's) is a root (§启动恢复与发送防护).
   */
  async function rootSessionOf(sessionId: string): Promise<string> {
    const first = await tape.readBySource({
      sessionId,
      sourceType: 'session',
      sourceId: sessionId,
      limit: 8,
    })
    const profile = first.find((entry) => entry.name === 'session/profile_set')
    const parent = (profile?.payload['subagentOf'] as { sessionId?: unknown } | undefined)
      ?.sessionId
    return typeof parent === 'string' ? parent : sessionId
  }

  /** The rows with each assistant row's calls attached, read off the Tape once per page. */
  async function withCalls(
    sessionId: string,
    rows: readonly MessageRow[],
  ): Promise<SessionMessageRow[]> {
    if (!rows.some((row) => row.role === 'assistant')) return [...rows]
    const calls = callsByMessage(await readSessionEntries(tape, sessionId))
    return rows.map((row) => {
      const own = row.role === 'assistant' ? calls.get(row.messageId) : undefined
      return own === undefined || own.length === 0 ? row : { ...row, calls: own }
    })
  }

  function startFact(
    sessionId: string,
    incarnationId: string,
    forkedFrom: ForkOrigin | undefined,
  ): TapeFact {
    // The lineage pointer is rebuilt field by field rather than spread: the payload is hashed and
    // sealed, so it carries the four fields lineage is checkable from and nothing else a caller
    // happened to hang off its object.
    const payload: SessionStartPayload =
      forkedFrom === undefined
        ? { incarnationId }
        : {
            incarnationId,
            forkedFrom: {
              sessionId: forkedFrom.sessionId,
              incarnationId: forkedFrom.incarnationId,
              entryId: forkedFrom.entryId,
              entryHash: forkedFrom.entryHash,
            },
          }
    return {
      name: 'session/start',
      fields: {
        sourceType: 'session',
        sourceId: sessionId,
        sourceSeq: 0,
        provenanceKey: sessionStartKey(incarnationId),
        payload,
        createdAt: now(),
      },
    }
  }

  return {
    async createSession(q = {}): Promise<SessionIncarnation> {
      const sessionId = q.sessionId ?? ids.uuid()
      if (!isCanonicalUuid(sessionId)) {
        throw new TypeError(`createSession: "${sessionId}" is not a canonical UUID`)
      }
      const incarnationId = ids.uuid()
      const result = await sessionSlice.write({
        sessionId,
        incarnationId,
        fact: startFact(sessionId, incarnationId, q.forkedFrom),
      })
      return { sessionId, incarnationId, startEntryId: result.entryId }
    },

    resetSession(sessionId: string): Promise<SessionIncarnation> {
      // In the root's mailbox (§会话事实「写入」): the carry rewrites `session/*` facts, so the facts it
      // is built from are read in the same turn that commits it.
      return loop.resetTurn(sessionId, async () => {
        // A NEW incarnation: reusing the current one would make the two generations
        // hash-indistinguishable. The store refuses that, and refuses a session it has no head row
        // for.
        const incarnationId = ids.uuid()
        const fact = startFact(sessionId, incarnationId, undefined)
        const facts = await readSessionFacts(tape, sessionId)
        const result = await tape.resetSession({
          sessionId,
          incarnationId,
          start: sessionSlice.entry(fact.name, fact.fields),
          carry: carryEntries({ tape, sessionId, incarnationId, now }, facts),
        })
        return { sessionId, incarnationId, startEntryId: result.entryId }
      })
    },

    deleteSession(sessionId: string): Promise<void> {
      return tape.deleteSession(sessionId)
    },

    async latestSession(q): Promise<LatestSession | null> {
      // `listSessions` is newest first — but it ranks by `updated_at`, which `session/start` bumps
      // too, so an empty session that was opened and never used would shadow the conversation the
      // user actually wants back (acceptance 5). `lastMessageAt` is written only by `message/*`, so
      // the first row that has one is the newest session with anything to restore; when none has,
      // the newest overall is the honest answer. One bounded page, not a scan.
      const newest = await tape.listSessions({ limit: LATEST_SESSION_SCAN })
      const restorable = newest.find((row) => row.lastMessageAt !== null) ?? newest[0]
      if (restorable === undefined) return null
      // A sub-agent's session opens as its root (B3, 01 修补 6「启动恢复」).
      const sessionId = await rootSessionOf(restorable.sessionId)
      const messages = await withCalls(
        sessionId,
        await tape.listMessages({ sessionId, limit: q.limit }),
      )
      return { sessionId, messages }
    },

    async listMessages(q): Promise<SessionMessageRow[]> {
      return withCalls(q.sessionId, await tape.listMessages(q))
    },

    sessionFacts: (q) => loop.sessionFacts(q),
    selectProfile: (q) => loop.selectProfile(q),
    selectModel: (q) => loop.selectModel(q),
    effectiveModelChoice: (q) => loop.effectiveModelChoice(q),
    setWorkspace: (q) => loop.setWorkspace(q),

    bindLoop(ports): void {
      loop.bind(ports)
    },
    recover: () => loop.recover(),
    resume: (q) => loop.resume(q),
    send: (q) => loop.send(q),
    continueRun: (q) => loop.continueRun(q),
    answer: (q) => loop.answer(q),
    currentPending: (q) => loop.currentPending(q),
    listPendingRoots: (q) => loop.listPendingRoots(q),
    stop: (q) => loop.stop(q),
  }
}

/**
 * An inspector the service cannot run is refused at construction: 02 never calls the after-result
 * hook, and a registration carrying one would look as if it ran (F10). Ids are recorded in every
 * decision, so two with the same id could not be told apart.
 */
function assertInspectors(inspectors: readonly InspectorRegistration[]): void {
  const seen = new Set<string>()
  for (const inspector of inspectors) {
    if (inspector.afterResult !== undefined) {
      throw new TypeError(
        `inspector "${inspector.id}" registers afterResult, which phase 2 never calls`,
      )
    }
    if (seen.has(inspector.id)) throw new TypeError(`two inspectors share the id "${inspector.id}"`)
    seen.add(inspector.id)
  }
}
