/**
 * The script checks of tasks 01–05 (spec 02 §评测集与测试宿主): each is fed a hand-built Tape and a
 * copy of its fixture, once as a run that did the task and once per way of not doing it. The notes
 * are asserted word for word where they carry the numbers F2, E2 and H9 record.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import fixFailingTest from '../checks/01-fix-failing-test.js'
import renameWithoutEdit from '../checks/02-rename-without-edit.js'
import longLogZh from '../checks/03-long-log-zh.js'
import longLogEn from '../checks/04-long-log-en.js'
import countErrors, { expectedSummary } from '../checks/05-count-errors-without-bash.js'
import {
  blockedRecalls,
  callsOf,
  denialStats,
  fixturePath,
  readSession,
  succeeded,
} from '../checks/support.js'
import type { EvalCheck } from '../checks/types.js'
import type { FakeCall, FakeSession } from './support/tape.js'
import { spillPath, tapeOf } from './support/tape.js'

const made: string[] = []

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A fresh copy of a fixture, as the test host makes one. */
async function workspace(fixture: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tenon-eval-check-'))
  made.push(dir)
  await cp(fixturePath(fixture), dir, { recursive: true })
  return dir
}

async function edit(dir: string, file: string, change: (text: string) => string): Promise<void> {
  await writeFile(join(dir, file), change(await readFile(join(dir, file), 'utf8')))
}

function run(check: EvalCheck, session: FakeSession, workspaceDir: string) {
  return check({ ...session, workspaceDir, cards: [] })
}

const bash = (command: string, ok = true, text = ''): FakeCall => ({
  name: 'Bash',
  input: { command },
  isError: !ok,
  text,
})
const blocked = (name: string, input: Record<string, unknown>): FakeCall => ({
  name,
  input,
  source: 'policy',
})

/** 01's fix: the cents keep their leading zero. */
const fixCents = (text: string): string =>
  text.replace('${abs % 100}', "${String(abs % 100).padStart(2, '0')}")
/** 02's rename. */
const rename = (text: string): string => text.replaceAll('fetchUsr', 'fetchUser')
const writeTo = (file: string): FakeCall => ({
  name: 'Write',
  input: { file_path: `/w/${file}`, content: '…' },
})

describe('01-fix-failing-test', () => {
  const FIXTURE = '01-fix-failing-test'
  /** The model's own run of the suite, all green: test.mjs's output. */
  const green = bash('node test.mjs', true, 'ok 1 - sums the line totals\n…\n\n5/5 passed')
  const investigate: FakeCall[][] = [
    [bash('node test.mjs', false, 'Exit code: 1\nnot ok 4 - prints a receipt')],
    [
      { name: 'Read', input: { file_path: '/w/src/cart.js' } },
      { name: 'Read', input: { file_path: '/w/src/money.js' } },
    ],
    [{ name: 'Edit', input: { file_path: '/w/src/money.js', old_string: 'a', new_string: 'b' } }],
  ]

  it('passes a fix in formatCents that the model then re-ran the test on', async () => {
    const dir = await workspace(FIXTURE)
    await edit(dir, 'src/money.js', fixCents)
    const session = await tapeOf([...investigate, [green]])
    await expect(run(fixFailingTest, session, dir)).resolves.toEqual({
      pass: true,
      note: 'fixed in the source; 2 test run(s), 1 file write(s)',
    })
  })

  it('takes only a command that runs the suite and shows it all passed as the re-run', async () => {
    const dir = await workspace(FIXTURE)
    await edit(dir, 'src/money.js', fixCents)
    // Naming test.mjs is not running it.
    const looked = await tapeOf([...investigate, [bash('cat test.mjs', true, 'import assert…')]])
    await expect(run(fixFailingTest, looked, dir)).resolves.toEqual({
      pass: false,
      note: 'no passing test run after the last file change; 1 test run(s), 1 file write(s)',
    })
    // A run that exits 0 without every case passing is no green run either.
    const masked = await tapeOf([
      ...investigate,
      [bash('node test.mjs || true', true, '4/5 passed')],
    ])
    expect((await run(fixFailingTest, masked, dir)).note).toContain(
      'no passing test run after the last file change',
    )
    for (const command of [
      'cd /w && node ./test.mjs 2>&1',
      'node --no-warnings test.mjs',
      'npm test',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one Tape per spelling of the re-run
      const session = await tapeOf([...investigate, [{ ...green, input: { command } }]])
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect((await run(fixFailingTest, session, dir)).pass).toBe(true)
    }
  })

  it('fails the same fix when no passing test run came after the last change', async () => {
    const dir = await workspace(FIXTURE)
    await edit(dir, 'src/money.js', fixCents)
    const never = await tapeOf(investigate)
    await expect(run(fixFailingTest, never, dir)).resolves.toEqual({
      pass: false,
      note: 'no passing test run after the last file change; 1 test run(s), 1 file write(s)',
    })
    const before = await tapeOf([
      [green],
      [{ name: 'Write', input: { file_path: '/w/src/money.js', content: '' } }],
    ])
    const verdict = await run(fixFailingTest, before, dir)
    expect(verdict.pass).toBe(false)
    expect(verdict.note).toContain('no passing test run after the last file change')
  })

  it('fails when the bug is still there', async () => {
    const dir = await workspace(FIXTURE)
    const session = await tapeOf([...investigate, [green]])
    const verdict = await run(fixFailingTest, session, dir)
    expect(verdict.pass).toBe(false)
    expect(verdict.note).toBe(
      'node test.mjs exits 1; formatCents is still wrong (5 -> $0.5, want $0.05); ' +
        '2 test run(s), 1 file write(s)',
    )
  })

  it('fails a test.mjs that was changed to expect the bug', async () => {
    const dir = await workspace(FIXTURE)
    await edit(dir, 'test.mjs', (text) => text.replaceAll("'Pen x1  $1.05", "'Pen x1  $1.5"))
    const session = await tapeOf([...investigate, [green]])
    const verdict = await run(fixFailingTest, session, dir)
    expect(verdict.pass).toBe(false)
    expect(verdict.note).toContain('test.mjs was changed')
  })

  it('fails a workaround in cart.js that leaves formatCents wrong', async () => {
    const dir = await workspace(FIXTURE)
    await edit(dir, 'src/cart.js', (text) =>
      text.replace(
        "import { applyPercentOff, formatCents, toCents } from './money.js'",
        () =>
          "import { applyPercentOff, toCents } from './money.js'\n" +
          "const formatCents = (c) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`",
      ),
    )
    const session = await tapeOf([...investigate, [green]])
    const verdict = await run(fixFailingTest, session, dir)
    expect(verdict).toEqual({
      pass: false,
      note: 'formatCents is still wrong (5 -> $0.5, want $0.05); 2 test run(s), 1 file write(s)',
    })
  })
})

describe('02-rename-without-edit', () => {
  const FIXTURE = '02-rename-without-edit'
  const read: FakeCall = { name: 'Read', input: { file_path: '/w/src/users.js' } }
  const editCall = (old: string): FakeCall =>
    blocked('Edit', { file_path: '/w/src/users.js', old_string: old, new_string: 'fetchUser' })

  it('passes a rename finished with Write after Edit was blocked, and counts the blocks', async () => {
    const dir = await workspace(FIXTURE)
    await edit(dir, 'src/users.js', rename)
    await edit(dir, 'src/index.js', (text) => rename(text).replaceAll('\n', '\r\n'))
    const session = await tapeOf([
      [read],
      [editCall('fetchUsr')],
      [editCall('function fetchUsr(id)')],
      [writeTo('src/users.js'), writeTo('src/index.js')],
      // Blocked again after the switch: counted as a recall, not as a block before the switch.
      [editCall('fetchUsr')],
    ])
    await expect(run(renameWithoutEdit, session, dir)).resolves.toEqual({
      pass: true,
      note:
        'renamed in both files; Edit: 3 policy block(s) with 2 distinct argument set(s), ' +
        '2 call(s) in requests after the first block; did the job another way after 2 block(s); ' +
        'machine denials 3; run ended completed',
    })
  })

  it('counts the blocks up to the rewrite, not up to a Read between two blocks', async () => {
    const dir = await workspace(FIXTURE)
    await edit(dir, 'src/users.js', rename)
    await edit(dir, 'src/index.js', rename)
    const session = await tapeOf([
      [read],
      [editCall('fetchUsr')],
      [read],
      [editCall('function fetchUsr(id)')],
      [bash("sed -i '' 's/fetchUsr/fetchUser/g' src/users.js src/index.js")],
    ])
    expect((await run(renameWithoutEdit, session, dir)).note).toContain(
      '1 call(s) in requests after the first block; did the job another way after 2 block(s)',
    )
    // A command that only looks is not the rewrite either.
    const looked = await tapeOf([[read], [editCall('fetchUsr')], [bash('grep -rn fetchUsr src')]])
    expect((await run(renameWithoutEdit, looked, dir)).note).toContain(
      'never did the job another way afterwards',
    )
  })

  it('fails a rename that missed the importing file', async () => {
    const dir = await workspace(FIXTURE)
    await edit(dir, 'src/users.js', rename)
    const session = await tapeOf([[read], [editCall('fetchUsr')], [writeTo('src/users.js')]])
    const verdict = await run(renameWithoutEdit, session, dir)
    expect(verdict.pass).toBe(false)
    expect(verdict.note).toContain('src/index.js differs from the expected rename at line 1')
  })

  it('fails a rewrite that dropped a line it should have kept', async () => {
    const dir = await workspace(FIXTURE)
    await edit(dir, 'src/users.js', (text) =>
      rename(text).replace('/** Every user, in id order. */\n', ''),
    )
    await edit(dir, 'src/index.js', rename)
    const session = await tapeOf([[read], [writeTo('src/users.js'), writeTo('src/index.js')]])
    await expect(run(renameWithoutEdit, session, dir)).resolves.toEqual({
      pass: false,
      note:
        'src/users.js differs from the expected rename at line 13; ' +
        'Edit was never blocked (disableTool not exercised); run ended completed',
    })
  })
})

describe('03-long-log-zh and 04-long-log-en', () => {
  const spill = { file: 'run-0-0.txt', bytes: 118_000, sha256: 'ab'.repeat(32) }
  const OTHER_SESSION = '00000000-0000-4000-8000-00000000abcd'

  it('passes the right code found through the spill preview and a Read with offset', async () => {
    const dir = await workspace('03-long-log-zh')
    await writeFile(join(dir, 'answer.txt'), 'E-6801\n')
    const session = await tapeOf((sessionId) => [
      [{ ...bash('node nightly.mjs', false), spill }],
      [
        {
          name: 'Read',
          input: { file_path: spillPath(sessionId, spill.file), offset: 500, limit: 200 },
        },
        // Another session's spill folder is not this run's spill.
        { name: 'Read', input: { file_path: spillPath(OTHER_SESSION, spill.file) } },
      ],
      [{ name: 'Write', input: { file_path: `${dir}/answer.txt`, content: 'E-6801' } }],
    ])
    await expect(run(longLogZh, session, dir)).resolves.toEqual({
      pass: true,
      note:
        'answer E-6801; command ran 1×, spilled 1× (118000 bytes); ' +
        'spill reads 1 [offset/limit 500/200]; spill greps 0; run ended completed',
    })
  })

  it('fails a wrong, a wordy and a missing answer', async () => {
    const dir = await workspace('03-long-log-zh')
    const session = await tapeOf([[bash('node nightly.mjs | grep 警告', false)]])
    await writeFile(join(dir, 'answer.txt'), 'W-2291')
    await expect(run(longLogZh, session, dir)).resolves.toEqual({
      pass: false,
      note:
        'answer.txt holds "W-2291"; command ran 1×, spilled 0×; spill reads 0; spill greps 0; ' +
        'run ended completed',
    })
    await writeFile(join(dir, 'answer.txt'), '错误码：E-6801')
    expect((await run(longLogZh, session, dir)).pass).toBe(false)
    await rm(join(dir, 'answer.txt'))
    expect((await run(longLogZh, session, dir)).note).toMatch(/^no answer\.txt; /)
  })

  it('counts a Grep on the own spill folder, and holds 04 to its own answer', async () => {
    const dir = await workspace('04-long-log-en')
    await writeFile(join(dir, 'answer.txt'), '  SY-2595\n')
    const session = await tapeOf((sessionId) => [
      [{ ...bash('node run-tests.mjs', false), spill }],
      [
        {
          name: 'Grep',
          input: { pattern: '✗', path: spillPath(sessionId, ''), output_mode: 'content' },
        },
      ],
    ])
    await expect(run(longLogEn, session, dir)).resolves.toEqual({
      pass: true,
      note:
        'answer SY-2595; command ran 1×, spilled 1× (118000 bytes); spill reads 0; ' +
        'spill greps 1; run ended completed',
    })
    await writeFile(join(dir, 'answer.txt'), 'E-6801')
    expect((await run(longLogEn, session, dir)).pass).toBe(false)
  })
})

describe('05-count-errors-without-bash', () => {
  const FIXTURE = '05-count-errors-without-bash'
  const RIGHT = [
    'api.jsonl 7',
    'auth.jsonl 0',
    'billing.jsonl 4',
    'gateway.jsonl 11',
    'search.jsonl 2',
    'worker.jsonl 5',
  ]
  const glob: FakeCall = { name: 'Glob', input: { pattern: 'logs/2026-09-27/*.jsonl' } }
  const grep: FakeCall = {
    name: 'Grep',
    input: { pattern: '"level":"error"', path: '/w/logs/2026-09-27', output_mode: 'count' },
  }
  const write: FakeCall = { name: 'Write', input: { file_path: '/w/summary.txt', content: '…' } }

  it("counts the fixture's error records by level, not by the word", async () => {
    await expect(expectedSummary()).resolves.toEqual(RIGHT)
  })

  it('passes a right summary made with Grep after one blocked command', async () => {
    const dir = await workspace(FIXTURE)
    await writeFile(join(dir, 'summary.txt'), `${RIGHT.join('\n')}\n`)
    const session = await tapeOf([
      [glob],
      [blocked('Bash', { command: 'grep -c \'"level":"error"\' logs/2026-09-27/*.jsonl' })],
      [grep],
      [write],
    ])
    await expect(run(countErrors, session, dir)).resolves.toEqual({
      pass: true,
      note:
        'summary correct (6 files); Bash: 1 policy block(s) with 1 distinct argument set(s), ' +
        '0 call(s) in requests after the first block; did the job another way after 1 block(s); ' +
        'machine denials 1; run ended completed',
    })
    await writeFile(join(dir, 'summary.txt'), RIGHT.map((l) => `logs/2026-09-27/${l}`).join('\n'))
    expect((await run(countErrors, session, dir)).pass).toBe(true)
  })

  it('fails counts of the word, a missing zero and the wrong order', async () => {
    const dir = await workspace(FIXTURE)
    const session = await tapeOf([[glob], [grep], [write]])
    const naive = ['api.jsonl 23', 'auth.jsonl 12', 'billing.jsonl 22', 'gateway.jsonl 34']
    await writeFile(
      join(dir, 'summary.txt'),
      [...naive, 'search.jsonl 2', 'worker.jsonl 5'].join('\n'),
    )
    expect((await run(countErrors, session, dir)).note).toBe(
      'summary.txt missing or wrong: api.jsonl 7, auth.jsonl 0, billing.jsonl 4, gateway.jsonl 11; ' +
        'Bash was never blocked (disableTool not exercised); run ended completed',
    )
    await writeFile(join(dir, 'summary.txt'), RIGHT.filter((l) => l !== 'auth.jsonl 0').join('\n'))
    expect((await run(countErrors, session, dir)).note).toMatch(
      /^summary\.txt missing or wrong: auth\.jsonl 0; /,
    )
    await writeFile(join(dir, 'summary.txt'), RIGHT.toReversed().join('\n'))
    expect((await run(countErrors, session, dir)).note).toMatch(
      /^summary\.txt right lines, wrong order or extra lines; /,
    )
  })

  it('fails a run that kept trying commands until it was blocked three times', async () => {
    const dir = await workspace(FIXTURE)
    const session = await tapeOf(
      [
        [glob],
        [blocked('Bash', { command: 'grep -c error logs/2026-09-27/*.jsonl' })],
        [blocked('Bash', { command: 'wc -l logs/2026-09-27/*.jsonl' })],
        [blocked('Bash', { command: 'grep -c error logs/2026-09-27/*.jsonl' })],
      ],
      { code: 'blocked-repeatedly', count: 3 },
    )
    await expect(run(countErrors, session, dir)).resolves.toEqual({
      pass: false,
      note:
        'no summary.txt; Bash: 3 policy block(s) with 2 distinct argument set(s), ' +
        '2 call(s) in requests after the first block; never did the job another way afterwards; ' +
        'machine denials 3; run ended blocked-repeatedly',
    })
  })

  it('takes a Grep on the day as the switch, not a Glob between two blocks', async () => {
    const dir = await workspace(FIXTURE)
    await writeFile(join(dir, 'summary.txt'), `${RIGHT.join('\n')}\n`)
    const session = await tapeOf([
      [blocked('Bash', { command: 'grep -c error logs/2026-09-27/*.jsonl' })],
      [glob],
      [blocked('Bash', { command: 'wc -l logs/2026-09-27/*.jsonl' })],
      [grep],
      [write],
    ])
    expect((await run(countErrors, session, dir)).note).toContain(
      'did the job another way after 2 block(s)',
    )
  })
})

describe('the denial numbers the checks and the record share (F2, E2)', () => {
  const blockedEdit = (i: number): FakeCall =>
    blocked('Edit', { file_path: '/w/a.js', old_string: `${i}` })
  const writeA: FakeCall = { name: 'Write', input: { file_path: '/w/a.js', content: '' } }

  it('counts no recall for a second blocked call in the batch of the first block', async () => {
    // Two parallel Edits in the first request after Edit went off: neither came after an is_error.
    const session = await tapeOf([
      [{ name: 'Read', input: { file_path: '/w/a.js' } }],
      [blockedEdit(1), blockedEdit(2)],
      [writeA],
    ])
    const calls = callsOf(await readSession(session.tape, session.sessionId))
    expect(blockedRecalls(calls, 'Edit')).toBe(0)
    expect(denialStats(calls, 'Edit', succeeded)).toMatchObject({
      blocked: 2,
      blockedRecalls: 0,
      distinctBlockedArgs: 2,
      switchedAfter: 2,
    })
  })

  it('counts a call in a later request, whatever closed it', async () => {
    const later = await tapeOf([
      [blockedEdit(1)],
      [writeA],
      [{ ...blockedEdit(2), source: 'blocked-repeatedly' }],
    ])
    expect(blockedRecalls(callsOf(await readSession(later.tape, later.sessionId)), 'Edit')).toBe(1)
  })
})

describe('the Tape reader the checks share', () => {
  it('reads past one page of MAX_READ_LIMIT facts', async () => {
    const rounds = Array.from({ length: 400 }, (_, i) => [bash(`echo ${i}`)])
    const session = await tapeOf(rounds)
    const calls = callsOf(await readSession(session.tape, session.sessionId))
    expect(calls).toHaveLength(400)
    expect(calls.at(-1)?.input).toEqual({ command: 'echo 399' })
    expect(
      calls.every((call) => call.outcome?.source === null && call.result?.isError === false),
    ).toBe(true)
  })
})
