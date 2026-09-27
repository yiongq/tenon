/**
 * The eval test host (spec 02 §评测集与测试宿主; D7). Answering cards by itself is this host's
 * behaviour, never a setting a user gets. 02 has no sandbox: files and commands go through the
 * desktop's real fs and process, and the host holds these lines instead:
 *
 *   - One `mkdtemp` directory per run holds the profile, the workspace (copied from the fixture,
 *     `dotenv.txt` renamed to `.env`), and the HOME and TMPDIR a command sees; a command's cwd is the
 *     workspace. The child's environment is PATH, HOME, TMPDIR and LANG and nothing else — no key —
 *     handed over as the kernel's `commandShell`. The Tape is the kernel's memory store (runner.ts).
 *   - Cards are answered by `ConfirmReason` from `host.answers`; an unlisted reason is denied,
 *     `outside-workspace` is always denied, and so is `command` in a task with `web`, whatever the
 *     task says (zod refuses such a task already; this is the second line). An allow's scope is the
 *     kernel's, as a click on 「允许」 is: `AnswerCommand` carries none, and the kernel grants
 *     「本会话」 wherever §作用域与授权键 lets the card offer it (`PendingCard.allowScope`).
 *   - Questions are skipped (runner.ts).
 *   - A task with `web` gets a fake `SearchBackend` reading `web.search` — `host` and `domainFilter`
 *     are those of the column's real backend, so the ToolSpec variant is the product's — and a fake
 *     `fetchUntrusted` reading `web.pages`, 404 for a URL not in the table. Neither leaves the
 *     machine; the conversation itself goes to the real network. Nothing is filtered by URL at the
 *     network layer: the Anthropic search backend and the conversation share one URL.
 *     WebSearch and WebFetch are not in the product table yet (plan steps 27–29): these are the seams
 *     they will find, `RunAssembly.search` and `HostNetwork.fetchUntrusted`.
 *   - `disableTool`: after round N, the policy is swapped for a snapshot that denies the tool — as
 *     the memory host's `setPolicy` does — so the block is recorded as `policy`.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { BUILTIN_SERVER_ID, EMPTY_POLICY, absolutePath } from '@tenon-app/kernel'
import type {
  AbsolutePath,
  CommandShell,
  ConfirmReason,
  ConfirmRequest,
  FetchLike,
  HostAdapter,
  HostConfirm,
  HostNetwork,
  HostPolicy,
  PolicyState,
  SearchBackend,
  SearchHit,
} from '@tenon-app/kernel'
import { SystemClock } from '../src/main/host/clock.js'
import { DesktopFs } from '../src/main/host/fs.js'
import { createDesktopNetwork } from '../src/main/host/network.js'
import { createHostProcess } from '../src/main/host/process.js'
import { openProfile } from '../src/main/host/profile.js'
import { PassthroughSandbox } from '../src/main/host/sandbox.js'
import { MemorySecrets } from '../src/main/host/secrets.js'
import { pickShell } from '../src/main/host/shell-env.js'
import { dedicatedFolderFor } from '../src/main/workspace.js'
import type { EvalTask } from './task.js'
import { fixtureFile, searchHitsSchema } from './task.js'

export const EVAL_USER_ID = 'eval'
export const EVAL_TENANT_ID = 'eval'

/** The names a fixture stores a workspace's `.env` under (`.gitignore` swallows `.env`). */
export const DOTENV_FIXTURE_NAME = 'dotenv.txt'

/** The only variables a command sees (§评测集与测试宿主「临时目录」). */
export const CHILD_ENV_NAMES = ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const

/** The network the host hands the kernel: the desktop's, with `fetchUntrusted` faked for `web`. */
export type EvalNetwork = HostNetwork & { readonly fetchUntrusted?: FetchLike }

/**
 * How the host answers a card: from `host.answers` by reason, deny when unlisted; never an allow
 * for `outside-workspace`, nor for `command` when the task has `web`.
 */
export function autoAnswer(
  reason: ConfirmReason,
  task: Pick<EvalTask, 'web' | 'host'>,
): 'allow' | 'deny' {
  if (reason === 'outside-workspace') return 'deny'
  if (reason === 'command' && task.web !== undefined) return 'deny'
  return task.host?.answers?.[reason] ?? 'deny'
}

/** The environment a command gets: PATH and LANG from the runner, HOME and TMPDIR in the run's dir. */
export function childEnv(
  home: AbsolutePath,
  tmp: AbsolutePath,
  runner: Readonly<Record<string, string | undefined>> = process.env,
): Record<(typeof CHILD_ENV_NAMES)[number], string> {
  return {
    PATH: runner['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    TMPDIR: tmp,
    LANG: runner['LANG'] ?? 'en_US.UTF-8',
  }
}

/** A policy that can be swapped once a task says so, notifying subscribers like the memory host's. */
export class SwappablePolicy implements HostPolicy {
  #state: PolicyState = { status: 'current', version: 'empty', snapshot: EMPTY_POLICY }
  readonly #listeners = new Set<{ readonly listener: (state: PolicyState) => void }>()

  current(): PolicyState {
    return this.#state
  }

  subscribe(listener: (state: PolicyState) => void): () => void {
    const entry = { listener }
    this.#listeners.add(entry)
    return () => {
      this.#listeners.delete(entry)
    }
  }

  set(state: PolicyState): void {
    this.#state = state
    for (const entry of this.#listeners) entry.listener(state)
  }
}

/** The snapshot `disableTool` swaps in: the one builtin tool denied by policy (§第 1 层真值表). */
export function disabledToolPolicy(toolName: string): PolicyState {
  return {
    status: 'current',
    version: `eval-disable-${toolName}`,
    snapshot: {
      tools: [
        { policyId: 'eval-disable-tool', serverId: BUILTIN_SERVER_ID, effect: 'deny', toolName },
      ],
    },
  }
}

/** Every card the kernel delivered, once each: a redelivered request (HostConfirm 可重复投递) is one card. */
export class RecordingConfirm implements HostConfirm {
  readonly cards: ConfirmRequest[] = []

  async request(req: ConfirmRequest): Promise<void> {
    if (!this.cards.some((card) => card.requestId === req.requestId)) this.cards.push(req)
  }
}

/** The search backend a column's host has (§工具形状与后端选择), or none. */
export function searchHostOf(baseURL: string): SearchBackend['host'] | null {
  const host = new URL(baseURL).hostname
  return host === 'open.bigmodel.cn' || host === 'api.anthropic.com' ? host : null
}

/** The fake `SearchBackend`: every query gets the same hits, the column's real host and filter. */
export function fakeSearchBackend(
  hits: readonly SearchHit[],
  host: SearchBackend['host'],
): SearchBackend {
  return {
    host,
    // Anthropic's backend takes domain filters, Zhipu's does not (search_pro_quark).
    domainFilter: host === 'api.anthropic.com',
    prepareQuery(query) {
      // Zhipu's backend cuts a query to 70 code points; Anthropic's sends it as it is.
      const points = [...query]
      return host === 'open.bigmodel.cn' && points.length > 70
        ? { query: points.slice(0, 70).join(''), truncated: true }
        : { query, truncated: false }
    },
    search: () => Promise.resolve({ ok: true, hits: hits.map((hit) => ({ ...hit })) }),
  }
}

const PAGE_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
}

/**
 * The fake `fetchUntrusted`: the page file of a URL in `pages` (URL → absolute file), 404 for any
 * other URL. `fetched` gets every URL asked for, in order.
 */
export function fakeFetchUntrusted(
  pages: Readonly<Record<string, string>>,
  fetched: string[],
): FetchLike {
  const table = new Map(Object.entries(pages).map(([url, file]) => [new URL(url).href, file]))
  return (input) => {
    const url = new URL(input instanceof Request ? input.url : input).href
    fetched.push(url)
    const file = table.get(url)
    if (file === undefined) return Promise.resolve(new Response('Not Found', { status: 404 }))
    const type = PAGE_TYPES[extname(file).toLowerCase()] ?? 'text/plain; charset=utf-8'
    return Promise.resolve(
      new Response(readFileSync(file), { status: 200, headers: { 'content-type': type } }),
    )
  }
}

export interface EvalHost {
  /** The run's mkdtemp directory; `dispose` removes it. */
  readonly dir: AbsolutePath
  readonly home: AbsolutePath
  readonly tmp: AbsolutePath
  /** A cowork task's folder: the copied fixture, or the session's dedicated folder. */
  readonly workspaceDir: AbsolutePath
  /** The folder picked for the session (the copied fixture); null when the task has none. */
  readonly picked: AbsolutePath | null
  /** The dedicated folder of `sessionId`, under the run's HOME. */
  readonly dedicated: AbsolutePath
  readonly adapter: HostAdapter & { readonly network: EvalNetwork }
  readonly secrets: MemorySecrets
  readonly policy: SwappablePolicy
  readonly confirm: RecordingConfirm
  readonly commandShell: CommandShell
  /** The fake search backend of a `web.search` task, for this column's host; null otherwise. */
  readonly search: SearchBackend | null
  /** Every URL the fake `fetchUntrusted` was asked for. */
  readonly fetched: readonly string[]
  dispose(): void
}

export interface EvalHostOptions {
  readonly task: EvalTask
  readonly sessionId: string
  /** `docs/evals/fixtures/`. */
  readonly fixturesDir: string
  /** The column's base URL: which search backend's host the fake one takes. */
  readonly baseURL: string
  readonly log: (line: string) => void
  /** The runner's environment, which PATH and LANG come from. */
  readonly runnerEnv?: Readonly<Record<string, string | undefined>>
}

export async function createEvalHost(options: EvalHostOptions): Promise<EvalHost> {
  const { task, fixturesDir } = options
  // Resolved: on macOS the temp folder is behind /var → /private/var, and the workspace judgement
  // compares real paths.
  const dir = absolutePath(realpathSync(mkdtempSync(join(tmpdir(), 'tenon-eval-'))))
  try {
    const home = absolutePath(join(dir, 'home'))
    const tmp = absolutePath(join(dir, 'tmp'))
    mkdirSync(home)
    mkdirSync(tmp)
    const fs = new DesktopFs()
    const identity = await openProfile(
      fs,
      absolutePath(join(dir, 'profile')),
      EVAL_USER_ID,
      EVAL_TENANT_ID,
    )
    const dedicated = dedicatedFolderFor(home, identity, options.sessionId)
    let picked: AbsolutePath | null = null
    if (task.workspace !== undefined) {
      picked = absolutePath(join(dir, 'workspace'))
      copyWorkspace(fixtureFile(fixturesDir, task.workspace), picked)
    }
    const fetched: string[] = []
    const desktop = createDesktopNetwork()
    const pages = Object.fromEntries(
      Object.entries(task.web?.pages ?? {}).map(([url, file]) => [
        url,
        fixtureFile(fixturesDir, file),
      ]),
    )
    const network: EvalNetwork =
      task.web === undefined
        ? desktop
        : { ...desktop, fetchUntrusted: fakeFetchUntrusted(pages, fetched) }
    const searchHost = searchHostOf(options.baseURL)
    const search =
      task.web?.search === undefined || searchHost === null
        ? null
        : fakeSearchBackend(
            searchHitsSchema.parse(
              JSON.parse(readFileSync(fixtureFile(fixturesDir, task.web.search), 'utf8')),
            ),
            searchHost,
          )
    const secrets = new MemorySecrets()
    const policy = new SwappablePolicy()
    const confirm = new RecordingConfirm()
    const env = childEnv(home, tmp, options.runnerEnv)
    return {
      dir,
      home,
      tmp,
      workspaceDir:
        picked ?? (task.profile === 'cowork' ? dedicated : absolutePath(join(dir, 'workspace'))),
      picked,
      dedicated,
      adapter: {
        identity,
        fs,
        secrets,
        process: createHostProcess(),
        sandbox: new PassthroughSandbox(options.log),
        confirm,
        clock: new SystemClock(),
        network,
        policy,
      },
      secrets,
      policy,
      confirm,
      // The desktop's shell choice; the environment is these four variables alone.
      commandShell: { path: pickShell(), env: () => Promise.resolve({ ...env }) },
      search,
      fetched,
      dispose: () => rmSync(dir, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

/** The fixture copied as it is, every `dotenv.txt` renamed to `.env` in its own folder. */
export function copyWorkspace(from: string, to: string): void {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true })
  renameDotenv(to)
}

function renameDotenv(folder: string): void {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) renameDotenv(join(folder, entry.name))
    else if (entry.name === DOTENV_FIXTURE_NAME) {
      renameSync(join(folder, entry.name), join(folder, '.env'))
    }
  }
}
