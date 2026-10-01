# 19-unicode-records · 同题对比（2026-10-01）

任务形态：读 records.json，筛 active，label 做 NFC 规范化，按 id 写出 public.json（期望 `Café` 的 é 为 U+00E9、`书 📚`）。列定义、方法与口径见 [总览](00-2026-10-01-summary.md)。

| 列 | 结果 | 卡 | 工具轮数 | 用时 | 费用 |
|---|---|---|---|---|---|
| A Tenon + Sonnet 5 | pass | 命令 2 | 4 | 13.8 秒 | $0.0247 |
| B Claude Desktop + Sonnet 5 | pass（人工判） | 文件夹 2；操作 0 | 未知（界面显示 3 个工具） | ≤36 秒（上限） | 订阅 |
| C Tenon + glm-5.3 | pass | 命令 2 | 4 | 29.1 秒 | ¥0.0740 |
| D Claude Code + glm-5.3 | pass（人工判） | 命令 3 | 5 | 47.6 秒（含人工审批） | 约 ¥0.29（transcript 估） |

## 差在哪

- **A 与 B**：输出相同，records.json 没改。A 经命令写文件，2 张命令卡；B 只有 2 张文件夹卡。
- **C 与 D**：输出相同，都经命令写文件、没有写入卡。D 先 ls、读文件（都免问），再跑 3 条 Bash（查码位、写文件、自查），各问一次；C 跑 2 条命令。

## 原因

- 审批范围（[已知差异 #1](../README.md#已知差异清单)）：两边都对非只读命令逐条问，本题的卡数差来自命令条数；Claude Code 的 ls 免问，Tenon 只读命令也问，但 C 本题没有单独跑只读命令。Cowork Manual 在已连接的文件夹里没有逐次卡。
