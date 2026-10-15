# Claude 5.5 两行 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。「验收 N」指 spec §验收标准，「FN」指 §事实与出处，「开放问题 N」指 §开放问题。spec 还是 `draft`：第 0 步做完之前不动代码。

## 开工前读

- **来源**：只读公开页面（`platform.claude.com/docs`）和仓库；不读逆向得来的材料（master-reference.md:614）。新核到的事实写进代码注释：URL 加读的日期，照 anthropic.ts:67-94。
- **key**：只有第 7 步要官方 key（开放问题 6 选 A 时）。从登录钥匙串 `tenon-live-anthropic` 读，只进那一次命令的环境；读前提醒 owner（macOS 会弹窗）。不进 `.env.local`、shell profile、命令字面量、Tape、日志和本文件。
- **机器约束**：vitest 一律 `--maxWorkers=2`；同一时刻最多一个 Electron（e2e、live 都算），起 Electron 用 `env -u ELECTRON_RUN_AS_NODE`。
- **突变**：每步列的突变逐个做一次——把生产代码改坏，确认对应测试变红，再改回——结果记在该步。没变红的补测试。
- **门禁**：每步结束跑下面「命令」的前两行（第二行是全量 vitest），仓库每步结束都是绿的。

## 命令

```sh
pnpm format:check && pnpm lint && pnpm typecheck
pnpm vitest run --maxWorkers=2
pnpm build && env -u ELECTRON_RUN_AS_NODE pnpm test:e2e model-menu.spec.ts text-fit-02.spec.ts
# 第 7 步：官方组，每个模型一次，只跑官方组；key 只在这条命令的环境里从钥匙串读出
TENON_LIVE_ANTHROPIC_OFFICIAL_MODEL=claude-sonnet-5-5 TENON_LIVE_ANTHROPIC_OFFICIAL_KEY="$(security find-generic-password -s tenon-live-anthropic -w)" env -u ELECTRON_RUN_AS_NODE pnpm test:live --grep "live provider · anthropic official"
# 第 7 步：只跑本 spec 新加的几例（标题都含「Sonnet 5.5」或「Haiku 5.5」，现有 live 用例的标题都不含）
TENON_LIVE_OFFICIAL_AGENT=1 TENON_LIVE_ANTHROPIC_OFFICIAL_KEY="$(security find-generic-password -s tenon-live-anthropic -w)" env -u ELECTRON_RUN_AS_NODE pnpm test:live --grep "Sonnet 5\.5|Haiku 5\.5"
```

## 步骤

- [ ] 0. owner 定开放问题 1–8。之后按选法同步改 spec 的 `Amends:`、`Replaces:`、§对 01 的修补、§对 02 的修补、§内置模型表的数据改动、§点名、不变量与验收，写 `Revisions:`（日期、各题选法），`Status: ready`。01、02 顶部各加一行 `Amended by:`，正文不动；§点名 里实际触发的各项（推荐项下有 (a)(b)）连同 owner 的确认都在 02 的那行 `Amended by:` 里点出，owner 不认可的项改走 supersede（spec §点名 的读法）。开放问题 4 选 A 或 C 时，02 §模型菜单与输入框 里「更多模型 ›」那一行的行末接指针「（<owner 定的日期> 起由 [claude-5-5-models](../../features/claude-5-5-models/spec.md) §替换 02 的表现层条款 取代：括注改为照实列出这一档的行）」，02 顶部加 `Clauses replaced by:`（spec-driven-dev 第三个例外）。
- [ ] 1. 落地前核对，只读公开页面：
  - F21 两页的原文还在（两新行 `supportsStreamingToolCalls: true` 靠它）。对不上时停下，spec 记 `Revisions:`，并按 01 spec:353「凡未能从文档或一次本地探测确认的字段，在 `plan.md` 记一笔」记进本文件。（`displays` 与 `supportsVision` 已由 F18 核过。）
  - 核到的 URL 与日期留给第 5 步的注释。
- [ ] 2. 类型：packages/kernel/src/provider/types.ts 加 `pricing.longPrompt`、`ThinkingSpec.offType`（`'between_tools'`）；开放问题 3 选 B 或 C 时另加 `ThinkingSpec.samplingExact`（都按第 0 步的选法），注释引本 spec。
  - 测试：由第 3、4、6 步覆盖，本步只跑 `pnpm typecheck`。
- [ ] 3. Anthropic 编码器：packages/kernel/src/provider/wire/anthropic-messages.ts 的 `thinkingShape` 关思考的 switch（:307-313）只在 `adaptive-gated` 一支写 `{ type: spec.offType ?? 'disabled' }`；`budget`、`adaptive` 两支遇到行上有 `offType` 时抛 `ProviderInvalidArgumentError`（照 :286-292 的表错误写法），否则照旧写 `disabled`；`offType` 为 `between_tools`、关思考且 `tools` 非空时抛 `ProviderInvalidArgumentError`；`ANTHROPIC_MESSAGES_ENCODER.version` 3 → 4（:132；开放问题 1 选 C 时不升，本步只剩测试），上方注释补一句第 4 版改了什么。
  - 测试：
    - thinking-shapes.test.ts 加两行的关思考用例（验收 2，含带 tools 的拒绝；行先用测试里的本地 `ModelInfo`，第 5 步换成表里的行），另用合成的 budget 行、adaptive 行各带 `offType: 'between_tools'` 测关思考本地拒绝；
    - encoder-version.test.ts：`ANTHROPIC_ROW`、`goldenRequest`、`fieldsGoldenRequest` 都不动。另加 `BETWEEN_TOOLS_ROW`（`adaptive-gated`、`disableMaxEffort: 'high'`、`offType: 'between_tools'`）和第三个固定请求 `offGoldenRequest`（同样的历史，`thinking: { enabled: false }`，effort `'high'`，不带 `tools`），它有自己的表 `GOLDEN_OFF = { 4: … }`。`GOLDEN['anthropic-messages']` 与 `GOLDEN_FIELDS` 各追加第 4 行，值等于第 3 行。原来按表查重（同表两行同哈希 = 空升版）改为跨表检查：每升一版（v > 1），至少有一张表在 v 的哈希与 v − 1 不同，或 v 是它的第一行；当前版本取所有表的最大版本号。`GOLDEN_WIRE_HASH` 仍断言 `ANTHROPIC_ROW`，值不变（验收 4）；
    - packages/kernel/test/provider/vendor-blocks.test.ts:538 的 `version: 3` 改为 4；
    - packages/kernel/test/provider/definitions.test.ts:851 的 `anthropic-messages' ? 3 : 2` 改为 4，注释补「4 加了 offType」。
    - 改完跑本步的门禁。
  - 突变：
    - ① 忽略 `offType`、恒写 `disabled` → 验收 2 红；
    - ② `between_tools` 跳过 `assertMayDisable` → xhigh / max 用例红；
    - ③ 关思考时把 `display` 写进对象 → 红；
    - ④ 版本不加一 → 金样红；
    - ⑤ 去掉「关思考且 tools 非空」的检查 → 验收 2 带 tools 的用例红；
    - ⑥ budget / adaptive 两支也写 `offType ?? 'disabled'`、不拒 → 合成行的用例红。
- [ ] 4. 采样守卫：packages/kernel/src/provider/wire/shared.ts:225-241 按开放问题 3。选 A：所有 `samplingDefaultsOnly` 的行，`top_p` 的判定由 `>= 0.99` 改为 `=== 0.99`，另拒 `temperature` 与 `top_p` 同发；同步改 shared.ts:219-224 与 types.ts:117 的注释、thinking-shapes.test.ts:331-337（spec §点名 (a)）。选 B 或 C：同样的规则只在 `samplingExact` 为 true 时用；选 B 时第 5 步给四行旧行加 `samplingExact`，thinking-shapes.test.ts:331-337 同样改。
  - 测试：thinking-shapes.test.ts（验收 5）。选 B 或 C 时另加：只有 `samplingExact`、没有 `samplingDefaultsOnly` 的行不拒；有 `samplingDefaultsOnly`、没有 `samplingExact` 的行（C 下用 Opus 5.5，B 下用合成行）单独带 `top_p` 1、`top_p` 0.995 都不抛。
  - 突变：① 判定改回 `topP >= 0.99` → `top_p` 1 的用例红；② 去掉同发检查 → 同发用例红；选 B 或 C 时另有 ③ 读 `samplingExact` 时不看 `samplingDefaultsOnly` → 「只有 `samplingExact`」那例红；④ 精确的 `top_p` 判定不看 `samplingExact`（同发检查仍看）→ 「没有 `samplingExact` 的行收 `top_p` 1」那例红。
- [ ] 5. 数据与文案：packages/kernel/src/provider/definitions/anthropic.ts 加两行（取值见 spec §内置模型表的数据改动，加第 1 步的结果），行序与 `listing` 照开放问题 4。注释按 spec 数据表「注释」一行改：文件头记 2026-10-15 的来源；`thinkingSpec` 注释段；Sonnet 5、Haiku 4.5 的 Legacy 一句；Haiku 4.5 的核查日期，5 选 A 时还有 A16 那一句。apps/desktop/src/i18n/locales/zh-CN/common.json 与 en/common.json 的 `model.name`、`model.purpose` 加新键、按开放问题 4 改值。
  - 测试：
    - definitions.test.ts（验收 1）：改「puts Opus 5.5 first」与「declares each Anthropic row’s thinking mode」两条的期望表；「M6 不变量 17」的 flagged 表与逐行判断补两新行；加两行的整行断言，以及 `offType`、`longPrompt` 的表规则（开放问题 3 选 B 或 C 时还有 `samplingExact`）；
    - thinking-shapes.test.ts 把第 3、4 步的用例换成表里的行；
    - thinking-default.test.ts（验收 6）；compaction.test.ts（验收 3）；copy-coverage.test.ts（验收 8）；search-backends.test.ts（验收 10，用改了 id 的 Sonnet 5.5 行）；
    - apps/desktop/test/model-selection.test.ts:144-152 的 `listing` 期望按开放问题 4 改（4A 下 Sonnet 5 是 `'more'`）；:153-157 用 `row.id.startsWith('claude-haiku')` 找 Haiku 4.5，新行排在它前面时会先找到有五档的 Haiku 5.5，改成 `row.id === 'claude-haiku-4-5-20251001'`，另加一条断言 Haiku 5.5 的 `effortLevels` 是 low…max、`defaultEffort` 是 `'medium'`；
    - model-menu.spec.ts（验收 9）。4A 下，:63-83、:188、:519 三处直接在主列表点或断言 Sonnet 5、Haiku 4.5 的行，改成先点 `model-more`，或者换成新行；:81「Haiku thinks on a budget」是 budget 模式在界面上唯一的覆盖，要留着；
    - 4B 下 text-fit-02.spec.ts:58 的行数 5 改为 7；
    - Haiku 4.5 行除注释与 `listing` 外不变、`modelWireHash` 不变（验收 11）。
  - 突变：① Haiku 5.5 的 `defaultDisplay` 写成 `'summarized'`（周报的错）→ 验收 1 红；② Sonnet 5.5 去掉 `offType` → 验收 3 红；③ Sonnet 5.5 去掉 `forcedToolChoice: false` → 验收 1、10 红；④ 任一新行去掉 `checksThinkingPrefix` → 验收 1 红；⑤ 把 Sonnet 5.5 排到第一行 → 验收 1、9 红。
- [ ] 6. 费用：apps/desktop/evals/cost.ts 的 `costOf`（:46-56）先算提示长度 `usage.input + usage.cacheRead + usage.cacheWrite`（与 `inputTotalOf` 同口径），大于 `pricing.longPrompt.overTokens` 时四项都换成本档单价，档内缺缓存价按本档输入价；文件头注释补一条引本 spec。
  - 测试：evals-cost.test.ts（验收 7，含档内缺缓存价的构造用例），现有用例不改。
  - 突变：① `>` 改 `>=` → 恰为 100 000 的用例红；② 提示长度只算 `input` → 靠缓存读推过阈值的用例红；③ 只有输入按高档、输出仍按低档 → 红；④ 档内缺缓存价时退回基础档的缓存价 → 档内缺缓存价的用例红。
- [ ] 7. 〔开放问题 6 选 A〕官方 live 冒烟（验收 12）。先提醒 owner 钥匙串会弹窗。
  - 官方组两次，`TENON_LIVE_ANTHROPIC_OFFICIAL_MODEL` 分别取 `claude-sonnet-5-5`、`claude-haiku-5-5`（命令见上，带 `--grep`，不连带跑搜索探测、前缀探测和智谱各组）。
  - apps/desktop/e2e/live-official-agent.spec.ts 照「Opus 5.5 performs actual threshold compaction in the product loop」加两例。官方协议接缝都用 `record` 模式：`strict` 会把 `thinking` 改写成带 `block_binding` 的 adaptive（apps/desktop/src/main/host/official-protocol-test-seam.ts:52-58），盖掉 `between_tools`；`evidence()` 相应传 `strict: false`。两例都在压缩前先跑一轮工具调用：照「performs a real WebSearch round trip and workspace Read smoke」那例，`startTask` 进一个工作区，让模型 Read 一个文件一次并 `allow`，这样摘要请求会回放一对 tool_use / tool_result（生产里最常见的形态；原 Opus 例每轮都不用工具，没覆盖到）。判据分两处读（spec 验收 12）：
    - 「Sonnet 5.5 performs actual threshold compaction after choosing low effort」：Read 那一轮之后用 `session.selectModel` 把 effort 设成 `'low'`（文件里的 `choose()` 传的是 `effort: null`，这里另传 low），再跑两轮，然后照原例带 `TENON_E2E_COMPACTION_THRESHOLD=1` 重启触发压缩。线上（重启后 `evidence(app, false, journal)` 的 `last.wire[0]` 是摘要请求）：`body.tools` 没有，`body.thinking` 是 `{ type: 'between_tools' }`，`body.output_config.effort === 'high'`，`status === 200`。Tape：摘要 attempt（`provider/attempt_completed` 带 `compaction` 的那条）的快照是 `{ thinking: { enabled: false }, effort: 'high' }`；压缩后主请求的快照带 `effort: 'low'`。
    - 「Haiku 5.5 performs actual threshold compaction at its default effort」：同样先跑 Read 一轮，不选档。线上：摘要请求不带 `tools`，`body.thinking` 是 `{ type: 'disabled' }`，effort `high`，`status === 200`。Tape：摘要 attempt 的快照同上。
  - 同一文件加一例「Sonnet 5.5 and Haiku 5.5 record cache reads and thinking text」，record 模式，两个模型各发两次一道要推理、不用工具的题，例如「Determine how many positive integers below 500 have exactly six positive divisors, and how many of those are odd. Do not use tools. Reply with the two numbers, then DIVISORS_DONE.」，用 `completed(page, 'DIVISORS_DONE')` 等。不照搬 live-provider.spec.ts:1699 的原题：它要求调 `lookup`，那是裸协议测试自己定义的工具，产品循环里没有。从 `tapeFacts(userData)` 读：
    - 第一个请求先断言提示长度（input + cacheRead + cacheWrite）大于 512（F20）、`usage.cacheWriteTokens` 大于 0，再断言第二个请求 `provider/attempt_completed` 的 `usage.cacheReadTokens` 大于 0；
    - 消息里出现思考块时，文本非空。
  - 任一摘要请求 400：停下，不改代码，spec 回 `draft`，按 spec §已有规则「逐条 effort」的退路请 owner 定（§点名 (e)）。
  - 记进本文件：模型、日期、各请求的状态码与用量、摘要请求的 `thinking` 与 effort、思考文本是否非空、第二个请求的缓存读。不记 key。
- [ ] 8. 对照验收 1–12 逐条核对，结果记在本文件。
- [ ] 9. 清理：临时探针、调试输出、live 记录里不该留的内容；`git status` 干净。
- [ ] 10. spec 的 `Status` 改为 `implemented`。

## 以后（不在本 spec 的完成条件里）

- 弃用页出现 Haiku 4.5 条目时，按开放问题 5 的选法执行（spec §Haiku 4.5），在这里新开一步，记日期和做法。
- 开放问题 7 选 A 时：以后要改 02 H10 的压缩绝对上限（`COMPACT_ABS_CAP`），另写 amend，把 Haiku 5.5 在 100 000 以上按高档计价这件事算进去。

## 交接

- 2026-10-15：spec 与本计划起草完，等 owner 定开放问题 1–8。代码没动。
- 2026-10-15：按评审就地修订 spec 与本计划（spec `Revisions:` ①–⑨）。代码没动。
- 2026-10-15：按第二轮评审就地修订 spec 与本计划（spec `Revisions:` ⑩–⑮）：第 1、3、4、5、7 步随改。代码没动。
