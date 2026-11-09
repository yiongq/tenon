# 06 · plan

## 当前 / 需要你

当前：ready。第一段（第 2–6 步）做完，评审通过（log 2026-11-09，审过 316af4c），等开 PR 合进 dev。
需要你：第二段开工前回两个问题（Open 第一条的「要问 owner」）。

## 开工前读

- AGENTS.md；docs/spec-driven-dev.md 的「本项目补充」（第 5 条 StrykerJS、第 6 条预算检查点、第 7 条提示层评测基线）；本目录的 spec、decisions、evidence。
- 02 §会话形态、§会话事实、§决策表与各层输入、§合并：两步、§作用域与授权键、§可逆性、§Inspector 接口与合议、§挂点与会话视图、§外带检查、§railguard 映射、§判决记录与摘要、§上限、守卫与用量、§提示层与评测；04 §档位计划写进判决、§拦截回执与放行、§网络白名单、§已知限制；05 §快照怎么拍、§判定时怎么知道拍不拍得了、§给 06 的接口；presentation-r1 §审批卡、§拦截回执、§工具行；auto-tier-hardening 的 spec。
- 实现三句（派实现子 agent 时原样带上）：测试有错就直说；不为某个用例写死结果；同一处反复跑红就停下报告。
- 平台与机密：e2e 不在 owner 的 Mac 上起窗口，走 CI 草稿 PR，或 Lima 虚拟机里 xvfb；基线评测的 key 只从进程环境读，命令里只写变量名；真花钱之前先问 owner。
- 分工：每段由 Codex 实现（经 codex-dispatch，各段一个 worktree、一个分支），lead 在每段末按 spec 审、跑门禁与突变、派多视角评审。

## 分段

| 段 | 分支 | 步骤 | 内容 | 粗估 | 合入后 |
|---|---|---|---|---|---|
| 一 · 判定 | `feat/06-seg1` | 2–6 | 档位事实、草稿与读档；自动档范围与照问的原因；覆盖写与 `>` 名单；免问命令的环境（kernel，不碰提示层，没有路由与界面） | 4 800–6 900 行，17 条 | 产品仍恒为手动：desktop 不调切档 |
| 二 · 机器检查与回执放行 | `feat/06-seg2` | 7–14 | 外带检查扩到命令（检查前采样、检查后复核）；railguard 适配器；回执放行的 kernel、`inspector.release` 路由、主进程接线、按钮与说明、端到端；第二段的卡与回执文案；累计熔断与降档；提示层 13 与基线评测 | 4 800–7 200 行，13 条 | 仍为手动；两条新检查在手动档已生效，拦下的能从回执放行（D12、D11 补记） |
| 三 · 开放自动档 | `feat/06-seg3` | 15–24 | 切档路由与 config；档位菜单、横幅、说明条、降档提示、设置；文件夹授权；照问原因的文案、Delete 卡标题、展开工具行的原因；e2e；文档同步 | 4 100–6 900 行，14 条 | 你第一次看到自动档 |

- 第三段开工前 auto-tier-hardening 要已 implemented（D22）。
- 第一个会拒的检查与回执放行的全部（kernel、路由、接线、按钮、文案、端到端）在第二段同一个 PR（02 §权限 不变量 17）。
- 提示层的改动都在第二段：版本一升，CI 的 `evals:gate` 到基线记录提交之前是红的，所以升版本与基线评测在同一个 PR。
- 合计粗估约 13 700–21 000 行、44 条，中位约 1.7 万行；检查点在第二段末（第 14.1 步）。

## 命令

- G：`pnpm format:check && pnpm lint && pnpm typecheck`
- T：`pnpm vitest run --maxWorkers=2`
- P：G、T 之后 `pnpm build && pnpm evals:gate --maxWorkers=2`
- E：e2e 只在 CI 草稿 PR 或 Lima 虚拟机里跑
- S：`python3 .sdd/spec-check.py`；改了页头与 plan 的「需要你」后 `python3 .sdd/spec-check.py --index`
- M：`python3 .sdd/spec-check.py --mutants`（log 里登记过的突变逐个打上、跑门禁、还原）

## 步骤

- [ ] 1. 改 ready 之前
  - [x] 1.1 挑刺评审 r1（Codex 交叉评审，2026-11-08）：1 blocker、4 major、2 minor；草稿第二版已逐条照改（D11 补记、D16、D27–D29、E20 更正、验收重排）。同日 Codex 复核 r2：r1 六条已修、一条部分修，另有 1 major、2 minor；第三版照改（D30、E25 重写、P1 补证 dist、编号刷新）。同日 Codex 复核 r3：r2 两条已修、一条部分修，另有 1 major、2 minor；第四版照改（回不去的点分三种情况、D31 改准、D32 兜底按 verdict、headers 与已知限制、验收 29、30 的夹具）。同日最后一次复核 r4：无 blocker、无 major，3 个 minor（验收 44 与 38 的工具行范围、E36 的类别校验范围、第 14.1 步的条数算法）已改。放进仓库时把两轮结论与逐条处置记进 log「## 挑刺评审 · 日期 · 审过 <提交号>」，原文留私有笔记。
  - [x] 1.2 P1 与 P2（2026-11-08）：P1 满足，依赖写 npm 精确版本 0.7.0；P2 能打开，回不去的一点（`inspector-flagged`）写进 spec「迁移与回退」与第 24 步的验收清单，引出第三版的开放问题，owner 已定为 D32。结果在 evidence。
  - [ ] 1.3 挑刺评审 r2（改 ready 时还没跑，改为与第一段并行补跑；发现照常处置，动到「给你看的一页」的先问 owner）：新上下文、Opus，两个视角：规则与安全（先读 overview §信任边界）、测试（验收测不测得了、会不会测空）。档位切换、草稿落盘、待批卡、重启重判、回执作废这几处先后有关，配一段能跑的小程序进私有笔记的 `research/`。
  - [x] 1.4 owner 答第一版的开放问题（2026-11-08，D23–D26；D22 lead 按推荐定）。
    - [x] 1.4.1 owner 答第三版的开放问题（2026-11-08，D32 选 A：容忍，即对改 02 contracts 读取端校验的点名批准）；spec 已加规矩 14、§点名 (j) 与验收 44，实现在第 15、18 步。
  - [x] 1.5 放进仓库（同一个 PR，162c16a）：spec、plan、decisions、evidence 进 `docs/architecture/06-approval-modes/`；照 headers.md 改 01、02、04、05、presentation-r1 的页头与总参考的四处；入口页重新生成；跑 S，`pairs`、`line-refs` 不拦。
  - [x] 1.6 owner 读「给你看的一页」，回一句带编号的话；页头加 `Approved:`，Status 改 ready，阶段表 4c 同改。
- [x] 2. 档位事实、草稿与读档（kernel）：`session/approval_mode_set` 的名字、载荷、键、投影与两种存储的一致性测试；`SessionDraft.approvalMode`；`setApprovalMode`（建立前写草稿、建立后写事实，经根会话 mailbox，关机中拒，对话会话拒，策略关掉时拒）；`approvalModeDefault`；`creationEntries` 同批写、`carryEntries` 清空时照抄；`judgeCall` 读根会话当前档位（对话恒为手动，子会话跟根会话）；策略关掉时写 `by: 'policy'`。测试点名验收 11、12、13、14、15、16。自动档测试显式设置根快照状态；重启后的正向夹具重设 tree 并断言重判实际会放行。默认档与草稿在发送预建开始时一起采样。Run 的策略折叠写入排进根 mailbox，与用户切档同队，writer 按入口填写；关闸拒绝，用户停止后的收尾期间仍可切档。
- [x] 3. 自动档范围：`LayerInputs` 只增三项；`judgeCall` 读 `snapshots.status`、`posture()`、`SandboxPorts.autoCommands`；`decide` 第 7 层两类放行；`autoAsk` 的五种原因与先后；`modeRule` 与 `summarize` 的 `auto-mode`。测试点名验收 1、2、3、4、5、6、9、10。验收 1、5、6 从 judgeCall 进入，不手填 commandSandboxed/autoAsk；验收 9 的固定表由 62fed4d 的旧实现录制，覆盖工具、路径、coverage、授权、姿态、快照状态与 autoCommands 的两两组合和边界；比较完整 Decision，另做自动档的变形关系检查。快照可用只认 tree / warming / file-only。固定表共 28 个 decide、67 个 judgeCall 判决；变形关系要求至少 17 次问变放行、其中 Bash 至少 3 次。旧 decide 与 sensitive 测试只补 snapshotStatus: tree，不改期望。
- [x] 4. 覆盖写七行与 `autoStillAsk`：每行的命中与不命中样例，模块加载时自测。测试点名验收 7、8。
- [x] 5. 免问命令的环境：`perform` 按派发的判决过滤 `CommandRun.env`，名单与规则是常量。测试点名验收 17。
- [x] 6. 第一段核对：G、T、S；多视角评审（对照 spec、安全、突变，各一个新子 agent），StrykerJS 只对改动过的文件跑、只出报告；汇总评审写 log。要出的突变至少有：
  - `decide` 自动分支去掉快照状态条件（验收 1 的 `unavailable` 一例应红）；
  - `commandSandboxed` 改成「state 不是 `unavailable`」（验收 5 的 `pending`、`degraded` 应红）；
  - `autoCommands` 缺省读作 `'yes'`，或 `'no'` 也给 `linux`（验收 5 应红）；
  - 删掉 `git reset --hard` 一行，或把 `git restore` 的 `--staged` 例外放宽到带 `--worktree` 也不命中（验收 7 应红）；
  - `autoStillAsk` 不排除 `/dev/null`（验收 8 应红）；
  - 环境过滤只认名单、不认规则（验收 17 应红）；
  - 子会话读自己的档位（验收 11 应红）；
  - 建会话时默认值盖过草稿里的选择（验收 13 应红）；
  - `carryEntries` 不带档位（验收 16 应红）；
  - 免问时写一条会话授权（验收 10 应红）；
  - `rejudgeWaiting` 把更宽的判决当真（验收 14 应红；tree 下同一调用重判实际为 allow，仍须保留原待批卡）。
  - 比较卡时不排除 `autoAsk`，或把全部 facts 都排除（验收 14 应红）；
  - 运行中切档总是结束借用的租约（验收 14 应红）；
  - Run 的策略折叠绕过根 mailbox（验收 15 的可暂停并发例应红）。
  - 启动恢复的策略折叠绕过根 mailbox（验收 15 的恢复并发例应红；正式突变 M17）。
- [ ] 7. 外带检查扩到命令：`judgeCall` 照现有顺序，检查前采样 `canReachNetwork` 与 `commandSandboxed`、检查后按最终计划复核、有变就重跑，最多三次、第三次偏严（D30）；`SandboxPorts.canReach`（desktop 照 `updateAllowlist` 的合并规则答）；`InspectedCall.canReachNetwork`；`exfiltrationOpinion` 认 Bash；命令卡 facts 的 `category`。测试点名验收 18、29、30。
- [ ] 8. railguard 适配器（按 P1 的结果钉依赖）：`InspectorCategory` 与 contracts 的类别只增两个；适配器只用 `inputHygiene`、查 D21 的参数；`summarize` 的 `inspector-flagged`；desktop 注册表加适配器。改 `inspectors.test.ts` 那条 02 不变量 17 用例与「`receipt-override` 字面量的写入方」用例的提交必须同时带上第 9、10 步。测试点名验收 19、20、23、25。
- [ ] 9. 回执放行（kernel）：`tool/inspector_override` 的名字、载荷、键、投影与一致性测试；`releaseInspector` 的核对；绑定与 `inspectorOverride`、`basis.override`；与 04 一次性放行共用的作废算法（04 的三种放行行为不变）；告诉模型的检查点。测试点名验收 21、22。
- [ ] 10. 回执放行（路由与界面）与第二段文案：contracts 的 `inspector.release`、主进程接线（关机中拒）；回执的「允许这一次」与说明、「已放行」；`hidden-characters` 与命令卡 `category` 的句子；对象行的可见记号；累计结束的结束文案；两份 locale 与文案覆盖。文案定稿写在这一步的交接里。测试点名验收 26。
- [ ] 11. 累计熔断与降档：`MACHINE_DENIAL_ROUND_CAP`、`chainCounters` 另数累计、执行循环到 20 结束、`scope: 'round'`、自动档写 `by: 'downgrade'`。测试点名验收 24。
- [ ] 12. 提示层：inspector 放行的告知行、Bash 描述那一句、累计到上限的 not-run 句；`PROMPT_LAYER_VERSION` 12 → 13、更新哈希。从这一步起 CI 的 `evals:gate` 红，到 12.1 为止；之后再改提示层文本回到这一步改哈希，不再加版本。
  - [ ] 12.1 基线评测（live）：真跑前先问 owner，说清跑什么、花多少（基线列 glm-5.3-flash 全集每题 3 次约 5 元；ADR-005 要的 02 题在 glm-5.3 上 3 次约 2 元，一并问）；在沙箱生效的 macOS 上跑；记录与改动同一 PR；lead 逐题对照第 12 版，对照表写进 log；有题从过变不过就停下交 owner；花费记 log。点名验收 28。
- [ ] 13. e2e：验收 27（拦下 → 允许这一次 → 同一条命令照常运行），macOS 与 Linux 两个 CI runner；走 CI 草稿 PR，一次推送攒齐。
- [ ] 14. 第二段核对：P；E；多视角评审与 StrykerJS 同第 6 步；汇总评审写 log。要出的突变至少有：
  - `canReachNetwork` 恒为 false，或 `canReach` 按「预设生效」算（验收 18 的只读档一例应红）；
  - 适配器把 `modified` 读成没意见（验收 19 应红）；
  - 适配器声明 `ceiling: 'ask'`（验收 20、23 应红）；
  - 绑定只比工具名、不比 `argsHash`（验收 21 应红）；
  - 一次性放行永不作废（验收 21 应红）；
  - `releaseInspector` 写成 `tool/receipt_override`（验收 21 应红）；
  - `summarize` 把 `inspector-failed` 的问给 `inspector-flagged`（验收 25 应红）；
  - 累计时把只带 `observed` 的也算进去，或上限写成 21（验收 24 应红）；
  - 回执按钮在 `policy` 的拦截上也出（验收 26 应红）；
  - 复核发现变化也不重跑检查，或第三次不按 `canReachNetwork: true` 跑（验收 30 应红）；
  - 判决改用检查前采样的那份计划（验收 29 应红）。
  - 14.1 预算检查点（本项目补充第 6 条，06 单独算，D11）：代码行数取第一、二段 PR 合计的实际 `git diff --shortstat` 加第三段的估计；验收条数取届时的全篇总数，现在是 44 条（17 + 13 + 14），不再另加第三段的条数；行数超过约 18 500 或条数超过 53，先告诉 owner，再按 ① 持久文件夹授权拆成 feature spec、② D10 挪阶段 6、③ 说明条不做、④ D4 只做 ② 的顺序定砍不砍；结果写 log。
- [ ] 15. 切档路由与 config：`session.setApprovalMode`（建立前写草稿）、`session.facts` 的档位、config.json 三个键与 `approvalModeDefault` 的接线、`workspace.pick` 与 `usePrefill` 的 `pendingGrant`、`workspace.grant`、`workspace.access`、`workspace.revokeAccess`，都经 contracts 登记、两端校验。contracts 读取端对认不出的摘要码读作 `unknown`、保留 verdict，类型断言改为单向（D32）。测试点名验收 12、13、15、36 的路由一半与 44 的读取一半。
- [ ] 16. 档位界面：`ApprovalModeMenu`（含发第一条消息之前、快照不可用时的说明）、`ComposerBanner`、说明条、降档提示、设置「权限与网络」的审批档段与次序。测试点名验收 31、32、33、34、35。
- [ ] 17. 文件夹授权：`GrantDialog` 的文件夹版、`FolderChip` 的授权与撤销入口、设置里的文件夹访问列表。测试点名验收 36、37。
- [ ] 18. 第三段文案：五种 `autoAsk` 的句子与认不出时的通用一句、命令卡上认不出的 `category` 的通用一句、未知摘要码按 verdict 的三句中性说明、Delete 卡标题、展开工具行的原因一行、`summary.auto-mode` 改成「自动档放行」；两份 locale；文案覆盖测试。测试点名验收 38、39、42、43、44。
- [ ] 19. e2e：验收 40，macOS 与 Linux 两个 CI runner；走 CI 草稿 PR，一次推送攒齐。
- [ ] 20. 第三段核对：P；E；多视角评审与 StrykerJS 同第 6 步；汇总评审写 log。要出的突变至少有：横幅点击不切档（验收 32）、说明条不写 `autoModeNoticeSeen`（验收 33）、「以后都允许」不落盘（验收 36）、原因一行在问过的调用上也出（验收 38）、策略关掉时菜单仍有自动项（验收 31）、`platform` 出了 Linux 那句（验收 39）、认不出的 `autoAsk` 让卡投递失败（验收 43）、未知摘要码让 `session.messages` 校验失败或一律显示「需要确认」（验收 44）。
- [ ] 21. 文档同步：spec §文档同步「实现时」各处；未解决的 Open 与跟进挪进总参考「以后再说」或写明已定，在派最后一次评审之前做完。点名验收 41。
- [ ] 22. 对照验收逐条核对：每条验收有点名它的测试或标了（人工）（live）；矩阵的「突变」列补齐；S 的 `trace` 不拦。
- [ ] 23. 清理：临时探针与调试输出清掉；复现程序与原始输出只放私有笔记（另记）。
- [ ] 24. owner 验收 → 改 Status。验收清单里点名告诉 owner 回退限制（P2 与 spec「回不去的点」）：06 写过 `inspector-flagged` 的会话，回到 06 之前的版本后消息列表加载失败（实测）；回退时正等着的看不见字符的卡，只有旧版重判仍放行的那种（如工作区里的 Read）投递不出，重判出新卡的与命令卡照常投递（按代码与源码探针）；新卡投递得出也不等于消息列表恢复。

## 交接

2026-11-09：owner「06 改 ready」，页头与阶段表已改。auto-tier-hardening 已 implemented（#88，f222db5），第三段的前置依赖解除。第一段分支 `feat/06-seg1` 从本分支切出。

2026-11-08：草稿第三版在私有笔记 `2026-11-08-06-approval-modes/draft/`，照 owner 对两轮开放问题的选择、Codex 交叉评审 r1、复核 r2、r3 与 P1、P2 的结果改过；在 dev `c894922` 的临时 worktree 里照 headers.md 改好页头后跑过 S：拦 0 条，与 06 有关的警告只剩 `trace`（还没有测试）与 `docs-sync`（overview 留到实现时改）。下一步：第 1.3 步挑刺评审 r2，然后第 1.5 步放进仓库。

2026-11-09 · 第一段实现交接：第 2–5 步已完成，十个突变已验证并还原，细节见 log「2026-11-09 · 第一段实现与交接」。未提交；下一步由协调者做第 6 步独立评审、StrykerJS 与沙箱外补跑。

2026-11-09 · 第一段 r2 补充交接：已处理测试视角 M1–M11、m1–m7、m11 与规则视角的第一段条目；m5 平台映射单测留第三段。102 个验收用例、十二个突变与 G 通过；T 仍有相同五项环境失败，S 只拦独立评审。逐条处置与红绿证据见 log「2026-11-09 · 第一段补充：r2 处置与交接」。本轮未提交，第 6 步保持未勾；下一步由协调者评审、StrykerJS 与沙箱外复验，Open 未改。

2026-11-09 · 第一段三路评审处置交接：Run 的策略事实已与用户切档排根队，实际 writer、停止与关闸、白名单及命令边界已修；134 个验收与 49 个突变还原验证通过。正式突变 M1–M16 的原文各出现一次，详见 log「2026-11-09 · 第一段独立评审处置（e67773b 后）」。本轮不提交，第 6 步待协调者复核并在沙箱外跑正式 --mutants；五项全量环境失败与唯一 review 拦截保留，spec 与协调者 Open 未改。

2026-11-09 · 第一段两路复核处置交接：restore 的 source / staged 与整尾 worktree 边界已修；恢复读写排根队新增可暂停测试与正式突变 M17。关机闸、判定 writer 均必填；139 个验收与本轮 17 个补充突变通过还原验证，日志只追加，代号逐项说明。spec 仅增加协调者指定两行，Open 未改。本轮未提交；第 6 步由协调者复核并在沙箱外跑正式门禁，五项环境失败与唯一 review 拦截保留。

## Open

- 挑刺评审 r2（2026-11-09，原文在私有笔记）第一段的条目已改进 spec 或交第一段实现；第二、三段开工前还要处理：
  - 要问 owner：看不见的字符在卡上用哪种写法（D25 当时依据的界面现状写错了，要按现状重问）；外带检查对命令的口径与 auto-tier-hardening 对齐，「给你看的一页」那句跟着改。
  - 第二段开工前 lead 定、改 spec：子会话的机器拦截算不算进根会话这一轮的累计；命令卡同时带 `category` 与 `autoAsk` 时显示哪一句；「继续」开的 Run 算不算回执作废的下一轮；inspector 放行与 04 一次性放行同在时怎么绑；第 20 条在重判时写下时由谁结束本轮、降档与结束同一次写入；验收 19、21、24 补齐情形；检查期间白名单变化的复核补验收；验收 18 的只读档一例放到 desktop 测；矩阵第 28 行拆成确定性与 live 两条；验收 24 的夹具排到突变咬得住。
  - 第三段开工前：策略关掉后 `session.facts` 报手动；contracts 怎么映射 kernel 的 `refused`；文件夹授权 token 的生命周期；e2e 两个平台的门禁与等沙箱 active；「以后都允许」落盘的突变咬得住；验收 20、33 各在哪层测。
- spec 全文超过 heavy 档上限约 700 字符（警告）；第 21 步文档同步时一并压缩。
- 第 21 步写进 spec 已知限制或收紧：`git restore` 的 `--staged` 例外照原文认字，`--worktree` 看整条命令的后面，所以 `git restore --staged x; echo --worktree` 会多问；反过来 `--no-staged`、`--work` 缩写、`#` 注释或重定向后面的 `--staged` 也算只改暂存区，自动档可能不问，靠 tree 快照还原（02 只许往撤不回加）。
- 第 21 步一并同步 overview.md：`LoopPorts.leases` 新增 `isShuttingDown()`。

## 验收矩阵

| 验收号 | 层 | 测试用例名 | 门禁命令 | 突变 | 平台 |
|---|---|---|---|---|---|
| 1 | 集成 | 06 验收 1: auto allows workspace Write, Edit and covered Delete while snapshots are %s, and asks safely when unavailable | test | 去掉快照条件 → 验收 1 | 任意 |
| 2 | 集成 | 06 验收 2: a Write with no coverage is allowed in auto; a Delete with none asks irreversible | test | — | 任意 |
| 3 | 集成 | 06 验收 3: twenty-five snapshotted Deletes in auto raise no card and are restorable | test | — | 任意 |
| 4 | 集成 | 06 验收 4: a sandboxed command runs unasked in auto under %s | test | — | 任意 |
| 5 | 集成 | 06 验收 5: auto still asks for a command when %s, with autoAsk %s | test | 放宽姿态 / 平台缺省 → 验收 5 | 任意 |
| 5 | 集成 | 06 验收 5: %s never adds autoAsk in either mode | test | autoAsk 不外溢 → 验收 5 | 任意 |
| 6 | 集成 | 06 验收 6: an allow-path bound command is unasked in auto and asked in manual | test | — | 任意 |
| 7 | 单元 | 06 验收 7: %s is irreversible in both modes; the misses stay unknown | test | 删除 reset / 放宽 restore 例外 → 验收 7 | 任意 |
| 7 | 单元 | 06 验收 7: pattern self-tests reject invalid %s samples | test | 自测 some 改 every → 验收 7 | 任意 |
| 8 | 集成 | 06 验收 8: a redirect asks once in auto with a session answer; %s does not | test | 不排除 /dev/null → 加载自测拦截 | 任意 |
| 8 | 集成 | 06 验收 8: filename redirect %s asks and accepts a real answer | test | 无条件排除 >& / /dev/null 近似路径 / 强制重定向 → 验收 8 | 任意 |
| 9 | 集成 | 06 验收 9: the manual mode decides every fixture as before 06 | test | — | 任意 |
| 9 | 集成 | 06 验收 9: auto changes only manual approval-mode asks to allows across the same fixtures | test | — | 任意 |
| 10 | 集成 | 06 验收 10: an unasked call writes no grant; manual grants still allow in auto | test | 免问写授权 → 验收 10 | 任意 |
| 11 | 集成 | 06 验收 11: a child follows the root's current mode | test | 子会话读自身 → 验收 11 | 任意 |
| 12 | 集成 | 06 验收 12: the mode fact survives a restart and new tasks start at the default | test | — | 任意 |
| 12 | 集成 | 06 验收 12: an auto default never writes a mode fact for chat | test | — | 任意 |
| 13 | 集成 | 06 验收 13: the %s draft choice overrides the %s default on the first call | test | 默认值盖草稿 → 验收 13 | 任意 |
| 13 | 集成 | 06 验收 13: the %s default is captured when send starts | test | 默认值盖草稿 → 验收 13 | 任意 |
| 14 | 集成 | 06 验收 14: switching to auto never releases a waiting card, even after a restart | test | 更宽重判当真 → 验收 14 | 任意 |
| 14 | 集成 | 06 验收 14: changing only autoAsk never stales an answer for %s | test | 比较卡时不排除 autoAsk → 验收 14 | 任意 |
| 15 | 集成 | 06 验收 15: disableAutoMode folds auto to manual and records a policy fact | test | — | 任意 |
| 16 | 集成 | 06 验收 16: clearing a session carries its %s approval mode | test | 清空不携带 → 验收 16 | 任意 |
| 17 | 集成 | 06 验收 17: an unasked command never receives %s; manual commands keep it | test | 不认环境后缀 → 验收 17 | 任意 |
| 5 | 集成 | 06 验收 5: an MCP tool named %s never gains autoAsk | test | 去掉内置工具守卫 → 验收 5 | 任意 |
| 1 | 集成 | 06 验收 1: unknown snapshot state fails closed for %s | test | 取消快照白名单 → 验收 1 | 任意 |
| 1 | 单元 | 06 验收 1: decide requires snapshot and command evidence for %s | test | 去掉快照 / 命令证据条件 → 验收 1 | 任意 |
| 7 | 单元 | 06 验收 7: loading always runs command pattern self-tests | test | 删除加载自测调用 → 验收 7 | 任意 |
| 15 | 集成 | 06 验收 15: a stop after policy %s prevents further judgement | test | 删除停止窗口检查 → 验收 15 | 任意 |
| 14 | 集成 | 06 验收 14: other card facts still invalidate an old answer | test | 丢弃全部 facts → 验收 14 | 任意 |
| 8 | 集成 | 06 验收 8: every judgement entry retains the same redirect explanation | test | 丢端口转发 → 验收 8 | 任意 |
| 12 | 集成 | 06 验收 12: chat stays manual even with a stray mode fact | test | 去掉任务形态守卫 → 验收 12 | 任意 |
| 15 | 集成 | 06 验收 15: unavailable policy denies calls but never throws on a mode choice | test | 不可用策略仍直接读 snapshot → 验收 15 | 任意 |
| 15 | 集成 | 06 验收 15: policy never prevents choosing manual | test | 策略拒绝不区分切档目标 → 验收 15 | 任意 |
| 15 | 集成 | 06 验收 15: a policy fold records its %s writer | test | 写错实际 writer → 验收 15 | 任意 |
| 15 | 集成 | 06 验收 15: a Run policy fold and user choice share the root mailbox | test | Run 绕过 mailbox → 验收 15 | 任意 |
| 14 | 集成 | 06 验收 14: a user stop still permits a choice while the Run closes | test | 错误拒绝用户停止后的切档 → 验收 14 | 任意 |
| 12 | 集成 | 06 验收 12: mode choices validate binding, ids and a missing head | test | 去掉入口守卫 → 验收 12 | 任意 |
| 12 | 集成 | 06 验收 12: shutdown at the %s boundary refuses a choice without later IO | test | 删除关机窗口检查 → 验收 12 | 任意 |
| 15 | 集成 | 06 验收 15: startup recovery and user choice share the root mailbox | test | 启动恢复绕过根队 → 验收 15 | 任意 |
| 18 | 集成 | 06 验收 18: after private data and untrusted content a command that can reach out via %s asks once | test | 待补 | 任意 |
| 19 | 单元 | 06 验收 19: control characters deny and invisible characters ask in %s | test | 待补 | 任意 |
| 20 | 单元 | 06 验收 20: a failing hygiene adapter denies with inspector-failed and a release | test | 待补 | 任意 |
| 21 | 集成 | 06 验收 21: an inspector override binds the next identical call once and expires | test | 待补 | 任意 |
| 22 | 集成 | 06 验收 22: an unannounced inspector override reaches the model at the next checkpoint | test | 待补 | 任意 |
| 23 | 单元 | 06 验收 23: desktop registers exfiltration (ask) and hygiene (deny) only | test | 待补 | 任意 |
| 24 | 集成 | 06 验收 24: twenty machine denials in a round end it and downgrade auto | test | 待补 | 任意 |
| 25 | 单元 | 06 验收 25: summarize maps inspector-flagged, check-incomplete and auto-sandboxed-command | test | 待补 | 任意 |
| 26 | 单元 | 06 验收 26: second-segment cards and receipts carry their sentences, marks and allow once | test | 待补 | 任意 |
| 27 | e2e | 06 验收 27: a blocked command is allowed once from its receipt and then runs | test:e2e | — | macOS、Linux |
| 28 | live | 06 验收 28: the prompt layer is version 13 and its hash gate passes | test | — | 任意 |
| 29 | 集成 | 06 验收 29: a profile switch during inspection keeps the post-inspection plan and runs the checks once | test | 待补 | 任意 |
| 30 | 集成 | 06 验收 30: pending to unavailable during inspection reruns the checks, and the third run is strict | test | 待补 | 任意 |
| 31 | 单元 | 06 验收 31: the mode menu shows two modes in task sessions only | test | 待补 | 任意 |
| 32 | 单元 | 06 验收 32: the auto banner stays and clicking it returns to manual | test | 待补 | 任意 |
| 33 | 单元 | 06 验收 33: the auto notice shows once and links to the permissions pane | test | 待补 | 任意 |
| 34 | 单元 | 06 验收 34: the downgrade line says consecutive or round, can close, without the banner | test | 待补 | 任意 |
| 35 | 单元 | 06 验收 35: the permissions pane lists mode, folder access, allowlist, advanced | test | 待补 | 任意 |
| 36 | 集成 | 06 验收 36: folder grants ask once, persist on always, and revoke for later picks | test | 待补 | 任意 |
| 37 | 单元 | 06 验收 37: a granted folder frees reads but a manual Write still asks | test | 待补 | 任意 |
| 38 | 单元 | 06 验收 38: an expanded allowed row shows why it was not asked | test | 待补 | 任意 |
| 39 | 单元 | 06 验收 39: each autoAsk reason has its sentence; Delete has its title | test | 待补 | 任意 |
| 40 | e2e | 06 验收 40: auto mode writes and restores unasked, the banner returns to manual | test:e2e | — | macOS、Linux |
| 41 | 你用 | （人工） | — | — | 任意 |
| 42 | 你用 | （人工） | — | — | 任意 |
| 43 | 单元 | 06 验收 43: unknown autoAsk values and command-card categories deliver with a generic sentence; unknown flagged categories do not | test | 待补 | 任意 |
| 44 | 集成 | 06 验收 44: an unknown summary code under %s verdict reads as unknown and the record shows that verdict's neutral sentence | test | 待补 | 任意 |

第一段的入口与界面断言归属：

- 验收 1、2、5、6 直接走 `packages/kernel/src/loop/batch.ts` 的 judgeCall；验收 8 走 SessionService 的发送、启动恢复与真实答复，并要求 applied。验收 9 同时比较旧 decide 表与 judgeCall 的完整判决；变形关系只忽略第 7 层自身的记录和解释字段 autoAsk，不忽略前六层或判决来源。
- 验收 2、7 的 kernel 断言为不可逆性、原因和 once；「撤不回」文字与 Enter / 默认焦点由 `apps/desktop/test/renderer-approval-card.test.ts` 的「⏎ denies wherever the focus is, 「允许」 included; Space is left to the button it is on」「presentation-r1 不变量 1: focus coming in lands on 「拒绝」, which carries ⏎ and Esc; 「允许」 carries no hint」及「presentation-r1 验收 1: an irreversible card has no why line (开放问题 15 A)」守。
- 验收 3 的 kernel 断言为 25 次成功删除、25 个可还原调用及完整恢复；计数由 `apps/desktop/test/renderer-snapshots.test.ts` 的「05 验收 48: Delete expands only on success and counts distinct successful paths」守。验收 3、4 的可还原 / 命令警示文字由 `apps/desktop/test/renderer-snapshot-views.test.ts` 的「05 验收 33: a settled round follows kernel restore availability and coverage flags; paused rounds hide the link」守；warming、file-only 与拍前失败的命令均断言 commandsWithoutSnapshot: true。
