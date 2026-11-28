/**
 * What an Electron process that goes away leaves in the log (docs/features/error-logs/spec.md
 * §记什么「进程退出」; acceptance 8): the renderer's `render-process-gone` and the other children's
 * `child-process-gone`, one `process.gone` line each, and none for a clean exit.
 *
 * `watchProcessExits` is given a stand-in for Electron's `app`: a plain EventEmitter. It reproduces
 * the parts of the real one the watcher depends on (evidence.md E4, P3), and nothing more:
 *
 *  1. `app` emits two events here. `render-process-gone` calls its listener with
 *     `(event, webContents, details)` and `child-process-gone` with `(event, details)`; the first
 *     argument is Electron's event object, so a watcher that takes the details from the wrong
 *     position reads nothing.
 *  2. `details` of a renderer is `{ reason, exitCode }`; of any other child it is
 *     `{ type, reason, exitCode, serviceName?, name? }`, where `type` names the kind of process
 *     ('GPU', 'Utility', 'Zygote', …) and `name` is there for a utility process only.
 *  3. `reason` is one of 'clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed'
 *     and 'integrity-failure'; `exitCode` is any integer, negative ones included.
 *  4. The renderer never comes through `child-process-gone`, a Node `child_process` never comes
 *     through either of them, and a normal quit makes neither event fire (P3): so nothing here
 *     emits for a process Electron does not report.
 *  5. The events fire as often as processes go away, and Electron never removes the listener.
 *
 * The log is the real one, on a real folder; what is read back is the file. The real events are the
 * e2e case of the same number (`e2e/error-logs-process.spec.ts`).
 */
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openLog, readRecords, sweepTempRoots } from './support/error-logs.js'
import { watchProcessExits } from './support/error-logs-seg2.js'

afterEach(sweepTempRoots)

/** Electron's `app` as far as process events go (points 1, 2 and 5 of the header). */
class FakeApp extends EventEmitter {
  /** What Electron does when a renderer goes: `(event, webContents, details)`. */
  renderGone(details: { reason: string; exitCode: number }): void {
    this.emit('render-process-gone', { preventDefault() {} }, { id: 1 }, details)
  }

  /** What Electron does when any other child goes: `(event, details)`. */
  childGone(details: {
    type: string
    reason: string
    exitCode: number
    serviceName?: string
    name?: string
  }): void {
    this.emit('child-process-gone', { preventDefault() {} }, details)
  }
}

const goneLines = (dir: string) =>
  readRecords(join(dir, 'main.jsonl')).filter((record) => record.event === 'process.gone')

it('error-logs 验收 8: child-process-gone logs type, reason and exit code and skips clean exits', () => {
  const { log, dir } = openLog({ packaged: true })
  const app = new FakeApp()
  watchProcessExits(app, log)
  // It listens to the two events Electron reports process exits on.
  expect(app.listenerCount('child-process-gone')).toBeGreaterThanOrEqual(1)
  expect(app.listenerCount('render-process-gone')).toBeGreaterThanOrEqual(1)
  expect(goneLines(dir)).toEqual([])

  app.childGone({ type: 'GPU', reason: 'crashed', exitCode: 139 })
  expect(goneLines(dir)).toHaveLength(1)
  const [gpu] = goneLines(dir)
  expect(gpu).toMatchObject({
    level: 'error',
    event: 'process.gone',
    process: 'GPU',
    reason: 'crashed',
    exitCode: 139,
  })
  // The kind of process is `type`; a process with no `name` leaves none in the line.
  expect(gpu?.['name']).toBeUndefined()

  // A utility process carries its `name`, which is kept beside the type.
  app.childGone({
    type: 'Utility',
    reason: 'abnormal-exit',
    exitCode: 1,
    serviceName: 'network.mojom.NetworkService',
    name: 'Network Service',
  })
  expect(goneLines(dir)).toHaveLength(2)
  expect(goneLines(dir)[1]).toMatchObject({
    level: 'error',
    process: 'Utility',
    name: 'Network Service',
    reason: 'abnormal-exit',
    exitCode: 1,
  })

  // Every way of not exiting cleanly is a line, with its own reason and exit code, however odd.
  const others: Array<[string, string, number]> = [
    ['Zygote', 'killed', 9],
    ['Sandbox helper', 'oom', -1073741571],
    ['Utility', 'launch-failed', 0],
    ['GPU', 'integrity-failure', 4_294_967_295],
  ]
  for (const [type, reason, exitCode] of others) app.childGone({ type, reason, exitCode })
  expect(
    goneLines(dir)
      .slice(2)
      .map((r) => [r['process'], r['reason'], r['exitCode']]),
  ).toEqual(others)

  // A clean exit is not a failure: no line, whatever the kind of process.
  const before = goneLines(dir).length
  app.childGone({ type: 'GPU', reason: 'clean-exit', exitCode: 0 })
  app.childGone({ type: 'Utility', reason: 'clean-exit', exitCode: 0, name: 'Audio Service' })
  expect(goneLines(dir)).toHaveLength(before)

  // The line is a line like the others: version, pid, time with its zone.
  expect(gpu).toMatchObject({ v: 1, ver: '0.0.0', pid: 4242 })
  expect(gpu?.t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/u)
})

it('error-logs 验收 8: a crashed renderer is logged as the renderer with its reason and exit code, a clean one is not', () => {
  const { log, dir } = openLog({ packaged: true })
  const app = new FakeApp()
  watchProcessExits(app, log)

  app.renderGone({ reason: 'crashed', exitCode: 11 })
  app.renderGone({ reason: 'killed', exitCode: 9 })
  app.renderGone({ reason: 'oom', exitCode: -536870904 })
  expect(goneLines(dir).map((r) => [r.level, r['process'], r['reason'], r['exitCode']])).toEqual([
    ['error', 'renderer', 'crashed', 11],
    ['error', 'renderer', 'killed', 9],
    ['error', 'renderer', 'oom', -536870904],
  ])
  // A renderer carries no `name`.
  expect(goneLines(dir)[0]?.['name']).toBeUndefined()

  // A renderer that left cleanly (its window was closed, say) is not a line.
  app.renderGone({ reason: 'clean-exit', exitCode: 0 })
  expect(goneLines(dir)).toHaveLength(3)
})

it('error-logs 验收 8: the two events do not share a reading: a renderer line and a child line each come from their own event', () => {
  const { log, dir } = openLog({ packaged: true })
  const app = new FakeApp()
  watchProcessExits(app, log)
  // The same details through the other event: the renderer's has no `type`, so what is logged for
  // it as a child would have no process at all; it must be the event that decides who went.
  app.renderGone({ reason: 'crashed', exitCode: 7 })
  app.childGone({ type: 'GPU', reason: 'crashed', exitCode: 7 })
  expect(goneLines(dir).map((r) => r['process'])).toEqual(['renderer', 'GPU'])
})

it('error-logs 验收 8: process exits are not capped like other sources: a storm of them is every one of them', () => {
  // Spec §限量: `process.gone` is one of the nine kinds that are never capped.
  const { log, dir } = openLog({ packaged: true })
  const app = new FakeApp()
  watchProcessExits(app, log)
  for (let i = 0; i < 150; i += 1)
    app.childGone({ type: 'Utility', reason: 'crashed', exitCode: i })
  expect(goneLines(dir)).toHaveLength(150)
  expect(readRecords(join(dir, 'main.jsonl')).filter((r) => r.event === 'log.dropped')).toEqual([])
})
