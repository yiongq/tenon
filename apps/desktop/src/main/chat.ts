import { chatEvent, chatSend, chatStop, registerRoute } from '@tenon-app/contracts'
import type { ChatEvent, IpcMainLike } from '@tenon-app/contracts'
import {
  ProviderConfigMissingError,
  ProviderInvalidArgumentError,
  TapeStaleIncarnationError,
  isCanonicalUuid,
} from '@tenon-app/kernel'
import type {
  HostAdapter,
  ProviderErrorCode,
  ProviderRegistry,
  SessionService,
  StopReason,
} from '@tenon-app/kernel'
import type { EventSender } from './host/index.js'
import { readConfig } from './host/profile.js'
import { devEnv, resolveChatProvider, selectProviderId } from './provider.js'
import type { EnvLike, ResolvedProvider } from './provider.js'

/**
 * The chat path (spec 01 §desktop 接线). Phase 0's in-memory `history` Map and its directly
 * constructed SDK client are gone: the transcript is the Tape, and one kernel call — the session
 * service's `runRequest` — writes the user's turn, streams the answer and records what happened.
 *
 * What survives unchanged from phase 0, because it is what makes the transcript trustworthy, and
 * where it now lives:
 *
 *   - the run is registered BEFORE the first await, so a `chat.stop` arriving while the keychain
 *     or the store is still being read is not lost;
 *   - a stopped reply keeps the text that did arrive (the service persists it as
 *     `status: 'aborted'`), so what the user sees and what the model will see stay the same thing;
 *   - a failed turn stays in the transcript: the user's message is on the tape and the evidence is
 *     the attempt fact's `error`, with no assistant message written;
 *   - re-sending the same text after a failure is therefore a RETRY of that same user message, not
 *     a second turn — the service recognises it and its append is an idempotent no-op;
 *   - in-flight is released BEFORE the terminal event goes out, and only after the service's final
 *     batch has committed: whoever reacts to `done` / `error` by sending again must neither be
 *     told a reply is still streaming nor race the transcript they are about to extend;
 *   - a run never outlives the document that asked for it (see `RunOwner`).
 *
 * One run per session at a time, as before. The session id is the RENDERER's: it mints a canonical
 * UUID per conversation and filters every `chat.event` on it, so main creates the session under
 * that id on first use rather than keeping a renderer-id → tape-id map — the in-process state this
 * step exists to delete.
 */

/** How the interface names a failure. Never a sentence: the renderer owns the copy. */
type ChatErrorCode = Extract<ChatEvent, { type: 'error' }>['code']
type ChatStopReason = Extract<ChatEvent, { type: 'done' }>['stopReason']

/** Spec 01 §desktop 接线, verbatim. `satisfies` makes a new provider code a compile error here. */
const ERROR_CODE = {
  network: 'network',
  auth: 'auth',
  'rate-limit': 'rate-limit',
  overloaded: 'rate-limit',
  'invalid-request': 'provider',
  'context-overflow': 'provider',
  server: 'provider',
  'egress-denied': 'unknown',
  unknown: 'unknown',
} as const satisfies Record<ProviderErrorCode, ChatErrorCode>

/**
 * Also verbatim. The three "finished normally" reasons collapse into `end-turn` because the
 * interface has one piece of copy for them; the raw `StopReason` is on the attempt fact, which is
 * where a reader that cares looks. Giving `max-tokens`, `refusal` and the rest their own copy
 * means extending the `chat.event` enum, which is phase 6's.
 */
const STOP_REASON = {
  'end-turn': 'end-turn',
  'stop-sequence': 'end-turn',
  'tool-use': 'end-turn',
  aborted: 'aborted',
  'max-tokens': 'error',
  refusal: 'error',
  'content-filter': 'error',
  'pause-turn': 'error',
  'context-overflow': 'error',
  unknown: 'error',
} as const satisfies Record<StopReason, ChatStopReason>

/** Diagnostics: logged and carried in the never-rendered `detail`, never shown to a user. */
const ALREADY_STREAMING = 'a reply is already streaming for this session'
const NO_STORE = 'the session store is unavailable'
const NOT_A_SESSION_ID = 'the session id is not a canonical uuid'

interface Run {
  readonly controller: AbortController
}

/**
 * The document a run belongs to, as this file needs it — structural, so chat.ts stays free of
 * electron: what IPC hands the handler is an `IpcMainInvokeEvent` whose `sender` is a WebContents.
 *
 * A run is started by one window and its events are rendered by that window's live subscription
 * alone. When the document goes away — the window closes, or the View menu's Reload replaces it —
 * the run must go with it. Otherwise the reply streams to nobody while the session stays
 * in-flight, the reloaded window's next send is refused as "already streaming", and the answer
 * that finally commits is invisible until a restart while the model has been seeing it all along:
 * exactly the drift this step exists to delete. Aborting is the honest end, and the kernel
 * persists what did arrive as `status: 'aborted'` — which is what the user saw.
 */
interface RunOwner {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface ChatDeps {
  host: HostAdapter
  send: EventSender
  ipcMain: IpcMainLike
  /**
   * `null` when `sessions.db` could not be opened (another tenant's file, or one written by a
   * newer build). The window still runs and every chat route answers with a terminal `error`
   * instead of crashing, because the alternative — refusing to start — would also refuse the
   * settings the user needs in order to fix it. Nothing on disk is touched.
   */
  sessions: SessionService | null
  providers: ProviderRegistry
  /** `app.isPackaged`: a packaged build takes no credential from the environment. */
  isPackaged?: boolean
  /** The environment the development fallback reads. Tests pass a fixed one; main passes none. */
  env?: EnvLike
  log?: (line: string) => void
}

export function registerChatRoutes(deps: ChatDeps): void {
  const { host, send, ipcMain, sessions, providers } = deps
  const log = deps.log ?? ((line: string): void => console.warn(line))
  const inFlight = new Map<string, Run>()

  /**
   * A send that throws would reject the whole run inside the service's stream loop and leave the
   * turn without its attempt fact, which is the shape of a crash rather than of a closed window.
   */
  const emit = (event: ChatEvent): void => {
    try {
      send(chatEvent.channel, event)
    } catch (error) {
      log(`[chat] dropped a ${event.type} event: ${describe(error)}`)
    }
  }

  registerRoute(ipcMain, chatSend, async ({ sessionId, text }, event) => {
    if (inFlight.has(sessionId)) throw new Error(ALREADY_STREAMING)

    const run: Run = { controller: new AbortController() }
    inFlight.set(sessionId, run)
    // Watched before the first await, with the run: a window that disappears during setup must
    // not leave one behind either.
    const detach = watchOwner(ownerOf(event), () => run.controller.abort())
    const release = (): void => {
      detach()
      if (inFlight.get(sessionId) === run) inFlight.delete(sessionId)
    }
    const accepted = { accepted: true as const }
    const fail = (code: ChatErrorCode, detail: string): typeof accepted => {
      release()
      emit({ type: 'error', sessionId, code, detail })
      return accepted
    }
    const stopHere = (): typeof accepted => {
      release()
      emit({ type: 'done', sessionId, stopReason: 'aborted' })
      return accepted
    }

    try {
      if (sessions === null) return fail('unknown', NO_STORE)
      // Every id on the tape is a canonical UUID; a session id that is not one would be taken for
      // a new conversation on every send, so it is refused here rather than at the store.
      if (!isCanonicalUuid(sessionId)) return fail('unknown', NOT_A_SESSION_ID)

      const config = await readConfig(host.fs, host.identity)
      // The SELECTED provider: what the settings card saved, else the development fallback, else
      // the default. Read per send, so a provider chosen while the window is open takes effect on
      // the next message rather than at the next launch.
      const env = devEnv({ isPackaged: deps.isPackaged === true, env: deps.env })
      const providerId = selectProviderId(config.provider?.id, env)
      let resolved: ResolvedProvider
      try {
        resolved = await resolveChatProvider({
          host,
          providers,
          providerId,
          settings: config.providerConfig[providerId],
          modelId: config.provider?.modelId,
          env,
          isPackaged: deps.isPackaged === true,
          log,
        })
      } catch (error) {
        // A provider that cannot be constructed is a CONFIGURATION problem, not a crash: the user
        // has no key yet, or a base URL they can fix. Phase 0 answered `auth` for the first one
        // and the interface has copy for it.
        return fail(configErrorCode(error), describe(error))
      }
      if (run.controller.signal.aborted) return stopHere()

      await ensureSession(sessions, sessionId)
      // Checked again: creating the session is the second await a stop can land inside.
      if (run.controller.signal.aborted) return stopHere()

      void runTurn({ sessions, run, sessionId, text, resolved, emit, release, log })
      return accepted
    } catch (error) {
      release()
      throw error
    }
  })

  registerRoute(ipcMain, chatStop, ({ sessionId }) => {
    const run = inFlight.get(sessionId)
    if (!run) return { stopped: false }
    // The signal is the only stop mechanism: it reaches the SDK, which reaches the socket, and the
    // provider turns it into `stop{ aborted }` rather than an error (invariant 2).
    run.controller.abort()
    return { stopped: true }
  })
}

interface TurnOptions {
  readonly sessions: SessionService
  readonly run: Run
  readonly sessionId: string
  readonly text: string
  readonly resolved: ResolvedProvider
  readonly emit: (event: ChatEvent) => void
  readonly release: () => void
  readonly log: (line: string) => void
}

/**
 * One request, start to terminal event. The terminal event is derived from the RESOLVED result
 * and never from the `stop` / `error` seen inside the stream: the facts are committed only when
 * `runRequest` resolves, so a renderer told "done" from inside the stream could send again while
 * `message/assistant` was still unwritten.
 */
async function runTurn(options: TurnOptions): Promise<void> {
  const { sessions, run, sessionId, text, resolved, emit, release, log } = options
  try {
    const result = await sessions.runRequest({
      sessionId,
      user: { text },
      provider: resolved.provider,
      model: resolved.model,
      maxTokens: resolved.maxTokens,
      signal: run.controller.signal,
      onEvent: (event) => {
        // Phase 1 renders text. Thinking, tool calls and usage are on the tape; giving them their
        // own `chat.event` members is phase 2's, when there is something to show for them.
        if (event.type === 'text-delta') emit({ type: 'text-delta', sessionId, delta: event.text })
      },
    })
    release()
    if (result.error !== null) {
      emit({
        type: 'error',
        sessionId,
        code: ERROR_CODE[result.error.code],
        detail: result.error.detail,
      })
      return
    }
    const reason = result.stop === null ? 'error' : STOP_REASON[result.stop.reason]
    emit({ type: 'done', sessionId, stopReason: reason })
  } catch (error) {
    // Not a provider failure: the request never reached a terminal fact. The one reachable cause
    // in phase 1 is a session deleted underneath a running request (`TapeSessionNotFoundError`),
    // whose facts are deliberately lost with the session — never something to retry.
    release()
    const detail = describe(error)
    log(`[chat] the run for session ${sessionId} did not complete: ${detail}`)
    emit({ type: 'error', sessionId, code: 'unknown', detail })
  }
}

/**
 * Creates the session the renderer named, if this is its first message.
 *
 * Two bounded reads instead of a "does it exist" method the port does not have: a session with
 * messages plainly exists, and for an empty one the store answers a `session/start` carrying a
 * fresh incarnation with `TapeStaleIncarnationError` — its head row already has one. Anything else
 * propagates.
 */
async function ensureSession(sessions: SessionService, sessionId: string): Promise<void> {
  const existing = await sessions.listMessages({ sessionId, limit: 1 })
  if (existing.length > 0) return
  try {
    await sessions.createSession({ sessionId })
  } catch (error) {
    if (!(error instanceof TapeStaleIncarnationError)) throw error
  }
}

/** The webContents behind an IPC event, when there is one (a unit test's event carries none). */
function ownerOf(event: unknown): RunOwner | null {
  const sender: unknown = isRecord(event) ? event['sender'] : undefined
  if (!isRecord(sender)) return null
  const hasListeners = typeof sender['on'] === 'function' && typeof sender['off'] === 'function'
  return hasListeners ? (sender as unknown as RunOwner) : null
}

/** Calls `gone` once the owning document is replaced or destroyed; returns the detach. */
function watchOwner(owner: RunOwner | null, gone: () => void): () => void {
  if (owner === null) return (): void => {}
  const onDestroyed = (): void => gone()
  const onNavigation = (...args: unknown[]): void => {
    // Electron's own `did-start-navigation` params. A main-frame navigation that is not a
    // fragment / pushState one replaces the document; anything else leaves the run alone.
    const details = args[0]
    if (!isRecord(details)) return
    if (details['isMainFrame'] === true && details['isSameDocument'] === false) gone()
  }
  owner.on('destroyed', onDestroyed)
  owner.on('did-start-navigation', onNavigation)
  return (): void => {
    owner.off('destroyed', onDestroyed)
    owner.off('did-start-navigation', onNavigation)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A provider that refuses to be constructed. A missing credential reads as `auth`, as it did in
 * phase 0; a value that is present but unusable (a base URL with a query string, an Anthropic one
 * ending in `/v1`) is the `provider` bucket, which is where the wire's own `invalid-request` goes.
 * Anything else is not a configuration problem and says so.
 */
function configErrorCode(error: unknown): ChatErrorCode {
  if (error instanceof ProviderConfigMissingError) return 'auth'
  if (error instanceof ProviderInvalidArgumentError) return 'provider'
  return 'unknown'
}

/** Diagnostic text for logs and the never-rendered `detail`. Adapters redact credentials. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
