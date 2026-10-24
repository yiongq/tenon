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
