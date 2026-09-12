# sandbox-runtime 源码机制拆解：API 形状 / 规则语义 / 三平台实现 / Electron 集成

> 目标：给要在本机跑 MCP 子进程和 shell 命令的 Electron Agent 客户端，提供"直接可用的 API + 规则语义 + 限制清单"
> 包：`@anthropic-ai/sandbox-runtime`，仓库 `anthropic-experimental/sandbox-runtime`，TS，Apache-2.0
> 版本：**v0.0.76**（commit `c392e6c`，2026-09-10）。之前主参考写的 npm 0.0.75 已过时
> 核对方式：本地 clone，路径相对仓库根。本环境无 bwrap，但用 bun 直接加载 `src/` 跑了纯生成函数验证 argv / profile 输出
> 标注：**[码]** 读源码确认 · **[文]** README/注释 · **[未查到]** 没找到

---

## ⚠️ 先说四个对集成有决定性影响的事实

1. **它包装的是一条命令，返回 argv 和 env，进程由你 spawn。** 所以 MCP stdio server 可以整个跑在沙箱里——README 的主用例就是这个。
2. **相对路径相对宿主 `process.cwd()` 解析，不是被包装命令的 cwd。** Electron 主进程的 cwd 通常不是工作区，**只传绝对路径**。
3. **网络白名单无法表达"全允许"**——schema 拒绝 `"*"`。"danger-full-access" 档只能跳过 wrap。
4. **没有 native addon**，但有三个预编译可执行文件（`apply-seccomp`、`srt-win.exe`、`srt-proxy-agent.jar`）随 npm 包分发，**源码检出里没有**。打包时要放 asar 外并用 config 指绝对路径。

---

# 一、API 形状

## 导出

`src/index.ts` **[码]**：`SandboxManager`（对象常量，非类，模块级单例）、`SandboxViolationStore`、全部 zod schema、`getDefaultWritePaths`、`getWslVersion`、一组 Windows 安装函数（`installWindowsSandbox` / `checkWindowsSandboxStatus` / `windowsTrustCa`）、`generateCa / validateCaPair`。

## 核心签名

`src/sandbox/sandbox-manager.ts:2322-2378` **[码]**

```ts
interface ISandboxManager {
  initialize(config: SandboxRuntimeConfig,
             askCallback?: (p: { host: string; port?: number }) => Promise<boolean>,
             enableLogMonitor?: boolean /* 默认 false */): Promise<void>
  isSupportedPlatform(): boolean                       // macos | linux(非 WSL1) | windows
  checkDependenciesAsync(): Promise<{ errors: string[]; warnings: string[] }>

  wrapWithSandbox(command, binShell?, customConfig?, abortSignal?, options?): Promise<string>
      // macOS/Linux 返回 shell 字符串；Windows 抛错
  wrapWithSandboxArgv(command, binShell?, customConfig?, abortSignal?, cwd?, options?)
      : Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>   // ★ 三平台通用，用这个

  updateConfig(config): void            // 网络规则热更新；文件系统规则不热更新
  cleanupAfterCommand(): void           // 每条命令结束后调（Linux 清 bwrap 挂载点空文件）
  reset(): Promise<void>                // 关代理 / bridge / ACL；exit / SIGINT / SIGTERM 也自动调
  getSandboxViolationStore(): SandboxViolationStore
  annotateStderrWithSandboxFailures(commandKey: string, stderr: string): string
}
```

`options.commandId` 用 tool-use id，违规归因靠它（比较只看命令前 100 字符）。

## 最小用法

README:179-216 + 源码注释 **[文]+[码]**

```ts
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { spawn } from 'node:child_process'

const config: SandboxRuntimeConfig = {
  network:    { allowedDomains: ['api.github.com'], deniedDomains: [] },
  filesystem: { denyRead: ['~/.ssh'], allowWrite: ['/abs/workspace'], denyWrite: ['/abs/workspace/.env'] },
}
await SandboxManager.initialize(config, undefined, /* enableLogMonitor */ true)
// 起本地 mux 代理（HTTP + SOCKS 同端口）、Linux 起 socat bridge、macOS 起 `log stream`

const id = 'toolu_123'
const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
  'npm test', '/bin/bash', undefined, undefined, '/abs/workspace', { commandId: id })
const child = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: '/abs/workspace', stdio: 'pipe' })
// …收集 stderr…
child.on('exit', () => {
  SandboxManager.cleanupAfterCommand()
  const annotated = SandboxManager.annotateStderrWithSandboxFailures(id, stderr)
  // annotated 末尾多了 <sandbox_violations>…</sandbox_violations>，喂给模型
})
// 退出前
await SandboxManager.reset()
```

`initialize` 先 `checkDependenciesAsync()`，缺依赖直接 throw（`:680-684`）**[码]**。"没有任何限制"时 `wrapWithSandbox` 原样返回命令（`macos-sandbox-utils.ts:1240`、`linux-sandbox-utils.ts:1820`）**[码]**。

**实验**（bun 加载 `src/`）：`denyRead: ['~/.ssh'], allowWrite: [cwd]` 在 Linux 生成
`bwrap --new-session --die-with-parent --unshare-net --ro-bind / / --bind <cwd> <cwd> --tmpfs ~/.ssh --ro-bind /dev/null <cwd>/.bashrc … --dev /dev --unshare-pid --unshare-user --cap-drop ALL --proc /proc -- /usr/bin/bash -c '…'`；
macOS 同配置生成 15.8KB profile，以 `(version 1)(deny default …)` 开头。**单次 wrap 约 10ms**（含 Linux 的 rg 扫描）。

## 配置 schema

`src/sandbox/sandbox-config.ts` **[码]**

```ts
type SandboxRuntimeConfig = {
  network: {
    allowedDomains: string[]        // 必填。"example.com" | "*.example.com" | "host:port" | "[::1]:443"；禁止 "*.com" / "*"
    deniedDomains: string[]         // 必填。另接受 "*" / "*:22" 表示全拒；先于 allow 检查
    deniedDomainReasons?: Record<string, string>   // ★ 写进 <sandbox_violations> 给模型看的理由
    strictAllowlist?: boolean       // true：未命中 allow 不问 askCallback 直接拒
    deniedResolvedAddresses?: string[]  // IP/CIDR，允许的域名不得解析到这些地址
    allowUnixSockets?: string[]     // 仅 macOS
    allowAllUnixSockets?: boolean
    allowLocalBinding?: boolean     // 默认 false；macOS 允许 bind 本地端口 + 直连 localhost:*
    allowMachLookup?: string[]      // 仅 macOS，XPC 服务名
    httpProxyPort? / socksProxyPort?: number   // 自带代理（自己负责过滤）
    filterRequest?: (req: Request) => Promise<{ action: 'allow' | 'deny'; reason?: string }>  // 每个 HTTP 请求回调
    tlsTerminate?: { caCertPath?, caKeyPath?, excludeDomains?, extraCaCertPaths? }   // [EXPERIMENTAL]
    parentProxy?: { http?, https?, noProxy? }   // 上游企业代理；未设则读 HTTP(S)_PROXY 环境变量
  }
  filesystem: {
    disabled?: boolean              // true = 不产生任何 FS 规则（含内置强制 deny）
    denyRead: string[]              // 必填（可 []）
    allowRead?: string[]            // 在 denyRead 区域内再放开
    allowWrite: string[]            // 必填（可 []）
    denyWrite: string[]             // 必填；优先于 allowWrite
    allowGitConfig?: boolean        // 默认 false：.git/config 强制禁写
  }
  credentials?: { files?, envVars?, allowPlaintextInject?, awsPairs?, sigv4? }   // deny / mask（mask 仅 Linux；macOS 降级为 deny）
  ignoreViolations?: Record<string /* 命令子串或 "*" */, string[] /* 违规行子串 */>
  enableWeakerNestedSandbox?: boolean    // Linux：Docker 无特权容器用，不挂新 /proc
  enableWeakerNetworkIsolation?: boolean // macOS：放开 trustd（Go 程序 TLS 校验）
  allowAppleEvents?: boolean             // macOS：open / osascript；README 明说等于放弃代码执行隔离
  ripgrep?: { command: string; args?; argv0? }   // 默认 { command: 'rg' }，仅 Linux 用
  mandatoryDenySearchDepth?: number      // Linux，1-10，默认 3
  allowPty?: boolean                     // 仅 macOS
  seccomp?: { applyPath?: string; argv0?: string }   // ★ Linux，apply-seccomp 二进制位置
  bwrapPath? / socatPath? / javaAgentJarPath?: string  // ★ 必须绝对路径
  windows?: { sandboxUser?, sublayerGuid?, proxyPortRange?: [lo, hi] /* 默认 60080-60089 */, srtWin?: { path } }  // ★
  git?: { safeDirectories: string[] }
}
```

## 读/写语义：核实主参考的说法

**正确。** `src/sandbox/sandbox-schemas.ts:3-40` **[码]**：

- 读：`FsReadRestrictionConfig { denyOnly; allowWithinDeny? }`，注释原话 "maximally permissive by default - only explicitly denied paths are blocked"。`denyOnly: []` = 全可读。`allowWithinDeny` 优先于 `denyOnly`，但**更具体的 deny 仍胜出**（`denyRead: ['**/.env']` + `allowRead: ['.']`，`.env` 仍不可读；macOS 用 `lateReadDenyFilters` 在 allow 之后再发一遍 deny，`macos-sandbox-utils.ts:263`；Linux 文件级 deny 只有精确匹配的 allowRead 才能覆盖，`linux-sandbox-utils.ts:1595`）
- 写：`FsWriteRestrictionConfig { allowOnly; denyWithinAllow }`，注释原话 "maximally restrictive by default"。`allowOnly: []` = 全不可写

**两个隐含规则** **[码]**：
1. `allowOnly` 永远被前置 `getDefaultWritePaths()`（`sandbox-utils.ts:430`）：`/dev/null`、`/dev/tty`、`/tmp/claude`、`/private/tmp/claude`、`~/.npm/_logs`、`~/.claude/debug`；子进程 `TMPDIR` 被改成 `/tmp/claude`（或 `CLAUDE_CODE_TMPDIR` / `CLAUDE_TMPDIR`）。README:426 自己警告这偏宽
2. **内置强制禁写**（`sandbox-utils.ts:11-40`）：`.gitconfig .gitmodules .bashrc .bash_profile .zshrc .zprofile .profile .ripgreprc .mcp.json`、目录 `.vscode .idea .claude/commands .claude/agents .git/hooks`、`.git/config`（除非 `allowGitConfig`）。防"agent 改 rc 文件 / git hook 实现持久化提权"。Linux 用 rg 扫 `mandatoryDenySearchDepth` 层，**只能挡已存在的文件**（README:689）

## 路径语法

`normalizePathForSandbox`（`sandbox-utils.ts:327-421`）**[码]**

| 规则 | 行为 |
|---|---|
| `~` / `~/…` | 展开为 `os.homedir()`；Windows 另支持 `~\`、`%USERPROFILE%` |
| 相对路径 | **相对宿主 `process.cwd()`**，macOS 的强制 deny 也用它（`macos-sandbox-utils.ts:80`） |
| glob | `*` `**` `?` `[abc]`，gitignore 风格。macOS 转成 SBPL `(regex …)`；**Linux 不支持 glob**：`denyRead/allowRead` 的 glob 在 wrap 时用 `readdirSync(recursive)` 展开为具体文件（时点快照），`allowWrite/denyWrite` 的 glob **直接丢弃**并 debug 日志（`sandbox-manager.ts:1591`）。尾部 `/**` 三平台都剥掉等价于子树 |
| symlink | 非 glob 路径 `realpathSync`，但 `isSymlinkOutsideBoundary`（:168-274）判断"解析后跳到祖先 / 根 / 无关树"时保留原路径；Linux `allowWrite` 若指向外部的 symlink 直接跳过；Linux 文件 deny 落在 symlink 目标上（bwrap 不能在 symlink 上 bind）。Windows UNC 字面量不做 stat（防 NTLM 强制认证） |
| 尾随 `/` | POSIX 非 glob 路径剥掉 |

## 网络

**[码]**
- **默认**：`allowedDomains` 是必填字段，只要存在（哪怕 `[]`）就启用限制且代理照起（`sandbox-manager.ts:1664`）；空数组 = 全拒。事实上默认 off
- **实现**：`initialize` 在 `127.0.0.1` 随机端口起 **mux 代理**（`mux-proxy.ts`，同端口按首字节分流 HTTP CONNECT / SOCKS5，SOCKS 用 `@pondwader/socks5-server`），每会话随机 16 字节 token 做认证，用户名 `srt.<base64(命令前 100 字符)>` 用于把拒绝归因到命令。子进程环境注入 `HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / GRPC_PROXY / FTP_PROXY / RSYNC_PROXY / DOCKER_* / CLOUDSDK_* / GIT_SSH_COMMAND(ProxyCommand) / JAVA_TOOL_OPTIONS(-javaagent)`，`NO_PROXY=localhost,127.0.0.1,::1,169.254/16,10/8,172.16/12,192.168/16`（`sandbox-utils.ts:474-677`）
- **过滤**（`sandbox-manager.ts:329-407`）：canonicalize host（防 `127.1`、十进制 IP）→ deniedDomains 匹配拒 → allowedDomains 匹配允 → 都不匹配：有 `askCallback` 且非 `strictAllowlist` 就问用户，否则拒。允许的域名再经 `resolved-address-guard.ts` 解析一次，命中 loopback / link-local / multicast / 本机接口 / 云 metadata / `deniedResolvedAddresses` 则拒
- **★ 绕过代理直接开 socket 会怎样：三平台都被 OS 层挡住，不靠环境变量。** Linux `--unshare-net`（沙箱内只有 lo，DNS 也不通）；macOS `(deny default)` 下只 `(allow network-outbound (remote ip "localhost:<proxyPort>"))`（`macos-sandbox-utils.ts:1094`）；Windows WFP 在 `ALE_AUTH_CONNECT_V4/V6` 层对 `srt-sandbox` SID 全 BLOCK，只 PERMIT loopback 代理端口段（`vendor/srt-win-src/src/wfp.rs`）。README:798 说的"不遵守环境变量的程序"是**连不上**，不是逃逸
- **unix socket**：macOS 默认拒，`allowUnixSockets` 按路径放开；Linux 用 seccomp 让 `socket(AF_UNIX)` 返回 EPERM（**无法按路径过滤**），`allowAllUnixSockets: true` 则不装 seccomp。**继承的 fd 不受限**（README:729）
- **localhost 端口**：macOS `allowLocalBinding`；Linux 沙箱内 localhost 是独立命名空间，宿主 `localhost:3000` **只能经代理**，且要以字面量 `127.0.0.1:3000` 进 allowlist（`resolved-address-guard.ts:14`）。**→ 你的 Electron 主进程如果起了本地服务给沙箱内进程用，要走这条路**

## 关键路径

| 内容 | 路径 |
|---|---|
| 导出 | `src/index.ts` |
| **Manager API / 过滤逻辑** | `src/sandbox/sandbox-manager.ts:329-407, 630-982, 1548-1927, 2322-2378` |
| zod schema | `src/sandbox/sandbox-config.ts:718-926, 1076-1161` |
| **读/写语义定义** | `src/sandbox/sandbox-schemas.ts:3-40` |
| 路径规范化 / 默认可写 / 代理 env | `src/sandbox/sandbox-utils.ts:327-446, 474-677` |
| 解析地址守卫 | `src/sandbox/resolved-address-guard.ts` |
| mux / HTTP / SOCKS 代理 | `src/sandbox/{mux-proxy,http-proxy,socks-proxy,request-filter}.ts` |

## 取舍

**赚到：** "读宽写窄 + 网络白名单"对 agent 场景刚好；网络隔离在 OS 层，环境变量只是让程序**能**联网而非**限制**联网；`deniedDomainReasons` 让拒绝对模型可解释。
**付出：** 相对路径绑定宿主 cwd；Linux 无 glob；默认可写路径偏宽；`filterRequest` 只对明文或 tlsTerminate 路径有效（HTTPS CONNECT 只看域名）。

---

# 二、三平台实现

## macOS：Seatbelt

`src/sandbox/macos-sandbox-utils.ts` **[码]**
- **无模板文件**，`generateSandboxProfile`（`:826-1168`）逐行拼字符串：`(version 1)` + **`(deny default (with message "<logTag>"))`** + 白名单 process-exec / fork、固定 mach-lookup 列表、sysctl 列表 + 网络段 + 文件段。文件段顺序：`(allow file-read*)` → deny → allowWithinDeny → 迟发 deny → `file-read-metadata` → move-blocking（deny 祖先目录的 `file-write-unlink/create`）→ 写段 + 强制 deny。Seatbelt 是 **last-match-wins**，代码注释有明确的审计不变量（`:663-667`）
- 调用：`env <vars> /usr/bin/sandbox-exec -p '<profile>' <shell> -c '<cmd>'`（`:1353`）。profile 走 `-p` 参数不落盘；有 SBPL 字符串 1025 字节上限的规避（`SBPL_STRING_MAX_BYTES = 900`）和多路径合并成 regex 的优化
- **`sandbox-exec` deprecated 问题**：**[未查到]** 仓库源码 / README 无 "deprecated" 字样，无替代方案或版本探测。**这是一个你要自己盯的风险**：Apple 标记它 deprecated 多年但至今可用，Claude Code 也在用
- 违规监控：`log stream --predicate '(eventMessage ENDSWITH "<sessionSuffix>")'`（`:1403`），每条 deny 带 `CMD64_<b64>_END_<session>_SBX` 标签
- 凭据 `mask` 在 macOS 降级为 deny

## Linux：bubblewrap + seccomp

`src/sandbox/linux-sandbox-utils.ts` **[码]**
- **bwrap 参数**（`:1838-2093`）：`--new-session --die-with-parent [--unsetenv/--setenv…] --unshare-net [--bind <sock>] <fs args> --dev /dev --unshare-pid --unshare-user --cap-drop ALL --proc /proc -- <shell> -c <inner>`。有写限制时 `--ro-bind / /` 再 `--bind <allowWrite>`；denyRead 目录 `--tmpfs`、文件 `--ro-bind /dev/null <file>`；denyWrite `--ro-bind <p> <p>`。不存在的 deny 目标会让 bwrap 在宿主创建空文件做挂载点 → 所以要 `cleanupAfterCommand()`
- **网络 socat 两跳**（`:648-720, 843`）：宿主 `socat UNIX-LISTEN:/tmp/claude-http-<id>.sock … TCP:localhost:<muxPort>`，socket 文件 bind 进沙箱，沙箱内 shell 先起 `socat TCP-LISTEN:3128 … UNIX-CONNECT:<sock>` 和 `TCP-LISTEN:1080`，子进程 `HTTP_PROXY=http://…@localhost:3128`
- **seccomp BPF 不是运行时生成**：`vendor/seccomp-src/seccomp-unix-block.c` 用 libseccomp 生成 x86_64 / aarch64 两份 BPF（`socket(AF_UNIX)` → EPERM，`io_uring_*` → EPERM，其余 ALLOW），`vendor/seccomp/build.ts` 烧进头文件后 `gcc -static` 出 `apply-seccomp`。运行时 `getApplySeccompBinaryPath`（`generate-seccomp-filter.ts:160-230`）按 `process.arch` 找 `vendor/seccomp/{x64,arm64}/apply-seccomp`，找不到退到全局 npm 目录，再找不到**只 warn 不装 seccomp**。`apply-seccomp` 自己 `unshare(CLONE_NEWUSER)` → `unshare(CLONE_NEWPID | CLONE_NEWNS)`，做 PID 1、`PR_SET_DUMPABLE = 0`、`PR_SET_NO_NEW_PRIVS`、`prctl(PR_SET_SECCOMP)`（`apply-seccomp.c:709-868`）
- **⚠️ 源码检出里 `vendor/seccomp/` 只有 `build.ts`**，二进制由 release workflow 构建后打进 npm 包（`release.yml:12-32`）
- **系统依赖**：`bwrap`、`socat`、`rg` 三个必装（缺一 `initialize` 抛错，`:589-620`）；bwrap 最低版本 **[未查到]**（无版本探测）。需要无特权 user namespace；**Ubuntu 24.04 需 `sysctl kernel.apparmor_restrict_unprivileged_userns=0`**（README:493，CI 同样设）
- 无特权容器：`enableWeakerNestedSandbox: true` 时 `--bind /proc /proc` 而非 `--proc /proc`（`:2046`），README:792 "considerably weakens security"。WSL1 `isSupportedPlatform() = false`（`platform.ts:12`），WSL2 当普通 Linux。32 位 x86 明确不支持（socketcall 绕过）

## Windows：alpha

**[码]+[文]**
- README:474 "Alpha"。机制**不是 AppContainer**：Rust 工具 `srt-win.exe`（`vendor/srt-win-src/`，约 11k 行，仓库只含源码）一次性 `windows-install`（UAC）创建本地账户 `srt-sandbox` + **WFP 过滤器**（按 SID BLOCK 全部 connect，PERMIT loopback 60080-60089）。每次 exec：broker `CreateProcessWithLogonW` 以 `srt-sandbox` 起 runner，runner 用 `CreateRestrictedToken` + 完整性级别 + **Job object**（`KILL_ON_JOB_CLOSE`）起目标
- 文件系统**不是命名空间，是 `initialize()` 时给目标路径打 NTFS 显式 ACE**（allowWrite → MODIFY ALLOW，deny → DENY + 父目录 `FILE_DELETE_CHILD` DENY），`reset()` 撤销，有引用计数和崩溃恢复（README:549）。glob 在 init 时点展开
- 限制：`wrapWithSandbox()` 抛错只能 `wrapWithSandboxArgv()` 且 `shell: false`；per-exec 只能加 deny 不能加 allow；schannel CRL 检查被 WFP 挡（`CRYPT_E_REVOCATION_OFFLINE`）；per-user 安装的工具（nvm、Scoop）沙箱账号打不开；DNS 由 `Dnscache` 解析不受挡（README:578）

## ★ 违规反馈：对 agent 客户端最关键的一节

**[码]**
- **子进程看到的**：文件系统 → `EPERM` / `EROFS`（Linux "Read-only file system"，macOS "Operation not permitted"）；网络 → 代理返回 `HTTP/1.1 403 Forbidden` + `X-Proxy-Error: blocked-by-sandbox-runtime`（`request-filter.ts:211`），SOCKS "connection not allowed by ruleset"，未认证 407
- **给 agent / UI 的结构化通道**：`SandboxViolationStore`（`sandbox-violation-store.ts`，内存环形 100 条，`subscribe(listener)` 可订阅，`getViolationsForCommand(key)`）。三个生产者：
  1. macOS `log stream` 监听（需 `initialize(..., true)`）
  2. Linux **seccomp USER_NOTIF 观测器**（`linux-violation-monitor.ts`）：apply-seccomp 装第二个 filter 拦 `openat / openat2` 等写意图 syscall，经 `SRT_OBSERVE_SOCK` 把路径 JSON 行送回宿主，宿主按 allowWrite / denyWrite 前缀判定。**注释明说路径来自 `process_vm_readv`，攻击者可控且有竞态，只做诊断不做策略**
  3. 代理拒绝（`recordProxyViolation`，行格式 `deny network-outbound host:port (reason)` / `deny http-request METHOD url (reason)`，query string 打码）
- `annotateStderrWithSandboxFailures(key, stderr)` 追加 `<sandbox_violations>…</sandbox_violations>` 块（`sandbox-manager.ts:2256`），`<>` 和控制字符清洗。`ignoreViolations` 可按命令子串抑制

**→ 这就是 Claude Code 把"沙箱拒绝了什么"告诉模型的机制。模型看到 `deny network-outbound pypi.org:443 (use the company mirror instead)` 就能自己换方案，而不是对着 403 反复重试。`deniedDomainReasons` 是你写给模型看的。**

## 关键路径

| 内容 | 路径 |
|---|---|
| **Seatbelt profile / log 监听** | `src/sandbox/macos-sandbox-utils.ts:826-1168, 1180-1383, 1389-1484` |
| **bwrap / socat / 强制 deny** | `src/sandbox/linux-sandbox-utils.ts:648-720, 830-861, 948-1720, 1773-2115` |
| seccomp 查找与 C 源 | `src/sandbox/generate-seccomp-filter.ts`、`vendor/seccomp-src/*.c`、`vendor/seccomp/build.ts` |
| Linux 违规观测 | `src/sandbox/linux-violation-monitor.ts` |
| Windows | `src/sandbox/windows-sandbox-utils.ts`、`vendor/srt-win-src/src/{wfp,job,token,launch}.rs` |
| **违规存储 / 403** | `src/sandbox/sandbox-violation-store.ts`、`src/sandbox/request-filter.ts:211-250` |

## 取舍

Linux 隔离最强（netns + pidns + userns + seccomp）但依赖最多且要内核放开 userns；macOS 零依赖但 `sandbox-exec` 前途在仓库内无讨论；Windows 需一次管理员安装并改本机账户 / ACL，侵入性最大——**做产品时 Windows 档要给用户"不装沙箱"的降级选项**。

---

# 三、与 Agent 客户端集成

## 一条命令 vs 长驻进程

**两者都行** **[码]+[文]**。本质是把命令包成 `bwrap … / sandbox-exec … / srt-win exec …` 的 argv，生命周期由你 `spawn` 决定。README:50-101 主用例就是 `.mcp.json` 里 `"command": "srt", "args": ["npx", "-y", "@modelcontextprotocol/server-filesystem"]`，CLI 用 `stdio: 'inherit'`（`cli.ts:328`），stdin/stdout 直通。Linux 的 `--new-session`（setsid）和 `--die-with-parent` 不影响管道；macOS 交互式 TTY 需要 `allowPty`。

**→ MCP stdio server 整体包进沙箱 = `wrapWithSandboxArgv` + `spawn(..., { stdio: 'pipe' })`，然后把 stdio 交给 `StdioClientTransport`。**

## 进程模型与开销

**[码]**
- `initialize()` 一次：代理 + Linux 两个 socat bridge + 监听器为**会话级复用**
- `wrapWithSandbox*` 是 **per-command 纯计算**，无缓存也无需缓存——实测约 10ms
- 运行期每条命令额外进程：Linux = bwrap + shell + 2×socat + apply-seccomp + shell；macOS = env + sandbox-exec + shell；Windows = broker → runner → child 两跳
- 同一会话可并发多条命令；Linux 挂载点清理有 `activeSandboxCount` 引用计数
- `updateConfig` 对**网络规则热生效**（代理每次请求读 config），**文件系统规则要 `reset() + initialize()`**（`:1938`）
- benchmark 文件 **[未查到]**

## 映射 Codex 三档

**仓库没有内置 preset** **[码]**（`cli.ts` 的 `getDefaultConfig()` 是 CLI 缺省，`grep preset` 无结果）。用 config 表达：

```ts
// read-only：不能写、不能联网（读默认全开，再挖掉密钥目录）
const readOnly: SandboxRuntimeConfig = {
  network:    { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: ['~/.ssh', '~/.aws', '~/.gnupg'], allowWrite: [], denyWrite: [] },
}
// 注意：仍有 getDefaultWritePaths（/tmp/claude、~/.npm/_logs 等）可写，TMPDIR 指到 /tmp/claude

// workspace-write：只写工作区（+ /tmp），网络按需白名单
const workspaceWrite: SandboxRuntimeConfig = {
  network:    { allowedDomains: ['api.github.com', '*.npmjs.org'], deniedDomains: ['*:22'], strictAllowlist: true },
  filesystem: { denyRead: ['~/.ssh'], allowWrite: [workspaceAbs, '/tmp'], denyWrite: [`${workspaceAbs}/.env`] },
}
// .git/hooks、.git/config、shell rc 由内置强制 deny 兜底；要改 git remote 时加 allowGitConfig: true

// danger-full-access：★ 无法用本包表达（网络不接受 "*"）→ 直接跳过 wrap
```

**→ 主参考 §4.10 说的"Codex 三档语义"要改成：两档用本包，第三档是"不包装"。** UI 上还是三档，实现上是两种 config + 一个 bypass。

## 已知限制（仓库明说）

**[文]+[码]**
- README:782-794：不检查代理流量内容（域名级，domain fronting 可绕）；`allowUnixSockets` 给 docker.sock 等于给宿主；宽写权限（PATH 目录、rc 文件）可提权；三个 `enableWeaker*` / `allowAppleEvents` 各自削弱
- 不防内核漏洞、不覆盖 GUI：**[未查到]**（README 未提；`allowAppleEvents` 段说明启动的 app 完全在沙箱外）
- **Electron / asar / code signing：[未查到]**，仓库零文档。与打包相关的事实：`apply-seccomp` 查找按 `import.meta.url` 相对目录再退到全局 npm（`generate-seccomp-filter.ts:126`，注释提到 "bundled into claude-cli"）；`seccomp.applyPath`、`javaAgentJarPath`、`windows.srtWin.path`、`bwrapPath / socatPath` 可显式指绝对路径——**这些就是为 bundler 设计的钩子**；`seccomp.argv0` / `srtWin` 的 `--srt-win` argv[1] 支持把 helper 编进 multicall 二进制

## 依赖

`package.json` **[码]**
- `dependencies` 4 个：`@pondwader/socks5-server`（SOCKS5）、`commander`（CLI）、`node-forge`（tlsTerminate 的 CA / 叶证书）、`zod`
- `engines.node >= 20.11.0`（`readdirSync(recursive)`、`parentPath` 需要 Node 20+）
- **无 native addon**（无 node-gyp / .node）。原生部分是三个**独立可执行文件**：`vendor/seccomp/<arch>/apply-seccomp`（静态 C）、`vendor/srt-win/<arch>/srt-win.exe`（Rust）、`vendor/java-proxy-agent/srt-proxy-agent.jar`（Java 17+）——在 `files` 字段随 npm 包发布，**Electron 不需要 rebuild**，但要保证它们以真实文件（非 asar 内）存在
- 测试跑 `bun test`

## 测试：可直接借用的逃逸测试集

**[码]** `test/sandbox/`：
- `integration.test.ts:465-990`：PID 命名空间隔离、symlink 逃逸写、跨协议 / 端口 / 直连 IP 的网络封锁、`--die-with-parent` 孤儿进程、提权尝试、特殊文件类型创建
- `pid-namespace-isolation`、`symlink-boundary`、`symlink-write-path`、`symlinked-deny-paths`、`mandatory-deny-paths`、`execute-only-binary`、`readonly-deny-dir-{binds,stubs}`、`macos-seatbelt`、`macos-glob-deny-reemit`、`allow-read`、`resolved-address-guard`、`proxy-deny-violations`、`seccomp-filter`
- 辅助 `test/helpers/spawn.ts` 的 `spawnAsync`（立即关 stdin），可搬到自己的 e2e
- CI `.github/workflows/integration-tests.yml`：linux / macos / windows × x64 / arm64 矩阵；docker job 在无特权容器分别以"root 有 / 无 CAP_SYS_ADMIN"跑 `test/docker-weak-sandbox.test.ts`

**→ 阶段 4 的验收标准可以直接是"这些测试在我们的集成层上全过"。**

## 关键路径

| 内容 | 路径 |
|---|---|
| CLI 执行方式（MCP 用例） | `src/cli.ts:318-363`、README:50-101 |
| 配置热更新 / 清理 | `src/sandbox/sandbox-manager.ts:1938-1986, 2114-2250` |
| **二进制查找钩子** | `src/sandbox/generate-seccomp-filter.ts`、`sandbox-config.ts:1058-1071, 1133-1152` |
| 依赖 | `package.json` |
| CI / 测试 | `.github/workflows/*.yml`、`test/sandbox/*.test.ts`、`test/helpers/spawn.ts` |

---

# 结论：Electron 集成清单（只写有源码依据的）

1. **主进程** `SandboxManager.initialize()` 一次常驻（代理 / bridge 会话级复用）；`wrapWithSandboxArgv()` + `spawn(..., { shell: false })` 统一三平台；退出 `reset()`（它也自动挂了 exit / SIGINT / SIGTERM）
2. **每次调用**传 `options.commandId`（= tool-use id）和显式 `cwd`，**只传绝对路径**；命令结束 `cleanupAfterCommand()`
3. **打包**：`apply-seccomp`、`srt-win.exe`、`srt-proxy-agent.jar` 作为 `extraResources` 放 asar 外，用 `seccomp.applyPath`、`windows.srtWin.path`、`javaAgentJarPath` 指绝对路径；`bwrapPath / socatPath` 可指向自带副本；启动时 `checkDependenciesAsync()` 把 `errors / warnings` 给用户看（Linux 还要提示 userns sysctl）
4. **违规回传**：`initialize(cfg, askCb, true)` 开监听，`getSandboxViolationStore().subscribe()` 推 UI，`annotateStderrWithSandboxFailures(commandId, stderr)` 把 `<sandbox_violations>` 喂给模型；`deniedDomainReasons` 写模型可读的替代方案
5. **`askCallback`** 用于"询问用户放行域名"→ `updateConfig()` 热更新 allowlist；文件系统规则变更需 `reset() + initialize()`——**所以"切换工作区"要重新初始化沙箱**
6. **MCP stdio server** 整体包进沙箱即可；需要 TTY 的交互命令在 macOS 加 `allowPty`
7. **三档 UI = 两种 config + 一个 bypass**；Windows 给"不装沙箱"的降级选项

## 对主参考的修正

- §4.10 "Codex 三档语义"：full-access 档无法用本包表达，是 bypass
- §15.1 第 5 条：npm 最新是 **0.0.76**（2026-09-10），不是 0.0.75；GitHub release 页日期问题不影响使用
- 新增风险：`sandbox-exec` deprecated 在仓库内无应对；Ubuntu 24.04 的 AppArmor userns 限制要在安装引导里处理
