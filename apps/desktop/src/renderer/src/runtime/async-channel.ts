/**
 * A single-consumer push channel: the IPC listener pushes, the adapter's generator pulls.
 * Nothing here is assistant-ui specific — it turns an event callback into an async iterable
 * without dropping events that arrive between two `yield`s.
 */
export interface AsyncChannel<T> {
  push(item: T): void
  close(): void
  drain(): AsyncGenerator<T, void>
}

export function createAsyncChannel<T>(): AsyncChannel<T> {
  const buffer: T[] = []
  let wake: (() => void) | null = null
  let closed = false

  const notify = (): void => {
    const resume = wake
    wake = null
    resume?.()
  }

  return {
    push(item) {
      if (closed) return
      buffer.push(item)
      notify()
    },
    close() {
      if (closed) return
      closed = true
      notify()
    },
    async *drain() {
      for (;;) {
        while (buffer.length > 0) {
          const item = buffer.shift()
          if (item !== undefined) yield item
        }
        if (closed) return
        // oxlint-disable-next-line no-await-in-loop -- the await IS the back-pressure: one idle turn per wake.
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    },
  }
}
