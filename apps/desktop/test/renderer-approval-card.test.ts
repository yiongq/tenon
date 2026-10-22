/**
 * What the minimal approval card shows and how its keys answer (spec 02 §最小审批卡 ②, ⑤, ⑥ and
 * 「按键」; plan step 22: 旧 215's change, 旧 216's key table, and the Everything fixture tool's card,
 * which the desktop cannot draw in the real shell because it registers no MCP source). ApprovalCard.tsx
 * lays these out; the e2e (approval-write.spec.ts) drives the built-in cards through the real shell.
 */
import type { ConfirmRequestInput } from '@tenon-app/contracts'
import type { i18n as I18n } from 'i18next'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { confirmReasonSchema, confirmKindSchema, reversibilitySchema } from '@tenon-app/contracts'
import { resources } from '../src/i18n/resources.js'
import type { EnResources } from '../src/i18n/resources.js'
import type { PendingCard } from '../src/renderer/src/runtime/session-store.js'
import { createI18n } from '../src/i18n/create-instance.js'
import {
  connectorCardName,
  definitionNotice,
  changeView,
  defaultButton,
  keyAnswer,
  keyHints,
  objectParts,
  whyKey,
  undoKey,
} from '../src/renderer/src/lib/approval-card.js'
import { scopeKey } from '../src/renderer/src/lib/approval-keys.js'
import { absolutePath, createMemoryHost, createMemoryTapeStore } from '@tenon-app/kernel'
import type { ModelInfo } from '@tenon-app/kernel'
import {
  createCounterIds,
  createScriptedProvider,
  createTestLoopPorts,
  createTestSessionService,
  scriptedTurn,
  stopEvent,
} from '@tenon-app/kernel/testing'

// Only the connector catalogue is a live external store; all card markup and translations are real.
vi.mock('../src/renderer/src/runtime/mcp-store', () => ({ useMcp: () => ({ servers: [] }) }))

type SentenceCard = Pick<
  ConfirmRequestInput,
  'kind' | 'reason' | 'facts' | 'target' | 'reversibility'
>

function pending(card: SentenceCard): PendingCard {
  return {
    waitKind: 'approval',
    card: { ...card, requestId: 'approval-1', sessionId: 'session-1' },
    allowScope: 'session',
    callKey: 'call-1',
    anchorCallKey: 'call-1',
  }
}

// As in renderer-connectors: load TSX through Vite, outside the Node-only typecheck project.
const componentPath = '../src/renderer/src/components/thread/ApprovalCard.tsx'
async function render(card: SentenceCard, i18n = zh, value = pending(card)): Promise<string> {
  const { ApprovalCard } = await import(componentPath)
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ApprovalCard, {
        pending: value,
        since: 0,
        toolName: 'Write',
        input: {},
        onRespond: () => {},
      }),
    ),
  )
}

function content(
  markup: string,
  id: string,
  tag = 'p',
): { text: string; attributes: string } | null {
  const match = new RegExp(`<${tag}([^>]*data-testid="${id}"[^>]*)>([\\s\\S]*?)</${tag}>`).exec(
    markup,
  )
  return match
    ? {
        attributes: match[1] ?? '',
        text: (match[2] ?? '')
          .replace(/<[^>]*>/g, '')
          .replaceAll('&#x27;', "'")
          .replaceAll('&amp;', '&'),
      }
    : null
}

const TARGET_BY_KIND = {
  file: { type: 'path', path: '/unique-folder/unique-file.txt' },
  command: { type: 'command', command: 'unique-command --arg', cwd: '/unique-cwd' },
  tool: { type: 'tool', serverId: 'unique-connector', toolName: 'unique-action' },
  network: { type: 'url', url: 'https://аpple.com/unique-path' },
} as const

const BASE: SentenceCard = {
  kind: 'file',
  reversibility: 'unknown',
  target: TARGET_BY_KIND.file,
  reason: 'default',
  facts: {},
}

type Card = Pick<ConfirmRequestInput, 'kind' | 'reversibility' | 'target'>

let en: I18n
let zh: I18n

beforeAll(async () => {
  en = await createI18n('en', () => {})
  zh = await createI18n('zh-CN', () => {})
})

/** A catalogue key in both languages: [en, zh-CN]. */
function both(key: string): [string, string] {
  return [en.t(key as never), zh.t(key as never)]
}

/** packages/kernel/test/support/server-everything.ts: the fixture's server id and one of its tools. */
const EVERYTHING: Card = {
  kind: 'tool',
  reversibility: 'unknown',
  target: { type: 'tool', serverId: 'everything', toolName: 'echo' },
}

const RM: Card = {
  kind: 'command',
  reversibility: 'irreversible',
  target: { type: 'command', command: 'rm notes.txt', cwd: '/ws' },
}

const WRITE: Card = {
  kind: 'file',
  reversibility: 'unknown',
  target: { type: 'path', path: '/ws/notes.txt' },
}

describe('the Everything fixture tool’s card (旧 216 last sentence; H3 ownerNote, open question 15)', () => {
  it('⏎ allows from the card and from 「允许」, Esc denies; ⏎ on another button is that button’s', () => {
    expect(keyAnswer(EVERYTHING, 'Enter', 'card')).toBe('allow')
    expect(keyAnswer(EVERYTHING, 'Enter', 'allow')).toBe('allow')
    expect(keyAnswer(EVERYTHING, 'Enter', 'other')).toBeNull()
    for (const from of ['card', 'allow', 'other'] as const) {
      expect(keyAnswer(EVERYTHING, 'Escape', from)).toBe('deny')
      expect(keyAnswer(EVERYTHING, ' ', from)).toBeNull()
    }
  })

  it('focus coming in lands on 「允许」, which carries the ⏎ hint; 「拒绝」 carries Esc', () => {
    expect(defaultButton(EVERYTHING)).toBe('allow')
    const hints = keyHints(EVERYTHING)
    expect(hints.allow.map((key) => both(key))).toEqual([['⏎', '⏎']])
    expect(hints.deny.map((key) => both(key))).toEqual([['Esc', 'Esc']])
  })

  it('its scope reads 「只这一次 / Just this once」: a connector call is allowed once', () => {
    expect(both(scopeKey('once', EVERYTHING.target.type, false))).toEqual([
      'Just this once',
      '只这一次',
    ])
  })

  it('the object line is the connector ID and the tool’s own name, two parts, never joined', () => {
    const named: Card = {
      ...EVERYTHING,
      target: { type: 'tool', serverId: 'everything', toolName: 'get · tiny image' },
    }
    expect(objectParts(en.t, named.target)).toEqual([
      { text: 'everything', role: 'value' },
      { text: 'get · tiny image', role: 'value' },
    ])
  })

  it('its arguments are open from the start, as the JSON it sends, escaped (②′)', () => {
    const view = changeView(EVERYTHING, 'echo', { message: 'hi‮there' })
    expect(view).toEqual({
      kind: 'arguments',
      expanded: true,
      sections: [{ label: null, text: '{⏎\n  "message": "hi\\u{202E}there"⏎\n}' }],
      note: null,
    })
  })
})

describe('an irreversible card: a Bash that deletes a file (旧 216; D10, H3)', () => {
  it('⏎ denies wherever the focus is, 「允许」 included; Space is left to the button it is on', () => {
    for (const from of ['card', 'allow', 'other'] as const) {
      expect(keyAnswer(RM, 'Enter', from)).toBe('deny')
      expect(keyAnswer(RM, 'Escape', from)).toBe('deny')
      expect(keyAnswer(RM, ' ', from)).toBeNull()
    }
  })

  it('presentation-r1 不变量 1: focus coming in lands on 「拒绝」, which carries ⏎ and Esc; 「允许」 carries no hint', () => {
    expect(defaultButton(RM)).toBe('deny')
    const hints = keyHints(RM)
    expect(hints.deny.map((key) => both(key))).toEqual([
      ['⏎', '⏎'],
      ['Esc', 'Esc'],
    ])
    expect(hints.allow).toEqual([])
  })

  it('the object line is the command, then its cwd; there is no change to show', () => {
    expect(objectParts(en.t, RM.target)).toEqual([
      { text: 'rm notes.txt', role: 'value' },
      { text: 'in /ws', role: 'note' },
    ])
    expect(objectParts(zh.t, RM.target)[1]).toEqual({ text: '位于 /ws', role: 'note' })
    expect(changeView(RM, 'Bash', { command: 'rm notes.txt' })).toBeNull()
  })
})

describe('a write’s change (§最小审批卡 ⑤; 旧 215)', () => {
  it('a Write shows its content as plain text, collapsed until asked for, escaped (②′)', () => {
    const view = changeView(WRITE, 'Write', {
      file_path: '/ws/notes.txt',
      content: '<b>one</b>\n{"k":1}‮\n',
    })
    expect(view).toEqual({
      kind: 'change',
      expanded: false,
      sections: [{ label: null, text: '<b>one</b>⏎\n{"k":1}\\u{202E}⏎\n' }],
      note: null,
    })
  })

  it('an Edit shows old_string and new_string under their labels, in both languages', () => {
    const view = changeView(WRITE, 'Edit', {
      file_path: '/ws/notes.txt',
      old_string: 'alpha\n',
      new_string: 'beta',
    })
    expect(view?.expanded).toBe(false)
    expect(view?.note).toBeNull()
    expect(view?.sections.map((section) => section.text)).toEqual(['alpha⏎\n', 'beta'])
    expect(view?.sections.map((section) => both(section.label ?? ''))).toEqual([
      ['Replace', '把这段'],
      ['With', '改成'],
    ])
  })

  it('an Edit with replace_all says every occurrence is replaced', () => {
    const view = changeView(WRITE, 'Edit', {
      file_path: '/ws/notes.txt',
      old_string: 'a',
      new_string: 'b',
      replace_all: true,
    })
    expect(both(view?.note ?? '')).toEqual([
      'Every occurrence is replaced.',
      '所有出现的地方都会替换。',
    ])
  })

  it('a write outside the workspace shows its change too; a read shows none', () => {
    expect(changeView(WRITE, 'Write', { content: 'x' })?.sections).toEqual([
      { label: null, text: 'x' },
    ])
    const read: Card = { ...WRITE, reversibility: 'read-only' }
    expect(changeView(read, 'Read', { file_path: '/ws/notes.txt' })).toBeNull()
  })

  it('a write card’s keys are the ordinary ones: ⏎ allows, focus lands on 「允许」', () => {
    expect(keyAnswer(WRITE, 'Enter', 'allow')).toBe('allow')
    expect(defaultButton(WRITE)).toBe('allow')
  })

  it('its object line is the path, what a font does not draw written as an escape (②′, 旧 218)', () => {
    const target = { type: 'path', path: '/ws/report‮txt.exe' } as const
    expect(objectParts(en.t, target)).toEqual([
      { text: '/ws/report\\u{202E}txt.exe', role: 'value' },
    ])
  })
})

describe('a network card’s object line (§最小审批卡 ②; acceptance 36)', () => {
  it('a search is the query, then the backend’s host under it, both escaped (②′)', () => {
    const target = {
      type: 'search',
      query: 'tenon‮ release',
      host: 'open.bigmodel\u{200B}.cn',
    } as const
    expect(objectParts(en.t, target)).toEqual([
      { text: 'tenon\\u{202E} release', role: 'value' },
      { text: 'open.bigmodel\\u{200B}.cn', role: 'host' },
    ])
  })

  it('a fetch is the full URL — path, query and fragment — never the host alone, escaped (②′)', () => {
    // The model's own string, as it typed it: a bidi control in the path is drawn as its escape.
    const target = { type: 'url', url: 'https://example.com/a/b\u{202E}gpj.exe?q=1#x' } as const
    expect(objectParts(en.t, target)).toEqual([
      { text: 'https://example.com/a/b\\u{202E}gpj.exe?q=1#x', role: 'value' },
    ])
  })
})

it('03 验收 45: connector shows server name and changed-definition notice (scale replaced by presentation-r1)', () => {
  expect(
    connectorCardName(EVERYTHING.target, [{ id: 'everything', displayName: 'Everything server' }]),
  ).toBe('Everything server')
  expect(connectorCardName(EVERYTHING.target, [])).toBe('everything')
  expect(connectorCardName(WRITE.target, [])).toBeNull()
  expect(definitionNotice(true)).toBe('mcp.definitionNotice')
  expect(definitionNotice(undefined)).toBeNull()
  expect(zh.t(definitionNotice(true)!)).toBe('这个工具的定义在会话中变了，总是允许这次不生效')
})

it('presentation-r1 验收 1 / presentation-r1 不变量 3: no scale; why and undo follow the tables for every reason, kind and reversibility', async () => {
  for (const reason of confirmReasonSchema.options) {
    for (const kind of confirmKindSchema.options) {
      const targets =
        kind === 'network'
          ? [
              TARGET_BY_KIND.network,
              { type: 'search', query: 'unique-query', host: 'search.example' } as const,
            ]
          : [TARGET_BY_KIND[kind]]
      for (const target of targets) {
        for (const category of ['exfiltration', 'inspector-failed']) {
          for (const reversibility of reversibilitySchema.options) {
            const card = {
              reason,
              kind,
              target,
              reversibility,
              facts: { category, host: 'xn--pple-43d.com', command: 'unique-command' },
            }
            const expectedWhy = ['default', 'command', 'irreversible'].includes(reason)
              ? null
              : reason === 'network'
                ? `confirm.reason.network.${target.type === 'search' ? 'search' : 'url'}`
                : reason === 'flagged'
                  ? `confirm.reason.flagged.${category}`
                  : `confirm.reason.${reason}`
            const expectedUndo =
              reversibility === 'irreversible'
                ? 'confirm.irreversible'
                : kind === 'network'
                  ? reason === 'network' || (reason === 'flagged' && category === 'exfiltration')
                    ? null
                    : `confirm.undo.network.${target.type === 'search' ? 'search' : 'url'}`
                  : reversibility === 'unknown' && target.type === 'path'
                    ? 'confirm.undo.unknownFile'
                    : `confirm.undo.${reversibility}`
            expect(whyKey(card)).toBe(expectedWhy)
            expect(undoKey(card)).toBe(expectedUndo)
            // oxlint-disable-next-line no-await-in-loop -- independently verify each table row's rendered card
            const html = await render(card)
            expect(html).not.toContain('reversibility-scale')
            const why = content(html, 'approval-reason')
            expect(/data-copy-key="([^"]+)"/.exec(why?.attributes ?? '')?.[1] ?? null).toBe(
              expectedWhy,
            )
            const undo = content(
              html,
              reversibility === 'irreversible' ? 'approval-irreversible' : 'approval-undo',
            )
            expect(/data-copy-key="([^"]+)"/.exec(undo?.attributes ?? '')?.[1] ?? null).toBe(
              expectedUndo,
            )
            expect(undo?.text.trim().length ?? 0).toBeGreaterThan(expectedUndo === null ? -1 : 0)
            expect(content(html, 'approval-irreversible')?.text ?? null).toBe(
              reversibility === 'irreversible' ? '撤不回。' : null,
            )
            expect(undo?.attributes.includes('text-text-danger') ?? false).toBe(
              reversibility === 'irreversible',
            )
          }
        }
      }
    }
  }
})

it('presentation-r1 验收 1: policy and inspector-failed WebFetch cards, and a policy WebSearch card, carry the online consequence', async () => {
  for (const i18n of [zh, en]) {
    const zhCN = i18n.language === 'zh-CN'
    for (const [reason, target, facts, expectedKey, text] of [
      [
        'policy',
        TARGET_BY_KIND.network,
        {},
        'confirm.undo.network.url',
        zhCN ? '网址会发给 xn--pple-43d.com。' : 'The address is sent to xn--pple-43d.com.',
      ],
      [
        'flagged',
        TARGET_BY_KIND.network,
        { category: 'inspector-failed' },
        'confirm.undo.network.url',
        zhCN ? '网址会发给 xn--pple-43d.com。' : 'The address is sent to xn--pple-43d.com.',
      ],
      [
        'policy',
        { type: 'search', query: 'a query', host: 'search.example' },
        {},
        'confirm.undo.network.search',
        zhCN ? '搜索词会发到这台电脑之外。' : 'The search words leave this computer.',
      ],
    ] as const) {
      const card: SentenceCard = {
        reason,
        target,
        facts,
        kind: 'network',
        reversibility: 'unknown',
      }
      // oxlint-disable-next-line no-await-in-loop -- inspect each distinct consequence and its own catalogue key
      const line = content(await render(card, i18n), 'approval-undo')
      expect(undoKey(card)).toBe(expectedKey)
      expect(line?.attributes).toContain(`data-copy-key="${expectedKey}"`)
      expect(line?.text).toBe(text)
    }
  }
})

it('presentation-r1 验收 1: a WebFetch card for https://аpple.com/x names xn--pple-43d.com, in ③ for a network card and in ④ for a policy card', async () => {
  const card: SentenceCard = {
    ...BASE,
    kind: 'network',
    reason: 'network',
    target: { type: 'url', url: 'https://аpple.com/x' },
    facts: { host: 'xn--pple-43d.com' },
  }
  expect(content(await render(card), 'approval-reason')?.text).toBe('网址会发给 xn--pple-43d.com。')
  expect(
    content(await render({ ...card, reason: 'policy', facts: {} }), 'approval-undo')?.text,
  ).toBe('网址会发给 xn--pple-43d.com。')
  // ③ takes only facts.host, even when it differs from the URL; ④ derives its own host.
  expect(
    content(await render({ ...card, facts: { host: 'frozen.example' } }), 'approval-reason')?.text,
  ).toBe('网址会发给 frozen.example。')
})

it('presentation-r1 验收 1: unknown says the change can’t be undone on a Write card and is conditional on a command or connector card', async () => {
  for (const i18n of [zh, en]) {
    for (const kind of ['file', 'command', 'tool'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- verify each target in both languages
      const line = content(
        // oxlint-disable-next-line no-await-in-loop -- verify each target in both languages
        await render({ ...BASE, kind, target: TARGET_BY_KIND[kind] }, i18n),
        'approval-undo',
      )
      expect(line?.text).toBe(
        i18n.language === 'zh-CN'
          ? kind === 'file'
            ? 'Tenon 没法替你撤回这次改动。'
            : '如果它改了东西，Tenon 没法替你撤回。'
          : kind === 'file'
            ? "Tenon can't undo this change for you."
            : "If this changes anything, Tenon can't undo it.",
      )
    }
  }
})

it('presentation-r1 验收 1: an irreversible card has no why line (开放问题 15 A)', async () => {
  for (const kind of confirmKindSchema.options) {
    const card = {
      ...BASE,
      reason: 'irreversible',
      kind,
      target: TARGET_BY_KIND[kind],
      reversibility: 'irreversible',
    } as const
    expect(whyKey(card)).toBeNull()
    // oxlint-disable-next-line no-await-in-loop -- the rendered card must omit ③ too
    const html = await render(card)
    expect(content(html, 'approval-reason')).toBeNull()
    expect(content(html, 'approval-irreversible')?.text).toBe('撤不回。')
  }
})

function leaves(value: unknown): string[] {
  return typeof value === 'string'
    ? [value]
    : Object.values(value as Record<string, unknown>).flatMap(leaves)
}

it('presentation-r1 验收 1: no {toolName} slot on the card; no built-in tool name in zh-CN; none of Bash, Glob, Grep, WebSearch, WebFetch, AskUserQuestion in en', () => {
  for (const locale of ['zh-CN', 'en'] as const) {
    const c = (resources[locale].common as EnResources['common']).confirm
    // Include the retained but unrendered default, command and irreversible reason keys.
    const sentences = leaves(c.reason).concat(
      leaves(c.undo),
      [c.allowScoped, c.allow, c.deny],
      leaves(c.scope),
      leaves(c.answered),
      [c.irreversible],
    )
    for (const sentence of sentences) {
      expect(sentence).not.toContain('{toolName}')
      expect(sentence).not.toMatch(
        locale === 'en'
          ? /\b(?:Bash|Glob|Grep|WebSearch|WebFetch|AskUserQuestion)\b/
          : /\b(?:Read|Write|Edit|Bash|Glob|Grep|WebSearch|WebFetch|AskUserQuestion|Agent)\b/,
      )
    }
    for (const sentence of leaves(c.reason.irreversible).concat([
      c.reason.default,
      c.reason.command,
    ])) {
      expect(sentence).not.toMatch(/\{[^}]*\}/)
    }
  }
})

it('presentation-r1 验收 2: the why line repeats no part of the object line', async () => {
  // Elevated copy belongs to 04 and explicitly repeats the command; exempt as specified.
  const targets: [SentenceCard['kind'], SentenceCard['target']][] = [
    ...(Object.entries(TARGET_BY_KIND) as [SentenceCard['kind'], SentenceCard['target']][]),
    ['network', { type: 'search', query: 'unique-query', host: 'search.example' }],
  ]
  for (const [kind, target] of targets) {
    for (const reason of confirmReasonSchema.options.filter((r) => r !== 'elevated')) {
      for (const i18n of [zh, en]) {
        const facts = {
          path: '/unique-folder/unique-file.txt',
          workspace: '/unique-folder',
          command: 'unique-command --arg',
          cwd: '/unique-cwd',
          host: 'xn--pple-43d.com',
          category: 'inspector-failed',
        }
        // oxlint-disable-next-line no-await-in-loop -- each target and non-exempt reason, in both languages
        const line = content(
          // oxlint-disable-next-line no-await-in-loop -- verify each target and non-exempt reason in both languages
          await render({ ...BASE, kind, target, reason, facts }, i18n),
          'approval-reason',
        )
        if (line === null) continue
        for (const part of objectParts(i18n.t, target)) expect(line.text).not.toContain(part.text)
        for (const value of [
          facts.path,
          facts.workspace,
          facts.command,
          facts.cwd,
          'unique-query',
          'search.example',
        ])
          expect(line.text).not.toContain(value)
      }
    }
  }
})

it('presentation-r1 验收 3 / presentation-r1 不变量 2: allow carries its scope, five scopes, the words as 02 maps them, each equal to the grant scope', async () => {
  const model: ModelInfo = {
    id: 'approval-model',
    providerId: 'anthropic',
    contextLimit: 200000,
    maxOutputTokens: 1024,
    reasoning: false,
    supportsToolCalling: true,
    supportsStreamingToolCalls: true,
    supportsVision: false,
    supportsCacheControl: false,
    thinkingPreservationFormat: 'drop',
    usageNeedsOptIn: false,
  }
  const rows = [
    { url: false, once: true, subtask: false, en: 'Just this once', zh: '只这一次' },
    { url: false, once: false, subtask: false, en: 'This session', zh: '本会话' },
    {
      url: true,
      once: false,
      subtask: false,
      en: 'This domain, this session',
      zh: '本会话里这个域名',
    },
    { url: false, once: false, subtask: true, en: 'This subtask', zh: '本次子任务' },
    {
      url: true,
      once: false,
      subtask: true,
      en: 'This domain, this subtask',
      zh: '本次子任务里这个域名',
    },
  ]
  for (const row of rows) {
    const host = createMemoryHost()
    const tape = createMemoryTapeStore({ identity: host.identity })
    const provider = createScriptedProvider({ models: [model] })
    const loop = createTestLoopPorts({ connector: { provider, model } })
    const service = createTestSessionService(
      {
        host,
        tape,
        ids: createCounterIds(),
        inspectors: [],
        connector: loop.connector,
        protectedFiles: [],
      },
      { tools: {} },
    )
    service.bindLoop(loop)
    const sessionId = '6c3f9a2e-6b3d-4a71-9f52-0c8de7a11c02'
    const dedicated = absolutePath('/dedicated')
    const work = absolutePath('/work')
    // oxlint-disable-next-line no-await-in-loop -- isolated real approval/grant for each scope label
    await host.fs.mkdirp(work)
    // oxlint-disable-next-line no-await-in-loop -- see above
    await service.selectProfile({ sessionId, profile: 'cowork', dedicated })
    // oxlint-disable-next-line no-await-in-loop -- see above
    await service.setWorkspace({ sessionId, change: { kind: 'add', folders: [work] }, dedicated })
    const name = row.url ? 'WebFetch' : 'Write'
    const input = row.url
      ? { url: 'https://example.com/x' }
      : { file_path: row.once ? '/elsewhere/a.txt' : '/work/a.txt', content: 'x' }
    provider.script([
      { type: 'tool-call-start', index: 0, id: 'call', name },
      { type: 'tool-call-end', index: 0, id: 'call', name, input },
      stopEvent('tool-use', 'tool_use'),
    ])
    // oxlint-disable-next-line no-await-in-loop -- see above
    expect((await service.send({ sessionId, origin: null, text: 'do the step' })).status).toBe(
      'started',
    )
    // oxlint-disable-next-line no-await-in-loop -- see above
    expect((await loop.runEnded()).reason).toEqual({ code: 'paused', waitingFor: 'approval' })
    // oxlint-disable-next-line no-await-in-loop -- see above
    const current = await service.currentPending({ sessionId })
    if (current?.waitKind !== 'approval') throw new Error('expected an approval')
    expect(current.allowScope).toBe(row.once ? 'once' : 'session')
    // Forwarding changes the displayed session to subtask words, never the grant's stored scope.
    const shown = { ...current, anchorCallKey: row.subtask ? 'parent-call' : current.callKey }
    for (const i18n of [zh, en]) {
      // oxlint-disable-next-line no-await-in-loop -- both locales read the exact pending scope
      const html = await render(current.card, i18n, shown)
      const label = content(html, 'approval-allow', 'button')?.text
      expect(label).toBe(i18n.language === 'zh-CN' ? `允许（${row.zh}）⏎` : `Allow (${row.en})⏎`)
      expect(html).not.toContain('data-testid="approval-scope"')
    }
    provider.script(scriptedTurn({ deltas: ['Done.'] }))
    // oxlint-disable-next-line no-await-in-loop -- answer the same approval whose scope was rendered
    expect(
      // oxlint-disable-next-line no-await-in-loop -- answer the exact card whose scope was rendered
      await service.answer({
        kind: 'approval',
        sessionId,
        requestId: current.card.requestId,
        decision: 'allow',
        origin: null,
      }),
    ).toEqual({ status: 'applied' })
    // oxlint-disable-next-line no-await-in-loop -- wait before reading the persisted grant
    await loop.runEnded()
    // oxlint-disable-next-line no-await-in-loop -- read the actual append-only answer
    const { entries } = await tape.readRange({ sessionId, limit: 1000 })
    const answer = entries.find((entry) => entry.name === 'tool/approval_resolved')
    expect(answer?.payload['grant']).toMatchObject({ scope: current.allowScope })
  }
})
