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

## 评审 · 2026-11-08 · 审过 baaedb8

方式：实现者是 Codex（gpt-6.1-sol）；两路新上下文评审由 Claude 做（对照 spec 与安全一路，测试与突变一路），各在自建的临时 worktree 里取证。第一轮对准 8f7c76e，两路都通过、各提若干建议；Codex 照建议补测试并把 `originOf` 改为查表，提交 baaedb8；测试与突变一路对 baaedb8 复核通过。B 段只改 kernel，不涉及真沙箱。

证据：
- 旧红新绿：三个生产文件换回 6d934d7 时，两条「auto-tier-hardening 验收 5 复现」都是断言失败（外发已发生），不是导入失败；本段通过。验收 6 的两条在旧代码上也绿，是真正的对照。
- 沙箱外全量 vitest（8f7c76e）：285 个文件、5686 条通过、0 失败；kernel 在 baaedb8 上 115 个文件、2579 条通过。
- 安全一路另跑两条临时探针：续跑那次派发能关联上来源（不落成 `unresolved`）；父读连接器、子调连接器时子会话出单次外带卡。都通过。
- `originOf` 查表改写：与 8f7c76e 的实现对跑 30000 个随机 tape，`buildSessionView` 输出逐字相等；4000 次派发、20000 条事实时单份视图约 104 ms → 3 ms。

发现：
- [建议] 父读连接器、子调连接器这一方向，以及续跑派发后的来源，没有测试（两路都提） · 已修 baaedb8
- [建议] 父子合并后 `privateSources`、`untrustedSources` 的去重没有测试 · 已修 baaedb8
- [建议] 连接器工具原名恰为 Read / Bash / WebFetch / WebSearch 时不按内置分类，没有测试 · 已修 baaedb8
- [建议] 「WebFetch 只认 builtin」在单元层没有对应用例（URL 豁免不给连接器） · 已修 baaedb8
- [建议] `originOf` 每次派发线性扫描两次 entries，长会话变慢（不影响收紧与否） · 已修 baaedb8
- [建议] plan 验收矩阵里验收 5、6、8、14 的用例名与实际标题对不上 · 已修 baaedb8 之后的 plan 修订（只改 plan）
- [建议] 查表改写的「同键多条保留首条」「缺表但有别的表仍记 unresolved」「键拼法不串」没有用例钉住（生产里不可达） · 不修：C 段一并补，记 plan Open

结论：通过

突变：第一轮在 8f7c76e 上出 31 个、存活 6 个（合并不去重两个、WebFetch 只凭名字、连接器跌进内置分类、子会话漏父会话的连接器来源两个），baaedb8 补测试后全部被杀；复核轮针对查表改写新做 7 个、存活 4 个，都是生产里不可达的保留策略与键拼法，记入 plan Open。plan B 段列的四个突变（恒真、恒假、当内置、漏合并）重放全被杀。

## 2026-11-08 · C 段实现

实现三句：发现函数按会话根及其 gitdir/commondir 配置、用户全局配置解析钩子目录，文件工具与沙箱共用解析实现。文件工具写钩子位置沿用自动执行位置的每次询问，沙箱两平台拒写根下名字与精确目录，macOS 另拒写子目录同名位置。验收 9、10、12 四条复现已核旧红新绿，四项突变均触发断言失败且已恢复；真沙箱平台验收留 lead 执行。

### 实现与范围

- apps/desktop/src/main/host/git-protection.ts 的 discoverGitProtection 增加固定钩子名单、core.hooksPath 和 include/includeIf（不判条件、取并集）解析；每个配置文本上限 1 MiB，配置读取预算 4096、include 深度 32，无跨调用缓存。支持引号、转义、注释、值续行、HOME 路径、XDG 配置；.husky/_ 另带 .husky 父目录。根下没有 .git 也解析全局配置、返回固定名字。
- 钩子配置来自该会话根的 gitdir/commondir 链及全局配置；子模块/worktree 元数据枚举仍做 A 段的转向保护与读失败回退，不把它们的相对 hooksPath 归到父根。子模块作为另一个会话根时独立发现。GitProtection 字段保持不变。
- apps/desktop/src/main/host/sensitive-paths.ts 的 desktopSensitivePaths 每次刷新调用同一发现函数，把固定名字和真实钩子目录并进敏感表，保留不完整标记及诊断。kernel 的 sensitiveName 只匹配 hookDirs，不读磁盘；读与查找不因钩子分类出卡。
- apps/desktop/src/main/host/sandbox-config.ts 的 buildFilesystem 把每个会话根下的 hookNames 与精确 hookDirs 加入拒写；macOS 另加子目录名字 glob，Linux 不加 glob，按 spec 保留其子目录限制和缺失位置占位代价。
- SandboxHostPaths.xdgConfigHome 改必填；sandbox-runtime.ts 从 startupEnv 接入 XDG_CONFIG_HOME，main 的文件工具 provider 也接同一启动值。测试与 eval 宿主补齐该字段。
- A 段 Open：内部发现错误记录路径和原因（指针解析、目标不是目录、commondir、预算/深度、配置/hooksPath）；端口没有 errno 的错误保留其原因。补模块目录链接与 Linux 事后比对、含 .. 的最后一级链接/无法解析、目录型 .git 链接回退。
- B 段 Open：只补 originOf 查表回归，生产代码不变，覆盖两类同键保留首条、缺引用表但有别的表、run/request 键不串。

### 验收落点

- 验收 9：sensitive-paths.test.ts 的「auto-tier-hardening 验收 9 复现：仓库钩子目录」「auto-tier-hardening 验收 9 复现：全局钩子目录」。另有 includes/quotes/continuations/husky parent、XDG 无 git 与刷新、目录链接与父路径、include 深度的对照；desktop-sandbox.test.ts 覆盖 XDG include、指针/公共配置与文件数预算。
- 验收 10：sensitive-paths.test.ts 的「auto-tier-hardening 验收 10 复现：钩子名字」，不配置 hooksPath，覆盖 Write/Edit/Delete、任意深度与折叠大小写；与验收 9 共用「auto-tier-hardening 验收 9、10: hook writes always ask with the automatic execution category」，覆盖 always-allow、自动档与重复询问。
- 验收 11：sensitive-paths.test.ts 的「auto-tier-hardening 验收 11: 配了 hooksPath 才认自定义目录」，fixture 为 my-hooks，未配置判 workspace、配置后判 auto-run，Read/Glob/Grep 照常；另有 core 子节不误认的对照。
- 验收 12：desktop-sandbox.test.ts 的「auto-tier-hardening 验收 12 复现：钩子拒写」，两平台检查根下钩子名字、精确目录与 macOS glob；escape.test.ts 的「auto-tier-hardening 验收 12: root hook locations refuse writes %s」「auto-tier-hardening 验收 12: macOS refuses nested hook names %s」分别覆盖已有/新建。lab.run 会等待 afterExit，测试串行；新建夹具在退出后检查包括目录位置本身的全部占位均不存在。黑盒未在本 agent 沙箱运行。
- Open 跟进：desktop-sandbox.test.ts 中「auto-tier-hardening 验收 1: linked module directories deny targets and Linux detects swaps」「auto-tier-hardening 验收 1: parent traversal ending in a link preserves its final entry」「auto-tier-hardening 验收 15: unresolved parent traversal reports its path and reason」「auto-tier-hardening 验收 15: directory git alias fallback protects the real directory」，以及 internal diagnostics/config budget 的参数化用例。
- 验收 8 跟进：session-view.test.ts 的「auto-tier-hardening 验收 8: 同键多条 %s 保留首条」（assembled、tool_table）、「auto-tier-hardening 验收 8: 引用表缺失时不借别的表」「auto-tier-hardening 验收 8: run-1/11 与 run-11/1 不串键」。

四条新增复现的 it 标题均保持单行；显示列宽（中文按 2）为 65、65、62、62。

### 旧红新绿与突变证据

以本次起点 HEAD 6254700 为基线：把改过的生产文件备份到临时目录，用 git show HEAD:<path> 的原始字节覆盖生产文件，测试文件保留；跑完在 finally 恢复。未用 stash 或 checkout。命令为 pnpm vitest run --maxWorkers=2 apps/desktop/test/sensitive-paths.test.ts apps/desktop/test/sandbox/desktop-sandbox.test.ts -t "auto-tier-hardening 验收 (9|10|12) 复现"。

~~~text
基线：exit 1；Test Files 2 failed；Tests 4 failed
  三条文件工具断言：AssertionError ... sensitive: 'auto-run'
  一条 wrap 断言：AssertionError ... ArrayContaining
恢复：exit 0；Test Files 2 passed；Tests 4 passed
~~~

四项手动突变，每次只改对应生产点，跑后恢复：

~~~text
去掉固定 .husky：验收 10，1 failed（AssertionError）
关闭 hooksPath 解析：验收 9，2 failed（AssertionError）
去掉 buildFilesystem 钩子名字/目录拒写：验收 12，1 failed（AssertionError）
去掉 sensitiveName 的 hookDirs 匹配：验收 9，2 failed（AssertionError）
全部恢复后：4 passed
~~~

### 新上下文快照复核与测试调整

独立只读上下文在临时快照审查源码及测试，发现一项配置注释解析问题：以反斜线结尾的注释吞掉下一行 [core]。隔离的 git config --file ... --get core.hooksPath 返回 my-hooks，而新增回归先断言失败；修正为先去引号外注释、再判续行，三种注释回归与原有真实值续行对照通过。自查另发现 core 子节误认，新增两个对照先失败，修正后通过。最终快照静态复核通过，无剩余具体发现；该结论不代替 lead 的两路正式评审与提交绑定。

测试改动：apps/desktop/test/sensitive-paths.test.ts · 完整敏感表精确比对 · 新契约增加 hookDirs 空数组，仍精确比对所有字段。
测试改动：apps/desktop/test/sandbox/desktop-sandbox.test.ts · Linux 占位记录/并发清理三条 · 精确名单增加 C 段的 16 个钩子名字，不移除原有条目或断言。
测试改动：apps/desktop/test/sandbox/desktop-sandbox.test.ts · FIFO git entry is rejected without reading it · 全局 git 配置现在也要读，将“readText 完全不调用”收窄到“绝不读 FIFO .git 本身”，保留原来的安全边界，允许正常的全局配置读取。
测试改动：apps/desktop/test/sandbox/escape.test.ts · C 段 macOS 子目录钩子黑盒 · 新增 macOS 平台条件，Linux 不支持这类 glob 是 spec 已定限制；已有测试未增加跳过。
未带入 ebdd69b 中把未配置 .husky 判为普通目录的旧对照，按 plan 用 my-hooks 验收 11。

### 最终门禁与交接

- pnpm format:check、pnpm lint、pnpm typecheck：最终生产版本全部通过。git diff --check 无空白问题。
- pnpm vitest run --maxWorkers=2 apps/desktop/test/sandbox/ apps/desktop/test/sensitive-paths.test.ts packages/kernel：125 个文件通过，3031 passed、117 skipped；黑盒因未设置 TENON_SANDBOX_TESTS 按原门禁跳过。
- pnpm vitest run --maxWorkers=2：283 个文件通过、2 个失败、3 个跳过；5717 passed、5 failed、133 skipped。四条 stop-tree 失败直接报 spawn EPERM，位置在调用 ps 的 living；snapshot-git 的“startup recovery ends a real leftover git launched through /usr/bin/git”因进程身份查询同样依赖受限的 /bin/ps，恢复未杀掉夹具进程而超时。与 brief 预告的 agent 沙箱限制一致，未改这些测试或门禁。
- python3 .sdd/spec-check.py：最近一轮退出 1，16 条 review 阻断，18 条警告；阻断均为旧 B 段“审过 baaedb8”之后的 C 段 16 个源码/测试文件尚未有新提交绑定评审。当前仅有未提交快照复核，brief 禁止提交及新增以“## 评审”开头的登记，不伪造绑定、不修改门禁；交接前会复跑一次。警告包括缺测试报告、已有文档关系/敏感词告警及测试改动提醒。
- 新 worktree 已运行 pnpm install --frozen-lockfile，依赖下载完成，但 prepare 安装 hooks 时因不能写主仓库 .git/hooks/pre-commit 而失败；未绕过 hooks。随后 pnpm build 成功，再执行类型检查与测试。pnpm 使用 NPM_CONFIG_USERCONFIG=/dev/null，避免访问受限用户配置。

交接：C 段源码、门禁复现、黑盒用例及 Open 标 C 的跟进已留在工作区；无提交、无 push、无 PR。未改 spec、plan、decisions、evidence、状态或门禁，未做 D 段，未启动 Electron、未读钥匙串/密钥、未调用真实模型。按本 brief 不改 plan，进度与剩余工作记在本节。下一步由 lead 在 macOS 与 Linux/Lima 跑验收 12 黑盒（含新建位置 afterExit 后无占位）、作正式两路评审与提交绑定，再更新 plan；全量测试的五条进程查询用例需在不受本 agent 沙箱限制的环境复核。需要确认的问题：无。

最终复跑确认：python3 .sdd/spec-check.py 退出 1，仍为 16 条 review 阻断、18 条警告；与上述原因一致。追加本节后的 pnpm format:check 通过，源码最终 pnpm lint、pnpm typecheck 通过；无未恢复的突变、临时源码或调试打印。

## 2026-11-08 · C 段真沙箱补正（lead）

- 验收 12 两条黑盒在 macOS 与 Linux 真沙箱上都红，但写入其实都被拒了：`lab.run` 把 stderr 并进 stdout，被拒时 shell 打的报错被断言当成「意外输出」。把每次写入尝试的报错丢到 `/dev/null`，只认显式的 `unexpected write` 标记。改后 macOS 上 4/4 绿；换回 6254700 的生产代码时 4/4 红（报 `unexpected write: .husky/pre-commit`，写入真的成功了）。
- 测试改动：apps/desktop/test/sandbox/escape.test.ts · 04 验收 9 (linux) 的 `ROOT_LEAVES` · C 段让 16 个钩子名字在 Linux 根下不存在时也成为只读占位（规矩 7，P4 已接受的代价），名单补上这 16 个；只增不删，原 17 个不动。Lima u2404 上用同样两处改动的副本跑过，验收 12 两条与 04 验收 9 (linux) 都绿，跑完宿主上没有占位残留。

## 2026-11-08 · C 段按评审补充

起点为 lead 提交 5d2275a。通读两份 C 段评审原文后，只修改 C 段源码及其测试；本节记录当前进度和交接，按本次指令不改 plan。include 目标保护按 owner 本轮明确选择「也拦」实施，spec 修订记录由 lead 补。

### 按条处理

- C-security.md 第 1 条：apps/desktop/src/main/host/git-protection.ts 的 readConfig 跳过空 hooksPath；解出的位置存在且不是目录时也不放入 hookDirs，缺失的未来目录仍保留保护。文件工具与配置层分别覆盖空值、普通文件、/dev/null。apps/desktop/test/sandbox/escape.test.ts 另加「auto-tier-hardening 验收 12: disabling hooks with dev null preserves shell redirection」，由 lead 在 macOS 真沙箱验证。
- C-security.md 第 2 条：configEntries 在解析节头后继续解析同一行剩余键值；保留 core 子节区分，新增 core、include、includeIf 三种同一行写法，标题为「auto-tier-hardening 验收 9: section %s accepts a key on the same line」。
- C-security.md 第 3 条：readConfig 把已经解析存在的 include 目标写入 redirectExisting，不改 GitProtection 字段，也不把缺失 include 放入 redirectAbsent。每个已存在的路径拼法在去重和读取正文之前登记，因此重复链接拼法及读不出的配置来源仍会被保护。复用现有 buildFilesystem 的平台存在性与 04 链接处理；新增配置层用例覆盖普通 include、条件 include、嵌套 include、带父路径的末级链接、实际目标、缺失目标不占位及 Linux 的链接事后比对，另测读取失败时保留拒写和回退。
- C-security.md 第 4 条：验收 12 的根下与 macOS 子目录黑盒，在同一次命令末尾写普通 ok.txt，宿主逐字比对其内容；原有拒写标记、退出码、文件内容及占位清理断言保留。
- C-security.md 第 5 条：apps/desktop/test/sensitive-paths.test.ts 的 scope 显式传 xdgConfigHome: null；每个用例清空环境 XDG_CONFIG_HOME 并在退出时恢复，避免其他直接调用被宿主配置污染。新增「auto-tier-hardening 验收 9: test scope ignores the ambient XDG git config」，显式 XDG 夹具用例仍独立传入自己的配置目录。
- C-security.md 第 6 条：packages/kernel/test/permission/session-view.test.ts 中随 C 段带入的验收 8 用例属于 B 段补测，是 plan Open 已安排的跟进；本轮不修改 B 段源码或测试，不拆提交。
- C-tests.md 第 1 条：apps/desktop/test/sandbox/config.test.ts 新增「auto-tier-hardening 验收 15: %s preserves a fallback leaf link after parent traversal」，直接传入末级为链接的 fallbackDeny，两个平台都断言包含链接拼法和实际目标。
- C-tests.md 第 2 条：按要求不为等价或经发现入口不可观察的 A-N7/A-N9 补测试；评审另列的 C18/C20 同样不补。
- C-tests.md 第 3 条：新增「auto-tier-hardening 验收 15: unreadable git config marks the sensitive table incomplete」，只向 .git/config 的 open 端口注入 EACCES，断言 incomplete 为 true、有诊断且固定钩子名仍受保护；不依赖 chmod 或运行用户权限。
- C-tests.md 第 4 条：选择保留现有额外行为并补「auto-tier-hardening 验收 9: config.worktree hooksPath is parsed independently」，不删除已有解析。
- C-tests.md 第 5 条：在现有 includes/quotes/continuations/husky parent 用例中增加 incomplete: false，钉住 include 循环去重，区分深度上限回退。
- C-tests.md 第 6 条：与 C-security.md 第 4 条合并处理，两条黑盒都有普通文件成功对照。

### 失败测试与突变证据

修生产代码前，新边界用例运行结果为 13 failed、5 passed，失败均为断言失败，覆盖禁用 hooksPath 的过度保护、同一行配置、include 目标缺少拒写及环境 XDG 污染。修改后三个定向文件共 206 条通过。一次夹具修正：include 的端口收到保留父路径的拼法，故障注入按该简单路径的规范化结果匹配，确保 EACCES 确实发生；未为此修改生产规则。

每项突变都备份文件、单独修改、运行对应测试，在 finally 中恢复，不用 stash 或 checkout。关键输出如下；全部失败都含 AssertionError，未靠导入或编译错误杀死突变。

| 对应建议 | 撤掉或改变的行为 | 关键输出 |
|---|---|---|
| 安全 1 | 去掉空 hooksPath 跳过 | exit 1；2 failed |
| 安全 1 | 去掉已存在非目录排除 | exit 1；4 failed |
| 安全 2 | 节头后直接跳过剩余键值 | exit 1；3 failed |
| 安全 3 | 去掉 include 目标拒写登记 | exit 1；3 failed |
| 安全 3 | 将缺失 include 也记入已存在名单 | exit 1；2 failed |
| 安全 3 | 把拒写登记延到读取成功之后 | exit 1；1 failed |
| 安全 5 | 去掉 scope 的显式 null | exit 1；1 failed |
| 安全 5 | 去掉测试环境清空，在受控 XDG 配置下运行完整表对照 | exit 1；1 failed |
| 测试 1 | followLast 从 false 改 true | exit 1；1 failed、1 passed，Linux 丢失末级链接拼法 |
| 测试 3 | 去掉 git.incomplete 并入敏感表 | exit 1；1 failed |
| 测试 4 | config.worktree 仍读但不解析 hooksPath | exit 1；1 failed |
| 测试 5 | 去掉 configSeen 循环去重 | exit 1；1 failed |

恢复后的输出：exit 0；Test Files 3 passed；Tests 206 passed。12 项门禁层突变全部被杀且已恢复。黑盒的普通文件对照与 /dev/null 用例只做本轮规定的 lint/typecheck；其真实执行与移除对照写入后的失败验证留 lead 在沙箱外跑，不以静态检查冒充运行证据。

### 检查与交接

- pnpm format:check && pnpm lint && pnpm typecheck：通过。
- pnpm vitest run --maxWorkers=2 apps/desktop/test/sandbox/ apps/desktop/test/sensitive-paths.test.ts packages/kernel：125 个文件通过，3048 passed、118 skipped；真沙箱仍按既有门禁跳过，新增 /dev/null 黑盒只针对 macOS。
- git diff --check：通过。
- python3 .sdd/spec-check.py：当前退出 1，1 条阻断、17 条警告；阻断为本次改动没有新增正式提交绑定评审记录。本轮明确禁止新增以「## 评审」开头的标题，故仅记录未提交快照复核，不伪造登记、不改门禁。交接前会在追加本节后复跑。
- 新上下文只读审查独立快照，已对照两份原评审和本轮 diff 复核通过，无剩余具体问题；未运行真沙箱，不代替 lead 的正式提交绑定评审。

测试改动：apps/desktop/test/sensitive-paths.test.ts · scope 与用例环境 · 显式禁用外部 XDG 配置并恢复环境，保留受控 XDG 夹具，避免宿主配置影响结果。
测试改动：apps/desktop/test/sensitive-paths.test.ts · includes, quotes, continuations and husky parent use one parser · 增加 incomplete:false，区分循环去重与深度回退。
测试改动：apps/desktop/test/sandbox/escape.test.ts · 验收 12 根下/子目录黑盒 · 同一命令增加普通文件写入与内容断言，原拒写和清理断言不变。
测试改动：apps/desktop/test/sandbox/escape.test.ts · disabling hooks with dev null preserves shell redirection · 新增 macOS 平台用例，核对评审所指出的 Seatbelt 设备规则差异；未给已有测试增加跳过。

当前：代码与测试已完成，突变全部恢复，改动留在工作区，不提交；未改 spec、plan、decisions、evidence、门禁或 B 段代码。交接：lead 复核本次差异，运行增强后的验收 12 黑盒及 /dev/null 用例，补 spec 修订记录和正式提交绑定评审。需要确认的问题：无。

最终复跑确认：追加本节后的 format:check 通过；spec-check 退出 1，仍为缺少本次正式提交绑定评审记录这一条阻断、17 条警告。最终 diff --check 通过，HEAD 仍为 5d2275a，六个改动文件均留在工作区。

## 2026-11-08 · C 段按复核修订

起点为 lead 提交 0729ebb。通读 C-security-r2.md 与 C-tests-r2.md 原文后，按本轮指令只改 C 段源码、测试及本日志，不提交；当前与交接记在本节，不改 plan。

### 按条处理

- C-security-r2.md「这轮带进的新问题」第 1 条（major）：git-protection.ts 的 readConfig 恢复将普通文件、FIFO、socket 和缺失目标纳入 hookDirs；不再按“非目录”整体排除。空 hooksPath 继续跳过；设备例外只保留路径规范化及真实路径均为 /dev/null 的情形，避免放掉普通工作区或可替换链接。配置层两平台覆盖四类目标，文件工具覆盖普通文件位置下的 Write/Edit/Delete 自动执行分类。
- 第 1 条的黑盒：escape.test.ts 新增「auto-tier-hardening 验收 12: a hooks file cannot become a directory before host commit」。同一次沙箱命令尝试将普通文件换成目录并写 pre-commit，另写普通文件成功对照；宿主确认原文件保持不变，随后 commit 不产生钩子标记。最后由宿主实际换成目录、运行同一钩子并断言标记出现，验证夹具有效。本 agent 只做 lint/typecheck，真实执行与相应突变由 lead 在沙箱外跑。
- C-security-r2.md「这轮带进的新问题」第 2 条（建议）：include /dev/null 在登记来源、读取正文之前当作空配置返回，不进拒写名单，不报发现不完整；同文件后面的 hooksPath 仍解析。新增配置层两平台及文件工具发现用例。
- C-security-r2.md「这轮带进的新问题」第 3 条（建议）：每个 hooksPath 的解析单独包在 attempt 中，单条失败只记 incomplete，继续解析后续 hooksPath 与 include；保留 .git 回退及具体路径诊断。
- 第 3 条的文件工具部分：按本轮“两条建议照改”的要求，采用评审推荐的收紧方向，把已经发现的 redirectExisting 来源并入自动执行敏感表。保留末级链接本身（Delete）与实际目标（Write/Edit），发现不完整也不丢弃已找到的来源；不覆盖已有凭据分类。新增 Write/Edit/Delete 每次询问、自动档及 always-allow 仍询问、Read/Glob/Grep 正常、直接访问实际目标和部分发现用例。没有改变 GitProtection 字段或顶层配置登记条件。
- C-tests-r2.md「三、发现」第 1 条（I5）：在「auto-tier-hardening 验收 12: %s denies existing include spellings and targets」中，同一 shared.gitconfig 先用普通拼法 include，再经 storage/shared-link.gitconfig 链接 include。断言两个拼法都拒写；替换链接后一次读取 violations，分别验证两个链接的 Linux 事后比对。原有嵌套 include、条件 include、缺失目标和另一条末级链接断言保留。
- C-tests-r2.md「三、发现」第 2 条（I2）：按本轮要求不处理，不增加顶层配置文件登记，也不补 spec 未规定的取舍断言。

### 先红后绿、范围比较及独立复核

修生产代码前，新增回归在 0729ebb 上为 9 failed、3 passed，均为断言失败；文件工具 include 用例先为 2 failed。针对 major，用 git show 5d2275a 的原始字节临时覆盖 git-protection.ts，保留本轮测试，运行 replaceable hooksPath：5 passed；恢复本轮生产版本，连同上一轮空值及 /dev/null 边界运行：9 passed。备份与恢复不用 stash 或 checkout。

新上下文只读审查独立临时快照，发现最初采用的 /dev/ 前缀例外过宽，会排除 /dev/shm 中的普通工作区。新增「auto-tier-hardening 验收 12: dev shm %s hooks and ordinary include keep protection」三格配置层回归先为 3 failed；将例外收窄至 /dev/null 后为 3 passed，两平台均检查目录/普通文件/其他节点钩子及 include 来源和其中解析出的钩子。最终快照复核通过，无剩余具体发现；未运行真实沙箱，不代替 lead 的正式提交绑定评审。

### 突变证据

每次只撤掉或改变一项保护，运行对应新用例，然后在 finally 中恢复。全部失败均为 AssertionError，不是导入、类型或启动错误。命令均使用 pnpm vitest run --maxWorkers=2；配置层在 desktop-sandbox.test.ts，文件工具层在 sensitive-paths.test.ts。关键输出如下：

| 对应条目 | 突变 | 输出 |
|---|---|---|
| 安全发现 1 | 恢复 found.kind 非目录跳过 | exit 1；4 failed、1 passed |
| 安全发现 1，保留边界 | 去掉空 hooksPath 跳过 | exit 1；2 failed |
| 安全发现 1，保留边界 | 去掉 /dev/null hooksPath 例外 | exit 1；2 failed |
| 安全发现 1，范围比较 | 把精确 /dev/null 例外扩大为 /dev/ 前缀 | exit 1；3 failed |
| 安全发现 2 | 去掉 include /dev/null 空配置处理 | exit 1；3 failed |
| 安全发现 3 | 去掉 hooksPath 条目级 attempt | exit 1；2 failed |
| 安全发现 3，文件工具 | 不消费已发现配置来源 | exit 1；3 failed |
| 安全发现 3，文件工具 | 链接条目解析改为跟随末级链接 | exit 1；1 failed |
| 安全发现 3，文件工具 | 不登记配置来源实际目标 | exit 1；1 failed |
| 安全发现 3，文件工具 | incomplete 时丢弃已发现来源 | exit 1；1 failed |
| 测试发现 1（I5） | existing.add 移到 configSeen 去重之后 | exit 1；2 failed |
| 测试发现 1，Linux 事后比对 | 不跟踪新增 shared-link 链接 | exit 1；1 failed、1 passed |

~~~text
5d2275a-range exit 0
Tests 5 passed
current-range-and-boundaries exit 0
Tests 9 passed
restored exit 0
Tests 16 passed
RESTORED exit 0
Test Files 1 passed
Tests 107 passed
~~~

12 项门禁层突变全部被杀且已恢复。关键原始输出留在 /tmp/hardc-r3-proof-final-summary.log 与 /tmp/hardc-r3-file-mutation-summary.log；各突变完整输出为 /tmp/hardc-r3-<突变名>.log。新黑盒的执行和撤掉保护后的失败验证仍由 lead 在沙箱外完成，不以本轮静态检查代替。

### 测试改动与最终检查

测试改动：apps/desktop/test/sandbox/desktop-sandbox.test.ts · disabled hooksPath 与 replaceable hooksPath · 将旧 disabled-hooks 普通文件的“不拒写”预期改由正向拒写用例覆盖，纠正复核指出的保护回退；保留空值和 /dev/null 原边界，并增加 FIFO/socket/缺失目标。
测试改动：apps/desktop/test/sensitive-paths.test.ts · disabled hooksPath 与 replaceable hooksPath · 同样纠正普通文件预期，验证文件工具分类；空值和 /dev/null 对照保持。
测试改动：apps/desktop/test/sandbox/desktop-sandbox.test.ts · denies existing include spellings and targets · 增加同一真实目标的第二种链接拼法及独立事后比对，violations 只取一次，避免消费结果后误判。
测试改动：apps/desktop/test/sandbox/desktop-sandbox.test.ts 与 apps/desktop/test/sensitive-paths.test.ts · 验收 9/12/15 的设备、解析失败及来源敏感用例 · 钉住空配置边界、条目隔离、部分发现保留和文件工具每次询问。
测试改动：apps/desktop/test/sandbox/escape.test.ts · a hooks file cannot become a directory before host commit · 增加普通文件替换拒写黑盒、普通写入成功对照及宿主钩子确实执行的正向对照；未给已有用例增加跳过。

- pnpm format:check && pnpm lint && pnpm typecheck：最终版本通过。首轮 lint 指出新增夹具拼接纯字面量，已合并字符串并重新通过整条门禁。
- pnpm vitest run --maxWorkers=2 apps/desktop/test/sandbox/ apps/desktop/test/sensitive-paths.test.ts packages/kernel：exit 0；125 个文件通过，3062 passed、119 skipped；真沙箱按既有条件跳过。完整输出为 /tmp/hardc-r3-final-tests.log。
- python3 .sdd/spec-check.py：exit 1；1 条 review 阻断、17 条警告。阻断仍为本次未提交改动没有新增正式提交绑定评审标题；遵守本次不提交及上轮禁止“## 评审”标题的要求，不伪造登记或修改门禁。其余警告包括已有文档关系、测试报告缺失、plan 未更新及测试改动提醒。
- git diff --check：通过。新上下文静态复核通过；所有突变恢复，工作区不含临时探针、调试打印。

当前：两份复核原文要求的本轮代码与配置层/文件工具测试均已补齐，改动只在工作区，HEAD 仍为 0729ebb；未改 spec、plan、decisions、evidence 或门禁文件。交接：lead 在 macOS 与 Linux/Lima 沙箱外执行新增验收 12 黑盒及对应突变，核对最终差异，完成正式评审登记与提交绑定。需要确认的问题：无。

## 评审 · 2026-11-08 · 审过 fa89884

方式：实现者是 Codex（gpt-6.1-sol）；两路新上下文评审由 Claude 做（对照 spec 与安全一路，测试与突变一路），各在自建的临时 worktree 里取证。三轮：第一轮对准 5d2275a，两路都通过并各留建议；Codex 按建议补成 0729ebb，复核时安全一路判不通过（1 条 major，测试一路通过）；Codex 再修为 fa89884，第二次复核两路都通过。各轮评审原文在私有笔记 `impl-reviews/C-security*.md`、`C-tests*.md`，这里只记结论与处置。

平台证据（旧红新绿）：
- macOS：验收 12 的四条黑盒在 6254700 的生产代码上 4/4 红（`unexpected write: .husky/pre-commit`）；fa89884 上 escape.test.ts 120 通过、0 失败。
- Linux（Lima tenon-u2404）：验收 12 两条在 6254700 的生产代码上都红；fa89884 上 escape.test.ts 49 通过、0 失败，04 原有用例没有变红，跑完宿主上没有占位残留。
- 沙箱外全量 vitest（fa89884）：285 个文件、5754 条通过、0 失败。
- lead 在 5d2275a 补正两处测试：验收 12 黑盒误把拒写报错当成意外输出；04 验收 9 (linux) 的 `ROOT_LEAVES` 补 16 个钩子名字（见上文「C 段真沙箱补正」）。

发现：
- [建议] 安全评审第一轮建议 1、2、4、5、6（原文 C-security.md） · 已修 0729ebb
- [建议] 安全评审第一轮建议 3：保护范围要不要包括已存在的 include 目标（owner 定「也拦」，见 picks.md） · 已修 0729ebb
- [major] 安全评审复核：建议 1 的修法使保护范围小于 5d2275a（原文 C-security-r2.md） · 已修 fa89884
- [建议] 安全评审复核的两条建议（原文 C-security-r2.md） · 已修 fa89884
- [建议] 安全评审第二次复核的一条建议（原文 C-security-r3.md） · 不修：记 plan Open，D 段或后续处理
- [建议] 测试评审第一轮建议 1–6（原文 C-tests.md） · 已修 0729ebb
- [建议] 测试评审复核：同一 include 目标两种拼法的夹具（原文 C-tests-r2.md） · 已修 fa89884
- [建议] 测试评审第二次复核：三个存活突变对应的用例缺口（原文 C-tests-r3.md，均为低影响或几乎不可达） · 不修：记 plan Open

结论：通过

突变：第一轮新做 28 个、重放 A/B 段 7 个，存活 8 个（实质 4 个，0729ebb 补测试后全杀）；第一次复核 15 个、存活 2 个（fa89884 补后杀 1 个，另 1 个偏严、spec 未定）；第二次复核 13 个、存活 3 个，记入 plan Open。保护范围对照（同一批夹具在 5d2275a 与 fa89884 的生产代码上各跑一遍）：除三处有意的豁免外不小于 5d2275a。


## 2026-11-09 · D 段文档同步与收口

范围：接自 dev `6661dfb`，按 brief-hardD 只改文档，不提交、不改 Status 或门禁。02/03/04/05 的 Changed by 与总参考接手三行已在步骤 1 合入，本次逐条核对，冻结正文未改。SECURITY.md 同步本 spec §对 04 的增补「已知限制」、§给 06 的约束与 §对 05 的增补，移除把受保护钩子和已发现指针配置描述为未保护的旧说法。

spec 正文与修订记录按 plan Open 分项记清：owner「也拦」的已存在 include 来源（沙箱与文件工具）、lefthook 本地配置和脚本目录、hooksPath 最终取值与设备边界、含 `..` 的拒绝路径拼法。修订只澄清或收紧已实现规则，不修改冻结的旧 spec 正文。05 验收 45 的 CI 清理偶发红并入总参考 §以后再说，保留“观察、未定因”，未把它写成已修复。

C 段原 Open 核对：验收 8 的冻结表四格跟进、内部错误的路径与原因、模块/末级链接及目录型 .git 回退、startupEnv 的 XDG_CONFIG_HOME 接线，均已在 C 段实现与正式评审记录中有对应证据，故移出待办。C 段第二次复核遗留的一条链接删除建议、三个存活突变及 root 下 chmod 用例保留为后续事项；本段不改代码、不新增测试。

### 验收逐条核对

测试的完整标题与路径见 plan §验收矩阵；下表核对要求、断言和既有平台证据。新工作区仅重跑不进 OS 沙箱的相关套件，真实平台结论引用 A/C 段正式评审，未把本次跳过当通过。

| 验收 | 核对的断言与证据 |
|---|---|
| 1 | 已有指针、实际目标与子模块 config/hooks 拒写；跨根、srt 默认可写目录均有配置测试；A 段正式评审记录 macOS/Linux 黑盒通过及 fsmonitor 对照。 |
| 2 | macOS 不存在的 commondir/config.worktree 与子目录 .git 进入拒写，黑盒检查目标不变及 fsmonitor 未执行；A 段正式评审通过。 |
| 3 | 完整发现不触发回退，平台配置对照保留正常根 git 与子模块提交、Linux 无转向占位；A 段两平台黑盒通过。 |
| 4 | Linux 配置不收缺失转向条目或子目录 git glob，黑盒明确断言两类新建成功；这是限制的表征，A 段 Linux 已跑。 |
| 5 | 任务/对话两条回环：总是允许的跨源调用先暂停，答复前不外发、批准后仅本次派发、后次再问；B 段正式评审通过。 |
| 6 | 任务/对话未读连接器时直接派发无审批；B 段正式评审确认旧实现也绿，正常对照成立。 |
| 7 | 同源私密来源集合不含别处时不出外带卡；单元断言及 B 段恒真突变证据对应。 |
| 8 | 两形态冻结表来源去重、关联失败 unresolved、连接器不跌入内置分类；C 段补同键首条/缺引用表/组合键四格回归。 |
| 9 | 仓库与全局 hooksPath 写入判 auto-run，决策仍 ask/once，原因显示自动执行；含 include、XDG、设备和部分发现的边界测试。 |
| 10 | 任意深度固定钩子名，Write/Edit/Delete 每次问、读查找正常；固定 .husky 的突变已由 C 段杀死。 |
| 11 | my-hooks 未配置为 workspace，配置后 auto-run；空值与精确 /dev/null 不把普通文件误判敏感，core 子节不误认。 |
| 12 | 配置测试覆盖根名字、精确目录、macOS 子目录 glob；已有/新建黑盒含普通写成功对照，Linux afterExit 后无占位；C 段正式评审记录 macOS 120/Linux 49 条全套通过。 |
| 13 | 仅目标连接器的不可信来源加 local 私密仍出卡；同源只读连接器回环及连接器原名 WebFetch 的 URL 对照防止注解或名字放宽。 |
| 14 | 子读交接父、父读传子、父子同读三条回环核对来源并集去重与单次卡；已有跨会话外带两条保留。 |
| 15 | 目录型/指针型故障注入核对整个 .git 或指针+gitdir+commondir 回退、日志路径与原因；宿主成功、仅注入期间沙箱提交失败、关掉注入恢复、Linux 无新增占位；A 段两平台正式评审有证。 |

### 突变登记说明

下面把 A/B/C 段已有突变的行为与本次静态核对的边界规范化为机器可重放片段，补齐 plan 的编号。原文均与当前实现逐字核对、只出现一次，门禁只登记 `test`；不登记只在真沙箱或 macOS 能观察的突变。本次 D 段没有修改生产代码或执行新突变；各块的“依据”区分已有失败证据与待机器重跑的静态登记，不把候选片段冒充本轮实跑结果。

### 突变 M1 · auto-tier-hardening 验收 1 · 门禁 test

依据：撤掉已有指针本身的拒写；A 段实现「检查证据」记录验收 1 复现断言失败。

文件：apps/desktop/src/main/host/sandbox-config.ts
原文：
```
          ...root.git.redirectExisting,
```
改成：
```
          ...root.git.redirectExisting.filter((path) => !path.endsWith('/.git')),
```

### 突变 M2 · auto-tier-hardening 验收 2 · 门禁 test

依据：撤掉 macOS 尚不存在的转向条目；验收 2 复现核对 commondir/config.worktree 拒写。

文件：apps/desktop/src/main/host/sandbox-config.ts
原文：
```
        if (darwin) writeDenied.push(...root.git.redirectAbsent)
```
改成：
```

```

### 突变 M3 · auto-tier-hardening 验收 3 · 门禁 test

依据：把 macOS 的缺失条目错误地传给 Linux；验收 3 的平台分支对照核对 Linux 不收缺失转向文件。

文件：apps/desktop/src/main/host/sandbox-config.ts
原文：
```
        if (darwin) writeDenied.push(...root.git.redirectAbsent)
```
改成：
```
        writeDenied.push(...root.git.redirectAbsent)
```

### 突变 M4 · auto-tier-hardening 验收 7 · 门禁 test

依据：跨源私密条件恒真；B 段「旧红新绿与突变证据」记录验收 7 断言失败。

文件：packages/kernel/src/permission/exfiltration.ts
原文：
```
    view.privateSources.some((privateSource) => privateSource !== source) &&
```
改成：
```
    true &&
```

### 突变 M5 · auto-tier-hardening 验收 5、13 · 门禁 test

依据：跨源私密条件恒假；B 段「旧红新绿与突变证据」记录验收 13 断言失败，验收 5 同样要求跨源出卡。

文件：packages/kernel/src/permission/exfiltration.ts
原文：
```
    view.privateSources.some((privateSource) => privateSource !== source) &&
```
改成：
```
    false &&
```

### 突变 M6 · auto-tier-hardening 验收 8 · 门禁 test

依据：来源关联不上时丢弃污点；B 段「旧红新绿与突变证据」记录同类从严判定突变使验收 8 的七个分支失败。

文件：packages/kernel/src/permission/session-view.ts
原文：
```
    if (origin === null || origin.source === 'mcp') {
```
改成：
```
    if (origin === null) continue
    if (origin.source === 'mcp') {
```

### 突变 M7 · auto-tier-hardening 验收 14 · 门禁 test

依据：漏合并父子私密来源；B 段「旧红新绿与突变证据」记录验收 14 断言失败。

文件：packages/kernel/src/loop/batch.ts
原文：
```
  const privateSources = [...new Set([...ownView.privateSources, ...related.privateSources])]
```
改成：
```
  const privateSources = [...ownView.privateSources]
```

### 突变 M8 · auto-tier-hardening 验收 9 · 门禁 test

依据：撤掉文件工具的自定义钩子目录匹配；C 段「旧红新绿与突变证据」记录验收 9 两条失败。

文件：packages/kernel/src/permission/workspace.ts
原文：
```
  if (paths.some((path) => list.hookDirs?.some((dir) => within(path, dir)))) return 'auto-run'
```
改成：
```
  if (false) return 'auto-run'
```

### 突变 M9 · auto-tier-hardening 验收 10 · 门禁 test

依据：从固定名单去掉 .husky；C 段「旧红新绿与突变证据」记录验收 10 失败。

文件：apps/desktop/src/main/host/git-protection.ts
原文：
```
  '.husky',
```
改成：
```

```

### 突变 M10 · auto-tier-hardening 验收 12 · 门禁 test

依据：撤掉沙箱精确钩子目录的拒写；C 段「旧红新绿与突变证据」记录撤掉钩子消费时验收 12 复现失败。

文件：apps/desktop/src/main/host/sandbox-config.ts
原文：
```
          ...root.git.hookDirs,
```
改成：
```

```

### 突变 M11 · auto-tier-hardening 验收 15 · 门禁 test

依据：撤掉不完整发现的从严拒写；验收 15 的目录型与指针型配置测试核对回退范围。

文件：apps/desktop/src/main/host/sandbox-config.ts
原文：
```
          ...root.git.fallbackDeny,
```
改成：
```

```

### D 段检查

- 新工作区先运行 `pnpm install --frozen-lockfile`：无 TTY 首次退出，设置 CI=true 后依赖安装完成，但 prepare 的 lefthook install 替换主仓库 `.git/hooks/pre-commit` 被沙箱拒绝，退出 1；没有跳过或改动 hooks。随后单独 `pnpm build` 成功，之后才运行 typecheck。所有 pnpm 命令设置 `NPM_CONFIG_USERCONFIG=/dev/null`。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck` 全部退出 0。
- `TENON_SANDBOX_TESTS=skip pnpm vitest run --maxWorkers=2 apps/desktop/test/sandbox/config.test.ts apps/desktop/test/sandbox/desktop-sandbox.test.ts apps/desktop/test/sandbox/desktop-sandbox-fs.test.ts apps/desktop/test/sensitive-paths.test.ts packages/kernel/test/permission/session-view.test.ts packages/kernel/test/permission/exfiltration.test.ts packages/kernel/test/loop/mcp-exfiltration.test.ts packages/kernel/test/loop/subagent-security.test.ts`：8 个文件、287 条通过，0 失败。没有启动 Electron、真实沙箱、VM 或模型调用。
- `python3 .sdd/spec-check.py --index` 已执行；首轮 `python3 .sdd/spec-check.py` 拦 0。自身新增的 SECURITY.md 长行警告已拆行，最终结果在收尾时补记。
- overview 不需同步：接口处只补齐已实现的字段说明与来源注释，未改变模块边界、契约类型、数据流或技术栈；02/03/04/05 冻结正文保持原样。

## 2026-11-09 · D 段独立文档复核

方式：按 AGENTS.md 核心第 8 条，在新上下文子 agent 的独立临时快照中只读审查，不与原工作区并行开发。对照 brief、spec、plan、既有实施日志、源码与测试，覆盖文档要求、安全边界与验收/突变映射。未提交，故绑定文档差异 SHA-256 `1cee4602bea12f0c17d2f205c712d03c102d38b30a716034ee89b2554688e79a`，不冒充某个实现提交的正式评审。

发现与处置：
- SECURITY 的“文件工具每次写都问”可能被读成包括尚未识别的 hooksPath 链接拼法；已明确为 recognized hook locations，保留 plan Open 的末级链接 Delete 建议。新上下文在更新后的同一快照中实际复核通过。
- 矩阵旧说明按“用例名标黑盒”区分运行层，与实际标题不符；已改为 escape.test.ts 的真沙箱用例，并经同一上下文只读复核。

核对结论：安全文档覆盖 §对 04 的增补六条限制、§给 06 的约束与 §对 05 的限制，保留平台差异和未实测范围；四行修订覆盖原 Open 全部 D 段事项；矩阵标题均在测试中存在，突变原文各唯一匹配、替换静态对应所称验收；冻结的 02–05 没有差异；总参考保留偶发红的观察性质。overview 无需同步：只有已实现字段与配置来源的说明细化，未改变模块边界、接口类型、数据流或技术栈。

结论：通过，无剩余阻塞。

突变：D 段只登记 11 个可重放片段，未执行新突变、未改生产代码；既有失败证据与静态登记已分别注明。C 段遗留三个存活突变及一条链接删除建议继续留在 plan Open，未宣称解决。

收尾：步骤 5–8 已勾，步骤 9 留 owner；当前与交接已重写。依 brief 不提交，不改 ready 状态。最终入口页、format 与 spec-check 结果见下方补记。

最终补记：最终 plan 更新后已重新执行 `python3 .sdd/spec-check.py --index`；`pnpm format:check`、`git diff --check` 通过；`python3 .sdd/spec-check.py` 退出 0，拦 0 条、警 11 条（既有索引关系、其他 feature 的 notes、缺少 CI 报告及已解释的 overview 提醒）。工作区仅六个预期 Markdown 文件，无未跟踪探针，02–05 与 HEAD 逐字相同；未提交、未改门禁或 Status。
