/**
 * What the script checks read (spec 02 §评测集与测试宿主): the session's Tape through `TapeReader`,
 * and the workspace the test host copied from `docs/evals/fixtures/`. A check decides from files and
 * Tape facts, never from the model's wording; the numbers it gathers go into the note.
 *
 * Tape facts are read by the names and payloads of §02 的 Tape 事实: a call is its `tool/call`, its
 * `tool/result` and its `execution/tool_outcome`, joined on `(runId, requestSeq, <i>)` (§键与挂靠).
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_READ_LIMIT, TOOL_OUTPUT_DIR, absolutePath } from '@tenon-app/kernel'
import type { BlockReason, TapeEntry, TapeReader } from '@tenon-app/kernel'
import { createHostProcess } from '../../src/main/host/process.js'
import { PassthroughSandbox } from '../../src/main/host/sandbox.js'

/** Every fact of the session's current incarnation, in entry order, one pinned incarnation. */
export async function readSession(tape: TapeReader, sessionId: string): Promise<TapeEntry[]> {
  const entries: TapeEntry[] = []
  let fromEntryId: number | undefined
  let incarnationId: string | undefined
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the next page's cursor is this page's answer
    const page = await tape.readRange({
      sessionId,
      limit: MAX_READ_LIMIT,
      ...(fromEntryId === undefined ? {} : { fromEntryId }),
      ...(incarnationId === undefined ? {} : { incarnationId }),
    })
    entries.push(...page.entries)
    incarnationId = page.incarnationId
    if (page.nextFromEntryId === null) return entries
    fromEntryId = page.nextFromEntryId
  }
}

/** One client tool call as the Tape has it. `result` / `outcome` are null while it has none. */
export interface CallView {
  /** `<runId>:<requestSeq>:<i>`, the key every fact of the call hangs on. */
  readonly key: string
  /** The `tool/call`'s entry id: calls sort by it in the order the model made them. */
  readonly entryId: number
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  readonly argsHash: string
  readonly result: {
    readonly isError: boolean
    /** The text blocks the model was sent, joined by `\n`. */
    readonly text: string
    readonly spill: { readonly file: string; readonly bytes: number } | null
  } | null
  readonly outcome: { readonly state: string; readonly source: string | null } | null
}

/** The four sources §原因码表 marks 「拦截」: what `MACHINE_DENIAL_CAP` counts (F2). */
export const BLOCK_SOURCES: readonly BlockReason[] = [
  'policy',
  'user-disabled',
  'protected',
  'inspector',
]

function callKey(entry: TapeEntry): string {
  return `${String(entry.sourceId)}:${String(entry.sourceSeq)}:${String(entry.payload['ordinal'])}`
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function resultOf(payload: Readonly<Record<string, unknown>>): NonNullable<CallView['result']> {
  const content = Array.isArray(payload['content']) ? (payload['content'] as unknown[]) : []
  const text = content
    .map(record)
    .filter((block) => block['type'] === 'text' && typeof block['text'] === 'string')
    .map((block) => block['text'] as string)
    .join('\n')
  const spill = record(payload['spill'])
  return {
    isError: payload['isError'] === true,
    text,
    spill:
      typeof spill['file'] === 'string' && typeof spill['bytes'] === 'number'
        ? { file: spill['file'], bytes: spill['bytes'] }
        : null,
  }
}

/** Every client call of the session, in the order the model made them. */
export function callsOf(entries: readonly TapeEntry[]): CallView[] {
  const results = new Map<string, NonNullable<CallView['result']>>()
  const outcomes = new Map<string, NonNullable<CallView['outcome']>>()
  for (const entry of entries) {
    if (entry.name === 'tool/result') results.set(callKey(entry), resultOf(entry.payload))
    if (entry.name === 'execution/tool_outcome') {
      const source = entry.payload['source']
      outcomes.set(callKey(entry), {
        state: String(entry.payload['state']),
        source: typeof source === 'string' ? source : null,
      })
    }
  }
  return entries
    .filter((entry) => entry.name === 'tool/call')
    .map((entry) => {
      const key = callKey(entry)
      return {
        key,
        entryId: entry.entryId,
        name: String(entry.payload['name']),
        input: record(entry.payload['input']),
        argsHash: String(entry.payload['argsHash']),
        result: results.get(key) ?? null,
        outcome: outcomes.get(key) ?? null,
      }
    })
}

/** A call that ran and came back without `is_error`. */
export function succeeded(call: CallView): boolean {
  return call.outcome?.source === null && call.result !== null && !call.result.isError
}

/** Closed by one of the four 「拦截」 sources. */
export function machineDenied(call: CallView): boolean {
  const source = call.outcome?.source
  return source !== undefined && source !== null && (BLOCK_SOURCES as string[]).includes(source)
}

/** The `code` of the session's last `execution/run_terminal`, or null when no Run ended. */
export function lastEndReason(entries: readonly TapeEntry[]): string | null {
  const terminals = entries.filter((entry) => entry.name === 'execution/run_terminal')
  const reason = record(terminals.at(-1)?.payload['reason'])
  return typeof reason['code'] === 'string' ? reason['code'] : null
}

function policyBlocked(call: CallView, toolName: string): boolean {
  return call.name === toolName && call.outcome?.source === 'policy'
}

/** `<runId>:<requestSeq>`: the request whose batch a call was in. */
function requestOf(call: CallView): string {
  return call.key.slice(0, call.key.lastIndexOf(':'))
}

/**
 * `calib.blockedRecalls` (E2: 收到 is_error 后，模型还会不会再调被禁的工具): the calls to the tool in
 * the requests after the one whose batch holds its first `policy` block, whatever closed them. The
 * other calls of that batch are not counted: the model made them before it saw any is_error. The
 * record and the check notes both take it from here.
 */
export function blockedRecalls(calls: readonly CallView[], toolName: string): number {
  const firstBlock = calls.findIndex((call) => policyBlocked(call, toolName))
  const first = calls[firstBlock]
  if (first === undefined) return 0
  return calls.filter(
    (call, index) =>
      index > firstBlock && call.name === toolName && requestOf(call) !== requestOf(first),
  ).length
}

/**
 * What a disabled tool did to the run (spec §评测集与测试宿主 `disableTool`; F2, E2): the machine
 * denials of the whole session (`calib.machineDenials`), `blockedRecalls` above, how many different
 * argument sets the blocked calls had (换着参数), and how many blocks of the tool came before the
 * model first did the tool's job another way (第几次机器拒绝后改对了做法; null when it never did, or
 * was never blocked). What does the job is the task's to say (`didTheJob`: a call that succeeded
 * and did what the disabled tool was for): a Read between two blocks is no change of approach.
 */
export interface DenialStats {
  readonly machineDenials: number
  readonly blocked: number
  readonly blockedRecalls: number
  readonly distinctBlockedArgs: number
  readonly switchedAfter: number | null
}

export function denialStats(
  calls: readonly CallView[],
  toolName: string,
  didTheJob: (call: CallView) => boolean,
): DenialStats {
  const firstBlock = calls.findIndex((call) => policyBlocked(call, toolName))
  const blockedCalls = calls.filter((call) => policyBlocked(call, toolName))
  let switchedAfter: number | null = null
  if (firstBlock !== -1) {
    const switchAt = calls.findIndex((call, index) => index > firstBlock && didTheJob(call))
    if (switchAt !== -1) {
      switchedAfter = calls
        .slice(0, switchAt)
        .filter((call) => policyBlocked(call, toolName)).length
    }
  }
  return {
    machineDenials: calls.filter(machineDenied).length,
    blocked: blockedCalls.length,
    blockedRecalls: blockedRecalls(calls, toolName),
    distinctBlockedArgs: new Set(blockedCalls.map((call) => call.argsHash)).size,
    switchedAfter,
  }
}

export function denialNote(toolName: string, stats: DenialStats): string {
  if (stats.blocked === 0) return `${toolName} was never blocked (disableTool not exercised)`
  const switched =
    stats.switchedAfter === null
      ? 'never did the job another way afterwards'
      : `did the job another way after ${stats.switchedAfter} block(s)`
  return (
    `${toolName}: ${stats.blocked} policy block(s) with ${stats.distinctBlockedArgs} distinct ` +
    `argument set(s), ${stats.blockedRecalls} call(s) in requests after the first block; ` +
    `${switched}; machine denials ${stats.machineDenials}`
  )
}

/**
 * Whether a path is inside this session's own spill folder, `<profileDir>/tool-output/<sessionId>/`
 * (§大响应落盘). The profile folder is the host's; the check only knows the suffix, which is enough:
 * the file name is the kernel's, never the model's.
 */
export function inOwnSpill(path: unknown, sessionId: string): boolean {
  return typeof path === 'string' && path.includes(`/${TOOL_OUTPUT_DIR}/${sessionId}/`)
}

/**
 * How a long command output reached the model (H9): how often the command ran, how many of those
 * results spilled, and each Read (offset, limit) and Grep the model made on its own spill folder.
 */
export interface SpillStats {
  readonly runs: number
  readonly spilled: number
  readonly spillBytes: number | null
  readonly reads: ReadonlyArray<{ readonly offset: unknown; readonly limit: unknown }>
  readonly greps: number
}

export function spillStats(
  calls: readonly CallView[],
  sessionId: string,
  command: RegExp,
): SpillStats {
  const runs = calls.filter(
    (call) =>
      call.name === 'Bash' &&
      typeof call.input['command'] === 'string' &&
      command.test(call.input['command']),
  )
  const spilled = runs.filter((call) => call.result?.spill != null)
  return {
    runs: runs.length,
    spilled: spilled.length,
    spillBytes: spilled[0]?.result?.spill?.bytes ?? null,
    reads: calls
      .filter((call) => call.name === 'Read' && inOwnSpill(call.input['file_path'], sessionId))
      .map((call) => ({ offset: call.input['offset'], limit: call.input['limit'] })),
    greps: calls.filter((call) => call.name === 'Grep' && inOwnSpill(call.input['path'], sessionId))
      .length,
  }
}

export function spillNote(stats: SpillStats): string {
  const reads = stats.reads
    .map((read) => `${String(read.offset ?? '-')}/${String(read.limit ?? '-')}`)
    .join(', ')
  return (
    `command ran ${stats.runs}×, spilled ${stats.spilled}×` +
    (stats.spillBytes === null ? '' : ` (${stats.spillBytes} bytes)`) +
    `; spill reads ${stats.reads.length}${reads === '' ? '' : ` [offset/limit ${reads}]`}` +
    `; spill greps ${stats.greps}`
  )
}

/** The repository's copy of a fixture file: what the host copied before the run. */
export function fixturePath(fixture: string, ...parts: string[]): string {
  return join(
    fileURLToPath(new URL('../../../../docs/evals/fixtures/', import.meta.url)),
    fixture,
    ...parts,
  )
}

/** A workspace file's text, or null when it is not there. */
export async function readText(dir: string, ...parts: string[]): Promise<string | null> {
  try {
    return await readFile(join(dir, ...parts), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Line endings and the trailing newline are not part of a file's content for a check. */
export function normalizeText(text: string): string {
  return `${text.replaceAll('\r\n', '\n').trimEnd()}\n`
}

/** The first line where two texts differ, 1-based, or null when they are equal. */
export function firstDifferentLine(actual: string, expected: string): number | null {
  const a = actual.split('\n')
  const b = expected.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (a[i] !== b[i]) return i + 1
  return null
}

/**
 * Runs node in a workspace after the run, for a check that has to execute what the model left: the
 * cwd is the workspace and, as for the test host's commands (§测试宿主), the environment carries no
 * key — only PATH, with HOME pointing into the workspace.
 */
export async function runNode(
  cwd: string,
  args: readonly string[],
  timeoutMs = 10_000,
): Promise<{ code: number | null; output: string }> {
  // Through the desktop's own sandbox wrapper and HostProcess, like every subprocess (AGENTS.md).
  const workspace = absolutePath(cwd)
  const sandbox = new PassthroughSandbox(() => {})
  const commandId = `eval-check-${randomUUID()}`
  const wrapped = await sandbox.wrap({
    commandId,
    argv: [process.execPath, ...args],
    cwd: workspace,
    env: { PATH: process.env['PATH'] ?? '', HOME: cwd },
    profile: 'workspace-write',
    workspace: [workspace],
  })
  const child = await createHostProcess().spawn({
    argv: wrapped.argv,
    cwd: workspace,
    env: wrapped.env,
    stdio: 'pipe',
  })
  await child.stdin.close()
  const stdout = readAll(child.stdout)
  const stderr = readAll(child.stderr)
  const timer = setTimeout(() => void child.kill('SIGKILL'), timeoutMs)
  const exit = await child.exited
  clearTimeout(timer)
  // Whatever the program left behind goes with it, so the pipes close and the reads end.
  await child.kill('SIGKILL')
  await sandbox.afterExit(commandId)
  return { code: exit.code, output: `${await stdout}${await stderr}` }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true })
  return text + decoder.decode()
}
