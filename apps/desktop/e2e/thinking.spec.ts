import { deferred, messageBodies, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import { providerEnv, send } from './helpers/tools.js'

/**
 * Thinking and discarded attempts in the real shell (spec 02 §思考的默认与显示 `ThinkingBlock`,
 * §重试与「继续」; plan step 20: 旧 226 ThinkingBlock, `attempt-discarded`).
 */
let fake: FakeAnthropic | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
})

/** Four thinking deltas this far apart: the block streams for three gaps, 2.1 s, which rounds to 2. */
const THINKING_GAP_MS = 700

const CASES = {
  'zh-CN': {
    chunks: ['首先读', '题。然后', '简短地', '回答。'],
    first: '首先读题。',
    took: '思考了 2 秒',
    label: '思考',
  },
  en: {
    chunks: ['First, read ', 'the question. ', 'Then answer ', 'it briefly.'],
    first: 'First, read the question.',
    took: 'Thought for 2s',
    label: 'Thinking',
  },
} as const

for (const locale of ['zh-CN', 'en'] as const) {
  test(`a thinking block shows its first sentence and how long it streamed, and no timing once replayed (旧 226, ${locale})`, async () => {
    const copy = CASES[locale]
    const full = copy.chunks.join('')
    const hold = deferred()
    fake = await startFakeAnthropic({
      replies: [
        {
          steps: [
            { type: 'thinking', thinking: copy.chunks, signature: 'sig-e2e-thinking' },
            { type: 'wait', until: hold.promise },
            { type: 'text', text: ['The ', 'answer.'] },
          ],
          delayMs: THINKING_GAP_MS,
        },
      ],
    })
    const server = fake
    const userData = makeUserDataDir(`thinking-${locale}`)
    seedConfig(userData, { locale })

    const first = await launchTenon({ userData, env: providerEnv(server.baseURL) })
    try {
      const { page } = first
      await send(page, 'a question')
      const block = page.getByTestId('thinking-block')
      const toggle = block.getByTestId('thinking-toggle')
      // Still streaming (the reply is held after its thinking): collapsed, the time it took and the
      // first sentence, as this locale splits sentences.
      await expect(block.getByTestId('thinking-first')).toHaveText(copy.first)
      await expect(toggle).toHaveText(`${copy.took}${copy.first}`)
      await expect(page.getByTestId('assistant-text')).toHaveCount(0)
      // Expanded: the whole text the vendor returned, in place of the first sentence.
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(block.getByTestId('thinking-text')).toHaveText(full)
      await expect(block.getByTestId('thinking-first')).toHaveCount(0)
      await toggle.click()
      await expect(block.getByTestId('thinking-text')).toHaveCount(0)

      hold.resolve()
      await expect(page.getByTestId('assistant-text')).toHaveText('The answer.')
      await expect(toggle).toHaveText(`${copy.took}${copy.first}`)
    } finally {
      await first.app.close()
    }

    const second = await launchTenon({ userData, env: providerEnv(server.baseURL) })
    try {
      const { page } = second
      // Replayed from the Tape, which records no start or end: the label, no time.
      const block = page.getByTestId('thinking-block')
      await expect(block).toHaveCount(1)
      await expect(block.getByTestId('thinking-toggle')).toHaveText(`${copy.label}${copy.first}`)
      await block.getByTestId('thinking-toggle').click()
      await expect(block.getByTestId('thinking-text')).toHaveText(full)
      await expect(page.getByTestId('assistant-text')).toHaveText('The answer.')
    } finally {
      await second.app.close()
    }
  })
}

test('each thinking block of a reply shows its own time, and a block of one delta took at least 1 s (§思考的默认与显示)', async () => {
  fake = await startFakeAnthropic({
    replies: [
      {
        steps: [
          { type: 'thinking', thinking: ['Quick look.'], signature: 'sig-one' },
          { type: 'text', text: 'Then ' },
          {
            type: 'thinking',
            thinking: ['A longer ', 'think. ', 'Still ', 'going.'],
            signature: 'sig-two',
          },
          { type: 'text', text: 'done.' },
        ],
        delayMs: THINKING_GAP_MS,
      },
    ],
  })
  const server = fake
  const userData = makeUserDataDir('thinking-two')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await send(page, 'a question')
    // Text, thinking, text: two text parts around the second block.
    await expect(page.getByTestId('assistant-text')).toHaveText(['Then', 'done.'])
    const toggles = page.getByTestId('thinking-toggle')
    await expect(toggles).toHaveCount(2)
    // One delta: it started and ended at once, and still reads as a second, never 0 s.
    await expect(toggles.nth(0)).toHaveText('Thought for 1sQuick look.')
    // The second block's own three gaps (2.1 s), not the first block's time.
    await expect(toggles.nth(1)).toHaveText('Thought for 2sA longer think.')
  } finally {
    await app.close()
  }
})

test('a discarded attempt takes back the text and thinking it streamed, and the next one starts empty (attempt-discarded)', async () => {
  const beforeCut = deferred()
  const beforeResend = deferred()
  fake = await startFakeAnthropic({
    replies: [
      {
        steps: [
          { type: 'thinking', thinking: ['Planning a ', 'long answer.'], signature: 'sig-cut' },
          { type: 'text', text: ['Half of ', 'an answer'] },
          { type: 'wait', until: beforeCut.promise },
          // The connection drops with no terminal frame: a retryable network failure.
          { type: 'cut' },
        ],
        delayMs: 10,
      },
      {
        steps: [
          { type: 'wait', until: beforeResend.promise },
          { type: 'text', text: ['Fresh ', 'start.'] },
        ],
        delayMs: 10,
      },
    ],
  })
  const server = fake
  const userData = makeUserDataDir('discarded')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await send(page, 'go')
    const assistant = page.getByTestId('assistant-message')
    await expect(assistant.getByTestId('assistant-text')).toHaveText('Half of an answer')
    await expect(assistant.getByTestId('thinking-block')).toHaveCount(1)

    beforeCut.resolve()
    // Discarded: what that attempt streamed goes, the thinking with it.
    await expect(assistant).toHaveCount(0)
    await expect(page.getByTestId('thinking-block')).toHaveCount(0)
    await expect(page.getByTestId('user-message')).toHaveCount(1)
    // The resend is on the wire before anything of it is shown.
    await expect.poll(() => server.requests.length).toBe(2)
    await expect(assistant).toHaveCount(0)

    beforeResend.resolve()
    await expect(assistant.getByTestId('assistant-text')).toHaveText('Fresh start.')
    await expect(assistant).toHaveCount(1)
    await expect(page.getByTestId('thinking-block')).toHaveCount(0)
    await expect(page.getByTestId('failure-card')).toHaveCount(0)
    expect(server.cuts).toBe(1)
    // The same turn again, not a continuation of the cut one: nothing of the discarded attempt went
    // back to the model.
    const [cutBody, resentBody] = messageBodies(server)
    expect(resentBody?.messages).toEqual(cutBody?.messages)
    expect(JSON.stringify(resentBody)).not.toContain('Half of')
  } finally {
    await app.close()
  }
})
