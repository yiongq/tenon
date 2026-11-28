# claude-5-5-models · log

只往后追加。实施、验收、评审记录，突变结果，`测试改动：` 与 `花费：` 行都记在这里。

## 实施 · 2026-10-23

- 按 sdd v2 接入（plan 第 0.1 步，ADR-004 A5）：spec 页头补 `Tier: standard`，`Replaces:`、`Related:`、验收 12 的标记与 live 记录位置按 v2 澄清，记进 spec「修订记录」；plan 改成 v2 的形状（当前 / 需要你、只留最新一条交接、最后一步「owner 验收 → 改 Status」，第 13 步只写旧 spec 页头）；本文件新建。只收紧或澄清，代码没动。
- plan 第 2–5 步（Codex 按任务说明实现；lead 审查 diff、在沙箱外补跑全量 vitest 并提交）：types.ts 加 `pricing.longPrompt`、`ThinkingSpec.offType`、`ModelInfo.family` / `generation`、`ProviderDefinition.familyNameKeys`；anthropic-messages 编码器在 adaptive-gated 行关思考时写 `offType ?? 'disabled'`，budget、adaptive 行带 `offType` 与「`between_tools` 关思考又带 tools」都本地拒绝，编码器 3 → 4；采样守卫只收 `top_p` 0.99、拒 `temperature` 与 `top_p` 同发；definitions/models.ts 加 `arrangeFamilies`、`newestOfFamily` 并从 kernel 导出（还没接到内置表上，那是第 6 步）。新用例标题带「claude-5-5-models 验收 2 / 4 / 5 / 13」；新文件 packages/kernel/test/provider/model-families.test.ts。
- 门禁：format、lint、typecheck 通过；全量 vitest 241 个文件、4516 passed、110 skipped（沙箱外跑；Codex 的沙箱里进程树用例报 `spawn EPERM`，与本改动无关）。
- 位置漂移：plan 写的 thinking-shapes.test.ts 实际在 packages/kernel/test/provider/wire/ 下；其余按函数名与用例标题定位，没有对不上的。

突变（每个改坏一次、确认变红、改回；改回后生产文件与突变前逐字节相同）：

- 第 3 步 ① 忽略 `offType`、恒写 `disabled` → 红：Sonnet 关思考写 `between_tools` 的用例
- 第 3 步 ② `between_tools` 跳过 `assertMayDisable` → 红：xhigh / max 关思考本地拒绝的用例
- 第 3 步 ③ 关思考对象里写进 `display` → 红：两行关思考形状的用例
- 第 3 步 ④ 版本退回 3 → 红：当前版本、同模型字段、关思考三组金样
- 第 3 步 ⑤ 去掉「关思考且 tools 非空」的检查 → 红：`between_tools refuses nonempty tools before sending`
- 第 3 步 ⑥ budget / adaptive 也写 `offType ?? 'disabled'`、不拒 → 红：两条「with offType is a local table error」
- 第 4 步 ① 判定改回 `topP >= 0.99` → 红：三行非默认采样拒绝的用例
- 第 4 步 ② 去掉同发检查 → 红：三行非默认采样拒绝的用例
- 第 5 步 ① 代次只比主版本 → 红：`compares major before minor…`
- 第 5 步 ② 带家族的行手写 `listing` 不抛 → 红：authored listing 的 main、more、undefined 三例
- 第 5 步 ③ 最新一代也写 `listing: 'main'` → 红：代次排位与代次比较的用例
- 第 5 步 ④ `newestOfFamily` 取家族里排在前面的行 → 红：`newestOfFamily stays within the definition and family…`

测试改动：packages/kernel/test/provider/vendor-blocks.test.ts · records encoder, modelWireHash and responseModelId · 编码器按 spec §对 02 的修补 第 3 条升到 4
测试改动：packages/kernel/test/provider/definitions.test.ts · writes the same-shaped Tape facts for … · anthropic-messages 编码器版本期望改为 4，openai-chat 仍是 2
测试改动：packages/kernel/test/provider/wire/thinking-shapes.test.ts · writes the shapes Opus 5.5 does take · 默认采样由「同发也收」改为单发收、同发拒（spec §点名 (a)，F14）
测试改动：packages/kernel/test/provider/wire/encoder-version.test.ts · the current version is the newest row, and its row is these bytes · 查重由「同表两行同哈希 = 空升版」改为跨表检查，照 plan 第 3 步；原有金样行一字未改
测试改动：packages/kernel/test/provider/wire/encoder-version.test.ts · same-model text and tool_use fields have their own table · 追加与第 3 行相同的第 4 行，版本取各表最大值，查重交给跨表检查

## 评审 · 2026-10-23 · 审过 8ea52df

- 新上下文的评审 agent（Opus），只审第 0.1 步的文档改动，结论「要改」：1 blocker、2 major、7 minor。处置：
  - B1 plan「当前」的授权行比问卷宽（范围写成「本 spec 的实现 PR」、例外漏了安全取舍、花费收窄到第 12 步）：照问卷原文收窄成「本 spec 由 Codex 实现的 PR」，例外写全。
  - M1 第 13 步的页头写法会被 pairs 拦（评审在克隆里实测：只给旧 spec 加行时拦，本 spec 补上 `Changes` 后拦 0），而且每个目标只认第一个 §：第 13 步改成本 spec 页头改写为每条一个 § 的 `Changes`、旧 spec 逐条成对；`Replaces:` 里的日期约定去掉。
  - M2 测试点名只管新写的用例：改成每条验收都要有点名它的用例，靠改已有用例验的在原标题上补；第 14 步加 trace 检查。
  - m1 lead 自定的「上限 2 美元」撤回，改成第 12 步开跑前由 owner 定；m2 重新生成 docs/README.md；m3「需要你」只写「无」；m4 第 11 步的记录位置改成 log.md；m5 第 1 步的行号引用改成节名；m6「合入前不切 release 分支」写进总参考「以后再说」，标挡上线；m7 第 12 步加回写厂商表。
  - 建议项都采纳：Tier 理由补出处，e2e 位置写进「机器约束」，措辞改成「只收紧或澄清」。

## 评审 · 2026-10-23 · 审过 b72988a

- lead 审 Codex 实现的第 2–5 步（与作者不是同一上下文）：对照 spec §对 01 的修补、§对 02 的修补 第 1–4 条与 plan 第 2–5 步逐条看 diff，金样表的跨表查重按 plan 第 3 步；沙箱外跑全量 vitest 4516 passed；12 个突变全部变红。无发现。

## 评审 · 2026-10-23 · 审过 f44b5e0

范围：8ea52df、f44b5e0 的文档改动由新上下文的评审 agent（Opus）审了两轮；b72988a、e56d2d4 的代码与记录见上一条 lead 评审。
- [blocker] plan「当前」的授权行比问卷宽 · 证据：plan「当前」的授权行对照 2026-10-23 问卷原文（题目与选项说明） · 已修 f44b5e0
- [major] 第 13 步的页头写法 pairs 会拦，且每个目标只认第一个 § · 证据：评审在克隆里照旧写法跑 spec-check 拦 1 条，按新写法逐节成对后拦 0 · 已修 f44b5e0
- [major] 测试点名只管新写的用例 · 证据：spec-check trace 警告 18 条验收没有用例点名；第 6、11 步只靠改已有用例验 · 已修 f44b5e0
- [建议] 上一轮 m1–m7 与各建议项（花费上限交 owner、入口页、「需要你」、记录位置、行号引用、release 约束进「以后再说」、回写厂商表） · 已修 f44b5e0
- [建议] 第 13 步的示例把带点名项的节也标成「增补」；「不切 release 分支」那一行没有删除步骤 · 已修 e55adcb（只改 plan.md）
- [建议] spec-check 提示改了 packages/kernel/src/index.ts 却没动 overview.md · 不修：本段只新增两个导出函数，模块边界与 overview 的术语不变；第 6 步把家族接进内置表时再看 overview §术语 要不要加「家族、代次、指针」
结论：通过
突变：文档部分 0 个；代码部分 12 个，全部变红，0 个存活（见「实施 · 2026-10-23」）

## 实施 · 2026-10-23（第 1、6–8 步）

- 第 1 步（lead，只读）：F1–F21 逐条对一手页面重核，19 条不变（F4、F5、F8、F16、F17 只改了措辞），F6、F14 变了：API 版本 `2026-10-21` 起任何模型带采样参数都 400，旧规则只适用于之前的版本。Tenon 钉 `anthropic-version: 2023-06-01`（anthropic-messages.ts 的 `ALLOWED_HEADERS`），数据与第 4 步的守卫都不改；spec §事实与出处 加「2026-10-23 复核」一段，新建 docs/reference/vendors.md（先收 Anthropic），总参考「以后再说」加「升 API 版本前先改采样守卫」一行。重核原文另记。
- 第 6–8 步（Codex 按任务说明实现；lead 审查 diff、沙箱外补跑全量 vitest 并提交）：两新行逐字段照 spec §内置模型表的数据改动，lead 逐字段核过；anthropic、智谱的行加 `family` / `generation`、表经 `arrangeFamilies`，Opus 5 去掉手写的 `listing`；`familyNameKeys` 与两份 locale 的新键；`costOf` 按提示长度换档；contracts 的 `latestOf`、`family` / `familyNameKey`；`resolveChoice` 的问询加 `previousModel`，`SessionFacts.lastSelected` 加 `modelId` 与 `capabilitySource`。
- 门禁：format、lint、typecheck 通过；全量 vitest 241 个文件、4545 passed、110 skipped（沙箱外）。model-menu.spec.ts、text-fit-02.spec.ts 只过了 typecheck，由本段 PR 的 CI e2e 首跑。
- 位置漂移：plan 写的 `provider/models.ts` 实际是 `provider/definitions/models.ts`；model-menu.spec.ts 与 mailbox.ts 的行号都偏了，按用例标题与函数名定位，没有对不上的。

突变（第 8 步 ⑤⑥ 要等第 9 步，留到那时做）：

- 第 6 步 ① Haiku 5.5 的 `defaultDisplay` 写成 `'summarized'` → 红：验收 1「haiku 5.5 matches every documented field」
- 第 6 步 ② Sonnet 5.5 去掉 `offType` → 红：验收 3 Sonnet 5.5 摘要请求的编码用例
- 第 6 步 ③ Sonnet 5.5 去掉 `forcedToolChoice: false` → 红：验收 1 整行用例与验收 10 的 search-backends 用例
- 第 6 步 ④ Sonnet 5.5 去掉 `checksThinkingPrefix` → 红：验收 1 整行用例与 M6 前缀标记用例
- 第 6 步 ⑤ 把 Sonnet 5.5 排到第一行 → 红：验收 1「puts Opus 5.5 first…」
- 第 6 步 ⑥ GLM-4.6 的家族写成 `'glm-4'` → 红：验收 1、13 的家族与排位表
- 第 6 步 ⑦ Flash 并进 `glm` 家族 → 红：定义加载即抛 `family glm: duplicate generation 5,3`
- 第 7 步 ① `>` 改 `>=` → 红：验收 7 恰为 100 000 的用例
- 第 7 步 ② 提示长度只算 `input` → 红：验收 7 靠缓存读写跨阈值的用例
- 第 7 步 ③ 输出仍按低档 → 红：验收 7 的 100 001 用例
- 第 7 步 ④ 档内缺缓存价退回基础档 → 红：验收 7「missing tier cache rates…」
- 第 8 步 ① 交本代第一个 `model_selected` → 红：验收 15「passes the last selected model…」
- 第 8 步 ② 清空后仍交上一代的 → 红：同一用例清空后为 null 的断言
- 第 8 步 ③ `effectiveModelChoice` 交 null → 红：验收 15 的最后选择、`capabilitySource` 与旧记录用例
- 第 8 步 ④ 去掉 `.catch(undefined)` → 红：验收 18 的空串与非字符串坏值用例

测试改动：packages/kernel/test/provider/definitions.test.ts · declares each Anthropic row’s thinking mode… · 加两新行，按 spec 数据表的行序更新期望
测试改动：packages/kernel/test/provider/definitions.test.ts · puts Opus 5.5 first… · 七行的顺序与币种期望按 spec 数据表更新
测试改动：packages/kernel/test/provider/definitions.test.ts · M6 不变量 17… · 前缀标记的期望表加两新行
测试改动：apps/desktop/test/model-selection.test.ts · marks, lists and names each row… · Sonnet 5、Haiku 4.5、GLM-4.6 的 `listing` 改为算出的 `'more'`；Haiku 4.5 改按完整 id 找，另验 Haiku 5.5 的档位
测试改动：apps/desktop/e2e/model-menu.spec.ts · presentation-r1 验收 9… · 主列表断言改用 Sonnet 5.5；预算模式的 Haiku 4.5 改从「更多模型」进入（plan 第 6 步）
测试改动：apps/desktop/e2e/model-menu.spec.ts · asks by where the history went… · 改选主列表的 Sonnet 5.5，显示名期望随之改
测试改动：apps/desktop/e2e/model-menu.spec.ts · in a task, the text-only rows are greyed… · 可选的官方行改为主列表的 Sonnet 5.5
测试改动：packages/kernel/test/provider/wire/thinking-shapes.test.ts · 本地的 HAIKU_5_5、SONNET_5_5 夹具 · 换成内置表里的行（plan 第 6 步要求）；两行的整行期望由 definitions.test.ts 验收 1 用独立字面量守着
- overview 不用改：这一段只给 ModelInfo、config 的默认与 `resolveChoice` 的问询增可选键，模块边界、数据流与技术栈不变；overview §术语 是否加「家族、代次、指针」，等第 9–11 步把指针接进解析与界面时再定。

## 评审 · 2026-10-23 · 审过 4550a17

范围：b1b1577（Codex 的第 6–8 步代码，lead 逐字段核过两新行与 diff）与 93af16b、af2b10a、4550a17（lead 的文档）。新上下文的评审 agent（Sonnet）审了两轮，另跑了 12 个相关测试文件，全绿。
- [major] vendors.md 缺「重核」一列，前言却指着它；plan 第 1 步与 docs/spec-driven-dev.md「厂商现状」都要求这一列 · 证据：表头只有 5 列 · 已修 af2b10a
- [建议] vendors.md 的行查不回 F 编号 · 已修 af2b10a
- [建议] 几行写得过窄：display 只提 Sonnet 5.5、Sonnet 行漏 `budget_tokens` 400、effort 漏「在 Claude API 上」、工具流式漏平台与停顿 · 已修 af2b10a
- [建议] 采样行的模型名单像穷举，Haiku 4.5 一句没有出处 · 已修 af2b10a（评审对一手页面复核：页面点名十二个模型，没有 Haiku 4.5，写成「未核实」如实）
- [建议] API 版本 2026-10-21 另有两条不兼容改动没记；钉版本的地方有两处 · 已修 af2b10a
- [建议] log 少一行 thinking-shapes 的测试改动 · 已修 af2b10a
- [建议] 第 8 步突变 ⑤⑥ 要写进第 9 步；overview 是否要改没记结论 · 已修 af2b10a
- [建议] vendors.md 里「定价页」触发 notes 的敏感词警告（指厂商价格页，误报） · 已修 4550a17
- [建议] docs/spec-driven-dev.md「本项目补充」第 9 条仍写「厂商现状表……本次不创建」，已过时；改这一节要 owner 点名批准 · 交 owner
- [建议] anthropic.ts 注释里「Haiku 4.5 is restricted only while thinking is on」比 vendors.md 的说法强 · 不修：不影响行为，下次动 Haiku 4.5 那一行时一并核
结论：通过
突变：代码部分 15 个，全部变红，0 个存活（见「实施 · 2026-10-23（第 1、6–8 步）」）；第 8 步 ⑤⑥ 留到第 9 步之后

## 评审 · 2026-10-23 · 审过 004ee99

范围：PR #69 的 CI e2e（运行 39925804832）挂了一例，model-menu.spec.ts「a session on this computer whose default moved to a public host asks on any row or level of it」：Codex 新加的一段在打开菜单后立刻 `evaluateAll`，读到空数组。lead 在 004ee99 改成先等行数再读；同一个评审 agent（新上下文，Sonnet）复核。
- [建议] `evaluateAll` 不自动等待，菜单内容打开后才挂载 · 证据：CI 报 Expected 三行、Received []；同文件开头 anthropic 那段已先 `toHaveCount(4)` · 已修 004ee99
- [建议] 同一例新加的「更多模型」一段在 CI 上还没跑到过（上一行先挂了），重跑若在那里挂，先查点击打开子菜单是否稳定 · 不修：现写法与第一例相同且第一例已通过，等 CI 重跑验证
结论：通过
突变：0 个（只改测试的等待）

## 实施 · 2026-10-24（第 9–11 步）

- Codex 按任务说明实现，lead 审查 diff、沙箱外补跑全量 vitest 并提交（369ecd2）：
  - run-assembly.ts 的 `resolveChoice` 在 ① 空着时先看 `previousModel`：`builtin`、`probed` 与没记来源的行还在那家的表里就留；内置厂商上的 `user` 留在原 id 并照旧保守合成；`synthesized` 不留。再按答话的一层解析，指针经 `newestOfFamily`，家族找不到读作钉住的 `modelId`。数据去向检查仍在取行之后。
  - 新文件 apps/desktop/src/main/model-selection.ts 放 `selectionOf` 与 `menuSelectionOf`（避开 import 环）；`session.selectModel` 写指针，会话没有 ① 且选的就是 `session.modelChoice` 答的那一行时只写 ①、不动默认。
  - `provider.select` 带 `latestOf` 的一支（不在表里、Ollama 或实例、`modelId` 不是该家族的行都回 `invalid-value`）；`menuRow` 转发 `family`、`familyNameKey`；设置卡先列「最新的 …」、再列各行；`firstKeyDefaults` 改用 `menuSelectionOf`。
  - Codex 的自查另找到一处：手填过的 id 后来进了内置表，上一个 Run 记的 `user` 会被读成内置行；已先写失败的回归用例，再让 `selectModel` 对历史 `user` 照旧保守合成（spec §跟随最新「解析」第 1 条）。
- 门禁：format、lint、typecheck 通过；全量 vitest 4593 passed、1 failed、110 skipped（沙箱外）。失败的是 packages/kernel/test/mcp/http-connection.test.ts「03 验收 30 (HTTP): modern total deadline at ten times…」，单独连跑 5 次都过，Codex 那边也见过一次，与本段改动无关，是全量并行下偶发的慢；记一笔，不在本 spec 修。
- e2e：model-menu.spec.ts、provider-settings.spec.ts、recovery.spec.ts 只过了 typecheck，由本段 PR 的 CI 首跑。
- 总参考「以后再说」删掉「claude-5-5-models 合入之前不切 release 分支」一行：第一把 key 自本段起写指针（plan 第 11 步）。

突变：

- 第 9 步 ① 会话不换只在同厂商同家族时做 → 红：验收 15 默认是钉住行或改成 sonnet 指针的几例
- 第 9 步 ② 只有答话的一层是指针才看 `previousModel` → 红：验收 15 落到 ⑤ 与钉住的几例
- 第 9 步 ③ 家族找不到时落到 ⑤ → 红：验收 14 读作 `modelId` 的两例
- 第 9 步 ④ 上一个 Run 的行不在表里仍用它 → 红：验收 15 撤行一例
- 第 9 步 ⑤ 手填 id 不留（按 `synthesized` 读）→ 红：验收 15 手填 Ollama 一例
- 第 9 步 ⑤′ `synthesized` 也留 → 红：验收 15 `synthesized` 一例
- 第 9 步 ⑤″ 实例上的 `user` 行不在实例里了也留 → 红：验收 15 实例一例与 custom-vendor-runtime「验收 20」
- 第 9 步 ⑥ 会话不换留下的行跳过数据去向检查 → 红：验收 15「Ollama 地址改到公网主机」、确认前 0 次请求
- 第 9 步 ⑦ 「更多模型」的行也写指针 → 红：验收 16 选 Sonnet 5 一例
- 第 9 步 ⑧ 不带 `latestOf` 也写指针 → 红：provider-routes.test.ts「accepts glm-5.3-flash / flashx」
- 第 9 步 ⑨ 厂商没配置时跳到已配置的厂商 → 红：验收 14 缺 key 一例
- 第 9 步 ⑩ `latestOf` 与 `source` 同在仍按指针读 → 红：验收 14 一例
- 第 9 步 ⑪ 只改档也写默认 → 红：验收 16「只改档不写默认」两例与 hold 确认一例
- 第 8 步 ⑤ `effectiveModelChoice` 也交 `previousOrigin` → 红：验收 15 地址改到公网后 `session.modelChoice` 不抛一例
- 第 8 步 ⑥ `previousModel` 丢掉 `capabilitySource` → 红：验收 15 手填 Ollama 一例
- 第 10 步 ①–④（没存默认时选第一行、指针不带 `latestOf`、钉住行也带、Ollama 卡出指针项）→ 只有 e2e（provider-settings.spec.ts 验收 17）能抓，等 CI 首跑

测试改动：apps/desktop/test/model-selection.test.ts · records the choice and the profile’s default and provider · 默认改为家族指针（spec §点名 (g)），会话仍断言具体行
测试改动：apps/desktop/test/model-selection.test.ts · writes each profile’s default in the profile’s lock · 两个默认带家族指针，另先种不同的 cowork 默认以继续验锁内合并
测试改动：apps/desktop/test/model-selection.test.ts · answers neither route until startup recovery is done · 保存前多一次有效模型读取（只改档不写默认的判定要读它）
测试改动：apps/desktop/test/provider-routes.test.ts · first key with all three defaults empty · 钉住期望换成指针（presentation-r1 验收 12 的指针一例），去掉「没有 latestOf」断言
测试改动：apps/desktop/test/provider-routes.test.ts · TENON_PROVIDER or TENON_MODEL set · 打包分支第一把 key 的期望加 `latestOf: 'opus'`
测试改动：apps/desktop/test/custom-vendor-runtime.test.ts · 验收 20 · 第一轮之后删掉本地行再改默认（会话不换以后旧触发方式不再 hold），hold 与 0 次公网请求的断言保留
测试改动：apps/desktop/e2e/provider-settings.spec.ts · acceptance 6 · 原会话仍发 anthropic（会话不换），新对话发智谱；新对话的历史随之变短，流式与凭据断言保留
测试改动：apps/desktop/e2e/provider-settings.spec.ts · first-key defaults · 三个默认期望加 `latestOf: 'glm'`
测试改动：apps/desktop/e2e/recovery.spec.ts · restored receipt · 下一条留在 Sonnet 5（会话不换），另开新对话验新默认
测试改动：apps/desktop/e2e/recovery.spec.ts · resumable session the window does not open · 已有 Run 的会话芯片保持 Sonnet 5，新对话验 Ollama
测试改动：apps/desktop/e2e/model-menu.spec.ts · a round held for a public host · 种子改为可删除的回环实例，删后改默认触发 hold（plan 第 9 步）
测试改动：apps/desktop/e2e/model-menu.spec.ts · editing the held message · 同上
测试改动：apps/desktop/e2e/model-menu.spec.ts · 「立即发送」on the held message · 同上，再次确认的断言保留
测试改动：apps/desktop/e2e/model-menu.spec.ts · withdrawing the held message · 同上，重新 hold 的断言保留
测试改动：apps/desktop/e2e/model-menu.spec.ts · held for one public host, confirmed after the default moved · 同上，实际目标主机的断言保留
测试改动：apps/desktop/e2e/model-menu.spec.ts · asks on any row or level · 删除旧实例后改默认，当前行与档位都要确认的断言保留
测试改动：apps/desktop/e2e/model-menu.spec.ts · 改用 a public provider · 删除旧实例后改到缺 key 的默认，确认前 0 次请求的断言保留
测试改动：apps/desktop/test/custom-vendor-runtime.test.ts · 验收 20 · 021f4a8 恢复带 probe 的原 LOCAL 种子（369ecd2 曾去掉 probe，评审指出没必要且变弱），删行触发与 0 次公网请求的断言保留
测试改动：apps/desktop/e2e/provider-settings.spec.ts · 验收 17（双语） · 文案改用自动重试的 `toHaveText`，两处 `provider.select` 补成功断言（只收紧）
- 021f4a8 另把设置卡的指针逻辑抽成 apps/desktop/src/renderer/src/lib/provider-model-selection.ts 的纯函数，新文件 apps/desktop/test/renderer-provider-model-selection.test.ts（13 条）；第 10 步突变 ①–④ 在这里重做，全部变红（①3 条、②3 条、③4 条、④2 条）。
- 保守合成的范围（现行做法）：`capabilitySource` 为 `user` 的选择一律保守合成，含菜单里的 ① 与上一个 Run 留下的行；同一个手填过、后来进了内置表的 id，老会话保持纯文字，新会话按默认解析取到完整的内置行。spec §跟随最新「解析」第 1 条只写了上一个 Run 那条路径，这里照同一读法处理菜单 ①，不放宽。

## 评审 · 2026-10-24 · 审过 021f4a8

范围：369ecd2（Codex 的第 9–11 步代码与测试）、3ee88fa（lead 的文档）与 021f4a8（按评审修的代码）。lead 审了代码；新上下文的评审 agent（Sonnet）审了两轮，另跑了相关测试文件并在副本里重做了突变。
- [major] `session.selectModel` 在默认指向不存在的 provider 时整条路由失败，菜单没法修悬空的默认 · 证据：副本里种 `provider: { id: 'custom-gone' }` 后选模型得到 `handler-failed` · 已修 021f4a8（新增 6 个复现用例，去掉 try/catch 时全红）
- [建议] runtime 验收 20 的种子去掉了 probe，测得比原来弱 · 已修 021f4a8
- [建议] 验收 17 的 e2e 用 `allTextContents()` 比文案、两处 `provider.select` 没断言成功 · 已修 021f4a8
- [建议] 第 10 步的 4 个突变只有 e2e 能抓 · 已修 021f4a8（指针逻辑抽成纯函数，突变在 vitest 里变红）
- [建议] `resolveChoice` 有一支走不到、`'ollama'` 字面量、`menuRow` 的 `family` 与 `familyNameKey` 不同有同无 · 已修 021f4a8
- [建议] 保守合成对菜单 ① 也生效，spec 只写了上一个 Run 的路径 · 不修：照同一读法、不放宽，现行做法记在上面
- [建议] http-connection.test.ts「03 验收 30 (HTTP)」偶发红只有单独跑过的证据 · 不修：与本 spec 无关，全量负载下偶发，单独连跑 5 次都过；再红时先在 dev 上复现
- [建议] e2e（model-menu、provider-settings、recovery）还没跑过 · 不修：由本段 PR 的 CI e2e 首跑，e2e 绿之前自动合并不会合入
结论：通过
突变：第 9 步 13 个、第 8 步 ⑤⑥、第 10 步 4 个，共 19 个，全部变红，0 个存活

## 实施 · 2026-10-24（只改档不写默认，收窄）

- PR #70 的 CI e2e 挂了 02 的「keeps a default per profile: a new session in each starts on it (旧 37)」：聊天会话点了当前那一行 Opus 5.5，按原写法不写默认；任务会话再在「更多模型」里选 Haiku 4.5，写了 cowork 默认与共用的 `provider`；新开的聊天自己没有默认，读到 `provider`，成了 Haiku 4.5。根子是 spec 把「再点一次当前行」也算进不写默认，比 owner 2026-10-15 确认的「只改思考档位不动默认」宽。
- owner 2026-10-24 在对话里看过图解后选「A 点了就记，只有改档不记 (Recommended)」（题目「claude-5-5-models：在模型菜单里点「当前那一行」，要不要记成这种会话的默认？」）。spec 四处随之收窄，记进修订记录。
- Codex 按说明实现，lead 审查、沙箱外补跑全量 vitest（4620 passed）并提交（650091c）：`session.selectModel` 的请求只增可选 `intent`（`row` / `effort` / `confirm`，缺省 `row`）；ModelMenu 点行发 `row`、档位子菜单发 `effort`、kernel hold 的确认页发 `confirm`（点行触发的外发确认仍是 `row`）；model-routes.ts 只对符合条件的 `effort` 与 `confirm` 不写默认。`intent` 不进 kernel 的选择与 Tape。
- 新加复现用例（省略 `intent` 与显式 `row` 两例）改前红、改后绿；突变：判定改回「再点当前行也不写」，两例重新变红，已复原。02 的「旧 37」e2e 期望未改，由 CI 重跑。

测试改动：apps/desktop/test/model-selection.test.ts · only changing effort（两例） · 请求显式带 `intent: 'effort'`，原来不写默认的断言保留
测试改动：apps/desktop/test/model-selection.test.ts · confirming a held switch · 请求显式带 `intent: 'confirm'`，另加默认已移到另一行的情形
测试改动：apps/desktop/test/model-selection.test.ts · startup recovery gate · 点行不再先读有效默认，等待的调用次数少一次
测试改动：packages/contracts/test/model-choice-types.test.ts · SelectCarriesTheChoice · 新增的 `intent` 单独查可选性，模型字段的双向一致检查保留
- 583cef0：改档一律不写默认，不论会话有没有 ①（spec 修订记录 2026-10-24 第二条；lead 照 owner 原话「只改思考档位不动默认」的字面定，已告知 owner）。model-routes.ts 的判定简化为「`intent` 是 `effort` 或 `confirm` 就不写」，去掉预读有效默认与它的 try/catch（点行本来就不读，悬空默认的 6 个复现用例照旧通过）。model-menu.spec.ts 加两例 e2e：钉住默认的会话里经档位子菜单改档、hold 确认页点「切换」之后，三个默认都不变；renderer 两处 `intent` 改成 `row` 的突变只有这两例能抓，由 CI 首跑。
测试改动：apps/desktop/test/model-selection.test.ts · changing effort（old-sonnet / pinned-opus） · 会话已有 ① 后改档也不写默认（原期望是照常写）
测试改动：apps/desktop/test/model-selection.test.ts · effort request for a different row · 按「改档一律不写默认」改期望，会话选择照常生效的断言保留

## 评审 · 2026-10-24 · 审过 c811034

范围：021f4a8 之后的 650091c（`intent` 与点行照常写）、11a9aab（spec 收窄）、0119390、583cef0（改档一律不写默认、两例 e2e）、67ffe62（log）与 c811034（§点名 (g) 一句）。同一个新上下文的评审 agent（Sonnet）复核两轮，跑了 apps/desktop/test 与 packages/contracts 全部用例，并在副本里重做突变（点行一律不写、去掉 effort 一支、去掉 confirm 一支、加回不带保护的预读，全部变红）。
- [major] spec §点名 (g) 仍写「再点当前行」不写默认，后来又留着「会话没有 ①」的前提，与新的不变量 12、第 9 条相悖 · 证据：(g) 一行原文 · 已修 c811034
- [major] plan 第 9 步第二条仍是旧写法 · 已修 0119390
- [建议] renderer 一侧的 `intent` 取值没有测试读到 · 已修 583cef0（两例 e2e，CI 首跑）
- [建议] 会话已有 ① 时改档仍写默认，与 owner 原话「只改思考档位不动默认」字面不符 · 已修 583cef0（lead 照字面定，已告知 owner）
- [建议] 「档位子菜单触发外发确认再点切换」时 `intent` 是否保持 `effort` 没有断言 · 不修：e2e 已覆盖档位子菜单与 hold 确认两条路径，这条组合路径等第 14 步全量核对时补
结论：通过
突变：model-routes.ts 的三个 `intent` 分支与预读各一个，共 4 个，全部变红；renderer 两处 `intent` 改成 `row` 只有新 e2e 能抓，由 CI 首跑

## 实施 · 2026-11-28（第 12 步，官方 key live 冒烟，验收 12）

- owner 2026-11-28 定花费上限 2 美元（「按 2 美元开跑」，spec 修订记录一行）；钥匙串 `tenon-live-anthropic` 由 owner 当天更新，读前已提醒会弹窗。key 只进各条命令的环境，记录里 grep 过没有 `sk-ant`、没有鉴权头。
- 新加三例（apps/desktop/e2e/live-official-agent.spec.ts 最后一个 describe，标题带「claude-5-5-models 验收 12」，record 模式，不串行）：Sonnet 5.5 选 low 后阈值压缩、Haiku 5.5 默认档阈值压缩，两例都先在任务里 Read 一次；两行各问两次六因数题。`save()` 加了可选的文件名后缀，同一例里两个模型各存一份。
- 构建：dev `07470ca` 加本分支改动，`pnpm build` 后直接跑 desktop 的 `test:live`。
- 官方组（「live provider · anthropic official」3 例）：`claude-sonnet-5-5` 3 passed（14.3 s），`claude-haiku-5-5` 3 passed（12.0 s）。
- 新加三例：3 passed（48.4 s），线上请求全部 200，`captureFailures` 都为空。
  - Sonnet 5.5 压缩：Read 一轮 2 个请求，选 low 后两轮各 1 个（`output_config.effort: low`），重启后摘要请求 `thinking: { type: 'between_tools' }`、`output_config: { effort: 'high' }`、不带 tools、messages 里有 tool_result，200；Tape 摘要 attempt 快照 `{ thinking: { enabled: false }, effort: 'high' }`，压缩后主请求快照 `effort: 'low'`。
  - Haiku 5.5 压缩：同样 6 个请求，摘要请求 `{ type: 'disabled' }` 加 high、不带 tools、有 tool_result，200；Tape 快照同上；其余请求是 `adaptive` 加 `summarized`、不带 effort。
  - 缓存与思考：两行第一个请求 input 4、缓存写 2 146（提示 2 150 > 512），第二个请求缓存读 2 146。思考块：Sonnet 第一问 535 字、第二问没有；Haiku 两问 952、259 字；Haiku 压缩例 Read 那一轮 93 字。全部非空。
- 用量（每个 attempt，input / output / 缓存读 / 缓存写）：
  - Sonnet 压缩：4/112/0/4880 · 2/20/4880/133 · 4/10/4880/192 · 4/10/5072/49 · 摘要 4/413/0/1132 · 4/12/0/5350
  - Haiku 压缩：4/112/0/4880 · 2/21/4880/133 · 4/35/5013/60 · 4/10/5073/76 · 摘要 4/338/0/1133 · 4/12/0/5275
  - Sonnet 缓存：4/1143/0/2146 · 4/18/2146/1209；Haiku 缓存：4/1211/0/2146 · 4/97/2146/1277
- 花费：新加三例按 Tape 用量与定义表价格算约 0.06 美元；官方组两次没留 Tape（通过的例子删配置目录），按请求数与提示长度估不到 0.05 美元；合计约 0.1 美元，远低于上限。账单以 Console 为准。
- 结果回写 docs/reference/vendors.md 七行的「实测结果」与核实日期。原始记录在仓库外 tenon-notes/2026-11-28-c55-live/。
- 观察：压缩后的主请求缓存读为 0、重写 5 千多 token，是摘要替换了历史前缀，符合预期。

测试改动：apps/desktop/e2e/live-official-agent.spec.ts · official Claude 5.5 rows（三例） · 新 describe 照文件里已有的付费套件加 `test.skip(!ENABLED)`：只有 `TENON_LIVE=1` 且 `TENON_LIVE_OFFICIAL_AGENT=1` 时跑，默认 e2e 与 CI 不收要官方 key、要花钱的用例；不是放宽已有断言

## 评审 · 2026-11-28 · 审过 27826c9
结论：不通过    评审：派发会话起的独立子 agent，Opus 5.5，新上下文；读评审包、tenon-notes/2026-11-28-c55-live 下四份线上记录、plan 第 12 步与「命令」，在 27826c9 的临时 worktree 里读被测 helper 与 kernel 代码并做突变；没跑 live、没读钥匙串
突变：出了 24 个（记录回放 21 个：M1–M19，其中 M4、M13 各两份；生产代码 3 个：CM1、CM2、CM5，跑 vitest），首跑存活 9 个（M9、M10、M11、M12、M13×2、M15、M19、CM2）；M11、M12 的一般形式与 M13 的产品侧（CM5）被现有 CI 用例拦住，M19 不受验收约束、算等价；M9 与 CM2 是同一处，和 M10、M13/M15 记为下面三条建议；把突变放到真厂商上跑需付费 live，未跑
发现：
- [blocker] spec.md §修订记录 与 docs/reference/vendors.md §修订 新加的两行，出处写成分支名 `feat/claude-5-5-live` · 证据：docs/spec-driven-dev.md §4. 改动两条路「…相关的提交号或 PR 号。同一个提交写不进自己的提交号，所以写已有的相关提交或 `PR #n`」，同文件「现行文档」一节格式相同；违反处是这两行的行末 · 待作者处置
- [建议] Sonnet 压缩例只从 Tape 读压缩后主请求的 low，线上 `official[1]` 的 `output_config` 没断言 · 证据：存活突变 CM2（anthropic-messages.ts encode 对带 dropThinkingBefore、思考没关的请求不写 output_config），kernel 2805 例全绿、desktop/contracts 只红基线上同样红的 6 例；记录回放 M9 存活 · 不修：只算建议
- [建议] Sonnet 例没断言摘要前一个请求是 low（重启前 evidence 的结果被丢掉，CI 对应用例查了 attempts[at - 1]） · 证据：记录回放 M10 存活；本次记录 wire[2]、wire[3] 是 low，摘要请求缓存读 0、回放历史里没有思考块，不影响结论 · 不修：只算建议
- [建议] 思考文本断言在没有思考块时空过，可加「reasoningTokens > 0 的 attempt 消息里有思考块」 · 证据：记录回放 M13、M15 存活；产品侧突变 CM5 被 CI 拦（24 例红） · 不修：只算建议
- [建议] 缓存例把两个模型放在一个用例的循环里，Sonnet 一失败，Haiku 不跑，和 describe 注释不符 · 无证据 · 不修：只算建议
- [建议] save() 在用例函数体里写的 info.status 恒为 passed，记录里的 status 不能当通过的证据（已有代码） · 无证据 · 不修：只算建议
- [建议] 验收 12 第一点（官方组两行各跑一次）没有原始线上记录，vendors.md「官方组 3 例…全部 200」核不了 · 无证据 · 不修：只算建议

## 评审处置 · 2026-11-28（审过 27826c9 那一轮）

- [blocker] 两行修订的出处写成分支名 · 已修 d29ec38：spec.md §修订记录 与 vendors.md §修订 那两行行末改成 `PR #97`。
- [建议] 线上 `official[1]` 的 effort、摘要前一个请求的 low、没有思考块时空过 · 不修：断言照验收 12 的写法（快照从 Tape 读、「出现思考块时文本非空」、不要求一定思考）；补断言要再付费跑一次 live 才能确认，留给以后改这几例时一并做。
- [建议] 缓存例两个模型在一个用例里、`save()` 的 status 恒为 passed、官方组没有原始记录 · 不修：本次三例与官方组两行都过了；后两条是已有代码与已有用例的写法。

## 评审 · 2026-11-28 · 审过 a5356d1
结论：通过    评审：复审，派发会话起的独立子 agent，Opus 5.5，新上下文，没看作者对话；读 log.md「评审 · 2026-11-28 · 审过 27826c9」与「评审处置」两节、`git diff 27826c9 a5356d1` 及逐提交 stat、`gh pr view 97`、docs/spec-driven-dev.md §4 与 §8、sdd references/review.md、spec 验收 12、plan「Open」与第 15 步、apps/desktop/e2e/live-official-agent.spec.ts 的 `save()` 与 Claude 5.5 describe；跑了 spec-check（4 条拦都来自最后一条记录仍是审过 27826c9 的那条）；没跑 live、没读钥匙串或 .env
突变：本次修复只改了 spec.md、vendors.md 各一行修订和 log.md，没改测试或生产代码，突变不适用
发现：
- [blocker] spec.md §修订记录 与 docs/reference/vendors.md §修订 新加的两行，出处写成分支名 `feat/claude-5-5-live` · 证据：docs/spec-driven-dev.md §4. 改动两条路「…相关的提交号或 PR 号。同一个提交写不进自己的提交号，所以写已有的相关提交或 `PR #n`」；违反处是这两行的行末 · 已修 d29ec38，已复审：两行行末现为 `PR #97`，`gh pr view 97` 的 headRefName 是 `feat/claude-5-5-live`、base `dev`、OPEN；spec.md 那行与同节以 `PR #70` 结尾的行同式，vendors.md 那行按「日期、改了什么、为什么、提交号或 PR 号」四段写
- [建议] Sonnet 压缩例只从 Tape 读压缩后主请求的 low，线上 `official[1]` 的 `output_config` 没断言 · 证据：存活突变 CM2；记录回放 M9 存活 · 不修：断言照验收 12 的写法（快照从 Tape 读）；补断言要再付费跑一次 live 才能确认，留给以后改这几例时一并做（复审核过：验收 12 第二点线上只要求摘要请求，压缩后主请求的 low 写明从 Tape 读，理由属实）
- [建议] Sonnet 例没断言摘要前一个请求是 low · 证据：记录回放 M10 存活 · 不修：同上（复审核过：验收 12 把「选成 low」写成前置操作，没要求断言摘要前的请求，理由属实）
- [建议] 思考文本断言在没有思考块时空过 · 证据：记录回放 M13、M15 存活；产品侧突变 CM5 被 CI 拦 · 不修：同上（复审核过：验收 12 第四点原文「回复里出现思考块时文本非空…不要求一定有思考块」，理由属实）
- [建议] 缓存例把两个模型放在一个用例的循环里，Sonnet 一失败，Haiku 不跑，和 describe 注释不符 · 无证据 · 不修：只算建议
- [建议] save() 在用例函数体里写的 info.status 恒为 passed，记录里的 status 不能当通过的证据（已有代码） · 无证据 · 不修：只算建议
- [建议] 验收 12 第一点（官方组两行各跑一次）没有原始线上记录，vendors.md「官方组 3 例…全部 200」核不了 · 无证据 · 不修：只算建议
- [建议] 上面三条带证据的「不修」没进「以后再说」，也没进 plan「Open」，只在 log.md；plan 第 15 步只把「上线后跟进」与 Open 挪进「以后再说」，到时会漏 · 证据：docs/spec-driven-dev.md §8「默认不修，处置写 `不修：<理由>`，记进「以后再说」」；`git diff 27826c9 a5356d1` 没动 docs/architecture/master-reference.md 与 plan.md，plan「## Open」为「（无…）」 · 已修 616a569：总参考「以后再说」加一行

## 评审处置 · 2026-11-28（审过 a5356d1 那一轮）

- [建议] 三条带证据的「不修」没进「以后再说」 · 已修 616a569：总参考「以后再说」加一行，列出三处可收紧的断言与要付费重跑这一前提。
- 补记：「审过 a5356d1」那条记录里，blocker 一行处置中夹着的「 · 」改成顿号（spec-check 按「 · 」切段读处置），内容没改；最后一条建议的处置由「待作者处置」填成「已修 616a569」。

## 评审 · 2026-11-28 · 审过 38e94bf
结论：不通过    评审：派发会话起的独立子 agent，Opus 5.5，新上下文，没看作者对话；读了评审包、`git diff adee9a7 38e94bf`、spec 页头与 §对 02 的修补、§对 model-display-names 的修补、§替换 02 的表现层条款、§点名、§修订记录，plan 第 13 步，01、02、model-display-names 页头和被指的节标题，docs/spec-driven-dev.md §4、§5、§8、§页头、§入口页、§逐条替换、§本项目补充，spec-check.py 的 parse_ref_entry、split_entries、sec_compat、chk_pairs、chk_frozen、chk_index 与已知项匹配，config.json 的 modules 与 known；在作者工作区只读地跑了 spec-check
突变：16 个（删 Changed by、改 Changes 的节、改 implemented 正文和页头、改 kind 标记），在 38e94bf 的临时 worktree 里跑，跑完已移除；首跑存活 8 个：M1b、M1c 追到失效的已知项，删掉已知项后 M1b 变红，记为 major；M1e、M2b、M2d、M4a–c 是 spec-check 的设计边界，记为建议
发现：
- [blocker] 新 `Changes:` 一行 1074 字符，超过 600 字符上限 · 证据：docs/spec-driven-dev.md §5「新增的行不超过 600 个字符（`shape` 会警）」；spec-check 报 shape「claude-5-5-models/spec.md 有 1 个新增行超过 600 字符」，adee9a7 没有这条；plan 第 13 步没要求写成一行；按目标拆成四行（337、341、365、55 字符）后 pairs 0 拦、shape 警消失 · 待作者处置
- [major] config 里本 spec 的三条 pairs 已知项已失效，其中两条盖住了本步刚建的成对 · 证据：plan 第 13 步「若报 config 里这份 spec 的已知项失效，删它们要改 `.sdd/config.json`（门禁文件），那一处交 owner 合」，而 spec-check 不报失效，作者按字面跳过了清理；突变 M1b（01 删 §Provider 层 的 Changed by）和 M1c（02 删 §对 01-provider-and-tape 的修补 的 Changed by）存活，已知项跳过数 4→5；只删这三条已知项不会多出拦，删掉后 M1b 变红 · 待作者处置
- [建议] spec-check 只按节前缀配对，也不查「增补」和不标的区别，同节两条 Changes 配一条 Changed by、前缀相容的错节、两边一起改错的节、kind 改错都过 · 证据：突变 M1e、M2b、M2d、M4a、M4b、M4c 存活；本步 11 对已人工核过，没问题 · 待作者处置
- [建议] `Changed by` 括注里夹着说明，spec-check 解析出「验收标准，第 6 条的读法，§点名 (f」这类节名，只靠前缀匹配才配上；第 3、4、6、9、10 条 Changes 的括注里有第二个 §，和 plan「每条只带一个 §」的字面说法有出入 · 证据：用 parse_ref_entry 解析新加的 Changed by 与 Changes 得到的结果；spec-check 只取第一个 §，眼下不受影响 · 待作者处置
- [建议] §点名 正文还写着 `Amended by:`，表 (f) 行写着 `Amends:`，本步之后页头已没有这两个键 · 证据：spec.md §点名 首段与 (f) 行原文；spec-check 当别名处理，检查不受影响 · 待作者处置
- [建议] `Replaces:` 的理由删掉后，§替换 02 的表现层条款 没写这条为什么在表现层范围内 · 无证据 · 不修：只算建议

## 评审处置 · 2026-11-28（审过 38e94bf 那一轮）

- [blocker] 新 `Changes:` 一行超过 600 字符 · 已修 b0a3eb2：按目标分四行（336、466、237、55 字符），pairs 0 拦、超长警消失。
- [major] config 里本 spec 的三条 pairs 已知项已失效 · 交 owner：删这三条的提交 c200809 在 PR #100（`.sdd/config.json` 是门禁文件，不开自动合并；要在 #99 合入之后合，先合的话 dev 上配对还不存在会拦）。在本分支上删掉后没有多出拦，核过。
- [建议] spec-check 只按节前缀配对、不查「增补」 · 不修：那是 sdd skill 的工具，不在本仓库改；本步 11 对评审已人工核过。
- [建议] 括注里夹着说明、第二个 § · 已修 b0a3eb2：本 spec 的 `Changes` 括注里的点名不再带 §。01、02 已加的那两行 `Changed by` 没动：implemented 页头已加的行再改会被 frozen 拦（pre-commit 实测），按节前缀照样配上。
- [建议] §点名 正文还写 `Amended by:`、`Amends:` · 已修 b0a3eb2：改成 `Changed by:`、`Changes:`，修订记录同一行写明。

## 评审 · 2026-11-28 · 审过 0b31954
结论：不通过    评审：复审，派发会话起的独立子 agent，Opus 5.5，新上下文，没看作者对话；读 log.md「评审 · 2026-11-28 · 审过 38e94bf」与紧跟的「评审处置」、`git diff 38e94bf 0b31954` 与逐提交 stat、`git show c200809`、plan「当前 / 需要你」第 13 步「交接」、docs/spec-driven-dev.md §4 §5 §6 §8 §页头、spec-check.py 的 parse_header、split_entries、parse_ref_entry、chk_pairs、chk_frozen、chk_shape、chk_review、owner_pending；在作者工作区只读地跑 spec-check 与 `--status`，在 c200809、0b31954 两个临时 worktree 里跑突变，跑完已移除；没跑 live、没读钥匙串或 .env、没用 gh
突变：20 个（删 Changed by、删或改 Changes、并回超长行、改 implemented 正文和页头、`--staged` 下改本分支新加的 Changed by），在 c200809 上首跑存活 2 个：M1e 是 spec-check 的前缀配对边界（上一轮已记建议），M6c 是 range 模式下改本分支新加的 Changed by（相对 dev 仍是新增行，预期；同样改动 `--staged` 被 frozen 拦，M6d、M6e）；在 0b31954 上重跑其中 7 个，M1b、M1c 存活、跳过数 4→5（即那条 major），其余结果同 c200809；另把 c200809 的 config 套到 dev 的文档上，pairs 拦 3 条
发现：
- [blocker] 新 `Changes:` 一行 1074 字符，超过 600 字符上限 · 证据：docs/spec-driven-dev.md §5「新增的行不超过 600 个字符（`shape` 会警）」；spec-check 报 shape「claude-5-5-models/spec.md 有 1 个新增行超过 600 字符」 · 已修 b0a3eb2，已复审：四行 336、466、237、55 字符，11 条与 38e94bf 逐条相同（只第 3、4、6、9 条括注「§点名」改成「点名」），pairs 0 拦、frozen 0 拦、超长警消失，01、02、model-display-names 相对 dev 各只多一行 Changed by；突变 M5d 并回一行即复现超长警
- [major] config 里本 spec 的三条 pairs 已知项已失效，其中两条盖住了本步刚建的成对 · 证据：plan 第 13 步「删它们要改 `.sdd/config.json`（门禁文件），那一处交 owner 合」；突变 M1b、M1c 在 0b31954 上仍存活，已知项跳过数 4→5 · 交 owner：删这三条的提交 c200809 在 PR #100，门禁文件由 owner 合、要在 #99 之后合。已复审：c200809 只删这三条（known 590→587，JSON 合法），在它上面除 review 外没有新拦，M1b、M1c、M1d 都变红；把它套到 dev 的文档上 pairs 拦 3 条，先合会拦属实；合 plan 第 13 步写法，但 plan 没跟着改，见下面的新 blocker
- [建议] spec-check 只按节前缀配对，也不查「增补」和不标的区别 · 证据：突变 M1e、M2b、M2d、M4a、M4b、M4c 存活 · 不修：那是 sdd skill 的工具，不在本仓库改；本步 11 对评审已人工核过（已复审：理由属实，M1e 在 c200809 上仍存活；没记进「以后再说」或「待回流 skill」，见下面新建议）
- [建议] `Changed by` 括注里夹着说明、Changes 括注里有第二个 § · 证据：parse_ref_entry 的解析结果 · 已修 b0a3eb2：本 spec 的 Changes 括注里的点名不再带 §；01、02 已加的 Changed by 不动（已复审：第 3、4、6、9 条已去 §；不动 01、02 的理由属实，突变 M6d、M6e 在 `--staged` 下被 frozen 拦，M6c 同样的改动在 range 模式不拦，拦它的只有 pre-commit；第 10 条仍有第二个 §，见下面新建议）
- [建议] §点名 正文还写着 `Amended by:`，表 (f) 行写着 `Amends:` · 证据：spec.md §点名 首段与 (f) 行原文 · 已修 b0a3eb2：改成 `Changed by:`、`Changes:`（已复审：两处已改，首段「(a)(b)(f)(g) 在 02 那行，(f) 另在 01 那行」对照页头属实；剩下的 `Amends:` 只在 Revisions、§被否决的方案、修订记录里讲历史）
- [建议] `Replaces:` 的理由删掉后，§替换 02 的表现层条款 没写这条为什么在表现层范围内 · 无证据 · 不修：只算建议
- [blocker] 交 owner 之后 plan.md 没更新：「需要你」仍是「无」，第 13 步做完说明仍写「本 spec 改成一行 `Changes:`」「`.sdd/config.json` 不用改」，「交接」没提 PR #100 与合并顺序 · 证据：docs/spec-driven-dev.md §8「写「交 owner」时，在对话里和 plan 的「需要你」里写明规则或验收的原文、改的代价和不改的代价」；AGENTS.md 核心第 2 条「停下前重写 plan 的「当前」和「交接」」；`git diff 38e94bf 0b31954` 没动 plan.md，plan.md 最近一次改动是 4388778；`spec-check --status` 的「要你做的」里没有这条 · 待作者处置
- [建议] 第 10 条 `Changes` 括注仍有第二个 §（「新条款全文见 §替换 02 的表现层条款」），和 plan 第 13 步「每条只带一个 §」字面不符 · 证据：spec.md 页头第 9 行第 10 条，用 split_entries 切出后 § 数为 2；spec-check 只取第一个 §，检查不受影响 · 待作者处置
- [建议] 不修的前缀配对边界没记进「以后再说」也没记进「待回流 skill」 · 证据：§8「默认不修，处置写 `不修：<理由>`，记进「以后再说」」；§6「想改通用规则时…记成一条「待回流 skill」」；docs/spec-driven-dev.md「### 待回流 skill」仍是「（暂无）」，38e94bf..0b31954 没动 master-reference.md；突变 M1e 存活 · 待作者处置
- [建议] 修订记录 2026-11-28 第二行前后矛盾：前半「改写成一行 `Changes:`」后半「按目标分四行写」；写「哪一节」的那一段没写 §点名 正文；「「全文见……」不进 `Changes:`」与第 10 条仍带「新条款全文见 §…」不符 · 证据：spec.md §修订记录 该行原文与页头第 9 行 · 待作者处置

## 评审处置 · 2026-11-28（审过 0b31954 那一轮）

- [blocker] 交 owner 之后 plan.md 没更新 · 已修 b277dd4：「需要你」写明合 PR #100、规则原文、合并顺序（#97、#99 之后）、改与不改的代价；第 13 步说明改成四行 `Changes:` 与 PR #100；「交接」重写。`--status` 的「要你做的」里已有这条。
- [建议] 第 10 条 `Changes` 括注仍有第二个 § · 已修 b277dd4：改成「新条款全文见本 spec「替换 02 的表现层条款」一节」，不带 §。
- [建议] 前缀配对边界没记进「以后再说」 · 已修 b277dd4：总参考「以后再说」加一行，写明要改 sdd skill 的 spec-check。
- [建议] 修订记录那一行前后矛盾 · 已修 b277dd4：改写为「按 v2 改写成 `Changes:`，按目标分四行」，「哪一节」补上 §点名 正文，并写明替换那一条括注里指向新条款全文的半句保留、不带 §。

## 评审 · 2026-11-28 · 审过 c7fe624
结论：通过    评审：第三轮复审（本 PR 最后一轮），派发会话起的独立子 agent，Opus 5.5，新上下文，没看作者对话；读 log.md「评审 · 2026-11-28 · 审过 0b31954」与紧跟的「评审处置」（与 tenon-notes 里 review-0b31954.md 逐字相同）、`git diff 0b31954 c7fe624` 与逐提交 stat、`git show c200809`、plan「当前 / 需要你」第 13 步「交接」、spec 页头与 §点名 §修订记录、adee9a7 的旧 `Amends:` `Replaces:`、总参考「以后再说」、docs/spec-driven-dev.md §6 §8 §页头 §plan.md 与「本项目补充」、spec-check.py 的 parse_header、split_entries、parse_ref_entry、later_entries、status_todo、owner_pending、finding_disposition、classify_specs、chk_review、allowed_after_review；在作者工作区只读地跑 spec-check（默认与 `--base origin/dev` 都拦 0，纯文档范围 review 不查）与 `--status`，在 c7fe624 的临时 worktree 里跑突变与 `--index`，跑完已移除；没跑 live、没读钥匙串或 .env、没用 gh
突变：8 个，在 c7fe624 的临时 worktree 里跑：M5d 四行并回一行（1078 字）出超长警；M1b、M1c 仍存活、跳过 4→5（即交 owner 的那条 major，等 #100）；删 01 整行拦 2、删 02 整行拦 6；套 c200809 的 config 后 M1b 变红、删 01 整行拦 3；第 10 条加回第二个 § 不拦（只靠 plan 字面，预期）
发现：
- [blocker] 新 `Changes:` 一行 1074 字符，超过 600 字符上限 · 证据：docs/spec-driven-dev.md §5「新增的行不超过 600 个字符（`shape` 会警）」；spec-check 报 shape「claude-5-5-models/spec.md 有 1 个新增行超过 600 字符」 · 已修 b0a3eb2，已复审两轮：本轮四行 336、466、245、55 字符（第 9 行因 b277dd4 改第 10 条括注由 237 变 245），pairs 0 拦；突变 M5d 并回一行（1078 字）即复现超长警
- [major] config 里本 spec 的三条 pairs 已知项已失效，其中两条盖住了本步刚建的成对 · 证据：plan 第 13 步「删它们要改 `.sdd/config.json`（门禁文件），那一处交 owner 合」；突变 M1b、M1c 存活，已知项跳过数 4→5 · 交 owner：删这三条的提交 c200809 在 PR #100，门禁文件由 owner 在 #99 之后合。本轮复核：c200809 没变（只删 15 行）；M1b、M1c 在 c7fe624 上仍存活，套 c200809 的 config 后 M1b 变红、删 01 整行拦 3；plan「需要你」、第 13 步、「交接」已写明，`--status` 的「要你做的」与「交 owner 还没回」都列着；#100 在 #99 合入后只剩 config.json，没有归属 spec，review 不查，合并顺序走得通
- [建议] spec-check 只按节前缀配对，也不查「增补」和不标的区别 · 证据：突变 M1e、M2b、M2d、M4a、M4b、M4c 存活 · 不修：那是 sdd skill 的工具，不在本仓库改；本轮复核：已按上一轮建议记进总参考「以后再说」（b277dd4），四段齐全，第三段不以「挡」开头，`later_entries` 读成不挡上线
- [建议] `Changed by` 括注里夹着说明、Changes 括注里有第二个 § · 证据：parse_ref_entry 的解析结果 · 已修 b0a3eb2 与 b277dd4：本轮复核用 split_entries 切出 11 条 Changes，每条 § 数都是 1；01、02 已加的 Changed by 不动（frozen 理由上轮已复审）
- [建议] §点名 正文还写着 `Amended by:`，表 (f) 行写着 `Amends:` · 证据：spec.md §点名 首段与 (f) 行原文 · 已修 b0a3eb2：本轮复核 0b31954..c7fe624 没再动这一节，节内只剩 `Changed by:`、`Changes:`
- [建议] `Replaces:` 的理由删掉后，§替换 02 的表现层条款 没写这条为什么在表现层范围内 · 无证据 · 不修：只算建议（本轮照抄，没有重核）
- [blocker] 交 owner 之后 plan.md 没更新：「需要你」仍是「无」，第 13 步做完说明仍写「本 spec 改成一行 `Changes:`」「`.sdd/config.json` 不用改」，「交接」没提 PR #100 与合并顺序 · 证据：docs/spec-driven-dev.md §8「写「交 owner」时，在对话里和 plan 的「需要你」里写明规则或验收的原文、改的代价和不改的代价」；AGENTS.md 核心第 2 条「停下前重写 plan 的「当前」和「交接」」 · 已修 b277dd4：本轮复核「需要你」写明 PR #100、规则原文（plan 第 13 步）、合并顺序、改的代价（c200809 确为删 15 行）与不改的代价，第 13 步说明改成四行 `Changes:` 与 PR #100，「交接」重写，`--status` 列出这条；不改的代价写过头与 #97 已合两处见下面新建议
- [建议] 第 10 条 `Changes` 括注仍有第二个 §（「新条款全文见 §替换 02 的表现层条款」） · 证据：spec.md 页头第 9 行第 10 条，用 split_entries 切出后 § 数为 2 · 已修 b277dd4：本轮复核改成「新条款全文见本 spec「替换 02 的表现层条款」一节」，§ 数为 1，pairs 0 拦，第 9 行 245 字；把 § 加回去 spec-check 不拦（M10），这一条只靠 plan 字面守
- [建议] 不修的前缀配对边界没记进「以后再说」也没记进「待回流 skill」 · 证据：§8「默认不修，处置写 `不修：<理由>`，记进「以后再说」」；突变 M1e 存活 · 已修 b277dd4：本轮复核总参考「以后再说」新增一行，按同节格式写成什么事、谁做（lead）、什么时候（下次升级 sdd 或回流 skill 时）、出处（claude-5-5-models log 审过 38e94bf 那条），出处里带的两处分隔与上一行同写法；「待回流 skill」仍是暂无，§8 只要求记进「以后再说」
- [建议] 修订记录 2026-11-28 第二行前后矛盾：前半「改写成一行 `Changes:`」后半「按目标分四行写」；写「哪一节」的那一段没写 §点名 正文；「「全文见……」不进 `Changes:`」与第 10 条仍带「新条款全文见 §…」不符 · 证据：spec.md §修订记录 该行原文与页头第 9 行 · 已修 b277dd4：本轮复核该行 389 字，只说「按 v2 改写成 `Changes:`，按目标分四行」，「哪一节」写了 §点名 正文，替换那条保留的半句与页头一致，出处 `PR #99`；对照 adee9a7 的旧 `Amends:` 结尾「全文见 §对 01 的修补……」与 `Replaces:` 的理由，所说属实
- [建议] plan「需要你」的不改的代价写过头：写「以后有人删掉 01、02 那两行 `Changed by`，spec-check 不会拦」，实际删整行会拦，不拦的只是 01 §Provider 层、02 §对 01-provider-and-tape 的修补 这两条 · 证据：c7fe624 临时 worktree 里删 01 整行拦 2（§desktop 接线、§验收标准），删 02 整行拦 6；只删那两条（M1b、M1c）才 0 拦、跳过 4→5 · 已修 d276e79：改成只删 01 §Provider 层 或 02 §对 01-provider-and-tape 的修补 那一条才不拦，并注明删整行照样会拦
- [建议] plan「需要你」「交接」仍按 #97 没合写：「先等 #97、#99 合入」「自动合并已开」，而 #97 已于 14:53 合入 dev（4fd6f71），本地 origin/dev 14:59 已取到，早于 b277dd4（15:01） · 证据：`git log -1 4fd6f71`、`git reflog refs/remotes/origin/dev`、`git log -1 b277dd4` 的时间 · 已修 d276e79：「需要你」写 #97 已于 2026-11-28 合入、只等 #99；「交接」改成已合入 dev
- [建议] plan「需要你」没列 log 里另一条还没回的交 owner：2026-10-23「审过 4550a17」那条 [建议]（「本项目补充」第 9 条「厂商现状表……本次不创建」已过时） · 证据：`--status` 的「交 owner 还没回（claude-5-5-models）」列着它；§8「写「交 owner」时，在对话里和 plan 的「需要你」里写明」；本 PR 之前就如此，不是本轮引入 · 已修 d276e79：「需要你」加第 ② 条，写明原文、要 owner 点名批准、改与不改的代价
- 补记：「审过 c7fe624」那条记录最后三条建议的处置由「待作者处置」填成「已修 d276e79」（只改 plan.md，评审之后允许，不再复审）。

## 验收核对 · 2026-11-28（第 14 步）

- 依据：CI run 46120326933（PR #99 head 1b034bd，ci、e2e、sandbox-macos、spec-check、ci-ok 五项全绿；与合入后的 dev `48331f2` 同树）的三份测试报告，下载到 spec-check 读报告的位置（reports/vitest.json、reports/vitest-macos.json、apps/desktop/reports/e2e.json），跑 `python3 .sdd/spec-check.py --all --report`：trace 不再报本 spec 的验收没有用例点名或没有通过的用例。
- 逐条（报告里标题带「claude-5-5-models 验收 N」的用例，全部 passed）：
  - 1 definitions.test.ts 6 例 · 2 thinking-shapes.test.ts 8 例 · 3 compaction.test.ts 2 例 · 4 encoder-version.test.ts 4 例 · 5 thinking-shapes.test.ts 7 例 · 6 thinking-default.test.ts 1 例 · 7 evals-cost.test.ts 6 例 · 8 copy-coverage.test.ts 2 例 · 9 model-menu.spec.ts、text-fit-02.spec.ts 3 例 · 10 search-backends.test.ts 1 例 · 11 definitions.test.ts 1 例
  - 13 definitions.test.ts、model-families.test.ts 19 例 · 14 model-selection.test.ts 3 例 · 15 model-selection.test.ts、custom-vendor-runtime.test.ts、model-menu、provider-settings、recovery 等 24 例 · 16 model-selection、provider-routes、provider-catalogue、custom-vendor-runtime、model-menu 等 35 例 · 17 provider-settings.spec.ts、renderer-provider-model-selection.test.ts 15 例 · 18 config-route.test.ts、profile.test.ts 9 例
  - 12（live）：CI 不跑，见「实施 · 2026-11-28（第 12 步）」：官方组两行各 3 passed，新加三例 3 passed。
  - 19：presentation-r1 写第一把 key 的代码已在 dev，按第一种情形在本 spec 里验：provider-routes.test.ts 与 provider-settings.spec.ts 各 1 例通过。
- 全量 e2e：CI 的 e2e 作业跑的是 `xvfb-run pnpm test:e2e`（全量），278 expected、0 unexpected、0 flaky、6 skipped；跳过的 6 例都是 macOS 专属（composer-frame 2、navigation 1、stop-exit 3），与本 spec 无关。没有因会话不换变红的用例。
- 全量 vitest：6233 例，6092 passed、0 failed、141 pending；macOS 作业 401 例，384 passed、0 failed、17 pending。
- 这一步只核到「每条验收有点名用例且在 CI 上通过」；各用例的断言是否空心，留给第 15 步之后的评审逐条读。

## 评审 · 2026-11-28 · 审过 b93481c
结论：不通过    评审：派发会话起的独立子 agent，Opus 5.5，新上下文，没看作者对话；读评审包、log.md 全文、plan.md、`git diff 48331f2 b93481c`、总参考「以后再说」、docs/spec-driven-dev.md §6 §7 §8，逐条读验收 1–19 点名用例的断言和被测代码；用 `gh run download 46120326933` 取三份报告核对第 14 步，并在临时 worktree 里重跑 `spec-check --all --report`；没跑 live 与 e2e，没读钥匙串或 .env
突变：16 个，在 b93481c 的临时 worktree 里跑，跑完已移除；先跑 18 个相关测试文件，没变红的再跑全量（全量基线有 6 例与改动无关的环境红，比对时扣除）；首跑存活 7 个：R5、R6、R15 相关加全量都绿，R5 记为 major，R6、R15 记为建议；R18、R19 只有 e2e 能抓（需 e2e，未跑；CI 上分别由 model-menu.spec.ts 验收 9 与 provider-settings.spec.ts 验收 17 抓）；R21、R22 是等价突变（Ollama 与实例的行没有 family）；其余 9 个变红
发现：
- [major] 验收 16 的「`provider.list` 的行带 `family` 与 `familyNameKey`」只对 anthropic 的 Sonnet 5 一行断言，智谱四行丢掉这两个键没有用例发现；后果是智谱设置卡不再列「最新的 GLM…」指针项，§跟随最新「谁写指针」要求 anthropic、智谱两张卡都先列指针，e2e 也只看 anthropic 卡和 Ollama 卡 · 证据：突变 R5（provider-routes.ts `menuRow` 的条件加 `|| definition.wire === 'openai-chat'`）相关 434 例与全量 6233 例都绿，全量只红基线上同样红的 6 例 · 待作者处置
- [建议] log「验收核对 · 2026-11-28」写验收 13 有 19 例，CI 报告里标题点名验收 13 的用例是 10 例（model-families.test.ts 9 例加 definitions.test.ts「验收 1、13」1 例）；19 是把 describe 标题里的「验收 13」按 fullName 也算进去的 18 次再加 1；其余各条与全量 vitest、e2e 的数字都对得上 · 证据：`gh run download 46120326933` 的 vitest.json 按用例标题计数 · 待作者处置
- [建议] Sonnet 5、Haiku 4.5 的用途句（数据表和开放问题 4 定的「上一代 Sonnet（旧版）」「上一代 Haiku（旧版）」）没有用例钉住值；验收 8 只查键在不在和占位符，验收 9 只看两新行 · 证据：突变 R6 把两份 locale 的这两句改回本 spec 之前的值，相关与全量都绿，e2e 里也没有用例读这两句 · 不修：只算建议
- [建议] 验收 2「关思考且 tools 非空本地拒绝」只测了 effort high 一种 · 证据：突变 R15（拒绝条件加 `&& req.effort !== undefined`）相关与全量都绿 · 不修：只算建议
- [建议] 总参考「以后再说」新加的第一条（Haiku 4.5 公告）写「新开一步」，没写在哪里开：原 plan 写「在这里新开一步」，spec §Haiku 4.5 写「到时在本 spec 的 plan「以后」记一步」，plan 没有这一节，docs/spec-driven-dev.md §6 又说这一节的条目要做先写 spec · 无证据 · 不修：只算建议

## 评审处置 · 2026-11-28（审过 b93481c 那一轮）

- [major] 验收 16 只断言了 anthropic 一行的 `family`、`familyNameKey` · 已修 8bd3ba3：model-selection.test.ts「claude-5-5-models 验收 16」加智谱四行的 `family` 与 `familyNameKey`（写死期望值，不从被测代码算）；作者在工作区打上突变 R5（`menuRow` 条件加 `|| definition.wire === 'openai-chat'`），这例变红，已还原。
- [建议] 第 14 步记录里验收 13 写成 19 例 · 已修（本条所在提交）：见下面补记，原记录不改（log 只往后追加）。
- [建议] 两行旧版的用途句没有用例钉住 · 已修 8bd3ba3：copy-coverage.test.ts 加「keeps the purpose sentences open question 4 chose for the two legacy rows — claude-5-5-models 验收 8」，两份 locale 四句写死；突变 R6（改 zh-CN 那句）变红，已还原。
- [建议] 关思考带 tools 只测了 effort high · 已修 8bd3ba3：thinking-shapes.test.ts 那例改成 low、medium、high 与不传四种都要本地拒绝；突变 R15（拒绝条件加 `&& req.effort !== undefined`）变红，已还原。
- [建议] 「以后再说」的 Haiku 4.5 一条没写在哪里新开一步 · 已修 32d5b65：改成「先写一份 lite spec 再改」。
- 补记：「验收核对 · 2026-11-28（第 14 步）」里「13 definitions.test.ts、model-families.test.ts 19 例」应为 10 例（model-families.test.ts 9 例加 definitions.test.ts「验收 1、13」1 例）；19 是把 describe 标题里的「验收 13」也按完整标题算进去了。其余数字评审核过无误。

## 评审 · 2026-11-28 · 审过 902d979
结论：通过    评审：派发会话起的独立子 agent，Opus 5.5，新上下文，没看作者对话；读上一轮报告（tenon-notes 2026-11-28-c55-live/review-b93481c.md）、log.md「评审 · 审过 b93481c」与紧跟的「评审处置」、`git diff b93481c 902d979` 全文与四个提交各自的文件、spec §Haiku 4.5 与验收 2、8、16、docs/spec-driven-dev.md §6 §8、spec-check 的 review 检查，以及新断言的被测代码（provider-routes.ts `menuRow`、renderer provider-model-selection.ts `pointerRows`、anthropic-messages.ts 关思考一支、两份 locale）；在 902d979 的临时 worktree 里打突变，跑三个改动测试文件的 lint、格式与类型检查和 spec-check；没跑 live 与 e2e，没起 Electron，没读钥匙串或 .env，没改作者工作区
突变：17 个，在 902d979 的临时 worktree 里跑，跑完已移除；R5、R6、R15 照上一轮原样重打都变红，另出 14 个绕开新断言的变体；首跑存活 1 个：R5e（`menuRow` 只让 haiku 家族丢键）三个相关文件与全量 desktop vitest 都绿（全量只红上一轮记下的 6 例环境红），只有 CI 上 provider-settings.spec.ts「验收 17」的 11 个选项能抓（需 e2e，未跑），照上一轮 R18、R19 的算法不算存活；其余 16 个变红
发现：
- [major] 验收 16 的「`provider.list` 的行带 `family` 与 `familyNameKey`」只对 anthropic 的 Sonnet 5 一行断言，智谱四行丢掉这两个键没有用例发现；后果是智谱设置卡不再列「最新的 GLM…」指针项，§跟随最新「谁写指针」要求 anthropic、智谱两张卡都先列指针，e2e 也只看 anthropic 卡和 Ollama 卡 · 证据：突变 R5（provider-routes.ts `menuRow` 的条件加 `|| definition.wire === 'openai-chat'`）相关 434 例与全量 6233 例都绿，全量只红基线上同样红的 6 例 · 已修 8bd3ba3：model-selection.test.ts「claude-5-5-models 验收 16」加智谱四行写死的 `family` 与 `familyNameKey`；本轮复核 R5 原样、只丢 `glm-flashx`、只丢 `glm-4.6` 都变红；anthropic 主列表四行一起丢键由 provider-routes.test.ts「复现 claude-5-5-models 验收 16」的 Opus 5.5 一例抓到；只丢 haiku 家族时 vitest 全绿，由 CI 的 e2e「验收 17」兜着
- [建议] log「验收核对 · 2026-11-28」写验收 13 有 19 例，CI 报告里标题点名验收 13 的用例是 10 例（model-families.test.ts 9 例加 definitions.test.ts「验收 1、13」1 例）；19 是把 describe 标题里的「验收 13」按 fullName 也算进去的 18 次再加 1；其余各条与全量 vitest、e2e 的数字都对得上 · 证据：`gh run download 46120326933` 的 vitest.json 按用例标题计数 · 已修 902d979：log 末尾补记改为 10 例，原记录没改；本轮复核 model-families.test.ts 跑出 9 例，加 definitions.test.ts「验收 1、13」1 例，属实
- [建议] Sonnet 5、Haiku 4.5 的用途句（数据表和开放问题 4 定的「上一代 Sonnet（旧版）」「上一代 Haiku（旧版）」）没有用例钉住值；验收 8 只查键在不在和占位符，验收 9 只看两新行 · 证据：突变 R6 把两份 locale 的这两句改回本 spec 之前的值，相关与全量都绿，e2e 里也没有用例读这两句 · 已修 8bd3ba3：copy-coverage.test.ts 加一例，两份 locale 四句写死，与 spec 数据表一致；本轮复核 R6 原样与只改 en 的 Sonnet 句、只改 en 的 Haiku 句、只改 zh-CN 的 Haiku 句都变红；把 Haiku 4.5、Sonnet 5 行的 `purposeKey` 改指新行的句子，分别由 definitions.test.ts「验收 11」与 model-selection.test.ts「验收 16」抓到
- [建议] 验收 2「关思考且 tools 非空本地拒绝」只测了 effort high 一种 · 证据：突变 R15（拒绝条件加 `&& req.effort !== undefined`）相关与全量都绿 · 已修 8bd3ba3：thinking-shapes.test.ts 那例改成 low、medium、high 与不传四种都要本地拒绝，原来的 high 一例仍在其中，没有改弱；本轮复核 R15 原样与只放行 low、只放行 medium、只拦 high（不传按 high 算）、两个以上工具才拦都变红；xhigh、max 先被 `assertMayDisable` 拒，走不到这一支
- [建议] 总参考「以后再说」新加的第一条（Haiku 4.5 公告）写「新开一步」，没写在哪里开：原 plan 写「在这里新开一步」，spec §Haiku 4.5 写「到时在本 spec 的 plan「以后」记一步」，plan 没有这一节，docs/spec-driven-dev.md §6 又说这一节的条目要做先写 spec · 无证据 · 已修 32d5b65：那一行改成「先写一份 lite spec 再改」；本轮复核与 §6「要做哪一条，先写 spec」一致，四段格式不变，spec-check 的 later 不报；与 spec 原句的冲突见下一条
- [建议] 改写后的总参考那一行与 spec §Haiku 4.5「公告之后」末句相反：spec 写「撤行是表数据改动，不另写 spec，到时在本 spec 的 plan「以后」记一步」，总参考写先写一份 lite spec；§6 规定评审之后 spec 正文不能再改，本 spec 又要改 implemented，两处会一直并存，以后照 spec 做的人会去给已 implemented 的 plan 加步骤 · 无证据 · 已修 231a84a：总参考那一行加写「这一条取代该节末句「到时在本 spec 的 plan「以后」记一步」」，理由写明那份 spec 改 implemented 之后正文不动、plan 不再收步骤，按核心第 4 条要新写 spec；spec 正文不改

- 补记：「审过 902d979」那条记录最后一条建议的处置由「待作者处置」填成「已修 231a84a」（只改总参考「以后再说」一行，评审之后允许，不再复审）。

## owner 验收 · 2026-11-28（第 16 步）

- owner 在对话里说「claude-5-5-models 改 implemented」。依据：第 14 步验收核对（CI run 46120326933）、第 12 步 live 实跑、最终评审「审过 902d979」通过；#103 合入 dev（`4b09799`）后改 Status。改之前用 #103 head `8f37dc0` 的 CI run 46127268220 三份报告跑 spec-check：trace 0 拦，每条验收都有通过的用例；剩下的警是 spec、plan 篇幅超限与「开放问题（已定）」一节（记的是已定的选法，正文到处引用，保留）。

owner 回复：docs/spec-driven-dev.md「本项目补充」第 9 条已过时 · 「改」（2026-11-28 对话，答「这一节要不要改」）。已改：那一行写明厂商现状表在 `docs/reference/vendors.md`，同一句里同样过时的「overview 另开 PR」一并改成已建。
owner 回复：config 里本 spec 的三条 pairs 已知项已失效 · 没有原话：owner 2026-11-28 自己合入 PR #100（`6cf1b15`），删掉了这三条。
