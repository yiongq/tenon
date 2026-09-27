import { join } from 'node:path'
import { deferred, messageBodies, startFakeAnthropic } from '../test/support/fake-anthropic.js'
import type { FakeAnthropic, ScriptedReply } from '../test/support/fake-anthropic.js'
import { launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { expect, test } from './helpers/test.js'
import {
  callsReply,
  makeFolderTree,
  providerEnv,
  pushesOf,
  readCall,
  recordPushes,
  send,
  startTask,
  textReply,
} from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/**
 * How a Run's end shows (spec 02 §失败卡与结束原因, §重试与「继续」; plan step 20: 旧 221, 旧 27 界面).
 * The provider-error 「重试」 and 「去设置」 cases are in chat.spec.ts; this file adds 「继续」 for both
 * codes that share it and the provider error of a Run that already ran a call.
 */
let fake: FakeAnthropic | undefined
let tree: FolderTree | undefined

test.afterEach(async () => {
  await fake?.close()
  fake = undefined
  tree?.dispose()
  tree = undefined
})

/** packages/kernel/src/loop/limits.ts STEP_LIMIT: batches per user message. */
const STEP_LIMIT = 100

/** The model-only note a 「继续」 Run opens with (packages/kernel/src/prompts/index.ts `continuation`). */
const CONTINUATION = {
  'step-limit':
    'The task reached its step limit and the user asked you to continue. Carry on with the task from where you stopped.',
  'output-truncated':
    'Your previous reply was cut off at the output limit. Continue from exactly where it stopped, without repeating what you already wrote.',
} as const

/** A Run's terminal `chat.event` as main pushed it (`done` or `error`). */
interface EndPush {
  readonly type: string
  readonly endReason?: { readonly code: string }
  readonly runId?: string | null
}

async function endsOf(app: Parameters<typeof pushesOf>[0]): Promise<EndPush[]> {
  const events = await pushesOf<EndPush>(app, 'chat.event')
  return events.filter((event) => event.type === 'done' || event.type === 'error')
}

/** The text of a wire message's last text block. */
function lastText(message: { content: unknown } | undefined): string {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const texts = content.filter(
    (block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text',
  )
  return texts.at(-1)?.text ?? ''
}

test('the step limit ends the Run on 「继续」, which opens a new Run counting from 0; once that Run ends the button is gone (旧 221, 旧 27)', async () => {
  test.setTimeout(180_000)
  const folders = makeFolderTree('step-limit', { 'ws/a.txt': 'alpha\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  const file = join(ws, 'a.txt')
  /** Each reply a different call that needs no approval, so no two batches repeat (no-progress). */
  const call = (i: number): ScriptedReply =>
    callsReply(readCall(`toolu_${String(i)}`, file, { limit: i + 1 }))
  fake = await startFakeAnthropic({
    delayMs: 0,
    replies: (index) => {
      // 0–99 run; the 101st reply's call is closed not-run by the limit.
      if (index <= STEP_LIMIT) return { ...call(index), delayMs: 0 }
      // 「继续」: the counter starts again, so this call runs, then the reply.
      if (index === STEP_LIMIT + 1) return { ...call(index), delayMs: 0 }
      if (index === STEP_LIMIT + 2) return textReply('Carried ', 'on.')
      return undefined
    },
  })
  const server = fake
  const userData = makeUserDataDir('step-limit')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await startTask(app, page, ws)
    await recordPushes(app)
    await send(page, 'keep reading')
    const card = page.getByTestId('failure-card')
    await expect(card).toHaveAttribute('data-code', 'step-limit', { timeout: 120_000 })
    await expect(card).toHaveAttribute('data-visual', 'neutral')
    // Neutral: it reports, politely, and does not interrupt as an alert (components.md LiveRegion).
    await expect(card).not.toHaveAttribute('role', 'alert')
    await expect(card).toHaveAttribute('aria-live', 'polite')
    await expect(card.getByTestId('failure-what')).toHaveText('任务达到了 100 步的上限。')
    // ② by state: the completed calls listed by what they did, then the one that did not happen.
    const effects = card.getByTestId('failure-effects')
    await expect(effects.locator('p').first()).toHaveText('100 个调用已完成：')
    const done = card.getByTestId('failure-effects-done').locator('li')
    await expect(done).toHaveCount(STEP_LIMIT)
    await expect(done.first()).toHaveText(`读取 ${file}`)
    await expect(done.last()).toHaveText(`读取 ${file}`)
    await expect(effects.locator('p').last()).toHaveText('1 个调用确定没发生。')
    await expect(page.getByTestId('turn-summary')).toHaveCount(1)
    const action = card.getByTestId('failure-action')
    await expect(action).toHaveAttribute('data-action', 'continue')
    await expect(action).toHaveText('继续')
    expect(server.requests).toHaveLength(STEP_LIMIT + 1)
    // The 101st call never ran: its row says why.
    const rows = page.getByTestId('tool-row')
    await expect(rows).toHaveCount(STEP_LIMIT + 1)
    await expect(rows.last().getByTestId('tool-row-closure')).toHaveText(
      '没有执行：任务到了步数上限。',
    )

    await action.click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Carried on.')
    // A new Run (chat.continue opened it: its own runId), whose first request ends with the
    // continuation note; no message of the user's.
    await expect.poll(async () => (await endsOf(app)).length).toBe(2)
    const [limited, continued] = await endsOf(app)
    expect(limited?.endReason?.code).toBe('step-limit')
    expect(continued?.endReason?.code).toBe('completed')
    expect(typeof continued?.runId).toBe('string')
    expect(continued?.runId).not.toBe(limited?.runId)
    const bodies = messageBodies(server)
    expect(bodies).toHaveLength(STEP_LIMIT + 3)
    const tail = bodies[STEP_LIMIT + 1]?.messages.at(-1)
    expect(tail?.role).toBe('user')
    expect(lastText(tail)).toBe(CONTINUATION['step-limit'])
    await expect(page.getByTestId('user-message')).toHaveCount(1)
    // Counted from 0 again: the continued Run's call ran instead of closing on the limit.
    await expect(rows).toHaveCount(STEP_LIMIT + 2)
    await expect(rows.last().getByTestId('tool-row-closure')).toHaveCount(0)
    await expect(rows.last().getByTestId('tool-row-line')).toHaveText(`读取 ${file}`)
    // The continued Run has ended: the step-limit card stays, its 「继续」 goes, and the round keeps
    // one summary line, now under its last Run.
    await expect(card).toHaveAttribute('data-code', 'step-limit')
    await expect(card.getByTestId('failure-action')).toHaveCount(0)
    await expect(page.getByTestId('turn-summary')).toHaveCount(1)
    await expect(
      page.getByTestId('assistant-message').last().getByTestId('turn-summary'),
    ).toHaveCount(1)
    expect(server.unscripted).toBe(0)
  } finally {
    await app.close()
  }
})

test('a truncated reply ends on 「继续」 too, which continues without a message of the user’s (旧 221, A2)', async () => {
  fake = await startFakeAnthropic({
    replies: [
      { steps: [{ type: 'text', text: ['The first ', 'half'] }], stopReason: 'max_tokens' },
      textReply(' and the rest.'),
    ],
    delayMs: 5,
  })
  const server = fake
  const userData = makeUserDataDir('truncated')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await send(page, 'write it all')
    const card = page.getByTestId('failure-card')
    await expect(card).toHaveAttribute('data-code', 'output-truncated')
    await expect(card).toHaveAttribute('data-visual', 'neutral')
    const sent = server.requests[0]?.body as { max_tokens?: number } | undefined
    await expect(card.getByTestId('failure-what')).toHaveText(
      `The reply was cut off at the output limit of ${String(sent?.max_tokens)} tokens.`,
    )
    await expect(card.getByTestId('failure-effects')).toHaveText('No actions were taken.')
    // The half that arrived is kept.
    await expect(page.getByTestId('assistant-text').first()).toHaveText('The first half')
    const action = card.getByTestId('failure-action')
    await expect(action).toHaveAttribute('data-action', 'continue')
    await expect(action).toHaveText('Continue')

    await action.click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('and the rest.')
    const bodies = messageBodies(server)
    expect(bodies).toHaveLength(2)
    expect(lastText(bodies[1]?.messages.at(-1))).toBe(CONTINUATION['output-truncated'])
    await expect(page.getByTestId('user-message')).toHaveCount(1)
    await expect(card.getByTestId('failure-action')).toHaveCount(0)
    expect(server.requests).toHaveLength(2)
  } finally {
    await app.close()
  }
})

/**
 * §重试与「继续」 makes 「继续」 clickable only while the session's latest Run ended as step-limit or
 * output-truncated (§失败卡与结束原因 ③ refers to that condition).
 */
test('once the Run 「继续」 opened has ended, the old card offers 「继续」 no more (§重试与「继续」)', async () => {
  fake = await startFakeAnthropic({
    replies: [
      { steps: [{ type: 'text', text: 'The first half' }], stopReason: 'max_tokens' },
      textReply(' and the rest.'),
    ],
    delayMs: 5,
  })
  const server = fake
  const userData = makeUserDataDir('continued')
  seedConfig(userData, { locale: 'en' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await send(page, 'write it all')
    const card = page.getByTestId('failure-card')
    await card.getByTestId('failure-action').click()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('and the rest.')
    // The session's latest Run is the continued one, which completed: nothing to continue.
    await expect(
      page.locator('[data-testid="failure-action"][data-action="continue"]:enabled'),
    ).toHaveCount(0)
    expect(server.requests).toHaveLength(2)
  } finally {
    await app.close()
  }
})

test('a new message takes 「继续」 away at once, while its own Run is still going (§失败卡与结束原因 ③)', async () => {
  const hold = deferred()
  fake = await startFakeAnthropic({
    replies: [
      { steps: [{ type: 'text', text: 'The first half' }], stopReason: 'max_tokens' },
      {
        steps: [
          { type: 'text', text: 'Something ' },
          { type: 'wait', until: hold.promise },
          { type: 'text', text: 'else.' },
        ],
      },
    ],
    delayMs: 5,
  })
  const server = fake
  const userData = makeUserDataDir('continue-new-message')
  seedConfig(userData, { locale: 'zh-CN' })
  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await send(page, 'write it all')
    const card = page.getByTestId('failure-card')
    await expect(card.getByTestId('failure-action')).toHaveText('继续')
    await send(page, 'something else instead')
    // The new message's Run has not ended (its reply is held): only the message itself came after.
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Something')
    await expect(card).toHaveAttribute('data-code', 'output-truncated')
    await expect(card.getByTestId('failure-action')).toHaveCount(0)
    hold.resolve()
    await expect(page.getByTestId('assistant-text').last()).toHaveText('Something else.')
    await expect(card.getByTestId('failure-action')).toHaveCount(0)
    // It was a message, not a continuation: no continuation note went out.
    const bodies = messageBodies(server)
    expect(bodies).toHaveLength(2)
    expect(lastText(bodies[1]?.messages.at(-1))).toBe('something else instead')
  } finally {
    await app.close()
  }
})

/** A task whose one call runs, then a 400 (never retried) ends the Run: a Run that dispatched. */
async function ranThenFailed(tag: string) {
  const folders = makeFolderTree(tag, { 'ws/a.txt': 'alpha-content\n' })
  tree = folders
  const ws = join(folders.real, 'ws')
  const file = join(ws, 'a.txt')
  fake = await startFakeAnthropic({
    replies: [
      callsReply(readCall('toolu_a', file)),
      { failWith: { status: 400, type: 'invalid_request_error', message: 'boom' } },
    ],
  })
  const server = fake
  const userData = makeUserDataDir(tag)
  seedConfig(userData, { locale: 'en' })
  const launched = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  await recordPushes(launched.app)
  const drive = async () => {
    await startTask(launched.app, launched.page, ws)
    await send(launched.page, 'read a secret-question')
    const card = launched.page.getByTestId('failure-card')
    await expect(card).toHaveAttribute('data-code', 'provider-error')
    return card
  }
  return { ...launched, server, file, drive }
}

test('a provider error after a call already ran offers diagnostics to copy, not 「重试」 (旧 221)', async () => {
  const { app, server, file, drive } = await ranThenFailed('ran-then-failed')
  try {
    const card = await drive()
    await expect(card).toHaveAttribute('data-visual', 'danger')
    await expect(card.getByTestId('failure-what')).toHaveText(
      'The model service (anthropic) returned an error.',
    )
    // A failure interrupts: announced as an alert the moment it appears (components.md LiveRegion).
    await expect(card).toHaveAttribute('role', 'alert')
    // ② lists the call that completed, by what it did.
    await expect(card.getByTestId('failure-effects').locator('p')).toHaveText('One call completed:')
    await expect(card.getByTestId('failure-effects-done').locator('li')).toHaveText([
      `Read ${file}`,
    ])
    // The Run dispatched a call: sending the message again would repeat it (B17).
    const action = card.getByTestId('failure-action')
    await expect(action).toHaveAttribute('data-action', 'copy')
    await expect(action).toHaveText('Copy diagnostics')
    expect(server.requests).toHaveLength(2)
  } finally {
    await app.close()
  }
})

/**
 * §失败卡与结束原因: the copy holds codes, slots, runId and providerId, never a secret or the text —
 * through the system clipboard, which main lets only the app's own document write.
 */
test('「复制诊断信息」 copies the end reason, the runId and the providerId, and nothing else (§失败卡与结束原因)', async () => {
  const { app, page, drive } = await ranThenFailed('copy-diagnostics')
  // The copy goes to the system clipboard: keep the developer's and put it back.
  const kept = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    const card = await drive()
    const action = card.getByTestId('failure-action')
    await app.evaluate(({ clipboard }) => clipboard.writeText(''))
    await action.click()
    await expect(action).toHaveText('Copied')
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
    const diagnostics = JSON.parse(copied) as Record<string, unknown>
    // Exactly these three: the Run's end reason as main sent it (its code and slots), its runId —
    // the one run.state reported while it ran — and the provider.
    const ends = await endsOf(app)
    expect(ends).toHaveLength(1)
    const [ended] = ends
    expect(ended?.type).toBe('error')
    expect(diagnostics).toEqual({
      endReason: ended?.endReason,
      runId: ended?.runId,
      providerId: 'anthropic',
    })
    expect(diagnostics['endReason']).toMatchObject({
      code: 'provider-error',
      providerId: 'anthropic',
      attempts: 1,
    })
    const states = await pushesOf<{ running: boolean; runId: string | null }>(app, 'run.state')
    const ran = new Set(
      states.flatMap((state) => (state.running && state.runId !== null ? [state.runId] : [])),
    )
    expect([...ran]).toEqual([diagnostics['runId']])
    expect(copied).not.toContain('secret-question')
    expect(copied).not.toContain('alpha-content')
    expect(copied).not.toContain('e2e-test-key')
    // Writing is the one permission the document has: reading the clipboard back stays denied.
    const read = await page.evaluate(() =>
      navigator.clipboard.readText().then(
        () => 'read',
        (error: unknown) => (error instanceof Error ? error.name : 'denied'),
      ),
    )
    expect(read).toBe('NotAllowedError')
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), kept)
    await app.close()
  }
})

/** The sentence a spent quota ends on, by interface language, around its reset time. */
const QUOTA = {
  en: (at: string) => `The quota or spending limit on anthropic is used up. It resets at ${at}.`,
  'zh-CN': (at: string) => `anthropic 的额度或花费上限已用尽。将于 ${at} 重置。`,
} as const

test('a spent quota says when it resets, in the interface’s language, not the system’s (§失败卡与结束原因 quota-exhausted)', async () => {
  // A 429 naming the spend limit: not retried, and it resets at the start of next month (UTC).
  fake = await startFakeAnthropic({
    replies: [
      {
        failWith: {
          status: 429,
          type: 'rate_limit_error',
          message: 'spend limit reached',
          details: { error_code: 'enforced_spend_limit_reached' },
        },
      },
    ],
  })
  const server = fake
  const userData = makeUserDataDir('quota-reset')
  // The interface in the language the renderer's own default is not, so the two formats differ.
  seedConfig(userData, { locale: 'en' })
  const probe = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  const system = await probe.page.evaluate(() => new Intl.DateTimeFormat().resolvedOptions().locale)
  await probe.app.close()
  const locale = system.startsWith('zh') ? 'en' : 'zh-CN'
  seedConfig(userData, { locale })

  const { app, page } = await launchTenon({ userData, env: providerEnv(server.baseURL) })
  try {
    await recordPushes(app)
    await send(page, 'hi')
    const card = page.getByTestId('failure-card')
    await expect(card).toHaveAttribute('data-code', 'quota-exhausted')
    await expect(card).toHaveAttribute('data-visual', 'danger')
    const [ended] = await endsOf(app)
    const resetAt = (ended?.endReason as { resetAt?: number | null } | undefined)?.resetAt
    expect(typeof resetAt).toBe('number')
    const [inUi, inSystem] = await page.evaluate(
      ([at, ui]) => [new Date(at).toLocaleString(ui), new Date(at).toLocaleString()],
      [resetAt as number, locale] as const,
    )
    expect(inUi).not.toBe(inSystem)
    await expect(card.getByTestId('failure-what')).toHaveText(QUOTA[locale](inUi))
    expect(server.requests).toHaveLength(1)
  } finally {
    await app.close()
  }
})
