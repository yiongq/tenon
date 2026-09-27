/**
 * 01 · a small cowork coding fix (spec 02 §评测集与测试宿主; the §同题对比 set). The failing receipt
 * test is in test.mjs, the cause in src/money.js: `formatCents` drops a leading zero of the cents.
 *
 * Pass needs all four, each decided from a file or a Tape fact:
 *   1. test.mjs is byte-for-byte the fixture's (the fix is in the source, as the turn asks);
 *   2. `node test.mjs` exits 0 in the workspace;
 *   3. `formatCents` itself is fixed — a hidden probe, so a workaround in cart.js does not pass;
 *   4. the model ran the test after its last file change, and that run passed (the turn's last step).
 */
import { readFile } from 'node:fs/promises'
import type { EvalCheck } from './types.js'
import { callsOf, fixturePath, readSession, readText, runNode, succeeded } from './support.js'

const FIXTURE = '01-fix-failing-test'
const TEST_RUN = /\btest\.mjs\b|\b(?:npm|pnpm) (?:run )?test\b/

const PROBE = `
import { formatCents } from './src/money.js'
const cases = [[5, '$0.05'], [105, '$1.05'], [1200, '$12.00'], [-7, '-$0.07'], [1999, '$19.99']]
for (const [cents, want] of cases) {
  const got = formatCents(cents)
  if (got !== want) {
    process.stdout.write(cents + ' -> ' + got + ', want ' + want + '\\n')
    process.exitCode = 1
  }
}
`

const check: EvalCheck = async ({ tape, sessionId, workspaceDir }) => {
  const problems: string[] = []

  const original = await readFile(fixturePath(FIXTURE, 'test.mjs'), 'utf8')
  if ((await readText(workspaceDir, 'test.mjs')) !== original) problems.push('test.mjs was changed')

  const suite = await runNode(workspaceDir, ['test.mjs'])
  if (suite.code !== 0) problems.push(`node test.mjs exits ${String(suite.code)}`)

  const probe = await runNode(workspaceDir, ['--input-type=module', '--eval', PROBE])
  if (probe.code !== 0) {
    problems.push(`formatCents is still wrong (${probe.output.trim().split('\n')[0] ?? ''})`)
  }

  const calls = callsOf(await readSession(tape, sessionId))
  const writes = calls.filter(
    (call) => (call.name === 'Write' || call.name === 'Edit') && succeeded(call),
  )
  const testRuns = calls.filter(
    (call) =>
      call.name === 'Bash' &&
      typeof call.input['command'] === 'string' &&
      TEST_RUN.test(call.input['command']),
  )
  const lastWrite = writes.at(-1)
  const lastGreen = testRuns.findLast(succeeded)
  if (
    lastGreen === undefined ||
    (lastWrite !== undefined && lastGreen.entryId < lastWrite.entryId)
  ) {
    problems.push('no passing test run after the last file change')
  }

  const counts = `${testRuns.length} test run(s), ${writes.length} file write(s)`
  return problems.length === 0
    ? { pass: true, note: `fixed in the source; ${counts}` }
    : { pass: false, note: `${problems.join('; ')}; ${counts}` }
}

export default check
