import { spawn } from 'node:child_process'
spawn(
  process.execPath,
  ['-e', 'process.stdin.resume(); process.stdin.on("end", () => {}); setTimeout(() => {}, 60000)'],
  { stdio: process.argv.includes('--serve') ? ['ignore', 'inherit', 'inherit'] : 'inherit' },
)
if (process.argv.includes('--serve')) {
  const { serveStdio, StdioServerTransport } = await import('@modelcontextprotocol/server/stdio')
  const { createFixtureServer } = await import('./modern-server.mjs')
  serveStdio(() => createFixtureServer(), {
    legacy: 'serve',
    transport: new StdioServerTransport(),
  })
}
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
