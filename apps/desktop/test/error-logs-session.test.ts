/**
 * Real sessions against the log (docs/features/error-logs/spec.md §记什么, §不记; acceptance 4 and
 * 7): what a conversation leaves in `main.jsonl`, and what a failed model request does.
 *
 * Everything on the model's side of the wire is the real thing: the kernel's loop, its Anthropic
 * adapter, the host's network seam, the chat and provider routes — the harness of `chat.test.ts`.
 * The fake is the other end of the socket (`support/fake-anthropic.ts`, which answers what each
 * request is scripted to) and a memory host. The app log is a real `createAppLog` on a real
 * folder, handed to the same callbacks `index.ts` hands the console to: the kernel's `log` (as
 * source `kernel`), the connector's, the loop's and the routes'; the host's secrets are wrapped by
 * `rememberingSecrets` as `createDesktopHost` wraps them. A resend waits on the host's clock, which
 * is moved on by hand once the fake has cut a connection.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  absolutePath,
  createMemoryHost,
  createMemoryTapeStore,
  createProviderRegistry,
  createSessionService,
  registerBuiltinProviders,
} from '@tenon-app/kernel'
import type { CommandShell } from '@tenon-app/kernel'
import type { ChatEvent, IpcMainLike } from '@tenon-app/contracts'
import { afterEach, expect, it } from 'vitest'
import { createDesktopLoop, registerChatRoutes } from '../src/main/chat.js'
import { createProviderView } from '../src/main/custom-vendors/registry.js'
import { readConfig } from '../src/main/host/profile.js'
import { registerProviderRoutes } from '../src/main/provider-routes.js'
import { createRunConnector } from '../src/main/run-assembly.js'
import { registerSessionRoutes } from '../src/main/session.js'
import { startFakeAnthropic } from './support/fake-anthropic.js'
import type { FakeAnthropic } from './support/fake-anthropic.js'
import { ANTHROPIC_ORIGIN, seamNetwork } from './support/seam-network.js'
import {
  leaksIn,
  logRouteFailures,
  openLog,
  readRecords,
  rememberingSecrets,
  sweepTempRoots,
} from './support/error-logs.js'

/** These cases run no Bash: the shell is a stand-in. */
const NO_SHELL: CommandShell = { path: absolutePath('/bin/sh'), env: () => Promise.resolve({}) }

let fake: FakeAnthropic | undefined
const drivers: Array<() => void> = []
afterEach(async () => {
  for (const stop of drivers.splice(0)) stop()
  await fake?.close()
  fake = undefined
  sweepTempRoots()
})

type Handler = (event: unknown, ...args: unknown[]) => unknown

/** The chat stream as the renderer would see it, with a way to wait for an event type. */
function collector(): {
  readonly events: ChatEvent[]
  send(channel: string, payload: unknown): void
  waitFor(type: ChatEvent['type']): Promise<ChatEvent>
} {
  const events: ChatEvent[] = []
  const waiters: Array<{ type: ChatEvent['type']; resolve: (event: ChatEvent) => void }> = []
  return {
    events,
    send(channel, payload) {
      if (channel !== 'chat.event') return
      const event = payload as ChatEvent
      events.push(event)
      const matched = waiters.filter((waiter) => waiter.type === event.type)
      for (const waiter of matched) waiters.splice(waiters.indexOf(waiter), 1)
      for (const waiter of matched) waiter.resolve(event)
    },
    waitFor(type) {
      const existing = events.find((event) => event.type === type)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise((resolve) => waiters.push({ type, resolve }))
    },
  }
}

/**
 * The whole path of a conversation, wired the way `index.ts` wires it, with the app log where
 * the console was.
 */
async function conversation(server: FakeAnthropic, env: Record<string, string> = {}) {
  const { log, dir } = openLog({ packaged: true })
  const memory = createMemoryHost({ network: seamNetwork({ [ANTHROPIC_ORIGIN]: server.baseURL }) })
  const host = { ...memory, secrets: rememberingSecrets(memory.secrets, log) }
  await host.fs.mkdirp(absolutePath(host.identity.profileDir))
  const providers = createProviderRegistry()
  registerBuiltinProviders(providers)

  const kernel = log.line('kernel', 'error')
  const sessions = createSessionService({
    host,
    tape: createMemoryTapeStore({ identity: host.identity }),
    ids: { uuid: (): string => randomUUID() },
    inspectors: [],
    connector: createRunConnector({
      host,
      providers,
      env,
      log: log.line('provider', 'warn'),
    }),
    protectedFiles: [],
    log: kernel,
  })

  // A failed request is sent again after a wait on the host's clock: move the clock on, once for
  // each connection the fake cut.
  let moved = 0
  const driver = setInterval(() => {
    if (server.cuts > moved) {
      moved = server.cuts
      setTimeout(() => memory.advance(5_000), 30)
    }
  }, 10)
  drivers.push(() => clearInterval(driver))

  const handlers = new Map<string, Handler>()
  const base: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
  }
  const routes = logRouteFailures(base, log)
  const out = collector()
  const loop = createDesktopLoop({
    clock: host.clock,
    send: out.send,
    locale: () => 'en',
    commandShell: NO_SHELL,
    log: log.line('chat', 'warn'),
  })
  sessions.bindLoop(loop.ports)
  registerChatRoutes({
    send: out.send,
    ipcMain: routes,
    sessions,
    loop,
    log: log.line('chat', 'warn'),
  })
  registerSessionRoutes({ ipcMain: routes, sessions })
  registerProviderRoutes({
    ipcMain: routes,
    host,
    providers: createProviderView({
      builtin: providers,
      identity: host.identity,
      config: await readConfig(host.fs, host.identity),
    }),
    env: {},
    isPackaged: false,
    log: log.line('provider', 'warn'),
  })
  return {
    log,
    dir,
    out,
    sessionId: randomUUID(),
    async call(channel: string, payload: unknown): Promise<unknown> {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`no handler for ${channel}`)
      return await handler({}, payload)
    },
  }
}

it('error-logs 验收 7: a failed provider attempt logs code, status and detail without the key', async () => {
  const KEY = 'wrong-key-from-the-card-ZQ7'
  fake = await startFakeAnthropic({
    chunks: [],
    failWith: {
      status: 401,
      type: 'authentication_error',
      message: `invalid x-api-key: ${KEY} was refused`,
    },
  })
  const { call, out, dir, sessionId } = await conversation(fake)

  // The user saves a key that is wrong, on the settings card, and sends a message.
  expect(
    await call('provider.configure', { id: 'anthropic', values: { apiKey: KEY } }),
  ).toMatchObject({ ok: true })
  await call('chat.send', { sessionId, text: 'hello there' })
  expect(await out.waitFor('error')).toMatchObject({ code: 'auth' })
  // The key was really sent, so it really could have been in the line.
  expect(fake.requests[0]?.headers['x-api-key']).toBe(KEY)
  const body = fake.requests[0]?.body as { model: string }
  const model = body.model

  const failed = readRecords(join(dir, 'main.jsonl')).filter(
    (r) => r.event === 'line' && String(r['text']).includes('attempt failed'),
  )
  expect(failed).toHaveLength(1)
  expect(failed[0]).toMatchObject({ source: 'kernel', level: 'error' })
  const text = String(failed[0]?.['text'])
  expect(text).toMatch(/^\[provider\] run [0-9a-f-]{36} attempt failed: /)
  const rest = text.replace(/^\[provider\] run [0-9a-f-]{36} attempt failed: /, '')
  expect(
    rest.startsWith(`provider=anthropic model=${model} code=auth status=401 providerCode=`),
  ).toBe(true)
  expect(rest).toMatch(/ retryable=false detail=\S/)
  expect(leaksIn(dir, [KEY])).toEqual([])
})

it(
  'error-logs 验收 4: a real session with a fake model leaves no message, reply or tool argument in the log',
  { timeout: 30_000 },
  async () => {
    const stopped = Array.from({ length: 500 }, (_, i) => `w${i} STOPPED_REPLY_ZQX `)
    fake = await startFakeAnthropic({
      replies: [
        // A tool call, with its argument.
        {
          steps: [
            {
              type: 'tool_use',
              id: 'toolu_zqx',
              name: 'Read',
              input: { file_path: '/nowhere/TOOL_ARG_ZQX.txt' },
            },
          ],
          delayMs: 5,
        },
        // A request that fails after a few words, and is sent again.
        { steps: [{ type: 'text', text: 'PARTIAL_REPLY_ZQX ' }, { type: 'cut' }], delayMs: 5 },
        { steps: [{ type: 'text', text: ['ASSISTANT_REPLY_ZQX ', 'done'] }], delayMs: 5 },
        // A reply that the user stops half way.
        {
          steps: [
            { type: 'thinking', thinking: 'THINKING_ZQX', signature: 'sig' },
            { type: 'text', text: stopped },
          ],
          delayMs: 30,
        },
      ],
    })
    // A development build's key from the environment, so the session needs no card.
    const { call, out, dir, sessionId } = await conversation(fake, {
      ANTHROPIC_API_KEY: 'session-test-key',
    })

    await call('chat.send', { sessionId, text: 'USER_MSG_ONE_ZQX please read a file' })
    expect(await out.waitFor('done')).toMatchObject({ endReason: { code: 'completed' } })
    const first = out.events
      .filter((e): e is Extract<ChatEvent, { type: 'text-delta' }> => e.type === 'text-delta')
      .map((e) => e.delta)
      .join('')
    expect(first).toContain('ASSISTANT_REPLY_ZQX')
    out.events.length = 0

    await call('chat.send', { sessionId, text: 'USER_MSG_TWO_ZQX now another' })
    await out.waitFor('text-delta')
    expect(await call('chat.stop', { sessionId })).toEqual({ ok: true, data: { stopped: true } })
    expect(await out.waitFor('done')).toMatchObject({ stopReason: 'aborted' })
    expect(fake.requests).toHaveLength(4)

    // The log did see this session: the failed request that was sent again is in it, once.
    const retried = readRecords(join(dir, 'main.jsonl')).filter(
      (r) => r.event === 'line' && String(r['text']).includes('attempt failed'),
    )
    expect(retried).toHaveLength(1)
    expect(String(retried[0]?.['text'])).toContain('retryable=true')

    // And nothing of what was said, answered, thought or passed to the tool is.
    expect(
      leaksIn(dir, [
        'USER_MSG_ONE_ZQX',
        'USER_MSG_TWO_ZQX',
        'PARTIAL_REPLY_ZQX',
        'ASSISTANT_REPLY_ZQX',
        'STOPPED_REPLY_ZQX',
        'THINKING_ZQX',
        'TOOL_ARG_ZQX',
      ]),
    ).toEqual([])
  },
)
