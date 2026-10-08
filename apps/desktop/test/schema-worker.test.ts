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

it('03 验收 51: worker agrees with synchronous validation on dialect selection and error locations', async () => {
  const { synchronousSchemaVerdict } =
    await import('../../../packages/kernel/src/tools/validate.js')
  const worker = createSchemaWorker()
  try {
    for (const schema of [
      true,
      false,
      null,
      { type: 'object', properties: { count: { type: 'number' } } },
      { type: 'array', prefixItems: [{ type: 'number' }], items: false },
      {
        $schema: 'https://json-schema.org/draft-07/schema#',
        $ref: '#/$defs/any',
        $defs: { any: {} },
        type: 'number',
      },
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'array',
        items: [{ type: 'number' }],
      },
      { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object' },
      { $schema: 'https://unsupported.example/schema', type: 'object' },
    ]) {
      for (const instance of [{ count: 'bad' }, [1], ['bad']]) {
        expect(await worker.validate({ schema, instance, signal: signal() })).toEqual(
          synchronousSchemaVerdict(schema, instance),
        )
      }
    }
  } finally {
    await worker.close()
  }
})
it('queued validation aborts immediately and overflow is refused without waiting for the active deadline', async () => {
  const worker = createSchemaWorker({ timeoutMs: 600, maxQueue: 2 })
  try {
    const active = worker.validate({
      schema: schemaChain('anchor', 32),
      instance: {},
      signal: signal(),
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const abort = new AbortController()
    const queued = worker.validate({ schema: {}, instance: {}, signal: abort.signal })
    const next = worker.validate({ schema: {}, instance: {}, signal: signal() })
    const start = performance.now()
    expect(await worker.validate({ schema: {}, instance: {}, signal: signal() })).toEqual({
      ok: false,
      unusable: 'timeout',
    })
    abort.abort()
    expect(await queued).toEqual({ ok: false, unusable: 'timeout' })
    expect(performance.now() - start).toBeLessThan(100)
    expect(await active).toEqual({ ok: false, unusable: 'timeout' })
    expect(await next).toEqual({ ok: true })
  } finally {
    await worker.close()
  }
})

it('03 读法 69: abort releases both queue slots before resolving and does not decrement them twice', async () => {
  const worker = createSchemaWorker({ maxQueue: 2, timeoutMs: 500 })
  try {
    const active = worker.validate({
      schema: schemaChain('anchor', 32),
      instance: {},
      signal: signal(),
    })
    await new Promise((r) => setTimeout(r, 100))
    const a = new AbortController(),
      b = new AbortController()
    const one = worker.validate({ schema: {}, instance: {}, signal: a.signal }),
      two = worker.validate({ schema: {}, instance: {}, signal: b.signal })
    a.abort()
    b.abort()
    // Enqueue synchronously before the aborted jobs are reached or their promises are awaited.
    const next = worker.validate({
      schema: schemaChain('anchor', 32),
      instance: {},
      signal: signal(),
    })
    expect(await one).toEqual({ ok: false, unusable: 'timeout' })
    expect(await two).toEqual({ ok: false, unusable: 'timeout' })
    expect(await active).toEqual({ ok: false, unusable: 'timeout' })
    // The two aborted jobs have now left the queue, and the next slow validation is active.
    await new Promise((r) => setTimeout(r, 100))
    const fill1 = worker.validate({ schema: {}, instance: {}, signal: signal() }),
      fill2 = worker.validate({ schema: {}, instance: {}, signal: signal() })
    expect(await worker.validate({ schema: {}, instance: {}, signal: signal() })).toEqual({
      ok: false,
      unusable: 'timeout',
    })
    expect(await next).toEqual({ ok: false, unusable: 'timeout' })
    expect(await fill1).toEqual({ ok: true })
    expect(await fill2).toEqual({ ok: true })
  } finally {
    await worker.close()
  }
})
