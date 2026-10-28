# 05 · log

## 实施 · 2026-10-23

- 起草依据：owner 2026-10-23 在问卷里选「开始起草 05」，并定了 D1–D7（两轮都先直接点了推荐，lead 讲解后 owner 确认「看懂了，D1–D7 都按刚才选的，不改。」，原话见 decisions.md）；2026-10-09 阶段 4 裁决里归 4b 的各条重写成 D8–D23；lead 定、已告知 owner 的五条写成 D24–D28。范围梳理、问卷记录与外部调研原文在私有笔记（另记）。
- 探针：同一套脚本在 macOS（arm64，git 2.50.1）与两台 Lima 虚拟机 Ubuntu 24.04、26.04（arm64，git 2.43.0、2.53.0）上跑完十项，结论写进 evidence.md 的 P1–P10。macOS 先在另一个 agent 的沙箱里跑，快照与还原两项又在沙箱外重跑，耗时以沙箱外为准（5 万文件首张约 34 秒、之后每张约 0.13 秒；Linux 首张 6–9 秒、之后约 0.07–0.12 秒）。三平台还原后内容全部一致，mtime 写回最大误差 1.23 微秒。没跑的：没装命令行工具的 macOS、文件属主不同的工作区、回收站（只读文档）、项目 `.gitattributes`（P11）。
- 外部事实：Codex 移除撤销的日期在 openai/codex 的 PR #19481、issue #9280、discussion #9618 上核实，两份私有笔记的说法都对（命令先在 2026-01 中旬前拿掉，代码在 2026-04-28 删除），写进 E1；Claude Code 检查点文档与 WorkBuddy 权限页当天重取，写进 E2、E4。
- 第一版体量：spec 16 129 字符、38 条验收。

## 挑刺评审 · 2026-10-23 · 审过 draft-r1（私有笔记里的第一版，未入库，没有提交号）

结论：不通过（第一版）    评审：两个新上下文的视角——规则与证据面、机制与安全，各自只出发现；评审原文与复现程序在私有笔记（另记）
突变：无（审 spec）
发现：规则面 1 blocker、17 major、14 建议；机制面 4 blocker、12 major、13 建议。四个机制 blocker：还原会经父目录的链接写到工作区外、删与放的先后没定（P12）；一轮里排除集合变了，路径被读成删了或新建（P13）；Delete 判定用的真实路径会解开叶子链接；带 `sensitive` 的「每次问」被已有的会话授权绕过。规则面 blocker：D24–D37 没给 owner 选，其中两张改了已定项。
处置：已修 54、不修 3、交 owner 4，逐条见私有笔记的处置表（另记）。四个机制 blocker 都已修进第二版（D49–D52，验收 25、27、30、39、40、41）；交 owner 的四条（规则面 B1 与两条 major、机制面 J11）合成第二批问卷五题（D32 与 D44、D33、D37、D45、D46）。
- 同日 owner 定了第一版的六个开放问题：D38 A、D39 A、D40 A、D41 B、D42 A、D43 B（原话见 decisions.md），第二版照此改了正文与验收。
- 第二版体量：spec 约 2.1 万字符、48 条验收；在仓库外的临时副本里试跑 `python3 .sdd/spec-check.py`，拦 0 条。
- 第四轮问卷（owner 2026-10-23）定了交 owner 的四条：D8=A、D12=A、D13=A 逐张确认，D32 快照号不上卡，D33 A，D37 A，D45 B（还原写成还原那一刻的时间），D46 B（会被自动执行的位置与有两个名字的文件只在改和删时问）；原话见 decisions.md。第三版照此改了正文、规矩、验收与矩阵；剩 D48 一行与 D56 要 owner 回。
- 第五轮问卷（owner 2026-10-24）：D48 选「D48=A 写两条」；D56 选「先不加，用到时再加」，05 不加 `HostFs.utimes`，D12 改为只加删除与认出硬链接两个成员（确认原话保留）。第三版定稿，spec 的开放问题清空，交评审。

## 挑刺评审 · 2026-10-24 · 审过 draft-r3（私有笔记里的第三版，未入库，没有提交号）

结论：不通过（第三版）    评审：一个新上下文，机制、规则与 r1 处置核对三合一；评审原文与复现程序在私有笔记（另记）
突变：无（审 spec）
发现：r1 的 61 条逐条核对，真修 55、部分 3、不修 3（不修的理由评审判为成立）。第三版新发现 1 blocker、4 major、4 建议：还原不会重建被删的父目录，朴素地补上又会经植入的链接写到工作区外（P21）；整树快照不记权限位，600 的文件还原成 644（P22）；命令运行期间你改的文件被算成命令的改动（P23）；文件被删之后 mtime 守卫把同一路径的写入挡死（P24）；D52、D54、D55 没告知 owner；另有 `.git` 指针文件、规矩 11 的措辞、中断后再还原的冲突、git 以 `full-access` 运行四条建议。
处置：已修 7、不修 0、交 owner 2，逐条见私有笔记的处置表（另记）。NB1、NM2、NM4 写成具体规则并加验收 49、50（验收 17、39 也改了）；NM3 按评审建议写进已知限制，一页改成如实说法，清单里标出命令改的路径；交 owner 的两条是 D52、D54、D55 的告知（协调者在问）与 git 的运行权限（D57，问卷稿 owner-questions-r3）。
- 同日补测探针：P11、P17 在 macOS 与两台 Lima 上实测，P19 在 macOS 上实测，三条都走「照现稿写」那一支；P18 仍未核实。
- 第四版体量：spec 约 2.15 万字符、51 条验收；在仓库外的临时副本里试跑 `python3 .sdd/spec-check.py`，拦 0 条。
- 第六轮问卷（owner 2026-10-24）：D52 选「A 对这三类失效，再问一次」，D55 选「A 算整个磁盘，不让选」，D57 选「A 维持现状，以你的权限」；D54 由协调者在对话里告知，owner 没有异议。第五版定稿：spec 开放问题清空，D57 A 的代价写进已知限制。

## 评审 · 2026-10-24 · 审过 draft-r5

结论：通过（第一、二轮挑刺评审之后的复核，可以交 owner 批 ready）    评审：第二轮评审在新上下文里复核第五版（规则、机制与处置三方面），复现程序 r2-7、r2-8 在私有笔记（另记）
突变：无（审 spec）
发现：
- [建议] 「叶子名为 `.git` 的文件」漏了还不存在的指针文件 · 证据：规则字面 · 已修：改为叶子段名为 `.git` 的路径，验收 27 加新建一例
- [建议] 起点目录 0555 时验收 49 过不了 · 证据：r2-7 f，`failed=[ro/f.txt]` · 已修：目录先以属主可写建、内容放回后从深往浅设回起点权限（P25）
- [建议] 只改权限位的路径不会被还原 · 证据：r2-7 g · 已修：权限位变化也算 agent 改过的路径（P25）
- [建议] 守卫判「目标已不在」到打开之间文件冒出来会被盖掉 · 证据：r2-8 · 已修：排他新建，已存在就不写（P26）
- 这条记录审的是私有笔记里的第五版，没有提交号；放进仓库后的那一条见本文件末尾。

## 评审 · 2026-10-24 · 审过 draft-r5（Codex 交叉评审）

结论：不通过（第五版）    评审：另一个模型做的交叉评审，审第五版，协调者核过判断都成立；报告另记
突变：无（审 spec）
发现：
- [blocker] 敏感位置经符号链接后绕过「每次问」 · 证据：内存注入现有 `locatePath`，判成普通工作区文件、旧会话授权仍放行（P29） · 已修：比写法与真实路径两种、链接目标也算，验收 55
- [blocker] 起点已有硬链接的文件卡上标可还原、还原却必跳过 · 证据：规则互相矛盾 · 已修：这类目标 `coverage` 答 `none`，新增规矩 15、验收 52
- [blocker] 停止后晚到的宿主写入覆盖还原结果 · 证据：内存宿主上运行 `DesktopFs.writeFile` 复现（P28） · 已修：还原与工作区写入用租约互斥，验收 53
- [major] 两次调用之间你改同一文件仍被不问就撤 · 证据：P27 · 已修：相邻调用前后比对，对不上算冲突，验收 54
- [major] Read 的同句柄印记没有接口传回 kernel · 证据：`DesktopFs.readFile` 返回前关闭句柄 · 交 owner（D58）
- [major] 认卷根要设备号，接口没有 · 证据：`HostFs.stat` 与 `FileIdentity` 都没有 · 已修：`FileIdentity.dev`
- [major] 快照端口缺轮次关联与还原「先写事实再动文件」的交接 · 证据：`SnapshotRequest` 没有调用身份、`undoSnapshotId` 返回太晚 · 已修：`call` 身份由 kernel 传入，还原分 `prepare`、写事实、`apply` 三步
- [major] 「30 天全清」与「最近一轮不清」矛盾、受保护轮超 3 GB 时没规定 · 证据：规则互相矛盾 · 已修：30 天覆盖一切，预算不够时新快照拒收、不删受保护的起点
- 处置：已修 7、不修 0、交 owner 1，逐条见私有笔记的处置表（另记）。上一条记录里第五版复核的「排他新建」随「同一读句柄取印记」那一条改判为交 owner（D58），`writeFile` 的 `exclusive` 撤回。
- 第六版体量：spec 约 2.4 万字符、55 条验收；在仓库外的临时副本里试跑 `python3 .sdd/spec-check.py`，拦 0 条。

## 评审 · 2026-10-24 · 审过 draft-r6（Codex 复核）

结论：不通过（第六版）    评审：同一个外部模型复核第六版，报告另记
突变：无（审 spec）
发现：
- [blocker] 名单路径的中间目录是链接时，直接写解到底的位置仍绕过「每次问」 · 证据：规则只管名字本身是链接 · 已修：目标表照 `walkLinks` 逐级解开，验收 55 补两例
- [major] 规矩 15 的承诺与跳过规则冲突 · 证据：获批后多了名字的文件，规矩 15 要放回、跳过规则要跳过 · 已修：写明承诺成立与失效的条件，验收 52 验失效提示
- [major] D58 的风险说法给了不存在的时间保证，漏了往返替换 · 证据：`DesktopFs` 的异步操作没有上界 · 已修：更正说法、推荐改 A，spec 照 A 写，交 owner 重选
- [建议] §接口里「宿主不读 Tape」与「宿主先按 Tape 确认」矛盾 · 已修：kernel 一侧验证，`HostSnapshots` 不读 Tape
- 处置：已修 4、不修 0、交 owner 0；上一轮的其余五条（晚到写入、相邻调用、设备号、快照端口交接、保留与预算）复核为到位。第七版体量：spec 约 2.45 万字符、55 条验收，副本里试跑 spec-check 拦 0 条。

## 评审 · 2026-10-24 · 审过 draft-r7（Codex 复核）

结论：不通过（第七版，没有 blocker）    评审：同一个外部模型第三次复核，报告另记
突变：无（审 spec）
发现：
- [major] 规矩 15 把冲突归入跳过，与「覆盖」分支矛盾 · 证据：验收 18、20 与 `apply.overwrite` · 已修：冲突默认保留、可覆盖，只有多了名字、移出工作区、被后面的整树快照排除才跳过
- [major] 验收 23 要求认出所有往返替换，超出同句柄印记的能力 · 证据：句柄一直读 A 的情形本来就没读错 · 已修：收窄到「读到 B、写前回到 A、大小或 mtime 不同」
- [建议] D58 已定 A，spec 与 plan 里还有「重选中」「改 ready 前定」 · 已修：同步为已定 A
- 处置：已修 3、不修 0、交 owner 0；B1、`guarded`、Tape 验证归属复核为到位。
- 第八版体量：spec 24 499 字符（heavy 上限 2.5 万）、55 条验收；在仓库外的临时副本里试跑 `python3 .sdd/spec-check.py`，拦 0 条。

## 评审 · 2026-10-24 · 审过 466bd0a

范围：把私有笔记里的第八版放进仓库的那个提交（五份文件、四份旧 spec 页头的 `Changed by`、总参考的阶段表与「以后再说」、入口页）。内容在入库前已由上面各轮评审过；这一条只核放置。新上下文的评审 agent（Sonnet）核对：
- 五份文件与第八版逐字一致；四份旧 spec 各只多一行页头，旧页头与正文没动，与 05 页头的 15 条 `Changes` 逐条成对，spec-check 没有 `pairs` 拦截。
- 总参考只改了清单上的五处，入口页是 `--index` 的生成结果。
- 公开文件里没有本地绝对路径与禁用词。
- [建议] evidence 与 plan 里露出了私有笔记的目录名 · 已修 31c7085（改成「另记」）
- [建议] plan 与 log 停在「放进仓库前」的状态 · 已修 31c7085
- [建议] overview.md 没改（docs-sync 警告） · 不修：05 实现之前不改，照 spec「## 文档同步」
结论：通过
突变：0 个（只有文档）

## 实施 · 2026-10-24（改 ready）

- owner 在对话里读过「给你看的一页」后回「05 改 ready」。页头加 `Approved: ready · 2026-10-24 · 「05 改 ready」 · 对话`，Status 改 ready；总参考阶段表 4b 的状态一格同改；plan 第 1 步勾掉。

## 实施 · 2026-10-24（第一段：第 2–5 步）

- 分工：Codex 在自己的 worktree 实现，lead 每一步审 diff、在沙箱外跑全量、在两台 Lima（Ubuntu 24.04 + git 2.43.0、26.04 + git 2.53.0）跑快照与权限相关测试，再把检查点摘到 `feat/05-file-bridge-seg1`（72ecb7d 第 2–3 步、60a03f0 第 4 步、5bf0cae 第 5 步、c140301 评审修复）。
- lead 自己改的：影子仓库用空模板 `init` 后没有 `info/`，写 `info/attributes` 抛错、首张静默降级，补建目录（60a03f0）；Linux 上 git 先退出、再关它的 stdin 抛 `WritableStream is closed`，19 条快照用例在 Linux 上红、macOS 上绿，改成没有输入时关 stdin 失败不算错（60a03f0）；`git add --pathspec-from-file` 对 3 万条路径是平方级匹配，没改动的第二张也要 5.13 秒，实测 `update-index --add -z --stdin` 0.07 秒，交给 Codex 换掉（c140301）；跨卷大小写用例里 `hdiutil` 的文件系统名写成 `APFSX` 一直被跳过，改成 `Case-sensitive APFS` 后在 macOS 上真跑（c140301）。
- lead 审第 4 步时退回的：每次调用后都跑 `git gc`、宿主启动等快照恢复、工作区通知出错让路由失败、删会话时快照目录删不掉会跳过后续清理、降级原因靠匹配错误文本、stdin 那处缺确定性测试；都在 5bf0cae 前修掉。
- 选专属文件夹时它解开后是根或卷根：不给 `selectProfile` 加 `root-folder`（spec §接口 只给 pick、usePrefill 加），抛错、路由回 `handler-failed`、工作区不变；`workspace.remove` 回退到这种专属文件夹同样处理（c140301）。lead 定，理由是不改已合入的契约。
- 平台：macOS 区分大小写卷（测试自建稀疏映像）、两台 Lima 以 root 跑「不同属主」那条，都过；`safe.directory` 那条要 root，CI 里跳过。
- 门禁：基于 dev 的分支上 G 全过，T 4843 过、113 跳过。全量在负载下两次见到 `03 验收 30 (HTTP): modern total deadline at ten times uses fake setTimeout and cancels on the server` 失败，单跑 3 次都过；它要等测试服务器经真实本机连接发 17 帧进度，本段没碰 MCP，先记在这里，CI 上红了再处理。Lima 上 `evals-format` 的「fixture .gitignore would swallow」失败，是拷进虚拟机的副本里没有 `.git`，与本段无关。
- owner 2026-10-24 定 D59（链接目标表扫不完时照名字查）：spec §已知限制与代价 加一条、修订记录记一行（6e91032）。

测试改动：apps/desktop/test/fifo.test.ts · 换成设备的叶子 · `writeFile` 叶子加了 `O_NOFOLLOW`，期望从「是设备」改成 `ELOOP`
测试改动：apps/desktop/test/host.test.ts · 悬空链接写出工作区 · 同上，原来断言能写到外面，现在断言拒写、外面没有新文件
测试改动：packages/kernel/test/host/memory.test.ts · 内存宿主的悬空链接 · 内存宿主同样 `O_NOFOLLOW`，期望改成 `ELOOP`、不新建
测试改动：apps/desktop/test/session-removal.test.ts · HostFs 成员 · 原断言「HostFs 没有删除成员」，05 加了 `remove`、`identity`、`guarded`，改成断言恰好多这三个
测试改动：apps/desktop/test/sandbox/allowlist.test.ts · 04 不变量 1 · 允许调 `sandbox.wrap` 的文件多了 `snapshot-git.ts`（D57）
测试改动：apps/desktop/test/copy-coverage.test.ts · 审批卡文案 · 原因从 9 个变 10 个，`sensitive-path` 按三种 category 各一句，计数随之改
测试改动：apps/desktop/test/renderer-approval-keys.test.ts · 原因到文案键 · 同上，`sensitive-path` 按 category 取键，从「其余原因」里拿出来单独断言
测试改动：apps/desktop/test/renderer-approval-card.test.ts · 全原因矩阵 · 同上
测试改动：packages/contracts/test/confirm.test.ts · 02 增加的原因 · 原因从 9 个变 10 个，`sensitive-path` 的必填键是 `path`、`category`

## 评审 · 2026-10-24 · 审过 5bf0cae（对照 spec）

结论：不通过    评审：新上下文的子 agent（Opus），对照 spec 05 与 plan 第 2–5 步；复现脚本另记
突变：无（只读代码、跑复现）
发现：
- [blocker] 链接目标表扫描超过 5 秒或 10 万条就抛，失败被永久缓存，会话里所有工具调用以 `provider-error` 结束 · 证据：以本仓库 checkout 为工作区实跑 5000 ms 失败；注入抛错后 Read 与 Bash 的 Run 都失败 · 已修 c140301
- [major] 每张整树先清空索引再全部 `add`，3 万文件第二张超 5 秒、会话降级 · 证据：实测 1 万文件每张 1.2–3 秒、3 万文件第二张 5024 ms 失败 · 已修 c140301
- [major] 带 path 的拍摄撞上期限时不退单文件副本，承诺过的写入被拒 · 证据：3 万文件 before-call 拍摄 10014 ms 后 `ok:false` · 已修 c140301
- [major] 每张按「整树字节 ×2」预留，空间够也 `over-budget` 并先删旧轮 · 证据：等比缩小预算的复现 · 已修 c140301
- [major] 重启或清空会话后快照状态不恢复 · 证据：重启前后四种情形的答案对不上 · 已修 c140301
- [major] `sensitive-path` 卡第 ③ 句渲染成 i18n 错误串 · 证据：两份 locale 都渲染出 `<<i18n-error:…>>` · 已修 c140301
- [major] 验收 13 的界面一半没做、plan 后续步骤也没认领 · 证据：`FolderChip` 忽略 `code` 与 `warning` · 已修 c140301
- [major] `workspace.remove` 的响应契约被放宽 · 证据：三个路由共用 `workspaceResultSchema` · 已修 c140301
- [major] 验收 6 的全局 git 配置一半是空测试 · 证据：删掉 `GIT_CONFIG_GLOBAL` 照样过 · 已修 c140301
- [major] 验收 44 在 CI 里永远不跑 · 证据：workflow 里没有设那个环境变量 · 已修 c140301
- [major] 改了 17 个已有测试文件没有 `测试改动：` · 证据：spec-check 的 `tamper` 警告 · 不修：lead 在上面的实施记录里逐行补记
- [major] 名字带「05 验收 52」的用例断言的不是 52 · 证据：用例只测授权边界与 own-spill · 已修 c140301
- [建议] Glob、Grep 直接指向凭据时出卡、批了却返回空 · 已修 c140301
- [建议] `probeVolume` 在工作区里建临时目录 · 已修 c140301
- [建议] `safe.directory` 用例要 root 才跑 · 不修：2026-10-24 两台 Lima 以 root 跑过，plan 的 Open 已照实写
- [建议] 空间清理按 `runId === roundRunId` 认进行中的轮 · 已修 c140301

## 评审 · 2026-10-24 · 审过 5bf0cae（安全）

结论：不通过    评审：新上下文的子 agent（Opus），绕过保护与毁文件两个方向；PoC 另记
突变：无（只读代码、跑 PoC）
发现：
- [major] firmlink 拼写不一致：desktop 存 `/System/Volumes/Data/…`，kernel 比 `/Users/…`，直接写链接目标没卡 · 证据：PoC 复现 · 已修 c140301
- [major] 链接目标表扫描超时后会话里所有工具失败 · 证据：PoC 复现，同对照 spec 那条 blocker · 已修 c140301
- [major] 工作区里 `git~1`、`d/.git.` 让整树 `add` 失败、会话降级 · 证据：PoC 复现 · 已修 c140301
- [建议] 中途停止留下 `index.lock`，整树拍摄一直出错、`coverage` 仍答 `tree` · 已修 c140301
- [建议] 预留按 2 倍估算、会过早清别的会话的轮 · 已修 c140301
- [建议] `probeVolume` 在工作区里建临时目录 · 已修 c140301
- [建议] `/System/Volumes/Data` 与上级同 `dev`，能被选成工作区 · 已修 c140301
- [建议] `info/exclude` 不转义反斜杠 · 不修：原实现的转义集已含反斜杠，c140301 补了真 git 回归
- [建议] 残留进程靠 `ps` 输出子串认归属 · 已修 c140301
- 影子仓库的隔离用真 git 打过：恶意 config、钩子、fsmonitor、filter、include、`.gitmodules`、嵌套仓库的 gitfile 与怪文件名都没让钩子运行、没改工作区或用户仓库的 `git status`。

## 评审 · 2026-10-24 · 审过 5bf0cae（突变）

结论：不通过（测试缺口要补）    评审：新上下文的子 agent（Sonnet）跑 StrykerJS，只变异本段改过的生产代码行；报告与原始结果另记
突变：第 1 组（权限、保护名单、文件接口、选文件夹）676 个，杀死 567、存活 106、无覆盖 3，得分 83.8%；存活与无覆盖逐个判过，测试缺口 43 个（合并 17 条，c140301 补测试）、等价 37、无意义 29；第 2、3 组（快照）1631 个，得分 52–69%，缺口按函数列出，同在 c140301 补测试；第 4 组（其余改动）360 个，68.9%，只出报告
发现：
- [major] 保护名单扫描、判决记录的 `steps`、`identity` 的错误码边界、`guarded.read` 单变量改动、残留进程三种情形、坏清单、默认排除表、git 版本边界、拍到一半停止，这些行为改坏了测试也不红 · 证据：对应突变存活 · 已修 c140301

## 评审 · 2026-10-24 · 审过 c140301（复核）

结论：不通过    评审：新上下文的子 agent（Opus），逐条核第一轮的修复：在副本里把修复撤回或改坏，看点名的用例是否变红；复现另记
突变：手工撤回或改坏 30 余处修复，点名用例都变红；另抽查突变清单 15 处，都变红；`sameReadStamp` 的 `mode`、`nlink` 比较与默认排除表的用例杀不掉（见下）
发现：
- [blocker] 工作区扫描不完整时，主目录下固定的自动执行位置（`~/Library/LaunchAgents`、`~/.gitconfig`、`~/.zlogin` 等）一起丢掉，auto 档位与 always-allow 下直接写它们没卡；这几处不经链接，不在 D59 之内 · 证据：真盘、真 `locatePath` 与 `decide`、小条数上限复现 · 已修 7d76e36
- [major] 保留索引后，被删的文件被记成「排除」并计入跳过，第 13 步会把它放进「跳过」而不是「放回」 · 证据：删掉 `gone` 后 take 得到 `skipped 1 excluded ["gone"]`，旧实现是 0 · 已修 7d76e36
- [major] 整树超过文件数预算时带 path 的调用不退单文件副本，已批准的写被拒 · 证据：`limits.files=2` 复现 `ok:false` · 已修 7d76e36
- [major] macOS 上启动恢复遇到带空格的 argv 一律抛错，正式环境的 `Application Support` 路径必中，会话降成 `unavailable`、残留 git 不被结束（复核报为建议，lead 升为 major） · 证据：照现有用例 mock `ps` 复现 · 已修 7d76e36
- [建议] kernel 没有 fallback 时提供方抛错会让保护全部消失 · 已修 7d76e36
- [建议] 发布时预算被拒，回收仍压在调用方路径上 · 已修 7d76e36
- [建议] 文件夹 chip：移除失败不刷新；任何移除都清掉主目录提醒 · 不修：移除失败照常刷新已修 7d76e36；提醒要精确跟随列表得给 `session.facts.workspace` 加字段，spec 只要求选主目录时提醒一句，lead 定不为此改契约
- [建议] `guarded.read` 的单变量用例在真文件系统上改不出「只变一个量」，杀不掉 `mode`、`nlink` 比较 · 已修 7d76e36
- [建议] 默认排除表的参数化用例遍历的是生产常量本身 · 已修 7d76e36
- [建议] 由 git 配置决定的钩子目录（如 `.husky/`）不在自动执行名单里 · 不修：spec 层的缺口，记进总参考「以后再说」

## 评审 · 2026-10-24 · 审过 7d76e36（第二次复核）

结论：不通过    评审：新上下文的子 agent（Opus），逐条核第二轮修复并跑全量与慢测；复现另记
突变：撤回或改坏第二轮各条修复，点名用例都变红；自写 80 例覆盖主目录固定位置在扫描不完整时出卡，换回旧版 `sensitive-paths.ts` 后大面积变红
发现：
- [major] macOS 上 `/usr/bin/git` 是 xcrun 垫片，exec 之后同一 PID 的 `ps comm` 是命令行工具里的 git，和记录的 `/usr/bin/git` 永远对不上，启动恢复只删记录、不结束残留的 git，随后照常删 `index.lock` 并重建索引；单元测试的假 `ps` 原样回显记录里的路径，测不出来 · 证据：真进程复现，残留的 git 3 秒后仍活着 · 已修 acd2155
- [建议] 默认排除表的用例标题写「documented」，spec 里并没有列出这 11 个名字 · 已修 acd2155
- 全量 4896 过，3 条失败都是副本不是 git 仓库造成的，`git init` 后单独重跑全过；慢测 97 过。

## 评审 · 2026-10-24 · 审过 acd2155

结论：通过    评审：新上下文的子 agent（Opus），只审 macOS 恢复那一处修复（lead 自己改的代码）；第 2–5 步其余部分见上面三条记录
突变：在副本里把程序名比较改回整路径比较，`xcrun-shim` 与真进程两条用例都变红，恢复后转绿；真进程用例连跑 5 次、压满 10 核时又跑 3 次，都绿
发现：
- [建议] 真进程用例的 `finally` 只在组长还活着时才杀进程组、`process.kill` 没包 `try`，用例本身失败时可能多等到 `sleep` 自己结束 · 不修：只影响失败时的收尾，不会留下长期残留，第二段碰这个文件时一起改
- [建议] 恢复时比较的程序名取自记录自己的 `executable`，没有绑定到配置的 git · 不修：旧代码就如此，`process.json` 在 profile 目录里、受限命令写不进，没有提权路径；第二段碰 `snapshot-git.ts` 时加上，记在 plan 的 Open
- 只比程序名之后，误杀需要另一个以 `git` 为名的进程组组长在记录时刻前后 3 秒内复用同一个 PID，评审判断不现实；Linux 一侧的真进程用例 lead 在两台 Lima 上跑过、通过。
- 分支在 acd2155 上 G 全过，T 4901 过、113 跳过。

## 实施 · 2026-10-24（PR #72 的 CI）

- e2e 红在 `write-card.spec.ts` 的硬链接基线（旧 51）：它记的是 05 之前的行为（按普通工作区写入问、本会话允许），注释写明行为一改就更新它。照验收 25 改成 `sensitive-path`、类别 `hardlink`、只放行这一次，批准后写入照旧落到外面那个文件（97354f7）。
- spec-check 的 `--red-on-base` 在目标分支的旧代码上跑测试就红了，日志不给是哪条；lead 照它的做法（临时 worktree、`install --ignore-scripts`、不 build）在 macOS 与 Ubuntu 24.04 上重放 dev，都全绿，按偶发处理，推送后看重跑。

测试改动：apps/desktop/e2e/write-card.spec.ts · 硬链接写入（旧 51） · 05 验收 25 把基线从 `default`、本会话允许改成 `sensitive-path`、只放行这一次

## 评审 · 2026-10-24 · 审过 97354f7

结论：通过    评审：新上下文的子 agent（Opus），只审 e2e 基线这一处；对照 kernel 的 `locatePath`、`decide`、`answerScope` 与 renderer 的 `reasonKey` 读代码，相关单测 160 条全过
突变：无（只改 e2e；对应的生产路径由 `sensitive.test.ts`、`renderer-approval-card.test.ts` 守）
发现：
- [建议] 标题写「每次问」，用例只问了一次 · 不修：「不认已有授权」由 kernel `sensitive.test.ts` 守，这条 e2e 断言了只放行这一次
- [建议] 没断言卡上不写「有快照」 · 不修：第 15 步接上「有快照」那句时在这条用例里补
- [建议] `packages/kernel/src/permission/workspace.ts` 文件头仍说硬链接「留给阶段 4 定」 · 不修：不在本提交，第二段第 7 步改这个文件时一起改

## 实施 · 2026-10-25（第二段：第 6–12 步）

- 分工：Codex 在自己的 worktree（`feat/05-seg2`，新会话）实现，lead 每一步审 diff、在沙箱外跑全量，再摘到 `feat/05-file-bridge-seg2`：0616b4c 第 6–7 步、b5a9a38 第 8 步、fe6a205 第 9–10 步、f7cffce 第 11 步、b38e24a 与 e83eb09、4e9366c 三轮评审修复。
- lead 自己改的：`apps/desktop/test/tape/fs-dialects.test.ts` 把 Postgres 连接串放在 `PGDATABASE` 里，libpq 不把它当连接串解析，注释写的用法跑不通，改成 `--dbname=<url>`（0616b4c）。这条 Postgres 用例要 `TENON_TEST_POSTGRES_URL` 才跑，CI 里跳过（人工）：2026-10-25 在 Ubuntu 26.04 + PostgreSQL 18 的临时库上跑过，两条都过，事务回滚后不留 schema。
- owner 这一段定的：D60（判决记下判定时的叶子 `fileTarget`）、D61（快照能力变差后会话授权与继承授权不算、重新出卡）、ADR-005（评测基线列换成 glm-5.3-flash，PR #74），并接受 11 题在第 12 版上 1/3（原话见 decisions.md 末尾）。
- 第 11.1 步：基线列换成 flash（ADR-005）。flash 上第 11 版参考 57/60（PR #74）；第 12 版第一次跑 57/60，之后 Delete 的 `targetChanged` 一句改成两个方向都对，哈希从 `430552…` 变为 `a37b8c0d…`，在终版哈希上重跑 58/60，旧哈希那 60 条移出仓库、另存私有笔记（另记）。逐题对照第 11 版：02 1/3 → 3/3，20 2/3 → 3/3，11 3/3 → 1/3；11 的两次失败，一次是模型用新的 Delete 删自己建的临时脚本、评测宿主拒卡（owner 已接受），另一次是模型读输出文件时把长临时路径抄成了工作区外的路径、出了工作区外的卡（04 plan 第 15a 步记过 16 题的同类失败），与第 12 版的改动无关；其余 17 题都是 3/3。60 条都是 `sandbox: active`。
- 门禁：基于 dev 的分支上 G 全过，T 5169 过、114 跳过；`evals:gate` 30 过、1 跳过。全量在负载下偶见 `03 验收 30 (HTTP)` 时序用例失败，单跑稳定。

花费：2026-10-25 · flash 第 11 版参考全集（ADR-005，PR #74） · ¥3.79 · ¥3.79 / ¥20
花费：2026-10-25 · flash 第 12 版全集（旧哈希，已作废） · ¥3.70 · ¥7.49 / ¥20
花费：2026-10-25 · flash 第 12 版全集（终版哈希） · ¥4.18 · ¥11.67 / ¥20
花费：2026-10-25 · 免费模型 GLM-4.7-Flash、GLM-4-Flash-250414 各一题实测（ADR-005 调研） · ¥0 · ¥11.67 / ¥20

测试改动：packages/kernel/test/tape/names.test.ts · 身份三元组与名字总表 · `fs/snapshot_created` 从保留名变成已声明身份，加入两个还原名字
测试改动：apps/desktop/test/tape/conformance.test.ts · 共享用例数量 · 新增 fs 一致性用例，44 → 45
测试改动：packages/kernel/test/tape/provenance.test.ts · 键格式 · 加三种 fs 键
测试改动：packages/kernel/test/tools/builtin.test.ts · 参数表、effect 表、工具数量 · 加入 Delete，任务形态工具表 11 个
测试改动：packages/kernel/test/tools/write-edit.test.ts · 成功的 Write、Edit · 期望里加上新记的文件印记
测试改动：packages/kernel/test/loop/stop.test.ts · 停止落在派发提交时的写 · 原期望等写完、超时记 `uncertain`，05 让写类文件工具动文件前查中止，改成写前中止、内容不变（spec §点名 (j)）
测试改动：packages/kernel/test/loop/subagent-run.test.ts · 子任务崩溃后恢复 · Read 改走 `guarded.read`，读取计数的拦截随之改接，不重跑的断言不变
测试改动：packages/kernel/test/loop/tool-table.test.ts · 内置工具表 · 加入 Delete
测试改动：packages/kernel/test/provider/probe.test.ts · 智谱探测与冻结的任务表 · 加入 Delete，策略过滤的断言不变
测试改动：packages/kernel/test/tools/table.test.ts · 请求的容量上限 · 多一个内置工具，截断边界随之改
测试改动：apps/desktop/test/evals-runner.test.ts · 精确工具表 · 加入 Delete
测试改动：apps/desktop/test/custom-vendor-runtime.test.ts · 任务形态工具表 · 加入 Delete
测试改动：apps/desktop/test/mcp-routes.test.ts · 03 验收 35 · 多一个内置工具后，超限省略数改为 2
测试改动：packages/kernel/test/prompts/version.test.ts · 04 验收 24 (version) 与版本历史 · 提示层 11 → 12，第 12 版哈希为 `a37b8c0d…`
测试改动：apps/desktop/test/workspace-locate.test.ts · 05 验收 30 大小写不敏感的文件与链接 · 新用例要大小写不敏感的临时卷，只在 macOS 上跑；Linux 的临时目录区分大小写，`skipIf` 跳过，同一行为由 kernel 的内存宿主用例覆盖

## 评审 · 2026-10-25 · 审过 f7cffce（对照 spec）

结论：通过    评审：新上下文的子 agent（Opus），对照 spec 05 与 plan 第 6–11 步
突变：无（只读代码、跑复现）
发现：
- [建议] 「1 秒」只测了上界，把超时改成 10 毫秒测试仍全绿 · 证据：副本里实改复现 · 已修 b38e24a
- [建议] 卡上没标「有快照」的文件调用一律不拍，比 §快照怎么拍 字面窄 · 证据：用例专门断言不调 `take` · 已修 b38e24a
- [建议] 改了 02 的一条停止测试，没写测试改动、也没在 §点名 登记 · 证据：`stop.test.ts` 期望从 `uncertain` 改成 `aborted` · 已修 7f79c32
- [建议] Postgres 那一半在 CI 里永远跳过 · 不修：lead 2026-10-25 在 PostgreSQL 18 上手动跑过，记在上面的实施记录，标（人工）
- [建议] 验收 2 只测了 Write · 已修 b38e24a
- [建议] 验收 30、3 有几处没有直接断言 · 已修 b38e24a
- [建议] 提示层的新增不止 Delete 描述加四句（还有 Delete 的结果模板） · 已修 7f79c32
- [建议] `SnapshotCreatedPayload.commits`、`files` 永远不会被填 · 不修：记进 plan 的 Open，第 13 步再定
- [建议] plan 与 log 没跟上 · 不修：本记录与上面的实施记录即是

## 评审 · 2026-10-25 · 审过 f7cffce（安全）

结论：通过    评审：新上下文的子 agent（Opus），绕过保护、丢数据、没留底就写三个方向；PoC 另记
突变：无（只读代码、跑 PoC）
发现：
- [建议] 会话授权在快照能力变差之后照样放行、不出卡也不留底 · 证据：PoC-B 复现 · 已修 b38e24a（owner 定 D61）
- [建议] Delete 只拦「文件变成链接」、不拦反方向 · 证据：PoC-D 复现 · 已修 b38e24a
- [建议] 一个文件同时属于几类保护时卡上只说第一类 · 证据：PoC-A 复现 · 不修：要改审批卡的格式，记进总参考「以后再说」
- [建议] Write 被第二次检查拒绝时已建的父目录留下 · 证据：PoC-C 复现 · 已修 b38e24a
- [建议] Delete 记下的叶子大小写可能和盘上不同 · 已修 b38e24a

## 评审 · 2026-10-25 · 审过 f7cffce（突变）

结论：不通过（测试缺口要补）    评审：新上下文的子 agent（Sonnet）跑 StrykerJS，只变异本段改过的生产代码行；报告与原始结果另记
突变：839 个；第 1 组（守卫、Delete、Write、Edit、Read、印记、快照请求、可逆性、授权、判定）438 个，得分 78.3%，存活与无覆盖 95 个逐个判过：测试缺口 54、等价 15、无意义 26，另写 46 条探针，测试缺口全被探针杀死、等价与无意义一个没被杀；第 2 组（batch、closure、mailbox）358 个 70.7%，第 3 组（Tape 键、提示层）27 个 81.5%，第 4 组 16 个 87.5%，只出报告
发现：
- [major] 并行 Read 两个文件时印记按调用身份区分、守卫拒写后不清旧印记，这两条行为改坏了测试也不红 · 证据：对应突变存活，探针在未变异代码上通过 · 已修 e83eb09
- [建议] 其余 19 条测试缺口（Delete 的拒绝文案、Edit 写入出错、拍后出现或消失、同尺寸改写、自动档的 Edit 与 Delete、旧事实、恢复链成环等） · 已修 e83eb09

## 评审 · 2026-10-25 · 审过 b38e24a（复核）

结论：通过    评审：新上下文的子 agent（Opus），逐条核第一轮修复：撤回或改坏修复看点名用例是否变红
突变：手工撤回或改坏 20 余处，点名用例都变红；D61 的强弱比较去掉 → 17 条红，只让继承授权跳过 → 8 条红，方向反过来 → 25 条红
发现：
- [建议] Delete 的父目录列不出时，工作区里的普通文件被判成 `protected`、回给模型的理由也不对 · 证据：内存宿主让 `readdir` 抛 EACCES 复现 · 已修 e83eb09

## 评审 · 2026-10-25 · 审过 e83eb09（复核）

结论：通过    评审：新上下文的子 agent（Opus），只看 Delete 父目录回退与补的测试
突变：撤回回退、去掉执行期复查、去掉 `actual ?? real`，点名用例都变红（`missing` 那组除外，见下）
发现：
- [建议] 宿主错误被说成「文件变了」 · 证据：探针 P1b 复现 · 已修 4e9366c
- [建议] 判定时有歧义、执行时父目录变得列不出，复查会放行 · 证据：探针 P2 复现 · 已修 4e9366c
- [建议] 「missing」那组用例断言太弱，挡不住回退被拿掉 · 证据：只去掉 readdir 内层 try/catch 时仍绿 · 已修 4e9366c
- [建议] 两处已有测试改了期望，需要写测试改动 · 不修：写在上面的实施记录里

## 评审 · 2026-10-25 · 审过 4e9366c

结论：通过    评审：新上下文的子 agent（Opus），只审 Delete 宿主错误与歧义这一处修复；第 6–12 步其余部分见上面各条
突变：执行侧宿主错误改回 `targetChanged`、外层 catch 改成按歧义、去掉执行器开头的歧义拒绝、`!== false` 改成 `=== true`、missing 映射成 `targetChanged` 等，点名的「05 验收 30」用例都变红
发现：
- [建议] 等审批时重启、再批准一张 Delete 卡，统一拒绝并回 `targetChanged`，文件其实没变 · 证据：本提交的用例「a recovered Delete without its in-memory judgment marker refuses conservatively」断言的就是这一点 · 不修：只会更严；这一轮不改给模型的文字、不加 Tape 字段，记进 plan 的 Open，下次改提示层时换成准确的一句
- [建议] 被拒、没批或派发前被停止的 Delete，内存里的歧义标记不清，进程生命期内只增 · 不修：每条约百来字节；第三段碰 `batch.ts` 时顺手在判决收口处清掉
- 分支在 4e9366c 上 G 全过，T 5169 过、114 跳过；`evals:gate` 30 过、1 跳过。

## 实施 · 2026-10-25（PR #75 的 e2e）

- e2e 红在两条 presentation-r1 的旧期望：`write-card.spec.ts`（验收 3）的审批卡与 `tools.spec.ts`（验收 6）的工具行还写着「没法替你撤回」。第二段接上 `coverage` 之后，真宿主上工作区里的写入判成 `snapshotted`，卡与工具行显示 presentation-r1 给 `snapshotted` 的暂定句「Tenon 保存了改动前的副本。」。两条期望改成这一句（7fd3113）。

测试改动：apps/desktop/e2e/write-card.spec.ts · presentation-r1 验收 3 · 工作区里的新文件真宿主答 `file`，卡上第 ④ 句从「没法替你撤回」变成 `snapshotted` 的暂定句
测试改动：apps/desktop/e2e/tools.spec.ts · presentation-r1 验收 6 · 成功的 Write 那一行同理改成 `snapshotted` 的暂定句；出错的 Edit 不出这一行，照旧断言

## 评审 · 2026-10-25 · 审过 7fd3113

结论：通过    评审：新上下文的子 agent（Opus），只审这两处 e2e 期望；读代码核对 `readCoverage`、`reversibilityOf`、`undoKey` 与 locale，不跑 Electron
突变：无（只改 e2e 期望）
发现：
- [建议] 两条断言钉的是 presentation-r1 的暂定句，第 15 步换成 05 的终稿后会再红 · 不修：记进 plan 第 15 步，到时同改这两条断言与注释
- [建议] write-card 那条写的是新文件，注释引的验收 1 说的是已有文件 · 不修：行为不受影响，第 15 步改注释时改引验收 52
- [建议] 硬链接那条 e2e 现在就能断言「没法替你撤回」那句 · 不修：第 15 步补，与交接里已记的那条合并
- [建议] write-card 用例后半段在 `snapshotted` 下还没在 CI 跑过 · 不修：本次推送后由 CI 的 e2e 验证

## 实施 · 2026-10-28（第三段第 13、14 步）

- Codex 在 `codex-render`（分支 `feat/05-seg3`）实现，lead 审、沙箱外跑全量后提交检查点：第 13 步宿主一半 1afe0cd、kernel 一半 cdb5e91，第 14 步路由 1ef2916（本分支上的提交号）。沙箱外全量 5273 通过、114 跳过；提示层哈希没变。
- 第 14 步之后发现 spec 正文与验收 16 要清单单独标出命令改的路径，§接口 的 `RestorePreview` 没有路径来源。owner 定不标、放宽 spec（D62），问卷原话：「不标，改 spec 放宽」。
- 验收 15 要 macOS、Linux 两个平台，CI 原来只在 Linux 跑 e2e。owner 问卷原话：「ci.yml 加 macOS e2e 任务 (Recommended)」。lead 在 `sandbox-macos` 任务里补装 Electron，只跑 `restore.spec.ts` 与 `write-card.spec.ts`，报告另传 `e2e-macos-report`。改了门禁文件，第三段 PR 不开自动合并，由 owner 合。

## 实施 · 2026-10-28（第三段第 15 步）

- 检查点 443f1ab：审批卡 ④ 换成终稿句；工具行的失败标记、Delete 展开那一行与快照号；结算行的 Delete 一类、「可还原」与两种附注；还原清单（冲突逐个问、默认保留、取消不发请求、`stale` 重出并把覆盖选择重置为保留）；`ThreadTitleMenu` 的只读记录；「上次还原没做完」提示。
- 第一次派出时 Codex 停下报告：界面拿不到每次调用的快照号、也对不上结算行属于哪一轮。lead 没动已合入的 `session.messages`，只在新路由 `snapshot.rounds` 里补每轮的 Run 与每次调用的快照号（spec 澄清，见修订记录）。第二次又停：历史消息不画结算行、重启后没有还原入口；owner 定 D63，`snapshot.rounds` 再补每轮结束的那条消息。
- lead 审出 `rounds()` 每次都给每个能还原的轮重算宿主预览、界面每次工具调用结束都刷新：改成按「轮 + 这一轮各 Tape 的末条事实 + 存活」记住预览结论（只在内存），界面同一时刻只发一个请求、500 ms 内的工具事件合并。代价：两次 Tape 变化之间，结算行附注不随工作区实时变；点「可还原」时清单照旧现算。
- 沙箱外全量：5304 通过、114 跳过；提示层哈希没变。
- 文案：界面新增约 70 句中英文，Codex 起草、lead 审，只改了冲突那句。

测试改动：apps/desktop/e2e/write-card.spec.ts · presentation-r1 验收 3 · 卡上 ④ 从暂定句换成 05 终稿句，注释改引验收 52
测试改动：apps/desktop/e2e/write-card.spec.ts · 05 验收 25 硬链接写入 · 改用中文界面断言，补「没法替你撤回」与卡上没有「有快照」两条（加强）
测试改动：apps/desktop/e2e/tools.spec.ts · presentation-r1 验收 6 · 展开那一行的 ④ 换成 05 终稿句
测试改动：apps/desktop/test/copy-coverage.test.ts · 结算计数覆盖 · 类别由六类加到七类（Delete），并新增验收 35 的穷举
测试改动：apps/desktop/test/renderer-approval-card.test.ts · 原因、类别、可逆性全表 · `revertible` 期望不出 ④（spec §审批卡 ④：`revertible` 不出现）
测试改动：apps/desktop/test/renderer-tool-row.test.ts · 03 验收 45、presentation-r1 验收 6 · `revertible` 期望不出撤回说明，理由同上
测试改动：apps/desktop/test/renderer-live-thread.test.ts · 结算的两条用例 · 计数对象多一项 `delete: 0`
测试改动：apps/desktop/test/renderer-thread-model.test.ts · 结算计数的七条用例 · 计数对象多一项 `delete: 0`
测试改动：apps/desktop/test/renderer-to-thread-messages.test.ts · 结算的三条用例 · 计数对象多一项 `delete: 0`
测试改动：apps/desktop/test/session-store.test.ts · 子任务调用只读一次 · 计数对象多一项 `delete: 0`
测试改动：apps/desktop/test/shutdown.test.ts · 退出时拒绝的路由 · 清单加 `snapshot.restore`，保留不进 kernel、不写事实的断言（第 14 步）
测试改动：apps/desktop/test/session-removal.test.ts · 清空、删除期间拒绝的路由 · 清单加 `snapshot.restore`（第 14 步）
测试改动：packages/contracts/test/registry.test.ts · 完整通道清单 · 加三条 snapshot 通道（第 14 步）

## 实施 · 2026-10-29（第三段第 16 步）

- e2e `restore.spec.ts`（验收 15、29 与 D63 的重启）在 PR #77 的 Linux CI 上三条都过；macOS 那一半要等 `ci.yml` 的提交推上去（本机 gh 令牌缺 `workflow` 权限，提交暂存在本地分支 `feat/05-seg3-ci-commit`，等 owner）。
- 同一次 CI 里两条旧 e2e 红：结算行期望没有「 · 可还原」。05 验收 33 让留了快照的轮加这一段，是期望过期，改期望。
- 恢复快照子进程时核对 `executable`（plan Open 那条）在第三段补上：1bbce1f。

测试改动：apps/desktop/e2e/subagent.spec.ts · presentation-r1 验收 7 · 子会话的 Write 留了快照，结算行末尾加「 · 可还原」（05 验收 33）
测试改动：apps/desktop/e2e/write-card.spec.ts · 旧 222 写入一半 · 获批的写入留了快照，结算行末尾加「 · Can be restored」（05 验收 33）
测试改动：apps/desktop/test/snapshot-git.test.ts · 起真进程的恢复用例 · 收尾改成不判断存活、直接结束进程组（plan Open）；带空格路径与 xcrun 用例显式配置对应的 git 路径
