/**
 * The console fallbacks that became the log (docs/features/error-logs/spec.md §记什么 「Tenon
 * 自己的代码原来打到控制台的每一行」; acceptance 1): code that took no `log` and fell back to
 * `console.warn` now writes to `main.jsonl` instead.
 *
 * The process-wide `appLog` is the real one, swapped for a real `createAppLog` on this case's own
 * folder (the module is mocked only to hand out that instance), so what is read back is what
 * the fallback wrote: a line event with the source main gave it, its level, and its text. The
 * folder is the profile's own `logs`, as in the app.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { absolutePath } from '@tenon-app/kernel'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { DesktopFs } from '../src/main/host/fs.js'
import { openProfile, readConfig, configPath } from '../src/main/host/profile.js'
import { createMcpLogSink } from '../src/main/mcp/log-sink.js'
import {
  HOME,
  APP_DIR,
  appLog,
  makeTempRoot,
  readRecords,
  sweepTempRoots,
} from './support/error-logs.js'

vi.mock('../src/main/log/app-log.js', async (importOriginal) => {
  const actual = await importOriginal<{
    createAppLog: (options: {
      now: () => Date
      pid: number
      uid: number
      stderr: (text: string) => void
      maxBytes?: number
    }) => unknown
  }>()
  return {
    ...actual,
    appLog: actual.createAppLog({
      now: () => new Date(),
      pid: 4242,
      uid: process.getuid?.() ?? 0,
      stderr: () => {},
    }),
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

let logsDir = ''
let identity!: Awaited<ReturnType<typeof openProfile>>
const fs = new DesktopFs()

beforeAll(async () => {
  const root = makeTempRoot('fallbacks')
  identity = await openProfile(fs, absolutePath(root), 'local', 'personal')
  logsDir = join(identity.profileDir, 'logs')
  const opened = appLog.open(absolutePath(logsDir), {
    version: '0.0.0',
    packaged: true,
    home: absolutePath(HOME),
    appDir: absolutePath(APP_DIR),
  })
  if (!opened.ok) throw new Error(`the app log did not open: ${opened.reason}`)
  if (appLog.dir !== logsDir) throw new Error(`the app log is at ${String(appLog.dir)}`)
})

afterEach(() => {
  sweepTempRoots()
})

it('error-logs 验收 1: the console fallbacks of readConfig and the MCP log sink write to main.jsonl instead', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})

  // readConfig, given no `log`, as main's own reads are: a dropped entry is a warning, never its address.
  const broken = {
    id: '0b8f2a1c-3d4e-4f50-8a61-7b2c3d4e5f60',
    displayName: 'A',
    wire: 'grpc',
    baseURL: 'https://secret-host.example/v1',
    models: [],
  }
  writeFileSync(configPath(identity), JSON.stringify({ customVendors: [broken] }))
  await readConfig(fs, identity)

  // The MCP log sink's own failure: its file is a folder, so appending to it fails.
  mkdirSync(join(logsDir, 'mcp-notes.log'))
  const sink = createMcpLogSink(identity)
  await sink.append('notes', 'a line the sink cannot write')
  await sink.close()

  const lines = readRecords(join(logsDir, 'main.jsonl')).filter((r) => r.event === 'line')
  const config = lines.find((r) => r['source'] === 'config')
  expect(config).toMatchObject({ level: 'warn' })
  expect(String(config?.['text'])).toContain('customVendors[0]')
  expect(String(config?.['text'])).not.toContain('secret-host')
  const mcp = lines.find((r) => r['source'] === 'mcp')
  expect(mcp).toMatchObject({ level: 'warn' })
  expect(String(mcp?.['text'])).toContain('log write failed')

  // They no longer reach the console.
  expect(warn).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
})
