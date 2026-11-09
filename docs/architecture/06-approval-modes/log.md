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
