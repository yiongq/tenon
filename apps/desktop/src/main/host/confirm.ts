import type { ConfirmRequest, HostConfirm } from '@tenon-app/kernel'
import { confirmRequestEvent, confirmRequestSchema } from '@tenon-app/contracts'

export type EventSender = (channel: string, payload: unknown) => void

/**
 * Delivers approval requests to the UI over the `confirm.request` event. A request
 * whose `facts` miss a required slot fails validation and is NOT delivered; the
 * kernel gets the rejection instead of the UI rendering an empty `{slot}`.
 */
export class IpcConfirm implements HostConfirm {
  private readonly send: EventSender

  constructor(send: EventSender) {
    this.send = send
  }

  async request(req: ConfirmRequest): Promise<void> {
    const parsed = confirmRequestSchema.safeParse(req)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
      throw new Error(`confirm request ${req.requestId} rejected: ${issues}`)
    }
    this.send(confirmRequestEvent.channel, parsed.data)
  }
}
