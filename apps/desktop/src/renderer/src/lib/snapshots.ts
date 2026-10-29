import {
  invokeRoute,
  sessionMessages,
  snapshotPreview,
  snapshotRestore,
} from '@tenon-app/contracts'
import type { MessageRowContract, RouteResponse, snapshotRounds } from '@tenon-app/contracts'
import { toolObject } from './tool-sentence'
import { threadFromRows } from '../runtime/thread-model'

export type Rounds = Extract<RouteResponse<typeof snapshotRounds>, { ok: true }>
export type Round = Rounds['rounds'][number]
export type Preview = Extract<RouteResponse<typeof snapshotPreview>, { ok: true }>['preview']
export type RestoreResult = Extract<RouteResponse<typeof snapshotRestore>, { ok: true }>
export type SnapshotError =
  | Extract<RouteResponse<typeof snapshotRestore>, { ok: false }>['code']
  | 'failed'

export function roundForRun(rounds: readonly Round[], runId: string | null) {
  return runId === null ? undefined : rounds.find((round) => round.runIds.includes(runId))
}
export function callSnapshot(rounds: readonly Round[], callKey: string) {
  for (const round of rounds) {
    const call = round.calls.find((item) => item.callKey === callKey)
    if (call !== undefined) return { snapshotId: call.snapshotId, canRestore: round.canRestore }
  }
  return null
}
export function restoreNotes(round: Round | undefined) {
  return {
    link:
      round?.canRestore === true
        ? round.incompleteCoverage
          ? 'snapshot.partial'
          : 'snapshot.available'
        : null,
    command: round?.commandsWithoutSnapshot === true,
  } as const
}
export function unfinishedRestore(data: Rounds | null): boolean {
  return (data?.incompleteRestores.length ?? 0) > 0
}
export function previewGroups(preview: Preview) {
  return [
    { kind: 'restore', paths: preview.restore.map((path) => ({ path, reason: null })) },
    { kind: 'remove', paths: preview.remove.map((path) => ({ path, reason: null })) },
    { kind: 'skipped', paths: preview.skipped },
  ] as const
}
export function overwritePaths(preview: Preview, selected: ReadonlySet<string>): string[] {
  return preview.conflicts.filter((path) => selected.has(path))
}

/** The call key is the documented run/request/ordinal identity, including read-only calls. */
export function recordRows(messages: readonly MessageRowContract[], round: Round) {
  return messages.flatMap((message) => {
    let index = 0
    return message.content.flatMap((block) => {
      if (block.type !== 'tool-request') return []
      const call = message.calls?.[index++]
      if (call === undefined || !round.runIds.includes(call.callKey.split(':')[0]!)) return []
      const snapshot = callSnapshot([round], call.callKey)
      return [
        {
          callKey: call.callKey,
          tool: block.name,
          object: toolObject(block.name, block.input),
          decision: call.outcome?.permission ?? null,
          reversibility: call.outcome?.reversibility ?? 'unknown',
          snapshotId: snapshot?.snapshotId ?? null,
          canRestore: snapshot?.canRestore === true,
        },
      ]
    })
  })
}

/** Read all pages, so a long round cannot silently lose the calls before the loaded tail. */
export async function readRecordMessages(
  bridge: Parameters<typeof invokeRoute>[0],
  sessionId: string,
) {
  const rows: MessageRowContract[] = []
  let beforeOrderSeq: number | undefined
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the next cursor comes from this page
    const result = await invokeRoute(bridge, sessionMessages, {
      sessionId,
      limit: 1000,
      ...(beforeOrderSeq === undefined ? {} : { beforeOrderSeq }),
    })
    if (!result.ok) throw new Error('Could not read the session record')
    rows.unshift(...result.data)
    if (result.data.length < 1000) return rows
    const next = result.data[0]!.orderSeq
    if (beforeOrderSeq !== undefined && next >= beforeOrderSeq)
      throw new Error('Record cursor did not advance')
    beforeOrderSeq = next
  }
}

/** Historical settlement includes calls outside the visible tail, including each Agent's calls. */
export async function readHistoryModel(
  bridge: Parameters<typeof invokeRoute>[0],
  sessionId: string,
) {
  const model = threadFromRows(await readRecordMessages(bridge, sessionId))
  const children = new Set(
    model.turns.flatMap((turn) =>
      turn.parts.flatMap((part) => {
        const child =
          part.kind === 'tool' && part.name === 'Agent'
            ? part.outcome?.handoff?.childSessionId
            : undefined
        return child === undefined || child === null || child === sessionId ? [] : [child]
      }),
    ),
  )
  // Child sessions cannot dispatch Agent, so this is the complete child level.
  const childSessions = new Map(
    await Promise.all(
      [...children].map(
        async (child) =>
          [child, threadFromRows(await readRecordMessages(bridge, child)).turns] as const,
      ),
    ),
  )
  return { ...model, childSessions }
}

export interface RestoreState {
  readonly phase: 'closed' | 'loading' | 'preview' | 'applying' | 'done' | 'error'
  readonly preview: Preview | null
  readonly selected: ReadonlySet<string>
  readonly error: SnapshotError | null
  readonly done: RestoreResult | null
}
const CLOSED: RestoreState = {
  phase: 'closed',
  preview: null,
  selected: new Set(),
  error: null,
  done: null,
}

/** Only confirm sends a restore. Epochs discard replies to cancelled or superseded previews. */
export class RestoreFlow {
  #state = CLOSED
  #epoch = 0
  #roundRunId = ''
  #refreshPending = false
  #listeners = new Set<() => void>()
  private readonly bridge: Parameters<typeof invokeRoute>[0]
  private readonly sessionId: string
  private readonly changed: () => void
  constructor(bridge: Parameters<typeof invokeRoute>[0], sessionId: string, changed: () => void) {
    this.bridge = bridge
    this.sessionId = sessionId
    this.changed = changed
  }
  getSnapshot = () => this.#state
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  #set(state: RestoreState) {
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
  cancel = () => {
    if (this.#state.phase === 'applying') return
    this.#epoch++
    const refresh = this.#refreshPending
    this.#refreshPending = false
    this.#set(CLOSED)
    // Refreshing can remove RestoreLink when canRestore becomes false, unmounting its dialog.
    // Keep results/errors readable until the user closes this flow, then refresh once.
    if (refresh) this.changed()
  }
  select = (path: string, overwrite: boolean) => {
    if (this.#state.phase !== 'preview' || !this.#state.preview?.conflicts.includes(path)) return
    const selected = new Set(this.#state.selected)
    if (overwrite) selected.add(path)
    else selected.delete(path)
    this.#set({ ...this.#state, selected })
  }
  open = async (roundRunId: string, stale = false) => {
    const epoch = ++this.#epoch
    this.#roundRunId = roundRunId
    this.#set({ ...CLOSED, phase: 'loading', error: stale ? 'stale' : null })
    try {
      const result = await invokeRoute(this.bridge, snapshotPreview, {
        sessionId: this.sessionId,
        roundRunId,
      })
      if (epoch !== this.#epoch) return
      if (!result.ok || !result.data.ok) {
        this.#refreshPending = true
        this.#set({
          ...CLOSED,
          phase: 'error',
          error: result.ok && !result.data.ok ? result.data.code : 'failed',
        })
      } else
        this.#set({
          ...CLOSED,
          phase: 'preview',
          preview: result.data.preview,
          error: stale ? 'stale' : null,
        })
    } catch {
      if (epoch === this.#epoch) {
        this.#refreshPending = true
        this.#set({ ...CLOSED, phase: 'error', error: 'failed' })
      }
    }
  }
  confirm = async () => {
    const { preview, selected, phase } = this.#state
    if (phase !== 'preview' || preview === null) return
    const epoch = this.#epoch
    this.#set({ ...this.#state, phase: 'applying', error: null })
    try {
      const result = await invokeRoute(this.bridge, snapshotRestore, {
        sessionId: this.sessionId,
        roundRunId: this.#roundRunId,
        previewKey: preview.previewKey,
        overwrite: overwritePaths(preview, selected),
      })
      if (epoch !== this.#epoch) return
      this.#refreshPending = true
      if (result.ok && !result.data.ok && result.data.code === 'stale') {
        await this.open(this.#roundRunId, true)
        return
      }
      if (!result.ok || !result.data.ok)
        this.#set({
          ...CLOSED,
          phase: 'error',
          error: result.ok && !result.data.ok ? result.data.code : 'failed',
        })
      else this.#set({ ...CLOSED, phase: 'done', done: result.data })
    } catch {
      if (epoch === this.#epoch) {
        this.#refreshPending = true
        this.#set({ ...CLOSED, phase: 'error', error: 'failed' })
      }
    }
  }
}
