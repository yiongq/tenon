import { chatEventSchema, invokeRoute, snapshotRounds } from '@tenon-app/contracts'
import type { Rounds } from '../lib/snapshots'

/** The refresh lifetime of one mounted session, shared by events and explicit reads. */
export class SnapshotRefresh {
  private stopped = false
  private running: Promise<Rounds | null> | null = null
  private queued = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly bridge: Parameters<typeof invokeRoute>[0]
  private readonly sessionId: string
  private readonly publish: (data: Rounds | null) => void
  constructor(
    bridge: Parameters<typeof invokeRoute>[0],
    sessionId: string,
    publish: (data: Rounds | null) => void,
  ) {
    this.bridge = bridge
    this.sessionId = sessionId
    this.publish = publish
  }
  refresh = (): Promise<Rounds | null> => {
    if (this.stopped) return Promise.resolve(null)
    this.clearTimer()
    if (this.running !== null) {
      this.queued = true
      return this.running
    }
    this.running = Promise.resolve().then(this.drain)
    return this.running
  }
  private drain = async (): Promise<Rounds | null> => {
    let next: Rounds | null = null
    try {
      do {
        this.queued = false
        if (this.stopped) return null
        try {
          // oxlint-disable-next-line no-await-in-loop -- refreshes must never overlap; one dirty bit requests a follow-up
          const result = await invokeRoute(this.bridge, snapshotRounds, {
            sessionId: this.sessionId,
          })
          next = result.ok && result.data.ok ? result.data : null
        } catch {
          next = null
        }
      } while (this.queued && !this.stopped)
      if (!this.stopped) this.publish(next)
      return next
    } finally {
      this.running = null
    }
  }
  private clearTimer = () => {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
  event = (payload: unknown) => {
    if (this.stopped) return
    const event = chatEventSchema.safeParse(payload)
    if (!event.success || event.data.sessionId !== this.sessionId) return
    if (event.data.type === 'tool-outcome') {
      if (this.timer === null)
        this.timer = setTimeout(() => {
          void this.refresh()
        }, 500)
    } else if (event.data.type === 'done' || event.data.type === 'error') void this.refresh()
  }
  dispose = () => {
    this.stopped = true
    this.queued = false
    this.clearTimer()
  }
}
