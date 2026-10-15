# 模型显示名 — 执行计划

对应 [spec.md](./spec.md)。只记步骤和状态。代码先于 spec 落地（`38d4a1b`），本计划记的是补写 amendment 时的核对。

## 步骤

- [x] 1. 代码与测试：`ModelInfo.nameKey`、`providerModelSchema.nameKey`、`menuRow` 转发、菜单与 chip 读显示名、两份 locale 的 `model.name.*`（`38d4a1b`）。
- [x] 2. 补 amendment（2026-10-15）：本 spec；01、02 顶部各加一行 `Amended by:`，正文不动。
- [x] 3. 对照验收 1–3 逐条核对：所列测试在 feat/ux-craft 上通过。
- [x] 4. 评审修正（2026-10-15）：`Status` 改回 `draft`，`Owner` 行写明 owner 尚未接受；引用 02 改为节名加引文；`Amends:` 补「位置与触发器」「设置卡」；验收 3 改引实际的测试。记在 spec 的 `Revisions:`。
- [x] 5. owner 在本 PR 评审中接受（2026-10-15，PR #46） → 同一个 PR 里把 spec 的 `Status` 改为 `implemented`；驳回 → 撤掉 `38d4a1b` 的契约改动和 01、02 顶部的 `Amended by:` 行。
