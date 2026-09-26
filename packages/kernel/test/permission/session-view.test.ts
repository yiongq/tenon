/**
 * The session view an inspector judges with (spec 02 §挂点与会话视图, §外带检查; plan step 12): read
 * from the Tape by SOURCE — which messages a person wrote, which calls were dispatched — never by
 * scanning content. The facts here are built by hand in the shapes §载荷 gives them.
 */
import { describe, expect, it } from 'vitest'
import { absolutePath } from '../../src/index.js'
import type { TapeEntry } from '../../src/index.js'
import {
  RECENT_USER_TEXTS,
  buildSessionView,
  comparableUrl,
  urlsInText,
} from '../../src/permission/session-view.js'
import type { InspectedCall } from '../../src/permission/session-view.js'

const SPILL = absolutePath('/profile/tool-output/s1')
let nextId = 1

function entry(
  name: string,
  payload: Record<string, unknown>,
  identity: { sourceId?: string; sourceSeq?: number; key?: string } = {},
): TapeEntry {
  const entryId = nextId++
  return {
    entryId,
    name,
    payload,
    sourceId: identity.sourceId ?? null,
    sourceSeq: identity.sourceSeq ?? null,
    provenanceKey: identity.key ?? `key-${String(entryId)}`,
  } as unknown as TapeEntry
}

function user(text: string, messageId = `m${String(nextId)}`): TapeEntry {
  return entry('message/user', {
    messageId,
    revision: 0,
    role: 'user',
    content: [{ type: 'text', text }],
    status: 'complete',
  })
}

/** One dispatched call: its tool/call, its decision and its dispatch, under one (runId, 1, ordinal). */
function dispatched(
  name: string,
  input: Record<string, unknown>,
  reversibility: string,
  ordinal = 0,
): TapeEntry[] {
  const runId = `run-${String(nextId++)}`
  const decisionKey = `tool:v1:decision:${runId}:1:${String(ordinal)}`
  return [
    entry(
      'tool/call',
      { ordinal, providerToolCallId: 'c', messageId: 'a', name, input, argsHash: 'h' },
      { sourceId: runId, sourceSeq: 1 },
    ),
    entry(
      'tool/permission_decided',
      { ordinal, reversibility },
      { sourceId: runId, sourceSeq: 1, key: decisionKey },
    ),
    entry(
      'execution/dispatch_committed',
      { ordinal, providerToolCallId: 'c', name, argsHash: 'h', decisionKey },
      { sourceId: runId, sourceSeq: 1 },
    ),
  ]
}

function call(name: string, args: Record<string, unknown> = {}): InspectedCall {
  return {
    tool: { name, source: 'builtin', serverId: 'builtin', originalName: name },
    args,
    reversibility: 'unknown',
  }
}

describe('buildSessionView', () => {
  it('keeps the first human message and the latest eight, and leaves the notes out', () => {
    const messages = Array.from({ length: 10 }, (_, i) => user(`question ${String(i)}`))
    const entries = [
      ...messages,
      entry('message/continuation', {
        messageId: 'c',
        revision: 0,
        role: 'user',
        content: [{ type: 'text', text: 'continue' }],
      }),
      entry('message/environment', {
        messageId: 'e',
        revision: 0,
        role: 'user',
        content: [{ type: 'text', text: '<environment>' }],
      }),
    ]
    const view = buildSessionView(entries, {
      call: call('Read'),
      profile: 'cowork',
      ownSpillDir: SPILL,
    })
    expect(view.firstUserText).toBe('question 0')
    expect(RECENT_USER_TEXTS).toBe(8)
    expect(view.recentUserTexts).toEqual(
      Array.from({ length: 8 }, (_, i) => `question ${String(i + 2)}`),
    )
    // A sub-agent's first message is the parent model's prompt, not a person's.
    const child = buildSessionView(entries, {
      call: call('Read'),
      profile: 'cowork',
      ownSpillDir: SPILL,
      child: true,
    })
    expect(child.firstUserText).toBe('')
    expect(child.recentUserTexts).toEqual([])
  })

  it('counts dispatched calls only, by what the decision said about reversibility', () => {
    const entries = [
      ...dispatched('Write', { file_path: '/ws/a' }, 'unknown'),
      ...dispatched('Read', { file_path: '/ws/b' }, 'read-only'),
      // Decided but never dispatched: not counted.
      entry(
        'tool/call',
        { ordinal: 0, name: 'Bash', input: { command: 'rm x' } },
        { sourceId: 'r9', sourceSeq: 1 },
      ),
    ]
    const view = buildSessionView(entries, {
      call: call('Read'),
      profile: 'cowork',
      ownSpillDir: SPILL,
    })
    expect(view.nonReadOnlyCalls).toEqual([{ toolName: 'Write', reversibility: 'unknown' }])
  })

  it('marks private data by Read and Grep outside the spill directory, or any Bash; never in chat (F5, H1)', () => {
    const spillRead = dispatched(
      'Read',
      { file_path: '/profile/tool-output/s1/out.txt' },
      'read-only',
    )
    const glob = dispatched('Glob', { pattern: '**' }, 'read-only')
    expect(
      buildSessionView([...spillRead, ...glob], {
        call: call('WebFetch'),
        profile: 'cowork',
        ownSpillDir: SPILL,
      }).touchedPrivateData,
    ).toBe(false)
    const workspaceRead = dispatched('Read', { file_path: '/ws/secret.env' }, 'read-only')
    expect(
      buildSessionView(workspaceRead, {
        call: call('WebFetch'),
        profile: 'cowork',
        ownSpillDir: SPILL,
      }).touchedPrivateData,
    ).toBe(true)
    const grep = dispatched('Grep', { pattern: 'key' }, 'read-only')
    expect(
      buildSessionView(grep, { call: call('WebFetch'), profile: 'cowork', ownSpillDir: SPILL })
        .touchedPrivateData,
    ).toBe(true)
    const bash = dispatched('Bash', { command: 'ls' }, 'unknown')
    expect(
      buildSessionView(bash, { call: call('WebFetch'), profile: 'cowork', ownSpillDir: SPILL })
        .touchedPrivateData,
    ).toBe(true)
    expect(
      buildSessionView(workspaceRead, {
        call: call('WebFetch'),
        profile: 'chat',
        ownSpillDir: SPILL,
      }).touchedPrivateData,
    ).toBe(false)
  })

  it('lists untrusted sources by the tools that produced them, once each', () => {
    const entries = [
      ...dispatched('WebSearch', { query: 'q' }, 'unknown'),
      ...dispatched('WebSearch', { query: 'r' }, 'unknown'),
      ...dispatched('WebFetch', { url: 'https://a.test' }, 'unknown'),
    ]
    expect(
      buildSessionView(entries, { call: call('Read'), profile: 'cowork', ownSpillDir: SPILL })
        .untrustedSources,
    ).toEqual(['WebSearch', 'WebFetch'])
  })

  it('vouches for a URL a person wrote or a search returned, only on a WebFetch', () => {
    const entries = [
      user('please read [the docs](https://docs.example.com/guide#part).'),
      entry('tool/result', {
        ordinal: 0,
        isError: false,
        searchHitUrls: ['https://news.example.org/story'],
      }),
    ]
    const vouched = (url: string): boolean | undefined =>
      buildSessionView(entries, {
        call: call('WebFetch', { url }),
        profile: 'cowork',
        ownSpillDir: SPILL,
      }).fetchUrlVouched
    expect(vouched('https://docs.example.com/guide')).toBe(true)
    expect(vouched('https://news.example.org/story#top')).toBe(true)
    expect(vouched('https://evil.example.com/?q=secret')).toBe(false)
    expect(
      buildSessionView(entries, { call: call('Read'), profile: 'cowork', ownSpillDir: SPILL }),
    ).not.toHaveProperty('fetchUrlVouched')
  })
})

describe('URLs in a message (§外带检查「豁免」)', () => {
  it('takes http(s) fragments up to the stop characters and strips trailing punctuation', () => {
    expect(urlsInText('see https://a.test/x, and HTTP://B.test/y).')).toEqual([
      'https://a.test/x',
      'HTTP://B.test/y',
    ])
    expect(urlsInText('链接：https://c.test/中文路径。然后')).toEqual(['https://c.test/中文路径'])
    expect(urlsInText('`https://d.test/code` and <https://e.test/angle>')).toEqual([
      'https://d.test/code',
      'https://e.test/angle',
    ])
    expect(urlsInText('example.com/x has no scheme')).toEqual([])
  })

  it('compares parsed hrefs without the fragment', () => {
    expect(comparableUrl('https://A.test/p#frag')).toBe('https://a.test/p')
    expect(comparableUrl('not a url')).toBeNull()
  })
})
