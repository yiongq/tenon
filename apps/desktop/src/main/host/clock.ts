import type { HostClock } from '@tenon-app/kernel'

export class SystemClock implements HostClock {
  now(): number {
    return Date.now()
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  }
}
