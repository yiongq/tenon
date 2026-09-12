# 00 · 地基 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态，不复述设计。

- [ ] 1. `pnpm init` monorepo：`pnpm-workspace.yaml`、`tsconfig.base.json`、oxlint / oxfmt 配置、`.editorconfig`、commitlint、**lefthook**（pre-commit: format + lint + typecheck；commit-msg: commitlint）
- [ ] 2. 建 `packages/kernel`、`packages/contracts`、`apps/desktop` 三个包，空实现能 build
- [ ] 3. lint 规则：`packages/kernel` 禁 `electron` / `node:fs` / `node:child_process` / `keytar` import；包边界规则 `apps → contracts → kernel`
- [ ] 4. `HostAdapter` 接口按 spec 落到 `packages/kernel/src/host/`；`keyFor(identity, ...parts)`；内存版假实现（测试用）
- [ ] 5. `DesktopHostAdapter`：fs / secrets（keychain）/ process（spawn + 进程树 kill）/ sandbox（passthrough + 日志）/ confirm（投递到 IPC 事件）/ clock
- [ ] 6. kernel：最小 MCP host——用 `@modelcontextprotocol/client@2.0.0` + `HostProcess.spawn` 连 `server-everything`，`tools/list`，调 `echo`；对应验收 3 的测试
- [ ] 7. `packages/contracts`：`registerRoute` + 第一批 IPC schema（发送消息 / 流事件 / 停止 / 读写 config）；验收 6 的测试
- [ ] 8. Electron 壳：窗口 webPreferences 按 spec；preload 只暴露 contracts 通道；profile 目录布局
- [ ] 9. 最小 Anthropic 流式调用（不抽象），`AbortSignal` 贯穿到 fetch
- [ ] 10. UI：令牌（键名按 §8.5，值按 §8.1）、基础组件、壳层、Composer 最小态、消息流（block 注册表 + `text`）
- [ ] 11. `.claude/settings.json`：Stop hook 跑 `pnpm lint && pnpm typecheck`（Claude Code 专属的附加层；共享门禁是第 1 步的 lefthook）
- [ ] 12. `.github/workflows/ci.yml`：PR 触发 install / build / lint / typecheck / test
- [ ] 13. 仓库设置：secret scanning + push protection、`main` 分支保护
- [ ] 14. 对照 spec 验收标准 1–8 逐条验证并记录结果
- [ ] 15. 清理临时探针与测试
- [ ] 16. spec 顶部改 `Status: implemented`

## 交接（2026-09-12）

- 已完成：`.claude/settings.json` 设置 `includeCoAuthoredBy: false`；仓库保持 private，默认分支保持 `main`；已填写描述和 `electron`、`mcp`、`agent`、`typescript` topics。
- 本次交接提交包含 UX 规格边界、共享门禁和多 agent 交接规则；提交后推送 `main`，从同一提交创建并推送 `dev`，本地回到 `main`。日常 PR 目标为 `dev`。
- 第 13 步未完成：GitHub API 对私有仓库的分支保护返回 403，要求升级 GitHub Pro 或公开仓库；Secret scanning 启用返回 422（此仓库不可用）；单独请求启用 Push protection 后返回状态仍为 disabled。按用户要求保持私有，不更改套餐。
- 下一步：从第 1 步搭建 monorepo、commitlint 和 lefthook，再按计划推进；pnpm 检查脚本、CI、Claude Stop hook 当前尚未落地。本次仅检查文档 diff 和配置，未运行不存在的构建或测试脚本。
