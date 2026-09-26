# 评测集

02 的评测集与同题对比（2026-09-25 改，见 [02 §提示层与评测](../architecture/02-agent-loop/spec.md)）。本目录只放题目、夹具、记录和对比结论；运行器、测试宿主和 zod schema 在 `apps/desktop/evals/`。规则以 02 spec 为准，本文件不另立规则。

## 目录

- `tasks/<NN>-<slug>.json`：一题一个文件，共 20–30 题，形状是 `apps/desktop/evals/task.ts` 的 `EvalTask`。
- `results/<YYYY-MM-DD>-<列>.jsonl`：一行一条记录，形状是 `apps/desktop/evals/record.ts` 的 `EvalRecord`。
- `compare/<NN>-<slug>.md`：同题对比，写两边的结果、差在哪、原因。
- `fixtures/<NN>-<slug>/`：工作区种子、假网页、假搜索结果。`.gitignore` 忽略任意层级的 `.env`，所以工作区里的 `.env` 存成 `dotenv.txt`，宿主复制时再改名；内容只放假的金丝雀值。
- 录屏和 Claude Code 一侧的原始记录放在仓库外，记录里只留文件名（`raw`）。
- 任何 provider key 的值都不进本目录；记录和命令里只写变量名（如 `$ZHIPU_API_KEY`）。

## 列定义

一列 = 客户端 × 模型 × 入口（`EvalRecord.column`）。每个模型固定用一个 effort 并记进记录，`null` 表示没传、用模型默认档。

| 列 | Tenon 一侧 | 对照一侧 |
|---|---|---|
| 基线（每题都跑） | 智谱的基线模型，走 `/paas/v4`，是验收基准；基线模型由小横评定 | — |
| 主对比（至少 10 题） | Opus 5.5 或 Sonnet 5，走 `api.anthropic.com`，用官方 key | Claude Desktop，选同一个模型，用 Max 订阅。`profile: 'chat'` 的题在 Chat 里跑；`cowork` 的题在 Cowork 本机会话里跑，用 Manual 档，连接 fixture 的文件夹。录屏对比 |
| 同模型列（对比集） | glm-5.3。先走 `/paas/v4`；T8 通过、补上评测专用行之后，改走 `/api/anthropic` | Claude Code + glm-5.3：接 `open.bigmodel.cn/api/anthropic`，Haiku / Sonnet / Opus 三个槽位全部钉成 glm-5.3，用 default（Manual）模式，在交互模式下手动跑 |

- 同模型列跑不通工具循环时改用 OpenCode（经 `@ai-sdk/openai-compatible` 接 `/paas/v4`）；只是 WebFetch 不通，就把 Claude Code 一侧的联网题记为 `excluded`。
- 没有官方 key 时，主对比的 Tenon 一侧先用 GLM 跑，每条记录的 note 写「Tenon 侧模型为 GLM，差距可能来自模型」；有了 key 再补跑。

## 运行命令

```
pnpm eval        # = pnpm build && TENON_EVAL=1 vitest run --project evals；不进 CI（同 test:live）
                 # TENON_EVAL_PROVIDER / _MODEL / _EFFORT / _RUNS（默认 3）/ _TASKS / _COMPARE_ONLY
pnpm evals:gate  # = TENON_EVALS_GATE=1 vitest run --project evals；评测基线建成（plan 第 34 步）时加进 CI，不进 pre-commit
```

- 命令、运行器与 zod schema 在 `apps/desktop/evals/`。`pnpm test` 只跑格式检查（tasks 和 results 过 zod，fixture 引用的文件都在），不联网，不要 key。
- key 只从进程环境读。发送前照常核对 key 绑定的主机，评测配置不开后门。
- 判分：全部是 script 检查的题，`judgedBy` 记 `script`，全部通过才算 pass；只要有一条 human 检查，就记 `human`，脚本结果写进 note 供人参考。

## 费用口径

- **Tenon 列按 Tape 算**：对每条 `provider/attempt_completed` 取它最终的 usage，乘以对应 `view/assembled` 所指的 `view/content(model_info)` 里的 `pricing`（冻结时的价格，不读当前模型表）；子 agent 的用量按每条 attempt 各自计入。缺缓存单价的按输入价计；没有 `pricing` 的费用记 null。
- `usage.input` 与费用同一口径，一律是未命中缓存的输入：`anthropic-messages` 的 `inputTokens` 本来不含缓存；`openai-chat` 的含缓存，先减去 `cacheReadTokens` 和 `cacheWriteTokens`。`reasoningTokens` 已算在 `outputTokens` 里，不重复计（智谱线按已含计）。
- **币种与汇率**：币种取 `pricing.currency`，缺省为 USD；折人民币时记下汇率和日期，汇率取中国外汇交易中心当日中间价。
- **非 Tenon 列**：拿不到分项用量的，`usage` 整个记 null；订阅侧 `cost` 记 null；Claude Code + 智谱这一列不逐条记费用，整列按智谱账单记在 `compare/` 的说明里。

## 已知差异清单

照抄自 02 §已知差异清单；第 1 条与第 8 条等 owner 补录后更新（plan 第 34 步）。

1. **手动档问的范围**：Tenon 的写入，每个文件本会话问一次；命令按原文本会话问一次，只读命令也问（E4）；撤不回的只放行这一次（D10）（D7）。Claude Code 的 default 模式对 ls、cat、grep、git 只读形式等只读命令免问；Bash 的「不再询问」按仓库永久保存；文件编辑的授权到会话结束（Claude 底表 §9）。Cowork 的 Manual 档在已授权的文件夹里读写，不逐次问（D7、H3）。Cowork 覆盖已有文件、跑 shell 命令时弹不弹卡，还等 owner 补录。
2. **子 agent**：Tenon 前台串行（H5），Claude Code 默认后台并发。
3. **命令**：Tenon 超时就杀，没有后台命令（H7）；Claude Code 超时后转到后台。所以需要长驻进程的题，Tenon 会失败。
4. **执行代码**：对话形态不能执行代码（H1、H8），Claude Chat 能在沙箱里跑。
5. **搜索与抓取**：
   - Tenon 用智谱或 Anthropic 的搜索后端，在本机抓取，返回整页（H8、H7）。
   - Claude Code 的 WebSearch 是服务端工具。在同模型列里，它由智谱的 `/api/anthropic` 处理，能不能用看 T8。
   - Claude Code 的 WebFetch 多一次小模型调用，做有损提取；抓取前还会把主机名发给 api.anthropic.com 做安全检查。
   - Cowork 的本机会话在设备上抓取。
6. **入口**：同模型列切换入口之前，Tenon 走 OpenAI 兼容入口，Claude Code 走 Anthropic 兼容入口。后者把输出攒成大块再吐，特性支持也没有清单。
7. **OpenCode 顶上时**：它对 zai / zhipuai 会发 `clear_thinking:false`，Tenon 不发（A12）。
8. **录屏的体验版本**：owner 的录屏是 Claude 的旧体验，Chat 与 Cowork 还是分开的（H1）。
