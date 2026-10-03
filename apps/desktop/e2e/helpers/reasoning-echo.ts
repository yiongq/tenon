/**
 * What the DeepSeek live group reads off its request record (M6 验收 29, plan step 12): DeepSeek's
 * documentation says a request that carries `tools` without every earlier assistant turn's
 * `reasoning_content`, a turn that made no tool call included, is answered 400
 * (api-docs.deepseek.com/guides/thinking_mode; vendor research, vendor-matrix.json; deepseek-flash
 * answered 200 either way on 2026-10-03, spec Revisions). Tenon sends it back on a passed row under
 * the field the probe saw, `reasoning_content` when it saw none (§模型行「合成」; 推出的读法 16);
 * these read, per chat-completions request body, whether each assistant turn went out with it.
 *
 * Pure: every input is an argument, so apps/desktop/test/reasoning-echo.test.ts pins it in CI.
 */

/** The part of a chat-completions request body read here. */
export interface EchoBody {
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly reasoning_content?: unknown }>
}

/**
 * The reasoning each assistant turn of `body` carries back, in order: its `reasoning_content`, or
 * null where it went out without a non-empty one. Other roles are not turns of the model's.
 */
export function echoedReasoning(body: EchoBody | null): (string | null)[] {
  return (body?.messages ?? [])
    .filter((message) => message.role === 'assistant')
    .map((message) =>
      typeof message.reasoning_content === 'string' && message.reasoning_content !== ''
        ? message.reasoning_content
        : null,
    )
}

/**
 * An assistant turn sent without its reasoning: the request's index in `bodies` and the turn's
 * among that request's assistant messages; `turn` null where the body was not JSON, so nothing
 * shows it went back.
 */
export interface EchoGap {
  readonly request: number
  readonly turn: number | null
}

/** Every assistant turn in `bodies` that went out without its reasoning; empty when none did. */
export function echoGaps(bodies: readonly (EchoBody | null)[]): EchoGap[] {
  return bodies.flatMap((body, request): EchoGap[] =>
    body === null
      ? [{ request, turn: null }]
      : echoedReasoning(body).flatMap((text, turn) => (text === null ? [{ request, turn }] : [])),
  )
}

/**
 * What each assistant turn should carry back, from its thinking as the Tape holds it (验收 29: a turn
 * that carried thinking goes back with it; one with none, as deepseek-flash's first step often is,
 * has nothing to echo and reads null like `echoedReasoning`).
 */
export function expectedEchoes(thinking: readonly string[]): (string | null)[] {
  return thinking.map((text) => (text === '' ? null : text))
}
