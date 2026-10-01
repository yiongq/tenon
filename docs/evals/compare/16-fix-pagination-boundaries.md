# 16-fix-pagination-boundaries · 同题对比（2026-10-01）

任务形态：修 paginate.js 的 size 校验与循环边界，不改 test.mjs，修完运行 `node test.mjs`（修之前 size=0 会死循环）。检查：test.mjs 不变、隐藏边界探针通过、模型跑过测试且输出 `pagination passed`。列定义、方法与口径见 [总览](00-2026-10-01-summary.md)。

| 列 | 结果 | 卡 | 工具轮数 | 用时 | 费用 |
|---|---|---|---|---|---|
| A Tenon + Sonnet 5 | pass | 命令 4、写入 1 | 5 | 15.8 秒 | $0.0277 |
| B Claude Desktop + Sonnet 5 | pass（人工判，「跑过测试」未经 Tape 核） | 文件夹 2；操作 0 | 未知（界面显示 4 个工具） | ≤43 秒（上限） | 订阅 |
| C Tenon + glm-5.3 | **fail**（user-rejected） | 工作区外 1（宿主拒） | 2 | 5.6 秒 | ¥0.0191 |
| D Claude Code + glm-5.3 | pass（人工判） | 写入 1、命令 2 | 5 | 61.6 秒（含人工审批） | 约 ¥0.30（transcript 估） |

## 差在哪

- **A 与 B**：都修好了，探针通过，test.mjs 没动；B 加了 size 必须是正整数的校验（否则抛 RangeError），循环改为 `i < items.length`。A 弹 5 张操作卡；B 只有 2 张文件夹卡，界面上能看到的步骤标签都是 Ran a command。B 的「跑过测试且输出 pagination passed」只有回复自述，没有 Tape 或转录可核。
- **C 与 D**：同一模型，结局相反。C 在第 2 轮碰了工作区外的路径，弹出工作区外卡，测试宿主只能拒，Run 以 user-rejected 结束：paginate.js 没改（探针退出 1），测试没跑。D 读两份文件、Edit、跑 `node test.mjs`、再自跑一条边界验证，始终没出工作区。

## 原因

- Tenon 对工作区外的路径一律出卡，评测宿主对这类卡只能拒（spec §评测集与测试宿主）；Tenon 拒掉一张卡就结束本轮、等下一条指令（[已知差异 #10](../README.md#已知差异清单)，owner 维持），评测题没有下一条指令，所以越界一次就成了 fail。越界之后的这段收口是设计加宿主规则，不是运行出错。
- 越界的是哪个路径、经哪个工具，记录里没有：Tenon 列只存按原因的卡数，运行目录连同 Tape 跑完即删。所以这题分不清是模型单次的做法，还是 Tenon 的路径判定有问题；同一 Tenon 版本上 A 没有越界。要定性，需要复跑并留下卡的目标。
- D 本次没有越界，Claude Code 怎样对待工作区外的路径，这题没有测到。
- A 与 B 的卡数差见 [已知差异 #1](../README.md#已知差异清单)。
