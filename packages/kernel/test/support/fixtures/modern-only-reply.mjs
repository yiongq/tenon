import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const request = JSON.parse(line)
  if (request.method === 'initialize')
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: 'modern only', data: { supported: ['2026-07-28'] } },
      }) + '\n',
    )
}
