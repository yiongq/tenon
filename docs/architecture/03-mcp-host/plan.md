# 03 · MCP host 完整版 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。每一步结束时本地门禁 G 是绿的（CI 另跑的 `evals:gate` 见第 9a 步）。「验收 N」指 spec §验收标准，「03 不变量 N」指 §不变量，「开放问题 N」指 §开放问题，「点名 (x)」指 §点名 表里的行，「读法 N」指 §推出的读法。spec 已是 `ready`（owner 2026-10-08 过目 §推出的读法 60 条）；开放问题 1 的 CIMD 地址给出之前不开工。

行号换算：spec 与本文件引的 `02:N`、`01:N` 都是 dev `1ed9d64` 上的行号，即 03 给它们加 `Amended by` 那一行之前的。到工作树里对照时，02 第 5 行起、01 第 6 行起各加一（例如第 19 步的 02:3077 在工作树里是第 3078 行）。

## 开工前读

- **谁来做**：实现者是 Codex（owner 2026-10-08 定），只看得到仓库。每一步写明了文件、覆盖的验收、测试与命令、突变和完成标准，不留设计决定；spec 不够用时停下，在本文件「Open」写清缺什么，不自己补架构（AGENTS.md「How we work」）。
- **审查**：每段一个 PR，合并前由 lead（Claude Code）独立审查：照 spec 逐条读测试的实际断言、重跑突变、抽查真进程。审查发现的问题记在该步实施记录里，修完再合。
- **命令**（都在仓库根，除非另写）：
  - U = `env -u ELECTRON_RUN_AS_NODE pnpm vitest run --maxWorkers=2 <文件…>`
  - G = `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test --maxWorkers=2`
  - P = G 之后再 `pnpm build && pnpm evals:gate --maxWorkers=2`：与 CI 一致（.github/workflows/ci.yml:53），每段开 PR 前跑。`evals:gate` 要求基线列每题在当前 `PROMPT_LAYER_VERSION` 下有 3 条记录（apps/desktop/evals/format.ts:175-190），第 2 步加一之后到第 9a 步提交记录之前它是红的，这是预期。
  - E = `pnpm build`，再在 `apps/desktop` 下 `env -u ELECTRON_RUN_AS_NODE npx playwright test e2e/<文件> --trace off`
  - EA = `pnpm build && env -u ELECTRON_RUN_AS_NODE pnpm test:e2e`
  - 写代码前先 `pnpm format`，提交前跑 G。
- **机器约束**：vitest 一律 `--maxWorkers=2`；同一时刻最多一个 Electron（e2e、live、真进程审查都算）；起 Electron 的命令前一律 `env -u ELECTRON_RUN_AS_NODE`（本 harness 导出了它）。
- **机密**：不读、不打印 `.env.local`；CI 与 e2e 不用任何真实 key，e2e 机密走 `TENON_SECRETS=memory`（启动器缺省，apps/desktop/e2e/helpers/app-env.ts:69）。`MemorySecrets` 不限值长（apps/desktop/src/main/host/secrets.ts:65-67），2560 字节的上限要在单测里对 `KeychainSecrets` 的规则测。第 9a 步的基线评测与第 21 步的 live 由有 key 的一方跑，key 只从进程环境读、命令里只写变量名（02 的评测规则）。live OAuth（第 21 步）的令牌走真实钥匙串，跑之前先提醒 owner（macOS 会弹窗）。任何 key、令牌、client secret 不进 plan、日志、`docs/evals`、提交。
- **突变**：每步列的突变逐个做：改一处生产代码 → 跑所列测试 → 期望那条变红 → `git checkout -- <文件>` 恢复 → 再跑一次变绿。结果（红 / 没红）写进实施记录；没红的要补测试，补完再做一次。
- **Git**：从 `dev` 开分支 `feat/03-seg1`…`feat/03-seg4`（第四段按下面「分段」拆成几个 PR），各一个 PR 指向 `dev`。Conventional Commits，subject 不超过 50 个字符（超了 commitlint 会悄悄丢掉这次提交），不加 AI co-author，不 `--no-verify`，不 `push --force`，不删分支。lefthook 的 pre-commit 会先 stash 未暂存的改动：提交时暂存区要与工作树一致。
- **交接**：停下之前——不论原因——在「交接」加一条结构化条目（模板见该节）。工作要么已提交，要么是分支上描述清楚的 diff；不在 `/tmp` 或会话 scratchpad 留补丁让下一个人去取，临时探针提交前删掉。
- **owner 的事**：
  - 第 9a 步：基线评测要智谱 key 与一次全集（每题 3 次）的费用；没有 key 的编码 agent 照常推送，第一段 PR 等这一步的记录提交后才能合并（02:3003 的规则）。
  - 第 19 步：同题对比的 Claude Desktop 一侧；触发时 owner 拍板那份 feature spec。
  - 第 21 步前：开放问题 2（live 厂商），live 登录时在场。

## 分段

| 段 | 分支 | 步骤 | 内容 |
|---|---|---|---|
| 一 | `feat/03-seg1` | 1–9a | SDK 升级、契约、夹具、kernel（连接、环境、定义、连接池、工具表与收口、OAuth）、提示层基线评测 |
| 二 | `feat/03-seg2` | 10–13 | desktop 主进程（配置存储、宿主件、接线、IPC） |
| 三 | `feat/03-seg3` | 14–17 | 界面与 e2e |
| 四 | `feat/03-seg4a`，之后 `feat/03-seg4b`… | 18、22、24 先成一个 PR；19（及 19a / 19b）、20、21 按 owner 的输入各自一个 PR；最后一个 PR 做 23、25 | 同题对比、CIMD、live、核对与收尾 |

## 砍法（工期超出时）

预算 2–3 周（主参考:908）。lead 在两个时点判：第 6 步完成时（第 7、8、9 步开工之前），以及每段 PR 审查时。判法：从第 1 步开工起已用的工作日 + 余下步骤的估计 > 15 个工作日（读法 56），就照下表砍下一项（裁决卡范围段定的顺序；① 的读法见读法 57）。估计由 lead 给，连同依据写进实施记录。为了让 ①②③ 在第一段里也省得下工期，第 7、8、9 步把它们各自放成步末可单独跳过的子步（7b、8b、9b）。每砍一项：spec 顶部 `Revisions:` 记日期、砍了什么、旧的是什么、为什么；改本文件的步骤与对应验收；交接里告诉 owner。

| 顺序 | 砍什么 | 改法 | 受影响 |
|---|---|---|---|
| ① | Q4-2 退到 A：不用 server 说明 | 跳过 8b；删第 14 步的说明开关、`mcp.setInstructions` 与 `release` 的说明分支；撤掉第 2 步登记的 `message/server_instructions`（names、projection、replay、compaction、conformance）与 `MODEL_NOTES.serverInstructions`：第 9a 步之前砍只更新 `PROMPT_LAYER_HASH`，之后砍照版本闸再加一并重跑第 9a 步（02:2955）；01、02 顶部 `Amended by` 里说明那几项一起删 | 验收 42 删；§Tape 事实、§对 02 的修补 8 删 |
| ② | Q6 先做 B：崩溃不自动重启 | 跳过 7b：崩溃一律进「已停止」，只能点「重启」；重启期间的等待去掉 | 验收 3 改为「崩溃后已停止、点重启恢复」 |
| ③ | Q9 退到 A：只做 DCR 与自带 client | 跳过 9b 与第 20 步；`clientMetadataUrl` 恒为 null；主参考:910 的「CIMD 优先」加带日期补记「CIMD 记开放问题」。要 owner 明确同意才砍（开放问题 1） | 验收 17 删 CIMD 一支、产品常量那句改「恒为 null」；开放问题 1 改写 |
| ④ | Q12 维持 A | 界面只做 spec §界面 列的；审查中提出的任何界面加项记 Open 留给阶段 4 | 无 |

## 步骤

### 第一段：kernel（`feat/03-seg1`）

- [x] 1. SDK 升级（spec §SDK 升级；T2、T4、T44）
  - 文件：`packages/kernel/package.json`（`@modelcontextprotocol/client` 2.0.0 → 2.3.1；devDependencies 加 `@modelcontextprotocol/server` 2.3.1、`@modelcontextprotocol/node` 2.1.1；server-everything 不动）、`pnpm-lock.yaml`、编译不过的调用点（只做类型适配，不改行为）。新测试 `packages/kernel/test/mcp/sdk-upgrade.test.ts`。
  - 覆盖：验收 1。
  - 测试：「03 验收 1: the kernel depends on @modelcontextprotocol/client 2.3.1 and server-everything 2026.8.31」（用 `createRequire` 读两个包的 package.json）。K/mcp/everything.test.ts、everything-table.test.ts、fixture-server.test.ts 一行不改照过。
  - 命令：`pnpm install`；U `packages/kernel/test/mcp`；G；`pnpm build`（T44：kernel 打包方式不变；不过就停下写 Open，不改打包）。
  - 突变：① 在 connection.ts 给 `new Client` 临时加 `{ versionNegotiation: { mode: 'auto' } }` → fixture-server.test.ts 的 stdio 断言变红（证明它钉住 stdio 走 legacy，Q2）。
  - 完成：G 绿；实施记录写装上的版本与 lockfile 变化行数。

- [x] 2. 只增的类型与契约（spec §对 02 的修补 1–11 与 15 的类型、§对 01 的修补、§IPC、§配置；不接行为）
  - 文件：kernel——`tape/entry.ts`（`ToolTablePayload.tools[]` 只增可选 `definitionHash`、`ToolExclusionCode` 加四值、`ServerInstructionsPayload`、`PermissionDecidedPayload.definitionChanged?`）、`tools/registry.ts`（`ToolTableItem` 只增可选 `definitionHash`）、`tape/names.ts` 与 `tape/projection.ts`（登记 `message/server_instructions`，身份与 provenance 同 `message/environment`）、`tape/replay.ts`（`isFoldedMessage` 加这个名字，:59-65）、`loop/compaction.ts`（token 估算的名字表加它，:104-110）、`testing/tape-conformance.ts`（照 `message/environment` 登记）、`loop/closure.ts`（`ClosureSource` 加 `connector-unauthorized`）、`loop/events.ts`（`ToolOutcomeView.reversibility?`）、`loop/answer.ts`（`PendingApproval.definitionChanged?`）、`mcp/connection.ts`（`McpCallOptions` 类型与 `McpConnection` 可选成员的类型，实现留第 4 步）、`loop/ports.ts`（`McpToolSource` 三个可选成员、`McpAbsentSource`、`RunAssembly.mcpTable?`）、`tools/table.ts`（`ToolKey.definitionHash?`）、`permission/decide.ts`（`UserToolSetting.definitionChanged?`）、`session/service.ts`（`SessionServiceOptions.userSetting?`，接法：`extras.userSetting ?? options.userSetting ?? (() => null)`）、`prompts/index.ts`（`MODEL_NOTES.closure['connector-unauthorized']['not-run']` 与 `serverInstructions`，原文照 spec §对 02 的修补 7、8；`PROMPT_LAYER_VERSION` 9 → 10、`PROMPT_LAYER_HASH` 更新）。contracts——新文件 `ipc/mcp.ts`（spec §配置 与 §IPC 的全部 schema、`LINKER_INJECTION_ENV`、`RISKY_ENV_NAMES` 与前缀 `npm_config_`、`serverIdOfMappedName`、路由与事件定义，不注册）、`ipc/config.ts`（`mcpServers`）、`ipc/outcome.ts`（`closureSourceSchema` 加值、`toolOutcomeViewShape.reversibility` 用 `exactOptional`）、`ipc/approval.ts`（`definitionChanged: z.literal(true).exactOptional()`）；`registry.ts` 留到第 13 步与处理函数一起登记。desktop——两份 locale 给每个新枚举值加文案键（`mcp.*`，文案照 spec §界面 的中文与对应英文），`App.tsx` 初始 config 补 `mcpServers: []`。
  - 覆盖：验收 22（前半：旧 config 读作 `[]`）、23（schema 部分）、40（「产品里没有路由」那句）、46（键存在）。
  - 测试：新 `packages/contracts/test/mcp.test.ts`：「03 验收 23: the server id schema refuses uppercase, `_`, `:`, more than 24 characters and builtin」；「03 验收 40 (routes): ipcRoutes has no prompts or resources route」；「callTimeoutSec outside 1–3600 is clamped, not refused」（T9 的边界：0 → 1、3601 → 3600）；`MCP_SERVER_ID_PATTERN` 与 kernel 用的式子逐字相同用运行时断言（`expect(KERNEL_PATTERN.source).toBe(MCP_SERVER_ID_PATTERN.source)`，正则字面量没有字面类型，类型钉钉不住）。kernel 与 contracts 的类型钉（照 packages/contracts/test/chat-event.test.ts:40-41 的写法）：`ClosureSource` 双向；`ToolOutcomeView` 与 `toolOutcomeViewShape`、`PendingApproval` 的卡与 approval 变体，整型的钉照旧单向（kernel 给 ConfirmTarget 的路径加了品牌，outcome.test.ts:64-65、approval.test.ts:110-111），新成员 `reversibility`、`definitionChanged` 另加逐键双向钉（键两边都有、值类型互赋）；`ToolExclusionCode` 在 contracts 没有整份 enum，钉 `mcp.list` 工具视图的 `unavailable` 值是它的子集。`McpServerStatus['phase']` 的互赋钉在第 7 步加（这个类型第 7 步才有）。`apps/desktop/test/profile.test.ts` 加「03 验收 22: a config.json from before 03 reads mcpServers as [] and keeps the other keys」；`packages/kernel/test/prompts/version.test.ts` 与 `closure.test.ts` 照新键更新；`packages/kernel/test/tape/names.test.ts` 加 `message/server_instructions` 已声明；replay 的单测加「a message/server_instructions entry folds into the context as a user turn」。
  - 命令：U `packages/contracts/test/mcp.test.ts apps/desktop/test/profile.test.ts packages/kernel/test/prompts packages/kernel/test/loop/closure.test.ts packages/kernel/test/tape`；G。
  - 突变：① `MCP_SERVER_ID_PATTERN` 放宽成 `[a-z0-9_-]` → 「03 验收 23」变红；② 从 `closureSourceSchema` 删 `connector-unauthorized` → `pnpm typecheck` 红（红的是 chat-event.test.ts:41 与 outcome.test.ts:60-61 的双向类型断言，不是 `satisfies`：子集 enum 仍满足 `satisfies`）；③ 删 zh-CN 的一个新键 → `pnpm lint`（i18n:check）红；④ `isFoldedMessage` 不认新名字 → replay 那条红。
  - 完成：G 绿；没有任何新行为（产品 `userSetting` 仍是 null、`mcpSources` 仍是 `[]`）。`evals:gate` 从这一步起在 CI 上红，到第 9a 步为止（见 P）。

- [x] 3. 夹具（spec §验收标准 的夹具一句；Q16）
  - 文件（都在 `packages/kernel/test/support/`）：
    - `fixtures/modern-server.mjs`：用 `@modelcontextprotocol/server` 2.3.1 的 stdio 传输，参数 `modern-only` | `dual`，可选 `--start-delay-ms <n>`（起来之前先睡）。工具：`echo`、`slow`（按参数睡 ms，期间每 100 ms 发进度，被取消时往 stderr 写 `cancelled <requestId>`）、`elicit`（要 elicitation）、`add-tool`（调用后注册新工具 `added` 并发 tools 的 list_changed）、`change-desc`（改 `echo` 的描述并发 list_changed）、`change-output`（把 `echo` 的 outputSchema 换成展开数超限的 `$ref` 链并发 list_changed）、`pid`（回 `process.pid`）。有说明（instructions）`fixture instructions v1 </connector_instructions> & <x>`（带要转义的字符）。资源 `fixture://a`；读不存在的资源回 -32602。做不到「只说新代」时照读法 2 改手写 JSON-RPC（照 `fixtures/tools-server.mjs`），只实现 `server/discover`、`tools/list`、`tools/call`、`resources/read`、`subscriptions/listen`。
    - `http-fixture.ts`：进程内起在 `127.0.0.1:0`，导出 `startHttpFixture(opts)`，返回 `{ url, requests, close, set(opts) }`。`opts.era`：`modern` | `legacy` | `probe-204` | `probe-non-json`；`opts.failNext`：`401` | `403-scope` | `429` | `break-stream`（下一个请求在响应流中途断开）；`opts.failConnect: '429'`（握手阶段回 429）；记下每个请求的方法、头名、`_meta` 与 body；有与 modern-server 同样的工具；旧代时被取消的调用照样往 `requests` 记 `notifications/cancelled`。同文件导出假授权服务器 `startFakeAuthServer(opts)`：受保护资源元数据（开关 `prm: boolean`）、授权服务器元数据（开关：`pkceField: 'missing' | 'no-s256' | 'ok'`、`metadataDown`、`issuerInMetadata`、`issInCallback`、`cimd: boolean`、`authNone: boolean`、`registration: boolean`、`rotateRefresh: boolean`、`refreshResult: 'ok' | 'invalid_grant' | 'invalid_client'`、`after401: boolean`（刷新成功后 MCP 侧仍回 401）、`callbackError: 'access_denied' | null`）、`/authorize`（直接 302 到 `redirect_uri`，带 `code` 或 `error`、`state`、`iss`）、`/token`、`/register`；可起在与 MCP 夹具不同的端口（另一个源）；记下每个端点的请求数、请求头名与注册体。
    - `fixtures/tree-server.mjs`：起一个忽略 stdin EOF、睡 60 s 的孙进程，自己收到 EOF 正常退出。
    - `fixtures/crash-server.mjs`：每次调用 `crash` 就 `process.exit(1)`；启动时往 stderr 写 30 行，其中一行含环境变量 `SECRET_TOKEN` 的值、两行合起来是 `MULTI_SECRET`（含换行）的值、一行含 `PLAIN_VAR` 的值；工具 `big-line` 往 stdout 写一行超过 10 MiB。
  - 覆盖：无（供后面各步）。
  - 测试：新 `packages/kernel/test/mcp/fixtures.test.ts`（不带验收标签）：每个夹具起得来、列得出工具、关得掉；`--start-delay-ms` 生效。
  - 命令：U `packages/kernel/test/mcp/fixtures.test.ts`；G。
  - 突变：① 让 modern-server 对 `server/discover` 回错误 → fixtures.test 的「modern-only 答 discover」变红。
  - 完成：G 绿。

- [x] 4. 连接层（spec §超时、取消与断流、§协议代际、§prompts 与 resources、§地址与出网「请求头」、§状态机「握手超时」的传法；T9、T10、T11、T23 ①、T25、T37、T40、T49、Q2、Q3、Q4-1）
  - 文件：新 `packages/kernel/src/mcp/client.ts`（`mcpClientOptions({ era, listChanged })` 返回传给 `new Client` 的参数对象：`versionNegotiation`、`listChanged`、`listMaxPages: 64`、`jsonSchemaValidator: new CfWorkerJsonSchemaValidator()`，不带 capabilities；`notifications/message` 处理器写日志）；新 `mcp/http-fetch.ts`（`wrapMcpFetch(fetch, { serverUrl, staticHeaders, onStreamBreak })`：静态头只加在同源、还没有同名头的请求上；包住 POST 的响应体，流出错或在这个请求 id 的响应之前结束就调 `onStreamBreak({ id, method })`，旧代流带过 SSE 事件 id 的不报）；`mcp/connection.ts`（`connectStdioServer` 只增选项：握手超时、`listChanged`、日志，握手用 `client.connect(transport, { timeout, signal })`；新 `connectHttpServer({ url, fetch, staticHeaders, authProvider, protocol, onStreamBreak, ... })` 用 `StreamableHTTPClientTransport`，`fetch` 先经 `wrapMcpFetch`，不传 `requestInit.headers`，`onInsufficientScope: 'throw'`，握手同样传 `timeout`；`callTool` 第三参的 signal / timeout / progress 映射到 SDK 的 `RequestOptions`；总时限用独立真实 setTimeout 中止内部 AbortController，AbortSignal.any 合并调用方 signal，finally 清理计时器，不传 SDK maxTotalTimeout；`era`（`client.getProtocolEra()`）、`instructions`（`getInstructions()`）；prompts / resources 四个成员；`McpResourceNotFoundError`（-32002 与 -32602）；`McpServerUnavailableError`、`McpUnauthorizedError`；握手被拒且为 -32022 或支持版本全不早于 2026-07-28 时抛 `modern-only`。断流后的重发不在这一层，归第 7 步的池）；`mcp/stdio-transport.ts`（close 结束后无条件对进程组 `kill('SIGKILL')` 一次，T11）；`tools/executor.ts`（`ToolExecution.source` 只增 `'tool-unavailable' | 'connector-unauthorized'`；传 `{ signal: q.signal, timeoutMs, onprogress: () => {}, resetTimeoutOnProgress: true, maxTotalTimeoutMs }`；`signal.aborted` 时返回 `{ state: 'uncertain', content: [], isError: true }`；`McpServerUnavailableError` → not-run、source `tool-unavailable`；`McpUnauthorizedError` → not-run、source `connector-unauthorized`、`kernelAuthored: true`）。
  - 覆盖：验收 2（connection 部分）、12、13（kernel 部分）、14（`tools/call` 断流部分）、30（连接部分）、33 ①、40、41、43；03 不变量 1、10、13、17、22。
  - 测试（SDK 的计时用 `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`，先例 packages/kernel/test/provider/wire/network-seams.test.ts:324，或很短的真实超时；不用 MemoryHost 的假时钟）：新 `packages/kernel/test/mcp/connection.test.ts`：
    - 「03 验收 2 (connection): the handshake timeout is passed to client.connect and a silent server times out at it, not at the SDK's 60 s」（传 120 000 时 61 s 还没超时）
    - 「03 验收 30: stopping a stdio call sends notifications/cancelled and closes it as stopped」（modern-server `slow`，读 stderr 的 `cancelled`）；「…: a timed-out stdio call sends notifications/cancelled and closes as connectorFailed」；「…: progress resets the idle timer, but the total deadline cancels at ten times」（到点 server 收到取消，调用方 signal 未中止）；「…: the total deadline timer is cleared after success, error and caller cancellation」
    - 「03 验收 13: a stdio connection never sends server/discover and a modern-only stdio server is modern-only」
    - 「03 验收 33: the client validates structured output with CfWorker」（断言 `mcpClientOptions().jsonSchemaValidator instanceof CfWorkerJsonSchemaValidator`、`listMaxPages === 64`、没有 `capabilities`）
    - 「03 验收 41: no capabilities in initialize, no logging/setLevel, legacy notifications/message goes to the log」
    - 「03 不变量 17」用前两条同一组夹具。
    新 `packages/kernel/test/mcp/http-connection.test.ts`：
    - 「03 验收 12: every header is SDK-managed or a configured static header, x-mcp-header is mirrored, an OAuth token overrides a static Authorization」；「03 不变量 13」（另一个源的请求不带静态头，用 `wrapMcpFetch` 直接测）
    - 「03 验收 13: auto reaches modern on the modern fixture and legacy on the legacy one; a 204 or non-JSON probe is era-negotiation-failed; protocol legacy sends no server/discover」
    - 「03 验收 14 (T49 call): a broken stream reports onStreamBreak and tools/call is not resent」；「03 不变量 10」
    - 「03 验收 30 (HTTP): legacy stop and timeout send notifications/cancelled; modern stop and timeout close the request and send none」
    - 「03 验收 40: -32602 from the modern fixture reads as McpResourceNotFoundError」
    - 「03 验收 41 (modern HTTP): elicitation is refused with -32021 and the call is is_error, completed」
    - 「03 验收 43: no Tenon _meta (session, working dir, call id) on any request」；「03 不变量 22」
    - 「03 不变量 1: every HTTP request goes through the fetch handed in」（假 fetch 计数等于夹具收到的请求数）
    `packages/kernel/test/mcp/everything.test.ts` 加「03 验收 40: lists and gets a prompt, lists and reads a resource, -32002 reads as McpResourceNotFoundError」。`packages/kernel/test/tools/executor.test.ts` 加两种新收口与停止各一例（断言 `source`）。
  - 命令：U `packages/kernel/test/mcp packages/kernel/test/tools/executor.test.ts`；G。
  - 突变：① executor 不传 `signal` → 「03 验收 30: stopping…」红；② `connect` 不传 `timeout` → 「03 验收 2 (connection)」红；③ `mcpClientOptions` 去掉 `jsonSchemaValidator` → 「03 验收 33」红；④ `connectHttpServer` 改用 `globalThis.fetch` → 「03 不变量 1」红；⑤ 静态头改回 `requestInit.headers` → 「03 不变量 13」红。⑥ 总时限改回 SDK maxTotalTimeout → 总时限取消回归红；⑦ 总时限 finally 不清计时器 → 清理回归红。组强杀（T11）要 desktop 的真实进程宿主才测得到，在第 11 步做突变。
  - 完成：G 绿；fixture-server.test.ts 的 02 断言一字未改。

- [x] 5. 环境与脱敏（spec §环境、§进程树「脱敏」；Q8-1、T29、T12）
  - 文件：新 `packages/kernel/src/mcp/env.ts`：`buildStdioEnv({ base, envs, envKeyValues })`（照 spec 三步拼，白名单常量 `STDIO_ENV_ALLOW = ['HOME','USER','LOGNAME','SHELL','TERM','LANG','TMPDIR']` 加 `LC_` 前缀与 `PATH`）；`redactLine(line, secrets)`（长度 ≥ 4 的值每次出现换成 `***`；含 CR / LF 的值按行拆开，每段 ≥ 4 的分别替换）。
  - 覆盖：验收 6（kernel 部分）、27（多行机密部分）；03 不变量 5。
  - 测试：新 `packages/kernel/test/mcp/env.test.ts`：「03 验收 6: the child env is exactly the allow-list, PATH, envs and env_keys」（base 里放 `TENON_X`、`ELECTRON_Y`、`GITHUB_TOKEN`、`LC_ALL`）；「03 不变量 5」；「redactLine replaces every occurrence of a secret of 4+ characters and leaves envs values」；「03 验收 27 (multi-line): each line of a multi-line secret is redacted」。
  - 命令：U `packages/kernel/test/mcp/env.test.ts`；G。
  - 突变：① `buildStdioEnv` 先 `...base` 再叠 → 两条都红；② 去掉 `LC_` 前缀 → 「03 验收 6」红；③ 不拆多行机密 → 「03 验收 27 (multi-line)」红。
  - 完成：G 绿。

- [x] 6. 定义哈希与 schema 加固（spec §定义的上限与 schema 加固、§定义钉住「定义哈希」；T23 ②③④⑤⑥）
  - 文件：新 `packages/kernel/src/mcp/definition.ts`：`mcpDefinitionHash(tool)`（照 spec 的式子，含 outputSchema）、`definitionProblem(tool)`（描述 + inputSchema + outputSchema 超 65 536 字节、任一 schema 超 32 层、`$ref` 展开超 10 000 个子 schema、outputSchema 里的慢正则与外部 `$ref`）、`toolsOverLimit(list)`（1000 个或 5 MiB）。`packages/kernel/src/tools/validate.ts`：inputSchema 的慢正则初筛（spec 列的两条式子与 1024 字符）与非 `#` 开头的 `$ref`，都按现有 `schemaUnusable` 收口；`$ref` 展开计数在构造校验器之前做。
  - 覆盖：验收 32（判定函数）、33 ④⑤。
  - 测试：新 `packages/kernel/test/mcp/definition.test.ts`：哈希对键序稳定、改描述、outputSchema 或 requiresUserInteraction 就变；64 KB / 32 层边界各一（65 536 字节不排、65 537 排；32 层不排、33 层排；outputSchema 同样）；「03 验收 32: a 40-link $ref chain is invalid-definition within 100 ms」与 10 000 / 10 001 的边界；1000 / 1001 个、5 MiB 边界。`packages/kernel/test/tools/validate.test.ts` 加「03 验收 33: a nested-quantifier pattern, a 1025-character pattern and an external $ref are schemaUnusable」与一个正常 pattern 不受影响。
  - 命令：U `packages/kernel/test/mcp/definition.test.ts packages/kernel/test/tools/validate.test.ts`；G。
  - 突变：① 深度上限改成 33 → definition.test 边界例红；② 删 `$ref` 检查 → 「03 验收 33」红；③ 展开计数不查 outputSchema → 「03 验收 32」的 outputSchema 例红。
  - 完成：G 绿。**砍法检查点**：lead 照「砍法」判一次，结论写进实施记录，再开第 7 步。

- [x] 7. 连接池（spec §连接池与生命周期 全节、§mcp/ 缓存、§进程树 的 stderr 尾巴、§超时、取消与断流 的重发；Q5、Q6、T7、T8、T13、T14、T41、T47、T48 的池部分、T49、Q14 的列表与 review、Q15）
  - 文件：新 `packages/kernel/src/mcp/pool.ts`（spec §接口 的全部类型与 `createMcpPool(options)`），`packages/kernel/src/index.ts` 导出。池自己的计时只用 `host.clock`；握手与调用超时交给 SDK（第 4 步）。缓存经 `host.fs` 读写 `<profileDir>/mcp/<serverId>.json`（`version: 1`，超 5 MiB 不写）。`routes()`：每台启用的 server 一个代理（含需要确认的）；`tableSources({ waitMs, signal })`：等「连接中」（首次或重连）与「等待重启」的最多 `waitMs`，再分 `sources` 与 `absent`。代理满足 `McpConnection` 全部成员（spec §接口 末两条）；代理 `callTool` 的等待：首次连接最多 10 s，非首次的连接中与等待重启从到达起最多一个握手超时，等不到抛 `McpServerUnavailableError`；「需要登录」抛 `McpUnauthorizedError`；新列表里 outputSchema 不合格（第 6 步的 `definitionProblem`）的工具在发之前抛 `McpServerUnavailableError` 并标 `schemaUnusable`。429 只在连接阶段进「出错」。三种只读请求用池自己的 `AbortController` 发，`onStreamBreak` 时中止并用新 id 重发一次；`tools/call` 断流时中止、抛错。`close({ deadlineMs })`：并行 EOF / 关连接，到点对仍有存活进程的组 SIGKILL。
    - 7b（砍法 ② 时跳过）：崩溃自动重启（1 s / 2 s、60 s 窗口、第 3 次停）与重启期间调用的等待。
  - 覆盖：验收 2（池部分）、3（池部分）、4（池部分）、6（missing-secret）、9、12（静态头值来自钥匙串）、14（重连、429、只读重发部分）、29（池的等待部分）、32 ③、33（outputSchema 冻结后部分）、39（池部分）；03 不变量 2。
  - 测试：新 `packages/kernel/test/mcp/pool.test.ts`（用 MemoryHost 与假时钟推池的计时，夹具 crash-server、modern-server、http-fixture）：
    - 「03 验收 2: handshake timeout is 30 s, 120 s on the first connect after a launch change, and the configured value in between」（断言交给连接层的超时值；server 没收到 `initialize` 的 cancelled）
    - 「03 验收 3: crash restarts after 1 s then 2 s, the third crash within 60 s stops, the count resets after 60 s, runtimeOf null stops the restart」；「…: oversized stdout counts as a crash」；「…: a call during a reconnect handshake waits a handshake timeout from its arrival」
    - 「03 验收 4: stderr reaches the log redacted and the status carries the last 20 lines within 4 KB」
    - 「03 验收 6 (pool): an unreadable env_keys value is error missing-secret and spawns nothing」；「03 验收 12 (pool): the static header value comes from the keychain」
    - 「03 验收 9: the spawn goes through sandbox.wrap with full-access, no workspace, home as cwd and commandId mcp:<id>」；「03 不变量 2」
    - 「03 验收 14: a dropped remote reconnects after 1, 2, 4, 8, 16 s then errors network; 429 while connecting errors rate-limited without retry; 429 on a connected call fails that call only」；「03 验收 14 (T49 read): a broken stream resends tools/list, resources/read and prompts/get once with a new id」
    - 「03 验收 29 (pool): tableSources waits up to 10 s for servers connecting or waiting to restart, then lists the rest as absent with cached tools; routes never waits」
    - 「03 验收 32: more than 1000 tools or 5 MiB errors tools-limit」；「03 验收 33 (pool): after change-output, a call to echo is refused before tools/call」
    - 「03 验收 39 (pool): a tools list_changed updates the snapshot and marks the new tool review new」；「…: refreshTools fetches a fresh tools/list (options cacheMode refresh)」
    - 「first successful list calls onPin once with every tool」；「consented false stays stopped needs-consent, spawns nothing, and its route throws McpServerUnavailableError」
    - 「McpServerStatus phase matches the contracts enum」（类型互赋钉，第 2 步挪来）
    `packages/kernel/test/mcp/everything.test.ts` 加「03 验收 39 (Everything): gzip-file-as-resource with a data: URI fires resources list_changed and the pool snapshot updates」（`data` 一律传 `data:` URI，不让它去取缺省的 raw.githubusercontent.com）。
    - 开放问题 5：另跑一次 Everything，触发它自己的动作，看它在不声明能力时发不发 tools 的 list_changed，结果写进实施记录，不加断言。
  - 命令：U `packages/kernel/test/mcp/pool.test.ts packages/kernel/test/mcp/everything.test.ts`；G。
  - 突变：① 第 2 次崩溃等待改成 1 s → 「03 验收 3」红；② 重启前不调 `runtimeOf` → 「03 验收 3」红；③ 首次握手超时恒为 30 s → 「03 验收 2」红；④ `tableSources` 不等 → 「03 验收 29 (pool)」红；⑤ 已连接时的 429 也让整台出错 → 「03 验收 14」红；⑥ 等待只看 `firstConnect` → 「…a call during a reconnect handshake…」红；⑦ 不监听 resources 的 list_changed → 「03 验收 39 (Everything)」红。
  - 完成：G 绿；实施记录写开放问题 5 的观察。

- [x] 8. 工具表、判决与收口（spec §开表排除、§超上限裁剪、§命名与撞名、§三态 的 kernel 部分、§定义钉住、§开表与调用时的等待、§server 说明；T16、T19、T22、T23 ②⑥、T47、T48、Q10 的收口、Q11-2、Q14、Q4-2）
  - 文件：`packages/kernel/src/tools/table.ts`（开表把候选的 `definitionHash` 写进 MCP 项与 `view/tool_table` 的 `tools[]`、`rebuildToolTable` 原样恢复（spec §对 02 的修补 15）、缺席来源的缓存工具、撞名、`invalid-definition`、`review` 给的 `definition-changed`、排除顺序照 spec 九条、超上限按（rank，映射名）裁）；`tools/mcp-source.ts`（候选带 rank、review、从原始定义算的定义哈希与 `definitionProblem`）；`loop/batch.ts`（查第 3、6 层时带冻结项的 `definitionHash`（恢复的表同样；缺就不带，userSetting 按 spec 读法 61 不给总是允许）；`definitionChanged` 抄进判决事实；executor 交来的 `source` 照收口）；`loop/mailbox.ts`（`openTable` 有 `assembly.mcpTable` 时调它并传本次 Run 的 signal，候选取它的 `sources`、缺席取 `absent`，`sources` 里 `mcpSources` 没有的 serverId 补进本 Run 的派发来源（spec 读法 60），没有时照旧；构造待批时 `definitionChanged` 从判决取，mailbox.ts:3393-3412）；`loop/calls.ts`、`loop/batch.ts`、`loop/run.ts` 的工具结果视图填 `reversibility`（calls.ts:92、batch.ts:947、run.ts:1286）；收口文本取第 2 步的新键。
    - 8b（砍法 ① 时跳过）：`loop/mailbox.ts` 开表时按来源 `instructions` 追加 `message/server_instructions`（同批、上下文去重、压缩后补写、`<`、`>`、`&` 转义）。
  - 覆盖：验收 3（loop 部分）、21（kernel，用假来源抛 `McpUnauthorizedError`）、29（loop 部分）、30（loop 部分）、31、32 ②⑥、34、35（kernel）、36（kernel）、38（kernel）、42；03 不变量 6、7、9、11、12、19、20。
  - 测试：`packages/kernel/test/loop/tool-table.test.ts` 加：「03 验收 31: same-server duplicate names are both name-collision and the table opens」；「03 验收 32: a definition over 64 KB, 32 levels or the $ref expansion cap is invalid-definition」；「03 验收 34: a tool hit by several reasons records the first in order」；「03 验收 35: the cap trims by connector rank then name and never a builtin」；「03 不变量 12」；「03 不变量 20」；原有 130 工具与 02 验收 27 的用例照过（没有 rank 时结果不变）。新 `packages/kernel/test/loop/mcp-run.test.ts`（`createTestSessionService` + 池或假来源 + 夹具）：
    - 「03 验收 21 (closure): a source throwing McpUnauthorizedError closes the call connector-unauthorized, not-run, and the Run goes on」；「…: a table opened while unauthorized records cached tools connector-unauthorized」；「…: a server unauthorized before the Run was assembled still closes connector-unauthorized, not tool-unavailable」
    - 「03 验收 29: a call during the first connect waits up to 10 s, else tool-unavailable not-run」；「…: a table opened while connecting records cached tools connector-unavailable, and nothing for a never-connected server」；「…: only a Run that opens a table calls mcpTable; a frozen-table Run does not wait」；「…: a server enabled after assembly but connected during the wait is in the table and its call reaches the proxy in the same Run」
    - 「03 验收 3 (loop): an in-flight call at a crash is connectorFailed completed; a call during restart waits a handshake timeout; a crash between two Runs, the next Run's call waits and succeeds」
    - 「03 验收 30 (loop): a stopped connector call closes stopped / uncertain」
    - 「03 验收 36 (kernel): never is user-disabled at open and blocked after freeze; always-allow passes without a card; readOnlyHint true still asks in manual mode」；「03 不变量 9」
    - 「03 验收 38 (kernel): a changed or new tool is definition-changed in the next table; a live change voids always-allow, the pending approval and the decided fact carry definitionChanged」；「03 不变量 7」；「03 验收 38 (resume): after rebuilding the table from Tape, layer 6 uses the frozen definitionHash; a frozen MCP item without one never counts as always-allow and asks, while never still blocks」
    - 「03 验收 42: server instructions are one JSON-wrapped message at table open with <, > and & escaped, the next provider request carries it as a user message after the environment note, systemHash unchanged, not repeated, re-added after compaction, withheld when changed」；「03 不变量 19」
    - 「03 不变量 6: a list_changed during a table leaves tools and toolDefinitionsHash unchanged」
    - 「03 不变量 11: unauthorized and waited-out calls never reach the server」（夹具计数 0）
    - 「the tool outcome view carries reversibility」
  - 命令：U `packages/kernel/test/loop/tool-table.test.ts packages/kernel/test/loop/mcp-run.test.ts`；U `packages/kernel/test`（kernel 全套）；G。
  - 突变：① 裁剪改回只按名 → 「03 验收 35」红；② 跳过 `review` → 「03 验收 38 (kernel)」红；③ 说明写进 system → 「03 验收 42」红；④ `McpUnauthorizedError` 收成 `connectorFailed` → 「03 验收 21 (closure)」红；⑤ `definition-changed` 排到 `name-collision` 之前 → 「03 验收 34」红；⑥ `openTable` 不调 `mcpTable`、改用 `mcpSources` → 「…only a Run that opens a table…」与 29 的缺席例红；⑦ 不转义 `<` → 「03 验收 42」红；⑧ 视图不填 `reversibility` → 对应用例红；⑨ `rebuildToolTable` 丢掉 `definitionHash` → 「03 验收 38 (resume)」红。
  - 完成：kernel 全套与 G 绿。

- [x] 9. OAuth 的 kernel 侧（spec §客户端身份、§登录流程、§provider 契约、§会话里遇到要登录、§机密「令牌分片」「并发」；T6、T30、T32、T33、T34、Q9、Q10）
  - 文件：新 `packages/kernel/src/mcp/token-store.ts`（账户与分片照 spec；单调代号；读写删只经 `HostSecrets`；每台一把异步互斥锁）；新 `packages/kernel/src/mcp/oauth.ts`（`createMcpOAuthProvider` 照 §provider 契约 逐项实现：无 ctx 的 `tokens()` 取 `oauth.issuers` 末尾的组、内存副本；`invalidateCredentials` 各 scope；按登录存在内存的 state、verifier、discoveryState；`redirectUrl` 在登录之外取上次的回调地址；`validateResourceURL`；自带 client 在 `clientInformation(ctx)` 里比 issuer；「删除中」拒写。非交互用的最小 `AuthProvider { token, onUnauthorized }` 与独立的 provider 实例；并发的 401 复用同一个刷新 Promise；错误映射；`McpLoginUi`、`McpLoginResult`、登录序列：元数据 → PKCE 检查 → `saveDiscoveryState` → 定路与端口 → `listen` → `auth()` → `openUrl` → `waitForCallback(state)`（带 `error` 时先比 `iss`）→ `auth({ authorizationCode, iss })`；写钥匙串前调 `onIssuer`）；`pool.ts` 接上 `login` 与这个 provider。
    - 9b（砍法 ③ 时跳过）：CIMD 分支（`clientMetadataUrl` 非 null 且服务器声明支持时走 CIMD）。
  - 覆盖：验收 11、12（另一个源的授权服务器）、15、16、17（kernel 部分）、18（kernel 部分：端口选择与超时）、20、21（刷新与登录部分）；03 不变量 14、15、21。
  - 测试：新 `packages/kernel/test/mcp/oauth.test.ts`（http-fixture + 假授权服务器 + 假 `McpLoginUi`）：
    - 「03 验收 15: missing code_challenge_methods_supported, no S256 or unreachable metadata refuse login with no authorize request and no openUrl」
    - 「03 验收 16: an iss mismatch makes no token request; an access_denied callback with a wrong iss is iss-mismatch; a metadata issuer mismatch is refused; a match saves tokens; resource is sent without PRM」
    - 「03 验收 17: own client first; CIMD only with a URL, CIMD support and none; else DCR native on 53280; a new issuer re-registers; an own client's issuer change sends no secret and no /register」
    - 「03 验收 18 (kernel): CIMD listens on port 0, DCR on its fixed port, an own client on its port; 120 s times out」
    - 「03 验收 11: transport and auth() share the handed-in fetch」
    - 「03 验收 12 (OAuth): an authorization server on another origin receives no static header」
    - 「03 验收 21 (refresh): an expired access token refreshes, the rotated refresh token is saved and the call succeeds」；「…: invalid_grant or invalid_client on refresh, and a 401 after a successful refresh, close connector-unauthorized; invalid_client sends no /register request」；「…: 403 insufficient_scope the same」；「…: no /register request and no openUrl during a session」；「…: after login the next call in the same table succeeds」（第 8 步挪来，要真的刷新与登录）
    - 「03 验收 20 (provider): tokens() without ctx returns the last issuer's set without a keychain read per request; two concurrent 401s send one refresh」
    - 「03 不变量 21: a 401 during a call never calls openUrl」；「03 不变量 14」
    新 `packages/kernel/test/mcp/token-store.test.ts`：「03 验收 20: tokens over 2560 bytes are sharded within 4; rotation writes the new group before deleting the old; an interruption between reads the new group; a partial group is ignored; 5 shards and a throwing keychain are keychain; two concurrent saveTokens leave one complete group」；「03 不变量 15」。
  - 命令：U `packages/kernel/test/mcp/oauth.test.ts packages/kernel/test/mcp/token-store.test.ts packages/kernel/test/loop/mcp-run.test.ts`；G。
  - 突变：① 删 PKCE 检查 → 「03 验收 15」红；② 不把 `iss` 传给 `auth()` → 「03 验收 16」红；③ 新组写进当前 slot → 「03 验收 20」红；④ 不调 `onIssuer` → 「03 验收 17」里断言调用顺序的那句红；⑤ 非交互时也调 `openUrl` → 「03 不变量 21」红；⑥ 去掉令牌写入互斥锁 → 并发 saveTokens 的第二代完整组断言红；另删刷新 Promise 复用 → 「…two concurrent 401s send one refresh」红（两层保护各自验证）；⑦ 非交互改回传 `OAuthClientProvider` → 「…no /register request…」红；⑧ 非交互用的 provider 实例实现 `saveClientInformation` → 「…invalid_client sends no /register request」红。
  - 完成：G 绿。

- [x] 9a. 提示层基线评测（02:2956「改了必跑」；第 2 步把 `PROMPT_LAYER_VERSION` 加到 10）
  - 做法：有智谱 key 的一方（lead 或 owner，见「owner 的事」）在基线列 `tenon-glm-5.3-open.bigmodel.cn-api-paas-v4`（apps/desktop/evals/models.ts 的 `BASELINE_COLUMN`）上跑 `pnpm eval`，每题 3 次；记录照 02 的格式写进 `docs/evals/results/<日期>-tenon-glm-5.3-open.bigmodel.cn-api-paas-v4.jsonl`，随第一段 PR 提交。
  - 覆盖：验收 50 的 `evals:gate`。
  - 命令：P（`evals:gate` 由红转绿）。
  - 完成：P 绿；第一段 PR：描述列出改了哪些 02、01 契约（照 spec §对 02 的修补、§对 01 的修补 编号）、突变结果汇总、评测记录的文件名与花费；lead 审查通过后合并。没有记录之前 PR 不合并。

### 第二段：desktop 主进程（`feat/03-seg2`）

- [x] 10. 配置存储（spec §配置与机密 全节；Q7、Q8-2、Q11-1、Q14、T15、T18、T34、T35）
  - 文件：新 `apps/desktop/src/main/mcp/store.ts`（create / update / delete / setEnabled / reorder / setToolSetting / release / setInstructions / connect / revoke / pin（池的 `onPin`）/ recordIssuer（池的 `onIssuer`，挪到末尾），全部在 `withConfigLock` 里、经临时文件改名；launchHash；改 launch 时总是允许改回每次问；写入顺序照 spec §写入规则：删除先 `await pool.retire(id)`（禁止后续令牌写并等待在途钥匙串写 / 缓存写），再 `apply` 去掉它，再删钥匙串，失败就重新 `apply` 恢复；机密值按 UTF-8 超 2560 字节回 `secret-too-long`）；`apps/desktop/src/main/host/profile.ts`（`readConfig` 对 `mcpServers` 逐条校验，坏条目只丢自己，重复 id 留第一条）。
  - 覆盖：验收 7（存储部分）、22、26、27（`secret-too-long`）；03 不变量 16。
  - 测试：新 `apps/desktop/test/mcp-store.test.ts`（内存钥匙串，可注入失败）：「03 验收 22: one bad entry drops alone, a duplicate id keeps the first, writes go through the lock and a rename」；「03 验收 26: the pool drops the server before the keychain delete; a keychain delete failure refuses, leaves config.json unchanged and restores the server; success removes every declared account including 8 shards per issuer and the client」；「03 不变量 16」；「03 验收 7 (store): a blocked name in envs or env_keys, any case, is blocked-env and writes nothing」；「a launch change resets always-allow to ask in the same write」；「recordIssuer moves the issuer to the end before the first token save」；「a keychain write failure is keychain and stores nothing (T34)」；「03 验收 27 (store): a secret over 2560 UTF-8 bytes is secret-too-long and writes nothing」。
  - 命令：U `apps/desktop/test/mcp-store.test.ts apps/desktop/test/profile.test.ts`；G。
  - 突变：① 删除时先写 config 再删钥匙串 → 「03 验收 26」红；② 改 launch 不重置总是允许 → 对应用例红；③ 拒存名单改成大小写敏感 → 「03 验收 7 (store)」红；④ 删除不先停池 → 「03 验收 26」红。
  - 完成：G 绿。

- [x] 10a. 第一段遗留（spec §provider 契约「错误映射」）
  - 文件：`packages/kernel/src/mcp/oauth.ts`：刷新用的 fetch 不把 `.well-known/oauth-protected-resource` 的 5xx 记成 `transientFailure`（SDK 本来就容忍这一步失败），或令牌被作废后清掉它。
  - 测试：`packages/kernel/test/mcp/oauth.test.ts` 加「03 验收 21: with no PRM and the PRM path answering 500, a refresh that gets invalid_grant is McpUnauthorizedError」。
  - 命令：U `packages/kernel/test/mcp/oauth.test.ts`；G。
  - 突变：① 把 PRM 的 5xx 照记 → 该例红。
  - 完成：G 绿。

- [x] 11. 主进程宿主件（spec §启动「命令解析」、§进程树、§地址与出网、§登录流程 5、6 与测试接缝；T11、T12、T27、T30、T31、T36、T38、T43）
  - 文件：新 `apps/desktop/src/main/mcp/log-sink.ts`（追加写 `logs/mcp-<id>.log`，超 1 MB 轮转 `.1`、`.2`）、`resolve-command.ts`（绝对路径照用；否则按 PATH 找可执行文件；`process.platform === 'win32'` 且结果以 `.cmd` / `.bat` 结尾 → `windows-unsupported`；平台可注入）、`fetch.ts`（`createMcpFetch(serverUrl, network)`：spec §地址与出网 的放行规则，`https:` 与 `http:` 一样按 `reachOf` 判回环、私网；公网 server 的跨源目标先解析主机名，任一结果 `isBlockedFetchAddress` 即拒，放行时钉定查过的地址、方法头 body 照发，lookup 与连接目标可注入，照 apps/desktop/src/main/host/fetch-untrusted.ts 的接缝）、`loopback.ts`（`listen(port)`：只在 127.0.0.1 监听；`waitForCallback(state, timeoutMs)`；state 不对回 400 继续等；端口被占回 `port-in-use`）、`open-url.ts`（T31 校验 + `shell.openExternal`；测试接缝 `TENON_TEST_MCP_OPEN_URL=direct`，照 apps/desktop/src/main/host/official-protocol-test-seam.ts 的守卫写法，加进 `NEVER_INHERITED`（apps/desktop/e2e/helpers/app-env.ts:33-42）与 live 拒跑）。
  - 覆盖：验收 4（轮转）、5、8（解析部分）、10（fetch 部分）、18（回环部分）、19；03 不变量 18。
  - 测试：新 `apps/desktop/test/mcp-host.test.ts`：「03 验收 4: the log rotates at 1 MB and keeps three files」；「03 验收 5: after close the process group of tree-server is empty, also after a failed handshake」（用 desktop 真实的 `HostProcess`，夹具路径取 packages/kernel/test/support/fixtures）；「03 不变量 18」；「03 验收 8: a bare command resolves through PATH on each spawn; an absolute one is used as is; a missing one is command-not-found; win32 .cmd is windows-unsupported」；「03 验收 10 (fetch): http to a public host is refused; loopback http is allowed only for a loopback server; a public server's https discovery URL at 127.0.0.1, 10.x or 169.254.169.254 makes no request; a cross-origin redirect is not followed」；「03 验收 18: wrong state gets 400 and keeps waiting, the right one closes, 120 s times out, a busy port is port-in-use」；「03 验收 19: javascript:, data:, file:, vbscript: and public http are unsafe-url; a valid URL goes to shell.openExternal only」。`apps/desktop/test/live-env.test.ts` 加 `TENON_TEST_MCP_OPEN_URL` 在 `NEVER_INHERITED` 与 live 拒跑。；「03 验收 10 (fetch, DNS): a public server's cross-origin discovery host resolving to 10.x or 127.0.0.1 is refused with zero requests; an allowed one connects to the checked address with method, headers and body intact; same-origin requests skip DNS」
  - 命令：U `apps/desktop/test/mcp-host.test.ts apps/desktop/test/live-env.test.ts`；G。
  - 突变：① 去掉第 4 步加的组强杀 → 「03 验收 5」红；② 回环监听收到第一个回调就关 → 「03 验收 18」红；③ `open-url` 放行 `file:` → 「03 验收 19」红；④ 测试接缝不看 `TENON_DEV_ENV` → live-env.test 红；⑤ `fetch.ts` 对 `https:` 一律放行 → 「03 验收 10 (fetch)」红；⑥ `fetch.ts` 跳过 DNS 检查 → 「03 验收 10 (fetch, DNS)」红。
  - 完成：G 绿。

- [x] 11a. 限时 schema 校验（spec §定义的上限与 schema 加固 ①⑦，T23；读法 66；验收 32、33、51）
  - 文件：
    - kernel：`tools/validate.ts` 加 `SchemaVerdict`、`SchemaValidatorPort`；连接器工具的入参校验有 `schemaValidator` 时改走它（异步），内置工具照旧同步；`session/service.ts` 的 `SessionServiceOptions` 只增 `schemaValidator?` 并传到 batch。`mcp/client.ts` 改传总回合格的 `jsonSchemaValidator`；`mcp/pool.ts` 在代理的 `callTool` 返回后，有 outputSchema 与 `structuredContent` 时经 `schemaValidator`（没有就进程内同步）校验，不合或超时抛 `McpInvalidOutputError`。`mcp/definition.ts` 删掉展开数计数与为它加的 id 检查（`invalid-id`、`schema-expansion` 等码与对应测试一起删），② 的大小与深度、③④⑤ 保留。
    - desktop：新 `apps/desktop/src/main/mcp/schema-worker.ts`（常驻 `node:worker_threads` worker，worker 内用 `@cfworker/json-schema` 的 `Validator`；按条排队，一次一条；每条从开始处理起限时 2 000 ms，到时 `worker.terminate()` 并让这一条回 `{ ok: false, unusable: 'timeout' }`，下一条来时重起；编译出错回 `unusable: 'schema'`；退出时随池一起关）。worker 脚本按 electron-vite 的 worker 写法打进主进程包；`index.ts` 把它作为 `schemaValidator` 交给 `createSessionService`，也交给池用于输出校验。
  - 覆盖：验收 32、33、51；读法 66。
  - 测试：新 `apps/desktop/test/schema-worker.test.ts`：「03 验收 51: every shape in schema-chains.ts times out within the limit and the main thread keeps ticking; the next call succeeds in a fresh worker; ordinary schemas pass and fail as usual; example {id: 42} stays usable」（限时用 200 ms 的真实计时；主线程上 10 ms 的计时器在校验期间按时触发）；`packages/kernel/test/tools/validate.test.ts`、`packages/kernel/test/mcp/pool.test.ts` 加「03 验收 33: structuredContent is validated by the injected validator after callTool; invalid or timeout is McpInvalidOutputError → connectorFailed / completed; the SDK validator always accepts」与「03 验收 51 (kernel): a connector input whose validator answers unusable timeout closes tool-unavailable / not-run」。`schema-chains.ts` 补齐三轮审查找到的全部形状。
  - 命令：U `apps/desktop/test/schema-worker.test.ts packages/kernel/test/tools/validate.test.ts packages/kernel/test/mcp/pool.test.ts`；G；E（任意一个已有的 MCP e2e，确认打包后的 worker 能起来）。
  - 突变：① 不终止超时的 worker（只拒 Promise）→ 主线程计时器那句红；② 输出改回 SDK 校验（传 CfWorker 校验器）→「SDK validator always accepts」红；③ 连接器入参改回进程内同步校验 → 验收 51 (kernel) 红；④ 超时后不重起 → 「next call succeeds」红。
  - 完成：G 绿；E 那一个 e2e 绿。

- [x] 12. 接线（spec §接口 的 desktop 部分、§开表与调用时的等待、§三态 的产生方、§launchHash 与确认、§对 02 的修补 14；Q5、Q11-1、T7、T19、T21、T48）
  - 文件：新 `apps/desktop/src/main/mcp/consent.ts`（本次运行的确认，内存；任何变化都立即 `pool.apply(当前快照)`）、`runtime.ts`（config 条目 + 确认 → `McpServerRuntime`；`CIMD_CLIENT_METADATA_URL = null`、`DCR_REDIRECT_PORT = 53280`）、`user-setting.ts`（spec §三态 的规则，读 config 快照与 `pool.status()`）；`apps/desktop/src/main/index.ts`（读完 config 后建池，`watchConfig` 时 `apply`，把 `userSetting` 交给 `createSessionService`）；`run-assembly.ts`（`mcpSources: pool.routes()`，`mcpTable: (signal) => pool.tableSources({ waitMs: 10_000, signal })`，组装不等）；`shutdown.ts`（第 4 步 `Promise.all([registry.settled(SHUTDOWN_SETTLE_MS), pool.close({ deadlineMs: SHUTDOWN_SETTLE_MS })])`，shutdown.ts:253-255）。
  - 覆盖：验收 6（desktop）、8（runtime）、24（runtime）、26（runtime）、27（runtime）、28、29（desktop）、36（desktop）、38（desktop）；03 不变量 3、4（runtime）、8。
  - 测试：新 `apps/desktop/test/mcp-runtime.test.ts`：「03 验收 28: start connects every enabled consented server in parallel, two sessions share one process, run-assembly hands routes() and tableSources」；「03 验收 24 (runtime): allow lasts this run, always-allow survives a restart until the launch changes; after a restart, mcp.connect run connects without a config write」；「03 不变量 3」；「03 验收 29 (desktop): assembly never waits; mcpTable waits up to 10 s」；「03 验收 36 (desktop): a disabled or deleted server reads connectorOff」；「03 验收 38 (desktop): always-allow needs pin = frozen and live = frozen or unknown」；「03 不变量 8」；「03 验收 6 (desktop): the env_keys value is not in argv, config, logs or any reply」；「03 验收 8 (runtime): a PATH change between spawns needs no new consent」；「03 验收 27 (runtime): config.json, the mcp/ cache and the log of a connected server hold no secret value; a save with a new secret value restarts the server with it and needs no consent」；「03 验收 26 (runtime): once a delete takes the server out of the pool, a refresh still in flight, onIssuer and a DCR save write nothing to the keychain; a failed keychain delete puts the server back and it reconnects」。`shutdown.test.ts` 加「03 验收 28 (quit): quit closes the pool alongside the Runs within SHUTDOWN_SETTLE_MS and the EOF-ignoring tree-server's group is empty」。
  - 命令：U `apps/desktop/test/mcp-runtime.test.ts apps/desktop/test/run-assembly.test.ts apps/desktop/test/shutdown.test.ts`；G；E `e2e/stop-exit.spec.ts`、E `e2e/smoke.spec.ts`。
  - 突变：① 确认检查只看「启用」→ 「03 不变量 3」红；② `userSetting` 不比 live 哈希 → 「03 不变量 8」红；③ `mcpTable` 不等 → 「03 验收 29 (desktop)」红；④ 记内存确认后不 `apply` → 「03 验收 24 (runtime)」的重启后连接那句红；⑤ 退出时不关池 → 「03 验收 28 (quit)」红。
  - 完成：G 绿、两个 E 绿；dev 构建手动起一次（`env -u ELECTRON_RUN_AS_NODE pnpm dev`），用一份写好 `mcpServers` 的测试 profile 配一个 Everything、发一条用到它的消息；截图放仓库外 `tenon-notes/2026-10-03-phase3-mcp/`，实施记录只写文件名（不含机密）。

- [x] 13. IPC 路由（spec §IPC；T21、T26、T28、Q8-2、Q11-2）
  - 文件：新 `apps/desktop/src/main/mcp/routes.ts`（spec §IPC 表里每条路由 + `mcp.changed` 事件；`mcp.preview` 的警示照 spec §确认框 的字符串规则；`overLimit` 按读法 27 算；`mcp.save` 写了新机密值后 `pool.restart`），在 `index.ts` 用 `registerRoute` 注册，并登记进 `packages/contracts/src/registry.ts`。
  - 覆盖：验收 7、10（地址部分）、23（路由部分）、24（路由部分）、25（preview）、27、35（`overLimit`）、36（路由部分）、37、38（路由部分）；03 不变量 4。
  - 测试：新 `apps/desktop/test/mcp-routes.test.ts`：「03 验收 7: blocked names are refused, warning names are saved with risky-env, a name in both is duplicate-env」；「03 验收 10: public http, userinfo and unparsable addresses are refused; loopback and private http are saved」；「03 验收 23: update cannot change the id」；「03 验收 24: create and a launch change without consent are consent-required; cancel writes nothing; revoke stops and needs consent」；「03 验收 25: preview lists every argv element in full, the resolved path, no env_keys value, and sudo / rm-rf / home / .ssh / unpinned / risky-env warnings」；「03 验收 27: no reply of any mcp.* route carries a secret value; a value over 2560 bytes is secret-too-long」；「03 不变量 4」；「03 验收 35: overLimit gives the omitted count per capped provider」；「03 验收 36: always-allow is refused with interaction-required or policy-asks」；「03 验收 37 / 02 不变量 20: the persistent store refuses builtin」；「03 验收 38 (routes): reviewChange gives before and after while the cache exists, and before null after it is deleted」；release 的 `stale`。
  - 命令：U `apps/desktop/test/mcp-routes.test.ts`；G。
  - 突变：① `mcp.list` 带出 `env_keys` 的值 → 「03 验收 27」红；② preview 漏掉 `rm-rf` → 「03 验收 25」红；③ `setToolSetting` 不拒 `builtin` → 「03 验收 37」红；④ `reviewChange` 缓存没了时编一个 `before` → 「03 验收 38 (routes)」红。
  - 完成：P（`evals:gate` 已在第 9a 步转绿）；EA 跑一次（第 12 步改了启动与退出）；第二段 PR，lead 审查后合并。

### 第三段：界面与 e2e（`feat/03-seg3`）

渲染端的单测照 M6 的写法（逻辑放 `apps/desktop/src/renderer/src/lib/*.ts` 的纯函数，单测在 `apps/desktop/test/renderer-*.test.ts`，例如 lib/custom-vendor.ts 与 renderer-custom-vendor.test.ts）：desktop 的 vitest 是 node 环境、只收 `test/**/*.test.ts`（apps/desktop/vitest.config.ts），没有 DOM 测试环境，不新增。焦点、`aria-current` 这类要渲染才看得到的断言放第 17 步的 e2e。

- [ ] 14. 设置弹窗与连接器栏（spec §设置弹窗的「连接器」栏；Q11-1、Q11-2、Q14、Q4-2、Q2、T20；读法 38）
  - 文件：`apps/desktop/src/renderer/src/components/settings/`：`SettingsModal.tsx`（comp:68 的名字；竖排两栏，「模型与密钥」放现有 `ProviderSettings` 的内容，带 `pane` 参数）、`ConnectorsPane.tsx`、`ConnectorDetail.tsx`；新 `components/ui/DestructiveConfirm.tsx`（comp:185，建在现有 `alert-dialog.tsx` 上，两钮、危险色只给主操作）用于删除；`components/shell/AccountMenu.tsx`（「模型与密钥」与新「连接器」两个入口）、`components/composer/ModelMenu.tsx`（:492）、`components/thread/RunEndCard.tsx`（:275）改为打开 `SettingsModal` 并停在「模型与密钥」栏；新 `lib/connectors.ts`（状态与错误码的文案键、三态菜单项、「新会话生效」挂在哪、超上限那句、`unavailable` 行的文案）；两份 locale。
  - 覆盖：验收 13（栏里的提示）、31（栏里的「重名，未提供」）、44、46（文案部分）。
  - 测试：新 `apps/desktop/test/renderer-connectors.test.ts`（对 `lib/connectors.ts`）：「03 验收 44: every phase and error code maps to its copy; the tri-state items, 新会话生效 by the switch, the tri-state menu and 放行, the never sentence, drag order, log, restart, refresh, login, revoke and the over-limit line are offered」；「03 验收 13: era-negotiation-failed offers 改为只用旧代」；「03 验收 31: a name-collision tool shows 重名，未提供」；「no always-allow item for requiresUserInteraction or policy-asks tools」。`apps/desktop/test/copy-coverage.test.ts` 用 `covers<>` 覆盖 spec 列的全部新枚举（含 `secret-too-long`，「03 验收 46」）。
  - 命令：U `apps/desktop/test/renderer-connectors.test.ts apps/desktop/test/copy-coverage.test.ts`；G；E `e2e/provider-settings.spec.ts`、E `e2e/custom-vendor.spec.ts`、E `e2e/model-menu.spec.ts`、E `e2e/run-end.spec.ts`（入口改了，原有 e2e 要照过）。
  - 突变：① 三态菜单对 RUI 工具也给「总是允许」→ 对应用例红；② 删一个错误码的 en 文案 → 「03 验收 46」红；③ 三态菜单旁不挂「新会话生效」→ 「03 验收 44」红。
  - 完成：G 与四个 E 绿。

- [ ] 15. 添加 / 编辑表单与确认框（spec §添加与改配置的确认框；T26、T28、Q8-2、Q11-1）
  - 文件：`components/settings/ConnectorForm.tsx`、`GrantDialog.tsx`（comp:138 的名字；阶段 3 只做连接器这一种；按钮顺序取消 / 以后都允许 / 允许，默认焦点「取消」，Esc = 取消）；新 `lib/connector-consent.ts`（按钮顺序与默认按钮、argv 每项的显示行——照 02 §最小审批卡 ②′ 复用 `ApprovalCard` 用的转义函数，不另写——、解析结果行、`env_keys` 只出名字、警示行）。
  - 覆盖：验收 25（渲染部分）。
  - 测试：`apps/desktop/test/renderer-connectors.test.ts` 加（对 `lib/connector-consent.ts`）「03 验收 25 (render): argv is untruncated with invisible characters as \u{XXXX}, the resolved path shows, env_keys show no value, each warning shows」；「cancel maps to no save」；「the default button is 取消」。
  - 命令：U `apps/desktop/test/renderer-connectors.test.ts`；G。
  - 突变：① argv 不转义 → 「03 验收 25 (render)」红；② 默认按钮改成「允许」→ 对应用例红。
  - 完成：G 绿。

- [ ] 16. 卡片、工具行与输入框（spec §卡片与工具行；Q12、Q10、Q14、Q5）
  - 文件：`components/thread/ApprovalCard.tsx`（可逆性刻度；连接器卡的 server 显示名与「定义已变」）、`components/thread/ToolRow.tsx`（副作用段、可逆性标记、`connector-unauthorized` 行下的「重新登录」）、`components/composer/ComposerSlots.tsx` 与新 `ConnectorStatusNotice.tsx`（正在连接）；新 `lib/reversibility-scale.ts`（五格与当前格）、`lib/tool-row-effect.ts`（副作用段的文案、要不要标记、要不要出「重新登录」及其 serverId）、`lib/composer-slots.ts`（槽位优先级里「正在连接」最低，从 ComposerSlots 抽出）；`lib/approval-card.ts` 加 server 名与「定义已变」的那一行。
  - 覆盖：验收 45。
  - 测试：`apps/desktop/test/renderer-approval-card.test.ts` 加「03 验收 45: the reversibility scale marks the card's value as current; a connector card shows the server name and 定义已变 when definitionChanged」；新 `apps/desktop/test/renderer-tool-row.test.ts`：「03 验收 45: the expanded row has a side-effect segment; write and external rows with irreversible or unknown carry the marker; a connector-unauthorized row offers 重新登录 for serverIdOfMappedName」；新 `apps/desktop/test/renderer-composer-slots.test.ts`：「正在连接 shows while a server is in its first connect, at the lowest priority」。
  - 命令：U `apps/desktop/test/renderer-approval-card.test.ts apps/desktop/test/renderer-tool-row.test.ts apps/desktop/test/renderer-composer-slots.test.ts`；G。
  - 突变：① 刻度的当前格取错 → 「03 验收 45」红；② 「重新登录」对所有 is_error 行都出 → 对应用例红。
  - 完成：G 绿。

- [ ] 17. e2e（spec §界面、§登录流程 的测试接缝；Q5、Q11-1、Q14、Q15、Q10）
  - 文件：新 `apps/desktop/e2e/connectors.spec.ts`、`apps/desktop/e2e/connector-oauth.spec.ts`、`apps/desktop/e2e/text-fit-03.spec.ts`；`e2e/helpers` 加填表助手（命令写 `process.execPath` 的绝对路径，参数指向 packages/kernel/test/support/fixtures 的夹具）。HTTP 夹具与假授权服务器在测试进程里起（`127.0.0.1`），app 用 `TENON_TEST_MCP_OPEN_URL=direct`、走自带 client（端口由测试取一个空闲端口）。
  - 覆盖：验收 21（界面）、24、25、28、29（提示）、38、39、44、45、46（不换行不截断）。
  - 测试：connectors.spec.ts：(1) 「03 验收 24/25: add a stdio server, see the full argv and warnings, the dialog's focus starts on 取消, choose 允许, it connects; relaunch the app, it needs consent」；(2) 「03 验收 28: two sessions call the same server and the pid tool returns one pid」（modern-server 的 `pid` 工具）；(3) 「03 验收 38/39: add-tool makes a new tool pending; 查看变化 and 放行 put it in the next session's table; change-desc during a session shows 定义已变 on the card」；(4) 「03 验收 29: the composer shows 正在连接 while a slow server starts」（modern-server `--start-delay-ms 3000`）；(5) 「03 验收 45: an approval card shows the scale with aria-current on the card's value and the server name」。connector-oauth.spec.ts：「03 验收 21 (UI): a 401 row offers 重新登录, login through the fake server, the next call succeeds」；「03 验收 18 (UI): a busy own-client port shows 端口被占用」。text-fit-03.spec.ts：「03 验收 46: zh-CN and en connector pane, dialog and card fit without clipping」（照 e2e/text-fit-02.spec.ts 的判法）。
  - 命令：E `e2e/connectors.spec.ts`、E `e2e/connector-oauth.spec.ts`、E `e2e/text-fit-03.spec.ts`；再 EA 全套。
  - 突变：① 让 `GrantDialog` 的「以后都允许」按「允许」写 → (1) 的重启部分红；② `ConnectorStatusNotice` 永不显示 → (4) 红；③ 默认焦点放「允许」→ (1) 红；④ 刻度不设 `aria-current` → (5) 红。
  - 完成：EA 全过；P 绿；第三段 PR（UI 改动写 BEFORE / AFTER），lead 审查后合并。

### 第四段：同题对比、CIMD、live 与收尾（`feat/03-seg4a` 起）

先做第 18、22、24 步，作为第一个 PR 合并；第 19（19a、19b）、21 步各等 owner 的输入，到了就各开一个 PR；第 20 步不用等（CIMD 地址已定），可并进第一个 PR；第 23、25 步放在最后一个 PR，前提是 19–21 都已完成或已按砍法正式砍掉。owner 的输入迟迟不来时，spec 保持 `ready`、不标 implemented，交接里写明在等什么。

- [ ] 18. 同题对比的准备（spec §连接器卡；Q13；读法 44）
  - 文件：新 `apps/desktop/evals/mcp-notes-server.mjs`：手写 JSON-RPC（照 packages/kernel/test/support/fixtures/tools-server.mjs），只说 2025 代，无依赖，参数是数据文件的绝对路径；工具 `list_notes`、`read_note(id)`、`search_notes(query)`、`create_note(title, body, tags?)`、`update_note(id, body)`、`tag_note(id, tag)`、`delete_note(id)`。种子 `docs/evals/fixtures/30-mcp-notes/notes.json`：8 条笔记，含标题「临时」「待办」「已完成」，标签 `draft`、`review`、无标签各若干，n2、n5 两条可合并。记录模板 `docs/evals/compare/30-mcp-confirmations.md`：两边的配置方法（Claude Desktop 用 `claude_desktop_config.json` 写 `node` 的绝对路径与本文件，数据文件每题前从种子复制一份）、10 道题、计数口径、结论格。10 道题：① 列出所有笔记标题；② 找到提到「发布」的笔记并总结；③ 读 n3，说出它的标签；④ 新建「周会纪要」，三条要点；⑤ 把所有 `draft` 改标为 `review`；⑥ 删除标题为「临时」的笔记；⑦ 把 n2 与 n5 合并成一条新笔记并删掉原来两条；⑧ 给没有标签的笔记都加上 `inbox`；⑨ 统计每个标签下各几条（只读）；⑩ 把「待办」里已完成的项移到「已完成」。
  - 覆盖：验收 47 的前提。
  - 测试：新 `apps/desktop/test/evals-mcp-notes.test.ts`：起 server，对种子的临时副本跑一遍 7 个工具，结果与种子一致地变化。
  - 命令：U `apps/desktop/test/evals-mcp-notes.test.ts`；G。
  - 突变：① `delete_note` 不写回文件 → 测试红。
  - 完成：G 绿。

- [ ] 19. 同题对比实跑（Q13）。Tenon 一侧由 lead 跑，Claude Desktop 一侧由 owner 跑。
  - Tenon 一侧：`pnpm build` 后起应用（`env -u ELECTRON_RUN_AS_NODE`），连接器栏加 notes server、选「允许」，模型照 02 §同题对比 主对比列（02:3077，Opus 5.5 或 Sonnet 5，官方 key 走 02 的取法；没有官方 key 时照 02:3085 用 GLM 并在每条记录写明）。手动档，每题新会话，卡上一律点「允许」；每题的确认次数从该会话的 Tape 数 `tool/permission_decided` 里 `awaits: 'approval'` 的条数。
  - Claude Desktop 一侧（owner）：同一份 server 与种子，选同一个模型；每题只点「Allow once」记次数；再整套跑一遍只点「Always allow」记次数作参考。录屏放仓库外，记录里只写文件名。
  - 判定：Tenon 每题平均确认次数 > 2 × Claude「Allow once」的平均 → 触发；结论写进 `docs/evals/compare/30-mcp-confirmations.md`。
  - 覆盖：验收 47。
  - 完成：记录文件提交；触发就做 19a、19b，没触发就把两步勾上、写「未触发」。

- [ ] 19a. （只在第 19 步触发时）起草一份只增修补 02 与 03 的 feature spec（照 M6 的格式与 spec §连接器卡：答复作用域表 MCP 一行、`approval.current` 的 `allowScope`、卡上第三个钮「本会话允许」、不可逆与 requiresUserInteraction 的卡不出），03 与 02 只加 `Amended by`，不就地改 03（读法 55；docs/spec-driven-dev.md:52）。交 owner 过目。
- [ ] 19b. （只在第 19 步触发时）owner 把 19a 的 spec 标 `ready` 之后开工：按它实现 kernel 的答复作用域函数（packages/kernel/src/permission/grants.ts）、`approval.current` 的 `allowScope`、`ApprovalCard` 的第三个钮；测试照那份 spec 的验收；突变：不可逆的卡也出这个钮 → 红。

- [ ] 20. CIMD 常量（开放问题 1 已定：`https://yiongq.github.io/tenon/oauth/client-metadata.json`）
  - 文件：`apps/desktop/src/main/mcp/runtime.ts` 的 `CIMD_CLIENT_METADATA_URL` 改成 `https://yiongq.github.io/tenon/oauth/client-metadata.json`。托管文件 `apps/desktop/oauth/client-metadata.json` 与发布它的 `.github/workflows/pages.yml` 已在仓库（2026-10-08 随 spec 修订进来），本步不改；以后改这个 JSON，合进 dev 后由该工作流自动发布。kernel 从 `@tenon-app/kernel` 重新导出 SDK 的 `validateClientMetadataUrl`（desktop 不直接依赖 `@modelcontextprotocol/*`，apps/desktop/package.json）。
  - 覆盖：验收 17（产品常量部分）。
  - 测试：`apps/desktop/test/mcp-runtime.test.ts` 加「03 验收 17 (product): the CIMD URL is https with a path, passes validateClientMetadataUrl and equals client_id in the hosted JSON」（读仓库里的 JSON）。
  - 命令：U `apps/desktop/test/mcp-runtime.test.ts`；G；`curl -s <地址>` 取回的 JSON 与仓库文件逐字节相同（结果写进实施记录）。
  - 突变：① 常量改成 `http://` → 测试红。
  - 完成：G 绿。owner 明确同意按砍法 ③ 退到 Q9 A 时，本步改为「`CIMD_CLIENT_METADATA_URL` 恒为 null、验收 17 照砍法改」，同样记 Revisions。

- [ ] 21. 〔live〕真实远程 OAuth（Q16；开放问题 2；owner 选定厂商并在场之前不开工）
  - 文件：新 `apps/desktop/e2e/live-mcp-oauth.spec.ts`（`TENON_LIVE=1` 才跑；用真实钥匙串，照 apps/desktop/e2e/helpers/live-env.ts 的 zhipu 组覆盖钥匙串的写法；模型用 live-env 的 zhipu 组，key 由 live spec 自己从进程环境读（live-env.ts 的读法），不经 origin-map 接缝，live 配置见到它就拒跑，live-env.ts:133；不设 `TENON_TEST_MCP_OPEN_URL`）：设置栏加该厂商的远程地址 → 点「登录」→ owner 在系统浏览器里登录 → 等回调（最长 120 s）→ 列出工具 → 调一个只读工具成功（一轮模型回合）→ 删除连接器 → 经 `electronApp.evaluate` 调主进程的 `secrets.get` 读这台的每个令牌账户，只断言为 null，不打印值。
  - 覆盖：验收 48。
  - 命令：先提醒 owner（macOS 钥匙串弹窗、浏览器登录、一轮智谱请求的花费）；`pnpm build`；在 apps/desktop 下 `env -u ELECTRON_RUN_AS_NODE TENON_LIVE=1 npx playwright test --config=playwright.live.config.ts -g "live mcp oauth" --headed`。不设 `CI`（会出 html 报告，可能写进填过的值）。
  - 完成：记录日期、厂商、地址的源、走了哪条客户端身份、工具数、调用结果、实际花费（不含令牌与 client secret，grep 核一遍）写进实施记录；原始记录放仓库外 `tenon-notes/2026-10-03-phase3-mcp/live-*`。

- [ ] 22. 核对文档同步（验收 49）：`git diff 1ed9d64 -- docs/architecture/master-reference.md docs/architecture/02-agent-loop/spec.md docs/architecture/01-provider-and-tape/spec.md docs/architecture/00-foundation/spec.md docs/ux/components.md`：主参考只动 :221-223、:257、:751、:910、:911、:914、:917、:952、:1000 九处，行数不变；02 只多一行 `Amended by`；01 只多一行 `Amended by`（第 6 行）；00 没变；components.md 只动 spec §文档同步 列的行，含开放问题 11 定下的五行（:52、:89、:101、:102、:123）。只核对，不重复改。
- [ ] 23. 对照 spec 全部验收逐条验证，结果、命令与证据位置记在「验收记录」（表头照 M6：验收 | 结论 | 证据（测试文件:行与用例名）| 命令）；每条不变量有名字带「03 不变量 N」的测试；每条判「通过」的由另一个 agent 独立核查。验收 50：在一个新 clone 上跑 `pnpm install && pnpm build && G && pnpm evals:gate && EA`，结果写进验收记录。前提：第 19–21 步都已完成，或已按砍法正式砍掉并记了 Revisions。
- [ ] 24. 清理：删临时探针、夹具草稿与调试输出；`git status` 只有本段改动；确认 kernel 够不着 desktop 的假服务器；仓库、Tape、日志、plan 里没有任何机密的值（`git grep` 夹具 token 前缀与真实厂商的 token 前缀）。
- [ ] 25. spec 顶部改 `Status: implemented`，写交接。前提：第 20 步已完成（或 owner 明确同意砍法 ③ 且已照改），第 23 步全部通过。之后本文件不再有未勾的步骤。

## 实施记录

- **2026-10-08 · PR #36 lead 审查修复（完成）**
  - 先合 dev（`a582a02`，含 PR #37 / #38）。Open 的精确码与第九个 issuer 两条已解决；第 10–13 步全部完成，没有本轮待实现分支。提示层文案、哈希与 PROMPT_LAYER_VERSION=10 未改，免费 gate 沿用 lead 的 v10 基线，未跑付费 9a。
  - 6 major：未放行的工具设 ask / always 都拒绝，setToolSetting 只用旧 pin；有列表而缺工具退 ask / definitionChanged；截止 SIGKILL 单个拒绝不拖住 close；私网 http 登录 URL 拒绝；isError 保留原始错误、不校验 structuredContent；合格输出在注入端口与真实回退校验器下原样返回，不合格输出拒绝。
  - minor：worker 按 SDK 的 dialect 选择与错误位置判，排队中止立即响应、队列最多 64；地址去路径尾斜杠但保留 query；draft 与嵌套对象 strict；删除在配置锁里 await pool.retire，退役先禁止后续令牌写并等待已开始的钥匙串写与缓存写（不等待可能排队取配置锁的 issuer 回调）；警示 arg 过 visible，npx 空版本报警；未确认 restart=false；坏配置日志说明 schema / duplicate-id；Windows 按 PATHEXT 查文件、拒 cmd / bat、不搜索相对路径；无关配置写入跳过池 apply。
  - PR #38：rm -r -f、-R --force 按组合参数报警；改 header_keys 或 ownClient（包括只删）与新机密值一样重启一次。PR #37：第九个 issuer 先清旧 9 个账户再改配置，删失败恢复已删值；create / update 经 IPC 返回 blocked-env、duplicate-env、invalid-id，配置 / 钥匙串不变。
  - 审查的补测试已逐项落地：启用且已连接的撤销、预置 persistent / needs-consent、两次真实 spawn 换 PATH、风险 env_keys / 大小写 / npm_config_、resolved、cap=内置数+1 的 omitted=1、release / stale / one-time pin、issuer a/b/a、2560 / 2561 字节与零钥匙串写、reorder / secret-required / removed-secret / enabled / instructions / policy-ask、127.0.0.1 监听与超时后端口关闭、manual redirect 与已关闭的本机连接目标、Run 未 settle 前并行 close、真实 createDesktopMcp 退出与 stubborn 组长走截止 SIGKILL、重复 anchor / 嵌套与相对 id、修夹具路径、02 不变量 20 及机密不进哈希 / 日志、invalid-address 精确断言。
  - 门禁：format:check / lint / typecheck / build 绿；G：200 文件通过、2 文件跳过，3783 通过 / 2 跳过；免费 evals:gate：30 通过 / 1 跳过。普通相关 E：MCP 3、smoke 4、stop-exit 13，共 20 个不同用例全绿；递归 inputSchema 在约 3 s 内落 tool-unavailable / not-run，主进程 IPC 保持响应。
  - 突变：原计划 24 项重新全部红；本轮 36 项实现 / 边界突变全部红，worker dialect 与 home-path 可见性初次漏检已补强断言、精确重跑红，空版本匹配修正后红。打包 main 临时撤掉 SessionService 的 worker 注入时递归 E2E 超时红，产物 finally 恢复、隔离进程无残留，再构建后 E 绿；共 61 项。临时源码、探针与产物均已恢复，脚本 / 日志仅在 /tmp。
  - 交接：推送到 `feat/03-seg2` / PR #36，保持 Ready for review、目标 dev，不合并。下一步由 lead 按评论清单复核，预算砍法由 lead 审查时判；第三段第 14 步未开工。原有 AGENTS.md 修改保留、不提交。

- **2026-10-08 · 第二段完成 · `feat/03-seg2`（按用户要求，Open 两个缺口的受影响部分跳过）**：从 `origin/dev c1ff6bc` 起、先 install；实现第 10、10a、11、11a、12、13 步。配置逐条读 / 并发锁 / 原子替换 / 机密先写与失败恢复 / 删除先退池再删全部声明账户，首个 own-client issuer 与 issuer 挪尾；PRM 500 不掩盖 invalid_grant；宿主 PATH / Windows 脚本拒绝、三文件日志轮转、回环 state / 忙端口 / 120 s / 取消 / 提前回调、openExternal 守卫与开发接缝、HTTPS 与 HTTP 的 reach / 全 DNS 答案检查 / 地址钉定 / 请求原样传递 / 不跟重定向 / TLS 卡住后中止关 socket均已接入。机密轮换强制重启且不重确认，失败恢复先还钥匙串再恢复旧 run consent；真实进程和退出时 EOF 孤儿进程组的回归通过。
  - worker：常驻、逐条排队，从开始处理起 2 000 ms；超时真实 terminate，下一条重起，主线程保持计时；构造 / 编译错误、信号取消、空闲生命周期也收口。SDK 校验器恒接受，输入经 SessionService / batch 注入端口，输出在池的 callTool 之后经同一端口；内置与 kernel 无端口的同步回退保留。删静态展开计数与 id 限制，大小 / 深度 / 外部 ref / 危险正则的廉价检查保留。`schema-chains.ts` 压力形状 13 例（anchor、fragment id、未知键 dependencies、tuple、数值 / 空 / 布尔 / 对象 / 零 id、legacy id、pointer、recursiveRef、深实例递归）各在真实 200 ms 时限内终止；普通校验与 example id 42 正常，下一条成功；输出失败 completed / connectorFailed、输入超时 not-run / tool-unavailable、校验中停止 not-run / stopped 的 loop 回归绿。直接新增 desktop 依赖 `@cfworker/json-schema 4.1.1`，lockfile 20 行加 / 8 行删；worker 脚本及 CfWorker 打入 electron-vite 主进程包（worker chunk 约 42 KB）。
  - 接线 / IPC：应用共享池、watchConfig 与内存确认即时 apply、10 s 只在开表等、三态比较 pinned / frozen / live、全部 mcp 路由和 changed 事件；preview 复用现有不可见字符函数，reviewChange 为排序缩进 JSON，缓存消失为 null；overLimit 复用 provider 的已配置判定并按 cowork 内置表计数。两项 Open 不放宽已有 contracts、不静默丢 issuer：保存精确 IPC 诊断码、满 8 个后的第九 issuer 策略，均保留当前安全拒绝，其余功能完成。
  - 突变：第 10 四项、10a 一项、11 六项、11a 四项、12 五项、13 四项，共 24 项全部红；TLS 中止不关 socket 的额外一项也红。全部临时源码 finally 恢复。删除不先退池最初被 mock 内的断言吞掉，已加外部 apply 顺序断言、重跑红；内存确认突变初次匹配到了 restore 而非 allow，按 allow 精确定位重跑红；最终全 24 项重新跑过，HTTPS / DNS 在共用固定地址连接器后再次红。
  - 最终门禁：format:check / lint / typecheck / build 绿；`pnpm test --maxWorkers=2` 为 200 文件 / 3762 测试通过、2 文件 / 2 测试跳过；免费 `pnpm evals:gate --maxWorkers=2` 为 4 文件 / 30 测试通过、1 跳过，使用 lead 已提交的 v10 基线，未跑付费 9a。普通 EA（`env -u ELECTRON_RUN_AS_NODE ... playwright test --workers=1`）150 / 150 通过；MCP bundled worker、smoke、stop-exit 的 E 均绿。最终两条保存异常分支的改动分别有 U / G 回归，build 再跑绿；EA 正常流程未重复扩跑。
  - dev 观测：已以 `env -u ELECTRON_RUN_AS_NODE pnpm dev` 起过隔离测试 profile；原生 UI 工具只能读窗口，输入未生效，因此没有把该次人工发送记成功。改由可重复的 Everything seeded-profile 回归在 dev renderer + dev main 构建中实际发送并完成 `everything__echo`，全程内存机密 / 本地假 provider，无真实请求；截图 `seg2-everything-dev.png` 放仓库外 `tenon-notes/2026-10-03-phase3-mcp/`。同一回归已加入普通 E，打包构建也通过。
  - 提示层：相对 `c1ff6bc` 的 `packages/kernel/src/prompts` 无 diff，版本 10，哈希 `05155e927439d95459172208e8ca100a31515a464a6fdf7a2d39d6bbf2a7130c` 未变。原有 AGENTS.md 修改保留、不提交。
  - 交接：实现提交 `02e8b04`，PR [#36](https://github.com/yiongq/tenon/pull/36) 指向 dev / Ready for review，不合并；lead 审查代码、25 项突变及两项 Open，并按用户指令在审查时判预算。第三段从第 14 步起，表单接线前先写定 Open 的精确诊断读法；本段不自行决定新策略。


- **2026-10-08 · 第二段开工（`feat/03-seg2`）**：已先 `pnpm install --frozen-lockfile`，从最新 `origin/dev` 的 `c1ff6bc` 建分支，包含第一段与 PR #35 的 T23 worker 修订。范围仅第 10、10a、11、11a、12、13 步；提示层文案 / 版本 10 / 哈希不动。先实施配置存储与独立的 10a，再做主进程宿主件、限时 worker、接线和 IPC；遇到缺口记 Open，跳过受影响部分继续独立工作。原有 AGENTS.md 无关本地改动保留。

- **2026-10-08 · PR #29 第二轮修复（基于 `80ed98c`）**：目标为 03 第一段审查返修，不开第 10 步；当前 worktree `/Users/gq/.codex/worktrees/7c49/tenon` 的独立分支 `codex/pr29-round2`，最终推到 PR 的 `feat/03-seg1`。
  - [x] blocker 1：`items` 元组计入遍历；id 照 `$id || id` 取，字段存在时解析结果必须为非空字符串，否则 `invalid-id`。`schema-chains.ts` 加 tuple / numeric-id / empty-id 与便宜诱饵，definition / validate 六种链均提前拒绝，危险定义不交给 CfWorker。
  - [x] blocker 2：锚点只在同时补写说明时写 environment，恢复没有说明时 Run 中途压缩的 02 时序；不改环境文案。`mcp-run.test.ts` 的 mid-Run overflow 无说明例断言锚点之后没有 environment。
  - [x] major 3：首次开表的新说明在阈值判定后才随开表批次落盘，估算仍计入待写内容；after-compaction 开表按实际保留尾巴与同批事实去重。首次带说明的阈值路径逐个 recheckAttempt verified、最终 body 只有一条说明；同一 Run 已落盘说明位于 keepFrom 尾巴的 overflow 路径也只写 / 发一条。
  - [x] 回退 4：`screen=false` 跳过未解与不可解析 input ref；外部、悬空及坏 URL 三支均经 mcp-source / table 保留在表，调用收口 tool-unavailable / not-run、零派发。
  - [x] 回退 5–7：非交互的 LoginError 收成 McpUnauthorizedError（自带 client 的 issuer 变化 / 未绑定两支）；只有非 AUTHORIZED 才抛 transientFailure（缺 PRM、刷新重新取 PRM 得 503 时仍刷新成功且轮换落盘）；成功登录保存 discovery（origin resource 的刷新原文发送、没有多余 well-known 请求）。
  - [x] 补测试 / 标签：apply 与 runtimeOf 路径的 connect 均挂起，在 connecting 时直接断言 error=null；真实 HTTP 探测未回应时触发 SDK transport close，主体断言 SDK 的 closed during 错误与池 network 分类；executor / pool 的 T9 标签改为「03 验收 30 (T9)」。首次网络握手失败仍按原状态机进 error，退避回归仍覆盖已连接后断网。
  - 新增突变 14 项全部红：漏元组 items、id 改回 ??、放过数值 id、无条件环境写入、提前落盘说明、忽略保留尾巴去重、开表拒未解 ref、开表拒坏外部 URL、漏 LoginError 映射、AUTHORIZED 前抛 transientFailure、漏保存登录 discovery、漏估算待写说明、漏 resetLaunch 清 error、探测关闭误记代际错误；每项 finally 恢复。
  - 提示层：`src/prompts` 相对 `80ed98c` 无 diff；版本保持 10，哈希保持 `05155e927439d95459172208e8ca100a31515a464a6fdf7a2d39d6bbf2a7130c`。保留 lead 的原始 9a 记录，不跑付费评测。原有 AGENTS.md 无关修改保留、不提交。
  - 最终门禁：`pnpm format:check` / `pnpm lint` / `pnpm typecheck` 绿；`pnpm test --maxWorkers=2` 为 195 文件 / 3708 测试通过、2 文件 / 2 测试跳过；`pnpm build` 绿；`pnpm evals:gate --maxWorkers=2` 为 4 文件 / 30 测试通过、1 文件 / 1 测试跳过，P 绿。全部临时突变恢复，临时探针清理；随本轮提交推送，PR 保持 Ready、不合并。

- **2026-10-08 · PR #29 lead 再审修复**：按 PR #29 评论逐条修，先合入 dev PR #34（读法 65）。提示层文案 / PROMPT_LAYER_VERSION=10 / 哈希保持不变；9a 由 lead 在自己的 worktree 跑，推送前 pull 接上记录。评论中的 blocker、实现 bug、补测试与 minor 均已实施，新增回归与突变通过；最终 G / build 和推送前 pull 在下方记结果。不进入第二段、不合并 PR。
  - [x] blocker 1：CfWorker 的 anchor / fragment id / 未知键 / dependencies / recursiveRef / 未解本地 ref 与 10000/10001 边界。
  - [x] blocker 2：说明批次不在阈值压缩之前写 view/assembled；阈值路径与 recheckAttempt。
  - [x] 实现 3–6：auto 网络 / 5xx 分类、重启定时器取消、crash-limit close 和句柄清理、两条 launch 变化路径共用重置。
  - [x] 实现 7–9：有 PRM 不挂 validateResourceURL、钥匙串 rejected Promise 可恢复、超时只取池值。
  - [x] 补测试：验收 29 两阶段等待 / 成功 / loop 收口；池说明钉住四态；new 与 changed；多 provider 说明去重 / 哈希变化 / 转义 > / estimateInput / 真实 instructions；真实 HTTP 不派发；OAuth handed 全请求计数 / 持久轮换 / 再 401；握手传时限 / 改 launch / 中间值 / 超时分类；OAuth PKCE / CIMD / denied / error iss / 直接 client issuer；meta 与头白名单；env_keys；排除优先级 / 最终排序 / 无哈希 definitionChanged；移出 mock 的断言。
  - [x] minor：supported 字段、stopReason 先 announce、cacheLoaded、压缩 environment 顺序、approval.outcome 枚举、crashed 两份 locale、OAuth 非授权错误透传、测试标签与文件位置。

  - 证据文件：`mcp/definition.test.ts` 与 `tools/validate.test.ts` 共享 anchor / fragment-id / 未知键 dependencies 链，校验器 spy 保证危险定义被提前拒绝；`loop/mcp-run.test.ts` 覆盖带说明首次开表的阈值压缩、逐次 recheckAttempt、真实 HTTP 池零派发、首连成功与 401 刷新收口、OAuth AS 网络失败不改变 phase；`mcp/pool.test.ts` 覆盖计时、重置、cacheLoaded、钉住四态和关闭句柄；`mcp/oauth.test.ts` 核对 handed 的每个 AS 请求与 durable tokens；`mcp/http-connection.test.ts` 核对 connect 参数、原始错误、头和 meta 白名单。其余按评论移到 `loop/tool-table.test.ts`、contracts 和 executor 的主体断言。
  - 新增突变 35 项均红：schema 六项（anchor、fragment-id、未知键 dependencies、recursiveRef、本地未解 ref、根计数）；提前写 manifest；auto 网络 / 5xx；不取消旧 timer、第三次崩溃不 close、timer 路径不重置、保留旧 OAuth、重连不清已关闭句柄；有 PRM 仍验证 URI；缓存 rejected tokens；executor 固定超时；忽略 supported；不等 cacheLoaded；忽略说明 enabled / pin、忽略 new review、说明去重忽略 hash、不转义 >、estimateInput 不计说明、压缩漏补说明；AS 网络误触发池重启；不在 announce 前设置 stopReason；登录 / 刷新改 global fetch；不持久写轮换组；漏 HTTP 握手 timeout；注入 sessionId meta / Tenon 请求头；不按名重排裁剪项。临时源码均 finally 恢复。首次“停用说明”用例仅有不匹配 pin，突变未红，已补匹配 pin 且停用后重跑红；executor 改为完整选项断言。HTTP 握手脚本最初匹配到 stdio，未记为有效突变，按 HTTP 函数范围重跑红。
  - 提示层检查：`src/prompts` 相对 `9b2ddbc` 无 diff；`PROMPT_LAYER_VERSION=10`，哈希仍为 `05155e927439d95459172208e8ca100a31515a464a6fdf7a2d39d6bbf2a7130c`。locale 只新增 crashed 文案，不修改模型提示层。
  - 最终门禁：`pnpm format:check` / `pnpm lint` / `pnpm typecheck` 绿；`pnpm test --maxWorkers=2` 为 195 文件 / 3699 测试通过，2 文件 / 2 测试跳过；`pnpm build` 绿。
  - 推送前已 pull lead 的 `98c45e1 test(evals): record the v10 baseline run`，保留其 60 条原始记录：`docs/evals/results/2026-10-08-tenon-glm-5.3-open.bigmodel.cn-api-paas-v4.jsonl`（20 题 × 3，记录 verdict 均 pass，合计约 ¥49.75146）。`pnpm evals:gate --maxWorkers=2` 绿：4 文件 / 30 测试通过，1 文件 / 1 测试跳过；P 全绿，第 9a 步由 lead 完成、据记录勾选，实现者未跑付费评测。提示层哈希与记录匹配。
  - 交接：修复提交 `473720b`，PR #29 保持 Ready for review、目标 dev、不合并；下一步由 lead 对本审查清单复核，第二段第 10 步仍在后续 PR。原有 `AGENTS.md` 无关本地改动保留、不纳入提交。

- **2026-10-08 · 第 7–9 步收尾**：合入 dev PR #32 / #33（`17e8deb`），Open 两条缺口均已解决。补了首次自带 client 的 issuer 原文 / tokens 回写类别、启动时恢复最后 issuer、空列表不读钥匙串、新 issuer 重新 DCR 注册、crashed 尾巴 / crash-limit 保留 / 重连与用户操作清空、跨池缓存恢复与坏缓存、池退出并行关闭与到点强杀（leader 已退出仍杀组）的回归。连接池代理跨两个 Run 等重启后成功，冻结工具表不变；在途崩溃照既有 connectorFailed 文本、completed 收口；未授权连续三次不吃机器阻断上限。阶段与错误码的 kernel ↔ contracts 双向类型钉放在 contracts/test/mcp.test.ts（避免 kernel 新增 contracts 依赖）。
- **最终突变**：合新契约后重跑 7 的七项、8 的九项、9 的八项，全部红；额外验证刷新 Promise 合一，以及 PR #32 的忽略启动 issuer / 丢原文 / 误用 client 写类别、PR #33 的漏记 crashed / 重连不清空，共 30 项全红。8⑤ 统计键改为同台后格式变成多行，初次脚本未匹配，不算已跑；用最终代码准确匹配重跑，撞名优先级回归红。临时改动均 finally 恢复，相关回归恢复绿。收尾新增异步钉住期间删除不重建缓存、超长 Unicode 单行尾巴有界两例。
- **最终门禁**：最终 format:check / lint / typecheck 绿，全套 195 文件 / 3666 测试通过、2 文件 / 2 测试跳过；build 绿。`pnpm evals:gate --maxWorkers=2` 为预期红：20 题均缺提示层 10 的 3 条基线；未跑真实评测、未使用真实 key。9a 等 lead 跑。

- **第 7–9 步合入新契约前 G**：format:check / lint / typecheck 绿；全套 195 文件 / 3654 测试通过、2 文件 / 2 测试跳过。第 8 步完成；第 7、9 步待合 PR #32 / #33 后补齐，9a 等 lead 跑。

- **2026-10-08 · 第 7–9 步独立部分**：连接池、应用级代理、缓存、沙箱启动、120 s 首连、等待与重连、1/2 s 崩溃重启和 1/2/4/8/16 s 网络退避、429 分流、只读断流新 id 重发、outputSchema 调用前拒绝已实现。工具表按同台候选算撞名、按 rank 裁剪，冻结 definitionHash 跨 Tape 恢复；三态、待批 definitionChanged、未执行收口、结果 reversibility 与 server 说明（同批、JSON 包装、转义、去重、压缩后补写）已接入。OAuth 分片、互斥锁、PKCE / iss、DCR / CIMD / 已绑定自带 client、最小非交互 AuthProvider、并发刷新合一、登录恢复同代理、取消、跨源静态头保护已实现。第 7 步崩溃尾巴与第 9 步启动 issuer / 首次自带 issuer 写回按 Open 暂缺；dev 已收到 PR #32 / #33，当前改动提交后合入并补齐，不在这里停止。
- **第 7–9 步突变**：7 的七项、8 的九项、9 的八项均已逐项实施。7④“不等待”与 8⑧“重绘不填 reversibility”首次未红，补“截止前尚未返回”的宏任务断言与 Tape 重绘行断言后均红；7⑥ 同样补强后由重连到达时限例抓住。9⑥ 拆为两处保护：删除令牌写入锁使并发写的第二代完整组断言红；删除刷新 Promise 复用使并发 401 的单次刷新断言红（单删锁不会绕过 Promise 合一）。其余突变各自所列回归均红，全部恢复后相关四文件 51 测试绿；后补冻结正文和 readOnlyHint 手动审批两例及旧跨台撞名例共 25 测试绿。合入新契约后补测与最终 G 另记。
- **第 7 步开放问题 5 实测**：Everything 2026.8.31 的 `getServerCapabilities()` 实际声明 `tools: { listChanged: true }`；用 data URI 调 `gzip-file-as-resource` 后 300 ms 内收到 tools 的 list_changed 1 次，工具数前后均 13。和 plan 的“不声明能力”假设不同，记录实际结果、不加工具通知断言；resources list_changed 的池快照回归有持久断言。临时观察探针在仓库外，收尾删除。

lead 第 6 步检查点结论（2026-10-08）：不砍。
已用约 1 个工作日（第 1–6 步当天完成，依据 feat/03-seg1 的提交时间）；
余下估计约 9 个工作日：第一段剩余 1、第二段 1.5、第三段 2、
第四段 2.5（含 owner 的同题对比与 live OAuth）、lead 审查与 9a 共 2。
合计约 10 < 15，砍法 ①②③④ 都不触发：7b 自动重启、8b server 说明、
9b 与第 20 步 CIMD 全部保留。

- **2026-10-08 · 用户后续指令**：后面各段 PR 的砍法检查由 lead 在审查时判，不用为它停下；9a 仍跳过。

- **2026-10-08 · 第 4 步完成 · `feat/03-seg1`**：合入 dev PR #31（合并提交 `87cad8e`），Open 的总时限阻塞已解决。stdio / HTTP 共用连接层真实计时器，内部 AbortController 与调用方 signal 经 AbortSignal.any 合并，不传 SDK maxTotalTimeout；finally 清计时器。持续进度下总时限到点观察到 stdio cancelled，调用方 signal 未中止；HTTP 普通与总时限到点，旧代收到 cancelled、新代请求响应流被关闭且无 cancelled。补齐实际 notifications/message 日志、空 initialize capabilities、无 logging/setLevel / discover、SDK Mcp-Param-* 映射、Everything prompts/resources 与缺失资源、executor 实时信号和 completed 超时收口。HTTP 204 / 非 JSON 探测映射到 era-negotiation-failed。U MCP / executor 39 测试绿；新增第 6 步后最终 G：191 文件 / 3600 测试通过，2 文件 / 2 测试跳过；build 绿。七项突变均红→恢复后绿：executor signal、握手 timeout、CfWorker、交入 fetch、静态头跨源泄漏（删除同源限制，覆盖 requestInit.headers 式泄漏的行为）、改回 SDK 总时限、finally 不清计时器。原 fixture-server 02 断言未改。evals:gate 仍预期红：20 题缺提示层 10 的基线记录；9a 等 lead 跑，未使用真实 key。

- **2026-10-08 · 第 5 步完成 · `feat/03-seg1`**：新增 env.ts，按白名单 / PATH / LC_ → envs → env_keys 覆盖；秘密完整值及 CR / LF 分行片段仅长度 ≥ 4 才脱敏，最长先替换、替换全部出现。U 3 测试绿；继承全部环境、删除 LC_、不拆多行三项突变均红→恢复后绿。最终 G 与 build 同第 4 步记录。

- **2026-10-08 · 第 6 步实现与验证完成 / lead 检查点待判 · `feat/03-seg1`**：新增 definition.ts，定义哈希含 spec / outputSchema / requiresUserInteraction；大小、物理深度、工具列表限额按边界检查；schema 关键字遍历按路径展开本地 ref，递归同路径不重复展开，访问超过 10000 立即退出。outputSchema 检查慢正则与外部 ref；入参在构造 CfWorker 校验器前初筛与查展开数，不执行外部引用。U definition / validate 15 测试绿；40 链分支 ref 的 input 与 output 检查合计小于 100 ms。深度改 33、漏查 outputSchema 展开数均红；删除外部 ref 检查首次未红（CfWorker 本身拒绝），加「构造校验器之前拒绝」断言后重跑红，恢复后 G 绿。最终 G / build 同第 4 步记录。尚未勾第 6 步：plan §砍法要求 lead 给工期估计与依据、记录裁决后才开第 7–9 步；已向 owner 请求这项输入，未代 lead 编造估计或自行砍功能。

- **2026-10-08 · 第 4 步半成品 · `feat/03-seg1`**：完成连接层主要接法与回归，SDK 实际 `callTool(params, options)` 为两个参数，Tenon 的第三可选参映射到 SDK 第二参（发布包类型适配，不改 spec 行为）。stdio legacy 与 HTTP auto/legacy、120 s 静默握手、普通超时取消、进度重置与 SDK 总时限拒绝、HTTP 同源头与 token 优先、资源缺失、拒 elicitation、断流不重发工具调用、executor not-run/uncertain 回归通过。**不能勾完成**：SDK 总时限取消冲突见 Open，第 4 步剩余验收和五项突变尚未完成。最终 G 绿：189 文件 / 3582 测试通过、2 文件 / 2 测试跳过；build 绿。`pnpm evals:gate --maxWorkers=2` 预期红：20 题在提示层 10 均为 0 条基线记录；未运行 `pnpm eval`，无真实 key / 费用，9a 等 lead 跑。无调试探针或 failing 测试留在仓库。

- **2026-10-08 · 第 3 步 · `feat/03-seg1`**：新 stdio 夹具用 SDK `serveStdio` 的 `legacy: reject/serve`，无需手写 modern-only 协议。HTTP 新代用 SDK `createMcpHandler.fetch`，旧代与假 OAuth 端点按测试需求手写；tree/crash 夹具起停通过。U：5 测试绿；G：187 文件 / 3569 测试通过、2 跳过。discover 突变最初挂在 Server handler 被 SDK 入口覆盖、未红；改在实际 stdio 响应传输处注入 discover 错误，modern-only 用例红，恢复后 5 用例绿。这个故障入口留作握手回归夹具。

- **2026-10-08 · 第 2 步 · `feat/03-seg1`**：合入 dev `e7e5ee9`（合并提交 `462ffd0`），PR #30 阻塞已解决，过时 draft 开工限制已删。新增契约按 03 §对 02 的修补 1–11、15 与对 01 的修补实施；MCP 路由仅定义、未注册，产品尚无连接器来源。提示层版本 10，哈希 `05155e927439d95459172208e8ca100a31515a464a6fdf7a2d39d6bbf2a7130c`。G 绿：186 文件 / 3564 测试通过、2 跳过。四项突变（ID 放宽、closure 枚举漏项、中文漏键、重放漏新名字）均红，恢复后 typecheck、lint 与相关 20 测试绿。第 9a 步按用户要求不跑，等 lead 跑。

- **2026-10-08 · 第 1 步 · `feat/03-seg1`**：client/core 2.3.1，测试依赖 server 2.3.1、node 2.1.1；Everything 2026.8.31 不动，调用点无类型适配，打包方式不变。lockfile 46 行增加、9 行删除。U MCP：4 文件 / 12 测试通过；G：format、lint、typecheck 通过，全套 185 文件 / 3558 测试通过、2 文件 / 2 测试跳过；build 通过。全套需允许本机回环服务器，沙箱下模型选择用例曾超时，允许回环后单独 29 测试和全套通过。突变：临时改 Client 为 auto，fixture-server 的 2025 协商断言及对应 loop 用例红；恢复后 5 测试通过。

（每步完成时追加：日期、分支与提交、做法、改了什么、评审修补、留给后面的、实测（命令与结果、测试数）、突变结果。）

## 验收记录

（第 23 步填。）

## 交接

- **2026-10-08 · 第二轮审查返修完成**
  - 分支：当前独立 worktree 为 `codex/pr29-round2`；交付推至 `feat/03-seg1` / PR #29 → dev，保持 Ready、不合并。
  - 完成：最新 lead 评论的 1–7 条、补测试与标签逐项落实；实现 / 测试 / 14 项突变证据见本 plan 实施记录。第 2 条只改写入时机，版本 10、文案与哈希不变。
  - 门禁：G/P 全绿（3708 单测、30 评测门禁测试通过）；9a 记录为 lead 的既有提交，未跑真实付费评测。
  - 工作树：原有 `AGENTS.md` 无关修改保留、不纳入提交；其余本轮改动随提交推送，临时突变源码已恢复。
  - 下一步：lead 第三轮复核最新清单与新增突变；第 10 步仍属第二段后续 PR。本次不自行合并。

- **2026-10-08 · 第一段完成 / 待 lead 审查**
  - 分支：`feat/03-seg1`；PR #29 → `dev`。第 1–9 步实现与本段回归 / 突变完成，7b 自动重启、8b server 说明、9b CIMD 全部保留；第 9a 步按用户要求跳过，等 lead 跑。spec 保持 ready（第二至四段尚未实施）。
  - 原文 lead 预算结论已写入实施记录，Open 对应项已解决；后续砍法由 lead 在各段 PR 审查判，不再作为实现者开工暂停点。
  - 工作区：另有非本任务的 AGENTS.md 文案修改，保留未提交，不纳入本 PR；其余本段改动提交推送。
  - 给 lead：核对第 7–9 步实际断言与 30 项突变结果，尤其崩溃尾巴、OAuth 非交互不注册、首次自带 issuer 回写、冻结表恢复与 server 说明的同批事实。Everything 的实际能力声明 / 通知观察见实施记录。
  - 下一步：最终 G 与 build 通过，本次提交并推送、更新 PR 描述并设 Ready for review，不合并。接下来由 lead 审查第一段及跑 9a；第二段从第 10 步开始，不在本次请求内。

- **2026-10-08 · 第 4–5 步完成 / 第 6 步验证完成、检查点待判**
  - 分支：`feat/03-seg1`，已合入 dev PR #31（合并提交 `87cad8e`）。最新实现提交见 git log；本次改动仅第 4–6 步代码、耐久回归与 plan，无临时探针或失败测试。
  - 做完的：总时限到点取消的共享连接层机制、第 4 步其余验收和七项突变；第 5 步全部；第 6 步全部实现、测试与突变。第 4–5 步已勾，第 6 步保留未勾以显式跟踪 lead 检查点。
  - 门禁：format / lint / typecheck / 全套单测 G 绿（3600 通过 / 2 跳过），build 绿；evals:gate 缺提示层 10 的基线记录而预期红，9a 等 lead 跑。
  - 待输入：见 Open 的 lead 砍法检查点。第 7–9 步尚未开工；没有代 lead 写估计。PR #29 尚未满足 Ready 条件，保持 draft，未合并。
  - 下一步：收到 lead 的估计、依据与裁决（或 owner 明确覆盖该前置流程）后记录，勾第 6 步；从第 7 步连接池继续到第 9 步 OAuth，再将 PR #29 Ready for review。新 spec 缺口按用户要求记录 Open、跳过受影响部分，继续独立步骤。

- **2026-10-08 · 第 2–3 步完成 / 第 4 步半成品并卡住**
  - 分支与实现提交：`feat/03-seg1` @ `c5d2106`；未提交改动：无；已合入 dev PR #30（合并提交 `462ffd0`）；PR [#29](https://github.com/yiongq/tenon/pull/29) 仍为 draft，未合并。
  - 做完的：第 2 步新增契约、提示层版本 10、两份 locale；第 3 步 stdio / HTTP / OAuth / tree / crash 夹具。原冻结哈希持久化阻塞已解决，Open 过时 draft 条目已删。
  - 半成品：第 4 步 client 选项、HTTP fetch 包装、连接层、无条件进程组强杀、executor 取消与两种未执行收口已写，MCP / executor 32 用例绿；有 SDK 总时限取消冲突（见 Open）。验收 12 的 x-mcp-header、41 的实际通知日志、Everything prompts/resources 与第 4 步五项突变尚未全部完成，不能勾第 4 步；第 5–9 步未开始。
  - 门禁：第 2 步 G 绿（3564 通过 / 2 跳过）；第 3 步 G 绿（3569 通过 / 2 跳过）；第 4 步最终门禁见实施记录。P 中 build 会验证，evals:gate 因提示层 10 缺基线记录预期红；9a 按用户要求不跑，等 lead 跑。无 Electron / live 测试。
  - 突变：第 2 步四项全部红→绿；第 3 步 discover Server handler 覆盖突变未红，改为传输真实响应错误后红→绿。第 4 步突变未做。
  - 给审查者：优先核验 SDK maxTotalTimeout 的取消行为；没有以普通 timeout 的绿色结果替代这一条。
  - 给 owner：9a 仍跳过；第 2–9 步尚未全部完成，不能按用户条件将 PR #29 Ready for review。
  - 下一步：先决定并修补第 4 步总时限取消机制，完成第 4 步剩余验证，再按顺序继续第 5–9 步。

- **2026-10-08 · 第 1 步完成 / 第 2 步前卡住**
  - 分支与实现提交：`feat/03-seg1` @ `ce1d36e`，从 dev `16068ca` 开出；draft PR [#29](https://github.com/yiongq/tenon/pull/29) 指向 dev，未合并。改动仅 kernel package.json、pnpm-lock.yaml、SDK 版本回归测试及本 plan；没有半成品生产代码。
  - 做完的：第 1 步，03 验收 1；旧 MCP 测试保持原样通过。
  - 门禁：G 绿（3558 测试通过、2 跳过）；build 绿；P 未跑（尚未改提示层）；E 不适用。
  - 突变：Client auto 导致旧代协商断言红；恢复后 5 用例绿。
  - 给审查者：核对 Open 中冻结 definitionHash 的持久化缺口。spec 尚未有这部分代码依赖，可由 owner / lead 在 ready spec 的 Revisions 记录补充。
  - 给 owner：第 9a 步按用户要求跳过，等 lead 跑；不合并 PR。
  - 下一步：先补上述契约与旧表兼容规则，再从第 2 步开始，继续到第 9 步。

模板（每次停下都加一条，最新的在上）：

- **<日期> · 第 N 步 · <完成 / 半成品 / 卡住>**
  - 分支与提交：`feat/03-segX` @ `<sha>`；未提交的改动：无 / <文件列表与状态>
  - 做完的：<步骤与验收编号>
  - 半成品：<文件、停在哪、下一步具体做什么>
  - 门禁：G <绿 / 红：哪条>；P <跑了没有>；E <跑了哪些>
  - 突变：<做了哪些、哪些没红>
  - 给审查者：<要特别看的地方>
  - 给 owner：<要 owner 做或定的事>
  - 下一步：第 N+1 步

## Open

- **2026-10-08 · 已解决（PR #37，读法 68 / 验收 52）：第九个 issuer。** 已合最新 dev；满 8 个时在配置锁里先删最旧 issuer 的 8 片令牌与 client，再改列表、再由 token store 写新机密。删失败回 keychain 并恢复已删账户，列表保持不变；后续 server 删除覆盖余下所有账户。
- **2026-10-08 · 已解决（PR #37，读法 67 / 验收 52）：保存精确诊断。** draft 请求 schema 只查形状并逐层 strict；保存的 create / update 经路由回 blocked-env、duplicate-env、invalid-id，配置读取 schema 保留全部语义限制，违规条目单独丢弃并记录原因。
- **2026-10-08 · 已解决（PR #33）：第 7 步崩溃尾巴的状态契约缺口。** 合 dev 的提交 `17e8deb` 包含 PR #33；spec 读法 64 写定 `error` 是最近一次失败、只增 `crashed`。kernel / contracts 枚举同步；每次崩溃保留脱敏且最多 20 行 / 4 KiB 的尾巴，重连成功、用户重启或用户停止清空，crash-limit 保留。验收 4 回归及丢失 / 未清空突变均已验证。

- **2026-10-08 · 已解决（PR #32）：第 9 步 issuer 的 runtime / 写回契约缺口。** 合 dev 的提交 `17e8deb` 包含 PR #32；`McpOAuthRuntime.issuers` 给启动时最后一组，`onIssuer` 带 `{ hash, url }` 与 `tokens | client`。令牌存储在钥匙串写前按新参数回调，池写成功后更新内存当前 issuer；首次自带 client 登录用已核过的 issuer 原文，经 tokens 回调与哈希同次配置写入。新 provider 恢复与缓存令牌、空列表不读钥匙串、首次绑定与后续换 issuer 拒绝已有回归；这些路径不再跳过。

- **2026-10-08 · 已解决（lead 2026-10-08）：第 6 步砍法检查点。** 第 6 步实现、回归、三项突变与 G / build 已完成；本 plan §砍法明确「lead 在两个时点判：第 6 步完成时（第 7、8、9 步开工之前）」与「估计由 lead 给，连同依据写进实施记录」。目前文件未提供已用 + 余下工作日估计、依据或保留 / 砍功能裁决；不能由实现者代 lead 编造。已请求 owner 提供 lead 判断，所需具体输入：工期估计与依据，以及自动重启 / server 说明 / CIMD 是否保留。按最新用户指令，先完成所有不依赖此项的第 4–6 步实现与验证；剩余第 7–9 步均受同一前置检查点影响，所以未开工，PR #29 保持 draft。lead 已给出不砍结论（原文见实施记录）；第 7–9 步前置条件已满足。后续各段 PR 的砍法检查由 lead 在审查时判，不为它停下。

- **2026-10-08 · 已解决（PR #31）：SDK 总时限到达不取消调用，与验收 30 冲突。** 已按 §超时、取消与断流把 `timeout`、`signal`、`onprogress`、`resetTimeoutOnProgress`、`maxTotalTimeout` 原样交给 client 2.3.1。普通 stdio / legacy HTTP 超时与停止可以观察到 `notifications/cancelled`；新代 HTTP 停止不发该通知。真实 dual stdio 的 slow(ms=3000)，调用 timeout=180 ms、进度每 100 ms、resetTimeoutOnProgress=true、maxTotalTimeout=1800 ms：SDK 按总时限拒绝，但夹具继续执行，不出现 cancelled；原先在总时限测试末追加的 cancelled 断言等待 1 s 后红，撤掉探针后现有回归绿。
  - SDK 发布包 `@modelcontextprotocol/client@2.3.1/dist/src-WCy6ifGf.mjs`：`_resetTimeout` :5806–5817 到总时限时直接 throw；`_onprogress` :6030–6036 直接调用 responseHandler(error)；responseHandler :6210 将 responseReceived 设 true；cancel :6190 见 responseReceived 就返回。该分支没有通知旧代，也没有 abort 新代 HTTP 的 requestAbort。普通 timeoutHandler 则调用 cancel，因此普通超时测试通过并不能证明总时限取消。
  - spec §超时、取消与断流明确规定「调用超时、进度重置与总长封顶都是 SDK 用真实 setTimeout 走的计时，不走 HostClock」，第 1 步又固定 client 2.3.1；独立加总时限计时器、改 SDK 版本或修补 SDK 内部均会改变这项机制。需 lead / owner 写定修补方式与 Revisions，再实现并补总时限取消回归。已由 PR #31 写定连接层独立真实计时器与合并 AbortSignal 的机制（读法 62），本次据此补回归；未修改 node_modules。

- **2026-10-08 · 已解决（PR #30）：冻结定义哈希的持久化契约。** spec §三态、第 3 层与第 6 层、§对 02 的修补 5 要求把冻结项的 `definitionHash` 交给 `userSetting`；§定义钉住 / 读法 54 定义该哈希包含 `outputSchema`，并明确它不在 `ToolSpec` 中。但现有 `ToolTableItem`（`packages/kernel/src/tools/registry.ts`）、`ToolTablePayload.tools[]`（`packages/kernel/src/tape/entry.ts`）、`toolTableFacts` / `rebuildToolTable`（`packages/kernel/src/tools/table.ts`）都没有保存或恢复这个哈希。Tape 仅有 `specHash`、`requiresUserInteraction`；同一 spec 配两份不同 outputSchema 会有不同 definitionHash，却产生相同的现有工具表事实，恢复、续跑时无法还原冻结值。不能用当前 config pin 或池的实时哈希替代，否则定义变化会覆盖冻结依据，违反 03 不变量 6、8 和 02 的 Tape 恢复规则。
  - **需 owner / lead 补进 spec 的决定**：冻结哈希放进哪项 Tape 载荷及内存项（建议给 `ToolTablePayload.tools[]` 和 `ToolTableItem` 只增可选 `definitionHash`，开表保存、重建原样恢复）；03 之前已有冻结表没有该字段时的第 3 / 6 层行为（建议不可授予 always-allow，仍可每次审批）；相应类型契约修补与恢复回归验收。这两项在当前 spec 的 Tape 表、对 02 的修补和第 2 / 8 步中未写定。已由 PR #30 补入 spec §对 02 的修补 15、读法 61 和验收 38；本次按补充契约实现。
- **2026-10-08 · 用户指令（PR #31 后）**：后续 spec 缺口写入 Open，跳过受影响部分，继续独立步骤；仅剩余步骤全部受阻时停止。

- **2026-10-08 · 用户指令**：第 9a 步跳过，由 lead 跑；第一段 PR 描述必须写「等 lead 跑」，本次不合并。

- 开放问题 1 已定（2026-10-08）：CIMD 地址 `https://yiongq.github.io/tenon/oauth/client-metadata.json`，托管文件与发布工作流已在仓库，不挡开工。
- 开放问题 2（live 厂商）挡第 21 步；开放问题 11–13 已于 2026-10-08 定（照推荐，见 spec）。
- **已解决（lead `98c45e1`）：第 9a 步基线记录已接入，evals:gate 绿。** 第一段仍等 lead 再审通过，本次不合并。
