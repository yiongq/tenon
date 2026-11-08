# 开自动档前的加固 · log

## 2026-11-08 · A 段实现与交接

范围：仅沙箱 `.git` 转向保护（验收 1–4、15），基线 247ad93。按 brief-hardA 的要求保留未提交差异，不改 spec.md、plan.md、decisions.md、evidence.md，不做 B/C/D，不启动 Electron，不运行嵌套真沙箱。

`discoverGitProtection` 每次 wrap 从只读端口发现指针、commondir、子模块及 worktree 元数据；限制每个文本 1 MiB、枚举预算 4096、深度 32。只拒写 config、config.worktree、commondir、hooks 及已有指针；发现不完整时按 spec 的三种形态补拒写。Linux 只消费已存在的转向条目；macOS 另消费不存在条目与至少隔一层的 `.git` glob。hookDirs/hookNames 留给 C 段。目录存在性先经已有 walkLinks 逐级解链接，再检查实际目标。

测试改动：apps/desktop/test/sandbox/config.test.ts · 04 验收 5 的完整拒写表与通配字符对照 · 新增子目录 `.git` 规则后，精确预期从 23 条增加到 24 条；保留原有规则，并新增精确路径断言，没有删除保护断言。

测试改动：apps/desktop/test/sandbox/escape.test.ts · auto-tier-hardening 验收 2、4 的新增黑盒 · skipIf 只按 spec 的平台范围运行：验收 2 仅 macOS、验收 4 仅 Linux；既有 04 测试没有新增跳过。ebdd69b 的四条向量及宿主 fsmonitor 对照均保留；Linux nested 向量按已批准限制断言成功。

### 验收映射

路径前缀为 `apps/desktop/test/sandbox/`；参数化标题中的占位符由 Vitest 展开。

| 验收 | 配置层用例标题 | 真沙箱用例标题 |
|---|---|---|
| 1 | `auto-tier-hardening 验收 1 复现：已有转向文件`（desktop-sandbox.test.ts，两个平台）；`auto-tier-hardening 验收 1: pointer target in %s has config and hooks denied`（second-root / srt-default）；`auto-tier-hardening 验收 1: pointer paths resolve links before parent components` | `auto-tier-hardening 验收 1: 沙箱里 $name 被拒，宿主不执行 fsmonitor`（pointer / submodule） |
| 2 | `auto-tier-hardening 验收 2 复现：macOS 新建转向文件`（desktop-sandbox.test.ts） | `auto-tier-hardening 验收 2: 沙箱里 $name 被拒，宿主不执行 fsmonitor`（commondir / nested）；`auto-tier-hardening 验收 2: macOS refuses a new config.worktree` |
| 3 | `auto-tier-hardening 验收 3: %s selects existing redirects and platform-specific absent entries`（config.test.ts）；`auto-tier-hardening 验收 3: Linux ignores dangling leaves and discovers anew each wrap`（desktop-sandbox.test.ts） | `auto-tier-hardening 验收 3: complete discovery preserves root git and submodule commits` |
| 4 | —（已知限制的真沙箱表征） | `auto-tier-hardening 验收 4: Linux permits new nested git and absent redirect files` |
| 15 | `auto-tier-hardening 验收 15: unreadable %s denies the entire directory git root`（config / modules）；`auto-tier-hardening 验收 15: pointer %s failure denies only resolved metadata`（config / pointer）；`auto-tier-hardening 验收 15: dangling git links leave diagnostics without fallback`；`auto-tier-hardening 验收 15: %s reports incomplete discovery and falls back`（oversize config / enumeration budget / malformed pointer） | `auto-tier-hardening 验收 15: $kind with unreadable $fault fails commit only during discovery fault`（directory / pointer × config / modules） |

### 检查证据

所有 pnpm 命令设 `NPM_CONFIG_USERCONFIG=/dev/null`，避免访问本环境禁止读取的用户配置；不改仓库配置。

- `pnpm install --frozen-lockfile`：依赖安装完成，但 prepare 的 lefthook install 无权替换主仓库 `.git/hooks/pre-commit`，退出 1。没有绕过门禁。随后单独 `pnpm build` 成功。
- `pnpm vitest run --maxWorkers=2 apps/desktop/test/sandbox/desktop-sandbox.test.ts apps/desktop/test/sandbox/config.test.ts`：最终 2 files / 69 tests passed。
- 旧红新绿：用文件备份和 `git show HEAD:<path>` 临时还原 sandbox.ts、sandbox-config.ts，并临时移走新 git-protection.ts；用 finally 恢复，未使用 stash / checkout。运行 `pnpm vitest run --maxWorkers=2 apps/desktop/test/sandbox/desktop-sandbox.test.ts -t 'auto-tier-hardening.*复现'`：原生产代码 `2 failed`，两条均为 `AssertionError`（缺拒写项），不是导入错误；恢复后 `2 passed`。标题整行显示宽度分别为 65、71 列。
- 突变：从转向组消费处删掉以 `/.git` 结尾的已有指针 deny，同一命令得到验收 1 `AssertionError`、`1 failed | 1 passed`；改回后 `2 passed`。
- `pnpm vitest run --maxWorkers=2`：281 files passed / 2 failed / 3 skipped；5643 tests passed / 5 failed / 129 skipped。stop-tree.test.ts 的 4 条在调用 ps 时 `spawn EPERM`；snapshot-git.test.ts 的遗留进程恢复用例等待进程结束超时，恢复路径同样依赖 `/bin/ps`。未改这两个文件。真沙箱按未设置 TENON_SANDBOX_TESTS 跳过，四条宿主 fsmonitor 对照通过。
- 真沙箱：本次没有运行。协调者需在沙箱外的 macOS 与 Linux VM 跑 `TENON_SANDBOX_TESTS=required pnpm vitest run --maxWorkers=2 apps/desktop/test/sandbox/escape.test.ts`，核验验收 1–4、15。

## 实现者自查 · 2026-11-08 · A 段工作区快照（基线 247ad93，未提交；不是独立评审）

独立评审在新上下文、单独临时快照中只读进行，覆盖规格、安全及测试/突变三个视角。发现 Node realpathSync 提前折叠 `..` 与逐级解链接要求不符；已用 walkLinks 适配，并增加模拟真实端口行为的回归。独立复核确认修复，无剩余阻塞发现。未运行真沙箱。

自查结论：通过（A 段静态检查；双平台黑盒待协调者验证）。

自查突变：1 个，杀死 1 个，存活 0 个；已撤销突变。

按 brief 不提交，因此本次评审绑定的是工作区快照，不能冒充“审过某个实现提交”。spec-check 的提交绑定要求留给协调者在提交后补齐；不修改门禁。overview 与已实现 spec 的文档同步按 plan 留给 D 段。

## 2026-11-08 · 基线对照补记

将本段生产文件临时还原为 247ad93 后，运行 `pnpm vitest run --maxWorkers=2 apps/desktop/test/stop-tree.test.ts apps/desktop/test/snapshot-git.test.ts`：同样 `5 failed | 22 passed | 6 skipped`，失败标题与全量一致，确认不是本段引入。运行后已恢复本段生产文件。

## 2026-11-08 · 最终门禁与剩余事项

- `pnpm format:check && pnpm lint && pnpm typecheck` 全部退出 0；`git diff --check` 通过。
- `python3 .sdd/spec-check.py`：拦 1 条、警 22 条。唯一阻断为评审未绑定实现提交号；本次按 brief 不提交，独立快照评审不能伪造提交绑定。平台跳过已有测试改动说明，不再阻断。
- 逐字比较备份确认临时还原与突变后，三个生产文件均恢复为最终实现；工作区只有 A 段源代码、测试及本日志。
- 剩余：协调者在沙箱外跑 macOS / Linux 黑盒及依赖进程检查的全量测试；提交后补评审提交绑定。没有需要 owner 澄清的规格问题。plan.md 依 brief 保持不动。

## 2026-11-08 · A 段按评审修订

基线：lead 已提交的 b5593bb。本轮仅修 A 段，改动留在同一工作区、不提交；不改 spec、plan、decisions、evidence 和门禁，不接 xdgConfigHome。lead 已报告基线在沙箱外全量测试、macOS / Linux u2404 验收 1–4、15 黑盒通过；这不是本轮修订后的运行结果。

1. 真磁盘端口：新增 `apps/desktop/test/sandbox/desktop-sandbox-fs.test.ts`，直接调用 `desktopSandboxFs`，用真实临时目录测试 UTF-8 字节上限的等值与超一字节、ENOENT / ENOTDIR、正常枚举、目录、mkfifo 创建的 FIFO、chmod 000 文件。目录和 FIFO 用限时结果断言保证读取拒绝而非挂起，不启动 srt 或 Electron。五条展开用例全部归入普通 test 门禁，标题均点名验收 15。
2. 链接与回退：`discoverGitProtection` 保留原路径拼法，`wrapFilesystem` 统一按 04 §档位到 srt 配置「链接」处理转向和回退条目：落点拒写、macOS 保护途经链接、Linux 登记链接供 afterExit 核对。含 `..` 的路径先按组件解链接，再输出不含父目录组件的 literal；不把原串直接交给 srt。两个平台都有配置测试，并通过 DesktopSandbox.wrap / afterExit 复现核验。`GitProtection` 字段和接口均未改变。
3. Git 文本解析：指针和 commondir 都只剥离末尾连续 CR / LF，保留路径中的空格和制表符；各新增一条复现。
4. 故障矩阵：条目预算改为单独的宽目录用例；深度限制单独使用 40 层非 git 容器；新增 config.worktree 读失败，以及 `.git` 为 FIFO 的假磁盘夹具，断言走 lstat 的 other 分支且不调用 readText。
5. 验收 1、2 黑盒：保留宿主 fsmonitor 未执行断言，同时核验沙箱命令非零退出和目标文件内容（或原先不存在的状态）不变。
6. 验收 15 指针型黑盒：main 放到 srt 默认可写的 `/tmp/claude/<唯一目录>/main`（macOS 使用真实路径 `/private/tmp/claude`），workspace 只有 ws；注入失败时提交失败、撤销注入后提交成功。沿用共享目录锁，仅清理本用例的唯一目录。
7. 验收 4：新增 Linux 普通仓库配置测试，明确不存在的 commondir、config.worktree 和 `*/**/.git` 不进 denyWrite。
8. 诊断：在 sandbox.ts 组装发现端口时逐个包装 lstat、readdir、readText、realpath，错误日志带端口、JSON 编码的路径、errno；walkLinks 内被吞掉的 lstat / readlink 错误也先记录。真实读取的非普通文件和超限错误分别带 EINVAL / EFBIG。四个发现端口各有故障注入日志断言；未给 GitProtection 增加诊断字段。
9. 可选去重：移除重复的 existing.add(found.real)，由统一的路径配置层处理落点；其余入队校验和发现范围保留，避免扩大行为改动。

测试改动：apps/desktop/test/sandbox/desktop-sandbox.test.ts · 原验收 15 的 enumeration budget 参数行 · 改为独立的 4097 子目录预算测试，并另加 40 层深度测试；原故障回退断言保留且分开核验两项上限。

本轮新增复现标题（均为单行 it，整行不超过 100 显示列）：

- `auto-tier-hardening 验收 1 复现：转向路径链接`
- `auto-tier-hardening 验收 15 复现：回退保留链接`
- `auto-tier-hardening 验收 1 复现：指针只去换行`
- `auto-tier-hardening 验收 1 复现：公共路径保留空白`

旧红新绿：将 sandbox.ts、sandbox-config.ts、git-protection.ts 逐字备份，用 `git show b5593bb:<路径>` 临时还原三个生产文件，再运行 `pnpm vitest run --maxWorkers=2 apps/desktop/test/sandbox/desktop-sandbox.test.ts -t 'auto-tier-hardening.*复现：(转向路径|回退保留|指针只去|公共路径)'`。基线四条全部 AssertionError（4 failed），恢复后 4 passed；没有导入错误、没有使用 stash / checkout。临时输出为 `/private/tmp/hardA-r2-red-base.log` 与 `/private/tmp/hardA-r2-green.log`。

突变逐次运行、每次 finally 恢复生产文件：删 readText 大小上限 → 字节边界用例失败；删 isFile 检查 → FIFO 用例失败（读成功而非拒绝）；readdir 的缺失路径改抛错 → 缺失 / ENOTDIR 用例失败；发现时提前丢弃原路径 → 转向链接复现失败；取消 literal 的父目录组件解析 → macOS / Linux 两条配置用例失败。共五项，全部杀死。输出在 `/private/tmp/hardA-r2-mut-{size,isfile,readdir,provenance,literal}.log`；撤销后相关选择集 11 passed，见 `/private/tmp/hardA-r2-green-restored.log`。

检查：`pnpm format:check && pnpm lint && pnpm typecheck` 全部退出 0；`pnpm vitest run --maxWorkers=2 apps/desktop/test/sandbox/` 为 9 files passed、342 tests passed、113 skipped（见 `/private/tmp/hardA-r2-sandbox.log`）。所有 pnpm 命令继续设置 `NPM_CONFIG_USERCONFIG=/dev/null`。真实两平台沙箱本轮未运行，修订后的黑盒仍需 lead 在沙箱外复跑。

新上下文只读检查使用独立临时快照 `/private/tmp/hardA-review-r2`，未发现阻塞问题；未运行真实沙箱，不作为 lead 的正式评审记录。`python3 .sdd/spec-check.py` 当前唯一阻断是「本次改动里没有新增评审记录」；按本轮要求不新建评审标题、不改 plan，正式记录留给 lead。

最终全量：`pnpm vitest run --maxWorkers=2` 为 282 files passed / 2 failed / 3 skipped，5663 tests passed / 5 failed / 129 skipped，耗时 150.79 秒（`/private/tmp/hardA-r2-full.log`）。五条失败与前轮已确认的环境限制一致：stop-tree 的四条调用 ps 报 spawn EPERM；snapshot-git 的遗留进程恢复用例依赖被限制的进程枚举，等待退出超时。其余全绿，本轮未改这两个文件。

收尾：三个生产文件与突变前备份逐字一致，四条新复现标题显示宽度依次为 65 / 66 / 65 / 69 列；追加日志后 format:check、git diff --check 通过。spec-check 为 1 条阻断、15 条警告；阻断仍仅为 lead 正式评审记录缺失。修订后两平台真沙箱黑盒留给 lead 复跑。需要确认的问题：无。

## 评审 · 2026-11-08 · 审过 f41ddc9

方式：实现者是 Codex；两路新上下文评审由 Claude 做（对照 spec 与安全一路，测试与突变一路），各在自建的临时 worktree 里取证。第一轮对准 b5593bb，两路各 1 条 major、判不通过；Codex 按发现修订为 2c086f4（f41ddc9 只是并入 dev，apps 与 packages 下无差异）后复核，两路都通过。

平台证据（旧红新绿）：
- macOS（sandbox-runtime 0.0.79）：dev c894922 上 ebdd69b 的四条复现 4/4 红；f41ddc9 上 escape.test.ts 114 通过、0 失败（auto-tier-hardening 验收 1、2、3、15 全过，验收 4 只在 Linux 跑）。
- Linux（Lima tenon-u2404，git 2.43.0，bwrap 0.9.0）：ebdd69b 上四条复现 3 红 1 绿——写 commondir 那条在 Linux 沙箱里没修复也没有得逞，对应的验收 2 只在 macOS 跑，所以 Linux 上它没有红到绿可证；b5593bb 与 f41ddc9 上 escape.test.ts 都是 46 通过、0 失败，04 原有用例没有变红。tenon-u2604 冷启动后 Ubuntu 自带的 AppArmor 配置让沙箱不可用，没有结果，没改它；Linux 另由 CI 的 `ci` 作业覆盖。
- 沙箱外全量 vitest：f41ddc9 上 284 个文件、5669 条通过、0 失败（Codex 沙箱里那 5 条失败是调不了 `ps`）。

发现：
- [major] 真磁盘端口 `desktopSandboxFs()` 的 `readText`、`readdir` 在 `test` 门禁里没有覆盖，上限与非普通文件的检查都只由测试自己的假磁盘撑着（测试评审第一轮） · 已修 2c086f4
- [major] 发现交出的转向条目与回退条目没有照 04 §档位到 srt 配置「链接」一节处理（安全评审第一轮，附三条会失败的临时用例；复核时在新提交上重放全部通过） · 已修 2c086f4
- [建议] 指针与 commondir 的解析口径照 git，只去掉末尾的 `\r`、`\n` · 已修 2c086f4
- [建议] 条目预算、深度上限、`config.worktree` 读失败、`.git` 为 FIFO，各补单独用例 · 已修 2c086f4
- [建议] 真沙箱验收 1、2 另断言命令失败、目标文件不变 · 已修 2c086f4
- [建议] 验收 15 指针型黑盒把 main 移出 workspace，失败来源只剩 ws 自己的回退 · 已修 2c086f4
- [建议] 验收 4 补配置层用例 · 已修 2c086f4
- [建议] 端口出错的日志带端口名、路径与 errno · 已修 2c086f4
- [建议] 不经端口的发现失败（指针解析不了、预算或深度耗尽等）日志仍只有一句总述 · 不修：留 C 段，记 plan Open
- [建议] `xdgConfigHome` 没接线 · 不修：C 段解析全局 git 配置时接，记 plan Open
- [建议] 子模块目录本身是链接、`..` 写法最后一级是链接、`..` 写法解不完、目录型 `.git` 本身是链接，各缺一条回归用例 · 不修：留 C 段，记 plan Open
- [建议] `buildFilesystem` 对含 `..` 的条目改交解开 `..` 之前链接后的拼法，影响 denyRead 与 denyWrite 的全部条目（评审核过不算放宽，04 既有用例都过） · 不修：D 段在 04 的增补里写明，记 plan Open
- [建议] `desktop-sandbox-fs.test.ts` 的 chmod 000 用例在 root 下会红 · 不修：现有 CI 与 Lima 都不以 root 跑，记 plan Open
- [建议] 入队与出队重复登记 `rootMetadata` 等几处等价冗余 · 不修：不影响行为

结论：通过

突变：第一轮 40 个、存活 13 个，其中实质 6 个（真端口三处、深度上限、`config.worktree`、lstat 的 other），修订后复核全部被杀；复核轮在新改动上另做 26 个、存活 7 个：两个预算单项互相兜底、两个等价写法，其余三个是上面记入 plan Open 的用例缺口。


## 2026-11-08 · B 段实现

范围：仅 plan B 段（验收 5–8、13、14），基线 `6d934d7`，分支 `feat/auto-tier-hardening-b`。A 段保持原样；不改 spec.md、plan.md、decisions.md、evidence.md 与门禁文件。按 brief-hardB 留工作区差异，不提交、不 push、不开 PR，不读密钥或钥匙串，不调真实模型、不启动 Electron。brief 明确不改 plan，本节承担本次交接。

`session-view.ts` 的 `originOf` 按派发的 (runId, requestSeq) 找 `view/assembled`，再按 tableKey 找 `view/tool_table`、按映射后的 name 找 ToolOrigin。连接器两种形态都记入不可信与私密来源，来源为 `mcp:<serverId>`；关联不上时记 `unresolved:<name>`，同样计入两个集合。本地私密读仍只在任务形态记 local；WebSearch / WebFetch 的来源名、DNS 拒绝、落盘目录与 URL 豁免规则保留。

`exfiltration.ts` 把任一连接器调用作为出口，判据为任一不可信来源 + 存在不同于出口 S 的私密来源；WebFetch 继续用原 URL 豁免。`batch.ts` 的 `judgeCall` 合并自身、父会话及交接子会话的 privateSources，并由合并集合计算 touchedPrivateData。未使用 MCP 注解放宽判定，未改 Tape 载荷与 IPC。

测试从 `ebdd69b` 只取 `packages/kernel/test/loop/mcp-exfiltration.test.ts`，验收 5 按两种形态拆成单行 it，两个标题整行均 67 显示列。回环验证“总是允许”仍出 flagged / exfiltration 卡、答复前没有外发、允许后只派发一次、相同调用下次仍问且 grant.scope 为 once。验收 13 另经真实循环验证标注 readOnlyHint 的只读连接器同样是出口。验收 14 观察 inspector 实际收到的两个合并来源集合、布尔值与交接事实，并确认父会话出卡。

测试改动：packages/kernel/test/permission/session-view.test.ts · dispatched 夹具及引用 decision / dispatch 的原有用例 · 补齐冻结工具表与 assembled 事实，按名字取事实，保留原有私密读、DNS、压缩与 URL 断言；无新增跳过或删除断言。

测试改动：packages/kernel/test/permission/exfiltration.test.ts · 原 MCP WebFetch 名称对照及单条件对照 · 按已批准的任一连接器出口规则，将跨源 MCP 的 none 改为 ask；无私密条件同时清空 privateSources，保持字段一致；保留 WebFetch URL 豁免断言。

测试改动：packages/kernel/test/permission/inspector.test.ts · INPUT 夹具 · 为新增必填字段补空 privateSources，原断言不变。

### 验收落点

| 验收 | 文件 | 用例标题 |
|---|---|---|
| 5 | packages/kernel/test/loop/mcp-exfiltration.test.ts | auto-tier-hardening 验收 5 复现：任务跨源出卡；auto-tier-hardening 验收 5 复现：对话跨源出卡 |
| 6 | packages/kernel/test/loop/mcp-exfiltration.test.ts | auto-tier-hardening 验收 6: $label 未读连接器时直接派发（cowork 形态、对话形态） |
| 7 | packages/kernel/test/permission/exfiltration.test.ts | auto-tier-hardening 验收 7: 同源读写不出卡 |
| 8 | packages/kernel/test/permission/session-view.test.ts | auto-tier-hardening 验收 8: %s 从冻结工具表取来源并去重（chat、cowork）；auto-tier-hardening 验收 8: 来源关联失败 %s 时从严（assembled、table、null-tools、name、run、request、wrong-fact） |
| 13 | packages/kernel/test/permission/exfiltration.test.ts | auto-tier-hardening 验收 13: 只有 S 的不可信加本地私密读也出卡 |
| 13 | packages/kernel/test/loop/mcp-exfiltration.test.ts | auto-tier-hardening 验收 13: 本地私密读后同源只读连接器也出卡 |
| 14 | packages/kernel/test/loop/mcp-exfiltration.test.ts | auto-tier-hardening 验收 14: 子读 A 交接后父调 B 合并来源并出卡 |

既有 packages/kernel/test/loop/subagent-security.test.ts 未改；保留其中父子外带的全部用例，包括 `child private reads and untrusted fetches tighten the parent after handoff` 与 `a later child inherits exfiltration evidence returned by an earlier child`。

### 旧红新绿与突变证据

所有 pnpm 命令设置 `NPM_CONFIG_USERCONFIG=/dev/null`，避免读取本环境禁止访问的用户配置。新工作区先跑 install / build：install 首次因无 TTY 退出，设置 CI=true 后依赖安装完成，prepare 更新主仓库 hooks 被沙箱拒绝（operation not permitted），退出 1；未绕过 hooks。随后 `pnpm build` 成功，之后才运行 typecheck。

旧红新绿：三个生产文件逐字备份到 `/private/tmp/hardB-final-production-kn1rzf0b`，用 `git show HEAD:<path>` 临时还原生产代码，finally 恢复，未用 stash / checkout。命令：`pnpm vitest run --maxWorkers=2 packages/kernel/test/loop/mcp-exfiltration.test.ts -t 'auto-tier-hardening 验收 5 复现'`。基线 `2 failed | 4 skipped`，两条均为 `AssertionError: expected [ { …(2) }, { …(2) } ] to deeply equal []`（外发已发生）；恢复后 `2 passed | 4 skipped`。输出为 `/private/tmp/hardB-red-base.log`、`/private/tmp/hardB-green-restored.log`，三个生产文件已逐字比对恢复。

突变逐个临时修改、每次 finally 恢复，公共前缀为 `pnpm vitest run --maxWorkers=2`：

| 突变 | 选择命令（接公共前缀） | 关键输出 |
|---|---|---|
| 私密来源 ≠ S 恒真 | packages/kernel/test/permission/exfiltration.test.ts -t 'auto-tier-hardening 验收 7' | 1 failed；AssertionError: expected ask to deeply equal none |
| 私密来源 ≠ S 恒假 | packages/kernel/test/permission/exfiltration.test.ts -t 'auto-tier-hardening 验收 13' | 1 failed；AssertionError: expected none to match ask / exfiltration |
| originOf 返回空时当内置 | packages/kernel/test/permission/session-view.test.ts -t 'auto-tier-hardening 验收 8' | 7 failed、2 passed；AssertionError: expected [] to deeply equal ['unresolved:Read'] |
| judgeCall 漏合并 related.privateSources | packages/kernel/test/loop/mcp-exfiltration.test.ts -t 'auto-tier-hardening 验收 14' | 1 failed；AssertionError: expected completed to deeply equal paused / approval |

输出依次为 `/private/tmp/hardB-mut-true.log`、`/private/tmp/hardB-mut-false.log`、`/private/tmp/hardB-mut-builtin.log`、`/private/tmp/hardB-mut-merge.log`。共 4 个突变、杀死 4 个、存活 0 个。撤销后相关三文件 `34 passed`（`/private/tmp/hardB-green-mutations-restored.log`）；随后只调整注释、复现的 fail-fast 断言与 lint 要求，没有改生产逻辑。


### 最终门禁与交接

用例名校正：上文“既有 subagent-security.test.ts 未改”中的第二条，实际完整标题为 `a later child inherits the private-data condition already handed back by an earlier child`，以此为准；该文件已逐字比对 HEAD，未改动。

- `pnpm format:check && pnpm lint && pnpm typecheck`：全部退出 0。首次 lint 指出两个委托给 helper 的测试没有本地 expect、两处观察器参数遮蔽 call；已为测试增加返回值断言并改参数名，再跑上述完整命令通过。没有屏蔽 lint 规则。
- `pnpm vitest run --maxWorkers=2 packages/kernel`：115 files passed、2572 tests passed，25.54 秒（`/private/tmp/hardB-kernel.log`）。包括原有 WebFetch 与 subagent-security 回归。
- `pnpm vitest run --maxWorkers=2`：283 files passed / 2 failed / 3 skipped；5680 tests passed / 5 failed / 129 skipped，138.62 秒（`/private/tmp/hardB-full.log`）。stop-tree.test.ts 四条在 ps 调用处 `Error: spawn EPERM`；snapshot-git.test.ts 的 `05 验收 45: startup recovery ends a real leftover git launched through /usr/bin/git` 等待旧进程退出超时（`AssertionError: expected true to be false`），其 recoverProcess 在 macOS 依赖 `/bin/ps`。与 A 段日志记录的五条环境限制一致，未改这两个文件。真沙箱黑盒按本环境未设置 TENON_SANDBOX_TESTS 跳过；本段不启动真沙箱或 Electron。
- `python3 .sdd/spec-check.py`：退出 1，拦 7 条、警 19 条。七条阻断均为 A 段 `审过 f41ddc9` 之后 B 段七个源码/测试文件的改动尚未有新正式评审绑定。本次 brief 明确评审由 lead 另做、不得新增“## 评审”标题，故如实保留阻断，不伪造评审、不改门禁。其他警告包括 C 段验收 9–12 尚未实现与缺 CI 报告。
- `git diff --check` 通过；spec / plan / decisions / evidence 与 subagent-security.test.ts 均逐字等于 HEAD，log 只追加。最终生产文件与最后一次旧红新绿的备份逐字一致；突变均已撤销，无调试打印或临时探针。

当前：B 段实现、验收映射、旧红新绿及四项突变已完成，工作区只有本段三份生产文件、四份测试文件和本日志；没有提交。实现者静态自查已核对规矩 4、5、8、来源回退、URL 豁免与父子继承；不作为新上下文独立评审记录。

下一步交 lead：在独立上下文正式评审 B 段及提交绑定，按仓库流程更新 plan；在沙箱外复跑五条依赖进程枚举的测试或全量门禁。本次未做的正式评审按 brief 由 lead 承担，C、D 段未开始。

需要确认的问题：无。


## 2026-11-08 · B 段按评审补充

基线：lead 已提交的 `8f7c76e`，工作区开工时干净。owner 本轮消息告知基线沙箱外全量 0 失败、两路新上下文评审均通过，本节不将其当作修订后的测试结果。范围仅 B 段，按要求不提交、不改 spec / plan / decisions / evidence / 门禁文件，不启动 Electron、不调真实模型、不读取钥匙串。

性能：`packages/kernel/src/permission/session-view.ts` 的 `buildSessionView` 在派发循环之前遍历 entries，一次建好 assembledByRequest（键 sourceId:sourceSeq）及 toolTables（键 provenanceKey）两张 Map；`originOf` 通过 Map 关联请求与冻结工具表。索引保留首条匹配，与原 find 读法一致。连接器分类、不可信和私密来源、七种关联失败的 unresolved 回退均不变，没有新增持久缓存或依赖。

回环补充在 `packages/kernel/test/loop/mcp-exfiltration.test.ts`：
- `auto-tier-hardening 验收 14: 父读 A 后子调 B 出单次外带卡且续跑保留来源`：父读 documents 并获批后，子调总是允许的 messages，外发前 writes 为空、卡属于子会话、category 为 exfiltration、allowScope 为 once；允许后仅一次外发，再次派发前的判定视图精确为 mcp:messages 与 mcp:documents，不含 unresolved，且子会话再次出单次卡。
- `auto-tier-hardening 验收 14: 父子同读 A 后父调 B 时来源各只保留一次`：确认父、子两次 documents 读取都执行，父调 messages 前两个来源数组精确各为一个 mcp:documents，且外带卡阻止派发。

单元补充：`session-view.test.ts` 把 connector 辅助函数提到文件级，并允许传 originalName；`auto-tier-hardening 验收 8: 连接器原名 %s 不按内置工具分类` 分别取 Read / Bash / WebFetch / WebSearch，在 cowork 形态断言两个数组仅含 mcp:S。`exfiltration.test.ts` 新增 `auto-tier-hardening 验收 13: 连接器名为 WebFetch 也不享受 URL 豁免`，验证 mcp / WebFetch / fetchUrlVouched=true 仍然 ask。

测试改动：packages/kernel/test/permission/session-view.test.ts · connector 夹具 · 提到文件级并增加 originalName 默认参数，原用例与断言保持，未删除或放宽已有断言、未增加跳过。

新回环第一版等待重复子会话暂停时误用 rootEnd，导致超时；已对照 mailbox.ts 的 endOwnChild 改为等待该子会话的 runEnded（父会话仍暂停，不再发新终止事件），没有修改生产循环、提高超时或跳过用例。修正后相关三文件 `41 passed`。

### 计时对照

命令：`node --experimental-strip-types /private/tmp/hardB-r2-benchmark/compare.mjs`，Node v22.22.0。脚本在临时目录分别保存 `git show 8f7c76e:packages/kernel/src/permission/session-view.ts` 与本次实现；两者使用同一份 4000 次派发 / 20000 条记录（每次各含 tool_table、assembled、tool/call、permission_decided、dispatch），fixture 构建不计时。先断言两份完整视图 deepStrictEqual，再各预热 3 次、交替顺序采样 9 次，每次建立一份视图。

| 实现 | 单份视图耗时中位数 | 最小–最大 |
|---|---|---|
| 8f7c76e 的逐次 find | 103.87 ms | 101.26–106.62 ms |
| 本次 Map 索引 | 2.97 ms | 2.04–3.62 ms |

本机约快 35 倍；这只是同一 fixture 的本地计时，不作为 CI 阈值。输出在 `/private/tmp/hardB-r2-benchmark.log`，脚本和两份输入源码都只留临时目录，不进入仓库。

### 六项突变证据

每项都先备份生产文件、只修改该项，再运行对应新测试；要求返回 1 且包含 AssertionError，排除超时。每次 finally 逐字恢复，未使用 stash / checkout。公共命令前缀为 `pnpm vitest run --maxWorkers=2`，所有 pnpm 命令设置 NPM_CONFIG_USERCONFIG=/dev/null。

| 突变 | 接公共前缀的命令 | 输出 |
|---|---|---|
| privateSources 合并不去重 | packages/kernel/test/loop/mcp-exfiltration.test.ts -t 'auto-tier-hardening 验收 14: 父子同读' | 1 failed；AssertionError，privateSources 的 mcp:documents 重复 |
| untrustedSources 合并不去重 | packages/kernel/test/loop/mcp-exfiltration.test.ts -t 'auto-tier-hardening 验收 14: 父子同读' | 1 failed；AssertionError，untrustedSources 的 mcp:documents 重复 |
| WebFetch 只凭原名识别 | packages/kernel/test/permission/exfiltration.test.ts -t 'auto-tier-hardening 验收 13: 连接器名为' | 1 failed；AssertionError: expected none to match ask |
| 连接器分支去掉 continue | packages/kernel/test/permission/session-view.test.ts -t 'auto-tier-hardening 验收 8: 连接器原名' | 4 failed；AssertionError，分别多出 local、local、WebFetch、WebSearch |
| related.privateSources 过滤 mcp: | packages/kernel/test/loop/mcp-exfiltration.test.ts -t 'auto-tier-hardening 验收 14: 父读 A' | 1 failed；AssertionError: expected completed to deeply equal paused / subagent |
| related.untrustedSources 过滤 mcp: | packages/kernel/test/loop/mcp-exfiltration.test.ts -t 'auto-tier-hardening 验收 14: 父读 A' | 1 failed；AssertionError: expected 非空 writes to deeply equal [] |

输出依次为 `/private/tmp/hardB-r2-mut-private-dedup.log`、`/private/tmp/hardB-r2-mut-untrusted-dedup.log`、`/private/tmp/hardB-r2-mut-webfetch-name.log`、`/private/tmp/hardB-r2-mut-no-continue.log`、`/private/tmp/hardB-r2-mut-private-filter.log`、`/private/tmp/hardB-r2-mut-untrusted-filter.log`。6 个突变，全部杀死，无存活。生产备份在 `/private/tmp/hardB-r2-production-36oq6u9e`，已确认恢复。


### 门禁与交接

- `pnpm vitest run --maxWorkers=2 packages/kernel/test/permission/session-view.test.ts packages/kernel/test/permission/exfiltration.test.ts packages/kernel/test/loop/mcp-exfiltration.test.ts`：3 files / 41 tests passed（`/private/tmp/hardB-r2-targeted.log`）；包含两份指定测试文件的全部原有用例、原有七种 unresolved 关联失败以及本轮新增用例。
- `pnpm format:check && pnpm lint && pnpm typecheck`：全部退出 0。
- `pnpm vitest run --maxWorkers=2 packages/kernel`：115 files / 2579 tests passed，26.27 秒（`/private/tmp/hardB-r2-kernel.log`）；这是全部突变恢复后的运行结果。
- `python3 .sdd/spec-check.py`：退出 1，拦 11 条、警 19 条。原因是仓库最后一条正式评审仍绑定 A 段 f41ddc9，脚本列出其后 8f7c76e 的七个文件与本次工作区四个文件；owner 告知的两路通过尚未在此记录为新评审绑定。本轮按要求不新增以“## 评审”开头的标题、不改门禁，正式记录留 lead。
- `git diff --check` 通过；临时计时脚本、突变与调试输出未进入工作区，prod 的 batch.ts / exfiltration.ts 已逐字等于 HEAD；唯一生产差异为 session-view.ts 的 Map 索引。

当前：本轮三项建议已补齐，四个源码/测试文件及本日志留在工作区，不提交。spec / plan / decisions / evidence / 门禁文件保持原样；brief 明确不改 plan，因此本节记录当前与交接。没有降低断言、增加跳过或放宽生产权限规则。

交接：lead 复核本次性能与新增测试、正式记录 B 段评审及相应提交绑定；C、D 段未开始。需要确认的问题：无。
