# error-logs · plan

## 当前 / 需要你

当前：ready，段一第 2.6 步做完（`feat/error-logs-seg1`，PR #101）：三轮评审加一次收尾核对与复验，结论通过，记录在 log.md「评审 · 2026-11-28 · 审过 916d8b9」；owner 当天补定 D21–D26。下一步第 2.7 步：带 owner 走查段一（要在 owner 的 Mac 上起开发版，先问）。
需要你：① 段一走查（2.7）：说一声可以在你的 Mac 上起开发版；② 走查过后点名合并 PR #101（它改了 `.oxlintrc.json` 与 `scripts/lint-gate.test.mjs`，是 lint 规则变严，不开自动合并）。

## 分段

| 段 | 状态 | 这一段做完你能看到什么 | 守哪些验收 | 等 owner 做什么 |
|---|---|---|---|---|
| 一 · 报错写进日志 | 未开工 | 开发版里的报错、请求失败、模型请求失败、界面报错都进日志文件夹；里面没有 key；刷屏有上限；启动与退出都留一行；连接器日志只有你能读 | 1–7、13、14、16、17、18 | 批 ready；段末走查 |
| 二 · 崩溃、启动失败与菜单入口 | 未开工，排在段一之后 | 进程崩了、主进程出错、被强杀之后都留下一行；启动失败有提示框；帮助菜单能打开日志文件夹；没有转储文件 | 8–12、15、19；验收 17 里 SIGTERM 那一支的 e2e 也在这一段补（3.2） | 段末走查（几种场景由 lead 演示） |

## 步骤

- [x] 1. 改 ready 之前
  - [x] 1.1 lead 把四个文件与 log.md 放进仓库的那个 PR 里（03 页头的 `Changed by` 起草时已补上 error-logs 的两节）；提交之后在 log.md 那条挑刺评审记录下补一行被审内容所在的提交号；跑 `python3 .sdd/spec-check.py` 与 `python3 .sdd/spec-check.py --index`。这一份不进总参考阶段表（决策卡「agent 自定」）。
  - [x] 1.2 复审：新上下文核对两份评审每条发现的处置（2026-11-28，结论在 log.md）；按复审改完。
  - [x] 1.2.1 第三轮复查（第二次复审，2026-11-28）：结论与处置记在 log.md；按细则 8 不再起第四轮。
  - [x] 1.3 owner 定 D19（A）与 D20（A），2026-11-28。
  - [x] 1.4 探针 P1–P3：四轮 CI 跑完（2026-11-28），结论写进 evidence.md，照分支改了 spec；原始输出在私有笔记。
  - [x] 1.5 再跑 spec-check；请 owner 读一页、批 ready。
- [ ] 2. 段一 · 报错写进日志（守验收 1–7、13、14、16、17、18）
  - [x] 2.0 实现之前先验 spec 开放问题 1：开发构建里各跑一次有、没有 `unhandledRejection` 监听，记下 stderr 与退出码；按开放问题里写好的分支改 spec（属收紧时直接改并记修订，要改行为就先问 owner）。
  - [x] 2.1 测试的前置：e2e 里读日志的 helper（照 `apps/desktop/e2e/helpers/launch.ts` 里 `configPathIn` 的样子写 `logsDirIn(userData)`）；编码变体由独立脚本先算好，抄进测试当字面量。
  - [x] 2.2 测试作者（新子 agent，只读 spec、evidence 与本 plan，不看实现）按本段的验收写测试：哨兵经真实路径进来（用 `MemorySecrets`、`TENON_SECRETS=memory`，不碰钥匙串），一张 `satisfies Record<LogEvent['event'], …>` 的哨兵表，跨截断点的哨兵，OAuth 分片的哨兵，静态扫描（只有 `log/` 与 `mcp/log-sink.ts` 写 `logs/`；只有 `host/index.ts` new 钥匙串）。验收 3 那张表要有「事先就在内存钥匙串里、只经 `get` 读出」的哨兵、跨 300、500、2000 字截断点的哨兵、互为前缀的两个哨兵，三种写法要注入进去而不只是检查它们找不到。跑一遍确认是红的，单独提交一次只改测试的提交，在 log.md 记一行「测试作者提交：<提交号>」。
  - [x] 2.3 实现者（另一个子 agent）：`log/redact.ts`、`log/app-log.ts`（格式、限量与来源表、轮转与抄写、文件保护、半行修补、内存缓存、运行标记）、`log/watch.ts` 的请求失败与界面报错；`host/sandbox.ts` 的「对不上命令的违规」接到 `sandbox-unattributed`。不削弱 2.2 的测试；非改不可时在 log.md 写「测试改动：文件 · 用例 · 为什么」。
  - [x] 2.4 接线：`index.ts` 的转发器、各模块 `log ?? console.warn` 的回落、`readConfig` 的缺省 log 改成写日志，级别照 `LogLevel` 的含义；`main()` 一开始 `open`，之后注册 `will-quit`；`host/index.ts` 的 `HostSecrets` 包上 `rememberingSecrets`；`provider.ts` 的环境变量回落处登记；`.oxlintrc.json` 给 `apps/desktop/src/main/**` 禁 `console` 与 `process.stderr`，只放过 `log/`。`apps/desktop/test/profile.test.ts` 那条走 `console.warn` 的用例按需改，改了在 log.md 写「测试改动」一行（E2）。
  - [x] 2.5 kernel：`loop/run.ts` 在尝试失败处加一行 `ctx.log`；`mcp/pool.ts` 加 `onSecret`（§对 03 的增补，D19）；desktop 的 `mcp/log-sink.ts` 以 0600 新建，启动时以不跟随链接的方式收紧已有文件。
  - [x] 2.6 段一收尾：`pnpm format:check && pnpm lint && pnpm typecheck`、`pnpm vitest run --maxWorkers=2`、`python3 .sdd/spec-check.py`；新上下文的独立评审分「对照 spec」「安全」「突变」三个视角，StrykerJS 只对改动过的文件跑、只出报告（本项目补充第 5 条）；带证据的问题按细则分类处置，记进 log.md。
  - [ ] 2.7 带 owner 按场景逐条走查段一（开发版，owner 要求时在他的 Mac 上起）：存错 key 再发消息、正常开关一次看生命周期行；每条明确回答对或不对，记进 log.md。
- [ ] 3. 段二 · 崩溃、启动失败与菜单入口（守验收 8–12、15、19）
  - [ ] 3.1 测试的前置：不经 Playwright 的启动方式（照 `apps/desktop/e2e/single-instance.spec.ts` 直接 spawn），验收 10、11、15 要用；Playwright 起的 Electron 自带禁用转储的开关（E7）。
  - [ ] 3.2 测试作者按本段的验收写测试：`child-process-gone` 用假的 EventEmitter，文件头写明它复现了真依赖的哪几条行为；验收 9 用 Playwright 在主进程里替换 `dialog.showErrorBox` 再抛错；验收 11 用假的 dialog、exit 断言顺序，e2e 把 `<profileDir>/mcp` 换成同名文件、直接 spawn、等 `app.startup-failed` 再 SIGKILL；验收 15 先跑正对照；验收 17 的 SIGTERM 在 e2e 里走「srt 还没装监听」那一支，登记之后的那一支由 `registerSandboxSignals` 的单元测试守。跑红、单独提交、log.md 记「测试作者提交」。
  - [ ] 3.3 实现者：`watchProcessExits`、`watchUncaught`、`reportStartupFailure`、`openLogsFolder`、菜单。文案进 `apps/desktop/src/i18n/locales/{en,zh-CN}`，过 `pnpm i18n:check` 与 `copy:check`。`menu-template.test.ts` 里开发构建那条（`help.learnMore` 一项）与打包构建那条（没有 Help）、`menu.test.ts` 的对应断言都要改，各在 log.md 写「测试改动」一行。验收 8、9、14、15 照 P1–P3 的结果写好了，不再改。
  - [ ] 3.4 文档同步：`SECURITY.md` 加日志一段；overview 的模块一行与 §信任边界 的「密钥」一句；`docs/ux/components.md` 的「应用菜单」与它的「## 修订」一行。
  - [ ] 3.5 段二收尾：同 2.6。
  - [ ] 3.6 带 owner 按场景逐条走查段二，每条明确回答对或不对，记进 log.md。lead 演示 owner 自己做不出来的那几样：用 e2e 的启动器在 owner 面前起开发版，调 `forcefullyCrashRenderer` 让窗口崩、在主进程里抛一个没接住的错；在活动监视器里对 Tenon 点「强制退出」再打开；把 `<profileDir>/mcp` 换成同名文件让启动失败（日志照常可写）；在开发者工具的控制台里一分钟打出几千条不同的报错，然后关掉 Tenon，再打开日志给 owner 看那一句丢了多少条（它在窗口过去后的下一次写入或退出时才写）。「打开日志文件夹」由 owner 自己点（验收 19）。真弹框会不会卡住窗口，也在这一步由人看（P2 的效力说明）。
- [ ] 4. 「以后再说」登记下面这些，每条一行；「渲染层没有错误边界……」那一条原样留着、不动：
  - 崩溃上传到服务器 · owner · 有外部用户之后，阶段 7 · error-logs §给你看的一页「不做」
  - 性能度量（启动打点、内存采样、CI 预算），单开一份小 spec · lead · error-logs implemented 之后 · error-logs §给你看的一页「不做」
  - MCP 日志的数量上限与脱敏（现在每台 3 份、台数不限，只换已知值） · lead · 有人要把日志文件夹整个发给别人之前 · error-logs D18
  - 页面没加载出来、界面卡死这两种白屏不进日志 · lead · 待定 · error-logs 挑刺评审（另记）
  - 把限量挪到脱敏之前，免得连续的长消息占住主进程 · lead · 段二做完之后，单开小 spec · error-logs D26
  - OAuth 令牌先登记、后存进钥匙串（要动 kernel `mcp/oauth.ts`，owner 点名） · owner · 下一次动 03 时 · error-logs 段一评审（另记）
  - `kernel` 来源的行把提示与错误分开两个级别 · lead · 下一次动 kernel 的 log 回调时 · error-logs 段一评审（另记）
  - 纯数字的登记值落在 `…(+N)` 里时截断标记被吞 · lead · 待定 · error-logs 段一复验（另记）
- [ ] 5. 对照验收逐条核对；spec 的开放问题与本 plan 的 Open 要么写明已定，要么挪进「以后再说」；数验收条数与改动行数（本项目补充第 6 条「预算检查点」）。
- [ ] 6. 清理：探针用的草稿 PR 关掉，探针 workflow 不留在仓库里。
- [ ] 7. owner 验收 → 改 Status

## 交接

2026-11-28：段一代码、评审与修复都在 `feat/error-logs-seg1`（代码停在 e737d7b，之后只有文档提交），评审记录通过。spec 的 PR #98 已合入 dev。下一步：2.7 带 owner 走查（存错 key 再发消息、正常开关一次看生命周期行；每条明确回答对或不对，记进 log.md）。段二开工的第一步先做 Open 里标「段二第一步」的三件，并删掉临时探针 `apps/desktop/e2e/probe-unhandled-rejection.spec.ts` 与 `helpers/probe-unhandled-rejection-preload.cjs`。

## Open

- 段二第一步：长于 4096 字的值重复登记时不排到最新、计数会涨（复验的突变 N2）：先写红的用例再修。
- 段二第一步：`apps/desktop/src/main/log/redact.ts` 里 `REDACT_INPUT_LIMIT` 上的注释写的最坏耗时不实，改成 D26 的实测数。
- 段二第一步：spec 全文超过 heavy 档上限几十个字符（警告），文档同步时压掉。
- 段二第一步：spec「一万个开头相同的值…仍在毫秒级」改成实测的数（最后核对的建议）。

- （已定）加了 `unhandledRejection` 监听后退出码不变、只少那两行警告，照现稿（log.md 探针一行）。
- OAuth 令牌在存进钥匙串之后才登记（kernel `mcp/oauth.ts`）：要 owner 点名多动 kernel 一处才能改；第 4 步登记进「以后再说」。

## 验收矩阵

每行一条验收，说明这条验收最低要在哪一层测、由哪个门禁拦、被哪个突变盯着。门禁是必须通过的检查，用 `.sdd/config.json` 里的通用名写，比如 test、test:e2e、lint。突变是故意改坏一处生产代码、看测试会不会变红；这一列写 log.md 里评审登记的突变编号，评审还没出时先空着，写 `—`。层从下到上是：单元、集成、e2e、live。「平台」一列照本项目补充第 4 条：e2e 在 CI 里只在 Linux 上全量跑。

| 验收号 | 层 | 测试用例名 | 门禁命令 | 突变 | 平台 |
|---|---|---|---|---|---|
| 1 | 单元 | error-logs 验收 1: representative sources reach main.jsonl with time, level, event and version | lint、test | — | 任意 |
| 2 | 单元 | error-logs 验收 2: escapes, truncation marks, a torn last line and the pre-open buffer keep one record per line | test | — | 任意 |
| 3 | 集成 | error-logs 验收 3: sentinels from every registration point, including a key stored before the wrap and only read, never reach the app log files<br>error-logs 验收 3: no sentinel, spelling or fragment survives cuts at 300, 500 or 2000 or a shorter overlapping secret registered first | test | — | 任意 |
| 4 | 集成 | error-logs 验收 4: a real session with a fake model leaves no message, reply or tool argument in the log | test | — | 任意 |
| 5 | 单元 | error-logs 验收 5: home paths read ~ and errors drop cmd, spawnargs and env | test | — | 任意 |
| 6 | 单元 | error-logs 验收 6: route failures log channel and code; shutdown and removal refusals do not | test | — | 任意 |
| 7 | 集成 | error-logs 验收 7: a failed provider attempt logs code, status and detail without the key | test | — | 任意 |
| 8 | 单元 | error-logs 验收 8: child-process-gone logs type, reason and exit code and skips clean exits<br>error-logs 验收 8: a crashed renderer adds a process.gone line | test、test:e2e | — | 任意、Linux |
| 9 | e2e | error-logs 验收 9: a thrown main error is logged and Electron still shows its dialog without quitting<br>error-logs 验收 9: a lone rejection is logged and nothing else changes | test:e2e | — | Linux |
| 10 | e2e | error-logs 验收 10: a SIGKILLed app reports the unclean exit on the next start and a clean quit does not<br>error-logs 验收 10: a failed startup leaves the marker and the next start reports it | test:e2e | — | Linux |
| 11 | 单元 | error-logs 验收 11: reportStartupFailure logs, waits for ready, shows the localized box, then exits 1<br>error-logs 验收 11: a file in place of the mcp folder fails the start and app.startup-failed is written | test、test:e2e | — | 任意、Linux |
| 12 | 单元 | error-logs 验收 12: Help has Open Logs Folder in both builds and a failed open shows the path | test | — | 任意 |
| 13 | 单元 | error-logs 验收 13: rotation keeps two archives under 15 MiB, 0600 files in a 0700 folder, refuses links, hard links and foreign owners, and a leftover temp file does not stop logging | test | — | macOS、Linux |
| 14 | e2e | error-logs 验收 14: an uncaught renderer error logs its first line, file and line, and repeats merge | test:e2e、test | — | Linux、任意 |
| 15 | 单元 | error-logs 验收 15: no source starts the crash reporter<br>error-logs 验收 15: a real crash writes a .dmp with the reporter on and none without it | test、test:e2e | — | 任意、Linux |
| 16 | 单元 | error-logs 验收 16: each source is capped per window with a dropped count, sources do not share quota, and carried lifecycle lines survive rotation | test | — | 任意 |
| 17 | e2e | error-logs 验收 17: start comes first, window, posture and helpers all appear, quit comes last and removes the marker | test:e2e、test | — | Linux、任意 |
| 18 | 单元 | error-logs 验收 18: MCP log files are created 0600, existing ones are tightened, and links, hard links or foreign files are skipped | test | — | macOS、Linux |
| 19 | 你用 | （人工） | — | — | macOS |
