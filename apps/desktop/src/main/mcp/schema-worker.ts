import { Worker } from 'node:worker_threads'
import type { SchemaValidatorPort, SchemaVerdict } from '@tenon-app/kernel'
/** One worker, one active job. Queueing time is excluded from the per-job deadline. */
export function createSchemaWorker(
  q: { timeoutMs?: number; createWorker?: () => Worker } = {},
): SchemaValidatorPort & { close(): Promise<void> } {
  let worker: Worker | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let closed = false
  let cancel: (() => void) | null = null
  const run = async (
    input: Parameters<SchemaValidatorPort['validate']>[0],
  ): Promise<SchemaVerdict> => {
    if (closed || input.signal.aborted) return { ok: false, unusable: 'timeout' }
    if (!worker) {
      try {
        const next =
          q.createWorker?.() ?? new Worker(new URL('./schema-thread.mjs', import.meta.url))
        worker = next
        // Keep lifecycle listeners while idle and during termination, so a failed idle worker is replaced.
        const gone = () => {
          if (worker === next) worker = null
        }
        next.once('exit', gone)
        next.on('error', gone)
      } catch {
        return { ok: false, unusable: 'schema' }
      }
    }
    const current = worker
    return new Promise<SchemaVerdict>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const clean = () => {
        clearTimeout(timer)
        current.off('message', message)
        current.off('error', failed)
        current.off('exit', failed)
        input.signal.removeEventListener('abort', aborted)
        cancel = null
      }
      const finish = (verdict: SchemaVerdict, terminate = false) => {
        if (settled) return
        settled = true
        clean()
        if (terminate) {
          if (worker === current) worker = null
          void current.terminate().then(
            () => resolve(verdict),
            () => resolve(verdict),
          )
        } else resolve(verdict)
      }
      const failed = () => finish({ ok: false, unusable: 'schema' }, true)
      const aborted = () => finish({ ok: false, unusable: 'timeout' }, true)
      const message = (value: { type: 'started' | 'result'; verdict?: SchemaVerdict }) => {
        if (value.type === 'started') timer = setTimeout(aborted, q.timeoutMs ?? 2000)
        else if (value.type === 'result' && value.verdict) finish(value.verdict)
      }
      cancel = aborted
      current.on('message', message)
      current.once('error', failed)
      current.once('exit', failed)
      input.signal.addEventListener('abort', aborted, { once: true })
      if (input.signal.aborted) aborted()
      else {
        try {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker, no origin
          current.postMessage({ schema: input.schema, instance: input.instance })
        } catch {
          failed()
        }
      }
    })
  }
  return {
    validate(input) {
      const result = queue.then(() => run(input))
      queue = result.catch(() => {})
      return result
    },
    async close() {
      closed = true
      cancel?.()
      const current = worker
      worker = null
      await current?.terminate()
      await queue
    },
  }
}
