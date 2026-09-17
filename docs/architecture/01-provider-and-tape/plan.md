# 01 · Provider 抽象 + 会话存储 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。每一步结束时仓库都是绿的。

- [ ] 1. **owner 确认 amend 机制**（spec「这次修补怎么记录」、开放问题 1）。确认后落地三处文字：`00-foundation/spec.md` 的 `Amended by:` 行、`docs/spec-driven-dev.md`「改变决定」一节的增补段、主参考 §13 阶段 2 / 阶段 4 两处「按 Revisions 规则处理」改为「按 amend 规则处理」。**确认之前不动这三个文件，也不做第 2 步。** 若 owner 不同意，按开放问题 1 的替代做法另开 spec，再回到第 2 步
- [ ] 2. `HostAdapter.network`：`FetchLike`、`HostNetwork`、`HostNetworkDeniedError` 进 `packages/kernel/src/host/adapter.ts`；desktop 实现；内存版 host 默认抛错；`.oxlintrc.json` 改 `fetch` 提示语并加 `WebSocket` / `EventSource` / `XMLHttpRequest` 与 import 禁用清单；`@tenon-app/kernel/testing` 导出路径与 `fakeNetwork`；esbuild `--platform=browser` 打包测试（验收 8）
- [ ] 3. kernel Tape 纯内核：`canonicalJson`、`@noble/hashes` + `hashEntry` 固定向量（含长度前缀防撞向量）、entry 类型、`provenance` 语法与校验器、保留命名空间表 + 双向断言 + slice 写入器（验收 12 的向量部分、13）
- [ ] 4. `TapeStore` 端口 + 内存 store + 共享 conformance 套（导出为接收 store 工厂的函数）：有界读取、`atEntryId` 钉住、`readBySource`、幂等与 `TapeProvenanceConflictError`、高水位分配、reset / delete 与 incarnation（验收 10、11、15 的内存部分）
- [ ] 5. 投影 reducer `project()`、折叠规则 `effectiveMessages()`、`rebuildProviderContext()`；内存 store 在 append 内应用 op；合成的 `tool_call` / `tool_result` 夹具（验收 3 的投影一半）
- [ ] 6. 两份 DDL 与方言映射表、`scripts/check-tape-schema.mjs` 挂进 `pnpm lint`（验收 17）。此时还没有代码加载它们
- [ ] 7. desktop SQLite store：钉 `better-sqlite3@13.0.3` 并追加进 `ignoredBuiltDependencies`；连接 PRAGMA；`schema_version` 迁移；`BEGIN IMMEDIATE` + 每个方法自己 `ROLLBACK`；spec 规定的 append 语句顺序；`safeIntegers` 经统一的 prepare 辅助；`Buffer → Uint8Array`；`undefined → null`；`tape_meta` 租户校验；`<profileDir>/sessions.db`。原样跑第 4 步的 conformance 套，加验收 4、9、10（双连接交错与强制锁）、12（1 万条 + 对拍）、14、15（2^53）、18
- [ ] 8. kernel provider 内核：类型、`BaseProvider`、`ProviderRegistry`、事件联合、块累加器、终态事件包装、`decideThinking`（验收 16）
- [ ] 9. 两个线协议适配器的 `encode()`（纯函数，产出 `promptHash` / `toolDefinitionsHash` / `thinkingDecisions`）（验收 2）
- [ ] 10. `@anthropic-ai/sdk` 移入 kernel、新增 `openai`，都钉精确版本；Anthropic 适配器的 `stream()`：`maxRetries: 0`、凭据显式、`{ signal }`、try/catch 错误映射、`usage` 先于终态；录制的 SSE 夹具（验收 7）。SDK 进 kernel 之后重跑第 2 步的打包测试
- [ ] 11. OpenAI 兼容适配器的 `stream()`（按 `index` 归位、`reasoning_content ?? reasoning`、`include_usage`、`requestParams` 透传）+ `anthropic` / `zhipu` / `ollama` 三个定义。`ModelInfo` 按厂商当时的文档填，未能确认的字段记到本文件的 Open（验收 1）
- [ ] 12. kernel session service：建 / 重置 / 删会话，`runId`（canonical UUID）与 `requestSeq` / `physicalAttempt`，`session/start`、`message/*`、`session/model_selected`、`provider/attempt_completed` 的写入；只写事实，不做循环（验收 3 的重放一半）
- [ ] 13. 重接 `apps/desktop/src/main/chat.ts`：删内存 `history` 与直接构造的 SDK；保留阶段 0 注释里写明的行为（先登记后 await、停止保留部分文本、失败轮次留存、同文本重发 = 重试、先释放再发终态）；`session.latest` / `session.messages` 与渲染端启动恢复（验收 5；阶段 0 验收 4 不回退）
- [ ] 14. `provider.list` / `provider.configure` / `provider.select`、`config.json` 的 `provider` 字段、由 `ConfigKey[]` 渲染的最小设置卡（两份 locale 目录加键）、开发期环境变量回落与 `TENON_PROVIDER`、`pnpm test:live` 的 zhipu 用例（验收 6、21）
- [ ] 15. `packages/contracts/src/bridge/frame.ts`：信封、五种协议帧、版本协商、未知帧路径（验收 19）
- [ ] 16. 对照 spec 全部验收标准逐条验证，把每条的结果与命令记在本文件；记下 5000 条分页与 1 万条校验链的耗时
- [ ] 17. 清理临时探针与非持久的夹具；确认 `packages/kernel/src` 够不着任何 `node:http` 假服务器
- [ ] 18. spec 顶部改 `Status: implemented`，写交接

进度吃紧时的砍法，按这个顺序：先砍第 15 步（桥骨架），再砍第 14 步里的设置卡（IPC 与 `config.json` 字段保留，界面并入阶段 3 的设置工作）。**第 3–7 步不能砍**——它们是以后补不了的那部分。

## 起草记录（2026-09-17）

- spec 由 Claude Code 按 owner 的「你来做」起草，`Status: draft`；由 owner 审后改 `ready`。开工前只需要 owner 做一件事：第 1 步的确认。
- 依据：三项实测（SQLite 绑定、两家 SDK 的 fetch 注入与流形状、DeepChat Tape 补读），各经一轮独立的对抗复核；三套独立设计（最小不后悔 / 服务端与审计优先 / 循环与恢复优先）加两名评审逐条裁决，评审实际执行了各方案的 DDL 与分配语句。探针与中间产物不入库。
- R8 已在起草同一个 PR 里完成：`docs/reference/deepchat-mechanisms.md` §二之补。

## Open

- 开放问题见 spec 末尾（amend 机制、`x-stainless-*` 头、GLM 的 `reasoning_content` 回传、三平台 fsync 基准、主线程同步 SQLite 的搬迁阈值）。
- Ollama 的流式工具调用只从源码与已合并的 PR 核实过，没有对运行中的实例实测；`num_ctx` 默认 4096 会静默截断大 system prompt 的说法同样未实测。第 11 步接入时各探一次。
- 智谱的模型 id 以接入当天 `docs.bigmodel.cn` 为准，不以研究报告为准。
