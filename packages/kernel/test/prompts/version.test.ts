/**
 * The prompt layer's version gate (spec 02 §提示层「版本闸」; 旧 224): the layer's hash is recomputed
 * here, and any change to its text — a system prompt, the language hint, a note, a tool's spec, result
 * template or error text — fails `pnpm test` until the version goes up and the hash is updated.
 */
import { describe, expect, it } from 'vitest'
import {
  LOCALE_HINT,
  PROMPT_LAYER_HASH,
  PROMPT_LAYER_VERSION,
  SYSTEM_PROMPTS,
  fill,
  systemPrompt,
} from '../../src/prompts/index.js'
import { currentPromptLayer, promptLayerHash, promptLayerHashOf } from '../../src/prompts/layer.js'
import type { PromptLayer } from '../../src/prompts/layer.js'

describe('the version gate', () => {
  it('holds the hash of the layer this build has', () => {
    expect(
      promptLayerHash(),
      'The prompt layer changed. Raise PROMPT_LAYER_VERSION by one, set PROMPT_LAYER_HASH to the new hash, and run the eval set (spec 02 §提示层「版本闸」).',
    ).toBe(PROMPT_LAYER_HASH)
    expect(Number.isInteger(PROMPT_LAYER_VERSION) && PROMPT_LAYER_VERSION >= 1).toBe(true)
  })

  it('moves on one character anywhere in the layer', () => {
    const layer = currentPromptLayer()
    const base = promptLayerHashOf(layer)
    const tool = (name: string): PromptLayer['tools'][number] => {
      const found = layer.tools.find((candidate) => candidate.name === name)
      if (found === undefined) throw new Error(`no ${name} in the layer`)
      return found
    }
    const withTool = (
      name: string,
      change: (t: PromptLayer['tools'][number]) => PromptLayer['tools'][number],
    ): PromptLayer => ({
      ...layer,
      tools: layer.tools.map((candidate) =>
        candidate.name === name ? change(candidate) : candidate,
      ),
    })
    const search = tool('WebSearch')
    const read = tool('Read')
    const edit = tool('Edit')
    const variants: PromptLayer[] = [
      { ...layer, SYSTEM_PROMPTS: { ...SYSTEM_PROMPTS, chat: `${SYSTEM_PROMPTS.chat}.` } },
      { ...layer, LOCALE_HINT: `${LOCALE_HINT} ` },
      {
        ...layer,
        MODEL_NOTES: { ...(layer.MODEL_NOTES as object), schemaUnusable: 'changed' },
      },
      // A connector call's own texts (executor.ts) are in the layer too.
      {
        ...layer,
        MODEL_NOTES: { ...(layer.MODEL_NOTES as object), connectorFailed: 'changed {message}' },
      },
      { ...layer, MODEL_NOTES: { ...(layer.MODEL_NOTES as object), connectorEmpty: '(none)' } },
      // Both of WebSearch's variants are in the layer, each on its own.
      withTool('WebSearch', (t) => ({
        ...t,
        variants: t.variants.map((v) =>
          v.variant === 'domainFilter'
            ? { ...v, spec: { ...(v.spec as object), description: 'x' } }
            : v,
        ),
      })),
      withTool('WebSearch', (t) => ({
        ...t,
        variants: t.variants.map((v) =>
          v.variant === 'plain' ? { ...v, spec: { ...(v.spec as object), description: 'x' } } : v,
        ),
      })),
      // A result template, and a fixed error text.
      withTool('Read', (t) => ({
        ...t,
        texts: { ...t.texts, more: `${read.texts['more'] ?? ''}!` },
      })),
      withTool('Edit', (t) => ({
        ...t,
        texts: { ...t.texts, sameStrings: `${edit.texts['sameStrings'] ?? ''}!` },
      })),
    ]
    expect(search.variants.map((v) => v.variant)).toEqual(['domainFilter', 'plain'])
    for (const variant of variants) expect(promptLayerHashOf(variant)).not.toBe(base)
  })
})

describe('the system text', () => {
  it('is the profile prompt and the language hint, and names no model, date or folder', () => {
    for (const profile of ['chat', 'cowork'] as const) {
      for (const locale of ['zh-CN', 'en'] as const) {
        const text = systemPrompt(profile, locale)
        expect(text.startsWith(SYSTEM_PROMPTS[profile])).toBe(true)
        expect(text.endsWith(fill(LOCALE_HINT, { locale }))).toBe(true)
        expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|claude|glm|\/Users\//i)
      }
    }
  })

  it('says the six things §提示层「写法」 requires, in both profiles where they apply', () => {
    for (const profile of ['chat', 'cowork'] as const) {
      const text = SYSTEM_PROMPTS[profile]
      expect(text).toMatch(/data, not instructions/)
      expect(text).toMatch(/preview .*Read with offset and limit/s)
      expect(text).toMatch(/rejects a tool call, do not retry it/)
      expect(text).toMatch(/AskUserQuestion/)
      expect(text).toMatch(/<environment> block/)
      expect(text).toMatch(/the latest one is current/)
    }
    expect(SYSTEM_PROMPTS.chat).toMatch(/You cannot run code/)
  })
})
