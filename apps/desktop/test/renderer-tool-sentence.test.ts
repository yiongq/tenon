/**
 * The one line a tool call shows, and the catalogue lookup for keys built from data (spec 02
 * §界面范围 `ToolRow`, §最小审批卡「排队行」, `TurnSummaryLine`; plan step 20). A sentence by tool name,
 * with the argument that says what it touches, shown as it is; a tool the catalogue does not name — a
 * connector's — gets the generic sentence with its name. Real catalogues, both locales.
 */
import type { TFunction } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'
import { createI18n } from '../src/i18n/create-instance.js'
import { toolObject, toolSentence } from '../src/renderer/src/lib/tool-sentence.js'
import { tx } from '../src/renderer/src/lib/tx.js'

const t: Record<'en' | 'zh-CN', TFunction> = {} as never
const errors: string[] = []

beforeAll(async () => {
  for (const lng of ['en', 'zh-CN'] as const) {
    // oxlint-disable-next-line no-await-in-loop -- two instances, built one after the other
    t[lng] = (await createI18n(lng, (message) => errors.push(message))).t
  }
})

/** Each catalogue tool, the argument that names what it touches, and the two sentences. */
const NAMED: ReadonlyArray<
  readonly [name: string, input: Record<string, unknown>, en: string, zh: string]
> = [
  ['Read', { file_path: '/w/notes.md', offset: 3 }, 'Read /w/notes.md', '读取 /w/notes.md'],
  ['Write', { file_path: '/w/out.txt', content: 'x' }, 'Write /w/out.txt', '写入 /w/out.txt'],
  ['Edit', { file_path: '/w/a.ts', old_string: 'a' }, 'Edit /w/a.ts', '编辑 /w/a.ts'],
  ['Bash', { command: 'ls -la', description: 'list' }, 'Run ls -la', '运行 ls -la'],
  ['Glob', { pattern: '**/*.ts' }, 'Find files matching **/*.ts', '查找匹配 **/*.ts 的文件'],
  ['Grep', { pattern: 'TODO', path: '/w' }, 'Search files for TODO', '在文件里搜索 TODO'],
  ['WebSearch', { query: 'tenon joint' }, 'Search the web for tenon joint', '联网搜索 tenon joint'],
  [
    'WebFetch',
    { url: 'https://a.example/x' },
    'Fetch https://a.example/x',
    '抓取 https://a.example/x',
  ],
  [
    'Agent',
    { description: 'survey the repo', prompt: 'p' },
    'Hand a subtask to an agent: survey the repo',
    '把子任务交给 agent：survey the repo',
  ],
  ['AskUserQuestion', { questions: [] }, 'Ask you a question', '向你提问'],
]

describe('toolSentence', () => {
  it.each(NAMED)('says what %s touches, in both locales', (name, input, en, zh) => {
    expect(toolSentence(t.en, name, input)).toBe(en)
    expect(toolSentence(t['zh-CN'], name, input)).toBe(zh)
    expect(errors).toEqual([])
  })

  it('shows an argument as it is: no JSON quoting, and ICU syntax in it is not read as a slot', () => {
    const command = `echo "a {b}" && printf '%s' it's`
    expect(toolSentence(t.en, 'Bash', { command })).toBe(`Run ${command}`)
    expect(toolSentence(t['zh-CN'], 'Bash', { command })).toBe(`运行 ${command}`)
    expect(errors).toEqual([])
  })

  it('escapes the argument as the card does (②′): a row never reads differently from its card', () => {
    // The override would flip what follows it; the tag letters would say nothing at all.
    const path = '/w/invoice\u202Etxt.exe'
    expect(toolSentence(t.en, 'Read', { file_path: path })).toBe('Read /w/invoice\\u{202E}txt.exe')
    expect(toolSentence(t['zh-CN'], 'Write', { file_path: path })).toBe(
      '写入 /w/invoice\\u{202E}txt.exe',
    )
    expect(toolSentence(t.en, 'Bash', { command: 'ls\u{E0041}\nrm x' })).toBe(
      'Run ls\\u{E0041}⏎\nrm x',
    )
    // A connector's tool name is content too.
    expect(toolSentence(t.en, 'fs__lo\u200Bok', {})).toBe('Use fs__lo\\u{200B}ok')
    expect(errors).toEqual([])
  })

  it('gives a tool the catalogue does not name the generic sentence, with its name', () => {
    expect(toolSentence(t.en, 'fs__look', { at: '/x' })).toBe('Use fs__look')
    expect(toolSentence(t['zh-CN'], 'fs__look', { at: '/x' })).toBe('使用 fs__look')
  })

  it('treats a tool named like an Object.prototype member as a connector tool', () => {
    // A connector may call its tool anything; `in` would find these on the prototype.
    for (const name of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(toolSentence(t.en, name, {})).toBe(`Use ${name}`)
    }
  })

  it('never writes undefined or an object into the sentence when the argument is missing or odd', () => {
    for (const input of [
      {},
      { file_path: 42 },
      { file_path: { nested: true } },
      { file_path: null },
    ]) {
      const sentence = toolSentence(t.en, 'Read', input)
      expect(sentence.startsWith('Read')).toBe(true)
      expect(sentence).not.toMatch(/undefined|null|\[object|42|nested/)
    }
  })
})

describe('toolObject', () => {
  it('names the path or the command a queued row stands for, else the tool', () => {
    expect(toolObject('Write', { file_path: '/w/b.txt', content: 'x' })).toBe('/w/b.txt')
    expect(toolObject('Edit', { file_path: '/w/c.txt' })).toBe('/w/c.txt')
    expect(toolObject('Bash', { command: 'rm -rf build', description: 'clean' })).toBe(
      'rm -rf build',
    )
    expect(toolObject('fs__look', { at: '/x' })).toBe('fs__look')
    expect(toolObject('AskUserQuestion', { questions: [] })).toBe('AskUserQuestion')
    expect(toolObject('Write', { file_path: 7 })).toBe('Write')
    // The raw value: the queued row escapes it where it draws it, as the card does.
    expect(toolObject('Write', { file_path: '/w/a\u202Eb' })).toBe('/w/a\u202Eb')
  })
})

describe('tx', () => {
  it('reads a key built from data, with and without slots', () => {
    expect(tx(t.en, 'confirm.scope.once')).toBe('Just this once')
    expect(tx(t['zh-CN'], 'confirm.scope.once')).toBe('只这一次')
    const facts = { toolName: 'Write', path: '/w/a.txt' }
    expect(tx(t.en, 'confirm.reason.irreversible.file', facts)).toBe(
      'Write makes a change to /w/a.txt that can’t be undone.',
    )
    expect(tx(t['zh-CN'], 'confirm.reason.irreversible.file', facts)).toBe(
      'Write 对 /w/a.txt 的改动撤不回。',
    )
    expect(errors).toEqual([])
  })

  it('renders the summary line from its three counts (TurnSummaryLine: read, changed, sent out)', () => {
    expect(tx(t.en, 'summary.line', { read: 3, write: 1, external: 0 })).toBe('Read 3 · changed 1')
    expect(tx(t.en, 'summary.line', { read: 0, write: 0, external: 2 })).toBe(
      'Read 0 · changed 0 · sent data out',
    )
    expect(tx(t['zh-CN'], 'summary.line', { read: 3, write: 1, external: 0 })).toBe(
      '读了 3 个 · 改了 1 个',
    )
    expect(tx(t['zh-CN'], 'summary.line', { read: 1, write: 0, external: 1 })).toBe(
      '读了 1 个 · 改了 0 个 · 有对外发送',
    )
    expect(errors).toEqual([])
  })
})
