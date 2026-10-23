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
- [建议] 第 13 步的示例把带点名项的节也标成「增补」；「不切 release 分支」那一行没有删除步骤 · 已修 本提交（只改 plan.md）
- [建议] spec-check 提示改了 packages/kernel/src/index.ts 却没动 overview.md · 不修：本段只新增两个导出函数，模块边界与 overview 的术语不变；第 6 步把家族接进内置表时再看 overview §术语 要不要加「家族、代次、指针」
结论：通过
突变：文档部分 0 个；代码部分 12 个，全部变红，0 个存活（见「实施 · 2026-10-23」）
