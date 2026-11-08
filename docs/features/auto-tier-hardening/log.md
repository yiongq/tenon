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
