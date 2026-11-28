/**
 * The two watchers of segment one (docs/features/error-logs/spec.md §记什么; acceptance 6 and 14):
 * a route that answers `ok: false`, and a window's console errors.
 *
 * Acceptance 6 builds the route table the way `index.ts` does, from the real wrappers
 * (`refuseWhileShuttingDown`, `refuseWhileRemoving`) with `logRouteFailures` outermost, so the rule
 * "a refusal that happens inside it is not logged" is tested on the real composition, with
 * `registerRoute` from contracts registering real routes (`chat.send`, `session.latest`). The IPC
 * main is a map of handlers, which is all `registerRoute` asks of it.
 *
 * Acceptance 14 gives `watchRendererConsole` a stand-in `webContents` with the one method it uses,
 * `on('console-message', listener)`, and calls the listener as Electron does: with one details
 * object `{ level, message, sourceId, lineNumber }`, `level` being 'verbose', 'info', 'warning' or
 * 'error'. The real thing is covered by the e2e case of the same number.
 */
import { join } from 'node:path'
import { chatSend, registerRoute, sessionLatest } from '@tenon-app/contracts'
import type { IpcMainLike } from '@tenon-app/contracts'
import { afterEach, expect, it } from 'vitest'
import { refuseWhileRemoving } from '../src/main/session-removal.js'
import { refuseWhileShuttingDown } from '../src/main/shutdown.js'
import {
  HOME,
  logRouteFailures,
  openLog,
  readRecords,
  sweepTempRoots,
  watchRendererConsole,
} from './support/error-logs.js'
import { TABLE } from './support/error-logs-sentinels.js'

afterEach(sweepTempRoots)

const ROOT = '4f1c9a2e-6b3d-4a71-9f52-0c8de7a11b34'

it('error-logs 验收 6: route failures log channel and code; shutdown and removal refusals do not', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const base: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
  }
  let shuttingDown = false
  const removing = new Set<string>()
  const { log, dir } = openLog({ packaged: true })
  // index.ts's order: the log wraps the other wrappers, so it is the closest to registerRoute.
  const routes = logRouteFailures(
    refuseWhileRemoving(
      refuseWhileShuttingDown(base, () => shuttingDown),
      (sessionId: string) => removing.has(sessionId),
    ),
    log,
  )
  registerRoute(routes, chatSend, async ({ text }) => {
    if (text === 'throw') throw new Error(`boom at ${HOME}/x`)
    return { accepted: true as const }
  })
  registerRoute(routes, sessionLatest, () => 'not an object' as never)

  const call = async (channel: string, payload: unknown): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error(`no handler for ${channel}`)
    return await handler({}, payload)
  }
  const failures = () =>
    readRecords(join(dir, 'main.jsonl')).filter((r) => r.event === 'ipc.failed')

  // A success is not a failure.
  expect(await call('chat.send', { sessionId: ROOT, text: 'fine' })).toEqual({
    ok: true,
    data: { accepted: true },
  })
  expect(failures()).toEqual([])

  // The three kinds the renderer is answered with, one line each; the reply is left as it was.
  expect(await call('chat.send', {})).toMatchObject({
    ok: false,
    error: { code: 'invalid-request' },
  })
  expect(await call('chat.send', { sessionId: ROOT, text: 'throw' })).toEqual({
    ok: false,
    error: { code: 'handler-failed', message: `boom at ${HOME}/x` },
  })
  expect(await call('session.latest', { limit: 5 })).toMatchObject({
    ok: false,
    error: { code: 'invalid-response' },
  })
  expect(failures().map((r) => [r.level, r['channel'], r['code'], r['message']])).toEqual([
    ['warn', 'chat.send', 'invalid-request', 'chat.send: request failed validation'],
    ['warn', 'chat.send', 'handler-failed', 'boom at ~/x'],
    ['warn', 'session.latest', 'invalid-response', 'session.latest: response failed validation'],
  ])

  // Refused outside it, while the app quits or while the session is being removed: no line.
  shuttingDown = true
  expect(await call('chat.send', { sessionId: ROOT, text: 'late' })).toEqual({
    ok: false,
    error: { code: 'handler-failed', message: 'the app is shutting down' },
  })
  shuttingDown = false
  removing.add(ROOT)
  expect(await call('chat.send', { sessionId: ROOT, text: 'late' })).toEqual({
    ok: false,
    error: { code: 'handler-failed', message: 'the session is being cleared or deleted' },
  })
  expect(failures()).toHaveLength(3)
})

interface ConsoleDetails {
  readonly level: string
  readonly message: string
  readonly sourceId: string
  readonly lineNumber: number
}

/** The part of a `webContents` the watcher uses, with a way to make it emit. */
function fakeContents(): {
  readonly contents: {
    on(event: 'console-message', listener: (details: ConsoleDetails) => unknown): unknown
  }
  emit(details: ConsoleDetails): void
} {
  const listeners: Array<(details: ConsoleDetails) => unknown> = []
  const contents = {
    on(_event: 'console-message', listener: (details: ConsoleDetails) => unknown): unknown {
      listeners.push(listener)
      return contents
    },
  }
  return {
    contents,
    emit(details) {
      for (const listener of listeners) listener(details)
    },
  }
}

const BUNDLE = 'file:///Users/alice/Tenon/out/renderer/assets/index-3f9a.js?v=2#frag'

it('error-logs 验收 14: an uncaught renderer error logs its first line, file and line, and repeats merge', () => {
  const { log, dir } = openLog({ packaged: true })
  log.remember(TABLE.raw)
  const renderer = fakeContents()
  watchRendererConsole(renderer.contents, log)
  const logged = () =>
    readRecords(join(dir, 'main.jsonl')).filter((r) => r.event === 'renderer.error')

  // The error level only; its first line, home written ~; the file's name and the line number.
  renderer.emit({
    level: 'error',
    message: `Uncaught Error: first ${HOME}/p\n    at foo (${BUNDLE}:41:9)\n    at bar`,
    sourceId: BUNDLE,
    lineNumber: 41,
  })
  renderer.emit({ level: 'warning', message: 'only a warning', sourceId: BUNDLE, lineNumber: 1 })
  renderer.emit({ level: 'info', message: 'only some output', sourceId: BUNDLE, lineNumber: 2 })
  renderer.emit({ level: 'verbose', message: 'only a trace', sourceId: BUNDLE, lineNumber: 3 })
  expect(logged().map((r) => [r.level, r['message'], r['source'], r['line']])).toEqual([
    ['error', 'Uncaught Error: first ~/p', 'index-3f9a.js', 41],
  ])

  // A secret in the first line is replaced, a long first line is cut at 300, a long file name at 200.
  renderer.emit({
    level: 'error',
    message: `Uncaught Error: key ${TABLE.raw} was refused`,
    sourceId: BUNDLE,
    lineNumber: 5,
  })
  renderer.emit({
    level: 'error',
    message: `Uncaught Error: ${'e'.repeat(400)}`,
    sourceId: `file:///x/${'a'.repeat(250)}.js`,
    lineNumber: 6,
  })
  const found = logged()
  expect(found[1]?.['message']).toBe('Uncaught Error: key [redacted] was refused')
  // 416 characters cut to 300 (the 16 of "Uncaught Error: " and 284 e), 116 left out; the file name,
  // `aaa….js` of 253 characters, cut to 200, 53 left out.
  expect(found[2]?.['message']).toBe(`Uncaught Error: ${'e'.repeat(284)}…(+116)`)
  expect(found[2]?.['source']).toBe(`${'a'.repeat(200)}…(+53)`)

  // The same error again and again: the first is written at once, the rest are counted, and the
  // count is written when something else comes. (3 of them: the count line says 3.)
  const same = { level: 'error', message: 'Uncaught Error: loop', sourceId: BUNDLE, lineNumber: 9 }
  renderer.emit(same)
  renderer.emit(same)
  renderer.emit(same)
  const loops = () => logged().filter((r) => r['message'] === 'Uncaught Error: loop')
  expect(loops()).toHaveLength(1)
  // The first line counts itself; the follow-up line carries the total of the run.
  expect(loops()[0]?.['repeats']).toBe(1)
  renderer.emit({ ...same, message: 'Uncaught Error: another' })
  expect(loops()).toHaveLength(2)
  expect(loops()[1]?.['repeats']).toBe(3)
  const order = logged().map((r) => r['message'])
  expect(order.slice(-3)).toEqual([
    'Uncaught Error: loop',
    'Uncaught Error: loop',
    'Uncaught Error: another',
  ])

  // And when the app quits with a count still waiting, it is written then.
  renderer.emit({ ...same, message: 'Uncaught Error: another' })
  renderer.emit({ ...same, message: 'Uncaught Error: another' })
  log.close()
  const anothers = logged().filter((r) => r['message'] === 'Uncaught Error: another')
  expect(anothers).toHaveLength(2)
  expect(anothers[1]?.['repeats']).toBe(3)
  expect(readRecords(join(dir, 'main.jsonl')).at(-1)?.event).toBe('app.quit')
})

it('error-logs 验收 14: a count still waiting when the minute is over is written by the next write, not only when the app quits', () => {
  const { log, dir, clock } = openLog({ packaged: true })
  const renderer = fakeContents()
  watchRendererConsole(renderer.contents, log)
  const logged = () =>
    readRecords(join(dir, 'main.jsonl')).filter((r) => r.event === 'renderer.error')
  const boom = {
    level: 'error',
    message: 'Uncaught Error: boom',
    sourceId: BUNDLE,
    lineNumber: 3,
  }
  renderer.emit(boom)
  renderer.emit(boom)
  renderer.emit(boom)
  expect(logged().map((r) => r['repeats'])).toEqual([1])

  // Nothing else is reported, and the minute passes: the first write after it carries the count
  // out. It is read here, before `close`, which would write it too.
  clock.advance(61_000)
  log.line('host', 'info')('a write in the next minute')
  expect(logged().map((r) => [r['message'], r['repeats']])).toEqual([
    ['Uncaught Error: boom', 1],
    ['Uncaught Error: boom', 3],
  ])
  log.close()
  expect(logged()).toHaveLength(2)
})
