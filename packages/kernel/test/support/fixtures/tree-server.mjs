import { spawn } from 'node:child_process'
const stubborn = process.argv.includes('--stubborn')
if (stubborn) process.on('SIGTERM', () => {})
spawn(
  process.execPath,
  [
    '-e',
    'process.on("SIGTERM", () => {}); process.stdin.resume(); process.stdin.on("end", () => {}); setTimeout(() => {}, 60000)',
  ],
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
process.stdin.on('end', () => {
  if (!stubborn) process.exit(0)
})
if (stubborn) setInterval(() => {}, 60_000)
