# 06 · log

## 挑刺评审 · 2026-11-08 · Codex r1–r4（草稿，放进仓库之前）

- r1：1 blocker、4 major、2 minor；草稿第二版逐条照改（D11 补记、D16、D27–D29、E20 更正、验收重排）。
- r2：r1 六条已修、一条部分修；另 1 major、2 minor；第三版照改（D30、E25 重写、P1 补证 dist）。
- r3：r2 两条已修、一条部分修；另 1 major、2 minor；第四版照改（回不去的点分三种情况、D31、D32）。
- r4：无 blocker、无 major；3 个 minor 已改（验收 44 与 38 的工具行范围、E36 的类别校验范围、第 14.1 步的条数算法）。
- 原文在私有笔记 `2026-11-08-06-approval-modes/review-codex-r*.md`。

## 2026-11-09 · 改 ready

- owner 回复：「06 改 ready」（对话）。
- 第 1.3 步（Opus 挑刺评审 r2）在改 ready 时还没跑，改为与第一段并行补跑；发现照常处置，动到「给你看的一页」的先问 owner。


## 2026-11-09 · 第一段实现与交接

- 范围：plan 第 2–5 步、验收 1–17。第 6 步的独立评审与 StrykerJS 未做；没有修改提示层、evals 基线、路由、界面、config 或 02/04/05 的 spec。改动留在工作区，不提交、不 push。
- 档位事实：声明 `session/approval_mode_set` 的载荷、名字与 ordinal 键；按当前 incarnation 折叠，旧会话没有事实时为手动。`setApprovalMode` 经根 mailbox 写草稿或事实，拒绝未知会话、对话与子会话；自动档被策略关闭时拒绝切入。建立时草稿选择优先，默认为自动才写 default，显式选择手动也写 user；清空时完整携带最后一条事实。下一次判定禁用自动档时追加 policy/manual。
- 自动档判定：`LayerInputs` 只增约定的三项。文件工具读根快照状态；命令同时核对真实姿态、最终计划、平台查询、重定向名单。五个照问原因按 spec 排序，full-access 与绑定重跑不带 autoAsk。命令免问使用新 modeRule 与已有 auto-mode 摘要；本会话授权仍先于档位，免问不生成授权。
- 覆盖写与环境：模式表只增加七行，每行带命中与不命中样例，连同重定向例外在模块加载时自测。执行时从 dispatch 指向的判决读取依据，只有真正按 auto-sandboxed-command 派发的命令过滤环境；名单、前缀与大小写不敏感的五种后缀为 kernel 常量，传给 wrap 的已是过滤结果，原始环境不被修改。
- 实现取舍：档位事实不产生额外显示投影、不改 projection version，继续通过 Tape 读取。创建与政策事实的 writer 为 resolver；清空照 spec 原样携带载荷。切档复用正在运行的根租约，空闲时取得短租约检查宿主退出闸，避免给同一根开第二份活租约；desktop 既有退出流程同步关闸并中止全部租约。查询与执行均只经现有 host/loop 端口。
- 回归测试：验收矩阵 1–17 的名字逐字采用，67 个参数化用例。验收 3 执行 25 次真实内存文件删除，并通过 preview/restore 恢复全部内容；验收 4 包括 warming、file-only 与整树拍摄失败；验收 9 的 28 个手动判决夹具由修改前 HEAD 的 decide 采集（完整 record、summary、confirm/block），不在运行时重算期望；验收 17 按字面逐个列出名单与五种后缀变量，核对 wrap、保留普通变量、手动授权与自动档必须问后授权两种透传。共享 conformance 另核对事实读回、去重、哈希链、重放、投影重建及同存储租户隔离，在内存与 SQLite 都跑。
- 调试记录：首轮命令测试暴露 mailbox 包装漏转 autoCommands，已修复。随后发现新测试把 memory sandbox 的原型方法当作对象属性展开，缺少 afterExit/violations；已修正夹具，没有改弱断言。最终复核发现 startup recovery 未转发平台查询；先扩充验收 14，复现 redirect 被改成 platform 的失败，再修复 RecoveryDeps 与恢复接线，原卡现在保持原样。未加入临时调试代码。
- 测试改动：`packages/kernel/test/permission/commands.test.ts` · 覆盖写命令的 unknown/irreversible 清单 · 06 明确把五个旧 unknown 样例改为 irreversible，移到正例并保留原断言强度。
- 测试改动：`packages/kernel/test/permission/decide.test.ts` · 自动档与有快照 Edit/Delete 用例 · 补入新前提 snapshotStatus: tree，断言不变。
- 测试改动：`packages/kernel/test/tape/names.test.ts` · 完整名字清单 · 增列 approval_mode_set，继续逐项全量比较。
- 测试改动：`apps/desktop/test/tape/conformance.test.ts` · runs every case the kernel suite defines · 共享用例从 45 增到 46，增加完整性断言的预期数量。

突变自证逐个进行；每条先跑点名验收得到非零退出，再还原、跑同一命令得到 0。命令为 `pnpm vitest run --maxWorkers=2 packages/kernel/test/permission/approval-modes.test.ts packages/kernel/test/loop/approval-modes.test.ts -t '06 验收 N:'`：

| 临时突变 | 红的证据 | 还原后 |
|---|---|---|
| 自动文件分支去掉快照条件 | 验收 1 的 unavailable 断言，三个状态参数均失败 | 验收 1 三例通过 |
| commandSandboxed 只排除 unavailable | 验收 5 的 pending、degraded、缺 posture、sandbox 优先于 redirect 失败 | 验收 5 十三例通过 |
| autoCommands 缺省改 yes | 验收 5 的 missing platform query 失败 | 验收 5 十三例通过 |
| 删除 git reset --hard 模式行 | 验收 7 的 git reset --hard 失败 | 验收 7 七例通过 |
| autoStillAsk 不排除 /dev/null | 跑验收 8 时模块加载先失败：redirect self-test failed: npm test > /dev/null；未进入测试体 | 验收 8 七例通过 |
| 环境只按名单、不认后缀 | 验收 17 的 custom_TOKEN、custom_secret、Custom_Password、custom_API_KEY、custom_ACCESS_KEY 失败 | 验收 17 二十二例通过 |
| 子会话读自身档位 | 验收 11 首次调用未跟根自动档，失败 | 验收 11 通过 |
| 创建时默认值盖过草稿 | 验收 13 首次调用未按草稿自动档，失败 | 验收 13 通过 |
| carryEntries 不携带档位 | 验收 16 缺少清空后的档位事实，失败 | 验收 16 通过 |
| 免问 Write 写本会话授权 | 验收 10 的 approval_resolved 应为空断言失败 | 验收 10 通过 |

- 突变结果：10/10 被检测并逐个还原；其中 9 个在点名测试体变红，1 个由强制模块加载自测提前阻止。临时突变驱动与原始输出在工作区外的临时目录，未加入仓库，不登记供 CI 重跑的正式突变。
- 门禁：format:check、lint（含 i18n/colors/copy/tape 检查）、typecheck 通过。验收与存储及 recovery 相关套件 `pnpm vitest run --maxWorkers=2 packages/kernel/test/permission/approval-modes.test.ts packages/kernel/test/loop/approval-modes.test.ts packages/kernel/test/loop/recovery.test.ts packages/kernel/test/tape/memory-store.test.ts apps/desktop/test/tape/conformance.test.ts`：5 files / 188 tests passed。
- 全仓 `pnpm vitest run --maxWorkers=2`：285 files passed、5817 tests passed、135 skipped，2 files / 5 tests failed。stop-tree 四项在调用 ps 时报 spawn EPERM；snapshot-git 的真实残留回收用例等待进程退出超时，其恢复实现依赖 /bin/ps，读不到时保守返回不杀。两类均为当前沙箱环境限制，不改测试；真沙箱黑盒因未设置 TENON_SANDBOX_TESTS 按任务要求跳过，协调者在外补跑。
- 核心额外验证：`pnpm vitest run --maxWorkers=2 --project kernel --project contracts --project scripts`：2860 tests passed；无失败。
- 安装环境：使用空用户 npm 配置避免读取受限 ~/.npmrc；依赖下载完成，但 pnpm prepare 写共享主仓库 hooks 时被沙箱拒绝。没有修改或绕过 hooks，随后 pnpm build 完整通过，才运行 typecheck。
- spec-check：仍有 review 拦 1 条，要求新增独立评审记录。任务明确第 6 步评审归协调者，且禁止实现者写「## 评审」记录，因此没有伪造记录或绕过门禁。trace 18–44 与已有文档警告留到后续段；overview 同步按原 plan 第 21 步完成。
- 交接：第 2–5 步打勾，第 6 步不打勾；Status 保持 ready。协调者接着独立评审、StrykerJS、补跑上述平台用例与真沙箱，追加真实评审后重跑 spec-check。当前没有需要 owner 决定的 spec 歧义。

- 最后一轮验证：尝试用仓库根路径的 --exclude 排除上述两个环境文件；参数没有作用于子项目，实际仍执行全仓，JSON 报告仍为 5817 passed / 5 failed / 135 skipped，失败恰为相同五项。没有把这次结果说成通过，不再反复跑这五项；报告与命令原始输出保留在工作区外临时目录，交协调者在沙箱外补跑。
- 最终交接检查：`pnpm format:check`、`pnpm lint`、`pnpm typecheck` 均通过；`python3 .sdd/spec-check.py --index` 已生成入口页；`python3 .sdd/spec-check.py` 为拦 1 / 警 26，唯一拦截是缺独立评审。`git diff --check` 无输出；spec、decisions、evidence 与提示层未改，无临时源码与调试打印。
