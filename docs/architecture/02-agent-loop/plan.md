# 02 · Agent loop — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。每一步结束时仓库都是绿的。「验收 N」指 spec §验收标准，「不变量 N」指 §不变量，「开放问题 N」指 §开放问题；测试要点里的「旧 N」是瘦身前的验收编号，只为对照，断言以这里写的为准。

进度吃紧时的砍法（裁决 M1）：

- **不能砍**：第 0 步、①、②。**不在砍法里**：提问（H6）、评测基线、同题对比；要等它们做完才能标 implemented，想移出去要 owner 另外决定。
- **砍的顺序**（③ 按它的倒序实现）：先砍子 agent（H5）；再砍摘要压缩（H10，前提是日常线 glm-5.3-flash 有 1M 窗口，改用 200K 的模型要重估；spec §tools 只在下列时点变化 表里「摘要压缩」那一行随之移走，以后用 amend 加回）；最后一档由 owner 定：搜索与抓取两家一起砍（M2），这时 `HostNetwork.fetchUntrusted` 不做，对话形态只剩提问，同题对比剔掉联网题，D7、E4 的「抓取器防绕过」改为「只挡 URL 字面」。
- **怎么砍**：被砍的部分还没有代码，在 spec 顶部 Revisions 记下砍掉的目标和验收（日期、原文、原因），不走 amend，随之删的验收见 spec §验收标准 开头；契约文字留在 02，①② 已依赖的形状不删（`session/profile_set.subagentOf`、`waitingFor: 'subagent'`、收口表里「等子 agent」的分支、`ToolResultPayload.handoff` 及其 `SubagentHandoff` / `HandoffCall`（第 8 步声明）、`session/parent_link` 的载荷）；实现和验收移到 `docs/features/` 下的新 spec，它加成员写 `Amends: 02`；§13 阶段 2 加带日期注记（§文档同步「砍的时候再改」）。③ 要给 ① 已写代码的契约加成员时，只能把那一项照砍法移出去；例外只有给 spec §主进程与 kernel 的循环接口 的宿主端口加可选成员（暂定，开放问题 26）。
- **不算砍**：官方 key 没到手时，Anthropic 搜索后端与协议验收按 M4 记为「保证档待补」。**M5-B 是降级，不是砍**：ModelMenu 不砍，三条跨厂商回放测试 1 步内修不完才退到 M5-B，逐条记进 Revisions。手填模型 ID（M6）不在砍法里。
- **顺序可以调**（不是砍）：owner 更看重对话形态时，可以把提问、搜索与抓取挪到 ① 和 ② 之间，长输出落盘随之提前。

三条纪律：

- 发给模型的工具表里，只放审批和收口都已做完的工具（spec §一批工具怎么执行「实现纪律」）。
- 每一步开工前先看 spec §开放问题 里「最晚」落在这一步的条目；标「不开工」的没定之前，对应小步排到同一段最后，PR 里写明缺什么（AGENTS.md:7）。
- 某一步列出的验收如果还依赖后面的步骤，这一步只跑已经具备的部分，整条等依赖齐了在后一步勾上，并在实施记录里写明。主要的依赖：

| 验收 | 先跑的部分 | 补齐于 |
|---|---|---|
| 9 的结束码、`done.endReason` 与 `tool-outcome` | 第 7 步（映射、`thinking-delta`、`tool-call`、`attempt-discarded`） | 第 13 步（结束码）、第 14 步（`tool-outcome`）、第 17 步（`user-message`） |
| 13 的四组互赋 | 第 5 步（`PolicyState`） | 第 12 步（判决摘要）、第 16 步（待批行）、第 19 步（会话选择） |
| 17 的步数跨重启 | 第 13 步 | 第 15、16 步 |
| 7 的复算 promptHash、12 的挂靠与同批原子性 | 第 6、8 步的编码与写入器 | 第 10 步的组装清单、第 15 步的答复与续跑、第 19 步的选模型（旧 123） |
| 14 的「等审批」时点与崩溃时点、19 与 20 的 kernel 部分 | 第 14、15 步 | 第 15、16、20、22 步（崩溃要第 16 步的恢复，e2e 在第 20 步，要执行写入的在第 22 步） |
| 26 的拦截回执、跨 Run 批准、插话、切 provider | 第 10 步的冻结与排除 | 第 11（调用时拦下）、12（判决）、14（收口）、15、17、18（改界面语言、加文件夹）、19、20 步 |
| 27 的出卡格、36 的连接器卡 | 拦截与放行 | 开放问题 15 定下之后 |
| 36 的写入卡与不可逆卡 | 第 20 步的工作区外读卡 | 第 22 步 |
| 18 的续跑后插入排队消息 | 第 16 步 | 第 17 步 |
| 18 的子会话可续跑 | — | 第 31 步 |
| 20 的已排队消息排在新消息前 | 第 15 步 | 第 17 步 |
| 25 的工具集 | 第 10 步（测试注册表） | 第 18、22、26、28、29、31 步 |
| 25 的参数校验收口与 effect | 第 10 步 | 第 13、14、18、22 步 |
| 28 的判决事实 `policyVersion` 与调用时第 1 层拦下 | 第 11 步（`decide`） | 第 12、13、14 步 |
| 29 的 Glob / Grep 跳过保护子树、对话形态 Read | 第 11 步 | 第 14、18 步 |
| 31 的 `blocked-repeatedly`、停止收口、每个调用一条判决 | 第 12 步 | 第 13、14 步 |

规模粗估（M1）：第 0 步 1–2 步的量；① 15–18 步，另加模型菜单 1–1.5 步、手填模型 ID 0.3–0.5 步；② 5–6 步；③ 7–11 步；收尾 1–3 步。下面的编号是执行顺序，不是工作量。

## 第 0 步：前置（不能砍）

- [ ] 1. **修补与文档落地，回答「改为 ready 之前必须定」**（一个提交，裁决 D2；PR 描述单独点名 AGENTS.md:24，按 ready 前确认过的措辞合并）
  - 读：§文档同步；§对 00-foundation 的修补「这次修补怎么记录」；01 修补 8、9；§开工前裁决；§开放问题「改为 ready 之前必须定」。
  - 交付物：00 spec 顶部第二行、01 spec 顶部第一行 `Amended by`（全文见两节修补，正文一字不动）；master-reference.md 按 §文档同步 的表逐项改，每处带日期指针；goose-mechanisms.md:546 更正；AGENTS.md:24 改写；components.md 就地改行，parity-audit-2026-09-12.md 文末追加「2026-09-25 补记」；.env.example 三处；01 plan.md:139 标已结、:155 同次更正；docs/evals/README.md 建第一批文件（照 spec §提示层与评测）；ADR-003 随 spec 提交，owner 审过后「提议」改「采纳」；B7、B9、B10、B12 去 6b spec 的去向记进本文件实施记录。开放问题 1–11 的答复已记进 Revisions（2026-09-25），1、2 的接口形状已写进 §主进程与 kernel 的循环接口 与 01 修补 6；owner 把 spec 改为 `Status: ready` 后才开工。common.json 的两个键随第 19 步。
  - 验收：2（common.json 那半在第 19 步）、4。
  - 测试要点：
    - 旧 77：`git diff` 显示 00 spec 只多一行第二条 `Amended by`，01 spec 只多一行第一条，两份正文其余一字不变；01 plan.md 的 Open 里智谱 `usageNeedsOptIn` 那条标为已结（2026-09-25），neutral 那条提到 `standardwebhooks`。
    - 旧 78：ADR-003 与 02 spec 在同一个 PR 里落地，内容覆盖 M3 的落点以及 pendingImpact M3、M2。
    - 旧 79：第 0 步分支合并前，`git log` 在 master-reference.md、goose-mechanisms.md、AGENTS.md 上都只列出同一个提交（③ 砍法注记除外）；`| 序 | 层 | 来源 | 能做什么 |` 那张表已不存在，§4.11 换成指向 02 的带日期指针并按原行列出变化；「停止即杀」一行含 `ChildHandle.kill`、不含 `HostProcess`；`并行给意见` 在主参考和 goose-mechanisms.md 里都 grep 不到；§文档同步 主参考表的每一行都能在 master-reference.md 里找到一处 2026-09-25 的 02 链接；docs/ux、docs/reference 下没有写错的 `](02-agent-loop/spec.md` 相对路径。
    - 旧 80：AGENTS.md 不含 `model self-labels`、`precedence table in`，含 `the stricter one wins` 与 `docs/architecture/02-agent-loop/spec.md`。
    - 旧 81：components.md 逐行核对：`ApprovalCard` 拆成「最小态 · 阶段 2」「完整 · 阶段 3」两行；`ToolRow`、`ComposerSlots`、`ModeSwitch`、`AskWidget`、`AskSummaryCard`、`TurnSummaryLine`、`FailureCard`、`BlockedNotice` 阶段列为 2，`ApprovalModeMenu` 为 4；`FolderChip` 紧跟 `ModeSwitch`；`StopButton` 不含「沙箱进程」；`ModelMenu` 含「管理模型…」「去设置填 key」；`DetailTabs` 含三态菜单与 requiresUserInteraction 的限制。parity-audit 的 `git diff` 只有新增行。
    - 旧 82（.env.example 那半）：不含 `claude-opus-5`；含 flashx、Coding Plan、`ANTHROPIC_API_KEY` 计费三条注释；`TENON_PROVIDER` 的说明写明菜单或设置卡的选择优先。
    - 旧 83：每个 02 分支合并前，`git diff docs/spec-driven-dev.md` 为空。
    - 旧 75：开工前裁决表 82 个 id 在第一列各出现一次，另外只有「（B17）」一行；每行「落点」里的节名是真实节名，那一节有这条规则和它的（裁决 X）；表里写的「01 修补 9 (x)」在第 9 小节都存在、说的是同一件事；H8 的智谱默认档在 §开工前裁决、§搜索与抓取、§实测记录 三处都是 `search_pro_quark`。
    - 旧 76：被否决的方案每个 key 都有理由和改判；该节与 ADR-003 的「不用 AI SDK 的真实理由」「被否决的方案」两节都不拿 Cline 4.0.1 的回滚或 OpenCode 的 blockBinding 作论据（这两个词只出现在声明「不引用」的句子和验收 4 里）；凡提到 M5-B 都写作降级、不作默认。
  - 暂定与待定：开放问题 1–11 与 26 已于 2026-09-25 由 owner 全部定下，owner 已把 Status 改为 ready；owner 审稿时尽量一并答复开放问题 15、16（① 的「结果」依赖它们；没答复的按纪律排到 ① 最后，受影响的验收在实施记录里标「待开放问题 N」）。components.md 暂不为 PendingApprovalBanner、LeaveRunDialog、排队项、「继续」按钮、恢复前禁发补行（旧开放问题 145），提交前按 §界面范围 再看一次。
- [ ] 2. **模型表数据与智谱补测**（裁决 A12、M8、A16、A14、A1、E2、H13、M4；owner 的智谱 key 经进程环境，只记变量名）
  - 读：§实测记录；§模型与密钥；§内置模型表的数据改动。
  - 交付物：`ModelInfo.pricing` 只增 `currency`、`cacheWritePerMTok`（01 修补 2）；zhipu.ts 加 glm-5.3-flash、glm-5.3-flashx 两行，glm-5.3、glm-4.6 改为 `reasoning-content` 并加 `tool_stream`，各行补 pricing（glm-4.6 不填）；anthropic.ts 加 `claude-opus-5-5`（思考字段在第 6 步补），Sonnet 5 仍排第一，改两处过时注释，Haiku 注释写暂定退役日；ollama.ts 改注释依据；探测结果写进本文件的 live 记录，账单结论写进 spec §实测记录（draft 期间记 Revisions）。
  - 验收：1。
  - 测试要点：
    - 旧 87：kernel 单测读 `zhipuDefinition.builtinModels`：四行都是 `supportsToolCalling: true`、`thinkingPreservationFormat: 'reasoning-content'`、`reasoningEchoField: 'reasoning_content'`、`requestParams.tool_stream: true`；拒收 `tool_stream` 的行为 `supportsStreamingToolCalls: false`；`provider.select` 接受 flash、flashx，不返回 `unknown-model`。
    - 旧 89：智谱带工具的请求里，第二轮 assistant 回传同一模型的 `reasoning_content`；同一段历史不带工具时一条都不回传（守卫规则 4）。
    - 旧 90：live 记录各有一条带日期的：glm-5.3、glm-4.6 上带 `tool_stream: true` 的流式工具请求；glm-4.6 上回传 `reasoning_content` 的工具往返；E2 的智谱缓存检查。每条写状态码和关键字段，只写变量名。
    - 旧 91：`BUILTIN_PROVIDERS` 仍只有 anthropic、zhipu、ollama；qwen3:8b 的 `supportsToolCalling` 仍为 true。
    - 内置表单测、locale 键存在性单测不回退；`pnpm test:live` 以 `TENON_LIVE_ZHIPU_MODEL=glm-5.3-flashx` 跑一次智谱冒烟。
    - 实测：glm-5.3、glm-4.6 各发一次 `tool_stream: true` 的流式工具请求，glm-4.6 再做一次回传 `reasoning_content` 的工具往返；拒收的行设 `supportsStreamingToolCalls: false` 并带日期记录。
    - 实测：给 glm-5.3-flash（或 flashx）发一次带图请求，定 `supportsVision`，结论写回 zhipu.ts 并记 Revisions（旧开放问题 34）。
    - 实测：E2 的智谱缓存，只改工具列表，看 `cached_tokens` 会不会归零；只记录，供阶段 3 在 E2-D 与 E2-F 之间选。
    - 实测：T6 扩充组，同一段多回合历史带、不带历史思考各发一次，比 `prompt_tokens` 与耗时，再核一次次日账单。
    - 实测：智谱插话，glm-5.3 工具循环中途在 tool 消息后插一条 user，`clear_thinking` 取 true、false 各一次，同时比 `prompt_tokens` 与 `cached_tokens`，成本差记进实测记录。
    - 实测：中途改 `reasoning_effort` 对智谱隐式缓存（`cached_tokens`）的影响（菜单的「会让缓存失效」提示据此措辞）。
    - 可选：智谱 `tool_calls[type=mcp]` 这类服务端调用块不回传会不会 400（会的话记下报错，按 A13 的编辑规则补处理）。
    - 实测（有条件）：T8，`/api/anthropic` 对服务端工具、`cache_control` 的反应，外加一次 tool_use 往返；评测专用 glm-5.3 行收不收 `thinking`、`display`、`output_config.effort` 同批测。
    - owner 核对 S1、T10 的次日账单：`search_pro_quark` 是否按每次 ¥0.05 扣，`/reader` 怎么计费；顺带记下一次 quark 结果进上下文的实际 token 数。
  - 暂定与待定：`supportsVision` 定之前两行为 false（01:706 保守合成）。T6：不计费维持 A；计费就在 C（只改数据：各行 `requestParams` 加 `clear_thinking:false`）与 D（新加一档加守卫规则，属 01 修补，最晚第 6 步前定）之间选；02 implemented 时还没结论就维持 A。插话推理明显断掉时二选一：插话推迟到本轮结束，或插话时带 `clear_thinking:false`（与 T6 一起定），最晚第 17 步前。T8 不跑时同模型列留在 `/paas/v4`，评测专用行不带 `thinkingSpec`、只开工具。开放问题 8、22。
- [ ] 3. **SDK 升级**（裁决 A16、M3；按 ADR-003 当「SDK 现实」变更，不走 SDD）
  - 读：01 修补 4；ADR-003。
  - 交付物：`@anthropic-ai/sdk` 0.126→0.128，`openai` 7.17→7.23；五项全过才升，任一项不过就留在旧版、只加 Opus 5.5 一行，结论记进实施记录。发出两个以上 beta 值之前必须完成。
  - 验收：3。
  - 测试要点：
    - 旧 44：01 验收 8 的 browser 平台打包；全局 fetch 调用数为 0；packages/kernel/test/provider/wire/anthropic-stream.test.ts 的环境变量诱饵用例（`DECOY_ENV` 在 :66）。
    - 旧 232：记下五项检查的结果：上面三项；anthropic-messages.ts:87-92 注释里随 SDK 变化的那对保留键（`user_profile_id`、`workspace_id`）与 `RESERVED_KEYS`；新版 SDK 实际发出的协议必需头（含多个 `anthropic-beta` 值的拼接，供第 7 步的白名单用）；openai 7.23 的结论（不过就留在 7.17，packages/kernel/package.json:31）。
  - 暂定与待定：02 的 beta 名单为空，留在旧版不挡 02。
- [ ] 4. **测试接缝与官方 key 准备**（裁决 B1、M4、M8、E2、A6）
  - 读：01 修补 4「测试接缝」；§模型与密钥；§验收标准 开头的「测试接缝」。
  - 交付物：`fakeNetwork` 只增 `FakeNetworkOptions`（`checkRequest`、`untrusted`）与 `checkFailures`、`untrustedRequests`，导出 `assertToolPairing`，后面各步的配对断言都用它；不变量测试的命名约定（「02 不变量 N」）与共享的请求体断言工具（每个 tool_use 紧跟结果、末轮是 user、头名在白名单内、图片只以 base64 或 `data:` 出现）。owner 开 Console 预付 key，key 不进 `.env.local`、不进 shell profile；官方 key 的 live 组强制发往 `api.anthropic.com`、不读 `ANTHROPIC_BASE_URL`，能和 glm-4.7-flash 组并存，为此改 `liveEnv()`（apps/desktop/e2e/live-provider.spec.ts:63-72，现在会一起转交三个变量）。判定为老账号时，在 desktop host 网络层加只在 `!app.isPackaged` 且设了专用变量时生效的补头接缝，不进 A6 白名单。
  - 验收：无（支撑验收 14 与 54）。
  - 测试要点：
    - 原有的 `fakeNetwork(script)` 调用与 `requests`、`callCount` 照旧成立；`checkRequest` 抛出的错误记进 `checkFailures`，回放照常进行。
    - 实测（key 到手就先跑，不必等 ③）：判账号类型（方法见第 33 步），结果记进实施记录；Anthropic 线同一 provider 换到不发工具的模型（历史有 tool_use / tool_result，请求不带 tools）会不会 400，最好赶在第 10 步开工前出结论；搜索子请求的三个参数（见第 28 步）。
  - 暂定与待定：开放问题 20。会 400 的话，在「照发冻结的 tools 并带 `tool_choice: {type: 'none'}`」与「把这些块降级成文本」之间选，结论写回 spec §不带 tools 的请求与冻结后的变化；第 10 步之后才出、又要补的按 (b)。开不出 key 就按 spec §Anthropic 保证档的退路 走 Revisions。

## ① 能读能批（不能砍；做完时任务形态能读、能批）

- [ ] 5. **对 00 的修补落代码**（裁决 A4、D4、D5、D8、E1、E4、D12、F5、F1）
  - 读：§对 00-foundation 的修补。
  - 交付物：`HostAdapter.policy` 与 `packages/kernel/src/host/policy.ts`（`PolicyState`、`TenantPolicy`、`ToolPolicyRule`、`EMPTY_POLICY`）；desktop `host/policy.ts` 恒为空策略；内存 host 可注入 policy，只增 `setPolicy`、`symlink`；`HostFs.realpath`（desktop 用 `fs.promises.realpath` 加 lstat 回落，MemoryFs 跟随链接）；`ConfirmReason` 四个新值与 `CONFIRM_FACT_KEYS`、`FlaggedCategory` 检查（本步建 `permission/inspector.ts`，只放 `InspectorCategory`、`FlaggedCategory`，第 9 步的目录测试算上它）；`ConfirmRequest.reversibility` / `target` 与单向约束；contracts 的 `policyStateSchema` 与 confirm schema 同步；全部 host 与三处既有测试在同一改动里补齐；`adapter.ts` 文件头注释补一句。
  - 验收：5。
  - 测试要点：
    - 旧 92：缺 `policy` 成员的 host 对象 typecheck 失败（`@ts-expect-error`）；desktop 与内存 host 都通过 `pnpm typecheck`；desktop 的 `current()` 返回 `{ status: 'current', version: 'empty', snapshot: EMPTY_POLICY }` 并通过 `policyStateSchema`，该 schema 拒收未知 status；内存 host 默认同一个空策略。
    - 旧 94：`confirmReasonSchema` 的取值集合等于 `CONFIRM_FACT_KEYS` 的键集合（9 个）；四个新原因各缺一个必填键时 `confirmRequestSchema.safeParse` 失败，错误路径点出那个键；原有五个原因的 `requiredFactKeys` 结果与阶段 0 相同；`flagged` 的 `category` 为 `'exfil'` 时失败，`exfiltration`、`inspector-failed` 通过。
    - 旧 95：拒收缺 `reversibility` 或 `target` 的请求；拒收原因为 `irreversible` 而可逆性不是 `irreversible` 的；接受原因为 `command`、可逆性为 `irreversible` 的。
    - realpath 悬空链接回归，复现 2026-09-25 本机实测 `ws/evil → ../outside/new.txt`（realpath 报 ENOENT、lstat 成功、对它 writeFile 会在工作区外建文件）：desktop host 与内存 host 各断言 realpath 抛错而不是返回 null。
    - MemoryFs 跟随链接的行为与 node 一致：对悬空链接 writeFile 在目标处建文件，stat 返回 null，链接环时 realpath 抛错；链接逃逸用例在 kernel 里跑，不碰磁盘。
    - `MemoryHost.setPolicy` 替换 `policy.current()` 的返回值并同步通知全部订阅者；`subscribe` 返回的取消函数调用之后不再回调；desktop 的 `subscribe` 永不回调。
    - 三处既有测试（packages/contracts/test/confirm.test.ts、apps/desktop/test/host.test.ts:34-55、packages/kernel/test/host/memory.test.ts:89）的请求都补上 reversibility 和 target；`confirmRequestEventPayloadSchema` 带着两个新成员 parse 通过。
    - 旧 237（PolicyState 一组）：`policyStateSchema` 用 `satisfies z.ZodType<PolicyState>` 绑定，与 kernel 类型双向互赋（验收 13 整条在第 19 步勾）。
  - 暂定与待定：`unavailable` 读作拒绝一切工具（开放问题 11，已确认）；MCP 的 `ConfirmTarget` 这一步不加（开放问题 15）。
- [ ] 6. **Provider 思考与保真**（裁决 A1、A2、A11、A16、M3、A3、M5、B1、H10）
  - 读：01 修补 2、3、7；§组装清单与内容寄存；§工具调用的收口「崩溃、服务端调用块与兜底」；§思考的默认与显示。
  - 交付物：`ThinkingSpec`、`ProviderRequest.effort` / `display` / `dropThinkingBefore`、快照新键、三个保留键、`thinkingEffortSupport()` 与注释改写、Anthropic 线思考四分支与本地拒绝、OpenAI 兼容线的 effort-only 规则、`encode()` 末轮须为 user（01 修补 9 (k)）、`ModelInfo.purposeKey`；Opus 5.5 等行的 `thinkingSpec`，三行 5.3 系声明 low / high / max；厂商原样块与 `vendor-block` / `vendor-fields` / `response-model` 事件，守卫的 `server-executed` / `compacted`，`replay: 'never'` 在判空前丢弃；解码器存档服务端调用块（01 修补 9 (t)）；attempt 的 `assemblyRef` / `encoder` / `modelWireHash`（`WIRE_MODEL_FIELDS`）/ `responseModelId`，`model_selected` 的 `capabilitySource` / `endpointOrigin`；快照与 attempt 的 `compaction` 键先声明（③ 不能再给 ① 的契约加成员）。
  - 验收：6（首行调序在第 33 步）、7；不变量 1、2、33。
  - 测试要点：
    - 旧 98：没有 `thinkingSpec`、`supportsCacheControl` 为 false 的行（合成行；同一 ModelInfo 下的智谱、Ollama 行），对 01 能编码、以 user 结尾的任何输入，body 和 promptHash 与 01 逐字节相同；01 里断言编码成功、以 assistant 轮结尾的约 25 处（encode.test.ts:404、:423、:523、:537，另有 anthropic-messages.test.ts、openai-chat.test.ts）各补一条尾部 user 轮后通过，守卫结论与签名断言不变；断言拒绝的用例不改，仍抛原来的错误。
    - 旧 45、旧 99：Opus 5.5 行 `thinking.enabled=false`、不在 `effortLevels` 里的 effort、`temperature: 0.5`、adaptive 带 `budgetTokens`，都在本地抛 `ProviderInvalidArgumentError`，fakeNetwork 0 次。Opus 5 行不传 effort（默认档 high 等于 `disableMaxEffort`）时 `enabled=false` 写成 `{type:'disabled'}`，effort 为 max 时拒绝。思考关着时 body 与快照里都没有 display；Haiku 4.5 只在开了预算式思考时带 display；没声明 `displays` 的行收到 display 就拒绝。
    - 旧 100：OpenAI 兼容线 `thinking: { enabled: false }`、带 `budgetTokens` 的 thinking、display 都在本地拒绝；effort 为未声明的 `'none'` 时拒绝；`requestParams` 写 `reasoning_effort`（OpenAI 线）或 `output_config`、`cache_control`（Anthropic 线）时抛 `ProviderInvalidArgumentError`。
    - 旧 46（编码那半）：`effort` 由编码器写成 `reasoning_effort`，不传就不写；flash 传 `medium` 本地抛错、不触网；模型行 `requestParams` 带 `reasoning_effort` 时按 `mergeRequestParams`（wire/shared.ts:264）抛错。
    - 旧 88：三行 5.3 系恰好声明 low / high / max，不声明默认档；glm-4.6 不声明档位；anthropic 表有 `claude-opus-5-5`，`thinkingSpec` 为 always-on、`defaultEffort: 'medium'`、`forcedToolChoice: false`、`samplingDefaultsOnly: true`；第一行在前缀验收通过前是 `claude-sonnet-5`。
    - 旧 43：夹具放一个未知块类型、一个带未知字段的 thinking 块，存进 Tape 后同模型回放两块逐字节相同；换模型回放被守卫丢弃，记进 `thinkingDecisions`。
    - 旧 101：`caller` 非 direct 的 `tool_use` 与 `server_tool_use` 存成 `replay: 'never'`，不派发，下一次请求里没有，`thinkingDecisions` 记 `drop / server-executed`；含原样块的会话，`session.latest`、`session.messages` 仍通过 contracts 的响应校验，渲染端不显示原样块。
    - 旧 112：attempt 带 `encoder{wire, version, sdk}`、`modelWireHash`、`responseModelId`；只改 `pricing` 时 `modelWireHash` 不变；用 Proxy 记下 encode() 读过的 ModelInfo 键，断言都在 `WIRE_MODEL_FIELDS` 里；`canonicalHash(model)` 等于 `view/assembled.modelInfoHash`，`canonicalHash(pick(model, WIRE_MODEL_FIELDS))` 等于 `attempt.modelWireHash`。
    - 旧 42：改一行模型表后复核一条旧记录：`modelWireHash` 与按新表算的不同，报「模型表已变」而不是「被篡改」；用组装清单里的 ModelInfo 原文仍能复算原来的 `promptHash`（组装清单在第 10 步写）。
    - openai-chat 线 `tool_calls[type=mcp]` 在 :790 读不到名字、在 :831 被静默丢掉只是读代码推断：先用夹具证实这条丢弃路径，再改成在 :742 与 `custom` 并列识别。
  - 暂定与待定：T6 若计费并选 D，最晚本步前定（第 2 步）。原样块取乙（投影出主进程前剥掉 `vendor` 块，contracts 不变；以后改甲是只增）。5.3 系不声明 `medium`（按底表应当报错；实测可选，第 21 步）。
- [ ] 7. **出网与错误**（裁决 A4、A5、A6、A12、H8、H10、H12）
  - 读：01 修补 2（clock）、4、5、6「chat.event」；§结束原因词表。
  - 交付物：`create()` 的 clock 加 `setTimeout`（desktop provider.ts:197、provider-routes.ts:276 与测试替身同改，两处「只给读数」的注释改写，01 修补 9 (h)）；首字节超时；字节级空闲看门狗（`fetchThroughHost` 第四个参数、transport.ts 导出 `StreamIdleTimeoutError`）；导出的请求头白名单函数，协议必需头按第 3 步列出的清单；`ProviderErrorCode` 只增 `quota-exhausted`、`account-config` 与各厂商分类表；`error.timeout` / `resetAt`；`ProviderDefinition.finishReasons` 与智谱两个映射；Anthropic 顶层 `cache_control`；`chat.event` 的 `thinking-delta`、`tool-call`（按 `callKey`）、`attempt-discarded` 三个变体（`done.endReason` 与 17 个结束码键在第 13 步，`tool-outcome` 在第 14 步，它们要的类型那时才有）；chat.ts 的 ERROR_CODE 补 `quota-exhausted`、`account-config` 两行，都为 `unknown`（01 修补 5；`satisfies Record<ProviderErrorCode, …>` 要求同步改）。
  - 验收：8、9（结束码与 `tool-outcome` 那部分在第 13、14 步）；不变量 3。
  - 测试要点：
    - 旧 48：假时钟下空闲阈值对 `api.anthropic.com` 为 180 000 毫秒、其他端点 300 000；一直有字节到达（只有 ping 也算）就复位不触发；空闲超过阈值，流以 `error{ code: 'network', timeout: 'idle' }` 结束，而不是 `stop{ aborted }`。首字节：只对 `api.anthropic.com` 给 SDK 传 180 000 + ceil(bodyBytes / 32 768) × 1000 毫秒，其他端点不传；首字节超时后紧接着的那次重发带 `firstByteTimeout: false`，也不传。
    - 旧 103：首字节超时的流以 `error{ code: 'network', retryable: true, timeout: 'first-byte' }` 结束，没有 `stop{ aborted }`；空闲超时时调用方的 signal 从没被 abort，响应体读完或取消时 `setTimeout` 返回的取消函数已被调用；desktop 两处 `create()` 漏传 `setTimeout` 时 typecheck 失败。
    - 旧 102：`supportsCacheControl` 为 true 的 Anthropic 行，body 顶层有 `cache_control: { type: 'ephemeral' }`、不带 ttl；合成行与智谱行没有这个键。
    - 旧 104：设了 `ANTHROPIC_CUSTOM_HEADERS` / `OPENAI_CUSTOM_HEADERS`（含 `anthropic-beta` 与 `x-foo`）时，fakeNetwork 记到的头里两者都没有；凭据头的值恰好等于传入的值；`x-stainless-*` 仍在（搜索后端过同一函数在第 28 步验）。
    - 旧 47：三个 finish_reason 夹具：`sensitive` 读成 `content-filter`；`model_context_window_exceeded` 读成 `context-overflow`；`network_error` 读成 `unknown`，`providerReason` 保留原值（循环按瞬时错误重发在第 13 步验）。
    - 旧 105：Anthropic 429 且 `enforced_spend_limit_reached`、400 且消息以 `You have reached your specified` 开头，都归 `quota-exhausted`、不可重试，chat.event 上为 `unknown`，前者的 `resetAt` 为下月 1 日 00:00 UTC；智谱 1113、1308、1310、1316 归 `quota-exhausted`，1302、1305 仍可重试。
    - 旧 106（本步部分）：阶段 1 的 `stopReason` 映射不变（`tool-use` 仍归 `end-turn`）；`thinking-delta`、`tool-call`、`attempt-discarded` 都通过 `chatEventSchema`；ERROR_CODE 对两个新码给出 `unknown`。
    - 旧 231、实测 A5：用智谱 key 在 `/api/anthropic` 与 OpenAI 线各跑一次长思考、长输出（max 档，调大 max_tokens），记首字节时间和块间最长间隔；在 OpenAI 线调一个参数约 2 万 token 的工具，`tool_stream` 关、开各一次。间隔接近 300 秒就放宽该线阈值或关掉看门狗，写进 spec §实测记录。
  - 暂定与待定：非官方端点 300 秒是 Tenon 自取的值（按 A5 实测校准）；官方端点的 ping 间隔在第 33 步；智谱 1308、1310 的 `resetAt` 在报文格式核实前留 null（Open）；Fable 5.1 没开保留时的 400 原文拿到前仍归 `invalid-request`（第 33 步）；`x-stainless-*` 整组放行（阶段 6）。
- [ ] 8. **Tape 修补与新名字**（裁决 B1、B2、B4、B5、B6、B8、F3、H1、D11、A2、H10）
  - 读：01 修补 7；§02 的 Tape 事实。
  - 交付物：先只声明、按 spec 原文（各放进 spec 写的文件，后面的步骤实现、不改形状）§载荷 引用的类型：`RunEndReason`（loop/terminal）、`ExecutionState` / `ClosureSource` / `BlockReason`（loop/closure）、`DecisionSource` / `DecisionStep` / `DecisionRecord` / `Decision` / `DecisionSummary` 与摘要码（permission/decide、record）、`InspectorFinding`（permission/inspector；`InspectorCategory`、`FlaggedCategory` 第 5 步已声明）、`SubagentHandoff` / `HandoffCall`（loop/subagent）、`SpillRecord`（loop/spill）；`TapeSlice` 只增 `tool`、`view`、`compaction`，02 的全部名字按总表登记（含 ③ 才写的）；载荷类型（含 `ToolOutcomePayload`、`ToolResultPayload.searchHitUrls`）与 `TapePayloadByName`；names.test.ts:269 的标签改为「已声明的保留名」并补一个未声明的兄弟名；`REPLAY_KINDS` 只增两个，重放读工具事实与 `message/continuation`、从最近 anchor 往后读；撤回即终局与 `TapeMessageRetractedError`；`TapeClosedError`；`readBySource` 的 `fromEntryId`；`resetSession` 的 `carry`；`hash_ver` 规则（只写文档）；待批投影表（含 `wait_kind`）、两个 store、`listPendingApprovals`、`PROJECTION_VERSION` 为 2、第 2 号迁移两个文件与 `MIGRATIONS`；check-tape-schema 按迁移号锚定。
  - 验收：11、12（挂靠、同批原子性、rejudge 在第 15 步补齐，选模型的 n 在第 19 步）；不变量 32。
  - 测试要点：
    - 旧 58：带 `fromEntryId` 分页读完一个超过 1000 条的 run，结果与全量快照相同；`EXPLAIN QUERY PLAN` 里有 `tape_entry_by_source`，没有 `TEMP B-TREE`。
    - 旧 59、旧 113：kernel 层撤回之后再给同一 messageId 写修订，抛 `TapeMessageRetractedError`，Tape 不变（store 层现有的撤回 conformance 用例保留）；两个 store 在 `close()` 之后任何方法都以 `TapeClosedError` reject，`close()` 本身仍幂等 resolve（两个 store 各加一个 conformance 用例；现状 memory-store.ts:662-666、sqlite-store.ts:1092-1098、:1122-1127；运行器会再调一次 close，tape-conformance.ts:651-657）。
    - 旧 60：同一个库文件里放两个 `tenant_id` 的待批行；以 A 绑定的 store 调 `listPendingApprovals`，带 B 的 `sessionId` 与不带各一次，结果都没有 B 的行；去掉租户谓词测试必须变红；写进 conformance 套，两个 store 各跑一遍。
    - 旧 61：把第 2 号迁移的 SQLite、Postgres 两份文件同时改掉同一列（两份仍一致）而不改 02 spec 的 sql 块：`pnpm lint` 失败，点出迁移文件与这一列；同一张表在 01、02 两块 DDL 里都出现：失败并点出这张表；只改一方方言：仍按 01 验收 17 报错。
    - 旧 110：`resetSession` 带 `carry`：新 incarnation 依次是 `session/start` 与各条 carry，`entryCount` 为 1 + carry 条数；某条 carry 投影失败时重置不生效，旧事实原样还在；对别的租户的 sessionId 抛 `TapeSessionNotFoundError`，改动 0 行。
    - 旧 111：`rebuildProjections` 之后的行与增量写出的逐行相同（含 `wait_kind`、`entry_id`）；`PROJECTION_VERSION` 为 2；第 1 号迁移文件逐字节不变。
    - 旧 114：每个 02 名字只能由总表里的 slice、以那里的 kind 与身份列写入，错一项抛 `TapeAppendAuthorizationError`；通用 append 拒绝全部 02 名字，以及 tool/、view/、compaction/ 下已声明和未声明的名字（01 验收 13 扩到三个新 slice）；别的 slice 的写入器写这些名字也被拒；`view/anything`、`compaction/anything` 作为未声明的兄弟名被拒；源码里没有写 `tool/result_marked` 的调用。
    - 旧 115：同一事实重写返回 `created: false`、不增行；结论、摘要或卡面变了的重新判定写 `…:rejudge:<r>`（每个调用从 1 计，读取取最大的 r），都没变就不写；同一调用的第二条 `approval_resolved` 不写入。
    - 旧 116：批准后在新 Run 里执行的调用，`readBySource({ sourceType: 'runtime_event', sourceId: 原 runId })` 取得到它的六条事实（调用、判决、答复、派发、收口、结果）；派发、收口、结果的 writer 是新 Run，答复的 writer 是 resolver。
    - 旧 117：故意让 `approval_resolved(allowed)` 那次 append 失败，答复、新 Run 的 `run_started` 与 `session/model_selected` 都不在 Tape 里，待批行还在；问人的判决与 `run_terminal(paused)` 同样一起写入或一起不在。
    - 旧 118：同一个 system 与同一组工具定义跨多次请求，`view/content` 里每份内容恰好一条。
    - 旧 123：主页上先选模型再建会话，第 0 条 `model_choice_set` 与 `session/start` 同批；两次很快的 `session.selectModel` 得到 n=0、n=1，没有 `TapeProvenanceConflictError`（本步只测写入器；建会话前暂存随第 18 步、选模型随第 19 步补跑）。
  - 暂定与待定：开放问题 6（`carry`）owner 2026-09-25 已确认按修补处理。
- [ ] 9. **所有权骨架**（裁决 F1、F10、D4、A14、H15）
  - 读：§所有权与依赖方向（含 §主进程与 kernel 的循环接口）；01 修补 6「kernel 服务的构造参数」；01 修补 9 (v)；[models/README.md](models/README.md)（mailbox、租约、队列的并发测试照模型的场景与不变量写；实现中要改这些规则，先改模型、两个都跑到 0 违例）。
  - 交付物：`SessionServiceOptions.host` 改为完整 `HostAdapter`，只增 `inspectors`（desktop 先传 []）、`connector`、`protectedFiles`、`onUnansweredCall`、`log`，六处调用同改；删 `runRequest`、`RunRequestQuery`、`RunResult`（请求体挪进 `loop/` 内部），tape-conformance、service.test、definitions.test 改走 `send`，tape-conformance.ts:2157 改成两个会话（01 修补 9 (v)）。第 10、13、18 步之前，`send` 开的 Run 只发一次请求，不带 system 与 tools，写 `run_started`（`run_terminal` 自第 13 步起），回复里有 tool-use 照阶段 1 结束本轮；三组测试随之改：conformance 的重编码不带 `SCRIPT_SYSTEM`、`SCRIPT_TOOL`，`systemHash` 断言改为本 Run 实际发出的 system，definitions.test 的 `TURN_SHAPE` 加 `run_started`；kernel/src/index.ts:297-298 删两个导出；chat.ts 的 `chat.send` / `chat.stop` 改转 `send` / `stop`，emit、ERROR_CODE 与 STOP_REASON 映射挪进 run-events.ts；建 `tools/` 目录（`permission/`、`loop/` 第 5、8 步已建）；按 §主进程与 kernel 的循环接口「冻结」声明全部类型与命令方法（`bindLoop`、`LoopPorts`、`RunConnector`、`RunAssembly`、`SessionEvent`、各命令，③ 才实现的路径也在这里声明，M1），它们引用、第 8 步还没声明的类型（`ToolOutcomeView`、`AnswerCommand`、`SearchBackend` 连同 `SearchOutcome` / `SearchHit`、`McpToolSource`、`RunAbortCause`（loop/ports）、`SessionDraft` 占位），以及 `inspectors` 成员要的 `InspectorRegistration` 连同它引用的 `AskOpinion` / `DenyOpinion` / `BeforeCallInput` / `InspectedCall` / `AfterResultInput` / `ResultMarker`（permission/inspector）、`SessionView`（session-view）与 `ToolTableItem`（tools/registry），只声明、按 spec 原文，后面的步骤实现、不改形状；读写事实的方法随各自路由那一步加（第 15、16、18、19 步）；写 mailbox 与命令骨架；desktop 的 `run-assembly.ts`（由 `resolveChatProvider` 拆出）、`run-events.ts`、`queue.ts` 骨架；`RunRegistry` 取代 `inFlight`（chat.ts:132）并实现 `LoopPorts.leases`，`locale` 端口也在这一步；index.ts 接 `connector`、`protectedFiles`（第 11 步之前传 `[]`）与 `bindLoop`；`queue.ts` 这一步就以内存实现 `LoopPorts.queue` 的四个方法（`enqueue` / `peek` / `take`（含按 `queuedId`）/ `restore`；自动发出、`sendNow`、`queue.act` 与 `chat.queue` 事件在第 17 步）；第 17 步之前 `chat.send` 在这个根会话有活租约（含已中止、还在收尾的）时仍回 `ALREADY_STREAMING`，kernel `send` 返回 `queued` 时 desktop 撤下这一项、同样回 `ALREADY_STREAMING`（`approval.resume` 之后紧跟的发送、可续跑的会话里发消息都会走到），免得消息进了还不会自动发出的队列；`@tenon-app/kernel/testing` 导出 `createTestLoopPorts`。
  - 验收：13。
  - 测试要点：
    - 旧 236：三个目录都在之后 `pnpm lint` 与 packages/kernel/test/host-independence.test.ts 仍通过；kernel 源码里没有对 `@tenon-app/contracts` 或 railguard 的 import，也不直接做 DNS 解析或开 socket；`loop/`、`tools/`、`permission/` 里搜不到 `'ollama'` 字面量。
    - 旧 237（本步部分）：`PolicyState` 那组已在第 5 步；判决摘要、待批行、会话选择在第 12、16、19 步照写（写法照 packages/contracts/test/session-types.test.ts:26-33，任一侧加字段就编译失败）。
    - 旧 238：调 `createSessionService` 不传 `inspectors`、`connector` 或 `protectedFiles` 编译失败（`@ts-expect-error`）；六处现有调用都显式传入，其中四处改为传完整的 HostAdapter。
    - 旧 225（前半）：`SessionService` 上没有 `runRequest`，kernel 不导出 `RunRequestQuery`、`RunResult`（`@ts-expect-error`）；给 `send` 传 `system` 或 `tools` 编译失败（`@ts-expect-error`）；apps/desktop 的 `pnpm typecheck` 通过；`bindLoop` 之前调 `send` 返回 `{ status: 'refused', code: 'not-bound' }`，`continueRun`、`answer`、`resume` 返回 `refused`，`stop` 返回 `{ stopped: false }`，都不写事实；再调一次 `bindLoop` 抛错。
    - 两个会话各跑一个 Run 的 conformance 用例在内存与 SQLite 两个 store 上都通过；同一根会话连发两次 `send`（第二条在第一条预建时到达、先进 mailbox），第二条入队、只有一个 `run_started`，记录型租约没有第二次 `begin`（有就抛错）。
  - 暂定与待定：开放问题 1、2 已定（2026-09-25）；开放问题 26 已定（2026-09-25 owner：全部按默认），要进本步类型的几条（端口只加可选成员、直接发送的 held、「继续」的 held）照 spec 现写法声明；`SessionDraft` 形状随开放问题 16，先占位；desktop 的 run-events.ts 只转根会话的事件。
- [ ] 10. **工具注册表与工具表冻结**（裁决 H4、E2、A3、A14、A15、D12、H7、H6）
  - 读：§内置工具与工具来源；§工具目录与冻结；§组装清单与内容寄存；§名字总表。
  - 交付物：`packages/kernel/src/prompts/` 的骨架（`fill()` 与按 spec 形状声明的 `MODEL_NOTES`，还没写的成员与 `closure` 的来源键先标可选、写齐后去掉；第 10–15 步各自加上本步写给模型的键与格，如被禁、inspector 超时与出错、截断与步数上限、续写提示；`closure` 余下的格在第 14 步随 `closure.test.ts` 一次写齐）；`BUILTIN_SERVER_ID`、`ToolTableItem`（第 9 步已声明）、按 §工具来源、命名与权限键「命名规则」映射名字的函数与开表断言；十个内置 inputSchema 与描述；参数校验；按 `ProviderId` 查的每请求工具数常量；`@tenon-app/kernel/testing` 的 `createTestSessionService` 与 `TestToolRegistry`（十个内置名缺省配假执行器，可设 `'real'` 或 `null`，spec §主进程与 kernel 的循环接口「测试与 6b」；每个内置工具进产品工具表之前，kernel 测试经它执行调用）；「会话 × provider」冻结、排序、排除码；`view/content` / `view/tool_table` / `view/tools_withheld` / `view/assembled` 同批写入与从 Tape 重建；desktop `run-assembly.ts` 的 Ollama 范围规则与 `toolsWithheld`；同一 provider 换到不发工具的模型；注册 Everything 夹具、只读 `_meta` 那一个键；elicitation 一律拒绝（`Client` 不声明能力）。
  - 验收：25、26、27；不变量 6。
  - 测试要点：
    - 旧 139：用 `createTestSessionService` 的测试工具注册表（产品工具表这时为空，各内置工具在自己的执行器那一步才进：第 18、22、26、28、29、31 步）断言 `ProviderRequest.tools` 的名字集合：对话 = {AskUserQuestion, WebSearch, WebFetch, Read}，任务再加 {Write, Edit, Bash, Glob, Grep, Agent}；没有搜索后端时都不含 WebSearch，它以 `no-search-backend` 记在 `excluded`；按砍法砍掉的工具不在集合里；形态在发消息、重启、清空之后都不变，清空时形态与工作区事实随 `carry` 与新 `session/start` 同批写入，这次调用失败则三者都不在（形态部分随第 18 步）。
    - 旧 140：各工具 schema 的属性名等于参数表「收的参数」一列；任何 schema 里都没有 `run_in_background`、`dangerouslyDisableSandbox`、`mode`、`isolation` 或自标危险度的字段；WebFetch 没有 `prompt`；Bash 的 `timeout` 带 `maximum: 600000`。
    - 旧 141：参数校验在判权限之前：Bash `timeout: 600001`、Write 给相对路径、Edit 的 `old_string === new_string`、AskUserQuestion 给 5 道题或 1 个选项或 13 个码点的 header，都不出卡、不 spawn、不写判决和派发，结果 is_error，收口 effect=blocked、state=not-run。
    - 旧 147：已派发的 Read、Glob、Grep 记 `read`，Write、Edit 记 `write`；其余按参数表的暂定值断言。
    - 旧 32：五步前缀夹具（同一张表内依次中途改界面语言、关掉一个工具、跨 Run 批准一次审批、插话一次、切到别的 provider 再切回）：同一 provider 的每个带 tools 的请求 system 和 tools 逐字节相同；同一模型、中间没有压缩的相邻两次请求，后一次的 messages 逐条以前一次为前缀，两条线各一组；用假时钟跨过零点、再在任务形态加一个文件夹，这些变化只以新追加的消息出现，首条 user 不变；被关掉的工具在调用时被拦下，is_error、`effect: 'blocked'`、来源 `user-disabled`。
    - 旧 35：第一次切到厂商 B 写一条 B 的 `view/tool_table`；再切回 A 不写新的，A 的 tools 与第一次逐字节相同。
    - 旧 148：注册表乱序给出时，`view/tool_table` 与两条线请求体里的 tools 都按映射名码元升序；provider 第一次被用前注入用户禁用 X，X 不在 tools 里，`excluded` 记 `user-disabled`，没有拦截回执，X 没有任何 tool/ 事实；同时注入策略拒绝与用户禁用时只记一条 `policy`。
    - 旧 149：冻结后注入用户禁用 X、模型调用 X：之后请求的 tools 与冻结原文逐字相同；`tool/result` 的 `isError`、`kernelAuthored` 为真并带那句英文；收口 blocked / user-disabled；判决 deny、`decidedBy: user-disabled`；出拦截回执（界面在第 20 步）；没有新的 `view/tool_table`；改用 `setPolicy` 注入时为 `policy`。开表前禁用、开表后撤销：本会话后续请求仍不含 X，摘要压缩后的表和新会话的表都含 X（摘要压缩后的表在第 30 步补跑）。
    - 旧 150：同一 provider 换到手填模型时 `toolDefinitionsHash` 等于空数组的哈希，恰好一条 `view/tools_withheld`（`model-without-tools`），换回后等于冻结值；Ollama 的 `view/tool_table` 照常写，第一次请求写一条 `provider-text-only` 的 `view/tools_withheld`，之后不再写。
    - 旧 151：清空会话后，provider 下一次被用时写一条 `first-use` 的表，generation 为 0，incarnationId 为新值；删掉某个冻结工具的实现（测试工具注册表给 `null`）、恢复后调用它，按 `tool-unavailable` 收口（effect=blocked，不出回执，不计入机器拒绝），定义仍在 tools 里；中途改界面语言，本会话 `systemHash` 不变、新会话的 system 带新语言（语言部分随第 18 步）。
    - 不变量 6 的测法：遍历一个会话的全部 attempt 逐条断言 `toolDefinitionsHash`；用例必须含「A 切到 B 再切回 A」（回到 A 不写新事实，哈希回到 A 表的值），以及同一 provider 里带、不带 tools 来回切换。
    - 旧 55：名字超过 64 位并带非法字符的夹具工具，映射后匹配 `^[a-zA-Z0-9_-]{1,64}$`，映射写进 Tape，重启重放后不变；与内置工具同名的 MCP 工具，映射后不等于任何内置名；故意让两个映射撞名，开表断言失败；夹具 server 带 130 个工具时，智谱线的 tools 恰好 128 个，十个内置工具都在，其余以 `over-limit` 排除；Anthropic 线不裁；Everything 夹具的工具开表就进表，一次调用走完审批和 Tape。
    - 旧 144：超长名字带 8 位十六进制后缀；同一 server 的 `a.b` 与 `a_b` 映射成不同的名字；server `a` 的 `b__c` 与 server `a__b` 的 `c` 同时注册时开表断言失败；十个内置名原样不变；重启重放后映射名从 Tape 读出，逐字节相同。权限键：内置工具记 serverId `'builtin'` 与内置名，MCP 工具记配置里的 serverId 与 server 报的原名。
    - 旧 50：同一 MCP 夹具 server 放三个工具：标 `requiresUserInteraction: true`、不标、标成字符串 `"true"`；在手动档、会话授权、总是允许、按任务授权四种情况下判定，只有标 `true` 的每次都问，原因码 `interaction-required`，答复只管这一次；kernel 另在注入的自动档下判一次，结论不变（会话授权与按任务授权直接注入 `LayerInputs`：产品里推不出连接器的会话授权，这是纵深防御）。
    - 旧 145：值为字符串 `"true"` 的工具 `requiresUserInteraction` 为 false；重启后夹具改报 false，冻结表里那一项仍为 true（从 Tape 还原），调用仍按 `interaction-required` 出卡。
    - 旧 24（elicitation）、旧 146：用自写的原始 JSON-RPC 夹具（参照 packages/kernel/test/support/fixtures/wedged-server.mjs；Everything 只在客户端声明能力时才注册 elicitation 工具，server-everything/dist/tools/index.js:38-52）：旧修订版发来的 `elicitation/create` 收到 -32601，不出任何界面；2026-07-28 修订版的 `input_required` 让这次调用回 is_error、执行状态 completed，不出任何界面。
    - requiresUserInteraction 的 MCP 夹具要自写（Everything 基于 v1 SDK，不一定能设 `_meta` 键）。实现第 4 层 ② 之前，先用它端到端验证 connection.ts:76-77 返回的每个工具上 `_meta['anthropic/requiresUserInteraction']` 仍在。
    - 实测：智谱（owner 的 key）与本机 Ollama 在「历史里有工具调用、请求不带 tools」时会不会报错。
  - 暂定与待定：参数校验的来源码与校验器（开放问题 16）没定，这一小步不开工；MCP 的出卡路径等开放问题 15，拦截与放行照做；`_meta` 读不到就经 Revisions 把第 4 层 ② 推迟到 SDK 支持时；智谱或 Ollama 报错的话只能降级成文本（两线都没有可用的 `tool_choice:none`）；升级后「工具不可用」只看有没有同名实现（暂定，依据内置工具带不带版本号）；开表时断言没超工具数上限。
- [ ] 11. **工作区判定与决策表**（裁决 D1、D2、D3、D5、D6、D7、D8、D9、D10、D12、E1、E2、E4、F9、H9）
  - 读：§权限决策顺序；§可逆性判定与阶段 2 的默认权限姿态；§工作区（只在任务形态）。
  - 交付物：`normalizePath`、`locatePath`（保护名单里的 shell 配置文件由 desktop 在用户目录下算出、解析后经 `SessionServiceOptions.protectedFiles` 交入，成员在第 9 步声明）；`reversibility.ts` 除命令模式表以外的部分；主原因的取法（D5 顺序与命令例外）与 H14 用的「能并行」判定；`decide.ts` 两步合并与 `decidedBy`，连同它要的 `record.ts` 的 `summarize` 与摘要码、`BLOCKED_FACT_KEYS`（`TenantPolicy` 与 contracts 的 policy schema 已在第 5 步，旧 156 在这里作回归）；`grants.ts`、`grantKey` 与答复作用域；会话授权从 Tape 现算（含移出工作区永久作废、cwd 规则）；第 2 层保护名单与本会话落盘目录的只读窄口；冻结后在调用时拦下；`policyVersion` 与 `unavailable` 的处理；kernel 实现并测试自动档（contracts 不暴露）。
  - 验收：28、29、30；不变量 20、21、22（命令部分在第 22 步）。
  - 测试要点：
    - 旧 5 与「测试写法」：对 `decide()` 逐行断言判决与 `decidedBy`（必要时加 `basis`），直接构造 `LayerInputs`、不经 Tape；每行至少一个测试：八层加旁注，第二步的五档；真值表 16 格，点名内置工具的格子用 `serverId: BUILTIN_SERVER_ID` 的规则；第一步三种放开（release-irreversible、总是允许、taskGrant）各自撤掉第 4 层 ①，都撤不掉 ②；例 1、例 2；F9：会话授权或总是允许在场时，假 inspector 说问就出卡、说拒就拒；策略 `disableAutoMode` 后回落手动档；`unavailable` 按拒处理并压过第 2 层窄口；答复作用域表的每一行；`grantKey` 的五种 GrantObject。`taskGrant` 只供第一步和 D12 的逐行测试使用。
    - 旧 93：内存 host 注入 version 为 `v7` 的策略，本会话的 `view/tool_table` 与每条 `tool/permission_decided` 都记 `policyVersion: 'v7'`；开表前注入 `unavailable`：冻结的表为空，每个工具以 `policy` 进 `excluded`，`policyVersion` 记 `'unavailable'`，没有拦截回执也没有判决事实；冻结后改为 `unavailable`：下一次调用在第 1 层被拦，拦截码 `policy`，判决记 `'unavailable'`。每次判决和每次开表都只调一次 `policy.current()`（计数断言）。
    - 旧 152：例 1：本会话批过一次的 `git push` 再来仍出卡，原因 `command`、可逆性 `irreversible`、作用域 `once`；注入一条匹配的会话授权，结果不变。例 2：注入 `reversibility: { value: 'irreversible', source: 'policy' }` 加 `userSetting: 'always-allow'`，放行，`decidedBy: user-grant`，`basis.grant` 与 `basis.releasedBy` 都是 `always-allow`；再加一条策略 ask 规则，改为出卡，原因 `policy`，`decidedBy: tenant-policy`。
    - 旧 153：答复作用域表逐行：必须问的卡、不可逆、工作区外、MCP 工具记 `once`；工作区内 Write / Edit、Bash、WebSearch、WebFetch 记 `session`，`grant.key` 等于 `grantKey` 对相应对象的输出；同一条命令换了 cwd 是不同的授权；同一文件 Write 的会话授权不让 Edit 免问（暂定读法）；内置工具的会话授权重启后从 `tool/approval_resolved` 重建；可逆性未知的连接器工具允许后 `grant.scope` 为 `once`，下一次仍出卡。
    - 旧 154：注入 `userSetting: 'never'` 或 `connectorOff` 时拒绝，`decidedBy: user-disabled`，拦截码 `user-disabled`；AskUserQuestion 与 Agent 的启动在手动档和注入的自动档下都放行（`decidedBy: approval-mode`），策略 ask 规则点名它们时改为出卡。
    - 旧 155：自动档（只由测试注入）：工作区内 Write 放行（`approval-mode`）；策略 `disableAutoMode` 时同一输入改为出卡；工作区外 Write 在自动档下仍出卡。
    - 旧 156：contracts 的 policy schema 含 `disableAutoMode`，与 kernel `TenantPolicy` 的类型级互赋无例外通过；`release-irreversible` 规则缺 `toolName` 时 parse 失败。
    - 旧 157、旧 53：工作区内 Read / Glob / Grep 放行，`decidedBy: user-grant`、`basis.grant: workspace-folder`，收口的可逆性为 `read-only`；工作区内 Write 出卡，`decidedBy: approval-mode`，原因 `default`、可逆性 `unknown`，允许后同一文件本会话不再问、别的文件照问；工作区外 Read 出卡，`decidedBy: default`，原因 `outside-workspace`（facts 为 path 与 workspace），target 为真实路径，允许只管这一次；工作区外的写每次都问，对工作区外操作的答复不生成会话授权；contracts 里没有切换审批档的路由。
    - 旧 158：读 `<profileDir>/config.json` 被拦（`protected`，不出卡），判决里的可逆性仍为 `read-only`，被拦的 Write 记 `unknown`；本会话 `tool-output/<sessionId>/` 的只读调用放行（`decidedBy: protected`），写它、读别的会话的落盘目录都被拦；所选文件夹包含 profile 目录时照样如此；策略拒 Read 或 `PolicyState` 为 `unavailable` 时窄口也被拒；工作区设为家目录时写 `~/.zshrc` 被拦，经工作区里指向它的链接写也被拦，都不生成会话授权。
    - 旧 159：工作区设为 profileDir 的上级时，对只在 config.json 里出现的串做 Grep，0 命中、不出卡、不报错；Glob 在 profileDir 下只列出本会话的落盘目录。
    - 旧 179：对话形态的 Read：本会话落盘目录里的直接读到，不出卡，可逆性 `read-only`；`tool-output/<sessionId>/../config.json` 与其余路径都在调用时拦下，HostConfirm 调用 0 次，回 is_error，有收口事实；对话形态从不产出 `outside-workspace`。
    - 旧 51、不变量 21：链接逃逸判为工作区外；在工作区内新建文件、新建多层目录判为工作区内；带 `..` 的路径按规范化后的结果判；工作区根在符号链接之下（macOS 的 /tmp）时存下真实路径，里面的读写不被判成工作区外；大小写不敏感卷与硬链接的结果记进验收记录。
    - 旧 160：悬空链接 `ws/dangling` 指向外面不存在的路径时，对它 Write 判为工作区外；内存 host 上溯到根仍为 null 的判为工作区外；`realpath` 抛错（如 EACCES）判为工作区外，`real` 取规范化后的路径；desktop host 对大小写写错的已存在路径返回磁盘上的写法；desktop 真实临时目录上 `realpath` 对不存在的路径、普通文件下的路径返回 null，对悬空链接、链接环抛错，内存 host 结果相同；指向保护名单的链接判 `protected`；硬链接写入只记回归基线、不断言拦下。内存宿主要能表示链接。
    - 主原因顺序逐例测：多条原因同时命中取最前一条；命令工具固定为 `command`（curl POST 得 `command` 加 `irreversible`）；WebFetch 三要素齐备时 `flagged` 排在 `network` 前；`policy` 与 `interaction-required` 同时成立取 `policy`。
    - 不变量 20 在 02 只断言前半句（内置工具只产生 `once` / `session`），阶段 3 持久存储那半句不测。
  - 暂定与待定：开放问题 11 的权限读法已确认；shell 配置清单为用户目录下 `.zshrc`、`.zshenv`、`.zprofile`、`.bashrc`、`.bash_profile`、`.profile`；还不存在的余下段保留模型给的写法、逐码元比较（暂定）；对话形态越界的拦截码按开放问题 13，定之前 `protected`；MCP 出卡格等开放问题 15。
- [ ] 12. **Inspector 与判决记录**（裁决 F1、F8、F9、F10）
  - 读：§权限引擎 · Inspector 与判决记录。
  - 交付物：`inspector.ts`、`session-view.ts`、第一段运行器（时限、超时与出错的折算、停止时不写判决事实）、contracts `ipc/approval.ts` 的 `DecisionSummary` schema、假 inspector（类型第 8、9 步已声明，`summarize` 在第 11 步）；注册时带 `afterResult` 就在构造服务时抛错；desktop 单测断言注册的 inspector 全是 `ceiling: 'ask'`。
  - 验收：31；不变量 15–19。
  - 测试要点：
    - 旧 162：给 `decide()` 的任意输入多加一条 inspector 结果，判决不会变宽（性质测试）；运行时返回越过声明的按出错处理；只会问人的 inspector 超时（假时钟推过 2 秒）：出卡、原因 `flagged`、`category: inspector-failed`，这一步 `status: 'timeout'` 并带 inspectorId；会拒绝的 inspector 抛错：拒绝、拦截码 `inspector`，回给模型「failed with an error」那一句，超时则是「timed out」那一句；同一 Run 连续 3 个这样的调用以 `blocked-repeatedly` 结束；一个超时、一个返回 `exfiltration` 时卡上 category 取 `exfiltration`，两个都超时取 `inspector-failed`；判定中点停止，inspector 收到中止，这个调用没有判决事实，收口 not-run / stopped；注册时带 `afterResult` 的，构造服务时抛错。
    - 旧 163：`summarize` 映射表的每一行恰好对应一个摘要码，任何可达组合（含 auto-range、task）都不抛错；contracts 的摘要 schema 与 kernel 类型互赋；摘要里没有 steps 与层号。
    - 旧 124：每个轮到判定的调用都有一条 `tool/permission_decided`，`record.steps` 覆盖第 1–8 层并逐个列出 inspector，另有 `decidedBy`；`summary` 在载荷里；`policyVersion` 只在载荷顶层；冻结后才被禁的调用 `decidedBy` 为 `user-disabled` 或 `tenant-policy`；开表时就被排除的工具没有判决事实。
    - 旧 125、不变量 19：contracts 的 `decisionSummarySchema` 是严格对象，与 kernel 的 `DecisionSummary` 有类型级断言；`toolOutcomeViewShape.permission` 为 `decisionSummarySchema.optional()`（`tool-outcome` 在第 14 步、`calls[i].outcome` 在第 20 步补跑）；断言 contracts 里 `DecisionSummary` schema 的键集合恰为 `verdict`、`code`、`facts`（不对整个 src 做 grep，contracts 里已有无关的 `orderSeq`）；遍历 contracts 全部路由 schema，没有 `steps`、`decidedBy`、`basis`。
    - F9：会话授权或总是允许在场时，假 inspector 说问就出卡、说拒就拒；unavailable 按拒处理。
  - 暂定与待定：`INSPECTOR_TIMEOUT_MS` 暂定 local-rule 2000、model 30000，待校准（第 34 步）；`recentUserTexts` 暂取 8 条；会话视图的读取范围按开放问题 11（已确认）。
- [ ] 13. **循环骨架与 Run 的结束**（裁决 H11、H12、A2、A5、F2、F3、M1、B1、M3）
  - 读：§主循环与 Run 的结束；01 修补 5；§工具调用的收口「崩溃、服务端调用块与兜底」。
  - 交付物：一个 Run 多次请求（`requestSeq` / `physicalAttempt`，取代 service.ts:84-85 钉成 1 的写法）；每轮 5 步；分流表（含三种作废，01 修补 9 (m)）；零可执行调用与只有服务端块的回复；17 个结束码与 `runEndReasonSchema`，`chat.event` 的 `done.endReason` 与 `error` 变体只增的可选 `endReason`（开放问题 16 的暂定做法，run-events 映射与 parse 测试同步）、两份 locale 的 17 个结束码键（从第 7 步移来）；kernel 从 `signal.reason` 读 `RunAbortCause`，定 `user-stopped` 与 `shutdown-aborted`；按请求计的重试与退避；步数上限、原地打转、连续被拦截（计数从 Tape 推出）；token 上限；截断收口与「继续」（`chat.continue` 路由与 `message/continuation`）；三种作废与每次整轮重发前发 `attempt-discarded`，`tool-outcome` 在 `tool/result` 与 `tool_outcome` 提交之后才发；`loop/limits.ts` 的常量（STOP 三个先声明，校准在第 23 步）。
  - 验收：15、16、17（「继续」按钮在第 20 步）。
  - 测试要点：
    - 旧 12：夹具分别回放 Anthropic 的 `server_tool_use` 与智谱的 `tool_calls[type=mcp]`：不派发、不补结果，注入的 `log` 被调一次；原样块存进 Tape，下一轮请求体里没有它；与一个客户端调用同在时，客户端调用照常执行并通过配对断言；回复里只有服务端块时，Run 以 `{ code: 'provider-error', errorCode: null }` 结束，不停在「有调用、没结果」上。
    - 旧 30：`stop{ refusal }` 在流中途到达：这次 attempt 只有 `provider/attempt_completed`，没有 `message/assistant` 与 `tool/call`，Run 以 `refusal` 结束，请求数为 1；第二个 tool_use 流到一半给出 `max_tokens`：第一个完整调用记 not-run / output-truncated，半截的不写，Run 以 `output-truncated` 结束，点「继续」后下一次请求通过配对断言；智谱 `sensitive`：已记下的调用记 not-run / content-filter，Run 以 `content-filter` 结束。
    - 旧 128：被截断的回复带两个完整 tool_use 和一个半截时，两个完整的各得一条 is_error（not-run / output-truncated），半截的没有 `tool/call`；不点「继续」直接发新消息，请求也通过配对断言。
    - 旧 129：refusal、context-overflow、network_error 三种 attempt 都不写 assistant 与 tool/call，下一次请求的末轮是 user；拒答以 `refusal{providerId, modelId}` 结束，不向第二个模型发请求；溢出在压缩后以新的 requestSeq 重发（第 30 步）；以完整 tool_use 加 `content-filter`（或 `pause-turn`）结束的回复照 01 落盘，完整调用各记 not-run（来源 `content-filter` 或 `provider-error`），终态为 `content-filter` 或 `provider-error{errorCode: null, providerReason: 'pause_turn'}`。
    - 旧 29：瞬时错误的重发次数不超过 min(`retryAdvice().maxAttempts` − 1, `RETRY_CAP`)，A5 的超时与智谱 `network_error` 计入同一个计数，用尽后以 `provider-error` 结束；401 夹具请求数为 1，以 `{ code: 'provider-error', errorCode: 'auth', attempts: 1 }` 结束；智谱 1113 不重发，以 `quota-exhausted` 结束。
    - 旧 130：流中途断开或空闲超时后，以同一 requestSeq、`physicalAttempt + 1` 重发，失败的那次只有带 error 的 attempt 事实；首字节超时后的重发带 `firstByteTimeout: false`；同一 Run 里请求 1、请求 2 各失败两次再成功，Run 不结束；同一 requestSeq 先网络失败、再 auth，以 `provider-error{errorCode: 'auth', attempts: 2}` 结束。
    - 旧 3：夹具连续返回同一批调用（工具名相同，经 `canonicalJson` 后参数逐项相等，顺序相同）：前 3 批照常执行，第 4 批不执行，记 not-run / no-progress，Run 以 `{ code: 'no-progress', repeats: 4 }` 结束；对照组参数差一个字节就不触发。
    - 不变量 14 的推论：每批都被机器拒绝的重复批次，在第 3 次拒绝时就以 `blocked-repeatedly` 结束，走不到 no-progress 的第 4 批。
    - 旧 27、旧 127：每轮返回不同的免批调用：第 101 次回复里的调用没有 `dispatch_committed`，记 not-run / step-limit，Run 以 `{ code: 'step-limit', limit: 100 }` 结束；点「继续」开新 Run，以一条只给模型看、不渲染的续写提示事实结尾，没有新的 `message/user`，计数从 0 重来；`done.stopReason` 的三个值与阶段 1 映射不变，细分原因在 `done.endReason`；步数跨重启延续：第 60 批时暂停、重启、批准后，新 Run 最多再跑 40 批就以 step-limit 结束（子 agent 的更小上限在第 31 步）。
    - 旧 28：给 Run 设 token 上限，某次 attempt 的用量越限：这次回复里的调用全部记 not-run / usage-limit，不再发请求，以 `{ code: 'usage-limit', tokenLimit }` 结束。
    - 事件（`createTestLoopPorts` 的记录器）：每次作废或整轮重发恰好一个 `attempt-discarded`，排在下一次 attempt 的第一个 delta 之前；让 `tool/result` 那次 append 失败时没有 `tool-outcome`，成功时它排在两条事实提交之后。
    - 旧 106（结束码部分）：`done.endReason` 可选；17 个结束码在两份 locale 里都有非空文案、槽位齐全；`run_terminal` 没有单独的 slots 字段。
    - 旧 131：每个 Run 恰好一条 `execution/run_terminal`，崩溃恢复写的是 `recovered`（在第 16 步补跑）；`run_terminal.usage` 等于本 Run 全部 attempt（含重发与摘要请求）的最终 usage，加上本 Run 写下交接的子会话用量（子会话部分在第 31 步）；token 上限默认关。
  - 暂定与待定：没有 `retryAfterMs` 时从 `baseDelayMs` 起步、每次翻倍（旧开放问题 94，开工前复核）；`RETRY_CAP` 暂取 2（第 34 步校准）；中途插进来的 `message/user` 不清零三种计数（旧开放问题 48）；零可执行调用的 tool-use 回合归 `provider-error`（旧开放问题 124）；token 上限暂按未命中缓存的输入加输出、含子 agent 计（旧开放问题 95，第 34 步前复核）；「继续」重新解析模型、算压缩边界（开放问题 11）。
- [ ] 14. **收口与重放**（裁决 B1、B2、E2、M3、H8、A2）
  - 读：§工具调用的收口；§执行日志与恢复表；§折叠与读法。
  - 交付物：（`ExecutionState` / `ClosureSource` / `BlockReason` 与 `ToolOutcomePayload` 第 8 步已声明，`BLOCKED_FACT_KEYS` 在第 11 步）`chat.event` 的 `tool-outcome`（按 `callKey`）与 `executionStateSchema` / `closureSourceSchema`（从第 7 步移来）；按会话串行的写入队列（先写者算数）；重放排列（结果紧跟 assistant）；`encode()` 前的配对检查与 `onUnansweredCall`（desktop 只在 `app.isPackaged` 时传 `'repair'`，`log` 传 `console.error`）；撤回折叠；执行日志的 T1。
  - 验收：14（等审批那一种状态在第 15 步补跑）；不变量 23、31。
  - 测试要点：
    - 旧 1：kernel 测试用 `fakeNetwork(script, { checkRequest: assertToolPairing })` 分别驱动 anthropic-messages 与 openai-chat 两条线：停止、崩溃各取 200 个随机时点，覆盖流式中、工具执行中、等审批三种状态，做法照 01 验收 7，崩溃的模拟方法是丢掉内存里的循环、在同一个 store 上跑启动恢复；拒绝按批内位置穷举：一批 n 个要批的调用，拒绝第 k 个，k 取遍 1..n；之后发下一轮请求，`checkFailures` 必须为空。兜底两例：默认 `'throw'` 时人为删掉一条结果，发送前就抛错，fakeNetwork 不多调一次；`'repair'` 时补写一条来源为 `repair` 的收口，注入的 `log` 被调一次，请求照常发出并通过配对断言。
    - 旧 106（`tool-outcome` 部分）：`tool-outcome` 通过 `chatEventSchema`，两个 schema 以 `satisfies z.ZodType<…>` 绑定 kernel 类型。
    - 旧 122：撤回一条带工具调用的 assistant 之后，下一次请求里既没有那些 tool_use，也没有对应的结果，界面不再显示那些工具行（界面在第 20 步）。
    - 旧 178：让补写的结果在 Tape 里排到后来的 `message/user` 之后，下一次请求里它仍紧跟所在的 assistant 轮，排在那条用户文字之前。
    - `closure.test.ts`（从第 18 步移来）：本步把 `MODEL_NOTES.closure` 整张表写齐（含第 15、16、23、26 步才写到的 `user-rejected`、`superseded`、`crashed`、`app-exit`、`unanswered`），去掉可选；逐格检查收口表要填的格都有非空英文、槽位不超出该格可用的槽位。
    - 不变量 31 的测法：不断言 `tool/permission_decided`、`execution/dispatch_committed` 与结果之间怎么交错；并行与全串行实现写出的事实按 `<i>` 的子序列比较。
- [ ] 15. **等待与答复**（裁决 F3、F6、F7、F11、F2、H6、M5、B1、A11）
  - 读：§等待模型：审批、提问与拒绝；§执行日志与恢复表「同批规则」；§续跑。
  - 交付物：`tool/permission_decided`（`awaits`、rejudge 键）与 `tool/approval_resolved` 的写入、同批规则；按根会话串行的答复队列；`approval.respond` / `approval.current` 路由、`canonicalSessionIdSchema` 导出、registry.ts 登记；答复前重新判定与 `stale`；续跑 Run（冻结原文、沿用 batch 的模型与档位；同批 append 用 `connector.endpointOrigin` 写 `model_selected`，append 之后在 mailbox 外调 `assemble`，第一次发请求时才调 `provider()`，构造失败不丢已执行调用的结果）；mailbox 的时序规则（一个根会话一个活租约、租约不转手、握租约还没开 Run 时 mailbox 只跑它、轮到时判定、预建结果只在判为新一轮或取代时用、Run 的写入任务先查 signal、`paused` 提交途中被停止照暂停中停止收口、登记之后 append 之前被中止及其返回值）与子会话 → 根会话的内存映射；主会话拒绝路径；新消息取代；`chat.stop` 对暂停会话（01 修补 9 (s)）。
  - 验收：19、20、21（e2e 部分在第 20 步）；不变量 25–28。
  - 测试要点：
    - 旧 4（kernel 三例）：重启前让测试宿主撤掉这个工具，重启后不弹卡、直接记 `tool-unavailable`；答复前用 `setPolicy` 把策略改为拒绝这个工具，点允许后重新判定收紧，记 `denied-on-rejudge`，工具不执行；同一张卡的「停止」与「允许」同时到达，只有一方生效，另一方得到 `already-resolved`，这个调用恰好一条结果。
    - 旧 169：暂停之后、答复之前假 inspector 改了问人的原因：用旧 requestId 调 `approval.respond` 返回 `stale`，不写 `approval_resolved`，有一条 `…:rejudge:1`，`approval.current` 返回新的 requestId，在新卡上允许返回 `applied`；窗口就绪前发出的 `confirm.request` 丢了时（e2e，第 20 步），打开会话仍经 `approval.current` 显示卡片。
    - 旧 170：先 `approval.respond(allow)` 后 `chat.stop`：前者 `applied`，后者 `stopped: false`，没有 `cancelled-by-stop`；先 stop：`stopped: true`，之后 respond 得 `already-resolved`；两种顺序都不抛 `TapeProvenanceConflictError`；对暂停的会话 `chat.stop`：写 `approval_resolved(cancelled-by-stop)`，这个调用和同批其余记 not-run / stopped，不写新的 `run_started`。
    - 旧 10：等审批时点停止：卡片消失，重启后也不再弹出；下一轮请求里这个调用和同批后面的调用各带一条 is_error、not-run、来源 `stopped`；不开新 Run。
    - 旧 173：主会话里拒绝：同一次 append 里有 is_error 结果（存着那句英文）、同批其余的 not-run、新 Run 的 `run_started` 与 `run_terminal(user-rejected)`；下一条用户消息之前不发请求。
    - 旧 174：一次回复里「写 a、写 b」：待批表只有一行；允许 a，a 执行、b 成为可答的卡；拒绝 a，b 记 not-run；在 `SessionService` 与 `approval.list` 上断言一个根会话连同子会话任何时刻最多一行。
    - 旧 21（kernel 部分）：有待批时发新消息：下一次请求里这些调用和同批后面的调用各带一条 not-run / superseded 结果，排在新消息之前；生成中已排队的消息按先后排在新消息前面一起发出。
    - 旧 15、旧 16：改某个内置工具的描述或系统提示后重启、续跑旧会话：tools 与冻结时逐字节相同，`toolDefinitionsHash` 与 `request.systemHash`（tape/entry.ts:207）不变，system 原文逐字节取自组装清单；模拟升级（换一份工具实现代码）后结果相同。
    - 旧 34：生成中或有待批时改选模型：当前 Run 与审批后的续跑仍发往原模型，`model_selected` 照写原来那一对值；下一条用户消息起才用新模型。
    - 续跑取冻结的 ModelInfo：暂停之后改模型表里这一行，续跑请求仍按 `view/content(model_info)` 的原文编码，`modelWireHash` 与暂停前相同。
    - 旧 172：续跑时 key 被删：已批准的调用照常执行、写结果，Run 以 `provider-error{errorCode: 'auth'}` 结束，fakeNetwork 0 次；模型已下线：发一次请求，以 `provider-error` 结束，不换别的模型。
    - mailbox 时序（`createTestLoopPorts`）：`approval.respond(allow)` 已登记、还没 append 时以 `user-stop` 中止，写的是 `cancelled-by-stop` 与收口、不开 Run；以 `quit` 中止，Tape 逐字节不变、重启后卡还在；答复在途时来的 `send`，答复返回 `stale` 时它走取代、不留在队列里；`leases.begin` 返回 `refused` 时任何命令都不写事实；等审批时发新消息而 `RunAssembly.provider()` 抛 `ProviderConfigMissingError`，没有 `superseded`、没有新消息，卡还在；等审批时发新消息、在预建期间以 `user-stop` 中止，写 `cancelled-by-stop` 与收口，没有 `superseded`、没有新消息，`send` 返回 `not-sent`（`stopped`），发 `run-ended{ recorded: false, reason: user-stopped }`；等审批时先发消息（还在预建）再点允许：允许等消息判定完，消息取代待批，允许返回 `already-resolved`，记录型租约只 begin 一次；先点允许（答复握着租约）再发消息：消息等答复开出续跑后入队；Run 已决定暂停、提交之前以 `user-stop` 中止：不写问人的判决和 `paused`，Run 以 `user-stopped` 结束；问人的判决与 `run_terminal(paused)` 那次 append 挂起时 `chat.stop`：返回 `stopped: true`，同一任务里写 `cancelled-by-stop` 与收口（提问时写 `unanswered`）、不开 Run，卡片消失，`run-ended.reason` 为 `paused`；同一时点以 `quit` 中止：Tape 只多 `paused`，重启后卡还在；答复已登记、还没 append 时先以 `close-window` 中止、再 `chat.stop`（上一条两个时点同样再各跑一次）：返回 `stopped: true`，写 `cancelled-by-stop` 与收口，卡片消失，答复返回 `already-resolved`；先点停止（排进 mailbox）再发消息：卡作废，这条按停止之后的空闲开新一轮，不被停止中止；预建的 `assemble` 一直不 resolve 时点停止：`send` 不等它、返回 `not-sent`（`stopped`），之后的 `send` 照空闲开新一轮；子会话不在映射表里时答复返回 `not-found`。
  - 暂定与待定：开放问题 14（B1 补录 #2）最晚本步前回来，默认作废待批；MCP 审批请求等开放问题 15；开放问题 26 的其余读法已定（2026-09-25，按 spec 现写法）。
- [ ] 16. **启动恢复**（裁决 B1、B3、B5、F3、B15、A13）
  - 读：§desktop 接线「启动恢复与发送防护」「e2e 接缝」；§执行日志与恢复表；01 修补 6「启动恢复」。
  - 交付物：`startup-recovery.ts` 的闸（这时已有的 `chat.send`、`chat.stop`、「继续」、`approval.*`、`session.latest` 都先 await；`chat.sendNow`、`chat.queue.act`、`workspace.*` 写路由、`session.selectModel` 在第 17、18、19 步建路由时接上）；`approval.list` 路由（含 `waitKind: 'resume'` 的可续跑行）与子会话到根会话的映射，contracts 为待批行写双向互赋断言（验收 13）；按恢复表补写（a、b 两类，子先父后）；只收紧的重新判定（只对 `approval` 行）；重新投递；可续跑项：第 1 步扫描时按 Tape 判据找出，启动时只列出、不开 Run、不调 `assemble`，kernel 的可续跑集合，`approval.resume` 路由与 `resume({ rootSessionId })`，打开会话时续跑，在可续跑的会话里先发消息时先续跑、这条入队，`chat.stop` 按 spec §每种答复同批写什么「可续跑的会话里停止」一行写；`session.latest` 映射回根会话（`readBySource` 取前 8 条读 `subagentOf`）；延迟恢复 e2e 接缝的环境变量（名字这一步定，只在 `!app.isPackaged` 下生效）。
  - 验收：18、24（主进程一半；渲染端在第 20 步）。
  - 测试要点：
    - 旧 119：记录调用顺序的 host 替身显示 `dispatch_committed` 在每次写文件、起进程、出网之前提交；预置同内容的 dispatch：不派发，按 uncertain / repair 收口；预置同键、writer 不同的 dispatch：不派发，记错误，按损坏收口；测试与开发构建里两种都直接抛出。
    - 旧 120：批准后、派发前崩溃，该调用记 not-run / crashed，新 Run 写 `recovered`；派发后、结果前崩溃，记 uncertain / crashed，不重跑；两种情况下一次请求都通过配对断言。预置「有 dispatch、有结果、没收口」：正式构建补写 uncertain / repair 并记错误，测试构建抛出；预置被拦的调用（结果加 effect=blocked 的收口，没有 dispatch）：判为已完成，不动。
    - 旧 121：在 `permission_decided(ask)` 之后、终态之前崩溃，恢复后这个调用没有收口，Run 终态为 `paused`，卡片可答；子会话在待批表里有行时，父会话的 Agent 调用也不补写（子会话那句在第 31 步补跑）；一个 Run 超过 1000 条事实时崩溃，恢复用带起点的 `readBySource` 读完并完整补写。
    - 旧 168：单调用批的启动重判：重启前把工具设为策略拒绝、撤掉它，或让假 inspector 改判拒绝，重启后不出卡，Tape 里有 `approval_resolved`（`denied-on-rejudge` 或 `tool-unavailable`，`via: 'rejudge'`，writer 为 recovery）与这个调用的 is_error 结果，待批表为空；`resumable` 列出这个根会话，`approval.list` 有它的 `resume` 行；`approval.resume` 之后恰好一次请求，带着这条 is_error 结果。
    - 多调用批的启动重判（「写 a、读 b」，a 被收紧）：`recover()` 之后没有新的 `run_started`，connector 与 fakeNetwork 都 0 次调用，`resumable` 列出这个根会话；`approval.resume` 之后开 `run_started{ resume }`，b 照常判定执行（用测试工具注册表的假执行器）；不调 `resume` 再重启一次，仍列出、没有 `recovered` 终态，b 没有补写；不 resume、直接在该会话 `send`，先开续跑 Run，这条消息入队，续跑处理完同批后在下一次请求前插入（插入在第 17 步补跑）；脚本化 connector 设成会返回 `needsConfirm` 或缺 key 抛错时，`send` 返回时 `resolveChoice` 与 `provider()` 都调了 0 次，续跑照开、这条照样入队；之后续跑 Run 第一次发请求时调一次 `provider()`，缺 key 的那例它以 `provider-error{ errorCode: 'auth' }` 结束，这条仍在队列；这样 `send` 之后 `approval.list` 没有它的 `resume` 行，`approval.resume` 返回 `none`、不开第二个指向同一暂停 Run 的 Run。
    - 可续跑的会话里 `send` 已在入口 begin、还没轮到时点停止：记录型租约只 begin 一次，这条命令用它写那个不发请求的 Run，只发这个 Run 的 `run-ended`，`send` 返回 `not-sent`（`stopped`）。
    - 可续跑的会话点停止（单调用批与多调用批各一例）：`chat.stop` 返回 `stopped: true`；一次 append 里有新 Run 的 `run_started{ resume }`、同批其余的 not-run / `stopped`（单调用批没有）与 `run_terminal{ user-stopped }`，fakeNetwork 0 次；下一次 `recover()` 不再列出它。
    - 旧 171：在 `approval_resolved(allowed)` 的 append 之后、派发之前杀进程：重启后被批准的调用与同批其余记 not-run / crashed（经 `run_started.cause.batch` 读到），Run 写 `recovered`，下一条用户消息在测试构建里通过 B1 的请求前检查。
    - 旧 135（`approval.list` 部分）：子会话的待批经 `approval.list` 返回父会话 id；横幅用的 `limit` 与启动恢复经 `SessionService` 读的 1000 分开。
  - 暂定与待定：找没有终态的 Run 按会话 `readBySource` 分页扫描配对，不加索引；启动时窗口自动恢复的会话不算打开，不调 `approval.resume`，末尾给一行「继续」（开放问题 2，owner 2026-09-25：启动时 0 次模型请求、不弹钥匙串；「继续」一行按开放问题 26（已定））。
- [ ] 17. **插话与自动发出**（裁决 H13、F11、B18、B4）
  - 读：§插话与输入框状态表；01 修补 6「排队、立即发送与继续」；§进行中、暂停与 RunRegistry。
  - 交付物：`chat.send` 由拒收改为入队（01 修补 9 (a)）、`chat.queue` 事件、`chat.queue.act`、`chat.sendNow`；排队消息在批边界插入并新分配 messageId（01 修补 9 (q)(r)）；`chat.sendNow`、`chat.queue.act` 接启动恢复的闸（`LoopPorts.queue` 第 9 步已实现）；kernel 按 §主进程与 kernel 的循环接口 在 mailbox 里判定、自动发出（先 `take` 再 `finish`，预建失败 `restore`）、按 `upToSeq` 与 urgent 取；`chat.sendNow` 与 send-now 带 `runId`（本步只加契约字段与 kernel 行为，渲染端带哪个 runId 随开放问题 16）；kernel 的 held 状态与 `queue-held`（run-events.ts 交给 queue.ts 设或清 `chat.queue` 的 `held`）；`SessionEvent` 的 `user-message` 按开放问题 16 的暂定映射成 `chat.event` 的同名变体（按 spec 01 修补 6 末尾那句，01 修补 6、9 (o)、01 spec 的 Amended by 与验收 9 的「四个新变体」同改为五个）；撤掉第 9 步留下的 `ALREADY_STREAMING` 判断，连同 `queued` 时撤下这一项的做法。
  - 验收：22（e2e 在第 20 步，「立即发送」打断 Bash 在第 23 步）。
  - 测试要点：
    - 旧 22：消息显示为「排队中」，`chat.send` 不再返回 `ALREADY_STREAMING`；这一批工具跑完后，下一次请求把它排在工具结果之后，属于同一轮；Run 停在审批上时排队消息不会自动发出；按 Cmd/Ctrl+Enter 立即发送，当前 Run 以 `user-stopped` 结束，这条作为下一条发出。
    - 立即发送与自动发出（kernel，`createTestLoopPorts`）：按下时的 runId 已结束、这条已被自动发出带走，send-now 返回 `not-found`，新 Run 不被中止；`chat.sendNow` 的 runId 已结束，这条按普通发送处理；`completed` 之后自动发出时 `RunAssembly.provider()` 抛 `ProviderConfigMissingError`（`assemble` 正常 resolve）：Tape 不变、排队项按原顺序还在、`run-ended{ recorded: false }`；自动发出预建期间对被取走的项按「立即发送」，返回 `not-found`、新 Run 不被中止；自动发出的 `resolveChoice` 返回 `needsConfirm`：fakeNetwork 0 次、排队项还在、发 `queue-held`（放出在第 19 步验）；记录型租约上 `run-ended` 之前 `finish` 已调，`finish` 与自动发出的 `begin` 之间没有空档；自动发出预建期间来的 `send` 入队、排在取走的项之后，取走的项先发出，只有一次 `begin`；子会话的 Run 在父 Run 租约下结束时没有 `finish`（第 31 步补跑）；队列项的立即发送：Run 已结束时按原 seq 带上前面的项发出，缺 key 时这一项留在原位；新一轮的直接发送只带走它到达之前入队的项；直接发送碰上间接切公网：`send` 返回 `held`，这条留在队列，发 `queue-held{ host }`；有排队项时直接发送碰上缺 key：返回 `not-sent`，Tape 不变，排队项还在；`chat.stop` 之后、被中止的 Run 写终态之前 `chat.send`，这条在 `user-stopped` 之后开新 Run；Run 已决定 `completed`、提交之前 `chat.stop`：终态为 `user-stopped`，不自动发出非 urgent 项；预建中的 `send` 被 `chat.stop` 中止后到的 `send` 照空闲开新一轮；两次 `send` 按到达先后写进 Tape（前一条在预建、后一条先进 mailbox 也一样）；直接发送碰上间接切公网之后，另一次没有 `needsConfirm` 的新一轮开出：发 `queue-held{ host: null }`，之后的 `selectModel` 不取任何项（第 19 步补跑）；held 那条被撤回后 `selectModel` 只清 held、不发出别的项（第 19 步补跑）。
    - `user-message`：新变体通过 `chatEventSchema`；run-events.ts 只转根会话的，子会话的不转。
    - 旧 132：插入之前排队消息不写 `message/user`；两条同文本的排队消息成为两条 messageId 不同的 `message/user`；Run 正常结束时排队消息自动开新 Run，暂停时保持排队；带插话的续发不触发摘要压缩；「立即发送」时正在跑的 Bash 在 1 秒内进程树清空，Run 以 `user-stopped` 结束，没执行的调用按收口表收口，再发出这条消息。
  - 暂定与待定：开放问题 1 已定（2026-09-25）；排队项由主进程内存持有、退出即丢弃，立即发送时其余排队项保持排队，等审批或等提问时 Cmd/Ctrl+Enter 同按发送（旧开放问题 97）；以 completed、user-rejected、paused 以外的原因结束时保持排队、不自动发出（旧开放问题 49，结合 owner 补录 H13 #1 复核）；智谱插话实测的结论（第 2 步）；开放问题 16 的 `user-message` 怎么交给渲染端最晚本步前定。
- [ ] 18. **会话形态、工作区、读工具与提示层**（裁决 H1、D11、D8、A13、H15、A11）
  - 读：§会话形态、工作区与模型选择「会话形态」「工作区」；§内置工具与参数；§提示层与评测「提示层」「思考的默认与显示」；§对 00-foundation 的修补「§国际化」。
  - 交付物：形态事实与建立前暂存；阶段 1 旧会话读作 `chat`；两套候选工具集；`workspace.ts` 与 `workspace.*` 路由（写路由接启动恢复的闸）；专用文件夹；工作区事实与中途增删；Read / Glob / Grep 执行器（Read、Glob、Grep 这时才进产品工具表）；`prompts/` 补上两份系统提示初版、`LOCALE_HINT`、`PROMPT_LAYER_VERSION` / `HASH` 与 version 测试（`fill()` 与 `MODEL_NOTES` 骨架在第 10 步，closure 测试在第 14 步）；思考默认（Anthropic 线 `display: 'summarized'`，默认不传 effort）。
  - 验收：32（选模型那半在第 19 步）、38（ThinkingBlock 在第 20 步）；不变量 7。
  - 测试要点：
    - 旧 180：没选文件夹的任务会话，工作区事实只有 `<home>/Tenon/workspaces/<userId>/<tenantId>/<sessionId>/`，来源 `dedicated`；第一次 Write 或 Bash 之前这个目录不存在；Bash 的 cwd 等于它（Bash 在第 22 步补跑）；有多个文件夹时 cwd 取第一个，事实记变化后的整张有序列表。
    - 旧 181：对文件夹 X 下的 f 批过本会话写授权，移除 X 后再写 f 出卡（`outside-workspace`，没有「本会话」期限），把 X 加回来仍出卡，重启重建授权后结果相同；第一个文件夹被移除、cwd 变了之后，同一条已批准的 Bash 命令再出卡；工作区变化后下一次请求的 system 与 tools 逐字节不变，messages 多一条说明新列表的追加内容。
    - 旧 182：`lastWorkspaceFolders` 有值、用户没点确认时，工作区仍是专用文件夹，读预填路径下的文件按工作区外处理；所选列表变化后 `lastWorkspaceFolders` 等于新列表，回落到专用文件夹时不变；`workspace.pick`、`workspace.usePrefill` 的请求体只有 sessionId，带别的字段解析失败；`remove` 一个不在列表里的路径返回 `not-in-list`，列表与事实都不变；对话形态（含暂存的形态）返回 `not-cowork`；目录对话框里取消，原样返回、不写事实。
    - 旧 183：发第一条消息前选任务形态、选一个文件夹、选 glm-5.3-flash 再发送：`session/start`、形态事实、工作区事实、`session/model_choice_set` 属同一批，第一个 Run 的 `session/model_selected` 是 glm-5.3-flash（选模型那半随第 19 步）。
    - 阶段 1 的旧会话没有形态事实时读作 `chat`；移除文件夹时挂着的待批卡由答复前的重新判定收紧。
    - 旧 224：改系统提示、`LOCALE_HINT`、`MODEL_NOTES` 的任一键、任一内置工具的任一 ToolSpec 变体（含 WebSearch 的两种 domainFilter）、结果模板或错误文本里的一个字符，而不同时更新 `PROMPT_LAYER_VERSION` 与 `PROMPT_LAYER_HASH`，`pnpm test` 失败；`fill()` 缺槽位时抛 TypeError（closure 测试在第 14 步）。
    - 旧 225（后半）：system 只由 kernel 按 `session/profile_set` 的形态与 `LoopPorts.locale({ sessionId })` 取的语言组装（这个端口只在组装 system 时读），写进 `view/content(system)`；`kernelAuthored` 为真的结果、`message/continuation` 的 content、anchor 的 `summary` 重放时都取存下的原文，升提示层版本之后旧事实复算的 promptHash 不变。
    - 旧 226（请求体）：默认不带 effort；Anthropic 线思考开着时带 `display: 'summarized'`，关着时不带；Haiku 4.5 只在预算式思考时带；智谱线默认不带 `reasoning_effort`，选了 high 的会话带 `'high'`（选档在第 19 步补跑）。
    - 语言提示取本 incarnation 第一次请求时的界面语言；会话中途改界面语言，system 逐字节不变；新会话才用新的语言。
  - 暂定与待定：开放问题 16：建立前暂存形态的路由、已建会话读形态与工作区的路由、工作区变化告诉模型的消息，定下之前这几小步不开工（增删与权限重算照做）；开放问题 13（对话形态越界拦截码）；开放问题 24（删除会话时不删专用文件夹）；Glob 按路径码元升序、不跟随指向工作区外的链接（暂定，引擎与正则方言在第 22 步按评测定，两条底线不变）；开放问题 11（文件夹只经主进程、cwd 一变授权作废，已确认）。
- [ ] 19. **模型选择与手填模型 ID**（裁决 M5、M6、A11、A15、A16、B14、A9、A14，约 1.3–2 步）
  - 读：§模型选择；§思考档位；§表外模型与不发工具；01 修补 6；§模型菜单与输入框。
  - 交付物：`session.selectModel` / `session.modelChoice`、`session/model_choice_set`、`defaultModelByProfile` 与 `lastWorkspaceFolders`、五层读取顺序；「已配置」的算法；key 绑定主机（`provider.configure` 的拒绝、发送前核对）；`provider.list` 的 `mark` / `listing` / `purposeKey` / `effortLevels` / `defaultEffort` / `endpoint`；ModelMenu 与 EffortSubmenu、目标主机与本机切公网的确认；设置卡改名（common.json 两个键）与写键规则；三条跨厂商回放测试的前两条；`provider.select` 撤掉 `unknown-model` 拒收（01 修补 9 (c)）、`source: 'user'`、菜单「更多模型 ›」与设置卡的手填输入、手填模型不发工具；run-assembly.ts 的 `resolveChoice`（②–⑤ 与数据去向检查，间接切公网返回 `needsConfirm`）；`session.selectModel` 接启动恢复的闸，写下选择后放出 held 的排队项；contracts 为会话选择写双向互赋断言（验收 13）。一步内修不完跨厂商回放就按砍法退到 M5-B。
  - 验收：10、33、34、35（M5-B 降级时改验 35 末句）；并补齐 12 的选模型一半、验收 2 的 common.json 一半。
  - 测试要点：
    - 旧 49：只改地址的主机、不重填 key，`provider.configure` 返回 `key-host-binding`，什么都不写；Ollama 的 baseURL 指向 `ollama.com` 或它的子域同样被拒；手改 config.json 让钥匙串 key 绑定的主机与当前地址不符，或环境变量 key 遇到已存地址换了主机：发送前按配置错误拒绝，fakeNetwork 0 次；搜索后端主机与 key 绑定的主机不符时 WebSearch 以 `no-search-backend` 排除（第 28 步验）。
    - 旧 109：Anthropic 的 `apiKey`、`authToken` 都存了时只重填一个也被拒，给全部已存机密都带新值就成功；「已配置」：Anthropic 两个凭据都拿不到为 false；打包构建只有环境变量时为 false，开发构建同一环境为 true；绑定主机与当前 baseURL 不同的 key 为 false；`provider.list` 逐键的 `configured` 随之变化。
    - 旧 33：会话 A、B 各选不同的模型，交替发送，各自发往自己选的模型，`session/model_selected` 不串。
    - 旧 107：五层顺序各一例：会话选择 → `defaultModelByProfile[形态]` → `config.json` 的 `provider` → 开发构建的 `TENON_PROVIDER` / `TENON_MODEL` → 默认 provider 表的第一行；`session.modelChoice` 返回解析结果。
    - 旧 37：e2e：对话形态选 X、任务形态选 Y，两种形态各新建一个会话，分别预选 X 和 Y；清空会话后回到该形态的默认。
    - 旧 186：默认请求体里没有 `output_config.effort` 与 `reasoning_effort`；选 high 之后下一个 Run 的请求快照带 high；换模型之后 effort 回到空；手填模型、glm-4.6、qwen3:8b、Haiku 4.5 不显示子菜单；glm-5.3-flash 的子菜单只列 low、high、max（旧 46）；触发器在 effort 为 null 时显示 `defaultEffort` 的档名；生成中改档显示「下一条消息起生效」与「会让缓存失效」。
    - 旧 187：设置卡只改 key、不动模型下拉就保存，不调用任何写模型的路由；改下拉并保存后，新的对话会话与任务会话都用设置卡的模型（暂定同时覆盖 `defaultModelByProfile.chat`、`.cowork` 与 `provider`）。
    - 旧 38：e2e：菜单每行显示目标主机，回环地址显示「本机」；Ollama 会话有历史时切到智谱，菜单原地出现确认，文案里有 `open.bigmodel.cn`；选「用新模型开新会话」，旧会话的 Tape 里没有新的 `provider/attempt_completed`，假智谱服务器收到的请求里没有旧会话的内容；选「切换」，下一次请求带着历史发往智谱。
    - 旧 39：e2e：没填 key 的厂商只留一行置灰的组头，写「去设置填 key」，点击打开设置；它的模型都选不了。
    - 旧 184：有历史的 Ollama 会话 C 从没在菜单里选过模型；在会话 A 选了 Anthropic 之后，C 的下一条消息不经确认就不会发往 api.anthropic.com（假网络对该主机的请求数为 0），`chat.queue` 的 `held.host` 为 `api.anthropic.com`；在 C 里 `selectModel` 之后 `held` 清掉，held 的那条带着前面的排队项发出，`resolveChoice` 不再返回 `needsConfirm`（kernel 测试，接第 17 步）。
    - 旧 185：全程没有系统原生对话框；取消之后会话选择不变；Ollama 的 baseURL 设为私网地址时，行上显示那个主机而不是「本机」；有进行中的 Run 时点「用新模型开新会话」，先走 `LeaveRunDialog`（第 20 步补跑），新会话不带旧内容。
    - 旧 123（从第 8 步补跑）：主页上先选模型再建会话，第 0 条 `model_choice_set` 与 `session/start` 同批；两次很快的 `session.selectModel` 得到 n=0、n=1。
    - 旧 36：① 历史里有 tool_use / tool_result 时，换到不发工具的模型（同 provider 的表外模型，或 Ollama）：请求里没有 `tools` 键，写一条 `view/tools_withheld`，仍通过配对断言；② 智谱产生的 tool call id 回放到 Anthropic 线、Anthropic 的 id 回放到智谱线，都通过配对断言（只比较相等，测不出字符集差异；③ 在第 30 步）。
    - 旧 40、旧 108：`provider.select` 与 `session.selectModel` 都接受表外 id，存 `source: 'user'`；得到的 ModelInfo 等于 01 spec.md:706 的保守合成；`session/model_selected` 记 `capabilitySource: 'user'`，以及只含协议、主机、端口的 `endpointOrigin`；请求里没有 tools；菜单行标「未验证 · 仅文字对话」，在任务形态置灰。
    - 旧 41：Ollama 会话在两种形态下，fakeNetwork 断言请求里都没有 `tools`。
    - 旧 82（common.json 那半）：两种语言的 `settings.providers.model` 为「新会话默认模型 / Default model for new chats」，`settings.providers.description` 前半句提到新会话；locale 键存在性测试仍通过。
    - 旧 235（只在触发 M5-B 降级时）：在已有历史的会话里点别家厂商的模型行，会话的模型选择不变，行上显示原因；点「用新模型开新会话」会新建一个用该模型的会话；同一厂商内换模型照常生效。
  - 暂定与待定：开放问题 3、4 已确认按修补；开放问题 16：key 的主机绑定记录存哪（定下之前 A9 的保存记录与发送前核对不开工），`listing` 暂定主进程一张表；02 之前已存、没有绑定记录的 key，升级后第一次用到时绑到当时生效的主机并记一行日志（暂定）；开放问题 23（内置行改 baseURL 暂标 `verified`）；私网算本机一侧（开放问题 11，已确认）；tool call id 不规整（官方 key 那次前缀测试再定，第 33 步）。
- [ ] 20. **界面最小正式版**（裁决 H3、F6、B18、B15、H12、D10、H13、H6、A11）
  - 读：§界面范围；§离开会话；§启动恢复与发送防护「恢复完成前不能发送」。
  - 交付物：先做 runtime 的 spike（继续用 `useLocalRuntime`，还是换成由 Tape 投影驱动的 external-store runtime；依据：「暂停 → 答复 → 续跑」「生成中入队」「重启后重画」三个 e2e 不绕过 runtime 就能通过，「重试」仍对应阶段 1 的 Reload）；contracts 的 `calls`（kernel 投影组装、desktop 只转交）、`approval.current` 的 `callKey` / `anchorCallKey` / `allowScope`；ToolRow、ThinkingBlock、TurnSummaryLine、FailureCard（「继续」「重试」规则）、BlockedNotice、最小审批卡（先做工作区外读；对象行转义、按 `requestId` 去重、点击保护）、排队中行、PendingApprovalBanner、LeaveRunDialog、渲染端按 id 切会话（切到后调 `approval.resume`）、`attempt-discarded` 撤回已流出的内容、`chat.queue` 事件带 `held` 时打开模型菜单的确认页、横幅的 `resume` 行与自动恢复会话末尾的「继续」行（可续跑状态都读 `approval.list` 里当前会话的 `resume` 行，停止钮这时也显示）、自绘停止钮与适配器 `onAbort` 只关本地通道、恢复完成前禁发、ModeSwitch 与 FolderChip、待批时的输入框提示、排队气泡；文案覆盖单测与双语回归；开放问题 16 的 `error.endReason` 定下后，写进 01 修补 6、9 (o) 与 01 spec 的 Amended by 行（或按定下的做法撤回第 13 步的改动）。
  - 验收：23、24、36（写入卡与不可逆卡在第 22 步）、37；补跑 19、20、22 的 e2e 部分。
  - 测试要点：
    - 旧 6 与文案覆盖单测：写法照 apps/desktop/test/provider-catalogue.test.ts，遍历 `ConfirmReason` 的 9 个值（`flagged` 按 `exfiltration`、`inspector-failed` 各算一条）、`RunEndReason` 的 17 个 code、4 个拦截码与 `ClosureSource` 全部值、3 种行标记、3 种期限、横幅的 3 种 `waitKind`、每个内置模型行的 `purposeKey`；断言 zh-CN 与 en 都非空，参数名恰好等于必填键（`ConfirmReason` 对每个 `kind` 各算一遍，取 `requiredFactKeys(reason, kind)`，confirm.ts:17；`irreversible` 在 `file`、`command` 下另要 `path`、`command`；拦截码按 `BLOCKED_FACT_KEYS`）。参数名用 `@formatjs/icu-messageformat-parser` 取（加为 desktop 的 devDependency），不用正则。
    - 旧 223：00 验收 12 的双语「不换行不截断」Playwright 回归，覆盖审批卡、模型菜单、失败卡、拦截回执、待批横幅；对象行里的路径、命令、URL 允许折行。
    - 旧 4（Playwright）：假 provider 让模型调 Write（任务形态工作区外读同理），卡片出现后退出再重启，同一个 `requestId` 只显示一张；点「允许」后写入，续跑请求仍发往原来的 provider 和模型，结果挂在原调用的 `(runId, requestSeq)` 下（Write 在第 22 步落地后补跑）。
    - 旧 97：同一个 `requestId` 投递两次，界面只有一张卡；答复之后再投递，卡不回来，塌成的那一行也不重新展开。
    - 旧 17：① 任务进行中点新建出确认，选「留在这里」任务照常跑完；② 停在审批上点新建不弹确认，新会话顶部出现横幅，点「回去」后卡片可答；③ macOS 上有待批时关窗，再从菜单点 New Chat，新窗口有横幅，回去后可答（只在本机 macOS 跑）；④ 有待批时重启：(a) 打开的不是那个会话时横幅列出它、回去可答，(b) 打开的就是那个会话时卡直接可答、横幅里没有它。
    - 旧 134：选「留在这里」时主进程收到 0 次 `chat.stop`，终态 `completed`；选「停止任务」恰好 1 次，终态 `user-stopped`；审批后开的续跑 Run 生成时点新建同样弹确认（判据取主进程状态，不取 assistant-ui 的 `running`）；暂停或空闲时切换、ChatProvider 卸载时 0 次；停在提问上时横幅用「在等你回答」的文案。
    - 旧 135：两个会话各有一个待答项时重启：打开的会话卡片可答，横幅列出另一个；再新建一个会话，横幅列出两个；横幅从不列当前会话。
    - 旧 18、旧 138：用启动恢复延迟接缝，`session.latest` 应答之前发送钮不可用，按回车后 Tape 里没有新的 `message/user`，应答之后可以发送；组件测试覆盖 `session.latest` 返回 `ok: false` 时同样放开。
    - 旧 20：一次回复里两个要批的写入：第二个以「排队中」行叠在第一张卡下、不能作答；允许第一张后它升为可答的卡，出现后 `APPROVAL_CLICK_GUARD_MS` 之内的点击无效；另一种情况拒绝第一张，叠着的行一起变「未执行」（写入在第 22 步落地后补跑）。
    - 旧 21（e2e）：有待批时输入框显示「发送会取消上面待批的操作」；发出后卡片消失（子 agent 那句在第 31 步）。
    - 旧 22（e2e）：生成中发送显示「排队中」气泡。
    - 打开时续跑（e2e）：预置一个可续跑的会话作为最近的会话，启动后主进程收到 0 次 `approval.resume`，假 provider 0 次请求；切走再切回，或点横幅 `resume` 行的「回去」，恰好一次 `approval.resume`，续跑请求发往原 provider 和模型；在自动恢复的会话里直接发送，先跑续跑，这条显示「排队中」。
    - `attempt-discarded`（组件测试）：已流出的文字与思考在收到它后消失，下一次 attempt 的内容从空开始。
    - 旧 214：任务形态工作区外的 Read：卡接在 `callKey === anchorCallKey` 的那一行 ToolRow 下面；对象行显示真实路径，工作区根位于链接之下时也是；原因句取自 `confirm.reason.outside-workspace`；「允许」旁写「只这一次 / Just this once」；允许之后塌成一行（结果、期限、路径），重启后从 `calls[i].outcome.approval` 重画出同一行。
    - 旧 217：kernel 单测对答复作用域表的每一行断言 `approval.current.allowScope` 等于同一条判决写进 `approval_resolved` 的 `grant.scope`；渲染端单测：(once，任意 target) 为「只这一次」，(session，url) 为「本会话里这个域名」，(session，其余) 为「本会话」。
    - 旧 218：目标文件名含 U+202E 时，卡上的对象行显示可见的 `\u{202E}`，显示的串与请求里的路径逐字符对应（Write 的卡在第 22 步补跑）。
    - 旧 219：模型菜单按厂商分组，当前项打勾，每行显示目标主机（回环为「本机」，内网 IP 显示 IP）；Ollama 行写「本机 · 仅文字对话」，手填 id 写「未验证 · 仅文字对话」，Fable 5.1 显示 30 天保留的要求；仅文字的行在任务形态置灰并写原因，在对话形态可选；未配置的厂商只剩一行置灰的组头，点击打开设置。
    - 旧 220：生成中停止钮与发送钮都在；有正文时按发送，消息流末尾出现「排队中」气泡（来自 `chat.queue`），撤回删除它，修改改变之后插入的文本，「立即发送」以 `user-stopped` 结束当前 Run 再发出；Cmd/Ctrl+Enter 经 `chat.sendNow` 做同样的事；有待批时停止钮可见。
    - 旧 221：`step-limit` 的第三行是「继续」（`chat.continue` 开新 Run），来了新的用户消息之后按钮消失；由用户消息触发、还没有任何 `dispatch_committed` 的 `provider-error` 给「重试」，这个 Run 里已执行过 Write 的给「复制诊断信息」，`errorCode` 为 `auth` 的给「去设置」；对 `RunEndReason.code` 的穷举 switch，只有每个码都有视觉类和动作时才编译得过。
    - 旧 222：任务形态里 Read Tenon profile 目录下的文件，那一行下面出现 BlockedNotice，原因取自 `blocked.protected` 并填好 target 槽位，没有放行入口；一轮里夹一次审批（写 → 允许 → 再读几次）只出一行 TurnSummaryLine，在最后一个 Run 结束后出现，计数覆盖两个 Run，暂停时不出（写入在第 22 步补跑）。
    - 旧 226（ThinkingBlock）：收起显示首句、展开显示摘要或 reasoning_content；流式时收起态显示用时，重启后重放的历史消息不显示用时；zh-CN、en 各一例。
    - 旧 27（界面）：`step-limit` 结束后界面出现「继续」。
  - 暂定与待定：开放问题 16（主进程怎么把 Run 状态交给渲染端；定下之前离开确认、停止钮的状态接线与立即发送带的 runId 不开工；`error.endReason` 按暂定已在第 13 步做，最晚本步前定；`user-message` 已在第 17 步前定）；开放问题 26（「继续」行，已定）；多个文件夹时工作区外卡的 `facts.workspace` 填第一个（暂定）；新卡不抢焦点；`APPROVAL_CLICK_GUARD_MS` 按 Cowork 09-17 修过的叠卡行为自测取值，结果写进 components.md 的带日期补记；横幅 `approval.list` 的 `limit` 暂取 20（第 34 步校准）；开放问题 11 的界面读法；开放问题 15（连接器卡）。
- [ ] 21. **① 的 live**（〔智谱 live〕；裁决 M2、A12、A1、H4、F3、H10、A2）
  - 读：§验收标准 第 39 条；§实测记录。
  - 交付物：`pnpm test:live` 的智谱 agent 用例（flashx 与 flash 各一遍）；实测结果写进本文件的 live 记录。
  - 验收：39（WebSearch 往返在第 28 步）。
  - 测试要点：
    - 旧 62（除 WebSearch）：一次带工具的多轮对话，至少两次工具往返，其中一次经审批卡批准；在 `TENON_LIVE_ZHIPU_MODEL`（glm-5.3-flashx）与 glm-5.3-flash 上各跑一遍。
    - 旧 63：在 glm-5.3-flash 上分别发 `reasoning_effort` 为 `low`、`high`、`max`，三次都返回 200，请求体里的值与所选一致；`reasoning_tokens` 只记进验收记录，不作判据。
    - 旧 64：映射出的超长名字智谱线接受；在 glm-5.3-flash 上出一张待批，重启后批准，带着回传的思考内容续跑成功；01 验收 21 继续通过。
    - 旧 233：经 zhipu 定义（openai-chat 线）流式发一次超过 200K 的输入，记下返回的是 1261 还是 finish_reason `model_context_window_exceeded`，两者都映射为 `context-overflow`；另用非流式的直接请求记一次原始返回作对照（结果供第 30 步）。
    - 实测：A2 的截断续写，智谱 `finish_reason=length` 截在 tool_calls 中途，按「继续」的写法续写，确认不报错。
    - 实测：在 glm-5.3-flash 上实发一次以「-」开头的 JSON schema 属性名（Grep 的 `-i`、`-n` 等）。
    - 可选：5.3 系对 `reasoning_effort=medium` 的反应（不挡）。
  - 暂定与待定：截断续写会 400 的话，截断的一轮按失败处理、不进历史，「继续」改为加大 max_tokens 整轮重发，走 Revisions；「-」开头的属性名被拒，就作为与 H7 的冲突带回 owner；A5 的间隔实测没在第 7 步跑完的，在这里补。

## ② 能改能跑（不能砍；做完时任务形态完整可用，但还没验收）

- [ ] 22. **Write / Edit / Bash**（裁决 E1、E4、D10、D7、H7）
  - 读：§内置工具与参数「Bash」；§可逆性；§内置工具的默认档位；§权限决策顺序「合并：两步」。
  - 交付物：Write（父目录不存在先 `mkdirp`）、Edit 执行器（Write、Edit、Bash 在本步进产品工具表）；Bash 起进程（`HostSandbox.wrap` + `HostProcess.spawn` + `afterExit`，同 connection.ts:48-61 的路径）与 `SandboxRequest`；命令保守模式表（`reversibility.ts`）、`command` 原因码、撤不回每次问并接进第 4 层 ①、卡上改动可展开；effect 取值按参数表。
  - 验收：40；补齐 36 的写入卡与不可逆卡、19、20 与 37 里需要写入的部分；不变量 22（命令部分）。
  - 测试要点：
    - 旧 52、不变量 22：判 `irreversible`：rm 已有文件；curl 带 `-X POST`、`-d`、`-F` 或 `--upload-file`；git push；scp。判 `unknown`：curl GET、ls 与解析不了的命令；永远不判 `read-only`；原因码一律 `command`。
    - 旧 96：一条 `curl -X POST …` 的审批请求：原因 `command`，facts 有命令原文和 cwd，`target.type` 为 `command`，可逆性 `irreversible`；「允许」只管这一次，同一条命令再来仍出卡；可逆性为 `unknown` 的命令允许之后，本会话里一字不差的同一条免问，差一个字就出卡。
    - 旧 161：假 inspector 返回问人只改要不要问，ConfirmRequest、判决事实、收口里的可逆性都不变；MCP 夹具工具不论声明 `readOnlyHint: true` 还是 `destructiveHint: true` 都是 `unknown`（「评测里不出现 revertible、snapshotted」在第 34 步）。
    - 旧 215：工作区内的 Write：卡上显示路径，改动默认收起，展开为写入内容的纯文本，「允许」旁写「本会话」；同一文件本会话第二次写不出卡。
    - 旧 216：撤不回的卡（删除已有文件的 Bash）：单独一句「撤不回」；按钮为「拒绝 ⏎ Esc」「允许」（后者不带按键提示）；焦点进卡落在「拒绝」；在卡内按 ⏎，包括焦点在「允许」上时，都按拒绝收口，文件仍在；点「允许」，或焦点在「允许」上按 Space，才执行，期限写「只这一次」。Everything 夹具工具的卡仍是 ⏎ = 允许、期限「只这一次」（等开放问题 15；这一句是渲染端组件测试，desktop 不注册 MCP 来源）。
  - 暂定与待定：开放问题 17（shell 路径与基础环境、超时后的状态与输出格式）没定，Bash 起进程与超时收口这两小步不开工；命令模式表在 E1 / E4 用例之外收哪些（`rmdir`、`find -delete`、`git clean -f`、覆盖文件的 `mv`、`wget --post-data`、rsync 到远端等）按评测里的命令样本定，只许加往 `irreversible` 判的；Glob / Grep 的引擎与正则方言、要不要「先 Read 才能 Write / Edit」的守卫（定之前不做）、Read 的行号前缀会不会降低 Edit 命中率，都按评测题定；每次调用起新进程、`cd` 不跨调用保留（暂定）；Bash、WebSearch、WebFetch 的 effect 暂定 `external`（开放问题 11）。
- [ ] 23. **停止即杀与关窗退出**（裁决 B1、B4、B18、H7）
  - 读：§工具调用的收口「点停止时各状态怎么收」；§desktop 接线「停止与退出」「e2e 接缝」；§上限、守卫与用量 的常量。
  - 交付物：`STOP_TERM_GRACE_MS` / `STOP_EXIT_CONFIRM_MS` / `STOP_WRITE_WAIT_MS` 的校准；停止时六种状态的收口；无条件 SIGKILL 与确认窗口；进程内写操作等待；Bash 超时（`HostClock.setTimeout`，同一序列）；窗口 `close` 与 `before-quit` 的确认、六步关机顺序、`watchOwner` 新语义与 `RunAbortCause`、删掉 will-quit 里的 `void tape.close()`、迟到写入捕获 `TapeClosedError`、`dialog.showMessageBox` 的调用写法与 e2e 接缝。
  - 验收：41、42；补齐 22 的「立即发送」打断 Bash。
  - 测试要点：
    - 旧 7：夹具命令 fork 一个子进程，父子都忽略 SIGTERM；Bash 跑起它之后点停止：1 秒内这棵进程树里没有存活的进程；这次调用记 aborted、来源 `stopped`，附上停止前的输出；进程树清空之后界面才出现「后续写入未发生」。Linux CI 与本机 macOS 各跑一遍，口径同 01 验收 20（CI 现在只有 ubuntu-latest，.github/workflows/ci.yml:23）。
    - 旧 177：流里已收完一个 tool_use 时点停止，或假 inspector 一直挂着时点停止，这个调用都记 not-run / stopped、effect=blocked，inspector 被中止不算出错；直接子进程收到 SIGTERM 就退、孙进程忽略 SIGTERM 的夹具，点停止后 1 秒内整个进程组清空；`exited` 在确认窗口内到达才写 aborted（附停止前的输出）；假 ChildHandle 的 `exited` 永不 resolve 时记 uncertain，界面写「可能已执行」；进程内写操作超过 2 秒才返回：先写 uncertain，之后返回时 Tape 条数不变、不抛冲突，注入的 log 被调一次；停止与正常完成同时到达时只留下一条结果。
    - 旧 142：Bash 超时（夹具子进程忽略 SIGTERM，`timeout: 1000`）：先收 SIGTERM，约 0.5 秒后收 SIGKILL，`exited` 确认之后才写结果（is_error，带部分输出与「超时被杀」），1 秒内进程树清空；不给 timeout 时假时钟上的时限是 120000 毫秒。内存 host 记下的 `SandboxRequest`：`commandId` 等于 providerToolCallId，`cwd` 等于 folders[0]，`workspace` 等于整张 folders，`profile` 为 `'workspace-write'`，退出后调了 `afterExit(commandId)`；kernel 源码里没有读 `process.env` 的地方。
    - 旧 143：Read 在两次 HostFs 调用之间看到中止信号，就不再发起下一次读，记 aborted；Write 的 `writeFile` 在途时，要等它完成才写收口。
    - 旧 230（STOP 部分）：`packages/kernel/src/loop/limits.ts` 导出三个 STOP 常量，都标「待校准」，前两者之和不超过 1000。
    - 旧 13：流式途中触发退出（e2e 用 `app.quit()`，Cmd+Q 到不了应用菜单）弹确认，确认后退出，重启后这个 Run 的终态为 `shutdown-aborted`；流式途中关窗也弹确认，选「取消」后任务照常跑完。
    - 旧 136：确认「停止任务并退出」后，重启时该 Run 的终态为 `shutdown-aborted{trigger: 'quit'}`，每个已派发的调用都有来源为 `app-exit` 的收口；关窗时确认停止为 `trigger: 'close-window'`。
    - 旧 14：有待批时退出，不弹确认，重启后卡片还在且可回答；macOS 上关窗后从 Dock 打开（`app.emit('activate')`），卡片可答，只在本机 macOS 跑，写法同 apps/desktop/e2e/session-restore.spec.ts:70。
    - 旧 137：关机顺序单测（假 app、假 TapeStore）：没有进行中 Run 时 before-quit 不弹确认；`tape.close()` resolve 之前不再调 `app.quit()`；关机流程开始后 `chat.send`、`approval.respond` 返回 `ok: false`，不开 Run、不写事实；等待上限取 `STOP_TERM_GRACE_MS + STOP_WRITE_WAIT_MS`，apps/desktop 里 grep 不到字面量 2500。
    - e2e 的原生确认框用 `electronApp.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: <i>, checkboxChecked: false }) })` 预设答案；有进行中 Run 的用例结束前也要预设，免得 teardown 卡在确认上。
  - 暂定与待定：三个 STOP 常量用「直接子进程退出、孙进程忽略 SIGTERM」与「父子都忽略」两个 fork 夹具在 macOS 与 Linux CI 各跑一遍，要求 1 秒内进程树清空，不够就调数、规则不变；校准同时决定退出第 4 步的等待，desktop 不改代码，只核对 `settled` 的入参随之变化；崩溃后残留的命令进程组只记 uncertain、不找也不杀（留到后续）。
- [ ] 24. **长输出落盘与只读并行**（裁决 H9、H14、A13、F6、E4）
  - 读：§大响应落盘；§本地持久化布局：只加一行；§一批工具怎么执行。
  - 交付物：`toolOutputDirFor`、`loop/spill.ts`（`SpillRecord` 第 8 步已声明）、`MODEL_NOTES.spill`；desktop 清空、删除会话的「store 提交 → 删目录 → 完成」与完成前拒收发送；`loop/batch.ts` 的只读并行组，结果按调用序号缓冲写入（来不及就先串行交付，Tape 形状不变）。
  - 验收：43、44；不变量 13、34。
  - 测试要点：
    - 旧 57、旧 188：成功、失败、WebFetch 各一例：一次结果的 text 总字符数超过 `SPILL_THRESHOLD_CHARS` 时，全文写进 `tool-output/<sessionId>/<file>`；`tool/result` 的 content 只有说明与预览，`kernelAuthored` 为 false；`spill.file` 不含 '/'；文件的 SHA-256 与字节数等于 `spill.sha256`、`spill.bytes`；任何 Tape 载荷里都没有全文，也没有绝对路径；两段 text 加一张图时，文件是两段以 `\n` 拼接，图片块原样留在 content 里、排在说明之后、不计入阈值；`toolOutputDirFor(profileDir, '../x')` 与大写的 UUID 都抛 TypeError；对话形态下 Read 这个路径不出卡；读别的会话的目录会被拦下；写盘失败回 is_error。
    - 旧 189：`deleteSession` / `resetSession` 完成之后目录不在；删除进行中该会话的发送不被接受；撤回单条消息之后落盘文件仍在；kernel 源码里没有删目录的调用。清空会话按「store 提交 → 删目录 → 完成」执行，清空之后新 incarnation 刚落盘的文件不会被异步删除吞掉。
    - 旧 23：「读 a、读 b、写 c、读 d」，a、b、d 都在工作区内：a、b 并行，两者的派发都早于任一个完成；c 出卡，d 排在 c 后面，拒绝 c 后 d 记 not-run；让 b 先于 a 完成，Tape 里的结果仍按调用顺序排。
    - 旧 126：d 没有被派发；`tool/result` 与 `tool_outcome` 按 a、b、c、d 的顺序出现；本会话即使已允许过搜索与域名，同批里 WebSearch、WebFetch、Bash、Write、MCP 工具也从不同时在途；对话形态里连续的 Read 逐个派发。
    - 不变量 13：假工具记录执行区间，只有最前面那组 Read / Glob / Grep 的区间允许重叠。
  - 暂定与待定：开放问题 24（Read 读落盘文件时单次结果又超过阈值；默认只返回阈值以内的整行并注明下一段的 `offset`）；删目录失败不在启动时清扫；阈值与预览在第 34 步校准。
- [ ] 25. **评测运行器与小横评**（裁决 H15、M8、D7）
  - 读：§评测集与测试宿主；§记录格式与费用口径；§同题对比。
  - 交付物：`apps/desktop/evals/`（测试宿主、task 与 record 的 zod、checks、费用函数、models.ts 的评测专用行），根 vitest 的 `evals` project 与 `pnpm eval` / `pnpm evals:gate` 脚本，评测集前 5 题（01–05）；循环跑通后马上做 GLM 小横评。
  - 验收：45。
  - 测试要点：
    - 旧 227：`outside-workspace` 卡被自动拒绝；带 web 的题里 `command` 卡被自动拒绝；子进程看到的 HOME、TMPDIR 在 mkdtemp 目录下，环境里没有任何 `*_API_KEY` / `*_AUTH_TOKEN`；题目 JSON 给 `outside-workspace` 或（带 web 时）`command` 写 allow 会被 zod 拒收。
    - 旧 228（格式部分）：`pnpm test` 包含 evals 的格式检查（tasks、results 过 zod，fixture 引用的文件都在），不联网、不要 key；docs/evals/fixtures 下没有被 .gitignore 吞掉的文件（`.env` 以 `dotenv.txt` 存放）。
    - 旧 229：费用函数单测：anthropic-messages（inputTokens 不含缓存）与 openai-chat（inputTokens 含缓存）各一例，`usage.input` 与费用和手算一致；缺 pricing 时费用记 null。
    - 实测：GLM 小横评，前 5 题，glm-5.3-flash 与 glm-5.3 各跑 3 次，不传 effort（即 max），约 ¥35；flashx 只测一次速度，记进 `timing`。
  - 暂定与待定：按 flash 在多步任务上掉多少，定基线模型用 glm-5.3-flash 还是 glm-5.3；评测运行器要不要设全局 token 上限当费用护栏，按 `calib.perRequest` 的单题最大用量定，定之前只按题目里的 `usageLimitTokens`。

## ③ 其余（先做不砍的，再按砍法倒序做）

- [ ] 26. **提问**（裁决 H6、F3、B1、H13、F6）
  - 读：§提问工具 AskUserQuestion；§等待模型：审批、提问与拒绝；§阶段 2 做的组件 的 `AskWidget`。
  - 交付物：AskUserQuestion 的上限校验、结果模板与三种回填、`awaits: 'question'` 与暂停同批、`approval.respond` 的 question 分支、等提问时的打字回答（`chat.send` 进同一个串行队列）、停止记 `unanswered`、最小 widget、汇总卡、同批后续调用以排队行叠在那次 AskUserQuestion 的行下；AskUserQuestion 在本步进产品工具表。
  - 验收：46。
  - 测试要点：
    - 旧 11（提问部分）：等提问时点停止，提问调用的结果是 `unanswered`，同批后面的调用记 not-run。
    - 旧 24：跳过时记 `no-preference`；直接打字回复时，原文作为结果回传。
    - mailbox 时序（从第 15 步移来）：等提问时会话当前选择的 key 缺失（续跑用的原 provider 有 key），打字回复照常写成答案、用 `send` 自己的租约开续跑，不 `finish`。
    - 旧 133：等提问时发送，输入的原文写成 AskUserQuestion 的结果，再开新 Run；排队消息在下一次请求前插入。
    - 旧 175：等提问时重启，`approval.current` 返回提问；跳过的题得到「无偏好」标记；多选 `['x', 'y']` 成为 `'x, y'`；未知的答案键返回 `invalid`、不写事实；等提问时 `chat.send` 成为打字回答（answers 为 {}，response 为原文），不写 `message/user`；停止记 `unanswered`。
    - 旧 176：在「其他」里打的字放进 `answers[题目原文]`；tool_result 文本来自固定模板，重放逐字不变；审批与提问同时待答时先出审批卡，审批答完才出提问卡。
  - 暂定与待定：开放问题 18（汇总卡的数据从哪读），定下之前汇总卡这一小步不开工；`unanswered` 标 is_error（开放问题 11，已确认）；子会话工具表里没有它（第 31 步验）。
- [ ] 27. **本机抓取与 WebFetch**（裁决 H8、F10、E4、D5、F2、H9；最后一个可砍项）
  - 读：§本机抓取器；§审批、授权与费用；01 修补 4（`fetchUntrusted`）；01 修补 9 (p)。
  - 交付物：`HostNetwork.fetchUntrusted` 修补与 desktop `host/fetch-untrusted.ts`（DNS 解析一次、判地址、钉地址、3xx 原样返回、`createDesktopNetwork(seams?)` 测试接缝），内存 host 与 fakeNetwork 同改；WebFetch 的字面判定、逐跳重定向、HTML 转 Markdown、落盘、审批与主机名授权、host 拒绝的收口。外带检查（第 29 步）接上之前，WebFetch 不进工具表：本步的 kernel 测试与 desktop 集成测试经 `createTestSessionService` 的注册表把 WebFetch 设为 `'real'`。
  - 验收：47。
  - 测试要点：
    - 旧 56：字面判定：非 http(s) 协议、URL 带用户名或密码、主机名不带点（含 `localhost`）、IP 字面量落在回环、私网或链路本地地址段（含十进制写法和 `::ffff:` 映射），都以 `protected` 拦下，不出卡，不触网；provider 发往 `localhost:11434` 的请求照常。
    - 防绕过用例（不需要 key，放在 desktop 集成测试里，用 apps/desktop/test/support/ 的 node:http 假服务器与 `lookup` / `connectTarget` 接缝）：公网 URL 302 跳到 127.0.0.1，走 WebFetch 端到端（kernel 执行加 desktop 的 `fetchUntrusted`），环回上的目标服务器收到 0 次请求、结果没有跟随；域名解析到 127.0.0.1 时 `fetchUntrusted` 以 `HostNetworkDeniedError` reject；已批准的域名换了解析结果，同样 reject；同一个测试里 `network.fetch` 访问环回上的临时端口照常成功（不绑 11434）。
    - 旧 208：假服务器返回 302 时，调用方拿到的就是这个 302 与 Location，假服务器只收到一次请求；每次调用恰好解析一次 DNS；内存 host 与没有脚本的 fakeNetwork 调 `fetchUntrusted` 都抛错；provider 测试里它的调用数为 0。
    - 旧 209：同主机 302 在内存里重判后跟随，不多写判决事实，结果写最终 URL；跨主机 302 不跟，结果 `is_error: false`，带状态码与绝对化后的目标 URL，另一台主机 0 次请求；没有 Location 的 3xx 回 is_error；F5 条件成立、同主机跳转目标不在豁免里时，按跨主机处理、不出卡；第 21 跳回 is_error。
    - 旧 210：DNS 层被拒，WebFetch 的收口为 not-run、来源 `protected`，facts 为 `{ toolName: 'WebFetch', target: <主机名> }`，结果 is_error，出拦截回执、没有放行入口；连续 3 个这样的调用以 `blocked-repeatedly` 结束。
    - 旧 211：`text/plain` 原样返回，`application/octet-stream` 回 is_error 并带类型；超过阈值的页面按 H9 落盘，结果只有预览、路径和大小；HTML 转 Markdown 的验收等库定下后补。
    - 旧 212（WebFetch 部分）：第一次访问 a.example.com 出卡，target 为完整 URL；同主机再抓不出卡；b.example.com、sub.a.example.com 都要出卡；`grant.key` 等于 `grantKey(BUILTIN_SERVER_ID, 'WebFetch', { kind: 'domain', host })`；`A.Example.COM.` 规范化为 `a.example.com`。
  - 暂定与待定：开放问题 12（外带检查怎么接，spec 定的期限是 ③ 的搜索与抓取开工前）最晚本步前定；开放问题 5（`fetchUntrusted`）已确认按修补；开放问题 18（HTML 转 Markdown 在哪一层、用哪个库），定下之前这部分不开工；开放问题 22（智谱线改不改走 `/reader`）；跳数上限暂取 20（第 34 步校准）；同主机跳转之后那一跳被 host 拒绝的算拦截（`protected`，计入 F2，出回执；暂定）；CGNAT 等地址段不拦（阶段 4）。
- [ ] 28. **智谱与 Anthropic 搜索后端**（裁决 H8、A6、A9、M4、M2、E1、D1、F5）
  - 读：§工具形状与后端选择；§智谱后端；§Anthropic 后端；§审批、授权与费用。
  - 交付物：`tools/search/` 的类型、智谱后端（`search_pro_quark`、70 码点截断、1701–1703）、Anthropic 后端（非流式子请求、按 `forcedToolChoice` 挑型号、多块合并）；run-assembly 按主机选后端并做 key 绑定主机的检查；WebSearch 工具（域名参数随后端的 `domainFilter`）；每个根会话 200 次；审批与后端域名授权；写 `searchHitUrls`；WebSearch 在本步进产品工具表。官方 key 没到手时 Anthropic 线不提供 WebSearch，记为保证档待补。
  - 验收：48、49；补齐 39 的 WebSearch 往返（〔智谱 live〕，后端 `search_pro_quark`，flashx 与 flash 各一遍）与 8 的「搜索后端过同一个白名单函数」。
  - 测试要点：
    - 旧 203：desktop run-assembly 的参数化测试：zhipu 定义（open.bigmodel.cn）用智谱后端；anthropic 定义且 baseURL 为 `https://open.bigmodel.cn/api/anthropic` 用智谱后端；anthropic 默认的 api.anthropic.com 用 Anthropic 后端；ollama 或其他主机没有后端，冻结的表里没有 WebSearch，`excluded` 记 `no-search-backend`；开发构建里只有环境变量 `ZHIPU_API_KEY`、钥匙串为空时，WebSearch 在表里，请求的 Bearer 等于这个环境变量的值。
    - 旧 204：fakeNetwork 记到恰好一次 `POST https://open.bigmodel.cn/api/paas/v4/web_search`，`search_engine: 'search_pro_quark'`、`search_intent: false`，Bearer 等于 provider 的 key，请求头都在白名单内；1701、1702、1703 都回 is_error，只有一次请求；100 码点的搜索词：`tool/call.input.query` 仍是原文，`confirm.target.query` 与请求体的 `search_query` 都是前 70 码点，结果文本注明已截断。
    - 旧 239：智谱搜索后端的请求只经注入的 `network.fetch` 发出，带着 `secrets` 里的 key；desktop 为它取 key 用的钥匙串账户与 provider 的 `keyFor(identity, 'provider', 'zhipu', …)` 相同，不另开键。
    - 旧 205：Anthropic 后端请求非流式；tools 只有一个带 `max_uses` 的 `web_search_20250305`；`tool_choice: {type: 'any'}`；没有 anthropic-beta 头。注入的表里 sonnet-5 可强制时，model 为 `claude-sonnet-5` 且 thinking 为 `{type: 'disabled'}`；把 sonnet-5 那一行的 `forcedToolChoice` 设为 false 后，改用 `claude-opus-5` 且不带 thinking；两行都是 false 时，开表以 `no-search-backend` 排除 WebSearch。
    - 旧 206：每种只有一次请求：一个成功块加一个 `max_uses_exceeded` 错误块，成功，命中取自成功块；两个成功块 url 重叠，合并去重；成功块全是空列表，空结果、不算错误；全是错误块或没有 `web_search_tool_result`，回 is_error，错误码取第一块的；`stop_reason` 为 `pause_turn` 时即使有成功块也回 is_error；主对话的 Tape 里没有这次子请求的 assistant 回合。
    - 旧 207：根会话与经 parent_link 连到的子会话，WebSearch 的 `dispatch_committed` 合计 200 条之后，下一次 WebSearch 调用不写判决、不出卡、不写派发，回 is_error，fakeNetwork 0 次；子会话里的调用计入根会话。
    - 旧 212（WebSearch 部分）：本会话第一次 WebSearch 出卡（原因 `network`，facts.host 为后端域名、toolName 为 WebSearch，target 为 `{ type: 'search', query: <截后>, host }`，可逆性 `unknown`，卡上没有「撤不回」）；同一后端再搜不出卡，中途换到另一个后端主机后再搜要出卡（按收窄读法；owner 不认可时这一条反转）；`grant.key` 等于 `grantKey(BUILTIN_SERVER_ID, 'WebSearch', { kind: 'search', host })`。
    - 旧 213：WebSearch 成功时 `tool/result` 带 `searchHitUrls`：只含非 null 的 url，去掉 `#` 片段后的 href，已去重，落不落盘都一样；写回过一次 WebSearch 或 WebFetch 结果之后，会话视图的「读进过不可信内容」为真，这个值只按来源算。
    - 旧 104（搜索部分）：搜索后端的请求经同一个白名单函数。
    - 实测（官方 key）：型号顺序 Sonnet 5 → Opus 5；Sonnet 5 关思考、Opus 5 保持 adaptive 两种设置在强制 `tool_choice` 下都可用；在两者上各发一次不压上限的子请求看 `usage.output_tokens`。
  - 暂定与待定：开放问题 20（官方 key，最晚本步前）、21（搜索细节，定之前按 spec 现写法：没链接的命中保留、不传 `count` 与 `search_recency_filter`、不设时限不重试、不做净化、没有配额和缓存）；默认档 `search_pro_quark` 已确认（开放问题 8），账单待核；`max_uses` 暂定 1，`max_tokens` 由 owner 按官方 key 的探测取值，在第 33 步定稿。
- [ ] 29. **外带检查**（裁决 F5、F10、F1、H5）
  - 读：§外带检查；§railguard 映射（只在选适配器时）；§挂点与会话视图。
  - 交付物：按开放问题 12 的接法实现（owner 没回复就写 kernel 的等价规则 `permission/exfiltration.ts`），以 `ceiling: 'ask'`、`kind: 'local-rule'` 由 desktop 在 `index.ts` 注册；豁免数据与会话视图从 incarnation 起算；接上之后 WebFetch 才进工具表。
  - 验收：50。
  - 测试要点：
    - 旧 54、旧 165：任务形态读过工作区 `.env`、抓过一个网页后，对本会话已允许的同一域名发 WebFetch，URL 既不在真人 `message/user` 里、也不在 `searchHitUrls` 里：出卡，`flagged / exfiltration`，target 为完整 URL；答「允许」后，同一域名的下一次非豁免抓取仍出卡（不生成域名授权）；外带检查抛错或超时：`flagged / inspector-failed`，只管这一次。
    - 旧 166：URL 出现在真人消息文本里（含紧跟全角「，」「）」的写法），或出现在 WebSearch 结果的 `searchHitUrls` 里（包括结果已落盘、Tape 只剩预览），按域名授权免问；只写 `example.com/x`、不带 scheme 的不豁免；写下 `compaction/anchor` 之后污点不清零，清空会话之后才清零；Agent prompt 里写的 URL 不算你的消息；两个条件只满足一个、对话形态、WebSearch 与 Bash 调用本身、你拒绝过的 WebFetch，都不触发；重启后从 Tape 重算，结论不变。
    - 旧 167：用 `createScriptedProvider`（packages/kernel/src/testing/scripted-provider.ts:44）让模型固定发出「读 .env，再 WebFetch `同一域名/?d=<内容>`」，弹出 flagged 卡、URL 完整，答复前 `fetchUntrusted` 调用数为 0。
    - 旧 164（只在选适配器时）：railguard 映射表每行一个测试，含 `HookRunResult.errors` 非空而 `ok` 为 true（fail-open）的用例，这时按声明的 ceiling 处理。
  - 暂定与待定：开放问题 12（接法、`status: 'skipped'` 的映射、豁免的 URL 提取与比较算法）已在第 27 步前定；「碰过私有数据」的范围与 `recentUserTexts` 条数在第 34 步看评测再校。
- [ ] 30. **摘要压缩**（裁决 H10、E2、A13、H12、M5；第二个砍项）
  - 读：§上下文管理：大响应落盘与摘要压缩；§tools 只在下列时点变化；§撞墙兜底与换模型。
  - 交付物：`loop/compaction.ts`（阈值、估算、边界、三种时机、防空转）；摘要请求（思考参数六行表、`compaction` 键、复算）；anchor 与各 provider 的 after-compaction 工具表同批写；重建与 `dropThinkingBefore`；撞墙兜底（与 `RETRY_CAP` 分开计）；换到小窗口模型先压缩；污点不随 anchor 清零；压缩阈值的测试接缝（只在 `!app.isPackaged` 加专用变量下生效）。
  - 验收：51；不变量 8（压缩用例）、9。
  - 测试要点：
    - 旧 2：夹具让 provider 在边界请求上连续报溢出，Anthropic 的 `model_context_window_exceeded` 与智谱 1261 各一组；夹具的历史要足够长，保证每次压缩都有可覆盖的内容；Run 以 `{ code: 'context-overflow', compactions: 2 }` 结束，provider 请求数恰好 5：原请求 1 次，加 2 ×（摘要 1 次 + 重发 1 次）；对照组：Opus 5.5 在回合中途溢出时不压缩，以 `compactions: 0` 结束。
    - 旧 31：(a) 边界请求：摘要请求在这条用户消息的请求之前发出；阈值取 `compactionThreshold`，Ollama 4096 档与 200K 档各一例，各测阈值上下一个 token；(b) `compaction/anchor` 与本会话用过的每个 provider 的 `view/tool_table` 同批写（`reason: 'after-compaction'`，代数加一），开表前禁用、开表后撤销的工具出现在 after-compaction 的表里（旧 149 补跑）；(c) 智谱会话在回合中途越过阈值，在两次工具往返之间压缩更早的回合，当前回合的消息逐字节不变，同样条件下 Opus 5.5 会话不压缩；(d) 保留尾巴里的思考块记 `drop / compacted`，tool_result 与原文逐字节相同；(e) 带插话的工具结果续发、cause 为 `resume` 的 Run 都不触发边界压缩。
    - 旧 190：`compactionThreshold` 对 contextLimit 4096 得 3276，200K 与 1M 都得 150000；估算只读主请求的 attempt，anthropic-messages 用 input + cacheRead + cacheWrite，openai-chat 只用 input；最近的 anchor 之后还没有主请求时，不用 anchor 之前的用量；带 `compaction` 键的 attempt 不进估算。
    - 旧 191：cause 为 `user-message`、`continue` 的 Run 的第一次请求是边界；带插话的续发、cause 为 `resume` 的 Run 的请求都不是；查前缀的模型夹具在回合中途越过阈值：不写 anchor，撞墙后以 `context-overflow{compactions: 0}` 结束，下一条消息先压缩再发，这次请求里 anchor 之前的思考块全部记 `drop / compacted`；不查前缀的模型回合中途压缩后，当前回合（含思考块）原样保留，到下一次边界请求时这些块才记 `drop / compacted`。
    - 旧 192：压缩后估算仍超阈值时，同一请求不再压第二次；回合中途压过一次之后，同一回合后面的工具往返没有可覆盖的内容，不再写 anchor；边界压缩之后，下一次请求的 messages 以摘要 user 消息开头，保留尾巴里没有思考块。
    - 旧 193：摘要请求的 attempt 带 `compaction` 键，按「重建 → 去掉 orderSeq ≥ keepFromEntryId → 追加 requestText」复算的 promptHash 等于记下的值（内存与 SQLite 两个 store 各一遍）；思考参数照六行表：Sonnet 5、Haiku 4.5 带 disabled；Opus 5 带 disabled 且 effort 取 `disableMaxEffort`；Opus 5.5、GLM-5.3 与没有 thinkingSpec 的行不传，不继承会话档位；历史里的思考块全部记 `drop / compacted`；写到一半点停止，不写 anchor、历史不变，以 `user-stopped` 结束；它的用量计入 `run_terminal.usage`、不计步数。
    - 旧 194：错误码与停止原因两条溢出路径各测一组；没有可覆盖的内容时不再压缩，直接以 `context-overflow` 结束。
    - 旧 36 ③：换到上下文更小的模型，估算值超过新模型的阈值时，先发摘要请求、写 anchor，再发这条用户消息。
    - 不变量 9：会查前缀的模型夹具在回合中途让估算越过阈值，断言不写 anchor、最后一条 assistant 的思考块仍在；不查前缀的夹具断言 `keepFromEntryId` 等于当前回合的起点，当前回合的思考块照常回传。不变量 8 的测试会话补一次摘要压缩。
    - 实测：有本机实例时，Ollama 4096 档超过 num_ctx 的实际行为；智谱 200K 溢出的返回形式用第 21 步的记录。
  - 暂定与待定：`checksThinkingPrefix` 在函数里按 modelId 列出（Opus 5.5、Fable 5.1）；摘要请求的前缀按默认做法（丢掉全部思考块、system 取冻结原文、不带 tools），最好在本步前拿到第 33 步那次带压缩的前缀测试，之后才出的走 Revisions；摘要请求重试用尽以 `provider-error` 结束、历史不变；待摘要部分本身超过新模型窗口时照发，溢出以 `compactions: 0` 结束；不画 anchor 分隔提示；压缩后 system 不重组。
- [ ] 31. **子 agent**（裁决 H5、F7、F2、F3、B3、D11、H11、F5、F11、H13、B1；第一个砍项）
  - 读：§子 agent 契约；§授权、工作区与外带检查的继承。
  - 交付物：Agent 工具、子会话与 `parent_link`、工具集收窄、沿用父 Run 的模型、授权与工作区现算继承、跨父子的外带检查、暂停与转发、排队消息只在父会话、`subagentElapsedMs` 与期限、交接与用量、停止 / 新消息 / 退出 / 重启的连带、`session.latest` 与 `approval.list` 映射回根会话、单工具回执行，Agent 在本步进产品工具表；`SUBAGENT_STEP_LIMIT`、`SUBAGENT_TOKEN_LIMIT` 在 Revisions 记下 owner 给的数之后才声明。
  - 验收：52、53；不变量 29、30；补齐 17、18、46 与 20 的子 agent 部分。
  - 测试要点：
    - 旧 195：派出子 agent 之后，子会话有自己的 `session/start` 与 Tape，同批写了 `session/profile_set`（profile 为 `cowork`，`subagentOf` 指向父会话与那条 parent_link 的键）；父会话里恰好一条 `session/parent_link`；子会话的工具表不含 Agent 与 AskUserQuestion，按名字和 specHash 是父会话同一 provider 冻结表的子集；子会话里没有 `session/workspace_set`，Glob 省略 path 时用父会话最新 `workspace_set` 的 folders[0]；`session.latest` 与 `approval.list` 只读 `subagentOf` 映射回根会话。
    - 旧 26：父会话先允许写 a（本会话），再允许抓域名 d，然后派出子 agent：子会话写 a、抓 d 都不出卡，判决记录带 `basis.inherited: true`；子会话里允许写 b 之后，父会话写 b 仍出卡；父会话移除 a 所在的文件夹之后，子会话再写 a 就出卡；子会话调 Agent 按 `tool-unavailable` 收口、不建会话；期限：给 `subagentElapsedMs` 一组 Run，其中含一段从暂停到答复的区间、一个由恢复补写的终态，结果只计各 Run 自己的起止区间。
    - 旧 196：父会话读过工作区文件、有过 WebSearch 结果，子 agent 去抓一个只出现在 Agent prompt 里、域名已允许的 URL，弹出 flagged 卡；子 agent 读过 .env、抓过网页，交接写回之后，父会话对已允许域名下的非豁免 URL 发起抓取，同样弹出 flagged 卡。
    - 旧 197：子 Run 以 `paused/approval` 结束，父 Run 以 `paused/subagent` 结束；待批表只有一行，属于子会话；卡片接在父会话那次 Agent 调用的工具行下面；横幅指向根会话；在转上来的卡上拒绝，或允许之后答复前的重判改成拒绝：子会话开新 Run，这个调用写 is_error，子 agent 接着做；父会话不写 `user-rejected`，也不开新的父 Run；交接的 calls 列出这个调用和它的来源。
    - 旧 19、旧 198：子 agent 等审批时退出再重启：打开父会话，卡片可答，父会话的 Agent 调用没有被补写收口；批准后子 agent 跑完，父会话开一个 cause 为 `resume` 的新 Run，Agent 调用的结果挂在原 `(runId, requestSeq, <i>)` 下并带 handoff；候选页（最新 20 个会话）全是子会话时，「最近一个会话」仍映射到根会话。
    - 旧 11（子 agent 部分）、旧 199：子 agent 等审批时点停止：子会话的卡片作废，同批其余调用记 not-run / stopped，交接为 `aborted`，`childEndReason` 为 null，父会话的 Agent 调用记 aborted，结果里说明停止前的改动还在；子 agent 在跑命令时点停止，子进程确认退出之后才写子会话的收口与父会话的交接；等审批时发新消息：交接附的调用清单与子会话 Tape 逐项一致，下一次请求依次是 Agent 的 tool_use、它的结果、排队消息、新消息（旧 21 的子 agent 那句）。
    - 旧 200：子 agent 在跑时发出的消息，不出现在子会话任何一条 `view/assembled` 引用的请求里，而是出现在父会话写下 Agent 结果之后的第一次请求里；子会话转上来的卡被允许，不会让它插入。
    - 旧 25、旧 201：子 agent 到步数上限：交接 outcome 为 `partial`、`childEndReason` 为 `step-limit`，发给父模型的正文带状态行与调用清单，子会话里没有 `message/continuation`；用固定 usage 的夹具：写下交接的父 Run 的 `run_terminal.usage` 等于它自己各 attempt 的行，加上子会话各 Run 的行（origin 为 `subagent`）；答复处理器写下的交接（停止、被新消息取代），用量不出现在任何 `run_terminal` 里；同一个子 agent 的用量不计入因它暂停的那个父 Run。
    - 旧 202：子 agent 执行调用时崩溃：重启后先恢复子会话、再恢复父会话；子会话在途的调用和父会话的 Agent 调用都记 uncertain，交接为 `uncertain`、带 finalReply 与 calls，没有调用被自动重跑；`subagentElapsedMs` 不计从暂停到答复的时段，也不计「写完问人判决、还没写 paused 终态」时崩溃到重启的时段；同一份 Tape 在重启前后算出的值相同。
    - 旧 230（SUBAGENT 部分）：两个常量只在 Revisions 记下 owner 给的数之后才声明，且 `SUBAGENT_STEP_LIMIT < STEP_LIMIT`。
    - 旧 24（子 agent）：子 agent 的工具表里没有 AskUserQuestion。
    - 子会话可续跑时点停止：子会话写不发请求的 Run 收掉同批剩下的，父会话的 Agent 调用记 aborted / `stopped`、交接 `aborted`，同批其余 not-run；之后没有在等的 Agent 调用，下一次 `send` 过配对检查。
    - 子会话在父会话暂停时握着自己的租约跑、点停止：子 Run 以 `user-stopped` 结束，不开父会话收交接的 Run，父会话的 Agent 调用记 aborted / `stopped`，fakeNetwork 不多调一次；改按 Cmd/Ctrl+Enter（runId 为这个子 Run）：父会话的 aborted Agent 结果与同批 not-run 之后，这条作为下一条发出。
    - 握着自己租约的子 Run 的 `run_terminal(completed)` 在 append 途中时点停止：`stopped: true`，不开父会话收交接的 Run，父会话的 Agent 调用记 aborted / `stopped`，交接 `childEndReason` 为 `completed`，fakeNetwork 不多调一次；停止改在交接生成（读子会话 Tape）途中到达，结果相同；子 Run 的 `run_terminal(paused)` 在 append 途中点停止：子会话写 `cancelled-by-stop`，父会话的 Agent 调用记 aborted / `stopped`，卡片消失，不开 Run。
    - 子会话可续跑时在根会话里发消息：先开子会话的续跑，这条留在父会话的队列，出现在父会话收交接的 Run 处理完同批后的第一次请求里，不出现在子会话的任何请求里；收交接的结果与父会话新 Run 的 `run_started`、`model_selected` 在同一次 append 里。
    - 子会话可续跑（含单调用批）：子会话的待批在启动时被收紧，`recover()` 把它列在根会话名下，父会话的 Agent 调用不补写、不生成交接；不打开再重启一次，Agent 调用仍按第 2 类保留；`approval.resume(root)` 开子会话的新 Run 处理同批剩下的，交接之后父会话续跑。
  - 暂定与待定：开放问题 19（owner 给数之前这一步不开工）；开放问题 18（到期收尾、其他结束原因的交接 outcome，定之前不做到期检查，其他原因占位 `partial`、不标 is_error、带 `childEndReason`，PR 里写明；子会话卡上「本会话」的措辞）；子会话用任务形态那份系统提示；先写子会话再写父会话之间崩溃，父会话的 Agent 调用暂一律记 `uncertain`（开放问题 25，最晚本步前定）；开放问题 11 的子 agent 读法已确认。
- [ ] 32. **砍法落定**（裁决 M1）
  - 读：本文件开头的砍法；spec §验收标准 开头的删条目对照；§文档同步「砍的时候再改」。
  - 交付物：owner 定下砍不砍、砍哪些。如果砍：spec 顶部 Revisions 记下砍掉的目标和验收；§13 阶段 2 加带日期注记，指向新的 features spec（砍压缩连带 :881 的 B 与 :900「压缩重试 ≤ 2」；砍子 agent 注明 :886 (2) 由哪份 spec 实现、写进 :948 Research 的前置）；建好那份 spec 的骨架。触发过 M5-B 降级的，确认 Revisions 已逐条记下。
  - 验收：无。
- [ ] 33. **Anthropic 官方 key 协议验收**（〔官方 key〕；裁决 M4、M2、E2、A13、A16、A7、H8、H15、F3、B4、A1、A5；不是砍项）
  - 读：§验收标准 第 54 条；§模型与密钥；§Anthropic 保证档的退路。
  - 交付物：跑完协议验收组，每条记录写日期、模型与请求主机（必须是 `api.anthropic.com`）；协议项在 Opus 5.5 上跑，搜索子请求在 Sonnet 5 或 Opus 5 上跑。前缀验收通过后，把 anthropic.ts 的第一行从 Sonnet 5 换成 Opus 5.5（A16 ownerNote），记进 Revisions。任何一项不通过就按对应卡的 tests 修到通过；出 400 时报错会点名第一个失效的块，照它查冻结纪律漏了哪一处。
  - 验收：54；补齐 6 的首行。
  - 测试要点：
    - 凭据：只用 Console 预付的 API key，经 `apiKey`（`x-api-key`）传入，只放进程环境或钥匙串；不用任何 Claude 订阅的 OAuth token，也不经 `authToken` 传它。
    - 判账号类型：拿一段带思考块的会话，故意改一处前缀，不带 beta 头发一次。返回 400、报错里提到 beta 头的是默认强制前缀检查的新账号，之后都不带头，通过标准是不出 400；返回 200 的是老账号（2026-08-31 之前创建），之后用老账号补头接缝带 `thinking-binding-controls-2026-08-01` 头并设 `thinking.block_binding.prefix_mismatch_behavior: "error"`，通过标准是不出 400 且 `input_transformations` 为空。下面各项都按这个标准判。
    - 旧 65：Opus 5.5 上一场会话，中途依次关一个工具；跨 Run 批准一次审批；切到智谱，在智谱段夹一次工具回合再切回来，让真实的智谱 tool call id 回放到 Anthropic 线；用压缩阈值接缝做一次摘要压缩。
    - 旧 66：跨重启续跑：出一张待批，退出应用，改一个内置工具的描述，在设置里换一个模型，重启并批准，续跑请求仍发往原模型。
    - 旧 67：同一会话依次用 Opus 5.5 → Fable 5.1 → Opus 5.5，每一段夹一次工具回合（Fable 5.1 要先开 30 天数据保留）；核对守卫规则 2 对同一目标模型每次丢同一批块、不撞前缀检查。
    - 旧 68：由思考字段推出的请求形状，在 Opus 5、Sonnet 5、Opus 5.5、Fable 5.1、Haiku 4.5 上各发一次；Opus 5.5 不传 thinking、不传 effort，发一次带工具的请求：思考文本为空、签名在，回传通过。
    - 旧 69：历史里有 tool_use / tool_result 时，在官方端点上换到一个手填 id 的模型，请求不带 tools；结论写回 spec §不带 tools 的请求与冻结后的变化，出 400 的话按那里的二选一修到通过（第 4 步没跑完的在这里补）。
    - 旧 70：顶层 `cache_control` 的缓存对照在 Opus 5.5 上做，前缀超过 512 token；同一前缀连发两次，一组带顶层 `cache_control`、一组不带，比较 `cache_read_input_tokens`，带的那组第二次应当命中，不带那组的结果也记下。
    - 旧 71：搜索子请求在 Sonnet 5 或 Opus 5 上跑，`tool_choice: any` 能强制它搜，`web_search_tool_result` 的 url 与 title 齐全；Anthropic 线上 Tenon 的 WebSearch 完成一次往返；第 21 步的冒烟子集在 Opus 5.5 或 Sonnet 5 上再跑一遍。
    - 旧 72：用这把 key 跑第 34 步的 Claude 模型列；把 01 plan.md:90「没能对照的」Anthropic 夹具对一遍，不符的按 amend 或修复处理。
    - 旧 234：记录格式如上。
    - 实测：`max_uses` 在这里定稿（暂定 1）；`max_tokens` 由 owner 按第 28 步的探测取值。
    - 实测：那次带压缩的前缀测试决定摘要请求的前缀做法（保留默认，或逐字沿用冻结的 system、tools 并加 `tool_choice: none`），以及 tool call id 要不要规整字符集。
    - 实测：中途改顶层 effort 时，tools 与 system 的缓存会不会失效（按模型记录）；Opus 5.5 以 omitted 长思考时抓原始 SSE，ping 间隔要远小于 180 秒，没有 ping 或接近 180 秒就放宽官方端点阈值（A5）。
    - 实测：A2 截断续写，Opus 5 上在 tool_use 中途截断，照「继续」的写法续写，会不会 400。
    - 可选：服务端调用块不回传会不会 400（会的话记下报错，按 A13 的编辑规则补处理，按 (b)）；Opus 5.5 的 fallback 块与流里的未知 delta（有的话按原样字段存，回传规则补测）；Fable 5.1 所在组织没开 30 天保留时的 400 原文，拿到就补进 `account-config` 的识别，拿不到只保留菜单说明；不需要 key 的一项：打包版从 Dock 启动时，shell 配置里设的 `ANTHROPIC_CUSTOM_HEADERS` 会不会进进程环境（抓一次出网请求头，结果只影响优先级）。
    - M5-A 的第二条改判：实测从别的模型换回 Opus 5.5 会撞上前缀检查、drop 也救不回来时，改成「换模型时提示开新会话」，走 Revisions。
  - 暂定与待定：开放问题 20。走退路时本组经 Revisions 改为「照文档手写的夹具通过」，验收记录列出「没能对照的」；有 key 之后逐项补跑：判账号类型；前缀检查（关一个工具、跨 Run 批准、换 provider 再换回、压缩、跨重启续跑、Opus 5.5 → Fable 5.1 → Opus 5.5）；五个模型的思考形状；换到不发工具的模型；顶层 `cache_control` 的缓存对照；搜索子请求、WebSearch 往返与冒烟子集；Claude 模型列的同题对比；01 plan.md:90 的夹具；A5 的 ping 间隔；可选的三项。补跑结果与 spec 不符的按 amend 或 supersede 处理。
- [ ] 34. **评测基线与同题对比**（裁决 H15、M4、M8、H9、H10、H11、F2、F5、E2；不在砍法里，砍定之后跑）
  - 读：§提示层与评测；§同题对比；§已知差异清单。
  - 交付物：评测集补到 20–30 题（含 F2、F5、E2、H9、H10、H11 的必含题），基线列全集 × 3；CI 加 `pnpm evals:gate`；同模型列（Claude Code + glm-5.3，先跑两道探路题）；Claude 评测轮与主对比（Claude Desktop 选同一模型，Max 订阅，录屏放仓库外；没有官方 key 走 M4 退路）；按基线数据校准下面的数值并记 Revisions；owner 补录在对比开跑前补齐，更新 docs/evals/README.md 的已知差异清单（第 1、8 条）。
  - 验收：55；补齐 40 的「评测里不出现 revertible、snapshotted」。
  - 测试要点：
    - 旧 8：必含题：中途关掉某个工具后继续干活（E2）；抓一个藏着外带指令的测试页（F5，假网络，外带那次弹出 flagged 卡、URL 完整显示）；先读文件、再按搜索结果抓 5 页、顺着页面链接再抓 2 页（F5，记下多弹了几张卡）；中文、英文的长输出各一题（H9）；以及 §评测集与测试宿主 必含题表里的其余各题。
    - 旧 9：与 Claude Desktop 的同题对比至少 10 题有记录，写明差异和原因；Tenon 一侧用 Claude 模型（Opus 5.5 或 Sonnet 5），和 Claude Desktop 选同一个模型，记录写明两边的模型；同模型列（Claude Code + glm-5.3 对 Tenon + glm-5.3）对同一批题另有记录，Claude Code 跑不通时改用 OpenCode 并注明。
    - 旧 228（门禁部分）：基线建成后 CI 跑 `pnpm evals:gate` 并通过：20–30 题，含全部必含题，`compare: true` 至少 10 题且两种形态都有，基线列上每题在当前 `PROMPT_LAYER_VERSION` 下有 3 条字段齐全的记录。
    - 旧 161（评测部分）：一次完整评测里没有任何请求或收口带 `revertible`、`snapshotted`。
    - 实测：同模型列先跑两道探路题（读写加命令；WebFetch 在 skipWebFetchPreflight 开、关下各一次）；工具循环跑不通就换 OpenCode，只是 WebFetch 不通就把 Claude Code 一侧的联网题记为 `excluded`。
    - 实测：第一轮评测之后用次日账单核对智谱的 `completion_tokens` 是否已含 `reasoning_tokens`，不含就给费用函数的智谱线加一项。
    - 校准（每项改了就记 Revisions）：`SPILL_THRESHOLD_CHARS` / `SPILL_PREVIEW_CHARS`，以及失败结果的预览要不要改成头加尾（中文、英文长输出两题，看模型靠「预览 + Read 分段」能不能找到关键行）；`COMPACT_ABS_CAP`（在 glm-5.3-flash 的 1M 窗口上跑长任务，按每次请求的输入 token 与费用）；`COMPACT_KEEP_TURNS`（只能在 1–2 之内取）；`RETRY_CAP`（按 attempt 事实里的重试次数与重试后的成败）；`INSPECTOR_TIMEOUT_MS` 的 local-rule（按外带检查实际耗时；model 等第一个调模型的 inspector）；`recentUserTexts` 条数与「碰过私有数据」的范围（看 F5 两道题，多弹的卡明显超过预期 2 张时收窄）；WebFetch 的跳数上限（按抓取题里的实际跳数）；冻结后被禁那句英文（看「中途关掉某个工具」题模型还会不会反复调用）；横幅 `limit`（按实际同时待答的会话数）；`SUBAGENT_STEP_LIMIT` / `SUBAGENT_TOKEN_LIMIT`（按每题工具轮数的最大值与用量；最大轮数接近 100 时提请 owner 复议主循环上限）；Anthropic 的 1 小时缓存档（按 H11 的用量数据；02 先只发 5 分钟档）。
    - 费用估算：完整横评 GLM 约 ¥170；Claude 约 ¥440（按加了缓存算，Sonnet 5 跑全集 × 3，Opus 5.5 只跑对比题 × 3）；同模型列约 ¥60–130，走智谱按量。
  - 暂定与待定：单次 Run 的 token 上限计量口径在本步前复核（暂按未命中缓存的输入加输出、含子 agent）；owner 补录（见 Open）在对比开跑前回来；T8 通过后同模型列改走 `/api/anthropic`，入口差异记进结果。

## 收尾（照 01 plan 的第 16–18 步）

- [ ] 35. **验收审计、清理，标 implemented 与交接**（裁决 M4、M8、M1）
  - 读：spec §验收标准、§不变量、§开放问题。
  - 交付物：验收审计：对照第 1–56 条与不变量 1–34 逐条验证，审计员分组、各用一个 worktree，读过测试、确认它断言的是验收原文，实际跑过，便宜处把生产代码改坏、看它变红；每条的结论与复跑命令记进验收记录，Anthropic 那一组写日期、模型与请求主机，写明「没能对照的」项、校准得出的数值、D8 的已知局限（硬链接、大小写不敏感卷）与 Windows 两项未验证。清理：临时探针与非持久的夹具；测试专用的 beta 头、`prefix_mismatch_behavior`、启动恢复延迟与调低压缩阈值这几个接缝只在 `!app.isPackaged` 加专用变量下生效、不在产品代码路径里（第 16 步定下的延迟接缝变量名在这里核对）；kernel 够不着 `node:http` 假服务器。然后 spec 顶部改 `Status: implemented`，写交接：保证档的待补项（如有）、砍下的部分去了哪份 spec、下一份要手动开工的 spec（自定义厂商那份 features spec，M6；可选的「Claude Code 引擎」features spec，M8）。
  - 验收：56。
  - 测试要点：
    - 旧 73：在干净 clone 上 `pnpm install && pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` 全部通过，照 01 验收 20；`pnpm lint` 已经包含 `i18n:check` 与 `tape:check`（package.json:9）。
    - 旧 74：§不变量 第 1–34 条每条至少有一个自动化测试，测试名带「02 不变量 N」，按编号 grep 核对；Tape 组末尾那条评审规则不要求测试。
    - 旧 84：仓库、Tape、日志、本文件的 live 记录与 docs/evals 里都没有任何 provider key 的值，记录只写变量名（如 `$ZHIPU_API_KEY`）。
    - 旧 85：apps/desktop/src、packages/kernel/src、packages/contracts/src 里 grep 不到 `.claude/`、`.credentials.json`、`Claude Code-credentials`、`.codex/auth.json`、`auth.openai.com`、`claude.ai/oauth`、`chatgpt.com/backend-api` 中的任何一个。
    - 旧 86：§开放问题 的每条都有结论（写回对应节并记 Revisions，或链到后续 spec），有期限的要么在期限前定下并记进 Revisions，要么代码与「定之前按」一致；标「不开工」的，决定进 Revisions 之前没有合并对应代码；owner 补录在同题对比开跑前补齐。

## 实施记录

（尚无）

## 验收记录

（第 35 步填写）

## 清理记录

（第 35 步填写）

## 起草记录（2026-09-25）

- 循环接口（开放问题 1、2）由三个候选方案经评审选定，并发规则经六轮评审与两个可执行模型核查（[models/](models/README.md)），逐轮问题数 53、57、45、26、19、2。
- 首版草稿依据 owner 同日拍板的 82 条开工前裁决、四份底表、参考实现笔记与当天的智谱实测（探针与中间产物不入库）；同日按 owner 要求瘦身：spec 4603 → 约 3220 行，验收 239 → 56 条，开放问题约 150 → 24 条，plan 44 → 35 步。
- 验收的新旧对照：新验收在各步「验收」一行，被它吸收的旧编号逐条标在同一步的「旧 N」里（新 1 ← 旧 87、89–91；2 ← 77–83；3 ← 44、232；4 ← 75、76；5 ← 92、94、95；6 ← 45、46、88、98–100；7 ← 42、43、101、112；8 ← 48、102–104、231；9 ← 47、105、106；10 ← 49、109；11 ← 58–61、110、111、113；12 ← 114–118、123；13 ← 236–238；14 ← 1、122、178；15 ← 12、30、128、129；16 ← 29、130；17 ← 3、27、28、127、131；18 ← 119–121、168、171；19 ← 4、97、169、170；20 ← 10、20、21、173、174；21 ← 15、16、34、172；22 ← 22、132；23 ← 17、134、135；24 ← 18、138；25 ← 139–141、147；26 ← 32、35、148–151；27 ← 24、50、55、144–146；28 ← 5、93、152–156；29 ← 53、157–159、179；30 ← 51、160；31 ← 124、125、162、163；32 ← 180–183；33 ← 33、37、107、186、187；34 ← 38、39、184、185；35 ← 36、40、41、108、235；36 ← 214–218；37 ← 6、219–223；38 ← 224–226；39 ← 62–64、233；40 ← 52、96、161；41 ← 7、142、143、177、230；42 ← 13、14、136、137；43 ← 57、188、189；44 ← 23、126；45 ← 227–229；46 ← 11、24、133、175、176；47 ← 56、208–211；48 ← 203–207、239；49 ← 212、213；50 ← 54、164–167；51 ← 2、31、190–194；52 ← 19、25、26、195–198；53 ← 11、199–202、230；54 ← 65–72、234；55 ← 8、9；56 ← 73、74、84–86）。
- 开放问题的去向：须 ready 前定或须 owner 定的 24 条留在 spec §开放问题（ready 前第 1、2 条即旧第 148、83 条，2026-09-25 已定）；「待校准的数值」「要实测的」改成本 plan 各步的测试要点与暂定项，引用旧号的在条目里注明（如旧开放问题 34、48、49、94、95、97、124、145）；其余写成所在节的暂定规则，或并进 §开放问题「留到后续阶段」。瘦身前的旧稿只留在起草会话，不入库。

## 交接

尚未开工。2026-09-25 spec §开放问题 第 1–11 条与第 26 条全部定下，owner 把 spec 改为 ready；从第 1 步开工，开工前先读 §开放问题 里「最晚」落在第 0 步和第 5 步的条目。

## Open

只列 owner 在仓库外要做的事：

- 核对 S1、T10 的次日账单：`search_pro_quark` 是否按每次 ¥0.05 扣，`/paas/v4/reader` 怎么计费（第 2 步；spec 开放问题 8、22）。
- Anthropic 官方 key：起草时（2026-09-25）owner 已同意开，还没到手；在所在地区能不能开、怎么付款未核实；在 Console 预付少量 credits（预付本身就是花费上限，第 4 步）。最晚在第 28 步之前确认，开不了按 spec §Anthropic 保证档的退路 走 Revisions（开放问题 20）。
- 给数：`SUBAGENT_STEP_LIMIT`、`SUBAGENT_TOKEN_LIMIT`（步数须小于 100），第 31 步开工前（开放问题 19）。
- owner 补录：B1 #2（审批卡挂着时点停止，Cowork 作废还是保留卡片），最晚第 15 步前（开放问题 14）；F11 与 H13 #1（审批卡挂着时发新消息）；D7 三项（手动档下跑 `ls` 会不会先弹卡、新账号的初始审批档、覆盖已连接文件夹里的已有文件是否也不逐次问）；F6 #5（多张审批卡是否来自同一批、能否跳着答、拒绝一张后其余怎样）；F7 #3（子 agent 的审批卡出现在哪、会不会超时）；B3（停在任务页直接 Cmd+Q 再启动，落在首页还是该任务；落在任务页就按 B3-A 的改判重比 A 和 D）；H1 自查（自己的 Claude 消息框里还有没有 Chat / Cowork 选项）；Cowork 覆盖已有文件、跑 shell 命令时弹不弹卡。除 B1 #2 外都在同题对比开跑前补齐（第 34 步），补录后更新 docs/evals/README.md 已知差异清单的第 1 条和第 8 条。
- owner 的 key 下次撞到智谱额度上限时，抓 1308、1310 报文的原文，供补 `resetAt` 的解析（第 7 步）。
- M8 landing：在 ChatGPT 的 Data Controls 里关掉训练；主账号先不订 GLM Coding Plan；需要时买智谱资源包，并在账单上核对 flash 的实际单价与资源包的扣减方式。
