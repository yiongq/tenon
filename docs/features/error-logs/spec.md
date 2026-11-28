# 错误日志

Status: ready
Approved: ready · 2026-11-28 · 「error-logs 改 ready」 · 对话
Tier: heavy — 机密和对话会不会进日志：写入口、脱敏和测试要一起守住，漏一处就会把 key 留在磁盘上
Changes: 03 §接口（增补：McpPoolOptions 只增可选成员 onSecret）；03 §本地 server：进程与环境（增补：MCP 日志文件只有本人能读）

## 给你看的一页

做什么：把 Tenon 今天只打到控制台的报错写进本地日志文件，写之前去掉机密；启动失败时告诉你日志在哪。

```
界面向后台的请求失败 · 模型请求失败 · 进程崩溃或异常退出 · Tenon 原来只打到控制台的
        │
        ▼ 先去掉 key 和令牌，主目录写成 ~，再截短；同一个来源刷屏时限量
Tenon 数据目录里的日志文件夹：一行一条；当前文件满 5 MB 换新，另留 2 份旧的
        ├─► 帮助菜单里能打开这个文件夹
        └─► 启动失败时，弹框写明它在哪
```

例子：你存了一把错的智谱 key，发一句「帮我看看这个文件夹」。日志里多出一行。它记着时间（带时区）、错误级别、模型请求失败、状态 401、原因是 key 不对、不能重试，后面跟着截短的错误说明。那把 key 不在这一行里。文件里是英文写的。

怎么算做完：
- 你存错 key 再发消息 → 日志里多一行模型请求失败，里面没有那把 key（验收 3、7）
- 你点「帮助 → 打开日志文件夹」→ 访达打开这个文件夹（验收 12、19）
- 你打开 Tenon 用一会儿再关掉 → 日志里记着启动、窗口出来了、沙箱状态和正常退出（验收 17）
- lead 演示让窗口崩一次 → 日志里写着崩的是窗口进程，以及原因（验收 8、19）
- lead 演示在后台抛一个没接住的错 → 日志多一行；照旧弹出那个英文报错框，Tenon 不退出（验收 9、19）
- lead 演示在活动监视器里「强制退出」，你再打开 → 日志里写着「上次没有正常退出」和那次的启动时间（验收 10、19）
- lead 演示把数据目录里的一个子文件夹换成同名文件 → Tenon 启动失败，弹框写明日志在哪个文件夹，那里有这次失败的一行（验收 11、19）
- lead 演示在开发者工具里一分钟打出几千条不同的报错 → 每一分钟最多多出 60 行，跨两分钟最多 120 行；关掉 Tenon 再看，多了一句丢了多少条（验收 16、19）

不做：把崩溃上传到服务器；Tenon 自己在本机留崩溃转储；界面白屏之后的恢复；工具调用失败（它们在对话里看）；Node 和 Chromium 自己往终端打的行；启动速度和内存的度量。连接器的日志只改成只有你能读，不加上限、不加脱敏。安装包在另一份 spec 里。

代价和已知限制：Tenon 被强杀、内存耗尽或断电时，那一刻记不下来，下次启动只补一句「上次没有正常退出」。不留转储，底层崩溃没有现场；系统自己会留崩溃报告（Linux 上含整段内存），Tenon 管不到。厂商的错误说明、界面报错和少数后台报错，偶尔会带回一点你的内容。主目录写成了 ~，项目名和文件名照记。沙箱没生效时，你放行过的命令读得到日志。有人持续刷屏十来分钟，前面的普通记录会被挤掉。在 Linux 上打开日志文件夹，会起一个不在 Tenon 沙箱里的系统程序。

要你定的：这一份的 16 张卡都已定（后 4 张是段一复审后补问的，D21–D24），都标了推荐；选错难退的没有，中等的 1 张。lead 还替你定了 42 项，写在决策记录里，你不推翻就算认可；最要紧的 5 项在最后一行。
- 你定了：机密分三层去掉，读到 key 时当场登记（不是只靠格式去认）。
- 你定了：同一个来源每分钟最多 60 行，日志文件打开前先查是不是链接、是不是你的（不是只要其中一道，或都不要）。有两处比 60 行宽，是 lead 后补的、记在决策记录里：主进程没接住的错每分钟 600 行；启动、退出、崩溃这类九种行不限量。
- 你定了：启动失败的提示框和「打开日志文件夹」都做（不是只做一项，或都不做）。
- 你定了：不留崩溃转储（不是在本机留 3 份）。
- 你定了：连接器的日志只改成只有你能读（不是一起加上限和脱敏）。另有 7 条见决策记录。
- lead 替你定的：先去掉机密再截短；没接住的错只记下来，Tenon 的反应不变；换新文件时把本次启动的关键几行抄过去；新写的部分不依赖 Electron，好测；「打开日志文件夹」放在帮助菜单。

## 外部依据

- 仓库现状：主进程的报错只进控制台，界面向后台的请求失败与模型请求失败今天都不进日志，现有的脱敏函数只是已知值精确替换（E1）；改动会碰到的测试与可借的先例（E2）。
- 机密从哪来、会从哪漏：OAuth 令牌分片存、client secret 在整段 JSON 里、开发期 key 来自环境变量、MCP 日志是 0644、沙箱观测器的路径由沙箱里的程序控制、几处后台报错带原文（E8）。
- 转储里可能有内存片段、命令行和环境，Electron 没有删除它的办法，所以不留（E3）；正对照成立之后，不启动崩溃收集时三个平台的数据目录里都没有 `.dmp`（P1）。
- Electron 的进程事件与主进程异常的默认处理（E4）；单独的 Promise 拒绝不到 `uncaughtExceptionMonitor`、不弹框、不退出，`unhandledRejection` 监听收得到（P2）；界面里没接住的异常、未处理的拒绝、渲染时抛的错都以错误级出现在控制台消息里，正常退出时没有子进程事件（P3）。
- 错误对象里带路径、响应头和响应体，不能整对象序列化（E5）。
- 自写写入器而不用现成日志库的理由，以及同类应用的做法（E6）。
- 测试工具与 Electron 的几处细节：Playwright 起的 Electron 自带禁用转储的开关、Linux 上 ready 之前弹框只打到 stderr、SIGTERM 的三种情形、e2e 里的版本号（E7）。
- 文件保护挡得住什么、挡不住什么，系统自己的崩溃记录，Linux 上打开文件夹会起系统程序（E9）。
- 调研原文、核实、两份挑刺评审、复审与探针原始输出在仓库外的私有笔记（另记）。

## 接口

只写新增与改动的部分。新增的都在 `apps/desktop/src/main/log/`，都不 import electron；用到 Electron 的值（版本、目录、是否安装版、`dialog`、`shell`）一律由调用方传入。

```ts
// log/events.ts —— 写入口只收这些事件
export type LogLevel = 'error' | 'warn' | 'info' // error：出了错要看；warn：降级、被拒或被丢；info：生命周期与提示
export interface ErrorSummary {
  readonly name: string               // 构造函数名，取不到用 error.name
  readonly code?: string              // error.code，如 ENOENT
  readonly message: string            // 先脱敏，再截到 500 字
  readonly frames?: readonly string[] // 栈的前 10 帧，每帧先脱敏再截到 300 字
} // 不取 cmd、spawnargs、env 等属性；cause 链不读
export type LogEvent =
  | { readonly event: 'app.start'; readonly packaged: boolean; readonly platform: string; readonly arch: string; readonly userData: string }
  | { readonly event: 'app.unclean-exit'; readonly startedAt: string | null; readonly version: string | null }
  | { readonly event: 'app.startup-failed'; readonly error: ErrorSummary }
  | { readonly event: 'app.quit' }
  | { readonly event: 'window.shown' }
  | { readonly event: 'sandbox.posture'; readonly state: 'active' | 'degraded' | 'unavailable'; readonly reasons: readonly string[] }
  | { readonly event: 'sandbox.helpers'; readonly packageDir: string; readonly applySeccomp: string; readonly javaAgentJar: string }
  | { readonly event: 'main.uncaught'; readonly origin: 'uncaughtException' | 'unhandledRejection'; readonly error: ErrorSummary }
  | { readonly event: 'process.gone'; readonly process: string; readonly reason: string; readonly exitCode: number; readonly name?: string }
  | { readonly event: 'ipc.failed'; readonly channel: string; readonly code: IpcError['code']; readonly message: string }
  | { readonly event: 'renderer.error'; readonly message: string; readonly source: string; readonly line: number; readonly repeats: number }
  | { readonly event: 'log.dropped'; readonly source: string; readonly count: number } // 限量丢掉的、开日志前缓存溢出的
  | { readonly event: 'line'; readonly source: string; readonly text: string }        // 各模块 `log` 回调交来的一行字

// log/app-log.ts
export interface RunningMarker { readonly v: 1; readonly startedAt: string; readonly version: string; readonly pid: number }
export type OpenResult =
  | { readonly ok: true; readonly previous: 'none' | 'unreadable' | RunningMarker } // 不是 none 时 open 自己写 app.unclean-exit
  | { readonly ok: false; readonly reason: string }                                // 写不进去：照常运行，只往 stderr 报一次
export interface AppLog {
  open(dir: AbsolutePath, q: {     // dir 就是 `<profileDir>/logs`；不存在就建成 0700
    readonly version: string      // app.getVersion()
    readonly packaged: boolean    // app.isPackaged；只有开发构建镜像到 stderr
    readonly home: AbsolutePath   // 写成 ~
    readonly appDir: AbsolutePath // 写成 <app>：安装版是 process.resourcesPath，开发构建是 app.getAppPath()
  }): OpenResult
  write(level: LogLevel, event: LogEvent): void                  // 同步；从不抛
  line(source: string, level: LogLevel): (text: string) => void  // 接已有的 `log: (line: string) => void`
  remember(secret: string): void                                 // 登记机密；短于 8 个字符的不登记
  redact(text: string): string
  readonly dir: AbsolutePath | null                              // 还没开时为 null
  close(): void                                                  // 补写合并与丢弃的计数、写 app.quit、删标记、关文件；没开过时什么都不做
}
export function createAppLog(options: {
  readonly now: () => Date
  readonly pid: number
  readonly uid: number                    // 文件属主要等于它；测试传别的值来模拟「别人的文件」
  readonly stderr: (text: string) => void // 镜像与「写不进去」的那一句；控制字符先转义
  readonly maxBytes?: number              // 缺省 5 MiB
  readonly keep?: number                  // 缺省 2 份旧的
}): AppLog
export const appLog: AppLog // 主进程唯一的实例；Electron-free 的模块 import 它不会拉进 electron

// log/redact.ts
export function summarizeError(error: unknown, redact: (text: string) => string): ErrorSummary
export function rememberingSecrets(secrets: HostSecrets, log: Pick<AppLog, 'remember'>): HostSecrets // 每次 get 读出、set 写入的值都登记

// log/watch.ts
export function logRouteFailures(ipc: IpcMainLike, log: AppLog): IpcMainLike
export function watchProcessExits(app: { on(event: 'render-process-gone' | 'child-process-gone', listener: (...args: never[]) => void): unknown }, log: AppLog): void
export function watchUncaught(proc: {
  on(event: 'uncaughtExceptionMonitor', listener: (error: Error, origin: string) => void): unknown
  on(event: 'unhandledRejection', listener: (reason: unknown, promise: Promise<unknown>) => void): unknown
}, log: AppLog): void // 来源按哪个事件触发来定，不看参数
export function watchRendererConsole(contents: { on(event: 'console-message', listener: (details: { level: string; message: string; sourceId: string; lineNumber: number }) => void): unknown }, log: AppLog): void

// log/startup-failure.ts —— 「记一行 → 等 ready → 弹框 → 退出」的顺序都在这里，单元测试用假的 dialog 与 exit
export async function reportStartupFailure(q: {
  readonly error: unknown
  readonly log: AppLog
  readonly openFallback: () => void                 // 日志还没开时按算出的文件夹尽力开一次
  readonly whenReady: () => Promise<void>           // Linux 上 ready 之前弹框只会打到 stderr
  readonly showErrorBox: (title: string, content: string) => void
  readonly exit: (code: number) => void
  readonly languages: readonly string[]             // 系统偏好语言，挑 zh-CN 或 en，挑不到用 en
}): Promise<void>
export async function openLogsFolder(q: {
  readonly dir: AbsolutePath | null
  readonly openPath: (path: string) => Promise<string> // Electron 的 shell.openPath：成功回空串
  readonly showErrorBox: (title: string, content: string) => void
  readonly languages: readonly string[]
}): Promise<void>

// apps/desktop/src/main/menu-template.ts —— MenuOptions 只增一个成员
export interface MenuOptions { /* 已有四个成员不动 */ readonly onOpenLogs: () => void }
// apps/desktop/src/main/menu.ts —— 多一个参数
export function buildApplicationMenu(i18n: I18n, onNewChat: () => void, onOpenLogs: () => void, packaged: boolean = app.isPackaged): Menu

// packages/kernel/src/mcp/pool.ts —— 只增一个可选成员（§对 03 的增补，D19）
export interface McpPoolOptions { /* 已有成员不动 */ readonly onSecret?: (value: string) => void }
```

模型请求失败那一行由 `packages/kernel/src/loop/run.ts` 经已有的 `ctx.log` 交出，kernel 别的接口不变。`host/sandbox.ts` 的 `DesktopSandbox` 把「对不上命令的违规」那一行交给单独的来源 `sandbox-unattributed`（接线时多给它一个 log 函数）。

**日志行**（存盘格式，D17）：`<profileDir>/logs/main.jsonl`，UTF-8，一行一个 JSON 对象，以 `\n` 结尾。前六个字段固定、按这个顺序，后面接事件自己的字段：

| 字段 | 值 |
|---|---|
| `v` | 格式版本，现在是 1 |
| `t` | 本地时间带时区偏移，ISO 8601 到毫秒，如 `2026-11-28T17:15:02.123+08:00` |
| `level` | `error`、`warn` 或 `info` |
| `ver` | `open` 时传入的版本：开发构建是 package.json 的版本，e2e 直接起 `out/main/index.js` 时是 Electron 的版本 |
| `pid` | 主进程 pid |
| `event` | `LogEvent` 的 `event` |

轮转后抄进新文件的那几行，原样照抄（`t` 仍是原来的时间），末尾多一个 `"carried": true`。读日志的工具按 JSON 逐行解析、看 `event` 字段判断，不拿文字去搜（`line.text` 里可能有任意文字）。

例（模型请求失败）：`{"v":1,"t":"2026-11-28T17:15:02.123+08:00","level":"error","ver":"0.0.0","pid":4242,"event":"line","source":"kernel","text":"[provider] run 3f2c… attempt failed: provider=zhipu model=glm-5.3-flash code=auth status=401 providerCode=1000 retryable=false detail=AuthenticationError: …"}`

**运行标记**：`<profileDir>/logs/running.json`，内容是一个 `RunningMarker`，`startedAt` 的写法同 `t`。

**迁移和回退**：只新增文件，另把已有的 `logs/` 改成 0700、已有的 MCP 日志改成 0600。没有这两种文件的旧版本不读它们，退回旧版本时可以直接删。将来改格式只升 `v`，应用从不回读旧的日志行；运行标记读不出就当「上次没有正常退出」。没有回不去的点。

## 一直要成立的规矩

- 主进程里只有 `log/` 写控制台或 stderr，别处不调 `console`、不写 `process.stderr` 与 `process.stdout`（由 lint 与静态扫描测试一起守，两边各有没列到的写法）。
- 主进程里只有 `log/` 与 `mcp/log-sink.ts` 写 `logs/` 下的文件（由测试守：静态扫描 `apps/desktop/src/main`）。
- 写入口只收 `LogEvent`（由类型检查守对象形状）；`line` 的字符串里不放 `JSON.stringify` 或 `util.inspect` 出来的对象（没自动化，靠评审）。
- 每个字符串字段先脱敏、再截断，做完再序列化成一行，不在序列化后的整行上替换；同一位置有几个登记值能对上时取最长的；应用目录先于主目录替换（由测试守）。
- 主进程里的 `HostSecrets` 只有一个，在交给 host 之前包上 `rememberingSecrets`，`get` 的每一次读出都登记；`apps/desktop/src/main` 里别处不 new 钥匙串或内存钥匙串（由测试守：静态扫描 `new KeychainSecrets`、`new MemorySecrets` 只出现在 `host/index.ts`）。
- 应用日志与运行标记只在 `<profileDir>/logs/` 下，路径里带 tenantId；不调 `app.setAppLogsPath`，不写 `app.getPath('logs')`（D17；由测试守）。
- 打开日志前确认 `logs/` 是自己的真目录（不是链接、属主是自己），改成 0700；`main.jsonl` 以追加、不跟随符号链接打开后，必须是普通文件、只有一个硬链接、属主是自己，再改成 0600；运行标记的临时文件（`running.json.tmp`）先删掉同名的旧名字（只删名字本身，不跟随链接），再以排他创建、不跟随符号链接、0600 写出并改名；运行标记写不出来，只影响下次的「上次没有正常退出」，日志照写。读旧标记时以不跟随符号链接、不阻塞的方式打开，确认是普通文件且不超过 4 KiB。目录或日志文件检查不过，才当「写不进去」（D20；由测试守）。
- 改已有 MCP 日志的权限时，以不跟随符号链接的方式打开，确认是自己的普通文件、只有一个硬链接后再改；不是就跳过（D18；由测试守）。
- kernel 不碰日志文件，只经已有的 `log` 回调交出一行字，经 `onSecret` 交出机密（AGENTS.md「Hard rules」第 1 条；由 lint 守）。
- 日志相关的改动不新增 IPC 通道，不改 `packages/contracts`（AGENTS.md「Hard rules」第 3 条；没自动化，靠评审）。
- 不调用 `crashReporter.start`，不设 `crashDumps` 路径（由测试守：静态扫描）。
- 主进程不注册 `uncaughtException` 监听：异常只用 `uncaughtExceptionMonitor` 记，Promise 拒绝用一个只记一行的 `unhandledRejection` 监听（P2；由测试守）。
- 「打开日志文件夹」只用 Electron 的 `shell.openPath`；Linux 上它由 Electron 起 `xdg-open`、参数固定，和已有的 `shell.openExternal` 同一类（E9；没自动化，靠评审）。

## 日志怎么写

**记什么**（级别按 `LogLevel` 的含义定，不照搬原来用的 console 方法）
- 生命周期（info）：启动（安装版与否、平台、架构、数据目录）、窗口出来了（主窗口 `ready-to-show`）、沙箱状态与原因（启动结果出来时）、交给沙箱的 helper 路径、正常退出（`will-quit`）。04 原有的那行 `sandbox: <状态>` 文字照旧作为 `line` 留着，带原因详情；判断沙箱状态只看 `sandbox.posture`。
- Tenon 自己的代码原来打到控制台的每一行：`index.ts` 里的转发器改成 `appLog.line(来源, 级别)`；各模块 `log ?? console.warn` 的回落与 `host/profile.ts` 的 `readConfig` 的缺省 log 改成 `appLog.line`。kernel、MCP、Tape 经已有回调交来的行同样收。`startup-recovery.ts` 的「N 个会话可续跑」记 info。Node 与 Chromium 自己往 stderr 打的行不收。
- 界面向后台的请求失败（warn）：`logRouteFailures` 包在 `index.ts` 那三层路由包装的最外面，所以离 `registerRoute` 最近，只看它自己的答复：`ok: false` 时记通道、码和说明；退出中、删除中的拒绝发生在它外面，不记（E2）。
- 模型请求失败（error）：kernel `loop/run.ts` 在一次尝试以 `error` 结束时经 `ctx.log` 写 `[provider] run <runId> attempt failed: provider=<id> model=<id> code=<code> status=<status 或 -> providerCode=<码或 -> retryable=<true|false> detail=<detail>`。detail 是 kernel 已脱敏、截到 500 字的那段，01 定它「只进日志」。
- 进程退出（error）：`render-process-gone` 记 `process: 'renderer'`；`child-process-gone` 记 `details.type` 与 `name`；`reason` 为 `clean-exit` 的不记（E4、P3）。
- 主进程没接住的错（error）：异常只听 `uncaughtExceptionMonitor`，记来源与错误摘要，Electron 自己的弹框与「不退出」照旧；单独的 Promise 拒绝今天到不了它（P2），另加一个只记一行的 `unhandledRejection` 监听。拒绝今天就不弹框、不退出，加了照旧。加了监听之后，终端里原来那行英文警告与进程的退出码会不会变，探针没测（开放问题 1）。
- 界面报错（error，D8；P3 实测三种错都以 error 级出现）：每个窗口的 `webContents` 上听 `console-message`，只取级别为 error 的：第一行先脱敏再截到 300 字；来源只留文件名（路径的最后一段，去掉查询串与 `#` 之后，截到 200 字）与行号。第一条立即写出，`repeats` 是 1；之后连续相同的只计数，内容变了、这一分钟过去或 `AppLog.close()` 时，补写一行，`repeats` 是这一串的总次数（含第一条）；只出现一次的不补写（P3）。
- 不记：对话内容（消息、回复、思考、工具参数与结果）、完整命令行与环境变量、错误对象的 `cmd`、`spawnargs`、`env`、请求头、子进程输出的正文（MCP 的照旧进它自己的日志）。

**写入口**（验收 3、4 的测试按这张表逐项注入）：`LogEvent` 的每一种；`line`；开日志之前的内存缓存；轮转出来的 `main.1.jsonl`、`main.2.jsonl`；轮转后抄过去的行；`running.json`。stderr 镜像只在开发构建里有，同样已脱敏，不算日志文件。测试用一张 `satisfies Record<LogEvent['event'], …>` 的哨兵表，新增一种事件不补哨兵就过不了类型检查。

**脱敏**（D16）：三层。
1. 只收声明过的字段；错误只留 `ErrorSummary`。
2. 登记值：主进程每次读到密钥值都当场登记。登记点是 ① `host.secrets` 的每一次 `get` 读出（包括启动后第一次读上一次运行存下的 key）与每一次 `set` 写入（`rememberingSecrets`；provider key、自定厂商 key、MCP 的 `env_keys` 与静态头都经它）；② 开发构建从环境变量回落取到的密钥（`apps/desktop/src/main/provider.ts` 解析出 `source: 'env'` 的那一刻，名字来自 `DEV_ENV_FALLBACK`）；③ kernel 连接池往某台 server 的脱敏表里加的每一个值，经 `onSecret` 报出，包括从分片拼出的整段 OAuth 令牌、refresh token 与 client secret（D19）；④ MCP server 配置里 `envs` 的值，desktop 每次把 MCP 配置交给连接池时（`mcp/runtime.ts` 的 `mcpRuntimes`）登记，运行中经 `mcp.save` 新加或修改的 server 也走这一步。每个值连同它的 base64、URL 编码、JSON 转义写法一起登记。不少于 8 个字符才登记，比 03 给 MCP 日志定的 4 个字符严，因为这里要少换掉普通的配置值。
3. 通用格式兜底：`sk-`、`gh[opusr]_`、`github_pat_`、`glpat-`、`xox[abp]-`、`AKIA`、`AIza` 开头的串；`Bearer` 后的令牌；三段式 JWT；网址里 `token`、`key`、`apikey`、`api_key`、`api-key`、`secret`、`client_secret`、`code`、`access_token`、`access-token`、`refresh_token`、`password`、`sig` 的值（参数名不分大小写）；`Authorization:` 头的值；PEM 私钥块；网址里的 `user:pass@`。 每种格式带一个最短长度（如 `sk-` 后至少 20 个字符），短于它的不当令牌换，免得把普通文字换掉。

都换成 `[redacted]`；最后应用目录换成 `<app>`，主目录前缀换成 `~`。漏登记由两样守：结构上只有一个被包住的 `HostSecrets`（规矩第 5 条）；每个登记点一条走真实路径的哨兵用例，包括「上次已存、这次重启后只经 `get` 读出」那一条（验收 3）。

**限量**（D20）：固定窗口，从 `open` 起每 60 秒一窗。每个来源每窗最多 60 行，超出的丢掉；窗口过去后的第一次写入时、或 `close` 时，补写一行 `log.dropped`。来源这样算：
- `line`：按它的 `source`，即各转发器与回落在接线时写下的名字（如 `host`、`tape`、`kernel`、`mcp`、`config`、`shutdown`、`recovery`）；Linux 沙箱观测器「对不上命令的违规」单独算 `sandbox-unattributed`。
- `ipc.failed`：所有通道合起来算一个来源 `ipc`。
- `renderer.error`：所有窗口合起来算一个来源 `renderer`（合并计数的那一行也算一行）。
- `main.uncaught`：一个来源，每窗最多 600 行。
- 不限量的九种：`app.start`、`app.unclean-exit`、`app.startup-failed`、`app.quit`、`window.shown`、`sandbox.posture`、`sandbox.helpers`、`process.gone`、`log.dropped`。补写 `log.dropped` 每窗每个来源至多一行，所以它刷不起来。
- 每次轮转后，在新文件开头抄一遍本次启动已写的 `app.start`、`app.unclean-exit`、`window.shown`、`sandbox.posture`、`sandbox.helpers`，每种只抄最近的一条（窗口可以开很多个，全抄会让抄写本身没有上界）。不给别的行留保底：要保证得按来源分字节额度或另开文件，超出 D20；照实写进已知限制。

**怎么写**
- 文件：当前写 `main.jsonl`；加上下一行会超过 5 MiB 时，先轮转再写：它改名 `main.1.jsonl`、原来的 `main.1` 改名 `main.2`、最旧的删掉。
- 打开：`main()` 一开始（单实例锁已拿到）按 `profileDirFor(userData, 'local', 'personal')` 算出日志文件夹，照规矩第 7 条检查与建立；每行同步写（E6）。上次最后一行没有换行时先补一个。`will-quit` 的监听在 `open` 之后才注册。
- 运行标记：`open` 读旧标记，不是 `none` 就自己写 `app.unclean-exit`（读不出时两个字段为 null），再写新标记。`will-quit` 时 `close()`。启动失败走 `app.exit(1)`，不删标记。
- SIGTERM 有三种情形（E7）：srt 装上它的信号监听之前，Electron 把 SIGTERM 当成正常退出处理，写 `app.quit`；srt 装上之后、Tenon 的 `registerSandboxSignals` 登记之前，SIGTERM 只让 srt 复位，进程不退出；登记之后，走正常退出。
- 上限：单行 16 KiB，字符串字段 2000 字，超出截断并写明截了多少，如 `…(+5120)`（留下的部分不超过上限，这个标记加在后面、不算在上限里）；先脱敏再截断。整行仍超过 16 KiB 时，把当时最长的字符串字段再截一半，直到放得下。换行与控制字符由 JSON 转义，一条不会拆成两行。
- 脱敏、截断都按字段做，做完再拼成一行：登记值和通用格式只在字符串字段的值上替换，不在拼好的整行 JSON 上替换（登记进来的值如果长得像日志格式本身，整行替换会把之后每一行打碎）。字段的结尾（后面可以跟着截断标记 `…` 或 `…(+N)`，标记留着）恰好是某个登记值原文开头的 8 个字符以上时，这一段也换掉，7 个以下不动（上游先截过的文字，比如 kernel 截到 500 字的 detail，会留下机密的前半段）。
- 一行里除了 JSON 本来就转义的控制字符，U+0080–U+009F、U+2028、U+2029 也写成 `\uXXXX` 转义，免得按行读的工具把一行看成两行。
- 缩到最短仍超过 16 KiB 的行不写原事件：当场改写一行 `log.dropped`，`source` 是原事件名，`count` 是 1，级别沿用原行。开日志前缓存溢出的那一行 `log.dropped`，`source` 是 `buffer`。值的嵌套深度、数组长度超过实现里的固定上限时照截断处理。
- 轮转失败（旧文件改不了名、名字被占）：不回到已满的文件接着写。这一行丢掉并计进 `log.dropped`（`source` 是 `rotate`），只往 stderr 报一次，从失败那一刻起过一分钟再试轮转，这一分钟里还放得进去的短行照常写；丢了多少等轮转成功后（或退出时写得进去的话）再记，不挤进已满的文件；`main.jsonl` 任何时候不超过 5 MiB 加一行。 丢掉的行一条算一条（被限量并掉的也按原来的条数算），抄写行不算丢；改名成功但新文件打不开时，同样按轮转失败处理并计数；退出时即使还在那一分钟里也再试一次轮转，好把 `app.quit` 写进去。
- 开发构建的 stderr 镜像排在限量之前：被限量丢掉的行终端里照样看得到；`close` 之后写的行也镜像。
- 脱敏的工作量有上界：字符串字段在脱敏之前先截到 16 384 个字符（多出来的本来也会被截掉，`…(+N)` 的 N 照原来的长度算）；长于 16 384 个字符的值不登记。一个 4096 字的登记值加一条 1 MB 的文字，写这一行仍在 200 毫秒以内。
- 登记表有上限：最多 10 000 个值，满了丢最久没被读到的；重复登记同一个值不占位置，但会把它排到最新（常用的 key 每次读出都会登记一次，所以不会被挤掉）。查找的耗时不随「开头相同的登记值有多少」变坏：一万个开头 8 个字符都相同的值登记在案时，脱敏一个 2000 字的字段仍在毫秒级。
- 写失败：只往 stderr 报一次，之后照常运行，不抛。

**启动失败**（D15）：`index.ts` 末尾 `startSingleInstance(...).catch` 只调 `reportStartupFailure`：先记 `app.startup-failed`（日志还没开就先 `openFallback`），再等 ready，再弹框，再 `exit(1)`。提示框的标题与正文走 i18n，正文写 Tenon 没能启动与日志文件夹的完整路径（主目录写成 `~`）；日志写不进去时写「日志也没能写下」和错误名。

**打开日志文件夹**（D15）：「帮助」菜单加一项，文案 zh-CN「打开日志文件夹」、en「Open Logs Folder」，点它调 `openLogsFolder`；`openPath` 回非空串时弹框写出路径。菜单模板在开发构建与打包构建下都带这一项：打包构建的「帮助」只有这一项，开发构建照旧带「了解更多」。

**崩溃转储**：不调用 `crashReporter.start`，不设 `crashDumps`（D5、E3）。Linux 上 Electron 不启动崩溃收集也会建一个只放 `client_id` 的 `Crashpad` 文件夹，那不是转储；判断看有没有 `.dmp`（P1）。验收 15 的正对照用测试自己的入口脚本：先 `crashReporter.start`，再加载主进程的 bundle；不在 `apps/desktop/src/main` 里留接缝。

## 对 03 的增补

- 03 §接口 的 `McpPoolOptions` 只增一个可选成员 `onSecret: (value: string) => void`。连接池每往某台 server 的脱敏表里加一个值（`readSecrets` 读到的 `env_keys` 与静态头的值、`oauth.ts` 经 `addSecret` 交来的令牌与 client secret），同时把它交给 `onSecret`；不传时行为不变。desktop 接到 `appLog.remember`（D19）。
- 03 §本地 server：进程与环境 里「进程树、stderr 与日志」那一小节的 MCP 日志文件（`mcp-<serverId>.log` 与它轮转出的两份）以 0600 新建；启动时已有的这些文件照规矩第 8 条改成 0600。数量上限、脱敏与写入方式照 03 不变（D18）。

## 已知限制与代价

- 主进程被 SIGKILL、内存耗尽被杀、断电或原生崩溃时，记录的代码不会跑，只能靠下次启动的「上次没有正常退出」（E4）。
- `child-process-gone` 管不到 Node 起的子进程：Bash 命令的退出在工具结果里，MCP server 的崩溃在它自己的日志里（E4）。
- 不留转储：底层原生崩溃没有现场。系统自己的崩溃记录不归 Tenon 管：macOS 在 `~/Library/Logs/DiagnosticReports` 写 `.ips`，只有回溯；Linux 上 `core_pattern` 交给 systemd-coredump 或 apport 时，系统写一份含整段内存的 core（`/var/lib/systemd/coredump`），apport 另在 `/var/crash` 写一份报告（E9；P1 在开发构建与安装版上都见到了）。
- 日志开之前、日志文件夹建不出来或检查不过时的失败，只有提示框和 stderr。Linux 上 ready 之前的失败，提示框要等到 ready 才弹（E7）。
- 自由文字字段可能带回内容片段，三层脱敏挡不住：provider 的 detail（厂商回显，截到 500 字）、界面报错的第一行（300 字）、各模块记下的 `error.message`，其中 kernel `loop/batch.ts` 的 `withinWriteWait`（停下之后工具又抛的错，MCP server 的报错文字）与 `loop/recovery.ts` 记下的 Tape 解析错误（V8 的报错带一段原文）是已知两处（E8）。机密照样被换掉，对话片段换不掉。
- 脱敏只认登记值与通用格式：从没被读到的机密、格式少见的令牌会漏；`envs` 里的普通配置值也会被换成 `[redacted]`。主目录写成 `~` 只藏住用户名，项目名和文件名照记。
- 文件保护只到这一步：打开时检查挡得住已有的链接、硬链接、别人的文件和被事先占住的临时文件名；挡不住检查与打开之间同一用户换掉目录。MCP 日志的写入照 03 不做链接检查，只在启动改权限时检查。前提是能写 profile 目录，沙箱生效时 profile 目录在拒写名单里（E9）。
- 登记表满 10 000 个之后，最久没被读到的值不再被换掉：正常使用到不了这个数，一个每次都换令牌的远程 MCP 授权服务器可以把它灌满，这时靠通用格式那一层兜底。
- `ipc.failed` 的 `message` 可能带出存储里一小段原文（解析失败时的报错文字）；`kernel`、`host` 两个来源的行有一部分能被模型输出或 MCP server 触发，刷满它们各自的每分钟 60 行后，同一来源的其他行这一分钟会丢。自定厂商的模型 id 这类外来文字原样进文本字段，能在字段里拼出看起来像 `key=value` 的片段，但出不了字段。
- 没登记的写法：Basic 认证里错位的 base64、表单编码、十六进制写法的机密不换。
- 沙箱不可用时（Ubuntu 默认的 AppArmor 设置下就是这样），你放行过的命令读得到日志；kernel 的文件工具不论沙箱状态都拦（E1）。
- 限量之后，刷屏那一分钟里的大部分行会丢。有人按上限持续刷屏时，本次启动前面的、不在「抄过去」名单里的行会被轮转掉。第二次复审按截短来源文件名之前的写法算过（另记）：界面与 Linux 沙箱观测器一起刷，11–19 分钟；再加一条把输入原样写进错误说明的路由，约 7 分钟；外部输入若能触发主进程没接住的错（每窗 600 行），2–8 分钟。
- 同步写会占主进程一点时间。
- 这一份只在开发构建与 e2e 里验证。安装包那份只再查两件：生命周期行在安装版里写得出，安装版日志里没有未替换的主目录与资源目录（含 asar 里的路径）。打包版的启动失败弹框与登记值的替换，代码与开发构建相同，不在安装包里另测。

## 文档同步

- `SECURITY.md` 加日志一段：在哪、记什么不记什么、不留转储、自由文字可能带回的内容、连接器日志不脱敏。
- `docs/architecture/overview.md`：若列 desktop 主进程的模块，加日志模块一行；§信任边界 的「密钥」一条加一句日志放在哪、受什么保护。
- `docs/ux/components.md` 的「应用菜单」：打包版的「帮助」现在有「打开日志文件夹」；在它的「## 修订」记一行。
- 03 页头的 `Changed by` 起草时已加；入口页 `docs/README.md` 随页头改动重新生成。

## 验收标准

1. Tenon 自己的代码原来打到控制台的每一种提示、警告和错误都写进日志文件，带时间、级别、事件和版本；开发时终端里照样看得到，安装版不镜像到 stderr（`<profileDir>/logs/main.jsonl`；「每一处」由 lint 守，集成用例只测逐项写成字面量的几个代表来源）。
2. 一行只放一条：值里的换行和控制字符被转义；一行不超过 16 KiB，超长的字段截断并写明截了多少，整行仍超长时继续截最长的字段；上次写到一半的行，下次启动先补上换行；开日志之前缓存的行按原顺序写进去（缓存最多 1000 行，超出的丢后来的），溢出的记一行丢了几条。
3. 机密不进日志文件。哨兵从每个登记点的真实路径进来：内存钥匙串里事先就有、包上之后只经 `get` 读出的（模拟上次存的、这次重启后再读）；经 `provider.configure` 写入的；开发期环境变量；从分片拼出的 OAuth 令牌；整段 JSON 里的 client secret；MCP 的 `env_keys`，以及经 `mcp.save` 加进来的 `envs`。再由「写入口」表里的每一处写出，并把哨兵的 base64、URL 编码、JSON 转义写法（由独立脚本先算好写进测试）也注入进去；另有跨在 300、500、2000 字截断点上的哨兵，一个是另一个前缀的两个哨兵（短的那个先登记），和几种常见格式的令牌。轮转之后，`main.jsonl`、它的两份旧文件和 `running.json` 里，不只找不到完整的哨兵，也找不到它的任何片段：截断点前留下的那一段（不少于 8 个字符）、长哨兵去掉短哨兵之后剩下的尾巴。
4. 对话不经真实路径进日志：用假的模型跑一次真实的会话，其中至少有一次工具调用、一次失败后重试的请求和一次停下；消息、回复与工具参数不出现在日志文件里。只有 §已知限制与代价 列出的自由文字字段例外。
5. 主目录下的路径在日志里写成 `~/…`，应用目录写成 `<app>`；错误只记名字、码、截断后的说明和前 10 帧，`cmd`、`spawnargs`、`env` 等属性不进日志。
6. 界面向后台的请求失败记一行：通道、失败种类（`invalid-request`、`handler-failed`、`invalid-response`）和脱敏截断后的说明；正在退出、正在删除会话时被拒的请求不记。
7. 模型请求的每次失败记一行：厂商与模型、失败种类、HTTP 状态、厂商的错误码、能不能重试和脱敏截断后的详情；存一把错的 key 再发消息，日志里多出这一行，key 不在里面。
8. 渲染进程，或 GPU、工具进程等 Electron 管的子进程崩溃、被杀或异常退出时记一行：哪类进程、原因、退出码；正常退出的不记。
9. 主进程里没接住的错记一行：定时器里抛出的异常（来源 `uncaughtException`），Electron 照旧弹它自己的英文报错框、Tenon 不退出；单独的 Promise 拒绝（来源 `unhandledRejection`），照旧不弹框、不退出（终端那一行与退出码见开放问题 1）。
10. 上次没正常退出（被强杀、崩溃、启动失败）时，下次启动的日志里有一行「上次没有正常退出」，带上次的启动时间和版本；正常退出后再启动没有这一行。
11. 启动失败时：先记一行，再弹提示框（zh-CN 与 en，按系统语言），写明 Tenon 没能启动、日志在哪个文件夹（完整路径，主目录写成 `~`），再以退出码 1 退出，运行标记留着；日志写不进去时框里照实说（e2e 把 `<profileDir>/mcp` 换成同名文件来制造失败，日志照常可写；「日志也写不进去」那一支由单元测试守）。
12. 「帮助」菜单里有「打开日志文件夹」（zh-CN 与 en），菜单模板在开发构建与打包构建下都带这一项；点它把日志文件夹交给系统打开，打不开时弹框写出路径。
13. 日志有上限：加上下一行会超过 5 MiB 就先换新，留最近 2 份旧的，Tenon 自己的日志合计不超过 15 MiB；文件权限 0600、文件夹 0700；日志文件或文件夹是链接、有第二个硬链接、属主不是自己时，不往里写；临时文件名被事先放了链接时，不碰被指向的文件；上次被杀或磁盘满时留下的临时文件，不妨碍这次写日志和运行标记（平台：macOS、Linux）。
14. 界面里没接住的报错记一行：只记错误级的第一行，截到 300 字、脱敏，带来源文件名和行号；连续相同的只多一行计数，退出时也补写；警告和普通输出不记。
15. 不留崩溃转储：源码里不启动崩溃收集；先确认开着崩溃收集时（测试自己的入口脚本先启动它）同一种真崩溃能写出转储，再确认 Tenon 渲染进程或主进程真崩溃之后数据目录里没有 `.dmp`（不经 Playwright 起应用；只查 `.dmp`，Linux 上那个只放 `client_id` 的 `Crashpad` 文件夹不算）。
16. 刷屏限量：同一个来源一个窗口内超过上限时，多出的丢掉，并补写一行丢了几条；不同来源互不占额度；刷到轮转之后，本次启动的启动、上次没正常退出、窗口出来了、沙箱状态与 helper 路径几行在当前文件开头还在，标着是抄过来的。
17. 生命周期行：每次启动，启动（安装版与否、平台、架构、数据目录）是这次启动的第一行（上次没正常退出时，`open` 自己写的 `app.unclean-exit` 可以排在它前面；打开日志之前缓存的行都排在它后面），窗口出来了、沙箱状态与原因、交给沙箱的 helper 路径这几行都出现、各带时间，先后不定；正常退出时，退出是最后一行，运行标记被删掉。SIGTERM 在 srt 装上信号监听之前走正常退出（e2e 用假沙箱覆盖这一支）；登记之后的那一支由 `registerSandboxSignals` 的单元测试守。
18. 连接器的日志文件只有你自己能读：新建的是 0600，启动时已有的改成 0600；已有的那个是链接、有第二个硬链接或不是自己的文件时，改权限这一步跳过，不改被指向的文件（之后的写入照 03，见已知限制）（平台：macOS、Linux）。
19. 走查时：你点「打开日志文件夹」，访达或文件管理器打开了它；lead 演示让窗口崩溃、在后台抛一个没接住的错、在活动监视器里强制退出、把一个子文件夹换成同名文件让启动失败、在开发者工具里刷几千条报错再关掉 Tenon，你看到的和验收 8–11、16 写的一样；真弹框会不会卡住窗口也由人看（人工）。

## 开放问题

1. （已定，2026-11-28）加了 `unhandledRejection` 监听之后：退出码不变（有、没有监听都是 0），只是终端里那两行 `UnhandledPromiseRejectionWarning` 没了。照现稿，验收 9 不改（探针结果在 log.md）。

## 修订记录

从 ready 起每次改动记一行：日期 · 哪一节 · 为什么 · 相关的提交号或 PR 号。

- 2026-11-28 · 给你看的一页「要你定的」 · 澄清：补上 60 行上限的两处例外（600 行、九种不限量），原先只写在决策记录里 · PR #98
- 2026-11-28 · 验收 17 · 澄清：「启动是第一行」指这次启动的第一行，`app.unclean-exit` 可以在它前面 · PR #98
- 2026-11-28 · §脱敏、§记什么「界面报错」、§日志怎么写、§接口、验收 3 · 澄清（测试作者指出说不清的地方）：`mcp.add` 更正为 `mcp.save`；`repeats` 第一条是 1、补写行是总次数；来源取路径最后一段；截断标记不算在上限里；`open` 的 `dir` 是日志文件夹本身、不存在就建；开日志前的缓存最多 1000 行、超出的丢后来的；运行标记的临时文件名是 `running.json.tmp` · PR #98
- 2026-11-28 · §日志怎么写、§接口、§已知限制与代价 · 段一评审指出的收紧与澄清：脱敏与截断按字段做、结尾残段也换；多转义几种换行字符；放不下的行改写成 `log.dropped`；轮转失败不回写已满的文件；镜像排在限量之前；抄写每种只抄最近一条；登记表上限 10 000；`ErrorSummary` 不读 cause 链；已知限制补三条 · PR #101
- 2026-11-28 · §一直要成立的规矩 第 4 条、§日志怎么写 · 澄清（补测试时指出的）：第 4 条与「按字段脱敏」对齐；结尾残段的形状、轮转重试从哪一刻算、放不下的行当场改写、重复登记不改先后 · PR #101
- 2026-11-28 · §日志怎么写、§已知限制与代价 · owner 点名定的四项新增规则（段一复审指出前两行修订里有四项是新增机制、不是澄清，补问 owner；decisions.md D21–D24）：登记表上限 1 万、丢最久没用的（原先写的「丢最早登记的」改掉）；轮转失败丢行计数、一分钟后重试；结尾残段换掉；抄写每种只抄最近一条 · PR #101
- 2026-11-28 · §脱敏 第 3 层 · 澄清：通用格式各带最短长度（如 `sk-` 后至少 20 个字符），太短的不当令牌换 · PR #101
- 2026-11-28 · 开放问题 1 · 已定：探针（PR #101 的 CI，run 46126942154）实测加监听前后退出码都是 0，只是 `UnhandledPromiseRejectionWarning` 那两行没了，照现稿，验收 9 不改 · PR #101
- 2026-11-28 · §一直要成立的规矩 第 1 条 · 澄清：守这一条的是 lint 加静态扫描测试，禁的范围加上 `process.stdout` · PR #101
- 2026-11-28 · §日志怎么写「轮转失败」、§脱敏 第 3 层 · c851c89 加的几句补记（第三轮复审指出没进修订记录）：丢掉的行一条算一条、抄写行不算丢；改名成功但新文件打不开也按轮转失败处理、等一分钟（这一句改了行为，属 D22 的范围）；退出时再试一次轮转；通用格式带最短长度 · PR #101
- 2026-11-28 · 给你看的一页「要你定的」 · 卡数从 12 改成 16 · PR #101
- 2026-11-28 · §日志怎么写 · 收紧（第三轮复审的 major：脱敏之前字段没有长度上限，长登记值加长文字能让主进程卡几秒）：字段先截到 16 384 字再脱敏，超过 16 384 字的值不登记；开放问题 1 的正文改成已定 · PR #101
