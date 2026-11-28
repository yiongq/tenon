# 命令改动能不能还原的说法

Status: ready
Approved: ready · 2026-11-28 · 「command-undo-copy 改 ready」 · 对话
Tier: standard — 换审批卡与工具行上说后果的那一句（属权限语义的文字，但判定、按键、期限与契约都不变），并逐条替换已 implemented 的 presentation-r1 条款
Changes: presentation-r1 §审批卡（替换：④ 表里「`unknown`，其余」一行）；presentation-r1 §工具行（替换：接 ④ 的那一句）
Related: [05-file-bridge](../../architecture/05-file-bridge/spec.md)（命令改动只在整树快照里、命令的卡不出「有快照」那句）；[06-approval-modes](../../architecture/06-approval-modes/spec.md)（第 24 步实机验收时发现两句打架，log.md 2026-11-28）

## 给你看的一页

做什么：命令的审批卡和展开的工具行，按快照的实情说命令的改动能不能还原；能还原时不再写「没法替你撤回」。
你会看到：
- 任务文件夹整体有快照时，命令的审批卡写「它在任务文件夹里改的文件一般能随这一轮还原；文件夹外的、联网发出的、`.git` 里的和被排除的文件撤不回。」
- 命令跑完、这条命令留了快照号、这一轮还能还原（结算行有「可还原」）时，展开的工具行写「运行了这条命令 · 它在任务文件夹里改的文件能随这一轮还原；文件夹外的、联网发出的、`.git` 里的和被排除的文件撤不回。」
- 其余情形照旧「如果它改了东西，Tenon 没法替你撤回。」；撤不回的命令照旧是红色的「撤不回。」。
不做：不改哪些命令要问、按键、默认焦点、钮上的期限；不改结算行与还原清单；命令卡仍不出「有快照，这一轮可以一键还原」那句；文件工具、连接器与联网的卡和行不变；子任务里的命令不变。
代价和已知限制：卡在命令跑之前出，那时还不知道这一次整树快照拍不拍得成（首张没拍完或拍失败时，这一轮结算行会写「命令的改动可能无法还原」），所以卡上写「一般能」；快照状态没读到时一律用旧句；子任务里的命令照旧用旧句，哪怕它改的文件其实能随根会话的这一轮还原。
要你定的：D1 你已选「卡和行都按实情说」（2026-11-28），这比 05 的 D8「命令的卡不标『有快照』」放宽了一步；agent 自定 6 项（含档位；评审之后改了一项、加了一项，见修订记录），列在 decisions.md，不推翻就算一并认了。
怎么算做完：
1. 整树快照的任务里，命令卡的后果句是「一般能随这一轮还原」那句（验收 1）
2. 别的快照状态、读不到状态、子任务卡，命令卡仍是旧句；撤不回的命令仍是「撤不回。」；文件、连接器、联网的卡不变（验收 2）
3. 留了快照号、这一轮还能还原的命令，展开的工具行是「能随这一轮还原」那句；没留快照号或这一轮已不能还原的仍是旧句（验收 3）
4. 两份 locale 有两句新文案，文案覆盖测试穷举，中英文不含机制词（验收 4）
5. 真窗口里自动档跑一条命令，展开行和结算行不再打架；手动档的命令卡是新句（验收 5）

## 外部依据

无外部依赖，未调研。依据都在仓库里：05 §已知限制与代价（命令的改动只在 `tree` 时进快照；被排除的文件、你自己的 `.git`、联网发出的还原不了；派发前没拍成整树时结算行写「命令的改动可能无法还原」），05 §接口 的 `snapshot.rounds`（会话 `status` 与每轮 `calls` 的快照号），05 验收 3（Bash 的卡在任何情形下都不出「有快照」）。

## 接口

不改契约、IPC 通道、Tape 与提示层。只动 renderer 两个纯函数的入参与两份 locale。

```ts
// apps/desktop/src/renderer/src/lib/approval-card.ts
// 新增两个可选入参：本会话 snapshot.rounds 的 status（没读到时 undefined），
// 与这张卡是不是子任务卡（ApprovalCard 里已有的 callKey !== anchorCallKey）
export function undoKey(
  card: SentenceCard,
  snapshotStatus?: 'tree' | 'warming' | 'file-only' | 'unavailable',
  subtask?: boolean,
): string | null

// apps/desktop/src/renderer/src/lib/tool-row-effect.ts
// 新增可选入参：这次调用在 snapshot.rounds 的 calls 里有快照号、而且它所在那一轮的
// canRestore 为真（与结算行出不出「可还原」同一个条件）；返回值形状不变
export function toolRowEffect(
  outcome: ToolOutcomeViewContract | null,
  toolName: string,
  restorable?: boolean,
)
```

实现位置：apps/desktop/src/renderer/src/lib/approval-card.ts → undoKey
实现位置：apps/desktop/src/renderer/src/lib/tool-row-effect.ts → toolRowEffect

两条新键：

| 键 | 中文 | 英文 |
|---|---|---|
| `confirm.undo.commandRestorable` | 它在任务文件夹里改的文件一般能随这一轮还原；文件夹外的、联网发出的、`.git` 里的和被排除的文件撤不回。 | Files it changes in the task folder can usually be restored with this round; anything outside the folder, sent online, in .git, or excluded can't. |
| `confirm.undo.commandRestored` | 它在任务文件夹里改的文件能随这一轮还原；文件夹外的、联网发出的、`.git` 里的和被排除的文件撤不回。 | Files it changed in the task folder can be restored with this round; anything outside the folder, sent online, in .git, or excluded can't. |

`ApprovalCard` 从 `useSnapshotRounds()` 取本会话的 `status`，连同已算出的子任务标记传给 `undoKey`；`ToolRow` 把已算出的这次调用的快照号与那一轮的 `canRestore` 合成 `restorable` 传给 `toolRowEffect`。

## 对 presentation-r1 §审批卡 的替换

只换 ④ 表里「`unknown`，其余」一行；④ 的前三条、表的其余行、①②③⑤⑥ 与「于是每张卡都写明」一段不变。替换后的全文（两行，按先后取第一行成立的）：

| 可逆性 | 中文 | 英文意思 |
|---|---|---|
| `unknown`，对象是命令（Bash），不是子任务卡，本会话 `snapshot.rounds` 的 `status` 为 `tree` | 它在任务文件夹里改的文件一般能随这一轮还原；文件夹外的、联网发出的、`.git` 里的和被排除的文件撤不回。 | Files it changes in the task folder can usually be restored with this round; anything outside the folder, sent online, in .git, or excluded can't. |
| `unknown`，其余 | 如果它改了东西，Tenon 没法替你撤回。 | If this changes anything, Tenon can't undo it. |

第一行仍写明后果（任务文件夹里的能回，文件夹外的、联网发出的、`.git` 里的与被排除的回不去），满足「于是每张卡都写明」里的「后果」一项；在沙箱外重跑、沙箱不可用的命令也能改文件夹外的文件，这句对它们同样成立。

## 对 presentation-r1 §工具行 的替换

只换「展开后」那一条里接 ④ 的那一句；做了哪类事的分类表、联网类不接 ④、例句与其余各条不变。替换后的全文：

「接的 ④ 按这次调用的 `reversibility` 照 §审批卡 ④ 的表（撤不回为「撤不回。」），只有一处例外：工具是 Bash、可逆性为 `unknown`、这次调用在本会话 `snapshot.rounds` 的 `calls` 里有快照号、而且它所在那一轮的 `canRestore` 为真时，接「它在任务文件夹里改的文件能随这一轮还原；文件夹外的、联网发出的、`.git` 里的和被排除的文件撤不回。」。」

## 一直要成立的规矩

- 命令卡在任何快照状态下都不出 `confirm.undo.snapshotted`（05 验收 3）。
- 可逆性为 `irreversible` 的命令卡与工具行，④ 永远是「撤不回。」。
- `confirm.undo.commandRestorable` 只在四样同时成立时出现：对象是命令、可逆性 `unknown`、不是子任务卡、传入的快照状态恰为 `tree`；快照状态缺失时等同于不是 `tree`。
- `confirm.undo.commandRestored` 只在三样同时成立时出现：工具是 Bash、可逆性 `unknown`、`restorable === true`（这次调用有快照号、而且那一轮 `canRestore` 为真）；本会话现在的快照状态不参与。
- 审批卡的按键、默认焦点、钮上的期限、标题、①②③ 与改动前逐字相同。

## 验收标准

1. 命令卡，可逆性 `unknown`、不是子任务卡、快照状态为 `tree`（手动档的一般命令卡、自动档照问的命令卡、在沙箱外重跑的卡与沙箱不可用的卡各一例）：④ 是 `confirm.undo.commandRestorable` 那句，不是「有快照」那句。
2. 同样的命令卡在快照状态为 `warming`、`file-only`、`unavailable` 与没读到时（参数化），以及 `tree` 下的子任务卡：④ 是「如果它改了东西，Tenon 没法替你撤回。」；`tree` 下可逆性为 `irreversible` 的命令卡仍是「撤不回。」；`tree` 下 Write、Edit、Delete、连接器与联网的卡 ④ 与改动前相同。
3. 展开的 Bash 工具行，可逆性 `unknown`：这次调用有快照号、而且那一轮还能还原时接 `confirm.undo.commandRestored` 那句，不论本会话现在的快照状态；没有快照号、或那一轮已不能还原（快照清掉了、已经还原过）时接旧句；可逆性为 `irreversible` 的仍是「撤不回。」；Write、Edit、Delete、连接器的行与改动前相同。
4. 两份 locale 都有这两个键，文案覆盖测试穷举；中英文都不含「模型」「沙箱」「inspector」/ model、sandbox、inspector。
5. （人工）（平台：macOS）真窗口，任务文件夹在「文稿」「桌面」以外：手动档里一条普通命令的卡，④ 是「一般能随这一轮还原」那句；自动档里跑一条 `touch`，展开的工具行是「能随这一轮还原」那句，同一轮结算行是「可还原」。

## 开放问题

（无）

## 修订记录

从 ready 起每次改动记一行：日期 · 哪一节 · 为什么 · 相关的提交号或 PR 号。

- 2026-11-28 · 给你看的一页、接口、两节替换、一直要成立的规矩、验收 1 与 3 · 收紧，照 a6f66a5 的评审：工具行的新句另要那一轮 `canRestore` 为真（快照清掉后快照号仍在，`restore.ts` 的 `calls` 不看 `snapshotsAlive`）；两句新文案限定在「任务文件夹里」、撤不回的一串加「文件夹外的」（在沙箱外重跑、沙箱不可用与「仅此路径」放行的命令能改文件夹外的文件，卡上认不全）；入参 `hasSnapshot` 改名 `restorable` · PR #95
