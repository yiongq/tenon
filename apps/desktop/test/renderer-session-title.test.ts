/**
 * The top bar's title (lib/session-title.ts; UX diagnosis N01, N02): the first sentence of the
 * session's first user message, on one line, and nothing while the session has no message — the bar
 * used to repeat the product name over every conversation.
 */
import { describe, expect, it } from 'vitest'
import { sessionTitle } from '../src/renderer/src/lib/session-title.js'
import type { Turn } from '../src/renderer/src/runtime/thread-model.js'

function turn(role: Turn['role'], text: string, extra: Partial<Turn> = {}): Turn {
  return {
    id: `${role}-${text}`,
    role,
    parts: [{ kind: 'text', text }],
    status: 'complete',
    runId: null,
    createdAt: 0,
    ...extra,
  }
}

describe('sessionTitle', () => {
  it('is empty while the session has no message', () => {
    expect(sessionTitle([], 'en')).toBe('')
    // An assistant turn alone (a run the kernel opened) names nothing.
    expect(sessionTitle([turn('assistant', 'Hello.')], 'en')).toBe('')
  })

  it('en: the first sentence of the first user message, not the rest of it nor the reply', () => {
    const turns = [
      turn('user', 'Rename the config loader. Then update its tests.'),
      turn('assistant', 'Done. Both are renamed.'),
      turn('user', 'Now add a changelog entry.'),
    ]
    expect(sessionTitle(turns, 'en')).toBe('Rename the config loader.')
  })

  it('zh-CN: stops at 。 even with no space after it', () => {
    expect(sessionTitle([turn('user', '帮我把配置加载器改个名。然后更新测试。')], 'zh-CN')).toBe(
      '帮我把配置加载器改个名。',
    )
  })

  it('collapses runs of whitespace, and ends the sentence at a line break', () => {
    expect(sessionTitle([turn('user', 'fix   the\tlogin\u00a0bug')], 'en')).toBe(
      'fix the login bug',
    )
    // The language splits a new line like a full stop: the first line is the title.
    expect(sessionTitle([turn('user', 'Review the diff\nit touches the auth flow')], 'en')).toBe(
      'Review the diff',
    )
  })

  it('skips a turn that was only the typed answer to a question', () => {
    const turns = [
      turn('user', 'the blue one', { answering: true }),
      turn('user', 'Pick a colour.'),
    ]
    expect(sessionTitle(turns, 'en')).toBe('Pick a colour.')
    expect(sessionTitle([turns[0]!], 'en')).toBe('')
  })

  it('names the session as soon as the message is sent, before it is written', () => {
    expect(sessionTitle([turn('user', 'hello there', { optimistic: true })], 'en')).toBe(
      'hello there',
    )
  })

  it('keeps a very long sentence whole: the top bar shortens it on screen, not here', () => {
    const long = 'a'.repeat(500)
    expect(sessionTitle([turn('user', long)], 'en')).toBe(long)
    expect(sessionTitle([turn('user', '😀'.repeat(200))], 'en')).toBe('😀'.repeat(200))
  })

  it('ignores thinking and tool parts when it reads the message', () => {
    const user: Turn = {
      ...turn('user', 'ignored'),
      parts: [
        { kind: 'thinking', text: 'hmm', startedAt: null, endedAt: null },
        { kind: 'text', text: 'Summarise the report.' },
      ],
    }
    expect(sessionTitle([user], 'en')).toBe('Summarise the report.')
  })
})
