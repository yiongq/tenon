import { spawn } from 'node:child_process'
spawn(
  process.execPath,
  ['-e', 'process.stdin.resume(); process.stdin.on("end", () => {}); setTimeout(() => {}, 60000)'],
  { stdio: 'inherit' },
)
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
