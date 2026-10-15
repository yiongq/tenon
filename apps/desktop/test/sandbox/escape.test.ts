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
import { readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DARWIN,
  SANDBOX_TESTS_VARIABLE,
  SHELL,
  assertSandboxActive,
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
 * srt's own variables in a command's environment (srt79 dist/sandbox/sandbox-utils.js:642-781; the
 * last two only on Linux, linux-sandbox-utils.js:2744-2747).
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
/** srt's `safe.directory` set (sandbox-utils.js `GIT_CONFIG_COUNT` / `_KEY_<n>` / `_VALUE_<n>`). */
const SRT_GIT_CONFIG = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/
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

/** The proxy port in the command's own HTTP_PROXY, never the URL itself (its token, 04 不变量 12). */
const PRINT_PROXY_PORT = 'echo "proxy_port=${HTTP_PROXY##*:}"'

/** What `PRINT_PROXY_PORT` printed. */
function proxyPortOf(ran: Ran): string | undefined {
  return /^proxy_port=(\d+)$/m.exec(ran.stdout)?.[1]
}

/** Runs `attempt` up to three times on macOS (once on Linux) until `ok` holds; the last run. */
async function upToThree(attempt: () => Promise<Ran>, ok: (ran: Ran) => boolean): Promise<Ran> {
  let ran = await attempt()
  for (let tries = 1; tries < (DARWIN ? DARWIN_TRIES : 1) && !ok(ran); tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one try after another, each a fresh command
    ran = await attempt()
  }
  return ran
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
  function workspaceLab(): { lab: SandboxLab; ws: string; outside: string } {
    const lab = rig.lab()
    const ws = lab.dir('ws')
    lab.folders = [ws]
    return { lab, ws, outside: lab.dir('outside') }
  }

  // -------------------------------------------------------------------------------------------
  // 验收 6, 7

  it(
    '04 验收 6: the command sees request.env plus srt’s own variables; main’s sentinel, TENON_* and ELECTRON_RUN_AS_NODE=1 never reach it; darwin adds exactly one TENON_SANDBOX_MARK',
    async () => {
      const { lab, ws } = workspaceLab()
      const request = lab.requestEnv({ ESCAPE_REQUEST_MARK: 'from-request-env' })
      const saved = {
        sentinel: process.env['ESCAPE_HOST_SENTINEL'],
        tenon: process.env['TENON_ESCAPE_HOST_ONLY'],
        electron: process.env['ELECTRON_RUN_AS_NODE'],
      }
      process.env['ESCAPE_HOST_SENTINEL'] = 'host-only-sentinel'
      process.env['TENON_ESCAPE_HOST_ONLY'] = 'tenon-host-only'
      process.env['ELECTRON_RUN_AS_NODE'] = '1'
      let ran: Ran
      try {
        ran = await lab.run('/usr/bin/env -0', { workspace: [ws], env: request })
      } finally {
        for (const [name, value] of [
          ['ESCAPE_HOST_SENTINEL', saved.sentinel],
          ['TENON_ESCAPE_HOST_ONLY', saved.tenon],
          ['ELECTRON_RUN_AS_NODE', saved.electron],
        ] as const) {
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
      const tenon = [...seen.keys()].filter((name) => name.startsWith('TENON_'))
      expect(tenon).toEqual(DARWIN ? ['TENON_SANDBOX_MARK'] : [])
      expect(seen.get('TENON_SANDBOX_MARK')).toBe(DARWIN ? ran.srtId : undefined)
      // Every other name is srt's or the shell's.
      const other = [...seen.keys()].filter(
        (name) =>
          !(name in request) &&
          name !== 'TENON_SANDBOX_MARK' &&
          !SRT_VARIABLES.has(name) &&
          !SRT_GIT_CONFIG.test(name) &&
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
      // srt's TMPDIR, shared with every srt user on the machine: one already there is set aside and
      // put back, never deleted.
      const tmpClaude = DARWIN ? '/private/tmp/claude' : '/tmp/claude'
      const aside = `${tmpClaude}.tenon-escape-${String(process.pid)}`
      const hadOne = hostKind(tmpClaude) !== 'missing'
      if (hadOne) renameSync(tmpClaude, aside)
      try {
        expect(hostKind(tmpClaude)).toBe('missing')
        const ran = await lab.run(
          'u=$(mktemp "$TMPDIR/x.XXXXXX") && echo "made $u" && rm -f "$u"; echo "tmpdir=$TMPDIR"',
          { workspace: [ws] },
        )
        expect(ran.stdout).toMatch(/^tmpdir=\/tmp\/claude$/m)
        expect(ran.stdout).toMatch(/^made \/tmp\/claude\/x\.\S{6}$/m)
      } finally {
        if (hadOne) {
          rmSync(tmpClaude, { recursive: true, force: true })
          renameSync(aside, tmpClaude)
        }
      }
    },
    CASE_MS,
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

      const writes = await lab.run(
        [
          `echo ${WRITTEN} >> "$HOME/.aws/credentials"`,
          `echo ${WRITTEN} > "$HOME/.aws/new-by-link"`,
          `echo ${WRITTEN} >> "$HOME/dotfiles/aws/credentials"`,
          `echo ${WRITTEN} > "$HOME/dotfiles/aws/new-by-real"`,
          `echo ${WRITTEN} >> "$HOME/.docker/config.json"`,
          `echo ${WRITTEN} >> "$HOME/dotfiles/docker/config.json"`,
          'echo fresh > "$HOME/.docker/fresh-by-link.json"; echo link_write=$?',
          'echo fresh > "$HOME/dotfiles/docker/fresh-by-real.json"; echo real_write=$?',
        ].join('; '),
        { workspace: [home], cwd: home },
      )
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
   * 验收 11, the protected name that is itself a link: `.envrc` at the root links to an outside file;
   * the command removes or moves it and writes a plain file in its place. Each attempt starts from a
   * fresh link; the runs come back for the platform's own assertions.
   */
  async function replaceLinkedEnvrc(): Promise<{
    readonly ws: string
    readonly target: string
    readonly runs: readonly { readonly ran: Ran; readonly link: string; readonly moved: string }[]
  }> {
    const { lab, ws, outside } = workspaceLab()
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

  it.skipIf(!DARWIN)(
    '04 验收 11 (darwin): a protected name that is itself a link (.envrc to an outside file) can be neither removed nor moved and rewritten; link and target stay',
    async () => {
      const { target, runs } = await replaceLinkedEnvrc()
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

  it.skipIf(DARWIN)(
    '04 验收 11 (linux): a protected name that is itself a link (.envrc to an outside file) removed or moved and rewritten leaves one protected violation targeting it; the target stays',
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
    '04 验收 12: writes to the workspace root’s .envrc, .claude/settings.json (absent before), .zshrc, .git/hooks/x, .mcp.json and .vscode/tasks.json are refused and leave nothing on the host',
    async () => {
      const { lab, ws } = workspaceLab()
      writeHostFile(join(ws, '.zshrc'), 'ORIGINAL_ZSHRC\n')
      // Linux denies the .git pair only where .git is a directory (§档位到 srt 配置).
      makeDir(join(ws, '.git'))
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
      expect(hostKind(join(ws, '.claude'))).toBe('missing')
    },
    CASE_MS,
  )

  it(
    '04 验收 12: with the test home as the workspace, writes to .ssh/authorized_keys and Library/LaunchAgents/x.plist are refused',
    async () => {
      const lab = rig.lab()
      lab.folders = [lab.home]
      const keys = writeHostFile(join(lab.home, '.ssh/authorized_keys'), 'ORIGINAL_KEYS\n')
      const agent = join(lab.home, 'Library/LaunchAgents/x.plist')
      const ran = await lab.run(
        [
          `echo ${WRITTEN} >> ${shq(keys)}`,
          `mkdir -p ${shq(join(agent, '..'))} 2>/dev/null; echo ${WRITTEN} > ${shq(agent)}; echo agent=$?`,
          `echo ok > ${shq(join(lab.home, 'normal.txt'))}; echo normal=$?`,
        ].join('; '),
        { workspace: [lab.home], cwd: lab.home },
      )
      expect(ran.stdout).toMatch(/^normal=0$/m)
      expect(ran.stdout).toMatch(/^agent=[1-9]/m)
      // On the host, nothing: on Linux .ssh, a denyRead directory, is an empty tmpfs inside the
      // sandbox (srt79 linux-sandbox-utils.js:1408-1415), so the append "succeeds" there and is gone
      // with the sandbox; on macOS Seatbelt refuses it.
      expect(readFileSync(keys, 'utf8')).toBe('ORIGINAL_KEYS\n')
      expect(hostKind(agent)).toBe('missing')
    },
    CASE_MS,
  )

  it.skipIf(!DARWIN)(
    '04 验收 12 (darwin): on the case-insensitive volume, .ENVRC and .Claude/settings.json, absent before, are refused',
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
      expect(proxyPortOf(added)).toBeDefined()
      expect(proxyPortOf(added)).toBe(proxyPortOf(byName))
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

  describe.skipIf(!DARWIN)('darwin: what Seatbelt reports', () => {
    it(
      '04 验收 16 (darwin): a refused write outside the workspace is in violations() with its real path and a path release',
      async () => {
        const { lab, ws, outside } = workspaceLab()
        const file = join(outside, 'f1')
        const want = {
          kind: 'fs',
          target: join(real(outside), 'f1'),
          release: 'path',
          protected: false,
          observed: false,
        }
        const ran = await upToThree(
          () => lab.run(`echo ${WRITTEN} > ${shq(file)}`, { workspace: [ws] }),
          (one) =>
            one.violations.map(shapeOf).some((v) => JSON.stringify(v) === JSON.stringify(want)),
        )
        expect(ran.violations.map(shapeOf)).toContainEqual(want)
      },
      CASE_MS,
    )

    it(
      '04 验收 16 (darwin): a refused write to a protected name at the root is in violations(), protected',
      async () => {
        const { lab, ws } = workspaceLab()
        const want = {
          kind: 'fs',
          target: join(real(ws), '.envrc'),
          release: null,
          protected: true,
          observed: false,
        }
        const ran = await upToThree(
          () => lab.run(`echo ${WRITTEN} > .envrc`, { workspace: [ws] }),
          (one) =>
            one.violations.map(shapeOf).some((v) => JSON.stringify(v) === JSON.stringify(want)),
        )
        expect(ran.violations.map(shapeOf)).toContainEqual(want)
      },
      CASE_MS,
    )

    it(
      '04 验收 16 (darwin): a refused read of .ssh is in violations() without protected; one of the profile is protected',
      async () => {
        const { lab, ws } = workspaceLab()
        const key = writeHostFile(join(lab.home, '.ssh/id_ed25519'), 'TENON_FAKE_SSH\n')
        const config = writeHostFile(join(lab.profileDir, 'config.json'), 'TENON_FAKE_PROFILE\n')
        for (const [path, isProtected] of [
          [key, false],
          [config, true],
        ] as const) {
          const want = {
            kind: 'fs',
            target: real(path),
            release: null,
            protected: isProtected,
            observed: false,
          }
          // oxlint-disable-next-line no-await-in-loop -- one read after the other
          const ran = await upToThree(
            () => lab.run(`cat ${shq(path)}`, { workspace: [ws] }),
            (one) =>
              one.violations.map(shapeOf).some((v) => JSON.stringify(v) === JSON.stringify(want)),
          )
          expect(ran.violations.map(shapeOf)).toContainEqual(want)
        }
      },
      CASE_MS,
    )

    it(
      '04 验收 16 (darwin): a direct connection’s Seatbelt line has no target and is observed',
      async () => {
        const { lab, ws } = workspaceLab()
        rig.setAllowlist([`127.0.0.1:${String(httpA.port)}`])
        const want = {
          kind: 'network',
          target: null,
          release: null,
          protected: false,
          observed: true,
        }
        const ran = await upToThree(
          () =>
            lab.run(`curl -sS --max-time 5 http://127.0.0.1:${String(httpA.port)}/`, {
              workspace: [ws],
            }),
          (one) =>
            one.violations.map(shapeOf).some((v) => JSON.stringify(v) === JSON.stringify(want)),
        )
        expect(ran.violations.map(shapeOf)).toContainEqual(want)
      },
      CASE_MS,
    )
  })

  describe.skipIf(DARWIN)('linux: what the proxy and the seccomp observer report', () => {
    it(
      '04 验收 16 (linux): refused writes outside the workspace and to a protected name are in violations(), observed (the protected one protected); a normal write in the workspace is not',
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
        const inWorkspace = shapes.filter(
          (v) => v.target !== null && isWithinDir(v.target, ws) && v.target !== join(ws, '.envrc'),
        )
        expect(inWorkspace).toEqual([])
        expect(readFileSync(join(ws, 'd', 'f'), 'utf8')).toBe('ok\n')
      },
      CASE_MS,
    )

    it(
      '04 验收 16 (linux): mkdir -p of an absolute path that exists leaves no mkdirat',
      async () => {
        const { lab, ws, outside } = workspaceLab()
        const deep = makeDir(join(outside, 'a', 'b'))
        const ran = await lab.run(`mkdir -p ${shq(deep)}; echo rc=$?`, { workspace: [ws] })
        expect(ran.stdout).toMatch(/^rc=0$/m)
        expect(ran.violations.filter((v) => v.line.startsWith('deny mkdirat'))).toEqual([])
      },
      CASE_MS,
    )

    it(
      '04 验收 9 (linux): the mount points a call made are gone from the host once afterExit ran, and stubs.json lists none',
      async () => {
        const { lab, ws } = workspaceLab()
        const ran = await lab.run(
          '[ -e .envrc ] && echo envrc-mounted; [ -d .claude ] && echo claude-mounted; true',
          { workspace: [ws] },
        )
        // The call ran with srt's mount points in place …
        expect(ran.stdout).toContain('envrc-mounted')
        expect(ran.stdout).toContain('claude-mounted')
        // … and none of them is left on the host.
        const left = ROOT_NAMES.filter((name) => hostKind(join(ws, name)) !== 'missing')
        expect(left).toEqual([])
        const stubs = JSON.parse(
          readFileSync(join(lab.profileDir, 'sandbox', 'stubs.json'), 'utf8'),
        ) as { mountPoints?: Record<string, unknown> }
        expect(stubs.mountPoints).toEqual({})
      },
      CASE_MS,
    )
  })
})
