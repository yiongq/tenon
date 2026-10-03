import { APPROVAL_CLICK_GUARD_MS } from '../src/renderer/src/lib/approval-keys.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import Database from 'better-sqlite3'
import {
  ZHIPU_DEFAULT_BASE_URL,
  anthropicDefinition,
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
import { createInstanceInCard } from './helpers/instances.js'
import { configPathIn, launchTenon, makeUserDataDir, seedConfig } from './helpers/launch.js'
import { compact, deepseekKey, officialGroup } from './helpers/live-env.js'
import type { InstanceKey, LiveGroup } from './helpers/live-env.js'
import { echoGaps, echoedReasoning, expectedEchoes } from './helpers/reasoning-echo.js'
import { expect, test } from './helpers/test.js'
import { makeFolderTree, send, startTask } from './helpers/tools.js'
import type { FolderTree } from './helpers/tools.js'

/**
 * Acceptances 4 and 21 against REAL endpoints — the only automated coverage the spec gives the
 * real keychain path and the real wire formats — and M6 acceptances 28 and 29's custom vendor
 * instances. Opt-in: CI never runs it.
 *
 * HOW TO RUN IT
 *
 *   1. Put the non-official credentials in the repo-root `.env.local` (gitignored, never read by
 *      any other test):
 *        ZHIPU_API_KEY=…           enables the zhipu groups (acceptance 21, spec 02's acceptance 39
 *                                  and M6 acceptance 28's two instances, whose key is typed into
 *                                  the settings card); absent ⇒ they skip
 *        TENON_LIVE_ZHIPU_MODEL=…  glm-5.3-flashx (unset ⇒ glm-4.6); not glm-4.7-flash, whose free
 *                                  tier 1302-limits consecutive requests on the same key
 *        TENON_LIVE_RECORD_DIR=…   optional: where the agent group and the M6 instance groups write
 *                                  what went on the wire; unset, the instance groups write to each
 *                                  test's output folder, which the next run clears
 *      The Anthropic wire to Zhipu's /api/anthropic is a custom vendor instance now (M6 §点名 (d)):
 *      the ANTHROPIC_BASE_URL emulation group is gone, since anthropic reads that address as not
 *      configured. TENON_TEST_ORIGIN_MAP anywhere in sight refuses the whole run.
 *   2. The official Anthropic key, when there is one, NEVER goes into `.env.local` or a shell
 *      profile. Hand it to this one run only, as TENON_LIVE_ANTHROPIC_OFFICIAL_KEY in the command's
 *      environment (from a password manager, not typed into the command line); absent ⇒ the
 *      official group skips. TENON_LIVE_ANTHROPIC_OFFICIAL_MODEL picks its model (default: the
 *      definition's first row). helpers/live-env.ts says why the two Anthropic groups cannot mix.
 *      The DeepSeek key (M6 验收 29) follows the same rule: TENON_LIVE_DEEPSEEK_KEY in this run's
 *      environment only, read from the login keychain (service `tenon-live-deepseek`) for that one
 *      run and never typed into the command line; absent ⇒ the DeepSeek instance group skips,
 *      found in `.env.local` ⇒ it fails. It is typed into the instance's settings card, never
 *      handed to an app's environment.
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
 * The Anthropic wire on the official API (spec 02 §模型与密钥). Its emulation behind Zhipu's
 * /api/anthropic went with M6 §点名 (c), (d).
 */
const ANTHROPIC_GROUPS: readonly { title: string; tag: string; group: LiveGroup }[] = [
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
        await page.waitForTimeout(3_000)
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
      // The definition's own official endpoint: a Zhipu gateway is a custom vendor instance (M6
      // §点名 (a), (b)).
      provider: { id: 'zhipu', modelId: model },
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
      await page.waitForTimeout(3_000)
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
 * What went on the wire is read where it leaves: main's egress is undici's own fetch
 * (src/main/host/network.ts; 01 修补 9 (w), owner 2026-09-27), which announces every request on
 * undici's diagnostics channels, so each case subscribes to them in the app it launched and keeps the
 * URL, method, JSON body and status of every request — never a header, so never the credential.
 * Wrapping `globalThis.fetch` would see nothing: the egress no longer goes through it. A local proxy as
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

/**
 * Subscribes to undici's request channels in main, once per launch; self-contained, as `evaluate`
 * runs it in main. The channels are named process-wide, so they carry the requests of the undici the
 * egress imports as well as the platform's own; a redirect is one request per hop.
 */
async function recordRequests(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const store = globalThis as unknown as { liveRequests?: unknown[] }
    if (store.liveRequests !== undefined) return
    const requests: Array<{ url: string; method: string; body: unknown; status: number | null }> =
      []
    store.liveRequests = requests
    /** undici's own request object, as its channels publish it: only the fields read here. */
    interface Sent {
      readonly origin: string | URL
      readonly path: string
      readonly method: string
    }
    const open = new WeakMap<object, { record: (typeof requests)[number]; chunks: Buffer[] }>()
    const channels = process.getBuiltinModule('node:diagnostics_channel')
    channels.subscribe('undici:request:create', (message) => {
      const { request } = message as { request: Sent }
      const url = `${new URL(String(request.origin)).origin}${request.path}`
      const record: (typeof requests)[number] = {
        url,
        method: request.method,
        body: null,
        status: null,
      }
      requests.push(record)
      open.set(request, { record, chunks: [] })
    })
    channels.subscribe('undici:request:bodyChunkSent', (message) => {
      const { request, chunk } = message as { request: object; chunk: Uint8Array | string }
      open.get(request)?.chunks.push(Buffer.from(chunk))
    })
    channels.subscribe('undici:request:bodySent', (message) => {
      const entry = open.get((message as { request: object }).request)
      if (entry === undefined || entry.chunks.length === 0) return
      try {
        entry.record.body = JSON.parse(Buffer.concat(entry.chunks).toString('utf8')) as unknown
      } catch {
        entry.record.body = null
      }
    })
    channels.subscribe('undici:request:headers', (message) => {
      const { request, response } = message as { request: object; response: { statusCode: number } }
      const entry = open.get(request)
      if (entry !== undefined) entry.record.status = response.statusCode
    })
  })
}

/**
 * The requests main sent since `recordRequests` to a URL ending in `path` (chat completions unless
 * told otherwise; `''` for every request), in order.
 */
async function requestsOf(
  app: ElectronApplication,
  path = '/chat/completions',
): Promise<WireRequest[]> {
  const all = (await app.evaluate(
    () => (globalThis as unknown as { liveRequests?: unknown[] }).liveRequests ?? [],
  )) as WireRequest[]
  return all.filter((request) => request.url.endsWith(path))
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
    test(`WebSearch completes a real quark round trip (step 28, ${model})`, async () => {
      const userData = profile(`28-search-${model}`, model)
      const { app, page } = await launch(userData)
      try {
        await send(
          page,
          'Call WebSearch exactly once to find the official TypeScript website. After the result, reply with SEARCH_DONE and one link from the results. Do not call other tools.',
        )
        const card = page.getByTestId('approval-card')
        await expect(card).toContainText('open.bigmodel.cn', { timeout: TURN_MS })
        await allowCard(page)
        await settles(page, 'SEARCH_DONE')
        await expect(page.getByTestId('failure-card')).toHaveCount(0)
        const searchRequests = await app.evaluate(() =>
          (
            (
              globalThis as unknown as {
                liveRequests?: {
                  url: string
                  method: string
                  body: unknown
                  status: number | null
                }[]
              }
            ).liveRequests ?? []
          ).filter((entry) => entry.url === 'https://open.bigmodel.cn/api/paas/v4/web_search'),
        )
        expect(searchRequests).toHaveLength(1)
        expect(searchRequests[0]).toMatchObject({
          method: 'POST',
          status: 200,
          body: { search_engine: 'search_pro_quark', search_intent: false },
        })
        requests.push(...(searchRequests as WireRequest[]))
      } finally {
        await close(app)
      }
      facts = tapeFacts(userData)
      expect(named(facts, 'tool/call').map((fact) => fact.payload['name'])).toEqual(['WebSearch'])
      const results = named(facts, 'tool/result')
      expect(results).toHaveLength(1)
      expect(results[0]?.payload['isError']).toBe(false)
      const hitUrls = results[0]?.payload['searchHitUrls'] as string[]
      expect(hitUrls.length).toBeGreaterThan(0)
      expect(new Set(hitUrls).size).toBe(hitUrls.length)
      for (const url of hitUrls) {
        expect(new URL(url).hash).toBe('')
      }
      expect(runsOf(facts).ends).toEqual(['paused', 'completed'])
    })

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
      network: {
        fetchUntrusted: createMemoryHost().network.fetchUntrusted,
        fetch: recordingFetch(requests),
      },
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

/**
 * M6 验收 28 (plan step 11, 〔智谱 live〕): custom vendor instances on Zhipu's two pay-as-you-go
 * addresses, set up the way a user does — 「其他兼容端点」 on the settings card with the key typed in,
 * a model row with its limits, 「探测」 — then one task round trip with a tool on the probed row.
 *
 * The key is the zhipu groups' own (`.env.example`: both instance groups use ZHIPU_API_KEY). It is
 * typed into the card, never handed to the app's environment; `createInstanceInCard` runs the
 * instance key guard first (M6 §点名, 02 M4), and the in-memory secrets seam keeps it out of the
 * login keychain. These groups run after the builtin zhipu ones and, like the whole suite, one test
 * at a time (`workers: 1`, playwright.shared.ts), so no two requests on the key overlap (1302).
 *
 * glm-4.7-flash is the free tier that 1302-limits consecutive requests, and it has never carried
 * tools on /api/anthropic (M6 开放问题 2): whatever its probe answers is in the record before
 * anything is asserted, and the owner decides from it. Each case writes that record — the date, the
 * model, the hosts its requests went to, the probe snapshot, then each request's URL, method, JSON
 * body and status (never a header, so never the key) and its Tape's attempts — to
 * TENON_LIVE_RECORD_DIR, or to the test's output folder when that is unset.
 */
interface ZhipuInstance {
  readonly title: string
  readonly tag: string
  readonly wire: 'openai-chat' | 'anthropic-messages'
  readonly baseURL: string
  readonly model: string
  /** Where the wire's model requests go under `baseURL`. */
  readonly path: string
  /** What 验收 28 asks of the stored snapshot. */
  readonly probe: Readonly<Record<string, unknown>>
}

const ZHIPU_INSTANCES: readonly ZhipuInstance[] = [
  {
    title: 'live custom vendor · zhipu openai-chat',
    tag: 'openai',
    wire: 'openai-chat',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3-flashx',
    path: '/chat/completions',
    // The thinking field ① saw, which ② and every later turn send back (§合成).
    probe: { outcome: 'passed', reason: null, reasoningField: 'reasoning_content' },
  },
  {
    title: 'live custom vendor · zhipu anthropic-messages',
    tag: 'anthropic',
    wire: 'anthropic-messages',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-4.7-flash',
    path: '/v1/messages',
    probe: { outcome: 'passed', reason: null },
  },
]

/**
 * The limits typed into each instance row (§列表与上限 T6: the user's own, both required). The
 * test's values, not the vendor's published ones: no history or reply here comes near either, and
 * the output limit equals the cap every request of these cases goes out with.
 */
const INSTANCE_ROW = { contextLimit: 128_000, maxOutputTokens: Number(AGENT_MAX_TOKENS) }
/** A probe is two model turns, three with §两步 T10's retry. */
const PROBE_MS = 2 * TURN_MS

/** What one instance case leaves for the live record in plan.md. */
interface InstanceRecord {
  readonly date: string
  readonly wire: ZhipuInstance['wire']
  readonly baseURL: string
  readonly model: string
  /** Every host main sent a request to in this case, the probe's included. */
  hosts: string[]
  /** The row's stored snapshot after 「探测」; null while there is none. */
  probe: Readonly<Record<string, unknown>> | null
  /** The two limits 「获取模型列表」 prefilled, as the fields held them (DeepSeek, 验收 29). */
  prefilled?: { contextLimit: string; maxOutputTokens: string }
  requests: WireRequest[]
  attempts: unknown[]
  ends: unknown[]
}

/** The tools a model request offers, by name, on either wire. */
function offeredTools(body: unknown): string[] {
  const tools =
    (body as { tools?: ReadonlyArray<{ name?: string; function?: { name: string } }> } | null)
      ?.tools ?? []
  return tools.map((tool) => tool.function?.name ?? tool.name ?? '')
}

/** An instance's model row as `customVendor.list` answers it. */
interface ListedRow {
  readonly id: string
  readonly contextLimit: number
  readonly maxOutputTokens: number
  readonly probe?: Readonly<Record<string, unknown>>
}

/** An instance's row for `model` as `customVendor.list` answers it; null when it has none. */
async function rowOf(page: Page, id: string, model: string): Promise<ListedRow | null> {
  const answer = (await page.evaluate(() => window.tenon.invoke('customVendor.list', {}))) as {
    data?: { instances: ReadonlyArray<{ id: string; models: readonly ListedRow[] }> }
  }
  const instance = answer.data?.instances.find((entry) => entry.id === id)
  return instance?.models.find((row) => row.id === model) ?? null
}

/** The stored probe snapshot of an instance's row, as `customVendor.list` answers it. */
async function probeOf(
  page: Page,
  id: string,
  model: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  return (await rowOf(page, id, model))?.probe ?? null
}

/**
 * The case's record as JSON, under TENON_LIVE_RECORD_DIR or the test's output folder. The file
 * name carries the record's date, so 开放问题 2's two runs 60 s apart both stay in one folder.
 */
function writeInstanceRecord(info: TestInfo, record: InstanceRecord): void {
  const slug = info.title
    .replaceAll(/[^A-Za-z0-9.]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(-100)
  const file = `${slug}-${record.date.replaceAll(':', '-')}.json`
  const destination = RECORD_DIR === undefined ? info.outputPath(file) : join(RECORD_DIR, file)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(
    destination,
    `${JSON.stringify({ title: info.title, status: info.status, ...record }, null, 2)}\n`,
  )
  const { date, model, hosts, probe, prefilled } = record
  process.stderr.write(`${JSON.stringify({ date, model, hosts, probe, prefilled })}\n`)
}

for (const instance of ZHIPU_INSTANCES) {
  test.describe(instance.title, () => {
    const key = LIVE ? pick('TENON_LIVE_ZHIPU_KEY', 'ZHIPU_API_KEY') : undefined
    test.skip(!LIVE, 'opt-in: run `pnpm test:live` with credentials in .env.local')
    test.skip(
      LIVE && key === undefined,
      `no zhipu key found: fill in ZHIPU_API_KEY in ${ENV_FILE} to run M6 acceptance 28`,
    )
    test.describe.configure({ timeout: 900_000 })

    let record: InstanceRecord | undefined
    let tree: FolderTree | undefined

    test.afterEach(() => {
      if (record !== undefined) writeInstanceRecord(test.info(), record)
      record = undefined
      tree?.dispose()
      tree = undefined
    })

    test(`created on the settings card, probed, then a task round trip with a tool (M6 验收 28, ${instance.model})`, async () => {
      const epsilon = codeword('EPSILON')
      const folders = makeFolderTree(`live-instance-${instance.tag}`, {
        'ws/notes.txt': `Project notes.\nThe codeword is ${epsilon}.\n`,
      })
      tree = folders
      const workspace = join(folders.real, 'ws')
      const notes = join(workspace, 'notes.txt')
      const userData = makeUserDataDir(`live-instance-${instance.tag}`)
      seedConfig(userData, { locale: 'en' })
      const kept: InstanceRecord = {
        date: new Date().toISOString(),
        wire: instance.wire,
        baseURL: instance.baseURL,
        model: instance.model,
        hosts: [],
        probe: null,
        requests: [],
        attempts: [],
        ends: [],
      }
      record = kept
      // No provider variable: the key goes in through the card, onto the in-memory secrets seam.
      const { app, page } = await launchTenon({
        userData,
        env: { TENON_MAX_TOKENS: AGENT_MAX_TOKENS },
        secrets: 'memory',
      })
      await recordRequests(app)
      let id = ''
      let probeSent = 0
      try {
        await page.getByTestId('account-row').click()
        await page.getByTestId('account-providers').click()
        await expect(page.getByTestId('custom-vendors')).toBeVisible()
        id = await createInstanceInCard(page, {
          displayName: `Zhipu · ${instance.wire}`,
          wire: instance.wire,
          baseURL: instance.baseURL,
          apiKey: key ?? '',
        })
        await page.getByTestId(`custom-vendor-row-id-${id}`).fill(instance.model)
        await page
          .getByTestId(`custom-vendor-row-context-${id}`)
          .fill(String(INSTANCE_ROW.contextLimit))
        await page
          .getByTestId(`custom-vendor-row-output-${id}`)
          .fill(String(INSTANCE_ROW.maxOutputTokens))
        await page.getByTestId(`custom-vendor-row-save-${id}`).click()
        const row = `${id}-${instance.model}`
        await expect(page.getByTestId(`custom-vendor-row-${row}`)).toBeVisible()
        // Neither the instance nor its row sent anything (T7).
        expect(await requestsOf(app, '')).toHaveLength(0)

        // 「探测」: over once the row shows a stored snapshot, or the probe's answer beside it.
        await page.getByTestId(`custom-vendor-probe-${row}`).click()
        await expect(
          page
            .locator(`[data-testid="custom-vendor-probe-status-${row}"]:not([data-outcome="none"])`)
            .or(page.getByTestId(`custom-vendor-probe-answer-${row}`))
            .first(),
        ).toBeVisible({ timeout: PROBE_MS })
        kept.probe = await probeOf(page, id, instance.model)
        probeSent = (await requestsOf(app, instance.path)).length
        expect(kept.probe).toMatchObject(instance.probe)
        await page.getByTestId('provider-cancel').click()
        await expect(page.getByTestId('provider-settings')).toBeHidden()

        // The task, on the probed row: chosen in the menu, which offers it to a task (Q6).
        await startTask(app, page, workspace)
        await page.getByTestId('model-menu-trigger').click()
        const choice = page.getByTestId(`model-row-${row}`)
        await expect(choice).not.toHaveAttribute('aria-disabled', 'true')
        await choice.click()
        await expect(page.getByTestId('model-menu')).toBeHidden()
        await expect(page.getByTestId('model-menu-current')).toHaveText(instance.model)
        await expect(page.getByTestId('composer-send-block')).toHaveCount(0)
        await send(
          page,
          `Use the Read tool to read ${notes}. Reply with the codeword in it and nothing else.`,
        )
        await settles(page, epsilon)
        // A Read in the workspace asks nothing.
        await expect(page.getByTestId('approval-card')).toHaveCount(0)
        expect(await page.getByTestId('tool-row').count()).toBeGreaterThanOrEqual(1)
        await expect(page.getByTestId('failure-card')).toHaveCount(0)
        await expect(page.getByTestId('message-error')).toHaveCount(0)
      } finally {
        try {
          const sent = await requestsOf(app, '')
          kept.hosts = [...new Set(sent.map((request) => new URL(request.url).host))]
          kept.requests = sent
        } finally {
          await app.close()
        }
      }

      const facts = tapeFacts(userData)
      kept.attempts = named(facts, 'provider/attempt_completed').map((fact) => fact.payload)
      kept.ends = named(facts, 'execution/run_terminal').map((fact) => fact.payload['reason'])

      // The Tape: the probed row chose the tools (M6 §不发工具) for its instance's own origin (不变量 3).
      expect(named(facts, 'session/model_selected').map((fact) => fact.payload)).toEqual([
        {
          providerId: id,
          modelId: instance.model,
          capabilitySource: 'probed',
          endpointOrigin: new URL(instance.baseURL).origin,
        },
      ])
      expect(named(facts, 'view/tools_withheld')).toHaveLength(0)
      const calls = named(facts, 'tool/call')
      expect(calls.map((fact) => fact.payload['name'])).toContain('Read')
      const results = named(facts, 'tool/result')
      expect(results.map((fact) => fact.payload['providerToolCallId'])).toEqual(
        calls.map((fact) => fact.payload['providerToolCallId']),
      )
      expect(JSON.stringify(results.map((fact) => fact.payload['content']))).toContain(epsilon)
      expect(runsOf(facts)).toEqual({ ends: ['completed'], causes: ['user-message'] })

      // The wire: the probe and the round went to the instance's address and nowhere else (不变量 3);
      // the round's requests each offered Read and no WebSearch (不变量 15), and carried no
      // thinking parameter (不变量 11).
      expect(kept.hosts).toEqual([new URL(instance.baseURL).host])
      const wire = kept.requests.filter((request) => request.url.endsWith(instance.path))
      for (const request of wire) {
        expect(request.url.startsWith(`${instance.baseURL}/`)).toBe(true)
        expect(request.body?.model).toBe(instance.model)
      }
      // 验收 28 asks that one round trip completes, which the Tape above says; a 429 (1302) the loop
      // retried (§错误, up to 3 times) still completes it, so it stays in the record for 开放问题 2
      // rather than failing here. A 400 (an echo the endpoint refused) or any other error fails.
      const round = wire.slice(probeSent)
      const statuses = round.map((request) => request.status)
      expect(statuses.filter((status) => status !== 200 && status !== 429)).toEqual([])
      expect(round.at(-1)?.status).toBe(200)
      expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(2)
      for (const request of round) {
        expect(offeredTools(request.body)).toContain('Read')
        expect(offeredTools(request.body)).not.toContain('WebSearch')
        expect(request.body).not.toHaveProperty('thinking')
        expect(request.body).not.toHaveProperty('reasoning_effort')
      }
    })
  })
}

/**
 * M6 验收 29 (plan step 12, 〔DeepSeek live〕): an openai-chat instance on DeepSeek made from its
 * preset on the settings card; 「获取模型列表」 prefills deepseek-flash's two limits from GET /models
 * (`context_window`, `max_output_tokens`: §列表与上限); 「探测」 passes with usage seen and
 * `reasoning_content` or no thinking field (验收 29 as revised 2026-10-03: deepseek-flash streams an
 * empty `reasoning_content` in ① and thinks from ② on); then a task session with tools over two user
 * turns, each reading a file.
 *
 * DeepSeek thinks by default and documents a 400 for a request that carries tools without every
 * earlier assistant turn's `reasoning_content` — a turn that made no tool call included (vendor
 * research: api-docs.deepseek.com/guides/thinking_mode; M6 §错误's known limit is the other side of
 * it; deepseek-flash answered 200 either way on 2026-10-03). A passed row echoes under
 * `reasoning_content` whatever ① showed (§模型行「合成」; 推出的读法 16). The request record shows
 * it, not the fake network: every assistant turn that carried thinking goes back with it in every
 * later request, in order, the probe's ② included, and no request was answered 400.
 *
 * The key is TENON_LIVE_DEEPSEEK_KEY in this run's environment alone (plan「开工前读」key: the lead
 * reads it from the login keychain for that one run); `deepseekKey` fails the group when
 * `.env.local` holds it. It is typed into the create form on the in-memory secrets seam, never
 * handed to an app's environment. The record is the zhipu instance groups' plus the two prefilled
 * limits.
 */
const DEEPSEEK = {
  title: 'live custom vendor · deepseek openai-chat',
  preset: 'deepseek',
  region: 'default',
  wire: 'openai-chat',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  path: '/chat/completions',
} as const
/** A limit field as the card holds it once prefilled: a positive integer, in digits. */
const POSITIVE_INTEGER = /^[1-9]\d*$/
/** The model list's own bound (§列表与上限: response headers within 30 s), with room to show it. */
const LIST_MS = 60_000

/** A status the loop resends after (§错误): a 429, or a 5xx. */
function retried(status: number | null): boolean {
  return status === 429 || (status !== null && status >= 500)
}

/** A turn only a Read of `file` can answer. */
function readTurn(lead: string, file: string): string {
  return `${lead} the Read tool to read ${file}. Reply with the codeword in it and nothing else.`
}

/** Each `message/assistant`'s thinking text, in the order written. */
function assistantThinking(facts: readonly Fact[]): string[] {
  return named(facts, 'message/assistant').map((fact) =>
    (fact.payload['content'] as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === 'thinking')
      .map((block) => block.text ?? '')
      .join(''),
  )
}

test.describe(DEEPSEEK.title, () => {
  const key: InstanceKey = LIVE
    ? deepseekKey(process.env, fromFile)
    : { kind: 'absent', reason: 'opt-in' }
  test.skip(!LIVE, 'opt-in: run `pnpm test:live` with TENON_LIVE_DEEPSEEK_KEY in its environment')
  test.skip(
    LIVE && key.kind === 'absent',
    `skipped: ${key.kind === 'absent' ? key.reason : ''} (see the header of this file)`,
  )
  test.describe.configure({ timeout: 1_200_000 })

  let record: InstanceRecord | undefined
  let tree: FolderTree | undefined

  test.beforeAll(() => {
    // A key kept where it never goes fails the group rather than skipping it.
    if (key.kind === 'refused') throw new Error(`${DEEPSEEK.title}: ${key.reason}`)
  })

  test.afterEach(() => {
    if (record !== undefined) writeInstanceRecord(test.info(), record)
    record = undefined
    tree?.dispose()
    tree = undefined
  })

  test('preset, list, probe, two task turns with tools (M6 验收 29, deepseek-flash)', async () => {
    const alpha = codeword('ALPHA')
    const beta = codeword('BETA')
    const folders = makeFolderTree('live-instance-deepseek', {
      'ws/first.txt': `First notes.\nThe codeword is ${alpha}.\n`,
      'ws/second.txt': `Second notes.\nThe codeword is ${beta}.\n`,
    })
    tree = folders
    const workspace = join(folders.real, 'ws')
    const userData = makeUserDataDir('live-instance-deepseek')
    seedConfig(userData, { locale: 'en' })
    const kept: InstanceRecord = {
      date: new Date().toISOString(),
      wire: DEEPSEEK.wire,
      baseURL: DEEPSEEK.baseURL,
      model: DEEPSEEK.model,
      hosts: [],
      probe: null,
      requests: [],
      attempts: [],
      ends: [],
    }
    record = kept
    // No provider variable: the key goes in through the card, onto the in-memory secrets seam.
    const { app, page } = await launchTenon({
      userData,
      env: { TENON_MAX_TOKENS: AGENT_MAX_TOKENS },
      secrets: 'memory',
    })
    await recordRequests(app)
    let id = ''
    let probeSent = 0
    try {
      await page.getByTestId('account-row').click()
      await page.getByTestId('account-providers').click()
      await expect(page.getByTestId('custom-vendors')).toBeVisible()
      // The preset's address is read-only; the helper types the key only once the card shows it.
      id = await createInstanceInCard(page, {
        displayName: 'DeepSeek',
        preset: DEEPSEEK.preset,
        region: DEEPSEEK.region,
        wire: DEEPSEEK.wire,
        baseURL: DEEPSEEK.baseURL,
        apiKey: key.kind === 'ready' ? key.key : '',
      })
      // Creating it sent nothing (T7).
      expect(await requestsOf(app, '')).toHaveLength(0)

      // 「获取模型列表」: one GET, only now (T7); picking the model prefills both limits (§列表与上限).
      await page.getByTestId(`custom-vendor-fetch-${id}`).click()
      const fetched = page.getByTestId(`custom-vendor-fetched-${id}`)
      const message = page.getByTestId(`custom-vendor-message-${id}`)
      await expect(fetched.or(message).first()).toBeVisible({ timeout: LIST_MS })
      await expect(message).toHaveCount(0)
      expect(
        (await requestsOf(app, '')).map((sent) => `${sent.method} ${sent.url} ${sent.status}`),
      ).toEqual([`GET ${DEEPSEEK.baseURL}/models 200`])
      // Listed, or `selectOption` would wait out the whole case.
      await expect(fetched.locator(`option[value="${DEEPSEEK.model}"]`)).toHaveCount(1)
      await fetched.selectOption(DEEPSEEK.model)
      await expect(page.getByTestId(`custom-vendor-row-id-${id}`)).toHaveValue(DEEPSEEK.model)
      const prefilled = {
        contextLimit: await page.getByTestId(`custom-vendor-row-context-${id}`).inputValue(),
        maxOutputTokens: await page.getByTestId(`custom-vendor-row-output-${id}`).inputValue(),
      }
      kept.prefilled = prefilled
      expect(prefilled.contextLimit).toMatch(POSITIVE_INTEGER)
      expect(prefilled.maxOutputTokens).toMatch(POSITIVE_INTEGER)
      // Saved as prefilled, nothing typed over it.
      await page.getByTestId(`custom-vendor-row-save-${id}`).click()
      const row = `${id}-${DEEPSEEK.model}`
      await expect(page.getByTestId(`custom-vendor-row-${row}`)).toBeVisible()
      expect(await rowOf(page, id, DEEPSEEK.model)).toMatchObject({
        contextLimit: Number(prefilled.contextLimit),
        maxOutputTokens: Number(prefilled.maxOutputTokens),
      })

      // 「探测」: over once the row shows a stored snapshot, or the probe's answer beside it.
      await page.getByTestId(`custom-vendor-probe-${row}`).click()
      await expect(
        page
          .locator(`[data-testid="custom-vendor-probe-status-${row}"]:not([data-outcome="none"])`)
          .or(page.getByTestId(`custom-vendor-probe-answer-${row}`))
          .first(),
      ).toBeVisible({ timeout: PROBE_MS })
      kept.probe = await probeOf(page, id, DEEPSEEK.model)
      probeSent = (await requestsOf(app, DEEPSEEK.path)).length
      expect(kept.probe).toMatchObject({ outcome: 'passed', reason: null, usageSeen: true })
      // 验收 29: `reasoning_content`, or none when the model did not think in ①; never `reasoning`.
      expect(['reasoning_content', null]).toContain(kept.probe?.['reasoningField'])
      await page.getByTestId('provider-cancel').click()
      await expect(page.getByTestId('provider-settings')).toBeHidden()

      // Two user turns on the probed row, each with a Read: the second carries the first's turns.
      await startTask(app, page, workspace)
      await page.getByTestId('model-menu-trigger').click()
      const choice = page.getByTestId(`model-row-${row}`)
      await expect(choice).not.toHaveAttribute('aria-disabled', 'true')
      await choice.click()
      await expect(page.getByTestId('model-menu')).toBeHidden()
      await expect(page.getByTestId('model-menu-current')).toHaveText(DEEPSEEK.model)
      await expect(page.getByTestId('composer-send-block')).toHaveCount(0)
      await send(page, readTurn('Use', join(workspace, 'first.txt')))
      await settles(page, alpha)
      await send(page, readTurn('Now use', join(workspace, 'second.txt')))
      await settles(page, beta)
      // A Read in the workspace asks nothing.
      await expect(page.getByTestId('approval-card')).toHaveCount(0)
      await expect(page.getByTestId('failure-card')).toHaveCount(0)
      await expect(page.getByTestId('message-error')).toHaveCount(0)
    } finally {
      try {
        const sent = await requestsOf(app, '')
        kept.hosts = [...new Set(sent.map((request) => new URL(request.url).host))]
        kept.requests = sent
      } finally {
        await app.close()
      }
    }

    const facts = tapeFacts(userData)
    kept.attempts = named(facts, 'provider/attempt_completed').map((fact) => fact.payload)
    kept.ends = named(facts, 'execution/run_terminal').map((fact) => fact.payload['reason'])

    // The Tape: two Runs on the probed row, with the tools (M6 §不发工具), at its own origin (不变量 3).
    const selected = {
      providerId: id,
      modelId: DEEPSEEK.model,
      capabilitySource: 'probed',
      endpointOrigin: DEEPSEEK.baseURL,
    }
    expect(named(facts, 'session/model_selected').map((fact) => fact.payload)).toEqual([
      selected,
      selected,
    ])
    expect(named(facts, 'view/tools_withheld')).toHaveLength(0)
    const calls = named(facts, 'tool/call')
    expect(calls.filter((fact) => fact.payload['name'] === 'Read').length).toBeGreaterThanOrEqual(2)
    const results = named(facts, 'tool/result')
    expect(results.map((fact) => fact.payload['providerToolCallId'])).toEqual(
      calls.map((fact) => fact.payload['providerToolCallId']),
    )
    const read = JSON.stringify(results.map((fact) => fact.payload['content']))
    expect(read).toContain(alpha)
    expect(read).toContain(beta)
    expect(runsOf(facts)).toEqual({
      ends: ['completed', 'completed'],
      causes: ['user-message', 'user-message'],
    })

    // The wire: the list, the probe and both turns went to the preset's address alone (不变量 3),
    // and no request was answered 400 — DeepSeek's answer to an echo left out (验收 29).
    expect(kept.hosts).toEqual([new URL(DEEPSEEK.baseURL).host])
    expect(kept.requests.map((request) => request.status)).not.toContain(400)
    const chat = kept.requests.filter((request) => request.url.endsWith(DEEPSEEK.path))
    for (const request of chat) {
      expect(request.url.startsWith(`${DEEPSEEK.baseURL}/`)).toBe(true)
      expect(request.body?.model).toBe(DEEPSEEK.model)
    }
    // A 429 or 5xx the loop retried (§错误) still lets a turn complete, as the Tape says it did;
    // anything else fails. Each turn is at least a call and its answer.
    const round = chat.slice(probeSent)
    const statuses = round.map((request) => request.status)
    expect(statuses.filter((status) => status !== 200 && !retried(status))).toEqual([])
    expect(round.at(-1)?.status).toBe(200)
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(4)
    for (const request of round) {
      expect(offeredTools(request.body)).toContain('Read')
      expect(offeredTools(request.body)).not.toContain('WebSearch')
      // No thinking parameter (不变量 11): DeepSeek thinks by default.
      expect(request.body).not.toHaveProperty('thinking')
      expect(request.body).not.toHaveProperty('reasoning_effort')
    }

    // 验收 29「凡带思考内容的助手轮，之后每次请求都以 reasoning_content 回传」: the probe's ② carries
    // ①'s turn back with its thinking when ① thought (the snapshot names the field) and with none
    // when it did not.
    const probeTwo = chat.slice(0, probeSent).filter((request) => {
      return echoedReasoning(request.body).length > 0
    })
    expect(probeTwo).toHaveLength(1)
    const thoughtInOne = kept.probe?.['reasoningField'] === 'reasoning_content'
    expect(echoGaps(probeTwo.map((request) => request.body))).toEqual(
      thoughtInOne ? [] : [{ request: 0, turn: 0 }],
    )
    // Each session request carries the Tape's thinking of the turns before it, in order, a turn
    // that did not think with none; the last one all of them but its own answer's: the first
    // turn's reply, which made no tool call, among them.
    const thinking = assistantThinking(facts)
    expect(thinking.length).toBeGreaterThanOrEqual(4)
    const expected = expectedEchoes(thinking)
    expect(echoedReasoning(round[0]?.body ?? null)).toEqual([])
    for (const request of round) {
      const echoed = echoedReasoning(request.body)
      expect(echoed).toEqual(expected.slice(0, echoed.length))
    }
    const last = round.at(-1)?.body ?? null
    expect(echoedReasoning(last)).toEqual(expected.slice(0, -1))
    // The echo was exercised: some earlier turn thought, and it went back.
    expect(echoedReasoning(last).some((text) => text !== null)).toBe(true)
    expect(
      last?.messages?.some(
        (message) => message.role === 'assistant' && (message.tool_calls ?? []).length === 0,
      ),
    ).toBe(true)
  })
})

/** Step 28: official protocol probe, one request per model and no SDK retries or main Tape. */
test.describe('live search probe · anthropic official', () => {
  test.describe.configure({ timeout: 180_000 })
  const group = LIVE ? officialGroup(process.env, fromFile, pick, MAX_TOKENS) : NOT_LIVE
  test.skip(group.kind === 'absent', group.kind === 'absent' ? group.reason : '')
  for (const modelId of ['claude-sonnet-5', 'claude-opus-5']) {
    test(`forced search with ${modelId} records uncapped output usage`, async () => {
      const testInfo = test.info()
      if (group.kind !== 'ready') throw new Error('Official search probe configuration refused')
      const model = anthropicDefinition.builtinModels.find((row) => row.id === modelId)
      if (model === undefined) throw new Error('Official search probe model is missing')
      const request = {
        model: modelId,
        max_tokens: model.maxOutputTokens,
        stream: false,
        ...(modelId === 'claude-sonnet-5' ? { thinking: { type: 'disabled' } } : {}),
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
        tool_choice: { type: 'any' },
        messages: [
          {
            role: 'user',
            content:
              'Search for the official TypeScript website. Return one relevant link briefly.',
          },
        ],
      }
      const response = await globalThis.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': group.env['ANTHROPIC_API_KEY'] ?? '',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(150_000),
      })
      const body = (await response.json()) as {
        stop_reason?: string
        usage?: { input_tokens?: number; output_tokens?: number; server_tool_use?: unknown }
        content?: { type: string; content?: unknown }[]
        error?: { type?: string }
      }
      const record = {
        model: modelId,
        status: response.status,
        maxTokens: model.maxOutputTokens,
        thinking: request.thinking ?? 'default',
        stopReason: body.stop_reason ?? null,
        usage: body.usage ?? null,
        errorType: body.error?.type ?? null,
        searchBlocks: (body.content ?? [])
          .filter((block) => block.type === 'web_search_tool_result')
          .map((block) => ({
            successful: Array.isArray(block.content),
            hits: Array.isArray(block.content) ? block.content.length : 0,
          })),
      }
      const output = pick('TENON_LIVE_RECORD_DIR')
      const destination =
        output === undefined
          ? testInfo.outputPath(`${modelId}-search-probe.json`)
          : join(output, `${modelId}-search-probe.json`)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, JSON.stringify(record, null, 2))
      process.stderr.write(`${JSON.stringify(record)}\n`)
      expect(response.status).toBe(200)
      expect(record.searchBlocks.some((block) => block.successful)).toBe(true)
      expect(body.stop_reason).not.toBe('pause_turn')
      expect(body.stop_reason).not.toBe('max_tokens')
      expect(body.usage?.output_tokens).toBeGreaterThan(0)
    })
  }
})

/** Steps 30/33: exercise the specified summary prefix before wiring compaction into the loop. */
test.describe('live compaction prefix probe · anthropic official', () => {
  test.describe.configure({ timeout: 600_000 })
  const group = LIVE ? officialGroup(process.env, fromFile, pick, MAX_TOKENS) : NOT_LIVE
  test.skip(group.kind === 'absent', group.kind === 'absent' ? group.reason : '')
  test('Opus 5.5 classifies prefix enforcement and accepts a thinking-free summary', async () => {
    if (group.kind !== 'ready') throw new Error('Official prefix probe configuration refused')
    type Block = { type: string; id?: string; signature?: string; [key: string]: unknown }
    type Message = { role: 'user' | 'assistant'; content: string | Block[] }
    type Answer = {
      content?: Block[]
      stop_reason?: string
      usage?: Record<string, unknown>
      input_transformations?: unknown[]
      error?: { type?: string; message?: string }
    }
    const model = 'claude-opus-5-5'
    const rows: unknown[] = []
    const base = {
      model,
      max_tokens: 4096,
      stream: false,
      system: 'You are a protocol test assistant. Follow the user task briefly.',
      tools: [
        {
          name: 'lookup',
          description: 'Returns a public fixture value for the computed counts. Call once.',
          input_schema: {
            type: 'object',
            properties: { total: { type: 'integer' }, odd: { type: 'integer' } },
            required: ['total', 'odd'],
            additionalProperties: false,
          },
        },
      ],
    }
    const request = async (label: string, body: Record<string, unknown>, strict = false) => {
      const response = await globalThis.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': group.env['ANTHROPIC_API_KEY'] ?? '',
          ...(strict ? { 'anthropic-beta': 'thinking-binding-controls-2026-08-01' } : {}),
        },
        body: JSON.stringify({
          ...body,
          ...(strict
            ? {
                thinking: {
                  type: 'adaptive',
                  block_binding: { prefix_mismatch_behavior: 'error' },
                },
              }
            : {}),
        }),
        signal: AbortSignal.timeout(150_000),
      })
      const answer = (await response.json()) as Answer
      rows.push({
        label,
        date: new Date().toISOString(),
        host: 'api.anthropic.com',
        model,
        status: response.status,
        strict,
        usage: answer.usage ?? null,
        stopReason: answer.stop_reason ?? null,
        errorType: answer.error?.type ?? null,
        mentionsBindingHeader:
          answer.error?.message?.includes('thinking-binding-controls') ?? false,
        inputTransformationCount: answer.input_transformations?.length ?? 0,
        blocks: (answer.content ?? []).map((block) => ({
          type: block.type,
          signed: typeof block.signature === 'string' && block.signature.length > 0,
          emptyThinking: block.type === 'thinking' ? block['thinking'] === '' : undefined,
        })),
      })
      return { status: response.status, answer }
    }
    try {
      const messages: Message[] = [
        {
          role: 'user',
          content:
            'Determine how many positive integers below 500 have exactly six positive divisors, and how many of those are odd. Call lookup exactly once with these two counts as total and odd. After its result reply DONE.',
        },
      ]
      const first = await request('signed-tool-call', { ...base, messages })
      expect(first.status).toBe(200)
      expect(first.answer.stop_reason).toBe('tool_use')
      expect(
        first.answer.content?.some(
          (block) =>
            block.type === 'thinking' &&
            typeof block.signature === 'string' &&
            block.signature.length > 0,
        ),
      ).toBe(true)
      const calls = first.answer.content?.filter((block) => block.type === 'tool_use') ?? []
      expect(calls).toHaveLength(1)
      messages.push(
        { role: 'assistant', content: first.answer.content ?? [] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: calls[0]?.id, content: 'PUBLIC_FIXTURE_VALUE' },
          ],
        },
      )
      const changed = await request('changed-prefix-account-check', {
        ...base,
        system: `${base.system} The prefix has deliberately changed.`,
        messages,
      })
      expect([200, 400]).toContain(changed.status)
      const strict = changed.status === 200
      if (!strict)
        expect(changed.answer.error?.message?.includes('thinking-binding-controls')).toBe(true)
      const completion = await request('original-prefix-tool-result', { ...base, messages }, strict)
      expect(completion.status).toBe(200)
      expect(completion.answer.stop_reason).toBe('end_turn')
      expect(
        strict
          ? completion.answer.input_transformations
          : (completion.answer.input_transformations ?? []),
      ).toEqual([])
      messages.push({ role: 'assistant', content: completion.answer.content ?? [] })
      const summaryMessages = messages.map((message) => ({
        role: message.role,
        content: Array.isArray(message.content)
          ? message.content.filter(
              (block) => !['thinking', 'redacted_thinking'].includes(block.type),
            )
          : message.content,
      }))
      summaryMessages.push({
        role: 'user',
        content: 'Summarize this completed task in one sentence.',
      })
      const summary = await request(
        'summary-without-thinking-or-tools',
        { model, max_tokens: 4096, stream: false, system: base.system, messages: summaryMessages },
        strict,
      )
      expect(summary.status).toBe(200)
      expect(summary.answer.stop_reason).toBe('end_turn')
      expect(
        strict
          ? summary.answer.input_transformations
          : (summary.answer.input_transformations ?? []),
      ).toEqual([])
    } finally {
      const output = pick('TENON_LIVE_RECORD_DIR')
      const destination =
        output === undefined
          ? test.info().outputPath('compaction-prefix-probe.json')
          : join(output, 'compaction-prefix-probe.json')
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, JSON.stringify(rows, null, 2))
      process.stderr.write(`${JSON.stringify(rows)}\n`)
    }
  })
})
