/**
 * An eval task and the check a task names (spec 02 §评测集与测试宿主): `docs/evals/tasks/<NN>-<slug>.json`
 * is checked with `evalTaskSchema`, and `apps/desktop/evals/checks/<id>.ts` default-exports an
 * `EvalCheck`. The interfaces are the spec's, word for word; the schema refuses what the spec says a
 * task may not ask for:
 *
 *   - an `allow` for `outside-workspace` (the test host only ever denies it);
 *   - an `allow` for `command` in a task with `web` (an injected page could have the model use Bash to
 *     reach the real network or read this machine's files);
 *   - `workspace` on a chat task (only for cowork);
 *   - any key the interface does not declare, at every level. A task file carries no `$schema`.
 *
 * `taskFileProblems` adds what zod cannot see: the id is the file's name, and every fixture file the
 * task references exists under `docs/evals/fixtures/` (the `.env` of a workspace is stored as
 * `dotenv.txt`, because `.gitignore` swallows `.env` at any depth; the host renames it on copy),
 * with no symlink on its path or anywhere under it, whether it points in or out.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { confirmReasonSchema } from '@tenon-app/contracts'
import type {
  ConfirmReason,
  ConfirmRequest,
  SearchHit,
  SessionProfile,
  TapeReader,
} from '@tenon-app/kernel'
import { z } from 'zod'

// apps/desktop/evals/task.ts —— 新增（02）；用 zod 校验 docs/evals/tasks/*.json
export interface EvalTask {
  id: string
  profile: SessionProfile
  turns: string[] // turns：依次发出的用户消息
  workspace?: string // fixtures 下的目录，只用于 cowork
  web?: { search?: string; pages?: Record<string, string> } // 假搜索结果文件；URL → 假网页文件
  host?: {
    answers?: Partial<Record<ConfirmReason, 'allow' | 'deny'>> // 没列的都拒；outside-workspace 只能拒；带 web 的题 command 只能拒
    disableTool?: { name: string; afterRound: number }
    usageLimitTokens?: number
  }
  checks: Array<{ kind: 'script'; id: string } | { kind: 'human'; text: string }>
  calibrates?: ('H9' | 'H10' | 'H11')[]
  compare?: boolean
  from: string[] // from：出自哪张卡的 tests
}

// apps/desktop/evals/checks/<id>.ts 默认导出一个 EvalCheck。TapeReader 已存在（tape/store.ts:285）；cards 是宿主收到的全部审批请求
export type EvalCheck = (ctx: {
  tape: TapeReader
  sessionId: string
  workspaceDir: string
  cards: readonly ConfirmRequest[]
}) => Promise<{ pass: boolean; note: string }>

/** `docs/evals/`, from this file (apps/desktop/evals/). */
export const EVALS_DOCS_DIR = join(import.meta.dirname, '..', '..', '..', 'docs', 'evals')

/** A task's id, and the stem of its file, its fixture folder and its compare note: `<NN>-<slug>`. */
export const TASK_ID_PATTERN = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A script check's id, and the stem of `checks/<id>.ts`: no path can be spelled with it. */
export const CHECK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A path under `docs/evals/fixtures/`, as a task names it: relative, and never leaving that folder. */
const fixturePath = z
  .string()
  .min(1)
  .refine((path) => !isAbsolute(path) && !normalize(path).split(sep).includes('..'), {
    message: 'a fixture path is relative to docs/evals/fixtures and stays inside it',
  })

const answerSchema = z.enum(['allow', 'deny'])

const checkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('script'), id: z.string().regex(CHECK_ID_PATTERN) }),
  z.strictObject({ kind: z.literal('human'), text: z.string().min(1) }),
])

export const evalTaskSchema = z
  .strictObject({
    id: z.string().regex(TASK_ID_PATTERN),
    // 02 writes no `code` profile (§会话事实: ProfileSetPayload excludes it), so no task can run in it.
    profile: z.enum(['chat', 'cowork']),
    turns: z.array(z.string().min(1)).min(1),
    workspace: fixturePath.exactOptional(),
    web: z
      .strictObject({
        search: fixturePath.exactOptional(),
        pages: z.record(z.url(), fixturePath).exactOptional(),
      })
      .exactOptional(),
    host: z
      .strictObject({
        answers: z.partialRecord(confirmReasonSchema, answerSchema).exactOptional(),
        disableTool: z
          .strictObject({ name: z.string().min(1), afterRound: z.int().nonnegative() })
          .exactOptional(),
        usageLimitTokens: z.int().positive().exactOptional(),
      })
      .exactOptional(),
    checks: z.array(checkSchema).min(1),
    calibrates: z.array(z.enum(['H9', 'H10', 'H11'])).exactOptional(),
    compare: z.boolean().exactOptional(),
    from: z.array(z.string().min(1)),
  })
  .superRefine((task, ctx) => {
    const answers = task.host?.answers ?? {}
    if (answers['outside-workspace'] === 'allow') {
      ctx.addIssue({
        code: 'custom',
        path: ['host', 'answers', 'outside-workspace'],
        message: 'outside-workspace can only be denied (§评测集与测试宿主「自动答复」)',
      })
    }
    if (task.web !== undefined && answers.command === 'allow') {
      ctx.addIssue({
        code: 'custom',
        path: ['host', 'answers', 'command'],
        message: 'a task with web can only deny command: an injected page could reach the network',
      })
    }
    if (task.profile === 'chat' && task.workspace !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['workspace'],
        message: 'workspace is only for cowork tasks',
      })
    }
  }) satisfies z.ZodType<EvalTask>

/** A fake search result file (`web.search`): the hits every query of the task gets back. */
export const searchHitsSchema = z.array(
  z.strictObject({
    title: z.string(),
    url: z.string().nullable(),
    snippet: z.string().exactOptional(),
    publishedAt: z.string().exactOptional(),
  }),
) satisfies z.ZodType<SearchHit[]>

/** Where a fixture path points. */
export function fixtureFile(fixturesDir: string, path: string): string {
  return join(fixturesDir, path)
}

/**
 * The first symlink on a fixture path or anywhere under it, as a path from `fixturesDir`, or null
 * (also for a path that is not there). A fixture holds files and folders only (Revision (17) ⑤): a
 * link, pointing in or out, would have the host work in or read whatever it points at. The folder
 * `fixturesDir` itself may sit behind a link, as macOS's temp folder does.
 */
export function fixtureSymlink(fixturesDir: string, path: string): string | null {
  const shown = (at: string): string => relative(fixturesDir, at).split(sep).join('/')
  let at = fixturesDir
  let stat: Stats | null = null
  for (const part of normalize(path).split(sep)) {
    if (part === '' || part === '.') continue
    at = join(at, part)
    stat = lstatSync(at, { throwIfNoEntry: false }) ?? null
    if (stat === null) return null
    if (stat.isSymbolicLink()) return shown(at)
  }
  if (stat?.isDirectory() ?? lstatSync(at).isDirectory()) {
    for (const entry of readdirSync(at, { withFileTypes: true, recursive: true })) {
      if (entry.isSymbolicLink()) return shown(join(entry.parentPath, entry.name))
    }
  }
  return null
}

/** Every fixture a task references, with what it must be. */
export function fixtureReferences(
  task: EvalTask,
): Array<{ path: string; kind: 'directory' | 'file' | 'search' }> {
  const refs: Array<{ path: string; kind: 'directory' | 'file' | 'search' }> = []
  if (task.workspace !== undefined) refs.push({ path: task.workspace, kind: 'directory' })
  if (task.web?.search !== undefined) refs.push({ path: task.web.search, kind: 'search' })
  for (const page of Object.values(task.web?.pages ?? {})) refs.push({ path: page, kind: 'file' })
  return refs
}

/**
 * What is wrong with one task file, as lines; empty when it passes. `name` is the file's name in
 * `tasks/`; `checksDir` is where each script check's module must be.
 */
export function taskFileProblems(options: {
  readonly name: string
  readonly text: string
  readonly fixturesDir: string
  readonly checksDir: string
}): { task: EvalTask | null; problems: string[] } {
  const { name, fixturesDir, checksDir } = options
  let raw: unknown
  try {
    raw = JSON.parse(options.text)
  } catch (error) {
    return { task: null, problems: [`${name}: not JSON (${String(error)})`] }
  }
  const parsed = evalTaskSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      task: null,
      problems: parsed.error.issues.map(
        (issue) => `${name}: ${issue.path.join('.') || '(task)'}: ${issue.message}`,
      ),
    }
  }
  const task = parsed.data
  const problems: string[] = []
  if (`${task.id}.json` !== name) problems.push(`${name}: id ${task.id} is not the file's name`)
  for (const ref of fixtureReferences(task)) {
    const at = fixtureFile(fixturesDir, ref.path)
    const link = fixtureSymlink(fixturesDir, ref.path)
    if (link !== null) {
      problems.push(`${name}: fixture ${ref.path} has a symlink at ${link}`)
      continue
    }
    const found = existsSync(at) ? statSync(at) : null
    if (found === null) {
      problems.push(`${name}: fixture ${ref.path} does not exist`)
    } else if (ref.kind === 'directory' ? !found.isDirectory() : !found.isFile()) {
      problems.push(
        `${name}: fixture ${ref.path} is not a ${ref.kind === 'directory' ? 'folder' : 'file'}`,
      )
    } else if (ref.kind === 'search') {
      const hits = searchHitsSchema.safeParse(safeJson(readFileSync(at, 'utf8')))
      if (!hits.success) problems.push(`${name}: fixture ${ref.path} is not a list of search hits`)
    }
  }
  for (const check of task.checks) {
    if (check.kind === 'script' && !existsSync(join(checksDir, `${check.id}.ts`))) {
      problems.push(`${name}: script check ${check.id} has no checks/${check.id}.ts`)
    }
  }
  return { task, problems }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
