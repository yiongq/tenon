import { APPROVAL_CLICK_GUARD_MS } from '../src/renderer/src/lib/approval-keys.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import Database from 'better-sqlite3'
import {
  ZHIPU_DEFAULT_BASE_URL,
  createMemoryHost,
  createMemoryTapeStore,
  zhipuDefinition,
} from '@tenon-app/kernel'
import type {
  FetchLike,
  HostClock,
  McpConnection,
  McpToolSource,
  TapeEntry,
} from '@tenon-app/kernel'
import {
  createCounterIds,
  createTestLoopPorts,
  createTestSessionService,
} from '@tenon-app/kernel/testing'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { compact, emulationGroup, officialGroup } from './helpers/live-env.js'
import type { LiveGroup } from './helpers/live-env.js'
import { expect, test } from './helpers/test.js'
import { makeFolderTree, send, startTask } from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/**
 * Acceptances 4 and 21 against REAL endpoints — the only automated coverage the spec gives the
 * real keychain path and the real wire formats. Opt-in: CI never runs it.
 *
 * HOW TO RUN IT
 *
 *   1. Put the non-official credentials in the repo-root `.env.local` (gitignored, never read by
 *      any other test):
 *        ANTHROPIC_BASE_URL=…      Zhipu's Anthropic-compatible endpoint (…/api/anthropic)
 *        ANTHROPIC_AUTH_TOKEN=…    the Zhipu key; with the base URL, enables the emulation group
 *        TENON_LIVE_MODEL=…        its model, glm-4.7-flash (spec 02 §模型与密钥)
 *        ZHIPU_API_KEY=…           enables the zhipu groups (acceptance 21, and spec 02's
 *                                  acceptance 39 below); absent ⇒ they skip
 *        TENON_LIVE_ZHIPU_MODEL=…  glm-5.3-flashx (unset ⇒ glm-4.6); never the emulation group's
 *                                  free model, which 1302-limits a second group on the same key
 *        TENON_LIVE_RECORD_DIR=…   optional: where the agent group writes what went on the wire
 *   2. The official Anthropic key, when there is one, NEVER goes into `.env.local` or a shell
 *      profile. Hand it to this one run only, as TENON_LIVE_ANTHROPIC_OFFICIAL_KEY in the command's
 *      environment (from a password manager, not typed into the command line); absent ⇒ the
 *      official group skips. TENON_LIVE_ANTHROPIC_OFFICIAL_MODEL picks its model (default: the
 *      definition's first row). helpers/live-env.ts says why the two Anthropic groups cannot mix.
 *   3. `pnpm test:live`, the ONLY command that selects `playwright.live.config.ts` — the default
 *      config ignores this file, so `pnpm test:e2e` cannot collect it whatever is in your shell.
 *
 * It spends a few thousand tokens per group and run (the agent group some 25 000 input tokens, about
 * half of them cached), and the zhipu group goes through the real login keychain, which is why it is
 * manual. Do not point it at an endpoint you do not own.
 *
 * STILL OWED: the Anthropic-wire SSE fixtures (packages/kernel/test/provider/fixtures/
 * anthropic-sse.ts) were written from the documentation and only ever met Zhipu's emulation. The
 * first run of the official group should diff one real stream against them, frame by frame, and
 * record the result (01 plan.md, live record of 2026-09-22).
 */
const LIVE = process.env['TENON_LIVE'] === '1'
const ENV_FILE = resolve(process.cwd(), '../../.env.local')
/**
 * One key serves both manual use and these tests; what differs is the model. The tests read
 * their own `TENON_LIVE_*` settings first, so `TENON_MODEL` can stay on the model you like to
 * chat with while the suite runs on a cheap (or free) one. Replies are always capped.
 */
const fromFile = LIVE && existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : {}

function pick(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name] || fromFile[name]
    if (value) return value
  }
  return undefined
}

const MAX_TOKENS = pick('TENON_LIVE_MAX_TOKENS', 'TENON_MAX_TOKENS') ?? '2048'
const NOT_LIVE: LiveGroup = { kind: 'absent', reason: 'opt-in' }

/**
 * The Anthropic wire twice, on two endpoints that never share a key: Zhipu's emulation (the
 * adapter swallows it; not the guarantee tier) and the official API (spec 02 §模型与密钥).
 */
const ANTHROPIC_GROUPS: readonly { title: string; tag: string; group: LiveGroup }[] = [
  {
    title: 'live provider · anthropic emulation',
    tag: 'live',
    group: LIVE ? emulationGroup(pick, MAX_TOKENS) : NOT_LIVE,
  },
  {
    title: 'live provider · anthropic official',
    tag: 'live-official',
    group: LIVE ? officialGroup(process.env, fromFile, pick, MAX_TOKENS) : NOT_LIVE,
  },
]

for (const { title, tag, group } of ANTHROPIC_GROUPS) {
  test.describe(title, () => {
    test.skip(!LIVE, 'opt-in: run `pnpm test:live` with credentials in .env.local')
    test.skip(
      LIVE && group.kind === 'absent',
      `skipped: ${group.kind === 'absent' ? group.reason : ''} (see the header of this file)`,
    )
    test.describe.configure({ timeout: 180_000 })

    test.beforeAll(() => {
      // A setup that could send a key to the wrong host fails the group rather than skipping it.
      if (group.kind === 'refused') throw new Error(`${title}: ${group.reason}`)
    })

    async function open(name: string): ReturnType<typeof launchTenon> {
      const userData = makeUserDataDir(`${tag}-${name}`)
      seedConfig(userData, { locale: 'en' })
      const env = group.kind === 'ready' ? group.env : {}
      // In-memory secrets: the real keychain would be read AHEAD of these variables, so a key
      // saved through the settings card in daily use would ride along (helpers/live-env.ts).
      return launchTenon({ userData, env, secrets: 'memory' })
    }

    test('a real reply streams into the thread', async () => {
      const { app, page } = await open('stream')
      try {
        await page.getByTestId('composer-input').fill('Reply with the single word: pong')
        await page.keyboard.press('Enter')
        const reply = page.getByTestId('assistant-message').getByTestId('assistant-text')
        await expect(reply).toContainText(/pong/i, { timeout: 90_000 })
        await expect(page.getByTestId('composer-stop')).toHaveCount(0, { timeout: 90_000 })
        await expect(page.getByTestId('message-error')).toHaveCount(0)
      } finally {
        await app.close()
      }
    })

    test('the model sees the earlier turns of the same session', async () => {
      const { app, page } = await open('context')
      try {
        const input = page.getByTestId('composer-input')
        await input.fill('My codeword is tenon-42. Just answer: OK')
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('assistant-message')).toHaveCount(1, { timeout: 90_000 })
        // The Run is over once the stop button is gone (the send button stays while it runs, 旧 220).
        await expect(page.getByTestId('composer-stop')).toHaveCount(0, { timeout: 90_000 })

        await input.fill('What is my codeword? Answer with the codeword only.')
        await page.keyboard.press('Enter')
        const second = page.getByTestId('assistant-message').nth(1).getByTestId('assistant-text')
        await expect(second).toContainText('tenon-42', { timeout: 90_000 })
      } finally {
        await app.close()
      }
    })

    test('Stop really stops a long reply', async () => {
      const { app, page } = await open('stop')
      try {
        await page
          .getByTestId('composer-input')
          .fill('Count from 1 to 400, one number per line, nothing else.')
        await page.keyboard.press('Enter')
        const reply = page.getByTestId('assistant-message').getByTestId('assistant-text')
        await expect(reply).toContainText('3', { timeout: 90_000 })
        await page.getByTestId('composer-stop').click()
        await expect(page.getByTestId('composer-stop')).toHaveCount(0)

        const stoppedAt = await reply.innerText()
        await page.waitForTimeout(2500)
        expect(await reply.innerText()).toBe(stoppedAt)
        expect(stoppedAt).not.toContain('400')
      } finally {
        await app.close()
      }
    })
  })
}

/**
 * Acceptance 21: the `zhipu` definition — the OpenAI-compatible wire — against the real endpoint,
 * one streamed turn and one stop.
 *
 * The provider choice is SEEDED into `config.json` rather than clicked through the settings card:
 * this is a test of the wire, and acceptance 6's e2e already drives the card. The credential
 * arrives through the development fallback (`ZHIPU_API_KEY`), which is the one path that needs no
 * real key written anywhere on disk.
 */
const ZHIPU_MODEL_DEFAULT = 'glm-4.6'

test.describe('live provider · zhipu', () => {
  const key = LIVE ? pick('TENON_LIVE_ZHIPU_KEY', 'ZHIPU_API_KEY') : undefined
  test.skip(!LIVE, 'opt-in: run `pnpm test:live` with credentials in .env.local')
  test.skip(
    LIVE && key === undefined,
    `no zhipu key found: fill in ZHIPU_API_KEY in ${ENV_FILE} to run acceptance 21`,
  )
  test.describe.configure({ timeout: 180_000 })

  const model = pick('TENON_LIVE_ZHIPU_MODEL') ?? ZHIPU_MODEL_DEFAULT
  const env = compact({
    ZHIPU_API_KEY: key,
    TENON_MAX_TOKENS: pick('TENON_LIVE_MAX_TOKENS') ?? '2048',
  })

  async function open(tag: string): ReturnType<typeof launchTenon> {
    const userData = makeUserDataDir(`live-zhipu-${tag}`)
    seedConfig(userData, {
      locale: 'en',
      provider: { id: 'zhipu', modelId: model },
      // A gateway, when one is configured; otherwise the definition's own default endpoint.
      ...(pick('TENON_LIVE_ZHIPU_BASE_URL') === undefined
        ? {}
        : { providerConfig: { zhipu: { baseURL: pick('TENON_LIVE_ZHIPU_BASE_URL') ?? '' } } }),
    })
    return launchTenon({ userData, env, secrets: 'keychain' })
  }

  test('a real reply streams in from the OpenAI-compatible endpoint', async () => {
    const { app, page } = await open('stream')
    try {
      await page.getByTestId('composer-input').fill('Reply with the single word: pong')
      await page.keyboard.press('Enter')
      const reply = page.getByTestId('assistant-message').getByTestId('assistant-text')
      await expect(reply).toContainText(/pong/i, { timeout: 90_000 })
      await expect(page.getByTestId('composer-stop')).toHaveCount(0, { timeout: 90_000 })
      await expect(page.getByTestId('message-error')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test('Stop really stops a long reply on this wire too', async () => {
    const { app, page } = await open('stop')
    try {
      await page
        .getByTestId('composer-input')
        .fill('Count from 1 to 400, one number per line, nothing else.')
      await page.keyboard.press('Enter')
      const reply = page.getByTestId('assistant-message').getByTestId('assistant-text')
      await expect(reply).toContainText('3', { timeout: 90_000 })
      await page.getByTestId('composer-stop').click()
      await expect(page.getByTestId('composer-stop')).toHaveCount(0)

      const stoppedAt = await reply.innerText()
      await page.waitForTimeout(2500)
      expect(await reply.innerText()).toBe(stoppedAt)
      expect(stoppedAt).not.toContain('400')
    } finally {
      await app.close()
    }
  })
})

/**
 * Spec 02 acceptance 39 (plan step 21, 〔智谱 live〕): the agent loop on the `zhipu` definition against
 * the real endpoint — tools and the approval card over several turns, a card that outlives a
 * restart, the thinking levels, and connector names mapped to the 64-character limit. 旧 62 runs on
 * glm-5.3-flashx (TENON_LIVE_ZHIPU_MODEL) and glm-5.3-flash, the rest on flash, as the plan says;
 * the WebSearch round trip waits for plan step 28.
 *
 * What went on the wire is read where it leaves: main's egress calls `globalThis.fetch` at send time
 * (src/main/host/network.ts), so each case wraps it in the app it launched and keeps the URL, method,
 * JSON body and status of every request — never a header, so never the credential. A local proxy as
 * the zhipu `baseURL` cannot stand in for that seam: a development-fallback key is bound to the
 * declared host (A9, `boundHost` in src/main/provider.ts) and is never sent to another one. With
 * TENON_LIVE_RECORD_DIR set, each case writes those requests and its Tape's attempts (usage with the
 * reasoning tokens, stop reasons) there as JSON, which is where the live record in plan.md reads its
 * observations from.
 *
 * In-memory secrets, unlike acceptance 21's group above: that group keeps the keychain path covered,
 * and these cases are about the loop, so the key comes from the development fallback alone rather
 * than from a login-keychain read on each of their launches.
 */
const FLASH = 'glm-5.3-flash'
const AGENT_MODELS = [...new Set([pick('TENON_LIVE_ZHIPU_MODEL') ?? 'glm-5.3-flashx', FLASH])]
/** Room for the default thinking level (`max`) and a tool call; the plain-reply cap above is smaller. */
const AGENT_MAX_TOKENS = '8192'
/** One model turn, thinking included. Generous: a slow turn is not what these cases test. */
const TURN_MS = 180_000
/** Past the window in which clicks on a card that just appeared are ignored (plan step 34 retunes it). */
const PAST_CLICK_GUARD_MS = APPROVAL_CLICK_GUARD_MS + 200
const RECORD_DIR = LIVE ? pick('TENON_LIVE_RECORD_DIR') : undefined

/** The part of a chat-completions request body these cases read. */
interface ChatBody {
  readonly model?: string
  readonly reasoning_effort?: string
  readonly tools?: ReadonlyArray<{
    readonly function: {
      readonly name: string
      readonly parameters?: { readonly properties?: Readonly<Record<string, unknown>> }
    }
  }>
  readonly messages?: ReadonlyArray<{
    readonly role: string
    readonly content?: unknown
    readonly reasoning_content?: string
    readonly tool_calls?: ReadonlyArray<{
      readonly id: string
      readonly function: { name: string }
    }>
    readonly tool_call_id?: string
  }>
}

/** One provider request as it went to fetch. Never a header. */
interface WireRequest {
  readonly url: string
  readonly method: string
  /** The JSON body; null when it was not a JSON string. */
  readonly body: ChatBody | null
  /** The answer's status; null while none came, or when fetch threw. */
  status: number | null
}

/** Wraps main's `globalThis.fetch`, once per launch; self-contained, as `evaluate` runs it in main. */
async function recordRequests(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const store = globalThis as unknown as { liveRequests?: unknown[] }
    if (store.liveRequests !== undefined) return
    const requests: Array<{ url: string; method: string; body: unknown; status: number | null }> =
      []
    store.liveRequests = requests
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      let body: unknown = null
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body) as unknown
        } catch {
          body = null
        }
      }
      const record = { url, method: init?.method ?? 'GET', body, status: null as number | null }
      requests.push(record)
      const response = await original(input, init)
      record.status = response.status
      return response
    }
  })
}

/** The chat-completions requests main sent since `recordRequests`, in order. */
async function requestsOf(app: ElectronApplication): Promise<WireRequest[]> {
  const all = (await app.evaluate(
    () => (globalThis as unknown as { liveRequests?: unknown[] }).liveRequests ?? [],
  )) as WireRequest[]
  return all.filter((request) => request.url.endsWith('/chat/completions'))
}

/** The same record in this process, for the kernel case: the platform fetch, one hop. */
function recordingFetch(requests: WireRequest[]): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let body: ChatBody | null = null
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as ChatBody
      } catch {
        body = null
      }
    }
    const record: WireRequest = { url, method: init?.method ?? 'GET', body, status: null }
    requests.push(record)
    const response = await globalThis.fetch(input, init)
    record.status = response.status
    return response
  }
}

/** Every request answered 200; the others, by status, otherwise. */
function expectAllAnswered(requests: readonly WireRequest[]): void {
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.map((request) => request.status)).toEqual(requests.map(() => 200))
}

/** A fresh codeword the model can only know by reading it. */
function codeword(label: string): string {
  return `${label}-${randomUUID().slice(0, 8).toUpperCase()}`
}

interface Fact {
  readonly name: string
  readonly payload: Readonly<Record<string, unknown>>
}

/** The profile's Tape in the order written, read once the app is closed. */
function tapeFacts(userData: string): Fact[] {
  const db = new Database(join(dirname(configPathIn(userData)), 'sessions.db'), {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const rows = db
      .prepare('SELECT name, payload_json FROM tape_entry ORDER BY session_id, entry_id')
      .all() as Array<{ name: string; payload_json: string }>
    return rows.map((row) => ({
      name: row.name,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }))
  } finally {
    db.close()
  }
}

function named(facts: readonly Fact[], name: string): Fact[] {
  return facts.filter((fact) => fact.name === name)
}

/** Each Run's end code and each Run's cause, in the order written (spec 02 §结束原因词表). */
function runsOf(facts: readonly Fact[]): { ends: string[]; causes: string[] } {
  return {
    ends: named(facts, 'execution/run_terminal').map(
      (fact) => (fact.payload['reason'] as { code: string }).code,
    ),
    causes: named(facts, 'execution/run_started').map(
      (fact) => (fact.payload['cause'] as { kind: string }).kind,
    ),
  }
}

/** The thinking text of the last `message/assistant` that asked for a tool. */
function thinkingBeforeCall(facts: readonly Fact[]): string {
  const asked = named(facts, 'message/assistant').findLast((fact) =>
    (fact.payload['content'] as Array<{ type: string }>).some(
      (block) => block.type === 'tool-request',
    ),
  )
  return ((asked?.payload['content'] ?? []) as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === 'thinking')
    .map((block) => block.text ?? '')
    .join('')
}

/**
 * The Run on screen answered `expected` and is over: no stop button (the send button stays while it
 * runs, 旧 220). The text comes first because only the finished turn can show it.
 */
async function settles(page: Page, expected: string | RegExp): Promise<void> {
  await expect(page.getByTestId('assistant-text').last()).toContainText(expected, {
    timeout: TURN_MS,
  })
  await expect(page.getByTestId('composer-stop')).toHaveCount(0, { timeout: TURN_MS })
}

/** The card on screen, answered 「允许」 once the click guard has passed. */
async function allowCard(page: Page): Promise<void> {
  const card = page.getByTestId('approval-card')
  await expect(card).toHaveCount(1, { timeout: TURN_MS })
  await page.waitForTimeout(PAST_CLICK_GUARD_MS)
  await card.getByTestId('approval-allow').click()
  await expect(page.getByTestId('approval-answered').last()).toHaveAttribute(
    'data-outcome',
    'allowed',
  )
}

/** A case's requests and its Tape's attempts, as JSON under TENON_LIVE_RECORD_DIR. */
function writeRecord(
  info: TestInfo,
  requests: readonly WireRequest[],
  facts: readonly Fact[],
): void {
  if (RECORD_DIR === undefined) return
  mkdirSync(RECORD_DIR, { recursive: true })
  // The end of the title names the plan item and the model; the start is prose.
  const file = info.title
    .replaceAll(/[^A-Za-z0-9.]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(-100)
  const attempts = named(facts, 'provider/attempt_completed').map((fact) => fact.payload)
  const ends = named(facts, 'execution/run_terminal').map((fact) => fact.payload['reason'])
  writeFileSync(
    join(RECORD_DIR, `${file}.json`),
    `${JSON.stringify({ title: info.title, status: info.status, requests, attempts, ends }, null, 2)}\n`,
  )
}

/** A profile on the zhipu definition's own endpoint, with this model chosen. */
function profile(tag: string, model: string): string {
  const userData = makeUserDataDir(`live-agent-${tag}`)
  seedConfig(userData, { locale: 'en', provider: { id: 'zhipu', modelId: model } })
  return userData
}

/** The kernel's clock for the in-process case: real time, as the provider's watchdogs expect. */
const REAL_CLOCK: HostClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}

/**
 * A connector whose names are too long to go out as they are (§工具来源、命名与权限键「命名规则」):
 * `${serverId}__${name}` is 76 characters for the lookup, has a `.` for the old lookup, and is
 * exactly 64 for the echo — two mapped with the hash suffix, one kept verbatim.
 */
const CONNECTOR_ID = 'tenon-live-connector-with-a-long-server-id'
const LOOKUP = 'look_up_the_codeword_for_a_topic'
const OLD_LOOKUP = 'lookup.v2'
const ECHO = 'echo_the_topic_given'

function connectorSource(
  code: string,
  executed: Array<{ name: string; args: Record<string, unknown> }>,
): McpToolSource {
  const topic = {
    type: 'object',
    properties: { topic: { type: 'string', description: 'The topic to look up.' } },
    required: ['topic'],
    additionalProperties: false,
  }
  const connection = {
    listTools: () =>
      Promise.resolve([
        { name: LOOKUP, description: 'Looks up the codeword for a topic.', inputSchema: topic },
        { name: OLD_LOOKUP, description: 'Retired. Never call this tool.', inputSchema: topic },
        {
          name: ECHO,
          description: 'Echoes the topic back. Never call this tool.',
          inputSchema: topic,
        },
      ]),
    callTool: (name: string, args: Record<string, unknown>) => {
      executed.push({ name, args })
      return Promise.resolve({
        content: [{ type: 'text', text: `The codeword for ${String(args['topic'])} is ${code}.` }],
        isError: false,
      })
    },
  } as unknown as McpConnection
  return { serverId: CONNECTOR_ID, connection }
}

test.describe('live agent · zhipu', () => {
  const key = LIVE ? pick('TENON_LIVE_ZHIPU_KEY', 'ZHIPU_API_KEY') : undefined
  test.skip(!LIVE, 'opt-in: run `pnpm test:live` with credentials in .env.local')
  test.skip(
    LIVE && key === undefined,
    `no zhipu key found: fill in ZHIPU_API_KEY in ${ENV_FILE} to run acceptance 39`,
  )
  test.describe.configure({ timeout: 600_000 })

  const env = compact({ ZHIPU_API_KEY: key, TENON_MAX_TOKENS: AGENT_MAX_TOKENS })
  // What the case sent and what its Tape holds, for writeRecord.
  let requests: WireRequest[] = []
  let facts: Fact[] = []
  let tree: FolderTree | undefined

  test.afterEach(() => {
    writeRecord(test.info(), requests, facts)
    requests = []
    facts = []
    tree?.dispose()
    tree = undefined
  })

  async function launch(userData: string): ReturnType<typeof launchTenon> {
    const launched = await launchTenon({ userData, env, secrets: 'memory' })
    await recordRequests(launched.app)
    return launched
  }

  /** Keeps what the app sent, then closes it. */
  async function close(app: ElectronApplication): Promise<void> {
    try {
      requests.push(...(await requestsOf(app)))
    } finally {
      await app.close()
    }
  }

  for (const model of AGENT_MODELS) {
    test(`a task conversation with tools: two round trips over two turns, one allowed on the card, and every Run completes (旧 62, ${model})`, async () => {
      const alpha = codeword('ALPHA')
      const beta = codeword('BETA')
      const folders = makeFolderTree(`live-62-${model}`, {
        'ws/notes.txt': `Project notes.\nThe codeword is ${alpha}.\n`,
        'outside/beta.txt': `The codeword is ${beta}.\n`,
      })
      tree = folders
      const workspace = join(folders.real, 'ws')
      const outside = join(folders.real, 'outside', 'beta.txt')
      const first =
        `Use the Grep tool, with -i set to true and output_mode set to "content", to search ` +
        `${workspace} for the word "codeword". Then reply with the codeword you found and nothing else.`
      const second = `Now use the Read tool to read ${outside}. Reply with the codeword in it and nothing else.`
      const userData = profile(`62-${model}`, model)

      const { app, page } = await launch(userData)
      try {
        await startTask(app, page, workspace)
        // Turn 1: a round trip inside the workspace, which asks nothing.
        await send(page, first)
        await settles(page, alpha)
        await expect(page.getByTestId('approval-card')).toHaveCount(0)
        // Turn 2: a Read outside it stops on a card; allowed, the Run resumes and answers.
        await send(page, second)
        await allowCard(page)
        await settles(page, beta)

        // The thread: both turns, a row per call, the one answered card, no failure.
        await expect(page.getByTestId('user-text')).toHaveText([first, second])
        expect(await page.getByTestId('tool-row').count()).toBeGreaterThanOrEqual(2)
        await expect(page.getByTestId('approval-answered')).toHaveCount(1)
        await expect(page.getByTestId('failure-card')).toHaveCount(0)
        await expect(page.getByTestId('message-error')).toHaveCount(0)
      } finally {
        await close(app)
      }

      // The Tape: two user turns, a result for every call, one card allowed, and the Runs — the
      // first turn's, the second's that paused, and the one the answer opened — end as they should.
      facts = tapeFacts(userData)
      expect(named(facts, 'message/user')).toHaveLength(2)
      const calls = named(facts, 'tool/call')
      expect(calls.length).toBeGreaterThanOrEqual(2)
      for (const call of calls) expect(['Read', 'Glob', 'Grep']).toContain(call.payload['name'])
      const results = named(facts, 'tool/result')
      expect(results.map((fact) => fact.payload['providerToolCallId'])).toEqual(
        calls.map((fact) => fact.payload['providerToolCallId']),
      )
      const resolved = named(facts, 'tool/approval_resolved')
      expect(resolved.map((fact) => [fact.payload['outcome'], fact.payload['via']])).toEqual([
        ['allowed', 'card'],
      ])
      const allowed = results.find(
        (fact) => fact.payload['providerToolCallId'] === resolved[0]?.payload['providerToolCallId'],
      )
      expect(allowed?.payload['isError']).toBe(false)
      expect(JSON.stringify(allowed?.payload['content'])).toContain(beta)
      expect(runsOf(facts)).toEqual({
        ends: ['completed', 'paused', 'completed'],
        causes: ['user-message', 'user-message', 'resume'],
      })

      // The wire: every request answered 200, each carrying Grep's `-i` / `-n` properties — the
      // property names starting with 「-」 that decision H7 keeps (plan step 21, 实测).
      expectAllAnswered(requests)
      for (const request of requests) {
        expect(request.body?.model).toBe(model)
        const grep = request.body?.tools?.find((tool) => tool.function.name === 'Grep')
        expect(Object.keys(grep?.function.parameters?.properties ?? {})).toEqual(
          expect.arrayContaining(['-i', '-n']),
        )
      }
    })
  }

  /** The level on the menu, then one short turn at it; its request is the last one sent. */
  async function turnAtLevel(
    app: ElectronApplication,
    page: Page,
    level: 'low' | 'high' | 'max',
  ): Promise<void> {
    await page.getByTestId('model-menu-trigger').click()
    // The submenu opens on hover; a click on its trigger would toggle it shut again.
    await page.getByTestId('model-effort').hover()
    await expect(page.getByTestId('model-effort-levels')).toBeVisible()
    await page.getByTestId(`model-effort-${level}`).click()
    const shown = { low: 'Low', high: 'High', max: 'Max' }[level]
    await expect(page.getByTestId('model-menu-current')).toHaveText(`${FLASH} · ${shown}`)
    const before = (await requestsOf(app)).length
    await send(page, `Reply with the single word: ${level}`)
    await settles(page, new RegExp(level, 'i'))
    const sent = await requestsOf(app)
    expect(sent).toHaveLength(before + 1)
    expect(sent.at(-1)?.status).toBe(200)
    expect(sent.at(-1)?.body?.reasoning_effort).toBe(level)
  }

  test(`reasoning_effort low, high and max each answer 200 and go out as chosen (旧 63, ${FLASH})`, async () => {
    const userData = profile('63', FLASH)
    const { app, page } = await launch(userData)
    try {
      await turnAtLevel(app, page, 'low')
      await turnAtLevel(app, page, 'high')
      await turnAtLevel(app, page, 'max')
    } finally {
      await close(app)
    }
    expectAllAnswered(requests)
    expect(requests.map((request) => request.body?.reasoning_effort)).toEqual([
      'low',
      'high',
      'max',
    ])
    // Each attempt's reasoning tokens go into the live record (TENON_LIVE_RECORD_DIR), not a criterion.
    facts = tapeFacts(userData)
    expect(runsOf(facts).ends).toEqual(['completed', 'completed', 'completed'])
  })

  test(`a card left pending across a restart, then allowed: the resumed Run carries the echoed thinking and succeeds (旧 64, ${FLASH})`, async () => {
    const gamma = codeword('GAMMA')
    const folders = makeFolderTree('live-64', {
      'ws/readme.txt': 'An empty workspace.\n',
      'outside/gamma.txt': `The codeword is ${gamma}.\n`,
    })
    tree = folders
    const workspace = join(folders.real, 'ws')
    const outside = join(folders.real, 'outside', 'gamma.txt')
    // The GLM-5.3 line always runs in thinking mode, yet on a task this short it sometimes streams
    // no thinking before the call (1 run in 3, 2026-09-27): a paused turn without thinking has
    // nothing to echo, so the first launch is tried again on a fresh profile, up to three times.
    let userData = ''
    let thinking = ''
    for (let attempt = 1; attempt <= 3 && thinking === ''; attempt += 1) {
      requests = []
      userData = profile(`64-restart-${String(attempt)}`, FLASH)
      // oxlint-disable-next-line no-await-in-loop -- each attempt is one live launch after the last
      const first = await launch(userData)
      try {
        // oxlint-disable-next-line no-await-in-loop -- the same launch, in order
        await startTask(first.app, first.page, workspace)
        // oxlint-disable-next-line no-await-in-loop -- the same launch, in order
        await send(
          first.page,
          `Use the Read tool to read ${outside}. Reply with the codeword in it and nothing else.`,
        )
        // oxlint-disable-next-line no-await-in-loop -- the same launch, in order
        await expect(first.page.getByTestId('approval-card')).toHaveCount(1, { timeout: TURN_MS })
      } finally {
        // Quit with the card unanswered.
        // oxlint-disable-next-line no-await-in-loop -- the same launch, in order
        await close(first.app)
      }
      expect(requests).toHaveLength(1)
      thinking = thinkingBeforeCall(tapeFacts(userData))
    }
    expect(thinking).not.toBe('')

    const second = await launch(userData)
    try {
      await allowCard(second.page)
      await settles(second.page, gamma)
      await expect(second.page.getByTestId('failure-card')).toHaveCount(0)
    } finally {
      await close(second.app)
    }

    // The resumed request: the paused turn's assistant message with its call and, verbatim, the
    // thinking it streamed before the restart (A12), then the Read's result.
    expectAllAnswered(requests)
    expect(requests).toHaveLength(2)
    const messages = requests[1]?.body?.messages ?? []
    const echoed = messages.find((message) => (message.tool_calls?.length ?? 0) > 0)
    expect(echoed?.role).toBe('assistant')
    expect(echoed?.reasoning_content).toBe(thinking)
    const result = messages.find((message) => message.role === 'tool')
    expect(result?.tool_call_id).toBe(echoed?.tool_calls?.[0]?.id)
    expect(JSON.stringify(result?.content)).toContain(gamma)

    facts = tapeFacts(userData)
    expect(runsOf(facts)).toEqual({
      ends: ['paused', 'completed'],
      causes: ['user-message', 'resume'],
    })
    expect(named(facts, 'tool/approval_resolved').map((fact) => fact.payload['outcome'])).toEqual([
      'allowed',
    ])
  })

  /**
   * The mapped names need a connector, and the desktop registers none in ①, so this case drives the
   * kernel in this process: the session service with the test registry (every call always-allowed),
   * the real `zhipu` definition on its own endpoint, and the connector above.
   */
  test(`connector names mapped to 64 characters are accepted on the wire and called back by name (旧 64, ${FLASH})`, async () => {
    const delta = codeword('DELTA')
    const executed: Array<{ name: string; args: Record<string, unknown> }> = []
    const model = zhipuDefinition.builtinModels.find((row) => row.id === FLASH)
    if (model === undefined) throw new Error(`${FLASH} is not a builtin zhipu row`)
    const provider = zhipuDefinition.create({
      network: { fetch: recordingFetch(requests) },
      clock: REAL_CLOCK,
      // The declared host only, as the app's key binding (A9) allows: an env key never goes elsewhere.
      config: { baseURL: ZHIPU_DEFAULT_BASE_URL },
      secrets: { apiKey: key ?? '' },
    })
    const store = createMemoryTapeStore({
      identity: { userId: 'live', tenantId: 'live', profileDir: '/tenon/live' },
    })
    const loop = createTestLoopPorts({
      connector: {
        provider,
        model,
        effort: 'low',
        maxTokens: Number(AGENT_MAX_TOKENS),
        mcpSources: [connectorSource(delta, executed)],
      },
    })
    const service = createTestSessionService(
      {
        host: { ...createMemoryHost(), clock: REAL_CLOCK },
        tape: store,
        ids: createCounterIds(),
        inspectors: [],
        connector: loop.connector,
        protectedFiles: [],
      },
      { tools: {}, userSetting: () => ({ userSetting: 'always-allow' }) },
    )
    service.bindLoop(loop)
    const sessionId = randomUUID()
    const sent = await service.send({
      sessionId,
      origin: null,
      text: 'Look up the codeword for the topic "tenon" with the tool for that. Then reply with the codeword and nothing else.',
    })
    if (sent.status !== 'started') throw new Error(`send answered ${JSON.stringify(sent)}`)
    const ended = await loop.runEnded({ runId: sent.runId })
    const entries: TapeEntry[] = (await store.readRange({ sessionId, limit: 1000 })).entries
    facts = entries.map((entry) => ({ name: entry.name, payload: entry.payload }))
    expect(ended.reason).toEqual({ code: 'completed' })

    const table = named(facts, 'view/tool_table')[0]?.payload['tools'] as
      | Array<{ name: string; originalName: string; source: string }>
      | undefined
    const mapped = new Map(
      (table ?? [])
        .filter((tool) => tool.source === 'mcp')
        .map((tool) => [tool.originalName, tool.name]),
    )
    const lookup = mapped.get(LOOKUP) ?? ''
    const raw = (name: string): string => `${CONNECTOR_ID}__${name}`
    // Too long: its first 55 characters, `_` and 8 hex digits. With a `.`: replaced, then the same.
    // Exactly 64 of the allowed characters: as it is.
    expect(lookup).toMatch(new RegExp(`^${raw(LOOKUP).slice(0, 55)}_[0-9a-f]{8}$`))
    expect(mapped.get(OLD_LOOKUP)).toMatch(new RegExp(`^${raw('lookup_v2')}_[0-9a-f]{8}$`))
    expect(mapped.get(ECHO)).toBe(raw(ECHO))
    expect([...mapped.values()].map((name) => name.length).toSorted()).toEqual([62, 64, 64])

    // On the wire: those names in `tools`, 200 both times; the call made by its mapped name and run
    // under its original one, and the answer read from its result.
    expectAllAnswered(requests)
    expect(requests).toHaveLength(2)
    expect(requests[0]?.body?.tools?.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining([...mapped.values()]),
    )
    expect(named(facts, 'tool/call').map((fact) => fact.payload['name'])).toEqual([lookup])
    expect(executed.map((call) => call.name)).toEqual([LOOKUP])
    const assistant = requests[1]?.body?.messages?.find((message) => message.role === 'assistant')
    expect(assistant?.tool_calls?.map((call) => call.function.name)).toEqual([lookup])
    const reply = named(facts, 'message/assistant').at(-1)?.payload['content']
    expect(JSON.stringify(reply)).toContain(delta)
  })
})
