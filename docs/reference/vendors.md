# 厂商现状

我们依赖的外部厂商能力，一张现行的表（docs/spec-driven-dev.md「厂商现状」）。每行写能力、实测结果、核实日期、一手来源、依赖它的 spec、什么时候重核。厂商文档变了或实测出新结果，就改这一行和核实日期，并在文末「## 修订」记一行。「X 不支持 Y」这类说没有的话，也要实际查过才写；查不实的标「未核实」。

现在只收 Anthropic（ADR-004 A12：随 claude-5-5-models 第 1 步先核实 Anthropic，其余厂商随以后的核实补上）。

## Anthropic

一手来源都在 `https://platform.claude.com/docs/en/` 下，表里只写路径。Tenon 把 `anthropic-version` 钉在 `2023-06-01`，有两处：packages/kernel/src/provider/wire/anthropic-messages.ts 的 `ALLOWED_HEADERS`，以及 packages/kernel/src/tools/search/backends.ts 里网络搜索请求的固定头；SDK 是 `@anthropic-ai/sdk` 0.128.0。下表凡与 API 版本有关的，都按这个版本读。「依赖它的 spec」一列带上 claude-5-5-models §事实与出处 的编号（F 几），方便查回原文。

| 能力 | 实测结果 | 核实日期 | 一手来源 | 依赖它的 spec | 重核 |
|---|---|---|---|---|---|
| Sonnet 5.5：id `claude-sonnet-5-5`，上下文 1M、同步 Messages API 输出上限 128K，输入 $2、输出 $10、5 分钟缓存写 $2.50、缓存读 $0.10（每百万 token） | 未实测（claude-5-5-models 第 12 步） | 2026-10-23 | `models/sonnet-5-5/overview`；`about-claude/pricing`；`release-notes/overview`（2026-10-07 缓存读降价） | claude-5-5-models F12 | 定价页或发布记录改价时 |
| Haiku 5.5：id `claude-haiku-5-5`，固定 id、无日期后缀、无别名；上下文 1M、同步 Messages API 输出上限 128K | 未实测（同上） | 2026-10-23 | `models/haiku-5-5/migration-guide`；`models/haiku-5-5/overview` | claude-5-5-models F1、F2 | 厂商发新一代时 |
| Haiku 5.5 按单次请求的提示长度分两档计价：不超过 100 000 token 时输入 0.10、输出 0.50、缓存读 0.01、5 分钟缓存写 0.125；超过时 0.50、2.50、0.05、0.625。提示长度含缓存读写 | 未实测 | 2026-10-23 | `about-claude/pricing`（分档规则只在这一页）；`models/haiku-5-5/overview`（价格表） | claude-5-5-models F11 | 定价页改价时 |
| 两行都有 low 到 max 五档 effort；Haiku 5.5 默认 medium；Sonnet 5.5 在 Claude API 上默认 high | 未实测 | 2026-10-23 | `build-with-claude/effort` | claude-5-5-models F3 | 厂商发新一代、或 effort 页改档位时 |
| Haiku 5.5 默认开思考；`disabled` 只在 high 及以下可发，发了就不能逐条改 effort；预算式 `budget_tokens` 是 400 | 未实测 | 2026-10-23 | `build-with-claude/effort`；`models/haiku-5-5/migration-guide` | claude-5-5-models F4 | 同上 |
| Sonnet 5.5 关思考要发 `between_tools`（发 `disabled` 是 400），只在 high 及以下、不能带别的键；不带 tools 时只回正文；用它时不能逐条改 effort；预算式 `budget_tokens` 是 400 | 未实测（第 12 步验摘要请求） | 2026-10-23 | `models/sonnet-5-5/whats-new-sonnet-5-5` | claude-5-5-models F13 | 同上 |
| display 两行默认都是 omitted；两行都收 `display: "summarized"` | 未实测 | 2026-10-23 | `models/haiku-5-5/migration-guide`；`models/sonnet-5-5/migration-guide` | claude-5-5-models F5、F12、F18 | 同上 |
| 采样参数（API 版本 2026-10-21 之前）：页面列出的模型（含 Opus 5.5、Opus 5、Sonnet 5.5、Sonnet 5、Fable 5.1、Haiku 5.5 这六行）的非默认值都是 400，开不开思考都一样；`top_p` 默认 0.99；`temperature` 与 `top_p` 同发是 400。更早的模型只在开思考时受限；Haiku 4.5 属不属这一类，页面没点名，未核实 | 未实测 | 2026-10-23 | `build-with-claude/thinking` §Sampling parameters | claude-5-5-models F14 | 改 `anthropic-version` 或升 SDK 之前 |
| API 版本 `2026-10-21` 的 Messages API 不兼容改动：任何模型带 `temperature`、`top_p` 或 `top_k`（取任何值）都是 400；assistant 消息里直接放 `document` 块是 400；user 消息里 text 块带非空 `citations` 是 400。TypeScript 要 `@anthropic-ai/sdk` 1.0.0 起才用这个版本。Haiku 5.5 迁移页改为只写「省略这三个采样参数」。Tenon 现在不发这个版本 | 未实测 | 2026-10-23 | `api/migration-2026-10-21`；`api/versioning`；`build-with-claude/thinking` §Sampling parameters | claude-5-5-models F6、F14 | 改 `anthropic-version` 或升 SDK 之前 |
| 两行都拒 assistant 预填（Haiku 5.5 关思考也拒） | 未实测 | 2026-10-23 | `models/haiku-5-5/migration-guide`；`models/sonnet-5-5/migration-guide` | claude-5-5-models F7 | 厂商发新一代时 |
| 强制 `tool_choice`：Haiku 5.5 收（响应从工具调用开始、没有思考块）；Sonnet 5.5 不收 | 未实测 | 2026-10-23 | `models/haiku-5-5/migration-guide`；`models/sonnet-5-5/whats-new-sonnet-5-5` | claude-5-5-models F10 | 同上 |
| 拒答按 `stop_details.category` 分类：Haiku 5.5 四类（cyber、frontier_llm、bio、general_harms），没有服务端 fallback；Sonnet 5.5 五类（多 reasoning_extraction），有 beta 版服务端 fallback（Claude API 与 Google Cloud 上的 Anthropic 托管版） | 未实测；Tenon 不解码分类、不发 `fallbacks` | 2026-10-23 | `models/haiku-5-5/migration-guide`；`build-with-claude/prompt-engineering/prompting-claude-haiku-5-5`；`models/sonnet-5-5/whats-new-sonnet-5-5` | claude-5-5-models F8、F17 | 要解码拒答分类或接 fallback 时 |
| 思考块绑账号（别的账号发来的块被丢弃、请求照常成功）；前缀校验：块之前的内容变了块就失效（2026-08-31 起建的账号默认强制） | 未实测 | 2026-10-23 | `build-with-claude/preserved-thinking` | claude-5-5-models F9；02-agent-loop | 改思考块的回放规则时 |
| 工具调用的输入流式返回，不分型号（`input_json_delta` 片段；标准流式按完整键值吐，可能有停顿）；细粒度工具流式在 Claude API 上所有模型都支持，要在工具上设 `eager_input_streaming: true` | 未实测 | 2026-10-23 | `build-with-claude/streaming` §Input JSON delta；`agents-and-tools/tool-use/fine-grained-tool-streaming` | claude-5-5-models F21 | 要开细粒度工具流式时 |
| 两行都收图片输入（vision） | 未实测 | 2026-10-23 | `models/overview`；`models/haiku-5-5/overview`；`models/sonnet-5-5/whats-new-sonnet-5-5` | claude-5-5-models F18 | 厂商发新一代时 |
| Sonnet 5.5 在工具调用之间写的较长说明以 progress-update 思考块返回，默认 display 下文本为空 | 未实测 | 2026-10-23 | `models/sonnet-5-5/migration-guide` | claude-5-5-models F19 | 改工具行的思考展示时 |
| 两行的最小可缓存提示长度是 512 token（Sonnet 5 是 1 024） | 未实测（第 12 步验缓存读） | 2026-10-23 | `models/sonnet-5-5/whats-new-sonnet-5-5`；`models/haiku-5-5/overview` | claude-5-5-models F20 | 改缓存策略时 |
| Haiku 4.5（`claude-haiku-4-5-20251001`）：弃用页状态 Active、Deprecated 一栏 N/A、退役「不早于 2026-10-15」（下限已过，仍无弃用公告）；退役前至少提前 60 天通知 | — | 2026-10-23 | `about-claude/model-deprecations` | claude-5-5-models F15、§Haiku 4.5；02-agent-loop | 每次动内置表时，或弃用页出现它的条目时 |
| Sonnet 5、Haiku 4.5、Opus 5 都在 Legacy 名单里：不再更新、以后可能弃用，不等于弃用 | — | 2026-10-23 | `models/overview`；`about-claude/model-deprecations` | claude-5-5-models F16 | 同上 |

## 修订

- 2026-10-23 · 新建，先收 Anthropic：claude-5-5-models 的 F1–F21 逐条对一手页面重核，19 条不变（其中 5 条只改了措辞），F6、F14 因 API 版本 2026-10-21 变了 · claude-5-5-models plan 第 1 步，ADR-004 A12，b1b1577
