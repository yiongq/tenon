import { createInterface } from 'node:readline'
for (let i = 0; i < 30; i++)
  process.stderr.write(
    `${i === 10 ? (process.env.SECRET_TOKEN ?? 'no-secret') : i === 11 ? (process.env.MULTI_SECRET ?? 'no-multi') : i === 12 ? (process.env.PLAIN_VAR ?? 'plain') : `line ${i}`}\n`,
  )
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize')
    send({
      id: m.id,
      result: {
        protocolVersion: m.params.protocolVersion,
        serverInfo: { name: 'crash', version: '1' },
        capabilities: { tools: {} },
      },
    })
  if (m.method === 'tools/list')
    send({
      id: m.id,
      result: {
        tools: ['crash', 'big-line'].map((name) => ({ name, inputSchema: { type: 'object' } })),
      },
    })
  if (m.method === 'tools/call' && m.params.name === 'crash') process.exit(1)
  if (m.method === 'tools/call' && m.params.name === 'big-line')
    process.stdout.write('x'.repeat(10 * 1024 * 1024 + 1))
})
