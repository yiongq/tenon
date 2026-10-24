# 呈现修订第一轮（presentation-r1）

Status: implemented
Kind: features
Owner: 起草在 Claude Code（2026-10-15）。owner 2026-10-15 在对话里听过白话讲解与模拟界面后定（「都按推荐来」）：§开放问题 1、3–9、14–17 都取 A（推荐项），§按推荐定、owner 可否决 的 2、10–13 照写、未否决；同日另说内置厂商的默认模型要跟随家族的最新一行：§对 02 的修补 第 1 条照 claude-5-5-models §跟随最新「谁写指针」写，构建里有那份 spec 的 `latestOf` 时，带家族的内置第一行写指针，没有时写该行的 id（留作钉住），自定义实例照旧写行的 id（见该条）。方向是 owner 2026-10-15 定的：B+ 的轨二（去掉界面上的机制）、对话 / 任务入口改成「在文件夹里工作」开关（保留 02 的 H1，契约 `session.selectProfile` 不变）、[docs/spec-driven-dev.md](../../spec-driven-dev.md) 的第三个例外。选项与评审在仓库外 `../tenon-notes/2026-10-14-desktop-codex-ux/`（`ux-compare-and-decision.json` 的 `final`；诊断 M01、M02、M07、M08、C01 在 `codex-and-tenon-ux-diagnosis.json`）
Amends: [02-agent-loop](../../architecture/02-agent-loop/spec.md) §会话形态、工作区与模型选择「模型选择」（M5）与 §对 01-provider-and-tape 的修补 第 6 小节的 `provider.configure`；[01-provider-and-tape](../../architecture/01-provider-and-tape/spec.md) §desktop 接线 的 `provider.configure`；[custom-vendors](../custom-vendors/spec.md) §写入规则 的「新建」与「保存实例的 key」：第一次存 key（含新建带 key 的自定义实例）、新会话默认还空着时，把默认落到这个厂商。只增这一种写入；碰到 01、02、custom-vendors 旧文字的几句在 §对 02 的修补「点名」(a)–(c)、(e)，owner 2026-10-15 确认（开放问题 2，照推荐、未否决）。另有一处读法：02 §最小审批卡「按键」里的钮上文字读作带期限的允许钮，键、默认焦点、哪个钮放行都不变（「点名」(d)，开放问题 17 A，owner 同日确认）。日期为 2026-10-22（写入指针的日期，定义见 §替换的条款 引言）；02 §工具调用的收口 的工具结果视图（kernel 的 `ToolOutcomeView` 与 contracts 的 `toolOutcomeViewShape`）只增 `isError`（§对 02 的修补 第 3 条，owner 2026-10-22 定）
Replaces: 照第三个例外逐条替换，日期为 2026-10-22（写入指针的日期，定义见 §替换的条款 引言，与旧 spec 指针上的日期相同），理由是界面不讲内核机制（[parity-audit](../../ux/parity-audit-2026-09-12.md)「2026-09-13 补记：简化决定」）与 owner 2026-10-15 的 B+ 轨二：[00-foundation](../../architecture/00-foundation/spec.md) 两条（R1、R2）；[02-agent-loop](../../architecture/02-agent-loop/spec.md) 二十一条（R3–R16、R19–R22、R31、R32、R35）；[03-mcp-host](../../architecture/03-mcp-host/spec.md) 三条（R23–R25）；[custom-vendors](../custom-vendors/spec.md) 四条（R26、R28、R33、R34）；[model-display-names](../model-display-names/spec.md) 两条（R29、R30）。R17、R18、R27 已删去，编号不复用。每条的原文、保留的部分、新条款在哪、为什么只涉及表现，见 §替换的条款
Related: claude-5-5-models（`docs/features/claude-5-5-models/spec.md`，与本 spec 同日并行起草，在分支 `docs/claude-5-5-models` 上、尚未进 `dev`，两份谁先合入 `dev` 都行，所以这里不写链接，免得先合入的一方在 `dev` 上指向不存在的文件）。核对基准是那个分支的 `cbde44f`。两份谁也不等谁，后合入的一方负责衔接（plan「与 claude-5-5-models 的先后」）。交叉的有这几处：① 第一把 key：那份 spec §跟随最新「谁写指针」要本 spec §对 02 的修补 第 1 条对带家族的内置第一行写 `latestOf` 指针；第 1 条按构建里有没有 `latestOf` 分两种写法，有时与它的验收 19 相同（本 spec 验收 12）；② 它的不变量 5 保持 Anthropic 表第一行是 `claude-opus-5-5`、不是 `listing: 'more'`，第 1 条对 Anthropic 写下的就是这一行；③ 两份都改的文件：`apps/desktop/e2e/model-menu.spec.ts` 首条用例与 `text-fit-02.spec.ts`（菜单行上的主机以本 spec 验收 9 为准）、`apps/desktop/e2e/provider-settings.spec.ts`（它的验收 17 与本 spec 验收 11、12）、`apps/desktop/src/main/provider-routes.ts` 与 `provider-routes.test.ts`（本 spec 改 `provider.configure`，它改 `selectionOf`、`provider.select`、`menuRow`）、两份 locale 与 `copy-coverage.test.ts`
Revisions: 2026-10-15 首版。同日按三轮评审就地修订（尚无代码依赖）：「改用 <X>」先按菜单的规则判数据去向，菜单会出外发确认的情形改为打开确认页（旧：直接调 `session.selectModel`，会绕过 02 §数据去向 的确认）；④ 的省略按原因判，`policy` 与 `inspector-failed` 的网络卡出网络句（旧：`network` 类且可逆性 `unknown` 一律不出，这些卡上没有后果句）；主会话的允许塌行留下工具行没有的授权范围：命令的 cwd、搜索的后端域名（旧：一律不带对象）；行内主机只对地址是内置厂商声明默认值的行去掉，自定义实例的行与改过地址的行照旧写，R17、R18、R27 删去，R26 只把「本机探测」改成「探测通过」、主机照旧（旧：实例行也只在悬停里、`local-text-only` 私网改写）；点名补 02 验收 33 与 01 的 `provider.configure`，Amends 加 01（旧：只列 02）；R13 只换 ⑥，英文期限词不动（旧：英文改句中小写）；验收 4 的重启重画限于主会话卡；R4、R5、R6、R8、R9、R16、R19、R21 补引被换的半句或改写理由，加 R31（02「已配置」组头）、R32（02 刻度排期）、R33（custom-vendors 验收 19 与 §目标 第 2 条）；`elevated` 在 ③ 规则与验收 2 豁免；定义「有 key 的厂商」（Ollama 不算），发不了的原因与组头按 `refused` 分句；读文件、查找、改文件只算成功完成的调用；工具行展开那一行按工具名分类；拦截回执的 `protected` 分读、写、抓取，抓取句改写；仅文字模型的两句改说开关；设置关上同时重读 `session.modelChoice`；`revertible`、`snapshotted` 两句归 05；加开放问题 14（发送与停止同位）、15（例行卡的 ③）；开放问题 9 注明改 parity-audit:292；验收 1 改成可测的三条；plan 补 04 的开工门、各步的 e2e 文件与文档清单。2026-10-15 第二次评审修订（又一批评审，逐条对照仓库核对，尚无代码依赖）：网址卡的 ③ 写回规范化主机名「网址会发给 {host}。」，④ 第 3 条的网址句带从 `target.url` 算出的主机，允许塌行接「· 发往 <主机>」（旧：「网址会发给这个网站」、塌行不接，授权落在哪个主机名上卡上与塌行里都看不到）；文件卡的允许塌行在工具行的路径与真实路径逐字不同时接真实路径（旧：一律不接，理由「工具行写着完整路径」不成立，工具行是模型给的 `file_path`）；「改用 <X>」在 X 的行内写主机时打开菜单、高亮那一行（旧：新会话或不需确认时直接选，实例的主机可能从没出现）；R13 依赖的「按键」读法列为「点名」(d) 与开放问题 17，R13 指针写明按键条不变，02 的 `Amended by:` 记 (d)（旧：挂在开放问题 2 下一并确认，02 上无记录）；预填浮层逐行列出路径、开关打开时自动展开、焦点留在开关上（旧：只写数量；评审建议把焦点放到确认项，那是改确认步骤，未采纳）；修补扩到 `customVendor.create` 与 `configureInstance`，Amends 加 custom-vendors 与「点名」(e)，第一行仅文字时连 `provider` 也不写（旧：只挂 `provider.configure`，实例的第一把 key 不触发；只不写 cowork，任务形态仍会经 ③ 落到仅文字行）；框下的发不了与仅文字模型句不写模型名与厂商名，英文约 70 字符，缺 key 一句不再说「填了 key 才能发」（旧：句含模型名与厂商名，800×520 放不下；Ollama 不要 key 也能发）；「有 key 的厂商」写明 `configured` 是先决条件（旧：读不出优先级）；文件夹 chip 的名字列为开放问题 16，推荐单个文件夹写完整名字、chip 内折行（旧：放不下写「N 个文件夹」，推翻 PR #46 刚验收的折行而未列问题）；结算行的读与查找不算 `own-output-read`；撤不回的卡并进开放问题 15 不出 ③（旧：「这类操作每次都要你亲自同意」，与 ④ 重复，且策略与总是允许能免掉这一问）；④ 的 `unknown` 分写入直说与其余条件句（旧：一律「Tenon 没法替你撤回」，把不知道说成会改）；加 R34（custom-vendors 探测结果表的通过一句）；R24 保留改为只取 `reversibility`、类别按工具名，03 读法 42 不接指针；R11 原文补「③「为什么停」一句」两层；R26 删「回环实例上会出本机探测 · 本机」（回环实例不探测）；智谱、Anthropic 改地址即被拒，「地址改过的内置行」只举 Ollama；非目标补 06 的 inspector 回执放行与持久文件夹授权、05 的结算行能否还原；04 的交接补旧四码回执已是一行与 copy-coverage 不按行号，plan 第 11 步给 04 的 4d 清单补工具行短写（与开放问题 14 A 时的单钮）；本 spec 头行的日期由 plan 第 11 步填；plan 补 `BrandRow`、`chat.spec.ts`、`retry.spec.ts` 与第 8 步末的 EA；开放问题每问先用一句白话说取舍，2、10–13 挪进「按推荐定、owner 可否决」，编号不变。2026-10-15 owner 定开放问题（对话里听过白话讲解与模拟界面之后）：1、3–9、14–17 都取 A（推荐项），2、10–13 照推荐、未否决；各问就地标已定，题面与被否决的选项留着备查；正文、验收与 plan 里按选项分写的句子改成已定的写法，被否决的一支留一句括注或标「留作记录」（「怎么判」第 4 问、R11、R13、§审批卡 ③ 与 ⑥、§拦截回执、§输入框 的文件夹 chip、§与 04 第三段的先后 末段、§旧 spec 上要加的 末段、「点名」引言、验收 1、10、13、15）（旧：各处写「选 A 时 / 选 B 时」两支，「点名」与 `Amends:` 写「要 owner 确认」）；验收 15 加 parity-audit 的补记（开放问题 9 A）与 04 plan 的开工门（开放问题 13）（旧：两样只在 plan 里）；第 0b 步照 13 在 04 plan 第 16 步之前加了开工门。同日与 claude-5-5-models 对齐（owner 定内置厂商的默认模型跟随家族的最新一行）：§对 02 的修补 第 1 条对内置厂商写下的模型照那份 spec，它实现之后写它定义的跟最新家族指针，之前写那一行的具体 id；自定义实例照旧写行的 id；验收 12 与 plan 第 9 步随改，加 `Related:`（旧：一律写第一行的 id）。2026-10-15 第三次评审修订（两批评审，逐条对照仓库与兄弟分支 `docs/claude-5-5-models` 的提交 `3a85b7c` 核对，尚无代码依赖）：§对 02 的修补 第 1 条、验收 12、开放问题 1 的已定、`Owner`、`Related` 与 plan「前提」、第 9 步去掉「跟最新家族指针」一支，内置厂商与实例一律写第一行的 id，owner 那句「默认跟随家族的最新一行」记作写下时即成立，自动跟新留给另一份 spec（旧：claude-5-5-models 实现后写它定义的指针、形状与解析归它；可那份 spec 在 `3a85b7c` 里既没有这项决定也没有指针，往 `providerSelectionSchema` 写非行 id 会被五层解析当表外 id，「只增」也就没了着落）；`Related` 不再链到兄弟 spec（它还不在 `dev`），改写两份的交叉（其不变量 5、模型菜单测试），plan 加「与 claude-5-5-models 的先后」（旧：带链接，只写默认跟随最新一行，菜单主机的冲突与同改一个测试都没写）；04 plan 第 16 步之前的开工门与 §与 04 第三段的先后、验收 15、开放问题 13、plan「先后」与第 0b 步里的门文改成看实现已合入 `dev`（spec 顶部 `Status: implemented`），只有 spec 文档在 `dev` 上不算（旧：「已合入 `dev`」，本 spec 的文档 PR 一合就算满足）；§与 04 第三段的先后 开头与第 4 段、R9 理由句、plan「先后」与第 0b 步去掉按选项分写的残句（旧：「推荐：」「选 13 A 时」「开放问题 12 选 B 时只换句」）；§审批卡 ③ 写明 `default`、`command`、`irreversible` 三类的键都留在目录、不渲染、值取 B 的句子，plan 第 1 步列出值，「no {toolName} slot」查全部 `confirm.reason.*`（旧：只写了 `irreversible`，`default`、`command` 带 `{toolName}` 的旧句会原样留着）；R22 的新写法补上规范化主机这第三个换算槽位，与验收 14 逐字一致，R22、R25 的指针补上冒号后一句（旧：只豁免厂商名、模型名；指针只写「取代上述两处」）；「点名」(c)、(e) 的引文改成逐字（旧：丢了反引号、删了括注）；不变量 3 与 §审批卡 末段把「网址卡写出规范化主机」收窄为 `network` 原因与 ④ 第 3 条的网址卡，写明 `flagged`/`exfiltration` 卡只放行这一次、主机在允许后的塌行里（旧：泛指网址卡，与 ④ 第 2 条、验收 1 矛盾；另一种修法是让外带卡也出带主机的 ④，那会改开放问题 7 A，未采纳）。2026-10-15 第四次评审修订（三批评审，逐条对照仓库与兄弟分支 `docs/claude-5-5-models` 的 `cbde44f` 核对，尚无代码依赖）：撤回第三次修订里第一把 key 的那条。那次核的是兄弟分支的 `3a85b7c`，可 `cbde44f`（14:44，早于第三次修订的提交）已在 §跟随最新 定义了指针 `{ id, modelId, latestOf }`：`modelId` 仍是行 id、旧构建读作钉住，所以「五层解析把非行 id 当表外 id」那条理由不成立。它的「谁写指针」还要本条对带家族的行写指针，验收 19 断言了这一点。现在 §对 02 的修补 第 1 条按构建里有没有 `latestOf` 分写：有时，带家族的内置第一行写指针；没有时写行 id；实例照旧写行 id。触发、写哪几个键、写在哪一次写入里与失败行为都不变。「只增」与不变量 4 注明 `latestOf` 是那份 spec 的成员；`Owner`、开放问题 1 的已定、验收 12（分指针、钉住两例，指针一例与它的验收 19 相同）与 plan 第 9 步随改（旧：一律写行 id；`Owner` 写「随新家族自动换的记号没有哪份 spec 定义」，已定写「写下时即成立」）。`Related` 写明核对基准 `cbde44f`，逐项列出交叉处（加第一把 key、`provider-settings.spec.ts`、`provider-routes.ts` 与其测试、两份 locale 与 `copy-coverage.test.ts`）。plan「与 claude-5-5-models 的先后」改成谁也不等谁、后合入的一方衔接，菜单测试改引它的第 6 步（旧：「交叉的只有两处」「两份互不依赖，谁先实现都行」「claude-5-5-models 第 5 步」；`cbde44f` 里第 5 步已是家族排位）。④ 第 3 条的联网句改用非原因键 `confirm.undo.network.search`、`.url`，`{host}` 取自 `target`，`confirm.reason.*` 的槽位照旧只取必填 `facts` 键；R11、R22、验收 1、14 与 plan 第 1 步随改（旧：借 `confirm.reason.network.url`，可 `policy`、`inspector-failed` 的必填键里没有 `host`，与 00 §HostAdapter 不变量「界面文案的槽位只取必填键」和 R11 的保留冲突）。R9 引文补「槽位取这个成员的字段」；加 R35，替换 02 §结束原因词表 的「各有 18 条文案、槽位齐全」；02 的 `Clauses replaced by:` 括注与 `Replaces:` 计数随改（旧：两处没进任何 R，落地后 02 正文仍写旧规则）。R32 加 02 §目标与非目标「完整版界面」里刻度的去向（旧：同类排期句只覆盖 02 §可逆性 一处）。「改用」钮写厂商名与模型名，悬停与无障碍描述写「发往 <主机>」；不变量 7、R20 的理由、验收 11、13 与 plan 第 8 步随改（旧：钮上只写模型显示名。有历史的会话从公网 A 换到公网 B 时不出确认，用户在这条路上始终看不到厂商名）。指针与头行的日期改为写入指针那个提交的日期（旧：「实现合入当天」，写那个提交时还不知道哪天合入）。开放问题 15 的 A 一支写明键值取 B 的句子（旧：「值为暂定」）。plan 第 7 步标题去掉已定不做的开放问题 14。评审里只改兄弟 spec 的几条不在本分支：它的验收 17 在全新 profile 上断言「三个键都不写」、它的 §点名 缺第一把 key 一项、它 plan 第 11 步的先后与 `Amended by:` 清单、它验收 9 的主机写法。本 spec 只在 plan 的合并清单里记下 `provider-settings.spec.ts` 那一处冲突。2026-10-15 owner 验收（决定在对话里做出，「都按推荐来」，内容见 `Owner` 行）：`Status` 由 `draft` 改 `ready`，正文不动（旧：`Status: draft`；开放问题都已定、尚无代码依赖，就地修订的条件满足）；2026-10-22 实现时修订：① owner 2026-10-22 经问答定 A——结算行（R5，验收 7）与工具行的结果行（R6）要分「改成功」与「改失败」，但工具结果不进 `message_projection`，`session.messages` 里没有 `tool-response` 块，原写的「读本会话的 `session.messages` 取 `isError`」做不到；改为 kernel 的工具结果视图只增 `isError`（live 的 `tool-outcome` 与重画的 `calls[i].outcome` 都带），界面从它取，§对 02 的修补 加第 3 条，「不碰 kernel、contracts」放开这一处（旧：本 spec 不碰 kernel 与 contracts）；② 验收 4 的例子「一次 `file_path` 为 `notes/today.md` 的相对路径 Write」发生不了：02 §内置工具与参数「路径」要求 `file_path` 是绝对路径，相对路径在判定之前就被拒，卡不会出现；规则「工具行的路径与真实路径逐字不同时带真实路径」不变，例子换成会真出现的「工作区经链接」（旧：相对路径的例子；lead 定（已告知 owner））；③ §对 02 的修补 第 1 条「新建实例：带非空 `apiKey` 且新建成功」时写它的第一行：今天的预设与新建流程都不带模型行（新建时 `models: []`），没有第一行就不写；用户给实例加了模型、再存一次 key 时，由 `configureInstance` 那一支照第 1 条写（规则不变，只写明没有行时的读法；lead 定（已告知 owner））；①′ 同日照 ① 改写跟着它的几处正文：§工具调用 的结果行、§结算行 的「成功完成」与「数字从哪读」、不变量 4（契约面另有只增的 `isError`）、不变量 5（数字来自工具结果视图，不再说 tool-response）（旧：这几处都写「tool-response 的 `isError`」「从 `session.messages` 读」）；④ 验收 13「框下那行在 800×520、侧栏展开时也不换行」做不到：用最长的内置厂商名加模型显示名时这一行宽出约 128 px，只剩截断（本条禁止）或折行，改为各段自身不换行不截断、放不下时按钮整组挪到第二行（旧：整行不换行；lead 定（已告知 owner））；2026-10-22 实现完成，`Status: implemented`（plan 第 14 步；实现在分支 `feat/presentation-r1`、PR #55）
Changed by: 05（§审批卡）；05（§结算行）；05（§工具行）

## 背景

2026-10-14 对 Tenon 自己界面的诊断（85 张 e2e 截图，仓库外）里，「差印象」的一大块是机制外露和层层重复，而且多数是已实现 spec 写死的：

- 审批卡：一行五格刻度「只读 可撤销 有快照 不可逆 未知」（03 §卡片与工具行）；「Write 需要你批准」这类内置工具的英文名（`confirm.reason.*` 的 `{toolName}`）；命令卡的原因句「每条命令都先问：在 {cwd} 运行 {command}」把对象行再说一遍；不可逆时刻度高亮「不可逆」，下面再一句「撤不回」。
- 拒绝一次出三层：行下「你拒绝了这个操作」、「已拒绝」加对象、失败卡「你拒绝了 Read，任务已结束。1 个调用确定没发生。」。
- 结算行按 `effect` 计数，Bash 的 effect 暂定为 `external`（02 §内置工具与参数），所以跑过命令就写「有对外发送」；子任务里的改动不计；零也写（「改了 0 个」）。
- 失败卡：401 与 400 的第一行都是「模型服务（anthropic）出错」，括号里是内部 id；步数上限卡把 100 次「读取 <整条路径>」逐条列出；卡宽随内容变。
- 模型菜单每行带主机（02 §模型菜单与输入框「每一行」），连官方地址也写；没配 key 的厂商会是默认，第一次发送就失败，报的是「API 密钥被拒绝」，其实是没填。
- 对话 / 任务是两颗小胶囊，建会话后变成点不动的标签。

这些都在 `implemented` 的 spec 里。只涉及界面文案、布局或组件形态的条款，按第三个例外逐条换；会改变行为的一处（默认模型）走修补。

## 目标与非目标

**目标**

- 审批卡：至多两句 Tenon 自己的人话（为什么停，例行的询问与撤不回的卡不说，开放问题 15；能不能撤），没有刻度、没有内置工具英文名、不重复对象行（网址卡的规范化主机除外：对象行里没有它）；期限写进「允许」钮（「允许（本会话）」，开放问题 17），放行什么、范围、管多久、后果照样写明。
- 答完一行；拒绝一行，不再出失败卡。
- 结算行说真话（运行了 N 条命令、联网 N 次，计入子任务，失败的改动与回读 Tenon 自己落盘的输出不算）；失败卡按错误码说原因、写厂商名不写 id、按对象聚合。
- 模型菜单里，地址是内置厂商官方默认地址的行，主机只在悬停、键盘高亮和「此前的内容会发往」确认里；自定义实例的行与改过地址的行照旧在行内写主机。
- 输入框工具行左簇的「在文件夹里工作」开关，取代两颗胶囊；文件夹 chip 在开关旁边原位出现。
- 新会话默认是有 key 的模型；所选模型用不了时发送钮禁用并说明原因。
- 00 两条已在 `feat/ux-craft` 落地的做法（临时种子、侧栏只画有页面的行）补上条款。

**非目标**

- 不改契约、Tape、IPC 通道与消息形状、提示层，不改权限语义：审批卡与回执的按键、默认焦点、主次按钮、哪个钮放行、确认步骤都不动，授权文字仍写明放行什么、范围、管多久、后果。模型菜单的外发确认与 kernel 的数据去向检查不动，界面上任何一条选模型的路都不绕过它。
- 4d（`docs/features/task-mode-ui`）的东西不做：折叠头、命令子行、改动预览、会话列表、状态点；工具行里的整条路径改短写，随 4d 的工具行一起定（工具行显示的路径与真实路径不同时，文件卡的塌行自会接上真实路径，§答完与拒绝；plan 第 11 步把这一项写进 04 列给 4d 的清单）。
- 「发送与停止在同一位置变形」（components.md「2026-10-15 输入框与原生外壳补记」撤回、留给呈现 spec 的那一处）：开放问题 14 已定 A，本 spec 不做、留给 4d（plan 第 11 步把它写进 04 的 4d 清单）。
- 06 的东西不做：`inspector` 拦截回执的放行入口（04 派给 06 的「F9 的 inspector 回执」）、持久文件夹授权（comp:87 的文件夹授权弹窗，Q21 A）。它们建在本 spec 的一行回执与 chip 浮层之上，由 06 加；本 spec 不预留位置。
- 对话中途转成任务（用户手势、开一个新的任务会话）在阶段 6。
- 04 的沙箱回执、`elevated` 卡文案、「沙箱不可用，将以你的权限运行」那句归 04；本 spec 只定它们在卡上的位置。
- 05 的「能否还原」：快照落地之前，「可以撤回」「有快照」两句不会出现，文案也由 05 定（§审批卡 ④ 表）；结算行的「能否还原」（comp:141）同样由 05 加，本 spec 的 §结算行 不写它（R5 已保留「不写」）。

## 怎么判「只涉及表现」

每条替换都过这五问，全是「不动」才算：

1. `packages/contracts` 的 schema 与路由：不动。渲染端只读已有的 `provider.list`、`session.modelChoice`、`session.facts`、`session.messages`、`mcp.list`、`approval.current`、`config.get` 与已有事件。
2. Tape 的名字、载荷与写入时机：不动。
3. IPC 通道与消息形状：不动。
4. 权限语义：02 §最小审批卡「按键」整条不动（一般卡 ⏎ = 允许、Esc = 拒绝，默认焦点在「允许」；撤不回的卡 ⏎ 与 Esc 都是拒绝，默认焦点在「拒绝」，放行只有点「允许」或焦点在「允许」上按 Space）；「期限」由 `allowScope`、`target.type`、是不是子任务卡决定的规则与期限词不动；`APPROVAL_CLICK_GUARD_MS` 不动。改了措辞的授权文字仍写明那四样。「按键」条款写的是钮上的字（一般卡「拒绝 Esc」「允许 ⏎」，撤不回的卡「拒绝 ⏎ Esc」「允许」），它属权限语义，第三个例外换不了。R13 把期限挪进「允许」钮，靠的是一个读法：那几处「允许」指放行的那个钮和它的按键提示，钮里加上期限词（「允许（本会话） ⏎」「允许（只这一次）」）不改哪个键放行、哪个钮放行、默认焦点在哪。这个读法记在 §对 02 的修补「点名」(d)，单独由开放问题 17 定；owner 2026-10-15 定 A，读法成立，R13 照做（不成立时本不做 R13）。
5. 提示层（系统提示、工具描述、`MODEL_NOTES`）：不碰。

一条里搅着语义的，拆开：语义那半句照旧（下文「保留」），只换措辞、位置或形态。拆不开或要改行为的，不走这里：默认模型那条因此在 §对 02 的修补；模型菜单行上的主机，凡是名字看不出去向的行都照旧（开放问题 4）。

## 替换的条款

每条写：旧 spec 的节与原文（节名 + 引文，不写行号）；保留的部分；新条款在本 spec 哪一节；只涉及表现的理由（上面五问之外要多说一句的才写）；旧 spec 那一行行末要接的指针（`<日期>` 为写入指针那天：实现 PR 里 plan 第 11 步写入这些指针的那个提交的日期；合入要等 CI 与审查，写这个提交时还不知道哪天合入，所以不用合入日，合入晚了也不改；本 spec 顶部 `Amends:`、`Replaces:` 与旧 spec 顶部各行用同一个日期。链接在 00–03 里写 `../../features/presentation-r1/spec.md`，在两份 features spec 里写 `../presentation-r1/spec.md`）。表格行的指针放进该行最后一格、结尾的 `|` 之前，表格才照常渲染。一条 R 引了同一行里的几处时，那一行只接一句指针。

**00-foundation**

- **R1** §UI 最小集「设计令牌」：「值用 §8.1 临时皮肤」。保留：键名分层、亮暗两套、壳层背景独立一层。新条款：§00 的两条。理由：令牌值只管观感。指针：「（<日期> 起由 presentation-r1 §00 的两条 取代：值见 docs/ux/tokens.md 的临时种子）」
- **R2** §国际化「英文更长」：「阶段 0 覆盖侧栏导航项与 Composer（同验收 12）」。保留：两种语言都不换行不截断、Playwright 截图加 DOM 断言、后续界面纳入同一回归。新条款：§00 的两条。理由：哪几行画出来是组件形态；回归规则本身不变。指针：「（<日期> 起由 presentation-r1 §00 的两条 取代：侧栏只画已有页面的行，每行随页面回来时重新计入回归）」

**02-agent-loop**

- **R3** §会话形态 表的「任务」行：「输入框下方有文件夹 chip（裁决 H1、D11）」。保留：工具集与 Read 的判定。新条款：§输入框。指针：「（<日期> 起由 presentation-r1 §输入框 取代：文件夹 chip 在输入框工具行里）」
- **R4** §阶段 2 做的组件 `ToolRow`：「查不到的（MCP 工具）用通用句，带工具名」，与「执行状态不是 completed 的行，按收口来源码查目录写一句」中主会话卡被拒的那一次调用。保留：一行人话、按工具名查目录、展开看纯文本的输入输出、默认不出 JSON；其余收口来源码照旧各写一句，子任务卡被拒照旧；`closure.user-rejected` 键留在目录里（02 验收 37 要它）。新条款：§工具行、§答完与拒绝。理由：映射名 `<serverId>__<name>` 是 Tenon 内部的命名，换成连接器显示名加工具原名只是显示；被拒那一次的收口改由塌行说，Run 照样以 `user-rejected` 结束，调用的收口事实不变。指针：「（<日期> 起由 presentation-r1 §工具行、§答完与拒绝 取代：连接器调用写显示名与工具原名；主会话卡被拒的那次调用不出收口句，塌行就是它的收口）」
- **R5** 同表 `TurnSummaryLine`：「读了 N 个、改了 M 个、有没有对外发送，按各调用的 `effect`（read / write / external）计数」与「没有工具调用的轮不出」。保留：一轮一行、「一轮」的定义、只在 `paused` 以外的码结束时出、不写「能不能还原」。新条款：§结算行。理由：换计数口径与措辞，哪一轮出是形态（改成计数全零的轮不出：只有提问、只有被拦或没做成的调用、子任务什么都没做的轮也不出）；读的是调用的工具结果视图，含 §对 02 的修补 第 3 条只增的 `isError`（子任务的读子会话 `session.messages` 行上的 `calls[i].outcome`）。指针：「（<日期> 起由 presentation-r1 §结算行 取代：按类别计数并计入子任务，计数全零的轮不出）」
- **R6** 同表 `BlockedNotice`：「写三样：拦了什么（有 `facts.target` 写它，否则写工具名）；为什么（查 `blocked.<source>`…）；「已告诉模型」」。保留：四个拦截码各一句、按来源查（`protected` 再按工具分文件的读、文件的写与抓取，`inspector` 照旧按 `facts.category`，`category` 的取值规则不变）、对话形态 Read 的分句规则、02 不给放行入口。新条款：§拦截回执。指针：「（<日期> 起由 presentation-r1 §拦截回执 取代：一行说为什么，不写工具名与「已告诉模型」，protected 按读、写、抓取分句）」（开放问题 8）
- **R7** 同表 `ModeSwitch`：「新会话发出第一条消息之前可在「对话 / 任务」之间切；建立后只显示形态，不能改」。保留：第一条消息之前可切、建立后不能改（`session.selectProfile` 回 `established`），读 `session.facts`、写 `session.selectProfile`。新条款：§输入框。指针：「（<日期> 起由 presentation-r1 §输入框 取代：「在文件夹里工作」开关）」
- **R8** 同表 `FolderChip`：「位于输入框下方」「列出本会话的文件夹」与「点开由主进程弹系统目录选择框」。保留：只在任务形态、浮层列出全部文件夹且第一个标 cwd、没选时「专用文件夹」、文件夹只能经主进程的目录框或预填进列表、预填点确认才生效、每项能移除。新条款：§输入框。理由：位置、chip 上写什么、「点开是列表、列表里的『添加』才弹目录框」是形态；进列表的两条路和预填的确认步骤一字不改。指针：「（<日期> 起由 presentation-r1 §输入框 取代：chip 在工具行开关旁，点开是列出全部文件夹的浮层）」
- **R9** §失败卡与结束原因 第一条：「① 发生了什么：按终态事件…的 `endReason.code` 查目录」、「没有 `endReason` 的 error（不是 Run 的失败）照阶段 1 的 ThreadError 按 `code` 出」中 `auth` 的文案与按钮、「槽位取这个成员的字段（§结束原因词表）」，与「② …已完成的列出来」。保留：三行都不能空、① 按结束码、阶段 1 错误态按 `code` 查目录、槽位只来自这个成员（厂商名、模型名由它的 `providerId`、`modelId` 换算）、② 按 `state` 分写与各句（确定没发生、可能已执行、后续写入未发生）、③ 按下表。新条款：§失败卡。理由：`provider-error` 再按已有的 `errorCode` 分句、厂商与模型写名字（槽位由 `providerId`、`modelId` 经 `provider.list` 换算）、`runEnd.user-rejected` 去掉 `{toolName}`、已完成的按对象聚合，都只是读同一份数据换写法；阶段 1 错误态的 `auth` 换句并加「去设置」，所有结束卡与内容列同宽，是文案与形态。指针：「（<日期> 起由 presentation-r1 §失败卡 取代：provider-error 按 errorCode 分句、已完成的按对象聚合；厂商、模型写名字（由 providerId、modelId 换算）；user-rejected 不带 toolName；阶段 1 错误态的 auth 换句并给「去设置」）」
- **R10** 同节表格行「`user-stopped`、`shutdown-aborted`、`user-rejected`、… | 失败卡 | 中性 | 复制诊断信息」中的 `user-rejected`。保留：其余五个码照旧；「你拒绝就结束本轮」（F2）不变。新条款：§答完与拒绝。理由：出哪个组件是形态；Run 照样以 `user-rejected` 结束。指针（放进该行最后一格）：「（<日期> 起 user-rejected 由 presentation-r1 §答完与拒绝 取代：不出卡，拒绝那一行说本轮结束）」
- **R11** §最小审批卡 ③：「③「为什么停」一句：查 `confirm.reason.<reason>`；`flagged` 查 `confirm.reason.flagged.<category>`」。被换的有两层：查法（句子写什么），与「每张卡都有这一句」（开放问题 15 已定 A：例行的询问与撤不回的卡不出；被否决的 B 只换查法那一层）。保留：按原因选句、不用模型给的文字、槽位只取该原因的必填 `facts` 键（可以一个不用；④ 第 3 条要从 `target.url` 算主机，所以用自己的 `confirm.undo.network.*`，不借原因键）。新条款：§审批卡。理由：网址卡的 ③ 照旧写 `facts.host`（授权管的是这个规范化主机名，对象行只有模型给的原样 URL），只是不再带工具名。指针：「（<日期> 起由 presentation-r1 §审批卡 取代：句子不写工具名、不重复对象（网址卡照旧写主机），例行的询问与撤不回的卡不出这一句）」
- **R12** 同节 ④：「`reversibility === 'irreversible'` 时单独一句「撤不回」」。保留：撤不回的卡有单独一句「撤不回」（措辞不变）。新条款：§审批卡。理由：加的是其余卡的后果句，撤不回那句一字不改。指针：「（<日期> 起由 presentation-r1 §审批卡 取代：每张卡一句后果）」
- **R13** 同节 ⑥：「两个按钮，期限写在「允许」旁」。保留：两个按钮；同节「期限」一条整条不动（期限只由 `allowScope`、`target.type` 与是否子任务卡决定，中英期限词一字不改），那一行不接指针。新条款：§审批卡。理由：期限从钮旁挪进钮里，仍写明范围与管多久；同节「按键」条写的钮上文字靠「点名」(d) 的读法；开放问题 17 已定 A，本条照做（被否决的 B：本条与指针去掉、期限照 02 写在钮旁）。指针：「（<日期> 起由 presentation-r1 §审批卡 取代：期限写进「允许」钮；按键、默认焦点与放行的钮照本节「按键」条不变）」
- **R14** 同节「答完」：「塌成一行：结果、期限、对象」。保留：只有 `allowed`、`denied` 留塌行，其余四种不留；live 与重画的数据来源；转自子会话的卡的塌行只在当场显示（同节「期限」）；重复到达的 `requestId` 忽略；允许的塌行仍写明结果、期限与授权范围（工具行没写的那部分接在塌行里）。新条款：§答完与拒绝。理由：主会话的卡挂在它那一行工具行下，工具行写着模型给的参数；塌行只省掉与它逐字相同的部分。授权范围里有、工具行却没有的照写：命令的 cwd、搜索的后端域名、网址的规范化主机名（授权管「本会话里这个主机名」，工具行只有原样 URL）、文件的真实路径（授权管真实路径，D8；工具行写的是模型给的 `file_path`，可能是相对路径或经过链接，两者逐字不同时接上）。指针：「（<日期> 起由 presentation-r1 §答完与拒绝 取代：主会话的卡塌行不再重复工具行已有的对象，授权范围里工具行没写的照写）」
- **R15** §模型菜单与输入框「分组」：组头文案「去设置填 key」。保留：只列已配置厂商、未配置的只留一行置灰组头、点击打开设置。新条款：§模型菜单。指针：「（<日期> 起由 presentation-r1 §模型菜单 取代：组头文案，地址被拒的另一句）」
- **R16** 同节「每一行」：「第二行是用途句（`purposeKey`）或行标记，后接目标主机，`endpoint.reach` 为 `loopback` 写「本机」，`private`、`public` 写主机名或 IP」中地址是内置厂商声明默认值的行。保留：两行、当前项打勾、第一行模型名、第二行用途句或行标记；自定义实例的行与地址不是声明默认值的内置行照旧后接目标主机，`loopback` 写「本机」。新条款：§模型菜单。理由：主机仍按同一份 `endpoint` 算，只是挪到悬停提示与无障碍描述。地址不是声明默认值的内置行只可能是 Ollama（局域网或改了端口）：智谱、Anthropic 自 custom-vendors Q8 起只认官方源，改指别处读作未配置、带 `refused`，只留置灰组头，不出行。只这样处理的行，厂商名（组头）本身就说明了主机，02 §模型选择「数据去向」的「选 ① 时已在菜单里确认过这个主机」仍成立；自定义实例的名字是用户起的，看不出数据去哪（custom-vendors 的 `displayName`），它声明 `baseURL` 正是为了让主机显示生效，所以照旧写在行内。外发确认与 kernel 的数据去向检查不动。指针：「（<日期> 起由 presentation-r1 §模型菜单 取代：地址是厂商声明默认值的内置行，主机只在悬停与确认里）」
- **R17**（删去：`local-text-only` 的「<主机> · 仅文字对话」照 02 不变，见开放问题 4）
- **R18**（删去：同 R17）
- **R19** §模型选择「数据去向」第一条：「菜单每行显示目标主机」。保留：按当前 baseURL 的主机算、只有回环叫「本机」、Ollama 不写死；自定义实例的行与地址不是声明默认值的行照旧在行内显示；第二、三条（原地确认、key 绑定主机）整条不动。新条款：§模型菜单。理由同 R16：只在悬停里给主机的，只剩厂商名就说明了主机的行，所以「选中即确认」仍成立。指针同 R16。
- **R20** §模型菜单与输入框「提示与禁发」：「禁发并说明原因（components.md:81）只有两种」。保留：两种原因与各自的依据一字不改。新条款：§输入框「发不了的原因」。理由：加第三种原因只是输入框不让点、说为什么，给的出路（「改用」）走菜单的同一套选择与确认，钮上写厂商名与模型名、悬停与无障碍描述写主机，去向和在菜单里选时一样看得到；主进程对缺 key 的发送照旧什么都不写（02「缺 key 什么都不写」），排队项自动发出碰上缺 key 照旧出失败卡（02 验收 22）。02 §主进程与 kernel 的循环接口「缺 key」的缺 key 失败卡从此只从不经发送钮的路到达（排队项自动发出、「继续」），输入框直发到不了它。指针：「（<日期> 起由 presentation-r1 §输入框 取代：加第三种：所选模型用不了）」
- **R21** 验收 34：「菜单每行显示目标主机」与「「去设置填 key」」。保留：回环地址显示「本机」、私网地址显示主机名（这些行都照旧在行内）、确认之前对该主机 0 次请求、「用新模型开新会话」不带旧内容、未配置厂商只留置灰组头。新条款：§验收标准 9。指针：「（<日期> 起由 presentation-r1 验收 9 取代：地址是厂商声明默认值的内置行主机在悬停里；组头文案）」
- **R22** 验收 37：「参数名等于必填键」「失败卡三行都不空」。保留：每个原因、结束码、拦截码、收口来源、行标记、期限、横幅两份 locale 都有文案；穷举 switch；其余各句。换成「参数名都取自必填键或字段（由 `providerId`、`modelId` 换算出的厂商名、模型名，与由 `target.url` 规范化算出的主机，这三个槽位除外；主机只出现在不是原因键的 `confirm.undo.network.url` 与塌行键里，`confirm.reason.*` 的参数名只取该原因的必填 `facts` 键）」「失败卡（`user-rejected` 不出卡）三行都不空」。指针：「（<日期> 起由 presentation-r1 验收 14 取代：参数名取自必填键，厂商名、模型名与非原因键里的规范化主机三个换算槽位除外；失败卡（user-rejected 不出卡）三行都不空）」
- **R31** §模型选择「已配置」：「未配置的厂商在菜单里只留一行置灰的组头「去设置填 key」」中的组头文案。保留：只有「已配置」的厂商可以选、未配置的只留置灰组头、算法照 01 修补 6。新条款：§模型菜单。指针同 R15。
- **R32** §可逆性「记录和展示」末句：「刻度图标在阶段 3 上卡（裁决 E1、H3）」，与 §目标与非目标「完整版界面」中的「可逆性刻度」与「去向：阶段 3、4」。保留：两条的其余各句（三处载荷带这个值、不修补 01、阶段 2 的最小审批卡只用「撤不回」那一句；完整版界面的其余各项与去向）。新条款：§审批卡。理由：这两句是 03 做过、本 spec 去掉的那条刻度（R23）的排期，不接指针就与现状矛盾。指针（两行各接同一句）：「（<日期> 起刻度已由 presentation-r1 §审批卡 去掉）」
- **R35** §结束原因词表 末段：「两份 locale（…）各有 18 条文案、槽位齐全」。保留：同句的「槽位只放事实」「kernel 不产生句子」，每个结束码在两份 locale 里都有文案。新条款：§失败卡、§答完与拒绝。理由：`provider-error` 按 `errorCode` 多出几句、厂商名与模型名由 `providerId`、`modelId` 换算、`runEnd.user-rejected` 不再带 `{toolName}`，三样都只是同一份成员字段换写法（同 R9）；词表本身与 kernel 给的事实一字不改。指针：「（<日期> 起由 presentation-r1 §失败卡 取代：provider-error 再按 errorCode 各一句；参数取自成员字段，厂商名、模型名由 id 换算，user-rejected 不带 toolName）」

**03-mcp-host**

- **R23** §卡片与工具行「可逆性刻度上卡」整条。保留：「撤不回」那句照旧（即 R12 的保留）。新条款：§审批卡。理由：刻度只是显示，`card.reversibility` 照读。指针：「（<日期> 起由 presentation-r1 §审批卡 取代：去掉五格刻度，改为一句后果）」
- **R24** 同节「ToolRow 副作用段与可逆性标记」整条。保留：`reversibility` 照取工具结果视图；标记有屏读文字。类别改按工具名分（与 §结算行 同一张表），不再读 `effect`。03 §推出的读法 42「工具结果视图只增 `reversibility`，供副作用段与可逆性标记用」是契约读法：字段照旧在、照旧供展开那一行的 ④ 与标记用，那一行不接指针。新条款：§工具行。指针：「（<日期> 起由 presentation-r1 §工具行 取代：展开后一行说做了什么、能不能撤；标记只给撤不回的行）」（开放问题 8、9）
- **R25** 验收 45：「审批卡的可逆性刻度按 `reversibility` 高亮」与「工具行展开有副作用段、写和对外发送的行有可逆性标记」。保留：连接器卡的显示名与「定义已变」、`connector-unauthorized` 的「重新登录」。新条款：§验收标准 1、6。指针：「（<日期> 起由 presentation-r1 验收 1、6 取代：审批卡没有刻度；工具行展开后一行写做了哪类事与能不能撤，标记只给撤不回的行）」

**custom-vendors**

- **R26** §对 02 的修补 第 1 条 `model.mark.probed` 的文案「本机探测 · 不保证 · {host}」（及英文 "Probed on this computer · not guaranteed · {host}"）中的「本机探测」。保留：`modelMarkSchema` 只增 `probed`、两个键名、`{host}` 照旧在句末、`model.mark.unprobed` 一字不改。新条款：§模型菜单。理由：菜单里「本机」专指回环（「本机 · 仅文字对话」，悬停「留在这台电脑上」），「本机探测」会被读成「本机的模型」。指针：「（<日期> 起由 presentation-r1 §模型菜单 取代：probed 的文案改「探测通过 · 不保证 · {host}」）」
- **R27**（删去：实例行照旧在行内写主机，custom-vendors 验收 20 不换，见 R16 的理由）
- **R28** 验收 25：「失败卡与菜单显示 §实例被删或改坏 的文案」中「新消息」那一半。保留：新消息不发出、不写事实；续跑以 provider 错误结束、不换模型、失败卡用 `error.customVendorGone`；菜单触发器写「（已删除）」；删掉默认实例后新会话照常可发。新条款：§输入框「发不了的原因」。理由：新消息现在在输入框就被拦下、说同一个原因，主进程的拒绝不变。指针：「（<日期> 起由 presentation-r1 §输入框 取代：新消息在输入框说明已删除、不出失败卡）」
- **R33** §目标 第 2 条「标「本机探测 · 不保证」」与验收 19「通过的行标「本机探测 · 不保证」」。保留：两处的其余各句（探测两步、两种形态带工具、`capabilitySource`、没通过的行与置灰）。新条款：§模型菜单。理由同 R26。指针（两行各接同一句）：「（<日期> 起由 presentation-r1 §模型菜单 取代：标记改「探测通过 · 不保证」）」。§裁决索引 Q6 那一行是裁决记录，不接。
- **R34** §探测「结果与原因码」表的通过一行（`customVendor.probe.passed`）：「本机探测通过 · 不保证」/ "Probed on this computer · not guaranteed"。保留：三态、键名、其余各行与原因码。新条款：§模型菜单（设置卡与菜单用同一个说法）。理由同 R26：同一件事在设置卡写「本机探测通过」、菜单写「探测通过」会是两种叫法。指针（放进该行最后一格）：「（<日期> 起由 presentation-r1 §模型菜单 取代：改「探测通过 · 不保证」）」

**model-display-names**

- **R29** §对 02 的修补 末段：「第二行（用途句或行标记，后接目标主机）不变」。保留：第一行与 chip 写显示名、设置卡下拉的写法；自定义实例与改过地址的行第二行照旧带主机。新条款：§模型菜单。指针：「（<日期> 起由 presentation-r1 §模型菜单 取代：地址是厂商声明默认值的内置行第二行不再带主机）」
- **R30** 验收 3：「第二行仍有主机」。保留：其余各句。新条款：§验收标准 9。指针：「（<日期> 起由 presentation-r1 验收 9 取代：官方地址的行主机在悬停里）」

## 新条款

文案给出中文与英文的意思；定稿的键在 plan。所有新句子都是界面文案：一行、不截断；里面嵌的路径、命令、主机、模型 id、文件夹名是内容，可折行、不截断（02 §调用的键与读写的数据）。

### 审批卡

从上到下：① 问题式标题（不变）；② 对象一行（不变，02 E4 与 ②′）；连接器卡的显示名与「定义已变」那句（不变，03）；③ 为什么停；04 的「沙箱不可用，将以你的权限运行」（有 `facts.sandbox` 时，文案归 04）；④ 能不能撤；⑤ 改动（不变）；⑥ 按钮。没有刻度。

③ 为什么停，按 `reason`（必要时再按 `kind` 或 `target.type`）一句。不写内置工具名，不写对象行里已有的路径、命令、网址、搜索词与主机。两处例外：`elevated` 的文案归 04，04 §界面 定的句子后面跟完整命令，本 spec 不改（见 §与 04 第三段的先后）；网址卡写规范化的主机名（02 §审批、授权与费用：WHATWG `URL.hostname`，小写、punycode，去掉末尾的一个点），因为「允许」管的是本会话里这个主机名，而对象行只有模型给的原样 URL，看起来是一个域名的 URL（`https://аpple.com/…` 里的西里尔 а、`https://evil.com\.good.com`）授权可能落在别的主机上。例行的询问（`default`、`command`）标题已经在问，没有别的原因可说，不出 ③；撤不回的卡（`irreversible`）也不出：原因由 ④ 的「撤不回。」说，期限由钮说，而「每次都问」不是一句能保证的话（策略的 `release-irreversible`、连接器的总是允许、阶段 6 的任务授权都能免掉这一问）。这三类按开放问题 15 A（已定）不出；表里括号中是被否决的 B 的句子，留作记录。三类的键都留在目录里（02 验收 37 与本 spec 验收 14 要每个原因都有文案）、不渲染，值取表里 B 的句子：`confirm.reason.default` 取「其余」那句，`confirm.reason.command` 取 `command` 那句，`confirm.reason.irreversible.<kind>` 都取 `irreversible` 那句（plan 第 1 步），目录里不再留带 `{toolName}` 或重复对象的旧句：

| 原因 | 中文 | 英文意思 |
|---|---|---|
| `default`，文件 | 不出（B：改文件前要你同意。） | (B: Changing a file needs your OK.) |
| `default`，连接器 | 不出（B：连接器做事前要你同意。） | (B: A connector action needs your OK.) |
| `default`，其余（02 不产出） | 不出（B：这一步要你同意。） | (B: This step needs your OK.) |
| `command` | 不出（B：运行命令前要你同意。） | (B: Running a command needs your OK.) |
| `outside-workspace` | 它不在这个任务的文件夹里。 | It is outside this task's folders. |
| `network`，搜索 | 搜索词会发到这台电脑之外。 | The search words leave this computer. |
| `network`，网址与其余 | 网址会发给 {host}。（槽位取必填的 `facts.host`） | The address is sent to {host}. |
| `elevated` | 照 04 §界面（本 spec 不定） | — |
| `policy` | 你的组织要求这一步先经你同意。 | Your organization asks for your OK on this step. |
| `flagged`，`exfiltration` | 这次请求可能把你的数据带到别处。 | This request might take your data elsewhere. |
| `flagged`，`inspector-failed` | Tenon 没能确认这一步是否安全。 | Tenon couldn't check that this step is safe. |
| `interaction-required` | 这个连接器要求你亲自确认。 | This connector wants you to confirm it yourself. |
| `irreversible` | 不出（B：做了就撤不回，所以先问你。） | (B: This can't be undone, so Tenon asks first.) |

④ 能不能撤，一句，自上而下取第一条成立的：

1. 可逆性为 `irreversible`（不论原因）：02 的原句「撤不回。」，红色。
2. `kind` 为 `network`，③ 是 `network` 的两句之一或 `flagged`/`exfiltration` 那句：不出，③ 已说了后果。
3. `kind` 为 `network`，③ 是别的原因（`policy`、`flagged`/`inspector-failed`）：出联网的后果句，文字与 ③ 的 `network` 两句相同（搜索「搜索词会发到这台电脑之外。」，网址「网址会发给 <主机>。」），但用自己的键 `confirm.undo.network.search`、`confirm.undo.network.url`，不借原因键：这些原因的必填 `facts` 里没有 `host`，而原因句的槽位只取该原因的必填 `facts` 键（00 §HostAdapter 不变量「界面文案的槽位只取必填键」，R11 保留）。`confirm.undo.network.url` 的 `{host}` 和对象行一样取自 `card.target`（02 的 `confirm.cwd` 也是这样取 `target.cwd`）：由渲染端从 `target.url` 照 02 §审批、授权与费用 的同一规范化算出（这些卡只放行这一次，主机是为了说清后果）。不出 `unknown` 那句。
4. 其余按 `reversibility`：

| 可逆性 | 中文 | 英文意思 |
|---|---|---|
| `read-only` | 只读，不会改动任何东西。 | Read only: nothing changes. |
| `revertible` | 照 05（本 spec 不定） | — |
| `snapshotted` | 照 05（本 spec 不定） | — |
| `unknown`，文件（Write、Edit） | Tenon 没法替你撤回这次改动。 | Tenon can't undo this change for you. |
| `unknown`，其余 | 如果它改了东西，Tenon 没法替你撤回。 | If this changes anything, Tenon can't undo it. |

`unknown` 的意思是「不知道」：连接器工具一律是它（reversibility.ts 对非内置工具直接回 `unknown`），命令里除命中模式表的也都是它，所以查询类连接器与 `ls` 的卡上不能写成「这一步一定会改东西」；写入与编辑一定改文件，用直说的那句。`revertible`、`snapshotted` 在快照落地之前不会出现；两份 locale 里先放 plan 给的暂定值让文案覆盖测试能穷举，05 定稿时改值，不算替换本条。

⑥ 两个钮：「拒绝」与「允许（<期限>）」。期限词照 02 §最小审批卡「期限」的映射，中英一字不改（只这一次 / 本会话 / 本会话里这个域名 / 本次子任务 / 本次子任务里这个域名；Just this once / This session / This domain, this session / This subtask / This domain, this subtask），英文钮写成 "Allow (Just this once)"。按键提示照旧挂在钮上：一般卡「拒绝 Esc」「允许（本会话） ⏎」，撤不回的卡「拒绝 ⏎ Esc」「允许（只这一次）」。按键、默认焦点、主次与点击防抖照 02，不动。钮一行右对齐，不折行。钮上文字靠 §对 02 的修补「点名」(d) 的读法（开放问题 17 A，owner 2026-10-15 确认；被否决的 B 不做本段，钮照 02 是「拒绝」「允许」，期限写在「允许」旁）。

于是每张卡都写明：放行什么（标题加对象）、范围与管多久（「允许」钮里；`network` 原因的网址卡授权落在主机名上，主机在 ③ 里；④ 第 3 条的网址卡主机在 ④ 里）、后果（④；网络卡是 ③ 或 ④ 里的联网句）。`flagged`/`exfiltration` 的网址卡（02 只给 WebFetch 出）只放行这一次，不生成也不扩大主机名授权（02 §内置工具的默认档位 的 WebFetch 行），后果由 ③ 说，卡上不另写主机（开放问题 7 A 定它不出 ④）；允许之后的塌行照 §答完与拒绝 写出规范化主机。

### 答完与拒绝

- **允许**：塌成一行「已允许（<期限>）」/ "Allowed (<scope>)"。主会话的卡（`callKey === anchorCallKey`）挂在它那一行工具行下，工具行已写出的对象不再重复；授权范围里有、工具行却没写的那一段接在后面：
  - 命令卡接 cwd（「已允许（本会话） · 位于 <cwd>」，同 `confirm.cwd`）。
  - 搜索卡接后端域名（「已允许（本会话） · 发往 <域名>」/ "Allowed (This session) · sent to <host>"）。
  - 网址卡接规范化的主机名（「已允许（本会话里这个域名） · 发往 <主机>」）：live 取 `card.facts.host`，没有时（`policy`、`flagged` 的卡）与重画时都从 `target.url` 照 02 §审批、授权与费用 的同一规范化算出。工具行只有原样 URL，授权落在哪个主机名上要在这里写出来。
  - 文件卡在工具行那一句显示的路径（今天是模型给的 `input.file_path`）与 `target.path`（真实路径，D8）逐字不同时，接「 · <真实路径>」；相同时不接。相对路径、经过链接的路径都会不同。4d 把工具行的路径改成短写之后，这条比较自然让文件卡带上真实路径。
  - 连接器卡不接（工具行写着连接器显示名与工具原名，授权就是这一次调用）。
  - 子任务转上来的卡挂在父会话的 Agent 行下，塌行仍带对象行。
- **拒绝**：主会话的卡塌成一行「已拒绝 · 这一轮到此为止」/ "Denied · this round stops here"；这一行就是拒绝的全部反馈：那一行下不再出收口句「你拒绝了这个操作」，Run 以 `user-rejected` 结束时不出失败卡。同批排在后面的调用照旧各自一行「未执行」。子任务卡被拒只拒这一次（F2），塌成「已拒绝」加对象行，不写「这一轮到此为止」。
- 主会话卡的塌行重启后从 `calls` 重画；子任务卡的塌行照 02 只在当场显示，重启后不重画。
- 本轮已有完成的调用时，结算行照 §结算行 出。
- `runEnd.user-rejected` 与 `closure.user-rejected` 的文案留在目录里（02 验收 37 要每个结束码、每个收口来源有文案），前者去掉 `{toolName}`：「你拒绝了，这一轮到此为止。」。

### 拦截回执

（开放问题 8 已定 A：纳入。）02 的四个拦截码，回执是一行琥珀色的「为什么」，不写内置工具名、不重复上面那一行的对象、不写「已告诉模型」（04 对沙箱回执的同一规矩）：

| 来源 | 中文 | 英文意思 |
|---|---|---|
| `policy` | 你的组织不允许这一步。 | Your organization doesn't allow this step. |
| `user-disabled` | 你在设置里关掉了它。 | You turned this off in Settings. |
| `protected`，读文件（Read、Glob、Grep） | 这个位置受保护，Tenon 不读它。 | This location is protected; Tenon doesn't read it. |
| `protected`，改文件（Write、Edit） | 这个位置受保护，Tenon 不改它。 | This location is protected; Tenon doesn't change it. |
| `protected`，WebFetch | Tenon 只抓取公网上的网页，这个地址不在其中。 | Tenon only fetches public web pages; this isn't one. |
| 对话里的 Read（`blocked.chatReadScope`） | 对话里只能打开 Tenon 为这个对话保存的文件。 | In a chat, only files Tenon saved for this chat can be opened. |
| `inspector`，`exfiltration` | 这一步可能把你的数据带到别处，已拦下。 | This step might take your data elsewhere, so it was stopped. |
| `inspector`，`inspector-failed` | Tenon 没能确认这一步是否安全，已拦下。 | Tenon couldn't check that this step is safe, so it was stopped. |

读、写分句是因为 Tenon 为会话保存的文件（own-spill）只读放行、写入才拦；抓取那句覆盖 `isBlockedFetchUrl` 拦的全部情形（本机与内网地址、非 http(s)、带用户名密码、单段主机名、解析不了）。有 `sandbox` 成员的调用照 04 §回执上有什么，不走这张表。

### 工具行

- 连接器调用的那一句：「使用 <连接器显示名> 的 <工具原名>」/ "Use <tool> from <connector>"。显示名取 `mcp.list`，原名按 `mcp.list` 里同一台的原名与映射名对上；对不上（连接器已删、名字被截断）时退回映射名。
- 展开后，「输入」「输出」之后一行（不再有「副作用」小标题）：做了哪类事 + ④。按工具名分类，和 §结算行 同一张表：改了这个文件（Write、Edit）/ 运行了这条命令（Bash）/ 联网（WebSearch、WebFetch）/ 用了连接器（连接器工具）。接的 ④ 按这次调用的 `reversibility` 照 §审批卡 ④ 的表（撤不回为「撤不回。」）；联网类只写「联网」，不接 ④（同卡：联网本身就是后果）。例：「运行了这条命令 · 如果它改了东西，Tenon 没法替你撤回。」「改了这个文件 · Tenon 没法替你撤回这次改动。」
- 不出这一行的：读文件与查找（只读）、Agent、AskUserQuestion、`state` 不是 `completed` 的调用（收口句已说了它的结局）。「改了这个文件」另要工具结果视图的 `isError === false`（§对 02 的修补 第 3 条：live 的 `tool-outcome` 与重画的 `calls[i].outcome` 都带）；出错的 Write、Edit 不出这一行。
- 收起时的标记：只给可逆性为 `irreversible` 的行（开放问题 9），图标旁有悬停提示「撤不回」，屏读文字同一句。

### 结算行

一轮一行，按类别计数，零项不写，类别之间用「 · 」：

| 类别 | 算哪些调用 | 中文 | 英文意思 |
|---|---|---|---|
| 读文件 | Read，成功完成的，按不同路径数 | 读了 N 个文件 | Read N files |
| 查找 | Glob、Grep，成功完成的，按次数 | 查找 N 次 | Searched files N times |
| 改文件 | Write、Edit，成功完成的，按不同路径数 | 改了 N 个文件 | Changed N files |
| 命令 | Bash，派发过的，按次数 | 运行了 N 条命令 | Ran N commands |
| 联网 | WebSearch、WebFetch，派发过的，按次数 | 联网 N 次 | Went online N times |
| 连接器 | 连接器工具，派发过的，按次数 | 用了连接器 N 次 | Used connectors N times |

- 「成功完成」= `state === 'completed'` 且工具结果视图的 `isError === false`；「派发过」= `state` 不是 `not-run`。被拦、被拒、没派发的都不算；一次 `old_string` 没找到的 Edit、停在半途的写入都不算「改了」。
- 读文件、查找两类不算结果视图里 `permission.code === 'own-output-read'` 的调用：那是模型回读 Tenon 自己落盘的工具输出（对话形态里 Read 只能读它，02 验收 29），用户没给过文件，算进去就是又一处机制外露。摘要码已在结果视图里，不加字段。
- 数字取各调用的工具结果视图（含 `isError`，§对 02 的修补 第 3 条：live 用 `tool-outcome`，重画用 `session.messages` 行上的 `calls[i].outcome`）；AskUserQuestion 不算；Agent 调用本身不算，它的子会话里的调用按同样的类别与条件并进来（读子会话的 `session.messages`，子会话 id 取 `handoff.childSessionId`），不另标子任务（开放问题 11）。
- 计数全零的轮不出这一行（R5：替换 02「没有工具调用的轮不出」）。
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

- 第二行：地址是内置厂商声明的默认地址的行（不是自定义实例，且 `provider.list` 条目里 `baseURL` 键的 `default` 的主机与 `endpoint.host` 相同），只写用途句或行标记，不带主机。其余行照 02 后接「 · <主机>」（`loopback` 写「本机」）：自定义实例的行（条目带 `displayName`；实例的 `baseURL` 默认值就是它自己的地址，所以不能用上一句的比法判）、地址改过的内置行（只可能是 Ollama：局域网或改了端口的 Ollama；智谱、Anthropic 自 custom-vendors Q8 起只认官方源，改指别处读作未配置、带 `refused`，只留置灰组头，不出行）。这些行只看名字猜不出数据去哪（开放问题 4）。
- 行标记的文案：`local-text-only` 照 02「<主机> · 仅文字对话」，回环即「本机 · 仅文字对话」，不分是不是默认地址；手填的表外模型（`unverified-text-only`）在官方地址的行上写「未验证 · 仅文字对话」，在其余行上照旧接主机；实例的 `model.mark.unprobed` 不变；`model.mark.probed` 改为「探测通过 · 不保证 · <主机>」/ "Probe passed · not guaranteed · <host>"（R26）；设置卡上探测结果的通过一句（`customVendor.probe.passed`）同改「探测通过 · 不保证」/ "Probe passed · not guaranteed"（R34）。
- 鼠标悬停或键盘高亮一行时显示「发往 <主机>」/ "Sends to <host>"，回环写「留在这台电脑上」/ "Stays on this computer"；同一句一直挂在行的无障碍描述上，行内已有主机的行也一样。
- 「此前的内容会发往 <主机>」的确认页、「用新模型开新会话」、kernel 的数据去向检查都不动。
- 未配置厂商的组头：「<厂商> · 去设置填 API 密钥」/ "<provider> · Add an API key in Settings"；条目带 `refused`（地址被拒）时写「<厂商> · 地址用不了，去设置改」/ "<provider> · Its address can't be used; fix it in Settings"。点击照旧打开设置。
- 仅文字对话的行在任务形态置灰的原因（`model.row.textOnlyInTask`）改说开关：「在文件夹里工作需要能用工具的模型」/ "Working in a folder needs a model that can use tools"。02 只写了「置灰并写明原因」，没定文字，这里不替换条款。

### 输入框

- **「在文件夹里工作」开关**：工具行左簇（`ComposerLead`）的一个 `Switch`，标签「在文件夹里工作」/ "Work in a folder"。关 = 对话，开 = 任务，经 `session.selectProfile` 写。只在会话建立之前出现；发出第一条消息之后不再显示（开放问题 5），任务会话靠文件夹 chip 认出来。对话 / 任务两个名字照 02 §会话形态，侧栏等别处照旧。
- **文件夹 chip**：开关打开时出现在开关右边，同一行。没选时写「专用文件夹」。选了文件夹时 chip 上的名字按开放问题 16 A（已定）：只有一个文件夹时写它的完整名字（最后一段），占左簇剩下的宽度，放不下时在 chip 内折行、不省略（工具行只在这种情形下变高，照 owner 2026-10-15 在 PR #46 验收的「长文件夹名完整显示、折行」）；多于一个时写「<第一个> +N」，第一个的名字同样可折行（被否决的 B：放不下时改写「N 个文件夹」，名字只在悬停里）。悬停提示与无障碍名是完整路径。点开是一个浮层：每个文件夹一行完整路径（可折行），第一个标「命令在这里运行」，选来的每项可移除；「添加文件夹…」由主进程弹系统目录框；没选文件夹时一句「没选文件夹时，命令在 Tenon 为这个任务单独建的文件夹里运行。」
- **上次的文件夹（预填）**：有没确认的预填时，浮层里先逐行列出这些文件夹的完整路径（可折行），标「上次用过，尚未加入」，下面是确认项「用这 N 个文件夹」，点它就是 02 §工作区 的确认；点之前它们不进列表（确认等于把它们加进工作区，其中的读与查找此后不再询问，所以确认之前要看得到记录本身）。打开「在文件夹里工作」时若有没确认的预填，浮层自动展开，最常见的「接着在上次的文件夹里干」不用先想到去点 chip；焦点留在开关上，不移到确认项（落在确认项上，一次 ⏎ 就把文件夹加进工作区，那是改确认步骤，第三个例外不碰）。
- 框下只剩一行淡字（免责 / 发送会取消待批的操作 / 发不了的原因），不再给文件夹留一行。开关开合、chip 出现消失，框和淡字行都不挪。
- **仅文字模型的禁发句**（02 的第二种原因，句子改说开关；02 只写了「说明原因」，没定文字）：会话建立之前「这个模型不能用工具。换一个模型，或关掉「在文件夹里工作」。」/ "This model can't use tools. Pick another, or turn off Work in a folder."；建立之后（开关已不在）「这个模型不能用工具，请换一个。」/ "This model can't use tools. Pick another one."。框下这一行在 800×520、侧栏展开时只有约 488px 宽（800 − 侧栏 264 − 两侧 24），字号 12px，所以框下的句子都不写模型名与厂商名（模型 chip 已写着模型），英文控制在 70 个字符左右（验收 13）。
- **发不了的原因**（R20 的第三种；与前两种同一行、同一套禁用）。先定一个口径：**有 key 的厂商** = `provider.list` 条目 `configured` 为 true，并且下面两条满足一条：`configKeys` 里至少一个 `secret` 键 `configured`；条目带 `displayName`（自定义实例）。`configured` 是先决条件：地址被拒的实例、缺 key 的公网实例 `configured` 都是 false，不算。Ollama 的两个键都不是机密、都有默认值，永远读作「已配置」，但不算有 key（开放问题 3）。按下表自上而下取第一条成立的：

| 情形 | 中文 | 英文意思 | 动作 |
|---|---|---|---|
| 会话用的实例或它那一行已删（M6 的「已删除」判法） | 这个会话用的自定义厂商或模型已删除。 | This chat's custom provider or model was removed. | 改用 <X> |
| 生效的选择（`session.modelChoice`）的厂商带 `refused` | 这个模型的地址用不了。 | This model's address can't be used. | 改用 <X>；去设置 |
| 生效的选择的厂商 `configured: false`，且没有一个有 key 的厂商 | 这个模型没有可用的 API 密钥。 | No API key for this model. | 去设置 |
| 生效的选择的厂商 `configured: false` | 同上一行 | 同上一行 | 改用 <X>；去设置 |

  第三行只陈述所选模型的事实，不说「填了 key 才能发」：本机在跑 Ollama 时，对话形态在菜单里选它不要 key 也能发。
  <X> 是按 `provider.list` 顺序第一个有 key 的厂商的第一行 `listing: 'main'`；任务形态只取能发工具的行（`verified`、`probed`）；没有这样的行就不给「改用」（开放问题 3）。所以全新安装时只给「去设置」，不会把人引到 Ollama。钮上写「改用 <厂商> <模型>」/ "Switch to <provider> <model>"：厂商取 `provider.list` 条目 `nameKey` 的文案（实例取 `displayName`），模型写显示名（同模型 chip 的写法）；钮的悬停提示与无障碍描述是「发往 <主机>」（回环写「留在这台电脑上」，同 §模型菜单 的提示）。名字是内容，放不下时折行、不截断。
  **「改用 <X>」不让 X 的主机还没出现过就写 ①**：
  - X 那一行在菜单里行内写主机（`rowHostInLine(X)` 为真：自定义实例的行、地址不是声明默认值的 Ollama 行）：点「改用」打开模型菜单并键盘高亮 X 那一行（行内的主机与「发往 <主机>」提示都在），不直接选；用户在菜单里选它，照菜单的规则走，要确认的情形出确认页。理由同 R16：实例的名字是用户起的，看不出数据发往哪里；直接选会让「选 ① 时已在菜单里确认过这个主机」不成立，此后 kernel 也不再检查。
  - 其余的行（官方地址的内置行：钮上的厂商名就说明了主机，悬停与无障碍描述另写着它；有历史的会话从公网 A 换到公网 B 不出确认、直接写 ①，用户看到的去向就是钮上这个厂商名）先按菜单的规则判数据去向：用 `session.facts.lastEndpoint` 与 X 所在条目的 `endpoint` 比，凡是菜单会出「此前的内容会发往 <主机>」确认页的情形（会话有历史、目标从回环或私网变成公网，02 §模型选择「数据去向」），改为打开模型菜单并停在 X 的确认页（照旧有「切换」「用新模型开新会话」），不直接调 `session.selectModel`；确认之前对 X 的主机 0 次请求、不写选择事实。只有新会话（还没有历史），或比较结果不需要确认时，才直接选，等于在菜单里选这一行（`session.selectModel`，照 02 一起写默认）。
  禁用时 ⏎ 与 Cmd/Ctrl+Enter 都不发，0 次 `chat.send` / `chat.sendNow`。任何设置弹窗（模型菜单里的、框下「去设置」打开的、账号菜单打开的）关上时，与窗口重新拿到焦点时，同时重读 `provider.list` 与 `session.modelChoice`，chip、禁发行与菜单用同一份；读不到时不因此禁用。

### 00 的两条

- **R1 设计令牌的值**：值见 [docs/ux/tokens.md](../../ux/tokens.md)：2026-10-15 起是该文「2026-10-15 临时换装记录」的三个临时种子与由它们派生的值，§8.1 的赤陶奶油只作历史记录；定稿照主参考 §8.3。
- **R2 侧栏与双语回归**：侧栏只画已有页面的行（2026-10-15 起只有「新对话」），项目、产物、定时任务、技能与连接器四行随各自的页面回来，回来时重新计入双语「不换行不截断」回归（`shell-i18n.spec.ts` 的 `NAV_ITEM_COUNT`）。四个文案键保留。

## 对 02 的修补（M5）

1. **第一把 key 定新会话默认**（主进程：`provider.configure`，含实例分支 `configureInstance`；`customVendor.create`）：一次保存成功后（新建实例：带非空 `apiKey` 且新建成功），若 config.json 的 `defaultModelByProfile.chat`、`defaultModelByProfile.cowork`、`provider` 三者都没有值，本构建没有 ④（开发构建的 `TENON_PROVIDER` / `TENON_MODEL`），且这次保存写下了它的一把非空的机密键（`secret: true`；实例是 `apiKey`）、之后按 01 修补 6 的算法读作「已配置」（用这次写入的值与锁里读到的 config 算，不另读钥匙串），就在同一把 profile 锁里写：
   - `defaultModelByProfile.chat` 写成它 `listing: 'main'` 的第一行（今天 Anthropic 是 `claude-opus-5-5`、智谱是 `glm-5.3`）。写法按构建里有没有 claude-5-5-models 的指针分两种；owner 2026-10-15 定「内置默认跟随家族的最新一行」，指针的形状、解析与「谁写指针」归那份 spec §跟随最新，本条只定第一把 key 这一处写什么：
     - **有**：`providerSelectionSchema`（`packages/contracts/src/ipc/config.ts`）已有那份 spec 加的可选成员 `latestOf`，且第一行带 `family`（内置的 anthropic、智谱）：写指针 `{ id, modelId: <第一行的 id>, latestOf: <第一行的 family> }`，照那份 spec §跟随最新「谁写指针」的「第一把 key」。Anthropic 写 `{ id: 'anthropic', modelId: 'claude-opus-5-5', latestOf: 'opus' }`，智谱写 `{ id: 'zhipu', modelId: 'glm-5.3', latestOf: 'glm' }`。`modelId` 仍是那一行的 id，不认识 `latestOf` 的旧构建把它读成钉住的这一行。
     - **没有**（那份 spec 还没实现），或第一行不带 `family`（自定义实例的行）：写 `{ id, modelId: <第一行的 id> }`，钉住这一行。内置厂商的第一行今天就是本家族最新的一行；那份 spec 实现之前写下的值，按它 §跟随最新「迁移」留作钉住。
     - 哪一种由实现（或 rebase）时 `dev` 上的 schema 决定；本 spec 先实现时只做「没有」一支，「有」一支由后合入的 claude-5-5-models 补上（它 plan 第 11 步「已实现」一支）。那是在实现本条已写的规则，不改本条（plan「与 claude-5-5-models 的先后」）。
     下一条写 `.cowork` 与 `provider` 时用同一个值（指针或钉住的一样）。
   - 那一行能发工具（`verified` 或 `probed`）时，`defaultModelByProfile.cowork` 与 `provider` 也写成它；不能发工具时这两个都不写。`provider` 是五层解析的 ③，任务形态的 ② 空着时会落到它（02 §对 01-provider-and-tape 的修补 第 6 小节「五层解析」），写了它就等于把任务形态默认到一行仅文字的模型。新建的实例各行还没探测，所以只写 `.chat`；任务形态照五层落到 ④⑤，所选模型用不了时输入框照 §输入框「发不了的原因」说明。
   - 不写 `source`。其余情况一概不写（保存 Ollama 的地址不会触发：它没有机密键；不填 key 的回环实例也不会）。五层解析、`resolveChoice` 不读密钥、`session.selectModel` 的写法都不动。
   - 写在哪一次 config 写入里：`provider.configure` 的内置厂商，在保存成功之后另写一次；`configureInstance` 照 custom-vendors「先写 config.json、再写钥匙串」，钥匙串写成功之后另写一次；`customVendor.create` 照「写 key → 写 config.json 加条目」，并进加条目的那一次写入。
   - 只增：在原来什么都不写的一种情形里加一次写入，不改任何既有成员的形状，config 键都是 01、02 已立的，写进去的值是已有形状的行 id，或带 `latestOf` 的指针；`latestOf` 是 claude-5-5-models 给 `providerSelectionSchema` 加的成员，不是本 spec 加的。
   - 失败行为：另写的那一次失败不影响 key 的保存结果（key 已在钥匙串、`provider.configure` 照旧回 `ok`），日志记一行，不带 key。新建实例时它与加条目是同一次写入，失败照 custom-vendors 的新建规则整次失败、删回 key，没有新的失败情形。
3. **工具结果视图只增 `isError`**（owner 2026-10-22 定，Revisions ①）：kernel 的 `ToolOutcomeView`（packages/kernel/src/loop/events.ts）与 contracts 的 `toolOutcomeViewShape` 只增 `isError?: boolean`，取这次调用 `tool/result` 的 `isError`；live 的 `tool-outcome` 事件与重画用的 `calls[i].outcome` 都带，没有结果的（未派发、收口前）不带。只增：不改既有成员，也不改 Tape 事实（`ToolResultPayload.isError` 02 已有）。界面的结算行与结果行只从这里取「是否出错」，不再另读 `session.messages`。
2. **点名**（不属纯粹只增，owner 2026-10-15 已确认）。(a)–(c)、(e) 由开放问题 2 定（照推荐、未否决）：第 1 条在三键都空时不改下拉也写，这几处之后读作「三键都空时除外」，正文不改。(d) 由开放问题 17 定（A）。
   - (a) 02 §模型选择「设置卡」：「保存时只有用户改过这个下拉才写」；§模型菜单与输入框「设置卡」：「只有改动过这个下拉，保存时才写」。
   - (b) 02 验收 33：「设置卡只在改过下拉时才写键」。原用例（plan 第 9 步）加一句前提「三键已有值」照旧通过。
   - (c) 01 §desktop 接线 `provider.configure`：「机密进 keychain，其余进 `config.json`」「对 `providerConfig[id]` 逐键合并」。读作：另在三键都空、存下第一把机密键时写 `provider` 与 `defaultModelByProfile` 两个已有的键，`providerConfig` 的合并规则不变。
   - (d) 02 §最小审批卡「按键」：一般的卡「拒绝 Esc」「允许 ⏎」，撤不回的卡「按钮是「拒绝 ⏎ Esc」「允许」」。读作：「允许」指放行的那个钮，钮上带期限词（「允许（本会话） ⏎」「允许（只这一次）」，§审批卡 ⑥）；键、默认焦点、哪个钮放行、Space 与点击都不变，正文不改。这不是第 1 条的修补，是 R13 要用的读法：按键条属权限语义，第三个例外换不了，所以单独点名。
   - (e) custom-vendors §写入规则「新建」：「校验地址（预设按 §IPC 从 presets.ts 取）→ 铸 id → 写 key（有的话）→ 写 config.json 加条目」；「保存实例的 key」：「先写 config.json，把该实例每行的 `probe` 清掉，再写钥匙串」。读作：三键都空、这次写下非空 key 时，新建在加条目的那一次写入里另写第 1 条的键；保存实例 key 在写完钥匙串之后、同一把锁里另写一次。顺序与失败规则不变。

## 与 04 第三段的先后

04 第三段（04 plan 第 16–20 步）动的是：`ApprovalCard.tsx`、`lib/approval-card.ts`（`elevated` 文案、「沙箱不可用」那句）、`ToolRow.tsx` 的 `BlockedNotice`（沙箱回执）、两份 locale、`copy-coverage.test.ts`、新的 text-fit e2e，以及设置弹窗的「权限与网络」一栏。本 spec 改前五样，不碰设置弹窗。

已定（开放问题 13，照推荐、未否决）：**本 spec 先实现、先合入，04 第三段在它之上做**。理由：

- 两边改同一组文件，04 新加的句子（`elevated`、「沙箱不可用」、沙箱回执）一次落进最终版式，不用先落进旧卡再搬；04 验收 33 的「回执不讲机制」测试可以连本 spec 的键一起查。
- 04 第三段排在第二段与基线评测（第 15a 步，要有 key 的一方跑）之后，本 spec 不依赖 kernel 与契约，能和 04 第一、二段并行，不推迟 04。
- 反过来做，本 spec 要改 04 刚落地、刚测过的卡；并成一个 PR 则一个 PR 对两份 spec，审查与回退都更难。

这个先后不会自己发生：「开工」照 AGENTS.md 先选序号最小、`ready` 的 architecture spec，也就是 04；本 spec 是 features spec，只在被明说「按 docs/features/presentation-r1/spec.md 实现」时才开工。所以第 0b 步已在 04 plan 第 16 步之前加了一道门（2026-10-15）：「开工前确认 presentation-r1 的实现已合入 `dev`（`docs/features/presentation-r1/spec.md` 顶部为 `Status: implemented`）；只有 spec 文档在 `dev` 上不算。不是就停下问 owner。」门看实现、不看 spec 文件在不在：照仓库惯例 spec 的文档 PR 先合进 `dev`（04 的 spec 就是先合了 PR #45），之后才从 `dev` 开实现分支，这一行门本身也随本 spec 的文档 PR 进 `dev`。04 plan 是进度文件，加这一行不改 04 的 spec。

本 spec 合入时在 04 plan 第 18 步末尾加一句交接：卡面的位置照 presentation-r1 §审批卡（③ 放 `elevated` 句，「沙箱不可用」在 ③ 与 ④ 之间），按键与焦点仍照 02。`elevated` 句照 04 §界面 原文，后面带完整命令，本 spec 的 ③ 规则与验收 2 对它豁免。04 第 18 步可以另选：把句末的「只允许这一次，不会记住」与 `{command}` 交给「允许（只这一次）」钮与对象行去说，在 04 的 Revisions 里记下（04 还没实现，可以就地改）；不选就照 04 原文，豁免照旧。同一句交接还写两件事：旧四码的回执已按 presentation-r1 §拦截回执 变成一行，04 §回执上有什么 的「02:2831 的三行版式只管四个旧拦截码」改指 presentation-r1 §拦截回执（04 用 `Revisions:` 就地改）；04 第 18 步按 copy-coverage 行号写的改法（「:304 的 24 改 25、:315 的四个码改五个」）以本 spec 合入后的断言为准，不按行号（本 spec 第 3 步把 `protected` 拆成读、写、抓取，那几行会挪）。

04 §留给 05、06 与 task-mode-ui 的 列给 4d 的清单，本 spec 合入时用 04 的 `Revisions:` 就地改（04 仍是 `ready`）：「在文件夹里工作」开关一项注明由本 spec 做了；另补两项，4d 起草时照这份清单取范围，不补就会漏：「工具行路径短写；文件卡的允许塌行在工具行显示的路径与真实路径不同时接真实路径（presentation-r1 §答完与拒绝、不变量 3）」；再加「发送与停止同位单钮，要按第三个例外替换 02 §模型菜单与输入框「停止与发送」」（开放问题 14 A）。

## 旧 spec 上要加的

和实现同一个 PR，日期写写入指针那天（§替换的条款 引言：plan 第 11 步那个提交的日期；本 spec 顶部 `Amends:`、`Replaces:` 里的「写入指针那天」同一个提交换成同一个日期）；旧文一字不改，只在行末接 §替换的条款 里各条的指针，顶部加一行（`Status` 不变）：

- 00：`Clauses replaced by: [presentation-r1](../../features/presentation-r1/spec.md)（<日期>：§UI 最小集「设计令牌」的值、§国际化「英文更长」的覆盖范围）`
- 01：`Amended by: [presentation-r1](../../features/presentation-r1/spec.md)（<日期>：provider.configure 在三键都空、存下第一把机密键时另写 provider 与 defaultModelByProfile，见该 spec §对 02 的修补「点名」(c)）`
- 02：`Clauses replaced by: [presentation-r1](../../features/presentation-r1/spec.md)（<日期>：§会话形态 任务行的文件夹 chip、§阶段 2 做的组件 的 ToolRow 通用句与被拒收口句、TurnSummaryLine、BlockedNotice、ModeSwitch、FolderChip 四行、§失败卡与结束原因 ①② 与阶段 1 错误态的 auth、① 的槽位、user-rejected、§结束原因词表 的「槽位齐全」、§最小审批卡 ③④⑥ 与答完、§模型菜单与输入框 的组头文案、每一行与提示与禁发、§模型选择 数据去向第一条与「已配置」的组头、§可逆性「记录和展示」与 §目标与非目标「完整版界面」的刻度排期、验收 34 与 37 各两处）`；另加 `Amended by: [presentation-r1](../../features/presentation-r1/spec.md)（<日期>：第一次存 key、新会话默认还空着时把默认落到这个厂商；「只有改过下拉才写」两句与验收 33 读作三键都空时除外；§最小审批卡「按键」的钮上文字读作带期限的允许钮，键、默认焦点与放行的钮不变；见该 spec「点名」(a)、(b)、(d)）`
- 03：`Clauses replaced by: [presentation-r1](../../features/presentation-r1/spec.md)（<日期>：§卡片与工具行 的可逆性刻度与 ToolRow 副作用段、验收 45 两处）`
- custom-vendors：`Clauses replaced by: [presentation-r1](../presentation-r1/spec.md)（<日期>：§对 02 的修补 第 1 条 probed 的文案、§目标 第 2 条与验收 19 的标记、§探测「结果与原因码」表的通过一行、验收 25 的新消息一半）`；另加 `Amended by: [presentation-r1](../presentation-r1/spec.md)（<日期>：三键都空时，新建带 key 的实例与保存实例 key 另写新会话默认，见该 spec「点名」(e)）`
- model-display-names：`Clauses replaced by: [presentation-r1](../presentation-r1/spec.md)（<日期>：§对 02 的修补 末段、验收 3 的主机一句）`

开放问题都取了推荐项（owner 2026-10-15），下面这段不适用，留作记录。选了非推荐项时：开放问题 8 选 B，R4 的连接器一半、R6、R24 与 R25 的工具行一半连同各自的指针一起去掉（R4 的被拒收口句一半留着）。开放问题 4 选 B 不能走本节：见开放问题 4。开放问题 14 选 B，另加一条 R 替换 02 §模型菜单与输入框「停止与发送」的「生成中停止钮和发送钮并存」，按键与 `chat.stop` / `chat.sendNow` 不变。开放问题 15 选 B，R11 的指针去掉「例行的询问与撤不回的卡不出这一句」。开放问题 17 选 B，R13 与它的指针、「点名」(d) 与 02 `Amended by:` 里那一句一起去掉。开放问题 16 两个选项都只动本 spec 的 §输入框，不影响本节。

## 不变量

1. 审批卡与回执上的按键、默认焦点、主次按钮、哪个钮放行、点击防抖与 02 §最小审批卡「按键」「排队行」相同。
2. 期限文字只由 `allowScope`、`target.type`、是否子任务卡决定，与写进 `approval_resolved.grant.scope` 的值一一对应；期限词与 02 一字不差。
3. 每张审批卡写明放行什么、范围与管多久、后果（④；网络卡是 ③ 或 ④ 里的联网句）；`network` 原因的网址卡（授权落在主机名上）与 §审批卡 ④ 第 3 条的网址卡写出规范化主机名（`flagged`/`exfiltration` 卡只放行这一次，主机在允许后的塌行里）；撤不回的卡有原句「撤不回」。每条允许的塌行写明结果、期限与工具行没写的授权范围，包括命令的 cwd、搜索的后端域名、网址的规范化主机名，以及与工具行所写逐字不同的文件真实路径。
4. 本 spec 的渲染端改动不加路由、不加字段、不改 schema；契约面的改动只有 §对 02 的修补 第 1 条那次 config 写入（`provider.configure` 与 `customVendor.create` 两处入口）与第 3 条工具结果视图只增的 `isError`；写指针时用的 `latestOf` 是 claude-5-5-models 加的成员，本 spec 不加。
5. 结算行的数字只来自各调用的工具结果视图（含 `isError`；live 的 `tool-outcome` 与 `session.messages` 行上的 `calls[i].outcome`，含子会话），同一轮不重复计数；失败的改动不算「改了」，回读 Tenon 自己落盘的输出（`own-output-read`）不算读与查找。
6. 发送钮因模型用不了而禁用时，输入框调用 `chat.send`、`chat.sendNow` 0 次。
7. 模型菜单的外发确认与 kernel 的数据去向检查不变：确认之前对目标主机 0 次请求；「改用 <X>」不绕过这道确认。「改用」写 ① 之前，X 的去向已经出现过：行内写主机的行（实例、地址改过的 Ollama）只经菜单选中；官方地址的内置行靠「改用」钮上的厂商名（同菜单的组头），钮的悬停与无障碍描述另写「发往 <主机>」。

## 验收标准

测试名以「presentation-r1 验收 N:」开头。D = `apps/desktop/test/`，E = `apps/desktop/e2e/`。

1. 审批卡上没有刻度；③④ 照 §审批卡 出：撤不回的卡 ④ 是红色的「撤不回。」；`network` 原因的网络卡与 `flagged`/`exfiltration` 卡没有 ④；`network` 原因的 WebFetch 卡 ③ 写 `facts.host`：URL 为 `https://аpple.com/x`（西里尔 а）的卡写出 `xn--pple-43d.com`；`policy` 的 WebFetch 卡与 `inspector-failed` 的 WebFetch 卡 ④ 是「网址会发给 <主机>。」，主机从 `target.url` 规范化算出，`policy` 的 WebSearch 卡 ④ 是搜索那句，这三张卡 ④ 用的是 `confirm.undo.network.*`，不是 `confirm.reason.*` 的键；`unknown` 的 Write 卡 ④ 是「Tenon 没法替你撤回这次改动。」，`unknown` 的命令卡与连接器卡是「如果它改了东西，Tenon 没法替你撤回。」；`default`、`command` 与撤不回的卡没有 ③（开放问题 15 A）。卡用到的所有键（③④、钮、塌行）都没有 `{toolName}` 槽位；zh-CN 里这些键的文案不含任何内置工具名；en 里不含 Bash、Glob、Grep、WebSearch、WebFetch、AskUserQuestion（Read、Write、Edit、Agent 是英语常用词，不查）。〔D/renderer-approval-card.test.ts、D/copy-coverage.test.ts〕
2. 每种目标的卡（`elevated` 卡除外，照 04），③ 的文字不含对象行里的任何一段（路径、命令、cwd、网址、搜索词、主机）；网址卡 ③ 里的规范化主机名除外。〔D/renderer-approval-card.test.ts〕
3. 「允许」钮带期限，五种期限各一例，期限词与 02 的映射一字不差，且与答复写下的 `grant.scope` 对应；02 验收 36 的按键与焦点各条原样通过（撤不回卡默认焦点在「拒绝」、卡内 ⏎ 都是拒绝、Space 在「允许」上放行；一般卡与连接器卡 ⏎ = 允许）。〔D/renderer-approval-card.test.ts、E/approval.spec.ts、E/write-card.spec.ts〕
4. 允许后主会话的卡塌成「已允许（<期限>）」一行，不重复工具行已有的对象：命令卡的塌行写出 cwd，搜索卡的写出后端域名，网址卡的写出规范化主机名（URL 为 `https://аpple.com/x` 时塌行写 `xn--pple-43d.com`，live 与重启重画相同）；文件卡在工具行的路径与真实路径相同时不带路径，不同时带真实路径（工作区经链接打开时，`file_path` 写的是链接下的路径 `<链接>/notes/today.md`，塌行写出真实路径 `<真实工作区>/notes/today.md`）；拒绝后只有「已拒绝 · 这一轮到此为止」一行：没有收口句、没有失败卡，同批后面的调用各一行「未执行」；主会话卡的塌行重启后从 `calls` 重画出同样的行；子任务卡的塌行带对象，照 02 只在当场显示。〔E/approval.spec.ts、E/subagent.spec.ts、D/renderer-tool-row.test.ts、D/renderer-end-card.test.ts〕
5. 四个拦截码的回执各一行，不含「已告诉模型」与内置工具名；`protected` 的读、写、WebFetch 各是自己那句；有 `sandbox` 成员的调用不走这张表。〔D/renderer-tool-row.test.ts、D/copy-coverage.test.ts〕
6. 连接器调用的行写「使用 <显示名> 的 <原名>」，连接器删掉后退回映射名；展开后一行写做了哪类事与能不能撤：只读调用、Agent、AskUserQuestion、没完成的调用没有这一行，联网的行只写「联网」，一次出错的 Edit 不写「改了这个文件」；只有撤不回的行收起时带标记，标记有悬停提示与屏读文字。〔D/renderer-tool-row.test.ts、E/connectors.spec.ts〕
7. 结算行：一轮里 Read a.txt 三次、Edit b.txt 两次、Bash 两次、WebFetch 一次、Agent 一次（子会话里 Write c.txt 一次）时写「读了 1 个文件 · 改了 2 个文件 · 运行了 2 条命令 · 联网 1 次」；没有零项；被拦、没派发的不算；再加一次 `old_string` 没找到的 Edit d.txt，数字不变；只有一次 AskUserQuestion 的轮不出这一行；对话里只回读过落盘文件（`own-output-read`）的轮不出这一行。〔D/renderer-thread-model.test.ts、D/session-store.test.ts、E/subagent.spec.ts〕
8. 失败卡：`provider-error` 的每个 `errorCode` 一句，401 与 400 两张卡第一行不同；句子里是厂商名不是 id；结束卡与内容列同宽；步数上限卡对 100 次读同一文件写「读取 a.txt ×100」一行，同名不同路径的两组写完整路径，超过 5 组时其余收进「展开全部」。〔D/renderer-end-card.test.ts、E/run-end.spec.ts、E/retry.spec.ts〕
9. 模型菜单：官方地址的内置行行内不写主机；自定义实例的行、改过地址的内置行行内照旧写主机；Ollama 的回环行写「本机 · 仅文字对话」；悬停或键盘高亮时出现「发往 <主机>」，行的无障碍描述是同一句；通过探测的实例行写「探测通过 · 不保证 · <主机>」；外发确认页照旧写主机、确认前对该主机 0 次请求；未配置组头写「去设置填 API 密钥」，地址被拒的组头写「地址用不了」。〔E/model-menu.spec.ts、E/custom-vendor.spec.ts、D/renderer-custom-vendor.test.ts、D/renderer-data-flow.test.ts〕
10. 输入框：首页工具行左簇是「在文件夹里工作」开关；打开后 chip 出现在同一行，框与框下那行的位置前后相差 0 像素；发出第一条消息后没有开关，任务会话里 chip 还在；建立后的 `session.selectProfile` 照旧回 `established`；chip 浮层里添加走系统目录框、每项可移除；有没确认的预填时，打开开关后浮层自动展开、焦点仍在开关上，点确认之前浮层里已看得到每条预填的完整路径，不点就不进列表；单个文件夹的长名字在 chip 上完整显示、在 chip 内折行（开放问题 16 A）。〔E/composer.spec.ts、E/composer-frame.spec.ts、E/tools.spec.ts〕
11. 发不了：全新 profile（只有 Ollama 读作已配置）时发送钮禁用、框下一行说「这个模型没有可用的 API 密钥」并只给「去设置」，不给「改用」；生效选择的厂商没配置、另有有 key 的官方厂商时同一句并给「改用 <X>」「去设置」，钮上写厂商名与模型名（例：「改用 Anthropic Opus 5.5」），悬停提示与无障碍描述是「发往 <主机>」，新会话里点「改用」后可发；会话历史只发往回环或私网、X 在公网时，点「改用」打开 X 的外发确认页，确认前对 X 的主机 0 次请求、不写选择事实；X 是自定义实例时（例：会话历史发往公网主机 A，X 是公网主机 B 上的实例），点「改用」打开模型菜单并高亮 X 那一行，行内写着 B，用户在菜单里选它之前不写选择事实、对 B 0 次请求；地址被拒的实例与缺 key 的公网实例都不作为 X；生效选择的厂商地址被拒时说地址用不了，不说密钥；删掉会话用的实例后同样禁用并说明；在框下「去设置」打开的设置里存下 key、关上后，chip 与禁发行随即更新；四种情形下 ⏎ 与 Cmd/Ctrl+Enter 都是 0 次 `chat.send` / `chat.sendNow`。〔E/provider-settings.spec.ts、E/custom-vendor.spec.ts、E/model-menu.spec.ts、D/session-store.test.ts〕
12. 修补：三键都空、没有 ④ 时，第一次存 key 后三键（`.cowork` 与 `provider` 只在那一行能发工具时）写成该厂商的第一行，新会话的 chip 是它、可发。写下的值分两例，在哪一份里验看实现（或 rebase）时 `dev` 上的 `providerSelectionSchema` 有没有 `latestOf`：有，验指针一例，与 claude-5-5-models 验收 19 相同（全新 profile 第一次存 anthropic key，三个键都是 `{ id: 'anthropic', modelId: 'claude-opus-5-5', latestOf: 'opus' }`；第一次存智谱 key 是 `glm` 指针；新建带 key 的实例写钉住的 `.chat`）；没有，验钉住一例（Anthropic 三个键都是 `{ id: 'anthropic', modelId: 'claude-opus-5-5' }`，没有 `latestOf` 键），指针一例由后合入的 claude-5-5-models 在它的验收 19 验。两例的触发条件与下面各句相同。已有默认时存 key 不改默认；④ 有值时不写；只存 Ollama 的地址不写；写入失败时 key 照存、回 `ok`；第一行仅文字时只写 `.chat`，`.cowork` 与 `provider` 都不写；三键都空时新建带 key 的预设实例，`.chat` 写成它的第一行，`.cowork` 与 `provider` 不写（各行未探测），新对话的 chip 是它、可发；之后经 `provider.configure` 给实例存 key 同样只在三键都空时写。〔D/provider-routes.test.ts、D/custom-vendor-routes.test.ts、E/provider-settings.spec.ts、E/custom-vendor.spec.ts〕
13. 双语：上面每个改动的界面文字（含仅文字模型的禁发句与置灰原因）在 zh-CN、en 的 1280×800 下不换行、不截断；输入框工具行（开关、chip、模型 chip、停止、发送）在 800×520、侧栏展开时也不换行不截断；框下那行用 en、最长的内置厂商名加模型显示名作 X 量「改用 <厂商> <模型>」「去设置」与每一句发不了的原因，各段自身不换行不截断，放不下时按钮整组挪到第二行；内容（路径、命令、主机、模型 id、文件夹名，含 chip 里的文件夹名）可折行不截断。〔E/text-fit-r1.spec.ts〕
14. 文案覆盖：每个原因（按 kind 与目标细分的）、可逆性、拦截码（按读、写、抓取细分的）、`errorCode`、结算行类别、行标记、组头的两种、发不了的三句与仅文字模型的两句在两份 locale 里都有文案，参数名都取自各自的必填键或字段（由 `providerId`、`modelId` 换算出的厂商名、模型名，与由 `target.url` 规范化算出的主机，这三个槽位除外；主机只出现在不是原因键的 `confirm.undo.network.url` 与塌行键里，`confirm.reason.*` 的参数名只取该原因的必填 `facts` 键）；失败卡（`user-rejected` 不出卡）三行都不空；审批卡、塌行、拦截回执、工具行那一行、结算行的中英文案不含「模型」「可逆」「判决」「已告诉」/ model、reversib、verdict（04 的「沙箱不可用」那句与 `elevated` 句不在这组键里）。〔D/copy-coverage.test.ts〕
15. 文档：00、02、03、custom-vendors、model-display-names 只多了行末指针与顶部一行（02、custom-vendors 各两行），01 只多了顶部一行 `Amended by:`，旧文没有一个字被改；02 的 `Amended by:` 括注列出「点名」(a)、(b)、(d)，custom-vendors 的列出 (e)；本 spec 顶部 `Amends:`、`Replaces:` 写的是实际日期，与旧 spec 指针上的日期相同，都是写入指针那个提交的日期；04 用 `Revisions:` 改了 4d 清单（开关已做、补工具行短写与文件卡真实路径、补单钮（开放问题 14 A））与「02:2831 的三行版式」那一句；04 plan 第 16 步之前有 presentation-r1 的开工门，门文与 §与 04 第三段的先后 那一句相同：看的是 presentation-r1 的实现已合入 `dev`（spec 顶部为 `Status: implemented`），只有 spec 文档在 `dev` 上不算（开放问题 13）；components.md「待呈现 spec 替换的条款」两行标已替换，两节补记里留给呈现 spec 的各处逐处注明结局，`BrandRow` 的「将由」补了结局；parity-audit 在「2026-09-13 补记：简化决定」之后有一条带日期的补记：审批席没有刻度，工具行只有撤不回的行带标记（开放问题 9 A）。〔plan 的 git diff 核对〕

## 开放问题

都在改 `ready` 之前定；推荐项写在第一个。owner 2026-10-15 在对话里听过白话讲解与模拟界面后全部定了，都取 A（推荐项，下面各标已定）；规则已写进正文与 plan，题面与被否决的选项留在这里备查。每问先用一句白话说要定什么、两边各丢什么，再接细节。只有一个合理选项或只是细节默认值的几问（2、10–13）在下一节，按推荐写进了正文，owner 没有否决；编号不变。

1. **新会话默认怎么落到有 key 的厂商**。要定的：第一次填了 key 之后，新会话自动用它，由谁来做。A 让主进程在存 key 时顺手写默认，代价是对 01、02、custom-vendors 的「只有改过下拉才写」几处做点名（第 2 问）；B 改五层解析，代价是 config.json 要多一个会过期的记号；C 只改界面，首次运行仍停在没 key 的模型上，要用户自己点「改用」。
   细节：A（推荐）第一次存 key（含新建带 key 的自定义实例）、三键都空、没有 ④ 时，主进程写默认（§对 02 的修补）；B 五层解析跳过没配置的厂商——`resolveChoice` 要知道哪个厂商有 key，02 定了它不读密钥（钥匙串弹窗不能挡在数据去向判断之前），得另加一个不含密钥的「已存 key」记号进 config.json，记号会过期；C 只在渲染端做：设置卡在存第一把 key 时把「新会话默认模型」下拉预选成它，输入框给「改用」，不改主进程。 **已定（owner 2026-10-15）：A。主进程在存第一把 key 时写默认（§对 02 的修补 第 1 条）。owner 同日说内置默认跟随家族的最新一行，写法照该条：构建里有 claude-5-5-models 的 `latestOf` 时，带家族的内置第一行写指针；没有时写该行的 id，留作钉住；自定义实例写行的 id。**
3. **模型用不了时给不给一键改用**。要定的：发送钮禁用时，除了「去设置」，要不要给一个直接换到能用模型的钮。A 少走一步，代价是「改用」要做成和菜单一样的选择（外发确认、实例行先打开菜单）；B 只给「去设置」，做起来简单，但明明有能用的厂商也要绕去设置。
   细节：A（推荐）给「改用 <X>」加「去设置」，改用就是一次菜单选择：官方地址的行要外发确认时打开确认页，实例行与地址改过的 Ollama 行打开菜单、高亮那一行；X 只从「有 key 的厂商」里挑（`configured` 为 true，并且有一把机密键已配置或是自定义实例），Ollama 永远读作已配置但不进候选；B 只给「去设置」。 **已定（owner 2026-10-15）：A。给「改用 <X>」与「去设置」，规则在 §输入框「发不了的原因」。**
4. **模型菜单行上的主机**。要定的：菜单每行后面的主机名，哪些行可以收进悬停。A 只收官方地址的行（厂商名就说明了去向），实例行照旧写，菜单里仍有一部分行带主机；B 全收，菜单最干净，但实例的去向可能从没被看到过，要改 02 的数据去向条款（amend 或 supersede，第三个例外不适用）。
   细节：A（推荐）只有地址是内置厂商声明默认值的行把主机挪进悬停、键盘高亮与外发确认；自定义实例的行、地址改过的 Ollama 行（局域网或改了端口；智谱、Anthropic 改地址即被拒、不出行，custom-vendors Q8）与 `local-text-only` 的「本机」照旧在行内写，02 开放问题 23 的「去向看行上的目标主机」对这些行仍成立。B 一律只在悬停里：实例的名字是用户起的，看不出数据发往哪里，悬停提示没出来就点下去，主机就从没出现过，而 02 §模型选择「数据去向」认为选 ① 时已在菜单里确认过这个主机，kernel 也不再检查；选 B 要对 02 §数据去向 做 amend 或 supersede，另换 02 §目标与非目标「行标记」的「菜单行照常写用途句和目标主机」、§模型菜单与输入框「行标记」的「去向看行上的目标主机」与 `local-text-only` 的「<主机> · 仅文字对话」，并恢复 R17、R18、R27（custom-vendors 验收 20）。 **已定（owner 2026-10-15）：A。只有官方地址的内置行把主机收进悬停，实例行与改过地址的 Ollama 行照旧在行内写；R17、R18、R27 不恢复。**
5. **会话建立后的开关**。要定的：发出第一条消息之后，「在文件夹里工作」开关还露不露面。A 不再显示，少一个点不动的控件，任务会话靠文件夹 chip 认出来；B 留一个关不掉的开关，形态一眼可见，但又回到「点不动的标签」。
   细节：A（推荐）不再显示；B 显示一个关不掉的开关，悬停写「建立后不能改」。 **已定（owner 2026-10-15）：A。建立后不再显示开关。**
6. **「能不能撤」在 `unknown` 时**。要定的：Tenon 不知道一步能不能撤时，卡上说不说。A 说一句（写入直说、其余用条件句），后果总有交代，代价是写入与命令的卡上几乎总有这一句；B 不说，卡更短，但阶段 2–4 的写入与命令都看不出后果。
   细节：A（推荐）写入与编辑写「Tenon 没法替你撤回这次改动。」，其余写「如果它改了东西，Tenon 没法替你撤回。」（连接器工具一律、命令大多是 `unknown`，查询类也在内，不能说成一定会改）；B 不写，只在只读、可撤回、有快照、撤不回时写。 **已定（owner 2026-10-15）：A。§审批卡 ④ 的表照此。**
7. **网络卡的 ④**。要定的：联网的卡上，后果写「内容会发出去」还是写「撤不回」。A 照原因选，每张网络卡都有一句说内容离开这台电脑；B 一律用 `unknown` 那句，规则简单，但 `policy` 与 `inspector-failed` 的卡上就没有一句说内容会离开。
   细节：A（推荐）按 §审批卡 ④ 的第 2、3 条：③ 已说联网后果（`network` 两句、`flagged`/`exfiltration`）时不出，③ 是别的原因时出联网句（网址卡带从 `target.url` 算出的主机）；B 一律照 `unknown` 出条件句。 **已定（owner 2026-10-15）：A。§审批卡 ④ 第 2、3 条照此。**
8. **范围再加三项**。要定的：同一套「不讲机制」的规矩，要不要顺手用到拦截回执、工具行展开那一行和连接器调用句（同一批文件）。A 一次改齐，改动面大一些；B 只做 owner 列的几项，这三项留给 4d，在那之前界面上两种说法并存。
   细节：拦截回执旧四码去掉「已告诉模型」与工具名（R6）、工具行展开那一行与标记（R24）、连接器调用句（R4 的连接器一半）。A（推荐）一并纳入；B 只做 owner 列的几项。 **已定（owner 2026-10-15）：A。三项一并纳入，R4 的连接器一半、R6、R24 与 R25 的工具行一半照留。**
9. **工具行标记给哪些行**。要定的：收起的工具行上那个小标记，给哪些行。A 只给撤不回的行，标记才有分量，但改了 owner 在 parity-audit 定的「可逆性小图标只出现在审批席与写操作行」；B 照 03 给写与命令的行，几乎每行都有，等于没有。
   细节：A（推荐）只给撤不回的行；连同 §审批卡 去掉刻度，改的是 parity-audit「2026-09-13 补记：简化决定」（parity-audit-2026-09-12.md:292）：审批席不再有图标，写操作行只有撤不回的才有；选 A 时 plan 第 11 步给 parity-audit 加一条带日期的补记。B 照 03，只改说明文字。 **已定（owner 2026-10-15）：A。只给撤不回的行；plan 第 11 步给 parity-audit 加带日期的补记（验收 15）。**
14. **发送与停止在同一位置变形**。要定的：生成中把发送钮换成停止钮（单钮），还是两钮并存。A 本 spec 不做、留给 4d，现状不变，但 owner B+ 第 1 段的这一项要再等；B 现在做，要换 02「停止与发送」条，并改变「有正文时能不能点停止」。
   细节：owner B+ 第 1 段的一项；components.md 输入框补记 2026-10-15 因与 02「停止与发送」冲突撤回，留给呈现 spec。A（推荐）本 spec 不做，留给 4d（plan 第 11 步写进 04 的 4d 清单）：2026-10-15 的两钮并存已让 chip 与发送钮不挪位，单钮与 4d 的工具行一起定更合适；B 纳入，替换 02「停止与发送」的「生成中停止钮和发送钮并存」，同一位置按有无正文切换，按键与 `chat.stop` / `chat.sendNow` 不变。 **已定（owner 2026-10-15）：A。本 spec 不做；plan 第 11 步把单钮写进 04 列给 4d 的清单。**
15. **例行询问与撤不回的卡的 ③**。要定的：最常见的几种卡（改文件、跑命令、连接器）和撤不回的卡，要不要写「为什么停」那一句。A 不写，卡上少一句重复的话；B 照写，每张卡结构一样，但正是 §背景 说的层层重复（「修改这个文件？」下面再写「改文件前要你同意。」）。
   细节：A（推荐）`default`（文件、连接器）、`command` 与 `irreversible` 卡不出 ③：标题已经在问，④ 说后果（撤不回的卡是「撤不回。」），钮里写范围；`irreversible` 的「每次都要你亲自同意」也不是一句能保证的话（策略的 `release-irreversible`、连接器的总是允许、阶段 6 的任务授权都能免掉这一问），它的键留在目录里、值取 B 的句子（§审批卡 ③，plan 第 1 步）、不渲染。③ 只留给不寻常的原因（工作区外、联网、组织要求、被检查标出、连接器要求亲自确认）。B 照 §审批卡 ③ 表括号里的句子出。 **已定（owner 2026-10-15）：A。例行的询问与撤不回的卡不出 ③。**
16. **文件夹 chip 上写什么**。要定的：只有一个文件夹、名字又长时，chip 上写完整名字还是写「1 个文件夹」。A 写完整名字、在 chip 内折行，一眼看到在哪个文件夹里工作，代价是这时工具行变高；B 工具行始终一行，但只有一个文件夹时也看不到名字，要悬停。owner 2026-10-15 在 PR #46 刚验收过「长文件夹名完整显示、折行、不省略」（ux-craft.spec.ts「a long folder name shows whole and wraps…」），B 等于推翻那一条。
   细节：A（推荐）单个文件夹写完整名字，占左簇剩下的宽度，可在 chip 内折行；多个时写「<第一个> +N」。B 写 cwd 那个文件夹的名字，多于一个时后接「 +N」，放不下时改写「N 个文件夹」，名字在悬停里。plan 第 7 步按所选改写 ux-craft 的两条。 **已定（owner 2026-10-15）：A。单个文件夹写完整名字、在 chip 内折行，PR #46 验收的那一条照旧成立。**
17. **「允许」钮里写期限**。要定的：期限词放进「允许」钮（「允许（本会话） ⏎」），还是照 02 写在钮旁。A 放进钮里，按下的那个钮就写着放行多久，代价是 02 §最小审批卡「按键」条写的钮上文字要靠一个读法对上（「点名」(d)），那一条属权限语义、第三个例外换不了，所以要 owner 确认；B 不做，期限照 02 写在钮旁。
   细节：A（推荐）「点名」(d) 成立，照 §审批卡 ⑥ 与 R13 做：键、默认焦点、哪个钮放行、Space 与点击都不变，02 的 `Amended by:` 括注记下这个读法，R13 的指针写明按键条不变；B 删去 R13、它的指针、「点名」(d) 与 02 括注里那一句，§审批卡 ⑥ 照 02，验收 3 改为期限在钮旁。 **已定（owner 2026-10-15）：A。「点名」(d) 的读法成立，R13 照做，02 的 `Amended by:` 括注记 (d)。**

## 按推荐定、owner 可否决

这几问只有一个合理选项或只是细节默认值，按推荐写进了正文；owner 2026-10-15 过目、没有否决，照写（下面各标已定，括号里的另一项留作记录）。

2. **「只有改过下拉才写」那几处**：按 §对 02 的修补「点名」(a)–(c)、(e) 读作三键都空时除外，旧文不改（02 两句与验收 33、01 的 `provider.configure`、custom-vendors 的「新建」与「保存实例的 key」）。另一项是为此 supersede 02 §模型选择，不成比例；owner 不接受这个读法时，回到第 1 问在 C（只改渲染端）与 B 之间选。 **已定（owner 2026-10-15）：照推荐，未否决。**
10. **步数上限卡聚合后列几组**：5 组，其余收进「展开全部（N 项）」（另一项：全部列出）。 **已定（owner 2026-10-15）：照推荐，未否决。**
11. **结算行里子任务的份**：并进同一组数字，不另标（另一项：有子任务的数时句末加「（含子任务）」）。 **已定（owner 2026-10-15）：照推荐，未否决。**
12. **阶段 1 错误态的 `auth`**：改成「API 密钥无效或没有填。」并给「去设置」（另一项：只改文案、不加按钮）。 **已定（owner 2026-10-15）：照推荐，未否决。**
13. **与 04 第三段的先后**：本 spec 先实现、先合入，04 第三段在它之上做；第 0b 步在 04 plan 第 16 步前加开工门（看本 spec 的实现是否已合入 `dev`，不看 spec 文档）；`elevated` 句照 04 原文、在 ③ 规则与验收 2 豁免，04 第 18 步可另选把命令与「只允许这一次」交给对象行与钮（§与 04 第三段的先后）。另两项（04 第三段先做、本 spec 之后改它刚落的卡；两者并进一个 PR）在 §与 04 第三段的先后 已论证更差。 **已定（owner 2026-10-15）：照推荐，未否决；开工门已在同日加到 04 plan 第 16 步之前。**

## 被否决的方案

- 整份 supersede 02、03：为几句文案与一处位置作废两份大 spec，不成比例（第三个例外就是为此立的）。
- 刻度留着、只改字：五格仍是一张分类表，不是一句话（parity-audit 2026-09-13：审批那一刻只多给一句为什么停、能不能撤）。
- 「工作位置」chip（仅对话 / 专用文件夹 / 我的文件夹）：会和 6b 的「运行位置」混；owner 2026-10-15 选了开关。
- 开关在工具行、文件夹仍在框下：一个控件拆在两处，切换时框下那一行要么跳、要么常年空着。
- 拒绝后仍出失败卡：拒绝是你做的决定，不是失败；三层反馈说的是同一件事。
- 结算行按 `effect` 计数、只改字：Bash 的 effect 是 `external`，怎么改字都会把每条命令说成对外发送；`effect` 也不区分成功与失败。
- 「改用」直接调 `session.selectModel`：kernel 只在选择来自默认时检查数据去向，菜单选择被当作已确认，直接写 ① 会让历史不经确认发往公网主机。
- 开放问题 1、3–9、14–17 的 B、C 与 2、10–13 括号里的另一项：owner 2026-10-15 都没选，理由与代价留在 §开放问题、§按推荐定、owner 可否决 各问的题面。
