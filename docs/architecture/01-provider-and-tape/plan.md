# 01 · Provider 抽象 + 会话存储 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。每一步结束时仓库都是绿的。

- [x] 1. amend 机制：owner 于 2026-09-17 确认，四处文字已落地（AGENTS.md「How we work」、`docs/spec-driven-dev.md`「改变决定」、`00-foundation/spec.md` 的 `Amended by:` 行、主参考 §13 阶段 2 / 阶段 4 两处措辞）。开工前核对这四处仍在即可，不要重复落地
- [ ] 2. `HostAdapter.network`：`FetchLike`、`HostNetwork`、`HostNetworkDeniedError` 进 `packages/kernel/src/host/adapter.ts`；desktop 实现；内存版 host 默认抛错；`.oxlintrc.json` 改 `fetch` 提示语并加 `WebSocket` / `EventSource` / `XMLHttpRequest` / `process` / `crypto` 与 import 禁用清单；`packages/kernel/src/testing/` 与 `package.json` 的 `./testing` 子路径、`fakeNetwork`（不用定时器）；`ids: { uuid() }` 的构造参数约定与测试用确定性实现；esbuild `--platform=browser` 打包测试（验收 8）
- [ ] 3. kernel Tape 纯内核：`canonicalJson`、`@noble/hashes` + `hashEntry` 固定向量（含长度前缀防撞向量）、entry 类型、`provenance` 语法与校验器、保留命名空间表 + 双向断言 + slice 写入器（验收 12 的向量部分、13）
- [ ] 4. `TapeStore` 端口 + 内存 store + 共享 conformance 套（导出为接收 store 工厂的函数）：有界读取、`atEntryId` 钉住、`readBySource`、幂等与 `TapeProvenanceConflictError`（含批内重复键）、高水位分配、随批传入的 `incarnationId` 与 `TapeStaleIncarnationError`、reset / delete（验收 10、11、15 的内存部分）
- [ ] 5. 投影 reducer `project()`（含 `insertOnly`）、折叠规则 `effectiveMessages()`、带 `atEntryId` 的 `rebuildProviderContext()`；内存 store 在 append 内应用 op（验收 3 的投影一半）
- [ ] 6. 两份 DDL 与方言映射表、`scripts/check-tape-schema.mjs` 挂进 `pnpm lint`（验收 17）。此时还没有代码加载它们
- [ ] 7. desktop SQLite store：钉 `better-sqlite3@13.0.3` 并追加进 `ignoredBuiltDependencies`；连接 PRAGMA；`schema_version` 迁移；`BEGIN IMMEDIATE` + 每个方法自己 `ROLLBACK`；spec 规定的 append 语句顺序；`safeIntegers` 经统一的 prepare 辅助；`Buffer → Uint8Array`；`undefined → null`；`tape_meta` 租户校验；`<profileDir>/sessions.db`。原样跑第 4 步的 conformance 套，加验收 4、9、10（双连接交错与强制锁）、12（1 万条 + 对拍）、14、15（2^53）、18
- [ ] 8. kernel provider 内核：类型、`BaseProvider`、`ProviderRegistry`、事件联合、块累加器、终态事件包装、`decideThinking`（验收 16）
- [ ] 9. 两个线协议适配器的 `encode()`（纯函数，产出 `promptHash` / `toolDefinitionsHash` / `thinkingDecisions`）（验收 2）
- [ ] 10. `@anthropic-ai/sdk@0.126.0` 移入 kernel、新增 `openai@7.17.0`，都钉精确版本；Anthropic 适配器的 `stream()`：`maxRetries: 0`、凭据显式、`{ signal }`、try/catch 错误映射、`usage` 先于终态且只落 `final` 的那条、`retryAfterMs` 取自 `err.headers`；录制的 SSE 夹具（验收 7）。SDK 进 kernel 之后重跑第 2 步的打包测试
- [ ] 11. OpenAI 兼容适配器的 `stream()`（按 `index` 归位、`reasoning_content ?? reasoning`、`include_usage`、`requestParams` 透传）+ `anthropic` / `zhipu` / `ollama` 三个定义（`ollama` 带默认的 `apiKey`）。`ModelInfo` 按厂商当时的文档填，未能确认的字段记到本文件的 Open（验收 1）
- [ ] 12. kernel session service：建 / 重置 / 删会话，`runId`（canonical UUID）与 `requestSeq` / `physicalAttempt`，`session/start`、`message/*`、`session/model_selected`、`provider/attempt_completed`（含 `contextAtEntryId`）的写入；重试复用 `messageId` 的规则、失败轮次不写 assistant 消息；只写事实，不做循环（验收 3 的重放一半）
- [ ] 13. 重接 `apps/desktop/src/main/chat.ts`：删内存 `history` 与直接构造的 SDK；保留阶段 0 注释里写明的行为（先登记后 await、停止保留部分文本、失败轮次留存、同文本重发 = 重试、先释放再发终态）；`session.latest` / `session.messages` 与渲染端启动恢复（验收 5；阶段 0 验收 4 不回退）
- [ ] 14. `provider.list` / `provider.configure` / `provider.select`、`config.json` 的 `provider` 字段、由 `ConfigKey[]` 渲染的最小设置卡（两份 locale 目录加键）、`TENON_SECRETS=memory` 的 e2e 机密接缝、locale 键存在性单测、开发期环境变量回落（`TENON_MODEL` 未命中内置表时合成保守 `ModelInfo`、`TENON_MAX_TOKENS` 保留）与 `TENON_PROVIDER`、`pnpm test:live` 的 zhipu 用例（验收 6、21）
- [ ] 15. `packages/contracts/src/bridge/frame.ts`：信封、五种协议帧、版本协商、未知帧路径（验收 19）
- [ ] 16. 对照 spec 全部验收标准逐条验证，把每条的结果与命令记在本文件；记下 5000 条分页与 1 万条校验链的耗时
- [ ] 17. 清理临时探针与非持久的夹具；确认 `packages/kernel/src` 够不着任何 `node:http` 假服务器
- [ ] 18. spec 顶部改 `Status: implemented`，写交接

进度吃紧时的砍法，按这个顺序：先砍第 15 步（桥骨架），再砍第 14 步里的设置卡（IPC 与 `config.json` 字段保留，界面并入阶段 3 的设置工作）。**第 3–7 步不能砍**——它们是以后补不了的那部分。

## 起草记录（2026-09-17）

- spec 由 Claude Code 按 owner 的「你来做」起草；owner 于 2026-09-18 认可并指示改为 `Status: ready`、合并后开工。
- 草稿经过一轮五个角度的对抗审查（各配一名反驳者）：64 条里 45 条成立并已修进 spec，4 条高危分别是 incarnation id 无处传入、OpenAI SDK 的凭据规则、`Usage` 未定义且 Anthropic 一个流发两条 usage、amend 状态过期。随后一轮执行复核（照修订后的文本实现 store 并逐条跑不变量，外加修复落地核对）确认 45 条全部落地，又找到 11 条并已修：对不存在的 session 做 `resetSession` 会凭空建会话、`runId` 进了 `message/user` 的 payload 会让重试变冲突、原验收 9 测不出 store 有没有回滚、`promptHash` 缺请求参数快照无法复核，等等。
- 依据：三项实测（SQLite 绑定、两家 SDK 的 fetch 注入与流形状、DeepChat Tape 补读），各经一轮独立的对抗复核；三套独立设计（最小不后悔 / 服务端与审计优先 / 循环与恢复优先）加两名评审逐条裁决，评审实际执行了各方案的 DDL 与分配语句。探针与中间产物不入库。
- R8 已在起草同一个 PR 里完成：`docs/reference/deepchat-mechanisms.md` §二之补。

## Open

- 开放问题见 spec 末尾（`x-stainless-*` 头、GLM 的 `reasoning_content` 回传、三平台 fsync 基准、主线程同步 SQLite 的搬迁阈值）。
- Ollama 的流式工具调用只从源码与已合并的 PR 核实过，没有对运行中的实例实测；`num_ctx` 默认 4096 会静默截断大 system prompt 的说法同样未实测。第 11 步接入时各探一次。
- 智谱的模型 id 以接入当天 `docs.bigmodel.cn` 为准，不以研究报告为准。
