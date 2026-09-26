/**
 * The prompt layer (spec 02 §提示层：范围、位置、版本与组装): every fixed text Tenon sends a model.
 * Kernel code that writes fixed English into what a model reads takes it from here, or from a builtin
 * tool's module (descriptions, result templates, error texts); a new place means a new key.
 *
 * Plan step 10 lays down `fill()` and `MODEL_NOTES` in the spec's shape. A member no step has written
 * yet is optional; plan step 14 writes every cell of `closure` the §原因码表 needs, so every source has
 * its row, and each later step adds the member it writes to a model.
 * The system prompts, the language hint and `PROMPT_LAYER_VERSION` / `PROMPT_LAYER_HASH` arrive with
 * plan step 18.
 *
 * What is stored is the text AFTER filling: a replay takes the stored text, never re-fills it, so a
 * later version only changes facts written after it (B1, A13).
 */
import type { ClosureSource, ExecutionState } from '../loop/closure.js'

/**
 * Every `{name}` in the template must be in `slots`, or it throws `TypeError`; values go in as they
 * are, unescaped. A slot the template does not use is allowed: the caller passes what the cell may use.
 */
export function fill(template: string, slots: Readonly<Record<string, string>>): string {
  return template.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
    const value = slots[name]
    if (value === undefined) {
      throw new TypeError(`fill: the template names {${name}}, and no slot of that name was given`)
    }
    return value
  })
}

/** The closure codes a note is looked up for; the two answers of AskUserQuestion are not closures. */
export type ClosureNoteSource = Exclude<ClosureSource, 'no-preference' | 'typed-answer'>

export interface ModelNotes {
  /**
   * By (source, execution state). A blocking code may use the slots `BLOCKED_FACT_KEYS[source]`
   * (plan step 11); every other cell has none. Each source has the states §提示层「closure 要填满的格」
   * lists, and only those.
   */
  readonly closure: Readonly<
    Record<ClosureNoteSource, Readonly<Partial<Record<ExecutionState, string>>>>
  >
  /** A denying inspector that timed out or failed (§Inspector 接口与合议); the source is `inspector`. */
  readonly inspectorFailed: Readonly<Record<'timeout' | 'error', string>>
  readonly ask?: { readonly result: string; readonly noPreference: string; readonly typed: string } // plan step 26
  readonly handoff?: {
    readonly status: Readonly<Record<'partial' | 'aborted' | 'superseded' | 'uncertain', string>>
    readonly call: string
  } // plan step 31
  /** The model-only note a 「继续」 Run opens with (`message/continuation`; A2, H11). */
  readonly continuation: Readonly<Record<'output-truncated' | 'step-limit', string>>
  readonly spill?: string // plan step 24
  readonly searchTruncated?: string // plan step 28
  readonly compactionRequest?: string // plan step 30
  readonly compactionWrap?: string // plan step 30
  /** A connector tool's inputSchema cannot be used at all (open question 16). */
  readonly schemaUnusable: string
  readonly environment?: {
    readonly wrap: string
    readonly date: string
    readonly folders: string
    readonly dedicated: string
  } // plan step 18
}

/**
 * The sentence a tool that was blocked after the table froze gets back (§不带 tools 的请求与冻结后的
 * 变化; E2, B1, F2). `policy` uses it too: 02 has only "the whole tool is denied" (§第 1 层真值表).
 */
const NOT_AVAILABLE = 'This tool is not available in this session. Do not call it again.'

export const MODEL_NOTES: ModelNotes = {
  closure: {
    // What the user answered, or did instead of answering (F2, F11).
    'user-rejected': {
      'not-run': 'The user declined this call, so it was not run.',
    },
    superseded: {
      'not-run': 'The user sent a new message instead of answering, so this call was not run.',
    },
    // The four blocks (D5): not answered by the user, counted towards MACHINE_DENIAL_CAP.
    policy: { 'not-run': NOT_AVAILABLE },
    'user-disabled': { 'not-run': NOT_AVAILABLE },
    protected: {
      'not-run':
        'This call was blocked because it reaches a location Tenon protects ({target}), so it was not run. Do not try to reach it another way.',
    },
    inspector: {
      'not-run': 'A permission check blocked this call, so it was not run.',
    },
    'tool-unavailable': {
      'not-run': 'This tool cannot be used right now, so the call was not run.',
    },
    // The second text block carries the validator's message or the tool's own check (§参数校验与失败).
    'invalid-input': {
      'not-run':
        'The arguments of this call are invalid, so it was not run. The reason follows. Correct the arguments before calling it again.',
    },
    // A stop, a quit or a closed window (B1, B4). What a command printed before it goes after this.
    stopped: {
      'not-run': 'The user stopped the task before this call ran, so it was not run.',
      aborted:
        'The user stopped the task while this call was running, so it was interrupted. Changes it made before the stop are still in place.',
      uncertain:
        'The user stopped the task while this call was running, and it is not known whether the call finished. Its effects may have happened.',
    },
    'app-exit': {
      'not-run': 'Tenon was closing before this call ran, so it was not run.',
      aborted:
        'Tenon was closing while this call was running, so it was interrupted. Changes it made before that are still in place.',
      uncertain:
        'Tenon was closing while this call was running, and it is not known whether the call finished. Its effects may have happened.',
    },
    'timed-out': {
      aborted:
        'The command ran past its timeout and was stopped. Its output until then follows. Changes it made are still in place. Retry with a larger timeout if you still need it.',
      uncertain:
        'The command ran past its timeout and was stopped, and it is not known whether it exited. Its effects may have happened.',
    },
    // Written by the startup recovery, never re-run (B1, B15).
    crashed: {
      'not-run': 'Tenon closed unexpectedly before this call ran, so it was not run.',
      uncertain:
        'Tenon closed unexpectedly while this call was running, and it is not known whether the call finished. Its effects may have happened. It was not run again.',
    },
    // The fallback when a call reached a request without its result (B1): an internal error.
    repair: {
      'not-run':
        'This call has no recorded result because of an internal error, so it was not run.',
      uncertain:
        'This call has no recorded result because of an internal error. It may have run, and its effects may have happened.',
    },
    // AskUserQuestion stopped before it was answered (H6): the only one of its three fills that is a
    // closure.
    unanswered: {
      aborted: 'The task was stopped before the user answered this question.',
    },
    // The calls a Run leaves when it ends by one of these (A2, H11, H12, F2).
    'output-truncated': {
      'not-run':
        'The reply was cut off at the output limit before this call could run, so it was not run.',
    },
    'step-limit': {
      'not-run': 'The task reached its step limit before this call ran, so it was not run.',
    },
    'no-progress': {
      'not-run':
        'This call repeats the calls before it without making progress, so it was not run. Try a different approach.',
    },
    'usage-limit': {
      'not-run': 'The task reached its usage limit before this call ran, so it was not run.',
    },
    'blocked-repeatedly': {
      'not-run':
        'Several calls in a row were blocked, so the task stopped and this call was not run.',
    },
    'content-filter': {
      'not-run': 'The provider’s content filter stopped the reply, so this call was not run.',
    },
    'provider-error': {
      'not-run': 'The model service reported an error, so this call was not run.',
    },
  },
  continuation: {
    'output-truncated':
      'Your previous reply was cut off at the output limit. Continue from exactly where it stopped, without repeating what you already wrote.',
    'step-limit':
      'The task reached its step limit and the user asked you to continue. Carry on with the task from where you stopped.',
  },
  // The spec's own sentences (§Inspector 接口与合议).
  inspectorFailed: {
    timeout:
      'The permission check for this call timed out, so the call was not run. This is a check failure, not a judgment that the call is unsafe. Ask the user how to proceed if you still need this call.',
    error:
      'The permission check for this call failed with an error, so the call was not run. This is a check failure, not a judgment that the call is unsafe. Ask the user how to proceed if you still need this call.',
  },
  schemaUnusable:
    'The input schema its server gave for this tool cannot be used to check arguments, so no call to it can run. Do not call it again in this session.',
}
