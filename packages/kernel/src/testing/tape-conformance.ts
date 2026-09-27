/**
 * The shared `TapeStore` conformance suite (spec 01 acceptance 3, 10, 11, 13, 15; spec 02
 * acceptance 11 and the tape half of 12, plan step 8).
 *
 * It is FRAMEWORK-FREE by necessity: this file ships from `@tenon-app/kernel/testing`, an entry that
 * `test/host-independence.test.ts` bundles for the browser, so it may not import vitest or any Node
 * module. Cases are plain named async functions that throw on failure; a tiny vitest file maps them
 * onto `it()`. Step 7 runs this very file against the SQLite store, so nothing in here may touch a
 * store's internals — every assertion goes through the port.
 *
 * Whatever the store, the same properties are being proved: an `entryId` is a causal clock that
 * survives a reset, an append is idempotent by `provenanceKey` and atomic per batch, the store's own
 * append gate refuses a reserved name even when the facade is bypassed, reads are bounded and
 * pinnable, the chain recomputes from what the port returns, and a rebuilt projection equals the one
 * written incrementally. **Anything this file does not pin is free to differ between the two stores**,
 * and §删除语义 routes live (incognito) sessions to the memory store, so both contracts ship.
 *
 * The cases at the bottom drive the kernel SESSION SERVICE (acceptance 3 in full, acceptance 7's tape
 * half). They use a scripted provider whose `encode()` is the real Anthropic wire encoder — a
 * recorded `promptHash` is only worth re-deriving against the encoder that produced it — and no
 * network double at all, which is what keeps them portable.
 *
 * One thing is NOT covered here, on purpose:
 *
 *   - acceptance 12's tamper detection. `verifyChain`'s POSITIVE half is here (a healthy chain reports
 *     no bad link, page by page); its negative half needs a way to corrupt a stored row, which the
 *     spec gives only to SQLite (「用测试专用手段（去掉触发器）」) and which no port method offers. The
 *     predicate every store's `verifyChain` is built from — `isStoredEntryProvable` — has its four
 *     rejection branches unit-tested in `test/tape/hash.test.ts`, and step 7 owns the byte flip.
 */
import type { HostAdapter, HostIdentity } from '../host/adapter.js'
import { createMemoryHost } from '../host/memory.js'
import { absolutePath } from '../host/path.js'
import { environmentText } from '../loop/environment.js'
import type { SessionEvent } from '../loop/events.js'
import type { RunEndReason } from '../loop/terminal.js'
import type { ContentBlock, ModelInfo, ToolSpec, Usage } from '../provider/types.js'
import { canonicalHash, systemHash } from '../provider/wire/shared.js'
import { createSessionService } from '../session/service.js'
import type { SessionService } from '../session/service.js'
import type {
  ApprovalResolvedPayload,
  AppendResult,
  DispatchCommittedPayload,
  FactWriter,
  ModelChoiceSetPayload,
  NewEntry,
  PermissionDecidedPayload,
  ProfileSetPayload,
  RunStartedPayload,
  RunTerminalPayload,
  TapeEntry,
  TapeKind,
  ToolCallPayload,
  ToolOutcomePayload,
  ToolResultPayload,
  ViewAssembledPayload,
  ViewContentPayload,
  WorkspaceSetPayload,
} from '../tape/entry.js'
import { bytesToHex, contentHash, hashEntry } from '../tape/hash.js'
import type { SliceEntryFields, TapeSlice } from '../tape/names.js'
import { TapeAppendAuthorizationError, createEntryWriter } from '../tape/names.js'
import type {
  ProjectionOp,
  ProjectionReducer,
  TapeAttemptCompletedPayload,
  TapeAttemptError,
  TapeAttemptStop,
} from '../tape/projection.js'
import { TapeProjectionError, project } from '../tape/projection.js'
import { rebuildProviderContext } from '../tape/replay.js'
import { canonicalJson } from '../tape/canonical-json.js'
import { recheckAttempt } from './attempt-recheck.js'
import { createTestLoopPorts } from './loop-ports.js'
import type { TestLoopPorts } from './loop-ports.js'
import {
  TapeProvenanceSyntaxError,
  approvalResolvedKey,
  assembledKey,
  attemptCompletedKey,
  dispatchCommittedKey,
  messageRetractedKey,
  messageRevisionKey,
  modelChoiceSetKey,
  modelSelectedKey,
  permissionDecidedKey,
  profileSetKey,
  runStartedKey,
  runTerminalKey,
  sessionStartKey,
  toolCallKey,
  toolOutcomeKey,
  toolResultKey,
  viewContentKey,
  workspaceSetKey,
} from '../tape/provenance.js'
import type { MessageRow, PendingApprovalRow, TapeStore } from '../tape/store.js'
import {
  MAX_READ_LIMIT,
  TapeClosedError,
  TapeMessageRetractedError,
  TapeProvenanceConflictError,
  TapeReadLimitError,
  TapeSessionNotFoundError,
  TapeStaleIncarnationError,
} from '../tape/store.js'
import { createTape } from '../tape/tape.js'
import { createCounterIds } from './fake-ids.js'
import { createScriptedProvider, scriptedTurn, stopEvent } from './scripted-provider.js'
import type { ScriptedProvider } from './scripted-provider.js'

export interface TapeStoreFactoryOptions {
  /** The store binds its tenant to this; the suite never passes a tenant to a method. */
  readonly identity: HostIdentity
  /** When present, the store must apply THIS reducer instead of the kernel's. */
  readonly project?: ProjectionReducer
  /**
   * The case asking for the store, as a slug. A factory that needs a fresh backing store per call —
   * the SQLite one cannot honour `identity.profileDir`, or all cases would share one file — derives a
   * name from it and keeps the path itself. The suite closes every store it opened, including after a
   * failed assertion, so a factory may also track handles by label to tear down leftovers.
   */
  readonly label: string
  /**
   * Open this store over the SAME backing storage as that one — a store this case opened earlier
   * through this factory — bound to `identity`'s tenant: one file holding two tenants' rows, the
   * server shape (spec 01 acceptance 4; spec 02 acceptance 11, 旧 60 and 旧 110). A factory MUST honour
   * it. The port cannot tell a shared backing from a separate one — that is the property under test —
   * so a factory that quietly opened a second backing would make the tenant cases pass vacuously.
   */
  readonly shareBackingWith?: TapeStore
}

export type TapeStoreFactory = (options: TapeStoreFactoryOptions) => Promise<TapeStore>

export interface TapeConformanceCase {
  readonly name: string
  run(): Promise<void>
}

/** Thrown by every failed assertion, so a runner can tell a failure from a crash. */
export class TapeConformanceFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TapeConformanceFailure'
  }
}

type ErrorClass = new (...args: never[]) => Error

function fail(message: string): never {
  throw new TapeConformanceFailure(message)
}

function assertTrue(condition: boolean, message: string): void {
  if (!condition) fail(message)
}

/** Structural equality over what a tape returns: JSON values plus `Uint8Array`. */
function describeValue(value: unknown): string {
  if (value instanceof Uint8Array) return `bytes(${bytesToHex(value)})`
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false
    if (left.length !== right.length) return false
    return left.every((byte, index) => byte === right[index])
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  if (typeof left === 'object' && typeof right === 'object' && left !== null && right !== null) {
    const leftKeys = Object.keys(left).toSorted()
    const rightKeys = Object.keys(right).toSorted()
    if (!deepEqual(leftKeys, rightKeys)) return false
    const leftRecord: Record<string, unknown> = { ...left }
    const rightRecord: Record<string, unknown> = { ...right }
    return leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]))
  }
  return false
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!deepEqual(actual, expected)) {
    fail(`${message}: expected ${describeValue(expected)}, got ${describeValue(actual)}`)
  }
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expected: ErrorClass,
  message: string,
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof expected) return
    fail(`${message}: threw ${describeValue(String(error))} instead of ${expected.name}`)
  }
  fail(`${message}: resolved instead of throwing ${expected.name}`)
}

/**
 * Invariant 17, applied to whatever a read returned. A Node `Buffer` IS a `Uint8Array`, so the check
 * is on the prototype — and it has to work without importing `node:buffer`, which this file may not
 * do. `bigint` is caught by `typeof`.
 */
function assertPortSafe(value: unknown, path: string): void {
  if (typeof value === 'bigint') fail(`${path} is a bigint; no bigint crosses the port`)
  if (value === null || typeof value !== 'object') return
  if (value instanceof Uint8Array) {
    if (Object.getPrototypeOf(value) !== Uint8Array.prototype) {
      fail(`${path} is a Uint8Array subclass (a Buffer?); only plain Uint8Array crosses the port`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPortSafe(item, `${path}[${index}]`))
    return
  }
  const record: Record<string, unknown> = { ...value }
  for (const key of Object.keys(record)) assertPortSafe(record[key], `${path}.${key}`)
}

// -------------------------------------------------------------------------------------------------
// Fixture helpers — the kernel's own writers, so the suite can only build facts a slice may write
// -------------------------------------------------------------------------------------------------

const TENANT: HostIdentity = {
  userId: 'conformance-user',
  tenantId: 'conformance-tenant',
  profileDir: '/tenon/conformance',
}

/** Deterministic clock: `createdAt` is data on the fact, never read from a host clock. */
function clockFrom(start: number): () => number {
  let now = start
  return () => {
    now += 1000
    return now
  }
}

interface Fixture {
  readonly store: TapeStore
  readonly sessionId: string
  incarnationId: string
  readonly ids: ReturnType<typeof createCounterIds>
  readonly at: () => number
}

/** What one case's runner holds: its label, its private id range, and the stores it opened. */
interface CaseContext {
  readonly label: string
  readonly idStart: number
  readonly stores: TapeStore[]
}

interface OpenFixtureOptions {
  readonly project?: ProjectionReducer
  /** Bind the store to this tenant instead of the suite's. */
  readonly tenantId?: string
  /** Open it over the same backing storage as this earlier fixture's store. */
  readonly shareWith?: Fixture
}

/** How a case opens a store. The runner closes it afterwards, pass or fail. */
export type OpenFixture = (options?: OpenFixtureOptions) => Promise<Fixture>

async function openFixture(
  createStore: TapeStoreFactory,
  context: CaseContext,
  options: OpenFixtureOptions = {},
): Promise<Fixture> {
  const store = await createStore({
    identity: options.tenantId === undefined ? TENANT : { ...TENANT, tenantId: options.tenantId },
    label: context.label,
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.shareWith === undefined ? {} : { shareBackingWith: options.shareWith.store }),
  })
  context.stores.push(store)
  // Each case counts from its own base, so two cases never mint the same session id — a factory that
  // hands out ONE backing store would otherwise see case 2 collide with case 1's rows.
  const ids = createCounterIds({ start: context.idStart })
  return {
    store,
    sessionId: ids.uuid(),
    incarnationId: ids.uuid(),
    ids,
    at: clockFrom(1_700_000_000_000),
  }
}

/** Every fact goes through the kernel's own writer, so a fixture cannot build an unauthorised one. */
function write(slice: TapeSlice | null, name: string, fields: SliceEntryFields): NewEntry {
  return createEntryWriter(slice)(name, fields)
}

function startEntry(fixture: Fixture, incarnationId: string): NewEntry {
  return write('session', 'session/start', {
    sourceType: 'session',
    sourceId: fixture.sessionId,
    sourceSeq: 0,
    provenanceKey: sessionStartKey(incarnationId),
    payload: { incarnationId },
    createdAt: fixture.at(),
  })
}

function userMessage(
  fixture: Fixture,
  messageId: string,
  revision: number,
  text: string,
): NewEntry {
  return write('message', 'message/user', {
    sourceType: 'message',
    sourceId: messageId,
    sourceSeq: revision,
    provenanceKey: messageRevisionKey(messageId, revision),
    payload: {
      messageId,
      revision,
      role: 'user',
      content: [{ type: 'text', text }],
      status: 'complete',
    },
    createdAt: fixture.at(),
  })
}

function assistantMessage(
  fixture: Fixture,
  messageId: string,
  revision: number,
  runId: string,
  text: string,
): NewEntry {
  return write('message', 'message/assistant', {
    sourceType: 'message',
    sourceId: messageId,
    sourceSeq: revision,
    provenanceKey: messageRevisionKey(messageId, revision),
    payload: {
      messageId,
      revision,
      role: 'assistant',
      runId,
      content: [{ type: 'text', text }],
      status: 'complete',
    },
    createdAt: fixture.at(),
  })
}

function retraction(fixture: Fixture, messageId: string): NewEntry {
  return write('message', 'message/retracted', {
    sourceType: 'message',
    sourceId: messageId,
    provenanceKey: messageRetractedKey(messageId),
    payload: { messageId, reason: 'user-deleted' },
    createdAt: fixture.at(),
  })
}

function modelSelected(fixture: Fixture, runId: string): NewEntry {
  return write('session', 'session/model_selected', {
    sourceType: 'session',
    sourceId: fixture.sessionId,
    provenanceKey: modelSelectedKey(runId),
    payload: { providerId: 'anthropic', modelId: 'claude-test' },
    createdAt: fixture.at(),
  })
}

function attemptCompleted(fixture: Fixture, runId: string, requestSeq: number): NewEntry {
  return write('provider', 'provider/attempt_completed', {
    sourceType: 'runtime_event',
    sourceId: runId,
    sourceSeq: requestSeq,
    provenanceKey: attemptCompletedKey(runId, requestSeq, 1),
    payload: {
      providerId: 'anthropic',
      modelId: 'claude-test',
      contextAtEntryId: 1,
      request: { systemHash: 'a'.repeat(64), maxTokens: 1024 },
      promptHash: 'b'.repeat(64),
      toolDefinitionsHash: 'c'.repeat(64),
      thinkingDecisions: [],
      usage: null,
      stop: { reason: 'end-turn', providerReason: 'end_turn' },
      error: null,
    },
    createdAt: fixture.at(),
  })
}

/** An `ext/<owner>/…` fact: the only thing generic append may write, and a cheap filler. */
function extFact(fixture: Fixture, ordinal: number): NewEntry {
  return write(null, 'ext/acme/note', {
    kind: 'event',
    sourceType: 'session',
    sourceId: fixture.sessionId,
    provenanceKey: `ext:v1:acme:note.${ordinal}`,
    payload: { ordinal },
    createdAt: fixture.at(),
  })
}

async function appendAll(fixture: Fixture, entries: readonly NewEntry[]): Promise<AppendResult[]> {
  return fixture.store.append({
    sessionId: fixture.sessionId,
    incarnationId: fixture.incarnationId,
    entries,
  })
}

/** Reads a whole session through the port, page by page, with `atEntryId` pinned if given. */
async function readAll(
  store: TapeStore,
  sessionId: string,
  options: { readonly atEntryId?: number; readonly limit?: number } = {},
): Promise<TapeEntry[]> {
  const limit = options.limit ?? MAX_READ_LIMIT
  const entries: TapeEntry[] = []
  let fromEntryId: number | undefined
  let incarnationId: string | undefined
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
    const page = await store.readRange({
      sessionId,
      limit,
      ...(fromEntryId === undefined ? {} : { fromEntryId }),
      ...(options.atEntryId === undefined ? {} : { atEntryId: options.atEntryId }),
      ...(incarnationId === undefined ? {} : { incarnationId }),
    })
    entries.push(...page.entries)
    incarnationId = page.incarnationId
    if (page.nextFromEntryId === null) return entries
    fromEntryId = page.nextFromEntryId
  }
}

// -------------------------------------------------------------------------------------------------
// Spec 02 fact helpers — the phase-2 names through the kernel's own writers, keys and payload types
// -------------------------------------------------------------------------------------------------

const RESOLVER: FactWriter = { by: 'resolver' }

/** A client tool call's identity: every tool/ and per-call execution/ fact hangs on it (§键与挂靠). */
interface CallAt {
  readonly runId: string
  readonly requestSeq: number
  readonly ordinal: number
}

function callSource(call: CallAt): Pick<SliceEntryFields, 'sourceType' | 'sourceId' | 'sourceSeq'> {
  return { sourceType: 'runtime_event', sourceId: call.runId, sourceSeq: call.requestSeq }
}

function callRef(call: CallAt): { ordinal: number; providerToolCallId: string } {
  return { ordinal: call.ordinal, providerToolCallId: `toolu_${call.requestSeq}_${call.ordinal}` }
}

const ARGS_HASH = 'd'.repeat(64)

function toolCallFact(fixture: Fixture, call: CallAt, messageId: string): NewEntry {
  const payload: ToolCallPayload = {
    ...callRef(call),
    messageId,
    name: 'Write',
    input: { file_path: '/work/a.txt', content: 'x' },
    argsHash: ARGS_HASH,
  }
  return write('tool', 'tool/call', {
    ...callSource(call),
    provenanceKey: toolCallKey(call.runId, call.requestSeq, call.ordinal),
    payload,
    createdAt: fixture.at(),
  })
}

interface DecisionOptions {
  readonly awaits?: 'approval' | 'question'
  readonly rejudge?: number
  readonly verdict?: 'allow' | 'ask' | 'deny'
  readonly writer?: FactWriter
}

function decisionFact(fixture: Fixture, call: CallAt, options: DecisionOptions = {}): NewEntry {
  const verdict = options.verdict ?? (options.awaits === 'approval' ? 'ask' : 'allow')
  const payload: PermissionDecidedPayload = {
    ...callRef(call),
    argsHash: ARGS_HASH,
    reversibility: 'unknown',
    record: {
      verdict,
      decidedBy: 'default',
      steps: [{ by: 'default', said: verdict, status: 'ok' }],
    },
    summary: { verdict, code: 'default-ask', facts: { toolName: 'Write' } },
    policyVersion: 'empty',
    ...(verdict === 'ask'
      ? {
          confirm: {
            reason: 'default',
            facts: { toolName: 'Write' },
            kind: 'file',
            target: { type: 'path', path: absolutePath('/work/a.txt') },
          },
        }
      : {}),
    ...(verdict === 'deny' ? { block: { reason: 'policy', facts: { toolName: 'Write' } } } : {}),
    ...(options.awaits === undefined ? {} : { awaits: options.awaits }),
    ...(options.rejudge === undefined ? {} : { rejudge: options.rejudge }),
    writer: options.writer ?? { by: 'run', runId: call.runId },
  }
  return write('tool', 'tool/permission_decided', {
    ...callSource(call),
    provenanceKey: permissionDecidedKey(call.runId, call.requestSeq, call.ordinal, options.rejudge),
    payload,
    createdAt: fixture.at(),
  })
}

/** A decision that waits, on a call of a run of its own: one pending row. */
function waitingOnFreshRun(fixture: Fixture, awaits: 'approval' | 'question'): NewEntry {
  return decisionFact(fixture, { runId: fixture.ids.uuid(), requestSeq: 0, ordinal: 0 }, { awaits })
}

function approvalFact(
  fixture: Fixture,
  call: CallAt,
  outcome: ApprovalResolvedPayload['outcome'],
  options: { readonly decisionKey?: string; readonly writer?: FactWriter } = {},
): NewEntry {
  const payload: ApprovalResolvedPayload = {
    ...callRef(call),
    decisionKey:
      options.decisionKey ?? permissionDecidedKey(call.runId, call.requestSeq, call.ordinal),
    outcome,
    via: outcome === 'allowed' || outcome === 'denied' ? 'card' : 'stop',
    grant: outcome === 'allowed' ? { scope: 'once', key: 'write:/work/a.txt' } : null,
    writer: options.writer ?? RESOLVER,
  }
  return write('tool', 'tool/approval_resolved', {
    ...callSource(call),
    provenanceKey: approvalResolvedKey(call.runId, call.requestSeq, call.ordinal),
    payload,
    createdAt: fixture.at(),
  })
}

function resultFact(fixture: Fixture, call: CallAt, writer: FactWriter): NewEntry {
  const payload: ToolResultPayload = {
    ...callRef(call),
    isError: false,
    content: [{ type: 'text', text: 'written' }],
    kernelAuthored: false,
    writer,
  }
  return write('tool', 'tool/result', {
    ...callSource(call),
    provenanceKey: toolResultKey(call.runId, call.requestSeq, call.ordinal),
    payload,
    createdAt: fixture.at(),
  })
}

function dispatchFact(fixture: Fixture, call: CallAt, writer: FactWriter): NewEntry {
  const payload: DispatchCommittedPayload = {
    ...callRef(call),
    name: 'Write',
    argsHash: ARGS_HASH,
    decisionKey: permissionDecidedKey(call.runId, call.requestSeq, call.ordinal),
    writer,
  }
  return write('execution', 'execution/dispatch_committed', {
    ...callSource(call),
    provenanceKey: dispatchCommittedKey(call.runId, call.requestSeq, call.ordinal),
    payload,
    createdAt: fixture.at(),
  })
}

function outcomeFact(fixture: Fixture, call: CallAt, writer: FactWriter): NewEntry {
  const payload: ToolOutcomePayload = {
    ...callRef(call),
    effect: 'write',
    state: 'completed',
    source: null,
    reversibility: 'unknown',
    writer,
  }
  return write('execution', 'execution/tool_outcome', {
    ...callSource(call),
    provenanceKey: toolOutcomeKey(call.runId, call.requestSeq, call.ordinal),
    payload,
    createdAt: fixture.at(),
  })
}

function runStartedFact(
  fixture: Fixture,
  runId: string,
  cause: RunStartedPayload['cause'],
): NewEntry {
  const payload: RunStartedPayload = { cause }
  return write('execution', 'execution/run_started', {
    sourceType: 'runtime_event',
    sourceId: runId,
    provenanceKey: runStartedKey(runId),
    payload,
    createdAt: fixture.at(),
  })
}

function runTerminalFact(fixture: Fixture, runId: string, reason: RunEndReason): NewEntry {
  const payload: RunTerminalPayload = { reason, steps: 1, usage: [], writer: { by: 'run', runId } }
  return write('execution', 'execution/run_terminal', {
    sourceType: 'runtime_event',
    sourceId: runId,
    provenanceKey: runTerminalKey(runId),
    payload,
    createdAt: fixture.at(),
  })
}

function profileFact(fixture: Fixture, incarnationId: string): NewEntry {
  const payload: ProfileSetPayload = { profile: 'cowork' }
  return write('session', 'session/profile_set', {
    sourceType: 'session',
    sourceId: fixture.sessionId,
    provenanceKey: profileSetKey(incarnationId),
    payload,
    createdAt: fixture.at(),
  })
}

function workspaceFact(fixture: Fixture, incarnationId: string, n: number): NewEntry {
  const payload: WorkspaceSetPayload = { folders: [absolutePath('/work')], origin: 'picked' }
  return write('session', 'session/workspace_set', {
    sourceType: 'session',
    sourceId: fixture.sessionId,
    sourceSeq: n,
    provenanceKey: workspaceSetKey(incarnationId, n),
    payload,
    createdAt: fixture.at(),
  })
}

function modelChoiceFact(
  fixture: Fixture,
  incarnationId: string,
  n: number,
  modelId: string,
): NewEntry {
  const payload: ModelChoiceSetPayload = { providerId: 'zhipu', modelId, effort: null }
  return write('session', 'session/model_choice_set', {
    sourceType: 'session',
    sourceId: fixture.sessionId,
    sourceSeq: n,
    provenanceKey: modelChoiceSetKey(incarnationId, n),
    payload,
    createdAt: fixture.at(),
  })
}

function viewContentFact(fixture: Fixture, payload: ViewContentPayload): NewEntry {
  return write('view', 'view/content', {
    sourceType: 'session',
    sourceId: fixture.sessionId,
    provenanceKey: viewContentKey(payload.type, payload.hash),
    payload,
    createdAt: fixture.at(),
  })
}

function assembledFact(fixture: Fixture, runId: string, requestSeq: number, systemText: string) {
  const payload: ViewAssembledPayload = {
    modelInfoHash: canonicalHash(SCRIPT_MODEL, 'model'),
    systemHash: systemHash(systemText),
    tools: null,
  }
  return write('view', 'view/assembled', {
    sourceType: 'runtime_event',
    sourceId: runId,
    sourceSeq: requestSeq,
    provenanceKey: assembledKey(runId, requestSeq),
    payload,
    createdAt: fixture.at(),
  })
}

/** A reducer that projects like the kernel's but throws on the first fact `fails` picks out. */
function failingReducer(fails: (entry: TapeEntry) => boolean): ProjectionReducer {
  return (entry: TapeEntry): readonly ProjectionOp[] => {
    if (fails(entry)) throw new TapeProjectionError(`injected: ${entry.name} does not project`)
    return project(entry)
  }
}

/** Every pending row of a store, one tenant's, via the port. */
function pendingOf(fixture: Fixture, sessionId?: string): Promise<PendingApprovalRow[]> {
  return fixture.store.listPendingApprovals({
    limit: MAX_READ_LIMIT,
    ...(sessionId === undefined ? {} : { sessionId }),
  })
}

// -------------------------------------------------------------------------------------------------
// Session-service fixtures — a scripted provider, one fixed model, one fixed system prompt and tool
// -------------------------------------------------------------------------------------------------

/** The provider id the scripted provider answers to; the encoder refuses a foreign model. */
const SCRIPT_PROVIDER_ID = 'anthropic'

const SCRIPT_MODEL: ModelInfo = {
  id: 'claude-conformance-1',
  providerId: SCRIPT_PROVIDER_ID,
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

/**
 * A system prompt and a tool as `view/content` data (the spec 02 case near the end). A Run sends
 * neither before plan steps 10 and 18, so acceptance 3's re-encode below has no input the tape does
 * not hold.
 */
const SCRIPT_SYSTEM = 'be brief'
const SCRIPT_TOOL: ToolSpec = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

const SCRIPT_USAGE: Usage = {
  inputTokens: 11,
  outputTokens: 7,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: true,
}

/**
 * A reading that is NOT the attempt's: on the Anthropic wire `message_start` reports the prompt
 * before a token has been generated. Zeros everywhere, so a fact that took it would be
 * indistinguishable from a free turn.
 */
const NON_FINAL_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  final: false,
}

interface ServiceFixture {
  readonly fixture: Fixture
  readonly service: SessionService
  readonly provider: ScriptedProvider
  readonly loop: TestLoopPorts
  /** Every loop event, synchronously as it is sent; null stops listening. */
  listen(listener: ((event: SessionEvent) => void) | null): void
}

/**
 * The service under its own constructor shape — a store instance, an id source, the host with the
 * fixture's clock reading, the scripted connector — with the test loop ports bound.
 */
async function openService(open: OpenFixture): Promise<ServiceFixture> {
  const fixture = await open()
  const provider = createScriptedProvider({ id: SCRIPT_PROVIDER_ID, models: [SCRIPT_MODEL] })
  let listener: ((event: SessionEvent) => void) | null = null
  const loop = createTestLoopPorts({
    connector: { provider, model: SCRIPT_MODEL },
    onEvent: (event) => listener?.(event),
  })
  const service = createSessionService({
    host: hostReading(fixture.at),
    tape: fixture.store,
    ids: fixture.ids,
    inspectors: [],
    connector: loop.connector,
    protectedFiles: [],
  })
  service.bindLoop(loop)
  return {
    fixture,
    provider,
    service,
    loop,
    listen(next): void {
      listener = next
    },
  }
}

/** A memory host whose clock reads the fixture's: every fact's `createdAt` comes from it. */
function hostReading(now: () => number): HostAdapter {
  const host = createMemoryHost()
  return { ...host, clock: { now, setTimeout: (fn, ms) => host.clock.setTimeout(fn, ms) } }
}

/** What one Run left on the tape, read back the way any later reader would. */
interface TurnRecord {
  readonly runId: string
  readonly userMessageId: string
  /** false = the resend's idempotent no-op: the message is an older fact, not this Run's batch. */
  readonly userMessageCreated: boolean
  readonly contextAtEntryId: number
  readonly assistantMessageId: string | null
  readonly status: string | null
  readonly content: readonly ContentBlock[]
  readonly usage: Usage | null
  readonly stop: TapeAttemptStop | null
  readonly error: TapeAttemptError | null
}

/** One turn through the service: `send`, then the Run's end, then what it recorded. */
async function runTurn(ctx: ServiceFixture, sessionId: string, text: string): Promise<TurnRecord> {
  const sent = await ctx.service.send({ sessionId, origin: null, text })
  if (sent.status !== 'started') fail(`send answered ${describeValue(sent)}, not started`)
  const ended = await ctx.loop.runEnded({ runId: sent.runId })
  assertTrue(ended.recorded, `run ${sent.runId} recorded its end`)
  return turnRecord(ctx.fixture.store, sessionId, sent.runId)
}

async function turnRecord(store: TapeStore, sessionId: string, runId: string): Promise<TurnRecord> {
  const entries = await readAll(store, sessionId)
  const started = entries.find(
    (entry) => entry.name === 'execution/run_started' && entry.sourceId === runId,
  )
  if (started === undefined) fail(`run ${runId} has no run_started`)
  const cause = (started.payload as unknown as RunStartedPayload).cause
  if (cause.kind !== 'user-message') fail(`run ${runId} was not opened by a message`)
  const user = entries.find(
    (entry) => entry.name === 'message/user' && entry.payload['messageId'] === cause.messageId,
  )
  if (user === undefined) fail(`run ${runId}: its message ${cause.messageId} is not on the tape`)
  const attempt = entries.find(
    (entry) => entry.name === 'provider/attempt_completed' && entry.sourceId === runId,
  )
  if (attempt === undefined) fail(`run ${runId} wrote no attempt fact`)
  const fact = attemptPayloadOf(attempt)
  const assistant = entries.find(
    (entry) => entry.name === 'message/assistant' && entry.payload['runId'] === runId,
  )
  return {
    runId,
    userMessageId: cause.messageId,
    // The pre-run batch writes the message right before `run_started`; a resend's is older.
    userMessageCreated: user.entryId === started.entryId - 1,
    contextAtEntryId: fact.contextAtEntryId,
    assistantMessageId: assistant === undefined ? null : (assistant.payload['messageId'] as string),
    status: assistant === undefined ? null : (assistant.payload['status'] as string),
    content: assistant === undefined ? [] : (assistant.payload['content'] as ContentBlock[]),
    usage: fact.usage,
    stop: fact.stop,
    error: fact.error,
  }
}

/** The text of a folded turn, for comparing what was persisted against what arrived. */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/**
 * Reads a `provider/attempt_completed` payload as the type the tape binds for it. The four type
 * parameters are already bound (`TapeAttemptCompletedPayload`), so this checks the two fields every
 * case below asserts on and hands the record over — a payload off a disk is data, and a bare cast
 * would turn a corrupt row into a confusing assertion failure two screens later.
 */
function attemptPayloadOf(entry: TapeEntry): TapeAttemptCompletedPayload {
  const payload = entry.payload as unknown as TapeAttemptCompletedPayload
  if (typeof payload.contextAtEntryId !== 'number' || typeof payload.promptHash !== 'string') {
    fail(`entry ${entry.entryId} is not an attempt record: ${describeValue(entry.payload)}`)
  }
  return payload
}

async function attemptFacts(store: TapeStore, sessionId: string): Promise<TapeEntry[]> {
  const entries = await readAll(store, sessionId)
  return entries.filter((entry) => entry.name === 'provider/attempt_completed')
}

/**
 * Acceptance 3 for ONE attempt fact, and 02 不变量 33: the request rebuilt from the Tape alone — replay
 * pinned at the `contextAtEntryId` that fact recorded, its own request snapshot, and the ModelInfo,
 * system text and tools its `view/assembled` names — re-encodes through the real wire encoder to the
 * `promptHash` the fact recorded. `recheckAttempt` does the rebuilding; the model table it is compared
 * with here is the scripted provider's one row.
 *
 * Nothing outside the fact and the tape goes into it, which is the point: if the pin, the snapshot, the
 * stored originals or the encoder disagreed with what was sent, the recorded hash could never be
 * recomputed again.
 */
async function assertAttemptReEncodes(
  store: TapeStore,
  sessionId: string,
  entry: TapeEntry,
): Promise<void> {
  const fact = attemptPayloadOf(entry)
  await assertPinIsThisRunsOwnBatch(store, sessionId, entry, fact)
  const recheck = await recheckAttempt(store, {
    sessionId,
    attempt: entry,
    currentModel: (providerId, modelId) =>
      providerId === SCRIPT_PROVIDER_ID && modelId === SCRIPT_MODEL.id ? SCRIPT_MODEL : null,
  })
  if (recheck.verdict !== 'verified') {
    fail(`attempt ${entry.entryId} does not recompute from the tape: ${describeValue(recheck)}`)
  }
  const { messages, system } = recheck.request
  assertTrue(messages.length > 0, `the context of attempt ${entry.entryId} is not empty`)
  assertEqual(
    messages.filter((message) => message.content.length === 0),
    [],
    'replay never yields an empty turn, in either role',
  )
  // Phase 1's other safety property, worth pinning while the pin is in hand: a request always ends on
  // the user's turn. The retry rule keeps it that way, and plan.md 「Open」 relies on it — an assistant
  // turn at the end is a prefill, which newer models answer with a 400.
  assertEqual(
    messages.at(-1)?.role,
    'user',
    `attempt ${entry.entryId} was assembled from a prefix ending on the user's turn`,
  )
  // The system text is the incarnation's `view/content(system)` the snapshot's hash names (spec 02
  // §提示层「组装」): sent from the Tape, never re-assembled.
  assertTrue(
    system !== undefined && fact.request.systemHash === systemHash(system),
    'the snapshot names the system prompt the Run sent, stored once as view/content(system)',
  )
  assertEqual(fact.modelId, SCRIPT_MODEL.id, 'the fact names the model that went on the wire')
}

/**
 * The pin, tied to facts the tape can NAME rather than to a bare number.
 *
 * The re-encode above cannot see a pin that is one too LOW: one lower is this run's own
 * `run_started` fact, whose prefix holds the very same messages, so the promptHash still recomputes
 * and every fixture stays green while the recorded pin describes a prefix the request was not
 * assembled from. What does catch it is the identity the service commits to: the pin is the top of
 * THIS run's pre-run batch, and `session/model_selected` is keyed by `runId` and therefore always
 * newly appended — so it is that batch's largest id, and the relation is an equality. Spec 02 adds
 * one fact the Run itself writes on top before its first request, the environment note (§提示层
 * 「环境说明」); when there is one, the pin is that.
 */
async function assertPinIsThisRunsOwnBatch(
  store: TapeStore,
  sessionId: string,
  entry: TapeEntry,
  fact: TapeAttemptCompletedPayload,
): Promise<void> {
  const runId = entry.sourceId
  if (runId === null) fail(`attempt ${entry.entryId} carries no runId to pin against`)
  const entries = await readAll(store, sessionId)
  const receipt = entries.find((candidate) => candidate.provenanceKey === modelSelectedKey(runId))
  if (receipt === undefined) {
    fail(`attempt ${entry.entryId}: no session/model_selected for run ${runId}`)
  }
  const note = entries.find(
    (candidate) =>
      candidate.name === 'message/environment' &&
      candidate.entryId > receipt.entryId &&
      candidate.entryId < entry.entryId,
  )
  assertEqual(
    fact.contextAtEntryId,
    note?.entryId ?? receipt.entryId,
    `attempt ${entry.entryId} pinned the top of its own pre-run batch (or its environment note)`,
  )
  // The other fact of that batch: the question this request answered is INSIDE the prefix, which is
  // what makes the pin describe a request that could be sent at all.
  const question = entries.find(
    (candidate) => candidate.name === 'message/user' && candidate.entryId <= fact.contextAtEntryId,
  )
  if (question === undefined) {
    fail(`attempt ${entry.entryId}: the pinned prefix holds no message/user fact`)
  }
  assertTrue(
    fact.contextAtEntryId >= question.entryId,
    `attempt ${entry.entryId} pinned at or above the question it answered`,
  )
}

function countingReducer(counts: Map<string, number>): ProjectionReducer {
  return (entry: TapeEntry): readonly ProjectionOp[] => {
    const key = `${entry.name}#${entry.entryId}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return project(entry)
  }
}

// -------------------------------------------------------------------------------------------------
// The cases
// -------------------------------------------------------------------------------------------------

/** A case name as a factory can use it in a file name. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 48)
}

export function tapeConformanceCases(
  createStore: TapeStoreFactory,
): readonly TapeConformanceCase[] {
  const cases: TapeConformanceCase[] = []
  const add = (name: string, body: (open: OpenFixture) => Promise<void>): void => {
    // A private id range per case, wide enough for the 5000-fact one to stay inside it.
    const idStart = (cases.length + 1) * 100_000 + 1
    cases.push({
      name,
      async run(): Promise<void> {
        const context: CaseContext = { label: slugify(name), idStart, stores: [] }
        let failed = false
        let failure: unknown
        try {
          await body((options = {}) => openFixture(createStore, context, options))
        } catch (error) {
          failed = true
          failure = error
        }
        // Closed in every outcome: a failed assertion must not leave an open handle (and, for SQLite,
        // its -wal / -shm files) behind for the rest of the run. A close that itself fails is reported
        // only when the body passed, so it can never mask the real failure.
        for (const store of context.stores.splice(0)) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- handles are released one at a time
            await store.close()
          } catch (error) {
            if (!failed) {
              failed = true
              failure = error
            }
          }
        }
        if (failed) throw failure
      },
    })
  }

  // ----- acceptance 10: entry_id is a causal clock -----------------------------------------------

  add('entry ids keep rising across a reset, and the head never goes backwards', async (open) => {
    const fixture = await open()
    const runId = fixture.ids.uuid()
    const firstMessage = fixture.ids.uuid()
    const before = await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId),
      modelSelected(fixture, runId),
      userMessage(fixture, firstMessage, 0, 'before the reset'),
      assistantMessage(fixture, fixture.ids.uuid(), 0, runId, 'answer'),
      attemptCompleted(fixture, runId, 0),
    ])
    assertEqual(before.length, 5, 'five receipts')
    assertEqual(
      before.map((result) => result.entryId),
      [1, 2, 3, 4, 5],
      'ids are allocated from the head high-water mark, starting at 1',
    )
    const headBefore = await fixture.store.head(fixture.sessionId)
    if (headBefore === null) fail('head row is missing after the first append')
    assertEqual(headBefore.lastEntryId, 5, 'last_entry_id after five facts')
    assertEqual(headBefore.entryCount, 5, 'entry_count after five facts')

    const nextIncarnation = fixture.ids.uuid()
    const reset = await fixture.store.resetSession({
      sessionId: fixture.sessionId,
      incarnationId: nextIncarnation,
      start: startEntry(fixture, nextIncarnation),
    })
    assertTrue(
      reset.entryId > headBefore.lastEntryId,
      `the reset's session/start (${reset.entryId}) must be above every earlier id`,
    )
    const headAfterReset = await fixture.store.head(fixture.sessionId)
    if (headAfterReset === null) fail('head row is missing after the reset')
    assertEqual(headAfterReset.incarnationId, nextIncarnation, 'the incarnation was swapped')
    assertTrue(
      headAfterReset.lastEntryId >= headBefore.lastEntryId,
      'last_entry_id never decreases across a reset',
    )
    assertEqual(headAfterReset.entryCount, 1, 'entry_count restarts at the new session/start')

    fixture.incarnationId = nextIncarnation
    const after = await appendAll(fixture, [
      userMessage(fixture, fixture.ids.uuid(), 0, 'after the reset'),
    ])
    const newest = after[0]
    if (newest === undefined) fail('the post-reset append returned no receipt')
    assertTrue(
      newest.entryId > headBefore.lastEntryId,
      'ids after a reset are above every id from before it',
    )

    const entries = await readAll(fixture.store, fixture.sessionId)
    assertEqual(entries.length, 2, 'the old incarnation is physically gone')
    const anchor = entries.find((entry) => entry.name === 'session/start')
    if (anchor === undefined) fail('the new incarnation has no session/start')
    assertEqual(
      anchor.payload['incarnationId'],
      nextIncarnation,
      'the fresh anchor names the new id',
    )
    assertEqual(anchor.prevHash, null, 'a new incarnation opens a new chain')
  })

  add('a stale incarnation is refused on append and on a paged read', async (open) => {
    const fixture = await open()
    const stale = fixture.incarnationId
    await appendAll(fixture, [startEntry(fixture, stale), extFact(fixture, 1)])
    const fresh = fixture.ids.uuid()
    await fixture.store.resetSession({
      sessionId: fixture.sessionId,
      incarnationId: fresh,
      start: startEntry(fixture, fresh),
    })
    await assertRejects(
      () =>
        fixture.store.append({
          sessionId: fixture.sessionId,
          incarnationId: stale,
          entries: [extFact(fixture, 2)],
        }),
      TapeStaleIncarnationError,
      'appending with the previous incarnation',
    )
    await assertRejects(
      () =>
        fixture.store.readRange({
          sessionId: fixture.sessionId,
          incarnationId: stale,
          limit: 10,
        }),
      TapeStaleIncarnationError,
      'paging with the previous incarnation',
    )
    const entries = await readAll(fixture.store, fixture.sessionId)
    assertEqual(entries.length, 1, 'the refused append wrote nothing')
  })

  add('an EMPTY batch still answers the stale-incarnation question', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    // An empty batch writes nothing, so both stores are free to shortcut it — but they must shortcut
    // it the SAME way, and the guard is cheaper than the divergence: a caller holding a stale
    // incarnation learns it is stale on the call it made, not two calls later. Reported by a reviewer
    // as a real divergence between the two stores (SQLite resolved to [], memory threw).
    await assertRejects(
      () =>
        fixture.store.append({
          sessionId: fixture.sessionId,
          incarnationId: fixture.ids.uuid(),
          entries: [],
        }),
      TapeStaleIncarnationError,
      'an empty batch carrying an incarnation the head does not have',
    )
    assertEqual(
      await appendAll(fixture, []),
      [],
      'an empty batch on the current incarnation is an empty answer',
    )
    // And on a session that does not exist yet: nothing to be stale against, and nothing created.
    const unborn = fixture.ids.uuid()
    assertEqual(
      await fixture.store.append({
        sessionId: unborn,
        incarnationId: fixture.ids.uuid(),
        entries: [],
      }),
      [],
      'an empty batch never creates a head row',
    )
    assertEqual(await fixture.store.head(unborn), null, 'no head row was conjured up')
  })

  add('resetSession on an unknown session throws and writes nothing', async (open) => {
    const fixture = await open()
    const unknown = fixture.ids.uuid()
    const incarnation = fixture.ids.uuid()
    await assertRejects(
      () =>
        fixture.store.resetSession({
          sessionId: unknown,
          incarnationId: incarnation,
          start: write('session', 'session/start', {
            sourceType: 'session',
            sourceId: unknown,
            sourceSeq: 0,
            provenanceKey: sessionStartKey(incarnation),
            payload: { incarnationId: incarnation },
            createdAt: fixture.at(),
          }),
        }),
      TapeSessionNotFoundError,
      'resetting a session that has no head row',
    )
    assertEqual(await fixture.store.head(unknown), null, 'no head row was conjured up')
    assertEqual((await readAll(fixture.store, unknown)).length, 0, 'no facts were written')
  })

  add('a reset carries a NEW incarnation and opens it with session/start', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId), extFact(fixture, 1)])
    const headBefore = await fixture.store.head(fixture.sessionId)
    if (headBefore === null) fail('head row is missing')
    // Reusing the current incarnation would make two generations hash-indistinguishable.
    await assertRejects(
      () =>
        fixture.store.resetSession({
          sessionId: fixture.sessionId,
          incarnationId: fixture.incarnationId,
          start: startEntry(fixture, fixture.incarnationId),
        }),
      TapeStaleIncarnationError,
      'resetting into the incarnation the session is already in',
    )
    // And the anchor is the one fact a reset writes: anything else is a call-site error.
    const fresh = fixture.ids.uuid()
    await assertRejects(
      () =>
        fixture.store.resetSession({
          sessionId: fixture.sessionId,
          incarnationId: fresh,
          start: modelSelected(fixture, fixture.ids.uuid()),
        }),
      TypeError,
      'resetting with something other than session/start',
    )
    assertEqual(await fixture.store.head(fixture.sessionId), headBefore, 'neither call wrote')
  })

  // ----- acceptance 11: idempotency and conflict -------------------------------------------------

  add(
    'the same key with the same content returns the original receipt exactly once',
    async (open) => {
      const counts = new Map<string, number>()
      const fixture = await open({ project: countingReducer(counts) })
      const messageId = fixture.ids.uuid()
      const [, first] = await appendAll(fixture, [
        startEntry(fixture, fixture.incarnationId),
        userMessage(fixture, messageId, 0, 'resend me'),
      ])
      if (first === undefined) fail('the first append returned no receipt for the message')
      assertTrue(first.created, 'the first write created a row')
      const headAfterFirst = await fixture.store.head(fixture.sessionId)
      if (headAfterFirst === null) fail('head row is missing')

      // A retry rebuilds the same fact with a LATER clock: created_at is deliberately not compared.
      const replay = await appendAll(fixture, [userMessage(fixture, messageId, 0, 'resend me')])
      const second = replay[0]
      if (second === undefined) fail('the replay returned no receipt')
      assertEqual(second.created, false, 'the second write created nothing')
      assertEqual(second.entryId, first.entryId, 'the original entryId comes back')
      assertEqual(second.entryHash, first.entryHash, 'the original entryHash comes back')

      const headAfterReplay = await fixture.store.head(fixture.sessionId)
      if (headAfterReplay === null) fail('head row vanished')
      assertEqual(
        headAfterReplay.lastEntryId,
        headAfterFirst.lastEntryId,
        'last_entry_id did not move',
      )
      assertEqual(headAfterReplay.entryCount, headAfterFirst.entryCount, 'entry_count did not move')

      const entries = await readAll(fixture.store, fixture.sessionId)
      assertEqual(entries.length, 2, 'no second row was written')
      assertEqual(
        entries.map((entry) => entry.entryId),
        [1, 2],
        'the id sequence has no holes: the idempotent branch allocated nothing',
      )
      assertEqual(
        counts.get(`message/user#${first.entryId}`),
        1,
        'the reducer ran exactly once for the message fact',
      )
      // A third write, in a batch with a genuinely new fact: the batch must not become a conflict.
      const mixed = await appendAll(fixture, [
        userMessage(fixture, messageId, 0, 'resend me'),
        extFact(fixture, 1),
      ])
      assertEqual(
        mixed.map((result) => result.created),
        [false, true],
        'an idempotent hit next to a new fact in one batch',
      )
    },
  )

  add('the same key with different content is a conflict, whatever differs', async (open) => {
    const fixture = await open()
    const messageId = fixture.ids.uuid()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId),
      userMessage(fixture, messageId, 0, 'original'),
    ])
    const key = messageRevisionKey(messageId, 0)
    const before = await readAll(fixture.store, fixture.sessionId)

    await assertRejects(
      () =>
        appendAll(fixture, [
          write('message', 'message/user', {
            sourceType: 'message',
            sourceId: messageId,
            sourceSeq: 0,
            provenanceKey: key,
            payload: {
              messageId,
              revision: 0,
              role: 'user',
              content: [{ type: 'text', text: 'edited without a new revision' }],
              status: 'complete',
            },
            createdAt: fixture.at(),
          }),
        ]),
      TapeProvenanceConflictError,
      'same key, different payload',
    )
    // A different name and kind conflicts too (this one's payload differs as well — the case below
    // isolates each identity column with bytes that are identical).
    await assertRejects(
      () =>
        appendAll(fixture, [
          write('message', 'message/assistant', {
            sourceType: 'message',
            sourceId: messageId,
            sourceSeq: 0,
            provenanceKey: key,
            payload: {
              messageId,
              revision: 0,
              role: 'assistant',
              runId: fixture.ids.uuid(),
              content: [{ type: 'text', text: 'original' }],
              status: 'complete',
            },
            createdAt: fixture.at(),
          }),
        ]),
      TapeProvenanceConflictError,
      'same key, different name and kind',
    )
    await assertRejects(
      () =>
        appendAll(fixture, [
          write('message', 'message/user', {
            sourceType: 'message',
            sourceId: fixture.ids.uuid(),
            sourceSeq: 0,
            provenanceKey: key,
            payload: {
              messageId,
              revision: 0,
              role: 'user',
              content: [{ type: 'text', text: 'original' }],
              status: 'complete',
            },
            createdAt: fixture.at(),
          }),
        ]),
      TapeProvenanceConflictError,
      'same key and payload, different sourceId',
    )
    assertEqual(await readAll(fixture.store, fixture.sessionId), before, 'the tape is unchanged')
  })

  add('the comparison covers every identity column, not just the content hash', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    // One `ext/<owner>/…` fact, then the same key with a BYTE-IDENTICAL payload and exactly one
    // identity column changed. Identical bytes are the point: the content hash alone cannot tell
    // these apart, so each branch reaches a different half of the comparison (spec 01 §存储端口:
    // `content_hash` AND kind, name, source_type, source_id, source_seq).
    const base = write(null, 'ext/acme/note', {
      kind: 'event',
      sourceType: 'session',
      sourceId: fixture.sessionId,
      sourceSeq: 0,
      provenanceKey: 'ext:v1:acme:identity',
      payload: { note: 'unchanged bytes' },
      createdAt: fixture.at(),
    })
    await appendAll(fixture, [base])
    const before = await readAll(fixture.store, fixture.sessionId)
    const variants: readonly (readonly [string, NewEntry])[] = [
      ['kind', { ...base, kind: 'message' }],
      ['name', { ...base, name: 'ext/acme/other' }],
      ['sourceType', { ...base, sourceType: 'summary' }],
      ['sourceId', { ...base, sourceId: fixture.ids.uuid() }],
      ['sourceSeq', { ...base, sourceSeq: 7 }],
      ['payload', { ...base, payload: { note: 'different bytes' } }],
    ]
    for (const [column, variant] of variants) {
      // oxlint-disable-next-line no-await-in-loop -- one rejection asserted per column, in order
      await assertRejects(
        () => appendAll(fixture, [variant]),
        TapeProvenanceConflictError,
        `same key, only ${column} differs`,
      )
    }
    // And a replay with a LATER clock is still the same fact: created_at is deliberately not compared.
    const replay = await appendAll(fixture, [{ ...base, createdAt: fixture.at() }])
    assertEqual(replay[0]?.created, false, 'a later created_at does not make it a new fact')
    assertEqual(await readAll(fixture.store, fixture.sessionId), before, 'the tape is unchanged')
  })

  add('a duplicate key inside one batch rejects the whole batch', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    const headBefore = await fixture.store.head(fixture.sessionId)
    if (headBefore === null) fail('head row is missing')
    const messageId = fixture.ids.uuid()
    await assertRejects(
      () =>
        appendAll(fixture, [
          userMessage(fixture, messageId, 0, 'twice'),
          userMessage(fixture, messageId, 0, 'twice'),
        ]),
      TapeProvenanceConflictError,
      'two facts with one provenance key in one batch',
    )
    assertEqual(
      (await readAll(fixture.store, fixture.sessionId)).length,
      1,
      'neither of the two was written',
    )
    assertEqual(await fixture.store.head(fixture.sessionId), headBefore, 'the head did not move')
  })

  add('a failing second entry leaves the first unwritten and the store usable', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    const headBefore = await fixture.store.head(fixture.sessionId)
    if (headBefore === null) fail('head row is missing')
    const conflicting = fixture.ids.uuid()
    await appendAll(fixture, [userMessage(fixture, conflicting, 0, 'already here')])
    const headAfterSetup = await fixture.store.head(fixture.sessionId)
    if (headAfterSetup === null) fail('head row is missing')

    const survivor = fixture.ids.uuid()
    await assertRejects(
      () =>
        appendAll(fixture, [
          userMessage(fixture, survivor, 0, 'first of the failing batch'),
          // Same key as the fact above with a different payload: the second entry aborts the batch.
          write('message', 'message/user', {
            sourceType: 'message',
            sourceId: conflicting,
            sourceSeq: 0,
            provenanceKey: messageRevisionKey(conflicting, 0),
            payload: {
              messageId: conflicting,
              revision: 0,
              role: 'user',
              content: [{ type: 'text', text: 'different' }],
              status: 'complete',
            },
            createdAt: fixture.at(),
          }),
        ]),
      TapeProvenanceConflictError,
      'the second entry of the batch conflicts',
    )
    const entries = await readAll(fixture.store, fixture.sessionId)
    assertEqual(entries.length, 2, "the batch's first entry did not land")
    assertEqual(
      await fixture.store.head(fixture.sessionId),
      headAfterSetup,
      'the head is untouched',
    )
    assertEqual(
      (await fixture.store.listMessages({ sessionId: fixture.sessionId, limit: 10 })).length,
      1,
      'no projection row from the aborted batch',
    )
    // The store rolled back rather than leaving a transaction open.
    const afterwards = await appendAll(fixture, [userMessage(fixture, survivor, 0, 'retry')])
    const receipt = afterwards[0]
    if (receipt === undefined) fail('the retry returned no receipt')
    assertTrue(receipt.created, 'the same store still appends after a failed batch')
  })

  // ----- acceptance 13 / invariant 14: the store's own append gate -------------------------------

  add('the store refuses a reserved name and a malformed key on its own', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    const before = await readAll(fixture.store, fixture.sessionId)
    // Every attempt goes STRAIGHT at the port, as a test double or a second facade would. The gate is
    // a two-way assertion and the spec puts every store behind it (§保留命名空间), so this half cannot
    // live in the facade's tests alone: the slice half is the facade's, this half is every store's.
    const refused: readonly (readonly [string, ErrorClass, NewEntry])[] = [
      [
        'an undeclared sibling under a reserved prefix',
        TapeAppendAuthorizationError,
        {
          kind: 'event',
          name: 'execution/anything',
          sourceType: 'runtime_event',
          sourceId: fixture.sessionId,
          provenanceKey: 'execution:v1:anything',
          payload: {},
          createdAt: fixture.at(),
        },
      ],
      [
        'an exactly reserved, declared name with the wrong kind',
        TapeAppendAuthorizationError,
        {
          kind: 'event',
          name: 'message/user',
          sourceType: 'message',
          sourceId: fixture.sessionId,
          sourceSeq: 0,
          provenanceKey: messageRevisionKey(fixture.sessionId, 0),
          payload: {},
          createdAt: fixture.at(),
        },
      ],
      [
        'a declared name with the wrong identity triple',
        TapeAppendAuthorizationError,
        {
          kind: 'anchor',
          name: 'session/start',
          sourceType: 'runtime_event',
          sourceId: fixture.sessionId,
          sourceSeq: 0,
          provenanceKey: sessionStartKey(fixture.incarnationId),
          payload: {},
          createdAt: fixture.at(),
        },
      ],
      [
        'the context kind outside skill/',
        TapeAppendAuthorizationError,
        {
          kind: 'context',
          name: 'ext/acme/note',
          sourceType: 'session',
          sourceId: fixture.sessionId,
          provenanceKey: 'ext:v1:acme:context',
          payload: {},
          createdAt: fixture.at(),
        },
      ],
      [
        'a provenance key with a timestamp in it',
        TapeProvenanceSyntaxError,
        { ...extFact(fixture, 1), provenanceKey: 'ext:v1:acme:note.2026-09-21T10:00:00Z' },
      ],
    ]
    for (const [description, expected, entry] of refused) {
      // oxlint-disable-next-line no-await-in-loop -- one rejection asserted per attempt, in order
      await assertRejects(
        () =>
          fixture.store.append({
            sessionId: fixture.sessionId,
            incarnationId: fixture.incarnationId,
            entries: [entry],
          }),
        expected,
        `the store accepted ${description}`,
      )
    }
    // A batch is validated as a whole, so one bad entry keeps the good one out too.
    await assertRejects(
      () =>
        fixture.store.append({
          sessionId: fixture.sessionId,
          incarnationId: fixture.incarnationId,
          entries: [extFact(fixture, 2), { ...extFact(fixture, 3), name: 'view/assembled' }],
        }),
      TapeAppendAuthorizationError,
      'a batch whose second entry is unauthorised',
    )
    assertEqual(await readAll(fixture.store, fixture.sessionId), before, 'nothing was written')
  })

  // ----- acceptance 15: bounded reads, pinning, no host types ------------------------------------

  add('reads are bounded: a limit above the ceiling is refused', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    await assertRejects(
      () => fixture.store.readRange({ sessionId: fixture.sessionId, limit: MAX_READ_LIMIT + 1 }),
      TapeReadLimitError,
      'readRange above the ceiling',
    )
    await assertRejects(
      () =>
        fixture.store.readBySource({
          sessionId: fixture.sessionId,
          sourceType: 'session',
          sourceId: fixture.sessionId,
          limit: MAX_READ_LIMIT + 1,
        }),
      TapeReadLimitError,
      'readBySource above the ceiling',
    )
    await assertRejects(
      () => fixture.store.verifyChain({ sessionId: fixture.sessionId, limit: MAX_READ_LIMIT + 1 }),
      TapeReadLimitError,
      'verifyChain above the ceiling',
    )
    await assertRejects(
      () => fixture.store.listMessages({ sessionId: fixture.sessionId, limit: MAX_READ_LIMIT + 1 }),
      TapeReadLimitError,
      'listMessages above the ceiling',
    )
    await assertRejects(
      () => fixture.store.listSessions({ limit: MAX_READ_LIMIT + 1 }),
      TapeReadLimitError,
      'listSessions above the ceiling',
    )
    // The floor and the integers, not only the ceiling: zero rows and half a row are answers a store
    // would otherwise have to invent.
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      // oxlint-disable-next-line no-await-in-loop -- one rejection asserted per limit, in order
      await assertRejects(
        () => fixture.store.readRange({ sessionId: fixture.sessionId, limit }),
        TapeReadLimitError,
        `readRange with limit ${String(limit)}`,
      )
    }
    // An EMPTY kinds filter means neither "nothing" nor "everything" — it is refused, so the two
    // stores cannot settle on opposite readings (`kind IN ()` is not even valid SQL).
    await assertRejects(
      () => fixture.store.readRange({ sessionId: fixture.sessionId, limit: 10, kinds: [] }),
      TypeError,
      'readRange with an empty kinds filter',
    )
  })

  add('readRange filters by kind, and readBySource caps its page', async (open) => {
    const fixture = await open()
    const runId = fixture.ids.uuid()
    const messageId = fixture.ids.uuid()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId), // 1 · anchor
      modelSelected(fixture, runId), // 2 · event
      userMessage(fixture, messageId, 0, 'filtered'), // 3 · message
      attemptCompleted(fixture, runId, 0), // 4 · event
      assistantMessage(fixture, fixture.ids.uuid(), 0, runId, 'filtered too'), // 5 · message
    ])
    const idsOf = async (kinds: readonly TapeKind[], limit = 10): Promise<number[]> =>
      (await fixture.store.readRange({ sessionId: fixture.sessionId, limit, kinds })).entries.map(
        (entry) => entry.entryId,
      )
    // One kind and several kinds are two different query shapes in SQLite (§存储端口: a single kind
    // goes through `tape_entry_by_kind`, several scan the primary key), and replay depends on this
    // filter — it reads `kinds: REPLAY_KINDS` and nothing else.
    assertEqual(await idsOf(['message']), [3, 5], 'a single kind')
    assertEqual(await idsOf(['message', 'anchor']), [1, 3, 5], 'several kinds')
    assertEqual(await idsOf(['tool_call']), [], 'a kind with no rows')
    // Paging happens over the FILTERED set, not over the rows the filter skipped.
    const firstPage = await fixture.store.readRange({
      sessionId: fixture.sessionId,
      limit: 1,
      kinds: ['message'],
    })
    assertEqual(
      firstPage.entries.map((entry) => entry.entryId),
      [3],
      'the first filtered page',
    )
    if (firstPage.nextFromEntryId === null) fail('the filtered read stopped paging too early')
    const secondPage = await fixture.store.readRange({
      sessionId: fixture.sessionId,
      limit: 1,
      kinds: ['message'],
      fromEntryId: firstPage.nextFromEntryId,
    })
    assertEqual(
      secondPage.entries.map((entry) => entry.entryId),
      [5],
      'the second filtered page continues from the cursor',
    )
    // And `readBySource` is bounded as well (invariant 16): its limit is a cap, not a hint.
    await appendAll(fixture, [
      attemptCompleted(fixture, runId, 1),
      attemptCompleted(fixture, runId, 2),
    ])
    const capped = await fixture.store.readBySource({
      sessionId: fixture.sessionId,
      sourceType: 'runtime_event',
      sourceId: runId,
      limit: 2,
    })
    assertEqual(
      capped.map((entry) => entry.sourceSeq),
      [0, 1],
      'readBySource returns at most `limit` rows, in entry_id order',
    )
  })

  add('a page is full or final, and an exact multiple ends on an empty page', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId),
      extFact(fixture, 1),
      extFact(fixture, 2),
      extFact(fixture, 3),
    ])
    const pages: (readonly [readonly number[], number | null])[] = []
    let fromEntryId: number | undefined
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
      const page = await fixture.store.readRange({
        sessionId: fixture.sessionId,
        limit: 2,
        ...(fromEntryId === undefined ? {} : { fromEntryId }),
      })
      pages.push([page.entries.map((entry) => entry.entryId), page.nextFromEntryId])
      if (page.nextFromEntryId === null) break
      fromEntryId = page.nextFromEntryId
    }
    // Four facts at two per page: a FULL page always says "there may be more", so the count being an
    // exact multiple of the limit costs one empty final page. Guessing instead — "a full page that
    // happens to end at the last row is final" — cannot be done without a second query.
    assertEqual(
      pages,
      [
        [[1, 2], 3],
        [[3, 4], 5],
        [[], null],
      ],
      'the paging rule, including the empty final page',
    )
  })

  add('a paged read pinned at atEntryId equals a snapshot taken beforehand', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    // 5000 facts, appended in batches so the setup is one transaction per 250 rather than per fact.
    const total = 5000
    const batchSize = 250
    for (let base = 0; base < total; base += batchSize) {
      const batch: NewEntry[] = []
      for (let offset = 0; offset < batchSize; offset += 1) {
        batch.push(extFact(fixture, base + offset))
      }
      // oxlint-disable-next-line no-await-in-loop -- each batch is its own transaction, in order
      await appendAll(fixture, batch)
    }
    const head = await fixture.store.head(fixture.sessionId)
    if (head === null) fail('head row is missing')
    assertEqual(head.entryCount, total + 1, 'every fact landed')
    const pinnedAt = head.lastEntryId
    const snapshot = await readAll(fixture.store, fixture.sessionId, { atEntryId: pinnedAt })
    assertEqual(snapshot.length, total + 1, 'the snapshot holds the whole session')

    // Now read it again page by page, appending between pages: the pin must keep them out.
    const paged: TapeEntry[] = []
    let fromEntryId: number | undefined
    let incarnationId: string | undefined
    let interleaved = 0
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
      const page = await fixture.store.readRange({
        sessionId: fixture.sessionId,
        atEntryId: pinnedAt,
        limit: MAX_READ_LIMIT,
        ...(fromEntryId === undefined ? {} : { fromEntryId }),
        ...(incarnationId === undefined ? {} : { incarnationId }),
      })
      paged.push(...page.entries)
      incarnationId = page.incarnationId
      interleaved += 1
      // oxlint-disable-next-line no-await-in-loop -- the append has to land BETWEEN two pages
      await appendAll(fixture, [extFact(fixture, total + interleaved)])
      if (page.nextFromEntryId === null) break
      fromEntryId = page.nextFromEntryId
    }
    assertTrue(interleaved > 1, 'the session was read in more than one page')
    assertEqual(
      paged,
      snapshot,
      'the paged read equals the snapshot despite the appends between pages',
    )
    assertPortSafe(paged, 'readRange')
    assertPortSafe(await fixture.store.head(fixture.sessionId), 'head')
    assertPortSafe(
      await fixture.store.listMessages({ sessionId: fixture.sessionId, limit: 5 }),
      'listMessages',
    )
    assertPortSafe(await fixture.store.listSessions({ limit: 5 }), 'listSessions')
  })

  // ----- invariant 13: the chain ----------------------------------------------------------------

  add(
    'entry hashes recompute from what the port returns and the head names the last one',
    async (open) => {
      const fixture = await open()
      const runId = fixture.ids.uuid()
      const messageId = fixture.ids.uuid()
      await appendAll(fixture, [
        startEntry(fixture, fixture.incarnationId),
        modelSelected(fixture, runId),
        userMessage(fixture, messageId, 0, 'hash me'),
        attemptCompleted(fixture, runId, 0),
      ])
      const entries = await readAll(fixture.store, fixture.sessionId)
      let previous: Uint8Array | null = null
      for (const entry of entries) {
        const digest = contentHash(canonicalJson(entry.payload), canonicalJson(entry.meta))
        assertEqual(digest, entry.contentHash, `content_hash of entry ${entry.entryId}`)
        assertEqual(entry.prevHash, previous, `prev_hash of entry ${entry.entryId} links the chain`)
        const sealed = hashEntry({
          hashVer: entry.hashVer,
          tenantId: entry.tenantId,
          sessionId: entry.sessionId,
          incarnationId: entry.incarnationId,
          entryId: entry.entryId,
          kind: entry.kind,
          name: entry.name,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          sourceSeq: entry.sourceSeq,
          provenanceKey: entry.provenanceKey,
          createdAt: entry.createdAt,
          contentHash: entry.contentHash,
          prevHash: entry.prevHash,
        })
        assertEqual(sealed, entry.entryHash, `entry_hash of entry ${entry.entryId}`)
        previous = entry.entryHash
      }
      const head = await fixture.store.head(fixture.sessionId)
      if (head === null) fail('head row is missing')
      assertEqual(head.lastHash, previous, "head.lastHash is the last entry's hash")

      const verified = await fixture.store.verifyChain({ sessionId: fixture.sessionId, limit: 2 })
      assertEqual(verified.firstBadEntryId, null, 'a healthy chain reports no bad link')
      assertEqual(verified.checked, 2, 'verifyChain honours its limit')
      assertEqual(verified.incarnationId, head.incarnationId, 'verifyChain reports the incarnation')
      if (verified.nextFromEntryId === null) fail('verifyChain stopped paging too early')
      const rest = await fixture.store.verifyChain({
        sessionId: fixture.sessionId,
        fromEntryId: verified.nextFromEntryId,
        incarnationId: verified.incarnationId,
        limit: MAX_READ_LIMIT,
      })
      assertEqual(rest.firstBadEntryId, null, 'the second page is healthy too')
      assertEqual(rest.checked, entries.length - 2, 'the two pages cover every entry')
    },
  )

  // ----- acceptance 3, projection half ----------------------------------------------------------

  add('a rebuilt projection equals the incrementally written one, row by row', async (open) => {
    const fixture = await open()
    const runOne = fixture.ids.uuid()
    const runTwo = fixture.ids.uuid()
    const firstUser = fixture.ids.uuid()
    const firstAssistant = fixture.ids.uuid()
    const secondUser = fixture.ids.uuid()
    const secondAssistant = fixture.ids.uuid()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId),
      modelSelected(fixture, runOne),
      userMessage(fixture, firstUser, 0, 'first question'),
      assistantMessage(fixture, firstAssistant, 0, runOne, 'first answer'),
      attemptCompleted(fixture, runOne, 0),
    ])
    await appendAll(fixture, [
      modelSelected(fixture, runTwo),
      userMessage(fixture, secondUser, 0, 'second question'),
      assistantMessage(fixture, secondAssistant, 0, runTwo, 'second answer'),
      attemptCompleted(fixture, runTwo, 0),
    ])
    // One revision of the first question and one retraction of the second answer.
    await appendAll(fixture, [userMessage(fixture, firstUser, 1, 'first question, edited')])
    await appendAll(fixture, [retraction(fixture, secondAssistant)])

    const incremental = await fixture.store.listMessages({
      sessionId: fixture.sessionId,
      limit: MAX_READ_LIMIT,
    })
    assertEqual(
      incremental.map((row) => row.messageId),
      [firstUser, firstAssistant, secondUser],
      'the retracted message is gone and order_seq still orders by first appearance',
    )
    const revised = incremental[0]
    if (revised === undefined) fail('the revised message is missing')
    assertEqual(revised.orderSeq, 3, 'order_seq is the entry id of the FIRST fact of the message')
    assertTrue(revised.entryId > revised.orderSeq, 'entry_id moved to the revision')
    assertEqual(revised.createdAt < revised.updatedAt, true, 'created_at did not move with it')
    assertEqual(
      revised.content,
      [{ type: 'text', text: 'first question, edited' }],
      'the row carries the latest revision',
    )

    const sessionsBefore = await fixture.store.listSessions({ limit: MAX_READ_LIMIT })
    const summaryBefore = sessionsBefore.find((row) => row.sessionId === fixture.sessionId)
    if (summaryBefore === undefined) fail('the session summary is missing')
    assertEqual(summaryBefore.providerId, 'anthropic', 'session_projection carries the provider')
    assertEqual(summaryBefore.modelId, 'claude-test', 'session_projection carries the model')
    assertEqual(summaryBefore.title, null, 'phase 1 never writes a title')

    await fixture.store.rebuildProjections(fixture.sessionId)
    const rebuilt = await fixture.store.listMessages({
      sessionId: fixture.sessionId,
      limit: MAX_READ_LIMIT,
    })
    assertEqual(rebuilt, incremental, 'message_projection rebuilt from the facts, row by row')
    const summaryAfter = (await fixture.store.listSessions({ limit: MAX_READ_LIMIT })).find(
      (row) => row.sessionId === fixture.sessionId,
    )
    assertEqual(summaryAfter, summaryBefore, 'session_projection rebuilt from the facts')

    // The cursor half of the same property: a second rebuild is a no-op, not a doubling.
    await fixture.store.rebuildProjections(fixture.sessionId)
    assertEqual(
      await fixture.store.listMessages({ sessionId: fixture.sessionId, limit: MAX_READ_LIMIT }),
      incremental,
      'rebuilding twice changes nothing',
    )
    await assertRejects(
      () => fixture.store.rebuildProjections(fixture.ids.uuid()),
      TapeSessionNotFoundError,
      'rebuilding a session that has no head row',
    )
  })

  add('a revision after a retraction resurrects the row at its own order_seq', async (open) => {
    const fixture = await open()
    const retracted = fixture.ids.uuid()
    const neighbour = fixture.ids.uuid()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId), // 1
      userMessage(fixture, retracted, 0, 'the first question'), // 2
      userMessage(fixture, neighbour, 0, 'the second question'), // 3
      retraction(fixture, retracted), // 4 · deletes the row (§删除语义)
      userMessage(fixture, retracted, 1, 'edited after deleting'), // 5 · re-inserts it
    ])
    const rows = await fixture.store.listMessages({
      sessionId: fixture.sessionId,
      limit: MAX_READ_LIMIT,
    })
    // A RECORDED GAP, pinned so both stores answer alike and nobody closes it by accident. §投影与重放
    // says a retraction does not move `order_seq`, while §删除语义 says it deletes the row — and a
    // reducer that cannot read the current row has nothing left to restore the original id from, so
    // the revision inserts afresh at its own entry id and the message moves to the end. The fold
    // (`effectiveMessages`, pinned in test/tape/replay.test.ts) keeps it at 2, so the interface's
    // order and the model's context order differ for this one sequence. Phase 1 has no writer for it —
    // edit and delete are phase 6, and regenerate retracts and then runs with NEW messageIds — and
    // closing it takes a spec decision (a visibility column, or a fold that makes retraction final).
    assertEqual(
      rows.map((row) => [row.messageId, row.orderSeq]),
      [
        [neighbour, 3],
        [retracted, 5],
      ],
      'the resurrected message sits after its neighbour, at the revision entry id',
    )
    // Whatever the answer is, a rebuild from the facts must reproduce it (invariant 12).
    await fixture.store.rebuildProjections(fixture.sessionId)
    assertEqual(
      await fixture.store.listMessages({ sessionId: fixture.sessionId, limit: MAX_READ_LIMIT }),
      rows,
      'a rebuild reaches the same rows through the same ops',
    )
  })

  add('listMessages returns the latest rows without a cursor and pages with one', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    const messageIds: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const messageId = fixture.ids.uuid()
      messageIds.push(messageId)
      // oxlint-disable-next-line no-await-in-loop -- one transaction per message, in order
      await appendAll(fixture, [userMessage(fixture, messageId, 0, `message ${index}`)])
    }
    const tail = await fixture.store.listMessages({ sessionId: fixture.sessionId, limit: 2 })
    assertEqual(
      tail.map((row) => row.messageId),
      messageIds.slice(-2),
      'no cursor means the LATEST rows, in order_seq order',
    )
    const head = tail[0]
    if (head === undefined) fail('the tail page is empty')
    const forward = await fixture.store.listMessages({
      sessionId: fixture.sessionId,
      limit: 10,
      afterOrderSeq: head.orderSeq,
    })
    assertEqual(
      forward.map((row) => row.messageId),
      messageIds.slice(-1),
      'afterOrderSeq is exclusive and reads forwards',
    )
    const backward = await fixture.store.listMessages({
      sessionId: fixture.sessionId,
      limit: 2,
      beforeOrderSeq: head.orderSeq,
    })
    assertEqual(
      backward.map((row) => row.messageId),
      messageIds.slice(1, 3),
      'beforeOrderSeq is exclusive and reads the rows nearest below it',
    )
  })

  // ----- readBySource, isolation, delete --------------------------------------------------------

  add('readBySource groups a run by its identity columns, in entry_id order', async (open) => {
    const fixture = await open()
    const runId = fixture.ids.uuid()
    const otherRun = fixture.ids.uuid()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId),
      attemptCompleted(fixture, runId, 0),
      attemptCompleted(fixture, otherRun, 0),
      attemptCompleted(fixture, runId, 1),
    ])
    const facts = await fixture.store.readBySource({
      sessionId: fixture.sessionId,
      sourceType: 'runtime_event',
      sourceId: runId,
      limit: 10,
    })
    assertEqual(
      facts.map((entry) => entry.sourceSeq),
      [0, 1],
      'only this run, ordered by entry_id',
    )
    assertEqual(
      facts.map((entry) => entry.entryId),
      [2, 4],
      'entry_id order, not source_seq order',
    )
  })

  add('sessions are isolated: separate id sequences and separate chains', async (open) => {
    const fixture = await open()
    const otherSession = fixture.ids.uuid()
    const otherIncarnation = fixture.ids.uuid()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId), extFact(fixture, 1)])
    await fixture.store.append({
      sessionId: otherSession,
      incarnationId: otherIncarnation,
      entries: [
        write('session', 'session/start', {
          sourceType: 'session',
          sourceId: otherSession,
          sourceSeq: 0,
          provenanceKey: sessionStartKey(otherIncarnation),
          payload: { incarnationId: otherIncarnation },
          createdAt: fixture.at(),
        }),
      ],
    })
    const other = await fixture.store.head(otherSession)
    if (other === null) fail('the second session has no head row')
    assertEqual(other.lastEntryId, 1, 'each session allocates ids from its own high-water mark')
    const mine = await readAll(fixture.store, fixture.sessionId)
    assertEqual(mine.length, 2, 'the second session did not leak into the first')
    const theirs = await readAll(fixture.store, otherSession)
    assertEqual(theirs.length, 1, 'and the first did not leak into the second')
    const anchor = theirs[0]
    if (anchor === undefined) fail('the second session has no anchor')
    assertEqual(anchor.prevHash, null, 'each session starts its own chain')
  })

  add('deleteSession removes the facts, the head and the projections', async (open) => {
    const fixture = await open()
    const messageId = fixture.ids.uuid()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId),
      userMessage(fixture, messageId, 0, 'delete me'),
    ])
    await fixture.store.deleteSession(fixture.sessionId)
    assertEqual(await fixture.store.head(fixture.sessionId), null, 'the head row is gone')
    assertEqual((await readAll(fixture.store, fixture.sessionId)).length, 0, 'the facts are gone')
    const rows: MessageRow[] = await fixture.store.listMessages({
      sessionId: fixture.sessionId,
      limit: 10,
    })
    assertEqual(rows.length, 0, 'the message projection is gone')
    assertEqual(
      (await fixture.store.listSessions({ limit: MAX_READ_LIMIT })).filter(
        (row) => row.sessionId === fixture.sessionId,
      ).length,
      0,
      'the session projection is gone',
    )
    // Deleting a session that is not there changes nothing and does not throw.
    await fixture.store.deleteSession(fixture.ids.uuid())
  })

  add('an append that does not open with session/start never creates a session', async (open) => {
    const fixture = await open()
    const messageId = fixture.ids.uuid()
    // The port promises that a session's first fact is its anchor (§存储端口: 「kernel 保证新
    // incarnation 的第一条是 session/start」). A caller cannot keep that promise on its own — a
    // `deleteSession` can land between its head read and its append — so the store enforces it, or a
    // run overtaken by a delete would RESURRECT the session with a `message/*` as the first fact of
    // an incarnation whose entry ids restart at 1, with no anchor to replay and every snapshot
    // coordinate into it now naming a different fact.
    await assertRejects(
      () => appendAll(fixture, [userMessage(fixture, messageId, 0, 'no anchor above me')]),
      TapeSessionNotFoundError,
      'an append with no anchor and no head row',
    )
    assertEqual(await fixture.store.head(fixture.sessionId), null, 'no head row was created')
    assertEqual((await readAll(fixture.store, fixture.sessionId)).length, 0, 'and no facts')
    assertEqual(
      (await fixture.store.listSessions({ limit: MAX_READ_LIMIT })).filter(
        (row) => row.sessionId === fixture.sessionId,
      ).length,
      0,
      'the session is absent from listSessions',
    )
    assertEqual(
      (await fixture.store.listMessages({ sessionId: fixture.sessionId, limit: 10 })).length,
      0,
      'and no orphan message row was projected',
    )
    // The same batch is fine once the incarnation has been opened: this is a rule about CREATING a
    // head row, not about which facts may follow one.
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    await appendAll(fixture, [userMessage(fixture, messageId, 0, 'no anchor above me')])
    assertEqual(
      (await readAll(fixture.store, fixture.sessionId)).map((entry) => entry.name),
      ['session/start', 'message/user'],
      'the anchor still opens the incarnation',
    )
    // A session deleted after it was opened goes back to the same rule.
    await fixture.store.deleteSession(fixture.sessionId)
    await assertRejects(
      () => appendAll(fixture, [userMessage(fixture, messageId, 0, 'no anchor above me')]),
      TapeSessionNotFoundError,
      'an append after the session was deleted',
    )
    assertEqual(await fixture.store.head(fixture.sessionId), null, 'the session stayed deleted')
  })

  add('a session this store cannot see reads as absent, never as an error', async (open) => {
    const fixture = await open()
    await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
    // A store cannot tell "another tenant's session" from "never existed", and acceptance 4 needs the
    // first to look exactly like the second: empty reads, a null head, no throw. Only the two writes
    // that would otherwise conjure a session up are errors (`resetSession`, `rebuildProjections`).
    const unknown = fixture.ids.uuid()
    assertEqual(
      await fixture.store.readRange({ sessionId: unknown, limit: 10 }),
      { entries: [], incarnationId: '', nextFromEntryId: null },
      'readRange of an unknown session',
    )
    assertEqual(
      await fixture.store.readBySource({
        sessionId: unknown,
        sourceType: 'runtime_event',
        sourceId: unknown,
        limit: 10,
      }),
      [],
      'readBySource of an unknown session',
    )
    assertEqual(await fixture.store.head(unknown), null, 'head of an unknown session')
    assertEqual(
      await fixture.store.verifyChain({ sessionId: unknown, limit: 10 }),
      { incarnationId: '', checked: 0, firstBadEntryId: null, nextFromEntryId: null },
      'verifyChain of an unknown session',
    )
    assertEqual(
      await fixture.store.listMessages({ sessionId: unknown, limit: 10 }),
      [],
      'listMessages of an unknown session',
    )
  })

  add('listSessions breaks a tie on session id by code unit, not by locale', async (open) => {
    const fixture = await open()
    // Equal `updatedAt` is the only case where the tie-break is observable, and the two stores must
    // agree: SQLite orders TEXT with BINARY collation, so the memory store compares code units rather
    // than calling `localeCompare` (whose answer here is ['a-1', 'B-1'] and also depends on the
    // runtime's ICU build). The port accepts any non-empty string as a session id, so this is
    // reachable without a non-canonical UUID.
    const at = 1_700_000_777_000
    for (const sessionId of ['a-1', 'B-1']) {
      const incarnationId = fixture.ids.uuid()
      // oxlint-disable-next-line no-await-in-loop -- one session per transaction, in order
      await fixture.store.append({
        sessionId,
        incarnationId,
        entries: [
          write('session', 'session/start', {
            sourceType: 'session',
            sourceId: sessionId,
            sourceSeq: 0,
            provenanceKey: sessionStartKey(incarnationId),
            payload: { incarnationId },
            // The SAME timestamp for both, or there is no tie to break.
            createdAt: at,
          }),
        ],
      })
    }
    const rows = await fixture.store.listSessions({ limit: MAX_READ_LIMIT })
    assertEqual(
      rows.map((row) => row.sessionId),
      ['B-1', 'a-1'],
      'uppercase sorts before lowercase, as SQLite BINARY does',
    )
  })

  // ----- acceptance 3 in full: the session service writes it, replay re-derives it ---------------

  add(
    'every attempt fact re-encodes to its own promptHash, pinned at its own contextAtEntryId',
    async (open) => {
      const ctx = await openService(open)
      const store = ctx.fixture.store
      const created = await ctx.service.createSession()
      const sessionId = created.sessionId

      ctx.provider.script(scriptedTurn({ deltas: ['first ', 'answer'], usage: SCRIPT_USAGE }))
      const first = await runTurn(ctx, sessionId, 'first question')
      assertEqual(first.status, 'complete', 'a normal stop persists the answer')
      if (first.assistantMessageId === null) fail('the first turn wrote no assistant message')

      // An edit of the first question and a retraction of the first answer, BETWEEN the two turns, so
      // the second request's context differs from the first's by more than one message. Phase 1 has no
      // writer for either (edit and delete are phase 6, regenerate retracts and runs with new ids), so
      // the facts go in through the same slice writer that phase will use.
      await store.append({
        sessionId,
        incarnationId: created.incarnationId,
        entries: [
          userMessage(ctx.fixture, first.userMessageId, 1, 'first question, edited'),
          retraction(ctx.fixture, first.assistantMessageId),
        ],
      })

      ctx.provider.script(scriptedTurn({ deltas: ['second answer'], usage: SCRIPT_USAGE }))
      const second = await runTurn(ctx, sessionId, 'second question')
      assertEqual(second.status, 'complete', 'the second turn persists its answer too')

      // What each request actually saw. The first one is pinned BELOW the revision and the retraction,
      // so it still replays the question as it was sent; the second sees the edit, does not see the
      // retracted answer, and therefore opens on two adjacent user turns — which replay is specified
      // to leave exactly as it found them.
      const firstContext = await rebuildProviderContext(store, {
        sessionId,
        atEntryId: first.contextAtEntryId,
        target: SCRIPT_MODEL,
      })
      // The first request of a session carries the environment note after the question (spec 02
      // §提示层「环境说明」); the second, on the same day, finds it unchanged and writes none.
      const note = {
        role: 'user',
        content: [{ type: 'text', text: environmentText({ date: '2026-09-26', workspace: null }) }],
      }
      assertEqual(
        firstContext,
        [{ role: 'user', content: [{ type: 'text', text: 'first question' }] }, note],
        'the first request replays the question as it was sent, not as it was later edited',
      )
      const secondContext = await rebuildProviderContext(store, {
        sessionId,
        atEntryId: second.contextAtEntryId,
        target: SCRIPT_MODEL,
      })
      assertEqual(
        secondContext,
        [
          { role: 'user', content: [{ type: 'text', text: 'first question, edited' }] },
          note,
          { role: 'user', content: [{ type: 'text', text: 'second question' }] },
        ],
        'the second request sees the revision and not the retracted answer',
      )

      const attempts = await attemptFacts(store, sessionId)
      assertEqual(attempts.length, 2, 'one attempt fact per run')
      for (const entry of attempts) {
        // oxlint-disable-next-line no-await-in-loop -- one attempt fact at a time, in tape order
        await assertAttemptReEncodes(store, sessionId, entry)
        const fact = attemptPayloadOf(entry)
        assertEqual(fact.error, null, 'a completed turn records a stop, not an error')
        assertEqual(fact.usage, SCRIPT_USAGE, 'the final usage reading reached the fact')
      }
      assertTrue(
        attempts.every((entry) => entry.sourceType === 'runtime_event' && entry.sourceSeq === 1),
        'an attempt fact is identified by (runtime_event, runId, requestSeq)',
      )

      // The projection half of the same acceptance: what was written incrementally and what a rebuild
      // derives from the facts are the same rows.
      const incremental = await store.listMessages({ sessionId, limit: MAX_READ_LIMIT })
      assertEqual(
        incremental.map((row) => [row.role, textOf(row.content)]),
        [
          ['user', 'first question, edited'],
          ['user', 'second question'],
          ['assistant', 'second answer'],
        ],
        'the retracted answer is gone and order_seq still orders by first appearance',
      )
      const summaryBefore = (await store.listSessions({ limit: MAX_READ_LIMIT })).find(
        (row) => row.sessionId === sessionId,
      )
      if (summaryBefore === undefined) fail('the session summary is missing')
      assertEqual(summaryBefore.providerId, SCRIPT_PROVIDER_ID, 'the run recorded its provider')
      assertEqual(summaryBefore.modelId, SCRIPT_MODEL.id, 'the run recorded its model')
      await store.rebuildProjections(sessionId)
      assertEqual(
        await store.listMessages({ sessionId, limit: MAX_READ_LIMIT }),
        incremental,
        'message_projection rebuilt from the facts, row by row',
      )
      assertEqual(
        (await store.listSessions({ limit: MAX_READ_LIMIT })).find(
          (row) => row.sessionId === sessionId,
        ),
        summaryBefore,
        'session_projection rebuilt from the facts',
      )
    },
  )

  // ----- invariant 1: which usage reading becomes a fact -----------------------------------------

  add('an attempt records the reading marked final, not the last one to arrive', async (open) => {
    const ctx = await openService(open)
    const store = ctx.fixture.store
    const { sessionId } = await ctx.service.createSession()
    // A stream that reports usage twice and ends on the NON-final reading. Both shapes are real —
    // the Anthropic wire opens with a `message_start` reading that describes the prompt — and
    // nothing in invariant 1 fixes where a non-final reading sits relative to the final one. Only
    // `final: true` is a fact: a service that kept whichever reading came LAST would record this
    // turn as zero tokens, and an attempt fact is not correctable afterwards.
    ctx.provider.script([
      { type: 'text-delta', index: 0, text: 'an answer' },
      { type: 'usage', usage: SCRIPT_USAGE },
      { type: 'usage', usage: NON_FINAL_USAGE },
      stopEvent('end-turn', 'end_turn'),
    ])
    const result = await runTurn(ctx, sessionId, 'how many tokens did that cost?')
    assertEqual(result.status, 'complete', 'the turn completed')
    assertEqual(result.usage, SCRIPT_USAGE, 'the run result reports the reading marked final')
    const attempts = await attemptFacts(store, sessionId)
    assertEqual(attempts.length, 1, 'one attempt fact')
    const entry = attempts[0]
    if (entry === undefined) fail('the attempt fact is missing')
    assertEqual(
      attemptPayloadOf(entry).usage,
      SCRIPT_USAGE,
      'the fact holds the final reading, not the last one that arrived',
    )
  })

  // ----- acceptance 7, the tape half ------------------------------------------------------------

  add(
    'an abort at any point leaves one attempt fact and exactly the text that arrived',
    async (open) => {
      const ctx = await openService(open)
      const store = ctx.fixture.store
      const { sessionId } = await ctx.service.createSession()
      const deltas = ['a', 'b', 'c', 'd', 'e', 'f']
      const runIds: string[] = []
      // k = 0 stops the Run the moment its `run_started` is committed, so the signal is aborted before
      // the stream exists (the source is never created, invariant 2); k > 0 stops it from inside the
      // event handler, right after the k-th delta was forwarded — deterministic, and no timers. A
      // stop reaches the stream the only way it can: through the Run's lease.
      for (let k = 0; k <= deltas.length; k += 1) {
        ctx.provider.script(scriptedTurn({ deltas, usage: SCRIPT_USAGE }))
        const startsBefore = ctx.provider.starts
        let seen = 0
        ctx.listen((event) => {
          if (
            k === 0 ? event.type === 'run-started' : event.type === 'text-delta' && ++seen === k
          ) {
            void ctx.service.stop({ rootSessionId: sessionId })
          }
        })
        // oxlint-disable-next-line no-await-in-loop -- one run at a time: the tape is the assertion
        const sent = await ctx.service.send({ sessionId, origin: null, text: `abort after ${k}` })
        if (sent.status !== 'started') fail(`run ${k}: send answered ${describeValue(sent)}`)
        // oxlint-disable-next-line no-await-in-loop -- this run's end, then its facts
        const ended = await ctx.loop.runEnded({ runId: sent.runId })
        assertEqual(ended.reason, { code: 'user-stopped' }, `run ${k} ends as the user's stop`)
        // oxlint-disable-next-line no-await-in-loop -- this run's facts
        const result = await turnRecord(store, sessionId, sent.runId)
        ctx.listen(null)
        runIds.push(result.runId)
        const expected = deltas.slice(0, k).join('')
        assertEqual(
          result.stop,
          { reason: 'aborted', providerReason: null },
          `run ${k} ends aborted`,
        )
        assertEqual(result.error, null, `run ${k}: an abort is never an error`)
        assertEqual(textOf(result.content), expected, `run ${k} kept exactly what arrived`)
        assertEqual(result.usage, null, `run ${k}: the final reading never arrived`)
        if (k === 0) {
          assertEqual(
            ctx.provider.starts,
            startsBefore,
            'an already-aborted signal never starts a stream',
          )
          assertEqual(result.assistantMessageId, null, 'nothing arrived, so no assistant message')
          assertEqual(result.status, null, 'and no status was written')
        } else {
          assertEqual(result.status, 'aborted', `run ${k} persists the partial turn as aborted`)
          // oxlint-disable-next-line no-await-in-loop -- the row this run just wrote
          const rows = await store.listMessages({ sessionId, limit: MAX_READ_LIMIT })
          const row = rows.find((candidate) => candidate.messageId === result.assistantMessageId)
          if (row === undefined) fail(`run ${k}: the partial assistant message was not persisted`)
          assertEqual(textOf(row.content), expected, `run ${k}: the persisted text is what arrived`)
          assertEqual(row.status, 'aborted', `run ${k}: the row carries the aborted status`)
        }
        // Exactly one attempt fact per (runId, requestSeq, physicalAttempt), reachable by the identity
        // columns alone — which is the read phase 2's recovery is built on — after the Run's start.
        // oxlint-disable-next-line no-await-in-loop -- this run's facts, by its own runId
        const facts = await store.readBySource({
          sessionId,
          sourceType: 'runtime_event',
          sourceId: result.runId,
          limit: MAX_READ_LIMIT,
        })
        assertEqual(
          facts.map((candidate) => candidate.name),
          [
            'execution/run_started',
            'view/assembled',
            'provider/attempt_completed',
            'execution/run_terminal',
          ],
          `run ${k}: its start, its manifest, exactly one provider/attempt_completed and its end`,
        )
        const fact = facts[2]
        if (fact === undefined) fail(`run ${k}: readBySource returned no attempt fact`)
        assertEqual(
          fact.provenanceKey,
          attemptCompletedKey(result.runId, 1, 1),
          `run ${k}: the attempt key carries requestSeq and physicalAttempt`,
        )
        assertEqual(
          attemptPayloadOf(fact).stop,
          { reason: 'aborted', providerReason: null },
          `run ${k}: the fact records the abort`,
        )
      }
      assertEqual(new Set(runIds).size, runIds.length, 'every run has its own runId')
      assertEqual(
        (await attemptFacts(store, sessionId)).length,
        runIds.length,
        'one attempt fact per run and no more',
      )
    },
  )

  // ----- the retry rule, and a failed turn ------------------------------------------------------

  add('a resend after a failure is the same user message; a new text is not', async (open) => {
    const ctx = await openService(open)
    const store = ctx.fixture.store
    const { sessionId } = await ctx.service.createSession()

    // A failed turn: partial text arrived, and none of it is persisted — the evidence of the failure
    // is the attempt fact's `error`, and the user's message stays so a resend can be recognised.
    ctx.provider.script(
      scriptedTurn({
        deltas: ['half an '],
        // Not retryable, so the Run ends on this one attempt (spec 02 resends a transient error itself).
        terminal: {
          type: 'error',
          code: 'invalid-request',
          retryable: false,
          status: 400,
          providerCode: 'invalid_request_error',
          detail: 'upstream said no',
        },
      }),
    )
    const failed = await runTurn(ctx, sessionId, 'same question')
    assertEqual(failed.assistantMessageId, null, 'a failed turn writes no assistant message')
    assertEqual(failed.status, null, 'and no status')
    assertEqual(failed.stop, null, 'an error and a stop are exclusive')
    assertEqual(failed.error?.code, 'invalid-request', 'the error is on the run result')
    assertEqual(failed.userMessageCreated, true, 'the first send created the user message')

    // The same text again: the SAME messageId and revision, so the append is the idempotent no-op.
    ctx.provider.script(scriptedTurn({ deltas: ['an answer'], usage: SCRIPT_USAGE }))
    const retried = await runTurn(ctx, sessionId, 'same question')
    assertEqual(retried.userMessageId, failed.userMessageId, 'a resend reuses the messageId')
    assertEqual(retried.userMessageCreated, false, 'the second append is the idempotent no-op')
    assertTrue(retried.runId !== failed.runId, 'two runs, two runIds')
    for (const result of [failed, retried]) {
      // oxlint-disable-next-line no-await-in-loop -- one run's facts at a time
      const facts = await store.readBySource({
        sessionId,
        sourceType: 'runtime_event',
        sourceId: result.runId,
        limit: MAX_READ_LIMIT,
      })
      assertEqual(
        facts.filter((fact) => fact.name === 'provider/attempt_completed').length,
        1,
        'each run recorded its own attempt',
      )
    }
    assertEqual(
      (await attemptFacts(store, sessionId)).length,
      2,
      'a retry is one user message and TWO attempts',
    )

    // The rule only holds because a user message carries nothing run-scoped: a `runId` in the payload
    // or the meta would make the second append "same key, different content".
    const entries = await readAll(store, sessionId)
    const userFacts = entries.filter((entry) => entry.name === 'message/user')
    assertEqual(userFacts.length, 1, 'the resend wrote no second row')
    const userFact = userFacts[0]
    if (userFact === undefined) fail('the user message is missing')
    assertEqual(userFact.payload['runId'], undefined, 'a user message payload has no runId')
    assertEqual(userFact.meta, {}, 'and no meta either')

    // A different text is a different message.
    ctx.provider.script(scriptedTurn({ deltas: ['another answer'], usage: SCRIPT_USAGE }))
    const third = await runTurn(ctx, sessionId, 'another question')
    assertTrue(third.userMessageId !== retried.userMessageId, 'a new text mints a new messageId')
    assertEqual(third.userMessageCreated, true, 'and creates a row')
    assertEqual(
      (await store.listMessages({ sessionId, limit: MAX_READ_LIMIT })).map((row) => [
        row.role,
        textOf(row.content),
      ]),
      [
        ['user', 'same question'],
        ['assistant', 'an answer'],
        ['user', 'another question'],
        ['assistant', 'another answer'],
      ],
      'the transcript holds one question per text and one answer per successful run',
    )
  })

  // ----- two runs at once: two sessions, one store (spec 02, 01 修补 9 (v)) ------------------------
  //
  // Phase 1 checked two concurrent runs on ONE session here. Spec 02's mailbox makes that impossible
  // — the second send of a root queues behind the first — so the store's half of the property is
  // checked across two sessions instead: two Runs in flight at once, interleaving on one store.

  add('two sessions running at once leave the tape consistent', async (open) => {
    const ctx = await openService(open)
    const store = ctx.fixture.store
    const left = await ctx.service.createSession()
    const right = await ctx.service.createSession()
    // Which answer belongs to which session is not asserted: the scripts are handed out in the order
    // the two Runs reach the provider.
    ctx.provider.script(scriptedTurn({ deltas: ['left answer'], usage: SCRIPT_USAGE }))
    ctx.provider.script(scriptedTurn({ deltas: ['right answer'], usage: SCRIPT_USAGE }))
    const [leftTurn, rightTurn] = await Promise.all([
      runTurn(ctx, left.sessionId, 'left question'),
      runTurn(ctx, right.sessionId, 'right question'),
    ])
    if (leftTurn === undefined || rightTurn === undefined) fail('a concurrent run returned nothing')
    assertTrue(leftTurn.runId !== rightTurn.runId, 'each run minted its own runId')
    assertEqual(ctx.loop.leaseLog.length, 2, 'one lease per root')
    for (const [sessionId, turn] of [
      [left.sessionId, leftTurn],
      [right.sessionId, rightTurn],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one session's facts at a time
      const entries = await readAll(store, sessionId)
      assertEqual(
        entries.filter((entry) => entry.name === 'provider/attempt_completed').length,
        1,
        'each concurrent run recorded exactly one attempt, in its own session',
      )
      assertTrue(
        entries.every(
          (entry, index) => index === 0 || entry.entryId > (entries[index - 1]?.entryId ?? 0),
        ),
        'entry ids stayed strictly increasing through the interleaving',
      )
      assertEqual(
        new Set(entries.map((entry) => entry.provenanceKey)).size,
        entries.length,
        'no two facts share a provenance key',
      )
      // oxlint-disable-next-line no-await-in-loop -- this session's chain
      const verified = await store.verifyChain({ sessionId, limit: MAX_READ_LIMIT })
      assertEqual(verified.firstBadEntryId, null, 'the chain is intact after the interleaving')
      assertEqual(verified.checked, entries.length, 'every entry was checked')
      // The pin is this Run's OWN pre-run batch, not a head read: the other session's writes landing
      // in between must stay out of this one's audit.
      const selected = entries.find((entry) => entry.provenanceKey === modelSelectedKey(turn.runId))
      const note = entries.find((entry) => entry.name === 'message/environment')
      assertEqual(
        turn.contextAtEntryId,
        note?.entryId ?? selected?.entryId,
        "the pin is the run's own pre-run batch, topped by its environment note",
      )
      // oxlint-disable-next-line no-await-in-loop -- one attempt fact at a time
      for (const entry of await attemptFacts(store, sessionId)) {
        // oxlint-disable-next-line no-await-in-loop -- one attempt fact at a time
        await assertAttemptReEncodes(store, sessionId, entry)
      }
      // oxlint-disable-next-line no-await-in-loop -- this session's rows
      const rows = await store.listMessages({ sessionId, limit: MAX_READ_LIMIT })
      assertEqual(
        rows.map((row) => row.role),
        ['user', 'assistant'],
        'each session holds its question and one answer',
      )
      // oxlint-disable-next-line no-await-in-loop -- this session's rebuild
      await store.rebuildProjections(sessionId)
      assertEqual(
        // oxlint-disable-next-line no-await-in-loop -- this session's rows again
        await store.listMessages({ sessionId, limit: MAX_READ_LIMIT }),
        rows,
        'a rebuild reproduces the projection',
      )
    }
  })

  // ----- spec 02 · 01 修补 7: the port additions (acceptance 11) --------------------------------

  add(
    'readBySource pages a run of more than 1000 facts from fromEntryId, as one snapshot',
    async (open) => {
      // 旧 58. The run's facts outnumber one page, and another run's facts are interleaved with them, so
      // the cursor has to be an entry id (not a count) and has to stay on this run's identity columns.
      const fixture = await open()
      const runId = fixture.ids.uuid()
      const otherRun = fixture.ids.uuid()
      const messageId = fixture.ids.uuid()
      await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
      const total = MAX_READ_LIMIT + 203
      for (let batch = 0; batch * 250 < total; batch += 1) {
        const entries: NewEntry[] = []
        for (
          let ordinal = batch * 250;
          ordinal < Math.min(total, (batch + 1) * 250);
          ordinal += 1
        ) {
          entries.push(toolCallFact(fixture, { runId, requestSeq: 0, ordinal }, messageId))
          if (ordinal % 100 === 0) {
            entries.push(
              toolCallFact(fixture, { runId: otherRun, requestSeq: 0, ordinal }, messageId),
            )
          }
        }
        // oxlint-disable-next-line no-await-in-loop -- batches go in one after another
        await appendAll(fixture, entries)
      }
      const snapshot = (await readAll(fixture.store, fixture.sessionId)).filter(
        (entry) => entry.sourceType === 'runtime_event' && entry.sourceId === runId,
      )
      assertEqual(snapshot.length, total, 'the snapshot holds every fact of the run')
      const paged: TapeEntry[] = []
      let fromEntryId: number | undefined
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
        const page = await fixture.store.readBySource({
          sessionId: fixture.sessionId,
          sourceType: 'runtime_event',
          sourceId: runId,
          limit: MAX_READ_LIMIT,
          ...(fromEntryId === undefined ? {} : { fromEntryId }),
        })
        paged.push(...page)
        const last = page.at(-1)
        if (last === undefined || page.length < MAX_READ_LIMIT) break
        fromEntryId = last.entryId + 1
      }
      assertEqual(paged, snapshot, 'paging from fromEntryId reads the same facts as the snapshot')
      const first = snapshot[0]
      const second = snapshot[1]
      if (first === undefined || second === undefined) fail('the run has no facts')
      assertEqual(
        (
          await fixture.store.readBySource({
            sessionId: fixture.sessionId,
            sourceType: 'runtime_event',
            sourceId: runId,
            fromEntryId: second.entryId,
            limit: 1,
          })
        ).map((entry) => entry.entryId),
        [second.entryId],
        'fromEntryId is inclusive',
      )
      for (const bad of [-1, 1.5, Number.NaN]) {
        // oxlint-disable-next-line no-await-in-loop -- one rejection asserted per cursor
        await assertRejects(
          () =>
            fixture.store.readBySource({
              sessionId: fixture.sessionId,
              sourceType: 'runtime_event',
              sourceId: runId,
              fromEntryId: bad,
              limit: 10,
            }),
          TypeError,
          `fromEntryId ${String(bad)} was accepted`,
        )
      }
    },
  )

  add(
    'after close() every method rejects with TapeClosedError, and close() stays idempotent',
    async (open) => {
      // 旧 59 / 旧 113, the store half (B4). The check comes before the input is looked at, so a call
      // that would also be malformed still names the closed store.
      const fixture = await open()
      await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
      await fixture.store.close()
      await fixture.store.close()
      const sessionId = fixture.sessionId
      const calls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
        ['append', () => appendAll(fixture, [extFact(fixture, 1)])],
        ['readRange', () => fixture.store.readRange({ sessionId, limit: 10 })],
        ['readRange with a bad limit', () => fixture.store.readRange({ sessionId, limit: 0 })],
        [
          'readBySource',
          () =>
            fixture.store.readBySource({
              sessionId,
              sourceType: 'session',
              sourceId: sessionId,
              limit: 1,
            }),
        ],
        ['head', () => fixture.store.head(sessionId)],
        ['verifyChain', () => fixture.store.verifyChain({ sessionId, limit: 10 })],
        ['listSessions', () => fixture.store.listSessions({ limit: 10 })],
        ['listMessages', () => fixture.store.listMessages({ sessionId, limit: 10 })],
        ['listPendingApprovals', () => fixture.store.listPendingApprovals({ limit: 10 })],
        ['rebuildProjections', () => fixture.store.rebuildProjections(sessionId)],
        [
          'resetSession',
          () => {
            const next = fixture.ids.uuid()
            return fixture.store.resetSession({
              sessionId,
              incarnationId: next,
              start: startEntry(fixture, next),
            })
          },
        ],
        ['deleteSession', () => fixture.store.deleteSession(sessionId)],
      ]
      for (const [method, call] of calls) {
        // oxlint-disable-next-line no-await-in-loop -- one rejection asserted per method, in order
        await assertRejects(call, TapeClosedError, `${method} after close()`)
      }
    },
  )

  add(
    '02 不变量 32: a revision of a retracted message is refused and the tape is unchanged',
    async (open) => {
      // Through the kernel's facade — the message writer — because a store never learns who called it.
      // The store half (what a store does with such a revision when it is handed one anyway) is the
      // 'a revision after a retraction resurrects the row' case above, which stays.
      const fixture = await open()
      const tape = createTape(fixture.store)
      const messageId = fixture.ids.uuid()
      await appendAll(fixture, [
        startEntry(fixture, fixture.incarnationId),
        userMessage(fixture, messageId, 0, 'first'),
        retraction(fixture, messageId),
      ])
      const before = await readAll(fixture.store, fixture.sessionId)
      const head = await fixture.store.head(fixture.sessionId)
      const batch = (entries: readonly NewEntry[]): Promise<AppendResult[]> =>
        tape.appendEntries({
          sessionId: fixture.sessionId,
          incarnationId: fixture.incarnationId,
          entries,
        })
      await assertRejects(
        () => batch([userMessage(fixture, messageId, 1, 'edited after the delete')]),
        TapeMessageRetractedError,
        'a revision after the retraction',
      )
      await assertRejects(
        () =>
          tape.writer('message').write({
            sessionId: fixture.sessionId,
            incarnationId: fixture.incarnationId,
            fact: {
              name: 'message/assistant',
              fields: {
                sourceType: 'message',
                sourceId: messageId,
                sourceSeq: 2,
                provenanceKey: messageRevisionKey(messageId, 2),
                payload: {
                  messageId,
                  revision: 2,
                  role: 'assistant',
                  runId: fixture.ids.uuid(),
                  content: [{ type: 'text', text: 'x' }],
                  status: 'complete',
                },
                createdAt: fixture.at(),
              },
            },
          }),
        TapeMessageRetractedError,
        'a revision through the message slice writer',
      )
      // A tombstone EARLIER in the same batch is final too.
      const fresh = fixture.ids.uuid()
      await assertRejects(
        () => batch([retraction(fixture, fresh), userMessage(fixture, fresh, 0, 'after')]),
        TapeMessageRetractedError,
        'a revision behind a tombstone in its own batch',
      )
      assertEqual(await readAll(fixture.store, fixture.sessionId), before, 'the tape is unchanged')
      assertEqual(await fixture.store.head(fixture.sessionId), head, 'and so is the head')
      // Replaying the SAME tombstone is not a revision: 01 invariant 11 still answers it.
      const [replayed] = await batch([retraction(fixture, messageId)])
      assertEqual(replayed?.created, false, 'the same message/retracted is an idempotent no-op')
      // Other messages are unaffected.
      const [other] = await batch([userMessage(fixture, fixture.ids.uuid(), 0, 'unrelated')])
      assertEqual(other?.created, true, 'a message that was never retracted still writes')
    },
  )

  add(
    'resetSession writes the carry right after the new session/start, in one transaction',
    async (open) => {
      // 旧 110, first half (H1, D11): the profile and workspace facts a cleared session keeps.
      const fixture = await open()
      const messageId = fixture.ids.uuid()
      await appendAll(fixture, [
        startEntry(fixture, fixture.incarnationId),
        profileFact(fixture, fixture.incarnationId),
        workspaceFact(fixture, fixture.incarnationId, 0),
        userMessage(fixture, messageId, 0, 'before the reset'),
      ])
      const next = fixture.ids.uuid()
      const carry = [profileFact(fixture, next), workspaceFact(fixture, next, 0)]
      const receipt = await fixture.store.resetSession({
        sessionId: fixture.sessionId,
        incarnationId: next,
        start: startEntry(fixture, next),
        carry,
      })
      fixture.incarnationId = next
      const after = await readAll(fixture.store, fixture.sessionId)
      assertEqual(
        after.map((entry) => entry.name),
        ['session/start', 'session/profile_set', 'session/workspace_set'],
        'the new incarnation is session/start and then the carry, in order',
      )
      assertEqual(receipt.entryId, after[0]?.entryId, "the receipt is session/start's")
      assertEqual(receipt.created, true, 'and it is a fresh write')
      const head = await fixture.store.head(fixture.sessionId)
      assertEqual(head?.entryCount, 1 + carry.length, 'entryCount is 1 + the carry')
      assertEqual(head?.incarnationId, next, 'the head is on the new incarnation')
      assertEqual(
        (await fixture.store.verifyChain({ sessionId: fixture.sessionId, limit: 10 }))
          .firstBadEntryId,
        null,
        'the carry is chained onto the new anchor',
      )
      // A duplicate key inside the carry is a caller bug, and the whole reset is refused.
      const third = fixture.ids.uuid()
      await assertRejects(
        () =>
          fixture.store.resetSession({
            sessionId: fixture.sessionId,
            incarnationId: third,
            start: startEntry(fixture, third),
            carry: [profileFact(fixture, third), profileFact(fixture, third)],
          }),
        TapeProvenanceConflictError,
        'a carry repeating a key',
      )
      // So is an unauthorised one: the carry passes the same gate as an append.
      await assertRejects(
        () =>
          fixture.store.resetSession({
            sessionId: fixture.sessionId,
            incarnationId: third,
            start: startEntry(fixture, third),
            carry: [{ ...profileFact(fixture, third), kind: 'anchor' }],
          }),
        TapeAppendAuthorizationError,
        'a carry fact with the wrong kind',
      )
      assertEqual(
        await readAll(fixture.store, fixture.sessionId),
        after,
        'neither reset took effect',
      )
    },
  )

  add('a carry fact that fails to project rolls the whole reset back', async (open) => {
    // 旧 110, second half: the reset is one transaction, projection included.
    const fixture = await open({
      project: failingReducer(
        (entry) => entry.name === 'session/workspace_set' && entry.sourceSeq === 7,
      ),
    })
    const messageId = fixture.ids.uuid()
    await appendAll(fixture, [
      startEntry(fixture, fixture.incarnationId),
      userMessage(fixture, messageId, 0, 'keep me'),
    ])
    const before = await readAll(fixture.store, fixture.sessionId)
    const head = await fixture.store.head(fixture.sessionId)
    const rows = await fixture.store.listMessages({ sessionId: fixture.sessionId, limit: 10 })
    const next = fixture.ids.uuid()
    await assertRejects(
      () =>
        fixture.store.resetSession({
          sessionId: fixture.sessionId,
          incarnationId: next,
          start: startEntry(fixture, next),
          carry: [profileFact(fixture, next), workspaceFact(fixture, next, 7)],
        }),
      TapeProjectionError,
      'a reset whose last carry fact does not project',
    )
    assertEqual(
      await readAll(fixture.store, fixture.sessionId),
      before,
      'the old facts are all there',
    )
    assertEqual(await fixture.store.head(fixture.sessionId), head, 'the head did not move')
    assertEqual(
      await fixture.store.listMessages({ sessionId: fixture.sessionId, limit: 10 }),
      rows,
      'and neither did the projection',
    )
  })

  add('pending rows and resets never cross tenants sharing one backing', async (open) => {
    // 旧 60 and 旧 110's tenant half. B is a SECOND tenant in the same file, under the SAME session id,
    // run id and call key, so a statement that forgot its tenant predicate lists, deletes or resets B's
    // rows instead of (or as well as) A's. Spec 02 acceptance 11: 「去掉租户谓词测试就变红」.
    const a = await open()
    const b = await open({ tenantId: 'conformance-tenant-b', shareWith: a })
    assertEqual(b.sessionId, a.sessionId, 'the two tenants use the same session id')
    const runId = a.ids.uuid()
    assertEqual(b.ids.uuid(), runId, 'and the same run id')
    const call = { runId, requestSeq: 0, ordinal: 0 }
    const theirs = { runId, requestSeq: 0, ordinal: 1 }
    await appendAll(a, [
      startEntry(a, a.incarnationId),
      decisionFact(a, call, { awaits: 'approval' }),
    ])
    await appendAll(b, [
      startEntry(b, b.incarnationId),
      decisionFact(b, call, { awaits: 'approval' }),
      decisionFact(b, theirs, { awaits: 'question' }),
    ])
    const onlyB = b.ids.uuid()
    const onlyBIncarnation = b.ids.uuid()
    await b.store.append({
      sessionId: onlyB,
      incarnationId: onlyBIncarnation,
      entries: [
        write('session', 'session/start', {
          sourceType: 'session',
          sourceId: onlyB,
          sourceSeq: 0,
          provenanceKey: sessionStartKey(onlyBIncarnation),
          payload: { incarnationId: onlyBIncarnation },
          createdAt: b.at(),
        }),
      ],
    })
    const bState = async (): Promise<unknown> => ({
      pending: await pendingOf(b),
      facts: await readAll(b.store, b.sessionId),
      onlyB: await readAll(b.store, onlyB),
      head: await b.store.head(onlyB),
    })
    const before = await bState()
    const mine = await pendingOf(a)
    assertEqual(
      mine.map((row) => [row.sessionId, row.runId, row.callOrdinal, row.waitKind]),
      [[a.sessionId, runId, 0, 'approval']],
      "A lists its own row and none of B's",
    )
    assertEqual(await pendingOf(a, a.sessionId), mine, "with A's session id the same")
    assertEqual(await pendingOf(a, onlyB), [], "B's session id lists nothing for A")
    // A answers its call: its row goes, B's row under the very same key stays.
    await appendAll(a, [approvalFact(a, call, 'allowed')])
    assertEqual(await pendingOf(a), [], "A's row is gone")
    assertEqual(await bState(), before, "B's rows are untouched by A's delete")
    // A rebuild of A's projection neither sees nor drops B's.
    await a.store.rebuildProjections(a.sessionId)
    assertEqual(await pendingOf(a), [], 'the rebuild adds nothing of B')
    assertEqual(await bState(), before, 'and removes nothing of B')
    // A reset naming B's session is a session A cannot see: refused, and B unchanged.
    const next = a.ids.uuid()
    await assertRejects(
      () =>
        a.store.resetSession({
          sessionId: onlyB,
          incarnationId: next,
          start: write('session', 'session/start', {
            sourceType: 'session',
            sourceId: onlyB,
            sourceSeq: 0,
            provenanceKey: sessionStartKey(next),
            payload: { incarnationId: next },
            createdAt: a.at(),
          }),
          carry: [profileFact(a, next)],
        }),
      TapeSessionNotFoundError,
      "a reset of another tenant's session",
    )
    assertEqual(await bState(), before, "B's session survived A's reset attempt")
    // And B still sees exactly its own two rows.
    assertEqual(
      (await pendingOf(b)).map((row) => [row.callOrdinal, row.waitKind]),
      [
        [0, 'approval'],
        [1, 'question'],
      ],
      "B's view of its own rows",
    )
  })

  add(
    'the pending-approval projection follows decisions, answers and results; a rebuild equals it',
    async (open) => {
      // 旧 111 (F3, H6): §待批表's three rules, then the row-by-row rebuild comparison. PROJECTION_VERSION
      // itself is pinned by the kernel's projection test; a store keeps no second copy of it.
      const fixture = await open()
      const runId = fixture.ids.uuid()
      const laterRun = fixture.ids.uuid()
      const asked = { runId, requestSeq: 0, ordinal: 0 }
      const question = { runId, requestSeq: 1, ordinal: 0 }
      const denied = { runId, requestSeq: 1, ordinal: 1 }
      const answered = { runId: laterRun, requestSeq: 0, ordinal: 2 }
      const receipts = await appendAll(fixture, [
        startEntry(fixture, fixture.incarnationId),
        decisionFact(fixture, asked, { awaits: 'approval' }),
        decisionFact(fixture, question, { awaits: 'question' }),
        decisionFact(fixture, denied, { awaits: 'approval' }),
        decisionFact(fixture, answered, { awaits: 'approval' }),
      ])
      const [, askedAt, questionAt, deniedAt] = receipts
      // Rule 1 again: a re-judgement that still asks moves entry_id, not created_at.
      const [rejudged] = await appendAll(fixture, [
        decisionFact(fixture, asked, { awaits: 'approval', rejudge: 1 }),
      ])
      // Rule 3: a re-judgement into a denial carries no awaits and changes nothing by itself; the
      // approval_resolved written with it removes the row (rule 2). A result removes one as well.
      await appendAll(fixture, [decisionFact(fixture, denied, { verdict: 'deny', rejudge: 1 })])
      const stillThere = await pendingOf(fixture)
      assertEqual(stillThere.length, 4, 'a denial without awaits leaves its row alone')
      await appendAll(fixture, [
        approvalFact(fixture, denied, 'denied-on-rejudge', {
          decisionKey: permissionDecidedKey(denied.runId, denied.requestSeq, denied.ordinal, 1),
        }),
        resultFact(fixture, answered, RESOLVER),
      ])
      // A delete of a row that is not there is a no-op.
      await appendAll(fixture, [resultFact(fixture, denied, { by: 'run', runId })])
      if (askedAt === undefined || questionAt === undefined || deniedAt === undefined) {
        fail('the decisions were not all written')
      }
      const incremental = await pendingOf(fixture)
      const createdOf = async (entryId: number): Promise<number> => {
        const entry = (await readAll(fixture.store, fixture.sessionId)).find(
          (candidate) => candidate.entryId === entryId,
        )
        if (entry === undefined) fail(`no entry ${entryId}`)
        return entry.createdAt
      }
      assertEqual(
        incremental,
        [
          {
            sessionId: fixture.sessionId,
            runId,
            requestSeq: 0,
            callOrdinal: 0,
            waitKind: 'approval',
            entryId: rejudged?.entryId,
            createdAt: await createdOf(askedAt.entryId),
          },
          {
            sessionId: fixture.sessionId,
            runId,
            requestSeq: 1,
            callOrdinal: 0,
            waitKind: 'question',
            entryId: questionAt.entryId,
            createdAt: await createdOf(questionAt.entryId),
          },
        ],
        'two calls still wait, oldest first, each pointing at its decision in force',
      )
      await fixture.store.rebuildProjections(fixture.sessionId)
      assertEqual(await pendingOf(fixture), incremental, 'a rebuild reproduces the rows exactly')
      assertEqual(
        await pendingOf(fixture, fixture.sessionId),
        incremental,
        'listed by session id, the same rows',
      )
      assertEqual(await pendingOf(fixture, fixture.ids.uuid()), [], 'another session has none')
      // The ceiling holds here as on every read.
      await assertRejects(
        () => fixture.store.listPendingApprovals({ limit: MAX_READ_LIMIT + 1 }),
        TapeReadLimitError,
        'a limit above the ceiling',
      )
      assertEqual((await fixture.store.listPendingApprovals({ limit: 1 })).length, 1, 'limit caps')
    },
  )

  add(
    'a reset or a delete takes the session’s pending rows with it, and only its own',
    async (open) => {
      // 01 §删除语义 (resetSession / deleteSession 「清该 session 的投影与游标」) applied to 01 修补 7's
      // pending table: a row outliving its session would read, at startup and on the banner, as a
      // call still waiting under a Run that is gone. A second session's row must stay.
      const fixture = await open()
      const other: Fixture = { ...fixture, sessionId: fixture.ids.uuid() }
      other.incarnationId = fixture.ids.uuid()
      await appendAll(fixture, [
        startEntry(fixture, fixture.incarnationId),
        waitingOnFreshRun(fixture, 'approval'),
      ])
      await appendAll(other, [
        startEntry(other, other.incarnationId),
        waitingOnFreshRun(other, 'approval'),
      ])
      const theirs = await pendingOf(other, other.sessionId)
      assertEqual(theirs.length, 1, 'the other session has its one row')
      const assertOnlyTheirs = async (after: string): Promise<void> => {
        assertEqual(await pendingOf(fixture, fixture.sessionId), [], `${after}: no row of its own`)
        assertEqual(await pendingOf(fixture), theirs, `${after}: only the other session's row`)
      }
      const reset = async (withCarry: boolean): Promise<void> => {
        const next = fixture.ids.uuid()
        await fixture.store.resetSession({
          sessionId: fixture.sessionId,
          incarnationId: next,
          start: startEntry(fixture, next),
          ...(withCarry ? { carry: [profileFact(fixture, next)] } : {}),
        })
        fixture.incarnationId = next
      }
      await reset(false)
      await assertOnlyTheirs('a reset')
      await appendAll(fixture, [waitingOnFreshRun(fixture, 'question')])
      assertEqual((await pendingOf(fixture, fixture.sessionId)).length, 1, 'a question waits')
      await reset(true)
      await assertOnlyTheirs('a reset with a carry')
      await appendAll(fixture, [waitingOnFreshRun(fixture, 'approval')])
      assertEqual((await pendingOf(fixture, fixture.sessionId)).length, 1, 'an approval waits')
      await fixture.store.deleteSession(fixture.sessionId)
      await assertOnlyTheirs('a delete')
    },
  )

  // ----- spec 02 · the tape half of acceptance 12 (writers; the loop drives them in later steps) --

  add(
    'a phase-2 fact rewritten is created:false, and a second answer to one call is a conflict',
    async (open) => {
      // 旧 115, the store half. Rejudge keys are separate facts (`…:rejudge:<r>`); whether the loop
      // writes one only when the verdict, summary or card changed is plan step 15's to prove.
      const fixture = await open()
      const call = { runId: fixture.ids.uuid(), requestSeq: 0, ordinal: 0 }
      const messageId = fixture.ids.uuid()
      const facts = [
        toolCallFact(fixture, call, messageId),
        decisionFact(fixture, call, { awaits: 'approval' }),
      ]
      await appendAll(fixture, [startEntry(fixture, fixture.incarnationId), ...facts])
      const head = await fixture.store.head(fixture.sessionId)
      const again = await appendAll(fixture, facts)
      assertEqual(
        again.map((receipt) => receipt.created),
        [false, false],
        'the same call and decision again',
      )
      assertEqual(await fixture.store.head(fixture.sessionId), head, 'no row was added')
      const [rejudge] = await appendAll(fixture, [
        decisionFact(fixture, call, { awaits: 'approval', rejudge: 1 }),
      ])
      assertEqual(rejudge?.created, true, 'a re-judgement is its own fact under its own key')
      await appendAll(fixture, [approvalFact(fixture, call, 'allowed')])
      const answered = await readAll(fixture.store, fixture.sessionId)
      await assertRejects(
        () => appendAll(fixture, [approvalFact(fixture, call, 'cancelled-by-stop')]),
        TapeProvenanceConflictError,
        'a second, different answer to the same call',
      )
      const [same] = await appendAll(fixture, [approvalFact(fixture, call, 'allowed')])
      assertEqual(same?.created, false, 'the same answer replayed')
      assertEqual(
        await readAll(fixture.store, fixture.sessionId),
        answered,
        'the call still has exactly one answer',
      )
    },
  )

  add(
    'a call approved in one run and executed in the next keeps its six facts under the first',
    async (open) => {
      // 旧 116 (B1, F3): everything about a call hangs on the (runId, requestSeq) of the request that
      // made it; who actually wrote each fact is in `writer`.
      const fixture = await open()
      const pausedRun = fixture.ids.uuid()
      const resumedRun = fixture.ids.uuid()
      const call = { runId: pausedRun, requestSeq: 0, ordinal: 0 }
      const newRun: FactWriter = { by: 'run', runId: resumedRun }
      await appendAll(fixture, [
        startEntry(fixture, fixture.incarnationId),
        runStartedFact(fixture, pausedRun, { kind: 'user-message', messageId: fixture.ids.uuid() }),
        toolCallFact(fixture, call, fixture.ids.uuid()),
        decisionFact(fixture, call, { awaits: 'approval' }),
        runTerminalFact(fixture, pausedRun, { code: 'paused', waitingFor: 'approval' }),
      ])
      await appendAll(fixture, [
        approvalFact(fixture, call, 'allowed'),
        runStartedFact(fixture, resumedRun, {
          kind: 'resume',
          pausedRunId: pausedRun,
          batch: { runId: pausedRun, requestSeq: 0 },
        }),
        modelSelected(fixture, resumedRun),
      ])
      await appendAll(fixture, [dispatchFact(fixture, call, newRun)])
      await appendAll(fixture, [
        resultFact(fixture, call, newRun),
        outcomeFact(fixture, call, newRun),
      ])
      const facts = await fixture.store.readBySource({
        sessionId: fixture.sessionId,
        sourceType: 'runtime_event',
        sourceId: pausedRun,
        limit: MAX_READ_LIMIT,
      })
      const perCall = facts.filter((entry) => entry.sourceSeq === 0)
      assertEqual(
        perCall.map((entry) => entry.name),
        [
          'tool/call',
          'tool/permission_decided',
          'tool/approval_resolved',
          'execution/dispatch_committed',
          'tool/result',
          'execution/tool_outcome',
        ],
        "the six facts of the call, all under the paused run's id",
      )
      assertEqual(
        perCall.map((entry) => entry.payload['writer'] ?? null),
        [null, { by: 'run', runId: pausedRun }, RESOLVER, newRun, newRun, newRun],
        'each records who actually wrote it',
      )
      assertEqual(
        facts.map((entry) => entry.name).filter((name) => name.startsWith('execution/run_')),
        ['execution/run_started', 'execution/run_terminal'],
        "the paused run's own opening and end are here, the resumed run's are not",
      )
    },
  )

  add(
    'a paused decision and its run_terminal, an answer and the next run, land together or not at all',
    async (open) => {
      // 旧 117 (F3, B1): §执行日志与恢复表's batch rules 1 and 2, with the failure injected into the
      // LAST fact of each batch so the earlier ones had already been applied inside the transaction.
      // The reducer reads these two at append time, so a case can arm it for one batch at a time.
      let poisonedRun = ''
      let poisonedResume = ''
      const fixture = await open({
        project: failingReducer(
          (entry) =>
            (entry.name === 'execution/run_terminal' && entry.sourceId === poisonedRun) ||
            (entry.name === 'session/model_selected' &&
              entry.provenanceKey === modelSelectedKey(poisonedResume)),
        ),
      })
      const pausedRun = fixture.ids.uuid()
      const call = { runId: pausedRun, requestSeq: 0, ordinal: 0 }
      await appendAll(fixture, [
        startEntry(fixture, fixture.incarnationId),
        runStartedFact(fixture, pausedRun, { kind: 'user-message', messageId: fixture.ids.uuid() }),
        toolCallFact(fixture, call, fixture.ids.uuid()),
      ])
      const beforePause = await readAll(fixture.store, fixture.sessionId)
      // Rule 1: the ask decision and run_terminal{paused}. The poisoned terminal takes the decision —
      // and the pending row it would have made — down with it.
      poisonedRun = pausedRun
      await assertRejects(
        () =>
          appendAll(fixture, [
            decisionFact(fixture, call, { awaits: 'approval' }),
            runTerminalFact(fixture, pausedRun, { code: 'paused', waitingFor: 'approval' }),
          ]),
        TapeProjectionError,
        'a pause whose terminal does not project',
      )
      assertEqual(
        await readAll(fixture.store, fixture.sessionId),
        beforePause,
        'no decision without its pause',
      )
      assertEqual(await pendingOf(fixture), [], 'and no pending row either')
      poisonedRun = ''
      await appendAll(fixture, [
        decisionFact(fixture, call, { awaits: 'approval' }),
        runTerminalFact(fixture, pausedRun, { code: 'paused', waitingFor: 'approval' }),
      ])
      const waiting = await pendingOf(fixture)
      assertEqual(waiting.length, 1, 'the pause landed with its decision')
      const beforeAnswer = await readAll(fixture.store, fixture.sessionId)
      // Rule 2: approval_resolved(allowed) with the new run's run_started and session/model_selected.
      const resumed = fixture.ids.uuid()
      poisonedResume = resumed
      await assertRejects(
        () =>
          appendAll(fixture, [
            approvalFact(fixture, call, 'allowed'),
            runStartedFact(fixture, resumed, {
              kind: 'resume',
              pausedRunId: pausedRun,
              batch: { runId: pausedRun, requestSeq: 0 },
            }),
            modelSelected(fixture, resumed),
          ]),
        TapeProjectionError,
        'an answer whose new run cannot be recorded',
      )
      assertEqual(
        await readAll(fixture.store, fixture.sessionId),
        beforeAnswer,
        'no answer, no run_started, no model_selected',
      )
      assertEqual(await pendingOf(fixture), waiting, 'the call is still waiting')
    },
  )

  add(
    'view/content is written once per content, however many requests reference it',
    async (open) => {
      // 旧 118 (A3, E2): content-addressed keys, so the second request's copies are no-ops.
      const fixture = await open()
      const runId = fixture.ids.uuid()
      const system = SCRIPT_SYSTEM
      const contents = (): NewEntry[] => [
        viewContentFact(fixture, { type: 'system', hash: systemHash(system), text: system }),
        viewContentFact(fixture, {
          type: 'tool_spec',
          hash: canonicalHash(SCRIPT_TOOL, 'tool'),
          spec: SCRIPT_TOOL,
        }),
        viewContentFact(fixture, {
          type: 'model_info',
          hash: canonicalHash(SCRIPT_MODEL, 'model'),
          model: SCRIPT_MODEL,
        }),
      ]
      await appendAll(fixture, [startEntry(fixture, fixture.incarnationId)])
      for (let requestSeq = 0; requestSeq < 3; requestSeq += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one request's batch at a time
        const receipts = await appendAll(fixture, [
          ...contents(),
          assembledFact(fixture, runId, requestSeq, system),
        ])
        assertEqual(
          receipts.map((receipt) => receipt.created),
          requestSeq === 0 ? [true, true, true, true] : [false, false, false, true],
          `request ${requestSeq}: only the first writes the contents`,
        )
      }
      const stored = (await readAll(fixture.store, fixture.sessionId)).filter(
        (entry) => entry.name === 'view/content',
      )
      assertEqual(
        stored.map((entry) => entry.payload['type']),
        ['system', 'tool_spec', 'model_info'],
        'each content exactly once',
      )
    },
  )

  add(
    'the first model choice lands with session/start, and two quick choices are n=0 and n=1',
    async (open) => {
      // 旧 123, the writer half (M5, A11): a choice made on the home page before the session existed
      // is the batch's `<n>` = 0; the queue that counts `<n>` from the tape is plan step 19's.
      const fixture = await open()
      const receipts = await appendAll(fixture, [
        startEntry(fixture, fixture.incarnationId),
        modelChoiceFact(fixture, fixture.incarnationId, 0, 'glm-5.3-flash'),
      ])
      assertEqual(
        receipts.map((receipt) => receipt.created),
        [true, true],
        'a creating batch',
      )
      const [second] = await appendAll(fixture, [
        modelChoiceFact(fixture, fixture.incarnationId, 1, 'glm-5.3'),
      ])
      assertEqual(second?.created, true, 'n=1 is a second fact, not a conflict with n=0')
      const [replay] = await appendAll(fixture, [
        modelChoiceFact(fixture, fixture.incarnationId, 1, 'glm-5.3'),
      ])
      assertEqual(replay?.created, false, 'the same n=1 again is idempotent')
      assertEqual(
        (await readAll(fixture.store, fixture.sessionId))
          .filter((entry) => entry.name === 'session/model_choice_set')
          .map((entry) => [entry.sourceSeq, entry.payload['modelId']]),
        [
          [0, 'glm-5.3-flash'],
          [1, 'glm-5.3'],
        ],
        'the two choices in order',
      )
    },
  )

  return cases
}
