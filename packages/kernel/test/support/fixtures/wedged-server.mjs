// Test fixture: a hostile/broken MCP stdio server. It completes the handshake, then floods
// stdout with one unterminated line (tripping the transport's frame guard) and stays alive,
// ignoring stdin EOF. Only a signal ends it.
import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method === 'initialize') {
    const result = {
      protocolVersion: message.params.protocolVersion,
      capabilities: {},
      serverInfo: { name: 'wedged', version: '0.0.0' },
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
  }
  if (message.method === 'notifications/initialized') {
    process.stdout.write('x'.repeat(4096))
  }
})
lines.on('close', () => {
  /* stdin EOF is ignored on purpose */
})
setInterval(() => {}, 1000)
