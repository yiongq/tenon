/**
 * Copy coverage for the interface's codes (spec 02 验收 37; plan step 20, 旧 6 and the copy-coverage
 * unit test), written like provider-catalogue.test.ts: every value a code can take has a non-empty
 * sentence in BOTH catalogues, and each sentence names exactly the arguments the data brings — the
 * required `facts` keys of its reason (`requiredFactKeys`, for every `kind`), `BLOCKED_FACT_KEYS`
 * of its block code, nothing where the data brings none.
 *
 * The values come from the source unions and the runtime arrays (the contracts' enums, the kernel's
 * key tables, the registered providers), never from the catalogue: a code added without its copy
 * is exactly what this test exists to catch, and a catalogue walk would never see it. A union with
 * no runtime array is written out here with a compile-time check that it is the whole union.
 *
 * Arguments are read with `@formatjs/icu-messageformat-parser`, the grammar the catalogue is
 * rendered with, never a regex; the lookup goes against the raw bundles, NOT through i18next, whose
 * `fallbackLng: 'en'` would let an English entry answer for a missing zh-CN one.
 *
 * `end-reason-copy.test.ts` already pins the 18 end codes' slots against the kernel type; the end
 * codes here are only checked from the contract's side (what `chat.event` can carry).
 */
import {
  CONFIRM_FACT_KEYS,
  createProviderRegistry,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type {
  BlockReason,
  ClosureSource,
  ConfirmReason,
  PendingRoot,
  ToolExclusionCode,
} from '@tenon-app/kernel'
import {
  mcpErrorCodeSchema,
  mcpWriteErrorCodeSchema,
  mcpLoginErrorSchema,
  mcpPhaseSchema,
  toolSettingSchema,
  closureSourceSchema,
  confirmKindSchema,
  confirmReasonSchema,
  confirmTargetSchema,
  customVendorErrorCodeSchema,
  flaggedCategorySchema,
  pendingRootSchema,
  probeReasonSchema,
  providerModelSchema,
  providerRefusalSchema,
  providerWriteErrorCodeSchema,
  requiredFactKeys,
  reversibilitySchema,
  runEndReasonSchema,
} from '@tenon-app/contracts'
import type {
  RouteRequest,
  mcpSave,
  McpServerView,
  McpWarning,
  ChatEvent,
  ConfirmRequestInput,
  RunEndReasonContract,
} from '@tenon-app/contracts'
import {
  isArgumentElement,
  isDateElement,
  isNumberElement,
  isPluralElement,
  isSelectElement,
  isTagElement,
  isTimeElement,
  parse,
} from '@formatjs/icu-messageformat-parser'
import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { describe, expect, it } from 'vitest'
// The kernel's own table: not on its public surface, and the plan names it as the source (旧 6).
import { BLOCKED_FACT_KEYS } from '../../../packages/kernel/src/loop/closure.js'
import { SUPPORTED_LOCALES, resources } from '../src/i18n/resources.js'
import type { Locale } from '../src/i18n/resources.js'
import {
  FETCH_MODELS_KEY,
  KEY_REMINDER_KEY,
  PROBE_REASON_KEY,
  PROBE_REFUSED_KEY,
  VENDOR_ERROR_KEY,
} from '../src/renderer/src/lib/custom-vendor.js'
import type {
  FetchModelsCode,
  KeyReminder,
  ProbeReason,
  ProbeRefusedCode,
} from '../src/renderer/src/lib/custom-vendor.js'
import { PROVIDER_WRITE_ERROR_KEY, REFUSAL_KEY } from '../src/renderer/src/lib/provider-copy.js'
import type { PendingCard } from '../src/renderer/src/runtime/session-store.js'
import type { TurnSummary } from '../src/renderer/src/runtime/thread-model.js'

/** `true` only when `Listed` is the whole of `Union`. */
type Covers<Union, Listed> = [Exclude<Union, Listed>] extends [never] ? true : false

/**
 * `covers<U>()(list, true)` compiles only when `list` holds every member of `U` and nothing else:
 * a value added to the union, or dropped from the list, breaks the build.
 */
function covers<Union>() {
  return <const Listed extends readonly Union[]>(
    listed: Listed,
    _proof: Covers<Union, Listed[number]>,
  ): Listed => listed
}

function lookup(locale: Locale, key: string): unknown {
  let node: unknown = resources[locale].common
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

/** Every argument a message names, at any depth — a plural's or select's own argument included. */
function argumentsOf(message: string): string[] {
  const names = new Set<string>()
  const walk = (elements: readonly MessageFormatElement[]): void => {
    for (const element of elements) {
      if (
        isArgumentElement(element) ||
        isNumberElement(element) ||
        isDateElement(element) ||
        isTimeElement(element)
      ) {
        names.add(element.value)
      } else if (isSelectElement(element) || isPluralElement(element)) {
        names.add(element.value)
        for (const option of Object.values(element.options)) walk(option.value)
      } else if (isTagElement(element)) {
        walk(element.children)
      }
    }
  }
  walk(parse(message))
  return [...names].toSorted()
}

interface Expectation {
  readonly key: string
  /** The arguments the sentence must name — exactly these. */
  readonly args: readonly string[]
  /** What the entry is for, in a failure message. */
  readonly what: string
}

/** One line per entry that is missing, empty or names other arguments; `[]` when all is well. */
function problems(expected: readonly Expectation[]): string[] {
  const found: string[] = []
  for (const locale of SUPPORTED_LOCALES) {
    for (const { key, args, what } of expected) {
      const message = lookup(locale, key)
      if (typeof message !== 'string' || message.trim() === '') {
        found.push(`${locale}: ${key} is missing or empty (${what})`)
        continue
      }
      const named = argumentsOf(message)
      const wanted = [...new Set(args)].toSorted()
      if (named.join(',') !== wanted.join(',')) {
        found.push(
          `${locale}: ${key} names {${named.join(', ')}}, wants {${wanted.join(', ')}} (${what})`,
        )
      }
    }
  }
  return found
}

type Kind = ConfirmRequestInput['kind']
type TargetType = ConfirmRequestInput['target']['type']
const KINDS: readonly Kind[] = confirmKindSchema.options
const TARGET_TYPES: readonly TargetType[] = confirmTargetSchema.options.map(
  (option) => option.shape.type.value,
)
const CATEGORIES = flaggedCategorySchema.options
/** The kernel's table is a `Record<ConfirmReason, …>`, so its keys are every reason there is. */
const REASONS = Object.keys(CONFIRM_FACT_KEYS) as ConfirmReason[]
/** Likewise `Record<BlockReason, …>`. */
const BLOCK_CODES = Object.keys(BLOCKED_FACT_KEYS) as BlockReason[]
const CLOSURE_SOURCES = covers<ClosureSource>()(closureSourceSchema.options, true)

/*
 * The keys ApprovalCard builds (`titleKey`, `scopeKey`), restated from the spec because that module
 * is .tsx and does not load here: §最小审批卡 ① the title by kind and target, a `file` card split on
 * read-only or not; 「期限」 only from `allowScope` and `target.type`, a sub-agent's card a subtask's.
 */
function titleKey(kind: Kind, target: TargetType, reversibility: string): string {
  if (kind === 'file') {
    return reversibility === 'read-only' ? 'confirm.title.file.read' : 'confirm.title.file.write'
  }
  if (kind === 'network') {
    return target === 'search' ? 'confirm.title.network.search' : 'confirm.title.network.url'
  }
  return kind === 'command' ? 'confirm.title.command' : 'confirm.title.tool'
}

function scopeKey(scope: string, target: TargetType, subtask: boolean): string {
  if (scope !== 'session') return 'confirm.scope.once'
  if (subtask) return target === 'url' ? 'confirm.scope.subtaskDomain' : 'confirm.scope.subtask'
  return target === 'url' ? 'confirm.scope.sessionDomain' : 'confirm.scope.session'
}

describe('the approval card copy', () => {
  it('reads the nine reasons from the kernel table the contract enumerates', () => {
    expect(REASONS).toHaveLength(9)
    expect(REASONS.toSorted()).toEqual([...confirmReasonSchema.options].toSorted())
    expect(KINDS).toHaveLength(4)
    expect(CATEGORIES).toEqual(['exfiltration', 'inspector-failed'])
  })

  it('has the 「为什么停」 sentence of every reason under every kind, naming its required facts', () => {
    // §最小审批卡 ③: `confirm.reason.<reason>`; `irreversible` by kind (it needs `path` under
    // `file` and `command` under `command`); `flagged` by category, counted once for each — the
    // category picks the sentence, so the sentence itself names the reason's other keys.
    const expected: Expectation[] = []
    for (const kind of KINDS) {
      for (const reason of REASONS) {
        const required = requiredFactKeys(reason, kind)
        if (reason === 'irreversible') {
          expected.push({ key: `confirm.reason.irreversible.${kind}`, args: required, what: kind })
        } else if (reason === 'flagged') {
          for (const category of CATEGORIES) {
            expected.push({
              key: `confirm.reason.flagged.${category}`,
              args: required.filter((key) => key !== 'category'),
              what: `${kind}, category ${category}`,
            })
          }
        } else {
          expected.push({ key: `confirm.reason.${reason}`, args: required, what: kind })
        }
      }
    }
    // 4 kinds × (7 plain reasons + irreversible + flagged × 2 categories).
    expect(expected).toHaveLength(40)
    expect(problems(expected)).toEqual([])
  })

  it('counts the extra keys of irreversible under file and command', () => {
    // Plan step 20 旧 6: the required keys of `irreversible` differ by kind, so the sentence does.
    expect(requiredFactKeys('irreversible', 'file').toSorted()).toEqual(['path', 'toolName'])
    expect(requiredFactKeys('irreversible', 'command').toSorted()).toEqual(['command', 'toolName'])
    expect(
      problems([{ key: 'confirm.reason.irreversible.file', args: ['path', 'toolName'], what: '' }]),
    ).toEqual([])
    expect(
      problems([
        { key: 'confirm.reason.irreversible.command', args: ['command', 'toolName'], what: '' },
      ]),
    ).toEqual([])
  })

  it('has a question-style title for every kind, target and reversibility', () => {
    // §最小审批卡 ①: by `kind` and `target.type`; a `file` card splits on read-only or not.
    const expected = new Map<string, Expectation>()
    for (const kind of KINDS) {
      for (const target of TARGET_TYPES) {
        for (const reversibility of reversibilitySchema.options) {
          const key = titleKey(kind, target, reversibility)
          expected.set(key, { key, args: [], what: `${kind} / ${target} / ${reversibility}` })
        }
      }
    }
    expect(expected.size).toBe(6)
    expect(problems([...expected.values()])).toEqual([])
  })

  it('has the three scopes, and the two of a card from a subtask', () => {
    // §最小审批卡「期限」: only from `allowScope` and `target.type` — once; session and a URL; any
    // other session — and, on a card from a sub-agent (callKey ≠ anchorCallKey), the subtask's two.
    const scopes = covers<PendingCard['allowScope']>()(['once', 'session'], true)
    const expected = new Map<string, Expectation>()
    for (const scope of scopes) {
      for (const target of TARGET_TYPES) {
        for (const subtask of [false, true]) {
          const key = scopeKey(scope, target, subtask)
          expected.set(key, {
            key,
            args: [],
            what: `${scope} / ${target} / subtask ${String(subtask)}`,
          })
        }
      }
    }
    const mainSession = [...expected.keys()].filter((key) => !key.includes('subtask'))
    expect(mainSession.toSorted()).toEqual([
      'confirm.scope.once',
      'confirm.scope.session',
      'confirm.scope.sessionDomain',
    ])
    expect(expected.size).toBe(5)
    expect(problems([...expected.values()])).toEqual([])
    // The collapsed row after an answer: the result, with the scope's own sentence in it.
    expect(
      problems([
        { key: 'confirm.answered.allowed', args: ['scope'], what: 'collapsed allow' },
        { key: 'confirm.answered.denied', args: [], what: 'collapsed deny' },
      ]),
    ).toEqual([])
  })
})

describe('the tool row copy', () => {
  it('has a closure line for every ClosureSource, with nothing to fill', () => {
    // A closed call's `facts` exist only for a block code (§原因码表), so a closure line has no slots.
    expect(CLOSURE_SOURCES).toHaveLength(24)
    const expected = CLOSURE_SOURCES.map((source) => ({
      key: `closure.${source}`,
      args: [],
      what: 'closure line',
    }))
    expect(problems(expected)).toEqual([])
  })

  it('has a block notice for each of the four block codes, naming BLOCKED_FACT_KEYS', () => {
    // §界面范围 `BlockedNotice`: `blocked.<source>`, its slots the outcome's `facts`.
    expect(BLOCK_CODES.toSorted()).toEqual(['inspector', 'policy', 'protected', 'user-disabled'])
    for (const code of BLOCK_CODES) expect(CLOSURE_SOURCES).toContain(code)
    // An inspector's block is said by category, as the card's `flagged` reason is: the category
    // picks the sentence, so it is no slot of it.
    const expected: Expectation[] = BLOCK_CODES.flatMap((code) =>
      code === 'inspector'
        ? CATEGORIES.map((category) => ({
            key: `blocked.inspector.${category}`,
            args: BLOCKED_FACT_KEYS.inspector.filter((key) => key !== 'category'),
            what: `inspector block (${category})`,
          }))
        : [{ key: `blocked.${code}`, args: BLOCKED_FACT_KEYS[code], what: 'block notice' }],
    )
    // A chat's Read out of its own files is `protected` with a sentence of its own, same slots
    // (open question 13), and every notice ends with 「已告诉模型」.
    expected.push({
      key: 'blocked.chatReadScope',
      args: BLOCKED_FACT_KEYS.protected,
      what: 'chat Read',
    })
    expected.push({ key: 'blocked.told', args: [], what: 'the model was told' })
    expect(problems(expected)).toEqual([])
  })
})

describe('the end-of-Run copy', () => {
  it('has a sentence for every end code chat.event can carry, naming only its own fields', () => {
    const members = runEndReasonSchema.options
    expect(members).toHaveLength(18)
    const found: string[] = []
    for (const member of members) {
      const code: RunEndReasonContract['code'] = member.shape.code.value
      const fields = new Set(Object.keys(member.shape).filter((field) => field !== 'code'))
      const named = new Set<string>()
      for (const locale of SUPPORTED_LOCALES) {
        const message = lookup(locale, `runEnd.${code}`)
        if (typeof message !== 'string' || message.trim() === '') {
          found.push(`${locale}: runEnd.${code} is missing or empty`)
          continue
        }
        const args = argumentsOf(message)
        named.add(args.join(','))
        for (const arg of args) {
          if (!fields.has(arg)) found.push(`${locale}: runEnd.${code} names {${arg}}, not a field`)
        }
      }
      // Both languages fill the same slots: a slot only one names is data the other drops.
      if (named.size > 1) found.push(`runEnd.${code}: the locales name different arguments`)
    }
    expect(found).toEqual([])
  })

  it('has the failure card’s effects line and each of its one actions', () => {
    // §失败卡与结束原因 ② by state: the completed ones listed, stopped partway (a request sent out may
    // have arrived), did not happen, may have run — or nothing at all; ③ one of 「继续」「重试」「去设置」
    // 「复制诊断信息」 (and its copied state).
    expect(
      problems([
        { key: 'failure.effects.none', args: [], what: 'no calls' },
        { key: 'failure.effects.doneHeading', args: ['count'], what: 'completed calls, listed' },
        { key: 'failure.effects.stopped', args: ['count'], what: 'aborted calls' },
        { key: 'failure.effects.stoppedSent', args: ['count'], what: 'aborted external calls' },
        { key: 'failure.effects.notRun', args: ['count'], what: 'not-run calls' },
        { key: 'failure.effects.uncertain', args: ['count'], what: 'uncertain calls' },
        { key: 'failure.continue', args: [], what: 'step-limit / output-truncated' },
        { key: 'failure.retry', args: [], what: 'provider-error, retryable' },
        { key: 'failure.settings', args: [], what: 'provider-error, auth' },
        { key: 'failure.copy', args: [], what: 'the rest' },
        { key: 'failure.copied', args: [], what: 'after copying' },
      ]),
    ).toEqual([])
  })

  it('has the summary line with the three counts TurnSummary carries', () => {
    const counts = covers<keyof TurnSummary>()(['read', 'write', 'external'], true)
    expect(problems([{ key: 'summary.line', args: counts, what: 'turn summary' }])).toEqual([])
  })

  it('has a sentence for every error code an error event without an end reason carries', () => {
    // §失败卡与结束原因 ①: an error with no `endReason` is not a Run's; it shows by its `code`.
    const codes = covers<Extract<ChatEvent, { type: 'error' }>['code']>()(
      ['network', 'auth', 'rate-limit', 'provider', 'unknown'],
      true,
    )
    expect(
      problems(codes.map((code) => ({ key: `error.${code}`, args: [], what: 'error code' }))),
    ).toEqual([])
  })
})

describe('the banner and the model menu copy', () => {
  it('has a banner line for each of the three wait kinds', () => {
    const kinds = covers<PendingRoot['waitKind']>()(pendingRootSchema.shape.waitKind.options, true)
    expect(kinds).toHaveLength(3)
    const expected = kinds.map((kind) => ({ key: `banner.${kind}`, args: [], what: 'banner row' }))
    expected.push({ key: 'banner.goBack', args: [], what: '「回去」' })
    expect(problems(expected)).toEqual([])
  })

  it('has the second line of each of the four row marks', () => {
    // §模型菜单「行标记」: `verified` writes the purpose sentence and the target host;
    // `local-text-only` 「<主机> · 仅文字对话」; `unverified-text-only` 「未验证 · 仅文字对话 · <主机>」 (each row ends with its host).
    // M6 02 修补 1: `probed` 「本机探测 · 不保证 · <主机>」, and a custom instance's row without a
    // passing probe keeps `unverified-text-only` with its own line 「尚未通过探测 · 仅文字对话 · <主机>」.
    const marks = providerModelSchema.shape.mark.options
    expect(marks).toHaveLength(4)
    const line: Readonly<Record<(typeof marks)[number], Expectation>> = {
      verified: { key: 'model.row.line', args: ['purpose', 'host'], what: 'verified' },
      'local-text-only': {
        key: 'model.mark.localTextOnly',
        args: ['host'],
        what: 'local-text-only',
      },
      'unverified-text-only': {
        key: 'model.mark.unverified',
        args: ['host'],
        what: 'unverified-text-only',
      },
      probed: { key: 'model.mark.probed', args: ['host'], what: 'probed' },
    }
    const unprobed: Expectation = {
      key: 'model.mark.unprobed',
      args: ['host'],
      what: 'unverified-text-only, custom instance',
    }
    expect(problems([...marks.map((mark) => line[mark]), unprobed])).toEqual([])
  })

  it('has the thinking level’s marks, apart and together (s19-spec-5)', () => {
    // §模型菜单与输入框「思考强度 ›」: the default is marked, the highest level carries its cost, and a
    // default that is also the highest (GLM-5.3's max) carries both.
    expect(
      problems(
        ['default', 'highest', 'defaultHighest'].map((mark) => ({
          key: `model.effort.${mark}`,
          args: ['level'],
          what: `effort ${mark}`,
        })),
      ),
    ).toEqual([])
  })

  it('has the purpose sentence of every builtin model row, with nothing to fill', () => {
    const providers = createProviderRegistry()
    registerBuiltinProviders(providers)
    const expected = providers
      .list()
      .flatMap((definition) =>
        definition.builtinModels.flatMap((model) =>
          model.purposeKey === undefined
            ? []
            : [{ key: model.purposeKey, args: [], what: `${definition.id} ${model.id}` }],
        ),
      )
    expect(expected.length).toBeGreaterThan(0)
    expect(problems(expected)).toEqual([])
  })
})

describe('the custom vendor copy (M6 plan step 9)', () => {
  // The tables the settings card and the model menu read (lib/custom-vendor.ts, lib/provider-copy.ts):
  // each code of the contract, walked from the contract's own enum or a `covers<>` list of its union.

  it('has the passing line and a sentence for every probe reason, naming only its fields', () => {
    // §结果与原因码: `customVendor.probe.reason.<code>`, `opaque-fields` listing the fields (Q14).
    const reasons = covers<ProbeReason>()(probeReasonSchema.options, true)
    expect(reasons).toHaveLength(12)
    const expected: Expectation[] = reasons.map((reason) => ({
      key: PROBE_REASON_KEY[reason],
      args: reason === 'opaque-fields' ? ['fields'] : [],
      what: `probe reason ${reason}`,
    }))
    expected.push({ key: 'customVendor.probe.passed', args: [], what: 'probe passed' })
    expect(expected.every(({ key }) => key.startsWith('customVendor.probe.'))).toBe(true)
    expect(problems(expected)).toEqual([])
  })

  it('has a sentence for every refused probe code, aborted included, and every model list failure', () => {
    const refused = covers<ProbeRefusedCode>()(
      ['not-found', 'unknown-model', 'local-endpoint', 'busy', 'aborted'],
      true,
    )
    const fetched = covers<FetchModelsCode>()(
      ['not-found', 'config', 'auth', 'unsupported', 'service'],
      true,
    )
    expect(
      problems([
        ...refused.map((code) => ({
          key: PROBE_REFUSED_KEY[code],
          args: [],
          what: `probe refused ${code}`,
        })),
        ...fetched.map((code) => ({
          key: FETCH_MODELS_KEY[code],
          args: [],
          what: `fetchModels ${code}`,
        })),
        { key: 'customVendor.probe.notSaved', args: [], what: 'probe done, not saved' },
      ]),
    ).toEqual([])
  })

  it('has a sentence for every custom vendor write refusal', () => {
    const codes = covers<(typeof customVendorErrorCodeSchema.options)[number]>()(
      customVendorErrorCodeSchema.options,
      true,
    )
    expect(codes).toHaveLength(6)
    expect(
      problems(
        codes.map((code) => ({ key: VENDOR_ERROR_KEY[code], args: [], what: `write ${code}` })),
      ),
    ).toEqual([])
  })

  it('has the line of each of the four refused-address codes, and of the two new write codes', () => {
    // M6 01 修补 4: `refused` on a builtin's or an instance's entry; `official-host-only` and
    // `subscription-endpoint` from provider.configure (§点名 (a), (e)).
    const refusals = providerRefusalSchema.shape.code.options
    expect(refusals).toHaveLength(4)
    const writes = providerWriteErrorCodeSchema.options
    expect(writes).toContain('official-host-only')
    expect(writes).toContain('subscription-endpoint')
    expect(
      problems([
        ...refusals.map((code) => ({ key: REFUSAL_KEY[code], args: [], what: `refused ${code}` })),
        ...writes.map((code) => ({
          key: PROVIDER_WRITE_ERROR_KEY[code],
          args: [],
          what: `provider write ${code}`,
        })),
      ]),
    ).toEqual([])
  })

  it('has the removed-instance lines, the two key reminders and the sentences with slots', () => {
    const reminders = covers<KeyReminder>()(['zhipu', 'minimax'], true)
    expect(
      problems([
        { key: 'error.customVendorGone', args: [], what: '§实例被删或改坏, the failure card' },
        { key: 'model.trigger.removed', args: ['model'], what: '§实例被删或改坏, the trigger' },
        ...reminders.map((reminder) => ({
          key: KEY_REMINDER_KEY[reminder],
          args: [],
          what: `Q13 reminder ${reminder}`,
        })),
        {
          key: 'customVendor.models.limits',
          args: ['contextTokens', 'outputTokens'],
          what: 'a row’s limits',
        },
        { key: 'customVendor.instance.summary', args: ['address', 'wire'], what: 'card header' },
        { key: 'customVendor.instance.fromPreset', args: ['preset'], what: 'preset address' },
        { key: 'customVendor.section.noSearch', args: [], what: 'Q10' },
        { key: 'customVendor.probe.cost', args: [], what: 'T4' },
      ]),
    ).toEqual([])
  })
})

describe('the gate itself', () => {
  it('reports a missing entry, an empty one and one with the wrong arguments', () => {
    // Without this, a `problems` that always answered `[]` would pass every test above.
    expect(
      problems([{ key: 'confirm.reason.no-such-reason', args: [], what: 'probe' }]),
    ).toHaveLength(2)
    expect(
      problems([{ key: 'confirm.reason.network', args: ['host'], what: 'probe' }]),
    ).toHaveLength(2)
    expect(problems([{ key: 'confirm.reason', args: [], what: 'probe' }])).toHaveLength(2)
    expect(
      argumentsOf('{a} {n, plural, one {# {b}} other {{c}}} {s, select, x {{d}} other {}}'),
    ).toEqual(['a', 'b', 'c', 'd', 'n', 's'])
  })
})

it('03 验收 46: every MCP enum has zh-CN and en copy, including secret-too-long', () => {
  const values = [
    ...covers<McpServerView['toolViews'][number]['review']>()(['ok', 'changed', 'new'], true),
    ...covers<NonNullable<McpServerView['toolViews'][number]['unavailable']>>()(
      ['name-collision', 'invalid-definition'],
      true,
    ),
    ...covers<NonNullable<McpServerView['status']['stopReason']>>()(
      ['needs-consent', 'crash-limit'],
      true,
    ),
    ...covers<NonNullable<McpServerView['status']['era']>>()(['modern', 'legacy'], true),
    ...covers<McpServerView['transport']['type']>()(['stdio', 'http'], true),
    ...covers<McpServerView['source']>()(['manual'], true),
    ...toolSettingSchema.options,
    ...covers<McpWarning['kind']>()(
      ['sudo', 'rm-rf', 'home-path', 'ssh-path', 'unpinned-package', 'risky-env'],
      true,
    ),
    ...covers<Extract<McpServerView['transport'], { type: 'http' }>['protocol']>()(
      ['auto', 'legacy'],
      true,
    ),
    ...covers<NonNullable<RouteRequest<typeof mcpSave>['consent']>>()(['run', 'persistent'], true),
    ...covers<
      Exclude<
        ToolExclusionCode,
        'policy' | 'user-disabled' | 'connector-unauthorized' | 'over-limit' | 'no-search-backend'
      >
    >()(
      ['name-collision', 'invalid-definition', 'definition-changed', 'connector-unavailable'],
      true,
    ),
    'connector-unauthorized',
  ]
  expect(
    problems([
      ...[
        ...mcpErrorCodeSchema.options,
        ...mcpWriteErrorCodeSchema.options,
        ...mcpLoginErrorSchema.options,
      ].map((code) => ({ key: `mcp.error.${code}`, args: [], what: code })),
      ...mcpPhaseSchema.options.map((code) => ({ key: `mcp.phase.${code}`, args: [], what: code })),
      ...values.map((code) => ({ key: `mcp.value.${code}`, args: [], what: code })),
      ...reversibilitySchema.options.map((code) => ({
        key: `mcp.reversibility.${code}`,
        args: [],
        what: code,
      })),
      ...(['sudo', 'rm-rf', 'home-path', 'ssh-path', 'unpinned-package', 'risky-env'] as const).map(
        (code) => ({
          key: `mcp.warning.${code}`,
          args:
            code === 'home-path' || code === 'ssh-path'
              ? ['arg']
              : code === 'unpinned-package'
                ? ['package']
                : code === 'risky-env'
                  ? ['name']
                  : [],
          what: code,
        }),
      ),
    ]),
  ).toEqual([])
})
