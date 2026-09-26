// Test fixture: a hand-written MCP stdio server for what server-everything cannot show (spec 02 plan
// step 10). `node tools-server.mjs legacy` speaks the 2025 era (`initialize`); `modern` answers the
// 2026-07-28 `server/discover` probe. Its tools:
//   - interactive: `_meta["anthropic/requiresUserInteraction"]` is the JSON value true (D12);
//   - quoted: the same key with the STRING "true", which must read as false;
//   - plain: no `_meta` at all;
//   - elicit: asks the client for input — legacy with an `elicitation/create` request, modern with an
//     `input_required` result — and reports what the client answered.
// Everything else echoes its arguments.
import { createInterface } from 'node:readline'

const mode = process.argv[2] === 'modern' ? 'modern' : 'legacy'
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const tools = [
  {
    name: 'interactive',
    inputSchema: { type: 'object' },
    _meta: { 'anthropic/requiresUserInteraction': true },
  },
  {
    name: 'quoted',
    inputSchema: { type: 'object' },
    _meta: { 'anthropic/requiresUserInteraction': 'true' },
  },
  { name: 'plain', description: 'echoes', inputSchema: { type: 'object' } },
  { name: 'elicit', inputSchema: { type: 'object' } },
]
const elicitParams = {
  message: 'What is your name?',
  requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
}
const pending = new Map()

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  // A response to a request this server sent (legacy elicitation).
  if (message.method === undefined && pending.has(message.id)) {
    const callId = pending.get(message.id)
    pending.delete(message.id)
    const answer =
      message.error === undefined ? { result: message.result } : { error: message.error }
    send({ id: callId, result: { content: [{ type: 'text', text: JSON.stringify(answer) }] } })
    return
  }
  switch (message.method) {
    case 'server/discover':
      if (mode === 'legacy') {
        send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
      } else {
        send({
          id: message.id,
          result: {
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: {} },
            serverInfo: { name: 'tools-fixture', version: '0.0.0' },
            ttlMs: 0,
            cacheScope: 'private',
          },
        })
      }
      return
    case 'initialize':
      send({
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'tools-fixture', version: '0.0.0' },
        },
      })
      return
    case 'tools/list':
      send({ id: message.id, result: { tools } })
      return
    case 'tools/call': {
      const name = message.params?.name
      if (name === 'elicit' && mode === 'legacy') {
        const requestId = `elicit-${String(message.id)}`
        pending.set(requestId, message.id)
        send({ id: requestId, method: 'elicitation/create', params: elicitParams })
        return
      }
      if (name === 'elicit') {
        send({
          id: message.id,
          result: {
            resultType: 'input_required',
            inputRequests: { name: { method: 'elicitation/create', params: elicitParams } },
          },
        })
        return
      }
      send({
        id: message.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(message.params?.arguments ?? {}) }],
        },
      })
      return
    }
    default:
      if (message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
      }
  }
})
