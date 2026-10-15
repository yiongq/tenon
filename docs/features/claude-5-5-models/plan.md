# Claude 5.5 两行 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。「验收 N」指 spec §验收标准，「FN」指 §事实与出处，「开放问题 N」指 §开放问题。spec 还是 `draft`：第 0 步做完之前不动代码。

## 开工前读

- **来源**：只读公开页面（`platform.claude.com/docs`）和仓库；不读逆向得来的材料（master-reference.md:614）。新核到的事实写进代码注释：URL 加读的日期，照 anthropic.ts:67-94。
- **key**：只有第 7 步要官方 key（开放问题 6 选 A 时）。从登录钥匙串 `tenon-live-anthropic` 读，只进那一次命令的环境；读前提醒 owner（macOS 会弹窗）。不进 `.env.local`、shell profile、命令字面量、Tape、日志和本文件。
- **机器约束**：vitest 一律 `--maxWorkers=2`；同一时刻最多一个 Electron（e2e、live 都算），起 Electron 用 `env -u ELECTRON_RUN_AS_NODE`。
- **突变**：每步列的突变逐个做一次——把生产代码改坏，确认对应测试变红，再改回——结果记在该步。没变红的补测试。
- **门禁**：每步结束跑下面「命令」的前两行，仓库每步结束都是绿的。

## 命令

```sh
pnpm format:check && pnpm lint && pnpm typecheck
pnpm vitest run packages/kernel/test/provider packages/kernel/test/loop/compaction.test.ts packages/kernel/test/loop/thinking-default.test.ts packages/kernel/test/tools/search-backends.test.ts apps/desktop/test/evals-cost.test.ts apps/desktop/test/copy-coverage.test.ts --maxWorkers=2
pnpm build && env -u ELECTRON_RUN_AS_NODE pnpm test:e2e model-menu.spec.ts
# 第 7 步，每个模型一次；key 只在这条命令的环境里从钥匙串读出
TENON_LIVE_ANTHROPIC_OFFICIAL_MODEL=claude-sonnet-5-5 TENON_LIVE_ANTHROPIC_OFFICIAL_KEY="$(security find-generic-password -s tenon-live-anthropic -w)" env -u ELECTRON_RUN_AS_NODE pnpm test:live
```

## 步骤

- [ ] 0. owner 定开放问题 1–8。之后：spec 写 `Revisions:`（日期、各题选法），按选法改 §对 01 的修补 与 §内置模型表的数据改动，`Status: ready`；01、02 顶部各加一行 `Amended by:`，正文不动；选了非推荐项的，§点名 里对应的行在 02 的那行 `Amended by:` 里点出。
- [ ] 1. 落地前核对，只读公开页面：
  - Sonnet 5.5 迁移页的表格是否收 `display: 'summarized'`。收 → `displays` 写两值；核不到 → 这一行不写 `displays`、`defaultDisplay`（循环就不传 display），spec 记 `Revisions:`。
  - 两新行的 `supportsVision`、`supportsStreamingToolCalls`：models overview 那句 "all current models support … vision, and tool use"（anthropic.ts:9-12 引过）是否仍覆盖它们。核不到的位按 01 spec:706「能力不明就关」写 false，spec 记 `Revisions:`。
  - 核到的 URL 与日期留给第 5 步的注释。
- [ ] 2. 类型：packages/kernel/src/provider/types.ts 加 `pricing.longPrompt`、`ThinkingSpec.offType`、`ThinkingSpec.samplingExact`（按第 0 步的选法），注释引本 spec。
  - 测试：由第 3、4、6 步覆盖，本步只跑 `pnpm typecheck`。
- [ ] 3. Anthropic 编码器：packages/kernel/src/provider/wire/anthropic-messages.ts 的 `thinkingShape` 关思考一支写 `{ type: spec.offType ?? 'disabled' }`（:308-313）；`ANTHROPIC_MESSAGES_ENCODER.version` 3 → 4（:132），上方注释补一句第 4 版改了什么。
  - 测试：thinking-shapes.test.ts 加两行的关思考用例（验收 2；行先用测试里的本地 `ModelInfo`，第 5 步换成表里的行）。encoder-version.test.ts 照 M6 对 openai-chat 第 2 行的写法：`ANTHROPIC_ROW` 加 `offType: 'between_tools'`，anthropic 线的金样请求与字段金样请求都改为关思考，两张表各追加第 4 行；另断言原请求（不关思考、行不带 `offType`）仍是第 3 行；`GOLDEN_WIRE_HASH` 的断言改用不带 `offType` 的行，值不变（验收 4）。
  - 突变：① 忽略 `offType`、恒写 `disabled` → 验收 2 红；② `between_tools` 跳过 `assertMayDisable` → xhigh / max 用例红；③ 关思考时把 `display` 写进对象 → 红；④ 版本不加一 → 金样红。
- [ ] 4. 采样守卫：packages/kernel/src/provider/wire/shared.ts:225-241 在 `samplingExact` 为 true 时另拒 `top_p !== 0.99` 与 `temperature`、`top_p` 同发。开放问题 3 选 C 时改为对所有 `samplingDefaultsOnly` 的行，同步改 types.ts:117 的注释与 thinking-shapes.test.ts:331-337（spec §点名 (a)）。
  - 测试：thinking-shapes.test.ts（验收 5），另加一例：只有 `samplingExact`、没有 `samplingDefaultsOnly` 的行不拒。
  - 突变：① 判定改回 `topP >= 0.99` → `top_p` 1 的用例红；② 去掉同发检查 → 同发用例红；③ 读 `samplingExact` 时不看 `samplingDefaultsOnly` → 上面另加的那例红。
- [ ] 5. 数据与文案：packages/kernel/src/provider/definitions/anthropic.ts 加两行（取值见 spec §内置模型表的数据改动，加第 1 步的结果），行序与 `listing` 照开放问题 4，注释三处（文件头记 2026-10-15 的来源、`thinkingSpec` 注释段、Haiku 4.5 的核查日期）；apps/desktop/src/i18n/locales/zh-CN/common.json 与 en/common.json 的 `model.name`、`model.purpose` 加新键、按开放问题 4 改值。
  - 测试：definitions.test.ts（验收 1：改「puts Opus 5.5 first」与「declares each Anthropic row’s thinking mode」两条的期望表，加两行的整行断言与 `offType`、`samplingExact`、`longPrompt` 的表规则）；thinking-shapes.test.ts 把第 3、4 步的用例换成表里的行；thinking-default.test.ts（验收 6）；compaction.test.ts（验收 3）；copy-coverage.test.ts（验收 8）；search-backends.test.ts（验收 10）；model-menu.spec.ts（验收 9）；Haiku 4.5 行除注释外不变（验收 11）。
  - 突变：① Haiku 5.5 的 `defaultDisplay` 写成 `'summarized'`（周报的错）→ 验收 1 红；② Sonnet 5.5 去掉 `offType` → 验收 3 红；③ Sonnet 5.5 去掉 `forcedToolChoice: false` → 验收 1 红；④ 任一新行去掉 `checksThinkingPrefix` → 验收 1 红；⑤ 把 Sonnet 5.5 排到第一行 → 验收 1、9 红。
- [ ] 6. 费用：apps/desktop/evals/cost.ts 的 `costOf`（:46-56）先算提示长度 `usage.input + usage.cacheRead + usage.cacheWrite`（与 `inputTotalOf` 同口径），大于 `pricing.longPrompt.overTokens` 时四项都换成本档单价，档内缺缓存价按本档输入价；文件头注释补一条引本 spec。
  - 测试：evals-cost.test.ts（验收 7），现有用例不改。
  - 突变：① `>` 改 `>=` → 恰为 100 000 的用例红；② 提示长度只算 `input` → 靠缓存读推过阈值的用例红；③ 只有输入按高档、输出仍按低档 → 红。
- [ ] 7. 〔开放问题 6 选 A〕官方 live 冒烟（验收 12）。先提醒 owner 钥匙串会弹窗。
  - 官方组两次，`TENON_LIVE_ANTHROPIC_OFFICIAL_MODEL` 分别取 `claude-sonnet-5-5`、`claude-haiku-5-5`（命令见上）。
  - Sonnet 5.5 的阈值压缩：照 apps/desktop/e2e/live-official-agent.spec.ts「Opus 5.5 performs actual threshold compaction in the product loop」加一例，跑时另带 `TENON_LIVE_OFFICIAL_AGENT=1`。官方协议接缝要用 `record` 模式：`strict` 会把 `thinking` 改写成带 `block_binding` 的 adaptive（apps/desktop/src/main/host/official-protocol-test-seam.ts:52-58），盖掉 `between_tools`。
  - 记进本文件：模型、日期、各请求的状态码、摘要请求的 `thinking`、Haiku 5.5 的思考文本是否非空、第二个请求的缓存读。不记 key。
- [ ] 8. 对照验收 1–12 逐条核对，结果记在本文件。
- [ ] 9. 清理：临时探针、调试输出、live 记录里不该留的内容；`git status` 干净。
- [ ] 10. spec 的 `Status` 改为 `implemented`。

## 以后（不在本 spec 的完成条件里）

- 弃用页出现 Haiku 4.5 条目时，按开放问题 5 的选法执行（spec §Haiku 4.5），在这里新开一步，记日期和做法。

## 交接

- 2026-10-15：spec 与本计划起草完，等 owner 定开放问题 1–8。代码没动。
