# 01 · Provider 抽象 + 会话存储 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。每一步结束时仓库都是绿的。

- [x] 1. amend 机制：owner 于 2026-09-17 确认，四处文字已落地（AGENTS.md「How we work」、`docs/spec-driven-dev.md`「改变决定」、`00-foundation/spec.md` 的 `Amended by:` 行、主参考 §13 阶段 2 / 阶段 4 两处措辞）。开工前核对这四处仍在即可，不要重复落地
- [x] 2. `HostAdapter.network`：`FetchLike`、`HostNetwork`、`HostNetworkDeniedError` 进 `packages/kernel/src/host/adapter.ts`；desktop 实现；内存版 host 默认抛错；`.oxlintrc.json` 改 `fetch` 提示语并加 `WebSocket` / `EventSource` / `XMLHttpRequest` / `process` / `crypto` 与 import 禁用清单；`packages/kernel/src/testing/` 与 `package.json` 的 `./testing` 子路径、`fakeNetwork`（不用定时器）；`ids: { uuid() }` 的构造参数约定与测试用确定性实现；esbuild `--platform=browser` 打包测试（验收 8）
- [x] 3. kernel Tape 纯内核：`canonicalJson`、`@noble/hashes` + `hashEntry` 固定向量（含长度前缀防撞向量）、entry 类型、`provenance` 语法与校验器、保留命名空间表 + 双向断言 + slice 写入器（验收 12 的向量部分、13）
- [ ] 4. `TapeStore` 端口 + 内存 store + 共享 conformance 套（导出为接收 store 工厂的函数）：有界读取、`atEntryId` 钉住、`readBySource`、幂等与 `TapeProvenanceConflictError`（含批内重复键）、高水位分配、随批传入的 `incarnationId` 与 `TapeStaleIncarnationError`、reset / delete（验收 10、11、15 的内存部分）
- [ ] 5. 投影 reducer `project()`（含 `insertOnly`）、折叠规则 `effectiveMessages()`、带 `atEntryId` 的 `rebuildProviderContext()`；内存 store 在 append 内应用 op（验收 3 的投影一半）
- [x] 6. 两份 DDL 与方言映射表、`scripts/check-tape-schema.mjs` 挂进 `pnpm lint`（验收 17）。此时还没有代码加载它们
- [ ] 7. desktop SQLite store：钉 `better-sqlite3@13.0.3` 并追加进 `ignoredBuiltDependencies`；连接 PRAGMA；`schema_version` 迁移；`BEGIN IMMEDIATE` + 每个方法自己 `ROLLBACK`；spec 规定的 append 语句顺序；`safeIntegers` 经统一的 prepare 辅助；`Buffer → Uint8Array`；`undefined → null`；`tape_meta` 租户校验；`<profileDir>/sessions.db`。原样跑第 4 步的 conformance 套，加验收 4、9、10（双连接交错与强制锁）、12（1 万条 + 对拍）、14、15（2^53）、18
- [x] 8. kernel provider 内核：类型、`BaseProvider`、`ProviderRegistry`、事件联合、块累加器、终态事件包装、`decideThinking`（验收 16）
- [ ] 9. 两个线协议适配器的 `encode()`（纯函数，产出 `promptHash` / `toolDefinitionsHash` / `thinkingDecisions`）（验收 2）
- [ ] 10. `@anthropic-ai/sdk@0.126.0` 移入 kernel、新增 `openai@7.17.0`，都钉精确版本；Anthropic 适配器的 `stream()`：`maxRetries: 0`、凭据显式、`{ signal }`、try/catch 错误映射、`usage` 先于终态且只落 `final` 的那条、`retryAfterMs` 取自 `err.headers`；录制的 SSE 夹具（验收 7）。SDK 进 kernel 之后重跑第 2 步的打包测试
- [ ] 11. OpenAI 兼容适配器的 `stream()`（按 `index` 归位、`reasoning_content ?? reasoning`、`include_usage`、`requestParams` 透传）+ `anthropic` / `zhipu` / `ollama` 三个定义（`ollama` 带默认的 `apiKey`）。`ModelInfo` 按厂商当时的文档填，未能确认的字段记到本文件的 Open（验收 1）
- [ ] 12. kernel session service：建 / 重置 / 删会话，`runId`（canonical UUID）与 `requestSeq` / `physicalAttempt`，`session/start`、`message/*`、`session/model_selected`、`provider/attempt_completed`（含 `contextAtEntryId`）的写入；重试复用 `messageId` 的规则、失败轮次不写 assistant 消息；只写事实，不做循环（验收 3 的重放一半）
- [ ] 13. 重接 `apps/desktop/src/main/chat.ts`：删内存 `history` 与直接构造的 SDK；保留阶段 0 注释里写明的行为（先登记后 await、停止保留部分文本、失败轮次留存、同文本重发 = 重试、先释放再发终态）；`session.latest` / `session.messages` 与渲染端启动恢复（验收 5；阶段 0 验收 4 不回退）
- [ ] 14. `provider.list` / `provider.configure` / `provider.select`、`config.json` 的 `provider` 字段、由 `ConfigKey[]` 渲染的最小设置卡（两份 locale 目录加键）、`TENON_SECRETS=memory` 的 e2e 机密接缝、locale 键存在性单测、开发期环境变量回落（`TENON_MODEL` 未命中内置表时合成保守 `ModelInfo`、`TENON_MAX_TOKENS` 保留）与 `TENON_PROVIDER`、`pnpm test:live` 的 zhipu 用例（验收 6、21）
- [x] 15. `packages/contracts/src/bridge/frame.ts`：信封、五种协议帧、版本协商、未知帧路径（验收 19）
- [ ] 16. 对照 spec 全部验收标准逐条验证，把每条的结果与命令记在本文件；记下 5000 条分页与 1 万条校验链的耗时
- [ ] 17. 清理临时探针与非持久的夹具；确认 `packages/kernel/src` 够不着任何 `node:http` 假服务器
- [ ] 18. spec 顶部改 `Status: implemented`，写交接

进度吃紧时的砍法，按这个顺序：先砍第 15 步（桥骨架），再砍第 14 步里的设置卡（IPC 与 `config.json` 字段保留，界面并入阶段 3 的设置工作）。**第 3–7 步不能砍**——它们是以后补不了的那部分。

## 实施记录

- **第 2 步**（2026-09-21，`e1c9f9e`）：`HostAdapter.network` 为第八个成员；desktop 实现一行；内存 host 默认 reject、可注入。lint 闸除 spec 列的裸全局外，还用 `no-restricted-properties` 拦住了 `globalThis.fetch` / `.process` / `.crypto` 这类绕法（spec「不许 `globalThis.fetch ?? network.fetch` 式回落」的本意）。验收 8 的 lint 一半手工验证：在 `packages/kernel/src` 放一个探针文件，`pnpm lint` 报 22 个错并逐条点名规则（`no-restricted-imports` / `no-restricted-globals` / `import(no-nodejs-modules)`），探针已删；打包一半是持久测试 `packages/kernel/test/host-independence.test.ts`（esbuild `platform: 'browser'`，两个入口零错误，并断言 `package.json` 不依赖 `better-sqlite3` / `electron`）。oxlint 的实测事实：后一个 override 的 `no-restricted-imports` 会**整条替换**前一个，所以清单在 kernel/src 命中的每个 override 里都重复了一份。
- `@tenon-app/kernel/testing`：`fakeNetwork(script)` + `createStreamGate()`（`release(n)` / `end()` / `fail()`，无定时器）+ `createCounterIds()`。「慢流」只做了调用方推进这一种，`HostClock` 驱动的变体没做（spec 写的是二选一，验收 7 要的是前者）。**给第 8–12 步的提醒**：两家 SDK 在终止帧（`message_stop` / `data: [DONE]`）之后还会继续读 body，带闸的 happy path 测试必须调 `gate.end()`，否则挂到 vitest 超时。`HostNetworkDeniedError` 照 spec 写成裸的 `extends Error {}`，`name` 仍是 `'Error'`，第 10 步的错误映射要用 `instanceof`。
- **第 6 步**（2026-09-21，`11aa018`）：两份方言文件 + `scripts/check-tape-schema.mjs`（`pnpm tape:check`，已串进 `pnpm lint`）。验收 17 手工验证过单边改列 / 改索引 / 改键 / 削弱触发器都让 lint 失败并点名对象，另有持久测试 `scripts/check-tape-schema.test.mjs`（根 vitest 增加了 `scripts` 项目）。解析到零张表 / 零个索引时检查器直接失败，不会空转变绿；不认识的语句形式报错而不是跳过——第 7 步以后谁加 `VARCHAR(n)` 或 `CREATE VIEW`，要同时扩解析器与方言映射表。SQLite 文件用系统 `sqlite3` 3.51.0 实跑过四种触发器情形（裸 UPDATE 中止、未开闸 DELETE 中止、为 s1 开的闸删不了 s2、对闸成功）。**Postgres 文件没有被执行过**（本机无 server），可移植性证明是静态的，与 spec 一致。
- **第 15 步**（2026-09-21，`ad925ba`）：`frame.ts` 全是纯函数；`negotiateVersion` / `checkTenantAssertion` 返回的是 error **body** 而不是帧（contracts 铸不了 `id` / `ts`，由调用方包信封）。比 spec 多收紧了两处：`hello` 要求 `vMin <= vMax`；推导出的租户为空串时即使断言相等也是 `unauthorized`。
- **第 3 步**（2026-09-21，`bffa64d`）：`packages/kernel/src/tape/` 五个文件，无 store、无 I/O。`@noble/hashes@2.4.0` 精确钉版；哈希固定向量的期望值由一份手工拼原像的 `node:crypto` 脚本独立推导（脚本不入库，只入十六进制），含 `'ab'+'c'` 对 `'a'+'bc'` 的防撞对、null 对空串。spec 没写、取了最严读法并有测试钉住的几处（都是放宽容易、收紧难）：`canonicalJson` 只收纯对象 / 数组 / 字符串 / 有限数 / 布尔 / null，键按 UTF-16 码元序，拒绝带 `toJSON` 的值、getter、稀疏数组、类实例，嵌套上限 100；provenance 键总长 ≤ 256、身份段只许小写 `[a-z0-9._-]`、`ext:` 键必须带 owner 段；Tape name 2–8 段、每段 `[a-z][a-z0-9_]*`、总长 ≤ 128；声明表除了绑 kind，还绑了 spec 事实表里的身份三元组（比不变量 14 要求的严）。`ForkOrigin.entryHash` 是小写十六进制串而不是 `Uint8Array`——payload 要过 `canonicalJson`，它不收 typed array。payload 类型都是 type alias（隐式索引签名才能赋给 `NewEntry.payload`），改成 interface 会让第 4 / 12 步编译不过。`hashEntry` 对不认识的 `hash_ver` 抛 `TapeHashRecipeError`，校验方要先用 `isKnownHashVer` 过滤。顺手结掉了第 15 步留下的那条：`packages/contracts/test/frame-tape-syntax.test.ts` 钉住桥帧 type 与 Tape name 的段语法一致。
- **给第 4 步**：store 要同时调 `assertProvenanceKey` 与 `assertAppendAuthorized`（纯 slice 写入器不校验 provenance 键——`names.ts` 反向 import `provenance.ts` 会成环）；目前没有任何东西核对「键的 namespace 与写它的 slice 一致」。**给第 5 步**：把 `MessagePayload<TContent>` 绑到 `ContentBlock[]`，并按已导出的 `DeclaredTapeNameId` 加一张 name → payload 的类型表，`project()` 才不用 cast。
- **第 8 步**（2026-09-21，`8d50d9e` + `aaf711d`）：`provider/` 五个文件（块累加器与终态包装按 spec 的文件清单放在 `base.ts`）。`types.ts` 与 spec 两个代码块逐项一致。终态包装 `withTerminalEvent` 接的是**工厂**而不是 iterable（signal 已中止时根本不创建源，不变量 2），`signal` 是必填的可空字段（适配器忘传就编译不过），中止用竞速而不是只在两个事件之间轮询（卡住的流也停得下来）。spec 没定、此处取定的几处：源没给终态就结束 → `error{ code: 'network', retryable: true }`；`isRetryableByDefault`：`egress-denied` / `auth` / `invalid-request` / `context-overflow` / `unknown` 不可重试，其余可重试；`retryAfterMs` 夹在 `[0, 2^31-1]`；守卫规则 4 里 redacted 块在无 tools 时判 `redacted-unsupported` 而不是 `no-tools`；`ThinkingTarget = { model, hasTools }`。
- **给第 9–12 步**：thinking 块的 `providerModel` 打的是 `thinkingModelId(model)`（= `canonicalId ?? id`），守卫规则 2 比的也是它——`EncodedRequest.modelId` 仍是线上 id，任何别处给 thinking 块打标都必须走 `thinkingModelId()`。`withTerminalEvent` 不转发源终态之后的任何事件，所以 OpenAI 适配器**必须**把 `stop` 压到迭代器结束才发，否则尾块里的 usage 丢失。`applyThinkingDecision` 可能产出空文本块，`encode()` 要跳过（两种线协议都拒收）。`ModelInfo` 凡 `thinkingPreservationFormat: 'reasoning-content'` 必须声明 `reasoningEchoField`，否则抛。`BaseProvider.complete()` 拒绝 `providerId` 不是自己的 `ModelInfo`——第 14 步合成保守 `ModelInfo` 时要填对。payload 里不能出现值为 `undefined` 的键（`canonicalJson` 会在 append 事务里抛）。
- 流程：轮 2 的两个修复 agent 首次都死于 API 断线（ECONNRESET），留下半成品；续跑时让第二个修复 agent 把现场当不可信草稿逐条核对后才收尾。续跑那次第 8 步的 downstream 复核又断线，其首轮提出的四条 major 由编排方对着代码逐条核过：三条已落实，第四条（时钟）见 Open。

- 流程：harness 自建的 worktree 是从 `main` 拉的而不是当前分支，三个 agent 各自 `--ff-only` 到了 `cc1075f` 才开工；后续并行轨道的 worktree 由编排方自己 `git worktree add` 建。`.claude/worktrees/` 已进 `.gitignore`（嵌套检出会被主检出的 oxlint 扫到）。

## 起草记录（2026-09-17）

- spec 由 Claude Code 按 owner 的「你来做」起草；owner 于 2026-09-18 认可并指示改为 `Status: ready`、合并后开工。
- 草稿经过一轮五个角度的对抗审查（各配一名反驳者）：64 条里 45 条成立并已修进 spec，4 条高危分别是 incarnation id 无处传入、OpenAI SDK 的凭据规则、`Usage` 未定义且 Anthropic 一个流发两条 usage、amend 状态过期。随后一轮执行复核（照修订后的文本实现 store 并逐条跑不变量，外加修复落地核对）确认 45 条全部落地，又找到 11 条并已修：对不存在的 session 做 `resetSession` 会凭空建会话、`runId` 进了 `message/user` 的 payload 会让重试变冲突、原验收 9 测不出 store 有没有回滚、`promptHash` 缺请求参数快照无法复核，等等。
- 依据：三项实测（SQLite 绑定、两家 SDK 的 fetch 注入与流形状、DeepChat Tape 补读），各经一轮独立的对抗复核；三套独立设计（最小不后悔 / 服务端与审计优先 / 循环与恢复优先）加两名评审逐条裁决，评审实际执行了各方案的 DDL 与分配语句。探针与中间产物不入库。
- R8 已在起草同一个 PR 里完成：`docs/reference/deepchat-mechanisms.md` §二之补。

## Open

- **待 owner 裁决 · provider 拿不到时钟**：spec 要求 `retryAfterMs` 的 HTTP-date 分支「减 `HostClock.now()`」，但 `ProviderDefinition.create({ network, config, secrets })` 里没有时钟，kernel 又禁用 `Date.now()`。第 10 步先按只增的读法做：`create()` 的参数加一项 `clock: Pick<HostClock, 'now'>`。这是对 spec 接口的一处就地修订，需要 owner 在 spec 的 `Revisions:` 记一笔（或给出别的入口）。
- **待 owner 裁决 · 守卫的两处读法**：规则 2 比较的是 `canonicalId ?? id`（spec 说「定价与 thinking 规则按 canonicalId 算」，但没说身份比较也按它；现读法下，同一上游模型换转售渠道不算换模型）；规则 6 把只含空白的签名也当「签名为空」。
- **spec 缺口 · `verifyChain` 没有「本构建验不了」这个状态**：结果形状是定死的 `{ incarnationId, checked, firstBadEntryId, nextFromEntryId }`，而 `hash_ver` 不认识的行既不算好也不算被篡改。第 4 / 7 步先取保守读法：把它报成 `firstBadEntryId`。
- **spec 缺口 · DDL 对 `kind` / `source_type` 没有 CHECK**：封闭词表目前只靠 kernel 的闸守着，绕过门面直接写库的 store 拦不住。要加就得先改 spec 的 DDL 代码块（检查器会拿它比对）。
- **待 owner 裁决 · 重放与 thinking 守卫**：spec 写 `rebuildProviderContext(…, target)` 的「`target` 交给 thinking 守卫」，但守卫规则 4 要知道「本次请求是否带 tools」，重放拿不到；且重放若先丢块，`encode()` 记进 `provider/attempt_completed` 的 `thinkingDecisions` 审计就不完整。第 5 步先取可逆的读法：重放原样透传、守卫只在 `encode()` 里跑（两种读法下 `promptHash` 相同，以后改不动数据）。
- **待 owner 确认 · 检查器多读了一个输入**：`check-tape-schema.mjs` 除两份方言文件外，还把 SQLite 文件与 spec 里的 ```sql 代码块逐条比对（复核时发现两份文件可以一起偏离 spec 而检查器仍绿）。spec 原文只说「解析两份文件」。代价：以后哪份 spec 用新 DDL supersede 本 spec 时，要同时改脚本里的 `SPEC_FILE`。
- 验收 8 的措辞只列了裸形式；闸现在也拦 `globalThis.x` 形式。spec 要不要补一句，由 owner 定。
- 给 6b 的桥帧遗留：帧 `type` 的字符集暂定 `[a-z][a-z0-9_]*`、允许两段及以上（为了与 Tape 的 `ext/<owner>/…` 一致——spec 只写了 `<namespace>/<name>`）；信封 `id` 没有长度上限（属于传输层的帧大小决定）；zod 默认 strip 掉未知键，`hello` / `welcome` / `error` 上的增量字段不会被转发。规则 4 的段语法一致性已由第 3 步的跨包测试钉住；「业务帧的第一方前缀保留」要等 6b 有了第一个业务帧才有东西可拦。
- spec「选型」一节可补一条事实：当前依赖集下 `--platform=neutral` 先败在 `@modelcontextprotocol/client → pkce-challenge` 的解析上，还轮不到 Anthropic SDK 的 `node:` 模块；`--platform=browser` 干净。
- 开放问题见 spec 末尾（`x-stainless-*` 头、GLM 的 `reasoning_content` 回传、三平台 fsync 基准、主线程同步 SQLite 的搬迁阈值）。
- Ollama 的流式工具调用只从源码与已合并的 PR 核实过，没有对运行中的实例实测；`num_ctx` 默认 4096 会静默截断大 system prompt 的说法同样未实测。第 11 步接入时各探一次。
- 智谱的模型 id 以接入当天 `docs.bigmodel.cn` 为准，不以研究报告为准。
