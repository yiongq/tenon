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

## 2026-11-09 · 第一段补充：r2 处置与交接

- 基础：第一轮实现已由协调者提交为 ff1760c，条文澄清为 15a2333。本轮读取私有笔记中的 `review-opus-r2-tests.md` 与 `review-opus-r2-rules.md`，只处理第一段；spec、decisions、evidence 与 plan 的 Open 不改。协调者报告上一轮在沙箱外全量 Vitest 5823 通过、macOS 真沙箱 120 通过，这两项不充当本轮差异的验证结果。
- 实现修正：卡比较排除唯一的解释字段 autoAsk，其余内容照比；默认档在发送预建开始、第一次 await 前与草稿一起采样；Read、Glob、Grep 保留第 6 层的 folder 授权；`>&` 只排除数字描述符或 `-`，文件名重定向仍问；模式自测函数可注入故意错误的样例，模块加载仍强制调用。没有新增路由、界面、config、提示层或外部服务调用。

测试视角逐条处置：

| 条目 | 处置与证据 |
|---|---|
| M1 | 已做。验收 1、5、6 走真实 judgeCall，宿主状态由内存 host / SandboxPorts 提供；不在测试里预填 commandSandboxed 或 autoAsk。矩阵层改为集成，并点名入口。 |
| M2 | 已做。验收 5 的反例参数化在两档分别核对工作区外、敏感路径、coverage none 的 Delete、策略关闭自动、七行覆盖写、文件与命令的 inspector ask，共 13 行；均不带 autoAsk。 |
| M3 | 已做。验收 5 点名 unavailable 快照 + unavailable 姿态、linux + unavailable 姿态、unavailable 快照 + 绑定重跑，三者均不带 autoAsk；例外优先于五种原因。 |
| M4 | 已做。验收 1 的 unavailable 用真实宿主 coverage none：Write / Edit 为 no-snapshot；Delete 为 irreversible、once，不带 autoAsk。没有伪造 unavailable + 有覆盖的 Delete。 |
| M5 | 已做。验收 1 另断言缺 snapshotStatus 的自动档 Write 照问；旧 decide 用例只保留 ff1760c 已补的 tree 输入，期望不变，分项记在下方。 |
| M6 | 已做。验收 7 自带七行字面量，不读取生产样例；含 checkout 两行与 restore 长短参数的 staged + worktree 命中。删除 reset 行与放宽 restore 例外均已突变自证。 |
| M7 | 已做，选 ①。用 git show 取 62fed4d 的完整旧 kernel 源码到忽略目录，实际运行旧 decide / judgeCall，重新录下 28 个 decide、57 个 judgeCall 的固定完整判决。覆盖七个维度的两两组合、四种可逆性、策略 / 敏感 / 工作区外 / 网络 / 连接器边界；夹具写明完整提交号。测试只查固定数据字典，不用当前实现重算期望。录制程序通过后删除临时源码与捕获测试，只留正式 JSON。 |
| M8 | 已做。验收 13 参数化「默认手动、草稿自动」与反向，断言同批建立事实为 user、档位正确、第一条 Write 分别放行 / 出卡。 |
| M9 | 已做。验收 12 在改默认和重启后验证无事实的旧任务仍手动；显式自动的任务重启时默认手动仍自动。另验证默认自动时建对话不写档位事实。 |
| M10 | 已做。验收 14 显式设 tree，直接核对重判本会 allow 而结果 unchanged，原卡在答复前与启动恢复后保留；同样的新 Write 真正免问完成为正对照。新增更宽重判突变已被该验收检测。 |
| M11 ① | 已做。验收 8 经 SessionService 发送、启动恢复、真实答复，要求 applied，并核对本会话授权与重复命令；自动免问的对照也实际执行。运行、答复、启动与直接 judgeCall 使用同一份稳定的 SandboxPorts。 |
| M11 ② | 已做。比较卡不比 autoAsk；验收 14 分别用 Write / Bash、双向切档、启动恢复与真实 applied 答复验证。 |
| m1 | 已做。矩阵附文点名 kernel 的原因 / 可逆性 / 恢复 / round 数据，以及既有 renderer 测试负责的文字、焦点、Enter 与删除计数；warming 命令显式断言 commandsWithoutSnapshot 为 true。相关 renderer 三文件也运行通过。 |
| m2 | 已做。assertCommandPatterns 在模块加载时调用；验收 7 注入错误 hit / miss 两种样例，各要求抛错。 |
| m3 | 已做。验收 17 增加小写与混写后缀，以及 TOKENIZERS_PARALLELISM、GH_TOKEN_PATH、MY_API_KEY_FILE 等应保留的近似名字；继续验证手动档给的本会话授权在自动档命中第 6 层时原样透传，及必须问后获准的命令透传。 |
| m4 | 已做。同 M11 ①，验收 8 改走真实答复与授权路径。 |
| m5 | 部分完成。kernel 的「无 SandboxPorts」「有端口但无 autoCommands」两种缺省都覆盖且应问 platform。desktop 平台映射单测留第三段第 15 步：第一段尚无该生产接线，不为单测添加提前开放的 desktop 实现或测试专用映射。 |
| m6 | 已做。验收 11 / 12 覆盖对子会话、未知会话、对话和关机中切档的拒绝，不写档位事实。 |
| m7 | 已做。验收 1 的标题与矩阵收窄到 Write、Edit、covered Delete。 |
| m11 | 已做。正向自动档夹具显式设置根快照状态，重启后重新设 tree；应问 no-snapshot 的夹具才保留 unavailable，验收 14 另有实际放行正对照。 |

规则视角第一段逐条处置：

- M3：已做。验收 11 用可暂停的 fake inspector，在检查等待期间切回手动，当前这次 Write 即出卡；再在检查期间把快照改 unavailable，当前这次出 no-snapshot 卡。档位与状态均取最后一次检查之后的值。
- minor 1(a)(b)：已做。与测试视角 M2–M4 合并，例外压过先后、第 5 层 ask 卡不带解释；同批反例在手动档也不带。
- minor 2：已做。验收 7 七行逐行字面量，checkout 分两行。
- minor 3：已做。验收 8 真答复覆盖 `>&out.log`、`>& out.log`、`>&2.log`、`>&-notes` 命中；`2>&1`、`>&2`、`>&-`、带空白的数字 / 关闭描述符不命中。
- minor 7：已做。同 M11 ②，只排除 autoAsk 的比较。
- minor 8(a)(c)：已做。验收 13 在连接器预建暂停时更改默认值，证明默认与草稿在发送开始时采样；验收 12 证明对话形态不写默认档事实。
- minor 11：已做。decide 的第 7 层集合仅含 Write / Edit / Delete；验收 9 对 Read / Glob / Grep 明确断言第 7 层 none，第 6 层 user-grant 放行，完整记录保持旧值。
- minor 13：已做。验收 9 对同一份固定输入分别跑手动 / 自动，仅允许原第 7 层的问变放行，其他判决保持；还显式限制工作区外、网络、连接器、敏感与策略的调用不能借此放宽。只忽略第 7 层自身记录与 autoAsk 解释，不忽略前六层和判决来源。

- 测试改动：`packages/kernel/test/permission/decide.test.ts` · 05 验收 29 · ff1760c 已补 snapshotStatus: tree，本轮保留该输入及原期望，缺省 unavailable 不能充当有快照前提。
- 测试改动：`packages/kernel/test/permission/decide.test.ts` · 02 旧 155 · ff1760c 已补 snapshotStatus: tree，本轮保留该输入及原期望，自动档放行的前提显式给出。
- 测试改动：`packages/kernel/test/permission/approval-modes.test.ts` · 验收 1、6、9 · 用真实 judgeCall 与旧版固定完整判决替换手填条件的循环断言；unavailable Delete 按澄清改核 irreversible，无 autoAsk。
- 测试改动：`packages/kernel/test/loop/approval-modes.test.ts` · 验收 8、12–14、17 · 答复要求 applied，新增双向选择、发送采样、快照正对照、重启与环境边界，不放宽原有期望。
- 先红后绿：源代码修正前，新回归运行 9 failed / 89 passed，失败涉及文件名重定向、默认采样、解释导致旧卡 stale、自测入口与读工具第 7 层记录；修正后 98 passed。随后新增四个描述符 / 文件名边界参数，最终结果见下方门禁。相关 10 文件套件在这四项加入前为 331 passed / 0 failed。

突变自证本轮重跑全部原十项，另加两项。每项逐个改、跑点名验收非零、还原、同命令返回 0；运行命令仍为 `pnpm vitest run --maxWorkers=2 packages/kernel/test/permission/approval-modes.test.ts packages/kernel/test/loop/approval-modes.test.ts -t '06 验收 N:'`。

| 临时突变 | 红的证据 | 还原后 |
|---|---|---|
| 自动文件分支去掉快照条件 | 验收 1 三种状态的 unavailable 断言失败 | 验收 1 三例通过 |
| commandSandboxed 只排除 unavailable | 验收 5 的 pending / degraded / 缺姿态 / sandbox 优先级四例失败 | 验收 5 二十九例通过 |
| autoCommands 缺省改 yes | 验收 5 的缺查询与缺整个端口两例失败 | 验收 5 二十九例通过 |
| 删除 git reset --hard 行 | 验收 7 的 reset 行失败 | 验收 7 九例通过 |
| autoStillAsk 不排除 /dev/null | 模块加载时 redirect self-test failed，未进入测试体 | 验收 8 七例通过 |
| 环境过滤不认后缀 | 验收 17 七个大小写后缀参数失败 | 验收 17 二十四例通过 |
| 子会话读自身档位 | 验收 11 的首次调用不跟根自动档，失败 | 验收 11 通过 |
| 默认值盖过草稿 | 验收 13 的两个相反选择均失败 | 验收 13 四例通过 |
| carryEntries 不携带档位 | 验收 16 的携带事实缺失，失败 | 验收 16 通过 |
| 免问 Write 写会话授权 | 验收 10 的 approval_resolved 应为空断言失败 | 验收 10 通过 |
| rejudgeWaiting 把更宽判决当真 | 验收 14 的 waiting 卡断言失败（tree 下重判实际 allow） | 验收 14 三例通过 |
| restore 的 staged 例外放宽到 worktree | 模块加载时 command pattern self-test failed: git restore worktree，未进入测试体 | 验收 7 九例通过 |

- 结果：12/12 检测且还原；10 项由测试体检测、2 项由强制加载自测提前阻止。没有把两项加载失败说成测试体断言失败。临时驱动、红绿输出在工作区外 `/private/tmp/06s1-r2-mutants*`，没有加入 CI 正式突变登记。
- 本轮门禁：`pnpm format:check && pnpm lint && pnpm typecheck` 全部通过。全量 `pnpm vitest run --maxWorkers=2 --reporter=json --outputFile=/private/tmp/06s1-r2-full.json` 为 288 files passed / 2 failed，5852 tests passed / 5 failed / 135 skipped / 8 pending；本段两文件 102 passed，连同 recovery、sandbox-bash、receipt-override、workspace、model-choice 与 renderer 三文件共 10 文件 / 335 passed。
- 全量失败与上一轮相同：`apps/desktop/test/stop-tree.test.ts` 四项在 ps 调用处 spawn EPERM；`apps/desktop/test/snapshot-git.test.ts` 的真实残留 git 启动恢复一项等待退出超时。后者实现依赖读取 ps，当前沙箱读不到时保守不杀。没有改弱测试、绕过权限或反复重跑；原始输出与 JSON 在 `/private/tmp/06s1-r2-full.*`，交协调者沙箱外复验本轮。真沙箱黑盒按原任务跳过，没有启动 Electron 或读取密钥。
- `python3 .sdd/spec-check.py --index` 已更新入口页；S 的唯一拦截仍是没有独立评审记录。按任务要求，第 6 步独立评审与 StrykerJS 由协调者做，实现者不添加假评审；trace 18–44、后段文档同步及既有警告留原阶段。第 2–5 步保持已勾，第 6 步未勾，Status 保持 ready。
- 最终交接：矩阵第一段 24 个标题与测试逐项匹配；plan 的 Open 与 15a2333 完全一致。所有临时突变已还原、旧版捕获源码已移除；本轮改动留工作区，未提交、未 push。无需要 owner 另定的条文问题。协调者接着审查逐条处置、补独立评审与 StrykerJS，复验本轮平台用例；m5 的 desktop 平台映射测试在第三段第 15 步接线时完成。

## 2026-11-09 · 第一段独立评审处置（e67773b 后）

- 输入：三份只读独立评审（对照 spec、保护、突变），原文在私有笔记 `impl-reviews/seg1-{spec,protection,mutants}.md`。只处理第一段第 6 步发现；协调者工作区中的 spec 已知限制与 plan Open 均保留，不改 decisions / evidence，不提交。下面是实施处置，不冒充新一轮独立评审。
- 并发修正：Run 的档位读取、计数与策略折叠写入作为一个根 mailbox 任务，和用户切档排队；答复本就在 resolver 任务内，不再排队造成自锁；启动恢复的档位写入也排根队。策略事实按实际入口记 run（含本次 runId）、resolver、recovery。没有吞掉 TapeProvenanceConflictError 或重用过期序号。
- 停止与关机：切档复用运行中租约，但用户停止的 signal 不再充当关机闸。LoopPorts 的 leases 增加可选只读 isShuttingDown 查询，desktop 既有 RunRegistry 与测试宿主都答实际关闸状态；这只是读取既有闸，不开放档位路由或配置。旧宿主没有查询时保留 quit / close-window 中止的保守兜底。切档只结束自己临时取得的租约，借用的 Run 租约不结束。
- 判定边界：快照可用在 decide、judgeCall 两处都改成 tree / warming / file-only 白名单；未知状态照问 no-snapshot。重定向描述符边界补引号；checkout / switch / restore 认合写短选项；restore 的 staged 例外仅看当前 restore 到下一个分号、管道、& 或换行之间，继续扫描后续 restore，不让别段的 staged 覆盖它。

逐条处置（A 为对照 spec、B 为保护、C 为突变视角）：

| 条目 | 处置 |
|---|---|
| A M1 / B m2 / C M2 | 已做。可暂停的真实 Run 测试在策略折叠读 head 时插入用户手动选择；要求两者成功、ordinal 连续且 policy / user 都保存。原实现为 provider-error，修复后通过；另用绕过 mailbox 的突变验证回归保护。 |
| A M2 | 已做。05 敏感路径旧测试补 tree；验收 5 的 sensitive / inspector 文件与命令用 tree；固定基线和变形关系补 tree 下 sensitive、inspector ask、protected；改 decide 的 Read 归属注释。下列「测试改动」逐项记录。 |
| A m1 | 已做。描述符后的引号视为边界，真实答复路径补 bash -c 双引号、sh -c 单引号样例。 |
| A m2 / B m3 | 已做。短选项支持 qf、qS、qW、SW；restore 的长短 staged + worktree 与多段复合命令同时进入模块自测和独立字面量测试。 |
| A m3 | 已做。验收 12 断言 default 与创建事实在同次 append；验收 16 观察 reset 事务的 start + carry，并参数化显式 manual / auto，均断言同批。 |
| A m4 | 已做。停止后 Run 尚在收尾时选择 manual 成功、活租约仍是原对象；随后关闸，同一个尚未结束的 Run 下切档回 refused。 |
| A m5 | 已做。策略折叠测试分别断言 Run、答复、恢复三种 writer；创建与用户选择继续断言 resolver。 |
| A m6 | 已做。矩阵的 5b、7b、8b、14b 改成实际守住的突变；比较卡不排除 autoAsk 登记为 M14。 |
| A m7 | 协调者已处理。保留其 Open 内容，不代改。 |
| B m1 | 已做。两处白名单及 Write / Bash 的未知状态反例；直接 decide 也验证未知值照问。 |
| C M1 | 已做。姿态转 unavailable 只改变卡 facts 时，直接重判必须 changed，旧答复 stale，新卡带 sandbox: unavailable，且不启动进程；O109 被此例检测，登记为 M15。 |
| C M3 | 已做。验收 14 运行中切档后断言 liveLease 非空；停止收尾例另断言对象身份不变。R02 被检测，登记为 M16。 |
| C m1 | 已做。不可用策略下自动档调用拒绝而不抛错，切档仍 set；策略禁止自动时允许选择 manual。 |
| C m2 | 已做。名叫 Write / Bash 的 MCP 工具都照问且无 autoAsk。 |
| C m3 | 已做。新增 /dev/null 近似路径、>\|、&>、2>、harder / forceful 边界、大写 restore、短选项和多段命令；自测负例每组放好坏各一条，区分 some / every。加载自测通过 resetModules 后仅对该模式样例的 Array.some 注入错误并重导入，删除加载调用会红。 |
| C m4 | 已做。手动档事实清空同样照抄；对话混入 auto 事实仍手动；创建、用户和三种策略入口 writer 受断言；子会话策略折叠只写根 Tape。 |
| C m5 | 已做。自动免问环境保留 AUTHTOKEN、MYPASSWORD、WEBSECRET、MYAPI_KEY、MYACCESS_KEY，继续过滤带下划线的后缀。 |
| C m6 | 已做。对策略折叠的读事实 / head / append 后三个停止窗口，以及切档 begin / 读事实 / head 后三个关闸窗口逐项控制，断言 stopped / refused 与后续 IO / 事实边界；按新语义重打六个对应突变。 |
| C m7 | 已做。保留三处 sandbox 转发；直接观察真实答复前、启动重判的 judgeCall 返回值，均与运行事实一样为 redirect，且使用同一个 SandboxPorts 对象，不靠 cardChanged。原历史实现记录的措辞按本轮要求更正。 |
| C m8 | 已做。直接 decide 对文件 / 命令的缺省、unavailable、未知状态、工作区外和缺 commandSandboxed 逐项判问；另测不可用策略拒绝。 |
| C m9 | 已做。从 62fed4d 旧实现新增录制 10 个 judgeCall 判决（现在共 67 个，decide 仍 28 个），含 Bash tree / warming / file-only、Linux、缺快照、重定向，以及 tree 下 sensitive / protected / inspector；放行关系至少 17 次、其中 Bash 至少 3 次，防止 if 分支测空。 |
| C m10 | 已做。未绑定、非法 id、读到事实但 head 为 null，分别断言 refused、TypeError、unknown-session 且不写事实。 |

- 测试改动：`packages/kernel/test/permission/sensitive.test.ts` · 05 验收 25、26、27 · 06 把缺快照状态收紧后，原 auto 维度被动变弱；补 snapshotStatus: tree，原敏感类别、once 与必须问的断言不变。
- 测试改动：`packages/kernel/test/permission/approval-modes.test.ts` · 验收 5 的 sensitive / inspector 反例 · 改用 tree，确保后面的自动分支本可放行而必须被前层压住。
- 测试改动：`packages/kernel/test/permission/approval-modes.test.ts` 与固定基线 · 验收 9 · 新增旧版真实录制的判决及放行分支最低计数，不从当前实现推期望。
- 测试改动：`packages/kernel/test/permission/decide.test.ts` · names the first allower in table order · 只修注释，Read 由第 6 层授权，断言不变。
- 测试改动：`packages/kernel/test/loop/approval-modes.test.ts` · 验收 12 / 16 · 增同批事务断言，16 的标题增加 %s 并覆盖两档，矩阵同步。
- 失败测试与夹具修正：首次新增回归 16 failed / 112 passed，其中实际实现缺陷涉及短选项 / 复合命令、未知状态、引号描述符、Run 与恢复 writer、写入竞争、用户停止。其余失败包括待补旧 Bash 基线计数，以及三个夹具观测错误（reset 事务未记录、内部函数无法被外部 spy 捕获、全局 some 模拟影响模块解析）；分别改用 reset 事务观测、运行持久化判决 + 外部重判返回值、只匹配模式样例的模拟。停止收尾测试还补真实内存时钟推进以完成既有 SIGTERM 宽限；没有放宽产品期望。
- 基线录制最初用了不存在的根 esbuild 路径，未得到输出；没有用新实现填空或降低计数。改用 kernel 既有 esbuild 实际运行旧源，新增 10 条记录成功后再验。临时旧源码、捕获入口和 bundle 已删除，输出在工作区外 `/private/tmp/06s1-r3-old-decisions.json`。

- 突变首轮 P29 存活：新增 writer 断言只落在创建，尚未落到已建立会话的用户切档；补验收 12 的 resolver writer 后重打，已红，还原绿。下表列最终结果，不隐藏这次首轮存活。
- desktop 既有 RunRegistry 用例另断言：user-stop 的租约已中止但闸仍开，beginShutdown 后查询为真；避免主进程把两个状态混用。

突变自证最终 49/49 检测、每个还原后两份验收测试通过；其中 C §2.2 的 25 个全部已检测（六个停止窗口按 mailbox / 关闸新实现调整原文，语义对应原缺口）。额外重打 C 的 N01–N13、比较卡的 autoAsk、三处端口、some/every、restore 大小写与扫描起点、两处白名单与绕过根队的突变；C §2.3 判等价的其余突变未改。命令均为 `pnpm vitest run --maxWorkers=2 packages/kernel/test/permission/approval-modes.test.ts packages/kernel/test/loop/approval-modes.test.ts`。

| 临时突变 | 变红的证据 | 还原后 |
|---|---|---|
| N01 | 06 验收 1: auto allows workspace Write, Edit and covered Delete while snapshots are tree, and asks safely when unavailable 8ms | 两文件 134 passed，退出码 0 |
| N02 | 06 验收 5: auto still asks for a command when pending, with autoAsk sandbox 3ms | 两文件 134 passed，退出码 0 |
| N03 | 06 验收 5: auto still asks for a command when missing platform query, with autoAsk platform 3ms | 两文件 134 passed，退出码 0 |
| N04 | 06 验收 5: auto still asks for a command when another platform, with autoAsk platform 3ms | 两文件 134 passed，退出码 0 |
| N05 | 06 验收 7: git reset --hard is irreversible in both modes; the misses stay unknown 6ms | 两文件 134 passed，退出码 0 |
| N06 | Error: command pattern self-test failed: git restore worktree | 两文件 134 passed，退出码 0 |
| N07 | Error: redirect self-test failed: npm test > /dev/null | 两文件 134 passed，退出码 0 |
| N08 | 06 验收 17: an unasked command never receives custom_TOKEN; manual commands keep it 7ms | 两文件 134 passed，退出码 0 |
| N09 | 06 验收 11: a child follows the root's current mode 6ms | 两文件 134 passed，退出码 0 |
| N10 | 06 验收 2: a Write with no coverage is allowed in auto; a Delete with none asks irreversible 4ms | 两文件 134 passed，退出码 0 |
| N11 | 06 验收 16: clearing a session carries its auto approval mode 6ms | 两文件 134 passed，退出码 0 |
| N12 | 06 验收 8: a redirect asks once in auto with a session answer; npm test >> out.log does not 41ms | 两文件 134 passed，退出码 0 |
| N13 | 06 验收 14: switching to auto never releases a waiting card, even after a restart 6ms | 两文件 134 passed，退出码 0 |
| O22 | 06 验收 5: an MCP tool named Bash never gains autoAsk 3ms | 两文件 134 passed，退出码 0 |
| O51 | 06 验收 17: an unasked command never receives GH_TOKEN; manual commands keep it 6ms | 两文件 134 passed，退出码 0 |
| O71 | 06 验收 8: filename redirect npm test > /dev/null.log asks and accepts a real answer 6ms | 两文件 134 passed，退出码 0 |
| P33 | 06 验收 8: filename redirect npm test >\| out.log asks and accepts a real answer 5ms | 两文件 134 passed，退出码 0 |
| O78 | 06 验收 7: loading always runs command pattern self-tests 4ms | 两文件 134 passed，退出码 0 |
| O79 | 06 验收 12: chat stays manual even with a stray mode fact 6ms | 两文件 134 passed，退出码 0 |
| O87 | 06 验收 16: clearing a session carries its manual approval mode 5ms | 两文件 134 passed，退出码 0 |
| O109 | 06 验收 14: other card facts still invalidate an old answer 6ms | 两文件 134 passed，退出码 0 |
| P03 | 06 验收 11: a child follows the root's current mode 6ms | 两文件 134 passed，退出码 0 |
| P28 | 06 验收 15: disableAutoMode folds auto to manual and records a policy fact 7ms | 两文件 134 passed，退出码 0 |
| P29 | 06 验收 12: the mode fact survives a restart and new tasks start at the default 9ms | 两文件 134 passed，退出码 0 |
| P30 | 06 验收 12: the mode fact survives a restart and new tasks start at the default 11ms | 两文件 134 passed，退出码 0 |
| Q01 | 06 验收 15: unavailable policy denies calls but never throws on a mode choice 5ms | 两文件 134 passed，退出码 0 |
| Q02 | 06 验收 1: decide requires snapshot and command evidence for Write 2ms | 两文件 134 passed，退出码 0 |
| Q03 | 06 验收 15: unavailable policy denies calls but never throws on a mode choice 7ms | 两文件 134 passed，退出码 0 |
| R01 | 06 验收 15: policy never prevents choosing manual 5ms | 两文件 134 passed，退出码 0 |
| R02 | 06 验收 14: switching to auto never releases a waiting card, even after a restart 64ms | 两文件 134 passed，退出码 0 |
| R03 | 06 验收 12: mode choices validate binding, ids and a missing head 4ms | 两文件 134 passed，退出码 0 |
| R04 | 06 验收 12: mode choices validate binding, ids and a missing head 5ms | 两文件 134 passed，退出码 0 |
| O34 | 06 验收 15: a stop after policy facts prevents further judgement 3ms | 两文件 134 passed，退出码 0 |
| O35 | 06 验收 15: a stop after policy head prevents further judgement 3ms | 两文件 134 passed，退出码 0 |
| O36 | 06 验收 15: a stop after policy append prevents further judgement 4ms | 两文件 134 passed，退出码 0 |
| O97 | 06 验收 12: shutdown at the begin boundary refuses a choice without later IO 5ms | 两文件 134 passed，退出码 0 |
| O98 | 06 验收 12: shutdown at the facts boundary refuses a choice without later IO 5ms | 两文件 134 passed，退出码 0 |
| O99 | 06 验收 12: shutdown at the head boundary refuses a choice without later IO 5ms | 两文件 134 passed，退出码 0 |
| AUTOASK | 06 验收 14: changing only autoAsk never stales an answer for Write 6ms | 两文件 134 passed，退出码 0 |
| O104 | 06 验收 8: every judgement entry retains the same redirect explanation 9ms | 两文件 134 passed，退出码 0 |
| O105 | 06 验收 8: every judgement entry retains the same redirect explanation 7ms | 两文件 134 passed，退出码 0 |
| O106 | 06 验收 8: every judgement entry retains the same redirect explanation 7ms | 两文件 134 passed，退出码 0 |
| SOME-HIT | 06 验收 7: pattern self-tests reject invalid hit samples 4ms | 两文件 134 passed，退出码 0 |
| SOME-MISS | 06 验收 7: pattern self-tests reject invalid miss samples 3ms | 两文件 134 passed，退出码 0 |
| RESTORE-CASE | Error: command pattern self-test failed: git restore worktree | 两文件 134 passed，退出码 0 |
| RESTORE-TAIL | Error: command pattern self-test failed: git restore worktree | 两文件 134 passed，退出码 0 |
| WHITE-DECIDE | 06 验收 1: unknown snapshot state fails closed for Write 3ms | 两文件 134 passed，退出码 0 |
| WHITE-JUDGE | 06 验收 1: unknown snapshot state fails closed for Write 3ms | 两文件 134 passed，退出码 0 |
| MODE-TURN | 06 验收 15: a Run policy fold and user choice share the root mailbox 5ms | 两文件 134 passed，退出码 0 |

- 原始红绿输出与最终 JSON 在工作区外 `/private/tmp/06s1-r3-mut-*`、`/private/tmp/06s1-r3-mutants-final.json`。N06 / N07 及 restore 大小写 / 扫描起点等改坏生产样例的变体，会由模块加载自测提前拦，表中按实际输出记，不冒称进入测试体；O78 则由重导入的专用测试检测。
- 正式登记使用下列 M1–M16，对应 N01–N13、autoAsk 比较、O109 与 R02；门禁均为 test，登记时原文片段各在目标文件中恰好出现一次。脚本 --mutants 在 HEAD 建临时 worktree，本轮按要求不提交且沙箱外全量门禁尚待协调者复验，因此不声称正式 test 门禁已跑过；协调者提交后在沙箱外补跑 --mutants。

### 突变 M1 · N01 · decide 自动文件分支去掉快照状态条件 -> 验收 1 · 门禁 test
文件：packages/kernel/src/permission/decide.ts
原文：
```
    layers.place === 'workspace' &&
    snapshotAvailable
```
改成：
```
    layers.place === 'workspace'
```

### 突变 M2 · N02 · commandSandboxed 改成 posture.state !== 'unavailable' -> 验收 5 · 门禁 test
文件：packages/kernel/src/loop/batch.ts
原文：
```
ctx.host.sandbox.posture?.().state === 'active' &&
```
改成：
```
ctx.host.sandbox.posture?.().state !== 'unavailable' &&
```

### 突变 M3 · N03 · autoCommands 缺省读作 'yes' -> 验收 5 · 门禁 test
文件：packages/kernel/src/loop/batch.ts
原文：
```
const commandPlatform = ctx.sandbox?.autoCommands?.() ?? 'no'
```
改成：
```
const commandPlatform = ctx.sandbox?.autoCommands?.() ?? 'yes'
```

### 突变 M4 · N04 · 'no' 也给 linux（autoAsk 把 platform 写成 linux）-> 验收 5 · 门禁 test
文件：packages/kernel/src/loop/batch.ts
原文：
```
            : commandPlatform === 'no'
              ? 'platform'
```
改成：
```
            : commandPlatform === 'no'
              ? 'linux'
```

### 突变 M5 · N05 · 删掉 git reset --hard 一行 -> 验收 7 · 门禁 test
文件：packages/kernel/src/permission/reversibility.ts
原文：
```
  {
    row: 'git reset --hard',
    test: inOrder(GIT, word('reset'), option('--hard(?![\\w-])')),
    hits: ['git reset --hard', 'git reset --hard=HEAD~1'],
    misses: ['git reset --soft HEAD~1', 'git reset --harder'],
  },
```
改成：
```

```

### 突变 M6 · N06 · git restore 的 --staged 例外放宽到带 --worktree 也不命中 -> 验收 7 · 门禁 test
文件：packages/kernel/src/permission/reversibility.ts
原文：
```
        if (!staged || worktree) return true
```
改成：
```
        if (!staged) return true
```

### 突变 M7 · N07 · autoStillAsk 不排除 /dev/null -> 验收 8 · 门禁 test
文件：packages/kernel/src/permission/reversibility.ts
原文：
```
|=>|->|>=|>\s*\/dev\/null(?![\w/.-])/g
```
改成：
```
|=>|->|>=/g
```

### 突变 M8 · N08 · 环境过滤只认名单、不认后缀规则 -> 验收 17 · 门禁 test
文件：packages/kernel/src/permission/command-environment.ts
原文：
```
!TOKEN_NAMES.has(name) && !name.startsWith('OP_SESSION_') && !TOKEN_SUFFIX.test(name),
```
改成：
```
!TOKEN_NAMES.has(name) && !name.startsWith('OP_SESSION_'),
```

### 突变 M9 · N09 · 子会话读自己的档位 -> 验收 11 · 门禁 test
文件：packages/kernel/src/loop/batch.ts
原文：
```
const rootFacts = await readSessionFacts(ctx.tape, rootId)
```
改成：
```
const rootFacts = await readSessionFacts(ctx.tape, ctx.sessionId)
```

### 突变 M10 · N10 · 建会话时默认值盖过草稿里的选择 -> 验收 13 · 门禁 test
文件：packages/kernel/src/session/facts.ts
原文：
```
const mode = draft.approvalMode ?? defaultMode
```
改成：
```
const mode = defaultMode
```

### 突变 M11 · N11 · carryEntries 不带档位 -> 验收 16 · 门禁 test
文件：packages/kernel/src/session/facts.ts
原文：
```
  if (facts.approvalModeFact !== null) entries.push(approvalModeEntry(w, 0, facts.approvalModeFact))
```
改成：
```

```

### 突变 M12 · N12 · 免问时写一条会话授权（approval_resolved + session grant）-> 验收 10 · 门禁 test
文件：packages/kernel/src/loop/batch.ts
原文：
```
      const dispatchFacts = [decided, ...beforeSnapshotEntries(ctx, snapshot), dispatch]
```
改成：
```
      const dispatchFacts = [
        decided,
        ...beforeSnapshotEntries(ctx, snapshot),
        dispatch,
        ...(decision.record.decidedBy === 'approval-mode'
          ? [
              ctx.tape.writer('tool').entry('tool/approval_resolved', {
                sourceType: 'runtime_event',
                sourceId: ctx.runId,
                sourceSeq: ctx.requestSeq,
                provenanceKey: `tool:v1:approval:${ctx.runId}:${ctx.requestSeq}:${call.ordinal}`,
                createdAt: ctx.now(),
                payload: {
                  ordinal: call.ordinal,
                  providerToolCallId: call.providerToolCallId,
                  decisionKey,
                  outcome: 'allowed',
                  via: 'card',
                  grant: {
                    scope: 'session',
                    key: grantKey(
                      item.serverId,
                      item.originalName,
                      judged.grantObject ?? { kind: 'call', argsHash: call.argsHash },
                    ),
                  },
                  writer: { by: 'run', runId: ctx.runId },
                },
              } as never),
            ]
          : []),
      ]
```

### 突变 M13 · N13 · rejudgeWaiting 把更宽的判决当真（allow 读成 changed）-> 验收 14 · 门禁 test
文件：packages/kernel/src/loop/answer.ts
原文：
```
  if (verdict === 'ask' && cardChanged(waiting.decision, judged)) return { kind: 'changed', judged }
```
改成：
```
  if (verdict === 'allow') return { kind: 'changed', judged }
  if (verdict === 'ask' && cardChanged(waiting.decision, judged)) return { kind: 'changed', judged }
```

### 突变 M14 · AUTOASK · 比较卡时不排除 autoAsk · 门禁 test
文件：packages/kernel/src/loop/answer.ts
原文：
```
filter(([key]) => key !== 'autoAsk')
```
改成：
```
filter(() => true)
```

### 突变 M15 · O109 · cardChanged 排除全部 facts · 门禁 test
文件：packages/kernel/src/loop/answer.ts
原文：
```
Object.entries(confirm.facts).filter(([key]) => key !== 'autoAsk'),
```
改成：
```
[],
```

### 突变 M16 · R02 · [Stryker mailbox.ts:3363] setApprovalMode 总是结束租约（连借用运行中根的租约也结束） · 门禁 test
文件：packages/kernel/src/loop/mailbox.ts
原文：
```
const ownLease = box.lease === null
```
改成：
```
const ownLease = true
```

- 最终门禁：`pnpm format:check`、`pnpm lint`（含 i18n / colors / copy / tape）、`pnpm typecheck` 全通过；`git diff --check` 无输出。全量 `pnpm vitest run --maxWorkers=2 --reporter=json --outputFile=/private/tmp/06s1-r3-full.json` 为 288 files passed / 2 failed，5884 tests passed / 5 failed / 135 skipped / 8 pending。本段 permission 55 + loop 79 = 134 passed；desktop 的 RunRegistry / loop 23 passed，05 敏感路径原用例也全通过。
- 环境失败仍为相同五项：stop-tree 四项在 ps 处 spawn EPERM；snapshot-git 的真实残留 git 回收一项等待退出超时，其恢复实现读不到 ps 时保守不杀。不改测试、不重复跑这五项；原始输出在 `/private/tmp/06s1-r3-full.*`。真沙箱按原任务跳过，交协调者沙箱外复验本轮差异；没有启动 Electron 或读密钥。
- 文档门禁：spec-check 唯一拦截仍为缺新增独立评审记录，实施者按原任务不写「## 评审」或冒用三份外部评审作为本轮复核通过。协调者追加真实评审后再跑；第 6 步继续未勾，Status 仍 ready。StrykerJS 已由 C 给报告，本轮只补测试与手工突变，没有再跑一小时的同一批扫描。
- 更正（「第一段实现与交接」节的调试记录）：那句「先扩充验收 14，复现 redirect 被改成 platform 的失败」只在当时成立，靠的是待批卡比较间接验证。r2 把 autoAsk 排除出卡比较后，那条间接断言不再守住输入一致性；本轮补了直接观察真实答复前与启动重判返回值的测试，均仍为 redirect。逐条处置和新自证只追加。39 个矩阵标题逐字匹配，正式 16 个原文各恰好匹配一次；spec 与协调者 Open 对开工快照无变化。临时旧源码和 bundle 已清理，所有突变已还原，改动留工作区、不提交。无需要 owner 另定的问题。


## 2026-11-09 · 第一段复核处置（3b78178 后）

- 输入：对照 spec 的复核与测试 / 突变复核（下称 D、E），原文为私有笔记 `impl-reviews/seg1-recheck-spec.md`、`seg1-recheck-mutants.md`，只读。承接 3b78178，只处理第一段。本节及后续内容仅追加，不更改任何旧行。
- 取舍按协调者定法：关机闸查询与判定 writer 均改必填，删除两个缺省路径；生产的 Run / 答复 / 恢复已经明确提供实际身份。合写 staged 短选项在大写 S 前排除小写 s，避免把 source 的分支名当选项；staged 例外只看本段，worktree 看完整尾巴，后者只会收紧。

| 规则与处置 | 复核出处 |
|---|---|
| 已修。S 前不许小写 s，分支源参数 `git restore -sStaging x` 必须命中；行内 hits 和验收 7 字面量都补齐。 | D m1 |
| 已做。启动恢复暂停在策略折叠 append 时插入用户切档，要求恢复无错误、序号 0/1/2、user/policy/user 与 resolver/recovery/resolver 身份完整；恢复入口去掉排队回调会红，登记为正式突变 M17。 | D m2 / E m1 |
| 已做。LoopPorts.leases.isShuttingDown 必填，closed 仅调用它；删除中止原因兜底。测试中的关窗包装也转发同一查询。 | D m3 / E m2 |
| 已做。spec 只按协调者逐字插入接口注释与一条修订记录，其余字节不动。 | D m4 与本轮指令 |
| 已做。旧日志零删除、零替换；本节末追加代号说明，逐个定义历史表格里的临时代号；新记录先写规则，代号只作出处。 | D m5 |
| 已做。checkout / switch 的 fq、restore 的 Wq / Sq、带 & / 管道 / 换行的别段 staged，均进入行内 hits/misses 与验收 7 的独立字面量。 | E m3 |
| 已做。描述符后接右括号、分号、&、管道的四条样例，同时进入加载自测与验收 8 的不问参数表。 | E m4 |
| 已修。staged 只读本段，worktree 读整个尾巴；四条夹着引号 &、引号分号、描述符重定向、反斜杠续行的命令都在行内 hits 与验收 7，恢复判 irreversible。 | E m5 |
| 已做。modeTurn 移到 write 的 JSDoc 之前且有自己的说明；JudgeContext.writer 必填，折叠事实直接使用 ctx.writer；直接判定夹具显式填 resolver。 | E m6 |

- 测试改动：`packages/kernel/test/permission/approval-modes.test.ts` · 验收 7 / 2 · 增加独立边界字面量；验收 2 的直接判定上下文补必填 writer，原期望不变。
- 测试改动：`packages/kernel/test/loop/approval-modes.test.ts` · 验收 8 / 15 与直接判定夹具 · 增加四种描述符边界、可暂停的恢复并发例；四个既有直接上下文显式填 writer，原断言不变。
- 测试改动：`packages/kernel/test/loop/mcp-run.test.ts` · 直接 judgeCall 的 ctx · 补 resolver 输入，原判决与定义变化断言不变。
- 测试改动：`packages/kernel/test/loop/sandbox-bash.test.ts` · harness 的 judge · 补 resolver 输入，原重判和计划断言不变。
- 测试改动：`packages/kernel/test/loop/snapshot-coverage.test.ts` · harness 的 ctx · 补 resolver 输入，原覆盖与停止断言不变。
- 测试改动：`packages/kernel/test/session/receipt-override.test.ts` · harness 的 judge · 补 resolver 输入，原绑定、重判和恢复断言不变。
- 测试改动：`packages/kernel/test/support/approval-mode-judge.ts` · modeJudgeFixture 的 ctx · 显式提供 resolver，固定旧手动档判决的期望不改。
- 测试改动：`packages/kernel/test/loop/support.ts` · closedWindows · 必填的关闸查询继续转发到底层 ports，关窗行为与原用例期望不变。
- 先红后绿：新增边界在修正前使验收 7 的 restore 行红（1 failed / 138 passed）；修正正则并补齐必填 writer 的夹具后，两文件 139 passed。必填化中途暴露直接夹具缺 writer，导致四项写事实时无法序列化；这是输入夹具遗漏，已补输入，没有保留缺省或修改期望。
- 自证命令：`pnpm vitest run --maxWorkers=2 packages/kernel/test/permission/approval-modes.test.ts packages/kernel/test/loop/approval-modes.test.ts -t '06 验收 N:'`。新增 17 个临时突变均非零退出，还原后同命令为 0；其中四个恢复接线变体由测试体检测，十三个命令边界变体由新增加载自测样例拦下，未冒称进入测试体。原始输出与 JSON 在工作区外 `/private/tmp/06s1-r4-mut-*`、`/private/tmp/06s1-r4-mutants-results.json`。

| 临时改坏的规则 | 变红证据 | 还原后 |
|---|---|---|
| 恢复入口不转发根队任务 | 06 验收 15: startup recovery and user choice share the root mailbox 7ms | 验收 15 通过，退出 0 |
| 恢复任务直接执行 | 06 验收 15: startup recovery and user choice share the root mailbox 7ms | 验收 15 通过，退出 0 |
| 恢复任务排错根队 | 06 验收 15: startup recovery and user choice share the root mailbox 7ms | 验收 15 通过，退出 0 |
| 恢复重判不带队列 | 06 验收 15: startup recovery and user choice share the root mailbox 7ms | 验收 15 通过，退出 0 |
| source分支名误当staged | Error: command pattern self-test failed: git restore worktree | 验收 7 通过，退出 0 |
| worktree只看本段 | Error: command pattern self-test failed: git restore worktree | 验收 7 通过，退出 0 |
| checkout漏后置短选项 | Error: command pattern self-test failed: git checkout force | 验收 7 通过，退出 0 |
| switch漏后置短选项 | Error: command pattern self-test failed: git switch discard changes | 验收 7 通过，退出 0 |
| staged漏后置短选项 | Error: command pattern self-test failed: git restore worktree | 验收 7 通过，退出 0 |
| worktree漏后置短选项 | Error: command pattern self-test failed: git restore worktree | 验收 7 通过，退出 0 |
| staged漏命令边界& | Error: command pattern self-test failed: git restore worktree | 验收 7 通过，退出 0 |
| staged漏命令边界\| | Error: command pattern self-test failed: git restore worktree | 验收 7 通过，退出 0 |
| staged漏命令边界换行 | Error: command pattern self-test failed: git restore worktree | 验收 7 通过，退出 0 |
| 描述符漏后续边界) | Error: redirect self-test failed: (npm test 2>&1) | 验收 8 通过，退出 0 |
| 描述符漏后续边界; | Error: redirect self-test failed: npm test 2>&1;echo done | 验收 8 通过，退出 0 |
| 描述符漏后续边界& | Error: redirect self-test failed: npm test 2>&1&echo done | 验收 8 通过，退出 0 |
| 描述符漏后续边界\| | Error: redirect self-test failed: npm test 2>&1\|tee out | 验收 8 通过，退出 0 |

### 突变 M17 · 启动恢复档位读写绕过根会话排队 · 门禁 test
文件：packages/kernel/src/loop/mailbox.ts
原文：
```
      const recovered = await recoverTape({
        sandbox: bound.sandbox,
        modeTurn: (rootId, work) => post(mailboxOf(rootId), 'command', null, work),
```
改成：
```
      const recovered = await recoverTape({
        sandbox: bound.sandbox,
```

- 最终门禁：`pnpm format:check && pnpm lint && pnpm typecheck` 全部通过；`git diff --check` 无输出。全量 `pnpm vitest run --maxWorkers=2 --reporter=json --outputFile=/private/tmp/06s1-r4-full.json` 为 288 files passed / 2 failed，5889 tests passed / 5 failed / 135 skipped / 8 pending；本段 permission 55 + loop 84 = 139 passed。
- 五项失败与上一轮相同：stop-tree 四项在 ps 处 spawn EPERM，snapshot-git 的真实残留启动恢复一项等待退出超时，其实现读不到 ps 时保守不杀。没有改弱测试或反复重跑这五项；原始报告在 `/private/tmp/06s1-r4-full.*`。真沙箱按原任务跳过，留协调者沙箱外复验，没有启动 Electron 或读取密钥。
- 文档检查：spec 只有协调者指定的两行新增；log 的开工版本仍是当前文件的完整字节前缀，旧行零改动；Open 不变。40 个第一段矩阵标题逐字匹配；M1–M17 的原文各在对应文件恰好出现一次。spec-check 唯一拦截仍是缺新增独立评审记录，实施者不冒充本轮独立复核通过；协调者追加真实记录后再跑。
- 交接：本轮不提交，Status 仍 ready，第 6 步未勾。M17 的手工点名自证已做，正式 --mutants 的 test 门禁在当前沙箱仍因相同五项失败无法从绿基线起跑，且脚本按 HEAD 建副本；协调者提交本轮后在沙箱外跑。无需要 owner 另定的问题。代号说明只作历史记录索引，后续正文先写规则再附代号。

### 代号说明

以下只解释本段历史记录中的临时评审 / 突变代号，规则以前文和 spec 为准。N01–N13 已在正式突变 M1–M13 的标题与代码块定义；M14–M17 同样在各自登记块定义。

- P1：railguard 的 npm 依赖与接口核验，详见 evidence 的 P1 证据。
- O22：名叫 Write / Bash 的 MCP 工具不带 autoAsk。
- O34：根档位事实读完后遇停止，不再读 head。
- O35：策略折叠读 head 后遇停止，不再追加事实。
- O36：策略折叠追加完成后遇停止，不再形成判决。
- O51：令牌后缀必须带下划线，近似变量名应保留。
- O71：/dev/null 的近似文件名仍算重定向。
- O78：模块加载必须调用命令模式自测。
- O79：对话形态即使混入档位事实也恒为手动。
- O87：清空同样携带显式手动档事实。
- O97：切档开始时已关闸，不读事实。
- O98：切档读事实后关闸，不继续后续判定或写入。
- O99：切档读 head 后关闸，不追加事实。
- O104：答复前重判转发同一份 SandboxPorts。
- O105：mailbox 启动恢复转发 SandboxPorts。
- O106：恢复重判向 judgeCall 转发 SandboxPorts。
- O109：卡比较仅剔除 autoAsk，其余 facts 仍须比较。
- P03：子会话判定触发的策略折叠只写根会话。
- P28：策略折叠的 writer 按实际 Run / 答复 / 恢复入口记录。
- P29：已建立会话的用户切档记录 resolver writer。
- P30：创建批次中的档位事实记录 resolver writer。
- P33：强制覆盖的重定向仍应出卡。
- Q01：judgeCall 遇不可用策略时不直接读 snapshot。
- Q02：decide 遇不可用策略时拒绝而不抛异常。
- Q03：切档遇不可用策略时不直接读 snapshot。
- R01：策略禁止自动不妨碍用户切回手动。
- R02：运行中切档不能结束借用的 Run 租约。
- R03：切档入口拒绝非法会话 id。
- R04：切档入口在 bindLoop 之前回 refused。
- K2：对照 spec 复核中删除启动恢复根队回调的变体，对应本轮正式突变 M17。
- AUTOASK：比较卡时不算解释字段 autoAsk，对应正式突变 M14。
- SOME-HIT：自测命中样例只要有一条不命中就必须报错。
- SOME-MISS：自测不命中样例只要有一条命中就必须报错。
- RESTORE-CASE：restore 命令词按不分大小写识别。
- RESTORE-TAIL：staged 例外从当前 restore 后开始扫描。
- WHITE-DECIDE：纯判定只认可三种可用快照状态。
- WHITE-JUDGE：宿主判定只认可三种可用快照状态。
- MODE-TURN：Run 的策略档位读写排进根 mailbox。
