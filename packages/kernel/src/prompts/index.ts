/**
 * The prompt layer (spec 02 §提示层：范围、位置、版本与组装): every fixed text Tenon sends a model.
 * Kernel code that writes fixed English into what a model reads takes it from here, or from a builtin
 * tool's module (descriptions, result templates, error texts); a new place means a new key.
 *
 * Plan step 10 lays down `fill()` and `MODEL_NOTES` in the spec's shape. A member no step has written
 * yet is optional, and `closure` holds only the cells written so far; each step adds what it writes to
 * a model (plan steps 10–15), and plan step 14 fills the rest of `closure` and removes the optionals.
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
   * (plan step 11); every other cell has none. Partial until plan step 14 fills every cell.
   */
  readonly closure: Readonly<
    Partial<Record<ClosureNoteSource, Readonly<Partial<Record<ExecutionState, string>>>>>
  >
  /** A denying inspector that timed out or failed (§Inspector 接口与合议); the source is `inspector`. */
  readonly inspectorFailed: Readonly<Record<'timeout' | 'error', string>>
  readonly ask?: { readonly result: string; readonly noPreference: string; readonly typed: string } // plan step 26
  readonly handoff?: {
    readonly status: Readonly<Record<'partial' | 'aborted' | 'superseded' | 'uncertain', string>>
    readonly call: string
  } // plan step 31
  readonly continuation?: Readonly<Record<'output-truncated' | 'step-limit', string>> // plan step 13
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
    policy: { 'not-run': NOT_AVAILABLE },
    'user-disabled': { 'not-run': NOT_AVAILABLE },
    // The second text block carries the validator's message or the tool's own check (§参数校验与失败).
    'invalid-input': {
      'not-run':
        'The arguments of this call are invalid, so it was not run. The reason follows. Correct the arguments before calling it again.',
    },
    'tool-unavailable': {
      'not-run': 'This tool cannot be used right now, so the call was not run.',
    },
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
