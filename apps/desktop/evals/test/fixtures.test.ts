/**
 * The fixtures of tasks 01–05 hold what their checks assume (spec 02 §评测集与测试宿主):
 *   - each task names a fixture that exists and script checks that exist, under its own file name;
 *   - 03 and 04 print a log longer than the spill threshold, the same log every time, with exactly
 *     one answering line, past the spill preview and past the first Read-sized piece (H9), and that
 *     line carries the answer the check holds.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ANSWER as ZH_ANSWER } from '../checks/03-long-log-zh.js'
import { ANSWER as EN_ANSWER } from '../checks/04-long-log-en.js'
import { fixturePath, runNode } from '../checks/support.js'

/** packages/kernel/src/loop/spill.ts. Both are 暂定 until plan step 34; keep these in step. */
const SPILL_THRESHOLD_CHARS = 30_000
const SPILL_PREVIEW_CHARS = 2_000

const TASKS = fileURLToPath(new URL('../../../../docs/evals/tasks/', import.meta.url))
const OURS = /^0[1-5]-/

describe('tasks 01–05', () => {
  it('name their own file, a fixture that is there and checks that load', async () => {
    const files = (await readdir(TASKS)).filter((name) => OURS.test(name)).toSorted()
    expect(files).toHaveLength(5)
    for (const file of files) {
      // oxlint-disable-next-line no-await-in-loop -- five small files
      const task = JSON.parse(await readFile(`${TASKS}${file}`, 'utf8')) as {
        id: string
        workspace?: string
        checks: Array<{ kind: string; id?: string }>
      }
      expect(`${task.id}.json`).toBe(file)
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect((await stat(fixturePath(task.workspace ?? ''))).isDirectory()).toBe(true)
      for (const check of task.checks.filter((c) => c.kind === 'script')) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        const loaded = (await import(`../checks/${String(check.id)}.ts`)) as { default: unknown }
        expect(typeof loaded.default).toBe('function')
      }
    }
  })
})

describe.each([
  {
    fixture: '03-long-log-zh',
    script: 'nightly.mjs',
    answer: ZH_ANSWER,
    // The one [错误] line; 错误码 alone also sits in passing test names and the summary.
    line: /^.*\[错误\].*$/gm,
    code: /E-\d{4}/g,
  },
  {
    fixture: '04-long-log-en',
    script: 'run-tests.mjs',
    answer: EN_ANSWER,
    // The one real failure; the flaky ↻ lines failed once and passed on retry.
    line: /^ {2}✗ .*$/gm,
    code: /\b[A-Z]{2}-\d{4}\b/g,
  },
])('$fixture', ({ fixture, script, answer, line, code }) => {
  it('prints the same long log every time, exit code 1', async () => {
    const first = await runNode(fixturePath(fixture), [script])
    const second = await runNode(fixturePath(fixture), [script])
    expect(first.code).toBe(1)
    expect(second.output).toBe(first.output)
    expect(first.output.length).toBeGreaterThan(SPILL_THRESHOLD_CHARS * 1.4)
  })

  it('has one answering line, past the preview and the first Read-sized piece', async () => {
    const { output } = await runNode(fixturePath(fixture), [script])
    const lines = [...output.matchAll(line)]
    expect(lines).toHaveLength(1)
    const [hit] = lines
    expect(hit?.index).toBeGreaterThan(SPILL_THRESHOLD_CHARS)
    expect(hit?.index).toBeGreaterThan(SPILL_PREVIEW_CHARS)
    expect(hit?.[0].match(code)).toEqual([answer])
    // The answer appears once in the whole output, and never in the script's source.
    expect(output.split(answer)).toHaveLength(2)
    expect(await readFile(fixturePath(fixture, script), 'utf8')).not.toContain(answer)
  })
})
