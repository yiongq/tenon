/**
 * Spec 04 §验收标准 6, 7, 9 (the Linux half), 10–14 and 16 on the real sandbox: sandbox-runtime
 * 0.0.79 started as desktop starts it, a real `DesktopSandbox`, real processes (Q5 A, T42; 读法 11,
 * 24, 52, 53; P6; §档位到 srt 配置「链接」). Every home, profile and workspace is a temporary
 * directory outside this process's cwd; nothing leaves the machine.
 *
 * The suite runs only where the sandbox can start and `TENON_SANDBOX_TESTS=required` says so (plan
 * 开工前读「沙箱外」: macOS outside any agent sandbox, the Linux VMs, CI); unset, it is skipped
 * with the reason printed, and under `required` a posture other than `active` fails it. Names,
 * lists and violation shapes below are literals from the spec, never computed by the code under
 * test; paths the host logs are compared with `realpath` of the test's own directories.
 */
import {
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DARWIN,
  SANDBOX_TESTS_VARIABLE,
  SHELL,
  assertSandboxActive,
  holdTmpClaudeLock,
  hostKind,
  isWithinDir,
  makeDir,
  sandboxTestsGate,
  shapeOf,
  shq,
  startHttpFixture,
  startSandboxRig,
  startUnixFixture,
  writeHostFile,
  type HttpFixture,
  type Ran,
  type RunOptions,
  type SandboxLab,
  type SandboxRig,
} from './support.js'

const gate = sandboxTestsGate(process.env[SANDBOX_TESTS_VARIABLE])
if (!gate.run) console.warn(gate.reason)

/** A case's own bound: srt's wrap and a sandbox-exec or bwrap start take a while on a loaded runner. */
const CASE_MS = 60_000

/** macOS's log monitor keeps only the first denial of a log block (P2): each such case runs ≤ 3 times. */
const DARWIN_TRIES = 3
/**
 * The pause before a darwin retry. Lost lines come in runs: on this suite's Mac (macOS 26.3,
 * 2026-10-15) 20 of 180 single refused writes left no line (none arrived later), two tries in a row
 * were lost now and then, and a pause between tries lost fewer.
 */
const DARWIN_RETRY_PAUSE_MS = 1_000

/**
 * srt's own variables in a command's environment: the proxy, TMPDIR and gcloud ones of srt79
 * dist/sandbox/sandbox-utils.js:642-781; JAVA_TOOL_OPTIONS, which each platform's wrapper composes
 * with main's own JAVA_TOOL_OPTIONS value, carried over as it is (macos-sandbox-utils.js:1080-1088,
 * linux-sandbox-utils.js:2733-2740; spec §argv、shell、env 与 id, so 验收 6's sentinel avoids that
 * name and only names are compared here); the last two only on Linux (linux-sandbox-utils.js:
 * 2743-2748).
 */
const SRT_VARIABLES: ReadonlySet<string> = new Set([
  'SANDBOX_RUNTIME',
  'TMPDIR',
  'NO_PROXY',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'GIT_CONFIG_PARAMETERS',
  'ALL_PROXY',
  'all_proxy',
  'GRPC_PROXY',
  'grpc_proxy',
  'GIT_SSH_COMMAND',
  'FTP_PROXY',
  'ftp_proxy',
  'RSYNC_PROXY',
  'DOCKER_HTTP_PROXY',
  'DOCKER_HTTPS_PROXY',
  'CLOUDSDK_PROXY_TYPE',
  'CLOUDSDK_PROXY_ADDRESS',
  'CLOUDSDK_PROXY_PORT',
  'CLOUDSDK_PROXY_USERNAME',
  'CLOUDSDK_PROXY_PASSWORD',
  'JAVA_TOOL_OPTIONS',
  'CLAUDE_CODE_HOST_HTTP_PROXY_PORT',
  'CLAUDE_CODE_HOST_SOCKS_PROXY_PORT',
])
/**
 * git's env-level config. srt writes it only for `git.safeDirectories` (sandbox-manager.js:1225-1230,
 * macos-sandbox-utils.js:1094, linux-sandbox-utils.js:2681), a key Tenon never passes (04 不变量 4),
 * so none of it is srt's here: any the command sees came from request.env or leaked from main.
 */
const GIT_CONFIG_ENV = /^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/
/** What the shells themselves export to the command they start (zsh also sets LOGNAME). */
const SHELL_VARIABLES: ReadonlySet<string> = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'LOGNAME'])

/** spec §网络白名单 the preset table: each platform's variables and the dir each names. */
const PRESET_VARIABLES: Readonly<Record<'darwin' | 'linux', Readonly<Record<string, string>>>> = {
  darwin: {
    npm_config_cache: 'npm',
    npm_config_store_dir: 'pnpm/store',
    UV_CACHE_DIR: 'uv',
    CARGO_HOME: 'cargo',
  },
  linux: {
    npm_config_cache: 'npm',
    npm_config_store_dir: 'pnpm/store',
    PIP_CACHE_DIR: 'pip',
    UV_CACHE_DIR: 'uv',
    CARGO_HOME: 'cargo',
  },
}

/**
 * spec §档位到 srt 配置 the credential list (Q20 B, P3 settled; the 2026-10-15 additions, open
 * question 6). A trailing `/` is a directory, read through a file made inside it.
 */
const CREDENTIALS_BOTH: readonly string[] = [
  '.config/gh/',
  '.npmrc',
  '.docker/config.json',
  '.kube/',
  '.git-credentials',
  '.netrc',
  '.pypirc',
  '.cargo/credentials.toml',
  '.config/op/',
  '.vault-token',
  '.pgpass',
  '.cache/huggingface/token',
  '.cache/huggingface/stored_tokens',
]
const CREDENTIALS_DARWIN: readonly string[] = [
  '.config/gcloud/credentials.db',
  '.config/gcloud/access_tokens.db',
  '.config/gcloud/application_default_credentials.json',
  '.config/gcloud/legacy_credentials/',
  'Library/Application Support/Google/Chrome/',
  'Library/Application Support/Chromium/',
  'Library/Application Support/Microsoft Edge/',
  'Library/Application Support/BraveSoftware/',
  'Library/Application Support/Arc/',
  'Library/Application Support/Firefox/',
  'Library/Safari/',
  'Library/Cookies/',
]
const CREDENTIALS_LINUX: readonly string[] = [
  '.config/gcloud/',
  '.config/google-chrome/',
  '.config/chromium/',
  '.config/microsoft-edge/',
  '.config/BraveSoftware/',
  '.mozilla/',
  'snap/firefox/',
  'snap/chromium/',
]

/** The names Tenon and srt deny at each workspace root (§档位到 srt 配置, the workspace-write column). */
const ROOT_NAMES: readonly string[] = [
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.envrc',
  '.codex',
  '.gemini',
  '.cursor',
  '.aws',
  '.gitconfig',
  '.gitmodules',
  '.ripgreprc',
  '.mcp.json',
  '.vscode',
  '.idea',
  '.claude/commands',
  '.claude/agents',
  '.claude',
]

/** A host off every allowlist: srt's proxy refuses it by name, before any lookup. */
const UNLISTED = 'tenon-unlisted.test'

/** What a write in the sandbox leaves in a file when it gets through. */
const WRITTEN = 'TENON_ESCAPE_WRITTEN'

const real = (path: string): string => realpathSync(path)

/** curl forced through srt's proxy (§验收标准 14), the status on its own line. */
function curlViaProxy(url: string, extra = ''): string {
  return (
    `curl --noproxy '' -x "$HTTP_PROXY" -sS --max-time 10 ${extra} ` +
    `-w '\\nHTTP=%{http_code}\\n' ${shq(url)}; echo "curl_rc=$?"`
  )
}

/**
 * The host port of srt's HTTP proxy as the command sees it, never the URL itself (its token, 04
 * 不变量 12): on Linux HTTP_PROXY is socat's `localhost:3128` inside the sandbox and the host port is
 * in CLAUDE_CODE_HOST_HTTP_PROXY_PORT (srt79 linux-sandbox-utils.js:2720, :2744); on macOS
 * HTTP_PROXY names it.
 */
const PRINT_PROXY_PORT = 'echo "proxy_port=${CLAUDE_CODE_HOST_HTTP_PROXY_PORT:-${HTTP_PROXY##*:}}"'

/** What `PRINT_PROXY_PORT` printed. */
function proxyPortOf(ran: Ran): string | undefined {
  return /^proxy_port=(\d+)$/m.exec(ran.stdout)?.[1]
}

/** A violation as the receipt reads it (§afterExit 的表), every member spelled out. */
type Shape = ReturnType<typeof shapeOf>

/**
 * A refused file operation's Seatbelt violation (§afterExit 的表): the real path, `path` only where
 * 读法 35 allows it, `protected` for a write on a denyWrite entry or a read of the profile.
 */
function fsRefusal(target: string, release: 'path' | null, isProtected: boolean): Shape {
  return { kind: 'fs', target, release, protected: isProtected, observed: false }
}

/** The Linux observer's line for a refused write on a denyWrite entry, as the command spelled it. */
function observedProtected(target: string): Shape {
  return { kind: 'fs', target, release: null, protected: true, observed: true }
}

/** One command appending to each of `names` under `root`, its directory made first if missing. */
function writesTo(root: string, names: readonly string[]): string {
  return names
    .map(
      (name) =>
        `mkdir -p ${shq(join(root, dirname(name)))} 2>/dev/null; echo ${WRITTEN} >> ${shq(join(root, name))}`,
    )
    .join('; ')
}

/** Runs `attempt` up to three times on macOS (once on Linux) until `ok` holds; the last run. */
async function upToThree(attempt: () => Promise<Ran>, ok: (ran: Ran) => boolean): Promise<Ran> {
  let ran = await attempt()
  for (let tries = 1; tries < (DARWIN ? DARWIN_TRIES : 1) && !ok(ran); tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- the pause before a retry
    await new Promise((resolve) => setTimeout(resolve, DARWIN_RETRY_PAUSE_MS))
    // oxlint-disable-next-line no-await-in-loop -- one try after another, each a fresh command
    ran = await attempt()
  }
  return ran
}

/**
 * Puts the `/tmp/claude` set aside at `aside` back, whatever the case did. The one made meanwhile
 * goes only when nothing is left in it once this case's own file (`made`, which the command removed
 * already) is gone, and never recursively: anything else in it (a failed command's file, another
 * srt user's) is moved to `<tmpClaude>.tenon-escape-leftover-<pid>` instead, and that path is
 * returned (and printed) for the case to fail on once the original is back.
 */
function putTmpClaudeBack(
  tmpClaude: string,
  aside: string,
  made: string | undefined,
): string | undefined {
  if (made !== undefined) rmSync(made.replace(/^\/tmp\/claude\//, `${tmpClaude}/`), { force: true })
  let leftover: string | undefined
  if (hostKind(tmpClaude) !== 'missing') {
    try {
      rmdirSync(tmpClaude)
    } catch {
      leftover = `${tmpClaude}.tenon-escape-leftover-${String(process.pid)}`
      renameSync(tmpClaude, leftover)
    }
  }
  renameSync(aside, tmpClaude)
  if (leftover !== undefined) {
    console.warn(
      `${tmpClaude} held what was not this case's while the original was set aside; the original is ` +
        `back and that is in ${leftover}: look through it and merge what belongs to someone else`,
    )
  }
  return leftover
}

/** The env a command printed with `env -0`. */
function envOf(stdout: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const pair of stdout.split('\0')) {
    const at = pair.indexOf('=')
    if (at > 0) found.set(pair.slice(0, at), pair.slice(at + 1))
  }
  return found
}

describe('04 sandbox black box: the gate', () => {
  it('04 验收 34 (gate): unset or skip skips with a reason, required runs, any other value fails; under required only an active posture passes', () => {
    expect(sandboxTestsGate(undefined)).toEqual({
      run: false,
      reason: expect.stringContaining('TENON_SANDBOX_TESTS is not set'),
    })
    expect(sandboxTestsGate('')).toMatchObject({ run: false })
    expect(sandboxTestsGate('skip')).toEqual({
      run: false,
      reason: expect.stringContaining('TENON_SANDBOX_TESTS=skip'),
    })
    expect(sandboxTestsGate('required')).toEqual({ run: true })
    expect(() => sandboxTestsGate('require')).toThrow('must be "required" or "skip"')
    expect(() => sandboxTestsGate('1')).toThrow('must be "required" or "skip"')

    expect(() => assertSandboxActive({ state: 'active', reasons: [] })).not.toThrow()
    expect(() =>
      assertSandboxActive({
        state: 'degraded',
        reasons: [{ code: 'no-seccomp', detail: 'seccomp not available' }],
      }),
    ).toThrow('the sandbox is degraded (no-seccomp')
    expect(() =>
      assertSandboxActive({
        state: 'unavailable',
        reasons: [{ code: 'nested-sandbox', detail: null }],
      }),
    ).toThrow('the sandbox is unavailable (nested-sandbox')
  })
})

describe.skipIf(!gate.run)('04 sandbox black box (sandbox-runtime 0.0.79, real processes)', () => {
  let rig: SandboxRig
  let httpA: HttpFixture
  let httpB: HttpFixture

  beforeAll(async () => {
    rig = await startSandboxRig()
    assertSandboxActive(rig.outcome)
    // 验收 12: no workspace lies under this process's cwd, where srt's own mandatory denies anchor.
    if (isWithinDir(real(rig.root), real(process.cwd()))) {
      throw new Error(`the labs (${rig.root}) lie under the test process's cwd`)
    }
    httpA = await startHttpFixture()
    httpB = await startHttpFixture()
  }, CASE_MS)

  afterAll(async () => {
    await httpA?.close()
    await httpB?.close()
    if (rig !== undefined) {
      console.warn(
        `sandbox black box: startup ${rig.outcome.state}; ${rig.summary()}; log: ` +
          rig.logs.filter((line) => !line.includes('for no open command')).join(' | '),
      )
      await rig.dispose()
    }
  }, CASE_MS)

  /** A lab whose one session folder is a fresh `ws`, plus a fresh `outside`. */
  function workspaceLab(underLink = false): { lab: SandboxLab; ws: string; outside: string } {
    const lab = rig.lab({ underLink })
    const ws = lab.dir('ws')
    lab.folders = [ws]
    return { lab, ws, outside: lab.dir('outside') }
  }

  // -------------------------------------------------------------------------------------------
  // 验收 6, 7

  it(
    '04 验收 6: the command sees request.env plus srt’s own variables; main’s sentinel, TENON_*, GIT_CONFIG_* and ELECTRON_RUN_AS_NODE=1 never reach it; darwin adds exactly one TENON_SANDBOX_MARK',
    async () => {
      const { lab, ws } = workspaceLab()
      const request = lab.requestEnv({ ESCAPE_REQUEST_MARK: 'from-request-env' })
      const hostOnly: Readonly<Record<string, string>> = {
        ESCAPE_HOST_SENTINEL: 'host-only-sentinel',
        TENON_ESCAPE_HOST_ONLY: 'tenon-host-only',
        ELECTRON_RUN_AS_NODE: '1',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '/tenon-escape-host-only',
      }
      const saved = Object.fromEntries(
        Object.keys(hostOnly).map((name) => [name, process.env[name]] as const),
      )
      Object.assign(process.env, hostOnly)
      let ran: Ran
      try {
        ran = await lab.run('/usr/bin/env -0', { workspace: [ws], env: request })
      } finally {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }
      expect(ran.code).toBe(0)
      const seen = envOf(ran.stdout)
      // request.env, as it was handed over.
      for (const [name, value] of Object.entries(request)) expect(seen.get(name)).toBe(value)
      expect(seen.get('SANDBOX_RUNTIME')).toBe('1')
      // Nothing of main's own environment.
      expect(seen.has('ESCAPE_HOST_SENTINEL')).toBe(false)
      expect(seen.has('ELECTRON_RUN_AS_NODE')).toBe(false)
      expect([...seen.keys()].filter((name) => GIT_CONFIG_ENV.test(name))).toEqual([])
      const tenon = [...seen.keys()].filter((name) => name.startsWith('TENON_'))
      expect(tenon).toEqual(DARWIN ? ['TENON_SANDBOX_MARK'] : [])
      expect(seen.get('TENON_SANDBOX_MARK')).toBe(DARWIN ? ran.srtId : undefined)
      // Every other name is srt's or the shell's.
      const other = [...seen.keys()].filter(
        (name) =>
          !(name in request) &&
          name !== 'TENON_SANDBOX_MARK' &&
          !SRT_VARIABLES.has(name) &&
          !SHELL_VARIABLES.has(name),
      )
      expect(other).toEqual([])
    },
    CASE_MS,
  )

  it(
    '04 验收 6: with the preset in effect each preset variable of the platform is there exactly once, naming its dir, and request.env’s other spellings are gone; with the preset off request.env’s spelling stays',
    async () => {
      const { lab, ws } = workspaceLab()
      const request = lab.requestEnv({
        NPM_CONFIG_CACHE: '/elsewhere/npm',
        Uv_Cache_Dir: '/elsewhere/uv',
      })
      const presets = PRESET_VARIABLES[DARWIN ? 'darwin' : 'linux']

      lab.settings = { profile: 'workspace-write', packageManagers: true }
      const on = envOf((await lab.run('/usr/bin/env -0', { workspace: [ws], env: request })).stdout)
      const cache = real(lab.cacheDir)
      for (const [name, dir] of Object.entries(presets)) {
        const spellings = [...on.keys()].filter((key) => key.toLowerCase() === name.toLowerCase())
        expect(spellings).toEqual([name])
        expect(on.get(name)).toBe(`${cache}/${dir}`)
      }
      // pip is in the preset on Linux only (P4, 读法 51).
      expect([...on.keys()].filter((key) => key.toLowerCase() === 'pip_cache_dir')).toEqual(
        DARWIN ? [] : ['PIP_CACHE_DIR'],
      )

      lab.settings = { profile: 'workspace-write', packageManagers: false }
      const off = envOf(
        (await lab.run('/usr/bin/env -0', { workspace: [ws], env: request })).stdout,
      )
      expect(off.get('NPM_CONFIG_CACHE')).toBe('/elsewhere/npm')
      expect(off.get('Uv_Cache_Dir')).toBe('/elsewhere/uv')
      for (const name of Object.keys(presets)) expect(off.has(name)).toBe(false)
    },
    CASE_MS,
  )

  it(
    '04 验收 7: arguments with spaces, quotes, $, backticks, a newline and non-ASCII reach the sandboxed shell byte for byte',
    async () => {
      const { lab, ws } = workspaceLab()
      const args = [
        'a b',
        "it's",
        'q"q',
        '$HOME',
        '`id`',
        'line1\nline2',
        '中文é',
        '*',
        'tab\there',
        'back\\slash',
        '',
      ]
      for (const shell of [SHELL, '/bin/sh']) {
        // oxlint-disable-next-line no-await-in-loop -- one shell after the other
        const ran = await lab.run('', {
          workspace: [ws],
          argv: [shell, '-c', 'for a in "$@"; do printf "%s\\0" "$a"; done', 'argv0', ...args],
        })
        expect(ran.code).toBe(0)
        expect(ran.stdout.split('\0').slice(0, -1)).toEqual(args)
      }
    },
    CASE_MS,
  )

  // -------------------------------------------------------------------------------------------
  // 验收 10

  it(
    '04 验收 10: a write outside the workspace is refused and leaves no file on the host; a write inside succeeds',
    async () => {
      const { lab, ws, outside } = workspaceLab()
      const ran = await lab.run(
        `echo ${WRITTEN} > ${shq(join(outside, 'f1'))}; echo out=$?; echo inside > ${shq(join(ws, 'in.txt'))}; echo in=$?`,
        { workspace: [ws] },
      )
      expect(ran.stdout).toMatch(/^out=[1-9]/m)
      expect(ran.stdout).toMatch(/^in=0$/m)
      expect(hostKind(join(outside, 'f1'))).toBe('missing')
      expect(readFileSync(join(ws, 'in.txt'), 'utf8')).toBe('inside\n')
    },
    CASE_MS,
  )

  it(
    '04 验收 10: under read-only a write inside the workspace is refused',
    async () => {
      const { lab, ws } = workspaceLab()
      lab.settings = { profile: 'read-only', packageManagers: false }
      const ran = await lab.run(`echo ${WRITTEN} > ${shq(join(ws, 'ro.txt'))}; echo rc=$?`, {
        workspace: [ws],
        profile: 'read-only',
      })
      expect(ran.stdout).toMatch(/^rc=[1-9]/m)
      expect(hostKind(join(ws, 'ro.txt'))).toBe('missing')
    },
    CASE_MS,
  )

  it(
    '04 验收 10: with no /tmp/claude beforehand, mktemp "$TMPDIR/x.XXXXXX" succeeds',
    async () => {
      const { lab, ws } = workspaceLab()
      // srt's TMPDIR, shared with every srt user on the machine (Claude Code's sandbox among them):
      // one already there is set aside for this one call and always put back. The one this call
      // made is removed only when it holds nothing but what this case wrote; anything else in it is
      // moved to a leftover dir the case then fails on. stop-tree.test.ts's sandboxed group, which
      // runs in parallel under S and makes it again at every wrap, waits for this case's turn.
      const release = await holdTmpClaudeLock()
      const tmpClaude = DARWIN ? '/private/tmp/claude' : '/tmp/claude'
      const aside = `${tmpClaude}.tenon-escape-${String(process.pid)}`
      let hadOne = false
      let made: string | undefined
      let leftover: string | undefined
      try {
        hadOne = hostKind(tmpClaude) !== 'missing'
        if (hadOne) renameSync(tmpClaude, aside)
        if (hostKind(tmpClaude) !== 'missing') {
          throw new Error(
            `${tmpClaude} is there again right after it was set aside: another srt user made it`,
          )
        }
        const ran = await lab.run(
          'u=$(mktemp "$TMPDIR/x.XXXXXX") && echo "made $u" && rm -f "$u"; echo "tmpdir=$TMPDIR"',
          { workspace: [ws] },
        )
        made = /^made (\/tmp\/claude\/x\.\S{6})$/m.exec(ran.stdout)?.[1]
        expect(ran.stdout).toMatch(/^tmpdir=\/tmp\/claude$/m)
        expect(made).toBeDefined()
      } finally {
        try {
          if (hadOne) leftover = putTmpClaudeBack(tmpClaude, aside, made)
        } finally {
          release()
        }
      }
      expect(leftover).toBeUndefined()
    },
    CASE_MS * 3,
  )

  // -------------------------------------------------------------------------------------------
  // 验收 11

  it(
    '04 验收 11: a write through a workspace link to an outside directory and a read through a link to the test home’s .ssh are refused',
    async () => {
      const { lab, ws, outside } = workspaceLab()
      writeHostFile(join(lab.home, '.ssh', 'id_ed25519'), 'TENON_FAKE_SSH_KEY\n')
      symlinkSync(outside, join(ws, 'out-link'))
      symlinkSync(join(lab.home, '.ssh'), join(ws, 'ssh-link'))
      const ran = await lab.run(
        `echo ${WRITTEN} > out-link/via-link; echo w=$?; cat ssh-link/id_ed25519; echo r=$?`,
        { workspace: [ws] },
      )
      expect(ran.stdout).toMatch(/^w=[1-9]/m)
      expect(ran.stdout).toMatch(/^r=[1-9]/m)
      expect(ran.stdout).not.toContain('TENON_FAKE_SSH_KEY')
      expect(hostKind(join(outside, 'via-link'))).toBe('missing')
    },
    CASE_MS,
  )

  it(
    '04 验收 11: deny entries reached through links (~/.aws a link to a dotfiles dir, ~/.docker holding config.json a link) are refused by the link’s spelling and by the real place, for reads and writes; the same directory’s other files stay readable and, the home being the workspace, writable through the link',
    async () => {
      const lab = rig.lab()
      const home = lab.home
      lab.folders = [home]
      writeHostFile(join(home, 'dotfiles/aws/credentials'), 'TENON_FAKE_AWS\n')
      writeHostFile(join(home, 'dotfiles/docker/config.json'), 'TENON_FAKE_DOCKER\n')
      writeHostFile(join(home, 'dotfiles/docker/other.json'), 'TENON_OTHER_READABLE\n')
      symlinkSync(join(home, 'dotfiles/aws'), join(home, '.aws'))
      symlinkSync(join(home, 'dotfiles/docker'), join(home, '.docker'))

      const reads = await lab.run(
        [
          'cat "$HOME/.aws/credentials"',
          'cat "$HOME/dotfiles/aws/credentials"',
          'cat "$HOME/.docker/config.json"',
          'cat "$HOME/dotfiles/docker/config.json"',
          'cat "$HOME/.docker/other.json"',
          'cat "$HOME/dotfiles/docker/other.json"',
        ].join('; '),
        { workspace: [home], cwd: home },
      )
      expect(reads.stdout).not.toContain('TENON_FAKE_AWS')
      expect(reads.stdout).not.toContain('TENON_FAKE_DOCKER')
      expect(reads.stdout.split('TENON_OTHER_READABLE').length - 1).toBe(2)

      const refused = [
        ['aws_link', `echo ${WRITTEN} >> "$HOME/.aws/credentials"`],
        ['aws_new_link', `echo ${WRITTEN} > "$HOME/.aws/new-by-link"`],
        ['aws_real', `echo ${WRITTEN} >> "$HOME/dotfiles/aws/credentials"`],
        ['aws_new_real', `echo ${WRITTEN} > "$HOME/dotfiles/aws/new-by-real"`],
        ['docker_link', `echo ${WRITTEN} >> "$HOME/.docker/config.json"`],
        ['docker_real', `echo ${WRITTEN} >> "$HOME/dotfiles/docker/config.json"`],
      ] as const
      const writes = await lab.run(
        [
          ...refused.map(([label, command]) => `${command}; echo ${label}=$?`),
          'echo fresh > "$HOME/.docker/fresh-by-link.json"; echo link_write=$?',
          'echo fresh > "$HOME/dotfiles/docker/fresh-by-real.json"; echo real_write=$?',
        ].join('; '),
        { workspace: [home], cwd: home },
      )
      // On macOS Seatbelt refuses each write: a non-zero status. On Linux the existing ~/dotfiles/aws,
      // a denyRead directory (reached through ~/.aws), is an empty tmpfs in the sandbox, so writes
      // there land in it and are gone with the sandbox (srt79 linux-sandbox-utils.js:1408-1415): any
      // status, and the host below.
      for (const [label] of refused) {
        expect(new RegExp(`^${label}=(\\d+)$`, 'm').exec(writes.stdout)?.[1]).toMatch(
          DARWIN ? /^[1-9]\d*$/ : /^\d+$/,
        )
      }
      expect(readFileSync(join(home, 'dotfiles/aws/credentials'), 'utf8')).toBe('TENON_FAKE_AWS\n')
      expect(readFileSync(join(home, 'dotfiles/docker/config.json'), 'utf8')).toBe(
        'TENON_FAKE_DOCKER\n',
      )
      expect(hostKind(join(home, 'dotfiles/aws/new-by-link'))).toBe('missing')
      expect(hostKind(join(home, 'dotfiles/aws/new-by-real'))).toBe('missing')
      // The link itself, and its directory's other files, are no more locked than before.
      expect(writes.stdout).toMatch(/^link_write=0$/m)
      expect(writes.stdout).toMatch(/^real_write=0$/m)
      expect(readFileSync(join(home, 'dotfiles/docker/fresh-by-link.json'), 'utf8')).toBe('fresh\n')
      expect(readFileSync(join(home, 'dotfiles/docker/fresh-by-real.json'), 'utf8')).toBe('fresh\n')
      expect(hostKind(join(home, '.aws'))).toBe('link')
      expect(hostKind(join(home, '.docker'))).toBe('link')
    },
    CASE_MS,
  )

  /**
   * Where 验收 11's link cases on darwin run. A link on a deny entry's way is kept by srt's own rules
   * when the entry's spelling has no other link on it (a real home): the rule on the entry as written
   * and on its ancestors matches the link (macos-sandbox-utils.js:539-560). Under a linked parent (a
   * workspace under /tmp or /var) Seatbelt sees none of those spellings: the link node Tenon passes
   * itself (§档位到 srt 配置「链接」) keeps `~/.docker`, and keeps `.envrc` together with darwin's
   * per-root glob, which also hangs off the root's real path. So both layouts.
   */
  const DARWIN_LINK_LAYOUTS = [
    { underLink: false, where: '' },
    {
      underLink: true,
      where: '; also under a linked parent, where only the link node Tenon passes matches',
    },
  ] as const

  /**
   * 验收 11, the protected name that is itself a link: `.envrc` at the root links to an outside file;
   * the command removes or moves it and writes a plain file in its place. Each attempt starts from a
   * fresh link; the runs come back for the platform's own assertions.
   */
  async function replaceLinkedEnvrc(underLink = false): Promise<{
    readonly ws: string
    readonly target: string
    readonly runs: readonly { readonly ran: Ran; readonly link: string; readonly moved: string }[]
  }> {
    const { lab, ws, outside } = workspaceLab(underLink)
    const target = writeHostFile(join(outside, 'envrc-target'), 'ORIGINAL_ENVRC\n')
    const runs: { ran: Ran; link: string; moved: string }[] = []
    for (const command of [
      `rm .envrc && echo ${WRITTEN} > .envrc; echo rc=$?`,
      `mv .envrc moved-envrc && echo ${WRITTEN} > .envrc; echo rc=$?`,
    ]) {
      const link = join(ws, '.envrc')
      rmSync(link, { force: true })
      rmSync(join(ws, 'moved-envrc'), { force: true })
      symlinkSync(target, link)
      // oxlint-disable-next-line no-await-in-loop -- one attempt after the other, each from a fresh link
      const ran = await lab.run(command, { workspace: [ws] })
      runs.push({
        ran,
        link: hostKind(link) === 'link' ? readlinkSync(link) : hostKind(link),
        moved: hostKind(join(ws, 'moved-envrc')),
      })
    }
    return { ws, target, runs }
  }

  for (const { underLink, where } of DARWIN_LINK_LAYOUTS) {
    it.skipIf(!DARWIN)(
      `04 验收 11: (darwin) a protected name that is itself a link (.envrc to an outside file) can be neither removed nor moved and rewritten; link and target stay${where}`,
      async () => {
        const { target, runs } = await replaceLinkedEnvrc(underLink)
        expect(readFileSync(target, 'utf8')).toBe('ORIGINAL_ENVRC\n')
        expect(
          runs.map(({ ran, link, moved }) => ({
            rc: /^rc=(\d+)$/m.exec(ran.stdout)?.[1],
            link,
            moved,
          })),
        ).toEqual([
          { rc: '1', link: target, moved: 'missing' },
          { rc: '1', link: target, moved: 'missing' },
        ])
      },
      CASE_MS,
    )
  }

  it.skipIf(DARWIN)(
    '04 验收 11: (linux) a protected name that is itself a link (.envrc to an outside file) removed or moved and rewritten leaves one protected violation targeting it; the target stays',
    async () => {
      const { ws, target, runs } = await replaceLinkedEnvrc()
      expect(readFileSync(target, 'utf8')).toBe('ORIGINAL_ENVRC\n')
      for (const { ran } of runs) {
        expect(
          ran.violations
            .map(shapeOf)
            .filter((v) => v.target === join(real(ws), '.envrc') && !v.observed),
        ).toEqual([
          {
            kind: 'fs',
            target: join(real(ws), '.envrc'),
            release: null,
            protected: true,
            observed: false,
          },
        ])
      }
    },
    CASE_MS,
  )

  /**
   * 验收 11, a link on a deny entry's way (§档位到 srt 配置「链接」): the home is the workspace and
   * `~/.docker`, which holds `config.json` from the credential list, links to a dotfiles directory.
   * No per-root name or glob covers it, so only the link itself in denyWrite (darwin) or the host's
   * lstat check (Linux) stands between the command and a `~/.docker` of its own.
   */
  async function replaceLinkedDocker(underLink = false): Promise<{
    readonly home: string
    readonly target: string
    readonly runs: readonly { readonly ran: Ran; readonly link: string }[]
  }> {
    const lab = rig.lab({ underLink })
    const home = lab.home
    lab.folders = [home]
    const target = join(home, 'dotfiles/docker')
    writeHostFile(join(target, 'config.json'), 'TENON_FAKE_DOCKER\n')
    const link = join(home, '.docker')
    const runs: { ran: Ran; link: string }[] = []
    for (const command of [
      `rm "$HOME/.docker" && mkdir "$HOME/.docker" && echo ${WRITTEN} > "$HOME/.docker/config.json"; echo rc=$?`,
      `mv "$HOME/.docker" "$HOME/moved-docker" && mkdir "$HOME/.docker" && echo ${WRITTEN} > "$HOME/.docker/config.json"; echo rc=$?`,
    ]) {
      rmSync(link, { recursive: true, force: true })
      rmSync(join(home, 'moved-docker'), { force: true })
      symlinkSync(target, link)
      // oxlint-disable-next-line no-await-in-loop -- one attempt after the other, each from a fresh link
      const ran = await lab.run(command, { workspace: [home], cwd: home })
      runs.push({ ran, link: hostKind(link) === 'link' ? readlinkSync(link) : hostKind(link) })
    }
    return { home, target, runs }
  }

  for (const { underLink, where } of DARWIN_LINK_LAYOUTS) {
    it.skipIf(!DARWIN)(
      `04 验收 11: (darwin) a link on a deny entry’s way (~/.docker, the home being the workspace) can be neither removed nor moved and replaced; link and target stay${where}`,
      async () => {
        const { target, runs } = await replaceLinkedDocker(underLink)
        expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe('TENON_FAKE_DOCKER\n')
        expect(
          runs.map(({ ran, link }) => ({ rc: /^rc=(\d+)$/m.exec(ran.stdout)?.[1], link })),
        ).toEqual([
          { rc: '1', link: target },
          { rc: '1', link: target },
        ])
      },
      CASE_MS,
    )
  }

  it.skipIf(DARWIN)(
    '04 验收 11: (linux) a link on a deny entry’s way (~/.docker, the home being the workspace) removed or moved and replaced leaves one protected violation targeting it; the target stays',
    async () => {
      const { home, target, runs } = await replaceLinkedDocker()
      expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe('TENON_FAKE_DOCKER\n')
      for (const { ran } of runs) {
        expect(
          ran.violations
            .map(shapeOf)
            .filter((v) => v.target === join(real(home), '.docker') && !v.observed),
        ).toEqual([
          {
            kind: 'fs',
            target: join(real(home), '.docker'),
            release: null,
            protected: true,
            observed: false,
          },
        ])
      }
    },
    CASE_MS,
  )

  // -------------------------------------------------------------------------------------------
  // 验收 12

  it(
    '04 验收 12: reads of the test home’s .ssh, .aws, .gnupg and of the test profile are refused; this session’s tool-output is readable',
    async () => {
      const { lab, ws } = workspaceLab()
      const secrets = {
        ssh: writeHostFile(join(lab.home, '.ssh/id_ed25519'), 'TENON_FAKE_SSH\n'),
        aws: writeHostFile(join(lab.home, '.aws/credentials'), 'TENON_FAKE_AWS\n'),
        gnupg: writeHostFile(join(lab.home, '.gnupg/private-keys-v1.d/k.key'), 'TENON_FAKE_GPG\n'),
        profile: writeHostFile(join(lab.profileDir, 'config.json'), 'TENON_FAKE_PROFILE\n'),
      }
      writeHostFile(join(lab.toolOutputDir, 'out.txt'), 'TENON_TOOL_OUTPUT_READABLE\n')
      const ran = await lab.run(
        [...Object.values(secrets), join(lab.toolOutputDir, 'out.txt')]
          .map((path) => `cat ${shq(path)}`)
          .join('; '),
        { workspace: [ws] },
      )
      for (const marker of [
        'TENON_FAKE_SSH',
        'TENON_FAKE_AWS',
        'TENON_FAKE_GPG',
        'TENON_FAKE_PROFILE',
      ]) {
        expect(ran.stdout).not.toContain(marker)
      }
      expect(ran.stdout).toContain('TENON_TOOL_OUTPUT_READABLE')
    },
    CASE_MS,
  )

  it(
    '04 验收 12: writes to the workspace root’s .envrc, .claude/settings.json (absent before, .claude/ there), .zshrc, .git/hooks/x, .mcp.json and .vscode/tasks.json are refused and leave nothing on the host',
    async () => {
      const { lab, ws } = workspaceLab()
      writeHostFile(join(ws, '.zshrc'), 'ORIGINAL_ZSHRC\n')
      // Linux denies the .git pair only where .git is a directory (§档位到 srt 配置).
      makeDir(join(ws, '.git'))
      // A project's .claude/ is usually there already. Without it the write would fail on .claude
      // itself (srt's rule on the ancestors of .claude/commands and .claude/agents on macOS, their
      // read-only mount point on Linux), and settings.json's own entry would go untested.
      makeDir(join(ws, '.claude'))
      const targets = [
        '.envrc',
        '.claude/settings.json',
        '.zshrc',
        '.git/hooks/x',
        '.mcp.json',
        '.vscode/tasks.json',
      ]
      const ran = await lab.run(
        targets
          .map(
            (name) =>
              `mkdir -p ${shq(join(ws, name, '..'))} 2>/dev/null; echo ${WRITTEN} >> ${shq(join(ws, name))}; echo "${name}=$?"`,
          )
          .join('; '),
        { workspace: [ws] },
      )
      for (const name of targets) {
        expect(ran.stdout).toMatch(new RegExp(`^${name.replaceAll('.', '\\.')}=[1-9]`, 'm'))
        // Only .zshrc was there before; it keeps its own content (below).
        expect(hostKind(join(ws, name))).toBe(name === '.zshrc' ? 'file' : 'missing')
      }
      expect(readFileSync(join(ws, '.zshrc'), 'utf8')).toBe('ORIGINAL_ZSHRC\n')
    },
    CASE_MS,
  )

  it(
    '04 验收 12: with the test home as the workspace, writes to .ssh/authorized_keys and Library/LaunchAgents/x.plist are refused',
    async () => {
      const lab = rig.lab()
      lab.folders = [lab.home]
      const keys = writeHostFile(join(lab.home, '.ssh/authorized_keys'), 'ORIGINAL_KEYS\n')
      // A real home has ~/Library/LaunchAgents. Without Library/ the write would fail on Library
      // itself (srt's rule on the ancestors of the credential list's Library entries, macOS), and
      // the LaunchAgents entry would go untested.
      makeDir(join(lab.home, 'Library/LaunchAgents'))
      const agent = join(lab.home, 'Library/LaunchAgents/x.plist')
      const ran = await lab.run(
        [
          `echo ${WRITTEN} >> ${shq(keys)}; echo keys=$?`,
          `mkdir -p ${shq(join(agent, '..'))} 2>/dev/null; echo ${WRITTEN} > ${shq(agent)}; echo agent=$?`,
          `echo ok > ${shq(join(lab.home, 'normal.txt'))}; echo normal=$?`,
        ].join('; '),
        { workspace: [lab.home], cwd: lab.home },
      )
      expect(ran.stdout).toMatch(/^normal=0$/m)
      expect(ran.stdout).toMatch(/^agent=[1-9]/m)
      // On macOS Seatbelt refuses the append: a non-zero status. On Linux .ssh, a denyRead
      // directory, is an empty tmpfs inside the sandbox (srt79 linux-sandbox-utils.js:1408-1415), so
      // the append "succeeds" there and is gone with the sandbox: any status. On both, nothing
      // reaches the host.
      expect(/^keys=(\d+)$/m.exec(ran.stdout)?.[1]).toMatch(DARWIN ? /^[1-9]\d*$/ : /^\d+$/)
      expect(readFileSync(keys, 'utf8')).toBe('ORIGINAL_KEYS\n')
      expect(hostKind(agent)).toBe('missing')
    },
    CASE_MS,
  )

  it(
    '04 验收 12: with the test home as the workspace and no .ssh, .gnupg, .netrc or .git-credentials beforehand, making them is refused and leaves nothing on the host',
    async () => {
      // A denyRead entry that does not exist yet: Linux mounts nothing for it on the read side
      // (only a directory that exists becomes a tmpfs), so only denyWrite, which takes in denyRead
      // (§档位到 srt 配置), keeps the command from making it in a workspace that holds it.
      const lab = rig.lab()
      lab.folders = [lab.home]
      const made = ['.ssh/authorized_keys', '.gnupg/gpg.conf', '.netrc', '.git-credentials']
      const ran = await lab.run(
        [
          ...made.map(
            (name) =>
              `mkdir -p "$HOME/${dirname(name)}" 2>/dev/null; echo ${WRITTEN} >> "$HOME/${name}"; echo "${name}=$?"`,
          ),
          `echo ok > "$HOME/normal.txt"; echo normal=$?`,
        ].join('; '),
        { workspace: [lab.home], cwd: lab.home },
      )
      expect(ran.stdout).toMatch(/^normal=0$/m)
      for (const name of made) {
        expect(ran.stdout).toMatch(new RegExp(`^${name.replaceAll('.', '\\.')}=[1-9]`, 'm'))
        expect(hostKind(join(lab.home, name))).toBe('missing')
      }
      expect(hostKind(join(lab.home, '.ssh'))).toBe('missing')
      expect(hostKind(join(lab.home, '.gnupg'))).toBe('missing')
    },
    CASE_MS,
  )

  it.skipIf(!DARWIN)(
    '04 验收 12: (darwin) .envrc and .mcp.json in a subdirectory of the workspace are refused (the per-root glob)',
    async () => {
      const { lab, ws } = workspaceLab()
      makeDir(join(ws, 'sub'))
      const ran = await lab.run(
        `echo ${WRITTEN} > sub/.envrc; echo envrc=$?; echo ${WRITTEN} > sub/.mcp.json; echo mcp=$?; echo ok > sub/normal.txt; echo normal=$?`,
        { workspace: [ws] },
      )
      expect(ran.stdout).toMatch(/^envrc=[1-9]/m)
      expect(ran.stdout).toMatch(/^mcp=[1-9]/m)
      expect(ran.stdout).toMatch(/^normal=0$/m)
      expect(hostKind(join(ws, 'sub/.envrc'))).toBe('missing')
      expect(hostKind(join(ws, 'sub/.mcp.json'))).toBe('missing')
    },
    CASE_MS,
  )

  it.skipIf(!DARWIN)(
    '04 验收 12: (darwin) on the case-insensitive volume, .ENVRC and .Claude/settings.json, absent before, are refused',
    async () => {
      const { lab, ws } = workspaceLab()
      const ran = await lab.run(
        `echo ${WRITTEN} > .ENVRC; echo envrc=$?; mkdir -p .Claude 2>/dev/null; echo ${WRITTEN} > .Claude/settings.json; echo claude=$?`,
        { workspace: [ws] },
      )
      expect(ran.stdout).toMatch(/^envrc=[1-9]/m)
      expect(ran.stdout).toMatch(/^claude=[1-9]/m)
      expect(hostKind(join(ws, '.ENVRC'))).toBe('missing')
      expect(hostKind(join(ws, '.Claude/settings.json'))).toBe('missing')
    },
    CASE_MS,
  )

  // -------------------------------------------------------------------------------------------
  // 验收 13

  it(
    '04 验收 13: every path on the credential list, made under the test home, is unreadable in the sandbox',
    async () => {
      const { lab, ws } = workspaceLab()
      const list = [...CREDENTIALS_BOTH, ...(DARWIN ? CREDENTIALS_DARWIN : CREDENTIALS_LINUX)]
      const files = list.map((entry, i) => {
        const file = join(lab.home, entry.endsWith('/') ? `${entry}secret` : entry)
        writeHostFile(file, `TENON_FAKE_CREDENTIAL_${String(i)}_END\n`)
        return file
      })
      const ran = await lab.run(files.map((file) => `cat ${shq(file)} 2>/dev/null`).join('; '), {
        workspace: [ws],
      })
      const leaked = list.filter((_, i) =>
        ran.stdout.includes(`TENON_FAKE_CREDENTIAL_${String(i)}_END`),
      )
      expect(leaked).toEqual([])
    },
    CASE_MS,
  )

  // -------------------------------------------------------------------------------------------
  // 验收 14

  it(
    '04 验收 14: with 127.0.0.1:<A> listed, a proxied request to it connects; port <B> of the same host and an unlisted host name are refused, each with a network violation',
    async () => {
      const { lab, ws } = workspaceLab()
      rig.setAllowlist([`127.0.0.1:${String(httpA.port)}`])
      const hitsA = httpA.hits.length
      const listed = await lab.run(curlViaProxy(`http://127.0.0.1:${String(httpA.port)}/`), {
        workspace: [ws],
      })
      expect(listed.stdout).toContain(`tenon-escape-ok ${String(httpA.port)}`)
      expect(httpA.hits.length).toBe(hitsA + 1)

      const otherPort = await lab.run(curlViaProxy(`http://127.0.0.1:${String(httpB.port)}/`), {
        workspace: [ws],
      })
      expect(otherPort.stdout).not.toContain('tenon-escape-ok')
      expect(httpB.hits).toEqual([])
      expect(otherPort.violations.map(shapeOf)).toContainEqual({
        kind: 'network',
        target: '127.0.0.1',
        release: null,
        protected: false,
        observed: false,
      })

      const unlisted = await lab.run(curlViaProxy(`http://${UNLISTED}:${String(httpA.port)}/`), {
        workspace: [ws],
      })
      expect(unlisted.stdout).not.toContain('tenon-escape-ok')
      expect(httpA.hits.length).toBe(hitsA + 1)
      expect(unlisted.violations.map(shapeOf)).toContainEqual({
        kind: 'network',
        target: UNLISTED,
        release: 'domain',
        protected: false,
        observed: false,
      })
    },
    CASE_MS,
  )

  it(
    '04 验收 14: with only 127.0.0.1:<A> listed, localhost:<A> is refused; adding localhost:<B> through updateConfig, with no reset, lets localhost:<B> connect on the next command',
    async () => {
      const { lab, ws } = workspaceLab()
      rig.setAllowlist([`127.0.0.1:${String(httpA.port)}`])
      const port = rig.proxyPort()
      expect(port).toBeDefined()
      const byName = await lab.run(
        `${PRINT_PROXY_PORT}; ${curlViaProxy(`http://localhost:${String(httpA.port)}/`)}`,
        { workspace: [ws] },
      )
      expect(byName.stdout).not.toContain('tenon-escape-ok')
      expect(byName.violations.map(shapeOf)).toContainEqual({
        kind: 'network',
        target: 'localhost',
        release: null,
        protected: false,
        observed: false,
      })

      rig.setAllowlist([`127.0.0.1:${String(httpA.port)}`, `localhost:${String(httpB.port)}`])
      const added = await lab.run(
        `${PRINT_PROXY_PORT}; ${curlViaProxy(`http://localhost:${String(httpB.port)}/`)}`,
        { workspace: [ws] },
      )
      expect(added.stdout).toContain(`tenon-escape-ok ${String(httpB.port)}`)
      // The same proxy before and after: updateConfig, not a reset.
      expect(rig.proxyPort()).toBe(port)
      expect([proxyPortOf(byName), proxyPortOf(added)]).toEqual([String(port), String(port)])
    },
    CASE_MS,
  )

  it(
    '04 验收 14: a client that honours NO_PROXY (default curl) cannot reach the listed 127.0.0.1:<A> directly',
    async () => {
      const { lab, ws } = workspaceLab()
      rig.setAllowlist([`127.0.0.1:${String(httpA.port)}`])
      const hits = httpA.hits.length
      const ran = await lab.run(
        `curl -sS --max-time 5 http://127.0.0.1:${String(httpA.port)}/; echo "curl_rc=$?"`,
        { workspace: [ws] },
      )
      expect(ran.stdout).not.toContain('tenon-escape-ok')
      expect(ran.stdout).toMatch(/^curl_rc=[1-9]/m)
      expect(httpA.hits.length).toBe(hits)
    },
    CASE_MS,
  )

  it(
    '04 验收 14: a Unix socket the test made cannot be reached',
    async () => {
      const { lab, ws } = workspaceLab()
      const path = join(lab.dir('sock'), 'u.sock')
      const unix = await startUnixFixture(path)
      try {
        const ran = await lab.run(
          `perl -MIO::Socket::UNIX -e '$s = IO::Socket::UNIX->new(Peer => $ARGV[0]) or die "unix_refused $!\\n"; print "unix_connected ", scalar <$s>' ${shq(path)}; echo rc=$?`,
          { workspace: [ws] },
        )
        expect(ran.stdout).not.toContain('unix_connected')
        expect(ran.stdout).toMatch(/^rc=[1-9]/m)
        expect(unix.connections()).toBe(0)
      } finally {
        await unix.close()
      }
    },
    CASE_MS,
  )

  it(
    '04 验收 14: the proxy judges the request’s target, not its Host header: a CONNECT and a plain absolute-form request to an unlisted host, both with Host: <listed>, are refused',
    async () => {
      const { lab, ws } = workspaceLab()
      const listed = `127.0.0.1:${String(httpA.port)}`
      rig.setAllowlist([listed])
      const hits = httpA.hits.length
      const url = `http://${UNLISTED}:${String(httpA.port)}/`
      for (const extra of [
        `--proxytunnel --proxy-header ${shq(`Host: ${listed}`)} -H ${shq(`Host: ${listed}`)}`,
        `-H ${shq(`Host: ${listed}`)}`,
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const ran = await lab.run(curlViaProxy(url, extra), { workspace: [ws] })
        expect(ran.stdout).not.toContain('tenon-escape-ok')
        expect(ran.violations.map(shapeOf)).toContainEqual({
          kind: 'network',
          target: UNLISTED,
          release: 'domain',
          protected: false,
          observed: false,
        })
      }
      expect(httpA.hits.length).toBe(hits)
    },
    CASE_MS,
  )

  // -------------------------------------------------------------------------------------------
  // 验收 16 and 9 (Linux)

  /** A refused operation alone in its command, and the violation it must leave. */
  interface Refusal {
    readonly name: string
    readonly arrange: () => {
      readonly lab: SandboxLab
      readonly command: string
      readonly options: RunOptions
      readonly want: Shape
    }
  }

  /** A case in a fresh `ws`; `make` lays files down first. */
  function inWorkspace(
    name: string,
    make: (q: { lab: SandboxLab; ws: string; outside: string }) => {
      readonly command: string
      readonly want: Shape
      readonly readOnly?: true
    },
  ): Refusal {
    return {
      name,
      arrange: () => {
        const q = workspaceLab()
        const { command, want, readOnly } = make(q)
        if (readOnly) q.lab.settings = { profile: 'read-only', packageManagers: false }
        return {
          lab: q.lab,
          command,
          options: { workspace: [q.ws], ...(readOnly ? { profile: 'read-only' as const } : {}) },
          want,
        }
      },
    }
  }

  /** A case whose session folder (and cwd) is the test home. */
  function inHome(
    name: string,
    make: (home: string) => { readonly command: string; readonly want: Shape },
  ): Refusal {
    return {
      name,
      arrange: () => {
        const lab = rig.lab()
        lab.folders = [lab.home]
        const { command, want } = make(lab.home)
        return { lab, command, options: { workspace: [lab.home], cwd: lab.home }, want }
      },
    }
  }

  /** The test home as the workspace, `~/.aws` and `~/.docker` links to a dotfiles dir (验收 11). */
  function inLinkedHome(name: string, command: string, want: (home: string) => Shape): Refusal {
    return inHome(name, (home) => {
      writeHostFile(join(home, 'dotfiles/aws/credentials'), 'TENON_FAKE_AWS\n')
      writeHostFile(join(home, 'dotfiles/docker/config.json'), 'TENON_FAKE_DOCKER\n')
      symlinkSync(join(home, 'dotfiles/aws'), join(home, '.aws'))
      symlinkSync(join(home, 'dotfiles/docker'), join(home, '.docker'))
      return { command, want: want(home) }
    })
  }

  /**
   * 验收 16 on macOS: each read, write and connection 验收 10–14 refuse, one per command (a log
   * block keeps only its first denial, P2), Unix sockets aside (no line, P1), plus a mach-lookup and
   * an operation outside the closed list. The proxy's own refusals are asserted where 验收 14 makes
   * them. A line srt passes on that matches no format (a process name with parentheses) has no
   * black-box case: a copy of cat named `cat(x)` hung in the sandbox and left no line (2026-10-15);
   * violations.test.ts covers its classification.
   */
  const DARWIN_REFUSALS: readonly Refusal[] = [
    // 验收 10
    inWorkspace('a write outside the workspace (验收 10)', ({ outside }) => ({
      command: `echo ${WRITTEN} > ${shq(join(outside, 'f1'))}`,
      want: fsRefusal(join(real(outside), 'f1'), 'path', false),
    })),
    inWorkspace('a write in the workspace under read-only (验收 10)', ({ ws }) => ({
      command: `echo ${WRITTEN} > ${shq(join(ws, 'ro.txt'))}`,
      want: fsRefusal(join(real(ws), 'ro.txt'), 'path', false),
      readOnly: true,
    })),
    // 验收 11
    inWorkspace('a write through a workspace link to an outside directory (验收 11)', (q) => {
      symlinkSync(q.outside, join(q.ws, 'out-link'))
      return {
        command: `echo ${WRITTEN} > out-link/via-link`,
        want: fsRefusal(join(real(q.outside), 'via-link'), 'path', false),
      }
    }),
    inWorkspace('a read through a workspace link to the test home’s .ssh (验收 11)', (q) => {
      const key = writeHostFile(join(q.lab.home, '.ssh/id_ed25519'), 'TENON_FAKE_SSH\n')
      symlinkSync(join(q.lab.home, '.ssh'), join(q.ws, 'ssh-link'))
      return { command: 'cat ssh-link/id_ed25519', want: fsRefusal(real(key), null, false) }
    }),
    // ~/.aws is itself a deny entry and a link: Seatbelt refuses the lookup through it at the link,
    // `file-read-metadata <home>/.aws`, for a read and for a write alike. That is a read denial, so
    // per §afterExit 的表 it carries no `protected` even when the command was writing (plan Open,
    // step 6 review r3). (Under a linked parent the entry as written never matched and such a write
    // was refused at the real place, with `protected`.)
    ...(
      [
        ['cat "$HOME/.aws/credentials"', '.aws'],
        ['cat "$HOME/dotfiles/aws/credentials"', 'dotfiles/aws/credentials'],
        ['cat "$HOME/.docker/config.json"', 'dotfiles/docker/config.json'],
        ['cat "$HOME/dotfiles/docker/config.json"', 'dotfiles/docker/config.json'],
        [`echo ${WRITTEN} >> "$HOME/.aws/credentials"`, '.aws'],
        [`echo ${WRITTEN} > "$HOME/.aws/new-by-link"`, '.aws'],
      ] as const
    ).map(([command, file]) =>
      inLinkedHome(`${command} (验收 11)`, command, (home) =>
        fsRefusal(join(real(home), file), null, false),
      ),
    ),
    ...(
      [
        [`echo ${WRITTEN} >> "$HOME/dotfiles/aws/credentials"`, 'dotfiles/aws/credentials'],
        [`echo ${WRITTEN} > "$HOME/dotfiles/aws/new-by-real"`, 'dotfiles/aws/new-by-real'],
        [`echo ${WRITTEN} >> "$HOME/.docker/config.json"`, 'dotfiles/docker/config.json'],
        [`echo ${WRITTEN} >> "$HOME/dotfiles/docker/config.json"`, 'dotfiles/docker/config.json'],
        ['rm "$HOME/.docker"', '.docker'],
        ['mv "$HOME/.docker" "$HOME/moved-docker"', '.docker'],
      ] as const
    ).map(([command, file]) =>
      inLinkedHome(`${command} (验收 11)`, command, (home) =>
        fsRefusal(join(real(home), file), null, true),
      ),
    ),
    ...['rm .envrc', 'mv .envrc moved-envrc'].map((command) =>
      inWorkspace(`${command}, .envrc a link to an outside file (验收 11)`, (q) => {
        symlinkSync(writeHostFile(join(q.outside, 'envrc-target'), 'X\n'), join(q.ws, '.envrc'))
        return { command, want: fsRefusal(join(real(q.ws), '.envrc'), null, true) }
      }),
    ),
    // 验收 12
    ...(
      [
        ['.ssh/id_ed25519', false],
        ['.aws/credentials', false],
        ['.gnupg/private-keys-v1.d/k.key', false],
      ] as const
    ).map(([file, isProtected]) =>
      inWorkspace(`a read of the test home’s ${file} (验收 12)`, ({ lab }) => {
        const path = writeHostFile(join(lab.home, file), 'TENON_FAKE\n')
        return { command: `cat ${shq(path)}`, want: fsRefusal(real(path), null, isProtected) }
      }),
    ),
    inWorkspace('a read of the test profile (验收 12)', ({ lab }) => {
      const path = writeHostFile(join(lab.profileDir, 'config.json'), 'TENON_FAKE\n')
      return { command: `cat ${shq(path)}`, want: fsRefusal(real(path), null, true) }
    }),
    ...(
      [
        ['.envrc', null],
        ['.claude/settings.json', '.claude'],
        ['.zshrc', 'file'],
        ['.git/hooks/x', '.git/hooks'],
        ['.mcp.json', null],
        ['.vscode/tasks.json', '.vscode'],
        ['sub/.envrc', 'sub'],
        ['sub/.mcp.json', 'sub'],
        ['.ENVRC', null],
      ] as const
    ).map(([name, first]) =>
      inWorkspace(`a write to ${name} in the workspace (验收 12)`, ({ ws }) => {
        if (first === 'file') writeHostFile(join(ws, name), 'ORIGINAL\n')
        else if (first !== null) makeDir(join(ws, first))
        return {
          command: `echo ${WRITTEN} >> ${shq(name)}`,
          want: fsRefusal(join(real(ws), name), null, true),
        }
      }),
    ),
    // .Claude does not exist, so the refused write is its creation: an ancestor of the protected
    // names (no release, 读法 35), not one of them (srt's own rule refuses it).
    inWorkspace('the .Claude made for .Claude/settings.json (验收 12)', ({ ws }) => ({
      command: 'mkdir .Claude',
      want: fsRefusal(join(real(ws), '.Claude'), null, false),
    })),
    ...(
      [
        ['.ssh/authorized_keys', 'file', 'write'],
        ['Library/LaunchAgents/x.plist', 'Library/LaunchAgents', 'write'],
        ['.ssh', null, 'mkdir'],
        ['.gnupg', null, 'mkdir'],
        ['.netrc', null, 'write'],
        ['.git-credentials', null, 'write'],
      ] as const
    ).map(([name, first, how]) =>
      inHome(
        `${how === 'mkdir' ? 'mkdir' : 'a write to'} ${name} with the test home as the workspace (验收 12)`,
        (home) => {
          if (first === 'file') writeHostFile(join(home, name), 'ORIGINAL\n')
          else if (first !== null) makeDir(join(home, first))
          return {
            command: how === 'mkdir' ? `mkdir ${shq(name)}` : `echo ${WRITTEN} >> ${shq(name)}`,
            want: fsRefusal(join(real(home), name), null, true),
          }
        },
      ),
    ),
    // 验收 13
    ...[...CREDENTIALS_BOTH, ...CREDENTIALS_DARWIN].map((entry) =>
      inWorkspace(`a read of ~/${entry} (验收 13)`, ({ lab }) => {
        const file = writeHostFile(
          join(lab.home, entry.endsWith('/') ? `${entry}secret` : entry),
          'TENON_FAKE_CREDENTIAL\n',
        )
        return { command: `cat ${shq(file)}`, want: fsRefusal(real(file), null, false) }
      }),
    ),
    // 验收 14
    inWorkspace('a direct connection to the listed 127.0.0.1:<A> (验收 14)', () => {
      rig.setAllowlist([`127.0.0.1:${String(httpA.port)}`])
      return {
        command: `curl -sS --max-time 5 http://127.0.0.1:${String(httpA.port)}/`,
        want: { kind: 'network', target: null, release: null, protected: false, observed: true },
      }
    }),
    // 验收 16's own two: a line of the closed list with no object, and an operation outside it
    // (§afterExit 的表). Both offline: pbpaste is refused `mach-lookup com.apple.pasteboard.1`, nice
    // `system-sched self` (macOS 26.3, 2026-10-15).
    inWorkspace('a mach-lookup, pbpaste’s (验收 16)', () => ({
      command: 'pbpaste',
      want: { kind: 'fs', target: null, release: null, protected: false, observed: true },
    })),
    inWorkspace('an operation outside the closed list, nice’s system-sched (验收 16)', () => ({
      command: '/usr/bin/nice -n 5 /usr/bin/true',
      want: { kind: 'fs', target: null, release: null, protected: false, observed: false },
    })),
  ]

  describe.skipIf(!DARWIN)('darwin: what Seatbelt reports', () => {
    it.each(DARWIN_REFUSALS)(
      '04 验收 16: (darwin) $name is in violations() (test condition: OS_ACTIVITY_MODE=disable, which the product never sets)',
      async ({ arrange }) => {
        const { lab, command, options, want } = arrange()
        // A test condition, not the product's: Bash's env carries no OS_ACTIVITY_MODE and Tenon adds
        // none (04 不变量 3). While srt's `log stream` runs, each process in the sandbox is refused
        // `mach-lookup com.apple.diagnosticd` at its start, and the kernel's "N duplicate reports"
        // line for it comes in the same instant as the process's next denial. srt reads one line per
        // log block, the first holding `Sandbox:` and `deny`, and drops the whole block when that
        // line is noise it filters (diagnosticd, analyticsd, mDNSResponder) or matches
        // ignoreViolations (macos-sandbox-utils.js:1168-1199), real denials after it included. On this
        // suite's Mac (macOS 26.3, 2026-10-15), one refused write per command, 60 commands: without
        // the variable 43 of 60 arrived, and 36 of 60 in a second warm run; with it 60 of 60
        // (probes/results/step6/measure-diagnosticd-r1.txt); an earlier run lost 20 of 180 (see
        // DARWIN_RETRY_PAUSE_MS). So in the product a single refusal leaves no line roughly one time
        // in four and goes uncounted, which §已知限制 does not yet say (plan Open). This case is
        // about the line's shape.
        const env = lab.requestEnv({ OS_ACTIVITY_MODE: 'disable' })
        const ran = await upToThree(
          () => lab.run(command, { ...options, env }),
          (one) => one.violations.map(shapeOf).some((v) => isDeepStrictEqual(v, want)),
        )
        expect(ran.violations.map(shapeOf)).toContainEqual(want)
      },
      CASE_MS,
    )
  })

  describe.skipIf(DARWIN)('linux: what the proxy and the seccomp observer report', () => {
    it(
      '04 验收 16: (linux) refused writes outside the workspace and to a protected name are in violations(), observed (the protected one protected); a normal write in the workspace is not',
      async () => {
        const { lab, ws, outside } = workspaceLab()
        const ran = await lab.run(
          [
            `echo ${WRITTEN} > ${shq(join(outside, 'f1'))}`,
            `echo ${WRITTEN} > ${shq(join(ws, '.envrc'))}`,
            `echo ok > ${shq(join(ws, 'normal.txt'))}`,
            `mkdir ${shq(join(ws, 'd'))} && echo ok > ${shq(join(ws, 'd', 'f'))}`,
          ].join('; '),
          { workspace: [ws] },
        )
        const shapes = ran.violations.map(shapeOf)
        expect(shapes).toContainEqual({
          kind: 'fs',
          target: join(outside, 'f1'),
          release: null,
          protected: false,
          observed: true,
        })
        expect(shapes).toContainEqual({
          kind: 'fs',
          target: join(ws, '.envrc'),
          release: null,
          protected: true,
          observed: true,
        })
        const others = shapes.filter(
          (v) => v.target !== null && isWithinDir(v.target, ws) && v.target !== join(ws, '.envrc'),
        )
        expect(others).toEqual([])
        expect(readFileSync(join(ws, 'd', 'f'), 'utf8')).toBe('ok\n')
      },
      CASE_MS,
    )

    it(
      '04 验收 16: (linux) each refused write to a protected name at the workspace root is in violations(), observed and protected',
      async () => {
        const { lab, ws } = workspaceLab()
        writeHostFile(join(ws, '.zshrc'), 'ORIGINAL_ZSHRC\n')
        makeDir(join(ws, '.git'))
        makeDir(join(ws, '.claude'))
        const names = [
          '.envrc',
          '.claude/settings.json',
          '.zshrc',
          '.git/hooks/x',
          '.mcp.json',
          '.vscode/tasks.json',
        ]
        const ran = await lab.run(writesTo(ws, names), { workspace: [ws] })
        const shapes = ran.violations.map(shapeOf)
        for (const name of names) expect(shapes).toContainEqual(observedProtected(join(ws, name)))
      },
      CASE_MS,
    )

    it(
      '04 验收 16: (linux) with the test home as the workspace, refused writes to .ssh/authorized_keys and Library/LaunchAgents/x.plist, and to .ssh, .gnupg, .netrc and .git-credentials made anew, are in violations(), observed and protected',
      async () => {
        // On Linux the existing .ssh is an empty tmpfs in the sandbox and the append lands there
        // (验收 12's case); the observer reports the attempt all the same.
        const present = rig.lab()
        writeHostFile(join(present.home, '.ssh/authorized_keys'), 'ORIGINAL_KEYS\n')
        makeDir(join(present.home, 'Library/LaunchAgents'))
        const absent = rig.lab()
        for (const [lab, names] of [
          [present, ['.ssh/authorized_keys', 'Library/LaunchAgents/x.plist']],
          [absent, ['.ssh/authorized_keys', '.gnupg/gpg.conf', '.netrc', '.git-credentials']],
        ] as const) {
          lab.folders = [lab.home]
          // oxlint-disable-next-line no-await-in-loop -- one home after the other
          const ran = await lab.run(writesTo(lab.home, names), {
            workspace: [lab.home],
            cwd: lab.home,
          })
          const shapes = ran.violations.map(shapeOf)
          for (const name of names)
            expect(shapes).toContainEqual(observedProtected(join(lab.home, name)))
        }
      },
      CASE_MS,
    )

    it(
      '04 验收 16: (linux) refused reads, a direct connection and a Unix socket connection leave no violation',
      async () => {
        const { lab, ws } = workspaceLab()
        const files = [
          writeHostFile(join(lab.home, '.ssh/id_ed25519'), 'TENON_FAKE_SSH\n'),
          writeHostFile(join(lab.home, '.npmrc'), 'TENON_FAKE_NPMRC\n'),
          writeHostFile(join(lab.profileDir, 'config.json'), 'TENON_FAKE_PROFILE\n'),
        ]
        rig.setAllowlist([`127.0.0.1:${String(httpA.port)}`])
        const hits = httpA.hits.length
        const path = join(lab.dir('sock'), 'u.sock')
        const unix = await startUnixFixture(path)
        try {
          const ran = await lab.run(
            [
              ...files.map((file) => `cat ${shq(file)}`),
              `curl -sS --max-time 5 http://127.0.0.1:${String(httpA.port)}/; echo curl_rc=$?`,
              `perl -MIO::Socket::UNIX -e 'IO::Socket::UNIX->new(Peer => $ARGV[0]) or exit 7' ${shq(path)}; echo unix_rc=$?`,
            ].join('; '),
            { workspace: [ws] },
          )
          expect(ran.stdout).not.toContain('TENON_FAKE')
          expect(ran.stdout).toMatch(/^curl_rc=[1-9]/m)
          expect(ran.stdout).toMatch(/^unix_rc=[1-9]/m)
          expect(httpA.hits.length).toBe(hits)
          expect(unix.connections()).toBe(0)
          expect(ran.violations.map((v) => v.line)).toEqual([])
        } finally {
          await unix.close()
        }
      },
      CASE_MS,
    )

    it(
      '04 验收 16: (linux) mkdir -p of an absolute path that exists leaves no mkdirat',
      async () => {
        const { lab, ws, outside } = workspaceLab()
        const deep = makeDir(join(outside, 'a', 'b'))
        const ran = await lab.run(`mkdir -p ${shq(deep)}; echo rc=$?`, { workspace: [ws] })
        expect(ran.stdout).toMatch(/^rc=0$/m)
        // The observer's line names the syscall. srt's arm64 apply-seccomp watches only the `*at`
        // forms; its x64 one also watches the old `mkdir` (and creat, unlink, rename …), so an x64
        // run may report `deny mkdir <path>`, which the spec does not drop (读法 53 names only
        // `mkdirat`; plan Open). Every run so far was arm64.
        expect(ran.violations.filter((v) => /^deny mkdir(?:at)? /.test(v.line))).toEqual([])
      },
      CASE_MS,
    )

    it(
      '04 验收 9: (linux) while a call runs stubs.json lists the .claude it will mount; once afterExit ran no mount point is left on the host and stubs.json lists none',
      async () => {
        const { lab, ws } = workspaceLab()
        const stubsJson = join(lab.profileDir, 'sandbox', 'stubs.json')
        const recorded = (): string[] => {
          if (hostKind(stubsJson) === 'missing') return []
          const stubs = JSON.parse(readFileSync(stubsJson, 'utf8')) as {
            mountPoints?: Record<string, string[]>
          }
          return Object.values(stubs.mountPoints ?? {}).flat()
        }
        // The command holds until the host has read stubs.json mid-call (at most 10 s).
        const go = join(ws, 'go')
        const running = lab.run(
          [
            '[ -e .envrc ] && echo envrc-mounted; [ -d .claude ] && echo claude-mounted',
            'i=0; while [ ! -e go ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done',
            'true',
          ].join('; '),
          { workspace: [ws] },
        )
        const deadline = performance.now() + 10_000
        let during = recorded()
        while (during.length === 0 && performance.now() < deadline) {
          // oxlint-disable-next-line no-await-in-loop -- the poll's pace
          await new Promise((resolve) => setTimeout(resolve, 20))
          during = recorded()
        }
        writeHostFile(go, '')
        const ran = await running
        // The wrap recorded the one intermediate dir srt makes a mount point (§afterExit「挂载点与
        // 残留的记录」): .claude, for .claude/settings.json and the rest under it …
        expect(during).toEqual([join(real(ws), '.claude')])
        // … the call ran with srt's mount points in place …
        expect(ran.stdout).toContain('envrc-mounted')
        expect(ran.stdout).toContain('claude-mounted')
        // … and none of them is left on the host, nor in the record.
        const left = ROOT_NAMES.filter((name) => hostKind(join(ws, name)) !== 'missing')
        expect(left).toEqual([])
        expect(recorded()).toEqual([])
        const stubs = JSON.parse(readFileSync(stubsJson, 'utf8')) as {
          mountPoints?: Record<string, unknown>
        }
        expect(stubs.mountPoints).toEqual({})
      },
      CASE_MS,
    )
  })
})
