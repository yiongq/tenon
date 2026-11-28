# 错误日志 · 先核实

这里放这份 spec 依赖的事实（E）和批 ready 之前要跑的探针（P）。调研分四路，每路一份调研、一份对抗核实，原文在仓库外的私有笔记 `../tenon-notes/2026-11-28-packaging-and-logs/research/`（另记；这一份主要用第 03、04 路）；核实文件的更正优先于调研原文。2026-11-28 的两份挑刺评审（`../tenon-notes/2026-11-28-packaging-and-logs/reviews/`，另记）读源码、跑小程序得出的事实记在 E7–E9。这里只留结论和一手来源；探针已全部跑完（四轮 CI，记录在 `../tenon-notes/2026-11-28-packaging-and-logs/research/05-probe-results.md`，另记）；被推翻或「未核实」的说法不写成事实，要依赖的写成探针。

## 事实

### E1 · 仓库里日志的现状
- 结论：主进程约 100 处日志点（真正直接写 console 的约 9 条，其余是 `log: (line) => console.*(line)` 转发器和 `log ?? console.warn` 回落），kernel 与 contracts 0 处。唯一落盘的是 MCP 的 stderr（`apps/desktop/src/main/mcp/log-sink.ts` 的 `createMcpLogSink`，写 `<profileDir>/logs/mcp-<id>.log`，1 MB 轮转、留 3 份）。`<profileDir>/logs/` 已由 `openProfile` 建好，沙箱生效时在读写拒绝名单里，kernel 的文件工具也拦。
- 结论（续）：`packages/contracts/src/route.ts` 的 `registerRoute` 把异常和校验失败转成 `ok: false` 还给界面，主进程不记；provider 错误的 `detail` 只进 Tape 的尝试事实，不进日志（`provider/types.ts` 和两条 wire 的注释说它「进日志」，不实）。
- 结论（续）：全仓没有 `uncaughtException`、`child-process-gone`、`crashReporter`、`showErrorBox`、`shell.openPath`。渲染进程的报错只去开发者工具，安装版菜单里没有开发者工具。启动失败只有一行 `console.error` 加 `app.exit(1)`，安装版里用户什么都看不到。
- 结论（续）：现有三个脱敏函数（kernel `provider/errors.ts` 的 `redactCredentials`、kernel `mcp/env.ts` 的 `redactLine`、desktop `evals/raw.ts` 的 `redactEvidence`）都只是已知值精确替换，前两个不从 kernel 根导出。
- 一手来源：仓库上述文件，及 `apps/desktop/src/main/index.ts`、`apps/desktop/src/main/host/sandbox-config.ts`（`buildFilesystem`）、`packages/kernel/src/loop/run.ts`（`attemptError`）。
- 核查：确认；「约 100 处」按核实文件另算约 108（核实文件 04 的 C2 与重点项 1–4）。
- 什么时候重核：开工前（代码会变）。

### E2 · 改动会碰到的测试与可借的先例
- 结论：`apps/desktop/test/menu-template.test.ts` 与 `menu.test.ts` 断言打包构建的菜单里没有「帮助」；往别的菜单加一个只有文字、没有 role 的点击项不会破它们，只有「帮助」会。`apps/desktop/test/profile.test.ts` 有一条用例钉住 `readConfig` 不传 log 时走 `console.warn`（改它要写一行「测试改动」）。
- 结论（续）：「查看日志」已有先例：contracts 的 `mcp.readLog`、`mcp/log-sink.ts` 的 `read`、`ConnectorDetail.tsx` 的按钮。desktop 的路由已是三层 `IpcMainLike` 包装（`refuseWhileRemoving`、`refuseWhileShuttingDown`、`e2eRouteSeam`），拒绝类包装也回 `ok: false`、码为 `handler-failed`，所以记调用失败的那一层要包在最外面、只看 `registerRoute` 的答复。
- 一手来源：仓库上述文件，及 `apps/desktop/src/main/shutdown.ts`（`refuseWhileShuttingDown`）。
- 核查：确认（核实文件 04 的重点项 5 与第五节第 1–3 条）。
- 什么时候重核：开工前。

### E3 · 崩溃转储里有什么、Electron 怎么管
- 结论：Crashpad 的设计文档说转储可能抓到崩溃进程内存里的任意内容（含用户 ID、密码），并把命令行、环境列为一般会带的进程状态。Electron 的 crashReporter 在 `uploadToServer: false` 时照样在本机写转储，启动后关不掉，没有删除或清理的 API，也不给文件路径；默认目录是 userData 下的 `Crashpad`。不调用 `crashReporter.start` 时磁盘上会不会仍有转储，没查实（P1）。
- 一手来源：https://github.com/chromium/crashpad/blob/main/doc/overview_design.md ；https://github.com/electron/electron/blob/v44.4.1/docs/api/crash-reporter.md ；electron v44.4.1 的 `shell/common/electron_paths.cc`
- 核查：确认（核实文件 03 的 C5–C10、C17、C21；C16 更正为 `getUploadedReports` 也列出本地未上传的报告）。
- 什么时候重核：升 Electron 大版本时；P1 跑完时。

### E4 · Electron 的进程事件与主进程异常的默认处理
- 结论：`app` 的 `render-process-gone` 给 `(event, webContents, details)`，`details` 有 `reason`、`exitCode`；`child-process-gone` 给 `(event, details)`，有 `type`、`reason`、`exitCode`、`serviceName`、`name`，不含渲染进程，也管不到 Node `child_process` 起的子进程。Electron 主进程自己占一个 `uncaughtException` 监听：没有别的监听时弹「A JavaScript error occurred in the main process」框、不退出；你一注册监听，这个默认处理整个跳过。Node 的 `uncaughtExceptionMonitor` 只观察、不改默认行为。主进程被 SIGKILL、OOM、断电或原生崩溃时 JS 不会跑。
- 一手来源：https://github.com/electron/electron/blob/v44.4.1/docs/api/app.md ；https://github.com/electron/electron/blob/v44.4.1/lib/browser/init.ts ；https://nodejs.org/docs/latest-v24.x/api/process.html
- 核查：确认（核实文件 03 的 C24–C32）；`uncaughtExceptionMonitor` 收不到 Electron 主进程里单独的 Promise 拒绝，`unhandledRejection` 监听收得到，已由 P2 在三个平台上实测。
- 什么时候重核：升 Electron 大版本时。

### E5 · 错误对象里会带什么
- 结论：Node 的 fs 错误，`message` 本身就带完整路径（用户名、项目名在里面）；`JSON.stringify` 只出可枚举的自有属性；`util.inspect` 会递归打出 `cause` 链。Anthropic、OpenAI SDK 的 `APIError` 带响应头、响应体和 requestID，不带请求头；OpenAI 在没有 message 时把整个响应体序列化进 message。所以不整对象序列化，只取名字、码和过滤后的说明。通用的密钥规则集里没有智谱、DeepSeek 等国内厂商的规则，这些 key 只能靠登记值去掉。
- 一手来源：https://nodejs.org/docs/latest-v24.x/api/errors.html ；https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/core/error.ts ；https://github.com/openai/openai-node/blob/master/src/core/error.ts ；https://github.com/gitleaks/gitleaks （`config/gitleaks.toml`）
- 核查：确认（核实文件 03 的 C65–C71、C76，含本机复现）。
- 什么时候重核：升这两个 SDK 的大版本时。

### E6 · 日志库与同类做法
- 结论：electron-log 5.4.4 给所有会话注册 preload、暴露 `window.__electronLog`，主进程用 `ipcMain.on` 与 `ipcMain.handle` 收消息、不查发送方，与「IPC 只走 contracts」冲突；文件默认 1 MiB、只留一份 `.old`、权限 0666。DeepChat（Apache-2.0）从 electron-log 换成自写的类型化 JSONL：10 MiB 软上限、单条 16 KiB、持久 fd 加 O_APPEND 同步写、目录 0700 文件 0600、启动时修半行，并有测试扫源码不许再引 electron-log。pino 打包时离不开额外文件。
- 结论（续）：Linux 的 write(2) 写明追加模式下「移到末尾再写」是一步完成；成功返回不保证落盘，进程崩溃时已写的不丢是据此推的。VS Code、Mattermost 的「打开日志文件夹」在帮助或开发者菜单类里。
- 一手来源：https://registry.npmjs.org/electron-log （5.4.4 包里的 `src/renderer/electron-log-preload.js`、`src/main/index.js`、`src/node/transports/file/index.js`）；https://github.com/ThinkInAIXYZ/deepchat （`docs/architecture/main-process-structured-logging/spec.md`、`src/main/logging/mainJsonlPersistence.ts`）；https://man7.org/linux/man-pages/man2/write.2.html ；https://github.com/microsoft/vscode （`logsActions.ts`）
- 核查：确认（核实文件 03 的 C36–C57、C81、C84；C57「进程崩溃不丢」是推断）。
- 什么时候重核：有人提议换成现成日志库时。

### E7 · 测试工具与 Electron 的几处细节
- 结论：Playwright 1.63.0 起 Electron 时，它的 loader 把一组 Chromium 开关加到命令行上，其中有 `--disable-breakpad`，所以经 Playwright 起的应用「没有转储」证明不了什么；`forcefullyCrashRenderer()` 让 `render-process-gone` 的原因是 killed 或 crashed；P1 的正对照里，开着崩溃收集时它也写出了转储。
- 结论（续）：Electron 44.4.1 的 `dialog.showErrorBox` 是模态框；Linux 上在 ready 之前调用，只往 stderr 打一行、不弹框。SIGTERM 有三种情形：srt 装上它自己的 SIGINT、SIGTERM 监听之前，Electron 把 SIGTERM 当成原生的退出处理（和 Cmd+Q 一样走 before-quit）；srt 装上之后，它的监听移除了 Node 的默认退出、回调只是复位，在 `apps/desktop/src/main/shutdown.ts` 的 `registerSandboxSignals` 登记之前收到 SIGTERM，进程不退出；登记之后才又走正常退出。e2e 默认用假沙箱，srt 从不装监听，所以 e2e 里的 SIGTERM 走的是第一种。`apps/desktop/src/main/index.ts` 在模块顶层就用 electron，末尾那个 `.catch` 单元测试碰不到；`chat.ts`、`host/profile.ts` 等模块刻意不 import electron，Vitest 里 import `electron` 拿到的是可执行文件的路径。
- 一手来源：04 §退出（引 04 的 P8 实测）；`apps/desktop/e2e/stop-exit.spec.ts` 头注释；playwright-core 1.63.0 的 `lib/server/electron/loader.js`（`chromiumSwitches`）；npm 包 electron@44.4.1 的 `electron.d.ts`（`Dialog.showErrorBox`、`App.getVersion`）；仓库 `apps/desktop/src/main/shutdown.ts`、`apps/desktop/e2e/helpers/launch.ts`（`launchTenon`、`applicationMenuLabels` 的注释）、`apps/desktop/e2e/single-instance.spec.ts`。
- 核查：测试视角挑刺评审读源码确认；SIGTERM 一句由复审对照 04 更正（2026-11-28，另记）。未经单独的对抗核实。
- 什么时候重核：升 Playwright 或 Electron 时；改 `registerSandboxSignals` 时。

### E8 · 机密从哪来、会从哪漏
- 结论：MCP 的 OAuth 令牌存进钥匙串时，是 `JSON.stringify(tokens)` 转成 base64url、切成最多 4 片，每片一个条目（kernel `mcp/token-store.ts` 的 `createMcpTokenStore`）；client secret 在整段 JSON 里。kernel 在 `mcp/oauth.ts` 里对裸令牌与 client secret 调 `addSecret`，连接池（`mcp/pool.ts`）把它们收进每台 server 的脱敏表，所以 MCP 自己的日志换得掉，desktop 包住 `host.secrets` 只看得到片与 JSON。开发构建里 key 常来自环境变量（`apps/desktop/src/main/provider.ts` 的 `DEV_ENV_FALLBACK`，解析结果带 `source: 'env'`），不经 `host.secrets`。
- 结论（续）：MCP 日志（`mcp/log-sink.ts` 的 `createMcpLogSink`）用 `appendFile` 的默认权限，一般是 0644；03 §进程树、stderr 与日志 写明 `envs` 的值不换。Linux 沙箱观测器对不上命令的违规，`host/sandbox.ts` 的 `DesktopSandbox.take` 每条都记一行、不设上限，而 srt 0.0.79 `dist/sandbox/linux-violation-monitor.js` 的注释写明那些路径由沙箱里的程序控制。kernel `loop/batch.ts` 的 `withinWriteWait` 会记工具后来抛出的 `error.message`；`apps/desktop/src/main/tape/sqlite-store.ts` 的 `parseStoredJson` 把 V8 的 `JSON.parse` 报错原文接进错误，再由 `loop/recovery.ts` 记下，V8 的报错带一段原文。截断在脱敏之前时，跨在截断处的机密会留下半截。
- 一手来源：仓库上述文件；https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-0.0.79.tgz （`dist/sandbox/linux-violation-monitor.js`）；评审小程序 `oauth-registry-miss.mjs`、`truncate-then-redact.mjs`、`flood-rotation.mjs`（另记）。
- 核查：安全视角挑刺评审读码并跑小程序确认（2026-11-28，另记）。
- 什么时候重核：改 token-store、连接池的脱敏表或沙箱观测器时。

### E9 · 文件保护与系统行为
- 结论：`O_NOFOLLOW` 只拦最后一级的符号链接，拦不住硬链接，也管不到上一级目录本身是链接；`open` 的权限参数只在新建时生效，已有文件的权限不变；用普通写文件的办法写运行标记会顺着链接把目标截空。Linux 上 `core_pattern` 交给管道程序（systemd-coredump、apport）时，系统会存一份含整段内存的 core，不受 `RLIMIT_CORE` 限制；macOS 的诊断报告只有回溯。Electron 44.4.1 在 Linux 上的 `shell.openPath` 经 `xdg-open` 起一个子进程，不经 Tenon 的沙箱，参数固定。
- 一手来源：https://man7.org/linux/man-pages/man2/open.2.html ；https://man7.org/linux/man-pages/man5/core.5.html ；electron v44.4.1 的 `shell/common/platform_util_linux.cc`（`OpenPath`、`XDGOpen`）；评审小程序 `link-redirect.mjs`（另记）。
- 核查：安全视角挑刺评审读源码并跑小程序确认（2026-11-28，另记）。
- 什么时候重核：改日志文件的打开方式时；升 Electron 时。

## 探针

都在 CI 的草稿 PR 里跑，用开发构建，不在 owner 的 Mac 上起 Electron（owner 已同意开草稿 PR，D14）。草稿 PR 只放探针用的 workflow 与脚本，不合并。三个探针都不依赖安装包，起应用都照 `apps/desktop/e2e/single-instance.spec.ts` 直接 spawn，不经 Playwright（E7）。

### P1 · 不启动崩溃收集，磁盘上还有没有转储
- 做什么：macOS 与 Linux 的 runner 上各做两轮，数据目录都用临时目录。正对照：探针脚本里先 `crashReporter.start({ uploadToServer: false })`，主进程 `process.crash()`、渲染进程 `kill -SEGV <它的 pid>`，确认数据目录下写出了 `.dmp`。正式一轮：不启动崩溃收集，同样两种真崩溃，再列数据目录下的所有文件。另记下 Linux 的 `/proc/sys/kernel/core_pattern`，看 `/var/lib/systemd/coredump`、`/var/crash`；macOS 看 `~/Library/Logs/DiagnosticReports`。
- 结果是 X 就改什么：正对照写不出转储，换崩溃方式重来，结论不算数；正式一轮数据目录下没有 `.dmp`，照现稿；有，在 §日志怎么写 加一条「每次启动删数据目录下的 `.dmp`」（落实 D5，不是放宽），改验收 15。系统自己的崩溃记录照实写进已知限制。
- 实际结果：结论成立，照现稿。2026-11-28 第三轮（run 46087221328）有了正对照：开着崩溃收集时，外部 `kill -SEGV`（渲染进程、主进程）与应用内真故障（`forcefullyCrashRenderer`、`process.crash()`）四种方式，在 macOS、Ubuntu 24.04、26.04 上都在数据目录 `Crashpad/completed/` 下写出了 `.dmp`；不开收集，同样四种方式，三个平台都没有任何 `.dmp`。macOS 没有 `Crashpad` 目录，Linux 有一个只放 `client_id` 的 `Crashpad` 目录。第一、二轮（run 46082661569、46084382965）只有不开收集的一组，结果相同；第四轮（run 46089532804）重跑没有回归。
- 实际结果（续）：渲染进程那一支的崩溃方式有效：`forcefullyCrashRenderer` 与外部 `SIGSEGV` 在开着收集时都写出了转储，所以第二次复审担心的「杀进程写不出转储」在这三个平台上不成立；macOS 上外部 `SIGSEGV` 也写得出，不必换方式。系统自己另写了记录：macOS `~/Library/Logs/DiagnosticReports` 下渲染进程与主进程各一份 `.ips`，Linux `/var/lib/systemd/coredump/core.electron.*.zst`；安装版上 Ubuntu 还有 apport 的 `/var/crash/*.crash`。渲染进程被杀后主进程还活着，主进程被杀就死。
- 效力说明：正对照用的是探针分支里的接缝（环境变量打开收集、让应用自己制造故障），这种接缝不进主进程源码；验收 15 的正对照改由测试自己的入口脚本先启动收集。改了 spec：系统的三种崩溃记录写进已知限制，开放问题里的这一条关掉。

### P2 · Electron 主进程里未处理的 Promise 拒绝
- 做什么：用开发用的 Electron 跑一个小脚本：注册 `uncaughtExceptionMonitor`、把 `dialog.showErrorBox` 换成记录调用，先让一个 Promise 拒绝、再在定时器里抛错，记下 monitor 收到的 origin 与弹框有没有被调。
- 结果是 X 就改什么：拒绝也到了 monitor（origin 为 `unhandledRejection`），照现稿；没到，另加一个只记一行的 `unhandledRejection` 监听（拒绝今天本来就不弹框，加了不改行为），改 §日志怎么写 与验收 9。
- 实际结果：2026-11-28 第一、二轮（run 46082661569、46084382965），第四轮重跑没有回归；macOS、Ubuntu 24.04、26.04 完全一致。① 单独的 Promise 拒绝：`uncaughtExceptionMonitor` 收不到，不弹框、不退出，只在 stderr 打 `UnhandledPromiseRejectionWarning`。② 定时器里抛错：monitor 收到，origin 为 `uncaughtException`；默认处理调了 `dialog.showErrorBox`（标题「A JavaScript error occurred in the main process」），不退出。③ 拒绝加 `uncaughtException` 监听：监听没被叫，什么都没发生。④ 抛错加 `uncaughtException` 监听：monitor 与监听都收到，`showErrorBox` 不再被调。⑤ 拒绝加 `unhandledRejection` 监听：监听收到。
- 实际结果（续）：走「没到」那一支：spec 加一个只记一行的 `unhandledRejection` 监听，异常仍只用 monitor（不注册 `uncaughtException`，免得弹框消失），验收 9 分成两种。
- 效力说明：探针把 `dialog.showErrorBox` 换成了记录函数，能证明默认处理会调它、不退出，没看到真弹框是否阻塞主进程（留给走查由人看）；⑤ 没有记 stderr 与退出码，加了监听之后这两样会不会变没测（spec 开放问题 1）；脚本是独立的 `.cjs`，不是 Tenon 自己的 ESM bundle。

### P3 · 界面报错走不走控制台消息、正常退出时有没有子进程事件
- 做什么：开发构建里，在界面上分别制造：一个没接住的异常、一个未处理的 Promise 拒绝、一个 React 渲染时抛出的错；记下每种在 `console-message` 里出不出现、级别是什么、第一行是什么。另在 macOS 与 Linux（xvfb）上正常退出一次，记下有没有 `child-process-gone`、`type` 与 `reason` 是什么；启动时 GPU 进程会不会先退一次。
- 结果是 X 就改什么：三种都以 error 级出现，照现稿；哪种不出现，在已知限制里写明它不进日志（不为此加新通道，那是 D8 的 C）。正常退出时有子进程事件，把那几种 `reason` 加进「不记」，改验收 8。
- 实际结果：照现稿，验收不改。2026-11-28 第四轮（run 46089532804），macOS、Ubuntu 24.04、26.04 完全一致：① 没接住的异常在 `console-message` 里出现 1 次、error 级，第一行 `Uncaught Error: …`；② 未处理的 Promise 拒绝出现 1 次、error 级，`Uncaught (in promise) Error: …`；③ React 渲染时抛的错出现 1 次、error 级，`Uncaught Error: …`；三条各只有一行，来源是 `out/renderer/index.html` 的第 1 行；加载阶段没有 console-message。启动时 GPU 进程没有先退；正常退出时没有 `child-process-gone`，也没有 `render-process-gone`。两支都走「照现稿」：不用往「不记」里加 `reason`。
- 效力说明：渲染时抛的错是在一个独立的 React 根里挂一个必抛的组件，不是应用自己组件树里的错；渲染层是生产构建，没有开发版才有的组件栈；「开发构建」指未打包、跑 `out/`，不是 vite 开发服务器。结论只到「这三类错走 console-message、error 级」。
