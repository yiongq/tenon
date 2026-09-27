import { chatQueueEvent, runStateEvent } from '@tenon-app/contracts'
import type { DesktopLoop } from './chat.js'

/** The half of a WebContents the replay uses: its load event, and a send to that document. */
export interface ReplayTarget {
  on(event: 'did-finish-load', listener: () => void): unknown
  send(channel: string, ...args: unknown[]): void
}

/**
 * A document that loads — the first one, a new window, a reload — gets the state it missed (spec 02
 * §进行中、暂停与 RunRegistry「何时推」): `run.state` for every live lease, aborted ones still closing
 * included, and `chat.queue` for every queue that is not empty. Read at each load, never at the
 * time the window opened.
 */
export function replayOnLoad(contents: ReplayTarget, loop: DesktopLoop | null): void {
  contents.on('did-finish-load', () => {
    if (loop === null) return
    for (const entry of loop.registry.snapshot()) {
      contents.send(runStateEvent.channel, {
        sessionId: entry.rootSessionId,
        running: !entry.aborted,
        runId: entry.runId,
      })
    }
    for (const [root, view] of loop.queue.views()) {
      contents.send(chatQueueEvent.channel, { sessionId: root, ...view })
    }
  })
}
