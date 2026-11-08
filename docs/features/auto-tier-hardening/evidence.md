# 开自动档前的加固 · evidence

## E1 · srt 0.0.79 的 deny 通配会把根下 `.git` 一起拦

`@anthropic-ai/sandbox-runtime@0.0.79` 的 `globToRegex` 把 `**/` 转成 `(.*/)?`，`denyGlobRegex` 再在末尾加 `(/.*)?`（一手来源：`dist/sandbox/sandbox-utils.js` 的 `globToRegex`、`denyGlobRegex`）。所以 `<根>/**/.git` 会连根下的 `.git` 一起匹配，等于整个 `.git` 只读。只拦子目录要写 `<根>/*/**/.git`（至少隔一层）。macOS 用这条 glob 挡子目录新冒出的 `.git`（P1 证实有效且不误伤根）。
什么时候重核：升级 sandbox-runtime 大版本时。

## E2 · Linux 上 srt 给不存在的拒写叶子加 `/dev/null` 占位

Linux 后端对还不存在的 denyWrite 叶子用 `--ro-bind /dev/null <叶子>` 占位（一手来源：`dist/sandbox/linux-sandbox-utils.js`，非存在路径分支 `:2108-2120`、`isStaleBwrapMountPoint`、`cleanupBwrapMountPoints`）。命令运行期间宿主上出现一个空的 0444 文件；正常退出由 `cleanupBwrapMountPoints` 在「没有别的沙箱在跑时」删掉，被 SIGKILL 时内存里的记录丢失、占位留在宿主上。git 读到这个存在但为空的 `commondir` 会报错。P2 实测证实。
什么时候重核：升级 sandbox-runtime 大版本时（srt #693「bwrap 挂不到链接上」若发布，重核链接与占位行为）。

## E3 · husky / lefthook / pre-commit 的钩子装法

- husky 9.1.7：安装后 `core.hooksPath` 一般指 `.husky/_`，git 运行 `.husky/_/pre-commit`，它 source 用户写在 `.husky/` 下的脚本（如 `.husky/pre-commit`）。所以解析 `core.hooksPath` 得到 `.husky/_` 时，其父目录 `.husky/` 也要算（用户脚本在那）。一手来源：husky 9 文档与 `.husky/_` 的生成脚本；picks.md「当天核过」。
- lefthook 2.1.14（本仓库现装版本）：默认读仓库根的 `lefthook.yml`，同族还有 `.lefthook.yml` / `lefthook.yaml` / `.lefthook.yaml` / `lefthook.toml` / `lefthook.json`；本地覆盖文件 `lefthook-local.yml`（及同族）。脚本目录由 `source_dir` 定，默认 `.lefthook/`、本地 `.lefthook-local/`。
  一手来源：lefthook 2.1.14 的 README「Local config」一节与 `schema.json` 的 `source_dir`/`source_dir_local` 默认值、二进制里的 `lefthook.yml`/`lefthook-local`/`core.hooksPath` 字符串（`node_modules/.pnpm/lefthook-darwin-arm64@2.1.14/.../bin/lefthook`）。
- pre-commit：读仓库根的 `.pre-commit-config.yaml`（pre-commit 官方配置文件名）。
`.husky/`、lefthook 一族与脚本目录、`.pre-commit-config.yaml` 由各自工具读取执行，按名字无条件算 auto-run（owner 卡 3「再加 .husky/」、Codex 评审 1：`.husky/` 不以是否配 hooksPath 为条件）。`core.hooksPath` 指向的目录另按解析结果算（验收 9、11 用一个自定义目录测解析，不再拿 `.husky` 当未配置对照）。
什么时候重核：husky 或 lefthook 换掉默认钩子目录/配置文件名的大版本时。

## E4 · 连接器的「来源」按 serverId 判，从冻结工具表取

`ToolOrigin = { source: 'builtin' | 'mcp'; serverId: string; originalName: string }`（一手来源：`packages/kernel/src/tape/entry.ts:334`）。连接器工具 `source === 'mcp'`，每台 server 由 `serverId` 标识（`packages/kernel/src/tools/mcp-source.ts:43`、`registry.ts` 的 `BUILTIN_SERVER_ID`）。会话视图现算、按来源标记、不扫内容（`session-view.ts` 的 `buildSessionView`：`untrustedSources` 只对 WebSearch/WebFetch 加；`privateRead` 只认 Bash/Read/Grep 且仅 cowork 形态）。

**派发事实里没有来源字段**（Codex 评审 3，纠正草稿「只看 dispatch 的工具来源」的说法）：`DispatchCommittedPayload = CallRef & { name; argsHash; decisionKey; writer }`，身份 `(runId=sourceId, requestSeq=sourceSeq, ordinal)`（`tape/entry.ts:490`、`tape/names.ts` 的 `execution/dispatch_committed`、`loop/batch.ts` 的 `dispatchEntryFor`）。
来源要从冻结工具表关联：`view/assembled` 按 `(runId, requestSeq)` 记 `tools: { tableKey, sent } | null`（`tape/entry.ts:356`、`tape/provenance.ts` 的 `assembledKey`），`view/tool_table` 的 `tools[]` 是 `Array<ToolOrigin & { name; … }>`（`tape/entry.ts:335`）。
所以：拿派发事实的 `(runId, requestSeq)` 找 `view/assembled` → `tools.tableKey` → `view/tool_table` → 用派发事实的 `name`（发给模型的映射名，内置工具 `name === originalName`，连接器 `name = serverId__originalName` 或其哈希）在 `tools[]` 里对上那项，得 `ToolOrigin`。`buildSessionView` 本来就把整段 entries 读进来了，可一次建好 `name → origin` 表。
关联不上（旧会话缺这两条事实、摘要请求 `tools` 为 null、名字对不上）→ 记 `unresolved:<name>`，按连接器从严（不可信 + 私密 + 出口）。不新增任何 Tape 事实，兑现「不改 Tape、旧会话兼容」。
什么时候重核：MCP 工具来源模型（ToolOrigin）、`view/assembled`/`view/tool_table` 的载荷或键，或 `dispatchEntryFor` 变化时。

## E5 · trace、red-on-base 与 CI 各作业实际怎么跑沙箱用例

只读核过 `.sdd/spec-check.py` 与 `.github/workflows/ci.yml`（Codex 评审 7），四件事：
- **test_titles 认 `it.each`**：`JS_TITLE_RE`（`\b(?:it|test|describe|…)(?:\s*\.\s*\w+(?:\s*\(…\))?)*\s*\(\s*['"\`]`）在关键词后允许 `.each(…)` 再接标题串，所以 `trace` 能把 `it.each(PROFILES)('… 验收 N …')` 和单行 `it('… 验收 N …')` 都对上验收号。之前以为认不出，纠正。
- **trace 读 CI 报告**：`chk_trace` 读 `.sdd/config.json` 的 `test_reports`（`reports/vitest.json`、`reports/vitest-macos.json`）。这两份分别来自 ci.yml 的 `ci` 作业（ubuntu-24.04，`TENON_SANDBOX_TESTS: required`，跑全量含 escape.test.ts 的 Linux 沙箱用例）与 `sandbox-macos` 作业（macos-15，required，跑 escape.test.ts 等）。所以沙箱用例在 CI 上真跑、真出报告，`trace` 能看到它们通过。
- **red-on-base 跑 `test` 门禁（跳过沙箱）**：`mode_red_on_base` 在临时 worktree 里跑 `unit_gates`（即 `.sdd/config.json` 的 `test` = `TENON_SANDBOX_TESTS=skip …`），沙箱黑盒用例被跳过，状态 `skipped`。
- **new_repro_names 只认带「复现」且 `it(`/`test(` 直接接串的名字**（`\b(?:it|test)\s*(?:\.\w+)?\s*\(\s*['"\`].*?复现`）：被它选中的用例，若在旧代码上是 `skipped`（或导入失败），`mode_red_on_base` 判「不是断言红」而**拦**。注意这条正则不匹配 `it.each(args)(…)`（`.each` 后是 `(args)` 不是引号）。

落到做法（照 Codex 复核 r2 第 1 条，不靠去掉「复现」二字过检查，而是调整测试分层）：
- 每个缺口都补一条**能被 `test` 门禁执行的失败复现**，写成单行 `it('auto-tier-hardening 验收 N 复现：…')`：沙箱配置的缺口（验收 1、2、12）放在 `apps/desktop/test/sandbox/desktop-sandbox.test.ts`，经现有的 `DesktopSandbox.wrap` 入口——该文件用假 srt 截下 `customConfig.filesystem`、配假磁盘、不进沙箱门禁（已核 `fakeSrt` 与 `tables(h)` 辅助）——核对交给 srt 的拒写配置；连接器缺口（验收 5）放在 kernel 回环测试；钩子缺口（验收 9、10）放在 `sensitive-paths.test.ts`，经现有的 `desktopSensitivePaths` + `locatePath`。
- 这些复现只经 dev 上已有的入口、不 import 本 spec 新增的 `git-protection.ts`，所以在 dev 上是断言失败（拒写配置里缺对应条目、该出的卡没出），不是缺少新模块的导入失败；`red-on-base` 能选中并核验它们。
- 真沙箱黑盒用例（escape.test.ts）保留全部行为断言，作为验收 1、2、3、4、12 的对应验收，由 CI 的 `ci`/`sandbox-macos` 作业以 required 跑；它们在 `red-on-base` 里被跳过，所以不登记为复现，两平台「旧红新绿」由 lead 在 dev 与段提交上各跑一次、记进 log.md。
- 正常行为对照（验收 6 等）不带「复现」：`mode_red_on_base` 对登记为复现但旧代码上通过的用例会拦。
- 本 spec 不改任何门禁文件。
什么时候重核：`.sdd/spec-check.py` 的 `test_titles`/`new_repro_names`/`mode_red_on_base`、`.sdd/config.json` 的 `test`/`test_reports`、或 ci.yml 的测试作业改法时。

## P1 · macOS 兼容性与复现（真沙箱，srt 0.0.79）

**结果是「加某组 deny 后根 git 坏了」就改：把那组从 workspace-write 档删掉或改成只拦子目录。实际结果如下。**
2026-11-08 在 Claude 的 Bash 沙箱外、macOS 26.3 上用 `escape.test.ts` 的真沙箱夹具跑探针（draft-probe 里临时给 sandbox-config 加 `TENON_PROBE_GIT` 开关，未提交）。变体：V0 基线、V1=子目录 glob、V2=redirect+整目录+pointer、V3=四样全开、V4=子目录 glob+redirect+pointer+按文件拦模块内。原始 jsonl 在 probes/（见笔记）。

- 复现（四条 escape repro）：V0 四条全红（符合既有事实 4/4 红）；V3、V4 四条全绿（8/8，含对照）。保护生效。
- 根 git（status/add/commit/checkout/stash/log）：V0–V4 全绿，不受任何 deny 影响。✓ 规矩 2。
- `git submodule update`：V0 绿；凡带 redirect（拦 config.worktree）的 V2/V3/V4 → rc=128 `could not set 'core.worktree'`。坏。
- 子模块内 commit：整目录拦 `.git/modules`（V2/V3）→ rc=128；按文件拦（V4）→ 绿。→ D4 选 A（按文件拦）的依据：整目录拦（D4-B）才会坏子模块内提交，按文件拦不坏。
- `git worktree add`（工作区内）：V0 绿；任一保护变体（V1–V4）→ rc=128。坏（写 `.git/worktrees/<名>` 或新 worktree 的 `.git`）。注意这是 macOS 的结果；Linux 下 worktree add 照常（见 P2）。
- 子目录里新 nested 仓库的 commit：子目录 glob（V1/V3/V4）→ rc=128（glob 连 nested 的 `.git` 一起拦）；不带 glob（V2）→ 绿。这是 macOS 拦「子目录新 `.git`」的代价。
- `git submodule update --init`、linked-worktree 工作区的 add/commit：V0 就 rc=128（既有行为，与本 spec 的 deny 无关，不计入）。

结论：macOS 推荐 V4 形状（redirect + pointer + 子目录 glob + 子模块/worktree 按文件拦）——四条复现全绿、根 git 不坏、子模块内提交不坏；代价是 `git submodule update`、`git worktree add`、子目录新仓库 commit 在沙箱里失败，要在沙箱外跑（写进 §已知限制）。对应验收 1、2、3。
什么时候重核：改沙箱 deny 组成或升 srt 大版本时。

## P2 · Linux 兼容性与复现（Lima tenon-u2404 git 2.43.0、tenon-u2604 git 2.53.0）

**结果是「给不存在的转向文件加 deny 会坏正常 git」就改：Linux 只拦 wrap 时已存在的条目。实际结果如下，两个 git 版本一致。**
2026-11-08 在 Lima `tenon-u2404`（bwrap 0.9.0）与 `tenon-u2604`（bwrap 0.11.1，需先 `apparmor_parser -r /etc/apparmor.d/bwrap`）上跑同一套探针。变体：V0 基线、REDIR=拦 commondir+config.worktree、SAFE=只拦「wrap 时已存在」的转向文件（含已有 worktree/submodule 的 config/hooks/commondir、已有 `.git` 指针）。

- **REDIR（拦不存在的 commondir/config.worktree）两版 git 都灾难**：根 git（status/add/commit/checkout/stash/log）全部 rc=128 `failed to read .git/commondir`；命令运行期间宿主 `git status` fatal（读到空占位）；命令被 SIGKILL 后留下 `.git/commondir`、`.git/config.worktree` 的空 0444 占位，Tenon 下次 `afterExit`/startup 跑 srt 清理才清掉。
  证实 E2 的推断。→ Linux 不能拦不存在的转向文件（规矩 3、D5）。REDIR 的占位破坏是「给不存在的叶子加拒写」造成的，不是整目录方案造成的，别把这条证据套到 D4/D5 的整目录项上（Codex 评审 8）。
- **SAFE（只拦已存在）**：根 git 六项全绿、无占位、宿主 git 正常（linux-concurrent-host-git、linux-killed-placeholder 两场景 commondir/config.worktree 始终 missing、hostStatus ok）。✓ 验收 3。
- 复现（Linux 三条红 + commondir 已绿）：V0 基线下 commondir 复现本就绿（攻击在 Linux 普通仓库不成立），submodule、pointer、子目录 git init 三条红；SAFE 后 submodule、pointer 转绿，子目录 git init 仍红（拦不住，规矩 3）。→ 验收 1（pointer、submodule 两平台绿）、验收 4（Linux 子目录新 `.git` 未拦，表征）。
- SAFE 的代价：`git submodule update` rc=128（写被保护的子模块 config）；`git worktree add` 在 Linux SAFE 下**照常成功**（新 worktree 不在已存在条目里、不被拦）——与 macOS 不同，spec §已知限制按平台分开写（Codex 评审 8）。
- `git submodule update --init`、linked-worktree 工作区 add/commit：V0 就 rc=128（既有行为，不计入）。

结论：Linux 推荐「只拦已存在的转向文件」——submodule、pointer 复现转绿、根 git 不坏、无占位；拦不住「子目录新 `.git`」与「普通仓库新 commondir/config.worktree」，写进 §已知限制（D5）。对应验收 3、4。
什么时候重核：升 srt 大版本、或 srt #693 发布（链接/占位行为可能变）时。

## P3 · 对话形态私密与父子合并的判定依据

读 `session-view.ts` 与 `loop/batch.ts`：来源从冻结工具表取、不扫内容（E4）。「读到私密数据」在对话形态里原本永不成立（`privateRead` 只在 cowork 形态计本地读），本 spec 把「连接器结果算私密」扩到两形态（规矩 5、D7）——依据是连接器结果同样进了模型上下文，与形态无关。本地读（Bash/Read/Grep）仍只在任务形态记 'local'，因为对话形态没有工作区、Read 已被第 2 层限在落盘目录。
父子合并（Codex 评审 4）：`batch.ts` 的 `judgeCall`（`:1365-1391`）现把 `ownView` 与 `related`（父会话 + 交接回来的子会话）合并，对 `untrustedSources` 取并集、`touchedPrivateData` 取布尔或，其余字段取 `ownView`。
新增的 `privateSources` 必须一并取并集，`touchedPrivateData` 从合并后的 `privateSources` 是否非空算（否则会出现布尔真而来源集空）。继承口径照 02 §授权、工作区与外带检查的继承；现有 `subagent-security.test.ts` 的「child private reads … tighten the parent」与「a later child inherits …」两条要保留。
什么时候重核：会话形态、ToolOrigin 判法、或 `judgeCall` 的视图合并变化时。

## E6 · srt 的默认可写目录不在 Tenon 的 allowWrite 里

srt 0.0.79 在每次 wrap 时把 `defaultWritePathsUnder(...)` 与显式的 allowWrite 合并（一手来源：`dist/sandbox/sandbox-manager.js` 的 `defaultWritePathsUnder` 及其两处调用）。默认目录来自 `dist/sandbox/sandbox-utils.js` 的 `getDefaultWritePaths`：`SANDBOX_OWN_WRITE_PATHS`（含 `/tmp/claude`、`/private/tmp/claude`）加 `HOME_CONVENIENCE_WRITE_DIRS`（`~/.npm/_logs`、`~/.claude/debug`，没被 denyRead 盖住时）。04 §档位到 srt 配置 已记这几处「仍可写」。所以「不在 Tenon 的 allowWrite 里」不等于沙箱写不了；规矩 1 改为已解析出的指针目标一律按存在性规则进拒写名单，不按工作区根过滤（Codex 复核 r3 第 1 条）。
什么时候重核：升级 sandbox-runtime 时，或 `getDefaultWritePaths` 的列表变化时。

## P4 · Linux 上给尚不存在的钩子位置加拒写的代价（两台 Lima）

**结果是「占位破坏正常 git 或宿主上的提交」就改：在 spec 开放问题里写卡（A 照拦接受代价 / B Linux 上新建的钩子位置不拦），交 owner 定；结果是「代价与 04 已有占位同类、git 照常」就改：照 owner 卡 3 在 Linux 上也无条件拦，代价写进已知限制。**
2026-11-08 在 Lima `tenon-u2404`（git 2.43.0）与 `tenon-u2604`（git 2.53.0）上，用 `escape.test.ts` 的真沙箱夹具跑探针（临时 worktree 里给 sandbox-config 加 `TENON_PROBE_HOOKS` 开关，未提交，用完删掉）。夹具：普通仓库，`core.hooksPath=my-hooks`（目录不存在）；拒写工作区根下尚不存在的 `lefthook.yml`、`.pre-commit-config.yaml`、`.husky`、`my-hooks`。原始 jsonl 在 probes/（hp-u2404.jsonl、hp-u2604.jsonl）。两台结果一致：
- 命令运行期间：四个位置在宿主上都冒出空的 0444 文件。所测的都是根下的直接叶子，其中本该是目录的 `.husky`、`my-hooks` 也是文件；缺失中间目录时 srt 可能改用空目录占位，本次没测。
- 正常退出、清理被调用且没有别的活动 wrap 时：四个都清掉。这是单次实验；还有并发命令时 srt 会延后清理（E2），本次没测并发。
- 被 SIGKILL、没跑清理时：四个都留下；之后一次没有别的活动 wrap 的 `afterExit` 清掉。真正崩溃留下的残留按启动恢复处理（04 的占位记录）。
- 沙箱里：`git status --porcelain` 21 行未跟踪（04 已有的 17 个占位 + 新的 4 个）；`git add <路径>` + `git commit` 成功；`git add -A` 失败（04 已有占位本来就让它失败，04 §已知限制）。
- 宿主上：命令运行期间 `git status` 成功、列出这些占位；`git commit` 成功（hooksPath 指向的位置此时是个空文件，没有钩子可跑）；被强杀后同样能提交。
- lefthook 2.1.14：仓库用 `.lefthook.yml` 并已 `lefthook install`，`lefthook.yml` 是占位时，宿主上 `git commit` 在占位期间与之后都成功；占位期间 lefthook 是否照常执行 `.lefthook.yml` 里的命令未核验。
- pre-commit：两台 VM 都没装，未测。

结论：代价与 04 已接受的 17 个占位同一类，正常 git 操作两边都不坏 → 照 owner 卡 3 在 Linux 上也无条件拦，代价写进 spec §对 04 的增补「已知限制」，不另出开放问题卡。验收 12 覆盖「已有」和「新建」两种夹具。
什么时候重核：升级 sandbox-runtime，或钩子名单增删时。

## E7 · srt 在 Linux 上丢弃通配写规则

srt 0.0.79 的 `sandbox-manager.js → stripWriteGlobs` 在 `getPlatform() === 'linux'` 时，把含通配字符、又没有「名字读法」的 allowWrite / denyWrite 条目过滤掉，只记一条调试日志（一手来源：该函数，以及它对 allowWrite、denyWrite 的四处调用）。04 §档位到 srt 配置 已写「Linux 写规则不收 glob」。所以沙箱一侧对钩子名的保护，Linux 上只兑现到每个根下的字面路径与解析出的 `hookDirs`；子目录里同名的位置拦不住（spec 规矩 7、§对 04 的增补「已知限制」）。
什么时候重核：升级 sandbox-runtime，或 srt 开始在 Linux 上支持写规则的通配时。

