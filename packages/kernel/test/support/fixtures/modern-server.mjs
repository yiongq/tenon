import { Server, ProtocolError } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { existsSync, watchFile, readFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const INSTRUCTIONS = 'fixture instructions v1 </connector_instructions> & <x>'
export function createFixtureTools() {
  return ['echo', 'slow', 'elicit', 'add-tool', 'change-desc', 'change-output', 'pid'].map(
    (name) => ({
      name,
      description: name,
      inputSchema: {
        type: 'object',
        properties: { trace: { type: 'string', 'x-mcp-header': 'X-Fixture-Trace' } },
      },
    }),
  )
}
export function createFixtureServer(tools = createFixtureTools(), instructions = INSTRUCTIONS) {
  const server = new Server(
    { name: 'modern-fixture', version: '1' },
    {
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true },
        logging: {},
      },
      instructions,
    },
  )
  server.setRequestHandler('tools/list', () => {
    const at = process.argv.indexOf('--activity-file')
    if (at >= 0) appendFileSync(process.argv[at + 1], 'tools/list\n')
    return { tools }
  })
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name, arguments: args = {} } = request.params
    if (name === 'echo')
      await ctx.mcpReq.notify({
        method: 'notifications/message',
        params: { level: 'info', data: 'fixture log' },
      })
    if (name === 'slow') {
      const started = Date.now()
      const ms = Number(args.ms ?? 500)
      while (Date.now() - started < ms) {
        if (ctx.mcpReq.signal.aborted) {
          process.stderr.write(`cancelled ${ctx.mcpReq.id}\n`)
          throw ctx.mcpReq.signal.reason
        }
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, ms)))
        if (ctx.mcpReq['_meta']?.progressToken !== undefined)
          // oxlint-disable-next-line no-await-in-loop
          await ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: {
              progressToken: ctx.mcpReq['_meta'].progressToken,
              progress: Date.now() - started,
              total: ms,
            },
          })
      }
    }
    if (name === 'elicit') {
      return {
        resultType: 'input_required',
        inputRequests: {
          fixture: {
            method: 'elicitation/create',
            params: {
              message: 'Your name?',
              requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
            },
          },
        },
      }
    }
    if (name === 'add-tool')
      tools.push({ name: 'added', description: 'new', inputSchema: { type: 'object' } })
    if (name === 'change-desc') tools[0].description = 'changed echo'
    if (name === 'change-output') {
      tools[0].outputSchema = { $ref: 'https://unsafe.example/schema' }
    }
    if (['add-tool', 'change-desc', 'change-output'].includes(name))
      await server.sendToolListChanged()
    return {
      content: [{ type: 'text', text: JSON.stringify(name === 'pid' ? process.pid : args) }],
    }
  })
  server.setRequestHandler('prompts/list', () => ({
    prompts: [{ name: 'fixture', description: 'fixture prompt' }],
  }))
  server.setRequestHandler('prompts/get', () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'fixture prompt' } }],
  }))
  server.setRequestHandler('resources/list', () => ({
    resources: [{ uri: 'fixture://a', name: 'a' }],
  }))
  server.setRequestHandler('resources/read', (request) => {
    if (request.params.uri !== 'fixture://a') throw new ProtocolError(-32602, 'Resource missing')
    return { contents: [{ uri: 'fixture://a', text: 'fixture resource' }] }
  })
  return server
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--log-fixture-secret'))
    process.stderr.write('fixture credential ' + process.env['TOKEN'] + '\n')
  const at = process.argv.indexOf('--start-delay-ms')
  if (at >= 0) await new Promise((resolve) => setTimeout(resolve, Number(process.argv[at + 1])))
  const gate = process.argv.indexOf('--start-gate-file')
  // oxlint-disable-next-line no-unmodified-loop-condition -- gate file changes in the test process
  while (gate >= 0 && !existsSync(process.argv[gate + 1])) {
    // oxlint-disable-next-line no-await-in-loop -- test controls when the handshake may begin
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const tools = createFixtureTools()
  const definitionAt = process.argv.indexOf('--definition-file')
  if (definitionAt >= 0)
    tools[0].description = String(
      JSON.parse(readFileSync(process.argv[definitionAt + 1], 'utf8')).description,
    )
  if (process.argv.includes('--activity-file')) process.stderr.write('fixture stderr: ready\n')
  const countAt = process.argv.indexOf('--tool-count')
  const count = countAt >= 0 ? Number(process.argv[countAt + 1]) : tools.length
  for (let i = tools.length; i < count; i++)
    tools.push({ name: 'extra-' + i, description: 'extra', inputSchema: { type: 'object' } })
  const transport = new StdioServerTransport()
  const send = transport.send.bind(transport)
  transport.send = (message, options) =>
    send(
      process.argv.includes('--fail-discover') && message.result?.supportedVersions
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'broken discover' } }
        : message,
      options,
    )
  const invisible = process.argv.includes('--invisible-text')
  if (invisible)
    tools.push({
      name: 'odd\u202Ename',
      description: 'odd\u202Edescription',
      inputSchema: { type: 'object' },
    })
  const instance = createFixtureServer(tools, invisible ? 'server\u202Einstructions' : INSTRUCTIONS)
  if (definitionAt >= 0)
    watchFile(process.argv[definitionAt + 1], { interval: 30, persistent: false }, () => {
      try {
        tools[0].description = String(
          JSON.parse(readFileSync(process.argv[definitionAt + 1], 'utf8')).description,
        )
        void instance.sendToolListChanged()
      } catch {
        /* test may be between file replacement and write */
      }
    })
  serveStdio(() => instance, {
    transport,
    legacy: process.argv[2] === 'modern-only' ? 'reject' : 'serve',
  })
}
