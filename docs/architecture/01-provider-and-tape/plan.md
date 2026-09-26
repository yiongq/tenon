# 01 · Provider 抽象 + 会话存储 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。每一步结束时仓库都是绿的。

- [x] 1. amend 机制：owner 于 2026-09-17 确认，四处文字已落地（AGENTS.md「How we work」、`docs/spec-driven-dev.md`「改变决定」、`00-foundation/spec.md` 的 `Amended by:` 行、主参考 §13 阶段 2 / 阶段 4 两处措辞）。开工前核对这四处仍在即可，不要重复落地
- [x] 2. `HostAdapter.network`：`FetchLike`、`HostNetwork`、`HostNetworkDeniedError` 进 `packages/kernel/src/host/adapter.ts`；desktop 实现；内存版 host 默认抛错；`.oxlintrc.json` 改 `fetch` 提示语并加 `WebSocket` / `EventSource` / `XMLHttpRequest` / `process` / `crypto` 与 import 禁用清单；`packages/kernel/src/testing/` 与 `package.json` 的 `./testing` 子路径、`fakeNetwork`（不用定时器）；`ids: { uuid() }` 的构造参数约定与测试用确定性实现；esbuild `--platform=browser` 打包测试（验收 8）
- [x] 3. kernel Tape 纯内核：`canonicalJson`、`@noble/hashes` + `hashEntry` 固定向量（含长度前缀防撞向量）、entry 类型、`provenance` 语法与校验器、保留命名空间表 + 双向断言 + slice 写入器（验收 12 的向量部分、13）
- [x] 4. `TapeStore` 端口 + 内存 store + 共享 conformance 套（导出为接收 store 工厂的函数）：有界读取、`atEntryId` 钉住、`readBySource`、幂等与 `TapeProvenanceConflictError`（含批内重复键）、高水位分配、随批传入的 `incarnationId` 与 `TapeStaleIncarnationError`、reset / delete（验收 10、11、15 的内存部分）
- [x] 5. 投影 reducer `project()`（含 `insertOnly`）、折叠规则 `effectiveMessages()`、带 `atEntryId` 的 `rebuildProviderContext()`；内存 store 在 append 内应用 op（验收 3 的投影一半）
- [x] 6. 两份 DDL 与方言映射表、`scripts/check-tape-schema.mjs` 挂进 `pnpm lint`（验收 17）。此时还没有代码加载它们
- [x] 7. desktop SQLite store：钉 `better-sqlite3@13.0.3` 并追加进 `ignoredBuiltDependencies`；连接 PRAGMA；`schema_version` 迁移；`BEGIN IMMEDIATE` + 每个方法自己 `ROLLBACK`；spec 规定的 append 语句顺序；`safeIntegers` 经统一的 prepare 辅助；`Buffer → Uint8Array`；`undefined → null`；`tape_meta` 租户校验；`<profileDir>/sessions.db`。原样跑第 4 步的 conformance 套，加验收 4、9、10（双连接交错与强制锁）、12（1 万条 + 对拍）、14、15（2^53）、18
- [x] 8. kernel provider 内核：类型、`BaseProvider`、`ProviderRegistry`、事件联合、块累加器、终态事件包装、`decideThinking`（验收 16）
- [x] 9. 两个线协议适配器的 `encode()`（纯函数，产出 `promptHash` / `toolDefinitionsHash` / `thinkingDecisions`）（验收 2）
- [x] 10. `@anthropic-ai/sdk@0.126.0` 移入 kernel、新增 `openai@7.17.0`，都钉精确版本；Anthropic 适配器的 `stream()`：`maxRetries: 0`、凭据显式、`{ signal }`、try/catch 错误映射、`usage` 先于终态且只落 `final` 的那条、`retryAfterMs` 取自 `err.headers`；录制的 SSE 夹具（验收 7）。SDK 进 kernel 之后重跑第 2 步的打包测试
- [x] 11. OpenAI 兼容适配器的 `stream()`（按 `index` 归位、`reasoning_content ?? reasoning`、`include_usage`、`requestParams` 透传）+ `anthropic` / `zhipu` / `ollama` 三个定义（`ollama` 带默认的 `apiKey`）。`ModelInfo` 按厂商当时的文档填，未能确认的字段记到本文件的 Open（验收 1）
- [x] 12. kernel session service：建 / 重置 / 删会话，`runId`（canonical UUID）与 `requestSeq` / `physicalAttempt`，`session/start`、`message/*`、`session/model_selected`、`provider/attempt_completed`（含 `contextAtEntryId`）的写入；重试复用 `messageId` 的规则、失败轮次不写 assistant 消息；只写事实，不做循环（验收 3 的重放一半）
- [x] 13. 重接 `apps/desktop/src/main/chat.ts`：删内存 `history` 与直接构造的 SDK；保留阶段 0 注释里写明的行为（先登记后 await、停止保留部分文本、失败轮次留存、同文本重发 = 重试、先释放再发终态）；`session.latest` / `session.messages` 与渲染端启动恢复（验收 5；阶段 0 验收 4 不回退）
- [x] 14. `provider.list` / `provider.configure` / `provider.select`、`config.json` 的 `provider` 字段、由 `ConfigKey[]` 渲染的最小设置卡（两份 locale 目录加键）、`TENON_SECRETS=memory` 的 e2e 机密接缝、locale 键存在性单测、开发期环境变量回落（`TENON_MODEL` 未命中内置表时合成保守 `ModelInfo`、`TENON_MAX_TOKENS` 保留）与 `TENON_PROVIDER`、`pnpm test:live` 的 zhipu 用例（验收 6、21）
- [x] 15. `packages/contracts/src/bridge/frame.ts`：信封、五种协议帧、版本协商、未知帧路径（验收 19）
- [x] 16. 对照 spec 全部验收标准逐条验证，把每条的结果与命令记在本文件；记下 5000 条分页与 1 万条校验链的耗时
- [x] 17. 清理临时探针与非持久的夹具；确认 `packages/kernel/src` 够不着任何 `node:http` 假服务器
- [x] 18. spec 顶部改 `Status: implemented`，写交接

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
- **第 4、5 步**（2026-09-21，`ec73b9d`，合成一个单元做：内存 store 要在 append 里应用 reducer 才算完整）：`store.ts`（端口与 spec 代码块逐项一致）、`projection.ts`、`replay.ts`、`memory-store.ts`、`tape.ts`，以及 `@tenon-app/kernel/testing` 里**不依赖任何测试框架**的 conformance 套 `tapeConformanceCases(factory)`（`./testing` 入口要过浏览器打包测试，不能 import vitest；vitest 文件只是把用例映射到 `it()`）。现有 24 个用例，覆盖验收 10、11、13 的 store 侧、15 的端口一半、不变量 13、验收 3 的投影一半、批原子性。复核对它做过变异测试：逐条破坏 store 规则，确认至少有一个用例变红。内存 store 是写时复制事务；事实按 `canonicalJson` 文本存、读时解析，与 SQLite 同形。spec 没写、已被共享套钉住的读法（SQLite store 必须一致）：`limit < 1` / 非整数也拒；空的 `kinds` 数组拒；未知 session 的读取返回空而不是抛（另一个租户的 session 必须看起来和不存在一样）；`nextFromEntryId` 只在页满时非空；`rebuildProjections` 对没有 head 行的 session 抛 `TapeSessionNotFoundError`；`resetSession` 拒绝非 `session/start` 的 start、拒绝复用**当前**的 incarnationId（否则两代哈希不可分）；`session_head` 的时间取自事实自己的 `createdAt`（store 没有时钟）。`MessageRow` 过端口的字段叫 `content`（已解码），`ProjectionOp` 里仍是 `contentJson`。门面多了一个 spec 没点名的入口 `Tape.appendEntries`：第 12 步要把 `message/assistant` 与 `provider/attempt_completed`（分属两个 slice）写进同一个事务。
- **给第 9 / 12 步**：重放只做折叠，**不重排也不过滤**——它可能产出相邻的同角色轮次（失败轮次不写 assistant 消息，换了文本重发就是新的 `messageId`）、以 assistant 开头的上下文（第一条 user 消息被撤回）、文本为空的块。线上形状归 `encode()` 管，否则 `provider/attempt_completed` 记下的审计就和实际发出的不是一回事。验收 3 的 `promptHash` 一半要等 `encode()`，在第 12 步接上，conformance 套的文件头写明了这一点。
- **第 7 步**（2026-09-21，`7111da1`）：`apps/desktop/src/main/tape/sqlite-store.ts`，尚未接进应用（第 13 步）。`better-sqlite3@13.0.3` 精确钉版并进了 `ignoredBuiltDependencies`，两处都免编译加载且是同一个引擎：vitest 的 Node 22.22.0（ABI 127）与 `ELECTRON_RUN_AS_NODE=1` 的 Electron 44.4.1（ABI 149）都报 SQLite 3.53.4。conformance 套**原样**通过。验收 4 的可证伪条款：对全部 21 处 `tenant_id = ?` 谓词加 `tape_meta` 比较做了脚本化变异扫描，22/22 都让测试变红（修复前有 9 处删掉后仍绿）。验收 9、10（显式编排的双连接交错；`TapeBusyError` 用强制持有的写锁 + 可配置的短 `busyTimeoutMs` 单独测）、12、14（`EXPLAIN QUERY PLAN` 含 `tape_entry_by_source`、不含 `TEMP B-TREE`）、15、18 均为持久测试。**耗时**（macOS arm64）：5000 条分页读 9 ms；1 万条分页 `verifyChain` 72 ms。复核修掉的要点：被拒绝的打开原先并非零写入（`journal_mode = WAL` 跑在版本检查之前）；租户检查原先排在迁移之后（会先升级别人的文件再拒绝）。DDL 用 `?raw` import 加载。
- 第 7 步遗留：`@types/better-sqlite3` 最新只到 9.6.0，类型描述的是 v9 而运行时是 v13，用到的子集已对着 v13 源码核过；文件版本过新时抛的是 host 本地的 `TapeSchemaVersionError`（不在端口的七个错误里）；构造参数多了 `busyTimeoutMs` 与 `now` 两个 spec 没提的接缝，第 13 步接线时传 `now: () => host.clock.now()`；`createSqliteTapeStore` 是同步的、打开时就可能抛 `TapeTenantMismatchError` / `TapeSchemaVersionError`，第 13 步要决定此时窗口怎么办；`listSessions` 为了与内存 store 全序一致加了 `session_id` 次序，代价是计划里多一个 `TEMP B-TREE FOR LAST TERM`（验收 14 管的是 `readBySource`，它是干净的）。验收 20 的「CI Linux 上免编译」本机（macOS）证明不了，要等 CI。
- 顺带发现：`pnpm copy:check` 的 `MAIN_FIELDS` 正则会把主进程里 `error.message : 'unknown'` 这类三元式误报成未翻译文案，第 7 步用拆变量绕开了。第 13 / 14 步会写大量主进程代码，开工前先把这条正则收紧。

- **第 9 步**（2026-09-21，`0e06010`）：`provider/wire/{anthropic-messages,openai-chat,shared}.ts` 里的纯函数 `encodeAnthropicMessages` / `encodeOpenAIChat`，适配器类的 `encode()` 只是一行委托。`requestSnapshot(req)` 是 `provider/attempt_completed.request` 快照的**唯一**出处（第 12 步必须用它，不要自己拼）；`systemHash('')` 与「没有 system」同值，取 64 个 0 这个刻意不是摘要的哨兵。`requestParams` 是**纯增量**的：只能加编码器不写的键，不能覆盖编码器写的任何键（`model` / `messages` / `max_tokens` / `tools` / `stream` / `system` / `temperature` / `thinking`…），违者抛 `ProviderInvalidArgumentError`——否则快照与 `toolDefinitionsHash` 描述的就不是实际发出的字节。`stream: true`（以及 OpenAI 线的 `stream_options.include_usage`）写在 body 里而不是 `stream()` 里，`promptHash` 因此覆盖发出的每个字节。块出现在该厂商内容联合里没有位置的角色上（如 user 轮里的 `tool_use`）直接抛，不挪也不丢。被守卫清空的消息整条省略，留下的相邻同角色轮次原样相邻（两家文档都说会合并；补占位内容等于伪造 Tape 上没有的东西）。七条守卫规则在单一线协议上凑不齐（Anthropic 线表示不了 echo，OpenAI 线表示不了 signed replay），验收 2 的规则表断言是跨两条线完成的。
- **第 10 步**（2026-09-21，`d9e1fda`）：`@anthropic-ai/sdk@0.126.0`、`openai@7.17.0` 进 kernel（精确版本；desktop 自己那份依赖留到第 13 步删）。打包测试在两家 SDK 都可达的情况下仍零错误、无 `external`。`ProviderDefinition.create()` 的参数加了 `clock: Pick<HostClock, 'now'>`（见 Open）。复核抓到的要点：**`ANTHROPIC_CUSTOM_HEADERS` 是第四个环境变量入口**，能在每个请求上**替换**显式传入的凭据——已封住凭据这一半；`detail` 原先先截断再脱敏，长报错会漏出 key 的前 26 个字符——已改为先脱敏；SDK 把像超时的 fetch 拒绝包成别的错误类时 `HostNetworkDeniedError` 不在 cause 链上——已改为在 host fetch 接缝处直接识别；另外显式传 `webhookKey: null` 与 `logLevel: 'off'`，堵住 `ANTHROPIC_WEBHOOK_SIGNING_KEY` 与 `ANTHROPIC_LOG`。`stop` 随 `message_delta` 发出（紧跟 final usage），不等 `message_stop`。验收 7 的 provider 一半：200 个确定性中止点，每次恰好一个 `stop{aborted}`、部分文本逐字节等于中止前收到的；预先中止时 `callCount === 0`。
- **第 11 步**（2026-09-21，`3d25519`）：`OpenAIChatProvider` + `definitions/{anthropic,zhipu,ollama}.ts` + `registerBuiltinProviders`。状态码 → `ProviderErrorCode` 的表、cause 链、context-overflow 的措辞识别、`detail` 脱敏都收在 `provider/errors.ts`，两个适配器共用一份。「SDK 现实」复核抓到的要点：**Ollama 给每个流式工具调用都标 `index: 0`**，按 index 归位会把并行调用揉成一个解析不了的槽、全部丢掉——已处理；流中途断连到达 `mapError` 时是裸 `Error` / `TypeError` 而不是 `APIConnectionError`，原先被判成 `unknown` / 不可重试——现为 `network` / 可重试；智谱的上下文超长是 HTTP 400 + code 1261（「Prompt 超长」）、欠费是 **HTTP 429** + code 1113——后者若按状态码读就是可重试的 `rate-limit`，阶段 2 的循环会永远重发，现规则是「厂商错误码属于不可重试类时压过 HTTP 状态表」（只会少重试，不会多重试）。验收 1 的 provider 一半：一个参数化测试用同一条路径（registry → `create()` → encode → stream → 累加器）驱动三个定义，再现场注册第四个。
- **给第 12–14 步**：验收 1 的「同形 Tape 事实」、验收 3 的 `promptHash`、验收 7 的「恰好一条 `provider/attempt_completed`」三个一半都落在第 12 步。流中途断连现在记为可重试的 `network` 且带上该次已消耗的 usage。`create()` 会对用户填的配置抛 `ProviderConfigMissingError` / `ProviderInvalidArgumentError`（空白凭据、非 http(s) 或带 query / fragment 的 baseURL、Anthropic 的 baseURL 以 `/v1` 结尾）——第 14 步的设置卡要把它们呈现为配置错误而不是崩溃。`primary` 只标在 spec 表里标了的地方（anthropic 的 `apiKey`），zhipu / ollama 的卡片没有 primary 字段。
- **夹具不是录制的**：spec 写「录制的 SSE 夹具」，但这一轮不许 agent 碰真实凭据与端点，两条线的夹具都是照厂商文档的线上格式手写的，每个文件头都注明了。第一个跑 `pnpm test:live` 的人应拿一条真实的 Anthropic / 智谱 / Ollama 流与它们对一遍。

- **第 12 步**（2026-09-21，`89b4e4d`）：`packages/kernel/src/session/service.ts`。`createSessionService({ host, tape, ids })` 内部把 store 包进门面，外面够不着 `TapeStore.append`。API：`createSession({ sessionId?, forkedFrom? })` / `resetSession` / `deleteSession` / `latestSession({ limit })` / `listMessages` / `runRequest`。一次 `runRequest`：`message/user`（按重发规则）与 `session/model_selected` 同一个事务写入 → `contextAtEntryId` 取**这次 run 自己的**两条回执里较大的 entry id（不是共享的 head——并发 run 会把 head 推走）→ 钉住重放 → `encode()` 一次 → 流式转发每个事件 → 终态时 `message/assistant`（有内容才写）与 `provider/attempt_completed` 同一个事务写入，`request` 直接取第 9 步的 `requestSnapshot()`。`RunResult` 里 `stop` / `error` 恰好一个非空。一次发送的读开销是 `listMessages` 一页加一次点读，不是整条 Tape 的折叠。
- 第 12 步新增了一条**端口规则**（两个 store 都实现了，conformance 套有用例，6b 的 Postgres store 同样要守）：只有以 `session/start` 开头的批才能创建 head 行。起因：`deleteSession` 落在一次进行中的 run 之下时，终态批会把会话「复活」成一个没有 `session/start` 锚点的 session。现在那种情况下 `runRequest` 在流结束之后以 `TapeSessionNotFoundError` reject——这次 run 的事实随会话一起丢弃是有意的；调用方要把它当「会话没了」而不是 provider 错误，阶段 2 的循环不得把它当可重试。共享 conformance 套现为 29 个用例，验收 3（全量）、验收 7 的 Tape 一半、重发规则、两个并发 run 都在里面，内存 store 与 SQLite store 原样通过。验收 1 的 Tape 一半：三个内置定义加现场注册的第四个，五条事实的 kind、身份列、payload 键集完全同形。
- **第 13 步**（2026-09-21，`b9c1623`）：`chat.ts` 的内存 `history` 与直接构造的 SDK 已删，`@anthropic-ai/sdk` 从 desktop 的依赖里移除；对话落在 `<profileDir>/sessions.db`，渲染端启动时经 `session.latest` 恢复。session id 仍由渲染端铸造，主进程先验 `isCanonicalUuid`，首次发送时用它建 Tape 会话。阶段 0 的五条行为全部保留并改由 Tape 承载（`apps/desktop/test/chat.test.ts` 逐条钉着）。spec 没写、此处取定的：`sessions.db` 打不开（租户不符 / 版本过新 / 绑定加载失败）时应用照常启动、文件一字节不动、每次 `chat.send` 回一个终态 `error`（`unknown`）、`session.latest` 回 `null`；`ProviderConfigMissingError → auth`、`ProviderInvalidArgumentError → provider`、`egress-denied → unknown`（spec 的「其余 unknown」）；没设 `TENON_MAX_TOKENS` 时回复上限取 `min(64000, model.maxOutputTokens)`，保留阶段 0 的成本上限；**开发期环境变量回落在 `app.isPackaged` 时不生效**（与 `TENON_SECRETS`、`TENON_DEV_ENV` 两个开关一致）；恢复渲染只认 `text` 块；`onEvent` 里的 `send()` 包了 try/catch，窗口死了不会让 run 丢掉它的 attempt 事实。`TENON_SECRETS=memory` 接缝从第 14 步提前到了这一步（e2e 从这里起就需要），`createDesktopHost` 收 `isPackaged` 参数而不是 import electron，`src/main/host/` 因此仍不依赖 electron。复核修掉的回归：没有窗口时点 File ▸ New Chat 会重开旧会话；run 比它的窗口活得久时，恢复出来的窗口被拒且看不到已完成的回复；e2e 启动器原先给 `pnpm test:live` 也强加了内存机密，真 keychain 路径变成没有任何东西覆盖。验收 5 是 Playwright 用例 `e2e/session-restore.spec.ts`（重启后消息仍显示、假服务器在重启后的请求体里看到第一轮对话、另一个 profile 看不到），消息确实经 `sessions.db` 往返，即验收 20 的 Electron 一半。
- **第 14 步**（2026-09-21，`303098a`）：`provider.list` / `provider.configure` / `provider.select`，`config.json` 的 `provider` 与 `providerConfig`，账号菜单 →「模型与密钥」设置卡。`provider.list` **根本不带任何值字段**（连非机密的也不带，卡片从 `config.get` 预填），「永不回传机密」因此是结构性的；每个 ConfigKey 多带一个 `configured: boolean`。拒绝是结构化的 `{ ok: false, code, configKey }`，卡片映射到目录文案。**机密字段传空值即删除**（spec 没写清除规则，这里定的）；非机密字段传空存成 `''`，定义的 `create()` 读作「用声明的默认值」。一次保存只发送用户改过的字段。`provider.configure` 只对着**已存储**的值校验，不看开发期环境变量。`provider.select` 拒绝不在 `builtinModels` 里的 `modelId`（表外模型仍可经 `TENON_MODEL` 走合成的保守 `ModelInfo`）。复核修掉的要点：`config.set` 原先是绕过校验的第二条写入路径；输入的 key 在卡片关闭后仍留在渲染端 state 里；碰过又清空的机密字段会在保存时静默删掉已存的凭据（现在有明示）；切走再切回 provider 会静默改写已保存的模型。locale 键存在性单测遍历 `ProviderRegistry.list()`。验收 6 是 `e2e/provider-settings.spec.ts`（两个并排的假端点，断言路径、`Authorization`、body、`provider.list` 原始 IPC 结果里不含输入的 key）。`pnpm test:live` 增加了 zhipu 用例，只在 `TENON_LIVE=1` 时跑，**本次未运行**。UI 变化（供 PR 用）：BEFORE——账号菜单只有语言，provider 与模型来自环境变量；AFTER——账号菜单多一项「模型与密钥」，打开一个完全由 `provider.list` 渲染的对话框（provider 下拉、每个 ConfigKey 一个带标签的输入框、模型下拉、取消 / 保存），拒绝显示为一行本地化文案并标出出错字段，焦点起于 provider 下拉、关闭后回到账号行。两个下拉是原生 `<select>`（现有弹层原语在对话框上方有 z 层缺口）；新增了 `components/ui/input.tsx`。

- 流程：轮 2 的两个修复 agent 首次都死于 API 断线（ECONNRESET），留下半成品；续跑时让第二个修复 agent 把现场当不可信草稿逐条核对后才收尾。续跑那次第 8 步的 downstream 复核又断线，其首轮提出的四条 major 由编排方对着代码逐条核过：三条已落实，第四条（时钟）见 Open。

- 流程：harness 自建的 worktree 是从 `main` 拉的而不是当前分支，三个 agent 各自 `--ff-only` 到了 `cc1075f` 才开工；后续并行轨道的 worktree 由编排方自己 `git worktree add` 建。`.claude/worktrees/` 已进 `.gitignore`（嵌套检出会被主检出的 oxlint 扫到）。

## 验收记录（第 16 步，2026-09-21）

做法：4 名独立审计员各管一组、各用一个 worktree，外加一名完整性批评者。通过的标准不是「有个同名测试是绿的」，而是：读过测试、确认它断言的是验收原文；实际跑过；凡便宜处都把生产代码改坏、看它变红。结果 41 项（21 条验收 + 18 条不变量 + 第 17 步两项）**0 项失败**；批评者另核了 6 条目标、非目标清单、R1–R8 每条的「阶段 1 落地」所在文件，以及 AGENTS.md 的硬规则，均通过。审计找到的缺口都是「测试不够锋利」（改坏生产代码后仍绿），没有功能缺陷；已在 `b716e63` / `7e64756` / `bc3e6d7` 补上，每个新断言都在对应变异下亲眼见红，并由独立验证者换一种改法再验了一遍。

命令均相对仓库根；e2e 需先 `pnpm build`，在 Claude Code 里要加 `env -u ELECTRON_RUN_AS_NODE`。

| # | 结论 | 复跑命令 |
|---|---|---|
| 1 | 通过 | `pnpm vitest run --project kernel test/provider/definitions.test.ts`（四个定义同一条路径，含中止；Tape 事实同形） |
| 2 | 通过 | `pnpm vitest run --project kernel test/provider/wire/encode.test.ts`（「零网络调用」现经真实 provider 实例断言） |
| 3 | 通过 | `pnpm vitest run --project kernel test/tape/memory-store.test.ts -t "re-encodes"` 与 `pnpm vitest run --project desktop test/tape/conformance.test.ts -t "re-encodes"`（共享套，两个 store） |
| 4 | 通过 | `pnpm vitest run --project desktop test/tape/sqlite-store.test.ts -t "acceptance 4"`（全部 21 处租户谓词加 `tape_meta` 比较的变异扫描 22/22 见红） |
| 5 | 通过 | `cd apps/desktop && pnpm exec playwright test e2e/session-restore.spec.ts` |
| 6 | 通过 | `cd apps/desktop && pnpm exec playwright test e2e/provider-settings.spec.ts e2e/chat.spec.ts`；`pnpm vitest run --project desktop test/provider-catalogue.test.ts`（OpenAI 线的流式渲染现在在尾块放行**之前**断言首块已上屏） |
| 7 | 通过 | `pnpm vitest run --project kernel test/provider/wire/anthropic-stream.test.ts -t abort`（200 个确定性中止点，部分文本逐字节比对；预先中止 `callCount === 0`）；Tape 一半在共享套 |
| 8 | 通过 | lint 一半：`pnpm vitest run --project scripts scripts/lint-gate.test.mjs`（**新增的持久测试**：按 override「整条替换」的语义算出 kernel 路径的生效配置并断言禁用清单，另外真跑 oxlint 验证验收原文点名的五种形式）；打包一半：`pnpm vitest run --project kernel test/host-independence.test.ts` |
| 9 | 通过 | `pnpm vitest run --project desktop test/tape/sqlite-store.test.ts -t "acceptance 9"` |
| 10 | 通过 | `pnpm vitest run --project desktop test/tape/sqlite-store.test.ts -t "two connections"`；重置与陈旧 incarnation 在共享套 |
| 11 | 通过 | 共享套（两个 store）；冲突后「库文件逐字节不变」另有 SQLite 文件摘要测试 |
| 12 | 通过 | `pnpm vitest run --project kernel test/tape/hash.test.ts`；`pnpm vitest run --project desktop test/tape/chain.test.ts` |
| 13 | 通过 | `pnpm vitest run --project kernel test/tape/names.test.ts`（通用路径四道闸各删一道都见红，并断言是哪道闸拦的） |
| 14 | 通过 | `pnpm vitest run --project desktop test/tape/sqlite-store.test.ts -t "acceptance 14"`（`EXPLAIN QUERY PLAN` 跑在 store 实际用的那个 SQL 常量上） |
| 15 | 通过 | `pnpm typecheck`（类型夹具里的 `@ts-expect-error` 删掉即编译失败）；`-t "acceptance 15"` |
| 16 | 通过 | `pnpm vitest run --project kernel test/provider/thinking.test.ts`（25 行规则表，`action` 与 `reason` 整体比对） |
| 17 | 通过 | `pnpm tape:check`（单边改列 / 索引 / 键 / 触发器共六种变异，各自退出 1 并点名对象） |
| 18 | 通过 | `pnpm vitest run --project desktop test/tape/sqlite-store.test.ts -t "acceptance 18"` |
| 19 | 通过 | `pnpm vitest run --project contracts test/frame.test.ts test/frame-tape-syntax.test.ts` |
| 20 | 通过（本地 + PR #11 的 CI，2026-09-22） | 干净 clone 里 `pnpm install && pnpm build && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` 逐条退出 0（install 5.3 秒、无编译）；Electron 主进程里能打开库由 e2e 的消息经 `sessions.db` 往返证明。**「CI 的 Linux 上免编译加载」本机（macOS）证明不了**：包里确实带 linux-x64 / arm64 / musl 预编译产物，但只有一次 CI 运行能证明 |
| 21 | 通过（2026-09-22） | `pnpm test:live`（owner 的智谱 key）：Anthropic 线 3 个用例 + zhipu 的 OpenAI 兼容线 2 个用例（一次流式对话、一次停止）均通过，详见下方「live 运行记录」 |

**live 运行记录（验收 21，2026-09-22）**：owner 的 key 是智谱的 key，`.env.local` 里以 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic` 的形式存在，没有 `ZHIPU_API_KEY`；本次运行经进程环境把同一个 key 作为 `ZHIPU_API_KEY` 传入（不落盘）。要让 `pnpm test:live` 以后自己就能跑 zhipu 组，在 `.env.local` 里加一行 `ZHIPU_API_KEY=` 同一个值，并设 `TENON_LIVE_ZHIPU_MODEL=glm-4.6`。
- 第一次整套运行：Anthropic 线 3/3 通过；zhipu 组 2/2 **失败**，原因不在代码——免费模型 `glm-4.7-flash` 在 OpenAI 兼容端点回 `429 / code 1302「您的账户已达到速率限制」`（前面三个用例刚连续打过它）。适配器把它正确归成 `rate-limit`，界面显示了对应文案。同一个 key 换内置的 `glm-4.6` 单独重跑 zhipu 组：2/2 通过（6.9 秒、12.3 秒）。**教训**：live 套件里两组别共用同一个免费模型。
- **智谱的 `usageNeedsOptIn: false` 已确认正确**（Open 里那条可以关掉）：用 curl 抓了三条真实流（不带 / 带 `stream_options.include_usage` / `thinking: disabled`），用量在不 opt-in 时就给，挂在带 `finish_reason` 的**同一个块**上而不是尾部空 `choices` 块；带上 `stream_options` 被接受但没有任何区别；流以 `[DONE]` 结束，没有 `event:` 行。先 `reasoning_content` 后 `content`，用量含 `completion_tokens_details.reasoning_tokens` 与 `prompt_tokens_details.cached_tokens`——与手写的 zhipu 夹具一致，夹具注释已改为「已对照真实流确认」。真实线上多出两处适配器不读的细节：每个 delta 都重复带 `role`，finish 块的 delta 带一个 `content` 键。
- **没能对照的**：Anthropic 线的夹具。owner 的端点是智谱对 Anthropic 线协议的**仿真**，不是 Anthropic 本身；三个 live 用例在它上面通过，说明适配器吃得下这份仿真，但不能证明手写夹具与 Anthropic 官方的流逐帧一致。要等有 Anthropic 官方 key 的人来对。Ollama 的两项探测同样仍开着。

**耗时**（macOS arm64，Node 22.22.0）：5000 条分页读 9 ms；1 万条分页 `verifyChain` 72 ms。

审计后仍然成立、如实保留的几条：
- 不变量 8 的「凭据传 `null` 而不是 `undefined`」无法用测试钉住，因为它**没有可观察效果**：适配器的 `defaultHeaders` 已用显式 `null` 把两个凭据头钉死，SDK 从环境变量解析到什么都会在发出前被覆盖（把那段钉子删掉，现有测试会红）。显式 `null` 是第二道、冗余的防线。
- 验收 1 / 7 跑的 SSE 夹具是照文档手写的，不是录制的（见实施记录）。
- 验收 4 较强的那一半只有单元测试：发布的应用只有一个固定租户，端到端测不到租户谓词，要等 6b 有第二个租户。
- 新的 e2e 用例必须从 `./helpers/test.js` 而不是 `@playwright/test` 导入 `test`，否则它的临时 profile 不会被清理；目前没有机制强制这一点。

- **顺手修的阶段 0 界面 bug**（2026-09-22，`a3a0fdc` + `f353e4d`，owner 实机 100% 复现）：会话高过视口后，滚轮滚过消息列表底部会把**整个壳**（含侧栏）推上去、露出 body 背景。根因：每条消息里给读屏软件的 `<h3 class="sr-only">`（`position: absolute`）在 `position: static` 的滚动容器里以整个文档为定位基准，逃出 `overflow` 裁剪，把 `document.scrollHeight` 撑到比窗口高（1280×780 下四条短回复后 780 → 1060），文档因此可滚、滚动链接管。修法：`ThreadPrimitive.Viewport` 与 app-root 各加 `relative`（两道防线各自单独也够）。回归测试 `apps/desktop/e2e/layout.spec.ts`：四条 markdown 回复后断言文档高度 = 窗口高度、滚轮后 `scrollY === 0` 且 viewport 自己滚了、两处 `position` 都是 `relative`（撤掉任一处即红）。此前几轮探针没复现是因为单条超长回复的隐藏标题在视口内，要**多条消息**、后面几条的开头落在视口外才触发。
- **「回复不是流式的」不是代码问题**（2026-09-22 实测）：智谱的 Anthropic 兼容入口（`/api/anthropic`）把整段回复攒成 2 大块吐出（31 KB 分 7 块，前 4 块同一毫秒到达，两块间隔 1.7 s）；同一个模型走 OpenAI 兼容入口是 110 个小块、3.9 s 内逐字到达。owner 的 `.env.local` 已改为 `TENON_PROVIDER=zhipu` + `ZHIPU_API_KEY`（同一个 key），`.env.example` 同步记录。

## 清理记录（第 17 步，2026-09-21）

- 分支 diff（`git diff dev...HEAD`）里没有遗留探针、`.only`、调试输出或不属于本 spec 的文件；新增的两处 `console.log` 分别是 `scripts/` 里 CLI 的输出与 `chain.test.ts` 打印的耗时（plan 要求记录）。
- `packages/kernel/src` 够不着任何 `node:http` 假服务器：grep 无 import，lint 闸也会拒绝；两个假服务器只在 `apps/desktop/test/support/`。
- `packages/contracts/test/frame-tape-syntax.test.ts` 里的一个裸 NUL 字节（让 git 把该文件当二进制）已改成 `\x00` 转义，运行时字符串不变。
- e2e 的临时 profile 目录原先从不清理，系统临时目录里积了 410 个 / 675 MB：helper 现在登记每个根目录、用例通过即删（失败保留供排查），历史遗留的已手工删除。
- 各轮并行用的 worktree 目录均已移除。它们的本地分支（`worktree-wf_*`、`wt/01-*`）保留未删——AGENTS.md 规定不经要求不删分支；内容都已并入功能分支，owner 可自行清理。

## 起草记录（2026-09-17）

- spec 由 Claude Code 按 owner 的「你来做」起草；owner 于 2026-09-18 认可并指示改为 `Status: ready`、合并后开工。
- 草稿经过一轮五个角度的对抗审查（各配一名反驳者）：64 条里 45 条成立并已修进 spec，4 条高危分别是 incarnation id 无处传入、OpenAI SDK 的凭据规则、`Usage` 未定义且 Anthropic 一个流发两条 usage、amend 状态过期。随后一轮执行复核（照修订后的文本实现 store 并逐条跑不变量，外加修复落地核对）确认 45 条全部落地，又找到 11 条并已修：对不存在的 session 做 `resetSession` 会凭空建会话、`runId` 进了 `message/user` 的 payload 会让重试变冲突、原验收 9 测不出 store 有没有回滚、`promptHash` 缺请求参数快照无法复核，等等。
- 依据：三项实测（SQLite 绑定、两家 SDK 的 fetch 注入与流形状、DeepChat Tape 补读），各经一轮独立的对抗复核；三套独立设计（最小不后悔 / 服务端与审计优先 / 循环与恢复优先）加两名评审逐条裁决，评审实际执行了各方案的 DDL 与分配语句。探针与中间产物不入库。
- R8 已在起草同一个 PR 里完成：`docs/reference/deepchat-mechanisms.md` §二之补。

## 交接（2026-09-21）

分支 `feat/01-provider-and-tape`（已经 PR #11 于 2026-09-22 合并进 `dev`），第 1–17 步完成，门禁全绿：`pnpm format:check` / `lint` / `typecheck`、`pnpm test`（54 个文件 / 845 个用例）、`pnpm build`、`pnpm test:e2e`（16 通过）。

**第 18 步已完成（2026-09-22）**：验收 20 的另一半由 PR #11 的 CI 证明（ubuntu-latest：`ci` 59 s、`e2e` 1 m 32 s 全绿，`better-sqlite3@13.0.3` 免编译加载）；验收 21 已在真实智谱端点通过。spec 顶部已改 `Status: implemented`。

下一个接手的人先读本文件的 Open：有几条是 spec 缺口或自相矛盾，需要 owner 在 Claude Desktop 项目里裁决后回写 spec（多数要在 `Revisions:` 记一笔）。按对后续阶段的影响排序：Anthropic 的 thinking 形状已过时（阶段 2 之前必须给 `ModelInfo` 加 thinking 模式字段）；`promptHash` 的可复核性依赖不进 Tape 的模型表；`create()` 参数里加的 `clock`；「撤回后再修订」时 `order_seq` 的矛盾；已存的 key 可被静默指向新的 `baseURL`；「恢复最近一个会话」里「最近」的定义。

## Open

- **待 owner 裁决 · 已存的 key 可以被静默指向另一个端点**：在设置卡里只改 `baseURL`、不重输 key 就保存，之后已存的 key 会被发往新地址。受损的渲染端同样能经 `provider.configure` 做到。三种修法（要求重输 key / 确认新主机 / 留给阶段 4 的出网收口）都是产品决定，这一步没有发明确认流程。
- **spec 缺口 · 「恢复最近一个会话」没定义「最近」**：`updated_at` 与 `last_message_at` 都会被晚提交的 run 推动，所以一个被 `chat.new` 抛下、但后台 run 后完成的会话，仍可能成为下次启动恢复的那个。要按「用户最后看的那个」排序，需要投影里有一个按会话的「最后打开」读数——spec 决定。
- **阶段 1 / 2 的边界 · 停在 `tool-use` 的轮次**：会把模型的 `tool-request` 块持久化，而阶段 1 没有写应答事实的一方，重放会把这个没人回答的块交回去，两种线协议都会拒收。阶段 1 的对话路径不发 tools，所以走不到；spec 说「对 provider 上下文，工具事实是权威」，指向阶段 2 从事实组装工具块——由阶段 2 的 spec 定。
- 设置卡没有渲染定义级的 `configured`（只渲染了每个 key 的状态），选中一个未配置的 provider 不会被拦：`configured` 刻意只反映**已存储**的值，拿它拦保存会把 owner 日常用的环境变量路径拦掉。要不要提示、加什么文案，属于 UX 决定。
- 在 `session.latest` 返回之前的亚秒窗口里打字并发送的消息没有防护（只防了显式的 New Chat）；File ▸ New Chat 的回归测试只在 macOS 上跑（别的平台关掉最后一个窗口即退出）。
- 潜在陷阱（已写进注释，未全面修）：zod 4.6.5 的 `.partial()` 会保留每个字段的 `.default()`，从 `configSchema` 派生补丁 schema 的路由会把所有字段都物化出来。`configPatchSchema` 仍是这个形状，目前只用作主进程写入的类型。
- **待 owner 裁决 · Anthropic 的 thinking 形状已过时（影响面最大的一条）**：`encode()` 只会写 `thinking: { type: 'enabled', budget_tokens }`。2026-09-21 查 platform.claude.com 的 extended-thinking 文档：这个形状在 Claude Opus 4.7 及之后的模型上**返回 400**——即 `claude-opus-5`、`claude-sonnet-5`、`claude-fable-5-1`——它们要的是 `thinking: { type: 'adaptive' }` 加 `output_config: { effort }`；只有 `claude-haiku-4-5-20251001` 吃 budget 形式且只吃这一种。而 `ModelInfo` 没有任何字段能区分这两种模式，`requestParams` 又不许覆盖 `thinking`。结果：按现 spec，thinking 在当前没有一个主力 Claude 模型上能开。阶段 1 的对话路径不开 thinking，所以不阻塞；但阶段 2 之前必须给 `ModelInfo` 加一个 thinking 模式字段（spec 改动）。四个 Anthropic 内置模型目前都标着 `reasoning: true`。
- **spec 缺口 · `promptHash` 的可复核性依赖不进 Tape 的模型表**：`encode()` 读 `ModelInfo` 的 `requestParams`、`usageNeedsOptIn`、`thinkingPreservationFormat`、`reasoningEchoField`、`canonicalId`，而 `provider/attempt_completed` 只记了 `providerId` / `modelId` 与请求快照。模型表哪天改一行，旧记录的 `promptHash` 就复算不出来了。修法是在事实里多记一个这几项的摘要（如 `modelWireHash`），属于对 spec 固定形状的扩充。验收 3 在模型表不变的前提下成立。
- **spec 缺口 · 没有「末尾是 assistant 轮（prefill）」的按模型能力位**：新模型上是 400，老模型上是静默的语义变化。阶段 1 因为重试规则总留一条尾部 user 消息而安全；第 13 步的 `messageId` 复用与阶段 2 的重试循环可能打破它。与上面 thinking 模式是同一类「按模型的线上能力」字段。
- `ANTHROPIC_CUSTOM_HEADERS` 的非凭据部分（`anthropic-beta`、任意 `x-*`）仍能到线上。要不要做 header 白名单，与 spec 开放问题 1（`x-stainless-*`）是同一个决定。
- spec 没给线协议适配器定请求超时：现在生效的是 SDK 默认的 10 分钟（只覆盖到响应头）。kernel 要不要自己定一个数，待 owner。
- **已结（2026-09-25）：不开 opt-in 也给用量**（2026-09-25 改，见 [02 §背景与问题](../02-agent-loop/spec.md)）。原记：**智谱的 `usageNeedsOptIn` 填的是 `false`**，而 spec 的内置 provider 表把 `include_usage` 列为选它的理由之一：厂商的对话补全文档（2026-09-21 重读）根本没列 `stream_options`，只说 usage 是流式块的一个字段。按「照厂商当时文档填」保持 `false`，由验收 21 的 `pnpm test:live` 定夺。
- **Ollama 的三个保守值与两项探测仍开着**（本机没有运行中的实例）：`contextLimit: 4096` 是**服务端默认**（docs.ollama.com/faq）而不是模型能力；`maxOutputTokens: 2048` 是我们自己取的，没有文档给出上限；`supportsStreamingToolCalls: false` 待实测。两项探测：流式工具调用；`num_ctx` 默认 4096 是否静默截断大 system prompt。
- 其余未能从一手来源确认的 `ModelInfo` 字段，在 `definitions/*.ts` 的注释里逐项标了日期与查过的 URL。
- **spec 自相矛盾 · 撤回之后再修订同一个 `messageId`**：「`order_seq`…修订与撤回都不改它」（§投影与重放）与「删单条消息 → 物理删该行」（§删除语义）不能同时成立——行删掉之后，逐条处理的 reducer 无从恢复原来的 `order_seq`。现状：投影按修订那条的 `entry_id` 重新插入，折叠则让消息留在原位，于是 `listMessages` 与 `rebuildProviderContext` 对这一个 `messageId` 的排序不同。阶段 1 没有写入方（编辑 / 删除界面在阶段 6），不影响当前功能；两种修法（投影加 status 列软删，或规定撤回即终局）都要改 spec，待 owner 定。
- **端口没定义 close 之后的行为**：SQLite store 抛 `TypeError`，内存 store 照常服务。要么补一条端口规则加一个 conformance 用例，要么在 spec 里记下这处差异。
- **方言映射表缺两行**：迁移阶梯里的 `SELECT … FROM sqlite_master` 与 spec 规定的 `BEGIN IMMEDIATE` 都无法靠 `?` → `$n` 移植，代码里已收进同一个接缝并加了注释。另，给 6b 的 Postgres store：`ON CONFLICT … DO NOTHING` 影响 0 行时必须重跑第 ① 步查重（READ COMMITTED 下两个后端会同时查不到），spec 的语句清单没写。
- `readBySource` 在端口上没有游标：一个 run 的事实超过 `limit` 就被截断且无法续读。阶段 2 的恢复可能需要它——给查询类型加一个字段，是只增的改动。
- 维护闸在同一个事务里开了又关，外部看不见；验收 9 靠一个测试专用的 AFTER INSERT 触发器才证明了 `mode`。6b 的 legal hold 若要审计开闸，需要一条真事实或保留行，属于 spec 决定。
- **待 owner 裁决 · provider 拿不到时钟**：spec 要求 `retryAfterMs` 的 HTTP-date 分支「减 `HostClock.now()`」，但 `ProviderDefinition.create({ network, config, secrets })` 里没有时钟，kernel 又禁用 `Date.now()`。第 10 步先按只增的读法做：`create()` 的参数加一项 `clock: Pick<HostClock, 'now'>`。这是对 spec 接口的一处就地修订，需要 owner 在 spec 的 `Revisions:` 记一笔（或给出别的入口）。
- **待 owner 裁决 · 守卫的两处读法**：规则 2 比较的是 `canonicalId ?? id`（spec 说「定价与 thinking 规则按 canonicalId 算」，但没说身份比较也按它；现读法下，同一上游模型换转售渠道不算换模型）；规则 6 把只含空白的签名也当「签名为空」。
- **spec 缺口 · `verifyChain` 没有「本构建验不了」这个状态**：结果形状是定死的 `{ incarnationId, checked, firstBadEntryId, nextFromEntryId }`，而 `hash_ver` 不认识的行既不算好也不算被篡改。第 4 / 7 步先取保守读法：把它报成 `firstBadEntryId`。
- **spec 缺口 · DDL 对 `kind` / `source_type` 没有 CHECK**：封闭词表目前只靠 kernel 的闸守着，绕过门面直接写库的 store 拦不住。要加就得先改 spec 的 DDL 代码块（检查器会拿它比对）。
- **待 owner 裁决 · 重放与 thinking 守卫**：spec 写 `rebuildProviderContext(…, target)` 的「`target` 交给 thinking 守卫」，但守卫规则 4 要知道「本次请求是否带 tools」，重放拿不到；且重放若先丢块，`encode()` 记进 `provider/attempt_completed` 的 `thinkingDecisions` 审计就不完整。第 5 步先取可逆的读法：重放原样透传、守卫只在 `encode()` 里跑（两种读法下 `promptHash` 相同，以后改不动数据）。
- **待 owner 确认 · 检查器多读了一个输入**：`check-tape-schema.mjs` 除两份方言文件外，还把 SQLite 文件与 spec 里的 ```sql 代码块逐条比对（复核时发现两份文件可以一起偏离 spec 而检查器仍绿）。spec 原文只说「解析两份文件」。代价：以后哪份 spec 用新 DDL supersede 本 spec 时，要同时改脚本里的 `SPEC_FILE`。
- 验收 8 的措辞只列了裸形式；闸现在也拦 `globalThis.x` 形式。spec 要不要补一句，由 owner 定。
- 给 6b 的桥帧遗留：帧 `type` 的字符集暂定 `[a-z][a-z0-9_]*`、允许两段及以上（为了与 Tape 的 `ext/<owner>/…` 一致——spec 只写了 `<namespace>/<name>`）；信封 `id` 没有长度上限（属于传输层的帧大小决定）；zod 默认 strip 掉未知键，`hello` / `welcome` / `error` 上的增量字段不会被转发。规则 4 的段语法一致性已由第 3 步的跨包测试钉住；「业务帧的第一方前缀保留」要等 6b 有了第一个业务帧才有东西可拦。
- spec「选型」一节可补一条事实：当前依赖集下 `--platform=neutral` 同时败在 MCP 客户端的 `pkce-challenge` 和 SDK 的 `standardwebhooks` 与多个 `node:` 内置模块上；`--platform=browser` 干净（2026-09-25 改，见 [02 §UX 文档与其余文件](../02-agent-loop/spec.md)）。
- 开放问题见 spec 末尾（`x-stainless-*` 头、GLM 的 `reasoning_content` 回传、三平台 fsync 基准、主线程同步 SQLite 的搬迁阈值）。
- Ollama 的流式工具调用只从源码与已合并的 PR 核实过，没有对运行中的实例实测；`num_ctx` 默认 4096 会静默截断大 system prompt 的说法同样未实测。第 11 步接入时各探一次。
- 智谱的模型 id 以接入当天 `docs.bigmodel.cn` 为准，不以研究报告为准。
