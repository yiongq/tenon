# command-undo-copy · log

## 实施 · 2026-11-28（第 1–4 步）

- 先写用例、看到变红：`renderer-approval-card.test.ts`「command-undo-copy 验收 1、2」、`renderer-tool-row.test.ts`「command-undo-copy 验收 3」、`copy-coverage.test.ts`「command-undo-copy 验收 4」与 presentation-r1 验收 14 的清单里加上两个新键；改实现前验收 1、3、4 与 presentation-r1 验收 14 红，验收 2 绿（它守旧行为不变）。
- 实现：`lib/approval-card.ts` 的 `undoKey` 加 `snapshotStatus`、`subtask` 两个可选入参；`ApprovalCard` 从 `useSnapshotRounds()` 取 `status` 连同已有的子任务标记传入。`lib/tool-row-effect.ts` 的 `toolRowEffect` 加 `hasSnapshot`；`ToolRow` 先算这次调用的快照号再算这一行。两份 locale 各加两句。改完五个相关测试文件全绿。
- 测试里新加了 `SnapshotProvider` 的 mock（两个文件各一个，默认不给快照数据），原有用例的行为与改动前一样。
- 文档：总参考「以后再说」那一行改成指向本 spec 的已办写法；`docs/ux/components.md` 只写了「④ 说后果」，没引这句原文，不改；overview 不写界面文案的选法，不改。
