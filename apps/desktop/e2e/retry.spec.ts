import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
import { deferred, messageBodies, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FailWith, FakeAnthropic } from '../test/support/fake-anthropic.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { COUNT_ROUTES, routeCalls } from './helpers/navigation.js'
import { expect, test } from './helpers/test.js'
import {
  ANTHROPIC_ORIGIN,
  originMap,
  providerEnv,
  pushesOf,
  recordPushes,
  send,
  textReply,
} from './helpers/tools.js'

/**
 * Whose message 「重试」 sends, and where an end goes (spec 02 §失败卡与结束原因, §重试与「继续」; plan
 * step 20, the fixes after the second review): the button acts on the conversation as it stands, so
 * it goes once a later message was sent; it resends the one message the kernel named (`retryOf`),
 * which the kernel reads as that same message (01 spec.md:395); and an end that nothing was written
 * for goes under the message it answers, not under whatever the next send shows.
 */
let fake: FakeAnthropic | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
})

/** Never retried (the SDK retries 5xx and 429 only), so the Run ends on the first one. */
const BAD_REQUEST: FailWith = { status: 400, type: 'invalid_request_error', message: 'boom' }

/**
 * The thread top to bottom: each user turn by its text, each assistant turn by its text and the code
 * of the failure card under it, if any. The DOM order is what the user reads.
 */
async function threadOrder(page: Page): Promise<string[]> {
  return await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-testid="user-message"], [data-testid="assistant-message"]',
      ),
    ].map((turn) => {
      if (turn.getAttribute('data-testid') === 'user-message') {
        return `user: ${turn.querySelector('[data-testid="user-text"]')?.textContent ?? ''}`
      }
      const text = [...turn.querySelectorAll('[data-testid="assistant-text"]')]
        .map((part) => part.textContent)
        .join('')
      const card = turn.querySelector('[data-testid="failure-card"]')?.getAttribute('data-code')
      return `assistant: ${text}${card === undefined ? '' : `[${card}]`}`
    }),
  )
}

/** Every `message/user` fact on the profile's Tape, in the order written: its id and its text. */
function userMessagesOnTape(userData: string): Array<{ messageId: string; text: string }> {
  const db = new Database(join(dirname(configPathIn(userData)), 'sessions.db'), {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const rows = db
      .prepare(
        "SELECT payload_json FROM tape_entry WHERE name = 'message/user' ORDER BY created_at, entry_id",
      )
      .all() as Array<{ payload_json: string }>
    return rows.map((row) => {
      const payload = JSON.parse(row.payload_json) as {
        messageId: string
        content: Array<{ type: string; text?: string }>
      }
      const text = payload.content.map((block) => block.text ?? '').join('')
      return { messageId: payload.messageId, text }
    })
  } finally {
    db.close()
  }
}

/** How many times `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

interface ChatPush {
  readonly type: string
  readonly messageId?: string
  readonly retryOf?: string | null
  readonly endReason?: { readonly code: string }
}

test('「重试」 on an earlier failure goes once a later message is sent; the latest one resends the message its Run was opened by, as that same message (§失败卡与结束原因, §重试与「继续」)', async () => {
  const held = deferred()
  fake = await startFakeAnthropic({
    replies: [
      { failWith: BAD_REQUEST },
      // The second message's request stays in flight until the test lets it fail.
      { hold: held.promise, failWith: BAD_REQUEST },
      textReply('Answered ', 'at last.'),
    ],
  })
  const server = fake
  const userData = makeUserDataDir('retry-latest')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({
    userData,
    env: { ...providerEnv(server.baseURL), ...COUNT_ROUTES },
  })
  let second: string
  try {
    await recordPushes(app)
    await send(page, 'first question')
    const cards = page.getByTestId('failure-card')
    await expect(cards).toHaveCount(1)
    const earlier = cards.first()
    await expect(earlier).toHaveAttribute('data-code', 'provider-error')
    await expect(earlier.getByTestId('failure-action')).toHaveAttribute('data-action', 'retry')

    await send(page, 'second question')
    // At once, while that message's Run is still waiting on its answer: the earlier card resends
    // nothing any more.
    await expect(page.getByTestId('user-text')).toHaveText(['first question', 'second question'])
    await expect.poll(() => server.requests.length).toBe(2)
    await expect(page.getByTestId('composer-stop')).toBeVisible()
    await expect(earlier.getByTestId('failure-action')).toHaveCount(0)
    await expect(cards).toHaveCount(1)

    held.resolve()
    await expect(cards).toHaveCount(2)
    const latest = cards.nth(1)
    await expect(latest).toHaveAttribute('data-code', 'provider-error')
    await expect(latest.getByTestId('failure-action')).toHaveAttribute('data-action', 'retry')
    await expect(earlier.getByTestId('failure-action')).toHaveCount(0)
    expect(await threadOrder(page)).toEqual([
      'user: first question',
      'assistant: [provider-error]',
      'user: second question',
      'assistant: [provider-error]',
    ])
    // Each end names the message that opened its Run.
    const pushed = await pushesOf<ChatPush>(app, 'chat.event')
    const written = pushed.filter((event) => event.type === 'user-message')
    expect(written).toHaveLength(2)
    const [first, next] = written.map((event) => event.messageId ?? '')
    second = next ?? ''
    const ends = pushed.filter((event) => event.type === 'error')
    expect(ends.map((event) => event.retryOf)).toEqual([first, second])

    await latest.getByTestId('failure-action').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Answered at last.')
    // One bubble per message: the echo 「重试」 showed goes once the kernel names the message it
    // resent — the same one.
    await expect(page.getByTestId('user-text')).toHaveText(['first question', 'second question'])
    expect(await threadOrder(page)).toEqual([
      'user: first question',
      'assistant: [provider-error]',
      'user: second question',
      'assistant: [provider-error]',
      'assistant: Answered at last.',
    ])
    // A later end came: neither card resends anything now.
    await expect(page.getByTestId('failure-action')).toHaveCount(0)
    expect(await routeCalls(app, 'chat.send')).toBe(3)
    const resent = (await pushesOf<ChatPush>(app, 'chat.event')).filter(
      (event) => event.type === 'user-message',
    )
    expect(resent.map((event) => event.messageId)).toEqual([first, second, second])
    // The resent request carries each message once, the resent one last of the two.
    const bodies = messageBodies(server)
    expect(bodies).toHaveLength(3)
    const wire = JSON.stringify(bodies[2]?.messages)
    expect(occurrences(wire, 'first question')).toBe(1)
    expect(occurrences(wire, 'second question')).toBe(1)
    expect(wire.indexOf('first question')).toBeLessThan(wire.indexOf('second question'))
  } finally {
    await app.close()
  }
  // One `message/user` per message: the resend was the idempotent append of the same message.
  expect(userMessagesOnTape(userData)).toEqual([
    { messageId: expect.any(String), text: 'first question' },
    { messageId: second, text: 'second question' },
  ])
})

test('with no key the message stays, the 「去设置」 card comes below it, and once a key is set the next reply comes below its own message (§失败卡与结束原因, 缺 key)', async () => {
  fake = await startFakeAnthropic({ replies: [textReply('Now ', 'it works.')] })
  const server = fake
  const userData = makeUserDataDir('retry-no-key')
  seedConfig(userData, { locale: 'en' })
  // No key anywhere: not in the environment, not in the store. api.anthropic.com's requests go to
  // the fake (the origin map test seam), once there is a key to send.
  const { app, page } = await launchTenon({
    userData,
    env: originMap({ [ANTHROPIC_ORIGIN]: server.baseURL }),
  })
  try {
    await send(page, 'hello there')
    const card = page.getByTestId('failure-card')
    await expect(card).toHaveAttribute('data-code', 'provider-error')
    const action = card.getByTestId('failure-action')
    await expect(action).toHaveAttribute('data-action', 'settings')
    await expect(action).toHaveText('Open settings')
    expect(await threadOrder(page)).toEqual(['user: hello there', 'assistant: [provider-error]'])
    expect(server.requests).toHaveLength(0)

    // A second one nothing is written for: its card comes under it, not under the first, whichever
    // of the end and the route's answer the window handles first (step 20 round 4).
    await send(page, 'still nothing?')
    await expect(page.getByTestId('failure-card')).toHaveCount(2)
    expect(await threadOrder(page)).toEqual([
      'user: hello there',
      'assistant: [provider-error]',
      'user: still nothing?',
      'assistant: [provider-error]',
    ])

    await page.getByTestId('failure-action').last().click()
    await expect(page.getByTestId('provider-settings')).toBeVisible()
    await page.getByTestId('provider-select').selectOption('anthropic')
    await page.getByTestId('provider-config-apiKey').fill('e2e-typed-key')
    await page.getByTestId('provider-save').click()
    await expect(page.getByTestId('provider-settings')).toBeHidden()

    await send(page, 'and now?')
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Now it works.')
    expect(await threadOrder(page)).toEqual([
      'user: hello there',
      'assistant: [provider-error]',
      'user: still nothing?',
      'assistant: [provider-error]',
      'user: and now?',
      'assistant: Now it works.',
    ])
    // Nothing of the unsent message was written, so none of it went out with the next one.
    expect(server.requests).toHaveLength(1)
    const wire = JSON.stringify(messageBodies(server)[0]?.messages)
    expect(wire).toContain('and now?')
    expect(wire).not.toContain('hello there')
    expect(wire).not.toContain('still nothing?')
    expect(server.requests[0]?.headers['x-api-key']).toBe('e2e-typed-key')
  } finally {
    await app.close()
  }
  expect(userMessagesOnTape(userData).map((message) => message.text)).toEqual(['and now?'])
})

// A send whose `error` carries no end reason is not a Run's end (§失败卡与结束原因 ①): the phase 1
// line by its code and 「重试」, which sends the message just above it again and goes, like the failure
// card's, once a later message was sent (§重试与「继续」). Main answers every send that way when the
// conversation store could not open (tape/open.ts): nothing is written, and each send's echo stays.
test('a send the store never took shows the error line under it; 「重试」 resends that message, and goes once a later one was sent (§失败卡与结束原因 ①)', async () => {
  const userData = makeUserDataDir('retry-no-store')
  seedConfig(userData, { locale: 'en' })
  // A directory where the store's file goes: it cannot open, and main keeps running without it.
  mkdirSync(join(dirname(configPathIn(userData)), 'sessions.db'), { recursive: true })
  const { app, page } = await launchTenon({ userData, env: COUNT_ROUTES })
  try {
    await send(page, 'alpha')
    await expect(page.getByTestId('message-error')).toHaveCount(1)
    await expect(page.getByTestId('message-error-text')).toHaveText('Something went wrong.')
    await expect(page.getByTestId('message-retry')).toHaveCount(1)
    expect(await threadOrder(page)).toEqual(['user: alpha', 'assistant: '])

    await send(page, 'beta')
    await expect(page.getByTestId('message-error')).toHaveCount(2)
    // Each error under the message it answers; only the latest still offers 「重试」.
    expect(await threadOrder(page)).toEqual([
      'user: alpha',
      'assistant: ',
      'user: beta',
      'assistant: ',
    ])
    await expect(page.getByTestId('message-retry')).toHaveCount(1)
    await expect(
      page.getByTestId('message-error').first().getByTestId('message-retry'),
    ).toHaveCount(0)

    // The latest one's 「重试」 sends the message above it — beta, not the first one sent.
    await page.getByTestId('message-retry').click()
    await expect(page.getByTestId('message-error')).toHaveCount(3)
    await expect(page.getByTestId('user-text')).toHaveText(['alpha', 'beta', 'beta'])
    await expect(page.getByTestId('message-retry')).toHaveCount(1)
    await expect(page.getByTestId('message-error').last().getByTestId('message-retry')).toHaveCount(
      1,
    )
    expect(await routeCalls(app, 'chat.send')).toBe(3)
  } finally {
    await app.close()
  }
})
