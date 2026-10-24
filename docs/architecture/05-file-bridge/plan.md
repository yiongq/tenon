# 05 · plan

## 当前 / 需要你

当前：第八版已按 Codex 第三次复核改完（还在私有笔记里，没进仓库；第七版另存 `draft-r7/`）；owner 七轮问卷都已答，D58 已定 A。下一步是第 1.2 步：lead 把五份文件放进仓库。
需要你：读「给你看的一页」，回一句「05 改 ready」。

## 开工前读

- AGENTS.md；docs/spec-driven-dev.md 的「本项目补充」（第 5 条 StrykerJS、第 6 条预算检查点、第 7 条提示层评测基线）；本目录的 spec、decisions、evidence。
- 02 §可逆性、§内置工具的默认档位、§「在不在工作区里」、§内置工具与参数、§决策表与各层输入、§作用域与授权键、§提示层与评测；04 §档位到 srt 配置、§已知限制；presentation-r1 §审批卡、§结算行、§工具行。
- 实现三句（派实现子 agent 时原样带上）：测试有错就直说；不为某个用例写死结果；同一处反复跑红就停下报告。
- 平台与机密：e2e 不在 owner 的 Mac 上起窗口，走 CI 草稿 PR，或 Lima 虚拟机里 xvfb；探针与快照测试都用临时 HOME，不碰真实凭据；基线评测的 key 只从进程环境读，命令里只写变量名。

## 分段

| 段 | 分支 | 步骤 | 内容 |
|---|---|---|---|
| 一 | `feat/05-seg1` | 2–5 | 接口与判定（kernel 的 `adapter.ts`、`locatePath`、`decide` 第 6 层）、宿主的文件与快照子系统、保护名单的文件工具一半、选文件夹。不碰提示层 |
| 二 | `feat/05-seg2` | 6–12 | Tape 三个名字、判定前问能不能拍、调用前后的快照接进执行、守卫与拒写、Delete、提示层 12 与基线评测 |
| 三 | `feat/05-seg3` | 13–17 | 还原、路由、界面、e2e |

提示层的改动全在第二段：版本一升，CI 的 `evals:gate` 到基线记录提交之前是红的，所以升版本与基线评测必须在同一个 PR。Delete 的工具描述是提示层的一部分，所以 Delete 留在第二段；第二、三段之间 dev 上的 Delete 只留底、还不能从界面还原，dev 不发布，可以接受。

## 命令

- G：`pnpm format:check && pnpm lint && pnpm typecheck`
- T：`pnpm vitest run --maxWorkers=2`
- P：G、T 之后 `pnpm build && pnpm evals:gate --maxWorkers=2`
- E：e2e 只在 CI 草稿 PR 或 Lima 虚拟机里跑
- S：`python3 .sdd/spec-check.py`；改了页头与 plan 的「需要你」后 `python3 .sdd/spec-check.py --index`

## 步骤

- [ ] 1. 改 ready 之前
  - [x] 1.1 挑刺评审 r1（规则与证据面、机制与安全两份，2026-10-23）：结论与逐条处置记进 log.md；第二版已按处置改。
  - [ ] 1.2 lead 审第六版；把 spec、plan、log、decisions、evidence 放进 `docs/architecture/05-file-bridge/`（headers、notes、处置表、问卷稿只留私有笔记），同一个 PR 带上 spec「## 文档同步」列的「起草时」改动；跑 S，`pairs`、`codes`、`shape` 不拦。
  - [x] 1.3 补探针（2026-10-24）：P11、P17 在 macOS 与两台 Lima 上实测，P19 在 macOS 上实测，三条都走「照现稿写」那一支，结果已写进 evidence；P18（git 2.43 以下）仍未核实，留在 Open。
  - [x] 1.4 第二轮挑刺评审 r2（2026-10-24，机制、规则与处置核对）：1 blocker、4 major、4 建议；处置见 log；第四版已按处置改。
  - [x] 1.5 owner 定第二批问卷（2026-10-23）：D8=A、D12=A、D13=A 逐张确认；D32、D33、D37 照推荐；D45 选 B、D46 选 B。第三版已照此改 spec、验收与本 plan。
  - [x] 1.6 owner 回 D48 一行、答 D56（2026-10-24）：D48=A；D56 先不加，接口已删去 `utimes`。
  - [x] 1.7 owner 第六轮（2026-10-24）：D52 A、D55 A、D57 A；D54 已告知 owner、没有异议。
  - [x] 1.8 owner 第七轮（2026-10-24）：D58 按更正后的说法重问，选 A；spec 照 A 写。
  - [ ] 1.9 owner 读「给你看的一页」，回一句带编号的话，比如「05 改 ready」；页头加 `Approved:` 行，Status 改 ready，阶段表 4b 一行同改。
- [ ] 2. 对 00 的修补：`packages/kernel/src/host/adapter.ts` 加 `remove`、`identity`、`guarded`、`FileIdentity`、`SnapshotCoverage`、`HostSnapshots` 与相关类型，`ConfirmReason` 只增 `sensitive-path` 与必填键；`packages/contracts` 的 `ConfirmRequest` schema 同改；内存宿主同步（`snapshots` 的内存实现能模拟拍不成、超时、中止、四种状态，文件头写一句它复现了真宿主的哪几条行为）。
- [ ] 3. `apps/desktop/src/main/host/fs.ts`：`writeFile` 叶子加 `O_NOFOLLOW`；`guarded.read`、`guarded.create`（D58 A，owner 已定）；`identity` 带设备号；`identity` 用 bigint lstat；`remove` 只删文件或链接本身。测试点名验收 30、32 的宿主一半。
- [ ] 4. 快照子系统（desktop 宿主，新模块）：可用 git 的判定与 `xcode-select`（都经 `process` 加 `sandbox.wrap`）、影子仓库的建立、隔离配置与按工作区卷探测的三项、按忽略规则列文件、排除表（`.gitignore`、默认排除、嵌套根、超过 100 MB、读不了的）与每张收了哪些路径、不带父提交的快照与引用、单文件副本与清单、每张所收文件与目录的权限位、首张后台与预算、四种状态、每个仓库一把锁、保留（20 轮、30 天覆盖一切、3 GB 实占、空间清理才保护的轮、预留与 `over-budget`）与立即回收、启动时清残留与重建索引、删会话与清空会话时删目录、文件属主不同时的 `safe.directory`。测试点名验收 5–8、10–12、14、31、44、45、46、49 的宿主一半；git 的行为在真 git 上测，两平台。
- [ ] 5. 保护名单的文件工具一半与硬链接、选文件夹：`apps/desktop/src/main/host/sandbox-config.ts` 导出一个名单函数，沙箱配置与 `PathScope.sensitive` 都从它取；`locatePath` 按任意深度与大小写折叠认 `sensitive`：凭据对所有文件工具，会被自动执行的名字与名字数大于 1 的普通文件只对 Write、Edit、Delete；`decide` 的 `LayerInputs` 只增 `sensitive`，第 6 层不认会话授权与继承授权；Glob、Grep 的遍历只跳过凭据；`callReasonOf` 出 `sensitive-path`；两份 locale 的三句；kernel 设工作区的唯一入口拒根目录与卷根、主目录与其上级提醒。名单比写法与真实路径两种、照 `walkLinks` 逐级解开的目标表。测试点名验收 13、25（判定一半）、26、27、28、52、55。
  - [ ] 5.1 第一段核对：G、T、S；多视角评审（对照 spec、安全、突变，各一个新子 agent）；StrykerJS 只对改动过的文件跑、只出报告；汇总评审写 log。
- [ ] 6. Tape：`fs/snapshot_created` 补身份列，`fs/restore_started`、`fs/restored` 新登记；`DECLARED_TAPE_NAMES`、`TapePayloadByName`、投影与重放；`ToolOutcomePayload` 只增 `snapshotId` 与 `file`，`PermissionDecidedPayload` 只增 `coverage`；SQLite 与 Postgres 的一致性测试。测试点名验收 1、21 的 Tape 一半。
- [ ] 7. 判定：Write、Edit、Delete 判定前问 `coverage`（不抛、1 秒、出错按 `none`），`reversibilityOf` 收第三个入参并记进判决；答复作用域表加 Delete 一行。测试点名验收 3、4。
- [ ] 8. 执行：批准之后、动文件之前拍，拍成先写一批 `before-call`，打开文件前再比一次 `identity`；做完记 `after-call`；拍不成不写；`take` 收中止信号，三处查中止；Bash 在 `tree` 时派发前后各拍一张，派发与停止竞速；子会话的快照进根会话的影子仓库，带 `roundRunId`。测试点名验收 1、2、9、37、42、43。
- [ ] 9. mtime 守卫与写入边界的名字数复查：`tool_outcome` 记印记（Read 用 `guarded.read` 的同次打开印记）；目标不在时用 `guarded.create`；Write、Edit 执行前比对；固定英文。目标已不存在时不挡。测试点名验收 23、24、25（写入一半）、50。
- [ ] 10. Delete 工具：spec、执行器、父目录真实加叶子照写的路径认法、进两个文件工具集合、固定英文、effect；工具表变十一个。测试点名验收 29（kernel 一半）、30。
- [ ] 11. 提示层：`PROMPT_LAYER_VERSION` 从 11 升到 12、更新哈希；从这一步起 CI 的 `evals:gate` 红，到 11.1 为止。之后到 11.1 之前若要再改提示层文本，回到这一步改并更新哈希，不再加版本。
  - [ ] 11.1 基线评测（live）：先请 owner 批 key 与花费（04 那次 45.07 元，看门狗上限 75 元）；在沙箱生效的 macOS 上、agent 沙箱外跑基线列全集每题 3 次；记录与改动同一 PR；lead 逐题对照第 11 版基线，对照表写进 log；有题从过变不过就停下交 owner；花费记 log。点名验收 36。
- [ ] 12. 第二段核对：P；E 走 CI 草稿 PR；多视角评审与 StrykerJS 同 5.1；汇总评审写 log。
- [ ] 13. 还原（宿主与 kernel）：清单（agent 改过的路径、命令改的单独标出、已是起点的不动、三张都收了才动、跳过原因、冲突）、`previewKey` 与 `stale`、还原前那张必须收全、先写 `fs/restore_started`、先删后放、逐路径的 `identity` 与父目录检查、叶子不跟随、新建排他加权限位、临时文件加改名（修改时间即还原那一刻）、大小写配对、`fs/restored`；同一真实文件夹上有进行中 Run 时拒绝；启动时提示没做完的还原。逐级重建父目录（每级照规矩 8 查、以属主可写排他新建，内容放回后从深往浅设回起点权限）；相邻调用前后比对；租约与 `prepare`、`apply`、`cancel` 两段交接；只改了权限位的路径只改回权限位。测试点名验收 16–22、39、40、41、49、51、53、54 的宿主与 kernel 一半。
- [ ] 14. 路由：`snapshot.rounds`、`snapshot.preview`、`snapshot.restore` 经 contracts 登记，两端校验；宿主核对 `sessionId` 与目录；`overwrite` 只收冲突的子集。测试点名验收 18、22 的路由一半。
- [ ] 15. 界面：审批卡 ④ 的 `snapshotted` 一句；工具行收起的失败标记与 Delete 展开那一行；结算行的 Delete 一类、「可还原」与两种附注；还原清单（逐个路径、跳过原因、冲突逐个问、取消、`stale` 重出）；`ThreadTitleMenu` 与「查看本次记录」。测试点名验收 16、18、33、34、35、47、48 的渲染一半。
- [ ] 16. e2e：验收 15 的端到端句，macOS 与 Linux 两个 CI runner；验收 29 的还原回来。走 CI 草稿 PR，一次推送攒齐（每推一次取消上一轮 e2e）。
- [ ] 17. 第三段核对：P；E；多视角评审与 StrykerJS 同 5.1；汇总评审写 log。
- [ ] 18. 文档同步：spec「## 文档同步」列的「实现时」各处。点名验收 38。
- [ ] 19. 预算检查点（本项目补充第 6 条；阶段 4 的每一份都对照阶段 3）：数验收条数与 05 三个 PR 合计的 `git diff --shortstat`，对照阶段 3 的 1.5 倍（约 79 条、约 27 720 行）；再核阶段 4 合计不超过阶段 3 的 3 倍（约 55 440 行；04 已用约 25 600 行，05 之后留给 06 与 task-mode-ui 的余量一并写出）。任一超线先告诉 owner，再按总参考 §13 阶段 4 的砍法顺序（4d 挪阶段 6 → 快照只管文件工具 → macOS 那半本机跑 → 阶段 4 不开自动档）决定砍不砍；结果写 log。
- [ ] 20. 未解决的开放问题、Open 与跟进挪进总参考「以后再说」，或写明已定；在派最后一次评审之前做完。
- [ ] 21. 对照验收逐条核对：每条验收有点名它的测试或标了（人工）（live）；矩阵的「突变」列补齐；S 的 `trace` 不拦。
- [ ] 22. 清理：临时探针、调试输出、`research/` 里不该进仓库的原始输出挪到私有笔记。
- [ ] 23. owner 验收 → 改 Status

## 交接

2026-10-24 第八版起草完（私有笔记 `2026-10-23-05-file-bridge/draft/`；第三、五、六、七版另存 `draft-r3/`、`draft-r5/`、`draft-r6/`、`draft-r7/`），还没进仓库。r1、r2 两轮挑刺评审、第五版复核、Codex 交叉评审与三次复核都已处置；owner 七轮问卷都已答，D58 已定 A。接手的会话从第 1.2 步开始，照 headers.md 放进仓库。

## Open

- 没装命令行工具的 macOS 上 `xcode-select -p` 与 `/usr/bin/git` 的行为（P8 未验证）：等有一台干净的 macOS 虚拟机时实测；在此之前照 D4、D54 的判定，失败就不碰；验收 11 只用注入的失败 `xcode-select`。
- 文件属主不同的工作区（P2 没测）：第 4 步加一条用例实测命令行传 `safe.directory` 是否够，挡不住就记进已知限制。
- Linux 没有桌面环境时的回收站（P9）：随「以后再说」里回收站那一行，两平台实测后再定。
- 矩阵门禁列用了 `test:e2e`、`test:macos`，它们只在 `.sdd/config.json` 的 `test_reports` 里、不在 `gates` 里（04 的矩阵同样这么写）：要不要登记进 `gates` 由 owner 定，那是门禁文件的改动、只在 owner 说了才合。
- 收起行的状态词（运行中、待批、出错、被拒、被拦）要不要统一一套：06 碰同一行时定。

## 验收矩阵

| 验收号 | 层 | 测试用例名 | 门禁命令 | 突变 | 平台 |
|---|---|---|---|---|---|
| 1 | 集成 | 05 验收 1: before-call snapshot fact precedes the write and the outcome points to it | test | — | 任意 |
| 2 | 集成 | 05 验收 2: a promised snapshot that fails leaves the file untouched | test | — | 任意 |
| 3 | 单元 | 05 验收 3: Bash is never snapshotted on the card and is snapshotted before and after | test | — | 任意 |
| 4 | 单元 | 05 验收 4: coverage none, error or timeout gives unknown for writes and irreversible for Delete | test | — | 任意 |
| 5 | 集成 | 05 验收 5: shadow repo lives in the profile and leaves the workspace and its git status alone | test、test:macos | — | macOS、Linux |
| 6 | 集成 | 05 验收 6: user global git config does not reach the shadow repo | test、test:macos | — | macOS、Linux |
| 7 | 集成 | 05 验收 7: nested repos stay out of the tree, their files get single copies, a worktree root is snapshotted | test、test:macos | — | macOS、Linux |
| 8 | 集成 | 05 验收 8: files over 100 MB and unreadable files stay out and count as skipped | test | — | 任意 |
| 9 | 集成 | 05 验收 9: before the first tree snapshot, file tools keep single copies | test | — | 任意 |
| 10 | 单元 | 05 验收 10: over budget the session drops to single copies and says so once | test | — | 任意 |
| 11 | 单元 | 05 验收 11: a failing xcode-select, an old git or a failing init means single copies only | test | — | 任意 |
| 12 | 单元 | 05 验收 12: home, its parent, Desktop, Documents and Downloads get no tree snapshot | test | — | 任意 |
| 13 | 集成 | 05 验收 13: / or a volume root is refused through pick and prefill, home is warned | test | — | 任意 |
| 14 | 集成 | 05 验收 14: retention keeps 20 rounds, 30 days and 3 GB after reclaim, protects live rounds | test | — | 任意 |
| 15 | e2e | 05 验收 15: write task, approve, summary, restore, content back and git status clean | test:e2e | — | macOS、Linux |
| 16 | 集成 | 05 验收 16: preview lists every path with skip reasons, marks command paths, and cancel touches nothing | test | — | 任意 |
| 17 | 集成 | 05 验收 17: restore removes new files, brings back deleted ones, links and 600 modes (also chmod-only), and stamps restore time | test | — | 任意 |
| 18 | 集成 | 05 验收 18: conflicts are asked one by one and only listed overwrites happen | test | — | 任意 |
| 19 | 集成 | 05 验收 19: restore touches only the agent's paths, not ignored files or your in-round edits | test | — | 任意 |
| 20 | 集成 | 05 验收 20: restoring an earlier round undoes only that round | test | — | 任意 |
| 21 | 集成 | 05 验收 21: the pre-restore snapshot brings files back to before the restore | test | — | 任意 |
| 22 | 集成 | 05 验收 22: no card, busy across sessions, stale after preview, unfinished restore noticed | test | — | 任意 |
| 23 | 单元 | 05 验收 23: a file changed since the last read, or read as B while the path is back at A, is not written | test | — | 任意 |
| 24 | 集成 | 05 验收 24: the guard survives a restart from the Tape | test | — | 任意 |
| 25 | 集成 | 05 验收 25: writing a file with two names asks every time despite a grant, reading it does not | test、test:macos | — | macOS、Linux |
| 26 | 单元 | 05 验收 26: a private key under home asks as a credential and Grep skips it | test | — | 任意 |
| 27 | 单元 | 05 验收 27: writing auto-run names and .git pointer files, new or old, asks every time, reading does not | test | — | 任意 |
| 28 | 单元 | 05 验收 28: every shared sandbox deny name asks or blocks in the file tools | test | — | 任意 |
| 29 | 集成 | 05 验收 29: Delete with a snapshot comes back on restore | test | — | 任意 |
| 30 | 集成 | 05 验收 30: Delete refuses folders, removes only the link, blocks protected paths, rm still asks | test、test:macos | — | macOS、Linux |
| 31 | 单元 | 05 验收 31: status answers four states and turns unavailable after a full disk | test | — | 任意 |
| 32 | 集成 | 05 验收 32: a target swapped for a link after the decision is not touched | test、test:macos | — | macOS、Linux |
| 33 | 单元 | 05 验收 33: summary line shows restorable and its two notes | test | — | 任意 |
| 34 | 集成 | 05 验收 34: the session record lists tool, object, verdict, reversibility, snapshot and restorable | test | — | 任意 |
| 35 | 单元 | 05 验收 35: locale has the snapshotted, sensitive-path, failure and Delete lines | test | — | 任意 |
| 36 | live | 05 验收 36: prompt layer 12 baseline recorded with no task going from pass to fail | test | — | 任意 |
| 37 | 集成 | 05 验收 37: a subagent's write is restored with the root round | test | — | 任意 |
| 38 | 你用 | （人工） | — | — | 任意 |
| 39 | 集成 | 05 验收 39: a folder swapped for an outside link is rebuilt in place and nothing is written outside | test、test:macos | — | macOS、Linux |
| 40 | 集成 | 05 验收 40: a case-only rename is restored without losing the file | test:macos | — | macOS |
| 41 | 集成 | 05 验收 41: paths whose exclusion changed in the round are skipped with a reason | test | — | 任意 |
| 42 | 集成 | 05 验收 42: a target changed after the snapshot is not written | test | — | 任意 |
| 43 | 集成 | 05 验收 43: stop during a snapshot writes nothing and a command waiting on it does not run | test | — | 任意 |
| 44 | 集成 | 05 验收 44: case rules are probed on the workspace volume | test:macos | — | macOS |
| 45 | 集成 | 05 验收 45: concurrent snapshot, restore, cleanup and a stale index.lock leave the repo sound | test | — | 任意 |
| 46 | 集成 | 05 验收 46: targets outside the tree are restored byte for byte from single copies | test | — | 任意 |
| 47 | 单元 | 05 验收 47: a failed collapsed tool row shows the failure mark and no irreversible mark | test | — | 任意 |
| 48 | 单元 | 05 验收 48: summary counts deletions and the Delete row says it deleted the file | test | — | 任意 |
| 49 | 集成 | 05 验收 49: a deleted folder tree, a 0555 folder among it, comes back with its modes and nothing failed | test、test:macos | — | macOS、Linux |
| 50 | 集成 | 05 验收 50: read, delete, write is not blocked; a file appearing before the open is not overwritten | test | — | 任意 |
| 51 | 集成 | 05 验收 51: after an interrupted restore, paths already at the start are left alone | test | — | 任意 |
| 52 | 集成 | 05 验收 52: every snapshotted promise restores or is skipped with a stated reason; none is unlabelled | test | — | 任意 |
| 53 | 集成 | 05 验收 53: a stopped host write keeps restore busy until it truly ends, also for a parent folder | test | — | 任意 |
| 54 | 集成 | 05 验收 54: an edit of yours between two agent edits of one file makes it a kept conflict | test | — | 任意 |
| 55 | 单元 | 05 验收 55: links at any level of a sensitive path ask for spelling and final target, despite grants | test | — | 任意 |
