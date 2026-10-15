# 呈现修订第一轮（presentation-r1）

Status: draft
Kind: features
Owner: 起草在 Claude Code（2026-10-15），等 owner 拍板 §开放问题。方向是 owner 2026-10-15 定的：B+ 的轨二（去掉界面上的机制）、对话 / 任务入口改成「在文件夹里工作」开关（保留 02 的 H1，契约 `session.selectProfile` 不变）、[docs/spec-driven-dev.md](../../spec-driven-dev.md) 的第三个例外。选项与评审在仓库外 `../tenon-notes/2026-10-14-desktop-codex-ux/`（`ux-compare-and-decision.json` 的 `final`；诊断 M01、M02、M07、M08、C01 在 `codex-and-tenon-ux-diagnosis.json`）
Amends: [02-agent-loop](../../architecture/02-agent-loop/spec.md) §会话形态、工作区与模型选择「模型选择」（M5）与 §对 01-provider-and-tape 的修补 第 6 小节的 `provider.configure`：第一次存 key、新会话默认还空着时，把默认落到这个厂商。只增一处写入；碰到 02 旧文字的一句在 §对 02 的修补「点名」，要 owner 确认（开放问题 2）
Replaces: 照第三个例外逐条替换，日期为实现合入当天，理由是界面不讲内核机制（[parity-audit](../../ux/parity-audit-2026-09-12.md)「2026-09-13 补记：简化决定」）与 owner 2026-10-15 的 B+ 轨二：[00-foundation](../../architecture/00-foundation/spec.md) 两条（R1、R2）；[02-agent-loop](../../architecture/02-agent-loop/spec.md) 二十条（R3–R22）；[03-mcp-host](../../architecture/03-mcp-host/spec.md) 三条（R23–R25）；[custom-vendors](../custom-vendors/spec.md) 三条（R26–R28）；[model-display-names](../model-display-names/spec.md) 两条（R29、R30）。每条的原文、保留的部分、新条款在哪、为什么只涉及表现，见 §替换的条款
Revisions: 2026-10-15 首版

## 背景

2026-10-14 对 Tenon 自己界面的诊断（85 张 e2e 截图，仓库外）里，「差印象」的一大块是机制外露和层层重复，而且多数是已实现 spec 写死的：

- 审批卡：一行五格刻度「只读 可撤销 有快照 不可逆 未知」（03 §卡片与工具行）；「Write 需要你批准」这类内置工具的英文名（`confirm.reason.*` 的 `{toolName}`）；命令卡的原因句「每条命令都先问：在 {cwd} 运行 {command}」把对象行再说一遍；不可逆时刻度高亮「不可逆」，下面再一句「撤不回」。
- 拒绝一次出三层：行下「你拒绝了这个操作」、「已拒绝」加对象、失败卡「你拒绝了 Read，任务已结束。1 个调用确定没发生。」。
- 结算行按 `effect` 计数，Bash 的 effect 暂定为 `external`（02 §内置工具与参数），所以跑过命令就写「有对外发送」；子任务里的改动不计；零也写（「改了 0 个」）。
- 失败卡：401 与 400 的第一行都是「模型服务（anthropic）出错」，括号里是内部 id；步数上限卡把 100 次「读取 <整条路径>」逐条列出；卡宽随内容变。
- 模型菜单每行带主机（02 §模型菜单与输入框「每一行」）；没配 key 的厂商会是默认，第一次发送就失败，报的是「API 密钥被拒绝」，其实是没填。
- 对话 / 任务是两颗小胶囊，建会话后变成点不动的标签。

这些都在 `implemented` 的 spec 里。只涉及界面文案、布局或组件形态的条款，按第三个例外逐条换；会改变行为的一处（默认模型）走修补。

## 目标与非目标

**目标**

- 审批卡：两句 Tenon 自己的人话（为什么停；能不能撤），没有刻度、没有内置工具英文名、不重复对象行；期限写进「允许」钮（「允许（本会话）」），放行什么、范围、管多久、后果照样写明。
- 答完一行；拒绝一行，不再出失败卡。
- 结算行说真话（运行了 N 条命令、联网 N 次，计入子任务）；失败卡按错误码说原因、写厂商名不写 id、按对象聚合。
- 模型菜单的主机只在悬停、键盘高亮和「此前的内容会发往」确认里。
- 输入框工具行左簇的「在文件夹里工作」开关，取代两颗胶囊；文件夹 chip 在开关旁边原位出现。
- 新会话默认是有 key 的模型；所选模型用不了时发送钮禁用并说明原因。
- 00 两条已在 `feat/ux-craft` 落地的做法（临时种子、侧栏只画有页面的行）补上条款。

**非目标**

- 不改契约、Tape、IPC 通道与消息形状、提示层，不改权限语义：审批卡与回执的按键、默认焦点、主次按钮、哪个钮放行、确认步骤都不动，授权文字仍写明放行什么、范围、管多久、后果。
- 4d（`docs/features/task-mode-ui`）的东西不做：折叠头、命令子行、改动预览、会话列表、状态点；工具行里的整条路径改短写，随 4d 的工具行一起定。
- 对话中途转成任务（用户手势、开一个新的任务会话）在阶段 6。
- 04 的沙箱回执、`elevated` 卡文案、「沙箱不可用，将以你的权限运行」那句归 04；本 spec 只定它们在卡上的位置。
- 05 的「能否还原」：快照落地之前，「可以撤回」「有快照」两句不会出现。

## 怎么判「只涉及表现」

每条替换都过这五问，全是「不动」才算：

1. `packages/contracts` 的 schema 与路由：不动。渲染端只读已有的 `provider.list`、`session.modelChoice`、`session.facts`、`session.messages`、`mcp.list`、`approval.current`、`config.get` 与已有事件。
2. Tape 的名字、载荷与写入时机：不动。
3. IPC 通道与消息形状：不动。
4. 权限语义：02 §最小审批卡「按键」整条不动（一般卡 ⏎ = 允许、Esc = 拒绝，默认焦点在「允许」；撤不回的卡 ⏎ 与 Esc 都是拒绝，默认焦点在「拒绝」，放行只有点「允许」或焦点在「允许」上按 Space）；「期限」由 `allowScope`、`target.type`、是不是子任务卡决定的规则不动；`APPROVAL_CLICK_GUARD_MS` 不动。改了措辞的授权文字仍写明那四样。
5. 提示层（系统提示、工具描述、`MODEL_NOTES`）：不碰。

一条里搅着语义的，拆开：语义那半句照旧（下文「保留」），只换措辞、位置或形态。拆不开或要改行为的，不走这里：默认模型那条因此在 §对 02 的修补。

## 替换的条款

每条写：旧 spec 的节与原文（节名 + 引文，不写行号）；保留的部分；新条款在本 spec 哪一节；只涉及表现的理由（上面五问之外要多说一句的才写）；旧 spec 那一行行末要接的指针（`<日期>` 为实现合入当天，链接在 00–03 里写 `../../features/presentation-r1/spec.md`，在两份 features spec 里写 `../presentation-r1/spec.md`）。表格行的指针放进该行最后一格、结尾的 `|` 之前，表格才照常渲染。

**00-foundation**

- **R1** §UI 最小集「设计令牌」：「值用 §8.1 临时皮肤」。保留：键名分层、亮暗两套、壳层背景独立一层。新条款：§00 的两条。理由：令牌值只管观感。指针：「（<日期> 起由 presentation-r1 §00 的两条 取代：值见 docs/ux/tokens.md 的临时种子）」
- **R2** §国际化「英文更长」：「阶段 0 覆盖侧栏导航项与 Composer（同验收 12）」。保留：两种语言都不换行不截断、Playwright 截图加 DOM 断言、后续界面纳入同一回归。新条款：§00 的两条。理由：哪几行画出来是组件形态；回归规则本身不变。指针：「（<日期> 起由 presentation-r1 §00 的两条 取代：侧栏只画已有页面的行，每行随页面回来时重新计入回归）」

**02-agent-loop**

- **R3** §会话形态 表的「任务」行：「输入框下方有文件夹 chip（裁决 H1、D11）」。保留：工具集与 Read 的判定。新条款：§输入框。指针：「（<日期> 起由 presentation-r1 §输入框 取代：文件夹 chip 在输入框工具行里）」
- **R4** §阶段 2 做的组件 `ToolRow`：「查不到的（MCP 工具）用通用句，带工具名」。保留：一行人话、按工具名查目录、展开看纯文本的输入输出、默认不出 JSON。新条款：§工具行。理由：映射名 `<serverId>__<name>` 是 Tenon 内部的命名，换成连接器显示名加工具原名只是显示。指针：「（<日期> 起由 presentation-r1 §工具行 取代：连接器调用写显示名与工具原名）」
- **R5** 同表 `TurnSummaryLine`：「读了 N 个、改了 M 个、有没有对外发送，按各调用的 `effect`（read / write / external）计数」。保留：一轮一行、「一轮」的定义、只在 `paused` 以外的码结束时出、没有工具调用不出、不写「能不能还原」。新条款：§结算行。理由：只换计数口径与措辞；读的仍是工具结果视图（子任务的读子会话的 `session.messages`，02 §最小审批卡「排队行」已这样读）。指针：「（<日期> 起由 presentation-r1 §结算行 取代：按类别计数并计入子任务）」
- **R6** 同表 `BlockedNotice`：「写三样：拦了什么（有 `facts.target` 写它，否则写工具名）；为什么…；「已告诉模型」」。保留：四个拦截码各一句、按 `blocked.<source>` 与 `facts` 查、对话形态 Read 与 inspector 的分句规则、02 不给放行入口。新条款：§拦截回执。指针：「（<日期> 起由 presentation-r1 §拦截回执 取代：一行说为什么，不写工具名与「已告诉模型」）」（开放问题 8）
- **R7** 同表 `ModeSwitch`：「新会话发出第一条消息之前可在「对话 / 任务」之间切；建立后只显示形态，不能改」。保留：第一条消息之前可切、建立后不能改（`session.selectProfile` 回 `established`），读 `session.facts`、写 `session.selectProfile`。新条款：§输入框。指针：「（<日期> 起由 presentation-r1 §输入框 取代：「在文件夹里工作」开关）」
- **R8** 同表 `FolderChip`：「位于输入框下方」与「点开由主进程弹系统目录选择框」。保留：只在任务形态、第一个是 cwd、没选时「专用文件夹」、文件夹只能经主进程的目录框或预填进列表、预填点确认才生效、每项能移除。新条款：§输入框。理由：位置与「点开是列表、列表里的『添加』才弹目录框」是形态；进列表的两条路和预填的确认步骤一字不改。指针：「（<日期> 起由 presentation-r1 §输入框 取代：chip 在工具行开关旁，点开是列表）」
- **R9** §失败卡与结束原因 第一条：「① 发生了什么：按终态事件…的 `endReason.code` 查目录」与「② …已完成的列出来」。保留：三行都不能空、① 按结束码、② 按 `state` 分写与各句（确定没发生、可能已执行、后续写入未发生）、③ 按下表。新条款：§失败卡。理由：`provider-error` 再按已有的 `errorCode` 分句、厂商与模型写名字（槽位由 `providerId`、`modelId` 经 `provider.list` 换算）、已完成的按对象聚合，都只是读同一份数据换写法。指针：「（<日期> 起由 presentation-r1 §失败卡 取代：provider-error 按 errorCode 分句、已完成的按对象聚合）」
- **R10** 同节表格行「`user-stopped`、`shutdown-aborted`、`user-rejected`、… | 失败卡 | 中性 | 复制诊断信息」中的 `user-rejected`。保留：其余五个码照旧；「你拒绝就结束本轮」（F2）不变。新条款：§答完与拒绝。理由：出哪个组件是形态；Run 照样以 `user-rejected` 结束。指针（放进该行最后一格）：「（<日期> 起 user-rejected 由 presentation-r1 §答完与拒绝 取代：不出卡，拒绝那一行说本轮结束）」
- **R11** §最小审批卡 ③：「查 `confirm.reason.<reason>`；`flagged` 查 `confirm.reason.flagged.<category>`」。保留：按原因选句、不用模型给的文字、槽位只取该原因的必填 `facts` 键（可以一个不用）。新条款：§审批卡。指针：「（<日期> 起由 presentation-r1 §审批卡 取代：句子不写工具名、不重复对象）」
- **R12** 同节 ④：「`reversibility === 'irreversible'` 时单独一句「撤不回」」。保留：撤不回的卡有单独一句「撤不回」（措辞不变）。新条款：§审批卡。理由：加的是其余可逆性的后果句，撤不回那句一字不改。指针：「（<日期> 起由 presentation-r1 §审批卡 取代：每张卡一句「能不能撤」）」
- **R13** 同节 ⑥「两个按钮，期限写在「允许」旁」，与「期限」一条里的英文「Just this once」「This session」等。保留：两个按钮、期限只由 `allowScope` 与 `target.type`（与是否子任务卡）决定、中文期限词一字不改。新条款：§审批卡。理由：期限从钮旁挪进钮里，英文改成句中小写；仍写明范围与管多久。指针：「（<日期> 起由 presentation-r1 §审批卡 取代：期限写进「允许」钮）」
- **R14** 同节「答完」：「塌成一行：结果、期限、对象」。保留：只有 `allowed`、`denied` 留塌行，其余四种不留；live 与重画的数据来源；重复到达的 `requestId` 忽略。新条款：§答完与拒绝。指针：「（<日期> 起由 presentation-r1 §答完与拒绝 取代：主会话的卡塌行不再重复对象）」
- **R15** §模型菜单与输入框「分组」：组头文案「去设置填 key」。保留：只列已配置厂商、未配置的只留一行置灰组头、点击打开设置。新条款：§模型菜单。指针：「（<日期> 起由 presentation-r1 §模型菜单 取代：组头文案）」
- **R16** 同节「每一行」：「第二行是用途句（`purposeKey`）或行标记，后接目标主机，`endpoint.reach` 为 `loopback` 写「本机」，`private`、`public` 写主机名或 IP」。保留：两行、当前项打勾、第一行模型名、第二行用途句或行标记。新条款：§模型菜单。理由：主机仍按同一份 `endpoint` 算，只是挪到悬停提示与无障碍描述；外发确认与 kernel 的数据去向检查不动。指针：「（<日期> 起由 presentation-r1 §模型菜单 取代：主机只在悬停与确认里）」
- **R17** 同节「行标记」：`local-text-only` 的「<主机> · 仅文字对话」。保留：三个标记值、谁标什么、任务形态置灰。新条款：§模型菜单。指针：「（<日期> 起由 presentation-r1 §模型菜单 取代：行标记不带主机）」
- **R18** §表外模型与不发工具「菜单标记」：「Ollama 的行标「<目标主机> · 仅文字对话」，默认的回环地址就是「本机 · 仅文字对话」」。保留：表外模型「未验证 · 仅文字对话」、可以手填。新条款：§模型菜单。指针同 R17。
- **R19** §模型选择「数据去向」第一条：「菜单每行显示目标主机」。保留：按当前 baseURL 的主机算、只有回环叫「本机」、Ollama 不写死；第二、三条（原地确认、key 绑定主机）整条不动。新条款：§模型菜单。指针同 R16。
- **R20** §模型菜单与输入框「提示与禁发」：「禁发并说明原因（components.md:81）只有两种」。保留：两种原因与各自的依据一字不改。新条款：§输入框「发不了的原因」。理由：加第三种原因只是输入框不让点、说为什么；主进程对缺 key 的发送照旧什么都不写（02「缺 key 什么都不写」），排队项自动发出碰上缺 key 照旧出失败卡（02 验收 22）。指针：「（<日期> 起由 presentation-r1 §输入框 取代：加第三种：所选模型用不了）」
- **R21** 验收 34：「菜单每行显示目标主机，回环地址显示「本机」，私网地址显示主机名」与「「去设置填 key」」。保留：确认之前对该主机 0 次请求、「用新模型开新会话」不带旧内容、未配置厂商只留置灰组头。新条款：§验收标准 9。指针：「（<日期> 起由 presentation-r1 验收 9 取代：主机在悬停与确认里）」
- **R22** 验收 37：「参数名等于必填键」「失败卡三行都不空」。保留：每个原因、结束码、拦截码、收口来源、行标记、期限、横幅两份 locale 都有文案；穷举 switch；其余各句。换成「参数名都取自必填键或字段（厂商名、模型名两个换算槽位除外）」「失败卡（`user-rejected` 不出卡）三行都不空」。指针：「（<日期> 起由 presentation-r1 验收 14 取代上述两处）」

**03-mcp-host**

- **R23** §卡片与工具行「可逆性刻度上卡」整条。保留：「撤不回」那句照旧（即 R12 的保留）。新条款：§审批卡。理由：刻度只是显示，`card.reversibility` 照读。指针：「（<日期> 起由 presentation-r1 §审批卡 取代：去掉五格刻度，改为一句「能不能撤」）」
- **R24** 同节「ToolRow 副作用段与可逆性标记」整条。保留：数据取工具结果视图的 `effect` 与 `reversibility`；标记有屏读文字。新条款：§工具行。指针：「（<日期> 起由 presentation-r1 §工具行 取代：展开后一行说做了什么、能不能撤；标记只给撤不回的行）」（开放问题 8、9）
- **R25** 验收 45：「审批卡的可逆性刻度按 `reversibility` 高亮」与「工具行展开有副作用段、写和对外发送的行有可逆性标记」。保留：连接器卡的显示名与「定义已变」、`connector-unauthorized` 的「重新登录」。新条款：§验收标准 1、6。指针：「（<日期> 起由 presentation-r1 验收 1、6 取代上述两处）」

**custom-vendors**

- **R26** §对 02 的修补 第 1 条的两句文案：`model.mark.probed`「本机探测 · 不保证 · {host}」与 `model.mark.unprobed`「尚未通过探测 · 仅文字对话 · {host}」（及英文）。保留：`modelMarkSchema` 只增 `probed`、两个键名。新条款：§模型菜单。理由：去掉主机；「本机探测」去掉主机后会被读成「本机的模型」，改成「探测通过」。指针：「（<日期> 起由 presentation-r1 §模型菜单 取代：两句文案不带主机）」
- **R27** 验收 20：「实例行显示目标主机」。保留：本机切公网照 02 原地确认、确认前 0 次请求。新条款：§验收标准 9。指针：「（<日期> 起由 presentation-r1 验收 9 取代：主机在悬停里）」
- **R28** 验收 25：「失败卡与菜单显示 §实例被删或改坏 的文案」中「新消息」那一半。保留：新消息不发出、不写事实；续跑以 provider 错误结束、不换模型、失败卡用 `error.customVendorGone`；菜单触发器写「（已删除）」；删掉默认实例后新会话照常可发。新条款：§输入框「发不了的原因」。理由：新消息现在在输入框就被拦下、说同一个原因，主进程的拒绝不变。指针：「（<日期> 起由 presentation-r1 §输入框 取代：新消息在输入框说明已删除、不出失败卡）」

**model-display-names**

- **R29** §对 02 的修补 末段：「第二行（用途句或行标记，后接目标主机）不变」。保留：第一行与 chip 写显示名、设置卡下拉的写法。新条款：§模型菜单。指针：「（<日期> 起由 presentation-r1 §模型菜单 取代：第二行不再带主机）」
- **R30** 验收 3：「第二行仍有主机」。保留：其余各句。新条款：§验收标准 9。指针：「（<日期> 起由 presentation-r1 验收 9 取代：主机在悬停里）」

## 新条款

文案给出中文与英文的意思；定稿的键在 plan。所有新句子都是界面文案：一行、不截断；里面嵌的路径、命令、主机、模型 id、文件夹名是内容，可折行、不截断（02 §调用的键与读写的数据）。

### 审批卡

从上到下：① 问题式标题（不变）；② 对象一行（不变，02 E4 与 ②′）；连接器卡的显示名与「定义已变」那句（不变，03）；③ 为什么停；04 的「沙箱不可用，将以你的权限运行」（有 `facts.sandbox` 时，文案归 04）；④ 能不能撤；⑤ 改动（不变）；⑥ 按钮。没有刻度。

③ 为什么停，按 `reason`（必要时再按 `kind` 或 `target.type`）一句。不写内置工具名，不写对象行里已有的路径、命令、网址、搜索词与主机：

| 原因 | 中文 | 英文意思 |
|---|---|---|
| `default`，文件 | 改文件前要你同意。 | Changing a file needs your OK. |
| `default`，连接器 | 连接器做事前要你同意。 | A connector action needs your OK. |
| `default`，其余（02 不产出） | 这一步要你同意。 | This step needs your OK. |
| `outside-workspace` | 它不在这个任务的文件夹里。 | It is outside this task's folders. |
| `network`，搜索 | 搜索词会发到这台电脑之外。 | The search words leave this computer. |
| `network`，网址与其余 | 网址会发给这个网站。 | The address is sent to this site. |
| `command` | 运行命令前要你同意。 | Running a command needs your OK. |
| `elevated` | 照 04 §界面（本 spec 不定） | — |
| `policy` | 你的组织要求这一步先经你同意。 | Your organization asks for your OK on this step. |
| `flagged`，`exfiltration` | 这次请求可能把你的数据带到别处。 | This request might take your data elsewhere. |
| `flagged`，`inspector-failed` | Tenon 没能确认这一步是否安全。 | Tenon couldn't check that this step is safe. |
| `interaction-required` | 这个连接器要求你亲自确认。 | This connector wants you to confirm it yourself. |
| `irreversible` | 这类操作每次都要你亲自同意。 | Tenon asks you every time for this kind of step. |

④ 能不能撤，按 `reversibility` 一句；只有 `kind` 为 `network` 且可逆性为 `unknown` 时不出（③ 已说内容会离开这台电脑）。撤不回的卡（不论原因）④ 就是 02 的原句「撤不回。」，红色：

| 可逆性 | 中文 | 英文意思 |
|---|---|---|
| `read-only` | 只读，不会改动任何东西。 | Read only: nothing changes. |
| `revertible` | 做完可以撤回。 | You can undo this afterwards. |
| `snapshotted` | 改之前会留快照，可以还原。 | A snapshot is taken first, so it can be restored. |
| `irreversible` | 撤不回。（红，原句） | This can't be undone. |
| `unknown` | Tenon 没法替你撤回。 | Tenon can't undo this for you. |

⑥ 两个钮：「拒绝」与「允许（<期限>）」。期限词照 02 §最小审批卡「期限」的映射，中文一字不改（只这一次 / 本会话 / 本会话里这个域名 / 本次子任务 / 本次子任务里这个域名），英文改句中小写（just this once / this session / this domain, this session / this subtask / this domain, this subtask）。按键提示照旧挂在钮上：一般卡「拒绝 Esc」「允许（本会话） ⏎」，撤不回的卡「拒绝 ⏎ Esc」「允许（只这一次）」。按键、默认焦点、主次与点击防抖照 02，不动。钮一行右对齐，不折行。

于是每张卡都写明：放行什么（标题加对象）、范围与管多久（「允许」钮里）、后果（④；网络卡是 ③ 那句）。

### 答完与拒绝

- **允许**：塌成一行「已允许（<期限>）」/ "Allowed (<scope>)"。主会话的卡（`callKey === anchorCallKey`）不再重复对象，上面那一行就是它；子任务转上来的卡挂在父会话的 Agent 行下，塌行仍带对象行。
- **拒绝**：主会话的卡塌成一行「已拒绝 · 这一轮到此为止」/ "Denied · this round stops here"；这一行就是拒绝的全部反馈：那一行下不再出收口句「你拒绝了这个操作」，Run 以 `user-rejected` 结束时不出失败卡。同批排在后面的调用照旧各自一行「未执行」。子任务卡被拒只拒这一次（F2），塌成「已拒绝」加对象行，不写「这一轮到此为止」。
- 本轮已有完成的调用时，结算行照 §结算行 出。
- `runEnd.user-rejected` 的文案留在目录里（02 验收 37 要每个结束码有文案），去掉 `{toolName}`：「你拒绝了，这一轮到此为止。」。

### 拦截回执

（开放问题 8 定；推荐纳入。）02 的四个拦截码，回执是一行琥珀色的「为什么」，不写内置工具名、不重复上面那一行的对象、不写「已告诉模型」（04 对沙箱回执的同一规矩）：

| 来源 | 中文 | 英文意思 |
|---|---|---|
| `policy` | 你的组织不允许这一步。 | Your organization doesn't allow this step. |
| `user-disabled` | 你在设置里关掉了它。 | You turned this off in Settings. |
| `protected`，文件 | 这个位置受保护，Tenon 不读写它。 | This location is protected; Tenon doesn't read or write it. |
| `protected`，WebFetch | 这个地址指向本机或内网，不能抓取。 | This address points to this computer or a local network, so it can't be fetched. |
| 对话里的 Read（`blocked.chatReadScope`） | 对话里只能打开 Tenon 为这个对话保存的文件。 | In a chat, only files Tenon saved for this chat can be opened. |
| `inspector`，`exfiltration` | 这一步可能把你的数据带到别处，已拦下。 | This step might take your data elsewhere, so it was stopped. |
| `inspector`，`inspector-failed` | Tenon 没能确认这一步是否安全，已拦下。 | Tenon couldn't check that this step is safe, so it was stopped. |

有 `sandbox` 成员的调用照 04 §回执上有什么，不走这张表。

### 工具行

- 连接器调用的那一句：「使用 <连接器显示名> 的 <工具原名>」/ "Use <tool> from <connector>"。显示名取 `mcp.list`，原名按 `mcp.list` 里同一台的原名与映射名对上；对不上（连接器已删、名字被截断）时退回映射名。
- 展开后，「输入」「输出」之后一行（不再有「副作用」小标题）：做了哪类事 + ④ 那句。做了哪类事：改了这个文件 / 运行了这条命令 / 联网 / 用了连接器 / 没有执行；只读的调用不出这一行。例：「运行了这条命令 · Tenon 没法替你撤回。」
- 收起时的标记：只给可逆性为 `irreversible` 的行（开放问题 9），图标旁有悬停提示「撤不回」，屏读文字同一句。

### 结算行

一轮一行，按类别计数，零项不写，类别之间用「 · 」：

| 类别 | 算哪些调用 | 中文 | 英文意思 |
|---|---|---|---|
| 读文件 | Read，按不同路径数 | 读了 N 个文件 | Read N files |
| 查找 | Glob、Grep，按次数 | 查找 N 次 | Searched files N times |
| 改文件 | Write、Edit，按不同路径数 | 改了 N 个文件 | Changed N files |
| 命令 | Bash，按次数 | 运行了 N 条命令 | Ran N commands |
| 联网 | WebSearch、WebFetch，按次数 | 联网 N 次 | Went online N times |
| 连接器 | 连接器工具，按次数 | 用了连接器 N 次 | Used connectors N times |

- 只算派发过的调用（`effect` 不是 `blocked`）；AskUserQuestion 不算；Agent 调用本身不算，它的子会话里派发过的调用按同样的类别并进来（读子会话的 `session.messages`，子会话 id 取 `handoff.childSessionId`），不另标子任务（开放问题 11）。
- 每类都是零时不出这一行（与 02 「没有工具调用的轮不出」一致）。
- 不再有「有对外发送」：命令会不会联网，界面不知道，就只说运行了命令。

### 失败卡

- 所有结束卡（失败卡、阶段 1 的错误态）与内容列同宽。
- **厂商名**：凡是带 `providerId` 的句子写厂商名：内置的取 `provider.list` 条目 `nameKey` 的文案，实例取 `displayName`；列表里已没有它时写「模型服务」/ "the model service"（实例被删照旧用 `error.customVendorGone`）。`refusal` 的模型写显示名（`nameKey`），没有时写 id。
- **① `provider-error` 按 `errorCode`**（动作照 02 的表：`auth` 给「去设置」，其余照「重试」与「复制诊断信息」的规则）：

| `errorCode` | 中文 | 英文意思 |
|---|---|---|
| `auth` | <厂商> 的 API 密钥无效或没有填。 | The API key for <provider> is missing or not valid. |
| `rate-limit` | <厂商> 现在请求太多，稍后再试。 | <provider> is getting too many requests. Try again shortly. |
| `overloaded` | <厂商> 的服务正忙，稍后再试。 | <provider> is busy right now. Try again shortly. |
| `network` | 连不上 <厂商>，请检查网络。 | Can't reach <provider>. Check your connection. |
| `egress-denied` | 这次请求不允许发往 <厂商>。 | This request isn't allowed to go to <provider>. |
| `invalid-request` | <厂商> 拒绝了这次请求。 | <provider> turned down this request. |
| `server` | <厂商> 的服务出错了。 | <provider> had a server error. |
| `context-overflow` | 对话太长，<厂商> 接不下了。 | The conversation is too long for <provider>. |
| `quota-exhausted`、`account-config` | 同名结束码的那句 | — |
| `unknown`、null | <厂商> 出错了。 | <provider> ran into an error. |

  重试过的（`attempts` 大于 1）句末加「已试 N 次。」/ "Tried N times."。阶段 1 的错误态（没有 `endReason` 的 error）的 `auth` 改为「API 密钥无效或没有填。」并给「去设置」（开放问题 12）。
- **② 已完成的按对象聚合**：同一工具对同一对象的调用并成一行「读取 a.txt ×100」。文件路径写最后一段名字，完整路径在悬停提示与无障碍名里；两组的短名相同而路径不同时，这两组写完整路径；命令、网址、搜索词照旧写全。按第一次出现的先后排，最多列 5 组，其余收在「展开全部（N 项）」后面（开放问题 10）。

### 模型菜单

- 第二行只写用途句或行标记，不带主机：

| 行 | 中文 | 英文意思 |
|---|---|---|
| `verified` | 用途句（不变） | — |
| `local-text-only`，回环 | 本机 · 仅文字对话 | This computer · text conversation only |
| `local-text-only`，私网 | 仅文字对话 | Text conversation only |
| `unverified-text-only`，手填 | 未验证 · 仅文字对话 | Unverified · text conversation only |
| `unverified-text-only`，实例 | 尚未通过探测 · 仅文字对话 | No passing probe · text conversation only |
| `probed` | 探测通过 · 不保证 | Probe passed · not guaranteed |

- 内置厂商的地址不是它声明的默认地址时（`provider.list` 条目里 `baseURL` 键的 `default` 的主机与 `endpoint.host` 不同，如局域网里的 Ollama），第二行末尾照旧接「 · <主机>」：这种行只看名字猜不出数据去哪（开放问题 4）。
- 鼠标悬停或键盘高亮一行时显示「发往 <主机>」/ "Sends to <host>"，回环写「留在这台电脑上」/ "Stays on this computer"；同一句一直挂在行的无障碍描述上。
- 「此前的内容会发往 <主机>」的确认页、「用新模型开新会话」、kernel 的数据去向检查都不动。
- 未配置厂商的组头：「<厂商> · 去设置填 API 密钥」/ "<provider> · Add an API key in Settings"。

### 输入框

- **「在文件夹里工作」开关**：工具行左簇（`ComposerLead`）的一个 `Switch`，标签「在文件夹里工作」/ "Work in a folder"。关 = 对话，开 = 任务，经 `session.selectProfile` 写。只在会话建立之前出现；发出第一条消息之后不再显示（开放问题 5），任务会话靠文件夹 chip 认出来。对话 / 任务两个名字照 02 §会话形态，侧栏等别处照旧。
- **文件夹 chip**：开关打开时出现在开关右边，同一行。chip 上写 cwd 那个文件夹的名字（最后一段），多于一个时后接「 +N」；没选时写「专用文件夹」；名字放不下时改写「N 个文件夹」，不省略。悬停提示与无障碍名是完整路径。点开是一个浮层：每个文件夹一行完整路径（可折行），第一个标「命令在这里运行」，选来的每项可移除；「添加文件夹…」由主进程弹系统目录框；有没确认的预填时一项「用上次的 N 个文件夹」，点它就是确认；没选文件夹时一句「没选文件夹时，命令在 Tenon 为这个任务单独建的文件夹里运行。」
- 框下只剩一行淡字（免责 / 发送会取消待批的操作 / 发不了的原因），不再给文件夹留一行。开关开合、chip 出现消失，框和淡字行都不挪。
- **发不了的原因**（R20 的第三种；与前两种同一行、同一套禁用）：

| 情形 | 中文 | 动作 |
|---|---|---|
| 没有一个已配置的厂商 | 先在设置里填一个 API 密钥，才能发送。 | 去设置 |
| 生效的选择（`session.modelChoice`）的厂商 `configured: false` | <模型名> 现在用不了：<厂商> 没有可用的 API 密钥。 | 改用 <X>；去设置 |
| 实例或它那一行已删（M6 的「已删除」判法） | 这个会话用的自定义厂商或模型已删除。 | 改用 <X> |

  <X> 是按 `provider.list` 顺序第一个已配置厂商的第一行 `listing: 'main'`；任务形态只取能发工具的行（`verified`、`probed`）；没有这样的行就不给「改用」（开放问题 3）。「改用」等于在菜单里选这一行（`session.selectModel`，照 02 一起写默认）。禁用时 ⏎ 与 Cmd/Ctrl+Enter 都不发，0 次 `chat.send` / `chat.sendNow`。设置弹窗关上、窗口重新拿到焦点时重读 `provider.list`；读不到时不因此禁用。

### 00 的两条

- **R1 设计令牌的值**：值见 [docs/ux/tokens.md](../../ux/tokens.md)：2026-10-15 起是该文「2026-10-15 临时换装记录」的三个临时种子与由它们派生的值，§8.1 的赤陶奶油只作历史记录；定稿照主参考 §8.3。
- **R2 侧栏与双语回归**：侧栏只画已有页面的行（2026-10-15 起只有「新对话」），项目、产物、定时任务、技能与连接器四行随各自的页面回来，回来时重新计入双语「不换行不截断」回归（`shell-i18n.spec.ts` 的 `NAV_ITEM_COUNT`）。四个文案键保留。

## 对 02 的修补（M5）

1. **第一把 key 定新会话默认**（主进程，`provider.configure`）：一次保存成功后，若 config.json 的 `defaultModelByProfile.chat`、`defaultModelByProfile.cowork`、`provider` 三者都没有值，本构建没有 ④（开发构建的 `TENON_PROVIDER` / `TENON_MODEL`），且这次保存写下了它的一把非空 key、之后按 01 修补 6 的算法读作「已配置」（用这次写入的值与锁里读到的 config 算，不另读钥匙串），就在同一把 profile 锁里写：`provider` 与 `defaultModelByProfile.chat` 写成它 `listing: 'main'` 的第一行；`defaultModelByProfile.cowork` 只在那一行能发工具（`verified` 或 `probed`）时写。不写 `source`。其余情况一概不写。五层解析、`resolveChoice` 不读密钥、`session.selectModel` 的写法都不动。
   - 只增：在原来什么都不写的一种情形里加一次写入，不改任何既有成员的形状，config 键都是 02 已立的。
   - 失败行为：这次写入失败不影响 key 的保存结果（key 已在钥匙串、`provider.configure` 照旧回 `ok`），日志记一行，不带 key。
2. **点名**（不属纯粹只增，要 owner 确认，开放问题 2）：02 §模型选择「设置卡」写「保存时只有用户改过这个下拉才写」，§模型菜单与输入框「设置卡」写「只有改动过这个下拉，保存时才写」。第 1 条在三键都空时不改下拉也写。这两句之后读作「三键都空时除外」，正文不改。

## 与 04 第三段的先后

04 第三段（04 plan 第 16–20 步）动的是：`ApprovalCard.tsx`、`lib/approval-card.ts`（`elevated` 文案、「沙箱不可用」那句）、`ToolRow.tsx` 的 `BlockedNotice`（沙箱回执）、两份 locale、`copy-coverage.test.ts`、新的 text-fit e2e，以及设置弹窗的「权限与网络」一栏。本 spec 改前五样，不碰设置弹窗。

推荐：**本 spec 先实现、先合入，04 第三段在它之上做**（开放问题 13）。理由：

- 两边改同一组文件，04 新加的句子（`elevated`、「沙箱不可用」、沙箱回执）一次落进最终版式，不用先落进旧卡再搬；04 验收 33 的「回执不讲机制」测试可以连本 spec 的键一起查。
- 04 第三段排在第二段与基线评测（第 15a 步，要有 key 的一方跑）之后，本 spec 不依赖 kernel 与契约，能和 04 第一、二段并行，不推迟 04。
- 反过来做，本 spec 要改 04 刚落地、刚测过的卡；并成一个 PR 则一个 PR 对两份 spec，审查与回退都更难。

本 spec 合入时在 04 plan 第 18 步末尾加一句交接：卡面的位置照 presentation-r1 §审批卡（③ 放 `elevated` 句，「沙箱不可用」在 ③ 与 ④ 之间），按键与焦点仍照 02。04 的 spec 不用改：它只规定这两句的文字，没规定位置。

## 旧 spec 上要加的

和实现同一个 PR，日期写合入当天；旧文一字不改，只在行末接 §替换的条款 里各条的指针，顶部加一行（`Status` 不变）：

- 00：`Clauses replaced by: [presentation-r1](../../features/presentation-r1/spec.md)（<日期>：§UI 最小集「设计令牌」的值、§国际化「英文更长」的覆盖范围）`
- 02：`Clauses replaced by: [presentation-r1](../../features/presentation-r1/spec.md)（<日期>：§会话形态 任务行的文件夹 chip、§阶段 2 做的组件 的 ToolRow 通用句与 TurnSummaryLine、BlockedNotice、ModeSwitch、FolderChip 四行、§失败卡与结束原因 ①② 与 user-rejected、§最小审批卡 ③④⑥ 与答完、§模型菜单与输入框 的组头文案、每一行、行标记与提示与禁发、§表外模型与不发工具 的菜单标记、§模型选择 数据去向第一条、验收 34 与 37 各两处）`；另加 `Amended by: [presentation-r1](../../features/presentation-r1/spec.md)（<日期>：第一次存 key、新会话默认还空着时把默认落到这个厂商；「只有改过下拉才写」读作三键都空时除外，见该 spec「点名」）`
- 03：`Clauses replaced by: [presentation-r1](../../features/presentation-r1/spec.md)（<日期>：§卡片与工具行 的可逆性刻度与 ToolRow 副作用段、验收 45 两处）`
- custom-vendors：`Clauses replaced by: [presentation-r1](../presentation-r1/spec.md)（<日期>：§对 02 的修补 第 1 条两句文案、验收 20、验收 25 的新消息一半）`
- model-display-names：`Clauses replaced by: [presentation-r1](../presentation-r1/spec.md)（<日期>：§对 02 的修补 末段、验收 3 的主机一句）`

开放问题 8 选 B 时，R4、R6、R24 与 R25 的工具行一半连同各自的指针一起去掉。

## 不变量

1. 审批卡与回执上的按键、默认焦点、主次按钮、哪个钮放行、点击防抖与 02 §最小审批卡「按键」「排队行」相同。
2. 期限文字只由 `allowScope`、`target.type`、是否子任务卡决定，与写进 `approval_resolved.grant.scope` 的值一一对应。
3. 每张审批卡写明放行什么、范围与管多久、后果（④；网络卡是 ③ 那句）；撤不回的卡有原句「撤不回」。
4. 本 spec 的渲染端改动不加路由、不加字段、不改 schema；契约面的改动只有 §对 02 的修补 第 1 条那次 config 写入。
5. 结算行的数字只来自工具结果视图（含子会话的 `session.messages`），同一轮不重复计数。
6. 发送钮因模型用不了而禁用时，输入框调用 `chat.send`、`chat.sendNow` 0 次。
7. 模型菜单的外发确认与 kernel 的数据去向检查不变：确认之前对目标主机 0 次请求。

## 验收标准

测试名以「presentation-r1 验收 N:」开头。D = `apps/desktop/test/`，E = `apps/desktop/e2e/`。

1. 审批卡上没有刻度；③④ 照 §审批卡 的两张表出（撤不回的卡 ④ 是红色的「撤不回。」，网络卡没有 ④）；两份 locale 里卡上的文字不含任何内置工具名（Read、Write、Edit、Bash、Glob、Grep、WebSearch、WebFetch、Agent、AskUserQuestion）。〔D/renderer-approval-card.test.ts、D/copy-coverage.test.ts〕
2. 每种目标的卡，③ 的文字不含对象行里的任何一段（路径、命令、cwd、网址、搜索词、主机）。〔D/renderer-approval-card.test.ts〕
3. 「允许」钮带期限，五种期限各一例，且与答复写下的 `grant.scope` 对应；02 验收 36 的按键与焦点各条原样通过（撤不回卡默认焦点在「拒绝」、卡内 ⏎ 都是拒绝、Space 在「允许」上放行；一般卡与连接器卡 ⏎ = 允许）。〔D/renderer-approval-card.test.ts、E/approval.spec.ts、E/write-card.spec.ts〕
4. 允许后主会话的卡塌成「已允许（<期限>）」一行、不带对象行；拒绝后只有「已拒绝 · 这一轮到此为止」一行：没有收口句、没有失败卡，同批后面的调用各一行「未执行」；子任务卡的塌行带对象；重启后从 `calls` 重画出同样的行。〔E/approval.spec.ts、E/subagent.spec.ts、D/renderer-end-card.test.ts〕
5. 四个拦截码的回执各一行，不含「已告诉模型」与内置工具名；有 `sandbox` 成员的调用不走这张表。〔D/renderer-tool-row.test.ts、D/copy-coverage.test.ts〕
6. 连接器调用的行写「使用 <显示名> 的 <原名>」，连接器删掉后退回映射名；展开后一行写做了哪类事与能不能撤，只读的调用没有这一行；只有撤不回的行收起时带标记，标记有悬停提示与屏读文字。〔D/renderer-tool-row.test.ts、E/connectors.spec.ts〕
7. 结算行：一轮里 Read a.txt 三次、Edit b.txt 两次、Bash 两次、WebFetch 一次、Agent 一次（子会话里 Write c.txt 一次）时写「读了 1 个文件 · 改了 2 个文件 · 运行了 2 条命令 · 联网 1 次」；没有零项；被拦、没派发的不算。〔D/renderer-thread-model.test.ts、E/subagent.spec.ts〕
8. 失败卡：`provider-error` 的每个 `errorCode` 一句，401 与 400 两张卡第一行不同；句子里是厂商名不是 id；结束卡与内容列同宽；步数上限卡对 100 次读同一文件写「读取 a.txt ×100」一行，同名不同路径的两组写完整路径，超过 5 组时其余收进「展开全部」。〔D/renderer-end-card.test.ts、E/run-end.spec.ts、E/retry.spec.ts〕
9. 模型菜单：行内不写主机（地址不是默认值的内置行除外）；悬停或键盘高亮时出现「发往 <主机>」，行的无障碍描述是同一句；回环行写「本机 · 仅文字对话」；外发确认页照旧写主机、确认前对该主机 0 次请求；未配置组头写「去设置填 API 密钥」；实例行同样只在悬停里给主机。〔E/model-menu.spec.ts、E/custom-vendor.spec.ts、D/renderer-custom-vendor.test.ts〕
10. 输入框：首页工具行左簇是「在文件夹里工作」开关；打开后 chip 出现在同一行，框与框下那行的位置前后相差 0 像素；发出第一条消息后没有开关，任务会话里 chip 还在；建立后的 `session.selectProfile` 照旧回 `established`；chip 浮层里添加走系统目录框、预填点了才进列表、每项可移除；名字放不下时 chip 写「N 个文件夹」。〔E/composer.spec.ts、E/composer-frame.spec.ts、E/tools.spec.ts〕
11. 发不了：没有已配置厂商时发送钮禁用、框下一行说明并给「去设置」；生效选择的厂商没配置时说明并给「改用 <X>」「去设置」，点「改用」后可发；删掉会话用的实例后同样禁用并说明；三种情形下 ⏎ 与 Cmd/Ctrl+Enter 都是 0 次 `chat.send` / `chat.sendNow`。〔E/provider-settings.spec.ts、E/custom-vendor.spec.ts、D/session-store.test.ts〕
12. 修补：三键都空、没有 ④ 时，第一次存 key 后三键（任务形态那一键只在那一行能发工具时）写成该厂商的第一行，新会话的 chip 是它、可发；已有默认时存 key 不改默认；④ 有值时不写；写入失败时 key 照存、回 `ok`。〔D/provider-routes.test.ts、E/provider-settings.spec.ts〕
13. 双语：上面每个改动的界面文字在 zh-CN、en 的 1280×800 下不换行、不截断；输入框工具行（开关、chip、模型 chip、停止、发送）与框下那行在 800×520、侧栏展开时也不换行不截断；内容（路径、命令、主机、模型 id、文件夹名）可折行不截断。〔E/text-fit-r1.spec.ts〕
14. 文案覆盖：每个原因（按 kind 与目标细分的）、可逆性、拦截码、`errorCode`、结算行类别、行标记、发不了的三种原因在两份 locale 里都有文案，参数名都取自各自的必填键或字段（由 `providerId`、`modelId` 换算出的厂商名、模型名两个槽位除外）；失败卡（`user-rejected` 不出卡）三行都不空；审批卡、塌行、拦截回执、工具行那一行、结算行的中英文案不含「模型」「可逆」「判决」「已告诉」/ model、reversib、verdict（04 的「沙箱不可用」那句不在这组键里）。〔D/copy-coverage.test.ts〕
15. 文档：00、02、03、custom-vendors、model-display-names 只多了行末指针与顶部一行（02 两行），旧文没有一个字被改；components.md「待呈现 spec 替换的条款」两行标已替换。〔plan 的 git diff 核对〕

## 开放问题

都在改 `ready` 之前定；推荐项写在第一个。

1. **默认模型怎么落到有 key 的厂商**：A（推荐）第一次存 key、三键都空、没有 ④ 时，主进程写默认（§对 02 的修补）；B 五层解析跳过没配置的厂商——`resolveChoice` 要知道哪个厂商有 key，02 定了它不读密钥（钥匙串弹窗不能挡在数据去向判断之前），得另加一个不含密钥的「已存 key」记号进 config.json，记号会过期；C 只在渲染端做：设置卡在存第一把 key 时把「新会话默认模型」下拉预选成它，输入框给「改用」，不改主进程。
2. **「只有改过下拉才写」那两句**：A（推荐）按 §对 02 的修补「点名」读作三键都空时除外，旧文不改；B 为这一处 supersede 02 §模型选择（不成比例）。
3. **模型用不了时给不给一键改用**：A（推荐）给「改用 <X>」加「去设置」，改用就是一次菜单选择；B 只给「去设置」。
4. **模型菜单行上的主机**：A（推荐）只在悬停、键盘高亮与外发确认里，但地址不是默认值的内置行（局域网 Ollama、改过地址的行）行内照旧写主机，02 开放问题 23 的「去向看行上的目标主机」对这些行仍成立；B 一律只在悬停里。
5. **会话建立后的开关**：A（推荐）不再显示，任务会话靠 chip 认；B 显示一个关不掉的开关，悬停写「建立后不能改」。
6. **「能不能撤」在 `unknown` 时**：A（推荐）写「Tenon 没法替你撤回。」——阶段 2–4 的写入与命令全是这一档，不写就看不出后果；B 不写，只在只读、可撤回、有快照、撤不回时写。
7. **网络卡的 ④**：A（推荐）不出，③「搜索词会发到这台电脑之外」「网址会发给这个网站」已说后果；B 照 `unknown` 出「Tenon 没法替你撤回。」。
8. **范围再加三项**（同一规矩、同一批文件）：拦截回执旧四码去掉「已告诉模型」与工具名（R6）、工具行展开那一行与标记（R24）、连接器调用句（R4）。A（推荐）一并纳入；B 只做 owner 列的几项，这三项留给 4d。
9. **工具行标记给哪些行**：A（推荐）只给撤不回的行；B 照 03 给写与命令的行（几乎每行都有，等于没有），只改说明文字。
10. **步数上限卡聚合后列几组**：A（推荐）5 组，其余收进「展开全部（N 项）」；B 全部列出。
11. **结算行里子任务的份**：A（推荐）并进同一组数字，不另标；B 有子任务的数时句末加「（含子任务）」。
12. **阶段 1 错误态的 `auth`**：A（推荐）改成「API 密钥无效或没有填。」并给「去设置」；B 照旧只改文案、不加按钮。
13. **与 04 第三段的先后**：A（推荐）本 spec 先实现、先合入，04 第三段在它之上做；B 04 第三段先做，本 spec 之后改它刚落的卡；C 两者并进一个 PR。

## 被否决的方案

- 整份 supersede 02、03：为几句文案与一处位置作废两份大 spec，不成比例（第三个例外就是为此立的）。
- 刻度留着、只改字：五格仍是一张分类表，不是一句话（parity-audit 2026-09-13：审批那一刻只多给一句为什么停、能不能撤）。
- 「工作位置」chip（仅对话 / 专用文件夹 / 我的文件夹）：会和 6b 的「运行位置」混；owner 2026-10-15 选了开关。
- 开关在工具行、文件夹仍在框下：一个控件拆在两处，切换时框下那一行要么跳、要么常年空着。
- 拒绝后仍出失败卡：拒绝是你做的决定，不是失败；三层反馈说的是同一件事。
- 结算行按 `effect` 计数、只改字：Bash 的 effect 是 `external`，怎么改字都会把每条命令说成对外发送。
