// Each shape runs in an isolated worker; later ordinary calls must still make progress.
// oxlint-disable no-await-in-loop
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { createSchemaWorker } from '../src/main/mcp/schema-worker.js'
import {
  schemaChain,
  hostileSchemaShapes,
} from '../../../packages/kernel/test/support/schema-chains.js'
const signal = () => new AbortController().signal
it('03 验收 51: ordinary schemas pass and fail; example id 42 is usable; a cancelled call cannot stall the queue', async () => {
  const worker = createSchemaWorker({ timeoutMs: 200 })
  try {
    expect(
      await worker.validate({ schema: { type: 'number' }, instance: 2, signal: signal() }),
    ).toEqual({ ok: true })
    expect(
      await worker.validate({ schema: { type: 'number' }, instance: 'x', signal: signal() }),
    ).toMatchObject({ ok: false, errors: expect.any(Array) })
    expect(
      await worker.validate({
        schema: { type: 'object', example: { id: 42 } },
        instance: {},
        signal: signal(),
      }),
    ).toEqual({ ok: true })
    const stop = new AbortController()
    stop.abort()
    expect(await worker.validate({ schema: {}, instance: {}, signal: stop.signal })).toEqual({
      ok: false,
      unusable: 'timeout',
    })
    expect(
      await worker.validate({ schema: { $ref: '#missing' }, instance: {}, signal: signal() }),
    ).toEqual({ ok: false, unusable: 'schema' })
  } finally {
    await worker.close()
  }
})
it('03 验收 51: hostile reference chains cannot block the main thread; a timed-out worker is terminated and the next call starts fresh', async () => {
  const threads: Worker[] = []
  const worker = createSchemaWorker({
    timeoutMs: 200,
    createWorker: () => {
      const t = new Worker(new URL('../src/main/mcp/schema-thread.mjs', import.meta.url))
      threads.push(t)
      return t
    },
  })
  try {
    let ticks = 0
    const timer = setInterval(() => {
      ticks++
    }, 10)
    const start = performance.now()
    const pending = worker.validate({
      schema: schemaChain('anchor', 32),
      instance: { x: 1, y: 1 },
      signal: signal(),
    })
    const ordinary = worker.validate({ schema: { type: 'object' }, instance: {}, signal: signal() })
    expect(await pending).toEqual({ ok: false, unusable: 'timeout' })
    expect(threads[0]?.threadId).toBe(-1)
    expect(await ordinary).toEqual({ ok: true })
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(5)
    expect(performance.now() - start).toBeLessThan(1500)
  } finally {
    await worker.close()
    await Promise.all(threads.map((t) => t.terminate()))
  }
})

it.each(hostileSchemaShapes())(
  '03 验收 51: $name cannot exhaust the main thread and an ordinary queued item succeeds after termination',
  async ({ schema, instance }) => {
    const worker = createSchemaWorker({ timeoutMs: 200 })
    let ticks = 0
    const timer = setInterval(() => {
      ticks++
    }, 10)
    try {
      const start = performance.now()
      const pending = worker.validate({ schema, instance, signal: signal() })
      const next = worker.validate({ schema: { type: 'object' }, instance: {}, signal: signal() })
      expect(await pending).toEqual({ ok: false, unusable: 'timeout' })
      expect(await next).toEqual({ ok: true })
      expect(ticks).toBeGreaterThan(5)
      expect(performance.now() - start).toBeLessThan(1500)
    } finally {
      clearInterval(timer)
      await worker.close()
    }
  },
)
