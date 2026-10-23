# claude-5-5-models · plan

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计；实施、验收、评审记录与花费写进 [log.md](./log.md)。「验收 N」指 spec §验收标准，「FN」指 §事实与出处，「开放问题 N」指 §开放问题（已定）。spec 是 `ready`（owner 2026-10-15 接受，spec `Revisions:` ㊴）。

## 当前 / 需要你

当前：第 0.1、1–8 步做完（第 2–5 步 PR #67 已合入；第 1、6–8 步在分支 `feat/claude-5-5-seg2`）。下一步第 9 步（desktop 主进程的解析与写指针，含会话不换模型与一批 e2e 改写），然后第 10、11 步。第 12 步开跑前会先问你（读钥匙串会弹窗，要花钱）。
需要你：无
授权：本 spec 由 Codex 实现的 PR，lead 评审、CI 绿后由 lead 开自动合并；碰门禁文件、涉及花费或安全取舍、改 Status 时仍问 owner · 到本 spec `implemented` 为止 · 「一路推进 (Recommended)」（2026-10-23 问卷，题目「Codex 的 PR 经我评审、CI 绿了之后，我自己开自动合并，还是每个都先问你？」）

## 开工前读

- **来源**：只读公开页面（`platform.claude.com/docs`）和仓库；不读逆向得来的材料（master-reference.md:614）。新核到的事实写进代码注释：URL 加读的日期，照 anthropic.ts:67-94。
- **key**：只有第 12 步要官方 key（开放问题 6 定 A）。从登录钥匙串 `tenon-live-anthropic` 读，只进那一次命令的环境。**读之前先提醒 owner：macOS 会弹窗**，等 owner 回话再跑。不进 `.env.local`、shell profile、命令字面量、Tape、日志和本文件。
- **机器约束**：vitest 一律 `--maxWorkers=2`；同一时刻最多一个 Electron（e2e、live 都算），起 Electron 用 `env -u ELECTRON_RUN_AS_NODE`；e2e 走 CI 草稿 PR 或 Lima VM，不在 owner 的 Mac 上起窗口。
- **突变**：每步列的突变逐个做一次——把生产代码改坏，确认对应测试变红，再改回——结果记进 log.md（编号写成「第 N 步 ①」）。没变红的补测试。
- **测试点名**：每条验收至少有一个用例标题带「claude-5-5-models 验收 N」（（live）的验收 12 也要有点名它的 live 用例）；靠改已有用例来验的，在原标题上补，例如「presentation-r1 验收 12、claude-5-5-models 验收 19」；改弱已有测试的每一处在 log.md 记一行 `测试改动：文件 · 用例 · 为什么`。
- **行号**：本文件与 spec 写于 2026-10-15，此后 04 与 presentation-r1 合入，文中的 `文件:行号` 多半已偏，按函数名、类型名、用例标题定位。新写的行不再写行号。
- **门禁**：每步结束跑下面「命令」的前两行（第二行是全量 vitest），仓库每步结束都是绿的。
- **与 presentation-r1 的先后**：已定。presentation-r1 于 2026-10-22 先合入（PR #55，`implemented`），`dev` 上写第一把 key 的代码只有钉住一支，所以第 11 步实现它 §对 02 的修补 第 1 条已写的「有」一支，跑验收 19（就是它验收 12 的指针一例）。本 spec 合入之前不切 release 分支（spec §跟随最新「迁移」）。

## 命令

```sh
pnpm format:check && pnpm lint && pnpm typecheck
pnpm vitest run --maxWorkers=2
pnpm build && env -u ELECTRON_RUN_AS_NODE pnpm test:e2e model-menu.spec.ts text-fit-02.spec.ts provider-settings.spec.ts recovery.spec.ts
# 第 9 步末与第 14 步：全量 e2e，找别的因会话不换变红的用例
pnpm build && env -u ELECTRON_RUN_AS_NODE pnpm test:e2e
# 第 12 步：官方组，每个模型一次，只跑官方组；key 只在这条命令的环境里从钥匙串读出（先提醒 owner）
TENON_LIVE_ANTHROPIC_OFFICIAL_MODEL=claude-sonnet-5-5 TENON_LIVE_ANTHROPIC_OFFICIAL_KEY="$(security find-generic-password -s tenon-live-anthropic -w)" env -u ELECTRON_RUN_AS_NODE pnpm test:live --grep "live provider · anthropic official"
# 第 12 步：只跑本 spec 新加的几例（标题都含「Sonnet 5.5」或「Haiku 5.5」，现有 live 用例的标题都不含）
TENON_LIVE_OFFICIAL_AGENT=1 TENON_LIVE_ANTHROPIC_OFFICIAL_KEY="$(security find-generic-password -s tenon-live-anthropic -w)" env -u ELECTRON_RUN_AS_NODE pnpm test:live --grep "Sonnet 5\.5|Haiku 5\.5"
```

## 步骤

- [x] 0. owner 定开放问题与接受 spec：2026-10-15 已定（1A、2A、3A、5A、6A、7A、8A；4 由「跟随最新」取代），spec 已按定法同步（`Revisions:` ⑯–⑳）。同日 owner 经问卷单独确认 §点名 (g) 取 A，spec 改 `Status: ready`（`Revisions:` ㊴，`Owner` 行已写）。旧 spec 顶部要加的几行不在这一步，在第 13 步。
- [x] 0.1 按 sdd v2 接入（ADR-004 A5）：spec 页头补 `Tier`，`Replaces:`、`Related:`、验收 12 的标记按 v2 澄清并记修订记录；本文件改成 v2 的形状；新建 log.md。
- [x] 1. 落地前核对，只读公开页面：
  - F21 两页的原文还在（两新行 `supportsStreamingToolCalls: true` 靠它）。对不上时停下，spec 记修订记录，并按 01 §内置 provider「凡未能从文档或一次本地探测确认的字段，在 `plan.md` 记一笔」记进 log.md。（`displays` 与 `supportsVision` 已由 F18 核过。）
  - 核到的 URL 与日期留给第 6 步的注释。
  - 建厂商现状表 `docs/reference/vendors.md`，先只收 Anthropic：本 spec 用到的每条能力（F1–F21）各一行，写能力、实测结果、核实日期、一手来源、依赖它的 spec、重核时间（ADR-004 A12；docs/spec-driven-dev.md「厂商现状」），并把总参考「以后再说」里那一行换成指向它的链接。
- [x] 2. 类型：packages/kernel/src/provider/types.ts 加 `pricing.longPrompt`、`ThinkingSpec.offType`（`'between_tools'`）、`ModelInfo.family`、`ModelInfo.generation`、`ProviderDefinition.familyNameKeys`，注释引本 spec。
  - 测试：由第 3–9 步覆盖，本步只跑 `pnpm typecheck`。
- [x] 3. Anthropic 编码器：packages/kernel/src/provider/wire/anthropic-messages.ts 的 `thinkingShape` 关思考的 switch（:307-313）只在 `adaptive-gated` 一支写 `{ type: spec.offType ?? 'disabled' }`；`budget`、`adaptive` 两支遇到行上有 `offType` 时抛 `ProviderInvalidArgumentError`（照 :286-292 的表错误写法），否则照旧写 `disabled`；`offType` 为 `between_tools`、关思考且 `tools` 非空时抛 `ProviderInvalidArgumentError`；`ANTHROPIC_MESSAGES_ENCODER.version` 3 → 4（:132），上方注释补一句第 4 版改了什么。
  - 测试：
    - thinking-shapes.test.ts 加两行的关思考用例（验收 2，含带 tools 的拒绝；行先用测试里的本地 `ModelInfo`，第 6 步换成表里的行），另用合成的 budget 行、adaptive 行各带 `offType: 'between_tools'` 测关思考本地拒绝；
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
- [x] 4. 采样守卫：packages/kernel/src/provider/wire/shared.ts:225-241，所有 `samplingDefaultsOnly` 的行，`top_p` 的判定由 `>= 0.99` 改为 `=== 0.99`，另拒 `temperature` 与 `top_p` 同发；同步改 shared.ts:219-224 与 types.ts:117 的注释、thinking-shapes.test.ts:331-337（spec §点名 (a)）。
  - 测试：thinking-shapes.test.ts（验收 5）。
  - 突变：① 判定改回 `topP >= 0.99` → `top_p` 1 的用例红；② 去掉同发检查 → 同发用例红。
- [x] 5. 家族排位：packages/kernel/src/provider/definitions/models.ts 加两个纯函数，从 kernel 包导出：
  - `arrangeFamilies(rows)`，在 `frozenModels` 之前调：带家族的行，本家族代次最大的不写 `listing`，其余写 `'more'`；带家族的行手写了 `listing`、同家族两行代次相同、`family` 与 `generation` 只有一个，抛错；
  - `newestOfFamily(definition, family)`：该定义里这一家族代次最大的行，没有给 null（第 9 步的解析与写指针用）。
  - 测试：新文件 packages/kernel/test/provider/model-families.test.ts（验收 13），合成的定义。
  - 突变：① 代次只比主版本 → [5, 0] 对 [5, 5] 的用例红；② 带家族的行手写 `listing` 不抛 → 红；③ 最新一代也写 `listing: 'main'` → 「最新一代没有 `listing` 键」红；④ `newestOfFamily` 取家族里排在前面的行 → 旧行排前面的用例红。
- [x] 6. 数据与文案：packages/kernel/src/provider/definitions/anthropic.ts 加两行（取值见 spec §内置模型表的数据改动，加第 1 步的结果），现有五行加 `family`、`generation`，Opus 5 去掉手写的 `listing`，行序照数据表，表经 `arrangeFamilies`；zhipu.ts 四行加 `family`、`generation`，表经 `arrangeFamilies`；两个定义加 `familyNameKeys`。注释按 spec 数据表「注释」一行改。apps/desktop/src/i18n/locales/zh-CN/common.json 与 en/common.json：`model.name`、`model.purpose` 加新键、改 `sonnet5`、`haiku45` 的值，加 `model.family.*` 七个键与 `settings.providers.latest`。
  - 测试：
    - definitions.test.ts（验收 1）：改「puts Opus 5.5 first」与「declares each Anthropic row’s thinking mode」两条的期望表；「M6 不变量 17」的 flagged 表与逐行判断补两新行；加两行的整行断言、各行的 `family` / `generation` / `listing`，以及 `offType`、`longPrompt`、`familyNameKeys` 的表规则；
    - thinking-shapes.test.ts 把第 3、4 步的用例换成表里的行；
    - thinking-default.test.ts（验收 6）；compaction.test.ts（验收 3）；copy-coverage.test.ts（验收 8）；search-backends.test.ts（验收 10，用改了 id 的 Sonnet 5.5 行）；
    - apps/desktop/test/model-selection.test.ts:144-152 的 `listing` 期望改为算出的值（Sonnet 5、Haiku 4.5、GLM-4.6 是 `'more'`）；:153-157 用 `row.id.startsWith('claude-haiku')` 找 Haiku 4.5，新行排在它前面时会先找到有五档的 Haiku 5.5，改成 `row.id === 'claude-haiku-4-5-20251001'`，另加一条断言 Haiku 5.5 的 `effortLevels` 是 low…max、`defaultEffort` 是 `'medium'`；
    - model-menu.spec.ts（验收 9）：:63-83、:188、:519 三处直接在主列表点或断言 Sonnet 5、Haiku 4.5 的行，改成先点 `model-more`，或者换成新行；:81「Haiku thinks on a budget」是 budget 模式在界面上唯一的覆盖，要留着；断言 GLM-4.6 在「更多模型」里；
    - text-fit-02.spec.ts:58 的行数仍是 5（anthropic 主列表仍是四行），只确认新行不换行不截断；
    - Haiku 4.5 行除注释、`family`、`generation` 与 `listing` 外不变、`modelWireHash` 不变（验收 11）。
  - 突变：① Haiku 5.5 的 `defaultDisplay` 写成 `'summarized'`（周报的错）→ 验收 1 红；② Sonnet 5.5 去掉 `offType` → 验收 3 红；③ Sonnet 5.5 去掉 `forcedToolChoice: false` → 验收 1、10 红；④ 任一新行去掉 `checksThinkingPrefix` → 验收 1 红；⑤ 把 Sonnet 5.5 排到第一行 → 验收 1、9 红；⑥ GLM-4.6 的家族写成 `'glm-4'` → 验收 1（它不再是 `'more'`）红；⑦ Flash 并进 `glm` 家族 → 验收 1 红。
- [x] 7. 费用：apps/desktop/evals/cost.ts 的 `costOf`（:46-56）先算提示长度 `usage.input + usage.cacheRead + usage.cacheWrite`（与 `inputTotalOf` 同口径），大于 `pricing.longPrompt.overTokens` 时四项都换成本档单价，档内缺缓存价按本档输入价；文件头注释补一条引本 spec。
  - 测试：evals-cost.test.ts（验收 7，含档内缺缓存价的构造用例），现有用例不改。
  - 突变：① `>` 改 `>=` → 恰为 100 000 的用例红；② 提示长度只算 `input` → 靠缓存读推过阈值的用例红；③ 只有输入按高档、输出仍按低档 → 红；④ 档内缺缓存价时退回基础档的缓存价 → 档内缺缓存价的用例红。
- [x] 8. 契约与端口：
  - packages/contracts/src/ipc/config.ts 的 `providerSelectionSchema`（:17）加 `latestOf`（`z.string().min(1).optional().catch(undefined)`，坏值只丢这个键）；provider.ts 的 `providerSelect` 请求（:204）加 `latestOf`，`providerModelSchema`（:84）加 `family`、`familyNameKey`；
  - kernel：`RunConnector.resolveChoice` 的问询加可选的 `previousModel`（packages/kernel/src/loop/ports.ts:50；可选，缺省按 null 读，照文件头的冻结规则，已有的十处直接调用点不用改），带 `providerId`、`modelId` 与 `capabilitySource`；`SessionFacts.lastSelected` 加 `modelId` 与 `capabilitySource`（session/facts.ts:44、:89；载荷里缺 `capabilitySource` 时不写）；mailbox.ts 的 `prebuild`（:541）与 `effectiveModelChoice`（:3256）都交它，`effectiveModelChoice` 的 `previousOrigin` 照旧是 null（它拿到 `needsConfirm` 会抛，:3263）；testing/loop-ports.ts 的脚本连接器照旧把问询记进 `resolved`。
  - 测试：packages/contracts/test/config-route.test.ts（验收 18 前半，含 `latestOf: ""`）；apps/desktop/test/profile.test.ts（验收 18 后半：写 `lastWorkspaceFolders` 后三个默认的 `latestOf` 还在）；packages/kernel/test/session/model-choice.test.ts（验收 15 末条：`previousModel` 是本代最后一个、带 `capabilitySource`、第一个 Run 与清空后为 null、`effectiveModelChoice` 交的 `previousModel` 相同而 `previousOrigin` 为 null）。
  - 突变：① 交本代第一个而不是最后一个 `model_selected` → 红；② 清空后仍交上一代的 → 红；③ `effectiveModelChoice` 交 null → 红；④ 去掉 `.catch(undefined)` → 验收 18 的 `latestOf: ""` 一例红；⑤ `effectiveModelChoice` 也交 `previousOrigin` → 验收 15「地址改到公网后 `session.modelChoice` 不抛」一例红（第 9 步那例，第 9 步做完后回头做这一个突变）；⑥ `previousModel` 丢掉 `capabilitySource` → 验收 15 手填一例红（同上）。
- [ ] 9. 解析与写指针（desktop 主进程）。本步做完后回头做第 8 步的突变 ⑤⑥（记进 log.md）：
  - apps/desktop/src/main/run-assembly.ts 的 `resolveChoice`（:150-182）按 spec §跟随最新「解析」「会话不换」取行：① 空着时先看 `previousModel`（按 `capabilitySource`：`builtin`、`probed` 与没记的，行还在该厂商的表里就用它；实例上的 `user` 同样要行还在；内置厂商上的 `user` 照 02 保守合成、仍记 `user`；`synthesized` 不用），再按答话的一层解析，指针的最新一代用 kernel 的 `newestOfFamily`，不自己扫家族；数据去向检查照旧在取行之后，会话不换留下的行也过这道检查。
  - model-routes.ts 的 `session.selectModel`（:44-87）：会话没有 ①、请求的 provider 与模型 id 就是写入前 `session.modelChoice` 答的那一行时（交给 kernel 之前读，`sessions.sessionFacts` 与 `sessions.effectiveModelChoice`），只交 kernel 写 ①，不写 `defaultModelByProfile[形态]` 与 `provider`（spec 不变量 12，§点名 (g) 后半）。
  - provider-routes.ts 的 `selectionOf`（:287）不改，`provider.select`（:247）照旧用它写钉住的值，只在请求带 `latestOf` 时按 spec §对 02 的修补 第 13 条另走一支（拒绝一律 `invalid-value`）。另加一个只给菜单用的 `menuSelectionOf(definition, modelId)`：行在主列表（没有 `listing: 'more'`）且带 `family` 时给 `{ id, modelId, latestOf: family }`，其余交给 `selectionOf`；model-routes.ts:55 改调它（第 11 步也用它）。`menuRow`（:422）转发 `family`、`familyNameKey`。
  - 测试：
    - model-selection.test.ts「the five layers and the data-flow check」（验收 14、15）。合成的 anthropic 定义把 `opus` [6, 0] 放在第一行；由表里的行展开时先去掉算好的 `listing` 再过 `arrangeFamilies`。不带 `previousModel` 的原有用例不改，照旧通过；
    - 同文件「session.selectModel and session.modelChoice」（验收 16）。02 验收 33 那两例按 spec §点名 (g) 改期望：「records the choice and the profile’s default and provider」（:961）的 `cowork` 与 `provider` 改为 `{ id: ZHIPU_PROVIDER_ID, modelId: 'glm-5.3-flash', latestOf: 'glm-flash' }`，已有的 `session.modelChoice` 断言不变（仍是具体的 `glm-5.3-flash`）；「writes each profile’s default in the profile’s lock」（:1047）的两个值分别带 `latestOf: 'opus'`、`'glm-flash'`；加验收 16「只改档不写默认」两例（opus 指针、会话留在 `claude-sonnet-5` 上只改档；钉住的 `claude-opus-5-5`、会话在默认那一行上只改档或确认「切换」）；
    - 同文件「provider.list for the menu」（:138，`r.list()`）断言行带 `family`、`familyNameKey`，Ollama 行没有（验收 16）；provider-catalogue.test.ts 的键清单加上各定义 `familyNameKeys` 的值；
    - provider-routes.test.ts（验收 16 的 `provider.select`）：「accepts %s」（:542）不改，照旧期望钉住的值；加带 `latestOf` 的各例与 `invalid-value` 各例；
    - 02「间接切公网」的 e2e：model-menu.spec.ts 里先在 Ollama `qwen3:8b` 上跑一轮、再改默认、期望下一条被 hold 的用例（:212，`heldRound` / `launchHeld` 带的 :301、:325、:341、:366，以及 :419），会话不换以后会留在 `qwen3:8b` 上、不再 hold。手填的 Ollama id 现在也留着，不能用来触发。改为：种子里放一个回环上的自定义实例（不填 key，地址指向原来的 Ollama 假服务），默认是它的行；跑一轮之后经 `customVendor.delete` 删掉实例（上一个 Run 的行不在表里，照默认读；删除顺带清掉指向它的默认），再照原样在设置卡里把默认改到智谱，下一条被 hold。这样「经形态默认」的语义不变，:366（hold 之后默认又移到 anthropic）与 :419（菜单当前项是 GLM-5.3 Flash）的断言照旧成立。另一种触发是把 Ollama 的地址改到公网主机（确认前 0 次请求），只适合只断言「hold 并出确认」的用例：那样当前项仍是 `qwen3:8b`，:419 的断言不成立。改不动的停下记进 Open。
    - 因会话不换变红的另外四例（spec §点名 (f)），逐个改：
      - provider-settings.spec.ts「acceptance 6」（:40，01 验收 6）：设置卡改到智谱 glm-4.6 之后，先在原会话发一条，断言仍发往 anthropic（会话不换的正向 e2e）；再 `newChatFromSidebar`，在新对话里发「and now?」，断言发往智谱、流式渲染的断言照旧；
      - recovery.spec.ts :287 那例（:325-328「The default did change: the next message of this session … follows it」）：改为断言下一条留在上一个 Run 的行（`modelOf(server, 2)` 是 `claude-sonnet-5`）；要验新默认生效，在新对话里发一条，断言是 `LATER_DEFAULT.modelId`；
      - recovery.spec.ts :385 那例（:406-408，在 anthropic 上跑过的对话芯片显示新默认 `qwen3:8b`）：改为芯片显示上一个 Run 的行（Sonnet 5）；新默认在新对话里断言；
      - apps/desktop/test/custom-vendor-runtime.test.ts「验收 20」（:1136，custom-vendors 验收 20）：第一轮之后先 `customVendor.update` 把 LOCAL 的 `TOOL_ROW` 删掉（上一个 Run 的行不在表里，照默认读），再 `provider.select` 公网实例 `ID`，断言 held，其余断言不变。实例没有手填 id，旧写法「种子改成手填 id」用不上。
    - 跑「命令」里的 e2e 子集（含 recovery.spec.ts）与全量 e2e 各一遍，因同样原因变红的别的用例照此改，逐个记在本步。
  - 突变：
    - ① 会话不换只在上一个 Run 的行与指针同厂商同家族时做（旧规则）→ 验收 15「默认是钉住的 `glm-5.3-flash` 或改成 sonnet 指针后仍用 `claude-opus-5-5`」红；
    - ② 会话不换只在答话的一层是指针时做（⑤ 与钉住的值不看 `previousModel`）→ 验收 15 落到 ⑤ 与钉住的那几例红；
    - ③ 家族找不到时落到 ⑤ → 「读作 `modelId`」红；
    - ④ 上一个 Run 的行不在表里时仍用它 → 红；
    - ⑤ 手填的 id 不留在原行（`user` 按 `synthesized` 读）→ 验收 15 手填一例红；⑤′ `synthesized` 的 id 也留在原行 → 验收 15 `synthesized` 一例红；⑤″ 实例上的 `user` 行不在实例里了也留（按内置厂商的手填读）→ 验收 15 实例一例与 custom-vendor-runtime「验收 20」红；
    - ⑥ 会话不换留下的行绕过数据去向检查 → 验收 15「Ollama 地址改到公网主机」一例红；
    - ⑦ `menuSelectionOf` 给「更多模型」的行也写指针 → 验收 16 红；
    - ⑧ `provider.select` 不带 `latestOf` 也写指针（例如让 `selectionOf` 对主列表的行给指针）→ 验收 16「不带 `latestOf` 选 `glm-5.3-flash`」与 provider-routes.test.ts「accepts %s」红；
    - ⑨ 厂商没配置时跳到已配置的厂商 → 验收 14 末句红；
    - ⑩ `latestOf` 与 `source` 同在时仍按指针读 → 红；
    - ⑪ 只改档也写默认（去掉 `session.selectModel` 里那条判定）→ 验收 16「只改档不写默认」两例红。
    - 「指针取家族里排在前面的行」不在这里做：解析调 `newestOfFamily`，由第 5 步的突变 ④ 覆盖；合成表把 [6, 0] 放在第一行，这里测不出它。
- [ ] 10. 设置卡（renderer）：apps/desktop/src/renderer/src/components/settings/ProviderSettings.tsx 的下拉（:370-392）先列指针项（`settings.providers.latest`，填家族显示名与那一行的显示名，悬停是 id），再列各行；`newDraft`（:500-520）按 spec §跟随最新「谁写指针」选中；保存（:229-236）时选的是指针项就给 `provider.select` 带 `latestOf`，选的是钉住的行就不带。指针项的选项值不能与行 id 重名，`selectOption('<行 id>')` 照旧选中钉住的那一行（model-menu.spec.ts:616 那例靠它）。
  - 测试：provider-settings.spec.ts（验收 17）；renderer-settings-sections.test.ts 若断言了下拉选项，一并改。
  - 突变：① 没存这一家的默认时选中第一行 → 验收 17 红；② 保存指针项时不带 `latestOf` → 红；③ 保存钉住的「Opus 5.5」时也带 `latestOf` → 验收 17 红；④ Ollama 卡也出指针项 → 红。
- [ ] 11. 第一把 key 的「有」一支（spec §跟随最新「谁写指针」「迁移」，`Related:`）。不改 presentation-r1 的 spec 与 plan。2026-10-23 核过：presentation-r1 已在 `dev` 上，按第一种情形做（写第一把 key 的代码在 apps/desktop/src/main/custom-vendors/store.ts 的 `firstKeyDefaults`）。两种情形原文：
  - presentation-r1 写第一把 key 的代码已在 `dev` 上（只有钉住一支）：实现它 §对 02 的修补 第 1 条已写的「有」一支，那次写入的值取第 9 步 `menuSelectionOf` 对那一行给出的值（内置带家族的行给指针，实例给钉住）；触发条件、写哪几个键、写在哪一次 config 写入里、失败行为都照它那一条。它验收 12 钉住一例的测试按它验收 12 的写法换成指针一例（`dev` 上已有 `latestOf`）。跑验收 19（就是它验收 12 的指针一例），结果记进 log.md。它合入之后、本步合入之前不切 release 分支；本步合入的那个 PR 里一并删掉总参考「以后再说」里「claude-5-5-models 合入之前不切 release 分支」那一行。
  - 还不在 `dev` 上：本步不做事，记一句「『有』一支由 presentation-r1 plan 第 9 步实现，验收 19 由它验收 12 的指针一例验」，勾掉。不因此等它，也不因此不标 `implemented`。
- [ ] 12. 〔开放问题 6 定 A〕官方 live 冒烟（验收 12）。**先提醒 owner 钥匙串会弹窗**，等回话再跑。
  - 官方组两次，`TENON_LIVE_ANTHROPIC_OFFICIAL_MODEL` 分别取 `claude-sonnet-5-5`、`claude-haiku-5-5`（命令见上，带 `--grep`，不连带跑搜索探测、前缀探测和智谱各组）。
  - apps/desktop/e2e/live-official-agent.spec.ts 照「Opus 5.5 performs actual threshold compaction in the product loop」加两例。官方协议接缝都用 `record` 模式：`strict` 会把 `thinking` 改写成带 `block_binding` 的 adaptive（apps/desktop/src/main/host/official-protocol-test-seam.ts:52-58），盖掉 `between_tools`；`evidence()` 相应传 `strict: false`。两例都在压缩前先跑一轮工具调用：照「performs a real WebSearch round trip and workspace Read smoke」那例，`startTask` 进一个工作区，让模型 Read 一个文件一次并 `allow`，这样摘要请求会回放一对 tool_use / tool_result（生产里最常见的形态；原 Opus 例每轮都不用工具，没覆盖到）。判据分两处读（spec 验收 12）：
    - 「Sonnet 5.5 performs actual threshold compaction after choosing low effort」：Read 那一轮之后用 `session.selectModel` 把 effort 设成 `'low'`（文件里的 `choose()` 传的是 `effort: null`，这里另传 low），再跑两轮，然后照原例带 `TENON_E2E_COMPACTION_THRESHOLD=1` 重启触发压缩。线上（重启后 `evidence(app, false, journal)` 的 `last.wire[0]` 是摘要请求）：`body.tools` 没有，`body.thinking` 是 `{ type: 'between_tools' }`，`body.output_config.effort === 'high'`，`status === 200`。Tape：摘要 attempt（`provider/attempt_completed` 带 `compaction` 的那条）的快照是 `{ thinking: { enabled: false }, effort: 'high' }`；压缩后主请求的快照带 `effort: 'low'`。
    - 「Haiku 5.5 performs actual threshold compaction at its default effort」：同样先跑 Read 一轮，不选档。线上：摘要请求不带 `tools`，`body.thinking` 是 `{ type: 'disabled' }`，effort `high`，`status === 200`。Tape：摘要 attempt 的快照同上。
  - 同一文件加一例「Sonnet 5.5 and Haiku 5.5 record cache reads and thinking text」，record 模式，两个模型各发两次一道要推理、不用工具的题，例如「Determine how many positive integers below 500 have exactly six positive divisors, and how many of those are odd. Do not use tools. Reply with the two numbers, then DIVISORS_DONE.」，用 `completed(page, 'DIVISORS_DONE')` 等。不照搬 live-provider.spec.ts:1699 的原题：它要求调 `lookup`，那是裸协议测试自己定义的工具，产品循环里没有。从 `tapeFacts(userData)` 读：
    - 第一个请求先断言提示长度（input + cacheRead + cacheWrite）大于 512（F20）、`usage.cacheWriteTokens` 大于 0，再断言第二个请求 `provider/attempt_completed` 的 `usage.cacheReadTokens` 大于 0；
    - 消息里出现思考块时，文本非空。
  - 任一摘要请求 400：停下，不改代码，spec 回 `draft`，把报错原文（不含 key）记进 log.md。报错指向 effort、`between_tools` 或 `disabled` 时，按 spec §已有规则「逐条 effort」的退路请 owner 定（§点名 (e)）。指向别的原因时不按 (e) 处理：这两例的摘要请求第一次回放 tool_use / tool_result 又不带 tools，记成 02 §摘要请求「前缀（默认做法）」的问题请 owner 定。原因判不清时，问 owner 要不要在 record 模式下给 Opus 5.5 跑一次同样的「Read + 阈值压缩」做对照（约 7 个请求，同样先提醒钥匙串会弹窗）。
  - 记进 log.md：模型、日期、各请求的状态码与用量、摘要请求的 `thinking` 与 effort、思考文本是否非空、第二个请求的缓存读，另记一行「花费：」。不记 key。实测结果回写 docs/reference/vendors.md 对应行的「实测结果」与核实日期。
  - 开跑前请 owner 确认花费上限（建议 2 美元，约为估计的两倍）并写进 spec 修订记录；累计到上限就停，问 owner。
- [ ] 13. 页头成对（与实现同一个 PR；旧 spec 正文一字不改，也不加行末指针，ADR-004 A5）：
  - 本 spec 页头：`Amends:` 改写成 v2 的 `Changes:`，每条只带一个 §（spec-check 每个目标只取第一个 §），多条用「；」隔开，例如 `[02-agent-loop](../../architecture/02-agent-loop/spec.md) §主进程与 kernel 的循环接口（增补：`resolveChoice` 的问询只增 `previousModel`）`；带 §点名 项的条目（(a)(b)(f)(g) 落到的节）不标「增补」，括注写点名与 owner 的确认；`Replaces:` 改写成 `Changes: 02 §模型菜单与输入框（替换：「更多模型 ›」的括注）`。改写只换格式，指到的节与内容不变，记一行修订。
  - 01、02、model-display-names 页头为本 spec 的每条 `Changes` 各写一条 `Changed by: claude-5-5-models（§<节名>）`，逐条成对；02 那几条的括注点出 §点名 (a)(b)(f)(g) 与 owner 的确认（(g) 是 owner 2026-10-15 经问卷确认，spec `Revisions:` ㊴；(e) 只在 live 失败、owner 确认时补）；01 那条点出 (f)（验收 6 的读法）。custom-vendors 与 presentation-r1 不加（spec `Revisions:` ㉘、㉛，`Related:`）。
  - 跑 `python3 .sdd/spec-check.py`：pairs 拦 0 条。若报 config 里这份 spec 的已知项失效，删它们要改 `.sdd/config.json`（门禁文件），那一处交 owner 合。
- [ ] 14. 对照验收 1–19 逐条核对（验收 19 按它写的条件），跑 `python3 .sdd/spec-check.py` 确认 trace 不再报本 spec 的验收没有用例点名，跑一次「命令」里的全量 e2e（走 CI 草稿 PR 或 Lima VM，不在 owner 的 Mac 上起窗口），结果记进 log.md。
- [ ] 15. 清理：临时探针、调试输出、live 记录里不该留的内容；把「上线后跟进」与 Open 挪进总参考「以后再说」或写明已定（要在派评审之前做）；`git status` 干净。
- [ ] 16. owner 验收 → 改 Status

## 上线后跟进

- 弃用页出现 Haiku 4.5 条目时，按开放问题 5 的定法执行（spec §Haiku 4.5），在这里新开一步，记日期和做法。
- 开放问题 7 定 A：以后要改 02 H10 的压缩绝对上限（`COMPACT_ABS_CAP`），另写 amend，把 Haiku 5.5 在 100 000 以上按高档计价这件事算进去。
- 厂商出新一代时：加行只写 `family`、`generation`，`listing` 自动算，旧行自动进「更多模型」；能力、价格与思考数据照本 spec 的做法逐项核一手页面。新一代在 Tenon 加行之前不会被指针选上（spec 非目标）。

## 交接

- 2026-10-23：第 1 步由 lead 做：F1–F21 对一手页面重核，F6、F14 因 API 版本 2026-10-21 变了（Tenon 钉 2023-06-01，数据与守卫不改），建了 docs/reference/vendors.md。第 6–8 步由 Codex 按任务说明实现，lead 审查、沙箱外补跑全量 vitest（4545 passed）并提交；e2e（model-menu、text-fit-02）只过了 typecheck，由本段 PR 的 CI 首跑。第 8 步的突变 ⑤⑥ 留到第 9 步做完后回头做。下一步第 9 步。

## Open

（无。原先交给 `docs/presentation-r1` 分支的三件事随它 2026-10-22 合入失效：它已 `implemented`，第 11 步按第一种情形做。）
