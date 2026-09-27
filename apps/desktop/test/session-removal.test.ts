/**
 * Clearing and deleting a session with its tool-output folder (spec 02 §大响应落盘「删除是 host 的义务」,
 * §本地持久化布局：只加一行; plan step 24, 旧 189; acceptance 43's deletion half). The store is the
 * desktop's SQLite one in a temporary profile, the kernel is the real loop, the RunRegistry is
 * chat.ts's. The spilled files are written here with plain fs: the kernel's spill writer is not what
 * is under test.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  absolutePath,
  createEntryWriter,
  createMemoryHost,
  messageRetractedKey,
  toolOutputDirFor,
} from '@tenon-app/kernel'
import type {
  AbsolutePath,
  CommandShell,
  HostFs,
  ModelInfo,
  SessionService,
  TapeStore,
} from '@tenon-app/kernel'
import {
  createCounterIds,
  createScriptedProvider,
  createTestConnector,
  createTestSessionService,
  scriptedTurn,
} from '@tenon-app/kernel/testing'
import type { IpcMainLike } from '@tenon-app/contracts'
import { parseAst, transformWithEsbuild } from 'vite'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { registerApprovalRoutes } from '../src/main/approval-routes.js'
import { createDesktopLoop, createRunRegistry, registerChatRoutes } from '../src/main/chat.js'
import type { DesktopLoop } from '../src/main/chat.js'
import {
  REFUSED_WHILE_REMOVING,
  createSessionRemoval,
  refuseWhileRemoving,
  removeFolder,
} from '../src/main/session-removal.js'
import type { SessionRemoval } from '../src/main/session-removal.js'
import { openStore, removeTempProfiles } from './tape/fixtures.js'

const MODEL: ModelInfo = {
  id: 'claude-removal-1',
  providerId: 'anthropic',
  contextLimit: 200_000,
  maxOutputTokens: 1024,
  reasoning: false,
  supportsToolCalling: true,
  supportsStreamingToolCalls: true,
  supportsVision: false,
  supportsCacheControl: false,
  thinkingPreservationFormat: 'drop',
  usageNeedsOptIn: false,
}

const NO_SHELL: CommandShell = { path: absolutePath('/bin/sh'), env: () => Promise.resolve({}) }

/** What a route refused during a removal answers. */
const REFUSED = {
  ok: false,
  error: { code: 'handler-failed', message: 'the session is being cleared or deleted' },
}

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- one store after another
    await close()
  }
  removeTempProfiles()
})

async function flush(): Promise<void> {
  for (let hop = 0; hop < 3; hop += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one macrotask after another
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  }
}

function fakeIpc(): {
  ipcMain: IpcMainLike
  call(channel: string, payload: unknown): Promise<unknown>
} {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
    async call(channel, payload) {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`no handler for ${channel}`)
      return handler({}, payload)
    },
  }
}

/** The service, each method the routes called recorded by name. */
function recorded(sessions: SessionService): { sessions: SessionService; reached: string[] } {
  const reached: string[] = []
  const proxy = new Proxy(sessions, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        reached.push(String(property))
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  return { sessions: proxy, reached }
}

/** The store, its appends counted. */
function counted(inner: TapeStore): { store: TapeStore; appends(): number } {
  let appends = 0
  const store = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'append') {
        return (batch: Parameters<TapeStore['append']>[0]) => {
          appends += 1
          return target.append(batch)
        }
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { store, appends: () => appends }
}

interface Rig {
  readonly profileDir: AbsolutePath
  readonly store: TapeStore
  readonly appends: () => number
  readonly kernel: SessionService
  readonly reached: string[]
  readonly provider: ReturnType<typeof createScriptedProvider>
  readonly loop: DesktopLoop
  readonly removal: SessionRemoval
  readonly ipc: ReturnType<typeof fakeIpc>
  /** In order: `store committed`, `rm <folder>`, `removed`, as each happened. */
  readonly order: string[]
  readonly log: string[]
  /** Step 2 waits for this; open unless a test holds it. */
  readonly folderGate: { hold(): void; release(): void }
}

/**
 * Main's wiring, as index.ts does it: the removal over the service, its `removing` into the
 * RunRegistry and around the route table, the chat and approval routes on that table.
 */
function rig(
  options: { sessions?: Pick<SessionService, 'resetSession' | 'deleteSession'> } = {},
): Rig {
  const opened = openStore({ label: 'removal' })
  closers.push(() => opened.store.close())
  const profileDir = absolutePath(opened.profileDir)
  const tape = counted(opened.store)
  const host = createMemoryHost()
  const provider = createScriptedProvider({ models: [MODEL] })
  const kernel = createTestSessionService(
    {
      host,
      tape: tape.store,
      ids: createCounterIds(),
      inspectors: [],
      connector: createTestConnector({ provider, model: MODEL }),
      protectedFiles: [],
    },
    { tools: {} },
  )
  const { sessions, reached } = recorded(kernel)
  const order: string[] = []
  const log: string[] = []
  let gate: PromiseWithResolvers<void> | null = null
  // The kernel's own reset and delete, each noted once the store committed it.
  const commits = options.sessions ?? kernel
  const removal = createSessionRemoval({
    sessions: {
      resetSession: async (sessionId) => {
        const incarnation = await commits.resetSession(sessionId)
        order.push('store committed')
        return incarnation
      },
      deleteSession: async (sessionId) => {
        await commits.deleteSession(sessionId)
        order.push('store committed')
      },
    },
    profileDir,
    log: (line) => log.push(line),
    removeFolder: async (folder) => {
      order.push(`rm ${relative(profileDir, folder)}`)
      if (gate !== null) await gate.promise
      await removeFolder(folder)
      order.push('removed')
    },
  })
  const loop = createDesktopLoop({
    clock: host.clock,
    send: () => {},
    locale: () => 'en',
    commandShell: NO_SHELL,
    removing: (root) => removal.removing(root),
    log: () => {},
  })
  kernel.bindLoop(loop.ports)
  const ipc = fakeIpc()
  const routes = refuseWhileRemoving(ipc.ipcMain, (sessionId) => removal.removing(sessionId))
  registerChatRoutes({ send: () => {}, ipcMain: routes, sessions, loop, log: () => {} })
  registerApprovalRoutes({ ipcMain: routes, sessions })
  return {
    profileDir,
    store: opened.store,
    appends: tape.appends,
    kernel,
    reached,
    provider,
    loop,
    removal,
    ipc,
    order,
    log,
    folderGate: {
      hold: () => {
        gate = Promise.withResolvers<void>()
      },
      release: () => gate?.resolve(),
    },
  }
}

/** One message and its reply, so the session exists; the Run is over when this returns. */
async function converse(r: Rig, sessionId: string, text: string): Promise<void> {
  r.provider.script(scriptedTurn({ deltas: [`re: ${text}`] }))
  expect(await r.ipc.call('chat.send', { sessionId, text })).toEqual({
    ok: true,
    data: { accepted: true, status: 'started' },
  })
  await expect.poll(() => r.loop.registry.snapshot()).toEqual([])
}

/** What a spill of `sessionId` leaves: `tool-output/<sessionId>/<runId>-<requestSeq>-<i>.txt`. */
function spill(r: Rig, sessionId: string, text: string): string {
  const folder = toolOutputDirFor(r.profileDir, sessionId)
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `${randomUUID()}-1-0.txt`)
  writeFileSync(file, text)
  return file
}

/** A valid request for every route refused during a removal. */
function sendRequests(sessionId: string): Array<[string, unknown]> {
  return [
    ['chat.send', { sessionId, text: 'one more' }],
    ['chat.sendNow', { sessionId, text: 'now', runId: null }],
    ['chat.queue.act', { sessionId, queuedId: 'q-1', action: 'send-now', runId: null }],
    ['chat.continue', { sessionId }],
    ['approval.respond', { kind: 'approval', sessionId, requestId: 'r-1', decision: 'allow' }],
    ['approval.resume', { sessionId }],
  ]
}

describe('clearing a session: store commit → folder removed → done (旧 189)', () => {
  it('removes the folder only after the store committed, and completes only after that', async () => {
    const r = rig()
    const session = randomUUID()
    const other = randomUUID()
    await converse(r, session, 'hello')
    await converse(r, other, 'elsewhere')
    const mine = [spill(r, session, 'A'.repeat(40_000)), spill(r, session, 'B')]
    const theirs = spill(r, other, 'C')
    r.folderGate.hold()

    let done = false
    const cleared = r.removal.clear(session).then((incarnation) => {
      r.order.push('done')
      done = true
      return incarnation
    })
    await expect.poll(() => r.order.length).toBe(2)
    expect(r.order).toEqual(['store committed', `rm tool-output/${session}`])
    // The store has the new incarnation: its facts and messages are gone...
    expect(await r.kernel.listMessages({ sessionId: session, limit: 10 })).toEqual([])
    // ...and the operation is not complete while the folder is still going.
    await flush()
    expect(done).toBe(false)
    expect(r.removal.removing(session)).toBe(true)
    expect(mine.every((file) => existsSync(file))).toBe(true)

    r.folderGate.release()
    const incarnation = await cleared
    expect(r.order).toEqual(['store committed', `rm tool-output/${session}`, 'removed', 'done'])
    expect(incarnation.sessionId).toBe(session)
    expect(existsSync(toolOutputDirFor(r.profileDir, session))).toBe(false)
    // Another session's folder is not touched.
    expect(readFileSync(theirs, 'utf8')).toBe('C')
    expect(r.removal.removing(session)).toBe(false)
    expect(r.log).toEqual([])
  })

  it('leaves a file the new incarnation spills right after the clear, and takes its sends', async () => {
    const r = rig()
    const session = randomUUID()
    await converse(r, session, 'hello')
    spill(r, session, 'old')
    await r.removal.clear(session)
    // Same session id, new incarnation: its first spill lands in the same folder name at once.
    const fresh = spill(r, session, 'new')
    await flush()
    expect(readFileSync(fresh, 'utf8')).toBe('new')
    expect(readdirSync(toolOutputDirFor(r.profileDir, session))).toHaveLength(1)
    // Complete, so the session takes a send again, into the new incarnation.
    await converse(r, session, 'again')
    const messages = await r.kernel.listMessages({ sessionId: session, limit: 10 })
    expect(messages.map((row) => row.role)).toEqual(['user', 'assistant'])
    expect(existsSync(fresh)).toBe(true)
  })
})

describe('deleting a session: store commit → folder removed → done (旧 189)', () => {
  it('removes the folder after the store deleted the session, and completes after that', async () => {
    const r = rig()
    const session = randomUUID()
    const other = randomUUID()
    await converse(r, session, 'hello')
    await converse(r, other, 'elsewhere')
    spill(r, session, 'A')
    const theirs = spill(r, other, 'C')
    r.folderGate.hold()

    let done = false
    const deleted = r.removal.delete(session).then(() => {
      r.order.push('done')
      done = true
    })
    await expect.poll(() => r.order.length).toBe(2)
    expect(r.order).toEqual(['store committed', `rm tool-output/${session}`])
    expect(await r.store.head(session)).toBeNull()
    await flush()
    expect(done).toBe(false)
    expect(r.removal.removing(session)).toBe(true)

    r.folderGate.release()
    await deleted
    expect(r.order).toEqual(['store committed', `rm tool-output/${session}`, 'removed', 'done'])
    expect(existsSync(toolOutputDirFor(r.profileDir, session))).toBe(false)
    expect(readFileSync(theirs, 'utf8')).toBe('C')
    expect(r.removal.removing(session)).toBe(false)
  })
})

describe('until a clear or a delete completes, the session takes no send (旧 189)', () => {
  for (const operation of ['clear', 'delete'] as const) {
    it(`${operation}: every send route answers ok: false, and nothing reaches the kernel`, async () => {
      const r = rig()
      const session = randomUUID()
      const other = randomUUID()
      await converse(r, session, 'hello')
      r.folderGate.hold()
      const removal = r.removal[operation](session)
      await expect.poll(() => r.order.length).toBe(2)
      const appends = r.appends()
      const starts = r.provider.starts
      r.reached.length = 0

      for (const [channel, payload] of sendRequests(session)) {
        // oxlint-disable-next-line no-await-in-loop -- one route at a time, each on its own
        expect([channel, await r.ipc.call(channel, payload)]).toEqual([channel, REFUSED])
      }
      // Refused as they arrived: no Run was begun, no fact written, no request sent.
      expect(r.reached).toEqual([])
      expect(r.loop.registry.snapshot()).toEqual([])
      expect(r.appends()).toBe(appends)
      expect(r.provider.starts).toBe(starts)

      // Whatever else would open a Run there is refused at its lease, and writes nothing: a send
      // that reached the kernel before the removal began, an auto-send, a released held message.
      expect(await r.kernel.send({ sessionId: session, origin: null, text: 'late' })).toEqual({
        status: 'refused',
        code: 'shutting-down',
      })
      expect(r.appends()).toBe(appends)
      expect(r.provider.starts).toBe(starts)

      // A queued item's withdraw opens no Run and still answers; another session still sends.
      expect(
        await r.ipc.call('chat.queue.act', {
          sessionId: session,
          queuedId: 'q-1',
          action: 'withdraw',
        }),
      ).toEqual({ ok: true, data: { status: 'not-found' } })
      await converse(r, other, 'meanwhile')

      r.folderGate.release()
      await removal
      // Complete: the session sends again.
      await converse(r, session, 'after')
      expect(r.provider.starts).toBe(starts + 2)
    })
  }

  it('refuses the sends, the queue’s send-now, 「继续」, the answer and the resume', () => {
    expect([...REFUSED_WHILE_REMOVING].toSorted()).toEqual(
      sendRequests(randomUUID())
        .map(([channel]) => channel)
        .toSorted(),
    )
  })

  it('refuses a lease for a root being removed, and only for it', () => {
    const removing = new Set<string>()
    const registry = createRunRegistry(createMemoryHost().clock, undefined, (root) =>
      removing.has(root),
    )
    const session = randomUUID()
    const other = randomUUID()
    removing.add(session)
    expect(registry.begin({ rootSessionId: session, origin: null })).toEqual({
      refused: 'shutting-down',
    })
    const theirs = registry.begin({ rootSessionId: other, origin: null })
    expect('refused' in theirs).toBe(false)
    removing.delete(session)
    const mine = registry.begin({ rootSessionId: session, origin: null })
    expect('refused' in mine).toBe(false)
  })
})

describe('a removal that fails', () => {
  it('leaves the folder when the store did not commit, and lets sends through again', async () => {
    const failing: Pick<SessionService, 'resetSession' | 'deleteSession'> = {
      resetSession: () => Promise.reject(new Error('disk full')),
      deleteSession: () => Promise.reject(new Error('disk full')),
    }
    const r = rig({ sessions: failing })
    const session = randomUUID()
    await converse(r, session, 'hello')
    const file = spill(r, session, 'kept')
    await expect(r.removal.clear(session)).rejects.toThrow('disk full')
    await expect(r.removal.delete(session)).rejects.toThrow('disk full')
    expect(r.order).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe('kept')
    expect(r.removal.removing(session)).toBe(false)
    await converse(r, session, 'still here')
  })

  it('logs a folder that did not go, and completes anyway', async () => {
    const opened = openStore({ label: 'removal-rm' })
    closers.push(() => opened.store.close())
    const log: string[] = []
    const session = randomUUID()
    const removal = createSessionRemoval({
      sessions: {
        resetSession: () => Promise.reject(new Error('unused')),
        deleteSession: () => Promise.resolve(),
      },
      profileDir: absolutePath(opened.profileDir),
      log: (line) => log.push(line),
      removeFolder: () => Promise.reject(new Error('EACCES: permission denied')),
    })
    await removal.delete(session)
    expect(log).toHaveLength(1)
    expect(log[0]).toContain(session)
    expect(log[0]).toContain('EACCES: permission denied')
    expect(removal.removing(session)).toBe(false)
  })

  it('refuses an id that is not a canonical UUID before the store or the disk is touched', async () => {
    const r = rig()
    // `../x` would name `<profileDir>/x`; an upper-case UUID is another folder on a case-sensitive disk.
    const beside = join(r.profileDir, 'x')
    mkdirSync(beside)
    for (const id of ['../x', randomUUID().toUpperCase()]) {
      // oxlint-disable-next-line no-await-in-loop -- one id at a time
      await expect(r.removal.clear(id)).rejects.toThrow(TypeError)
      // oxlint-disable-next-line no-await-in-loop -- one id at a time
      await expect(r.removal.delete(id)).rejects.toThrow(TypeError)
      expect(r.removal.removing(id)).toBe(false)
    }
    expect(r.order).toEqual([])
    expect(existsSync(beside)).toBe(true)
  })
})

describe('retracting one message deletes no file (旧 189; 01 §删除语义 unchanged)', () => {
  it('leaves every spilled file of the session in place', async () => {
    const r = rig()
    const session = randomUUID()
    await converse(r, session, 'hello')
    const files = [spill(r, session, 'first'), spill(r, session, 'second')]
    const [message] = await r.kernel.listMessages({ sessionId: session, limit: 1 })
    const head = await r.store.head(session)
    if (message === undefined || head === null) throw new Error('the session was not written')
    await r.store.append({
      sessionId: session,
      incarnationId: head.incarnationId,
      entries: [
        createEntryWriter('message')('message/retracted', {
          sourceType: 'message',
          sourceId: message.messageId,
          provenanceKey: messageRetractedKey(message.messageId),
          payload: { messageId: message.messageId, reason: 'user-deleted' },
          createdAt: 1_700_000_100_000,
        }),
      ],
    })
    await flush()
    expect(
      (await r.kernel.listMessages({ sessionId: session, limit: 10 })).map((row) => row.messageId),
    ).not.toContain(message.messageId)
    expect(files.map((file) => readFileSync(file, 'utf8'))).toEqual(['first', 'second'])
    expect(r.removal.removing(session)).toBe(false)
    expect(r.order).toEqual([])
  })
})

/** The calls in a source that would delete from a disk. */
const DELETING_CALLS = new Set(['rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync'])

/**
 * Each such call in a TypeScript source, found in its syntax tree — esbuild's JavaScript of it, parsed
 * — so a comment, a string or a regular expression that names one is not a call, and no `/*` inside
 * one can hide the code after it.
 */
async function deletingCalls(file: string, text: string): Promise<string[]> {
  const { code } = await transformWithEsbuild(text, file, { loader: 'ts', legalComments: 'none' })
  const found: string[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const each of node) visit(each)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    if (record['type'] === 'CallExpression') {
      const name = calleeName(record['callee'])
      if (name !== null && DELETING_CALLS.has(name)) found.push(`${file}: ${name}`)
    }
    for (const value of Object.values(record)) visit(value)
  }
  visit(parseAst(code))
  return found
}

/** `rm`, `fs.rm`, `fs['rm']`: the name a call is made by, or null. */
function calleeName(callee: unknown): string | null {
  if (typeof callee !== 'object' || callee === null) return null
  const node = callee as Record<string, unknown>
  if (node['type'] === 'Identifier') return String(node['name'])
  if (node['type'] !== 'MemberExpression') return null
  const property = node['property'] as Record<string, unknown>
  if (node['computed'] !== true && property['type'] === 'Identifier')
    return String(property['name'])
  return property['type'] === 'Literal' && typeof property['value'] === 'string'
    ? property['value']
    : null
}

describe('the kernel deletes no folder (旧 189; §大响应落盘「kernel 不删」)', () => {
  const kernelSrc = join(import.meta.dirname, '../../../packages/kernel/src')

  it('has no rm, rmdir or unlink call anywhere in packages/kernel/src', async () => {
    const files = readdirSync(kernelSrc, { recursive: true, encoding: 'utf8' }).filter((file) =>
      file.endsWith('.ts'),
    )
    expect(files.length).toBeGreaterThan(50)
    const offenders = await Promise.all(
      files.map((file) => deletingCalls(file, readFileSync(join(kernelSrc, file), 'utf8'))),
    )
    expect(offenders.flat()).toEqual([])
  })

  it('finds such a call however it is written, and not in a comment, a string or a pattern', async () => {
    const sample = [
      "import { rm } from 'node:fs/promises'",
      '// rm(dir) is the host’s, never the kernel’s',
      "const table = [{ row: 'rm', test: /\\brm\\(/ }, 'unlink(x)']",
      'await rm(dir, { recursive: true })',
      'fs.promises.rmdir(dir)',
      "fs['unlinkSync'](file)",
      "const facts = 'session/*'",
      'unlink(facts)',
    ].join('\n')
    expect(await deletingCalls('sample.ts', sample)).toEqual([
      'sample.ts: rm',
      'sample.ts: rmdir',
      'sample.ts: unlinkSync',
      'sample.ts: unlink',
    ])
  })

  it('gives HostFs no delete member (adapter.ts; §本地持久化布局「HostFs 不因此加删除成员」)', () => {
    expectTypeOf<keyof HostFs>().toEqualTypeOf<
      'readFile' | 'writeFile' | 'stat' | 'readdir' | 'mkdirp' | 'realpath'
    >()
  })
})
