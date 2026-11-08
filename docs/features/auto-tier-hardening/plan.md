# 开自动档前的加固 · plan

## 当前 / 需要你
当前：spec 已 ready 并合入 dev（PR #82）。A 段已合入（PR #84），B 段已合入（PR #85）。C 段（钩子位置）已实现，分支 `feat/auto-tier-hardening-c`：8e9c73f 实现、5d2275a 补正黑盒测试、0729ebb 与 fa89884 按两轮评审修订；两平台真沙箱与两路新上下文评审通过（log.md「评审 · 2026-11-08 · 审过 fa89884」）。下一步：D 段（文档同步与 spec 修订记录）。
需要你：无（实现时不改门禁文件：每个缺口都有能被 `test` 门禁执行的断言型复现，见「测试分层」）。
授权：本 spec 各段由 Codex 实现的 PR，lead 评审（两路新上下文）、CI 绿后由 lead 开自动合并；碰门禁文件、涉及花费或安全取舍、改 Status 时仍问 owner · 到本 spec `implemented` 为止 · 「一路推进」（2026-11-08 问题「加固 spec 各段 PR，我评审过且 CI 绿后由我开自动合并吗？」）

## 开工前读
- 本 spec 与 decisions.md、evidence.md。
- 02 §外带检查、§挂点与会话视图、§授权、工作区与外带检查的继承、§权限决策顺序；03 §连接器卡、§三态、第 3 层与第 6 层；04 §档位到 srt 配置、§已知限制；05 §硬链接、保护名单与选文件夹。
- 现成复现用例（威胁定义，不研究新绕法）：分支 `test/06-prereq-repro`（本地 ebdd69b）的 `apps/desktop/test/sandbox/escape.test.ts`、`apps/desktop/test/sensitive-paths.test.ts`、`packages/kernel/test/loop/mcp-exfiltration.test.ts`。各段从这里取本段要的那几条带进本段 PR。

## 命令
- 单测门禁：`TENON_SANDBOX_TESTS=skip pnpm vitest run --maxWorkers=2`（即 `.sdd/config.json` 的 `test`）。
- 沙箱黑盒（本地/Lima 手跑，与 CI 的 `ci`、`sandbox-macos` 作业同口径）：`TENON_SANDBOX_TESTS=required pnpm vitest run --maxWorkers=2 apps/desktop/test/sandbox/escape.test.ts`。
- 本地核 red-on-base：`python3 .sdd/spec-check.py --red-on-base`。
- Lima：`limactl start tenon-u2404`（u2604 起后先 `apparmor_parser -r /etc/apparmor.d/bwrap`），worktree 打包 `limactl copy` 进去换新目录名解开，用完 `limactl stop`；不在 `bash -lc` 里用 rm。

## 分段
Codex 实现，lead（Claude Code）每段 PR 合并前审一次（heavy：对照 spec、安全、突变三视角 + 汇总评审）。每段带「实现三句」。每段是独立 PR，只带本段的实现与本段的测试；别段的验收在本段 PR 里没有用例点名——`trace` 对非「改 implemented」的 PR 只警不拦（已核 `chk_trace`）。owner 最后把 Status 改 implemented 时，三段的测试都已合入 dev。

**测试分层**（E5；每个缺口三层，名字都带验收号）：
- **门禁可执行的复现**：单行 `it('auto-tier-hardening 验收 N 复现：…')`，跑在 `test` 门禁（不进沙箱），只经 dev 上已有的入口、不 import 本 spec 新增的模块，所以在 dev 上是断言失败、不是导入失败；`red-on-base` 自动核验。整行不超过 100 列（中文按 2 列计），免得格式化把标题挪到下一行、`new_repro_names` 认不出。
- **真沙箱黑盒验收**：escape.test.ts 的现成用例保留全部行为断言（宿主随后的 `git status` 不执行 fsmonitor），改名为 `auto-tier-hardening 验收 N: …`，由 CI 的 `ci`（Linux）与 `sandbox-macos`（macOS）作业以 `TENON_SANDBOX_TESTS=required` 跑，供 `trace`。它们在 `red-on-base` 里被跳过，所以不登记为复现；两平台「旧红新绿」由 lead 在 dev 与本段提交上各跑一次，记进 log.md。
- **正常行为对照**：不带「复现」（验收 3、6、11 的未配置一半）。

- **A 段 · 沙箱 `.git` 转向文件保护**（验收 1–4、15）。
  新增 `apps/desktop/src/main/host/git-protection.ts` 的 `discoverGitProtection`（转向文件、指针目标、子模块/worktree 枚举、不完整时的 `fallbackDeny`）。
  `sandbox.ts` 的 `SandboxFs` 只增 `readdir`、`readText`；`DesktopSandbox.wrap` 每次包装前对每个会话文件夹根 `await discoverGitProtection`，结果放进 `WorkspaceRoot.git`，再交给同步的 `wrapFilesystem`；`wrapFilesystem` 把 `redirectExisting`（两平台）、`redirectAbsent` 与 `<根>/*/**/.git` glob（仅 macOS）、`fallbackDeny`（发现不完整时只有一种：该根整个 `.git`）并进 denyWrite。D4=只拦 config/config.worktree/commondir/hooks。
  复现：`desktop-sandbox.test.ts` 里经 `DesktopSandbox.wrap`（假 srt 截下 `customConfig.filesystem`，假磁盘搭 fixture，假磁盘的 `readdir`/`readText` 加在本测试文件里），linux 与 darwin 两种 harness 各一条：验收 1 复现（已有指针及其目标的 config/hooks、子模块 config/hooks 进 denyWrite）、验收 2 复现（darwin：不存在的 commondir/config.worktree 与 `<根>/*/**/.git`）。`config.test.ts` 补 `wrapFilesystem` 的平台分支对照（Linux 不收 `redirectAbsent`，验收 3，不带「复现」）。
  指针目标的两条配置测试（验收 1，普通标题）：目标都放在普通目录里，不选旧规则本来就护着的 `.git/` ——一条在另一个工作区根的 `根B/git-meta/`，一条在 srt 默认可写目录下的 `/tmp/claude/<x>/git-meta/`；两条都断言交给 srt 的拒写配置里有 `git-meta/config` 与 `git-meta/hooks`。
  回退的一组测试（验收 15，普通标题）：
  ① 配置层：经 `DesktopSandbox.wrap` 让假磁盘的 `readText` 对 `.git/config` 抛错、或 `readdir` 对 `.git/modules` 抛错，两种都断言拒写配置含该根整个 `.git`、日志有诊断；夹具另含一条悬空的 `.git` 链接，断言它不进 `fallbackDeny`、只记诊断。
  指针型夹具（linked worktree，`.git` 是指针文件）：注入让它要读的配置读不出时，断言拒写配置含指针文件、解析出的实际 gitdir 目录与 commondir 目录；注入让指针本身解析不出时，断言只拒写指针文件、日志有诊断（这一形态不保证提交失败，见 spec §对 04 的增补「已知限制」）。
  ② 真沙箱黑盒，macOS 与 Linux 都跑：故障只注入到 Tenon 的发现端口（给 lab 的 `SandboxFs` 包一层，让 `readText`/`readdir` 对那一个路径抛错），磁盘上的仓库保持完好；目录型与指针型（指针解析得出的 linked worktree）两种夹具各跑一遍——先断言同一仓库在宿主上 `git status`、`git commit` 成功，再断言沙箱里 `git commit` 失败；关掉注入重跑一次，沙箱里 `git commit` 成功，证明失败来自拒写策略、不是夹具坏了。Linux 上另在没有别的活动 wrap、且 `afterExit` 完成之后断言不新增占位。
  黑盒：escape.test.ts 四条改名为验收 1（pointer、submodule，两平台断言被拒）、验收 2（commondir、子目录 `.git`，macOS）；加验收 3（根 git 常用操作与子模块提交成功、Linux 无占位）、验收 4（Linux 子目录新 `.git` 未被拦，表征）。
  门禁：`test`、`red-on-base`；CI `ci`、`sandbox-macos`。突变（评审出）：去掉转向文件组某一条 deny → 验收 1 或 2 的复现变红。
- **B 段 · 连接器外带检查**（验收 5–8、13、14）。
  改 `packages/kernel/src/permission/session-view.ts`（`untrustedSources` 记来源名、增 `privateSources`、新增 `originOf` 从冻结工具表取来源、取不到记 `unresolved:<name>`）、`permission/exfiltration.ts`（出口扩到任一连接器调用；判据=不可信任一来源 + 私密来源 ≠ S）、`loop/batch.ts` 的 `judgeCall`（父子 `privateSources` 并集合并、`touchedPrivateData` 从合并集算）。
  复现：只有验收 5 带「复现」——从 `mcp-exfiltration.test.ts` 取失败那组，按形态拆成单行 `it('auto-tier-hardening 验收 5 复现：…')`。验收 6 是正常行为对照（未读连接器时直接派发），用普通标题。另补验收 7、8、13、14 的单元/回环测试（普通标题），保留 `subagent-security.test.ts` 的跨会话外带两条。
  门禁：`test`、`red-on-base`。突变：「私密来源 ≠ S」改成恒真/恒假 → 验收 7 或 13 变红；`originOf` 取不到时改成「当内置」→ 验收 8 变红；`judgeCall` 漏合并 `privateSources` → 验收 14 变红。
- **C 段 · 钩子位置**（验收 9–12）。
  `git-protection.ts` 补 `core.hooksPath` 解析（含 include 跟进与上限）与 `hookNames`/`hookDirs`；`sensitive-paths.ts` 在刷新时调同一函数、把结果并进 `PathScope.sensitive`；`wrapFilesystem` 把钩子位置并进 denyWrite；`workspace.ts` 的 `sensitiveName` 增 `hookDirs` 匹配。
  复现：`sensitive-paths.test.ts` 经已有的 `desktopSensitivePaths` + `locatePath`，单行 `it('auto-tier-hardening 验收 9 复现：…')`（自定义目录的 hooksPath，分仓库配置与全局配置）与 `验收 10 复现`（`.husky/pre-commit`、lefthook 一族、`.pre-commit-config.yaml`，不配 hooksPath）；`desktop-sandbox.test.ts` 经 `DesktopSandbox.wrap` 加验收 12 复现（钩子位置进 denyWrite）。
  复现分支上那条旧对照「未配置 core.hooksPath 时写 `.husky/pre-commit` 不算自动执行位置」与 owner 卡 3 冲突，不带进来：改成验收 11，fixture 目录从 `.husky` 换成自定义目录（如 `my-hooks`），配了 hooksPath 指向它判 `auto-run`、没配判 workspace；`.husky` 的无条件保护由验收 10 管。它从没进过 dev，不算改弱已有测试。
  沙箱兑现的范围：两平台拦每个根下的 `hookNames` 与精确的 `hookDirs`；macOS 另对 `hookNames` 加子目录 glob；Linux 上 srt 丢弃通配写规则（E7），子目录同名位置不拦，写进已知限制。
  黑盒：escape.test.ts 加验收 12（沙箱写根下钩子位置被拒，两平台；macOS 另写一条子目录同名位置被拒），夹具分两种：钩子位置原来就有、原来没有要新建；Linux 上「原来没有」那种另在没有别的活动 wrap、且 `afterExit` 完成之后断言不留占位（P4）。门禁：`test`、`red-on-base`；CI `ci`、`sandbox-macos`。突变：从 `hookNames`/`hookDirs` 去掉 `.husky`/解析 → 验收 9 或 10 变红。
- **D 段 · 文档同步与收口**。按 headers.md 给 02、03、04、05 页头加 `Changed by`，正文不动；改总参考 §以后再说 三行；SECURITY.md 加 §已知限制 增补的各条与 §给 06 的约束；`docs/README.md` 重新生成（`python3 .sdd/spec-check.py --index`）。门禁：`spec-check` 的 `pairs`、`index`；文档改动 `red-on-base` 自动跳过。

## 步骤
- [x] 1. owner 批 ready → 草稿入库 `docs/features/auto-tier-hardening/`，按 headers.md 给 02/03/04/05 加 `Changed by`、总参考三行换链接、重生成入口页。
- [x] 2. A 段：沙箱转向文件保护 + 验收 1–4、15 的三层测试；dev 与本段提交上各跑一次沙箱黑盒（macOS + 两台 Lima），旧红新绿记 log.md；三视角评审 + 汇总评审。
- [x] 3. B 段：连接器外带（含 `batch.ts` 父子合并）+ 验收 5–8、13、14；`red-on-base` 核验验收 5 的复现；三视角评审 + 汇总评审。
- [x] 4. C 段：钩子位置 + 验收 9–12；沙箱黑盒旧红新绿记 log.md；三视角评审 + 汇总评审。
- [ ] 5. D 段：文档同步、SECURITY.md、入口页重生成；汇总评审（只改被改 spec 页头，正文不动）。
- [ ] 6. 补突变编号进 §验收矩阵「突变」列（汇总评审追加突变块后）。
- [ ] 7. 对照验收逐条核对（每条验收对上点名它的测试；沙箱与平台条由 lead 在两平台确认，记 log.md）。
- [ ] 8. 清理：撤掉所有临时探针，确认工作区干净、无调试打印。
- [ ] 9. owner 验收 → 改 Status。

## 验收矩阵
| 验收号 | 层 | 平台 | 测试用例名 | 门禁命令 | 突变 |
|---|---|---|---|---|---|
| 1 | 单元 | macOS、Linux | auto-tier-hardening 验收 1 复现：wrap 的拒写含已有指针、目标与子模块 config/hooks；黑盒 auto-tier-hardening 验收 1: 改已有 worktree/submodule 的转向文件被拒 | test | （待评审补） |
| 2 | 单元 | macOS | auto-tier-hardening 验收 2 复现：darwin 的拒写含不存在的转向文件与子目录 .git；黑盒 auto-tier-hardening 验收 2: 写 commondir/子目录 .git 被拒 | test | （待评审补） |
| 3 | 集成 | macOS、Linux | auto-tier-hardening 验收 3: 发现完整时根 git 与子模块提交照常、Linux 无占位 | test | （待评审补） |
| 4 | 集成 | Linux | auto-tier-hardening 验收 4: Linux 新建转向文件未被拦（表征） | test | — |
| 5 | 集成 | — | auto-tier-hardening 验收 5 复现：任务跨源出卡；…对话跨源出卡 | test | （待评审补） |
| 6 | 集成 | — | auto-tier-hardening 验收 6: $label 未读连接器时直接派发 | test | — |
| 7 | 单元 | — | auto-tier-hardening 验收 7: 同源读写不出卡 | test | （待评审补） |
| 8 | 单元 | — | auto-tier-hardening 验收 8: %s 从冻结工具表取来源并去重；…来源关联失败 %s 时从严；…连接器原名 Read/Bash/WebFetch/WebSearch 不按内置工具分类 | test | （待评审补） |
| 9 | 单元 | macOS、Linux | auto-tier-hardening 验收 9 复现：自定义 hooksPath 目录里的钩子判自动执行 | test | （待评审补） |
| 10 | 单元 | macOS、Linux | auto-tier-hardening 验收 10 复现：.husky、lefthook、pre-commit 判自动执行 | test | （待评审补） |
| 11 | 单元 | macOS、Linux | auto-tier-hardening 验收 11: 配了 hooksPath 才认自定义目录 | test | — |
| 12 | 单元 | macOS、Linux | auto-tier-hardening 验收 12 复现：wrap 的拒写含根下钩子位置与 hookDirs；黑盒 auto-tier-hardening 验收 12: 沙箱里写已有与新建的钩子位置都被拒（macOS 含子目录） | test | （待评审补） |
| 13 | 单元 | — | auto-tier-hardening 验收 13: 只有 S 的不可信加本地私密读也出卡 | test | （待评审补） |
| 14 | 集成 | — | auto-tier-hardening 验收 14: 子读 A 交接后父调 B 合并来源并出卡；…父读 A 后子调 B 出单次外带卡且续跑保留来源；…父子同读 A 后父调 B 时来源各只保留一次 | test | （待评审补） |
| 15 | 单元 | macOS、Linux | auto-tier-hardening 验收 15: 发现不完整时目录型拒写整个 .git、指针型拒写指针加 gitdir 与 commondir，并留诊断；黑盒 auto-tier-hardening 验收 15: 两种夹具只注入发现故障时 git 写照预期失败、关掉注入则成功、Linux 不新增占位 | test | （待评审补） |

（「层」写最低一层：复现与对照都在 `test` 门禁里跑；用例名里标「黑盒」的由 CI 的 `ci`、`sandbox-macos` 作业以 `TENON_SANDBOX_TESTS=required` 跑，`test` 门禁与 `red-on-base` 跳过它们（E5），两平台旧红新绿记 log.md。CI 机器重跑的突变只登记 `test` 门禁（本项目补充 5）。）

## 交接
2026-11-08：A 段由 Codex 实现、lead 提交，两路新上下文评审（对照 spec 与安全、测试与突变）各一轮不通过、修订后复核通过；macOS 真沙箱与 Lima u2404 真沙箱全绿，旧红新绿记 log.md（u2604 冷启动后 AppArmor 自带配置使沙箱不可用，未改它，Linux 另由 CI `ci` 作业覆盖）。B 段从 `packages/kernel/src/permission/session-view.ts` 接，照 plan B 段与「测试分层」。下面 Open 里的五条随 C、D 段处理。

## Open
- D 段：spec 修订记录要补 C 段实现中的几处细化——owner「也拦」（已存在的 include 目标也拒写，picks.md）、钩子名单比规矩 6 多收的 lefthook 本地配置与目录、hooksPath 几种取值的处理（评审原文 C-security.md、C-security-r2.md）；只收紧或澄清，照核心第 4 条记一行。
- C 段第二次复核留下的一条安全建议与三个存活突变（原文 C-security-r3.md、C-tests-r3.md），低影响，D 段或后续处理。
- C 段一并补测试：`originOf` 查表改写后，「同键多条保留首条」（assembled、tool_table 各一）、「引用的表缺失但 tape 里还有别的表时仍记 unresolved」、「键拼法不串（run-1/seq 11 与 run-11/seq 1）」；生产里不可达，B 段测试复核建议，标题带验收 8。
- 05 验收 45「concurrent captures and age cleanup keep live parentless trees sound」在 PR #84 的 CI `ci` 上偶发红一次（ENOTEMPTY rmdir），本地连跑 5 次全过、与本 spec 无关；并入总参考 §以后再说 那条「两个 worker 都满载时……偶发红」的观察记录（D 段做）。
- C 段一并做：发现失败中不经端口的那几类（指针解析不了、预算或深度耗尽、目标不是目录、commondir 内容非法）日志只有一句总述，要带上路径与原因（A 段安全复核建议）。
- C 段一并补测试：`.git/modules/<名>` 本身是链接时的拒写与 Linux 事后比对；含 `..` 的写法最后一级是链接、`..` 写法解不完；目录型 `.git` 本身是指向目录的链接配回退（A 段测试复核建议）。
- C 段：`SandboxHostPaths.xdgConfigHome` 接线（从 startupEnv 读 `XDG_CONFIG_HOME`，改必填），解析全局 git 配置要用。
- D 段：04 的增补里写一句「含 `..` 的条目改交解开 `..` 之前链接后的拼法」，这是 04「链接」规则的一处实现细化，影响 denyRead 与 denyWrite 的全部条目（A 段安全复核建议；已核不算放宽）。
- `desktop-sandbox-fs.test.ts` 的 chmod 000 用例在 root 下会红：现有 CI 与 Lima 都不以 root 跑；以后要在 root 下跑时加 `skipIf(process.getuid?.() === 0)`。
