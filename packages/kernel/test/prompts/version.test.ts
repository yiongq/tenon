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

/**
 * Every released prompt layer, by version: append a row, never edit one. Eval records and the
 * 「改了必跑」 trigger key on the version, so one version has to mean one layer — a hash updated
 * without a new row here fails, which is what makes the version move with it (acceptance 38:
 * 「却没同时改版本号和哈希，pnpm test 失败」).
 */
const LAYER_HISTORY: Readonly<Record<number, string>> = {
  1: '62cfe9ae7da9a26873d295566ace5d21277ed329c33f745309d7cd64175ae039',
  // The connector notes (connectorFailed, connectorEmpty) joined the layer (plan step 18 catch-up).
  2: '562b33451d62c4df7c54ff6827876baf8a94affe1334382530c202838d0372fc',
  // Write, Edit and Bash's result templates and errors joined the layer, and Grep names look-around
  // and backreferences as ripgrep does now that re2js turns them down, turns down what re2js would
  // misread and too large a pattern, says \b and \B are ASCII, and names a line too long for the
  // pattern and a search past its time budget (plan step 22).
  3: '21e3ec1ed486e1a68c260ce4801898c5f585dc4d7245780a7b917e83aabfc0f0',
}

describe('the version gate', () => {
  it('holds the hash of the layer this build has', () => {
    expect(
      promptLayerHash(),
      'The prompt layer changed. Raise PROMPT_LAYER_VERSION by one, set PROMPT_LAYER_HASH to the new hash, add the pair to LAYER_HISTORY in this file, and run the eval set (spec 02 §提示层「版本闸」).',
    ).toBe(PROMPT_LAYER_HASH)
  })

  it('moves the version with the hash (acceptance 38, 旧 224)', () => {
    const versions = Object.keys(LAYER_HISTORY).map(Number)
    expect(
      LAYER_HISTORY[PROMPT_LAYER_VERSION],
      'PROMPT_LAYER_HASH is not the hash LAYER_HISTORY records for PROMPT_LAYER_VERSION: a new layer needs a new version and a new row, never an edited one.',
    ).toBe(PROMPT_LAYER_HASH)
    // The current version is the newest, versions only go up by one, and no two share a layer.
    expect(PROMPT_LAYER_VERSION).toBe(Math.max(...versions))
    expect(versions.toSorted((a, b) => a - b)).toEqual(versions.map((_, i) => i + 1))
    expect(new Set(Object.values(LAYER_HISTORY)).size).toBe(versions.length)
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
    const bash = tool('Bash')
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
      // A command's result heading (plan step 22).
      withTool('Bash', (t) => ({
        ...t,
        texts: { ...t.texts, exitCode: `${bash.texts['exitCode'] ?? ''}.` },
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
