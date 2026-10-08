import { reversibilityScale } from '../src/renderer/src/lib/reversibility-scale.js'
/**
 * What the minimal approval card shows and how its keys answer (spec 02 §最小审批卡 ②, ⑤, ⑥ and
 * 「按键」; plan step 22: 旧 215's change, 旧 216's key table, and the Everything fixture tool's card,
 * which the desktop cannot draw in the real shell because it registers no MCP source). ApprovalCard.tsx
 * lays these out; the e2e (approval-write.spec.ts) drives the built-in cards through the real shell.
 */
import type { ConfirmRequestInput } from '@tenon-app/contracts'
import type { i18n as I18n } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import { createI18n } from '../src/i18n/create-instance.js'
import {
  connectorCardName,
  definitionNotice,
  changeView,
  defaultButton,
  keyAnswer,
  keyHints,
  objectParts,
} from '../src/renderer/src/lib/approval-card.js'
import { scopeKey } from '../src/renderer/src/lib/approval-keys.js'

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

  it('focus coming in lands on 「拒绝」, which carries ⏎ and Esc; 「允许」 carries no hint', () => {
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

it('03 验收 45: scale marks current value; connector shows server name and changed-definition notice', () => {
  for (const current of [
    'read-only',
    'revertible',
    'snapshotted',
    'irreversible',
    'unknown',
  ] as const) {
    const cells = reversibilityScale(current)
    expect(cells).toHaveLength(5)
    expect(cells.filter((c) => c.current).map((c) => c.value)).toEqual([current])
  }
  expect(
    connectorCardName(EVERYTHING.target, [{ id: 'everything', displayName: 'Everything server' }]),
  ).toBe('Everything server')
  expect(connectorCardName(EVERYTHING.target, [])).toBe('everything')
  expect(connectorCardName(WRITE.target, [])).toBeNull()
  expect(definitionNotice(true)).toBe('mcp.definitionNotice')
  expect(definitionNotice(undefined)).toBeNull()
  expect(zh.t(definitionNotice(true)!)).toBe('这个工具的定义在会话中变了，总是允许这次不生效')
})
