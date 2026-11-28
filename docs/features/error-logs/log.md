# error-logs · log

## 挑刺评审 · 2026-11-28 · 审过 未提交的草稿（基于 fedc419）

- 被审的内容：`docs/features/error-logs/` 的 spec、decisions、evidence、plan，当时只暂存、没有提交号；放进仓库之后在下面补一行「被审内容随 <提交号> 入库」（plan 1.1）。
- 被审内容随 daae933 入库（三轮评审审的都是这一版之前的草稿，处置后的结果在这个提交里）。
- 视角：两份，各在新上下文里审。一份看能不能测、范围、和代码对不对得上、owner 读不读得懂；一份看机密与硬规矩，每条 major 带一段可跑的小程序。
- 原文：`../tenon-notes/2026-11-28-packaging-and-logs/reviews/error-logs-critique-testability.md`、`error-logs-critique-security.md`，小程序在同目录 `error-logs-security/` 下（另记）。
- 结论：blocker 0；测试视角 major 13、minor 16、建议 4；安全视角 major 7、minor 5、建议 6。两份有重叠，合并处置。
- 突变：无（审 spec）。
- 处置（都在提交之前改进四个文件，等复审核对）：
  - 「对话不进日志」与已知限制矛盾、写入口没列、哨兵测空（测试 M1、安全 M1、M6）：已修。验收拆成机密（验收 3，硬保证，哨兵经每个登记点的真实路径进来）与对话（验收 4，只保证真实路径），列出写入口表与哨兵表，自由文字字段写进已知限制。
  - 先截断后脱敏留下半截机密（测试 M3、安全 M3）：已修。规矩写死先脱敏再截断、按长度从长到短，验收 3 加跨截断点的哨兵。
  - MCP 日志同在一个文件夹（测试 M2、安全 M5）：已修。范围收窄到 Tenon 自己的日志；owner 定 D18（只改权限），加 §对 03 的增补与验收 18。
  - OAuth 令牌与开发期环境变量登记不到（安全 M2）、脱敏方案该出卡（测试 M9）：已修。owner 定 D16，登记点列全；kernel 交出令牌要改 03 的接口，出 D19 交 owner。
  - 刷屏挤掉证据（安全 M4）：已修。按来源限量、关键行不限量并在轮转后重写，验收 16；lead 定为给 D8 的 B 补上限。
  - 文件保护只到最后一级（安全 M7）：已修。打开时检查目录、硬链接、属主，运行标记先写临时文件再改名，挡不住的写进已知限制，验收 13。
  - 单例拉进 Electron（测试 M4）、验收 10、11 没有可测入口（测试 M5）：已修。`appLog` 不 import electron，抽出 `reportStartupFailure`、`openLogsFolder`。
  - 验收 15 与 P1 测空（测试 M6）：已修。直接 spawn、真崩溃、先做正对照。
  - 矩阵的层与用例名盖不住验收（测试 M7）：已修，逐行对齐。
  - 安装包冒烟要读的几行没有验收、SIGTERM（测试 M8）：已修。验收 17，SIGTERM 写实。
  - 验收 10、11 指不回原话（测试 M10）：已修。owner 定 D15。
  - 一页的「调用失败」（测试 M11）：已修，改叫「界面向后台的请求失败」。
  - plan 现在就请批 ready（测试 M12）、没有测试作者一步（测试 M13）：已修。
  - minor 与建议：除测试 s2（未加载、卡死两种白屏）、s3（`process.on('warning')`）外都已改；s2 记进「以后再说」，s3 不改：没有证据表明它们今天丢了有用的信息。

## 挑刺评审 · 2026-11-28 · 审过 未提交的草稿（复审，基于 fedc419）

- 被审的内容：上一条记录之后改过的 error-logs 四个文件与 log，连带 packaging 同步改的部分；03、04 只看页头。仍未提交。
- 视角：一份新上下文的复审，只读两份挑刺评审原文和改后的文件，没看作者的对话；带小程序的几条按新写法重写再跑。
- 原文：`../tenon-notes/2026-11-28-packaging-and-logs/reviews/error-logs-recheck.md`，小程序在同目录 `recheck/` 下（另记）。
- 结论：第一轮 20 条 major 没有「没修」的；部分修 5 条（测试 M8、M5，安全 M4、M6、M7）；新 major 2 条（N3、N4）；新 minor 13 条（N1、N2、N5–N15）。上一条记录把安全 M4、M6、M7 写成「已修」，复审判为部分修；安全 s3 取的是「写明只靠评审」那一种。
- 突变：无（审 spec）。复审对验收 3 出了 11 个设计层面的突变（另记），活下来的 4 个在下面的处置里逐个堵上。
- 处置（都在提交之前改进文件，等第三轮复查核对）：
  - N3（只在写入时登记测不出）：已修。登记点写成「主进程每次读到密钥值的地方」，验收 3 加「包上之前就在钥匙串里、只经 `get` 读出」的哨兵，并加规矩「`get` 的每一次读出都登记」。另外三个活下来的突变：500 字截断点、互为前缀的两个哨兵、三种写法要注入进去，都写进验收 3。
  - N4（限量该出卡）：已修。owner 定 D20（两道保护都要）；D8 的代价恢复成 owner 当时看到的文字，结果里补一句后来加了限量。
  - 安全 M4 剩下的：已修。来源逐个列进限量表（含 `sandbox-unattributed`、`ipc`、`renderer`、`main.uncaught`），不同来源互不占额度；不给别的行留保底（要保底得超出 D20），持续刷屏约 11 分钟后旧证据被挤掉，写进已知限制；`app.unclean-exit` 加进轮转后抄写的名单。
  - 安全 M7、N6：已修。临时文件排他创建、不跟随链接；MCP 日志改权限不跟随链接、先验类型与属主；MCP 日志写入不做链接检查写进限制。
  - 测试 M8、N1、N8：已修。SIGTERM 改成三种情形；重复的沙箱行两行都留、只看 `sandbox.posture`；验收 17 的 SIGTERM 分成 e2e 那一支和单元测试那一支。
  - 测试 M5、N7：已修。启动失败的 e2e 改成把 `<profileDir>/mcp` 换成同名文件；「日志也写不进去」由单元测试守。
  - N2：已修。`<app>` 定义为安装版的 `process.resourcesPath`、开发构建的 `app.getAppPath()`，先换应用目录再换主目录；packaging 验收 11 跟着改。
  - N9：已修。D19 已定（A）。N10：并进安全 M4。N11：一页四处改了。N12：并进安全 M4，抄写的行带 `carried`，合并的界面报错何时写出写明了。N13：packaging 的卡号说明改了。N14：本条记录更正。N15：验收 1 与一页收窄到 Tenon 自己的代码，「不做」加了 Node、Chromium 的 stderr。
  - 建议：b1（`main.uncaught` 每窗 600 行）、b2（`gh[opusr]_`、参数名不分大小写）、b3（按 JSON 解析）、b4（单行超长的截法）、b5（`open` 时传入是不是安装版）、b6（`envs` 按 8 个字符登记写一句）、b7（一页提到 `xdg-open`）都已采纳。
- 探针：第一、二轮的 P1、P2 结果写进 evidence.md，并照各自事先写好的分支改了 spec（P2 加 `unhandledRejection` 监听，P1 的验收只查 `.dmp`）。

## 挑刺评审 · 2026-11-28 · 审过 未提交的草稿（第二次复审，第三轮，基于 fedc419）

- 被审的内容：上一条记录之后改过的 error-logs 四个文件与 log，连带 packaging 同步改的部分；只核对上一次复审列出的条目与这次新写的内容，没有重做完整评审。仍未提交。
- 视角：一份新上下文的复审，带小程序（另记）。
- 原文：`../tenon-notes/2026-11-28-packaging-and-logs/reviews/error-logs-recheck2.md`，小程序在同目录 `recheck2/` 下（另记）。
- 结论：上一轮 20 条里 17 条已修，3 条（安全 M7、N6、N11）的改法带出新问题；本轮新问题没有 major，minor 11 条（R1–R11），建议 4 条（R12–R15）。
- 突变：无（审 spec）。复审照验收 3 出了 13 个设计层面的突变（另记），按片段去查时都会变红，见 R3 的处置。
- 处置（都在提交之前改进文件）：
  - R1（残留临时文件让以后都不写日志）：已改。写运行标记前先删同名旧名字再排他创建；运行标记写不出来不关整份日志；验收 13 改了。
  - R2（MCP 改权限没查硬链接）：已改。规矩第 8 条加「只有一个硬链接」，验收 18 写明只管改权限那一步，写入照已知限制。
  - R3（「找不到」没写怎么查）：已改。验收 3 写明要查截断点前的片段与长哨兵的尾巴，短的先登记。
  - R4（运行中新加的 server 的 `envs` 没登记）：已改。登记点 ④ 改在把 MCP 配置交给连接池时；验收 3 的哨兵经 `mcp.add` 进来。
  - R5（刷屏的数字与出处）：已改。改了出处，补上路由原样带出输入与 `main.uncaught` 两种情形；另把界面报错的来源文件名截到 200 字。
  - R6（一页的刷屏场景）：已改。写明每窗最多 60 行、跨窗最多 120 行，丢了几条的那一句在关掉 Tenon 后能看到；走查步骤写了怎么让它出现。
  - R7（加监听后 stderr 与退出码没测、类型写错）：已改。写成开放问题 1，定在实现前的第一步（plan 2.0）验，不写成保证；`watchUncaught` 的两个事件分开写，来源按事件定。
  - R8（D20 卡面没写的细节）：已改。D20 下补一段「选定之后补的实现细节」，自定里各记一行（600 行、九种不限量、抄五种、来源截 200 字）。
  - R9（「需要你」只提 P1）：已改。探针都跑完了，改成请 owner 读一页。
  - R10（E4 的核查栏过时）：已改，引 P2。
  - R11（验收 17 的「依次」）：已改。只要求启动第一行、退出最后一行，其余都出现；packaging 验收 2、4 同步去掉「依次」。
  - 建议 R12（读旧标记会被管道卡住）、R13（正对照不在主进程源码里留接缝）、R15（写清哪一轮）：都已采纳。R14（渲染进程那一支的崩溃方式）：第三轮的正对照里，`forcefullyCrashRenderer` 与外部 `SIGSEGV` 开着收集时都写出了 `.dmp`，已被覆盖，写进 evidence P1。
- 探针：P1–P3 全部跑完（四轮 CI，另记），结果写进 evidence.md，照各自事先写好的分支改了 spec；P1、P3 原先的两条开放问题关掉。
- 按核心细则 8 不再起第四轮评审。遗留交 owner 知悉的：没有未处置的发现；剩一条开放问题（加 `unhandledRejection` 监听后终端那一行与退出码会不会变），定在实现前第一步验，结果属收紧就直接改并记修订，要改行为就先问 owner。

## 新格式试点 · 记数

- 2026-11-28 · owner 读「给你看的一页」约 5 分钟（owner 自述）；批 ready 前问了 1 个问题（要不要用日志库）。
- ready 之后的修订条数、走查时「这不是我以为的」次数：做到那一步再记。

## 评审 · 2026-11-28 · 审过 0b3707e

- 范围：PR #98 能不能合进 dev（两份 spec 的文档；设计不重审）。新上下文，Opus，只读。原文在私有笔记（另记）。
- 结论：改完再合。1 blocker、1 major、8 minor、4 建议。
- 处置：
  - B1（入口页与最新 dev 冲突）：已改，合入最新 dev 后重新生成。
  - M1（两份 plan 的进度过期）：已改。
  - m1（packaging 1.1 的总参考一行没加）：已加。m2（D18 把卡面写成 owner 点名）：改成照实写。m3（引号里的话不是 owner 原话）：去掉引号。m4（一页没写 60 行上限的两处例外）：补上，记修订。m5（`open -a` 与 `open -n -a` 不一）：统一成 `open -n -a`。m6（几条证据没跟上探针结果）：已更新。m7（「启动是第一行」）：两份 spec 都澄清，error-logs 记修订。m8（验收 17 的 SIGTERM 一支在段二）：分段表里写明。
  - 建议「三轮挑刺评审的标题没绑提交号、第三轮处置没人复核」：段一评审时抽查。其余两条建议知悉，不改。
- 没发现问题的：owner 批准记录、公开仓库边界、03/04 只改页头、没有行号引用、plan 尾部。

## 实施 · 段一

- 测试作者提交：3e36885（2026-11-28；新子 agent，只读 spec、evidence、plan，没看实现）。
- 现在就绿的两条：`error-logs-static.test.ts` 的两条静态扫描（今天只有 `mcp/log-sink.ts` 写 `logs/`、只有 `host/index.ts` new 钥匙串）；测试作者先对造出来的违规文件列表确认扫描会报错。它们守的是以后不退步。
- 测试改动：apps/desktop/test/error-logs-watch.test.ts、apps/desktop/e2e/error-logs.spec.ts · error-logs 验收 14 · 收紧：`repeats` 原先放宽成「0 或 1」「2 或 3」，spec 澄清为第一条 1、补写行是总次数后改成精确值（lead 改，实现之前）。
- 测试作者指出 spec 说不清的十处：七处已澄清进 spec（修订记录 2026-11-28）；其余三处照测试的理解不改 spec：MCP 日志收紧的入口时机、多行密钥按整段登记、`ErrorSummary` 的 cause 只保证 message 不进。
- 留给实现者：`test/support/error-logs.ts` 的 5 行与 `pool-on-secret.test.ts` 的 1 行 `@ts-expect-error` 在模块出现后删掉（只删这 6 行不算削弱）。
- 测试改动：apps/desktop/test/profile.test.ts · 「logs a dropped entry through console.warn when the caller gives no log, without its address」改名为「…through the app log…」 · `readConfig` 不传 log 时的回落按 spec §记什么改成 `appLog.line('config', 'warn')`，不再走 `console.warn`；用例改成 spy `appLog.line`，仍断言恰一行、含 `customVendors[0]`、不含 `secret-host`，另加一句断言来源与级别是 `config`、`warn`（E2、plan 2.4）。
- 测试改动：scripts/lint-gate.test.mjs · 「still bans reading main's cwd outside dev-env.ts」 · 评审后的修复（安全 m3、对照 spec m1）要求 `dev-env.ts` 的 override 只放开 cwd、不再把 `process.stderr` 的禁令一起关掉，并把 `process.stdout` 也加进禁令；原先断言 dev-env 的 `no-restricted-properties` 是 `'off'`，与此直接冲突。改成：它是 `error`、只禁 `process.stderr` 与 `process.stdout`（不含 cwd），`no-restricted-imports` 仍是 `'off'`——放开的范围没变，禁的范围更大。
- 实现者提交：5022747、cd87c5b、1a07167（2026-11-28；另一个新子 agent）。删掉 7 行 `@ts-expect-error`（测试作者数成 6 行，实际 7 行；只删指令行）；lead 随后删掉 `test/support/error-logs.ts` 文件头讲这些指令的过期注释，断言没动。
- 评审后补测试提交：3720511（2026-11-28；又一个新子 agent，只写测试）。14 条复现（12 条先红）、23 个突变缺口逐个验证能杀。
- 测试改动：apps/desktop/test/error-logs-app-log.test.ts · error-logs 验收 2、16 · 收紧：把「保留数小于总数」「长度不超过上限」这类宽松断言换成精确值（留下的是第 0–999 条、丢弃计数 49000、换窗口时的 `log.dropped` 在 close 之前就在），一条精确断言顶替了几条宽松的，所以删的条数比加的多。
- 修复者提交：2cab2ec、698f3f0、2f863e0、b9bbff0（2026-11-28；另一个新子 agent）。
- 探针（plan 2.0）：第一轮（run 46122329302）探针自己加载太早没测到；修好后第二轮（run 46126942154，Linux）：有、没有空的 `unhandledRejection` 监听，退出码都是 0；没监听时 stderr 有两行 `UnhandledPromiseRejectionWarning`，有监听时没有。走「照现稿」那一支，spec 开放问题 1 关掉。
- 复审（审 f5a1784，原文另记）：不通过，1 blocker、1 major、6 minor、6 建议；上一轮的 major 都已修对。blocker 是「ready 之后四项新增机制没有 owner 点名」，已补问，owner 四项都定了（D21–D24）；其余交下一轮修复。这是第二轮，按细则 8 再有一轮就停。
- 测试改动：apps/desktop/test/error-logs-registry.test.ts · 文件头与「the table holds 10 000 values…」的用例名、一句注释 · spec 改了（D21，丢最久没用的）：原先的「丢最早登记的」「重复登记不改先后」改成「丢最久没被读到的」「重复登记排到最新」，只改了措辞；该用例的断言原样保留（新规则下仍成立），「重复登记排到最新」另加两条新用例。
- 测试改动：scripts/lint-gate.test.mjs · 「still bans reading main's cwd outside dev-env.ts」 · 收紧（复审 m3）：dev-env.ts 也不能从 node:process 取 stderr、stdout、默认导出，也不能经 globalThis 写终端。原先断言它的 no-restricted-imports 是 `off`、no-restricted-properties 只有 process.stderr 与 process.stdout；改成断言前者是 error、只禁那三个名字（cwd 仍放开），后者再多 globalThis.console 与 globalThis.process 两项。
- 第二轮修复的提交：测试 926abb8、040982f（log.md 的测试改动另在 9048ed8）；修复 74b75c9、d21d088、4e6ead4、a1e3a9a（2026-11-28；又一个新子 agent，先交测试再改）。
- 第三轮复审（审 98aeecd，原文另记）：不通过，0 blocker、1 major、6 minor、6 建议；上一轮各条都已修。major 是登记值查找按「字段长 × 登记值长」退化（4096 字的值加 1 MB 文字卡 7.7 秒）。按细则 8 不再起第四轮；owner 2026-11-28 选「修完，只验这一处 (Recommended)」：修 major 与标了「合并前要改」的几条，再派新 agent 只核对这几处。
- 第三轮修复的提交：测试 70343d3、a61fcaa；修复 dda3443（2026-11-28；又一个新子 agent，先交测试再改）。没有「测试改动」。实测 4096 字的登记值加 1 MB 文字：修复前 3.6–8.5 秒，修复后 40–100 毫秒。
- 收尾核对（审 7bae8ed，原文另记）：第三轮的 major 与各条都修对、突变 6 个全红、测试没削弱；但指出「先截到 16 384 字、超长值不登记」是新增机制且放宽了验收 3（超长的 base64 写法会漏出最多 2000 字），还有一种登记值互为开头的形状要 0.94 秒。owner 2026-11-28 定 D25：截到 4096 字、超长的按开头 4096 字登记。
