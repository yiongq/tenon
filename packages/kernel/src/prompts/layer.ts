/**
 * The prompt layer's hash (spec 02 §提示层「版本闸」): every text the layer holds, in one canonical
 * hash — the system prompts, the language hint, every model note, and every builtin tool's every
 * possible ToolSpec (WebSearch has two: with and without its domain filter) with its result
 * templates and error texts, by (name, variant). test/prompts/version.test.ts recomputes it against
 * `PROMPT_LAYER_HASH`.
 */
import { canonicalHash } from '../provider/wire/shared.js'
import { canonicalJson } from '../tape/canonical-json.js'
import { BUILTIN_TOOLS, BUILTIN_TOOL_NAMES } from '../tools/builtin/index.js'
import { LOCALE_HINT, MODEL_NOTES, SYSTEM_PROMPTS } from './index.js'

/** Everything the hash covers, as plain data. */
export interface PromptLayer {
  readonly SYSTEM_PROMPTS: unknown
  readonly LOCALE_HINT: string
  readonly MODEL_NOTES: unknown
  /** By tool name: each distinct spec it can send, by variant, and its fixed texts. */
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly variants: ReadonlyArray<{ readonly variant: string; readonly spec: unknown }>
    readonly texts: Readonly<Record<string, string>>
  }>
}

/** The layer this build holds. */
export function currentPromptLayer(): PromptLayer {
  const tools = BUILTIN_TOOL_NAMES.toSorted().map((name) => {
    const tool = BUILTIN_TOOLS[name]
    const plain = tool.spec({ domainFilter: false })
    const filtered = tool.spec({ domainFilter: true })
    const variants =
      canonicalJson(plain) === canonicalJson(filtered)
        ? [{ variant: 'default', spec: plain }]
        : [
            { variant: 'domainFilter', spec: filtered },
            { variant: 'plain', spec: plain },
          ]
    return { name, variants, texts: tool.texts }
  })
  return { SYSTEM_PROMPTS, LOCALE_HINT, MODEL_NOTES, tools }
}

export function promptLayerHashOf(layer: PromptLayer): string {
  return canonicalHash(layer, 'prompt layer')
}

export function promptLayerHash(): string {
  return promptLayerHashOf(currentPromptLayer())
}
