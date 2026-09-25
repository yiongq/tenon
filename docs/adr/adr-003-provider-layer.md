# ADR-003：Provider 层选型与厂商分档 —— 官方 SDK + 自写适配器（K+），不以 AI SDK 为运行时依赖

- **状态**：提议（依据裁决 M3、M7、M2、M6、M8；owner 审过后改为「采纳」）
- **日期**：2026-09-25
- **背景**：阶段 2 要让 agent 在智谱和 Anthropic 上都过验收。owner 追问过「要支持各种厂商，要不要引入 AI SDK」。复核发现 01 spec.md:126-131 的选型理由大半不准；按 amend 规则 01 正文不能改，所以更正落在这份 ADR（[spec-driven-dev](../spec-driven-dev.md)「改变决定」：跨阶段的技术选型写 ADR）

---

## 决策

1. **依赖不换。** 继续用 `@anthropic-ai/sdk`、`openai` 两个官方 SDK，加两个自写的线协议适配器（`anthropic-messages`、`openai-chat`）。AI SDK 只当参考：vercel/ai 的源码和 CHANGELOG 用作对账清单和测试向量；两边都是 Apache-2.0，借鉴实现或测试向量时保留署名，列进 `NOTICE`。
2. **02 以只增的方式补齐保真与审计。** 厂商原样块、Opus 5.5 的思考形状、不支持的采样参数在本地拒绝、Anthropic 顶层 `cache_control`、attempt 的 `encoder` 与 `modelWireHash`、智谱行的思考回传与 `tool_stream`、finish_reason 映射。全文在 [02 spec](../architecture/02-agent-loop/spec.md)「对 01-provider-and-tape 的修补」。
3. **厂商分三档**：保证、能接上、纯文本（见下文「厂商分档」；裁决 M2、M6）。
4. **第一条新线是 `openai-responses`**，在已经依赖的 `openai` SDK 上自写，按需触发（裁决 M7）。
5. **ai-sdk 线只作预案**，启用条件见下文。

---

## 更正 01 的选型理由（01 spec.md:129）

01 正文不改；01 顶部的 `Amended by` 行附一句「选型理由的更正见 ADR-003」。

- **理由一**（`ai` 静态到达 `node:` 模块，做不到 host 无关）：写的当天就不准。在 Tenon 自己的 browser 门禁下（`packages/kernel/test/host-independence.test.ts`，esbuild `platform: 'browser'`），`ai@7.0.105` 打包 0 错误，因为 `@vercel/oidc@3.2.0` 的 exports 有 browser 条件。`--platform=neutral` 下的 8 个错误全部来自 oidc；但 01 选定的 `@anthropic-ai/sdk@0.126.0` 在 neutral 下同样失败，拿这一条区分两者不成立。
- **理由二**（统一的 stop reason 把 `pause_turn`、`refusal` 折叠掉）：事实成立（vercel/ai@5c830d57 `packages/anthropic/src/map-anthropic-stop-reason.ts:14-19`），但结果里有 `raw` 字段（`packages/provider/src/language-model/v4/language-model-v4-finish-reason.ts:8-33`），不构成否决理由。
- **理由三**（`@ai-sdk/openai-compatible` 无条件回传 `reasoning_content`）：不准。条件是「非空才回传」，消息级 `providerOptions` 可以逐条决定回不回传（`packages/openai-compatible/src/chat/convert-to-openai-compatible-chat-messages.ts:14-18、:238-244`），`transformRequestBody` 也早已公开。
- **理由四**（Tenon 要 Tape 形状的事件流）：只对了一半。provider 层的 V4 stream part 是协议层内容块，不是 UI 形状；真正成立的是下一节的第 1、2、3 条。

## 不用 AI SDK 的真实理由

1. **`encode()` 是同步纯函数**（`packages/kernel/src/provider/types.ts:98`）。`promptHash`、`thinkingDecisions` 审计和按模型的回传策略都建立在它上面，归 Tenon 自己管。AI SDK 生成请求体是异步的，body 随 SDK 版本变化，里面还夹带 SDK 自己的策略判断。
2. **回放保真。** AI SDK 从中间表示重新编码，不是原样发回：未知块会丢（`anthropic-api.ts` 的 zod 白名单）；已知块上的未知字段被剥掉；`tool_use` 被挪到末尾（`convert-to-anthropic-prompt.ts:1485-1510`）；对话中途的 system 在没有首条 system 时被提到顶层（:220-221）；fallback 边界块按设计丢弃（`anthropic-language-model.ts:1668-1673`）。这些都会撞上 Opus 5.5 preserved thinking 的前缀检查。
3. **按 modelId 子串硬编码的能力表**（`@ai-sdk/anthropic@4.0.62` `src/anthropic-language-model.ts:421-446、:3244-3272`）：默认 max_tokens、静默丢 temperature、改写 thinking、把强制 tool_choice 降成 auto。它会盖掉 Tenon 的 `ModelInfo`，而且不留审计。
4. **官方 SDK 不剥未知字段**，新字段发布当天就能发出去。AI SDK 对 Anthropic 新功能跟进滞后：`web_search_20260318` 晚了 97 天；`code_execution_20260521` 过了 105 天仍不支持（这两个数已用 `gh api` 与 `npm view time` 核对）；inline tools 也还不支持（最新条目的日期待复核）。
5. **host 边界。** import `ai` 核心时会在顶层执行 `os.hostname()`；URL 下载默认绕过注入的 fetch（`packages/provider-utils/src/fetch-with-validated-redirects.ts:17-26`）；没有显式传 apiKey、baseURL 时会读 `process.env`。这些和 `HostAdapter.network` 以及 02 的「key 绑定主机」（裁决 A9）冲突。

不引用 Cline 4.0.1 的回滚与 OpenCode 的 blockBinding 补丁：复核已撤回这两条论据（前者不能归因到 AI SDK；后者上游第二天就发布了同样的支持）。

---

## 厂商分档

代码只有一套，与厂商无关；厂商之间的差别只落在 provider 定义（数据）、线协议适配器、搜索后端，以及 desktop 侧的两条规则（不带工具的 provider 名单、key 绑定主机）（裁决 M2）。

| 档 | 02 里是谁 | 怎么接 | 界面标记 | 验收 |
|---|---|---|---|---|
| 保证 | 智谱 glm-5.3 系（OpenAI 兼容线，验收基准）；Anthropic，只算官方端点 `api.anthropic.com`，智谱 `/api/anthropic` 不算 | 内置定义文件加模型行 | 已验证 | 进 02 验收；Anthropic 那一列要官方 key |
| 能接上 | 02 之后那份自定义厂商 features spec 的交付物：通用定义工厂加数据，实例 id 形如 `custom:<uuid>`；前提是 A9 的强制检查，第一版不开自定义请求头和任意 body 参数。02 里只有两种：内置厂商下手填表外模型 ID（只能纯文本）；把 `zhipu` / `anthropic` 定义的 `baseURL` 改指其他主机（智谱 `/api/anthropic`、智谱国际站，以及 DeepSeek、Kimi、百炼、OpenAI 等兼容端点），这时内置行照该行能力数据发，不保证，换主机要按 A9 重填 key。OpenAI 在 02 里不跑 agent，纯文本走这条路接入（M7；读法待 owner 确认，见 02 spec 开放问题 第 9 条） | 定义工厂加数据 | 本机探测（探测通过后开工具，不保证） | 不进 02 验收 |
| 纯文本 | Ollama，只接本机或内网实例（02 两种形态都不发工具，靠范围规则，裁决 A14） | 现有 `ollama` 定义 | 未验证 · 仅文字对话（02 里 Ollama 行实际标「本机 · 仅文字对话」，见下） | 不进 02 的 agent 验收；02 只断言发给 Ollama 的请求不带 `tools` |

- 三档对应的三种标记，是 M6 的 features spec 落地之后的状态；02 实际产出的标记见 02 spec「界面范围」（Ollama 行标「本机 · 仅文字对话」，手填的表外模型标「未验证 · 仅文字对话」，02 里没有「本机探测」）。
- **每档怎么接。** 兼容协议靠定义工厂加数据，不必逐家写 `ProviderDefinition` 文件；自有协议要写新的线协议适配器。
- **「厂商差异做成数据」的清单**：回传字段、回传策略、finish_reason 词表、额外参数，再加 M7 补的五项：区域地址（国内站 / 国际站）、按（端点, 模型）区分的回传策略、tool_call 级不透明字段、usage 字段路径、max_tokens 字段名（OpenAI 推理模型要 `max_completion_tokens`，未实测）。02 只做 finish_reason 词表（`ProviderDefinition.finishReasons`，裁决 A12），其余归 M6 那份 features spec。
- **其他境内厂商进保证档**：随阶段 7 的国内合规一起评估（master-reference.md:973；ADR-002 决策 5），每家一个定义文件加一轮 live。市场依据另记。

## 第一条新线：openai-responses（自写）

- **触发条件**：owner 要让 OpenAI，或 xAI、Bedrock 等 Responses 端点跑 agent。依据：GPT-5.4 起，Chat Completions 上开着推理就不能调工具；GPT-6 Astra 调工具只能走 Responses。
- **做法**：在已经依赖的 `openai` SDK 上自写，不加新依赖。规模参照 OpenCode 的 `openai-responses.ts`（1022 行），估 1–1.5 步。
- 它也是以后做 ChatGPT 订阅登录的前提之一（裁决 M8）。它算 amend 还是 supersede，写进届时那份 spec。

## ai-sdk 线的启用条件（预案）

- **只在这种情况下启用**：Gemini 原生、Bedrock SigV4 或只支持 Converse 的模型进了保证档，而原生线又排不上。
- **启用时**：放在 kernel 外；精确锁版本；凭据显式传入；下载强制走宿主；`thinkingPreservationFormat` 只允许 `drop` / `text-only`。
- **启用前先查**：`@ai-sdk/anthropic/internal` 有没有稳定性承诺；`@ai-sdk/google`、`@ai-sdk/amazon-bedrock` 能不能过 kernel 的 browser 门禁和环境变量审计。两项都未核实。
- 这条线算 amend 还是 supersede，届时由 owner 裁定。
- **不算触发条件的**：Vertex、Bedrock 的短期 key，它们缺的是令牌提供者钩子，不是线协议；OpenAI Responses 已改为上一节的自写线。

## SDK 升级算「SDK 现实」变更，不走 SDD

`@anthropic-ai/sdk` 0.126 → 0.128，`openai` 7.17 → 7.23。升级后重跑 01 验收 8 的 browser 打包、全局 fetch 探针、环境变量诱饵测试（`packages/kernel/test/provider/wire/anthropic-stream.test.ts:67-69`），并复核随 SDK 变化的保留键（`anthropic-messages.ts:87-92`）和请求头白名单。在 02 plan 里记一笔；任何一项不过就留在旧版本。发出两个以上 beta 值之前必须完成（裁决 A16）。

---

## 订阅登录不是 provider（裁决 M8）

三家订阅都不作为 Tenon 的登录方式：

- **Claude**：[法务页](https://code.claude.com/docs/en/legal-and-compliance)原文「Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens」；[Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart) 原文「Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products」；Consumer Terms 只允许经 API key 做自动化访问；帮助中心 13189465 写明「attempt to route third-party traffic against subscription limits ... is prohibited」。
- **ChatGPT**：帮助中心 9793128 有不利表述（「Reselling access or using ChatGPT to power third-party services」）；现有做法借用 Codex CLI 的 OAuth client、打非公开端点；让第三方以自己身份接订阅的 SIWC 还没对第三方开放；订阅只能调 OpenAI 模型，而 OpenAI 不在保证档。
- **智谱 Coding Plan**：[订阅协议](https://docs.bigmodel.cn/cn/terms/subscription-agreement)第六条第 2 款禁止在自建应用里调用。

第三方产品接 Max 有两种做法。下面各条写的是核实过的例子（OpenClaw 那条 2026-09-25 另查了它的官方文档）：

1. **复用或中转订阅凭据**：读取、保存、代发 Claude.ai 的凭据或 session token。法务页明文禁止；OpenCode 已于 2026-03-19 按 Anthropic 的法律要求删掉内置的 Claude 订阅插件。
2. **调本机未修改的官方 Claude Code、由用户自己登录**（底表核实过 Cline、Cherry Studio v2、Zed 调本机官方 Claude Code 或 Agent SDK；OpenClaw 同样调本机官方 Claude Code，见 openclaw/openclaw `docs/providers/anthropic.md`（2026-09-25）：「Claude CLI - reuse an existing Claude Code login through the installed executable」「OpenClaw communicates directly with the installed Claude Code executable」；它接 ChatGPT 订阅走的是上面 ChatGPT 一条说的做法，不作先例；Agent SDK 走订阅按文档仍须事先批准）：法务页从 2026 年 8 月下旬起明文允许运行未修改的 Claude Code 二进制，前提是接受 Commercial Terms；额度从哪扣由 Anthropic 决定，13189465 保留了改从 usage credits 按 API 价扣的权利。

第二种不是一条 provider 线：它把循环、工具和提示词整体交给 Claude Code，Tenon 自己的循环就测不到了，所以不在本 ADR 的分档里。它记为后续可选的「Claude Code 引擎」features spec，02 不做（M8 ownerNote、laterPhase）。这项政策半年里改了三次，设计不押在它上面。

---

## 什么情况改判

- `@ai-sdk/anthropic` 公开 `transformRequestBody`、支持未知块和未知字段原样往返、能力表可以覆盖；或者 Anthropic 一手说明前缀检查按语义比较、能容忍字段丢失：重新比较 P-transport。
- owner 把非兼容协议的厂商纳入保证档：ai-sdk 线提前。
- owner 把 OpenAI 放进保证档：`openai-responses` 提前（即 M7 的 B）。
- AI SDK 公开原样往返和同步生成请求体，并且不再读环境变量：重新比较 P-strict 与 S。

## 被否决的方案

- **M3-K 原样保持现状**：等于没做完的 K+。Opus 5.5 一开 thinking 就 400，display 设不了，未知块被丢；智谱行的 `drop` 与厂商文档不符；attempt 不带编码器版本，以后换库时旧 promptHash 没法复核。
- **M3-H 现在就加第三条 wire「ai-sdk」接长尾厂商**：对 OpenAI 兼容的长尾它反而不如 `openai-chat` 线（畸形帧会清空 raw，截断的 tool-call 照样发出）；要新增运行时依赖；M2 没把这些厂商放进保证档，02 里没有用户。
- **M3-P-transport 保留 Tenon 的 encode，只把发送和解码交给 `@ai-sdk/*`**：解码仍走 zod 白名单，未知块和未知字段照样被丢；它改的是 01 的既有选型，只能整份 supersede 01。
- **M3-P-strict 由 AI SDK provider 包生成请求体**：生成请求体是异步的，`encode()` 要么改成 async，要么让 promptHash 改义，旧 promptHash 全都没法复算；能力表会盖掉 `ModelInfo`；同样要整份 supersede 01。
- **M3-S / M7-D 整体换成 AI SDK**：P-strict 的问题它全有；默认重试会破坏 `physicalAttempt` 计数；URL 下载绕过注入的 fetch；Tenon 自研循环用不上 streamText 的多步循环。
- **M7-B 02 里就自写 openai-responses 线**：M2 没把 OpenAI 放进保证档，这条线会挤占 Opus 5.5 和智谱的工作。
- **M7-C 现在就在 kernel 外加 ai-sdk 线接长尾**：问题同 M3-H，另外它会读环境变量，改写请求体也不留审计。
- **M8-B 给 Tenon 加 ChatGPT 订阅登录**：两条保证线一分钱都省不了；条款有不利表述；端点不公开。
- **M8-C 开发、评测期让 Tenon 调本机 Claude Code 或 Agent SDK 用 Max 跑 Claude 模型**：测不到 Tenon 自己的循环，而 H15 要验的正是它；Agent SDK 走订阅按文档要事先批准；协议验收照样要 API key。它否的是「当开发和评测手段」，不影响上文「Claude Code 引擎」作为可选 features spec。

## 参考

- 上游：vercel/ai@5c830d57 的 `packages/anthropic/src/map-anthropic-stop-reason.ts:14-19`、`packages/provider/src/language-model/v4/language-model-v4-finish-reason.ts:8-33`、`packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts:566-586`（畸形帧清空 raw）、`packages/provider-utils/src/fetch-with-validated-redirects.ts:17-26`、`packages/anthropic/src/anthropic-provider.ts:80-112`（公开 settings 里没有 `transformRequestBody`）；`@ai-sdk/openai-compatible@3.0.55` `src/chat/convert-to-openai-compatible-chat-messages.ts:14-18、:238-244`；`@ai-sdk/anthropic@4.0.62` `src/anthropic-language-model.ts:421-446、:3244-3272`。
- 本仓库：01 spec.md:126-131（选型原文）、:763（开放问题 2）；`packages/kernel/src/provider/types.ts:98`；`packages/kernel/src/provider/wire/anthropic-messages.ts:92-103`（RESERVED_KEYS）、:640-648（服务端块被跳过）。
- 产品对照（2026-09-25 调研，8 家）：多厂商产品的自定义厂商表单几乎一样（名称、协议格式、地址、key、模型 ID）；支持多厂商不以 AI SDK 为前提，LobeHub 开源版接了 85 家，一个 AI SDK 包都没用；用了 AI SDK 的 OpenCode、Cherry Studio 都另写了厂商规则层或给 dist 打了补丁。
- 条款：Claude [法务页](https://code.claude.com/docs/en/legal-and-compliance)、[Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)、帮助中心 13189465；ChatGPT 帮助中心 9793128；智谱 [订阅协议](https://docs.bigmodel.cn/cn/terms/subscription-agreement)。
- 实测：打包门禁、运行时副作用、回放保真、功能跟进速度的探针与原始输出不入库，结论写在本 ADR 与 02 spec，照 01「探针不入库」的写法。
