# 开自动档前的加固 · plan

## 当前 / 需要你
当前：A/B/C 段已合入 dev（PR #84、#85、#86），D 段文档已提交于 03bd512，lead 的正式文档评审通过。步骤 5–8 已完成，本轮已落实 D-review.md 五条文档建议，检查及独立复核通过，修订不提交；Status 保持 ready。改 implemented 前仍需 lead 补齐 M1–M11 的实际重跑证据，再交 owner 验收。
需要你：本轮无；lead 完成突变实跑核验后交 owner 验收，Status 只由 owner 决定。
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
- [x] 5. D 段：文档同步、SECURITY.md、入口页重生成；汇总评审（只改被改 spec 页头，正文不动）。
- [x] 6. 补突变编号进 §验收矩阵「突变」列（汇总评审追加突变块后）。
- [x] 7. 对照验收逐条核对（每条验收对上点名它的测试；沙箱与平台条由 lead 在两平台确认，记 log.md）。
- [x] 8. 清理：撤掉所有临时探针，确认工作区干净、无调试打印。
- [ ] 9. owner 验收 → 改 Status。

## 验收矩阵
| 验收号 | 层 | 平台 | 测试用例名 | 门禁命令 | 突变 |
|---|---|---|---|---|---|
| 1 | 单元 | macOS、Linux | desktop-sandbox.test.ts：auto-tier-hardening 验收 1 复现：已有转向文件；…验收 1: pointer target in %s has config and hooks denied；escape.test.ts：auto-tier-hardening 验收 1: 沙箱里 $name 被拒，宿主不执行 fsmonitor | test | M1 |
| 2 | 单元 | macOS | desktop-sandbox.test.ts：auto-tier-hardening 验收 2 复现：macOS 新建转向文件；escape.test.ts：auto-tier-hardening 验收 2: 沙箱里 $name 被拒，宿主不执行 fsmonitor；…验收 2: macOS refuses a new config.worktree | test | M2 |
| 3 | 单元 | macOS、Linux | config.test.ts：auto-tier-hardening 验收 3: %s selects existing redirects and platform-specific absent entries；desktop-sandbox.test.ts：auto-tier-hardening 验收 3: Linux ignores dangling leaves and discovers anew each wrap；escape.test.ts：auto-tier-hardening 验收 3: complete discovery preserves root git and submodule commits | test | M3 |
| 4 | 单元 | Linux | desktop-sandbox.test.ts：auto-tier-hardening 验收 4: Linux leaves new redirect files and nested git writable；escape.test.ts：auto-tier-hardening 验收 4: Linux permits new nested git and absent redirect files | test | —（已知限制对照） |
| 5 | 集成 | — | mcp-exfiltration.test.ts：auto-tier-hardening 验收 5 复现：任务跨源出卡；…验收 5 复现：对话跨源出卡 | test | M5 |
| 6 | 集成 | — | auto-tier-hardening 验收 6: $label 未读连接器时直接派发 | test | — |
| 7 | 单元 | — | auto-tier-hardening 验收 7: 同源读写不出卡 | test | M4 |
| 8 | 单元 | — | session-view.test.ts：auto-tier-hardening 验收 8: %s 从冻结工具表取来源并去重；…验收 8: 来源关联失败 %s 时从严；…验收 8: 连接器原名 %s 不按内置工具分类；…验收 8: 同键多条 %s 保留首条；…验收 8: 引用表缺失时不借别的表；…验收 8: run-1/11 与 run-11/1 不串键 | test | M6 |
| 9 | 单元 | macOS、Linux | sensitive-paths.test.ts：auto-tier-hardening 验收 9 复现：仓库钩子目录；…验收 9 复现：全局钩子目录；…验收 9、10: hook writes always ask with the automatic execution category | test | M8 |
| 10 | 单元 | macOS、Linux | sensitive-paths.test.ts：auto-tier-hardening 验收 10 复现：钩子名字；…验收 9、10: hook writes always ask with the automatic execution category | test | M9 |
| 11 | 单元 | macOS、Linux | auto-tier-hardening 验收 11: 配了 hooksPath 才认自定义目录 | test | — |
| 12 | 单元 | macOS、Linux | desktop-sandbox.test.ts：auto-tier-hardening 验收 12 复现：钩子拒写；escape.test.ts：auto-tier-hardening 验收 12: root hook locations refuse writes %s；…验收 12: macOS refuses nested hook names %s；…验收 12: a hooks file cannot become a directory before host commit；…验收 12: disabling hooks with dev null preserves shell redirection | test | M10 |
| 13 | 单元 | — | auto-tier-hardening 验收 13: 只有 S 的不可信加本地私密读也出卡；mcp-exfiltration.test.ts：auto-tier-hardening 验收 13: 本地私密读后同源只读连接器也出卡 | test | M5 |
| 14 | 集成 | — | auto-tier-hardening 验收 14: 子读 A 交接后父调 B 合并来源并出卡；…验收 14: 父读 A 后子调 B 出单次外带卡且续跑保留来源；…验收 14: 父子同读 A 后父调 B 时来源各只保留一次 | test | M7 |
| 15 | 单元 | macOS、Linux | desktop-sandbox.test.ts：auto-tier-hardening 验收 15: unreadable %s denies the entire directory git root；…验收 15: pointer %s failure denies only resolved metadata；escape.test.ts：auto-tier-hardening 验收 15: $kind with unreadable $fault fails commit only during discovery fault | test | M11 |

（「层」写最低一层：复现与对照都在 `test` 门禁里跑；escape.test.ts 的真沙箱用例由 CI 的 `ci`、`sandbox-macos` 作业以 `TENON_SANDBOX_TESTS=required` 跑，`test` 门禁与 `red-on-base` 跳过它们（E5），两平台旧红新绿记 log.md。CI 机器重跑的突变只登记 `test` 门禁（本项目补充 5）。）

文件名对应：沙箱用例在 `apps/desktop/test/sandbox/`，sensitive-paths.test.ts 在 `apps/desktop/test/`，session-view.test.ts 与验收 7、13 的 exfiltration.test.ts 在 `packages/kernel/test/permission/`，mcp-exfiltration.test.ts 在 `packages/kernel/test/loop/`；验收 6、14 未写文件名的用例均在 mcp-exfiltration.test.ts，验收 11 在 sensitive-paths.test.ts。escape.test.ts 的用例均为真沙箱黑盒，平台证据见 log.md 的 A/C 段正式评审；本次 D 段只核对已有证据，不重跑平台沙箱。

## 交接
2026-11-09：D 段基线已提交于 03bd512，本轮开始时工作区干净；lead 的正式评审审过该提交，结论通过，五条建议已逐条落实到文档（log.md「D 段正式评审及建议处置」）。步骤 5 的汇总评审以该正式评审为准，步骤 8 恢复原文，基线清理结论不等于本轮没有未提交差异。本轮仅留下预期文档修订，不提交、不改代码、门禁或 Status；format/lint/typecheck、相关 287 条测试及新上下文独立复核通过；入口页已重生成，spec-check 拦 0，结果见同节补记。下一步 lead 在 CI 或本地实际重跑 M1–M11 并记录结果，再由 owner 验收并决定是否改 Status；不可把静态登记当作实跑通过。

## Open
- D 段评审留下的 3 条文档小项（原文 impl-reviews/D-review-r2.md：建议 5 的余下部分与 2 条小建议），后续文档修订时处理，不挡验收。
- 改 implemented 前必须完成：M1–M11 目前仅静态登记，lead 须在 CI 或本地针对包含 A/B/C 段实现的代码范围逐项实际重跑，并将结果及存活项处置追加到 log.md，再交 owner 验收。文档差异导致的跳过不算通过；本轮只改文档，不执行突变。
- 后续代码改动时处理（本 D 段仅文档，不改代码）：文件工具的 hooksPath 目录本身为链接时，Delete 链接未必每次问；两步操作之间还需赶在敏感表刷新之前，评审未确定性复现后续写入。lead 下次改钩子发现时登记末级不解开的拼法并补 Delete 回归（原文 C-security-r3.md 的唯一建议；沙箱侧仍按平台规则保护或事后比对）。
- 后续测试跟进：`/dev/null` 的可替换链接别名仍受生产代码保护，但把它误豁免的突变尚无用例杀死；lead 下次改 hooksPath 时补沙箱与文件工具夹具（原文 C-tests-r3.md）。
- 后续评审复核：把顶层 git 配置也登记的偏严突变，spec 未定、不据此改范围；文件工具登记配置来源时覆盖已有凭据类别的突变，边界几乎不可达。维持现实现，lead 下次改配置来源时复核（原文 C-tests-r3.md 的另两个存活突变）。
- `desktop-sandbox-fs.test.ts` 的 chmod 000 用例在 root 下会红：现有 CI 与 Lima 都不以 root 跑；以后要在 root 下跑时加 `skipIf(process.getuid?.() === 0)`。
