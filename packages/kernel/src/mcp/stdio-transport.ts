import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/client'
import type { JSONRPCMessage, Transport, TransportSendOptions } from '@modelcontextprotocol/client'
import type { ChildHandle, HostClock } from '../host/adapter.js'

/** Mirrors the SDK's own stdio buffer ceiling. */
const DEFAULT_MAX_BUFFER_CHARS = 10 * 1024 * 1024
/** Wait this long for a voluntary exit after stdin EOF before SIGTERM, then again before SIGKILL. */
const DEFAULT_GRACE_MS = 2000

export interface ChildStdioTransportOptions {
  readonly maxBufferChars?: number
  readonly graceMs?: number
}

/**
 * MCP Transport over a ChildHandle's Web Streams. The kernel never spawns: the handle
 * comes from HostProcess.spawn. Framing and JSON-RPC (de)serialisation are the SDK's.
 */
export class ChildStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  sessionId?: string

  readonly #child: ChildHandle
  readonly #clock: HostClock
  readonly #maxBufferChars: number
  readonly #graceMs: number
  readonly #encoder = new TextEncoder()
  #writer?: WritableStreamDefaultWriter<Uint8Array>
  #reader?: ReadableStreamDefaultReader<Uint8Array>
  #started = false
  #closing = false
  #finished = false
  #protocolVersion?: string

  constructor(child: ChildHandle, clock: HostClock, options?: ChildStdioTransportOptions) {
    this.#child = child
    this.#clock = clock
    this.#maxBufferChars = options?.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS
    this.#graceMs = options?.graceMs ?? DEFAULT_GRACE_MS
  }

  get protocolVersion(): string | undefined {
    return this.#protocolVersion
  }

  setProtocolVersion(version: string): void {
    this.#protocolVersion = version
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('ChildStdioTransport already started')
    this.#started = true
    this.#writer = this.#child.stdin.getWriter()
    // Hosts error the stdin stream when the child exits normally; never let that surface
    // as an unhandled rejection.
    void this.#writer.closed.catch(() => {})
    this.#reader = this.#child.stdout.getReader()
    void this.#readLoop()
    void this.#child.exited.then(() => this.#finish())
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const writer = this.#writer
    if (!writer) throw new Error('ChildStdioTransport not started')
    await writer.write(this.#encoder.encode(serializeMessage(message)))
  }

  /**
   * Graceful shutdown: stdin EOF first (well-behaved servers exit 0 on EOF), SIGTERM
   * after `graceMs`, SIGKILL after another `graceMs`. Never leaks a child.
   */
  async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    try {
      await this.#writer?.close()
    } catch {
      /* pipe already gone */
    }
    if (!(await this.#exitedWithin(this.#graceMs))) {
      await this.#child.kill('SIGTERM')
      if (!(await this.#exitedWithin(this.#graceMs))) {
        await this.#child.kill('SIGKILL')
        await this.#child.exited
      }
    }
    try {
      await this.#reader?.cancel()
    } catch {
      /* already cancelled */
    }
    this.#finish()
  }

  #exitedWithin(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const cancel = this.#clock.setTimeout(() => resolve(false), ms)
      void this.#child.exited.then(() => {
        cancel()
        resolve(true)
      })
    })
  }

  #finish(): void {
    if (this.#finished) return
    this.#finished = true
    this.onclose?.()
  }

  async #readLoop(): Promise<void> {
    const reader = this.#reader
    if (!reader) return
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    try {
      for (;;) {
        // A stdio read loop is sequential by nature: the next frame cannot be read early.
        // oxlint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '')
          buffer = buffer.slice(nl + 1)
          if (line.length === 0) continue
          let message: JSONRPCMessage
          try {
            message = deserializeMessage(line)
          } catch (error) {
            // Like the SDK's ReadBuffer: skip non-JSON noise, report shape errors.
            if (error instanceof SyntaxError) continue
            this.onerror?.(error as Error)
            continue
          }
          this.onmessage?.(message)
        }
        // Checked after draining complete lines: only one oversized unterminated line trips it.
        if (buffer.length > this.#maxBufferChars) {
          throw new Error(`stdout line exceeded ${this.#maxBufferChars} chars`)
        }
      }
    } catch (error) {
      this.onerror?.(error as Error)
    } finally {
      this.#finish()
    }
  }
}
