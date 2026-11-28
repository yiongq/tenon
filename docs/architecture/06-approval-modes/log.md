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

## 评审 · 2026-11-09 · 审过 316af4c

结论：通过    评审：第 6 步分三轮，每路都是新上下文的子 agent、只读，报告原文在私有笔记。第一轮审 e67773b，三路：对照 spec（不通过，0 blocker / 2 major / 7 minor）、保护（通过，0/0/3）、测试与突变（不通过，0/3/10）；修在 3b78178。第二轮审 3b78178，两路：对照 spec（通过，0/0/5）、测试与突变（通过，0/0/6）；修在 316af4c。第三轮审 316af4c（通过，0/0/1），逐条核了第二轮的 minor，并用 26 条命令实测 `git restore` 例外没有比 spec 更松的写法。lead 在沙箱外跑了：316af4c 上全量 5 895 条通过；`TENON_SANDBOX_TESTS=required` 的逃逸测试 120 条通过；format、lint、typecheck 通过；spec-check 只拦本条记录
突变：plan 第 6 步点名的 13 个，第一轮评审独立重打，全红。第一轮另设 133 个，存活 45：等价 20，测试缺口 25，缺口在 3b78178 全部补上用例，第二轮重打全红。第二轮对新代码另设 109 个，存活 24：等价 6，缺口 18，缺口在 316af4c 补上。第三轮 14 个，存活 1（`git restore` 合写短选项里 S 前不许出现大写字母），等价：S 前能出现的大写短选项只有 W，带 W 的本来就命中。正式登记 M1–M17，`--mutants` 在 316af4c 上 17 个全部变红。StrykerJS 只出报告：e67773b 上 578 个变异体，得分 72.81%，存活的簇已与手工结果逐簇对照
发现：
- [major] 档位事实有两处写入（Run 里的策略折叠、用户切档）不排同一条队，同时写会撞同一个序号，这一轮失败 · 证据：可暂停的探针复现序号冲突，原文与探针在私有笔记 · 已修 3b78178
- [major] 05 里几条「自动档也照问」的用例被测空：新规则要快照状态在场，旧用例没给，第 7 层本来就不放行 · 证据：对照 spec 那一路逐条看过，旧用例不给快照状态，自动档的放行分支一次都走不到，断言对新旧实现都成立 · 已修 3b78178
- [major] 比较卡变没变时，除 `autoAsk` 以外的字段没有用例守着 · 证据：比较时把 facts 整个排除的突变全量不红 · 已修 3b78178
- [major] 运行中切档借用 Run 的租约，没有用例守着 · 证据：切档时把 Run 的租约一并结束的突变全量不红 · 已修 3b78178
- [建议] 第一轮其余 minor：覆盖写新行认合写短选项、`git restore` 的 `--staged` 例外只看本条命令、`>&` 后跟引号、验收 12 与 16 的同批断言、用户点停止后照常切档、快照可用只认三种状态、策略不可用与只拦切到自动档、`setApprovalMode` 的入口守卫、三处写入方、端口转发可直接观察、验收 9 的 Bash 夹具与计数、令牌后缀的下划线、对话会话恒手动 · 证据：各条的突变或探针，见上面突变一行 · 已修 3b78178
- [建议] `git restore -s<分支名>` 被当成只改暂存区（第二轮改合写短选项时带进来，偏松） · 证据：`git restore -sStaging x` 在 e67773b 判撤不回、在 3b78178 判未知 · 已修 316af4c
- [建议] 第二轮其余 minor：启动恢复的档位读写排根队没有用例（登记为 M17）、关机查询改必填并删掉走不到的回退、`LoopPorts.leases.isShuttingDown()` 补登记进 spec §接口、log 的代号补说明、合写短选项与命令分隔符的边界样例、`2>&1` 后接 `)`、`;`、`&`、`|` 的样例、restore 切段让引号与续行后的 `--worktree` 漏判、`run.ts` 注释位置与 `writer` 必填 · 证据：各条的突变或探针 · 已修 316af4c
- [建议] `--worktree` 看整条命令后面的全部内容，`git restore --staged x; echo --worktree` 这类写法会多问一次 · 不修：偏严，是选定的写法；第 21 步在已知限制补半句（plan Open）
- [建议] `git restore` 例外照原文认字：`--no-staged`、`--work` 这类缩写、`#` 注释或 `>>`、`<<<` 后面的 `--staged` 也算只改暂存区，自动档里可能不问 · 证据：最后一轮的探针，判未知 · 不修：与 spec 字面一致，tree 快照能还原；第 21 步定写进已知限制还是收紧（plan Open）
- [建议] 改了 `ports.ts` 而 overview.md 没跟着动的同步警告，以及 spec 超过 heavy 档上限 · 不修：第 21 步文档同步一并处理（plan Open）

## 2026-11-10 · 撤销 12 个登记突变（CI 时限）

- #89 的 CI 在 `spec-check --mutants` 超时：17 个登记突变每个都要跑一遍全量测试，30 分钟跑不完，job 被取消。owner 回复：「只留 5 个，其余撤销」（对话，2026-11-10）。
- 留下 M1（快照状态条件）、M2（沙箱姿态）、M3（平台缺省）、M12（免问不写授权）、M15（比较卡的其余字段），都守自动档放行的条件。撤销的 12 个在 316af4c 上已由 lead 在沙箱外的 `--mutants` 与最后一轮评审各验证一次，全部变红；以后由各自点名的用例守着。

撤销突变 M4：与 M3 同守平台缺省；CI 时限，316af4c 上已验证变红，验收 5 的用例守
撤销突变 M5：CI 时限，316af4c 上已验证变红，验收 7 的字面量用例守
撤销突变 M6：模块加载时的自测本身就拦；CI 时限，316af4c 上已验证变红
撤销突变 M7：模块加载时的自测本身就拦；CI 时限，316af4c 上已验证变红
撤销突变 M8：CI 时限，316af4c 上已验证变红，验收 17 的用例守
撤销突变 M9：CI 时限，316af4c 上已验证变红，验收 11 的用例守
撤销突变 M10：CI 时限，316af4c 上已验证变红，验收 13 的用例守
撤销突变 M11：CI 时限，316af4c 上已验证变红，验收 16 的用例守
撤销突变 M13：CI 时限，316af4c 上已验证变红，验收 14 的用例守
撤销突变 M14：CI 时限，316af4c 上已验证变红，验收 14 的用例守
撤销突变 M16：CI 时限，316af4c 上已验证变红，验收 14 的用例守
撤销突变 M17：CI 时限，316af4c 上已验证变红，验收 15 的恢复并发用例守

## 2026-11-10 · 第二段实现（第 7–11 步）与交接

- 分路：第二段按文件分三路并行，A 路（Codex，kernel、contracts、主进程路由与 railguard 适配器）分两轮，B 路（Codex，desktop 的 `canReach`），界面与文案由 lead 做；第 12 步提示层最后单独做。几路都不写本 log 与 plan，由 lead 汇总。
- 第 7 步（A 路第一轮 527c593、B 路 5eab3eb）：Bash 的 `judgeCall` 在检查前采样能否联网与是否免问、检查后按最终计划复核，有变就重跑，最多三次、第三次偏严；外带检查把能联网的 Bash 算作出口，来源记 'builtin'，没有同源豁免，连接器与 WebFetch 的判法原样保留（D33）；命令卡 facts 带检查的 `category`。desktop 的 `canReach` 与真正下发的白名单共用一份合并逻辑，读设置出错时答真；kernel 缺这个查询时也读作真。
- 第 11 步（A 路第一轮 527c593）：累计与连续 3 次并排计数，子会话交接回来时把它被拦的条数加进根会话这一轮；到 20 优先按本轮结束，`blocked-repeatedly` 带 `scope: 'round'`；重判写下第 20 条时续跑的 Run 开头先数；自动档的降档写在根会话，与 `run_terminal` 或那次 Agent 调用的收口同一次追加（D34、D35）。累计结束给模型看的句子留在 `closure.ts` 的 `roundDenialNote`，第 12 步接。
- 第 8–10 步（A 路第二轮，与界面同一个提交）：railguard 0.7.0 适配器只用 `inputHygiene`，`deny` / `local-rule`，参数照 D21；两个新类别与 `inspector-flagged`；`tool/inspector_override` 的事实、键、投影与两种存储的共享一致性用例；`releaseInspector` 在根会话 mailbox 里核对、五种状态、关机中拒；只撤掉回执点名的那几个检查的拒，重判沿用已绑的；与 04 一次性放行共用作废算法，04 的三种放行行为不变（D37）；`inspector.release` 路由等启动恢复、关机中拒。告诉模型的检查点只做了机制，句子留在 `loop/sandbox-release.ts` 的 `inspectorReleaseNote`，第 12 步填 `toolName`、`argsHash`、`inspectorIds` 三个槽。
- 界面（lead）：检查给出的拦截回执下出「允许这一次」与说明一行，点过变「已放行」，重开后再点回 `already-released` 照样显示「已放行」（同 04）；「已不能放行」「找不到这一步」两句不说「命令」，因为被拦的也可能是文件路径；组织策略、保护名单、你关掉的回执没有按钮。命令卡带 `category` 时 ③ 出类别句（D36）；对象行沿用 02 ②′ 的 `\u{XXXX}`（D25）；本轮累计结束的那句结束文案；`inspector-flagged` 在「查看本次记录」里的一句。
- 突变自证：A 路第一轮 11 个、第二轮 7 个、B 路 1 个，都是临时打上、点名的验收变红、再改回（结果在各路的交接里，原始输出不进仓库）；界面一侧：去掉回执按钮、按钮出现在策略拦截上、结束文案不分 `scope`，各让验收 20 或 26 变红。
- 门禁：每一路做完都在沙箱外补跑。A 路第一轮加 B 路合在一起：全量 5 918 条通过；再加 A 路第二轮与界面：全量 5 965 条通过，逃逸测试 120 条通过，format、lint、typecheck 通过；spec-check 只拦缺评审记录（第 14 步写）。
- 中途碰到的环境问题：命令的当前目录短暂落在 locales 目录时，Claude Code 在那里建了一个空的 `.claude/.cc-writes`，i18n:check 把它当成第三种语言报错；删掉这个空目录即可，不进仓库。

测试改动：packages/kernel/test/permission/approval-modes.test.ts · 06 验收 9: the manual mode decides every fixture as before 06 · 命令卡新增 `category`，只补这个字段的期望，其余照旧完整比较
测试改动：apps/desktop/test/inspectors.test.ts · 02 不变量 17 与 receipt-override 写入方两条 · plan 第 8 步要求，精确检查两个注册项与两个专用写入方，与第 9、10 步同一个提交
测试改动：apps/desktop/test/shutdown.test.ts · 写入请求集合 · 加入 `inspector.release` 及其注册
测试改动：apps/desktop/test/tape/conformance.test.ts · 共享套件数量 · 新增共享用例，46 改为 47
测试改动：packages/contracts/test/approval.test.ts · 摘要码数量 · 新增 `inspector-flagged`，18 改为 19
测试改动：packages/contracts/test/confirm.test.ts · 类别清单 · 增加两个类别，并补成功校验
测试改动：packages/contracts/test/registry.test.ts · 路由清单 · 加入 `inspector.release`
测试改动：packages/kernel/test/tape/names.test.ts · 事实清单 · 加入 `tool/inspector_override`
测试改动：apps/desktop/test/copy-coverage.test.ts · 类别、「为什么停」与拦截文案的计数，04 验收 33 的回执清单 · 四个类别让计数变成 64、19、11；回执清单加入「允许这一次」那四个键
测试改动：apps/desktop/test/renderer-approval-keys.test.ts · reads a flagged category the contract knows · 类别清单变成四个
测试改动：apps/desktop/test/end-reason-copy.test.ts · has a sentence for each of the 18 codes · `runEnd` 多了本轮累计这一个变体，另加一条用例核对它的槽与渲染
测试改动：apps/desktop/test/renderer-approval-card.test.ts · presentation-r1 验收 1 / presentation-r1 不变量 3 · 夹具给每张卡都带了 `category`；D36 起命令卡带 `category` 时 ③ 出类别句，期望照改
测试改动：apps/desktop/e2e/approval.spec.ts · presentation-r1 验收 2: the card escapes its object path without repeating it in the reason (②′, E4) · 06 起 input-hygiene 在两档都对路径里的零宽字符出卡，③ 改出「看不见的字符」那句（验收 19、D36）；对象行转义与「不重复路径」的断言不变。PR #90 的 CI 上它红过一次，其余 275 条 e2e 与新写的验收 27 都过

## 2026-11-20 · 第二段第 12、13 步与文案定稿

- 第 12 步（C 路 fdaa4b0）：三处给模型看的文本都由实现者按 spec 的意思自拟、lead 审过：放行告知行接在 `<sandbox_release>` 的「The user granted the following permissions」下，与 04 的几句同一种写法——"The next call to {toolName} with the same arguments (hash {argsHash}) may run once despite blocks from permission checks {inspectorIds}; all other permission checks and any required user confirmation still apply."；Bash 描述加 "In auto mode, commands that run without asking for approval do not receive token-like environment variables."；累计到上限的 not-run 句 "The task reached its limit for blocked calls in this round, so it stopped and this call was not run."（不写 in a row）。`PROMPT_LAYER_VERSION` 12 → 13，哈希 `f490205c…`；第 12 版的历史记录不动。`evals:gate` 因第 13 版没有基线而红，是 plan 写明的预期；第 12.1 步基线评测 owner 2026-11-12 说「先不跑」，仍开着。
- 第 13 步（E 路 b7f7a2c）：`apps/desktop/e2e/inspector-release.spec.ts`，流程照验收 27：手动档里脚本化回复发出含 BEL 的 `printf` 命令 → 回执 → 点「允许这一次」→「已放行」、不自动重发 → 同一条命令再来照常出命令卡 → 批准后输出文件逐字节正确、只派发了重试那一次。`ci.yml` 的 macOS e2e 列表加了这一个文件（门禁文件，#90 由 owner 合）。PR #90 的 CI（run 44508410897）上 e2e（Linux，含这一条）与 sandbox-macos（含 macOS 这一半）都过。推送改 `ci.yml` 的提交要 gh 凭据带 `workflow` 权限，owner 2026-11-12 补过。
- 第 10 步的文案定稿（两份 locale，lead 定）：
  - 卡 ③：`confirm.reason.flagged.hidden-characters`「路径或命令里有看不见的字符，已经标出来，先给你看一眼。」/ "This path or command contains invisible characters. They are marked so you can check it first."；`control-characters` 同句式（「有控制字符」/ "contains control characters"），按 D36 命令卡带 `category` 时也出这一句。
  - 回执：`blocked.inspector.control-characters`「路径或命令里有控制字符，已拦下。」/ "This path or command contains control characters, so it was stopped."；`hidden-characters` 同句式。按钮 `receipt.action.allow-once`「允许这一次」/ "Allow once"，说明 `receipt.note.allow-once`「在这个任务里再发出完全相同的这一步时生效一次；到下一轮回复结束还没用上就作废」/ "Applies once when this exact step is sent again in this task. Unused permission expires at the end of the next reply."；点过沿用 04 的「已放行」/ "Allowed"；`receipt.error.step-stale`「这一步已不能放行；还需要的话，让它重新做一次。」与 `step-not-found`「找不到这一步；还需要的话，让它重新做一次。」——04 那两句说「重新发起命令」，被拦的可能是文件路径，所以另写；`refused`、`failed` 沿用 04。
  - 结束：`runEnd.blocked-repeatedly-round`「这一轮被拦了 {count} 次，任务已结束。」/ "Calls were blocked {count} times in this round, so the task ended."
  - 「查看本次记录」：`snapshot.decision.inspector-flagged`「检查发现看不见的字符，需要确认」/ "Checks found invisible characters; confirmation is needed"。
- 补测（lead）：结束卡按 `scope` 出累计那句的渲染级用例，与 `inspector-flagged` 的句子；把结束卡的累计分支去掉，前者变红。
- Codex 本机这两天跑不起来：ChatGPT 账号不支持配置里的模型（`gpt-6.1-sol`、`gpt-6.2-sol` 都报 not supported），CLI 是 0.169.1、最新 0.171.0。第 14 步的修正改由子 agent 做。

测试改动：packages/kernel/test/prompts/version.test.ts · 版本、哈希与 LAYER_HISTORY · 版本 12 改 13、追加第 13 版的历史、提示层条目由五条改六条；第 12 版的记录不动
测试改动：packages/kernel/test/prompts/fill.test.ts · 新模板槽位 · 只新增用例
测试改动：packages/contracts/test/chat-event.test.ts · runEndReason · 新增 `scope: 'round'` 与旧原因兼容的用例
测试改动：apps/desktop/test/sandbox/allowlist.test.ts · canReach · 只新增用例

## 2026-11-20 · 第 14 步段末评审之后的修正

- 三路评审审的是 `ba293c6`：对照 spec 通过（0/0/7）、保护通过（0/0/4）、测试与突变不通过（0/3/9；突变 163 个、存活 43，其中 23 个有「原实现绿、变异体红」的探针，生产代码对全部探针按 spec 表现）。报告原文在私有笔记（另记）。
- 修正在一个子 agent 的隔离 worktree 里做（48594d9，Codex 这两天跑不起来），源码只动 `loop/batch.ts`、`loop/mailbox.ts`、`loop/run.ts`，都只收紧：
  - `judgeCall` 的顺序改为「检查 → 经根会话 mailbox 读档位 → 最终计划 → 复核采样，不一致就回去重跑」，等待期间姿态或白名单变了会被这一次判定读到（第一段之前就是在读档位之后算计划）。
  - 偏严的第三次检查里，计划为 full-access 的卡也不带 `autoAsk`，与 §自动档的范围 的例外一致。
  - `appendWithDowngrade` 对根会话的每条 `run_terminal` 都按计数判：到上限时不论这一轮是怎么结束的（含点停止、启动恢复），自动档都降回手动；`chainCounters` 并入同批待写的事实，续跑的 Run 一开头就停也数得到。
  - WebFetch 跟随重定向的那次判定不读、也不消耗未绑定的 inspector 放行。
- 补测（每条都给了「原实现或点名的突变体上红、修后绿」的证据）：同一轮回复里两条一字不差的调用只放第一条；放行只撤掉说拒的那几个检查、被放行的检查改说问时卡仍在；执行期沙箱拦截、跨模型响应、答复后续跑都计进本轮累计，连续第 3 与累计第 20 同时到达时按本轮结束；callKey 的第四段、前导零、撤回消息、非 Bash 工具；绑定重跑的命令在自动档不记免问规则；只有 Bash 带 `canReachNetwork`；适配器的 findings 只带固定码、认不出的结论按拦处理；desktop 缺 `canReach` 查询时读作能联网。
- D39（owner 同日选「只补两类高风险的」，2ea6cac）：适配器另认文字方向控制符（问）与 C1 控制字符（拒）；新用例在改动前的适配器上红。
- 不修、记下的：竞态与接线类没建探针的几处（releaseInspector 排队的会话、启动恢复降档写入排队、审批过的 Agent 分支里的累计、`main/index.ts` 的路由注册只有 e2e 守）——前三处按代码看排在根会话 mailbox，复核时再看；同号用例太多、矩阵与用例名的小出入留给第 22 步；命令卡上认不出的 `category` 出通用句属于第三段第 18 步。

测试改动：apps/desktop/test/inspectors.test.ts · 02 不变量 17: only release writes receipt overrides… · 去掉对 `packages/kernel/src/testing/` 目录的排除，改为把 `tape-conformance.ts` 里那 4 行精确列进期望（比排除更严）
- 更正（「第 14 步段末评审之后的修正」一节的「不修、记下」）：「审批过的 Agent 分支里的累计」不是排队问题，是那条分支里清零与累加没有测试守着（复核时突变 C02b、C03b 存活，实现读代码是对的），改为补测；另把 ToolRow 的 `key={callKey}` 静态渲染测不到（U09）记进不修：换一个调用时状态不串，靠组件按 key 重挂，只有真实渲染能测，e2e 的验收 27 走过这条路。

## 2026-11-20 · 复核 d074ba2 之后的修正

- 复核 d074ba2（报告在私有笔记，另记）不通过：每条根会话结束都按计数判降档之后，`chainCounters` 只在 `source` 为空时把连续计数清零，执行循环却在每条派发过、没被拦下的调用上清零（Bash 超时、派发后连接器不可用或未授权都算），正常结束的自动档任务可能被降回手动。
- 修正（6a5f683，子 agent）：`chainCounters` 按 `execution/dispatch_committed` 记下派发过的调用，派发过的收口照执行循环清零，被拦下的照旧计数；没派发的收口不动连续计数。回归用例照复核的探针写（拒、拒、Bash 超时、拒，正常结束仍是自动档），另有五种派发后收口的逐个用例，都在 d074ba2 上红。补测：等档位期间只换沙箱档位、C1 与零宽字符同时出现。
- 更正（上一节的更正）：「审批过的 Agent 分支」走不到，不是缺测试：会出卡的 Agent 调用被批准后，`rejudgeWaiting` 重判时找不到 Agent 的执行器，判成不可用，`tightenedFacts` 直接把它收口成 `tool-unavailable`，批处理进不了那条分支；那里的清零也已被 `awaits` 清过，等价。眼下 Agent 不出卡（`NOT_GATED`），碰不到；记进 plan Open。

## 2026-11-20 · 复核 57e4276 之后

- 复核 57e4276（报告在私有笔记，另记）通过（0/0/4）：新的清零口径与执行循环在各种收口来源上逐项一致，没找到「该降档却不降」的路径；产品构建里「审批过的 Agent 分支」确实走不到。
- 四条 minor 当场修掉（lead）：补「只有同一个调用的派发才算」的两例（同一请求里另一个没派发的调用、下一次请求里同位置的调用），复核存活的两个突变都被杀；repair 单列成一例，用例名与说法改成「按 02 放行即清零」——执行循环在 repair 后不动计数，Tape 一侧照 02 §上限 清零，只有打包构建里才会有 repair；spec 说清国旗不问、只有子区旗、彩虹旗与 emoji 组合两档都问；plan 的交接改到最新，Open 里超出篇幅上限改为约 2 900 字符。
- 更正（「复核 d074ba2 之后的修正」一节）：「派发过的收口照执行循环清零」对 repair 不准，见上一条。

## 评审 · 2026-11-20 · 审过 57f7333

结论：通过    评审：第 14 步分四轮，每路都是新上下文的子 agent、只读，报告原文在私有笔记（另记）。第一轮审 ba293c6，三路：对照 spec（通过，0 blocker / 0 major / 7 minor）、保护（通过，0/0/4）、测试与突变（不通过，0/3/9）；修在 48594d9（经 fadd64e 合入），另有 owner 当日选的 D39（2ea6cac）。第二轮审 d074ba2（不通过，0/1/6）：修降档时带进一处偏严，修在 6a5f683（经 34570e1 合入）。第三轮审 57e4276（通过，0/0/4），四条当场修在 57f7333。第四轮审 57f7333（通过，0/0/3），只多了测试与文档、没改生产代码。lead 在沙箱外跑了：57e4276 上全量 6 010 条通过，`TENON_SANDBOX_TESTS=required` 的逃逸测试 120 条通过（本机 `/private/tmp/claude` 被建成 0755 时这组整批失败、dev 上也一样，改回 0700 后通过），format、lint、typecheck 通过；57f7333 上 kernel 全量 2 803 条通过；spec-check 只拦本条记录。PR #90 的 CI 上 e2e（Linux，含验收 27）与 sandbox-macos（含它的 macOS 一半）都过；`ci` 只红在 `evals:gate`：第 13 版没有基线，P 等 owner 的第 12.1 步。14.1 预算检查点：验收 44 条（上限 53）；代码第一段 7 178 行、第二段到这里 4 984 行（`git diff --shortstat`），加第三段估计 4 000–5 500 行，合计约 16 200–17 700 行（上限约 18 500），不用砍，但余量不大，第三段开工前再量一次
突变：第一轮 plan 第 14 步点名的 15 个（含拆出的「绑定后不作废」一半）14 个被杀；另设 148 个，存活 43：有探针证明是缺口 23、等价或不可达 13、竞态与接线类没建探针 7；缺口在 48594d9 补上用例，第二轮重打全红。StrykerJS 只出报告：kernel 765 个变异体 79.74%，desktop 与 contracts 190 个 56.32%（ToolRow 的 0% 是 vitest-runner 跑不起 renderer-06-receipts 的度量失真，剔除后 80.5%）。第二轮 38 个存活 8（新代码缺口 2、等价 2、上一轮已记 4）；第三轮 12 个存活 2（`callOf` 去掉 ordinal、去掉 sourceSeq），57f7333 补测后都被杀；第四轮另打的 `callOf` 去掉 Run id 存活，见发现。CI 登记的突变仍是第一段留下的 M1、M2、M3、M12、M15
发现：
- [major] 一次放行「绑上就用掉」没有测试守：同一轮回复里两条一字不差的调用，第二条本该再拒 · 证据：`receipt-releases.ts` 的已用集合去掉放行键，全量不红 · 已修 48594d9
- [major] 累计熔断只测了判决当场拒一类来源：执行期沙箱拦截、跨模型响应、续跑、连续第 3 与累计第 20 同时到达都没有用例 · 证据：对应的六个突变存活 · 已修 48594d9
- [major] 回执放行「只放被点名的检查、只放拒」缺两个检查的用例 · 证据：放宽 `said === 'deny'` 的两个突变存活 · 已修 48594d9
- [major] 修降档时改宽：每条根会话结束都按计数判，而 `chainCounters` 的清零规则与执行循环不一致，正常结束的自动档任务可能被降回手动 · 证据：探针（拒、拒、Bash 超时、拒，正常结束后写了降档） · 已修 6a5f683
- [建议] 第一轮其余 minor：偏严的第三次检查里 full-access 的卡多带 autoAsk、只撤拒不撤问没测、写入方检查按目录排除、跟随重定向读未绑定放行、点停止后不降档、最终计划与采样定在等档位之前，以及 callKey 校验、适配器 findings 与失败即拦、只有 Bash 带能否联网等补测 · 证据：各条的突变或探针 · 已修 48594d9
- [建议] input-hygiene 认的看不见字符比卡片的写法窄，文字方向控制符与 C1 控制字符在自动档里免问 · 证据：保护一路的探针 · 已修 2ea6cac
- [建议] 第二轮其余 minor：等档位期间只换沙箱档位、C1 与零宽同时出现两处补测，以及 plan、spec、decisions 的计数与说法 · 证据：两个突变存活与文档对照 · 已修 6a5f683
- [建议] 第三轮四条：只有同一个调用的派发才算、repair 的说法、plan 交接、旗帜的说法 · 证据：两个突变存活与 railguard 0.7.0 实测 · 已修 57f7333
- [建议] `chainCounters` 认「同一个调用」的三项里 Run id 那一项没有用例，续跑链上前后两个 Run 同一位置的调用会撞键 · 证据：第四轮突变存活 · 不修：行为是对的、缺的是用例，记进 plan Open，第 22 步补
- [建议] plan 的「当前」与交接对不上、Open 的超长字数按旧版算 · 证据：第四轮复核 · 已修 39eeccb
- [建议] repair 那例的注释与上一节 log 说「只有打包构建里才会有 repair」不准，评测程序也开着 · 证据：`apps/desktop/evals/runner.ts` 的 `onUnansweredCall` · 不修：本节末尾追加更正，测试注释记进 plan Open 第 22 步
- [建议] 竞态与接线类没建探针的几处：releaseInspector 排的队、启动恢复降档写入的队、`main/index.ts` 的路由注册与启动恢复 gate、ToolRow 按 callKey 重挂 · 证据：复核读代码确认前两处排在根会话 mailbox，后两处有 e2e 走过 · 不修：只有并发或真实渲染才看得见，记下
- 更正（「复核 57e4276 之后」一节）：评测程序也开着 repair（`apps/desktop/evals/runner.ts`），不只是打包构建。

## 2026-11-27 · 第 12.1 步基线评测（live）

- owner 2026-11-20 回「跑，约 ¥7」（对话）；在本机跑，Tenon 沙箱生效（`/private/tmp/claude` 为 0700）。key 由评测程序从主仓库的 `.env.local` 自己读（worktree 里放一个软链，跑完删掉），命令与记录里只有变量名；外面套一个按已写记录累计花费、超上限就停掉整组进程的看门狗。
- 跑了什么、花了多少：基线列 glm-5.3-flash 全集 20 题 × 3 次，60 条记录，¥4.47（上限 ¥6.5）；ADR-005 要的 02 题在 glm-5.3 上 3 次，3 条记录，¥0.41（上限 ¥3）。合计 ¥4.87。结果在 `docs/evals/results/2026-11-20-tenon-glm-5.3-flash-…jsonl` 与 `2026-11-20-tenon-glm-5.3-…jsonl`，`clientVersion` 73c697e。
- 逐题对照第 12 版（flash 列，同列只比相邻版本）：总数 58/60 → 53/60；16 题不变（01、04–10、12–18、20 都是 3/3）；少过的四题：
  - 02（3/3 → 1/3）：两次都是模型连着用被禁掉的 Edit、连拦 3 次、本轮以 `blocked-repeatedly` 结束。flash 在这道题上的已知弱点（第 11 版 1/3）；ADR-005 要的 glm-5.3 上 02 题 3/3 全过（第 11 版也是 3/3）。
  - 03（3/3 → 2/3）、11（1/3 → 0/3）、19（3/3 → 2/3）：答案都对（记录里写着 pass 与正确的输出），失败是模型最后多删一个自己刚建的临时脚本，这个 Delete 在评测环境里判撤不回而出卡，评测里扮演用户的一方拒绝撤不回的卡，本轮以 `user-rejected` 结束、记 fail。第 12 版的 11 题有一次是同一个原因；第 13 版的三处新文本都不涉及删文件，判为模型每次做法不同的波动，不是第 13 版带来的。
- owner 2026-11-27 回「收下，写进 log」（对话）：第 13 版的基线照这次结果收下，flash 列以 53/60 作为第 13 版的起点。`pnpm evals:gate` 本地通过。
- 更正（上一条第一行）：worktree 里那个指向 `.env.local` 的软链当时没有删掉——lead 在沙箱里用 `test -L` 核对，沙箱看不见 `.env.local`，报成「不在」。2026-11-27 复核指出后在沙箱外核实是指向主仓库 `.env.local` 的软链，只删了软链本身，主仓库那份没动；它被 `.gitignore` 忽略，没进过仓库。plan「开工前读」改写了 key 的来源，与 docs/evals/README 一致。
- 更正（上一条的失败描述）：03 题删的是模型自己导出的 `full_log.txt`，不是脚本（11、19 删的才是脚本）；撤不回的 Delete 卡在 flash 列第 11、12、13 版分别出现 0/60、1/60、5/60 次，下一版对照时留意。02 的两次失败是同一批里并行发出 3 个 Edit，模型还没看到第一次拦截就连拦 3 次结束，与第 11 版的两次失败同形，不是看到拦截后还在重试。

## 评审 · 2026-11-27 · 审过 5e1547e

结论：通过    评审：新上下文的子 agent，只读，审 `73c697e..5e1547e`（两份基线结果、log 的「第 12.1 步基线评测」一节、plan 的勾与「当前 / 需要你」）；报告原文在私有笔记（另记）。核实：两份结果是在 73c697e 上真跑的（flash 60 条、glm-5.3 3 条，`prompt.version` 13、`prompt.hash` 等于 `PROMPT_LAYER_HASH`，任务题的 `toolDefinitionsHash` 换成新值、`systemHash` 与第 12 版相同，正对上第 13 版只在 Bash 描述加了一句；`clientVersion` 73c697e、没有 dirty；`sandbox` 全为 active/workspace-write）；格式检查 3/3；记录里扫过各种密钥形态都没有命中；log 的对照数与花费（¥4.468 + ¥0.406）与数据一致；副本上 `pnpm evals:gate` 通过，拿掉新的 flash 文件就变红；只动了这四个文件，log 只追加。lead 在本机另跑 `pnpm evals:gate` 通过（30 条），没有再花钱
突变：这一段只加了结果与文档，没有生产代码，不打突变；评测门禁那条用例用「拿掉新结果文件就红」核过咬得住
发现：
- [major] log 写「软链跑完删掉」，worktree 里那个指向 `.env.local` 的软链实际还在 · 证据：复核在该 worktree 根目录列出了这个软链；lead 当初在沙箱里核对，沙箱看不见 `.env.local` · 已修 1e7da61
- [建议] 03 题删的是 `full_log.txt` 不是脚本；撤不回的 Delete 卡在第 11、12、13 版出现 0、1、5 次，值得记下 · 证据：各条记录的 note · 已修 1e7da61
- [建议] 02 的失败是同一批并行发出 3 个 Edit，不是看到拦截后还在重试 · 证据：两条记录的 note 写「0 call(s) in requests after the first block」 · 已修 1e7da61
- [建议] plan「当前」与第 14 步的勾、交接过期 · 证据：复核对照 plan · 已修 1e7da61
- [建议] 入口页没有重新生成 · 证据：spec-check 报入口页过期 · 已修 1e7da61

## 2026-11-27 · 第三段实现（第 15–19 步）

- 开工前照挑刺评审 r2 留下的六条定了 D40–D43（c20e12d），写进 spec 的修订记录；第 1 步与 1.3 补勾（1.3 在 11-09 已跑，只是没勾）。预算再量一次：第一段 7 178 行、第二段 5 094 行，第三段估 4 000–5 500 行，合计没超约 18 500。
- 分路：contracts 的形状由 lead 先定（fe1b4b5：`session.setApprovalMode`、`session.facts` 的 `approvalMode` 与 `autoModeDisabled`、`pendingGrant`、`workspace.grant` / `access` / `revokeAccess`、config 的三个键；kernel 的 facts 视图在策略关掉自动档时报手动）；第 15 步其余部分交 Sonnet 子 agent 在独立 worktree 里做（Codex 本机仍跑不起来），lead 同时做第 16–19 步的界面、文案与 e2e。子 agent 的两个提交拣进本分支（e157b58、c2c319c）。
- 第 15 步：主进程的切档路由，关机中由路由表先拒（渲染端收到 IPC 失败，菜单不变），kernel 这一层回 `refused`，两条路径都有用例；子会话 id 回 `not-cowork`（D41）。`approvalModeDefault` 跟着 config.json 的每次写入。文件夹授权照 D42：选中的全部已在 `folderAccess` 才直接加，否则一个都不加、回 `pendingGrant`；token 只在主进程内存、每会话一张、只能用一次，再选、再用预填、清空会话都作废它（清空走 `createSessionRemoval` 新加的 `onRemoval`）；「以后都允许」只记 kernel 真正加进会话的真实路径。D32 读取端：认不出的摘要码读作 `unknown`、保留 verdict 与 facts，非字符串仍校验失败；kernel 码表与 Tape 不变。
- 第 15 步留下的两点小代价，记在这里不改：真实路径解析不出的文件夹照旧走直接加、由 kernel 回 `root-folder`；没授权过的磁盘根目录现在先弹授权框，点「允许」后才被 kernel 拒（以前选了就拒），提前拦要在 desktop 复制 kernel 的校验。
- 第 16 步（645b2e0）：`ApprovalModeMenu` 在任务的工具行、文件夹之后，向上弹，两项各一句，当前项打勾；快照 `unavailable` 时自动项下加一句，状态取结算行用的那份、打开菜单时刷新；策略关掉时只有手动。横幅常驻、整条是回手动的按钮；说明条只在第一次切到自动档时出、「设置」用 `#settings/permissions` 打开「权限与网络」、「知道了」写 `autoModeNoticeSeen`；降档提示由根会话这一轮的 `blocked-repeatedly` 结束原因给出种类与次数，子会话连续 3 次而本轮没结束的，按档位由自动变手动、又不是你切的也不是策略关的认出来，次数用 02 的 `MACHINE_DENIAL_CAP`（渲染端重述这个常量，有用例核对两边相等）。设置「权限与网络」最上面是审批档。
- 第 17 步（016bac7）：`FolderGrantDialog` 三钮「取消 / 以后都允许 / 允许」、焦点在「取消」，写明授权只给读取与查找、改动照样按档位问；框关掉后文件夹浮层重新打开，看得到结果；浮层底部「管理文件夹访问」链到设置；设置里「文件夹访问」逐条撤销。
- 第 18 步（fff231d）：③ 按 `autoAsk` 出五句之一，认不出的出通用一句；命令卡上认不出的 `category` 出「Tenon 的检查要你再看一眼这一步。」（原来会退成外带那一句）；Delete 卡标题「删除这个文件？」；认不出的摘要码在「查看本次记录」与展开的工具行按 verdict 出中性一句；展开的工具行在放行、没出过卡的调用上多一行「为什么没问」；`auto-mode` 改成「自动档放行」。
- 第 19 步（6f12c1c）：验收 40 的 e2e，macOS 上等设置里的沙箱状态变成生效再跑命令；Linux 的 e2e 没装 bubblewrap，用测试接缝的生效姿态，命令照问是因为在 Linux，不是因为姿态；新文件加进 `ci.yml` 的 macOS 列表（门禁文件，第三段的 PR 由 owner 合，D43）。所有选文件夹的 e2e 都多一步应答授权框（`grantFolder`）。
- 门禁：沙箱外全量 6 066 条通过，format、lint、typecheck 通过；spec-check 只拦缺评审记录（第 20 步写）。e2e 只在 CI 跑。

测试改动：packages/contracts/test/approval.test.ts · 类型断言 `ContractSummaryIsKernelSummary` · D32 起关系改为单向，删去这一向，另加 `ReadCodeOnlyAddsUnknown`
测试改动：packages/contracts/test/approval.test.ts · 02 不变量 19: has exactly verdict, code and facts, and refuses anything else · 认不出的码从「解析失败」改为读作 `unknown`、verdict 与 facts 保留，非字符串仍失败（D32，owner 2026-11-08 点名批准）
测试改动：packages/contracts/test/outcome.test.ts · 类型断言 `SummaryBothWays` · 同上，改为单向的 `KernelSummaryCrosses`
测试改动：apps/desktop/test/workspace.test.ts · 各例的 harness · 预先把用到的文件夹写进 `folderAccess`：这些例子测 kernel 的列表、拒绝与预填，不测授权；授权由 workspace-grants.test.ts 覆盖
测试改动：apps/desktop/test/snapshots.test.ts · 05 验收 10: accepted workspace notifications start the first tree in the background · 选文件夹之后多一步 `workspace.grant`（D42）
测试改动：apps/desktop/test/shutdown.test.ts · 写入请求集合两条 · 加入 `workspace.grant`、`session.setApprovalMode` 及其注册
测试改动：apps/desktop/test/profile.test.ts · 读旧 config、04 验收 27、坏字段只丢自己三条 · 期望对象补 config 的三个新默认键
测试改动：apps/desktop/e2e/helpers/tools.ts、tools.spec.ts、ux-craft.spec.ts · startTask 与选文件夹、用预填的几处 · 多一步应答授权框（D42），之后的断言不变

## 2026-11-27 · 第三段评审之后的修正

- 三个视角审 7df81fd，发现与作者处置在私有笔记（另记）。修在 e88d679（菜单选完就关、工具行可换行）、10926dc（授权 token 存真实路径并在答复时复核；工具行与记录的渲染测试；预填作废、草稿折手动的用例；授权框路径经 `visible()`；spec 说清 D41 与回退）、af87151（desktop 补上 `autoCommands`：之前从没实现，产品里的自动档对命令一律照问，是 CI 上验收 40 的 e2e 抓到的）、f7d9e41（策略不可用时 facts 照常可读、降档提示的两处时序、设置与默认档的 e2e）。
- 复审（三个视角审 64ca307）之后再修：4c258a3（主进程解析不出的文件夹直接回 `root-folder`，不再交给 kernel，关掉一处不弹框就加进会话的竞态；已授权直接加入时把核过的真实路径交给 kernel）；本条所在提交补了默认档为自动的草稿在策略关掉时报手动、两个文件夹只换其一也回 `stale`、宿主不答 `autoCommands` 时读作 `'no'` 三条用例。
- 交 owner 的一条：答复复核之后、kernel 解析之前的窗口，见 plan「需要你」①。
- 新突变不登记，手跑：CI 的 spec-check 只登记 5 个时已跑 18–23 分钟，上限 30 分钟（owner 2026-11-10「只留 5 个，其余撤销」）。

测试改动：apps/desktop/test/workspace-grants.test.ts · 06 验收 36: a selection with one ungranted folder asks for all of it, and always keeps only the ungranted real paths · 框里的列表从原样路径 `['/work/a', '/link', '/work/b']` 改成真实路径去重后的 `['/work/a', '/work/b']`：原断言把「框里显示原样路径」写成了期望值，正是安全视角报的问题；仍是精确相等
测试改动：apps/desktop/test/approval-mode-routes.test.ts · 06 验收 15: with the policy turning auto off… · 草稿改成在策略生效前自己选自动，另加一个默认为自动、自己没选的草稿；加严

## 评审 · 2026-11-28 · 审过 7567639

结论：通过    评审：第 20 步段末评审分三轮，每路都是新上下文的子 agent、只读，报告原文在私有笔记（另记）。第一轮审 7df81fd，三路：对照 spec（Opus，不通过，2 blocker / 4 major / 7 建议）、安全（Opus，0/3/4）、突变（Sonnet，不通过，0/7/4）；修在 e88d679、10926dc、af87151、f7d9e41、6461ef6、64ca307，作者另在 CI 上发现一条（`autoCommands`，修在 af87151）。第二轮复审 64ca307，三路：对照 spec（Opus，上一轮的都已修或理由属实，新 0/0/5）、安全（Opus，上一轮的都已修，新 0/2/2）、突变（Sonnet，不通过：e04 只修了一半，新 0/0/5）；修在 6553129、4c258a3、2a1ce3d，交 owner 的一条 owner 2026-11-28 回「写进已知限制」，落在 7567639（D44）。第三轮复审 7567639（Opus，一个视角覆盖上一轮三份，通过）：上一轮要处置的 15 条都处置到位，说「已修」的重打突变都变红，说「不修」的理由属实，没有新的 blocker、major 或要交 owner 的发现。CI：2a1ce3d（代码与 7567639 相同）上 ci、e2e、sandbox-macos 全绿，spec-check 只拦缺评审记录。汇总评审：Opus，只读评审包与各轮回复原文，没有另打突变；未开自动合并：改了门禁文件 ci.yml
突变：第一轮三个视角各自打：对照 spec 5 个，首跑全部存活（M1 即登记块 M18 的工具行原因行、M2 记录的中性说明、M3 预填作废是缺口，M4 接线算建议，M5 近似等价）；安全 18 个，相关测试首跑 3 个没红，跑全量后 S1、S12 存活、S6 等价；突变 68 个（plan 第 20 步点名的 8 类 20 个变体加自设 48 个，点名的 8 类都变红），首跑存活 22 个，15 个全量也绿，7 个是同位置兄弟、琐碎或等价，没跑全量；缺口在 10926dc、f7d9e41 补测。第二轮：对照 spec 14 个（M18、M2、M3 重打都红），存活 6（F1、F4 等价，F9 由 e2e text-fit-r1 守，F6、F8、F11 见发现）；安全 11 个，存活 3（R3b 等价、R4 近似等价、R8 见发现）；突变 90 个（相关集合跑了 70 个，全量跑了 5 个存活的），缺口 e04b、n05、n16 在 2a1ce3d 补测、n11 不修，其余存活的由 e2e 守或等价。第三轮 9 个，存活 1（X3，等价，落在 D44 的窗口里），e04b、n05、n16、R1、R2、M3 重打都红。候选登记块 4 个（第一轮对照 spec 的 M18、安全的 M18、突变的 M18 与 M19）按 CI 时限手跑、不登记：owner 2026-11-10 定过「只留 5 个，其余撤销」，CI 的 spec-check 只登记 5 个时已跑 18–23 分钟、上限 30 分钟；这四个在修复后的代码上都由复审重打过、都变红，第二轮突变复审核过不登记的理由属实。CI 登记的仍是第一段留下的 M1、M2、M3、M12、M15。StrykerJS 没跑：仓库没有现成配置（理由属实）
发现：
- [blocker] 验收 40：在菜单里选「自动」之后菜单不关，它的遮罩挡住了下一次点击（对照 spec） · 证据：失败的测试 `apps/desktop/e2e/approval-mode.spec.ts`「06 验收 40」在 Linux 和 macOS 上都卡在 `page.getByTestId('auto-notice-dismiss').click()`，30 s 超时，日志写着 `<div role="presentation" data-base-ui-inert=""> from <div data-base-ui-portal> subtree intercepts pointer events`；根因是 `ApprovalModeMenu.tsx` 用的 `DropdownMenuRadioItem` 在 Base UI 1.8.0 里 `closeOnClick = false`，`onValueChange` 又没调 `setOpen(false)`。复审：run 45965481959（af87151）Linux「06 验收 40」与 macOS 的 approval-mode.spec.ts 都过；去掉 `closeOnClick` 的突变 F2 变红，去掉 `setOpen(false)` 的 F1 与它重复、按等价 · 已修 e88d679（验收 40 后半段要等 af87151 才全绿）
- [blocker] presentation-r1 验收 13 回归：composer 的工具行在 800x520、侧栏展开、模型 id 很长时横向被裁（对照 spec） · 证据：失败的测试 `apps/desktop/e2e/text-fit-r1.spec.ts`「presentation-r1 验收 13: textOnlyTask, switch and settings fit at 1280x800 and 800x520 with the sidebar expanded」，zh-CN 报 `composer-tools` 横向被裁 21px，en 报 41px，dev 上同一条是绿的；多出来的是 `ComposerLead` 里新加的 `ApprovalModeMenu` 触发钮（`shrink-0`、`whitespace-nowrap`）。复审：e88d679 与 af87151 两次 Linux e2e 里这条的 zh-CN、en 各两例都过；去掉 `flex-wrap` 的突变 F9 单元测试守不住，由这条已证明能变红的 e2e 守 · 已修 e88d679
- [major] 文件夹授权的 token 存的是目录框或预填给的原样路径，`workspace.grant` 在用户答复时才交给 kernel 解析，与 D42「文件夹用主进程记下的那份真实路径」不符：框里列的是链接路径、加进会话的是链接指向的目录；从选到答复之间链接被改指，「以后都允许」会把用户没看到的目录加进会话并记进 `folderAccess`（安全） · 证据：内存宿主与真实 `DesktopFs` 加磁盘 config.json 各复现一次：建 `work/a`、`secret/a` 和链接 `proj → work`，目录框答 `proj/a`，`pendingGrant.folders` 是 `["<root>/proj/a"]`；答复前把 `proj` 改指到 `secret`，`workspace.grant {choice:'always'}` 回 `folders: [".../secret/a"]`，config.json 的 `folderAccess` 是 `[".../secret/a"]`，之后新会话选它不弹框。复审：`select` 现在用解析过的真实路径 mint，答复时再解析、对不上回 `stale`；R1（mint 原样路径）、R2（去掉答复时复核）、R3（复核只看 `resolved`）各自打回原样都有用例变红，第三轮重打 R1、R2 仍红 · 已修 10926dc
- [major] 验收 38 与验收 44 工具行那一半只测了辅助函数：`ToolRow` 渲染「为什么没问」那一行没有任何测试覆盖（对照 spec 的 M1 即登记块 M18，突变视角的 m04c、e40 同一处） · 证据：存活突变：`ToolRow.tsx` 改成 `const why = open ? null : unaskedReason(outcome)` 之后那一行永远不出现，相关 8 个文件 105 条全绿，全量 6059 过、只红 6 条沙箱 EPERM（干净代码上同样是这 6 条）；`grep tool-row-why` 在 test 和 e2e 里都找不到。复审重打后 renderer-tool-row.test.ts 红 2 条（「06 验收 38: an expanded allowed row shows why it was not asked…」与验收 44 的 allow verdict 那条），m04c、e40 也红 · 已修 10926dc
- [major] 验收 44 的「查看本次记录」里那句中性说明只测了 `decisionKey`（对照 spec 的 M2，突变视角的 e41 同一处） · 证据：存活突变：`ThreadTitleMenu.tsx` 的 `tx(t, decisionKey(row.decision), row.decision.facts)` 换回 `` `snapshot.decision.${row.decision.code}` `` 之后相关 4 个文件 59 条与全量都绿；用户会看到的是未知码那一行显示 i18next 的「returned an object instead of string」，而不是中性说明。复审重打后 renderer-restore-components.test.ts 的「06 验收 44: the record shows an unknown summary code under allow/ask/deny verdict…」三条全红，测试渲染真的 `ThreadTitleMenu` 加真的 i18n，还断言了不出现 `returned an object` · 已修 10926dc
- [major] 验收 35、36 的界面一半只有静态标记的断言：设置里的撤销钮、默认档的初始读取、授权框「允许」与「以后都允许」的区别都没人守（突变） · 证据：全量都绿的突变：e25（`FolderAccessSection.tsx` 撤销钮改成空函数；`renderToStaticMarkup` 不跑 effect，列表与按钮根本没渲染）、e26（`ApprovalDefaultSection.tsx` 初始读取改成 `setMode('manual')`）、e39（`FolderChip.tsx` 答复永远传 `'always'`，点「允许」也会永久记住；e2e 的 `grantFolder` 只点「允许」，也没断言之后 `folderAccess` 仍为空）。复审：e2e「06 验收 35」点撤销后要求列表为空、config.json 的 `folderAccess` 为空，并要求预置自动档时 `approval-default-auto` 为选中；「06 验收 40」在点「允许」之后读 config.json 要求 `folderAccess` 为空；三条突变在单元里仍存活是预期的，PR #92 头 64ca307 的 CI 上这两条 e2e 在 Linux 与 macOS 都过 · 已修 f7d9e41（改由 e2e 守）
- [major] D42 与验收 36「再用一次预填就作废前一个框」只在预填自己又出新框时测到（对照 spec 的 M3、安全的 S1 即登记块 M18、突变的 e08 同一处） · 证据：存活突变：删掉 `workspace.ts` 的 `workspaceUsePrefill` 里的 `grants.invalidate(sessionId)`，相关测试与全量都绿；它不等价：选没授权过的 `/work/a` 拿到 token T，预填只含已授权的 `/work/b`、直接加入不出新框，再用 T 调 `workspace.grant`，干净代码回 `{ok:false, code:'stale'}`，打了突变回 `ok:true`、`/work/a` 被加进会话（三个视角各自的探针都是这条路）。复审重打后 workspace-grants.test.ts 的「06 验收 36: a prefill that adds directly still voids the grant a pick left」变红，第三轮重打仍红 · 已修 10926dc
- [major] D40 与验收 31「策略关掉自动档时 `session.facts` 报手动」，草稿这一支没有测试守（安全的 S12、突变的 e04 同一处） · 证据：存活突变：`packages/kernel/src/loop/mailbox.ts` 的 `factsView` 草稿分支去掉 `shown(...)`，全量绿；`approval-mode-routes.test.ts` 那条用例里草稿既没选自动、默认也是手动。突变视角的探针：默认设成 auto 或草稿先选 auto，再换成 `disableAutoMode` 的策略，原实现报手动、突变红；后果是 `ApprovalModeMenu` 触发钮显示「自动」而菜单里只有手动项。第二轮突变复审：10926dc 只补了草稿自己选自动的一支，变体 e04b（草稿没选、取默认时不折）相关集合与全量都存活，算没处置；第三轮重打 e04b，验收 15 用例新加的「config 里默认自动、没选过的草稿」那段断言变红 · 已修 2a1ce3d（草稿自己选自动的一支修在 10926dc）
- [major] 验收 31：策略不可用时 `session.facts` 不能失败，这条守卫没有测试（突变） · 证据：突变 e05，`factsView` 里 `policy.status !== 'unavailable' && policy.snapshot.disableAutoMode === true` 去掉前半，全量绿；探针在 `memory.setPolicy({ status: 'unavailable' })` 后调 `session.facts`，原实现回 `established: true, approvalMode: 'manual'`，e05 上路由回错误。后果：策略不可用是 02 的 fail-closed 状态，这时整条 `session.facts` 失败，渲染端 facts 为 null，文件夹控件和档位菜单一起消失。复审：e05 现在红（`approval-mode-routes.test.ts`「an unavailable policy leaves the facts readable…」） · 已修 f7d9e41
- [major] 验收 34：降档提示有两处没人守（突变） · 证据：(a) 突变 e07，`session-store.ts` 的 `setApprovalMode` 切到自动时不清 `downgrade`，全量绿；探针「手动 → 自动 → 手动」后降档行又回来。(b) 突变 e17（去掉 `choices !== this.#modeChoices`）全量绿、e18（去掉 `this.#modeChoices += 1`）相关测试绿：已有用例里 `#readDowngrade` 的 facts 读在路由改档之前就发出了，守卫根本没被走到；探针让 Run 结束那次 facts 读挂起、期间用户切回手动，e17、e18 误出「连着被拦了 3 次，已停下并切回手动档」。复审：e07、e17、e18 现在都红（`session-store.test.ts` 新增的「going back to auto clears the downgrade line…」与「a switch the user makes while the Run's end is read is not a downgrade」） · 已修 f7d9e41
- [major]（问题 D）文件夹浮层里加了一个链到设置的「管理文件夹访问」（`FolderChip.tsx` 的 `folder-access-settings`，键 `folder.access.manage`），多个文件夹时标题改成「允许访问这 {count} 个文件夹」（`folder.grant.titleMany`），验收 31–40 都没有要求（对照 spec；突变视角报了链接那一半） · 证据：上面两处代码；spec §界面「文件夹授权」写的标题只有「允许访问这个文件夹」，验收 36 只要求设置里能撤销。复审：plan 第 17 步原文「`GrantDialog` 的文件夹版、`FolderChip` 的授权与撤销入口、设置里的文件夹访问列表」，链接就是这个撤销入口，按上一轮自己写的条件这一半撤回；复数标题是 D42 一次选几个文件夹那种情形的措辞，不是新的状态、机制、接口或配置项。突变复审的保留意见：spec §界面与 44 条验收都没写这个入口，只有 plan 写了，owner 想按 spec 字面时一句话可删 · 不修：链接是 plan 第 17 步要求的撤销入口；复数标题是 D42 多个文件夹情形的措辞，不是多做出来的东西（作者所引「plan 里定稿了这句文案」不属实，见下面 plan 第 17、18 步那条）
- [major] 验收 13、35 的主进程接线：`main/index.ts` 里 `createSessionService` 不传 `approvalModeDefault` 没有任何测试守（突变 e45；对照 spec 视角在 M4 那条建议里也点了这一行） · 证据：突变 e45 全量绿，没有测试 import `main/index.ts`（`git grep` 无结果），e2e 验收 40 不改设置里的默认档。复审：e2e「06 验收 35」预置 `approvalMode: 'auto'` 的 config，新任务草稿的 `approval-mode-trigger` 必须是 `data-mode="auto"`，不传时草稿读作手动必红；CI 头 64ca307 上两个平台都过 · 已修 f7d9e41（改由 e2e 守）
- [major] 验收 36 的主进程接线：清空会话时作废文件夹授权的那条接线没有测试守（突变 e16：`createSessionRemoval` 去掉 `onRemoval: (sessionId) => folderGrants.invalidate(sessionId)`；对照 spec 视角的 M4 是同一处：删掉 `registerWorkspaceRoutes` 的 `grants: folderGrants`，`onRemoval` 作废的就是另一张表，记为建议） · 证据：e16 与 M4 全量都绿；`index.ts` 只被 `sandbox/allowlist.test.ts` 当文本读过。复审：`main/index.ts` 里 `removal` 只在 `TENON_E2E_SESSION_REMOVAL` 打开时才挂到 globalThis，contracts 与 desktop 里没有清空或删除会话的 IPC 路由，产品里走不到；`onRemoval` 本身由 e15 守、仍红；这条不修已记进总参考「以后再说」（见下面 e16 那条） · 不修：产品里还没有清空会话的入口，这条接线现在走不到；组装根没有单测入口，加清空入口的那份 spec 用它的 e2e 守（理由属实，照录）
- [major] desktop 没实现 `SandboxPorts.autoCommands`，产品里自动档的命令一律按 `platform` 照问（作者在 CI 上自己发现，第二轮对照 spec 与安全复审核对） · 证据：CI run 45962395493（e88d679）的 Linux e2e 里验收 40 越过了菜单那一步、停在 Linux 那句。复审：spec §接口写的是「macOS 'yes'，Linux 'linux'，其余 'no'；缺省读作 'no'」，这是已有接口的补实现；突变 F3（其他平台答 `'yes'`）、R9（Linux 答 `'yes'`）、R10（不接 `autoCommands`）都让 chat.test.ts 变红；kernel `batch.ts` 的 `commandSandboxed` 另要求 `posture().state === 'active'`；af87151 上 Linux「06 验收 40」与 macOS 的 approval-mode.spec.ts 都过 · 已修 af87151
- [major] 选文件夹时主进程那一次解析在竞态里会失败，`select` 于是把原样路径直接交给 kernel、不弹授权框，而 kernel 稍后那次解析成功了，没授权过的文件夹就不经授权框加进了会话（第二轮安全复审；代码 7df81fd 就有） · 证据：`DesktopFs.realpath` 碰上「`realpath` 报 ENOENT，紧接着 `lstat` 又看到条目」时抛 `UnresolvableAliasError`，主进程这边成了 `resolved: false`；探针 B 用真实 `DesktopFs`，worker 线程循环把文件夹和指向 `secret` 的链接来回换，每轮 300 次选 `work/a`、`folderAccess` 始终为空，三轮里没弹框就加进 `secret` 的 15、19、18 次，加进没授权的 `work/a` 的 18、14、19 次；前提是 agent 的命令能写被选文件夹的上一级。第三轮：4c258a3 让主进程解析不出就直接回 `root-folder`；把早退改回旧写法（X1），新用例「06 验收 36: a folder main cannot name at the pick is refused there, never added by the kernel’s later look」红，只删早退（X2）红 2 条；`root-folder` 是原有的失败码，修订记录有一行，只收紧 · 已修 4c258a3（处置清单原写「lead 提交，见 log」，没写提交号）
- [major] 修复留下的窗口：`workspace.grant` 复核通过之后、kernel 的 `setWorkspace` 自己解析之前，路径被改指时框里写的是 `work/a`、会话加进去的却是 `secret`；`setWorkspace` 要进根会话的 mailbox 排队，Run 里有判定轮次时窗口会拉长（第二轮安全复审） · 证据：探针 A 用真实 `DesktopFs`，把 `setWorkspace` 包一层、在复核之后换成链接，框里是 `[".../work/a"]`、答复回 `folders: [".../secret"]`、`folderAccess` 为 `[]`；探针 B 三轮里这种情形 10、3、6 次（每轮 300 次）。`folderAccess` 不受影响，`keepAccess` 只记 kernel 接受了的；要彻底关掉得让 kernel 的 add 带上主进程核过的真实路径或 identity，是改接口 · 交 owner（owner 2026-11-28 回「写进已知限制」，7567639 落进 spec §已知限制与代价、修订记录、decisions.md D44 与总参考「以后再说」；第三轮复审核过已知限制原文与行为对得上）
- [建议] `ApprovalModeMenu` 的「这个任务没法留底，改动照样问你」只该在自动项下面（突变） · 证据：突变 e06 把 `{item === 'auto' && noSnapshot ? (` 改成 `{noSnapshot ? (`，全量绿，手动项下也会出这句。复审：e06 现在红（`renderer-06-mode.test.ts`，手动项下找不到这一句） · 已修 f7d9e41
- [建议] `ComposerSlots` 挂 `ComposerBanner`、`ComposerLead` 挂 `ApprovalModeMenu` 只被 e2e 守（突变） · 证据：突变 e02、e03 在 test 门禁全量绿。复审：「06 验收 40」要求 `approval-mode-trigger` 与 `auto-banner` 出现并可点，两个挂载点去掉都会红；CI 头 64ca307 两个平台都过 · 不修：e2e 验收 40 守（理由属实，照录）
- [建议]（问题 A）回退：06 之前的 `configSchema` 不是 strict 的，下次写盘会丢掉 `approvalMode`、`autoModeNoticeSeen`、`folderAccess` 三个键，再升回来默认档回手动、说明条再出一次、「以后都允许」的文件夹要重新授权；都往严的方向退，但 §接口「迁移与回退」只写了 Tape（对照 spec、安全、突变三个视角都报了） · 证据：fedc419 的 `packages/contracts/src/ipc/config.ts` 里 `configSchema` 是不带 passthrough 的 `z.object`，`writeConfigHeld` 写的是 `configSchema.parse({...previous, ...changes})`，`apps/desktop/src/main/host/profile.ts` 的 `readConfig` 读时丢未知键，该文件对 `customVendors` 已有同类说明；代码推导，没有实跑旧版。复审：spec「迁移与回退」新加「回退时的 config.json」一条，含三个键名与「只往严的方向变」，修订记录有对应一行 · 已修 10926dc
- [建议] 文档同步（验收 41，人工）还没做：`SECURITY.md` 仍写着「Environment filtering for automatically approved commands belongs to a later phase」，`docs/ux/components.md`、`parity-audit` 的四处补记、overview 的模块表与「信任边界」都没动（对照 spec、突变两个视角；安全视角单报了 overview「信任边界」没提授权框、`folderAccess` 与自动档） · 证据：上面几处的现文，spec-check 的 docs-sync 报了警。复审：SECURITY.md 那句改成按名字去掉令牌的说明，components.md 五行、parity-audit、overview（模块表与信任边界的「渲染进程」「模型输出」两条）、master-reference 都改了，与 spec「文档同步」一节逐处对得上，docs-sync 的警没了 · 已修 6461ef6
- [建议] D41 和验收 12 写的是「关机中回 `refused`」，可是在真应用里 `refuseWhileShuttingDown` 会先挡住请求，回的是 `{ok:false, error:{code:'handler-failed'}}`（对照 spec） · 证据：`approval-mode-routes.test.ts` 的「06 验收 12: a shutdown refuses a choice」自己写明了这一点；渲染端 `setApprovalMode` 对两种结果的处理一样（都返回 false）。复审：spec §接口改成「关机中主进程的路由表先拒（渲染端收到 IPC 失败），没经路由表的调用由 kernel 回 `refused`」，修订记录一行，属于说清；验收 12 原文没跟着改，见下面验收 12 那条 · 已修 10926dc（只改了 §接口）
- [建议] `docs/README.md` 把 06 的「需要你」改成了「无」，可是 #92 改了 `ci.yml`，要 owner 点名合并（对照 spec） · 证据：README 当时的现文。复审：现在写的是「需要你：#92 改了 `ci.yml`，评审过后由你点名合并」；`git log 7df81fd..64ca307 -- docs/README.md` 只列出 64ca307 · 已修 64ca307（作者处置原写 10926dc，复审更正）
- [建议] spec 全文超过 heavy 档 25000 字符的上限（对照 spec） · 证据：spec-check 的 shape 警告，7df81fd 上 28808 字符，64ca307 上 29390，7567639 上 29791 · 不修：plan Open 记了理由（照录）
- [建议] 验收矩阵里第三段各条的「突变」列都还是「待补」，矩阵也没列 desktop 那边验收 12、13、15 的路由测试（对照 spec） · 证据：矩阵当时的现文。复审：`git show --stat 64ca307` 显示它改了 plan.md（「fill 06 matrix」）；矩阵在 plan.md 里，不在复审能读的范围，内容没有核对 · 已修 64ca307（处置原缺提交号；内容未核）
- [建议] `renderer-06-copy.test.ts` 里验收 44 的 describe 标题里还留着字面的 `%s`（对照 spec） · 证据：标题原文。复审：改成「06 验收 44: unknown summary codes read as unknown with one neutral sentence per verdict」 · 已修 10926dc
- [建议] `FolderGrantDialog` 用 `PathText` 直接显示路径，不经过 `visible()`，文件夹名里的方向控制符和零宽字符不会被画出来；已有的连接器授权框也是这样（安全） · 无证据 · 已修 10926dc（复审：去掉 `visible` 的 R7、F10 让 renderer-06-mode.test.ts 的方向控制符用例变红；设置列表那半边没有用例，见下面设置列表那条）
- [建议] 渲染端只在打开会话、自己切档、自动档里一次 Run 结束时重读 `session.facts`，没有策略变化的通知；将来有了真实的策略宿主，策略放开、而 Tape 仍是自动的会话，会按自动档判，却显示手动、也没有横幅（安全） · 无证据 · 不修：desktop 现在只有 `EmptyPolicy`，没有策略变化的来源；接入真实的策略宿主时再加（照录；复审核过 `apps/desktop/src/main/host/index.ts` 里只有 `new EmptyPolicy()`）
- [建议] plan 第 17、18 步写的文案里没有「允许访问这 {count} 个文件夹」（`folder.grant.titleMany`）和「管理文件夹访问」（`folder.access.manage`），可 spec §界面写的是「两段的文案定稿都在 plan 那一段的步骤里」（第二轮对照 spec 复审） · 证据：plan 第 17、18 步原文。第三轮：6553129 把这两句和单数标题「允许访问这个文件夹」写进了第 17 步的「文案定稿」，英文指向两份 locale 的 `folder.grant.*`、`folder.access.*` · 已修 6553129
- [建议] D41 只说清了一半：spec §接口改了，验收 12 原文还是「关机中回 `refused`」，而 desktop 的用例「06 验收 12: a shutdown refuses a choice」实际断言的是 IPC 失败，两处读起来不一致（第二轮对照 spec 复审） · 证据：spec「验收标准」第 12 条与 §接口 contracts 那一条的现文。第三轮：plan Open 第一条记了这一条，只是文字说法，不违反验收 · 不修：只算建议，记进 plan Open（理由属实，照录）
- [建议] `workspace.grant` 新加的复核里 `!real.resolved` 这一支没有测试（突变 F6 存活），注释里说的「或者文件夹没了，答复就作废」也不准（第二轮对照 spec 复审） · 证据：kernel `permission/workspace.ts` 的 `resolvePath` 遇到不存在的路径会往上走，`DesktopFs.realpath` 碰到 ENOENT 返回 null，删掉的文件夹解析出来是 `resolved: true`、能过复核；只有悬空链接、循环链接、EACCES 才走到这一支，去掉它 kernel 加文件夹时也回 `root-folder`、什么都不加。第三轮：注释在 4c258a3 改成「A folder deleted since still names itself; the kernel then refuses it.」；用例那一半 n04、R3b 两轮都判等价 · 已修 4c258a3（只修了注释）；用例那一半不修：等价（照录）
- [建议] 设置里「文件夹访问」列表的 `visible()` 没有测试守（第二轮三个复审都报了：对照 spec 的 F11、安全的 R8、突变的 n11）；作者对安全视角那条的处置写「授权框与设置列表都经 `visible()`」，用例只有授权框一处 · 证据：`FolderAccessSection.tsx` 的 `<PathText text={visible(folder)} />` 改成 `folder` 后相关集合与全量都绿，`renderToStaticMarkup` 不跑 effect，e2e「验收 35」只断言 `toContainText('kept')`；授权框那处的 F10、R7、n10 变红。第三轮：`configSetRequestSchema` 只收 `locale`、`sidebarCollapsed`、`approvalMode`、`autoModeNoticeSeen`，`folderAccess` 只有 `workspace.ts` 的 `keepAccess` 写，写的是授权框里显示过的真实路径；验收 19、35、36 没有要求设置列表把格式字符画出来 · 不修：列表里的路径只由主进程写进 `folderAccess`，渲染端加不进路径，都是用户在框里看过的真实路径（理由属实，照录）
- [建议] `keepAccess` 去掉「只留 kernel 接受了的」那道过滤（突变 F8）后测试全绿（第二轮对照 spec 复审；安全复审的 R4 同一处，算近似等价） · 证据：F8 跑 workspace-grants、workspace，24 条全绿；token 里存的已是真实路径，只有主进程复核与 kernel 再解析之间恰好有人改了链接两边才会不一样，去掉过滤时记下的是用户在框里看到的路径，不放宽 · 不修：要两步之间恰好被打断才触发（理由属实，照录）
- [建议] 答复时复核回 `stale` 的条件，验收 36 只列了三种 token（别的会话的、用过的、作废的），「真实路径变了」没写进去；`workspace.grant` 的注释说「or a folder gone, voids the answer」，实际回的是 `root-folder`（第二轮安全复审） · 证据：探针 C，真实磁盘，框开着时 `rmdir` 掉 `work/a`，答复回 `{"ok":true,"data":{"ok":false,"code":"root-folder"}}`；两种都不加文件夹，差在渲染端给的提示。第三轮：注释在 4c258a3 改对了；2a1ce3d 的修订记录已写明「答复时再解析一遍，哪一个解析到别处就回 `stale`、一个都不加」，实现比验收 36 严；`docs/spec-driven-dev.md` 写着评审之后 spec 正文就不能再改，plan 第 21 步也写在派最后一次评审之前做完 · 已修 4c258a3（注释）；验收 36 不修：spec 正文在评审之后不动（理由属实，照录）
- [建议] 修复新加的答复时检查 `now.some((real, at) => !real.resolved || real.path !== folders[at])` 只被单个文件夹的用例守，`some` 与 `every` 分不开；碰安全，不走默认不修（第二轮突变复审） · 证据：突变 n05（`some` 改 `every`）相关集合与全量都存活；探针一次选 `work/a`、`work/b`，框开着时把 `work/b` 换成指向 `secret` 的链接再点「以后都允许」，原实现回 `stale`、`folderAccess` 为空，n05 把链接目标记进 `folderAccess`。第三轮重打 n05，「06 验收 36: a folder swapped for a link while the dialog is open voids the answer (real disk)」里新加的两个文件夹（`work/c`、`work/d`）只换 `work/d` 那段变红 · 已修 2a1ce3d
- [建议] `chat.ts` 的 `autoCommands: () => options.sandbox!.autoCommands?.() ?? 'no'` 里的 `'no'` 没人守；`SandboxPorts.autoCommands` 是可选的，spec 要求缺省读作 `'no'`，改成 `'yes'` 就是宿主不实现时放行命令，产品里的运行时总会实现它，现在走不到（第二轮突变复审；对照 spec 复审的 F4 同一处，按等价） · 证据：突变 n16（`?? 'no'` 改 `?? 'yes'`）相关集合与全量都存活。第三轮重打，`chat.test.ts` 的「06 验收 40: a sandbox port that does not answer autoCommands reads as no」变红 · 已修 2a1ce3d
- [建议] 作者对 e16 的「不修」按分法该记进「以后再说」，没找到（第二轮突变复审） · 证据：`master-reference.md` 的「以后再说」那一轮只多了别的一行，plan 的 Open 也没有 e16。第三轮：「以后再说」新增一行，写明加清空会话入口时用它的 e2e 守住 `index.ts` 把 `onRemoval` 接到文件夹授权的作废、由 lead 在加清空入口的那份 spec 里做、出处是 06 第三段评审的突变 e16，四段齐全 · 已修 2a1ce3d
- [建议] 修复里改了一条已有断言，没写「测试改动」行：`workspace-grants.test.ts`「a selection with one ungranted folder asks for all of it…」的期望从 `['/work/a', '/link', '/work/b']` 改成 `['/work/a', '/work/b']`；spec 也没写框里显示真实路径、去重、被换成链接回 `stale`（第二轮突变复审） · 证据：当时 log.md 新增的行里没有「测试改动」。第三轮：2a1ce3d 在 log.md 加了两行「测试改动：」（那条断言仍是精确相等；`approval-mode-routes.test.ts` 那条是加严），spec 修订记录加了「说清文件夹授权（D42）」一行 · 已修 2a1ce3d

owner 回复：修复留下的窗口：`workspace.grant` 复核通过之后、kernel 解析之前（D44） · 「写进已知限制」（对话，2026-11-28；选择记录在 decisions.md D44）

## 验收 · 2026-11-28（第 24 步）

- 怎么验：dev `2e96766`（与审过的 `7567639` 之后只多了 log、plan 与合并提交，树与 `cfa6c6b` 相同）的构建，macOS 上起真 Tenon 窗口，单独的 `--user-data-dir`（只抄 owner 的模型设置），真模型智谱 glm-5.3；owner 说「起吧，你来走」后由 lead 用 computer use 逐项操作并截图。测试文件夹在临时目录、不在「文稿」「桌面」下。截图与逐项记录只放私有笔记（另记），不进仓库。
- 逐条：
  1. 验收 31：对话形态没有档位菜单；任务草稿发第一条消息前就有，向上弹出，两项带说明，默认手动打勾。
  2. 验收 33：第一次切到自动出说明条；「设置」打开「权限与网络」；「知道了」之后来回切不再出，重启应用后切到自动也不出（config 里 `autoModeNoticeSeen: true`）。
  3. 验收 32：自动档横幅常驻、没有关闭钮；点它回到手动、横幅消失，下一次 Write 出卡。
  4. 验收 1、38、40：自动档里 Write 不出卡，展开的工具行有「为什么没问 · 自动档放行」；结算行「可还原」，确认还原后文件回到原样。
  5. 验收 4、40：沙箱里的 `touch` 不出卡、文件建出，工具行同样有原因一行。
  6. 验收 7：`git reset --hard` 两档都出卡，④ 是红色「撤不回。」，钮是「拒绝 ⏎ Esc」「允许（只这一次）」；新卡不抢焦点（02「按键」），焦点进卡后 ⏎ 是拒绝。
  7. 验收 8：`echo hi > out.log` 在自动档出卡，③ 是 `redirect` 那句，钮是「允许（本会话）」；允许后同一条再跑不出卡。
  8. 验收 36：授权框显示真实路径，⏎ 落在「取消」、不加文件夹，关掉后回到文件夹浮层；「允许」只加进这个任务（`folderAccess` 仍为空）；「以后都允许」把真实路径写进 `folderAccess`，新任务不带上、再选不弹；设置里撤销后再选又弹，草稿里已加的照用。
  9. 验收 35：「权限与网络」从上到下是审批档、文件夹访问、网络白名单、高级；默认改成自动后正在用的任务仍是手动，新任务默认自动。
  10. 验收 42（人工）：菜单、说明条、设置里的自动档说明只说「按规则拦下的照样问」。
  11. 验收 41（人工）：第二轮对照 spec 复审逐处核过文档同步，`python3 .sdd/spec-check.py` 的 `pairs` 不拦。
- 回退限制：验收清单里点名告诉了 owner（plan 第 24 步那三句：写过 `inspector-flagged` 的会话回到 06 之前的版本后消息列表加载失败；回退时正等着的看不见字符的卡只有旧版重判仍放行的那种投递不出；回退会丢 config 的三个新键）。
- （平台）条目：PR #92 的头 `cfa6c6b` 上 `ci`、e2e、`sandbox-macos`、spec-check、`ci-ok` 全过（e2e 与 `sandbox-macos` 含 macOS、Linux），合并后的 `2e96766` 与它的树相同。
- 顺带看到的一处文案，挪进总参考「以后再说」：命令的卡与工具行按 presentation-r1「`unknown`，其余」写「如果它改了东西，Tenon 没法替你撤回。」，同一轮结算行却是「可还原（不含被排除的文件）」；06 之前就有，自动档让两句并排出现。owner 回「验收后修」。
- 侧栏没有会话列表：现状（`lib/sidebar-chats.ts`，02 留到后续阶段），已在「以后再说」。
- plan 的 Open 清空：第三段复审留下的建议挪进总参考「以后再说」（测试缺口一行、验收 12 原文一行）；spec 篇幅超出 heavy 上限的警告第 21 步已定不压缩，照留。
- owner 回「06 改 implemented」（2026-11-28，对话）；Status 改 implemented。
