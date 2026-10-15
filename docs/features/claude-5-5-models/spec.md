# Claude 5.5 两行：Sonnet 5.5、Haiku 5.5

Status: draft
Kind: features
Owner: 起草在 Claude Code（2026-10-15），厂商事实当天按一手页面核过（§事实与出处）；等 owner 定 §开放问题 1–8，定完写进 `Revisions:` 并改 `ready`
Amends: [01-provider-and-tape](../../architecture/01-provider-and-tape/spec.md) §Provider 层（`ModelInfo.pricing`；`ThinkingSpec`，由 02 的 01 修补 2 立）；[02-agent-loop](../../architecture/02-agent-loop/spec.md) §对 01-provider-and-tape 的修补（第 2 小节的 `ThinkingSpec` 与 `pricing`；第 3 小节「Anthropic 线的 thinking 编码四分支」的 `{ enabled: false }` 一支、「`samplingDefaultsOnly` 的行……本地拒绝」一条）、§记录格式与费用口径（「费用与用量」第一条）。只增不改，全文见 §对 01 的修补、§对 02 的修补；开放问题选了非推荐项时可能出现不属纯粹只增的改动，列在 §点名
Replaces: 无（不替换任何表现层条款）
Revisions: 2026-10-15 首版

## 背景

Anthropic 发布了 Sonnet 5.5、Haiku 5.5。内置表现在五行（`packages/kernel/src/provider/definitions/anthropic.ts:95-238`）：Opus 5.5、Sonnet 5、Opus 5（更多模型）、Haiku 4.5、Fable 5.1。加这两行不只是填数据，现有形状有三处接不住：

1. **价格分档**。Haiku 5.5 按单次请求的提示长度分两档（F11）；`ModelInfo.pricing`（types.ts:48-56）只有一组单价。完整的 `ModelInfo` 按哈希冻结进 Tape（`view/content(model_info)`，tape/provenance.ts:206；testing/attempt-recheck.ts:157 读回），评测按冻结的价格算费用（apps/desktop/evals/cost.ts:4-7），所以分档要进 `ModelInfo`，是对 01 契约的修补。
2. **关思考的写法**。Sonnet 5.5 关思考不收 `disabled`，要发 `between_tools`（F13）；Anthropic 编码器关思考只会写 `{ type: 'disabled' }`（anthropic-messages.ts:308-313）。Tenon 只在摘要请求里关思考（compaction.ts:27-42；02 §摘要请求「思考参数」），这个请求不带 tools。
3. **采样守卫**。Haiku 5.5 的页面写明 `top_p` 只收 0.99、`top_p` 为 1 也是 400、`temperature` 与 `top_p` 同发是 400（F6）；守卫（wire/shared.ts:225-241）只拒小于 0.99 的 `top_p`（:238），不查同发。

另外，Haiku 4.5 在 02 裁决 A16 的推迟项里：「有弃用公告后撤行」。2026-10-15 核查没有公告（F15）。

## 事实与出处

2026-10-15 读一手页面（平台文档、定价页、弃用页），只收下表。没核到的不写进本 spec 和代码，或放进 §开放问题。代码注释照 anthropic.ts:67-94 的写法引 URL 与读的日期。页面都在 `https://platform.claude.com/docs/en/` 下，表里只写路径；「迁移页」指 `models/haiku-5-5/migration-guide`，「Sonnet 5.5 迁移页」是同目录结构下 Sonnet 5.5 的那一页（核查记录只给了页名，第一次在代码注释里引用时补全 URL）。

| # | 事实 | 出处 | 原文 |
|---|---|---|---|
| F1 | Haiku 5.5 的 id 是 `claude-haiku-5-5`，无日期后缀、无别名 | `models/haiku-5-5/migration-guide` | "`claude-haiku-5-5` is a fixed model ID with no date suffix and no separate alias." |
| F2 | Haiku 5.5：1M 窗口，同步输出上限 128K | `models/haiku-5-5/overview` | "Context window: 1M tokens · Max output: 128K tokens" |
| F3 | 两行都有 low 到 max 五档 effort；Haiku 5.5 默认 medium，Sonnet 5.5 默认 high | `build-with-claude/effort` | "Claude Haiku 5.5 supports all five effort levels, and `medium` is the default." / "Claude Sonnet 5.5 supports all five effort levels, and `high` is the default on the Claude API." |
| F4 | Haiku 5.5 默认开思考；`disabled` 只在 high 及以下可发；预算式 400 | `build-with-claude/effort`；迁移页 | "You can also send `thinking: {"type": "disabled"}` at `high` effort or below. At `xhigh` or `max`, it returns a 400 error" / "A `thinking` value of `{"type": "enabled", "budget_tokens": N}` returns a 400 error" |
| F5 | Haiku 5.5 的 display 默认 omitted，要摘要得设 `display` | 迁移页 | "By default, Claude Haiku 5.5 returns each `thinking` block with an empty `thinking` field and only a `signature`, where Claude Haiku 4.5 returned summarized thinking. To receive summarized thinking, set `thinking: {"type": "adaptive", "display": "summarized"}`." |
| F6 | Haiku 5.5 只收采样参数的默认值 | 迁移页 | "If a request includes `temperature`, it must be `1`. If it includes `top_p`, it must be `0.99`, its default. Any other `temperature` or `top_p` value returns a 400 error, including a `top_p` of `1`. So does any `top_k` value, and so does a request that includes both `temperature` and `top_p`." |
| F7 | 两行都拒 assistant 预填 | 迁移页；Sonnet 5.5 迁移页 | "Claude Haiku 5.5 rejects it with a 400 error, even with thinking turned off." / "This model does not support assistant message prefill. The conversation must end with a user message." |
| F8 | Haiku 5.5 会拒答，且没有服务端 fallback | 迁移页 | "Claude Haiku 5.5 runs safety classifiers that can decline a request, and it has no server-side fallback." |
| F9 | 两行的思考块绑账号；另有前缀校验 | `build-with-claude/preserved-thinking` | "Thinking blocks that Claude Sonnet 5.5 or Claude Haiku 5.5 produces work only in the account that produced them, or in an account linked to it. When another account sends one of these blocks, the API drops the block before the model sees it, and the request succeeds." / "On Claude Fable 5.1, Claude Opus 5.5, Claude Sonnet 5.5, and Claude Haiku 5.5, a thinking block stays valid only while everything you sent before it is unchanged"（2026-08-31 00:00 UTC 及以后建的账号默认强制；更早的账号只在设了 `prefix_mismatch_behavior` 时强制，要带 `thinking-binding-controls-2026-08-01` 头） |
| F10 | Haiku 5.5 收强制 `tool_choice`；Sonnet 5.5 不收 | 迁移页；`models/sonnet-5-5/whats-new-sonnet-5-5` | "Claude Haiku 5.5 accepts a forced `tool_choice` (`any` or a named tool), but the response starts with the tool call and has no `thinking` block." / "tool_choice: type "tool" and "any" are not supported for this model." |
| F11 | Haiku 5.5 按提示长度分两档计价（USD/MTok）：不超过 100 000 token 时输入 0.10、输出 0.50、缓存读 0.01、5 分钟缓存写 0.125；超过时输入 0.50、输出 2.50、缓存读 0.05、5 分钟缓存写 0.625。提示长度含缓存读写，每个请求单独算 | `models/haiku-5-5/overview`；`about-claude/pricing` | "Claude Haiku 5.5 is priced by prompt length: a request whose prompt is over 100,000 tokens pays higher prices." / "A request's prompt length counts all of its input tokens, including cache reads and cache writes. Each request is priced on its own" / "Cache read \| $0.01 / MTok for prompts up to 100,000 tokens; $0.05 / MTok for prompts over 100,000 tokens"（1 小时缓存写 0.20 / 1，Tenon 只用 5 分钟档，02 01 修补 3） |
| F12 | Sonnet 5.5：id `claude-sonnet-5-5`，1M / 128K，$2 / $10，5 分钟缓存写 $2.50，缓存读 0.05 × 输入价 = $0.10；默认开思考（自适应），display 默认 omitted；退役不早于 2027-09-28 | `models/sonnet-5-5/overview`；`about-claude/pricing`；Sonnet 5.5 迁移页的表格 | "Context window: 1M tokens · Max output: 128K tokens · Input pricing: $2 / MTok · Output pricing: $10 / MTok" / "Cache hits and refreshes on Claude Opus 5.5 and Claude Sonnet 5.5 are priced at 0.05x the base input price." |
| F13 | Sonnet 5.5 关思考：发 `disabled` 是 400（报错指向 `between_tools`），要发 `between_tools`；只在 high 及以下；不能带别的键 | `models/sonnet-5-5/whats-new-sonnet-5-5` | "`between_tools` is accepted at `low`, `medium`, and `high` effort. At `xhigh` or `max` effort, a request with `between_tools` returns a 400 error." / "`between_tools` takes no other field: `display`, `budget_tokens`, or `block_binding` sent with it returns a 400 error." / "With `between_tools`, effort can't change mid-conversation: a per-message `output_config.effort` that differs from the level in effect returns a 400 error." |
| F14 | Sonnet 5.5 只说非默认采样值 400，没给默认值，也没提同发 | `models/sonnet-5-5/overview` | "Setting `temperature`, `top_p`, or `top_k` to a non-default value returns a 400 error." |
| F15 | Haiku 4.5 没有弃用公告；「不早于 2026-10-15」只是下限；退役前至少提前 60 天通知 | `about-claude/model-deprecations` | "\| claude-haiku-4-5-20251001 \| Active \| N/A \| Not sooner than October 15, 2026 \|" / "providing at least 60 days' notice before model retirement for publicly released models."（弃用历史最新一条是 2026-09-30 的 Sonnet 4.5，Tenon 表里没有这一行；Haiku 5.5 退役不早于 2027-10-07） |

**更正，不采信**：

- 周报建议把 Haiku 5.5 的 `defaultDisplay` 写作 `'summarized'`，与 F5 矛盾，本 spec 取 `'omitted'`（与 Opus 5.5、Sonnet 5 等行一致，只有 Haiku 4.5 是 `'summarized'`）。
- 一份非一手材料写 Sonnet 5.5 缓存读 $0.20，与定价页冲突（F12），取 $0.10。

**没核到，不写**：Sonnet 5.5（以及 Opus 5.5、Fable 5.1）的采样默认值和同发规则（F14 之外没有）；拒答的分类清单（只在非一手材料里见到）；Sonnet 5.5 是否收 `display: 'summarized'`、两行的 vision 与流式工具调用——这三项落地前按 plan 第 1 步核对。

## 目标与非目标

### 目标

1. anthropic 内置表加 `claude-sonnet-5-5`、`claude-haiku-5-5` 两行，取值见 §内置模型表的数据改动。
2. `pricing` 能表达按单次请求提示长度分档，评测费用按档算。
3. `ThinkingSpec` 能表达「关思考写 `between_tools`」，Sonnet 5.5 上的摘要请求合法。
4. 采样守卫对 Haiku 5.5 按 F6 拒绝。
5. Haiku 4.5：写清现状和公告之后怎么做。

### 非目标

- 界面显示单价或费用。现在 `pricing` 只有评测读（cost.ts），本 spec 不加界面。
- 逐条消息改 effort（02 A13 不用）、1 小时缓存档、Message Batches 与 300K 输出 beta、拒答分类解码（02 §开放问题「以后再评估」）。
- 改 Opus 5.5、Sonnet 5、Opus 5、Fable 5.1 的数据。例外只有开放问题 3 选 C、开放问题 4 的位置与用途句。
- Bedrock、Google Cloud 的模型 id 与时间表。

## 对 01 的修补

01 已 `implemented`。下面全部只增，读法照 02 §对 01-provider-and-tape 的修补 第 1 小节：给既有对象类型加可选键算新增成员。改 `packages/kernel/src/provider/types.ts`，标「已存在」的只为定位。成员名与形状按开放问题 1–3 的推荐项写；owner 改选时随 `Revisions:` 改这一节。

```ts
export interface ModelInfo {                     // 已存在（types.ts:28）
  pricing?: {                                    // 已存在（types.ts:48-56），已有成员不变
    /** 新增：按单次请求的提示长度分档（开放问题 2）。缺省 = 不分档，02 的算法一字不变 */
    longPrompt?: {
      /** 这次请求的提示长度严格大于它时，这次请求的全部用量按本档计价 */
      overTokens: number
      inputPerMTok: number
      outputPerMTok: number
      cacheReadPerMTok?: number
      cacheWritePerMTok?: number
    }
  }
}

export interface ThinkingSpec {                  // 已存在（types.ts:108；02 的 01 修补 2）
  /** 新增：关思考时 Anthropic 线写的 thinking.type（开放问题 1）。缺省 = 'disabled'，即 02 的行为 */
  offType?: 'disabled' | 'between_tools'
  /**
   * 新增（开放问题 3）：只在 samplingDefaultsOnly 为 true 时读。true：temperature 只收 1，top_p 只收 0.99，
   * top_k 一律拒，temperature 与 top_p 不能同发（F6）
   */
  samplingExact?: boolean
}
```

- **提示长度**：一次请求的全部输入 token，含缓存读与缓存写（F11）。按 `Usage` 算：anthropic-messages 线是 `inputTokens + cacheReadTokens + cacheWriteTokens`，openai-chat 线是 `inputTokens`（已含缓存）。与 cost.ts 的 `inputTotalOf`、02 §压缩时机与估算的「输入总量」同一口径。
- 档内缺缓存单价的，按本档的输入价计（照 02 §记录格式与费用口径「缺缓存单价的按输入价计」）。币种随 `pricing.currency`，档内不另设。
- `longPrompt` 不进 `WIRE_MODEL_FIELDS`（`pricing` 本来就不在）。`offType`、`samplingExact` 在 `thinkingSpec` 里，随它进 `modelWireHash`。缺省的键不出现在 canonical JSON 里，所以没写它们的行，`modelWireHash` 与 `modelInfoHash` 都不变。
- `offType` 只有 anthropic-messages 线读，只在 `budget`、`adaptive`、`adaptive-gated` 三种模式下有意义。`always-on`、`effort-only` 的行写它是表错误，definitions 测试断言没有这样的行。

## 对 02 的修补

02 已 `implemented`，正文不改，下面每条只增一句读法。「第 N 小节」指 02 §对 01-provider-and-tape 的修补 的第 N 小节。

1. **第 3 小节「Anthropic 线的 thinking 编码四分支」的 `{ enabled: false }` 一支**：写出的对象是 `{ type: offType ?? 'disabled' }`。`between_tools` 和 `disabled` 一样不带任何别的键（F13）；`display` 照旧只在思考开着时写，所以这里不用新加拒绝。adaptive-gated 的档位上限照旧由 `disableMaxEffort` 管（`assertMayDisable`，anthropic-messages.ts:326）。请求快照照旧记所请求的 `thinking: { enabled: false }`；attempt 复核用冻结的 `model_info` 重编，`offType` 就在里面，字节对得上。
2. **第 3 小节「`samplingDefaultsOnly` 的行……本地拒绝」**：`samplingExact` 为 true 的行，在原有拒绝之外，`top_p` 不等于 0.99 的拒，`temperature` 与 `top_p` 同在一个请求里的也拒（`temperature` 来自请求，`top_p` 来自 `requestParams`，与 shared.ts:225-241 的来源相同）。照旧抛 `ProviderInvalidArgumentError`，不触网。
3. **编码器版本**：anthropic-messages 编码器 3 → 4（01 修补 7「凡改变编码结果的提交都加一」；先例是 M6 给 openai-chat 加 `maxTokensField` 时 1 → 2）。没写 `offType` 的行编出的字节不变。采样拒绝变多不改任何写出的字节，不另加版本。openai-chat 编码器不变，仍是 2。
4. **§记录格式与费用口径「费用与用量」第一条**：冻结的 `pricing` 带 `longPrompt`，且这次 attempt 的提示长度大于 `overTokens` 时，四项用量都乘本档单价；否则照旧。
5. **§摘要请求的「思考参数」表**：不改。两新行都是 `adaptive-gated`，照表那一行传 `{ enabled: false }` 与 `effort: disableMaxEffort`（即 `high`）；Sonnet 5.5 由编码器写成 `between_tools`。

## 内置模型表的数据改动

数据，不是 spec 成员，照 02 §内置模型表的数据改动的写法列出，供逐项核对。

| 行 | 取值 |
|---|---|
| `claude-sonnet-5-5` | `nameKey: 'model.name.sonnet55'`、`purposeKey: 'model.purpose.sonnet55'`；1 000 000 / 128 000（F12）；`reasoning`、`supportsToolCalling`、`supportsCacheControl` 为 true，`thinkingPreservationFormat: 'signed-blocks'`，`usageNeedsOptIn: false`；`supportsVision`、`supportsStreamingToolCalls` 按 plan 第 1 步；`thinkingSpec: { mode: 'adaptive-gated', defaultOn: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', disableMaxEffort: 'high', offType: 'between_tools', displays: ['summarized', 'omitted'], defaultDisplay: 'omitted', samplingDefaultsOnly: true, forcedToolChoice: false }`（F3、F12、F13、F14、F10；`displays` 里的 `'summarized'` 按 plan 第 1 步）；`checksThinkingPrefix: true`（F9）；`pricing: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2.5 }`（F12） |
| `claude-haiku-5-5` | `nameKey: 'model.name.haiku55'`、`purposeKey: 'model.purpose.haiku55'`；1 000 000 / 128 000（F2）；其余能力位同上一行；`thinkingSpec: { mode: 'adaptive-gated', defaultOn: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', disableMaxEffort: 'high', displays: ['summarized', 'omitted'], defaultDisplay: 'omitted', samplingDefaultsOnly: true, samplingExact: true }`，不写 `offType`（关思考是 `disabled`，F4）、不写 `forcedToolChoice`（F10）；`checksThinkingPrefix: true`（F9）；`pricing: { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125, longPrompt: { overTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5, cacheReadPerMTok: 0.05, cacheWritePerMTok: 0.625 } }`（F11） |
| 行序与 `listing` | 按开放问题 4。不论怎么选，第一行仍是 `claude-opus-5-5`（新用户兜底，02 M5、A16），它不能是 `listing: 'more'` |
| 两份 locale | `model.name.sonnet55`「Sonnet 5.5」、`model.name.haiku55`「Haiku 5.5」；用途句与 `sonnet5`、`haiku45` 的改值按开放问题 4 |
| 注释 | anthropic.ts 文件头记 2026-10-15 的来源；`thinkingSpec` 注释段补两行的模式、`between_tools` 与 F6；Haiku 4.5 行的核查日期改为 2026-10-15（§Haiku 4.5） |

## 已有规则已覆盖、不用改的

- **预填**（F7）：02 A2 末轮须为 user，两条线的 encode() 本地拒绝（shared.ts 的 `assertLastTurnIsUser`）。
- **拒答**（F8）：`stop{ refusal }` 作废、不重发、不换模型（02 H12），Tenon 本来就不在客户端兜底；分类不解码。
- **强制 `tool_choice`**（F10）：主对话不发 `tool_choice`（02 §对 01-provider-and-tape 的修补 第 2 小节）。搜索子请求按 `['claude-sonnet-5', 'claude-opus-5']` 挑（backends.ts:81），两新行都不在候选里，见开放问题 8。
- **前缀校验**（F9 后半）：两行写 `checksThinkingPrefix: true`，与 Opus 5.5、Fable 5.1 相同，不做回合中途压缩（02 §压缩时机与估算）。
- **逐条 effort**（F13 末句，F4 同理）：页面说的是逐条消息的 `output_config.effort`，Tenon 不用这个 beta（02 A13），只改顶层 effort。页面没写关思考时改顶层档位会怎样；Tenon 关思考只在摘要请求里，一次请求一个档，开放问题 6 的 live 冒烟核一次。
- **账号绑定**（F9 前半）：同一个 `anthropic` provider 换成另一个（未关联）账号的 key 后，历史里两新行的思考块会被服务端静默丢掉，请求照常成功；守卫照记 `replay`，审计与模型实际看到的不一致。记为已知局限，不改：Tenon 不知道 key 属于哪个账号。
- **跨模型读块**：规则 2 本来就丢别的模型的思考块（02 §对 01-provider-and-tape 的修补 第 3 小节「守卫的读法」），Sonnet 5.5 与 Haiku 5.5 之间互读的差别碰不到。

## Haiku 4.5

- **现状**（F15，2026-10-15）：Active，没有公告，「不早于 2026-10-15」只是下限。A16 的推迟项没触发：本 spec 不动这一行，只把 anthropic.ts:183-188 注释里的核查日期改成 2026-10-15。
- **用途句**：「最快、成本最低」在加入 Haiku 5.5 之后不成立（F11 的单价更低），随开放问题 4 改。
- **公告之后**按开放问题 5 做。撤行那一步：删行，删 `model.name.haiku45`、`model.purpose.haiku45` 两个键；选过它的会话与「新会话默认模型」落成表外 id（02 §表外模型与不发工具：保守合成、只能纯文字、标「未验证 · 仅文字对话」）；续跑仍用 Tape 冻结的 `model_info`（02 不变量 33）。撤行是表数据改动，不另写 spec，照开放问题 5 定的时机做，在本 spec 的 plan 记一步。

## 点名：不属纯粹只增的改动

按推荐项走，只有 (b)。其余各项只在 owner 选了对应的非推荐项时才出现。

| 项 | 触发的选法 | 改了什么 |
|---|---|---|
| (a) | 开放问题 3 选 C | 02 §对 01-provider-and-tape 的修补 第 3 小节与 types.ts:117 写定的「`top_p` 只收 ≥ 0.99」改为只收 0.99，并拒同发；Opus 5.5、Sonnet 5、Opus 5、Fable 5.1 的拒绝变多；thinking-shapes.test.ts:331-337「The defaults are accepted」那条（`temperature` 1 与 `top_p` 0.99 同发）改为断言拒绝 |
| (b) | 开放问题 5 选 A | A16 的推迟项「Haiku 4.5 有弃用公告后撤行」改为：公告后收进「更多模型 ›」并写明退役日，退役日之后撤行 |
| (c) | 开放问题 8 选 B | 02 §搜索与抓取 写定的候选表 `['claude-sonnet-5', 'claude-opus-5']` 前面加 `claude-haiku-5-5` |

## 不变量

1. 没写新键的行（anthropic 现有五行、zhipu 与 ollama 各行、合成行、自定义实例行）：encode() 的字节、`promptHash`、`modelWireHash`、`modelInfoHash` 与本 spec 之前逐字节相同。
2. `offType: 'between_tools'` 的行关思考时，body 的 `thinking` 恰为 `{ type: 'between_tools' }`；档位高于 `disableMaxEffort` 时本地拒绝，0 次请求。
3. 有 `longPrompt` 的行，一次 attempt 的提示长度大于 `overTokens` 时四项全按本档，否则全按基础档；从不把一次请求拆成两段计价。
4. `samplingExact` 的行，F6 列的每种情形都在本地拒绝，不静默改请求。
5. anthropic 表第一行仍是 `claude-opus-5-5`，且不是 `listing: 'more'`。
6. anthropic-messages 编码器版本为 4，openai-chat 仍为 2。

## 验收标准

全部通过才能标 `implemented`。不注明的在 CI 里跑；〔官方 live〕只在开放问题 6 选 A 时有。

1. definitions（packages/kernel/test/provider/definitions.test.ts）：两新行逐字段等于 §内置模型表的数据改动（按 plan 第 1 步核对的结果）；行序与 `listing` 照开放问题 4；`offType` 只出现在 anthropic-messages 线、模式为 budget / adaptive / adaptive-gated 的行；`samplingExact` 只出现在 `samplingDefaultsOnly` 为 true 的行；`longPrompt.overTokens` 是正整数。
2. 关思考（thinking-shapes.test.ts）：Sonnet 5.5 关思考、档位为 low / medium / high 或不传时 body 的 `thinking` 是 `{ type: 'between_tools' }`，带了 `display` 也不写；档位 xhigh / max 本地拒绝、0 次请求。Haiku 5.5 同样，写的是 `{ type: 'disabled' }`。两行开思考带 `budgetTokens` 本地拒绝。Opus 5 关思考仍写 `disabled`。
3. 摘要请求（packages/kernel/test/loop/compaction.test.ts）：Sonnet 5.5 上的摘要请求 body 里 `thinking` 是 `{ type: 'between_tools' }`、`output_config.effort` 是 `high`，没有 `tools` 和 `display`；Haiku 5.5 是 `{ type: 'disabled' }` 与 `high`。
4. 金样（packages/kernel/test/provider/wire/encoder-version.test.ts）：anthropic-messages 当前版本 4，两张表各追加第 4 行；不关思考、行不带 `offType` 的原金样请求仍是第 3 行的字节；`GOLDEN_WIRE_HASH` 不变。
5. 采样（thinking-shapes.test.ts）：Haiku 5.5 本地拒绝 `top_p` 1、`top_p` 0.9、任何 `top_k`、`temperature` 0.5、`temperature` 1 与 `top_p` 0.99 同发；只带 `temperature` 1 或只带 `top_p` 0.99 照常编码。选开放问题 3 的 A 或 B 时，Opus 5.5 那条「The defaults are accepted」不改仍通过。
6. 思考默认（packages/kernel/test/loop/thinking-default.test.ts）：Haiku 5.5 的第一个请求带 `thinking: { type: 'adaptive', display: 'summarized' }`，不带 effort（F5）。
7. 费用（apps/desktop/test/evals-cost.test.ts）：Haiku 5.5 一次 attempt 提示长度恰为 100 000 时按基础档，100 001 时四项全按高档；只靠缓存读把提示长度推过 100 000 的也按高档；没有 `longPrompt` 的行结果与之前相同（现有用例不改）。
8. 文案（apps/desktop/test/copy-coverage.test.ts「names every Anthropic and Zhipu row」「has the display name and purpose sentence of every builtin model row」）：新键两份 locale 都有、没有占位符。
9. 菜单（apps/desktop/e2e/model-menu.spec.ts）：两新行第一行写显示名、第二行写用途句与主机，位置照开放问题 4；没选过模型的新会话仍用 Opus 5.5。
10. 搜索（packages/kernel/test/tools/search-backends.test.ts）：加了两行之后，`selectAnthropicSearchModel()` 照开放问题 8 的选法给出型号（选 A 仍是 `claude-sonnet-5`）；Sonnet 5.5 在任何候选表下都选不上。
11. Haiku 4.5（开放问题 5 未触发时）：除注释外，这一行与之前逐字节相同。
12. 〔官方 live〕两新行各跑一次 02 的官方组并通过；Sonnet 5.5 一次真实的阈值压缩，线上摘要请求是 `between_tools`、返回 200；Haiku 5.5 的回复里有非空的摘要思考；两行第二个请求的 usage 里有缓存读。结果记进 plan。

## 开放问题

每题推荐项写在最前。全部在本 spec 改 `ready` 之前由 owner 定。

1. **关思考的形态怎么表达**
   - **A（推荐）**：`ThinkingSpec` 只增 `offType?: 'disabled' | 'between_tools'`；Sonnet 5.5 记 `adaptive-gated` + `disableMaxEffort: 'high'` + `offType: 'between_tools'`。档位上限沿用 `assertMayDisable`，`summaryThinking`（compaction.ts:27-42）不用改，缺省就是 02 的行为。
   - B：`mode` 只增一个值（如 `'adaptive-between-tools'`）。每个按 mode 分支的地方都要补：anthropic-messages.ts 的 `thinkingShape`、compaction.ts 的 `summaryThinking`（它的 `default` 分支会让摘要请求照常思考，不报错，漏补也不会被发现）、definitions 测试。
   - C：不建模，Sonnet 5.5 记 `always-on`。契约不动；代价是摘要请求在 Sonnet 5.5 上按默认 high 照常思考，行数据也与厂商能力不符。
2. **分档价格的形状**
   - **A（推荐）**：`pricing` 只增一个可选的 `longPrompt`（一个阈值加一组高档单价）。现在只有 Haiku 5.5 用到；以后真出现第三档再只增。
   - B：`pricing` 只增 `tiers: Array<{ overTokens, ...单价 }>`，按阈值升序取最后一个满足的。更通用，但现在用不上，还要多一套排序与校验。
3. **采样守卫怎么收紧**（三项对线上都没影响：内置 Anthropic 行都没有 `requestParams`，循环也不设 `temperature`，守卫拦的只是表错误）
   - **A（推荐）**：只增 `samplingExact`，只给 Haiku 5.5 设。纯只增，精确规则只用在页面写明的行上（F6）。
   - B：同 A，Sonnet 5.5 也设。F14 只说「非默认值 400」，没给默认值、没提同发，这是推断。
   - C：所有 `samplingDefaultsOnly` 的行统一收紧，不加成员。规则只有一套；但把 Haiku 5.5 的默认值 0.99 套到默认值未知的四行上，不见得更保守（若某行默认是 1，就拒了它的默认值）；改 02 写定的阈值，见 §点名 (a)。
4. **菜单位置与用途句**（不论选哪项，Haiku 4.5 的「最快、成本最低」都要改）
   - **A（推荐）**：两新行进主列表，排在 Opus 5.5 之后（Sonnet 5.5、Haiku 5.5）；Sonnet 5、Haiku 4.5 收进「更多模型 ›」（先例是 A16 把 Opus 5 收进去）。用途句：Sonnet 5.5「速度与能力兼顾 / Balanced speed and capability」（沿用 Sonnet 5 的那句），Haiku 5.5「成本最低 / Lowest cost」（F11：表里单价最低，高档也是）；Sonnet 5 改「上一代 Sonnet / Previous Sonnet」，Haiku 4.5 改「上一代 Haiku / Previous Haiku」。不写「旧版」，因为厂商没给这两行标 Legacy。
   - B：七行里六行在主列表（Opus 5 仍在更多模型），只改 Haiku 4.5 的用途句。
   - C：两新行先进「更多模型 ›」，开放问题 6 的 live 冒烟过了再提到主列表（照 A16 让 Opus 5.5 先过验收再排第一的做法）。
5. **Haiku 4.5 有弃用公告之后**（弃用页出现它的条目时执行）
   - **A（推荐）**：公告后的第一个版本把它收进「更多模型 ›」（4 选 A 时已在那里），用途句写明退役日；退役日之后的第一个版本撤行。公告到退役至少 60 天（F15），这期间厂商照常服务；公告即撤行，选过它的会话和默认模型会立刻落成表外 id、只能纯文字。改 A16 的推迟项，见 §点名 (b)。
   - B：照 A16，公告后撤行。
6. **官方 key 的 live 冒烟**
   - **A（推荐）**：跑，覆盖验收 12。key 照 02 的规矩从钥匙串 `tenon-live-anthropic` 读，只进那一次命令的环境，读前提醒 owner（macOS 会弹窗）。每组几千到两万多 token。
   - B：只用按文档写的夹具，plan 的验收记录列出没能对照的项（照 02 §Anthropic 保证档的退路）。
7. **Haiku 5.5 的高档与压缩阈值**：1M 窗口的行在 150 000 token 压缩（compaction.ts:13-15，`min(0.8 × 窗口, 150 000)`，02 H10），所以 Haiku 5.5 提示在 100 000 到 150 000 之间的请求，单价是低档的 5 倍（F11）。
   - **A（推荐）**：不动，费用照实记；校准 H10 的绝对上限时（02 plan 第 34 步）把这一档算进去。
   - B：`ModelInfo` 只增一个按行的压缩上限，Haiku 5.5 设 100 000，让请求尽量落在低档；代价是压缩更勤，细节丢得更早。
8. **搜索子请求要不要改用 Haiku 5.5**
   - **A（推荐）**：不改，候选仍是 `['claude-sonnet-5', 'claude-opus-5']`（02 §搜索与抓取；backends.ts:81）。Sonnet 5.5 因 `forcedToolChoice: false` 本来就选不上。Haiku 5.5 收强制 `tool_choice`（F10），但它对搜索请求的回应形状没有实测过。
   - B：候选表最前加 `claude-haiku-5-5`（更便宜）。改 02 写定的候选表，见 §点名 (c)；要先用官方 key 实测一次搜索回应。
