# 06 · 先核实

外部事实与 spec 里关于现有代码的每条断言（E1–E35），附一手来源；探针（P）写目的、事先定的「结果是 X 就改什么」与实际结果。代码一律按 dev `c894922` 核（核对用的工作副本是 dev 加三个测试文件，测试文件不影响下列断言；E14、E23 在 2026-11-10 按 dev `ecb82a7` 重核），写文件路径加函数名或类型名，不写行号。原始材料在私有笔记（另记）。

## 外部事实

### E1 · railguard 的 `inputHygiene` 怎么判

- 事实：`src/rules/hygiene.ts` 的 `inputHygiene`：输入含 C0 控制字符（`\x00-\x08`、`\x0B`、`\x0C`、`\x0E-\x1F`）或 `\x7F` 时返回 `verdict: 'blocked'`；不含这些、但含 Unicode 标签块（U+E0000–U+E007F）或零宽字符（U+200B–U+200D、U+2060、U+FEFF）时返回 `verdict: 'modified'` 与剥掉后的 `transformed`；其余 `pass`。制表、换行、回车不算控制字符。`check` 是同步的，`Rule.check` 的类型允许返回 Promise（`src/core/types.ts` → `Rule`）。规则 `tier: 'deterministic'`。
- 06 用到的地方：§两条新的机器检查 的映射（D4、D21）。
- 来源：本机 `../railguard` 在 `939027d` 的源码。核实：2026-11-08。
- 什么时候重核：升 railguard 版本之前。

### E2 · `939027d` 与 `v0.7.0` 标签

- 事实：`v0.7.0` 标签指 `0e48aca`（release 提交）；`939027d` 是它之后的一个提交，改了 `package.json` 一行与几个文档、图表脚本，`src/rules/hygiene.ts` 两者之间没有改动。`package.json` 的名字是 `@yiong/railguard`、版本 0.7.0，`./rules` 子路径导出 `inputHygiene`。
- 来源：`git rev-list -n1 v0.7.0`、`git diff --stat v0.7.0 939027d`、`git diff v0.7.0 939027d -- src/rules/hygiene.ts`（空）。核实：2026-11-08。
- 什么时候重核：P1 有结果时。

### E3 · Claude Code 自动模式的拒绝上限

- 事实：连续 3 次或累计 20 次被拒就把决定交还给人；分类器误拦约 0.4%、漏判约 17%。
- 06 用到的地方：D5 的 20。
- 来源：https://www.anthropic.com/engineering/claude-code-auto-mode 。核实：2026-10-22 外部调研（另记）；本次没有重取，未重新核实。
- 什么时候重核：有人要改 `MACHINE_DENIAL_ROUND_CAP` 时。

## 现有代码

### E4 · 自动分支不看可逆性与快照

- 事实：`packages/kernel/src/permission/decide.ts` → `decide`：第 7 层在 `approvalMode === 'auto'`、策略没关自动档、内置文件工具（`FILE_TOOLS`：Read、Write、Edit、Delete、Glob、Grep）且 `place === 'workspace'` 时放行，`modeRule: 'auto-range'`；不看 `reversibility`，也没有命令的放行分支。`LayerInputs.approvalMode` 只有 `'manual' | 'auto'`。
- 06 用到的地方：§点名 (a)(b)、§自动档的范围、验收 1、2。
- 什么时候重核：第一段第 3 步开工前。

### E5 · 产品恒传手动

- 事实：`packages/kernel/src/loop/batch.ts` → `judgeCall` 给 `decide` 的 `layers.approvalMode` 恒为 `'manual'`；全仓非测试代码只有这一处产生 `approvalMode`。`disableAutoMode` 在 `packages/kernel/src/host/policy.ts` → `TenantPolicy` 与 `packages/contracts/src/policy.ts` 里。
- 什么时候重核：第一段第 2 步开工前。

### E6 · 带 `sensitive` 与重跑的调用排在放行之前

- 事实：`decide` 在「必须问」之后、放行之前，对 `elevated`（绑定了重跑）或 `layers.sensitive` 有值的调用判问；带 `sensitive` 时会话授权不算。Delete 在 `coverage` 为 `none` 时由 `packages/kernel/src/permission/reversibility.ts` → `reversibilityOf` 判 `irreversible`，进第 4 层的必须问；Write、Edit 判 `unknown`。
- 06 用到的地方：§自动档的范围、规矩 1、验收 2。
- 什么时候重核：第一段第 3 步开工前。

### E7 · 缺 `posture` 的读法与计划不记姿态

- 事实：`packages/kernel/src/host/adapter.ts` → `HostSandbox.posture` 可选，注释写明缺省读作 active 只管卡面，少问的规则把缺它读作不可用；`SandboxPosture.state` 四值 `pending`、`active`、`degraded`、`unavailable`。`packages/kernel/src/loop/batch.ts` → `sandboxPlanOf` 缺 `posture` 时按 `active / workspace-write`；`packages/kernel/src/tape/entry.ts` → `SandboxPlan` 只记 `profile`、`chosen`、`unavailable`、`override`，不记姿态。`packages/kernel/src/host/memory.ts` 的内存宿主没有 `posture`；desktop 的 `apps/desktop/src/main/host/sandbox-runtime.ts` 有。
- 06 用到的地方：`LayerInputs.commandSandboxed` 由 `judgeCall` 直接读 `posture()`，不从计划推（规矩 5、验收 5、29、30）。
- 什么时候重核：第一段第 3 步开工前。

### E8 · 快照什么时候拍

- 事实：`packages/kernel/src/loop/batch.ts` → `beforeCallSnapshot`：文件工具在可逆性为 `snapshotted`，或状态为 `tree`、`file-only` 时尝试拍；Bash 只在 `tree` 时拍，否则记 `not-covered`、照跑。`perform`：卡上可逆性为 `snapshotted` 的文件工具拍不成时回 `SNAPSHOT_FAILED`、不动文件。`HostSnapshots.status` 同步、不抛（`adapter.ts` → `HostSnapshots`）；判定用根会话（`packages/kernel/src/loop/snapshots.ts` → `snapshotSessionId`）。
- 06 用到的地方：§自动档的范围、已知限制第一条、验收 4。
- 什么时候重核：第一段第 3 步开工前。

### E9 · 模式表与「只许加往撤不回」

- 事实：`reversibility.ts` → `commandReversibility` 只看 `COMMAND_PATTERNS`，命中 `irreversible`、其余 `unknown`；表里 22 行（rm、rmdir、find -delete、curl 发送与 DELETE、wget 发送、git push、git clean -f、scp、rsync 远端、npm / pnpm / yarn publish、docker / podman push、gh release create、twine upload、git branch 强删、git stash drop / clear、kubectl delete、shred -u），没有覆盖写类，也不认 `>`。注释写明「Rows may only be added, and only ones that judge towards `irreversible`」。`word`、`option`、`inOrder` 三个辅助函数可以照用。
- 06 用到的地方：§撤不回、§自动档仍问的写法、验收 7、8。
- 什么时候重核：第一段第 4 步开工前。

### E10 · 答复作用域

- 事实：`packages/kernel/src/permission/grants.ts` → `answerScope`：因 `tenant-policy`、`connector-confirm`、`inspector`、`irreversible` 判问的卡、可逆性 `irreversible`、工作区外、连接器、Delete 都是 `once`；其余 Write、Edit、Bash、WebSearch、WebFetch 是 `session`。会话授权只在第 6 层起作用，不影响第 4 层的必须问（`decide`）。
- 06 用到的地方：D2 的「只管这一次」、D3 的「本会话这一条」、D4 的「只这一次」、验收 7、8、18。
- 什么时候重核：第一段第 4 步开工前。

### E11 · 授权跟着可逆性走

- 事实：`batch.ts` → `usableGrant`：Write、Edit、Delete 的会话授权只在这次可逆性不弱于给出授权那次时有效（05 D61）。
- 06 用到的地方：自动档的免问不是授权，不经这里（规矩 3）。
- 什么时候重核：第一段第 3 步开工前。

### E12 · 命令卡的主原因是固定的

- 事实：`decide.ts` → `primaryReason`：Bash 的主原因恒为 `command`（绑定重跑时 `elevated`），第 5 层的问不改主原因；`facts` 只取 `CONFIRM_FACT_KEYS` 的必填键，唯一的例外是命令卡加 `sandbox: 'unavailable'`。
- 06 用到的地方：D15。
- 什么时候重核：第二段第 7 步开工前。

### E13 · inspector 的类别、时限与注册

- 事实：`packages/kernel/src/permission/inspector.ts` → `InspectorCategory` 只有 `'exfiltration'`；`INSPECTOR_TIMEOUT_MS` 的 `local-rule` 是 2 000 ms；`runInspectors` 并发跑全部 inspector，出错、超时、越过声明按声明的最严处理。`packages/contracts/src/ipc/confirm.ts` 的类别枚举是 `exfiltration`、`inspector-failed`。`packages/kernel/src/session/service.ts` → `assertInspectors` 对带 `afterResult` 的注册抛错。
- 06 用到的地方：§两条新的机器检查、§接口。
- 什么时候重核：第二段第 8 步开工前。

### E14 · 外带检查的出口与来源

- 事实（dev `ecb82a7`）：`packages/kernel/src/permission/exfiltration.ts` → `exfiltrationOpinion`：出口是内置 WebFetch 与任一连接器调用，来源 S 分别记 'builtin'、`mcp:<serverId>`；`untrustedSources` 不空、`privateSources` 里有不等于 S 的、WebFetch 时 `fetchUrlVouched` 不为真，就问；注册为 `ceiling: 'ask'`、`kind: 'local-rule'`。
- 事实（同上）：`packages/kernel/src/permission/session-view.ts` → `buildSessionView`：WebSearch、WebFetch 已派发记工具名进 `untrustedSources`；连接器调用与关联不上来源的派发记 `mcp:<serverId>`、`unresolved:<name>`，同时进 `untrustedSources` 与 `privateSources`；任务形态里任何已派发的 Bash、不落在本会话落盘目录的 Read 与 Grep 记 'local' 进 `privateSources`（`privateRead`）。这是 auto-tier-hardening 规矩 4、5 的实现（8f7c76e）。
- 更正：起草时按 `c894922` 写的「只有 WebFetch 是出口、只认 WebSearch 与 WebFetch 为不可信」已过时，挑刺评审 r2 指出；spec 照 D33 改。
- 06 用到的地方：§点名 (d)、§两条新的机器检查 的外带一条、D33、验收 18。Bash 作出口时 S 记 'builtin'，`privateSources` 里的任何来源都不等于它。
- 什么时候重核：第二段第 7 步开工前。

### E15 · desktop 只注册一个只会问的检查

- 事实：`apps/desktop/src/main/inspectors.ts` → `desktopInspectors` 只返回 `exfiltrationInspector`；`apps/desktop/test/inspectors.test.ts` 的用例「02 不变量 17: all register ceiling ask, and none registers the after-result hook」钉住这一点。`apps/desktop/src/main/inspectors/` 目录不存在；`@yiong/railguard` 不在任何 `package.json` 里。
- 06 用到的地方：§点名 (e)、验收 23、plan 第 8 步。
- 什么时候重核：第二段第 8 步开工前。

### E16 · 白名单的来源与查询口

- 事实：`packages/kernel/src/loop/ports.ts` → `SandboxPorts` 只有 `beforeWrap` 与 `grantsChanged`；`batch.ts` → `perform` 在 wrap 前把本会话的域名授权（`packages/kernel/src/permission/sandbox-release.ts` → `sandboxDomainHosts`）交给 `beforeWrap`。用户白名单与预设在 config.json 的 `sandbox`（`packages/contracts/src/ipc/config.ts` → `configSchema`），由 desktop 读。`JudgeContext` 没有 `sandbox` 端口。
- 06 用到的地方：`SandboxPorts.canReach`、`autoCommands`（§接口）。
- 什么时候重核：第二段第 7 步开工前。

### E17 · 回执放行的现状

- 事实：`packages/kernel/src/tape/entry.ts` → `ReceiptOverridePayload` 的 `action` 只有 `allow-domain`、`allow-path`、`rerun-unsandboxed`，必带 `command`、`cwd`；`sandbox-release.ts` → `releaseReceipt` 要求那次调用的 `tool_outcome` 有 `sandbox` 成员；`validSandboxReleases` 把 `allow-domain` 以外的都当一次性放行、按「点击之后开始的下一轮回复结束」作废；`unboundSandboxOverride` 只看命令原文与 cwd。`packages/kernel/src/session/service.ts` → `ReleaseQuery.action` 三值，`packages/contracts/src/ipc/sandbox.ts` → `sandboxRelease` 的状态五值。
- 06 用到的地方：D16、§从回执允许一次、验收 21。
- 什么时候重核：第二段第 9 步开工前。

### E18 · 告诉模型的文本

- 事实：`packages/kernel/src/prompts/index.ts` → `PROMPT_LAYER_VERSION = 12`；`MODEL_NOTES.sandbox.release` 有 `wrap`、`domain`、`path`、`rerun` 四个模板；`inspector` 拦截的收口句是「A permission check blocked this call, so it was not run.」；`blocked-repeatedly` 的 not-run 句写「Several calls in a row were blocked」。
- 06 用到的地方：§提示层与评测、D19。
- 什么时候重核：第二段第 12 步开工前。

### E19 · 机器拦截怎么计数

- 事实：`packages/kernel/src/loop/limits.ts` → `MACHINE_DENIAL_CAP = 3`、`STEP_LIMIT = 100`；`packages/kernel/src/loop/run.ts` → `chainCounters` 沿 `resume` 的链回到消息或「继续」开的 Run，`tool_outcome` 来源是拦截码就加一、来源为 null 就清零，出过卡也清零；`batch.ts` 的执行循环到 3 次回 `blocked-repeatedly`。只带 `observed` 违规的调用来源为 null（04 读法 53）。`packages/kernel/src/loop/terminal.ts` → `RunEndReason` 的 `blocked-repeatedly` 只有 `count`；`packages/contracts/src/ipc/chat.ts` 同形；中文结束文案是「调用连续 {count} 次被拦截，任务已结束。」。
- 06 用到的地方：§熔断、D20、验收 24。
- 什么时候重核：第二段第 11 步开工前。

### E20 · 判决摘要

- 事实：`packages/kernel/src/permission/record.ts` → `summarize`：判决来自第 5 层时，先取说问（或说拒）的那一级里第一个 `status: 'ok'` 的类别，没有就是 `inspector-failed`；`inspector-failed` 的问与拒都给 `check-incomplete`；其余说拒的给 `inspector-blocked`，其余说问的给 `exfiltration-recheck`（只有 `exfiltration` 一个正常类别时成立，06 加了 `hidden-characters` 才要分开）。第 7 层放行只有 `modeRule === 'auto-range'` 给 `auto-mode`，其余给 `no-approval-needed`。
- 更正：第一版把这一条写成「说问的一律给 `exfiltration-recheck`」，漏了失败分支，Codex 交叉评审 r1 指出。`DecisionStep.basis.modeRule` 只有 `auto-range`、`not-gated`。`packages/contracts/src/ipc/outcome.ts` 的摘要码已有 `auto-mode`；`ToolOutcomeView` 的 `permission` 带摘要，界面能按调用取到。中文 `summary.auto-mode` 是「按自动模式的设置允许」。
- 06 用到的地方：§两条新的机器检查 的新码、§界面「工具行」、验收 25、38。
- 什么时候重核：第一段第 3 步开工前。

### E21 · 命令的环境

- 事实：`packages/kernel/src/tools/builtin/bash.ts` → `CommandRun.env` 注释「the kernel adds nothing to it」，执行器把它原样拷进 `SandboxRequest.env`；`batch.ts` → `perform` 能读到这次派发所依据的判决（为了取计划）。`apps/desktop/src/main/host/shell-env.ts` 只去掉 `TENON_*`、`ELECTRON_*` 与开发构建自己读 key 的变量，注释写明不按名字过滤用户的令牌。
- 06 用到的地方：§免问命令的环境、验收 17。
- 什么时候重核：第一段第 5 步开工前。

### E22 · config.json 与工作区路由

- 事实：`configSchema` 没有 `approvalMode`、`autoModeNoticeSeen`、`folderAccess`；`lastWorkspaceFolders` 是只由主进程写、`config.set` 不收的先例。`packages/contracts/src/ipc/session.ts`：`workspace.pick` 与 `workspace.usePrefill` 直接把文件夹加进会话，成功响应是 `{ ok, folders, origin, warning? }`；没有文件夹授权、列表与撤销的路由。
- 06 用到的地方：§接口、§界面「文件夹授权」、验收 36。
- 什么时候重核：第三段第 15 步开工前。

### E23 · 界面现状

- 事实：`apps/desktop/src/renderer/src/components/` 下没有 `ApprovalModeMenu`、`ComposerBanner`；`components/settings/GrantDialog.tsx` 是连接器的授权框；`components/settings/SandboxPane.tsx` 的标题键 `sandbox.title` 中文是「权限与网络」；`components/thread/ToolRow.tsx` → `BlockedNotice` 对 `inspector` 来源按类别出一行 `blocked.inspector.<类别>`，没有按钮；审批卡标题 `confirm.title.file.write` 中文是「修改这个文件？」，Delete 也用它。`apps/desktop/src/renderer/src/lib/visible.ts` → `visible` 照 02 §最小审批卡 ②′ 把控制字符、格式字符（含零宽与标签块）与其余默认可忽略码位写成可见的 `\u{XXXX}`，`ApprovalCard.tsx`、`ToolRow.tsx` 都用它，`apps/desktop/test/renderer-visible.test.ts` 钉住。
- 更正（2026-11-10 按 `ecb82a7` 重核，前几句仍成立）：起草时漏了 `visible`，D25 第一次的题面因此把现状写成「照原样显示」，挑刺评审 r2 指出。
- 06 用到的地方：§界面、D25、验收 26、31 至 39。
- 什么时候重核：第二段第 10 步与第三段第 16 步开工前。

### E24 · Tape 名字与键

- 事实：`packages/kernel/src/tape/names.ts` → `RESERVED_NAMESPACES` 含 `session`；`session/workspace_set` 是 event、slice `session`、身份 `session`、`sourceSeq: 'ordinal'`；`packages/kernel/src/tape/provenance.ts` → `workspaceSetKey` 的写法是 `session:v1:workspace:<incarnationId>:<n>`；`tool/receipt_override` 已声明。
- 06 用到的地方：`session/approval_mode_set` 照同样的身份与键写法（§接口）。
- 什么时候重核：第一段第 2 步开工前。

### E25 · 执行循环与会话授权的取法

- 事实：`batch.ts` → `judgeCall` 先跑全部 inspector（`runInspectors`，异步等待），之后才算 Bash 的计划（`sandboxPlanOf`）、原因、会话授权，最后调 `decide`。子会话的授权与视图并入父会话的（`ownSessionGrants`、`sessionGrants`）。`decide` 对计划为 `full-access` 的命令，只认在同样不可用时的卡上给的会话授权。
- 事实：`sandboxPlanOf` 不依赖检查的意见，但读实时的 `posture()`。desktop 的 `apps/desktop/src/main/host/sandbox.ts` → `DesktopSandbox.posture` 每次现读设置与启动状态；`apps/desktop/src/main/sandbox-routes.ts` 的 `sandbox.setSettings` 在 config 锁里写，不经会话 mailbox；`DesktopSandbox.wrap` 照传入的计划包，不替旧计划改正。所以检查期间状态可能变，计划在检查之前算与在检查之后算可以不同。
- 实测（Codex 复核 r2，2026-11-08，现有源码的只读探针，原始记录另记）：检查等待期间可写变只读，在检查之前算得 `workspace-write`，现有顺序得 `read-only`；pending 变 unavailable，之前算得 `workspace-write`，现有顺序得带 `unavailable` 的 `full-access`。第一版写的「挪到检查之前不改结果」不成立，已删。
- 06 用到的地方：D28、D30 的检查前采样与检查后复核、规矩 4、7、验收 11、29、30。
- 什么时候重核：第二段第 7 步开工前。

### E26 · `SECURITY.md` 那句话

- 事实：`SECURITY.md` §Credentials, environment and package managers 写「Environment filtering for automatically approved commands belongs to a later phase.」，并列了 `GH_TOKEN`、`HF_TOKEN`、`VAULT_TOKEN`、`PGPASSWORD`、`OP_SERVICE_ACCOUNT_TOKEN`、`OP_SESSION_*`。
- 06 用到的地方：§文档同步。
- 什么时候重核：第三段第 21 步。

### E27 · 评测花费与额外的一题

- 事实：`docs/adr/adr-005-eval-baseline-flash.md`：基线列 glm-5.3-flash，按第 11 版的用量约 ¥4.80 一次；提示层改到被拦之后怎么说、怎么做的部分时，lead 先问 owner，再单独在 glm-5.3 上跑 02 题 3 次，约 ¥2。
- 06 用到的地方：§提示层与评测、plan 第 12.1 步。
- 什么时候重核：第二段第 12 步开工前。

### E28 · 对照审计与组件表里要补记的行

- 事实：`docs/ux/parity-audit-2026-09-12.md` 有「审批模式三档菜单」「审批模式默认值」「输入框上方浮层条」「输入框 · 档位说明条」与「审批模式菜单 · 打开 · 三档」几行，后者写着跳过档与「它自己跑，遇到看起来不安全的才停下来问」；档位说明条那行链到「设置 › 权限与沙箱」。`docs/ux/components.md` 的 `ApprovalModeMenu` 行写着「三档」、跳过项待 06 删。
- 06 用到的地方：§文档同步、验收 42。
- 什么时候重核：第三段第 21 步。

### E29 · 总参考里指向 06 的行

- 事实：`docs/architecture/master-reference.md` §阶段表 4c 一行是「`06-approval-modes`（待起草）｜审批档位｜规划中｜随快照与规则 inspector 开放，另行验收」；§以后再说 有「命令的『撤不回』模式表不认覆盖写类……随 06 另写 spec」与「Delete 的审批卡标题是『修改这个文件？』」两行；`.git` 元数据、连接器外带、`core.hooksPath` 三行归 auto-tier-hardening。
- 06 用到的地方：headers.md。
- 什么时候重核：放进仓库之前。

### E30 · 停止与收口不变

- 事实：`perform` 与 `execute` 只按派发所依据的判决取计划与快照；判定中被停止不写判决（`judgeCall` 返回 `stopped`）。06 不改这条路。
- 06 用到的地方：规矩 11。
- 什么时候重核：第一段第 3 步开工前。

### E31 · 文件工具的路径参数名

- 事实：Read、Write、Edit、Delete 用 `file_path`；Glob、Grep 用可选的 `path`（`packages/kernel/src/tools/builtin/glob.ts`、`grep.ts` 的参数表与 `absolutePathCheck`）。
- 06 用到的地方：§两条新的机器检查、D21。
- 什么时候重核：第二段第 8 步开工前。

### E32 · 重新判定不会放行

- 事实：`packages/kernel/src/loop/answer.ts` → `rejudgeWaiting`：答复前与启动时的重新判定，判得更宽的读作没变，注释写明「an allow never comes from a re-judgement」。
- 06 用到的地方：规矩 11、验收 14。
- 什么时候重核：第一段第 2 步开工前。

### E33 · 04 的放行载荷有哪些读者

- 事实：`packages/kernel/src/loop/sandbox-release.ts` → `sandboxReleaseEntry` 只收名字是 `tool/receipt_override` 的事实（`isSandboxRelease`），除 `allow-domain`、`allow-path` 外一律按重跑的模板填 `{command}`；`packages/kernel/src/permission/sandbox-release.ts` → `validSandboxReleases` 把 `allow-domain` 以外的都当一次性放行，`unboundSandboxOverride` 直接读 `command`、`cwd`。Codex 交叉评审 r1 用第一版草稿的并类型载荷跑现有代码，得到 `TypeError: fill: the template names {command}, and no slot of that name was given`（复现记录在私有笔记 `review-codex-r1.md`，另记）。
- 06 用到的地方：D16 改为另起 `tool/inspector_override`；旧读者只认旧名字，不会读到新载荷。
- 什么时候重核：第二段第 9 步开工前。

### E34 · 命令网络白名单的实际合并规则

- 事实：`apps/desktop/src/main/host/sandbox-runtime.ts` → `DesktopSandboxRuntime.updateAllowlist`：生效白名单 = `settings.allowedDomains` ∪（`settings.packageManagers` 为真时）本平台预设的域名 ∪ 传入的会话域名授权，不看档位。`apps/desktop/src/main/host/sandbox-config.ts` → `buildFilesystem` 的 `presetInEffect` 另要档位与所选档位都是 `workspace-write`，只管预设的可写目录；预设的环境变量也随 `presetInEffect`（`apps/desktop/src/main/host/sandbox.ts` 的 wrap 用计划里的 `env`）。Codex 交叉评审 r1 用只读档、白名单与会话授权都空、勾了预设的探针核过：网络名单里仍有包仓库的域名。
- 06 用到的地方：`canReach` 的定义、验收 18 的只读档一例（D28）。
- 什么时候重核：第二段第 7 步开工前。

### E35 · 会话建立前的草稿与清空时带过去的事实

- 事实：`packages/kernel/src/session/draft.ts` → `SessionDraft`：会话直到首条消息开 Run 才建立，之前的形态、文件夹、模型选择按会话 id 存在 kernel 的草稿里；`packages/kernel/src/session/facts.ts` → `creationEntries` 建会话时同一批写 `session/profile_set`、`session/workspace_set`、`session/model_choice_set`；`carryEntries` 清空会话时把 profile 与最新的 workspace 照抄进新 incarnation、与新的 `session/start` 同一事务，模型选择回到默认。`packages/kernel/src/loop/mailbox.ts` 建会话时调 `creationEntries`。
- 06 用到的地方：D26、D27、验收 13、16。
- 什么时候重核：第一段第 2 步开工前。

### E36 · 类别校验的范围与启动时的重新判定

- 事实：`packages/contracts/src/ipc/confirm.ts` → `checkFlaggedCategory` 只在 `reason === 'flagged'` 时用封闭的 `flaggedCategorySchema` 校验 `facts.category`，认不出就不投递；同一处的 `checkRequest` 另对 `sensitive-path` 卡只收 `credential`、`auto-run`、`hardlink` 三个类别。命令卡（原因是 `command`）不做类别的枚举校验。`packages/kernel/src/loop/answer.ts` → `rejudgeWaiting`：判得更宽的读作 `unchanged`、留着原判决；判为问且卡的内容变了返回 `changed`。`packages/kernel/src/loop/recovery.ts` → `rejudgeAtStartup` 对 `changed` 写新判决并投递新卡。Codex 复核 r3、r4 用当前 schema 核过：带未知类别时，`flagged` 卡被拒、`sensitive-path` 卡被拒、`command` 卡通过。06 两处已有的校验都不动，只是不给命令卡加新的。
- 06 用到的地方：§接口「回不去的点」、规矩 13、D31、验收 43。
- 什么时候重核：第二段第 10 步与第三段第 18 步开工前。

### E37 · 摘要码的契约是封闭的、双向一致

- 事实：`packages/contracts/src/ipc/outcome.ts` → `decisionSummaryCodeSchema` 是 `z.enum`，`satisfies z.ZodType<DecisionSummaryCode>`；`packages/contracts/test/approval.test.ts` 断言它与 kernel 的 `DecisionSummaryCode` 双向互赋。`decisionSummarySchema` 把 `verdict` 与 `code` 分开存，所以未知码也带着原 verdict。中文 `default-ask` 的文案是「这项操作需要确认」。
- 06 用到的地方：§点名 (j)、规矩 14、D32、验收 44。
- 什么时候重核：第三段第 15 步开工前。

## 探针

### P1 · npm 上有没有 `@yiong/railguard@0.7.0`，包里的 `inputHygiene` 是不是 E1 那份

- 目的：定依赖写法（D21）。
- 结果是 X 就改什么：有、且发布包的 `dist/rules/hygiene.js` 与 `939027d` 的判法相同，就照 spec 写精确版本；没有或不同，就改成 git 依赖钉 `939027d`，spec §两条新的机器检查 那一句同改。
- 要联网，起草时没有跑。改 ready 之前跑（plan 第 1.2 步），不花钱。
- 实际结果（lead，2026-11-08）：
  - npm 上有 0.5.0、0.5.1、0.6.0、0.7.0 四个版本，`latest` 是 0.7.0；元数据里没有 `gitHead`。
  - `npm pack @yiong/railguard@0.7.0` 下下来的包，shasum 是 `008cb33566c6b7ac91b9d99a909373660c58c886`，和 registry 的 `dist.shasum` 一致。
  - 包里带着源码。`src/rules/hygiene.ts` 和 railguard 仓库 `939027d` 的同名文件逐字相同（`diff -q` 没有差异）。`dist/rules/hygiene.js` 没有逐字比：它是同一份源码编出来的，没有重新编译来核对。
  - `package.json` 的名字是 `@yiong/railguard`，版本 0.7.0；`./rules` 子路径导出 `inputHygiene`。
  - 按上面的规矩，依赖写 npm 的精确版本 0.7.0。
- 补证 `dist`（lead，2026-11-08，Codex 复核 r2 指出上一条只比了源码）：在私有临时目录给本机 railguard 仓库建了一个 `939027d` 的 worktree，照它自己的构建命令 `pnpm install --frozen-lockfile --ignore-scripts`、`pnpm build`（tsdown 0.15.7）编出 `dist`，再和 npm 包解开后的文件比；没有执行下载来的包里的任何代码，只比文件。
  - `dist/rules/hygiene.js` 逐字相同，两边 SHA-1 都是 `2535d919b2351915b25c1734c7ea892ba991fcb8`；`dist/rules/index.js` 逐字相同，从 `./hygiene.js` 导出 `inputHygiene`；`src/` 整个目录逐字相同。
  - 整个 `dist` 另有四个文件不同：`dist/data/index.js`、`dist/eval/dataset.js` 只是 import 行的先后不同，`dist/node/audit-jsonl.d.ts.map`、`dist/rules/taint.d.ts.map` 是源码映射；06 都不用。
  - 结论：原定条件满足，依赖写 npm 的 `@yiong/railguard` 精确版本 0.7.0。临时 worktree 已用 `worktree remove --force` 删掉。

### P2 · 回退到 06 之前的版本，能不能打开写过两个新事实的会话

- 目的：旧版本不认识 `session/approval_mode_set`、`tool/inspector_override`，也不认识 `tool/permission_decided` 的 `inspectorOverride`、`blocked-repeatedly` 的 `scope` 与 `message/sandbox_release.overrides` 里的新键。
- 结果是 X 就改什么：照 05 P19 的做法，用 dev `c894922` 的 kernel 与真实 SQLite TapeStore 读回带这些事实与键的探针库；能照常打开、哈希链通过、投影与续跑通过、旧的沙箱放行与告知不受影响，spec「迁移与回退」照写；打不开，就在「迁移与回退」写明回不去的点，并列进 owner 验收清单。
- 只读 Node 探针，不起 Electron、不花钱。改 ready 之前跑（plan 第 1.2 步）。
- 实际结果（Codex，2026-11-08，dev `c894922`，旧 kernel、真实 SQLite TapeStore、脚本化 provider，只追加模拟的 06 事实再关库重开；原始记录在私有笔记 `p2-rollback-result.md`，另记）：
  - 能打开的部分：P2 点名的五类新事实与新键全部通过。三组库全部读回（68、91、66 条，与 session head 一致），哈希链分页校验都没有坏条目，19 次 attempt 复核都是 verified，投影重建、恢复续跑、重放都通过；两个新事实在旧投影里都是空，自动档的事实没有取消旧版的手动审批；旧的沙箱放行与告知（域名授权、路径放行的绑定与派发、三类告知、一次性放行作废）不受影响；`tool/inspector_override` 在旧版里不授予任何放行、不生成新告知。
  - 打不开的一点（补测）：会话里有判决摘要码 `inspector-flagged` 时，旧版的 `session.messages` 与 `session.latest` 回 `invalid-response`，路径是 `[…, "calls", 0, "outcome", "permission", "code"]`。原因：摘要在判定时就存进 `tool/permission_decided`、读取时不重算（`packages/kernel/src/tape/entry.ts`），而旧版 `packages/contracts/src/ipc/outcome.ts` 的 `decisionSummaryCodeSchema` 是封闭的枚举。对照库同样的两路都成功。
  - 按原定规矩：spec「迁移与回退」写明这个回不去的点，并列进 owner 验收清单（plan 第 24 步）。
- 等着的卡（lead 按代码推断，Codex 复核 r3 用源码探针核过，没在整套回退上实测）：回退时正有一张看不见字符的卡在等，旧版启动时重判分三种（E36）：
  - 重判仍是放行（如工作区里的 Read，旧版没有这条检查）：`rejudgeWaiting` 读作 `unchanged`、留着旧的 `flagged` 卡，`checkFlaggedCategory` 认不出 `hidden-characters`，卡投递不出去，那次调用一直等着、不执行。
  - 重判是问、卡的内容不同（如普通 Write、Bash，旧版判为普通的问）：返回 `changed`，`rejudgeAtStartup` 写新判决、投递新卡，照常能答。
  - 命令卡：原因是 `command`，`checkFlaggedCategory` 只在 `reason === 'flagged'` 时校验，带 `hidden-characters` 的命令卡照常投递。
  - 新卡投递得出去，不等于消息列表恢复：会话里有 `inspector-flagged` 时，消息列表照旧加载失败。
  - 第三版把这一条写成「回退时那张卡一律投递不出」，说过了头，r3 指出后改成上面的分情况。
