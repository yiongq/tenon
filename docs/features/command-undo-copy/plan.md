# command-undo-copy · plan

## 当前 / 需要你

当前：ready（2026-11-28 owner「command-undo-copy 改 ready」，Tier 与 agent 自定 5 项一并认了）。第 1–4 步做完（log 2026-11-28）；第 5 步：第一轮评审 3 条 major 已修（74cbae6），第二轮复审确认修好、又报 2 条 major，也已修，等第三轮复审（最后一轮，再有就交 owner）。
需要你：无。第 6 步真窗口验收要在你的 Mac 上起应用，到时先问你。

## 步骤

- [x] 1. 审批卡：先在 `renderer-approval-card.test.ts` 写验收 1、2 的失败用例（快照状态参数化、子任务卡、`irreversible`、文件与连接器与联网卡不变），再改 `lib/approval-card.ts` 的 `undoKey` 加两个可选入参；`components/thread/ApprovalCard.tsx` 从 `useSnapshotRounds()` 取 `status`、连同已有的子任务标记传进去。
- [x] 2. 工具行：先在 `renderer-tool-row.test.ts` 写验收 3 的失败用例（有无快照号、`irreversible`、其余工具不变），再改 `lib/tool-row-effect.ts` 的 `toolRowEffect` 加 `hasSnapshot`；`components/thread/ToolRow.tsx` 把已算出的快照号有无传进去。
- [x] 3. 文案：两份 locale 加 `confirm.undo.commandRestorable`、`confirm.undo.commandRestored`，文案覆盖测试穷举这两个键并查机制词（验收 4）。
- [x] 4. 文档：总参考「以后再说」里那一行改成指向本 spec 的已办写法（照同节已有的「（原「…」一行）」格式）；`docs/ux/components.md` 的 ApprovalCard、ToolRow 两行如写到 ④ 的句子，补一行带日期的补记。
- [ ] 5. 跑 format、lint、typecheck、相关 Vitest（`--maxWorkers=2`）与 `python3 .sdd/spec-check.py`；新上下文里独立评审，带证据的问题按细则分类处置。
- [ ] 6. 真窗口人工验收 5（macOS，独立配置目录，owner 同意后起应用）。
- [ ] 7. owner 验收 → 改 Status

## 交接

（还没有。每次停下前重写，只留最新一条：日期、已完成、半成品（代码停在什么状态）、下一步。）

## Open

（无）
