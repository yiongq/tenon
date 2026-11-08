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
