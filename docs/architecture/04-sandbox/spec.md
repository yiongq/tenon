# 04 · 沙箱与出网（阶段 4a）

Status: ready
Phase: 4（4a）of the roadmap in [master-reference §13](../master-reference.md)。阶段 4 拆成四份（Q1 A、T1）：4a = 本 spec；4b = `05-file-bridge`；4c = `06-approval-modes`；4d = `docs/features/task-mode-ui`。后三份在本 spec 标 implemented 之后起草，裁决已在选择记录里
Owner: 裁决由 owner 拍板（2026-10-09 五轮，Q1–Q21 都选推荐项，T1–T44 与 T36 附表全收；例外一处：T19 改为另加成员、`HostFs.stat` 不动，归 4b。裁决卡 `cards-v1.md`、选择记录 `picks.md`、事实表与调研原文在仓库外 `../tenon-notes/2026-10-09-phase4-sandbox/`）；开放问题 1–5 与读法 1–49 2026-10-14 定，读法 50–53、设置栏合一与回执文案 2026-10-15 定（都照推荐）；开放问题 6–8（2026-10-15 审查后列出）owner 同日经问卷逐条答复、都取 A（6、8 原从「都按推荐」推出，问卷确认）；2026-10-16 owner 在对话里经问答定第一段留下的两条：macOS 丢违规行取 B、macOS 上脱身的 Apple 平台程序取 A（见 Revisions），第一段收口的其余各条 lead 定（已告知 owner）；同日第一段审查后的几处更正与收紧 lead 定（见 Revisions，owner 还没看过）；起草在 Claude Code（2026-10-09）
Amends: [00-foundation](../00-foundation/spec.md) §HostAdapter（`HostSandbox` 只增可选成员 `posture`，`SandboxViolation` 只增四个可选成员；受限档在沙箱不可用时 `wrap` 拒绝，见 §点名 (a)）；[01-provider-and-tape](../01-provider-and-tape/spec.md)（config.json 只增键 `sandbox`）；[02-agent-loop](../02-agent-loop/spec.md) §工具调用的收口（拦截码只增 `sandbox`，`ToolOutcomePayload` 与工具结果视图只增 `sandbox`）、§02 的 Tape 事实（`PermissionDecidedPayload` 只增 `sandbox`，新名字 `tool/receipt_override`、`message/sandbox_release`）、§主进程与 kernel 的循环接口（`LoopPorts` 只增可选的 `sandbox`，`SessionService` 只增 `release`）、§权限决策顺序（第 6 层的网络白名单落地、会话命令授权不免 full-access 计划的卡，§点名 (k)、(l)）、§内置工具与参数「Bash」、§`ConfirmReason` 只增四个值（命令卡只增可选事实键 `sandbox`）、§提示层（三处新文本，版本加一）、§本机抓取器（地址表加 CGNAT）；[03-mcp-host](../03-mcp-host/spec.md) §地址与出网（跨源发现地址按 DNS 一起拒 CGNAT）。只增不改，全文见 §对 00 的修补 至 §对 03 的修补；碰到旧文字的条目在 §点名
Related: [master-reference](../master-reference.md) §4.10、§13 阶段 4；[sandbox-runtime-mechanisms](../../reference/sandbox-runtime-mechanisms.md)；`docs/ux/parity-audit-2026-09-12.md`:246、:291；`docs/ux/components.md`:68、:143
Revisions: 2026-10-09 首版；2026-10-09 五角度审查后就地修订（尚无代码依赖，记录在仓库外 `spec-review-r1.json`）：initialize 的第三个参数在 Linux 也传真（它同时启动 seccomp 观测器），依赖检查改在 initialize 之后、WSL1 用 `getWslVersion` 判、helper 文件由 host 先确认、`userns-restricted` 的判法写定、自检加「往外写必须被拦」、去掉不带 seccomp 的重试（0.0.79 没有合规的关法）；srt 的强制禁写锚在主进程的 cwd，改由 Tenon 按每个根加，denyWrite 另含 denyRead 的全部条目、主目录下沙箱外会自动执行的位置与 srt 包目录，Linux `no-seccomp` 时另禁读几处 socket；上游代理钉成不用（`parentProxy: { noProxy: '*' }`），配置改成封闭的键集合并过 srt 的 schema；`/tmp/claude` 由 host 建并核对归属；违规改为订阅 srt 的存储、按 wrap 自己缓冲，`SandboxOutcome` 只增 `anyProtected`，分类表补 Seatbelt 的出网行、去掉死行 `deny http-request`，`localhost` 与数字写法不给域名按钮，「仅此路径」的目标加硬规则；`localhost` 进白名单在 srt 里是放行而不是拒，本机与私网条目只对走代理的客户端有效，回环与私网 IP 字面量必须带端口；读凭据被拒与保护名单分开（开放问题 3）；绑定了重跑的一定出 `elevated` 卡、会话授权不免 full-access 计划的卡，没绑定的一次性放行到点击后第一个 Run 结束作废；`pending` 期间的重新判定沿用原卡的那一句；`sandbox.release` 改带 `callKey`、幂等键第 6 段统一为 action、关机时只拒 `release`；执行与收口落在 executor 与 batch，点名表补上随之改断言的 02 测试（bash.test.ts:351、copy-coverage.test.ts:304、:315、inspectors.test.ts:42、fetch-address.test.ts:45、:54-67），点名 (e) 改为 (i)、(g) 写明「第二个产生方」，新增 (k) 第 6 层网络白名单、(l) 会话授权的范围；补 §主参考与 02 留下的各条的去向、06 的 `.git` 待议与自动档文案、05 的 T19 例外写法；新增开放问题 3–5、读法 33–45、不变量 18，验收 2–5、8–10、12、14–19、22、23、26–29、31、34、37 同改；plan 把探针挪到改 `ready` 之前、CI PR 提到第一段之后、第 13 步拆成六步；主参考 :919 注明估计、:924 补记映射挪 6b，mech 的 Revisions 更正 `reset()` 与强制禁写的锚点；2026-10-09 终检就地修订（同记在仓库外）：只写 `127.0.0.1:端口` 并不放行 `localhost:端口`（srt 先按名字比白名单，sandbox-manager.js:239-249），§网络白名单与验收 14 改正；`localhost` 与 `.localhost` 结尾的名字同回环 IP 字面量一样必须带端口（读法 40、验收 28）；开放问题 5 改为 spec 改 `ready` 之前定（选 A 会动不变量 3 与第一段）；§档位计划 写明绑定重跑的卡任何授权都免不掉，与不变量 18 对齐；已知限制补 Linux 没有「仅此路径」、`no-seccomp` 时没有观测器、macOS 上工作区里 `git init` / `git clone` 预计失败；读法 35 的 host 复查不过即拒绝这次 wrap、验收 23 加这一条；自检的写目标避开 srt 默认可写处；schema 校验按会话配置并上这次的 `filesystem`；srt 自己起的进程不在 AGENTS.md:22 之内；Linux 上 srt 每次 wrap 从主进程 cwd 起跑 rg，交探针 P2 量；超过 200 条的违规不计入 `more`；plan 把「CI 里漏设变量即失败」挪到第 21 步（第一段合并时 CI 还没有这个变量），P1 加 git 两项、P2 加 cwd 耗时；2026-10-14 照 owner 当天的答复就地修订（仍无代码依赖；答复记在仓库外 picks.md「04-sandbox spec 的开放问题」）：§开放问题 1–5 各标已定（1 = Linux 探针在本机两台 Lima 虚拟机上跑、不挪 CI，macOS 探针由 Claude 在 agent 沙箱外逐次确认后跑；2–4 照推荐，正文原已照写；5 选 A），§推出的读法 页头原为「待 owner 过目接受」，改记 1–45 已收、46–49 同日过目全收；开放问题 5 A 带来的改动——§网络白名单 预设一段原为「缓存目录 `~/.npm`（勾上且档位为 workspace-write 时可写，读法 20）」并写「这一点由开放问题 5 定，定之前照 Q10 A 原文」，改为 Tenon 自己的 `<userData>/sandbox-cache/npm` 与 `npm_config_cache`；§argv、shell、env 与 id 的 env 原为「返回 `{ argv: srt 给的 argv, env: { ...request.env } }`」，加上这一个变量的例外；`DesktopSandbox.wrap` 第 2 步原为「预设打开时它的缓存目录同样要在」，改为照 `/tmp/claude` 核对；allowWrite 一格原为「加它的缓存目录」；不变量 3 原为「返回的 env 恒等于 `request.env` 的拷贝」，不变量 5 原为「与预设缓存目录（只在 workspace-write 档）」；验收 4、6 加缓存目录的核对与这个变量，验收 5 注明预设生效时 allowWrite 另有这个目录，验收 29 原为「`~/.npm` 在 workspace-write 档可写、只读档不可写」；已知限制原为「「包管理器」预设打开时 `~/.npm` 可写（开放问题 5）」，改为共用缓存与 `~/.npmrc` 两点；裁决索引 Q10、T6 两行补这个例外；读法 20、41 补指向，新增读法 46–49；plan 的改 `ready` 前提、owner 的事、沙箱外、分段说明、§探针 引言与 P1、P3、P4，第零段两项，第 2、4、6、13、21 步与验收表第 4、6、29 行同改；2026-10-14 探针 P1–P8 跑完后就地修订（仍无代码依赖；macOS 26.3 本机在 agent 沙箱外、Lima 里的 Ubuntu 24.04 与 26.04，原始结果在仓库外 `probes/results/`，摘要在 plan 实施记录；P2 在 CI 的 macOS runner 上那次随第四段）：§afterExit 的表——Seatbelt 三行原写作以 `deny(1)` 开头，实测带 `<进程名>(<pid>) ` 前缀；出网行原为「`deny(1) network-outbound <地址>`，target 为地址」，实测只有 `remote:*:<端口>` 或什么都没有，改为 target 为空；代理行原为「原因是『不在白名单』」，改为按原因字面区分（P1 两平台都分得开）；`VIOLATION_SETTLE_MS` 原为「探针 P2 定，初值 200 ms」、只在 macOS 等，改为两平台都等、暂定 50 ms；§启动 第 2 步加按记录清上次的残留，第 3 步加 macOS 上 initialize 抛错时的 sandbox-exec 检查（原来 `nested-sandbox` 只靠自检的 71，而 agent 沙箱里 initialize 自己就抛 EPERM）；第 5 步自检原只写「写成就以 3 退出、写不成以 0 退出的 `/bin/sh -c` 命令」，补上不能用 `: >` 的理由；`userns-restricted` 原只按 sysctl 读数判，加 apply-seccomp 的一句 stderr；第 6 步补修法；§退出 原为「接法按探针 P8 的决定」，改为自己注册信号处理；§档位到 srt 配置——`ignoreViolations` 原为「探针 P2 定出的噪声名单」，定为 configd 一行；大小写变体原为「P1 核实，成立就……另传 glob」，P1 不成立、不加；凭据清单原为起草时的候选、两平台一份，改为 P3 定稿、按平台分；srt 自己那份强制禁写补上从 `/` 启动的后果（P1）与 rg 扫描的实测耗时（P2）；§网络白名单 的预设原为「起草时只有 npm……其余由探针 P4 逐个实测」，改为按平台的预设表；§argv、shell、env 与 id 的 env 原为「唯一的例外……`npm_config_cache`」，改为预设表里的变量与 macOS 的进程标记；`DesktopSandbox.wrap` 第 2 步原为「这次要加 Tenon 的 npm 缓存目录时」、allowWrite 一格原为「加 Tenon 自己的 npm 缓存目录」，都改为预设表里的目录；§afterExit 加挂载点与残留的记录（P7）；§执行与收口「停止后无残留」原为「探针 P6 量……杀不到就照它的决定加进程树遍历」，改为 P6 的结果与两处改动；读法 47 原为「这是 T6……唯一的例外」，改为两类例外之一；不变量 3、5、13 与验收 2、3、6、9、10、12、15、16、29 照改（验收 10 原为「`mktemp` 照样成功」，16 原为「macOS 上上面每个被拒的读、写与连接都在 `violations()` 里」）；已知限制删「macOS 上不分大小写的名字绕过（探针 P1 核实前）」，git init / clone、挂载点、双重 fork、丢行四条照实测改写，预设那条扩到预设表里的每个缓存并补上工作区 `.npmrc` 的 `registry=`，另加 TLS、裸 `mktemp`、从 Dock 启动、Unix socket 不留行、假 IP 的 DNS、macOS 上的 gh 与 git 凭据助手；裁决索引 Q10、Q20、T4、T6、T9、T11 六行补结论（原为「实测后定 / 实测后接」这类）；新增读法 50–53，待 owner 过目，Status 仍为 draft；2026-10-15 照 owner 当天的决定就地修订（仍无代码依赖；都照推荐）：读法 50–53 由「待 owner 过目」改为已定、各条留着没选的选项——50 A（主进程在 initialize 之前 chdir 到 `<userData>/sandbox-cwd`），§启动 第 2 步与验收 2 照加，§档位到 srt 配置 原为「怎么办见读法 50（待 owner 过目）」，已知限制删去「从 Dock 启动时（主进程 cwd 为 `/`），macOS 上沙箱里任何地方都建不了 git 仓库、写不了 `.vscode`、`.idea` 这类名字」；51 A（照 T14 接受），已知限制原为「读法 51 待 owner 过目，定之前照此写」；52 A 连同 C（Bash 描述第二句并进第 7 步那一次 10 → 11），§对 02 的修补 9 原为「Bash 描述加一句英文」，T35 一行与读法 30 照改，已知限制原为「`git add -A` 遇到它们会怎样没测，读法 52 待 owner 过目」；53 B（没有对象的行带 `observed`，Linux 对已存在目录的 `mkdirat` 到达即丢，`DNSConfiguration` 进 `ignoreViolations`），`ignoreViolations` 原为只有 configd 一行，§afterExit 的表与表后两句原为「落在可写范围外的照读法 11 带 `observed`」「怎么算见读法 53（待 owner 过目）」，§执行与收口、§对 00 的修补 2 的 `observed` 注释（原为「只来自 Linux seccomp 观测器，只作诊断」）、不变量 15、验收 16、19、20 照改，已知限制的 git 一条补计数；设置的两栏合成一栏「权限与网络」：§界面 原为「加两栏。「沙箱」：状态……「网络白名单」：……」，目标 4、T39 一行（另写明 `SessionStatusDot` 归 4d）、§所有权与模块、读法 28 加注、验收 30 与 `fake` 接缝的状态行照改；回执与 `elevated` 卡的文案不讲机制、写明放行管多久：§回执上有什么 原为「①「沙箱拦下了」加对象；②「拒绝原因已回传模型，它会换一种做法」」与按钮「本次放行 <主机名>」「仅此路径放行一次」「在沙箱外重跑」、一句「保护名单里的不能放行」，§界面 的 `elevated` 卡原为「这条命令将在沙箱外、以你的权限运行：{command}」，§放行怎么生效 的卡面同改；契约不变，验收 31、32、33 照改，33 加机制词的测试；4d 一条加「在文件夹里工作」开关取代 `ModeSwitch`（H1 不变）；按当天核过的公开出处补：T37 一行与 §文档同步 写准 Cowork 的执行位置（Pro / Max 新任务 2026-10-06 起在云端、进了合并体验的账号只在云端、Team / Enterprise 仍有本地 VM），§被否决的方案 T30 一句原为「VM（Cowork 本地模式的做法，已转云端）」；已知限制加「没有 hypervisor 级的隔离」与 macOS TCC（后者是 Tenon 的推断），「放行的域名本身就是外带通道，域名前置也可能绕过过滤（security-12）」一句改写成「白名单即能力授权」；新增不变量 19（host 不自动把推理端点、MCP 地址、遥测端点加进命令白名单）；§网络白名单 加「管的范围」一条（只管命令；改动从下一次 wrap 起生效，与 Cowork 要新开会话不同）与设置页的一句说明；凭据清单加整个 `~/.kube`（原为 `~/.kube/config`）、`~/.config/op`、`~/.vault-token`、`~/.pgpass` 与 Hugging Face 的令牌文件（Tenon 自己的选择，没经 P3、第 6 步实测），Q20 一行、读法 22 加注，已知限制补代价；§档位到 srt 配置 加「链接」一段（host 自己解链接；srt 0.0.79 受不受 Claude Code 2.1.299 修过的那类缺陷影响记为未知，附 srt 仓库 0.0.79 之后的相关 PR），验收 11 加拒绝条目经过链接的用例，验收 14 加「代理按请求的目标判、不按 `Host` 头」；§argv、shell、env 与 id 写明 `ELECTRON_RUN_AS_NODE` 进不了沙箱命令，验收 6、25 各加一半；关于 Claude Desktop / Claude Code 的事实只引公开文档（主参考:614）；plan 第 0、2、3、5、6、7、10、13、17–20 步与验收表照改；2026-10-15 审查后再就地修订（仍无代码依赖；审查记在仓库外）：§档位到 srt 配置「链接」原为「上表每个路径都由 host 取真实路径再传……Tenon 传的是真实路径，这个缺陷要的前提不出现」，改为拒绝条目按写下的拼法、路径上每个链接本身与真实路径三样都传，Linux 上护不住链接本身时由 host 事后比对（srt #693），srt 仓库的链接改指 `anthropics/sandbox-runtime`，验收 11 加替换链接的用例；denyWrite 两档加 `<userData>/sandbox-cwd`——读法 50 原写「不在任何 allowWrite 里，沙箱里的命令改不了它」，工作区是主目录或它的上级时不成立——e2e 的两种接缝都不 chdir；§afterExit 表的最后一行原为「其余（`mach-lookup`、`sysctl-read`、`network-bind` 等，以及认不出的行）……`observed`（读法 53）」，拆成两行，认不出的行不带 `observed`、照旧计数：owner 选的 53 B 原文是「§afterExit 表的最后一行与 Seatbelt 出网行」，那时最后一行不含认不出的行，进程名又由沙箱里的程序定；读法 2、53，§执行与收口、§对 00 的修补 2、不变量 15、验收 16 照改；§回执上有什么 加「沙箱回执不渲染 `blocked.<source>` 与 `blocked.told` 两行，`blocked.sandbox`、`closure.sandbox` 只为文案覆盖而在」，「为什么」原把 IP 字面量一律写成「指向本机或内网」、工作区外的写写成「不在这次任务可以改动的文件夹里」（只读档下的写对不上），改为按类分开；域名按钮原为「在这个对话里允许连接」「只在这个对话里有效」，Bash 只在任务形态有，改为「任务」，验收 31–33 照改；§IPC 原只写「`fake` 时……设置页也显示状态那一行、写明是测试接缝（姿态虽是 `active`）」，补上 `reasons` 带 `test-seam` 的写法、原因码注释与验收 30；§已知限制「白名单即能力授权」原写「Anthropic 的工程文记过 Cowork 因放行 `api.anthropic.com` 被这样利用，修法是……只放行会话自己签发的 token 的 MITM 代理」，照原文改为一次第三方披露与「VM 自己领到的会话 token」，另加「包管理器」预设的 `registry.npmjs.org` 同时接受发布（不变量 19 与 §界面 同改）；TCC 一条补反方向的系统授权框；Linux 上链接本身护不住进已知限制；凭据清单 2026-10-15 新增的几项补上各工具的公开文档出处，去掉找不到现行公开出处的 `~/.huggingface/token`，实测命令 `huggingface-cli version` 改为 `hf env`；这几项不在 owner 2026-10-15 的决定里，待 owner 确认；§文档同步 写准主参考实改的行（原写 :581、:641、:822 都已写准，当时只改了 :822），components.md:68、:143 与 parity:246 的补记挪进「起草时改」，另列同一 PR 里与 04 无关的改动；页头的引用说明补上 AGENTS.md、docs/spec-driven-dev.md、comp 与 parity 只在原行上改；Revisions 里讲来源的一句改为「关于 Claude Desktop / Claude Code 的事实只引公开文档」；plan 第 22 步、开工前读「owner 的事」与 Open 三条照改；2026-10-15 第二次审查后再就地修订（仍无代码依赖；审查记在仓库外）：§档位到 srt 配置「链接」原为拒绝条目以「写下的拼法；这条路径上每一级是链接的那一级本身；真实路径」三样传、读条目三样都进 denyRead，改为链接本身只进 macOS 的 denyWrite、不进 denyRead，Linux 上不传（上级目录是链接时，传它本身会把整个目标目录挡成不可读或只读：Linux 上 bwrap 挂载会跟到目标，srt 挂载前也先解开它，linux-sandbox-utils.js:2034-2041），Linux 的 lstat 比对改为默认就做、不再等第 6 步确认；补上 srt 0.0.79 只在解出的位置落在写下路径自己的子树里时才换成真实路径、链接指向别处时保留写下的拼法（`isSymlinkOutsideBoundary`），实施记录原写「0.0.79 受不受 Claude Code 2.1.299 修过的那类缺陷影响记为未知」，由此可知只传写下的拼法就有，第 6 步只作回归；#680 原转述为「macOS 上凭据类的读拒绝按写下的拼法与解开链接后的位置各写一份」，照 PR 原文改；同节开头「所有路径都是真实路径」与拒绝条目的传法对齐；验收 11 加反向用例（上级目录是链接时同目录别的文件仍读得到、经它照常可写），不变量 6 补 chdir 目录、两样拼法与链接本身的去处；denyWrite 的 `<userData>/sandbox-cwd` 原为两档无条件加，改为启动时传了这个目录才加（评测宿主不传），验收 5 同改；`DesktopSandbox.wrap` 第 2 步加每次受限 wrap 前复核这个目录（经你批准的 full-access 命令能删掉或换掉它），验收 4 同改，读法 50 的代价补 lint；`ignoreViolations` 原两平台都传，改为只在 macOS 传（srt 对所有来源按子串比），已知限制补「行里含这几个子串时不留违规」；§afterExit 表原为「其余认得出格式的（`mach-lookup`、`sysctl-read`、`network-bind` 等）」，是开放集合，改为封闭清单，清单以外的操作照认不出的行处理，§执行与收口、§对 00 的修补 2、读法 2、不变量 15、验收 16、20 照改；读法 53 原写认不出的行划出 `observed` 是「照 B 的原文改回」，B 的原文只说「表的最后一行」、字面也装得下认不出的行，改记为审查后收紧、待 owner 确认，与上一条一起列为开放问题 8；§回执上有什么 第 1、2 段原按读与写分句（「没能读取」，凭据读、保护名单的写、profile 各一句）、写明「按 `kind`、`target`、`release`、`protected` 判」，而这几个字段分不出读写，也分不出 profile 与保护名单，改为「写入」只用于 `release: 'path'`、其余写「访问」，文件类的「为什么」按 `release: 'path'`、`protected`、其余三类出句（保护名单那句原为「这个文件改了会影响之后在你电脑上自动运行的东西」，对 `.ssh`、凭据的写不对）；按钮原为「不加限制重跑这条命令」（点了并不立即重跑）、路径按钮下面原为「只对下一次同样的命令有效一次，不会记住」，改为写明何时生效、没用上何时作废，域名按钮下面补「也能往上面传东西」，验收 31、32 与读法 51 照改；已知限制「凭据清单新增项的代价」原只写改了位置的挡不住，补上放在环境变量里的令牌照传给命令，Q20 一行、读法 22 同注；TCC 一条原为「你没有主动操作时冒出来的这类弹窗应当拒绝」，改为命令运行期间冒出、你没要求访问的才拒，补「别给完全磁盘访问」与 plan 第 13c 步的核对；不变量 19 删去「其中 npm 的那个同时接受发布」（是事实、不是断言，已在已知限制）；§开放问题 页头原为「五条 owner 都已于 2026-10-14 定」，加 6–8；读法 28 补 06 的去向；4d 一条写明照第三个例外替换 02 的 `ModeSwitch` 条款；§主参考与 02 留下的各条的去向 ③ 补「Q18 A 落地前复核读法 53 的不计数」；§文档同步「同一 PR 另带」原为「`AGENTS.md`:11 镜像一句、:12 补半句」，:12 的半句（已写进 implemented spec 的文案要走表现层的路）不在 owner 的决定里、与 docs/spec-driven-dev.md:11 相左，删掉、:12 回到原文，另补 parity:326 的注、02plan:1143 的限定与主参考 :641、:926 补的合并体验一句；plan 第 2–6、13c、15a、18–20、22 步、验收表、owner 的事与 Open 照改。2026-10-15 owner 过目并接受，Status 改 ready：读法 50–53、设置栏合一与回执文案照当天已记的决定（上面各轮修订已写入）；开放问题 6、8 owner 答「都按推荐」，都取 A（凭据清单新增项收下，53 B 照收紧后的范围），各处「待 owner 确认」的注已去掉；开放问题 7 不挡 `ready`，仍待 owner，定之前照 B 写。2026-10-15 owner 经问卷逐条答复（取代上一句从「都按推荐」推出的读法；仍无代码依赖）：开放问题 6、8 确认 A，页头、§裁决索引 Q20 一行、§档位到 srt 配置、§afterExit 表后一段、开放问题页头与 6、8、读法 22、53 原写「答「都按推荐」」，改为经问卷确认；开放问题 7 定 A——违规全带 `observed`、退出码为 0 的调用回执只作提示、不给「允许这条命令下次不受限制地运行一次」，退出码非 0 或至少一条不带 `observed` 时照现规则，只动界面上出不出这个按钮、契约与 kernel 的核对不变：§回执上有什么 这个按钮原为「`anyProtected` 为假时才有」，补上这一条与退出码怎么看（照 02:1933 从输出的第一行看），页头原为「开放问题 7 不挡 `ready`、仍待 owner」，验收 31 加这一条，plan 第 18 步与验收表加突变；同日 owner 定 2026-09-28 补录与 B 列一样降为只作参考，§文档同步 对 parity:326 那条注的说明原为「2026-09-28 补录还算不算证据待 owner 定」，02plan:1143 那条补「02 的 Status 仍为 implemented」。2026-10-15 plan 第 6 步实测后就地修订（代码不依赖这几句）：§已知限制 挂载点一条原为「`git add -A` 遇到它们会怎样由 plan 第 6 步实测、照结果改这一句」，改为实测结果（两台 Linux 上 `git add -A` 与 `git add .` 整条失败、退出码 128、什么都不 stage，`git add <路径>`、`-u`、`commit -a` 照常）；§网络白名单 预设一段原为「第 6 步的黑盒补一条」，改为第 6 步在跑 S 的机器上实测、不进黑盒（黑盒不联网），两平台都装上；§已知限制 凭据清单新增项一条补 hf：`~/.cache/huggingface/token` 存在时 `hf env` 在沙箱里起不来，清单里已是这个文件本身，照 P3 照留。2026-10-16 第一段收口就地修订（plan Open 里第一段留下的各条；第一段还没合并进 dev，依赖这些句子的只有同一个 PR 里的代码，一并照改）。owner 当天在对话里经问答定两条：① macOS 丢违规行取 B——srt 的日志监听每块只看第一条拒绝行、它是噪声或 `ignoreViolations` 行时整块扔掉，`diagnosticd` 那行常排在真拒绝前面（第 6 步审查三轮 300 次丢 61 次），所以 macOS 的受限命令另加 `OS_ACTIVITY_MODE=disable`、覆盖 `request.env` 里不分大小写的同名键：T6 与不变量 3 的例外由两类变三类，§argv、shell、env 与 id、§afterExit 表后一段、读法 47、验收 6、16 照改，验收 16 的 macOS 组不再另加测试条件、加一条连跑 50 次不重试的，§已知限制 写全丢失的原因与 B 管不到的两种（不经代理的直连被拒约一成，同一块里的第二条真拒绝）；② macOS 上脱身的 Apple 平台程序取 A——`ps -E` 读不到平台程序的环境变量、标签对它们不可见，照 P6 的预案收窄：§执行与收口 删掉「正常结束后 setsid 的那个与守护进程都找得到、杀得掉」，按标签找到的进程连它所在的进程组一起杀，不变量 13、验收 15 的 macOS 正常结束一半限定为标签读得到的进程与它们的组，§已知限制 写全 `setsid`、`set -m`、双重 fork 三种脱身法在正常结束与停止时的后果，T11 一行同改。其余各条 lead 2026-10-16 定（已告知 owner）：③ 读法 11 的「落在」按真实落点判（plan Open 原写「待 owner 定」；这是把「落在」说清楚，不涉及要 owner 取舍的代价）：观测器的路径照内核的顺序解开，跟与不跟链接的调用表写全，写下的拼法与真实位置任一落在 denyWrite 上就带 `protected`，`/proc`、`/dev` 不解，解不出的不丢；§afterExit 表的 Linux 行 target 原为写下的路径，改为真实位置，验收 16 照改；④ 拒绝条目一路解析到底（Open 里悬空链接、链式链接两条原写「待 owner 定」；只收紧、不放宽）：注入的端口加 `readlink`，悬空链接跟到目标（同 srt79 `resolveSymlinkedDenyPath`），链接目标里的链接也收进 links，最多 40 跳，成环或超限时保留已走过的链接、照常运行；原写「条目路径上每一级是链接的那一级」，「链接」一段、不变量 6、验收 11 与 §已知限制 照改；⑤ macOS 上本身就是链接的拒绝条目，写下的拼法只进 denyWrite、不再进 denyRead：原写法下 Seatbelt 在链接上就拒，经它写凭据被报成对链接的读、不带 `protected`，回执多给重跑按钮，「链接」一段与不变量 6 在这种情况下也自相矛盾；⑥ Linux 上已存在的禁读目录在沙箱里是可写的空 tmpfs：验收 11、12 的 Linux 半原写「写被拒」，改为宿主上不变，不变量 6 注明，§已知限制 加一句；⑦ x64 上观测器报的老式 `mkdir` 对已存在目录与 `mkdirat` 一样丢掉（意图与 owner 定的 53 B 相同，范围不扩大），读法 53、§afterExit、不变量 15、验收 16 写作「`mkdirat`（x64 上还有老式 `mkdir`）」，读法 53 与表后一段的「26.04 上没有」更正为 24.04 每一级都报、26.04 报最深一级；⑧「包管理器」预设的 pnpm 原只设 `npm_config_store_dir`，改为一组六个（store、cache、state 各一个 `npm_config_*` 与一个 `pnpm_config_*`，都在 `<目录>` 之下），预设表、不变量 3（补「或其下子目录」）、读法 47、49 照改——读法 49 是 owner 2026-10-14 收下的规则，措辞由「一个环境变量」改为「一个或一组」，意思不变，go 不进的理由随之改写为没用一组变量重测过、这次照旧不进；第 6 步就地改的三句照收（pnpm 手动实测、不进黑盒），照新的一组再测一次；⑨ 第 4、5 步实现时自定的接口与格式照收、写进正文：启动交接 `SandboxStartupRun` 与 `initialize` 的四种结果（§启动），信号之后 `reasons()` 为 `init-failed` / `reset by a signal`（§退出），`stubs.json` 的键、其余键原样保留、读时只收 tmpdir 下 srt 三类名字（§afterExit），Linux 链接变化的固定行文（「链接」），非 shell 的 `argv[0]` 抛 `SandboxUnavailableError`（原只写「拒绝」），第 5 步的各项映射（PATH 上找不到的交 srt、`ripgrep (<Tenon 的 rg>) not found` 记 `other`、自检只给 `PATH` 与 `HOME`、依赖检查抛错与配置过不了 schema 记 `init-failed`、sysctl 只在自检失败时读与详情的格式，§启动）；⑩ 注册 `app.quit` 的条件定为 `initialize` 不是 `not-called`、也不是 `dependency-error`，不看 `initialized`（srt 在依赖检查之后、起代理之前就装上信号监听，sandbox-manager.js:542），原写「initialize 之后」，§退出、T4 与验收 3 照改；⑪ tool-use id 按 UTF-8 在码点边界上截到 67 字节，原为 67 个字符（srt 送 id 最多 251 字节，67 个汉字会到 312 字节），读法 6 与 §argv、shell、env 与 id 照改；⑫ 第 3 步代码里往安全方向的几处收紧照收、写进正文：已存在的链接不给「仅此路径」（读法 35），域名按钮只给 srt 的 allowedDomains schema 收得下的名字，srt `isValidHost` 字符集以外的主机名不给 target、回执归入没有记下对象的那一句，进程名以 `deny ` 开头的 Seatbelt 行按认不出处理（§afterExit 的表与表后一段、§回执上有什么）；⑬ `killTree` 比原文多做的三处照收（`lstart` 防 pid 复用、收集到的在两次信号之间留着并在组空后再发、`ps` 至多等 200 ms），`ps` 失败或超时时不再静默、往宿主日志打一行（§执行与收口）；⑭ srt 以主进程的 `JAVA_TOOL_OPTIONS` 为底拼命令里的同名变量，T6 那段注明、§已知限制 加一句；⑮ macOS 上工作区根下建不出 `.claude/`，写进 §已知限制 git 那一条；⑯ NOTICE:9 的 srt 仓库名照迁址改写，§依赖 注明，§文档同步「实现时改」补上 NOTICE；⑰ 启动与清理一组（plan Open 378②、379–384，先于上面各条落地）：§afterExit「挂载点与残留的记录」原写「被 SIGKILL 之后只剩空目录」，与 P7 的原始数据不符（`afterSigkill` 是 17 个大小 0、权限 0444 的空文件加空目录 `.claude`），改为照实写，`stubs.json` 加 `leafMountPoints`（wrap 前记下这次 allowWrite 下此刻不存在的叶子拒绝条目），启动时记下的主进程已不在才删、只删仍满足 srt 四个条件的；那一句原写 `afterExit` 之后删掉这次的条目（正常收尾时 srt 自己收掉了），改为只删宿主上已不存在的，srt 推迟或跳过的留给下次启动；孤儿 socat 原要求父进程为 1，P7 只在 ssh 会话里测过、桌面会话的 `systemd --user` 是 subreaper，改为记下的主进程已不在、pid 与命令行一字不差、父进程不是那个主进程；`srt-obs-*` 原按「initialize 前后新出现」收，别的 srt 使用者同一时刻建的也会被记下、下次删掉，改为只收主进程监听着的（`/proc/net/unix` 与 `/proc/self/fd` 的 inode）；`claude-empty-*` 原列在 initialize 之后记的四类里，srt 实际在 wrap 时才建（linux-sandbox-utils.js:2161），记下的只可能是别人的，改为不记、写进已知限制；「P7 每次两个进程、八个条目」读错了 p7.json，改为每轮一个 socat 加四个条目、共两轮；§启动 第 4 步后一段与 §IPC 原只写依赖错误认不出的记 `other`，补「认不出的 warning 记 `degraded` 加 `other`、详情是 srt 原文」，原因码表的注同改；§启动 第 6 步要修法写出第 2 步找到的 bwrap，而 `unavailable` 时拿不到它，改为 `userns-restricted` 的详情末行写 `bwrap=<绝对路径>`、§IPC 同注；验收 9 与 §已知限制 照改；2026-10-16 第一段审查后再改（lead 定；这一轮审查的发现没有拿给 owner 看过，只往收紧或更正的方向改）：读法 11 的调用表补上 x64 版 apply-seccomp 的老式调用（`open`、`chmod`、`chown`、`utime`、`utimes` 跟链接，`unlink`、`rmdir`、`rename`、`symlink`、`mkdir`、`mknod`、`link`、`lchown` 不跟；原先都落进「两种都算」，x64 上经工作区里指向外面的链接 `unlink`、`rename` 会多报，`chmod` 经链接被拒时 `target` 报成链接本身），两张表都没有的只剩伪造的名字；解析途中（含链接目标）一到 `/proc`、`/dev` 就停（原只看写下的拼法，经工作区里指向 `/proc/self/fd` 的链接会解进 Tenon 自己的进程）；落在 srt 自带可写处（`/dev/null`、`/tmp/claude`、`~/.npm/_logs` 等）的与 srt 自己的观测器一样丢掉（原经链接到那里的会多报）；按目录的缓存遇到会把一级换掉的调用就作废那一级与它下面的（原整条命令都不失效，先写过的目录换成链接后，经它被拒的写会被当成工作区内的写丢掉），§已知限制 补上仍会漏的情形；§afterExit「挂载点与残留的记录」与验收 9：启动时目录挂载点也要记下的主进程已不在，挂载点（目录与叶子）另要没有在跑的 bwrap、读不到进程表也不删，没删的留在记录里等下次启动（原写空目录不等记录者，宿主上删掉别的 bwrap 正当挂载点用的路径会让那个沙箱的拒绝失效）；验收 16、§afterExit 表后一段与 §已知限制：P1 那次读拒绝没留行原被当成「同一块里的第二条」的例子，实为块里只有一条、打头那行被当噪声扔掉的那种，改正，「第二条」注明是从 srt 的读法推出、没实测；不变量 3 的「owner 2026-10-16」原标在句末，像是整句都由 owner 定，改为只标 `OS_ACTIVITY_MODE` 那一分句，「或其下子目录」标 lead 定

引用写法照裁决卡页头：`00:N`、`01:N`、`02:N`、`03:N` = docs/architecture/0N-*/spec.md 第 N 行；`02plan:N` = 02 的 plan.md；`主参考:N` = master-reference.md；`comp:N` = docs/ux/components.md；`parity:N` = docs/ux/parity-audit-2026-09-12.md；`mech:N` = docs/reference/sandbox-runtime-mechanisms.md；`srt79 …` = npm `@anthropic-ai/sandbox-runtime@0.0.79` 的发布包（仓库外 `audit-facts/srt79/package/`）；`srt-1`、`security-m3` 这类是仓库外 `verified-facts.md` 的事实编号；Q、T 是裁决卡题号。代码路径相对仓库根。所有行号按 dev `2d9e53e`，即本 spec 给 00–03 加 `Amended by` 之前的行号：到工作树里对照时，00 第 6 行起、01 第 7 行起、02 第 6 行起、03 第 4 行起各加一，mech 头部加了一行 Revisions、第 8 行起加一；主参考、AGENTS.md、docs/spec-driven-dev.md、comp 与 parity 都只在原行上改写、不增删行（§文档同步）。

## 现状

dev `2d9e53e`，只读代码与调研：

- 沙箱是直通：`PassthroughSandbox` 除 `full-access` 外只打一行日志（apps/desktop/src/main/host/sandbox.ts:10-29），desktop 宿主在 apps/desktop/src/main/host/index.ts:55 装它。srt 还不是依赖（pnpm-lock.yaml 与各 package.json 0 处）。
- 经 `sandbox.wrap` 的产品调用点三处：Bash（packages/kernel/src/tools/builtin/bash.ts:123，`profile: 'workspace-write'` 只记意图，02:1920）、MCP stdio（packages/kernel/src/mcp/connection.ts:101，池恒传 `full-access`，packages/kernel/src/mcp/pool.ts:488）、shell-env 探测（apps/desktop/src/main/host/shell-env.ts:147，传 `read-only`）。评测另有两处直通：判分检查（apps/desktop/evals/checks/support.ts:322）与评测宿主（apps/desktop/evals/host.ts:326）。
- `HostSandbox.violations()` 在产品里没有调用方；Bash 不读违规、wrap 成功而 spawn 失败时不调 `afterExit`（bash.ts:122-142）；正常退出后不杀留在后台的进程（02:1933 留给阶段 4）。
- 拦截码只有四个（packages/kernel/src/loop/closure.ts:28）；答复来源 `receipt-override` 只留字面量、没有写入方（02:1273、:2165）。
- WebFetch 不拦 CGNAT：地址表 packages/kernel/src/permission/fetch-address.ts:2-43 没有 `100.64.0.0/10`，apps/desktop/test/fetch-untrusted.test.ts:128 明写「留给阶段 4」（02:3400、02plan:1003）。
- CI 只有 ubuntu 三个 job（.github/workflows/ci.yml:23、:57、:90），没有 macOS runner（02:3404）。

## 目标与非目标

### 目标

1. macOS 与 Linux 上 Bash 起的命令都在 srt 沙箱里跑：默认工作区可写，设置「高级」里可改只读；网络默认关，只放行白名单（Q8 A、Q9 A、Q10 A、T33、T38）。
2. 沙箱起不来时照今天的样子跑、每条都问，卡上写「沙箱不可用，将以你的权限运行」，设置页写原因与修法（Q6 A、Q4 A、T12、T32）。
3. 被沙箱拦下的读写与连接回给模型、出拦截回执；你可以从回执一次性放行这个路径、在沙箱外重跑这一条，或本会话放行这个域名（Q8 A、Q9 A、T41、T43）。
4. 设置里有一栏「权限与网络」：网络白名单与「包管理器」预设是主体，命令档位在「高级」里（Q10 A、T18、T39；owner 2026-10-15 把原定的两栏合成一栏）。
5. 一组 Tenon 自己的沙箱黑盒用例在 macOS 与 Linux CI 上全过（Q5 A）。
6. WebFetch 与 03 公网 server 的跨源发现地址拦 CGNAT（T16）。

### 非目标

- MCP stdio server 进沙箱、按工作区拆进程（Q11 A：pool.ts:488、03 确认框与 03 验收 9 都不动）。
- Windows 上的沙箱（Q4 A）；常驻「完全访问」与「跑完自动降回」（Q8 A）；运行中就地问域名（Q9 A 不用 askCallback）；按命令的网络开关（T38：0.0.79 做不到）。
- helper 放 asar 外与签名（Q2 A、T31：阶段 7 打包）；宿主↔沙箱路径映射（Q2 A：6b）；右面板（Q2 A：阶段 5）；Execution Journal 余项与 LLM 判官（T28：单列）；按任务授权 `GrantScope` 的 `'task'`（T26：仍在阶段 6，02:2108、:3372）。
- 下一节列给 05、06 与 task-mode-ui 的一切。

### 留给 05、06 与 task-mode-ui 的

这些的触发条件只在 4b、4c、4d 才有，本 spec 不定，只指路（裁决都在 picks.md）：

- **05-file-bridge（4b）**：影子 git 快照、还原与小结（Q12 A 除 allowWrite 之外的全部、T20–T24、T22、T44）；mtime 守卫（Q13 A）；硬链接（Q14 A）；Delete 工具（Q15 A）——Q14 A 的 `nlink` 与 T19 的纳秒 mtime 照 picks.md 的 T19 例外放进另加的 `HostFs` 成员（如 `identity(path)`），`HostFs.stat` 不动；T13 的文件工具一半（保护名单里的非 shell 名字对文件工具按工作区外处理）；T29 路径归属；主参考:945 验收的第二句（还原后内容与 mtime 回到任务前）。
- **06-approval-modes（4c）**：自动档与 railguard、F9 的 inspector 回执（Q16 A、T26 的 4c 一半；inspector 回执的放行记在哪由 06 定，02 保留的 `ApprovalResolvedPayload.via` 字面量仍可用）；跳过档不做、带日期删 parity:39、:230 与 comp:103 的跳过项（Q17 A）；沙箱内命令免问（Q18 A，缺 `posture` 的宿主读作不可用，读法 1）；持久文件夹授权（Q21 A）；自动档免问的命令去掉 token 环境变量（Q20 B 的环境一半）；Q6 A 的「沙箱不可用时沙箱内免问与跳过档不可选」；picks.md「待议」的 `.git` 写保护（作题）；自动档文案改诚实（picks.md 追加决定，parity:230 带日期补记）；T25、T27、T34。
- **features/task-mode-ui（4d）**：T39 列给 4d 的界面（时间线、折叠头、子行、带样式的改动预览、`SessionStatusDot`、网络搜索开关、AskUserQuestion 的 preview、附件三件）；拦截回执的「查看这条规则」（读法 27）；输入框里的「在文件夹里工作」开关，取代两颗胶囊的 `ModeSwitch`（owner 2026-10-15：Tenon 不跟 Claude 把 Chat 与 Cowork 合成一个入口，仍保留对话与任务两种会话形态、建会话时定下，02 的 H1；随 4d 或展示层 spec 做）。做这件事的 spec 照 docs/spec-driven-dev.md 的第三个例外替换 02:2834 的 `ModeSwitch` 条款（契约 `session.selectProfile` 与 H1 不变）：在自己的 `Replaces:` 里写明，02 那一行末尾接指针，02 顶部加 `Clauses replaced by:`。

## 裁决索引

全文与依据在裁决卡（仓库外 `cards-v1.md`），选择记录在同目录 `picks.md`。只列 4a 承担的。

| id | 决定 | 落点 |
|---|---|---|
| Q1、T1 | 拆四份，本 spec 编号 04；编号与阶段号脱钩，主参考 §13 加对照 | 页头；§文档同步 |
| Q2 | 右面板 → 阶段 5；双向映射 → 6b；asar 外与签名 → 阶段 7，4a 只在开发构建验收 | §非目标；§文档同步 |
| Q4、T32 | Windows 不沙箱：不调 initialize，按「不可用」走 | §启动、自检与姿态 |
| Q5 | Tenon 自己的黑盒用例，macOS 与 Linux CI；workflow PR 由 owner 合 | §验收标准 10–16、34；plan 第四段 |
| Q6 | 不可用时每条照问、卡上一句、设置页写原因与修法，不替你 sudo | §档位计划写进判决；§界面 |
| Q8 | 无常驻完全访问；默认工作区可写、「高级」可改只读；越出沙箱只从回执一次性放行；Bash 参数不变；保护名单内不给按钮；不做跑完降回 | §拦截回执与放行；§界面 |
| Q9 | 白名单外一律拒（strictAllowlist）；违规进输出与回执；「本次放行这个域名」= Tape 里的会话授权（第 6 层）、热生效；「以后都允许」只在设置里加 | §网络白名单；§拦截回执与放行 |
| Q10 | 白名单默认空；「包管理器」预设一键加、默认不勾；P4 定：两平台 npm、pnpm、uv、cargo，Linux 另有 pip；勾上时各自在 `<userData>/sandbox-cache/` 下的目录可写（开放问题 5 A、读法 49） | §网络白名单；§argv、shell、env 与 id；plan 探针 P4 |
| Q11 | MCP stdio server 暂不入沙箱 | §非目标；§已知限制；§文档同步 |
| Q12（4a 部分） | allowWrite 直接指真实工作区 | §档位到 srt 配置 |
| Q20（4a 部分） | denyRead 加常见凭据清单，P3 定稿、按平台分；两档都生效；2026-10-15 另加几项明显是凭据的文件（Tenon 自己的选择，各附工具的公开文档；原不在 owner 2026-10-15 的决定里，之后 owner 经问卷确认收下，开放问题 6；第 6 步实测）；只挡缺省位置的文件，放在环境变量里的同类令牌照传给命令（§已知限制） | §档位到 srt 配置；plan 探针 P3、第 6 步 |
| T2 | 钉 0.0.79，不跟 HEAD，升级走 Revisions | §依赖 |
| T3 | 主参考、AGENTS.md、mech 的版本与机制勘误 | §文档同步 |
| T4 | 启动后 initialize 一次、不挡窗口；退出时显式 await reset；调过 initialize（依赖检查那一步抛错的除外）之后自己注册 SIGTERM / SIGINT → `app.quit()`（P8） | §启动、自检与姿态；§退出；探针 P8 |
| T5 | 每次 wrap 传本会话当前文件夹，中途增删从下一条起生效，不 reset | §档位到 srt 配置 |
| T6 | env 以 `request.env` 为底，绝不转发 srt 返回的 env；shell-env 探测改 `full-access`；例外三类：预设生效时 host 加预设表里的变量（开放问题 5 A，读法 47），macOS 上加进程标记 `TENON_SANDBOX_MARK`（P6）与 `OS_ACTIVITY_MODE=disable`（owner 2026-10-16） | §argv、shell、env 与 id；§三处调用点 |
| T7 | argv 转义成命令串，shell 传绝对路径 | §argv、shell、env 与 id |
| T8 | srt 用的 id 每次唯一、≤ 100 字符、带 128 位随机 | §argv、shell、env 与 id |
| T9 | 每次 wrap 恰好一次 `cleanupAfterCommand`；SIGKILL 后的挂载点与残留按记录在下次启动清（P7） | §afterExit、清理与违规；探针 P7 |
| T10、T41 | 违规附在输出末尾；照执行过收口、来源 `sandbox`、计入 F2；Linux 观测器的只回给模型与回执、不计数 | §执行与收口 |
| T11 | 真包装下重测停止；调用结束时杀进程组；macOS 另遍历子孙树、按标记找残留并连它所在的组一起杀（P6）；macOS 上脱离原进程组的 Apple 平台程序找不到，写进已知限制（owner 2026-10-16） | §执行与收口；探针 P6 |
| T12 | 依赖检查分「生效 / 部分降级 / 不可用」，Ubuntu 限制按运行时探测 | §启动、自检与姿态 |
| T13（4a 部分）、T14、T33 | 档位到 srt 配置；保护名单与凭据清单写字面路径；配置只含列出的键，几个开关永不打开（读法 43） | §档位到 srt 配置 |
| T15 | 已知剩余风险写进 spec 与 SECURITY.md | §已知限制 |
| T16、T42 | WebFetch 与 03 跨源发现拦 CGNAT；命令一侧沿用 srt 默认的解析地址检查，上游代理钉成不用（读法 33）；WebFetch 的按域名会话授权不并进命令白名单 | §WebFetch 与 CGNAT；§网络白名单 |
| T17 | 命令主原因仍是 `command`；在沙箱外重跑用 `elevated` | §档位计划写进判决 |
| T18 | 用户白名单存 config.json、域名的会话授权写 Tape，都经 updateConfig 热生效；拒裸 `*` | §网络白名单 |
| T26（4a 部分） | 4a 的回执放行由沙箱回执产生；网络的「本次放行」是会话授权 | §拦截回执与放行 |
| T31 | 开发构建显式传 helper 路径 | §依赖 |
| T35（4a 部分） | 违规说明、放行说明、Bash 描述两句（第二句是读法 52 的）计入提示层，版本加一 | §对 02 的修补 9 |
| T36 | 碰到 00–03 的条目按附表归类 | §点名 |
| T37 | 执行与隔离的对照改为 Claude Desktop 的 Code 会话与 Claude Code；Cowork 的执行位置照公开文档写准（2026-10-15 补，见 §文档同步） | §文档同步；§已知限制 |
| T38 | `SandboxRequest` 不动；网络在 host 的一份全局白名单上 | §对 00 的修补 |
| T39（4a 部分） | 设置里一栏「权限与网络」（owner 2026-10-15 把原定的「沙箱」栏与「网络白名单」页合一）、回执的放行按钮与 `elevated` 卡的文案；`SessionStatusDot` 归 4d，4a 不在别处放沙箱的状态点或 chip | §界面 |
| T40 | 评测的判分检查保持直通；模型命令用产品的实现 | §三处调用点；读法 26 |
| T43 | 「仅此路径」只认一次，host 拼、不接受模型输入，不生成会话授权 | §拦截回执与放行 |

### 主参考与 02 留下的各条的去向

主参考 §13 阶段 4「原列的」（主参考:931–:936）与 02 留下的七条（02:3159–:3165）：

| 条目 | 去向 |
|---|---|
| :931 档位与网络一个枚举还是两个轴 | 本 spec（T38） |
| :932 不可用时的降级阶梯 | 本 spec（Q6 A、T12） |
| :933「跑完自动降回」；profile 进 denyRead | 不做（Q8 A）；本 spec §档位到 srt 配置 |
| :934 长驻 MCP server 的档位；「仅包管理器」预设 | 不入沙箱（Q11 A）；本 spec §网络白名单 |
| :935 快照三选一 | 05（Q12 A）；allowWrite 指真实工作区在本 spec |
| :936 补查 srt 三点 | mech 的 Revisions（§文档同步） |
| ① 自动档、规则 inspector 与 railguard | 06（Q16 A） |
| ② 跳过档 | 06（Q17 A：不做） |
| ③ 只读命令免问 | 06（Q18 A 的沙箱内免问）；06 落地 Q18 A 之前复核读法 53 的不计数（免问之后，只带 `observed` 的试探只剩步数上限兜底） |
| ④ 有快照后的删除 | 05（Q15 A） |
| ⑤ 硬链接 | 05（Q14 A、T19 例外） |
| ⑥ WebFetch 并入出网收口、CGNAT | 本 spec（T16、T42） |
| ⑦ 命令的主原因 | 本 spec（T17） |

## 所有权与模块

- `packages/kernel`：Bash 的档位计划、违规块、收口与计数；`release` 命令、两条新事实、放行的绑定；提示层文本；地址表加 CGNAT。不 import srt（AGENTS.md:18）。
- `apps/desktop/src/main/host/`：`sandbox.ts` 新增 `DesktopSandbox`（`PassthroughSandbox` 保留给判分检查与测试）；`sandbox-config.ts`（纯函数，从会话文件夹、保护名单、凭据清单与设置拼 srt 配置）；`sandbox-posture.ts`（依赖检查、自检、原因码）；`sandbox-violations.ts`（按行文本分类）。srt 只在这几个文件里 import。
- `apps/desktop/src/main/`：`sandbox-routes.ts`（IPC）；`shutdown.ts`（reset）；`index.ts`（接线，把 `DesktopSandbox` 交给 `chat.ts`）；`chat.ts`（`LoopPorts.sandbox`，ports 在这里拼，chat.ts:337-344）。
- `packages/contracts/src/ipc/sandbox.ts`：路由、事件、config 的 `sandbox` 键。
- renderer：设置弹窗的「权限与网络」一栏、拦截回执的按钮、命令卡上一句、`elevated` 卡的文案。

## 依赖与生命周期

### 依赖

- `apps/desktop` 的 dependencies 加 `@anthropic-ai/sandbox-runtime`，精确钉 `0.0.79`（npm latest；engines `>=22.12.0`，Electron 44 的 Node 24.21 够用；纯 ESM、没有原生模块；srt-0、srt-14、srt-20）。不跟 HEAD：0.0.79 之后的第一个发布会改 askCallback 的语义（srt-m0）；升级走本 spec 的 Revisions 并重跑 §验收标准 10–16。上游只有 LICENSE、没有 NOTICE，NOTICE:9 已列（AGENTS.md:26；2026-10-16 照仓库迁址改写为 `anthropics/sandbox-runtime, formerly anthropic-experimental/sandbox-runtime`，§文档同步）。
- helper（T31）：开发构建里由 `createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json')` 取包目录的真实路径，显式传 `seccomp.applyPath = <包>/vendor/seccomp/<process.arch>/apply-seccomp` 与 `javaAgentJarPath = <包>/vendor/java-proxy-agent/srt-proxy-agent.jar`，不靠 `import.meta.url` 的自动查找（打进 asar 后必然找错，srt-m5）。显式路径的文件不存在时 srt 只记一行调试日志，接着回落到包内、再到全局 npm 里装的别的版本（srt79 dist/sandbox/generate-seccomp-filter.js:144-201，jar 同理 java-proxy-agent.js:53-65），所以 host 在 initialize 之前自己确认两个文件存在：受支持的架构上缺了记 `unavailable`/`other`、详情写缺哪个，不交给 srt 回落；不受支持的架构照 srt 的告警记 `degraded`/`no-seccomp`（T12）。放 asar 外与签名归阶段 7；每版 helper 字节不同，升级要重新随包（srt-5）。
- srt 自己起的进程（macOS 的 `log stream`，Linux 的 socat 桥与 rg 扫描，查找用的 `which`）是包装层内部的，不在 AGENTS.md:22「每个子进程经沙箱包装」的范围里；自检那条命令由 srt 直接包装（§启动 第 5 步）。

### 启动、自检与姿态

主进程 ready、建完窗口之后在后台做，不挡窗口（T4）：

1. win32：不调 initialize，姿态 `unavailable`，原因 `windows`（Q4 A、T32）。非 darwin、非 linux 同理，原因 `unsupported-platform`。Linux 上 srt 导出的 `getWslVersion()` 为 `'1'` 时同样不调，原因 `wsl1`（srt 自己只报 `Unsupported platform`，srt79 dist/sandbox/sandbox-manager.js:785-791）。
2. 准备：确认两个 helper 文件存在（§依赖）；Linux 上用主进程的 PATH 找出 `bwrap`、`socat`、`rg` 的绝对路径，作为 `bwrapPath`、`socatPath`、`ripgrep.command` 交给 srt，执行时就不再按命令环境的 PATH 另找一个；PATH 上找不到的那一项不传，交 srt 自己找、按它的原文映射（第 3 步）；缺 `which` 的发行版上 srt 的查找全部落空（它对绝对路径也用 `which` 找，dist/utils/which.js:15），它报的是 Tenon 传的那个 rg（`ripgrep (<路径>) not found`）时记 `other`，不记 `missing-rg`；从主进程 `process.env` 删掉 `CLAUDE_CODE_TMPDIR`、`CLAUDE_TMPDIR`（srt 拿它们定沙箱里的 `TMPDIR`，srt79 dist/sandbox/sandbox-utils.js:650-652）；按记录清掉上一次留下的挂载点与残留（§afterExit「挂载点与残留的记录」）；把主进程 `process.chdir` 到 `<userData>/sandbox-cwd`（读法 50）。这个只为此用的空目录照 `/tmp/claude` 核对（本用户所有、不是链接、权限 0700，不存在就建），两档都在 denyWrite 里（工作区是主目录或它的上级时它也落在 allowWrite 里，srt 的 denyWrite 压过 allowWrite），chdir 之后不改回，之后每次受限 wrap 前照同样的规则复核（`DesktopSandbox.wrap` 第 2 步）；核对不过或 chdir 抛错，姿态记 `unavailable`/`init-failed`、详情写哪一条没过，不调 initialize。为什么要它：srt 那份强制禁写锚在主进程的 cwd 上，从 Dock 起时 cwd 是 `/`（§档位到 srt 配置）。评测进程不 chdir（从仓库根起，vitest 依赖 cwd；读法 45），所以目标目录是启动函数的一个参数，desktop 主进程传、评测宿主不传；不传时 denyWrite 也不加它。
3. `initialize(会话级配置, undefined, true)`，macOS 与 Linux 都传 `true`：第三个参数同时管 macOS 的日志监听与 Linux 的 seccomp 观测器，传假 Linux 上就没有任何文件违规（sandbox-manager.js:493-536）。不传 askCallback（Q9 A）。initialize 自己带配置跑依赖检查、有 error 就以「Sandbox dependencies not available: …」抛错（:487-491）：按 srt 原文映射到原因码（缺 bwrap、socat、rg，root 缺 CAP_SETFCAP 记 `root-without-setfcap`，srt-9），其余抛错记 `init-failed`——macOS 上例外：先跑一次 `/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`（经 `HostAdapter.process`、argv 固定，同自检不经 `HostSandbox.wrap`），退出码 71 或 stderr 含 `sandbox_apply` 记 `nested-sandbox`，否则照记 `init-failed`。agent 沙箱里 initialize 自己就抛（srt 在主进程的 tmpdir 下 listen 它的 `srt-mux-<pid>-0.sock` 被拒，`listen EPERM`，mux-proxy.js:22），走不到第 5 步的自检（P1）。不在 initialize 之前单独调 `checkDependenciesAsync()`：那时 srt 还没有配置，看不到显式的 helper 路径（:862-873）。
4. initialize 成功后调 `checkDependenciesAsync()` 只取 warning：有就记为部分降级（缺 apply-seccomp 即 `no-seccomp`、bwrap 低于 0.5.0 即 `old-bwrap`，srt-6、srt-8、security-m1）。这一步自己抛错记 `unavailable`/`init-failed`；会话级配置在 initialize 之前就过不了 schema（§档位到 srt 配置）时同样记 `init-failed`、不调 initialize。
5. 自检（读法 4）：在 `sandbox-posture.ts` 里直接调 srt 的 `wrapWithSandboxArgv`（不经 `HostSandbox.wrap`），以 `read-only` 档、cwd 为主目录、命令环境只有 `PATH` 与 `HOME`（不转发主进程的 `process.env`），spawn 一条先往宿主上一个新的临时路径（不在 `/tmp/claude`、`~/.npm/_logs`、`~/.claude/debug` 这几处 srt 默认可写的地方之下）写、写成就以 3 退出、写不成以 0 退出的 `/bin/sh -c` 命令；写那一步放进子 shell（`( echo x > <路径> ) 2>/dev/null`），不用 `: > <路径>`：特殊内建命令的重定向失败会让非交互的 POSIX sh（dash、`bash --posix`）当场退出，沙箱拦下这次写时命令就到不了 `exit 0`（P1 的探针脚本踩过）。10 s 内退出码 0 且宿主上没有那个文件才算过，写成了记 `self-test-failed`（沙箱起来了却不拦）。这次 wrap 照样恰好一次 `cleanupAfterCommand`，wrap 自己抛错时不调。macOS 上退出码 71 或 stderr 含 `sandbox_apply` 记 `nested-sandbox`（agent 沙箱里再起 sandbox-exec 必然失败，platform-1）；Linux 上自检失败、且下一步的读数里任一个表示 userns 受限（`apparmor_restrict_unprivileged_userns` 为 1、`unprivileged_userns_clone` 为 0 或 `max_user_namespaces` 为 0），或 stderr 含 apply-seccomp 的 `nested userns is capability-restricted`，记 `userns-restricted`（P5：24.04 上 sysctl 为 1 时 stderr 是 bwrap 的 `loopback: Failed RTM_NEWADDR`；26.04 自带的 `bwrap-userns-restrict` AppArmor profile 拦下时是 apply-seccomp 那句，sysctl 改成 0 也一样，读数这时看不出来；原文在 srt79 vendor/seccomp/<arch>/apply-seccomp 里）；其余失败记 `self-test-failed`，stderr 前 2 KB 作详情。不做「不带 seccomp 再试」：0.0.79 没有合规的关法，唯一跳过 apply-seccomp 的 `allowAllUnixSockets` 在永不打开的开关里（linux-sandbox-utils.js:2631-2635，T14）。
6. Linux 上自检失败时另读 `/proc/sys/kernel/apparmor_restrict_unprivileged_userns`、`/proc/sys/kernel/unprivileged_userns_clone`、`/proc/sys/user/max_user_namespaces`（自检过了不读），读数进原因详情与修法说明（详情是三行 `<名字>=<值>`，再接 `exited N` 或超时那一句与 stderr 前 2 KB）、并按上一步判 `userns-restricted`，不按发行版号写死，也不替你 sudo（T12、platform-8、platform-9、platform-m2）。`userns-restricted` 的修法是 Claude Code 沙箱文档里的 AppArmor 配置：在 `/etc/apparmor.d/bwrap` 写一个只给 bwrap（写第 2 步找到的那个绝对路径）`userns` 权限、`flags=(unconfined)` 的 profile，再 `systemctl reload apparmor`；它只作用于 bwrap 本身，不及沙箱里的命令。P5 验过：24.04 上 sysctl 为 0 与 1、26.04 原样（1）装了它都是 `active`；只把 sysctl 改 0 在 26.04 上不够（自带的 profile 照拦）。设置页只显示这几条命令，Tenon 不执行。那个绝对路径写在 `userns-restricted` 原因详情的最后一行：`bwrap=<绝对路径>`（第 2 步没找到时为 `bwrap=(none)`），plan 第 13、17 步照它拼修法，姿态结果与 `SandboxView` 不另加字段。

```ts
// packages/kernel/src/host/adapter.ts —— 04 只增（§对 00 的修补）
export interface SandboxPosture {
  readonly state: 'pending' | 'active' | 'degraded' | 'unavailable' // degraded = 生效、部分降级
  readonly profile: 'read-only' | 'workspace-write'                  // 你在「高级」里选的命令档位
}

// packages/contracts/src/ipc/sandbox.ts —— 04 新增
export type SandboxReasonCode =
  | 'windows' | 'unsupported-platform' | 'wsl1' | 'root-without-setfcap'
  | 'missing-bwrap' | 'missing-socat' | 'missing-rg' | 'userns-restricted'
  | 'nested-sandbox' | 'self-test-failed' | 'init-failed' | 'other'               // 以上 → unavailable（other 也随 degraded，见下）
  | 'no-seccomp' | 'old-bwrap'                                                    // 以上 → degraded
  | 'test-seam' // 只来自 e2e 接缝：`off` 时随 unavailable，`fake` 时与 active 同现（§IPC）
```

srt 的依赖检查只给英文句子：host 按已知措辞映射到原因码（措辞取 srt79 的原文、夹具注明文件与行，升级改了措辞单测就红），认不出的记 `other`、原文作详情（§IPC 的 `detail`）。第 4 步的 warning 同样按措辞映射，认不出的也记 `other`、原文作详情，但姿态是 `degraded`：沙箱已经起来，只是某一层可能偏弱；记 `unavailable` 的话，每条命令都会在问过你之后去沙箱外跑，反而更不安全。`pending` 只在启动的几秒里出现：这期间新判定的命令按生效处理（卡上不加那一句）；重新判定（含启动恢复时的，recovery.ts:523）沿用原判决的 `unavailable` 与卡上的 `sandbox` 事实，免得上次不可用时出的卡在恢复时被换成没有那一句的卡（读法 38）。执行时 `wrap` 等初始化做完，最多 15 s，结果是不可用就拒绝（读法 3）：这次调用照今天 wrap 抛错的路收口（`BASH_TEXTS.notStarted`，bash.ts:139-141），下一次判定计划 full-access、卡上带那一句。`SandboxRequest` 没有中止信号（T38 不动它），这 15 s 里点停止要等 wrap 返回才生效，只在启动的几秒里可能出现，接受。

启动交给 `DesktopSandbox` 的是 `SandboxStartupRun = { initialized, outcome }`（`DesktopSandbox.start(run)`）：`initialized` 在 initialize 一返回就 resolve——此后才订阅违规存储、登记信号、`dispose` 才要 reset——没调或抛错时一直不 resolve；`outcome` 带姿态、会话级配置、`reasons` 与 `initialize` 的结果：`not-called`（没调，含 win32、WSL1、helper 缺失、chdir 目录不合格）、`dependency-error`（以「Sandbox dependencies not available」抛错）、`threw`（别的抛错）、`returned`（§退出 的信号处理按它注册）。原因一律带原因码与详情，详情是 srt 原文或读数、不翻译（§IPC）；`SandboxReasonCode` 现在定义在 sandbox-posture.ts，plan 第 8 步移进 contracts。

### 退出

`apps/desktop/src/main/shutdown.ts` 的 before-quit 第 4 步（:255-259，等 Run 与关连接池）之后、第 5 步关 Tape 之前，显式 `await sandbox.dispose()`：调一次 srt 的 `reset()`，最多等 2 s（读法 25；srt 关 socat 桥最长 1.5 s，srt79 dist/sandbox/sandbox-manager.js:1717），抛错只进日志；从没 initialize 过就不调。不靠 srt 自带的 exit 钩子（那里 reset 的异步部分跑不完，srt-15）。srt 装的 SIGINT / SIGTERM 监听会移除 Node 的默认退出（srt-m6）。那两个监听是 `once`、回调就是 `reset()`（sandbox-manager.js:97-110）：第一次信号就拆掉代理与桥，而 srt 的配置还在；Tenon 若不退出，之后的命令会断网且没有违规。P8 实测（最小的 Electron 44 主进程）：initialize 之后发 SIGTERM 或 SIGINT，5 s 内不退出、before-quit 不走、代理已拆，第二次信号才退；没有 srt 时两种信号都经 before-quit 退出。所以 host 在调过 initialize 之后自己注册 `process.on('SIGTERM' | 'SIGINT')` → `app.quit()`（P8 同一脚本加上之后两种信号都在 15 ms 内经 before-quit 退出、reset 走到；T4）。注册的条件看 `initialize` 的结果、不看 `initialized` 有没有 resolve：不是 `not-called`、也不是 `dependency-error` 就注册。srt 在依赖检查（:487-491）之后、起代理之前就装上那两个监听（:542），之后的抛错（P1 在 agent 沙箱里的 `listen EPERM` 就是）发生时监听已在；`threw` 也可能早于它们，多注册一个 `app.quit` 无害（2026-10-16）。host 在信号之后把姿态记 `unavailable`，`reasons()` 返回 `[{ code: 'init-failed', detail: 'reset by a signal' }]`（plan 第 13c、16 步并进 `SandboxView.reasons`），之后的受限 wrap 一律拒绝，`dispose` 对已被信号 reset 过的情况幂等、不再等。

## 包装（wrap）契约

### 三处调用点与档位

- **Bash**：档位取判决里的档位计划（§档位计划写进判决），是产品里唯一会要 `full-access` 以外档位的调用点。
- **MCP stdio**：照旧 `full-access`、`workspace: []`（Q11 A；pool.ts:488、03 验收 9 不改）。
- **shell-env 探测**：改为 `full-access`（T6）。真包装下 srt 会往命令里注入 `SANDBOX_RUNTIME=1`、`TMPDIR=/tmp/claude`、`NO_PROXY` 与带口令的 `HTTPS_PROXY`（srt79 dist/sandbox/sandbox-utils.js:642-686），会被抓进每条 Bash 的基础环境，`TMPDIR` 还会经白名单进 MCP 的环境（03:284）。探测在沙箱外读你的登录 shell 配置，沙箱里的命令改不了它们（denyWrite，§档位到 srt 配置）。
- **评测**：判分检查 `runNode` 保持 `PassthroughSandbox`（T40）；评测宿主里模型发出的命令改用 `DesktopSandbox`（读法 26、45）：每个评测进程 initialize 一次、跑完 dispose，`SandboxPorts` 在 runner 里绑定，姿态写进每条记录；apps/desktop/test/evals-host.test.ts:160 测的是环境不泄漏，经选项照旧用 `PassthroughSandbox`。

### 档位到 srt 配置

会话级配置（initialize 与 updateConfig 时给）：

- `network`：`allowedDomains` = 生效白名单（§网络白名单，空表也写出，security-m2），`deniedDomains: []`，`strictAllowlist: true`，`parentProxy: { noProxy: '*' }`。不写 `deniedResolvedAddresses`：解析地址检查沿用 srt 默认，拒回环、未指定、链路本地、组播、云元数据端点与本机自己的地址，不加私网与 CGNAT（T42；srt79 README.md:361-367）。这个检查对经上游代理出去的连接不做，而 srt 没配 `parentProxy` 时会拿主进程自己的 `HTTP_PROXY` / `HTTPS_PROXY` 当上游（dist/sandbox/parent-proxy.js:46-55，README.md:365），从终端或开着代理的机器上启动就悄悄没了；`noProxy: '*'` 让每个连接都直连、检查照做（parent-proxy.js:143，读法 33）。
- `filesystem`：与下面 read-only 档同形、不带 allowRead（每次 wrap 再整段替换，srt-1、srt-m2）。
- `seccomp.applyPath`、`javaAgentJarPath`（§依赖）；Linux 的 `bwrapPath`、`socatPath`、`ripgrep`（§启动 第 2 步）；`ignoreViolations` 噪声名单（T41；mech:118）——macOS 的日志监听与 Linux 观测器在 initialize 时就拿走它，之后 `updateConfig` 只影响代理那一侧（sandbox-manager.js:493-536），所以名单在 initialize 之前定好。P2 定了 configd 一行，读法 53 再加 DNSConfiguration 一行：`{ '*': ['mach-lookup com.apple.SystemConfiguration.configd', 'mach-lookup com.apple.SystemConfiguration.DNSConfiguration'] }`，只在 macOS 传。configd 那行 macOS 上 curl 每次连接都带，不论连接成败；DNSConfiguration 那行是 P3 里成功的 `npm view` 带的；Linux 上没有噪声行，不传这个键。srt 按子串比，而且对日志监听、Linux 观测器与代理三处来源都用同一个判断（sandbox-violation-store.js:61-87），Linux 上传了会连观测器报的、路径里含这两个子串的写一起滤掉；srt 自己另外恒丢 `mDNSResponder` 与两个日志服务的行（macos-sandbox-utils.js:1196-1199）。被拒操作的行里含这几个子串时（路径由沙箱里的程序定）这次拒绝不留违规，写进已知限制。

每次 wrap 的 `customConfig.filesystem`，由 host 只从这次请求的 `workspace`、本会话的落盘目录、保护名单、凭据清单与设置拼出，不接受模型的任何输入（T5、T13、T33）。所有路径都以 `{ path, literal: true }` 传，allowWrite 与 allowRead 只传真实路径，拒绝条目照下面「链接」一段传（Linux 上 allowWrite / denyWrite 只认字面路径，srt-m7；文件夹名带 `*?[]` 也照字面，srt-10；不存在的路径也挡得住，srt79 README.md:460）：

| 键 | read-only | workspace-write |
|---|---|---|
| `allowWrite` | `[]`（srt 默认可写的 `/tmp/claude`、`~/.npm/_logs`、`~/.claude/debug` 仍可写，security-21、security-m5） | 本次 `workspace` 的每一项；「包管理器」预设打开、且你的档位是 workspace-write 时加预设表里本平台各管理器在 `<userData>/sandbox-cache/` 下的目录（§网络白名单，读法 20、46、49），不加 `~/.npm`、`~/.cargo` 这类你自己的缓存目录 |
| `denyRead` | profile 目录；主目录下 `.ssh`、`.aws`、`.gnupg`（mech:267）；凭据清单；Linux 姿态为 `no-seccomp` 时另加 `$XDG_RUNTIME_DIR`（缺省 `/run/user/<uid>`）、`/var/run/docker.sock`、`/run/docker.sock`、`/tmp/.X11-unix` 与 `SSH_AUTH_SOCK` 所在目录（读法 42） | 同左 |
| `allowRead` | 本会话的 `tool-output/<sessionId>/`（02:2559；由 `beforeWrap` 给出的会话算） | 同左 |
| `denyWrite` | profile 目录；主目录下六个 shell 配置文件（apps/desktop/src/main/workspace.ts:34-41），`ZDOTDIR` 有值时再加它下面的同名文件；denyRead 的全部条目；主目录下沙箱外会自动执行的位置；srt 包目录（读法 34）；`<userData>/sandbox-cwd`（读法 50；只在启动时传了这个目录时加，评测宿主不传、不加） | 同左，再加 `workspace` 里每个目录之下的 `.zshrc`、`.zshenv`、`.zprofile`、`.bashrc`、`.bash_profile`、`.profile`、`.claude/settings.json`、`.claude/settings.local.json`、`.envrc`、`.codex`、`.gemini`、`.cursor`、`.aws`（security-m3、security-13、security-14、hosts-2），以及 srt 的强制禁写名单：`.gitconfig`、`.gitmodules`、`.ripgreprc`、`.mcp.json`、`.vscode`、`.idea`、`.claude/commands`、`.claude/agents`、`.git/hooks`、`.git/config`（srt79 dist/sandbox/sandbox-utils.js:10-37；Linux 上 `.git/` 两项只在这个根下 `.git` 是目录时加，否则挂载点会弄坏 `git init`，linux-sandbox-utils.js:186-205） |

**链接**（2026-10-15 补，同日第二次审查后改；2026-10-16 改为一路解析到底，见 Revisions）：上表的拒绝条目（denyRead、denyWrite）由 host 以 literal 传，每条两样都进它自己的表：写下的拼法（不解链接），与 host 照内核的顺序逐级解出的真实位置——从 `/` 起逐级 lstat，遇到链接就 readlink，把目标接在剩下的部分前面（相对目标按链接所在目录的真实路径解），悬空的链接也照它的目标往下解（同 srt79 的 `resolveSymlinkedDenyPath`），从第一级不存在的起照写下的接上其余部分；最多 40 跳（srt79 的 `MAX_SYMLINK_RESOLUTION_DEPTH`，即内核的 ELOOP），成环或超限时真实位置退回「最深一级已存在的祖先的真实路径再接上其余部分」，已走过的链接照收，照常运行。解析时经过的每个链接（包括链接目标里的，记在「链接所在目录的真实路径加名字」上）：macOS 上本身放进 denyWrite（防删、改名与替换），不放进 denyRead；Linux 上不传，只进事后的 lstat 比对（下文）。只有一个例外，只在 macOS：条目本身就是链接、而且解得开时，写下的拼法只进 denyWrite、不进 denyRead，denyRead 里只有真实位置——写下的拼法进了 denyRead，Seatbelt 在路径解析经过它时就拒，经它写凭据也被报成对链接本身的读（`file-read-metadata <链接>`），不带 `protected`，回执反倒给了重跑按钮（第 6 步审查 r3）；不进时被拒在真实位置，读写照 §afterExit 的表分类，回执上写的是真实位置（如 `~/dotfiles/aws/config`）。allowWrite 只传真实路径（照旧用 realpath，不跟悬空链接）。为什么要两样：srt 0.0.79 对 `literal` 条目也调 `fs.realpathSync`，但只在解出的位置落在写下路径自己的子树里、或只差 macOS 的 `/private` 前缀时才换成它，链接指向别处（dotfiles 这类常见情形）时保留写下的拼法（`isSymlinkOutsideBoundary`，srt79 dist/sandbox/sandbox-utils.js:216-282、:465-480；linux-sandbox-utils.js:2034-2041 的注释写明了这一点，Linux 上它在挂载之前自己再解一次）。只传写下的拼法时，拒绝条目经过链接（比如 `~/.aws` 本身是指向 dotfiles 仓库的链接），命令能按真实位置读写它：Claude Code 2.1.299（2026-10-14）修过 macOS 上的这个缺陷（[changelog](https://code.claude.com/docs/en/changelog)），0.0.79 照上面的写法同样有，所以 host 自己传真实路径，第 6 步核。为什么链接本身要另传、又只进 macOS 的 denyWrite：只传那两样时链接本身不受保护——保护名字或拒绝条目在 wrap 时是链接（工作区根的 `.envrc`、`.claude` 指向别处，工作区是主目录时 `~/.ssh`、`~/.aws` 指向 dotfiles 仓库），链接所在的目录可写，沙箱里的命令就能先 `rm` 或 `mv` 掉链接、再在原名字上写一个普通文件，之后在沙箱外被执行（direnv、hook、`ProxyCommand`、`credential_process`）；macOS 上 srt 保留链接本身的拼法、照写成规则，预计挡得住删、改名与替换。但链接本身进 denyRead 会多拦：上级目录是链接时（`~/.config` 指向 `~/dotfiles/config`），macOS 上对它的读拒绝可能挡住经过它的路径解析；Linux 上 bwrap 挂不到链接上（`mount(2)` 会跟到目标），srt 又会先把它解开，传链接本身等于把整个目标目录挡成不可读或只读（`~/.config/git` 这类都读不到），链接本身照样护不住，所以 Linux 上一律不传。srt 侧：0.0.79 之后 main 上合并了 [#680](https://github.com/anthropics/sandbox-runtime/pull/680)（2026-10-10；macOS 上每条读拒绝都按写下的拼法与解开链接后的位置各写一份，凭据类拒绝另行携带、排在 allow 规则之后）与 [#689](https://github.com/anthropics/sandbox-runtime/pull/689)（2026-10-14；统一取真实路径的办法）；处理「拒绝路径上的链接被删掉、改名或换掉」的 [#693](https://github.com/anthropics/sandbox-runtime/pull/693) 还没合并——它在 macOS 上给每个链接加一条 literal 规则，并写明 Linux 上 bwrap 挂不到链接上，要靠 seccomp helper 新加的 `--hold-link`。这些都没进发布版（2026-10-15 查；仓库已从 `anthropic-experimental/` 迁到 `anthropics/`，0.0.79 的 package.json 里 repository 写的是后者）。所以 Linux 上 host 在每次受限 wrap 之前记下这些链接节点的 lstat（类型与目标），`afterExit` 时比对，变了就加一条 `kind: 'fs'`、`target` 为那个链接的路径、带 `protected` 的违规（行文本由 host 写，固定为 `link changed during the command: <路径>`），这件事只能事后发现，写进已知限制。第 6 步实测：macOS 上 denyWrite 里的链接本身挡得住删除与替换，Linux 挡不住，所以照上面做，没改。验收 11 在两个平台核：拒绝条目经过链接时，按链接的拼法与按真实位置读、写都被拒；凭据文件的上级目录是链接时，同一目录下不在清单里的文件仍读得到，工作区内（含经那个链接目录）照常可写；保护名字本身是链接时，删掉或换掉它被拒（macOS），或调用结束后有那条带 `protected` 的违规（Linux）；拒绝条目是悬空链接时，沙箱里建不出它指向的位置；链接目标里还有一层链接时，那一层同样护住（macOS）或事后报出（Linux）。升级 srt 时重看这几处（§依赖）。

srt 自己的强制禁写不作数：它锚在跑 srt 的进程自己的 `process.cwd()`，wrap 传的 cwd 在 macOS / Linux 不用（macos-sandbox-utils.js:21-46，linux-sandbox-utils.js:177-208、:266，sandbox-manager.js:1534-1537），Tenon 主进程的 cwd 是启动目录、不是工作区，所以上表按每个根自己加。srt 那份照样生效，只是不一定落在工作区上：从 Dock 启动时 cwd 是 `/`，macOS 上它就成了 `/**/.git/hooks/**`、`/**/.vscode/**`、`/**/.gitconfig` 这类，盖住整个磁盘——沙箱里在 `/tmp/claude` 下 `git init` 失败，主进程 cwd 为空目录时成功（P1；Linux 上同一个用例两种 cwd 都成功）。所以 host 在 initialize 之前把主进程 chdir 到空目录 `<userData>/sandbox-cwd`（§启动 第 2 步，读法 50），srt 那份从此只落在这个空目录下，不随启动方式变。Linux 上它每次 wrap 还从主进程的 cwd 起跑一次 rg 扫描（四层、不认 ignore 文件、最长 10 s，linux-sandbox-utils.js:265-330）：P2 量得 cwd 为 `/` 或一个六万文件的主目录时比空目录只多 11 ms 以内；chdir 之后 cwd 就是空目录。子目录里的同名项：macOS 另传 `<根>/**/<名字>` 这类 glob（根路径含 `*?[]` 时不传），Linux 写规则不收 glob，写进已知限制。大小写变体不另传 glob：P1 在不分大小写的 APFS 上写还不存在的 `.ENVRC`、`.Envrc`、`.Claude/settings.json`、`.Mcp.json`、`.ZSHRC`、`.Git/hooks/x` 都被拒（security-4 担心的绕法不成立）。凭据清单（Q20 B，P3 在两个平台逐个实测后定稿）：两个平台都有 `~/.config/gh`、`~/.npmrc`、`~/.docker/config.json`、`~/.kube/config`、`~/.git-credentials` 与读法 22 的 `~/.netrc`、`~/.pypirc`、`~/.cargo/credentials.toml`；gcloud 在 Linux 上拒整个 `~/.config/gcloud`，在 macOS 上只拒其中的 `credentials.db`、`access_tokens.db`、`application_default_credentials.json` 与 `legacy_credentials`（macOS 上读被拒报 EPERM，拒整个目录连 `gcloud --version` 都起不来；Linux 上 srt 拿空的 tmpfs 盖住、读到的是空目录，照常，linux-sandbox-utils.js:1408-1415）；浏览器配置目录——macOS `~/Library/Application Support/` 下的 `Google/Chrome`、`Chromium`、`Microsoft Edge`、`BraveSoftware`、`Arc`、`Firefox` 与 `~/Library/Safari`、`~/Library/Cookies`，Linux `~/.config/google-chrome`、`~/.config/chromium`、`~/.config/microsoft-edge`、`~/.config/BraveSoftware`、`~/.mozilla`、`~/snap/firefox`、`~/snap/chromium`。2026-10-15 另加几项明显是凭据的（Tenon 自己的选择，与读法 22 同类，没经 P3；原不在 owner 当天的决定里，之后 owner 经问卷确认收下，开放问题 6），两个平台都加，位置取各工具公开文档写的缺省值：整个 `~/.kube`（替换原来的 `~/.kube/config`：kubeconfig 缺省是 `~/.kube/config`，[Kubernetes 文档](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/)；kubectl 的缓存缺省在 `~/.kube/cache`，[kubectl 参考](https://kubernetes.io/docs/reference/kubectl/kubectl/)；OIDC 插件 kubelogin 把令牌缓存在 `~/.kube/cache/oidc-login`，[kubelogin 文档](https://github.com/int128/kubelogin/blob/master/docs/usage.md)）、`~/.config/op`（1Password CLI 的配置目录之一，[文档](https://www.1password.dev/cli/config-directories/)）、`~/.vault-token`（Vault 缺省的 token helper 存令牌的文件，[文档](https://developer.hashicorp.com/vault/docs/commands/token-helper)）、`~/.pgpass`（PostgreSQL 的密码文件，[文档](https://www.postgresql.org/docs/current/libpq-pgpass.html)）、Hugging Face 的 `~/.cache/huggingface/token` 与 `~/.cache/huggingface/stored_tokens`（`HF_HOME` 缺省时 `hf auth login` 存令牌的两处，[环境变量文档](https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables)、[CLI 文档](https://huggingface.co/docs/huggingface_hub/guides/cli)）；plan 第 6 步照 P3 的规则实测（装得上的 `kubectl version --client`、`op --version`、`vault version`、`psql --version`、`hf env`），不需要登录的命令坏了就改拒其中的凭据文件，仍坏就照留、写进已知限制。`~/.config/gh` 在 macOS 上让 `gh --version` 也起不来，只拒其中的 `hosts.yml` 一样，照 P3 的规则照留、写进已知限制。读法 34 的位置 P3 核过：两个平台上会执行的 shell 配置都在名单里，git 两处配置都读；`.bash_aliases` 普通 shell 不读，照留（只收紧）。

交给 srt 的配置只含上面列的键（读法 43）：`network` 的 `allowedDomains`、`deniedDomains`、`strictAllowlist`、`parentProxy`，`filesystem` 的四个表，`ignoreViolations`、`seccomp.applyPath`、`javaAgentJarPath`、`bwrapPath`、`socatPath`、`ripgrep`；拼出的每份都过 srt 导出的 `SandboxRuntimeConfigSchema`（每次 wrap 的 `filesystem` 并进会话级配置再校验，schema 要求 `network` 与 `filesystem` 都在；srt 的 initialize、updateConfig、wrap 都不校验程序传入的配置，只有它的 CLI 校验，utils/config-loader.js:13、:57），不过就拒绝这次 wrap。于是 T14 的永不打开的开关（`allowAppleEvents`、`enableWeakerNetworkIsolation`、经 `allowUnixSockets` 放 docker.sock、`tlsTerminate`）连同 `enableWeakerNestedSandbox`、`allowUnixSockets` / `allowAllUnixSockets`（一个 Unix socket 都不放）、`allowLocalBinding`（读法 21）、`allowMachLookup`、`allowPty`、`allowGitConfig`、`filesystem.disabled`、`mitmProxy`、`filterRequest`、`credentials`（环境变量由 Tenon 自己拼，T6）、`httpProxyPort` / `socksProxyPort`、`git` 都不出现。4a 没有任何放宽项的入口，以后有也只读用户级配置、不读工作区里的文件（security-m6）。

### argv、shell、env 与 id

- **命令串**（T7）：srt 收命令串加 shell、不收 argv（srt79 dist/sandbox/sandbox-manager.d.ts:76）。host 把 `request.argv` 逐个单引号转义后以空格拼成命令串，`binShell` 取 `argv[0]`。受限档要求 `argv[0]` 是名字为 zsh、bash 或 sh 的绝对路径，否则抛 `SandboxUnavailableError`（拒绝、不直通，同读法 3；Bash 恒满足，02:1930；读法 5）——srt 会用主进程的 PATH 再查一次 shell（srt79 dist/sandbox/macos-sandbox-utils.js:1106-1107），从 Dock 启动时 PATH 很短，只有绝对路径可靠。
- **env**（T6）：返回 `{ argv: srt 给的 argv, env: { ...request.env } }`。例外只有三类。①「包管理器」预设生效时（预设打开、你的档位是 workspace-write；开放问题 5 A，读法 47），预设表（§网络白名单）里本平台每个管理器的那组变量（多为一个），每个变量：先删掉 env 里与它不分大小写同名的键，再加上指向它那个目录或其下子目录的值——npm 按不分大小写读 `npm_config_*`，两种拼法同在时谁生效看顺序（npm 10.9.4 的 `@npmcli/config` lib/index.js:332-346，起草时本机核对），其余变量照同一规矩删，无害；`npm_config_cache` 压过工作区与主目录的 `.npmrc`，`npx`、`_cacache` 与 npm 的日志（缺省在 `<缓存>/_logs`）都落进这个目录（P4 两平台核实）。② macOS 上每次受限 wrap 加 `TENON_SANDBOX_MARK=<这次交给 srt 的 id>`，调用结束时按它找留在后台的进程（§执行与收口，P6）。③ macOS 上每次受限 wrap 加 `OS_ACTIVITY_MODE=disable`，照 ① 先删掉不分大小写同名的键（owner 2026-10-16 选 B）：srt 开着 `log stream` 时，沙箱里每个写自己系统日志的程序一起来就被拒 `mach-lookup com.apple.diagnosticd`，这一行常与它的真拒绝同一毫秒到达、排在前面，srt 一见它就把整块连真拒绝一起扔掉（§afterExit 表后一段）；这个苹果的变量让程序不写自己的系统日志，也就不去连那个服务。代价：沙箱里的命令不往系统日志（Console.app）写自己的调试信息，打到屏幕上的输出预计不变（2026-10-15 在 agent 沙箱里用 `defaults` 试过一次，没经过 srt，plan 第 6 步的 S 再核）；清空环境变量的子进程、自己删掉这个变量的命令照旧会丢（§已知限制）。`full-access` 三样都不加。srt 返回的 env 在 macOS / Linux 上就是主进程的 `process.env`（srt79 dist/sandbox/sandbox-manager.js:1638），开发构建里已读进 `.env.local`，绝不转发。主进程自己的 `ELECTRON_RUN_AS_NODE`（开发与 agent 的环境里常有，会让沙箱里每个基于 Electron 的 CLI 变成裸 node）也只会从这里进来：Bash 的 `request.env` 是 shell-env 算出的基础环境，`ELECTRON_*` 与 `TENON_*` 已在那里去掉（apps/desktop/src/main/host/shell-env.ts:39、:97-107），评测宿主给的只有 `PATH`、`HOME`、`TMPDIR`、`LANG`（apps/desktop/evals/host.ts:99-111）；验收 6、25 各核一半（2026-10-15 补）。srt 自己要的变量都在它给的 argv 里（macOS 经 `env`，Linux 经 bwrap 的 `--setenv`）。其中两类的值取自主进程的 `process.env` 而不是 `request.env`：`JAVA_TOOL_OPTIONS`（srt 以主进程的这个值为底、接上 javaagent 与 IPv4 的参数，盖住 `request.env` 里的同名值，macos-sandbox-utils.js:1080-1088、linux-sandbox-utils.js:2733-2740；这个值来自你启动 Tenon 时的环境、不是模型给的，通常与 `request.env` 里的一样；Tenon 不从主进程的环境里删它，那会连带影响主进程起的别的子进程，如 MCP 连接器；§已知限制）与决定 `TMPDIR` 的 `CLAUDE_CODE_TMPDIR` / `CLAUDE_TMPDIR`（后两个在 §启动 第 2 步已删）。
- **id**（T8）：交给 srt 的 `commandId` = tool-use id 按 UTF-8 在码点边界上截到 67 字节 + `.` + 32 位十六进制随机数，总长不超过 100 字节（读法 6；srt 经代理用户名与 Linux 观测 socket 送 id 时最多 251 字节，超长就丢掉归属，srt79 sandbox-utils.js:938-971、linux-violation-monitor.js:106-109，按字符截的话 67 个汉字会到 312 字节；srt 按前 100 个字符比 id，重复会继承旧违规，srt79 dist/sandbox/sandbox-manager.d.ts:31-34；HEAD 的按命令白名单要求 128 位随机，srt-m1）。映射只在 host 里，`SandboxRequest.commandId` 照旧 = tool-use id（00:118、02:1920）。

`DesktopSandbox.wrap(request)`：

1. `full-access`：原样返回 argv 与 env 的拷贝，不碰 srt、不打日志（00:161）。
2. 受限档：等初始化（最多 15 s）；姿态是 `unavailable` 或等不到 → 抛 `SandboxUnavailableError`，不直通（读法 3）。再确认 `/tmp/claude`（macOS 上即 `/private/tmp/claude`）是本用户所有、不是链接、权限 0700 的目录，不存在就建。srt 给每条受限命令设 `TMPDIR=/tmp/claude` 却从不建它，Linux 上不存在的可写路径直接跳过，`/tmp` 又是只读绑定（sandbox-utils.js:645-653，linux-sandbox-utils.js:1779-1781）；它也可能是同机别的用户先建的。启动时 chdir 过的（§启动 第 2 步），`<userData>/sandbox-cwd` 照同样的条件复核（不存在也不建，算不满足）：它在 denyWrite 里，沙箱里的命令改不了，但经你批准的 full-access 命令能删掉它或换成链接，而主进程缓存的 cwd 仍是原来的路径，srt 那份强制禁写会落到哪里就说不准（读法 50）。预设生效时（上节 allowWrite 一格），预设表里本平台的每个缓存目录照同样的条件核对、不存在就建（读法 48：P4 在 macOS 上从沙箱里把这个可写目录换成了同名的链接，Linux 上换不了）。不满足就抛 `SandboxUnavailableError`、日志写原因（读法 41）。
3. 拼命令串与配置，过 schema（上节），Linux 上把这次将被造成挂载点的路径（中间目录与叶子）记进记录、记下解析拒绝条目时经过的链接的 lstat（§afterExit「挂载点与残留的记录」、「链接」），调 `wrapWithSandboxArgv(命令串, argv[0], { filesystem }, undefined, request.cwd, { commandId: srt 的 id })`，按 `request.commandId` 记下这次 wrap 与它所属的会话（`beforeWrap` 给的），返回上面那一对。

### afterExit、清理与违规

- **违规的去处**：srt 的违规存储是整个进程一份、只留最近 100 条（dist/sandbox/sandbox-violation-store.js:9、:22-24），Linux 观测器又把工作区里每次正常写都报上来（它的可写表取自 initialize 时的空表，sandbox-manager.js:497-536），一条 `npm install` 就能把同一命令里真正的拒绝挤掉。所以 host 在 initialize 之后 `getSandboxViolationStore().subscribe()`，按 `getTotalCount()` 的增量把每条新事件当场按 srt 的 id 搬进这次 wrap 自己的缓冲、当场分类，观测器报的、按真实落点落在这次可写范围里的当场丢掉（读法 11、39），报的 `mkdirat`（x64 上还有老式 `mkdir`）目标在事件到达时已是存在的目录的也当场丢掉（那次调用什么也没做成，读法 53）。每次 wrap 至多留 200 条，保护名单的排在前面、全部保留，多的只在日志里记条数（`SandboxOutcome.more` 只数交回 kernel 的）。
- `afterExit(commandId)`：对这个 id 下每次没收尾的 wrap 恰好调一次 `cleanupAfterCommand()`（少调 Linux 挂载点空文件攒着，多调会让仍在跑的 bwrap 的 deny 失效，srt-4、srt-m3；T9）；macOS 上按 `TENON_SANDBOX_MARK` 杀这次 wrap 留下的进程与它们各自的进程组（§执行与收口）；两个平台都先等 `VIOLATION_SETTLE_MS`，再结算这次 wrap 的缓冲；之后来的只进日志（读法 9）。`VIOLATION_SETTLE_MS` 暂定 50 ms：P2 在本机 macOS 与两台 Linux 虚拟机上，被拒的写与连接各 50 次，违规都在进程退出之前就进了 srt 的存储（p99 ≤ 0 ms），按规则取最小的一档；CI 的 macOS runner 那次随第四段，取两者较大者定稿。
- kernel 在 wrap 成功而没起进程（spawn 抛错、wrap 之后被停止）时同样调一次 `afterExit`（读法 7）。
- **挂载点与残留的记录**（P7、T9）：Linux 上主进程被 SIGKILL 之后，工作区根下 srt 造的挂载点都留着：不存在的保护名字各一个大小 0、权限 0444 的空文件（`.envrc`、`.mcp.json`、`.vscode`、`.idea` 等，P7 是 17 个），中间一级不存在时是一个空目录（如 `.claude/`）。空的只读文件 srt 只在下一次拒同一路径的 wrap 里认出、收掉（linux-sandbox-utils.js:418-428、:2087-2106），那个工作区不再跑受限命令就一直留在仓库里（IDE 建不出 `.vscode/`、`.idea/`，`git add -A` 还可能把它们提交上去）；空目录 srt 认不出。另有 srt 起的 socat 桥（`socat UNIX-LISTEN:<tmpdir>/claude-http-<十六进制>.sock,…`，linux-sandbox-utils.js:1075）成了孤儿进程，主进程的 tmpdir 下留着 `claude-http-*.sock`、`srt-mux-<pid>-*.sock`、`srt-obs-*`、`claude-empty-*`（同文件 :400，mux-proxy.js:22，linux-violation-monitor.js:34；P7 每轮一个 socat 加这四个条目，跑了两轮：runRoot、vmLocal）。所以 host 维护 `<profile>/sandbox/stubs.json`：Linux 上每次 wrap 之前，对这次 denyWrite 里此刻不存在、第一个不存在的一级的上级在这次 allowWrite 里的条目，记下那一级——是中间目录的记进 `mountPoints`（会被造成空目录），是条目本身的记进 `leafMountPoints`（会被造成空的只读文件）；`afterExit` 之后，这次的条目里在宿主上已经不存在的从记录里删掉：srt 有别的 wrap 在跑时会推迟删，碰到非空目录会跳过（linux-sandbox-utils.js:755-760、:797-833），这些留到下次启动再清。initialize 之后记下 srt 起的 socat 的 pid 与命令行、tmpdir 里新出现的 `claude-http-*`、`srt-mux-<主进程 pid>-*`、`srt-obs-*` 与主进程的 pid（macOS 上只有 tmpdir 条目，SIGKILL 后留什么没测）；名字里没有 pid 的两类只收确是这次的：`claude-http-*` 要有记下的 socat 在它上面监听，`srt-obs-*` 要它里面的 `s*.sock` 出现在 `/proc/net/unix`、且那个 inode 也在主进程的 `/proc/self/fd` 里（观测器的 socket 由主进程监听）。`claude-empty-*` 不记：srt 在 wrap 时才建它（:2161），initialize 期间冒出来的只会是别的 srt 使用者的（已知限制）。记录的形状是 `{ mountPoints: { <srt id>: [路径] }, leafMountPoints: { <srt id>: [路径] }, pid, socat: [{ pid, command }], tmpEntries: [路径] }`，别的键原样保留；这个文件以你身份运行的任何进程都能改，而它点名的东西会被整个删掉，所以读的时候 `tmpEntries` 只收主进程 tmpdir 下 srt 那三类名字。下次启动、initialize 之前（§启动 第 2 步），一律要记下的主进程已不在：记下的 socat 在 pid 与命令行一字不差（socket 名里有 16 位随机十六进制）、父进程不是记下的主进程时 SIGKILL（孤儿的父进程可能是 1，也可能是桌面会话里 `systemd --user` 这类 subreaper），记下的 tmpdir 条目删掉；挂载点另要进程表里此刻没有在跑的 bwrap（命令行以 `bwrap` 起头或含 `/bwrap`，不论是谁的；读不到进程表也当有），这时 `mountPoints` 里仍是空目录的、`leafMountPoints` 里仍满足 srt 那四个条件的删掉（普通文件、大小 0、没有写位、nlink 为 1；不满足的一律不碰）。宿主上删掉别的 bwrap 正当挂载点用的路径，那个沙箱里的绑定会脱落、拒绝随之失效（linux-sandbox-utils.js:755-768）：可能是 Tenon 自己还在跑的那次（同一个 profile 能起两个 Tenon，00 的单实例锁还是占位），也可能是别的 srt 使用者（Claude Code 的 srt 会把留下的空只读文件收作自己的挂载点，:2087-2106）。没删的挂载点留在记录里（键 `earlier-runs`）、下次启动再看，记录的其余部分清空。（2026-10-16 审查后改，lead 定：原写空目录不等记录者、也不看别的 bwrap，然后整份清空。）只动记录里的东西：Linux 的 tmpdir 多半是全机共用的 `/tmp`，同机别的 srt 使用者（如 Claude Code）的条目不碰。
- `violations(commandId)`：返回结算好的分类结果（保护名单的在前）并清掉。分类由 host 按行文本做（srt 的事件只有 `line`、`command`、`encodedCommand`、`timestamp`，srt79 dist/sandbox/macos-sandbox-utils.d.ts:73-78；T10），只认整行严格匹配的写法，认不出的不给任何放行（读法 44）：

| 行 | `kind` | `target` | `release` | 另 |
|---|---|---|---|---|
| 代理拒绝 `deny network-outbound <host>:<port> (<原因>)`（sandbox-manager.js:170-172） | network | 主机名，去端口与方括号，照 WHATWG URL 规范化（小写、去末尾点，数字写法认作 IP）；srt `isValidHost` 字符集（字母、数字、`.`、`_`、`-`，parent-proxy.js:369-381）以外的主机名不给（回执归入「没有记下对象」那一句：这种名字只能来自带括号的 HTTP CONNECT 或伪造的观测器行，原样显示等于让命令往回执与模型输入里塞文字） | 原因恰为 `host is not on the allow list`、主机名是域名且不是 `localhost` 或 `*.localhost`、srt 的 allowedDomains schema 收得下（至少一个点、不以点开头或结尾，sandbox-config.js:20-56；Tenon 另拒空 label，`db`、`com`、`a..example.com` 给了也写不进白名单）→ `domain`；IP 字面量（P1：`1.1.1.1`、`127.0.0.1` 也是这个原因）、以 `resolved to ` 开头的（如 `resolved to a loopback address`，resolved-address-guard.js:203）、`malformed host`、`host is on the deny list` 都不给（读法 18） | — |
| Seatbelt 的出网拒绝 `<进程名>(<pid>) deny(1) network-outbound`，后面或接 ` remote:*:<端口>`、或什么都不接 | network | 无（行里没有地址，P1、P2） | 无 | 不经代理的直连；`observed`（读法 53） |
| Seatbelt 的写拒绝 `<进程名>(<pid>) deny(1) file-write-<操作> <路径>` | fs | 绝对路径 | 照读法 35 的条件 → `path` | 落在 denyWrite 任一项 → `protected` |
| Seatbelt 的读拒绝 `<进程名>(<pid>) deny(1) file-read-<操作> <路径>` | fs | 绝对路径 | 无 | 落在 profile 目录 → `protected`；落在 `.ssh`、`.aws`、`.gnupg` 与凭据清单的不带 `protected`（读法 36，开放问题 3） |
| Linux seccomp 观测器 `deny <系统调用> <路径>` | fs | 写落到的真实位置（读法 11；解不出时为写下的路径；到了 `/proc`、`/dev` 之下不再往下解） | 无 | `observed`；写下的路径或真实位置落在 denyWrite 任一项也带 `protected`（路径可伪造，伪造只会让按钮消失）；两样都不碰 denyWrite、真实位置又在可写处（allowWrite 与 srt 自带的可写处）的丢掉（读法 11）；`mkdirat`（x64 上还有老式 `mkdir`）的目标在到达时已是目录的丢掉（读法 53） |
| 认得出格式、操作在这份封闭清单里的：`mach-lookup`、`sysctl-read`、`network-bind` | fs | 无 | 无 | 读法 32；`observed`（读法 53） |
| 认得出格式、操作不在上面清单里的（`appleevent-send`、`process-exec*`、`signal`、`iokit-open` 等），与认不出的行 | fs | 无 | 无 | 读法 32、44；不带 `observed`：照旧让来源记 `sandbox`、计入上限（读法 53，开放问题 8） |

Seatbelt 的行都带 `<进程名>(<pid>) ` 前缀（srt 取日志里 `Sandbox:` 之后的全部，macos-sandbox-utils.js:1158、:1176；P1 抓到的每条都是）；进程名不含括号，含括号的、以 `deny ` 开头的整行都按认不出处理（进程名由沙箱里的程序定；`deny ` 开头的行也可能是 Linux 观测器伪造的 `deny x(1) deny(1) file-write-create /…`，分类不带平台、分不出来；代价同括号那种，越出沙箱仍要过 `elevated` 卡，读法 15）。`deny http-request` 只在 `filterRequest` 拒绝时才有（sandbox-manager.js:384-386），Tenon 不开它，不认。Linux 上只有两种来源：代理的网络拒绝与观测器的写意图；读被拒、不经代理的直连都不留违规（linux-violation-monitor.js:12-20，README.md:856），见已知限制与开放问题 4；GNU `mkdir -p <绝对路径>` 对已存在的祖先目录报 `deny mkdirat`（x64 上 glibc 走老式的 `mkdir` 系统调用，报 `deny mkdir`）：24.04 上每一级已存在的祖先都报，26.04 上报最深一级；都在到达时当场丢掉（读法 53）。x64 版 apply-seccomp 还监视别的老式调用（`creat`、`truncate`、`unlink`、`rename` 等，arm64 版只有 `*at` 形式），照常报，调用名只用来定最后一级跟不跟链接（读法 11）：x64 多报的 `truncate` 是真的写尝试；x64 的 S 在 plan 第 21 步 PR 的临时 job 上跑。被拒的 Unix socket 连接两个平台都不留行（P1：macOS 三次都没有；Linux 由 seccomp 拒 `socket(AF_UNIX)`，观测器只报写）。macOS 的日志监听一个输出块只看第一条拒绝行（macos-sandbox-utils.js:1168-1172），这一行是 srt 恒丢的噪声（`mDNSResponder`、`diagnosticd`、`analyticsd`）或命中 `ignoreViolations` 时整块扔掉（:1195-1204），块里后面的真拒绝一起丢。沙箱里每个写自己系统日志的程序起来时都被拒一次 `mach-lookup com.apple.diagnosticd`，常与它的真拒绝同一毫秒到达、排在前面：第 6 步审查时每条命令被拒一次写，同一台 Mac 上三轮 300 次丢 61 次（单轮 11%–40%）。所以 macOS 的受限命令加 `OS_ACTIVITY_MODE=disable`（§argv、shell、env 与 id ③，owner 2026-10-16），加了之后 60 次全到。它管不到两种，照旧会丢（§已知限制）：不经代理的直连被拒，打头的是 curl 的 configd 那行（P2：50 次丢 5 次，进了 `ignoreViolations` 也照样占掉这一块）；同一块里有两条真拒绝时只记第一条（从上面那段 srt 代码推出，没实测）。P1 里一次读 `.ssh` 被拒没留行，是加这个变量之前的那一种，不是「第二条」：块里只有这一条真拒绝，按 srt 的读法只能是打头那行被当噪声扔掉（2026-10-16 更正）。成功的命令也可能带行（macOS 上 `npm install` 的不带地址的出网行、`git ls-remote` 的 `com.apple.authd` 那行等）：清单里的无对象行（不带地址的出网行，与 `mach-lookup`、`sysctl-read`、`network-bind`）带 `observed`，照样进模型的违规块与回执，但不让来源变 `sandbox`、不计数；清单以外的操作（`appleevent-send`、`process-exec*`、`signal`、`iokit-open` 这类，多是试探能不能出沙箱）与认不出的行不带，照旧计数——进程名由沙箱里的程序定，改个带括号的名字就能让整行认不出，不能让它借此退出连拦上限。这两处是审查后对 owner 选的 53 B 的收紧，owner 2026-10-15 经问卷确认取收紧后的写（开放问题 8，读法 53）。P1–P3 在两个平台抓到的原文行进 desktop 单测的夹具。

## Bash 的变化

### 档位计划写进判决

判定一次 Bash 调用时（含重新判定），kernel 读 `host.sandbox.posture?.()`（没有就按 `{ state: 'active', profile: 'workspace-write' }`）和本会话还没绑定的一次性放行（§拦截回执与放行），算出档位计划，写进 `tool/permission_decided`：

```ts
// packages/kernel/src/tape/entry.ts —— 04 只增（§对 02 的修补 3）
export interface SandboxPlan {
  readonly profile: 'read-only' | 'workspace-write' | 'full-access' // 交给 wrap 的档位
  readonly chosen: 'read-only' | 'workspace-write'                   // 判定时你在「高级」里选的档位
  readonly unavailable?: true                                        // 判定时沙箱不可用
  readonly override?: { readonly key: string; readonly action: 'allow-path' | 'rerun-unsandboxed'; readonly path?: AbsolutePath }
}
```

取第一条成立的：

1. 绑定了「在沙箱外重跑」：`profile: 'full-access'`，主原因 `elevated`（T17；facts `command`）。
2. 姿态 `unavailable`：`profile: 'full-access'`、`unavailable: true`；命令卡（主原因 `command`）的 facts 只增可选键 `sandbox: 'unavailable'`，卡上加一句「沙箱不可用，将以你的权限运行」（Q6 A；facts 原本就收额外的键，packages/contracts/src/ipc/confirm.ts:82）。这时不绑定路径放行。
3. 绑定了「仅此路径」：`profile: 'workspace-write'`。
4. 其余：`profile` = 姿态里的档位。

判定只看工具与参数的规则不变：可逆性照命令模式表（02:2265），第 4 层照旧；手动档照 E4 每条都问或按本会话命令授权放行（02:2281）。只加一条：本会话命令授权只覆盖不比给出它的那张卡更宽的计划——计划为 `full-access`（第 1、2 条）时，在沙箱档的卡上给的授权不免卡（02:2108「范围以卡或弹窗上写明的为限」；读法 37）；第 1 条的卡任何授权都免不掉（读法 15、不变量 18）；`elevated` 卡上的「允许」只放行这一次、不生成会话授权（同 D7）。执行器按这次派发所依据的判决（`dispatch_committed.decisionKey`）取计划，拼 `SandboxRequest`：`profile` = 计划的档位；`workspace` = `chosen` 为 read-only 而 `profile` 为 workspace-write（只读档下的路径放行）时只有那个路径，否则为本会话此刻的文件夹，路径放行再加上那个路径（读法 12、16）。重新判定沿用原判决绑定的放行，其余重算。

### 执行与收口

- **正常退出**：读完输出（至多 `STOP_EXIT_CONFIRM_MS`，同今天）→ 对进程组发 `kill('SIGKILL')`，杀掉留在后台的进程（T11；ESRCH 不算错；读法 8）→ `afterExit` → `violations`。
- **停止、超时**：序列不变（02:1932）；确认退出后同样 `afterExit`、`violations`。
- **wrap 抛错**（姿态不可用、初始化超时、`/tmp/claude` 不合格、配置没过 schema）：照今天的 `BASH_TEXTS.notStarted` 收口（bash.ts:139-141），不调 `afterExit`。
- **违规进模型**：有违规时在输出之后另加一个文本块：`MODEL_NOTES.sandbox.violations` 的一句说明，再 `<sandbox_violations>`、每条一行 JSON 字符串（`JSON.stringify(line)`，防止伪造标签）、取 `violations()` 的前 20 条，其余写条数，再 `</sandbox_violations>`。这个块不参与落盘判断（读法 10）。
- **收口**（T41）：照「执行过」收口——状态 `completed`、effect `external`、退出码规则照 02:1933、`kernelAuthored` 为假。至少一条违规不带 `observed` 时来源记 `sandbox`、facts `{ toolName }`；全是 `observed`（Linux 观测器的行与清单里的无对象行，读法 53）时来源为 null。只要有违规，`tool_outcome` 只增的 `sandbox` 成员就列出它们（回执读它）。停止、超时的来源不变，违规照附、`sandbox` 成员照写。今天来源、落盘与计数都由批次定、且批次把完成的调用的来源一律置 null（packages/kernel/src/loop/batch.ts:748-756、:698），所以这几条落在 `tools/executor.ts` 的 `ToolExecution` 只增 `sandbox` 与 batch 的 perform / execute：完成的调用保留来源 `sandbox`，违规块在落盘检查之后再接上，execute 把 `sandbox` 计入上限（plan 第 10 步）。
- **计数**：来源 `sandbox` 是拦截码，照 02:1459 计入 `MACHINE_DENIAL_CAP`，一次调用最多算一次；问过人就清零（同一条命令靠本会话授权连着跑三次都有违规，Run 以 `blocked-repeatedly` 结束）。
- **停止后无残留**：真包装下「点停止后 1 秒内无子进程存活」照样成立（主参考:905；Linux bwrap 带 `--new-session --die-with-parent --unshare-pid`，mech:85）。P6 两个平台各起：一条命令里后台 `sleep`、setsid 出去的 python 与前台 sleep（按停止序列停）；双重 fork 后 `exit 0`（子进程留在原会话或另起会话成守护进程，两种）；setsid 出一个进程后 `exit 0`（后两种正常结束、再对进程组 SIGKILL）。Linux 上四种都不留进程。macOS 上停止时 setsid 出去的那个、正常结束后 setsid 出去的那个与成了守护进程的那个都活着（父进程已退、被 launchd 收养，进程组里没有它们）。所以两处改动，都只在 macOS。desktop 的 `killTree`（apps/desktop/src/main/host/process.ts:217）发信号之前先用 `/bin/ps -A -o pid=,ppid=,lstart=` 收集整棵子孙树，信号发给进程组之后再逐个发（P6：停止时 setsid 的那个这样杀得掉）；收集到的在 SIGTERM 与 SIGKILL 之间留着，组空了以后对它们（这时多半已被 launchd 收养）照样再发，`lstart` 核对 pid 没被复用（忽略 SIGTERM 的 setsid 进程靠这个死在 SIGKILL 上）；`ps` 至多等 200 ms，失败或超时时只发进程组、往宿主日志打一行。`afterExit` 在 `/bin/ps -E -axww -o pid=,pgid=,command=` 里找带这次 `TENON_SANDBOX_MARK` 的进程，逐个 SIGKILL，再对它所在的进程组各发一次（组号取自同一张表；0、1 与 Tenon 自己的组不发，表里没有 Tenon 那一行时一个组都不发），它脱身之后在新组里起的子进程也就一并收掉（P6：正常结束后 setsid 的那个这样找得到、杀得掉）。两处 `ps` 与 win32 的 taskkill 同属宿主内部的辅助进程。P6 只用 Homebrew 的 python 验过；第 6 步审查发现 macOS 不让别的程序读 Apple 平台程序（`/usr/bin/perl`、`ruby`、`/bin/sleep`、`bash`、`zsh`、`sh` 这类带平台签名的）的环境变量，`ps -E` 看不到它们的标签。所以脱离了原进程组（`setsid`、bash 的 `set -m`、双重 fork）的 Apple 平台程序，正常结束后两招都够不着；点停止时直接从命令里脱身的那种由 `killTree` 的子孙树杀得掉，先双重 fork 再脱身的（父进程链已断）也收不掉。命令自己去掉标签再脱身的同样找不到。这几种写进已知限制，验收 15 与不变量 13 的 macOS 一半照 P6 的预案收窄（owner 2026-10-16 选 A，没有现在就换一种找法）。正常退出后的那一下 SIGKILL 让一条 02 断言改变：packages/kernel/test/tools/bash.test.ts:351 的 `expect(fake.kills).toEqual([])`（点名 (c)）。

```ts
// packages/kernel/src/tape/entry.ts —— 04 只增（§对 02 的修补 2）
export interface SandboxOutcome {
  readonly violations: readonly {
    readonly kind: 'fs' | 'network'
    readonly target: string | null
    readonly release: 'domain' | 'path' | null
    readonly protected: boolean
    readonly observed: boolean
  }[]                       // violations() 的前 20 条（保护名单的在前）
  readonly more: number     // 没留下的条数
  readonly anyProtected: boolean // 截断之前算：有没有一条带 protected（读法 39）
}
```

## 拦截回执与放行

### 回执上有什么

`tool_outcome` 有 `sandbox` 成员的调用出拦截回执（`BlockedNotice`，comp:143），按这个成员在不在选，不按来源（ToolRow.tsx:22-27、:70 今天只认四个拦截码，只带 `observed` 的调用来源为 null 却也有回执）；琥珀色、三段（parity:246）。文案照 owner 2026-10-15 定的规矩：说被拦下的是什么、用平常话说为什么、每个按钮写明按下会允许什么与管多久；不用「沙箱拦下了」「已告诉模型」这类讲机制的话（回执与 `elevated` 卡的中英文案都不含「沙箱」「模型」/ sandbox、model，验收 33 有一条测试）。有 `sandbox` 成员的调用，`BlockedNotice` 只渲染下面三段：不渲染 `blocked.<source>` 那一句（来源为 null 时也不去查 `blocked.null`），也不渲染今天每张回执都带的 `blocked.told`（「已告诉模型。」，ToolRow.tsx:269）；02:2831 的三行版式只管四个旧拦截码。`blocked.sandbox`（槽位 `{toolName}`）与 `closure.sandbox` 只为 copy-coverage「每个拦截码、每个来源都有文案」而在，回执不用它们，值同样不含上面那些词。契约不变，下面的中文是意思，定稿的键与英文在 plan 第 18 步；类别由界面只按违规的 `kind`、`target`、`release`、`protected` 判，不加契约字段——这几个字段分不出一次文件违规是读还是写（读凭据被拒、落在主目录上的 `chmod 700 ~`、对已存在目录的写、被换行截断的路径，字段都一样），也分不出 profile 目录与保护名单（都只有 `protected`），所以文件类只按 `release` 与 `protected` 分三类：

1. **拦下了什么**：动作加对象，至多三个，多的写条数：网络违规写「没能连接 <主机名>」（如「没能连接 registry.example.com」）；`release: 'path'` 的文件违规（只有被拒的写才有）写「没能写入 <完整路径>」；其余有对象的文件违规写「没能访问 <完整路径>」（如「没能访问 ~/.ssh/id_ed25519」）；没有对象的行（含主机名在 srt 字符集以外、没给 `target` 的网络违规，§afterExit 的表）合成一句「另有 N 次操作没有成功，没有记下对象」。
2. **为什么**，每类一句：白名单外的主机名（给域名按钮的）——「这个网站不在允许连接的列表里」；公网 IP 字面量——「这个地址不在允许连接的列表里；按地址连接的不能从这里允许，要在设置「权限与网络」里加」；回环、私网、链路本地的 IP 字面量与 `localhost`、`*.localhost`——「这个地址指向本机或内网，不能从这里允许」；其余不给域名按钮的主机名（解析到受限地址的、写法认不出的）——「这个名字指向本机或内网，或者写法认不出，不能从这里允许」；`release: 'path'` 的文件违规（工作区外的写，或档位为只读时的写）——「这次不能改动这个位置：它不在这个任务的文件夹里，或者设置里选了只读」；带 `protected` 的文件违规（profile 目录的读写，保护名单、`.ssh` 与凭据位置的写）——「这个位置受保护：里面是登录凭据或 Tenon 自己的数据，或者改了会影响之后在你电脑上自动运行的东西」；其余有对象的文件违规（读 `.ssh` 与凭据清单被拒，落在主目录、已存在的目录这类不能单独放开的写，被换行截断的路径，Linux 上工作区外的写）——「这个位置不在这次能读写的范围里（比如存着登录凭据的地方），也不能从这里单独允许」。第 1 段里没有对象的那一句（含认不出的行）不另配「为什么」，它自己已写明没有记下对象。
3. **按钮**（每个按钮下面一行写明什么时候生效、多给了什么、没用上什么时候作废）：
   - 每个 `release: 'domain'` 的主机名（去重，至多三个）：「在这个任务里允许连接 <主机名>」，下面一行「现在起这个任务里的命令可以连它，也能往上面传东西；只在这个任务里有效，不会加进设置里的列表」（Bash 只在任务形态有，界面上这种会话叫「任务」）。
   - 每个 `release: 'path'` 的路径（不含 `observed`，至多三个）：「允许写入这一个位置」，按钮上写出完整路径，下面一行「在这个任务里再运行完全相同的这条命令时生效一次，只多给这一个位置；到下一轮回复结束还没用上就作废，不会记住」。
   - 「允许这条命令下次不受限制地运行一次」：`anyProtected` 为假、且这次调用不是「违规全带 `observed`、退出码为 0」时才有（Q8 A、开放问题 7 A；full-access 的调用不进 srt、不会有违规）；下面一行「在这个任务里再运行完全相同的这条命令时生效：那一次它能读写你能访问的所有文件、连任何网站；运行前还会再问你一次；到下一轮回复结束还没用上就作废，不会记住」。点了不会立即重跑：要等再次发出同样的命令（§放行怎么生效）。读 `.ssh`、凭据清单被拒的不算保护名单，照样有这个按钮（Q20 B 的代价，开放问题 3）。违规全带 `observed`、退出码为 0 的调用（如 macOS 上一次成功的 `npm install` 只留一条不带地址的出网行，读法 53）回执只作提示、不给这个按钮，免得每条成功的包管理命令都在引你到沙箱外运行；退出码非 0、或至少一条不带 `observed` 的，照本条。退出码由界面照 02:1933 从输出的第一行看（非 0 时是 `Exit code: N`，被信号杀掉时是 `Killed by signal: …`；停止、超时的不算退出码为 0），不加契约字段；kernel 对 `rerun-unsandboxed` 的核对不变（§放行的记法），只是界面不给这个入口。
   - 有保护名单的违规时写一句「这类文件不能从这里允许」，不给放行入口（parity:246）。

本 spec 其余各处与读法里的「本次放行」「仅此路径」「在沙箱外重跑」是这三种放行的名字（`allow-domain`、`allow-path`、`rerun-unsandboxed`），不是按钮上的字；SECURITY.md 这类给你看的文字用按钮上的字（plan 第 20 步）。

Linux 上读被拒不留违规（§afterExit、清理与违规），这类命令没有回执、也就没有「在沙箱外重跑」（开放问题 4）。新文案的键在 plan 第 18 步定；02 的 copy-coverage 测试随之改断言：apps/desktop/test/copy-coverage.test.ts:304 的来源数 24 → 25、:315 的四个拦截码 → 五个（点名 (d)）。

没有「以后都允许」：要长期放行一个域名，去设置「权限与网络」的白名单加（Q9 A）。点过的按钮变成「已放行」；回执的这个状态不进投影，重开后按钮照常出现，再点得到 `already-released` 也显示「已放行」（读法 31）。

### 放行的记法

点按钮 → `sandbox.release` → kernel 在根会话的 mailbox 里核对并写一条 `tool/receipt_override`（02 F9 把回执放行的界面与记法交给阶段 4，02:220；T26、T43）：

```ts
// packages/kernel/src/tape/entry.ts —— 04 只增（§对 02 的修补 4）
export type ReceiptOverridePayload = CallRef & { // CallRef 指回执所在的那次调用
  action: 'allow-domain' | 'allow-path' | 'rerun-unsandboxed'
  target: string | null           // 主机名或真实路径；rerun 为 null
  violation: number               // 在那次 tool_outcome.sandbox.violations 里的序号；rerun 为 0
  command: string; cwd: AbsolutePath // 那次调用的命令原文与 cwd
  via: 'receipt-override'         // 02 保留的答复来源字面量（02:1273）
  writer: FactWriter
}
```

- 渲染端只有不透明的 `callKey`（ToolRow.tsx:45；格式 `<runId>:<requestSeq>:<i>` 由 kernel 定，run.ts:1179-1182），请求带它、由 kernel 解析。`violation` 由 kernel 取第一条目标等于 `target` 的违规的序号（重跑为 0）。
- 键 `tool:v1:override:<runId>:<requestSeq>:<i>:<action>:<violation>`，身份照 02:1323；同键已在 → `already-released`。
- 核对（不成立回 `stale`）：调用在本会话当前 incarnation 里、是 Bash、`tool_outcome` 有 `sandbox` 成员；`allow-domain` 要求那条 `release` 为 `domain` 且主机名等于 `target`；`allow-path` 要求 `release` 为 `path`、不是 `observed`、路径等于 `target`；`rerun-unsandboxed` 要求 `anyProtected` 为假。调用不存在或已撤回回 `not-found`；没 bindLoop 回 `refused`（关机中由路由层先拒，§IPC）。渲染端传来的目标只用来比对，不会被采信（读法 13）。
- 不用 `tool/approval_resolved`：被放行的调用多半已有一条答复，而一个调用只能有一条（`approvalResolvedKey`，packages/kernel/src/tape/provenance.ts:264）。载荷里的 `via` 让 02 保留的字面量第一次有了写入方，02 不变量 17 的测试（apps/desktop/test/inspectors.test.ts:42-55，断言整个源码里只出现一次）随点名 (g) 改为：`ApprovalResolvedPayload.via` 的那个仍没有写入方，`tool/receipt_override` 只由 `release` 写。inspector 回执的放行记在哪由 06 定（读法 13）。

### 放行怎么生效

- **域名**（会话授权，第 6 层，Q9 A、T18）：本会话当前 incarnation 里的 `allow-domain`，加上它从父会话继承的（H5 只往下继承，02:2644），就是这个会话的域名授权；它从 `tool/receipt_override` 推出，不从答复记录推出（点名 (k)）；清空会话后不再算。Bash 每次 wrap 之前，kernel 经 `LoopPorts.sandbox.beforeWrap` 把它们交给 host（读法 19）；写下一条域名授权、而这个会话正是最近一次 `beforeWrap` 的会话时，立即经 `grantsChanged` 再交一次，host 热更新，模型自己重试就能连上。
- **一次性放行**（`allow-path`、`rerun-unsandboxed`，Q8 A、T43）：在同一会话里、命令原文与 cwd 都一字不差的下一次判定时绑定（写进计划的 `override`），绑定即用掉——之后被你拒绝、被停止都不退回；没绑定的，到点击之后开始的第一个 Run 结束时作废（点击时本会话有 Run 在跑的，这个 Run 与下一个 Run 都算），清空会话也作废；一个判定只绑一条，重跑优先于路径，另一条留给再下一次；子会话与父会话互不绑定（读法 14）。「仅此路径」不生成会话授权（D7，02:2108）。
- **卡**：绑定了重跑的调用一定出卡，主原因记 `elevated`，卡面照 §界面 的 `elevated` 文案写明这一次不受限制、只允许这一次，附完整的命令原文；本会话命令授权免不掉它（那条授权是在沙箱档的卡上给的），卡上的「允许」只放行这一次（读法 15、37）。重跑只绑原文与 cwd、不绑脚本内容：点按钮之后 `./run.sh` 这类脚本仍可能被换掉，卡是最后一道闸，`protected` 只是界面提示（读法 36）。

### 告诉模型

kernel 在与 `message/environment` 相同的检查点（02:2966：边界请求，与批边界插入过排队消息之后的那次请求）检查：本会话有放行还没出现在本 incarnation 任何一条 `message/sandbox_release` 的 `overrides` 里，就追加一条 `message/sandbox_release`（user 消息，进上下文、不产投影行、不渲染），内容为 `MODEL_NOTES.sandbox.release` 填好的英文，每条放行一行、值写成 JSON 字符串；载荷带 `overrides`（宣告的那几条的键）。压缩之后上下文里没有了，下一个检查点把仍有效的（本会话的域名放行、还没绑定的一次性放行）补写一条。Run 进行中点的，模型到下一个检查点才看到；在那之前它自己重试也能成（白名单已热更新）（读法 17）。

## 网络白名单

- **管的范围**（2026-10-15 补）：白名单只管沙箱里的命令（Bash 起的进程）。WebFetch 走自己的地址判定与按域名会话授权（02 的 H8、§WebFetch 与 CGNAT），MCP server 照 03 的确认与出网规则、不进沙箱（Q11 A）；三者互不相通，WebFetch 能抓的网站命令不一定连得上，反过来也一样，设置页写明。Claude Code 的沙箱同样只管命令、不限 WebFetch（[沙箱文档](https://code.claude.com/docs/en/sandboxing)）。改动在每次 wrap 前按当时的值重算、从下一次 wrap 起生效，不是建会话时取一份。这与 Cowork 不同——组织改了网络设置，要新开 Cowork 会话才生效（[Team / Enterprise 文章](https://support.claude.com/en/articles/13455879-use-claude-cowork-on-team-and-enterprise-plans)）——是有意的：回执上放行一个域名，模型重试就能连上（§放行怎么生效）；从白名单删掉的，已开着的会话里下一条命令起也不再有效。
- **生效白名单**（T18）= 设置里的用户白名单 ∪「包管理器」预设（勾上时）∪ 正在跑的这条命令所属会话的域名授权。除这三样 host 什么都不自动加：各厂商的推理 API 域名、你配的自建网关与 provider 端点、MCP server 的地址、遥测端点都不进（不变量 19）。Claude Desktop 3P 部署的 2.37337.1 也不再替用户把推理提供方、网关、OTLP 收集器的主机与 `api.anthropic.com` 加进 Cowork 的出网白名单（[changelog](https://claude.com/docs/cowork/changelog)）。srt 整个进程只有一份白名单（srt-1、srt-2），所以「只在本会话」靠每条命令前重算：同一时刻只有一个顶层 Run（02:1820），Bash 不并行，留在后台的进程在调用结束时已杀（T11）。这三个前提有缺口：「一个顶层 Run」只由界面保证（02:1820 第 6 条），`updateConfig` 对已经在跑的进程立即生效（sandbox-manager.js:1680-1700），杀不到的残留进程（§已知限制）会拿到之后任何会话的域名授权。所以 host 记下已 wrap、还没 `afterExit` 的调用各属哪个会话，`beforeWrap` 换成另一个会话的白名单之前先等它们收尾，至多 2 s，超时记一行日志、照换。有变化才 `updateConfig`，从不为白名单 reset。WebFetch 的按域名会话授权（H8）不并进命令的白名单（T16）。
- **用户白名单**存 config.json 的 `sandbox.allowedDomains`（§对 01 的修补；写入照 M6 的锁与临时文件改名）。写法照 srt 的模式：域名、`*.` 加至少两段的域名、`localhost`、IPv4 字面量、带方括号的 IPv6，可带 `:端口`；拒裸 `*`、`*.com`、带协议或路径的、不带方括号的多冒号写法（srt79 dist/sandbox/sandbox-config.js:19-87）；回环、链路本地与私网的 IP 字面量，以及 `localhost` 与以 `.localhost` 结尾的名字，必须带端口，界面对它们加一句警告（只写 `127.0.0.1` 或 `localhost` 等于经代理放开本机所有端口，srt 对白名单里的 IP 字面量不做解析地址检查，README.md:365；读法 40）。按小写存、去重、最多 256 条；读入时坏条目只丢自己、记一行日志（读法 29）。设置页在列表上方写明白名单按网站放行、不按操作：列进来的网站，沙箱里的命令可以连，也可以往上面传东西（§已知限制「白名单即能力授权」）。
- **「包管理器」预设**（Q10 A）：默认不勾。P4 照它的规则与读法 49 在两个平台逐个实测后定为下表（装得上；域名都归包仓库的运营方、不超过 4 个；能用环境变量把缓存挪进 Tenon 自己的目录——一个，或一组都指向那个目录之下）。`<目录>` = `<userData>/sandbox-cache/<管理器>`（`<userData>` 即 `app.getPath('userData')`，在 profile 目录之外，所有会话共用一份，开放问题 5 A，读法 46）：

  | 管理器 | 平台 | 域名 | 变量 |
  |---|---|---|---|
  | npm | 两平台 | `registry.npmjs.org` | `npm_config_cache=<目录>` |
  | pnpm | 两平台 | `registry.npmjs.org` | 一组六个：`npm_config_store_dir=<目录>/store`、`npm_config_cache_dir=<目录>/cache`、`npm_config_state_dir=<目录>/state`，与同样三个以 `pnpm_config_` 开头的（pnpm 10 及以前读 `npm_config_*`，11 起只读 `pnpm_config_*`） |
  | pip | 只 Linux | `pypi.org`、`files.pythonhosted.org` | `PIP_CACHE_DIR=<目录>` |
  | uv | 两平台 | `pypi.org`、`files.pythonhosted.org` | `UV_CACHE_DIR=<目录>` |
  | cargo | 两平台 | `index.crates.io`、`static.crates.io` | `CARGO_HOME=<目录>` |

  不进的：yarn classic 与 berry（两平台把缓存挪进 Tenon 的目录后都装不上，拒绝里也没指出缺哪个域名或目录）；go（macOS 上 TLS 校验失败；Linux 上挪了 `GOMODCACHE`、`GOCACHE` 仍要写 `~/go`、`~/.config/go`，没用一组变量重测过，这次照旧不进）；macOS 的 pip（Homebrew 的 pip 经系统信任库校验 TLS，沙箱里失败，读法 51）。不设变量也装得上的两处照样给变量：macOS 上的 pnpm 不设时把仓库建在项目里的 `.pnpm-store/`，Linux 上的 pip 不设时关掉缓存、打一行警告。pnpm 那一行原来只设 `npm_config_store_dir`：plan 第 6 步在跑 S 的机器上实测（不进黑盒，黑盒不联网），macOS 与 24.04、26.04 上都装上、仓库落在 `<目录>/store`，但缓存与状态写在主目录下（macOS 上写 `~/Library`、`~/.local` 被拒，这类回执还会给放开你自己的 pnpm 目录的「仅此路径」按钮），pnpm 11 起又只读 `pnpm_config_*`；2026-10-16 改成上表那一组（P4 用 pnpm 9 三项同设，macOS 上一条拒绝都没有）。这一组同样手动重测、不进黑盒（plan 第 6 步）：过线是 pnpm 自己的退出码为 0、仓库在 `<目录>/store`、没有不带 `observed` 的违规；不过线就停下，由 owner 定去掉 pnpm 预设还是接受这些回执。勾上且你的档位为 workspace-write 时（下称「预设生效」），本平台各行的目录进 allowWrite，`DesktopSandbox.wrap` 同时在命令环境里加各行的变量（§argv、shell、env 与 id，读法 20、47）；只读档两样都没有。你自己的缓存目录（`~/.npm`、`~/.cargo`、`~/.cache/uv` 这类）不进 allowWrite（srt 默认可写的 `~/.npm/_logs` 除外）：`~/.npm/_npx` 里 npx 装好的包与 `_cacache` 的缓存——03 的连接器常用 `npx -y` 起、不进沙箱（Q11 A），你自己终端里的 npx 也从这里执行——沙箱里的命令改不到；代价是沙箱里第一次装要重新下载，`~/.npmrc` 在凭据清单里、里面的设置在沙箱里不生效（§已知限制）。npm 在两平台核实：`_cacache`、`_npx`、`_logs` 都落进它的目录，`~/.npm` 不动，工作区 `.npmrc` 里的 `cache=` 压不过变量（P4）。预设只给命令用（Q11 A）。
- **解析地址**（T42）：沿用 srt 默认（§档位到 srt 配置），上游代理钉成不用，检查对每个连接都做。白名单里的主机名被人把 DNS 指到内网时挡不住，写进已知限制。`localhost`、`*.localhost` 在 srt 里只许解析到回环（resolved-address-guard.js:162-164），所以 `localhost:端口` 进了白名单就是经代理放行本机这个端口。反过来不成立：只写 `127.0.0.1:端口` 时 `localhost:端口` 被拒——srt 先按名字比白名单（sandbox-manager.js:239-249），README.md:365 说的「名字可以解析到白名单里的 IP 字面量」只对名字本身已在白名单里的成立。但 srt 给每条命令的 `NO_PROXY` 固定含 `localhost`、`127.0.0.1`、`::1`、链路本地与三段私网（sandbox-utils.js:673-683），curl、npm、pip 这类认它的客户端对这些目的地直连，而直连在 macOS 只许连代理端口、在 Linux 的独立网络命名空间里连不出去：本机与私网的白名单条目只对走代理的客户端有效（设置页照写，读法 40）。

## WebFetch 与 CGNAT

`isBlockedFetchAddress`（packages/kernel/src/permission/fetch-address.ts:2）加上 `100.64.0.0/10`（含它的 IPv4 映射写法，同函数已有的递归），于是三处一起变严（T16）：WebFetch 的 URL 字面判定（第 2 层拦下，拦截码 `protected`）、host 的 DNS 判定（apps/desktop/src/main/host/fetch-untrusted.ts，以 `HostNetworkDeniedError` 拒，02:2765），以及 03 公网 server 的跨源发现地址（03:527，同一个函数）。apps/desktop/test/fetch-untrusted.test.ts:128 那条「放行 CGNAT」的用例、packages/kernel/test/permission/fetch-address.test.ts:45 的 `http://100.64.0.1` 与 :54-67「without widening to CGNAT」的 `100.64.1.1` 都改为断言拦下（点名 (i)）。provider 端点的 `reachOf`（apps/desktop/src/main/endpoint.ts:68 已把 CGNAT 算私网）是你选的地址，不过这张表，照旧。命令一侧不同（T42），是有意的：WebFetch 的地址由模型挑，命令的域名由你加。

## 界面

- **设置弹窗**（T39；comp:68，parity:291；读法 28）：加一栏「权限与网络」（owner 2026-10-15 把原定的「沙箱」「网络白名单」两栏合一）。主体是网络白名单：说明一句（按网站放行、不按操作，§网络白名单），列表增删、就地显示校验错误，本机与私网条目旁写明只对走代理的客户端有效；「包管理器」复选框，展开可见它加哪些域名、哪些缓存目录变可写，并写明 npm 的那个域名同时接受发布（§已知限制「白名单即能力授权」）；写明白名单只管命令、不管 WebFetch 与 MCP。沙箱状态平时不显示：姿态为 `degraded` 或 `unavailable` 时在这一栏顶部显示一行（状态与原因码的一句说明），展开是修法与详情（Linux 附 sysctl 读数；`no-seccomp` 写明失去了什么：沙箱里的命令能连 Unix socket，被拦的写不再回报；修法只给命令或文档链接，不代执行）；`active`、`pending` 不显示（测试接缝 `fake` 例外，§IPC）。折叠的「高级」里是命令档位单选「工作区可写（默认）/ 只读」，各带一句后果，写进 config.json，下一次判定起生效。输入框上不放沙箱 chip（comp:196），会话的状态点 `SessionStatusDot` 归 4d（T39）。
- **审批卡**：命令卡 facts 带 `sandbox: 'unavailable'` 时加一句琥珀色的「沙箱不可用，将以你的权限运行」（Q6 A 定的原话，不在 2026-10-15 的文案规矩里）；`elevated` 卡的文案改为「这条命令这一次不受限制地运行，和你在终端里自己运行一样：能读写你能访问的所有文件、能连任何网站。只允许这一次，不会记住。」，下面是完整的命令原文 `{command}`（槽位只有必填的 `command`，00:163；今天的文案是「这条命令要提升权限：{command}」）。
- **拦截回执**：照 §回执上有什么。按钮经 `sandbox.release`，错误码就地显示。

## IPC

都经 `packages/contracts` 注册（AGENTS.md:20）。

```ts
// packages/contracts/src/ipc/sandbox.ts —— 04 新增
sandbox.get → SandboxView
sandbox.changed (event) → SandboxView   // 启动后姿态定下、设置变了时推
interface SandboxView {
  posture: { state: 'pending' | 'active' | 'degraded' | 'unavailable'; profile: 'read-only' | 'workspace-write' }
  platform: 'darwin' | 'linux' | 'win32' | 'other'
  reasons: { code: SandboxReasonCode; detail: string | null }[] // detail 是 srt 原文或 sysctl 读数，不翻译；userns-restricted 的末行是 bwrap=<绝对路径>
  settings: { profile: 'read-only' | 'workspace-write'; allowedDomains: string[]; packageManagers: boolean }
  preset: { domains: string[]; writable: string[] } // 「包管理器」会加什么，供界面展示
}
sandbox.setSettings({ profile?, allowedDomains?, packageManagers? })
  → { ok: true } | { ok: false; code: 'invalid-domain'; index: number } | { ok: false; code: 'too-many' | 'write-failed' }
sandbox.release({ sessionId, callKey, action, target: string | null }) // callKey 即工具结果视图里的那个，kernel 解析
  → { status: 'released' | 'already-released' | 'stale' | 'not-found' | 'refused' }
```

- `reasons` 里的 `other` 随 `unavailable` 出现，也随 `degraded` 出现（§启动 第 4 步：认不出的 warning），两种情况下详情都是 srt 的原文。`userns-restricted` 的详情末行是第 2 步找到的 bwrap：`bwrap=<绝对路径>`（§启动 第 6 步）。
- 渲染端永远拿不到 srt 的配置、代理端口与口令。`sandbox.release` 写事实，加进 shutdown.ts 的 `REFUSED_WHILE_SHUTTING_DOWN`，关机开始后由路由层回 IPC 信封的错误（`{ ok: false, error: { code: 'handler-failed' } }`，shutdown.ts:94-111）；`sandbox.setSettings` 只写 config，照那张表对 config 写入方的做法不拒（:65-69）。`release` 的 `refused` 只留给「循环还没绑定」。
- e2e 接缝 `TENON_TEST_SANDBOX=off | fake`：只在未打包且 `TENON_DEV_ENV=off` 时生效、不被子进程继承；`off` 让姿态为 `unavailable`/`test-seam`；`fake` 让姿态为 `active`、命令照直通跑，只按命令里的标记 `tenon-test-blocked:<主机名>`、`tenon-test-write:<绝对路径>` 报违规；e2e 启动器默认 `fake`，既有 e2e 的卡面与今天一样、不依赖本机能不能起沙箱（读法 23）；`fake` 时 `sandbox.get` 返回 `state: 'active'` 加 `reasons: [{ code: 'test-seam', detail: 'fake' }]`，启动日志写明是测试接缝，设置页照这个原因码也显示状态那一行、写明是测试接缝；真实的 `active` 从不带原因。两种接缝都不调 initialize，也都不 chdir（读法 50 的 chdir 只为 srt 那份强制禁写，接缝下没有它）。

## Tape 事实

照 02 §02 的 Tape 事实 的写法，两个新名字落在 01 保留的前缀下（照 02 的读法不算修补 01）：

| 名字 | 写入方 | 幂等键 | 何时 | 投影与上下文 |
|---|---|---|---|---|
| `tool/receipt_override` | resolver（`release` 命令，根会话 mailbox） | `tool:v1:override:<runId>:<requestSeq>:<i>:<action>:<n>` | 你点回执按钮 | 不产投影行；不进上下文 |
| `message/sandbox_release` | 循环 | `message:v1:<messageId>:0` | §告诉模型 的检查点 | 作为一条 user 消息进上下文；不产投影行、不渲染；压缩的 token 估算计入 |

`message/sandbox_release` 的载荷 = `UserMessagePayload<ContentBlock> & { overrides: string[] }`。两者都登记进 names、projection、replay（只有后者折进上下文，同 `message/environment`）、compaction 的名字表与 `testing/tape-conformance.ts`。`tool/permission_decided` 只增 `sandbox?: SandboxPlan`（只 Bash 有），`execution/tool_outcome` 只增 `sandbox?: SandboxOutcome`。

## 对 00 的修补

00 已 `implemented`。下面只增，00 正文不改，00 顶部加一行 `Amended by`（§文档同步）。`SandboxRequest` 不动（T38）。

1. `HostSandbox` 只增可选成员 `posture?(): SandboxPosture`（同步、不抛错）。没有它的宿主（`MemoryHost`、`PassthroughSandbox` 与别的不实现它的宿主）按 `{ state: 'active', profile: 'workspace-write' }` 读，02 的行为与测试不变（读法 1）。这个缺省只决定卡面文案；以后任何因为「沙箱生效」而少问的规则（06 的沙箱内免问）把缺 `posture` 读作不可用：`PassthroughSandbox` 对受限档照样直通。
2. `SandboxViolation` 只增四个可选成员（读法 2）：

```ts
export interface SandboxViolation {
  kind: 'fs' | 'network'      // 00，不变
  line: string                // 00，不变；原始行文本
  target?: string             // 04：主机名（不带端口）或绝对路径
  release?: 'domain' | 'path' // 04：回执可以就这个对象给一次性放行
  protected?: true            // 04：对象落在保护名单上
  observed?: true             // 04：只作诊断——Linux seccomp 观测器的行（mech:218）与清单里的无对象行（§afterExit 的表，读法 53）
}
```

3. 00:161「阶段 4 替换实现时接口不变」：`DesktopSandbox` 替换 `PassthroughSandbox`；受限档在沙箱不可用时拒绝而不直通（§点名 (a)）。

## 对 01 的修补

01 已 `implemented`，只增一条：config.json（01:705 立的）只增键 `sandbox: { profile: 'read-only' | 'workspace-write'; allowedDomains: string[]; packageManagers: boolean }`，缺省 `{ profile: 'workspace-write', allowedDomains: [], packageManagers: false }`；没有这个键的旧配置读作缺省，其余键不变（M6、03 加 `customVendors`、`mcpServers` 都记作修补 01，这里照做）。01 顶部加一行 `Amended by`。

## 对 02 的修补

02 已 `implemented`。下面全部只增，02 正文不改，02 顶部加一行 `Amended by`。给既有对象类型加可选键算新增成员（02 的 01 修补 1 的读法）。

1. **拦截码**：`BlockReason` 只增 `'sandbox'`（02:191、closure.ts:28）；`BLOCKED_FACT_KEYS.sandbox = ['toolName']`；contracts 的 `closureSourceSchema` 同步；`MODEL_NOTES.closure.sandbox = {}`——这类调用的结果是命令自己的输出，没有收口句。
2. **`ToolOutcomePayload` 只增 `sandbox?: SandboxOutcome`**；kernel 的 `ToolOutcomeView`（packages/kernel/src/loop/events.ts:44）与 contracts 的 `toolOutcomeViewShape` 同步只增，逐键双向类型钉照 03 §对 02 的修补 11 的写法。
3. **`PermissionDecidedPayload` 只增 `sandbox?: SandboxPlan`**，只 Bash 写；本 spec 之前写的判决没有它，执行时按 `{ profile: 'workspace-write', chosen: 'workspace-write' }` 读。
4. **新名字** `tool/receipt_override`、`message/sandbox_release`（§Tape 事实）。
5. **`LoopPorts` 只增可选成员 `sandbox?: SandboxPorts`**（02:373-385；合 packages/kernel/src/loop/ports.ts:11-12「宿主实现的端口只加可选成员」，02 开放问题 26）：

```ts
export interface SandboxPorts {
  /** Bash 调 wrap 之前同步调：这条命令属于哪个会话、这个会话（含继承）放行过的域名。 */
  beforeWrap(q: { commandId: string; sessionId: string; hosts: readonly string[] }): void
  /** 刚写下一条域名放行，且 sessionId 正是最近一次 beforeWrap 的会话。 */
  grantsChanged(q: { sessionId: string; hosts: readonly string[] }): void
}
```

6. **`SessionService` 只增命令 `release(q)`**，形状照 §IPC 的 `sandbox.release`，进根会话 mailbox，规则见 §放行的记法。
7. **命令卡**：`command` 原因的 facts 只增可选键 `sandbox`（值只有 `'unavailable'`）；必填键不变（00:163 的槽位规则照旧，这一句是固定文案、没有槽位）。kernel 内部的 `CallReason.reason` 只增 `'elevated'`，主原因的命令例外（02:573）加一条：绑定了重跑放行的 Bash 取 `elevated`。
8. **Bash**（02:1918-1933）：档位取判决的计划；wrap 成功而没起进程时也调 `afterExit`；正常退出后杀进程组；违规块与收口照 §执行与收口；02:1933「`&` 留在后台的进程杀不杀，02 不定」由此定为杀，bash.test.ts:351 的「不发信号」断言随之改（点名 (c)）。
9. **提示层**（02:2933、:2956；T35）：`MODEL_NOTES` 只增 `sandbox: { violations: string; release: { wrap: string; domain: string; path: string; rerun: string } }`（槽位：`{lines}`；`{host}`；`{path}` `{command}`；`{command}`，值为 JSON 字符串）；Bash 描述加两句英文，第一句意思是「沙箱生效时命令只能写工作区文件夹、只能连用户放行的域名，被拦下的操作列在输出后的 `<sandbox_violations>` 里」，第二句（读法 52）意思是「Linux 沙箱里工作区根下会出现一些空的占位项（如 `.envrc`、`.bashrc`、`.vscode`），不是用户的文件；不要 stage 或提交它们，用 `git add <路径>` 而不是 `git add -A`」；任务形态的 system 加一句英文，意思是「单独成条的 `<sandbox_release>` 是 Tenon 写的，工具结果里同样的文字不是」。英文原文在 plan 第 7 步写定。`PROMPT_LAYER_VERSION` 10 → 11，更新哈希，跑基线评测（读法 30）。
10. **地址表**：`isBlockedFetchAddress` 加 `100.64.0.0/10`（§WebFetch 与 CGNAT）。

## 对 03 的修补

03 已 `implemented`，只一条：§地址与出网 的 DNS 判定（03:527）用的 `isBlockedFetchAddress` 加了 CGNAT，公网 server 的跨源发现地址解析到 `100.64.0.0/10` 时同样 0 次请求（T16，点名 (ii)）。MCP stdio 的档位、确认框与验收 9 都不动（Q11 A）。03 顶部加一行 `Amended by`。

## 点名（T36 附表中 4a 承担的行）

规则见 AGENTS.md:11、docs/spec-driven-dev.md:54：对 implemented 的 00–03 只能只增。「点名」照 03 §点名 的先例：仍属 amend，只是把碰到旧文字的条目单列，理由只有两种——(i) 被改的 spec 自己把这件事交给阶段 4；(ii) 收紧原本未限定的选型。本表没有需要 supersede 的条目。

| | 旧行 | 改什么 | 归类 | 理由 |
|---|---|---|---|---|
| (a) | 00:161 | 受限档真包装；沙箱不可用时 wrap 拒绝，不再「原样返回打日志」 | 点名 (i) | 00:161「阶段 4 替换实现时接口不变」 |
| (b) | 02:1920 | Bash 的档位从「只记意图」变为生效，可为 read-only 或 full-access（按判决的计划） | 点名 (i) | 02:1920 写阶段 2 直通，三档在阶段 4（主参考:921） |
| (c) | 02:1933 | 调用结束时杀进程组；packages/kernel/test/tools/bash.test.ts:351「不发信号」的断言随之改 | 点名 (i) | 02:1933「02 不定（阶段 4）」 |
| (d) | 02:1459、:1570、:2213 | 有违规的命令照执行过记、来源 `sandbox`、计入上限；观测器的不计；apps/desktop/test/copy-coverage.test.ts:304 的来源数 24 → 25、:315 的四个拦截码 → 五个 | 点名 (i) | 02:191、:1570「阶段 4 再加 `sandbox`」 |
| (e) | 02:1594 | 回执除 `source`、`facts` 与对话形态 Read 那个「唯一的例外」之外，另读 `tool_outcome.sandbox` | 点名 (i) | 02:1570 把 `sandbox` 交给阶段 4，02:220 把回执放行的界面交给阶段 4 |
| (f) | 02:2104 | 命令一侧的保护名单由沙箱的 denyRead / denyWrite 补齐，另加凭据清单、会话钩子类文件与 srt 的强制禁写名 | 点名 (i)+(ii) | 02:2104「阶段 4 由沙箱补齐」；新增的名字是收紧 |
| (g) | 02:220、:2165、:3245（不变量 17 后半） | 02:2165 的两句——「只有第 5 层的拒能推翻」「界面和执行随第一个会拒绝的 inspector 同时上线」——各扩一处：沙箱违规（02:2213 列的第五种拦截来源）是回执放行的第二个产生方，并先于 inspector 上线；记在新名字里、带 `receipt-override` 字面量；`approval_resolved` 的那个仍没有写入方；apps/desktop/test/inspectors.test.ts:42-55 的断言随之改 | 点名 (i) | 02:220「回执放行的界面与记法：阶段 4」；02:3400「从回执放行的产生方」在阶段 4；T36 |
| (h) | 02:573 | 命令主原因仍是 `command`，绑定了重跑的取 `elevated` | 点名 (i) | 02:3165 ⑦ 交给阶段 4 |
| (i) | fetch-address.ts:2-43 | 加 CGNAT；apps/desktop/test/fetch-untrusted.test.ts:128、packages/kernel/test/permission/fetch-address.test.ts:45、:54-67 改为断言拦下 | 点名 (i) | 02:3400、02plan:1003 |
| (j) | 03:527 | 跨源发现一起拒 CGNAT | 点名 (ii) | 收紧 |
| (k) | 02:2108（第 6 层） | 「网络白名单（阶段 4）」这个来源落地：用户白名单在 config.json，域名的会话授权从 `tool/receipt_override` 推出，不从答复记录推出 | 点名 (i) | 02:2108 把网络白名单列给阶段 4 |
| (l) | 02:2281、:2108 | 本会话命令授权不免 full-access 计划（不可用、绑定了重跑）的卡；`elevated` 卡的「允许」只这一次 | 点名 (ii) | 02:2108「范围以卡或弹窗上写明的为限」；full-access 计划是阶段 4 才有的情形 |

## 已知限制

写进 SECURITY.md 的「已知限制」（T15，plan 第 20 步），不在阶段 4 解决：

- macOS 钥匙串通路 `com.apple.securityd.xpc` 与 `com.apple.SecurityServer` 在 srt 里无条件放行、没有开关（security-8、security-m0、security-23）：沙箱里的命令能对 Tenon 自己 `com.yiongspace.tenon` 下的条目（apps/desktop/src/main/host/secrets.ts:5）发起系统授权弹窗，开发构建没签名，弹窗上看不出是谁在要。
- **白名单即能力授权**（2026-10-15 补）：白名单按网站放行、不按操作。你自己加进去的宽域名——模型厂商的 API（如 `api.anthropic.com`、`api.deepseek.com`、`open.bigmodel.cn`）、`github.com` 这类——让沙箱里的命令能带着攻击者自己的 key 或令牌，把工作区内容传到攻击者的账号或仓库里。srt 的代理只按 CONNECT 的目标放行、不终止 TLS（Tenon 不开 `tlsTerminate`，T14），看不到隧道里的请求，没法只放行某个 token 或某种操作；域名前置也可能绕过过滤（security-12）。Anthropic 的工程文记了一次第三方披露：Cowork 的白名单放行 `api.anthropic.com`，工作区里一个恶意文件带着攻击者的 key，让 Claude 读了工作区的其他文件、经 Files API 传到攻击者的账号；修法是在 VM 里放一个防御用的 MITM 代理，只放行带这个 VM 自己领到的会话 token 的请求（[How we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude)）。Tenon 自己的「包管理器」预设也有这一类：npm、pnpm 用的 `registry.npmjs.org` 同时接受发布，勾上预设后，沙箱里的命令能带着别人的令牌把工作区内容发布成 npm 包；pip、uv 的上传域 `upload.pypi.org` 与 cargo 发布用的 `crates.io` 不在预设里；srt 的 README 也写放行 `github.com` 就能往任何仓库推（srt79 README.md:886、:890）。Tenon 不自动加这类域名（不变量 19）、设置页写明这一点（预设展开处另写 npm 那一条），4a 不做按 token 或按操作的过滤。白名单里的主机名被指到内网地址时挡不住（T42）。机器上的解析器答「假 IP」时（代理软件的 fake-IP 模式，P1 那台机器把公网名字都解析到 `198.18.0.0/15`），srt 的解析地址检查只看得到假地址，名字实际指向哪里它不知道。
- macOS 上经系统信任库校验证书的客户端在沙箱里 TLS 校验失败（OSStatus -26276；P4 实测的是 Homebrew 的 pip 与 go，Claude Code 的沙箱文档说 gh、gcloud、terraform 也会）：它们要连的 `com.apple.trustd.agent` 只在 `enableWeakerNetworkIsolation` 打开时放行，T14 不开；要走「在沙箱外重跑」，Python 包可改用 uv（读法 51，owner 2026-10-15 定照 T14 接受）。node、curl、uv、cargo 不受影响。
- macOS 上不认 `TMPDIR`、直接写每用户临时目录（`/var/folders/…/T`）的工具在沙箱里写不了临时文件，比如裸 `mktemp`（P1；`mktemp "$TMPDIR/x.XXXXXX"` 可以）。
- 上游代理钉成不用（读法 33）：只能经公司代理出网的机器上，沙箱里的命令连不出去，要走「在沙箱外重跑」。不读代理变量的工具（裸 ssh、多数数据库驱动，hosts-9）同样连不上（Q8 D 的代价，靠 Q8 A 的重跑）；jlink 裁掉 `java.instrument` 的 JVM 在沙箱里起不来（srt-m8）。
- 本机与私网的白名单条目只对走代理的客户端有效：srt 的 `NO_PROXY` 让多数工具直连这些地址，直连被拒（§网络白名单）；macOS 上沙箱里起本机端口的测试会失败（读法 21）。一个 Unix socket 都不放（读法 43）：ssh-agent、gpg-agent、docker CLI 在沙箱里用不了；连 Unix socket 被拒两个平台都不留违规（P1），这类命令没有回执。
- MCP stdio server 以你的权限运行，只靠添加时的确认与 launchHash（Q11 A，03:211）；SECURITY.md 设计原则里「每个子进程经沙箱」那句要带上这个例外。
- Windows 没有 OS 级隔离，命令每条都问（Q4 A）。
- 没有 hypervisor 级的隔离（2026-10-15 补，T30 不用 VM 的代价）：Cowork 的本地会话把 agent 循环跑在设备上、代码放进专用的 Linux VM 里执行，由 hypervisor 隔开（[Cowork 架构概览](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)、[How we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude)）。Tenon 的形状一样——循环与文件工具在本机，只有命令进隔离——但命令只在 OS 级沙箱（Seatbelt / bubblewrap）里、与你共用同一个内核，内核或沙箱机制本身的漏洞挡不住。形状相同、隔离弱一档，是有意的取舍：不装虚拟机、不备镜像，命令直接用你机器上的工具链。
- macOS 的 TCC 隐私授权（2026-10-15 补，Tenon 自己的推断，没实测）：沙箱里的命令由 Tenon 起，按 macOS 的规则以 Tenon 为负责进程，Tenon 已经拿到的隐私授权（你给过的「文稿」「桌面」「下载」、完全磁盘访问这类）它们也有。srt 默认可读整台机器、只拒 denyRead（§档位到 srt 配置），所以 TCC 管着的位置在沙箱里读不读得到，取决于 Tenon 被授过什么，而不是这条命令。反过来，沙箱里的命令去碰 TCC 管着、而 Tenon 还没被授权的位置时，macOS 弹出的授权框写的是 Tenon（开发构建里是 Electron）在要；点了允许，就是给了 Tenon 与之后的每条沙箱命令，所以命令运行期间冒出、而你没要求访问那个位置的这类授权框应当拒绝（同样是推断；Tenon 自己的文件工具在你选的文件夹位于「文稿」「桌面」时也会弹同样写着 Tenon 的框，那是你要的，可以允许）。也不要给 Tenon 完全磁盘访问：给了之后，沙箱里的命令也读得到邮件、信息这类位置（同样是推断）。plan 第 13c 步在真进程上核一次，照结果改这一条或记 Revisions。把命令的 TCC 身份与 Tenon 分开，归阶段 7 的 helper 与签名。
- 继承的文件描述符不受限（security-22），所以 spawn 只传三个标准流（apps/desktop/src/main/host/process.ts:58）；`/tmp/claude` 被所有沙箱命令共享，也与同机别的 srt 使用者（如 Claude Code 的沙箱）共享，只读档也能写它与 `~/.npm/_logs`、`~/.claude/debug`（security-21、security-m5）。
- 工作区里运行前就有的、指向外面的硬链接（security-6）。保护名单只覆盖每个文件夹根下的那些名字；子目录里的同名项 macOS 靠 glob，Linux 不挡（srt 的子目录扫描从主进程的 cwd 起，对工作区不成立）。Linux 上拒绝条目解析时经过的链接本身（比如工作区根的 `.envrc` 是个链接，或 `~/.aws` 的目标里还有一层 `~/dotfiles` 链接）0.0.79 护不住（bwrap 挂不到链接上，srt #693 未发布），命令能删掉或换掉它、在原名字上写普通文件；host 在调用结束时比对发现、报一条带 `protected` 的违规，只能事后提醒、挡不住（§档位到 srt 配置「链接」；macOS 上靠 denyWrite 里的链接本身挡，第 6 步实测挡得住）。拒绝条目是悬空链接时（`~/.aws` 指向还没建的 `~/dotfiles/aws`），链接指向的位置照样进拒绝表：沙箱里建不出它，连它缺的上级目录也建不出（macOS 上 srt 给每条 literal 的 denyWrite 的各级祖先加禁止创建的规则，macos-sandbox-utils.js:539-560；Linux 上原本如此），这类目录要在沙箱外建。
- Linux 上命令运行期间，工作区根下不存在的保护名字会出现空的挂载点文件或空目录（如没有 `.claude/` 时的 `.claude/`）；沙箱里的 `git status` 把它们列成 17 个未跟踪项（`.aws`、`.bashrc`、`.envrc`、`.vscode` 等，P5 在 24.04 与 26.04 上都是；在沙箱里它们是 `/dev/null` 这个字符设备）；`git add -A` 与 `git add .` 遇到它们整条失败、什么都不 stage（`error: .aws: can only add regular files, symbolic links or git-directories`、`fatal: adding files failed`，退出码 128），`git add <路径>`、`git add -u`、`git commit -a` 照常（plan 第 6 步在 24.04 与 26.04 上实测；宿主上调用结束后只剩真正的改动）；Bash 描述里有一句告诉模型它们不是你的文件、别 stage（读法 52），模型照不照做评测看不到（评测只在 macOS 跑）。被 SIGKILL 之后空的只读文件与空目录都留着（P7），由 host 下次启动时按记录删（§afterExit「挂载点与残留的记录」；记下的那次已退出、又没有 bwrap 在跑时才删，文件只删仍是 bwrap 造的样子的）；bwrap 低于 0.5.0 时文件 srt 也认不出（security-m4，linux-sandbox-utils.js:407-429）。Linux 上往已存在的禁读目录里写（主目录是工作区时的 `~/.ssh`，凭据清单里已存在的 `~/.kube`、`~/.config/gh` 这类），看起来成功，内容随命令结束丢掉，不会写到你的文件上：srt 用空的 tmpfs 盖住这类目录、不再给它们只读绑定（linux-sandbox-utils.js:1415、:2438-2439）；观测器照样报一条带 `protected` 的违规。命令运行中 Tenon 被强杀时，`/tmp` 里还可能留下一个空的 0700 目录 `claude-empty-*`：它没有内容，只有你自己看得到，系统清 `/tmp` 时（多半是重启）就没了；Tenon 不收它——名字由 mkdtemp 生成、不带 pid，按「wrap 后新出现的名字」去收，会把别的 srt 使用者（如 Claude Code）正在用的目录记成自己的、下次启动删掉。
- `.git/config` 与 `.git/hooks` 在每个根下不可写（上表），`git remote add`、装 hook 会失败；macOS 上子目录也照 glob 挡、根下不论 `.git` 在不在都挡，在工作区根 `git init`、往子目录 `git clone` 都失败（P1）；Linux 上两样都成功（只挡根下已有的 `.git` 目录，P1）；工作区根下还没有 `.claude/` 时，macOS 沙箱里也建不出它（srt 给每条 literal 的 denyWrite 条目的各级祖先目录加禁止创建与删除的规则、排在写规则之后，macos-sandbox-utils.js:539-560；P1 实测被拒；与根下的 `.git` 同一机制），要在沙箱外建；但 agent 在沙箱里跑的 `git commit`、`reset` 改的就是你自己的 `.git`（Q12 A 的代价）。macOS 上 git 走 https 时 osxkeychain 凭据助手存不进钥匙串（输出里多一行 `failed to store: -60008`，`com.apple.authd` 被拒），命令本身照常，但每次带着读 `~/.netrc` 被拒等违规行（P3）；读 `~/.netrc` 那行有对象，这次调用来源记 `sandbox`、计入上限（读法 53），靠本会话授权连着三次走 https 的 `git` 命令，Run 以 `blocked-repeatedly` 结束。workspace-write 下命令还能在工作区写之后会在沙箱外执行的东西：`package.json` 的脚本、Makefile、`.husky/`、`lefthook.yml` 这类，你在终端里跑或点「在沙箱外重跑」时它们就执行；重跑只绑原文与 cwd、不绑脚本内容。
- 凭据清单与 `.ssh` 等读不到，gh、`npm publish`、`docker push` 这类用文件登录的拿不到登录态，要走「在沙箱外重跑」（Q20 B 的代价；开放问题 3）。macOS 上 gh 在沙箱里连 `gh --version` 都起不来（读 `~/.config/gh/config.yml` 报 EPERM，只拒 `hosts.yml` 也一样，P3）。2026-10-15 另加的几项（开放问题 6）同样有代价：用缺省位置的文件登录时，沙箱里 kubectl 连不了集群、1Password CLI 拿不到会话、vault 与 psql 的免密登录不生效、Hugging Face 下不了要登录的模型，都要重跑。`~/.cache/huggingface/token` 存在时，hf 在沙箱里连 `hf env` 这类不需要登录的命令也起不来（读它报 `PermissionError`、退出码 1；只有 `stored_tokens` 或两个都没有时照常；hf 0.34.4 先取环境里的 `HF_TOKEN`，有它就不读这个文件），清单里已经是这个文件本身，照 P3 的规则照留（plan 第 6 步，macOS 与 24.04 实测；`kubectl version --client`、`op --version`、`vault version`、`psql --version` 两平台都照常）。这几项只挡缺省位置的文件：`HF_HOME`、`KUBECONFIG`、`PGPASSFILE`、1Password CLI 的 `~/.op` 这类改了位置或用别的位置的挡不住；同类凭据放在环境变量里的（`GH_TOKEN`、`HF_TOKEN`、`VAULT_TOKEN`、`PGPASSWORD`、`OP_SERVICE_ACCOUNT_TOKEN`、`OP_SESSION_*` 这类），4a 照 02:1930 原样传给沙箱里的命令（shell-env 不按名字过滤你自己的令牌），这些工具在沙箱里照常能登录（连得上的话），任何沙箱命令也读得到这些令牌，白名单里的网站就是把它们带出去的路（「白名单即能力授权」）。Q20 B 的环境那一半在 06，且只管自动档下免问的命令。
- Linux 上没有「仅此路径」：文件违规只来自观测器、只作诊断。读被拒、不经代理的直连都不留违规（§afterExit、清理与违规），这类命令没有回执；观测器的路径与代理用户名都由沙箱里的进程控制，违规可以被错归到别的调用上（只会错归，放行不了什么）（开放问题 4）。观测到的写按事件到达时宿主上的样子判（读法 11）：命令删掉或挪走一个目录、在原处放一个指向外面的链接，而换的那一步用另一种拼法（工作区以链接给出时的另一种写法、`rename` 报的是另一头的名字）、或事件到达之前宿主上又变了，之后经它被拒的写可能被当成工作区内的写丢掉，没有回执、不计入连拦上限；和伪造观测器的行同类，只会少报，放行不了什么。
- Linux 姿态为 `no-seccomp` 时 Unix socket 不受限：上表另加的禁读挡住常见的几处（D-Bus 会话总线、docker.sock、X11、ssh-agent），别处的 socket 挡不住。观测器随 apply-seccomp 起，这时也没有，文件违规一条都不报，只剩代理的网络拒绝。
- macOS 上有几种后台进程在调用结束后收不掉（§执行与收口）：去掉了 `TENON_SANDBOX_MARK` 再脱身的（P6：带着标签的那种找得到、杀得掉，但命令可以先去掉它）；脱离了原进程组的 Apple 平台程序（`/usr/bin/perl`、`ruby`、`/bin/sleep`、`bash`、`zsh` 这类带平台签名的）：macOS 没有 `setsid` 命令，但脚本能自己调（perl、ruby 的 setsid），bash 的 `set -m` 起的后台任务、双重 fork 也能脱离原组，而 macOS 不让别的程序读平台程序的环境变量，标签看不到——正常结束后都收不掉，点停止时直接从命令里脱身的由子孙树杀得掉，先双重 fork 再脱身的（父进程链已断）也收不掉（第 6 步审查实测：setsid 出去的 perl 在调用结束 5 s 后还在；owner 2026-10-16 选 A，验收 15、不变量 13 照此收窄）。Homebrew 的 python、命令行工具里的 python 与 git（`/usr/bin/python3`、`/usr/bin/git` 会 exec 到它们）、fnm 装的 node 都不是平台程序，按标签找得到。这样留下的进程一直活着，直到它自己退出、你重启电脑或手动杀掉；沙箱的读写规则跟着它直到结束，Tenon 退出也一样（读不到凭据，保有原工作区的写权限）；Tenon 这次运行期间它还能经代理上网，拿得到之后任何会话的域名授权与用户白名单，Tenon 一退出它就断网（代理口令只在这次启动内有效）。
- 违规晚于结算窗口到达的只进日志（读法 9）。macOS 上 srt 的日志监听每个输出块只看第一条拒绝行，这一行是噪声或 `ignoreViolations` 行时整块扔掉、块里的真拒绝一起丢（§afterExit、清理与违规）；Tenon 给 macOS 的受限命令加 `OS_ACTIVITY_MODE=disable`，挡掉了最常见的那一种（diagnosticd 那行打头：第 6 步审查时每条命令被拒一次写，三轮 300 次丢 61 次，约两成，单轮 11%–40%；加了之后 60/60）。剩下两种照旧丢——不经代理的直连被拒（打头的是 curl 的 configd 那行，P2：50 次丢 5 次，约一成），同一块里有两条真拒绝时的第二条（从 srt 的读法推出，没实测）——会清空环境变量的子进程那一部分、自己删掉这个变量的命令也照旧会丢（与下一句同类）。被丢的那次拒绝本身照样生效，只是没有回执、不计入连拦上限。被拒操作的行里含 `mDNSResponder`（srt 自己恒丢）或 `ignoreViolations` 那两行的子串时也不留违规（srt 按子串比；路径由沙箱里的程序定，故意起这种名字就能让一次拒绝不进回执、不计数），拒绝本身照样生效。
- 主进程环境里的 `JAVA_TOOL_OPTIONS` 经 srt 原样进沙箱里的命令（srt 以它为底拼这个变量、盖住 `request.env` 里的同名值，§argv、shell、env 与 id）：这个值来自你启动 Tenon 时的环境、不是模型给的；Tenon 不从主进程的环境里删它，那会连带影响主进程起的别的子进程（如 MCP 连接器）。
- 「包管理器」预设生效时，Tenon 自己的那几个缓存目录（读法 46、49）被所有会话与文件夹里的沙箱命令共用：一条命令写进去的假缓存、`_npx` 里的包或 `CARGO_HOME` 里 registry 的源码（含 `build.rs`），会被之后别的会话里沙箱中的 `npm`、`npx`、`pnpm`、`uv`、`cargo` 取来执行——仍在沙箱里，带那条命令自己的写权限与白名单；你自己的缓存与沙箱外的工具不受影响。`~/.npmrc` 在凭据清单里（Q20 B），沙箱里的 npm、pnpm 读不到它，只记一行照常跑（npm 10.9.4 的 `@npmcli/config` lib/index.js:586-601、:549-553；P3、P4 实测）：里面配的镜像、代理、私有 scope 与 token 在沙箱里都不生效，连的是缺省的 `registry.npmjs.org`。工作区里 `.npmrc` 的 `registry=` 在沙箱里照样生效（P4：npm 去连了 `registry.npmmirror.com`），把镜像域名加进白名单是一条绕法；P4 里这样装仍失败（镜像回 403，原因没查），能不能装上未验证。

## 文档同步

**起草时改**（本 spec 同一 PR；改的句子带「2026-10-09 改 / 补，见 04」，已实现 spec 的正文一字不改）：

- 00、01、02、03 顶部各加一行 `Amended by`，正文不改（docs/spec-driven-dev.md:54）。
- `docs/architecture/master-reference.md`：:144、:420、:422 版本事实改 0.0.79 与 `>=22.12.0`（T3）；:919 阶段 4 标题的工期改为拆分与预算，注明是没有出处的估计、以检查点为准（Q1 A、裁决卡页头、picks.md）；:921 改为 MCP stdio server 暂不入沙箱、上游发布按命令网络白名单后另立，03:48、:278 的「按工作区拆进程」不做，档位与越出沙箱照 Q8 A（Q11 A、Q8 A）；:922 helper 放 asar 外与签名归阶段 7（Q2 A、T31）；:926 的「对齐 Cowork 本地模式」改为对照 Claude Desktop 的 Code 会话与 Claude Code、右面板挪阶段 5（T37、Q2 A）；:924 注明宿主↔沙箱双向映射挪 6b（Q2 A）；:929 DeepChat 指针改为 `agentFileSystemHandler.ts` 与 `acpPathGuard.ts`（T3）；:930 加「裁决结果（2026-10-09）」与拆分、编号对照、检查点，各条去向指向本 spec §主参考与 02 留下的各条的去向（T1）；:945 验收第一句改为「Tenon 的沙箱黑盒用例在 macOS 与 Linux CI 上全过」，第二句注明归 05（Q5 A）；:581、:641、:822 的本地 VM 对照加带日期补记（T37）。（2026-10-15 补：:581、:641、:822 的补记与 :926 的改写都照公开文档写准 Cowork 的执行位置，不写笼统的「已转云端」——Pro / Max 的新 Cowork 任务自 2026-10-06 起在云端运行，设置里的「Only on your computer」已移除（[15520349](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)）；已进合并体验的 Pro / Max 账号（合并自 2026-09-16 起按账号分批放量）任务只在云端、没有本地选项（[15811196](https://support.claude.com/en/articles/15811196-what-to-expect-with-claude-cowork-in-the-cloud)）；Team / Enterprise 仍有本地 VM 会话（[13455879](https://support.claude.com/en/articles/13455879-use-claude-cowork-on-team-and-enterprise-plans)、[14479288](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)）。对照对象不变，仍是 Code 会话与 Claude Code；本地会话与 Tenon 的隔离对比见 §已知限制「没有 hypervisor 级的隔离」。）
- `docs/reference/sandbox-runtime-mechanisms.md`：头部加一行 `Revisions`，记 :141、:294、:326 的勘误（含强制禁写锚在 srt 进程自己的 cwd）与补查三点的答案（T3），正文不改；2026-10-15 在同一行末补上仓库迁到 `anthropics/` 的一句。
- `AGENTS.md`:30：「sandbox-runtime alone would accept 20.11」改为 0.0.79 同样要求 22.12（T3）。
- `docs/ux/components.md` 的 `SettingsModal`（:68，一栏「权限与网络」）与 `BlockedNotice`（:143，回执不讲机制的文案规矩）、`docs/ux/parity-audit-2026-09-12.md`:246（同一规矩）加带日期补记：都是 owner 2026-10-15 的决定，起草时就写（原排在「实现时改」）。
- 同一 PR 另带 2026-10-15 的其余改动（:416 的 srt 仓库迁址之外都与 04 无关），第 22 步核对时一并认：owner 定的第三个例外写进 `docs/spec-driven-dev.md`（:39、:52、:54 原行内改）、`AGENTS.md`:11 镜像一句（:12 不改）；主参考 :271（MCP-UI 不采用）、:416（srt 仓库迁址）、:678、:892、:905（评测的 Claude Desktop 一列只作参考）、:740、:820、:1071、:1120（Chat 与 Cowork 合一）、:912（MCP stdio 探测的更正，03 正文不改）的带日期补记；`docs/evals/README.md` 与 `docs/evals/compare/00-2026-10-01-summary.md` 的注、`docs/reference/` 下 `claude-desktop-feature-map.md` 的修订节与 `deepchat-mechanisms.md` 的 :770、:772、parity 的头注（:3）、标「上游已变」的各行与 :326 的注（2026-09-28 补录与 B 列一样降为只作参考，owner 2026-10-15 定；注不加在 :324 的标题上，免得改掉 02 与 evals README 引用的锚点）、comp:42、:86、:103、:161 的补记；02 plan 验收记录第 55 行（02plan:1143）在原行末尾加的限定（Claude Desktop 一列只作参考之后，那一半待新协议重新取证；02 的 Status 仍为 implemented）。除 evals 两份与 feature-map（没有按行号引用它们的地方）外，行数都不变。

**实现时改**（列在 plan）：`docs/ux/parity-audit-2026-09-12.md`:51 注明「跑完自动降回」不做（Q8 A）；SECURITY.md 的已知限制；两份 locale 的新键；`NOTICE`:9 的 srt 仓库名照迁址改为 `anthropics/sandbox-runtime, formerly anthropic-experimental/sandbox-runtime`（第一段带上，2026-10-16）；`AGENTS.md`:51「`ci-ok` … passes only when `ci` and `e2e` both succeed」随 CI PR 加上 `sandbox-macos`。

**留给后续 spec**：parity:39、:230 与 comp:103 的跳过项（06，Q17）；comp:87、:103、:105、:138 的档位菜单、横幅与文件夹弹窗（06）；comp:137、:141 的「能否还原」（05）；comp:129-135 与其余 4d 界面（task-mode-ui）；主参考:945 第二句的落实（05）。

## 不变量

每条有一个名字带「04 不变量 N」的测试。

1. `packages/*/src` 与 `apps/desktop/src` 里调 `sandbox.wrap(` 的文件恰为 bash.ts、connection.ts、shell-env.ts，只有 Bash 会要 `full-access` 以外的档位；MCP stdio 与 shell-env 探测恒为 `full-access`。自检直接调 srt，不经 `HostSandbox.wrap`。
2. 命令不经包装运行，当且仅当它的 `SandboxRequest` 是 `full-access`；`DesktopSandbox` 从不把受限档直通。
3. `DesktopSandbox.wrap` 返回的 env：`full-access` 时恒等于 `request.env` 的拷贝；受限档时也等于它，只有三处例外——预设生效时，本平台预设表里的每个变量，与它不分大小写同名的键都去掉、换成恰好一个指向它那个目录或其下子目录的（「或其下子目录」lead 2026-10-16 定，已告知 owner，Revisions 2026-10-16 ⑧）；macOS 上另有恰好一个 `TENON_SANDBOX_MARK`；macOS 上与 `OS_ACTIVITY_MODE` 不分大小写同名的键都去掉、换成恰好一个 `OS_ACTIVITY_MODE=disable`（owner 2026-10-16）；此外不增不减任何键（读法 47，P4、P6）。
4. 交给 srt 的每份配置只含 §档位到 srt 配置 列的键、都过 `SandboxRuntimeConfigSchema`，写出 `network.allowedDomains`、开 `strictAllowlist`、`parentProxy` 为 `{ noProxy: '*' }`；initialize 不带 askCallback、第三个参数为真。
5. allowWrite 只含这次请求 `workspace` 的项与预设表里本平台的缓存目录（只在预设打开、你的档位为 workspace-write 时；预设从不加 `~/.npm`、`~/.cargo` 这类你自己的缓存目录）；没有一项来自模型的参数或命令输出。
6. denyRead 含 profile 目录、主目录的 `.ssh`、`.aws`、`.gnupg` 与凭据清单；denyWrite 含 denyRead 的全部条目，两档都含 `<userData>/sandbox-cwd`（启动时传了这个目录时），workspace-write 下还含每个根下的 Tenon 名字与 srt 的强制禁写名；每个拒绝条目以写下的拼法与真实位置两样出现（真实位置一路解到底：悬空链接跟到目标，链接目标里的链接也解），只有一个例外：macOS 上本身就是链接、解得开的条目，写下的拼法只在 denyWrite 里、不在 denyRead 里；解析时经过的每个链接（含链接目标里的）本身只在 macOS 的 denyWrite 里出现，不进 denyRead，Linux 上不出现（只进 lstat 比对）；allowWrite 只含真实路径；allowRead 至多含本会话的 `tool-output/<sessionId>/`。Linux 上已存在的禁读目录由 srt 拿空的 tmpfs 盖住，落在它下面的 denyWrite 只读绑定被跳过（linux-sandbox-utils.js:1415、:2438-2439），所以这类目录在沙箱里可写、写进的是那个临时的空目录，宿主上不变：「denyWrite 含 denyRead」对它们在 Linux 上靠 tmpfs，不靠只读绑定。
7. 每次成功的 `wrapWithSandboxArgv` 恰好对应一次 `cleanupAfterCommand`。
8. srt 收到的 commandId 两两不同、都不超过 100 个字符。
9. 一条命令执行时 srt 的白名单 = 用户白名单 ∪ 打开的预设 ∪ 这条命令所属会话（含继承）的域名授权；别的会话还有没收尾的调用时不换（至多等 2 s）。杀不到的残留进程不在此列（§已知限制）。
10. `tool/receipt_override` 只由 `release` 写入，目标必在那次调用记下的违规里；重跑放行从不针对 `anyProtected` 为真的调用。`protected` 是界面提示，越出沙箱的闸是第 18 条的卡。
11. 每条一次性放行至多被一次判定绑定。
12. kernel、contracts、renderer 不 import srt；代理口令不出现在 Tenon 自己写的日志、Tape 事实字段与任何 IPC 应答里（命令自己的输出里可能有，比如它跑了 `env`；口令只在这次启动内有效）。
13. 点停止后 1 秒内，这条命令的进程（含后台与 setsid 出去的）都已不在；正常结束的调用，结束时它的进程组为空，macOS 上 `ps -E` 读得到这次 `TENON_SANDBOX_MARK` 的进程与它们各自的进程组也都已不在（P6）。不在此列的（§已知限制）：去掉了标记再脱身的；macOS 上脱离了原进程组的 Apple 平台程序——正常结束后的都算，停止时先双重 fork 再脱身的也算（owner 2026-10-16 选 A，照 P6 预案收窄）。
14. 进模型的违规行都是 JSON 字符串，一个块不超过 20 行。
15. 只带 `observed` 的违规（Linux 观测器的行与清单里的无对象行：不带地址的出网行、`mach-lookup`、`sysctl-read`、`network-bind`，读法 53）不会让来源变成 `sandbox`，不计入 `MACHINE_DENIAL_CAP`；清单以外的操作与认不出的行不带 `observed`；Linux 观测器报的、目标在到达时已是目录的 `mkdirat`（x64 上还有老式 `mkdir`）不进任何结果。
16. 来源为 `sandbox` 的调用一定已派发、状态 `completed`。
17. `isBlockedFetchAddress` 对 `100.64.0.0/10` 内的地址为真，对其外相邻地址为假。
18. 绑定了重跑的 Bash 判定一定出卡、主原因 `elevated`，任何会话授权都免不掉；不可用时的判定，只有在同样不可用时的卡上给的本会话命令授权能免卡，在沙箱档的卡上给的不能。
19. host 从不自动把推理端点（任何厂商的 API 域名、你配的自建网关与 provider 端点）、MCP server 的地址或遥测端点加进命令的生效白名单：生效白名单恰为不变量 9 的三样之并，预设表里只有包仓库的域名（2026-10-15 补）。

## 验收标准

全部通过才能标 implemented。1–33 每条至少有一个标题含「04 验收 N」的测试（10–16 在两个平台各跑一遍）；34–37 的证据分别是 CI 运行链接、评测记录、git diff 与干净 clone 的命令输出。路径前缀：K = `packages/kernel/test`，C = `packages/contracts/test`，D = `apps/desktop/test`，E = `apps/desktop/e2e`。标〔两平台〕的是黑盒用例，只在沙箱真能起的机器上跑（macOS 不在 agent 沙箱里；Linux 装了 bwrap、socat、rg 且 userns 放开），跑法见 plan「开工前读」（读法 24）。

### 依赖、启动与退出

1. desktop 依赖 srt 恰为 `0.0.79`；kernel、contracts、renderer 不 import 它；交给 srt 的 `seccomp.applyPath` 与 `javaAgentJarPath` 指向 node_modules 里真实存在的文件（T2、T31）。〔D/sandbox/setup.test.ts〕
2. 姿态：启动不挡窗口；initialize 在 macOS 与 Linux 的第三个参数都为真；它以依赖错误抛出 → `unavailable` 带对应原因码（夹具是 srt79 的原文），别的抛错 → `init-failed`；之后 `checkDependenciesAsync()` 只有 warning → `degraded`；helper 文件缺失 → `unavailable`、不调 initialize；macOS 上 initialize 抛错、sandbox-exec 检查退出 71 → `nested-sandbox`；自检失败 → `unavailable`（退出码 71 记 `nested-sandbox`；Linux 读数表示 userns 受限或 stderr 含 apply-seccomp 的 `nested userns is capability-restricted` 时记 `userns-restricted`）；自检里往外写成功了也记 `self-test-failed`；win32、WSL1 不调 initialize；Linux 的三个 sysctl 读数进详情；任何路径都不执行 sudo；initialize 之前主进程已 chdir 到 `<userData>/sandbox-cwd`（是链接、属别的用户或不是 0700 → `unavailable`/`init-failed`、不调 initialize，不存在就建），不传目标目录（评测进程）时不 chdir（T4、T12、T32、Q4、Q6、读法 50）。〔D/sandbox/posture.test.ts，假的 srt 模块与 chdir 端口〕
3. 退出：before-quit 第 4 步之后调一次 reset、最多等 2 s；reset 抛错只进日志；没 initialize 过不调；被信号 reset 过之后姿态为 `unavailable`、`reasons()` 为 `init-failed` / `reset by a signal`、`dispose` 不再等；调过 initialize（含它以依赖错误以外的原因抛错之后）收到 SIGTERM 或 SIGINT 经 `app.quit()` 走 before-quit 退出，没调过或依赖检查那一步抛错时不注册（T4、P8）。〔D/shutdown.test.ts、D/sandbox/desktop-sandbox.test.ts〕

### 包装契约

4. `full-access` 原样返回 argv 与 env 的拷贝、不碰 srt；受限档在 `unavailable` 或初始化 15 s 没完成时抛 `SandboxUnavailableError`；`argv[0]` 不是 zsh、bash、sh 的绝对路径时抛 `SandboxUnavailableError`；`/tmp/claude` 是链接、属别的用户或不是 0700 时拒绝，不存在就建；预设生效时 Tenon 的 npm 缓存目录照同样的条件核对、不存在就建，预设关着时不碰它；启动时 chdir 过的 `<userData>/sandbox-cwd` 在启动之后被删掉、换成链接或改了权限时，受限档同样拒绝（00:161、读法 3、5、41、48、50）。〔D/sandbox/desktop-sandbox.test.ts〕
5. 配置：read-only 的 allowWrite 为空；workspace-write 为本次 `workspace` 的每一项（literal；预设生效时另加 Tenon 的 npm 缓存目录，见验收 29）；denyRead、allowRead、denyWrite 照 §档位到 srt 配置（含 denyRead 进 denyWrite、传了 chdir 目录时两档的 denyWrite 都有 `<userData>/sandbox-cwd`、不传（评测宿主）时没有、每个根下的 srt 强制禁写名、Linux 上 `.git` 不是目录时不加那两项）；`allowedDomains` 恒在、`strictAllowlist` 为真、`parentProxy` 为 `{ noProxy: '*' }`；键只有列出的那些、每份都过 `SandboxRuntimeConfigSchema`；文件夹名带 `*?[]` 的照 literal 传。期望的名单在测试里逐项写成字面量，不调被测函数算（T5、T13、T14、T33、Q20）。〔D/sandbox/config.test.ts〕
6. env：子进程看到的环境 = `request.env` 加 srt 自己的变量；预设生效时另有预设表里本平台的每个变量、各恰好一个、值为它的目录或其下子目录（`request.env` 里的 `NPM_CONFIG_CACHE` 这类别的拼法不在），预设关着时 `request.env` 里的照原样（开放问题 5 A、读法 47）；macOS 上另有恰好一个 `TENON_SANDBOX_MARK`（P6）与恰好一个 `OS_ACTIVITY_MODE=disable`（`request.env` 里别的拼法不在；owner 2026-10-16）；预先放进主进程 `process.env` 的哨兵变量、`TENON_*` 与 `ELECTRON_RUN_AS_NODE=1` 都看不到（哨兵不用 `JAVA_TOOL_OPTIONS`、`CLAUDE_CODE_TMPDIR`、`CLAUDE_TMPDIR` 这几个 srt 自己取的名字）（T6）。〔两平台；D/sandbox/escape.test.ts〕
7. argv：含空格、单双引号、`$`、反引号、换行与非 ASCII 的参数在沙箱里逐字节到达（T7）。〔两平台；escape〕
8. id：同一 tool-use id 先后两次 wrap，srt 收到的 id 不同、都以它开头、都不超过 100 字符；第二次的违规里没有第一次的（假的违规存储照 srt 只比前 100 个字符）；一条命令的大量观测器正常写挤不掉它的一条真拒绝（T8、读法 39）。〔D/sandbox/desktop-sandbox.test.ts〕
9. 清理：正常退出、超时、停止、spawn 失败、wrap 之后被停止没起进程，五条路各恰好一次 `cleanupAfterCommand`（断言次数为 1，多调与少调都红）；Linux 上 `afterExit` 之后宿主上没有挂载点文件；启动时，记下的主进程已不在、进程表里又没有在跑的 bwrap，才按 `stubs.json` 删掉记下的、仍为空目录的挂载点与仍满足 srt 四个条件（普通文件、大小 0、没有写位、nlink 为 1）的叶子挂载点，否则它们留在记录里等下次启动（有 bwrap 在跑、读不到进程表都算）；记下的主进程已不在时，杀掉记下的、pid 与命令行一字不差而父进程不是那个主进程的 socat（父进程为 1 或别的 subreaper 都算），删掉记下的 tmpdir 条目；记录之外的同名条目、不满足四个条件的文件、别的 srt 使用者在 initialize 期间建的 `srt-obs-*` 与 `claude-empty-*` 都不碰（T9、P7）。〔D/sandbox/desktop-sandbox.test.ts、D/sandbox/posture.test.ts、K/loop/sandbox-bash.test.ts；Linux 那半在 escape〕

### 沙箱黑盒（Q5 A）

10. 工作区外写被拒、宿主上没有那个文件；工作区内写成功；read-only 档下工作区内写也被拒；事先没有 `/tmp/claude` 时 `mktemp "$TMPDIR/x.XXXXXX"` 照样成功（macOS 上裸 `mktemp` 不认 `TMPDIR`、被拒，P1，见已知限制）。〔两平台；escape〕
11. 符号链接：经工作区里指向外面目录的链接写被拒；经指向测试主目录 `.ssh` 的链接读被拒；拒绝条目本身经过链接时（测试主目录的 `.aws` 是指向另一个目录的链接、凭据清单里一个文件所在的目录是链接），按链接的拼法与按真实位置读、写都被拒（Linux 上写进已存在的禁读目录的，在沙箱里落进临时的空目录、命令结束就丢，宿主上不变，见不变量 6），而那个上级目录里不在清单里的文件照常读得到、工作区内（工作区就是测试主目录时含经那个链接目录写）照常可写；macOS 上这样的读写被拒在真实位置（写带 `protected`），删掉或挪走 `~/.aws` 这个链接本身被拒、带 `protected`；拒绝条目是悬空链接时（`~/.aws` 指向还没建的 `~/dotfiles/aws`，工作区是测试主目录），沙箱里建不出目标与它缺的上级目录，经链接与按真实位置都写不进，宿主上什么都没留下；拒绝条目的链接目标里还有一层链接时（`~/dotfiles` 指向主目录外的目录），删掉再重建那一层在 macOS 上被拒、链接与目标不变，在 Linux 上调用结束后有一条 `target` 为它、带 `protected` 的违规、原目标不变；工作区根的 `.envrc` 是指向外部文件的链接时，`rm .envrc && echo x > .envrc` 与 `mv .envrc x && echo x > .envrc` 在 macOS 上都被拒、宿主上的链接与目标不变，在 Linux 上调用结束后有一条 `target` 为它、带 `protected` 的违规（各平台照第 6 步实测的结果，§档位到 srt 配置「链接」）。〔两平台；escape；比对那半在 D/sandbox/desktop-sandbox.test.ts〕
12. 保护名单：读测试主目录 `.ssh`、`.aws`、`.gnupg` 与测试 profile 目录里的文件被拒，读本会话 `tool-output` 成功；写工作区根的 `.envrc`、`.claude/settings.json`（事先不存在）、`.zshrc`、`.git/hooks/x`、`.mcp.json`、`.vscode/tasks.json` 被拒，命令结束后宿主上没有写进去的内容；工作区不在测试进程的 cwd 之下；工作区就是测试主目录时，写 `.ssh/authorized_keys` 与 `Library/LaunchAgents/x.plist` 也被拒（Linux 上已存在的 `.ssh` 是空 tmpfs：写在沙箱里成功、命令结束就丢，宿主上不变，见不变量 6）；macOS 上（不分大小写的卷）写事先不存在的 `.ENVRC`、`.Claude/settings.json` 也被拒（P1，不另传 glob）（T13）。〔两平台；escape〕
13. 凭据清单：清单里每个路径（在测试主目录下造出）在沙箱里都读不到（Q20 B）。〔两平台；escape〕
14. 网络（客户端以 `curl --noproxy '' -x "$HTTP_PROXY"` 强制走代理，另注明的除外）：白名单里的 `127.0.0.1:<端口>` 连得通；同主机别的端口、白名单外的主机名被拒且各有一条 network 违规；只写了 `127.0.0.1:<端口>` 时 `localhost:<端口>` 被拒（名字不在白名单），白名单加上 `localhost:<端口 2>` 后 `localhost:<端口 2>` 连得通；认 `NO_PROXY` 的默认 curl 连白名单里的 `127.0.0.1:<端口>` 失败（直连被拒，即 `allowLocalBinding` 没开）；连测试自己建的 Unix socket 失败；`updateConfig` 热加一条之后下一次连接成功、不 reset；代理按请求的目标判、不按 `Host` 头：`CONNECT <白名单外主机>:<端口>` 带上 `Host: <白名单里的主机>` 被拒，明文 HTTP 的绝对形式请求按 URL 里的主机判、`Host` 头写成白名单里的主机也被拒（srt79 dist/sandbox/http-proxy.js:225-234、:439-444；这一条测的是 srt 的行为，升级时是回归用例）（Q9、T18、T38、T42）。〔两平台；escape〕
15. 停止：命令留下 `&` 的孙进程与 setsid 出去的进程，点停止后 1 秒内宿主进程表里找不到带标记的进程；正常结束的命令留在后台的进程（含 setsid 出去的）在调用结束时同样不在——macOS 上这一半只对 `ps -E` 读得到标签的程序（非 Apple 平台程序，如 python3）与它们组里的进程（含它们起的 Apple 平台程序）成立，setsid 出去的 Apple 平台程序（perl）正常结束后仍在，有一条用例记下这个现状（修好了它会红）；双重 fork 成守护进程的不在此列（T11、主参考:905、P6；owner 2026-10-16 选 A）。〔两平台；D/stop-tree.test.ts〕
16. 违规：macOS 上上面每个被拒的读、写与连接（Unix socket 除外）都在 `violations()` 里——一个日志块只取第一条，`OS_ACTIVITY_MODE=disable` 管不到的直连（P2 直连 50 次丢 5 次）与一块里的第二条（从 srt 的读法推出，macos-sandbox-utils.js:1168-1172，没实测）照旧会丢，每个这类用例最多跑三次、取任一次（P1 那次读 `.ssh` 被拒没留行是另一种：当时没设这个变量，块里只有这一条真拒绝，按 srt 的读法只能是打头那行被当噪声扔掉，2026-10-16 更正）；macOS 上只被拒一次写的命令连跑 50 条、不重试，每条都留下那一行（产品自己的环境，不另加测试条件；owner 2026-10-16）；Linux 上被代理拒的连接与工作区外、保护名单的写在里面（读、直连与 Unix socket 都不留违规），观测器报的带 `observed`、按真实落点判：经工作区里指向外面的链接的写留下、`target` 是外面的真实位置，工作区以链接的拼法给出时照这个拼法的正常写不出现，工作区里的正常写不出现，`mkdir -p` 对已存在目录报的 `mkdirat`（x64 上还有 `mkdir`）也不出现；macOS 上清单里的无对象行（不带地址的出网行、mach-lookup）带 `observed`，清单以外的操作与认不出的行不带；对象与分类照 §afterExit、清理与违规（T10、T41、读法 11、53）。〔两平台；escape〕

### 判定、执行与收口

17. 档位计划：姿态 active、档位 workspace-write 时计划为 workspace-write，wrap 收到本会话的文件夹；改成只读后下一次判定的计划为 read-only；没有 `posture` 的宿主照 02，02 的 Bash 测试除 bash.test.ts:351（点名 (c)）外不改断言照过。〔K/loop/sandbox-bash.test.ts〕
18. 不可用：命令卡主原因仍是 `command`、facts 带 `sandbox: 'unavailable'`，卡上那一句中英文都有；计划为 full-access 带 `unavailable`，wrap 收到 `full-access`；生效时授权过的同一条命令在不可用时仍出带那一句的卡；`pending` 时判定、wrap 时不可用的调用照 `notStarted` 收口，下一次判定计划 full-access；`pending` 时的启动恢复保留卡上那一句（Q6 A、读法 37、38）。〔K/loop/sandbox-bash.test.ts、K/loop/recovery.test.ts、D/renderer-approval-card.test.ts〕
19. 收口：有违规的命令状态 `completed`、`kernelAuthored` 为假，输出之后多一个文本块（说明 + `<sandbox_violations>`、每行 JSON 字符串、最多 20 行加条数），输出大到落盘时这个块仍在结果里；来源 `sandbox`、facts `{ toolName }`、`tool_outcome.sandbox` 列出对象；只有 `observed` 的来源为 null、仍有 `sandbox` 成员，只带没有对象的行的成功命令（如 macOS 上只多一条不带地址出网行的 `npm install`）也是这样；停止与超时的来源不变（T10、T41、读法 53）。〔K/loop/sandbox-bash.test.ts〕
20. 计数：同一条命令靠本会话授权连着三次跑出违规，Run 以 `blocked-repeatedly` 结束；中间问过人重新计；只有 `observed` 的不计——连着三次只带清单里的无对象行的命令，Run 不因此结束（T41、读法 53）。〔K/loop/sandbox-bash.test.ts〕
21. 域名放行：点回执上的主机名写一条 `tool/receipt_override`；再点回 `already-released`；目标不在回执上、调用没有 `sandbox` 成员回 `stale`；之后本会话与它的子会话每次 `beforeWrap` 的 hosts 含它，别的会话不含；放行发生在本会话命令跑着时立即 `grantsChanged`；重启后照样（Q9 A、T18）。〔K/session/receipt-override.test.ts〕
22. 重跑放行：同一会话、原文与 cwd 都相同的下一次判定绑定它，主原因 `elevated`、计划 full-access；有本会话命令授权也出卡；再下一条同样的命令回到沙箱；`anyProtected` 为真时回 `stale`（保护名单那条排在第 21 条之后也一样）；读凭据清单被拒的照样能重跑；重新判定沿用绑定；被拒绝后不退回；没绑定的在点击后第一个 Run 结束时作废（Q8 A、T17）。〔K/session/receipt-override.test.ts〕
23. 路径放行：同上但计划 workspace-write、wrap 的 workspace 多出那个路径；档位为只读时只有那个路径；`observed` 与保护名单的路径回 `stale`；`chmod 700 ~` 这类落在主目录上的违规、已存在的目录、文件名带换行的都不给按钮；`workspace` 里有一项不属于会话文件夹、又是主目录或它的上级时，host 拒绝这次 wrap（T43、读法 35）。〔K/session/receipt-override.test.ts、D/sandbox/desktop-sandbox.test.ts〕
24. 告诉模型：放行之后的下一个检查点写一条 `message/sandbox_release`、列出还没宣告的放行（JSON 字符串），作为 user 消息进下一次请求、不渲染；压缩之后补写仍有效的；`PROMPT_LAYER_VERSION` 为 11、哈希已更新（T35）。〔K/session/receipt-override.test.ts、K/prompts/version.test.ts〕
25. 其余调用点：shell-env 探测以 `full-access` 请求，算出的基础环境里没有 `SANDBOX_RUNTIME`、`HTTPS_PROXY`、`ELECTRON_RUN_AS_NODE`（登录 shell 输出了它也去掉），`TMPDIR` 不是 `/tmp/claude`；MCP stdio 照旧 `full-access`、`workspace: []`，03 验收 9 不改断言照过（T6、Q11 A）。〔D/shell-env.test.ts、K/mcp/pool.test.ts〕

### 出网

26. CGNAT：URL 字面 `100.64.0.1` 第 2 层拦下；主机名解析到 `100.64.x.x` 以 `protected` 拒、0 次连接；`100.63.255.255`、`100.128.0.1` 照放；点名 (i) 列的三条旧断言改为拦下；03 公网 server 的跨源发现地址解析到 `100.64.x.x` 时 0 次请求；provider 端点的 `reachOf` 不变（T16）。〔K/permission/fetch-address.test.ts、D/fetch-untrusted.test.ts、D/mcp-host.test.ts、D/endpoint.test.ts〕

### 配置、白名单与界面

27. config.json：没有 `sandbox` 键的旧配置读作缺省、其余键不变；坏的域名条目只丢自己（档位与预设照留）；超过 256 条的只留前 256 条、记一行日志；写入在锁内、经临时文件改名（§对 01 的修补）。〔D/profile.test.ts〕
28. 白名单校验：拒裸 `*`、`*.com`、带协议或路径的、不带方括号的多冒号写法、不带端口的回环与私网 IP 字面量、不带端口的 `localhost` 与以 `.localhost` 结尾的名字、第 257 条；一组样例里 Tenon 的 schema 接受的，srt 的 schema 全都接受（T18）。〔C/sandbox.test.ts、D/sandbox/allowlist.test.ts〕
29. 生效白名单：设置里增删、勾预设，下一条命令起生效，只调 `updateConfig` 不 reset；预设勾上时本平台预设表里的域名进白名单，各行的目录在 workspace-write 档可写、命令环境带各行的变量，只读档两样都没有，`~/.npm`、`~/.cargo` 两档都不进 allowWrite；`sandbox.setSettings({ profile: 'read-only' })` 之后不重启，`posture().profile` 即为只读、下一次 Bash 的 wrap 收到 read-only（Q10、T18、T33；开放问题 5 A，读法 46、47）。〔D/sandbox/allowlist.test.ts、D/sandbox/config.test.ts〕
30. 设置弹窗只加一栏「权限与网络」：白名单增删、校验错误就地显示、预设复选框、白名单的说明；姿态 `active`、`pending` 时不显示状态（接缝 `fake` 下显示一行测试接缝，`reasons` 带 `test-seam`），`degraded`、`unavailable` 时显示一行状态与原因、展开是每个原因码的修法；「高级」里的档位单选写进 config.json（T39，owner 2026-10-15）。〔D/renderer-sandbox.test.ts、E/sandbox.spec.ts〕
31. 拦截回执：按钮照 §回执上有什么 出与不出（`localhost`、IP 字面量、`malformed host` 不给域名按钮）；每个按钮下面有一行写明它什么时候生效、多给了什么、没用上什么时候作废；「为什么」按类出句（公网 IP 与本机、内网地址各是各的句子；文件违规只按 `release` 与 `protected` 分三类，读凭据被拒与落在主目录上的写同一句）；「拦下了什么」只在 `release: 'path'` 时写「写入」，其余文件违规写「访问」；有 `sandbox` 成员的回执不渲染 `blocked.<source>` 与 `blocked.told`；只带 `observed` 的调用也出回执、不去查 `blocked.null`；违规全带 `observed`、退出码为 0 的调用回执只作提示、没有「允许这条命令下次不受限制地运行一次」，同样的违规而退出码非 0、或多一条不带 `observed` 的违规时照给（开放问题 7 A）；点过变「已放行」；路由对伪造的目标回 `stale`（parity:246、T39）。〔D/renderer-sandbox.test.ts、D/sandbox-routes.test.ts、E/sandbox.spec.ts〕
32. 端到端（`fake` 接缝）：命令被拦 → 回执 → 点「在这个任务里允许连接 <主机名>」（本次放行）→ 下一次请求带那条放行说明、生效白名单含它；点「允许这条命令下次不受限制地运行一次」（在沙箱外重跑）→ 点击本身不起命令 → 模型重发同一条命令时过 `elevated` 卡 → 它以 `full-access` 起、再下一条回到沙箱（Q8、Q9）。〔E/sandbox.spec.ts〕
33. 文案：新增的原因码、回执按钮、卡上那句、设置项在 zh-CN 与 en 都有非空文案；回执与 `elevated` 卡的键（连同 `blocked.sandbox`、`closure.sandbox`）在 zh-CN 里不含「沙箱」「模型」、在 en 里不含 sandbox、model（不分大小写；§回执上有什么）；新界面纳入 00 验收 12 的双语不换行不截断回归。〔D/copy-coverage.test.ts、E/text-fit-04.spec.ts〕

### 验证与收尾

34. CI：钉住镜像的 macOS job 与 ubuntu job 在 `TENON_SANDBOX_TESTS=required` 下跑验收 6、7、10–16 的用例全过，姿态为 `active`（`degraded` 算失败）；CI 里没设这个变量（也没显式写 `skip`）时套件失败而不是跳过（Q5 A，主参考:945 改后的第一句）。〔.github/workflows/ci.yml，owner 合并之后〕
35. 评测：提示层 11 的基线记录在沙箱生效的机器上跑齐（02:2956），`evals:gate` 绿（T35、T40）。
36. 文档：§文档同步「起草时改」的各处都在，00–03 正文不变（git diff 核对）。
37. 干净 clone 上 install、build、lint、typecheck、test、`evals:gate`、`test:e2e` 全过；§不变量 每条有测试；仓库、Tape、日志、plan 里没有代理口令与任何机密的值；两平台各有一条 S 用例：真 wrap 一条命令、再让一次 spawn 在 wrap 之后失败，从 srt 的 `getProxyAuthToken()` 取口令，断言它不在任何日志行、Tape 条目、工具结果与错误信息里。

主参考 §13 阶段 4 的验收（:945，按 Q5 A 改后）对照：第一句 = 验收 34（用例为 6、7、10–16）；第二句归 05。「停止后 1 秒内无子进程」在真包装下 = 验收 15。

## 开放问题

1–5 owner 已于 2026-10-14 定（picks.md「04-sandbox spec 的开放问题」；规则已写进正文与 plan，留在这里备查）；6–8 是 2026-10-15 两次审查后列出的，owner 同日经问卷逐条答复，都取 A（下面各标已定；6、8 原从「都按推荐」推出取 A，问卷确认；plan 的 Open 同记）。

1. **Linux 实测用什么机器、能不能挪后**（owner）：picks.md 要求凭据清单、预设域名、Ubuntu 26.04 的 seccomp 层、信号、`kill(-pgid)`、残留挂载点在写 spec 时实测；起草所在的 agent 沙箱里两样都做不了（嵌套 sandbox-exec 必然失败，也没有 Linux），所以 plan 把它们排成 spec 改 `ready` 之前的探针 P1–P8。macOS 部分在沙箱外照常跑完再改 `ready`；Linux 部分要真 Linux（Ubuntu 24.04 与 26.04），Docker 容器不算。推荐：在这台 Mac 上用 Lima 起两台虚拟机（`limactl start template://ubuntu-24.04` 等），owner 装好后 agent 在里面跑，跑完再改 `ready`；否则 owner 明确接受 Linux 部分挪到 workflow PR 的 CI 上跑、第一段先按 plan 写的保守分支做。什么时候定：spec 改 `ready` 之前。 **已定（owner 2026-10-14）：A，照推荐。Linux 探针在这台 Mac 上用 Lima 起 Ubuntu 24.04 与 26.04 两台虚拟机跑，跑完再改 `ready`，不挪 CI；macOS 探针由 Claude 在 agent 沙箱外跑——只对跑探针的那几次 Bash 调用关沙箱，owner 逐次确认弹窗；探针都在仓库外 probes/ 下、用临时 HOME，不碰真实凭据。plan「开工前读」与「探针」照此改。**
2. **macOS CI job 跑多少**（owner）：推荐只跑沙箱套件与停止用例（验收 6、7、10–16），其余单测已在 ubuntu 跑；要整套也在 macOS 跑就多花一倍 runner 时间。什么时候定：workflow PR 之前。 **已定（owner 2026-10-14）：A，照推荐，macOS job 只跑验收 6、7、10–16；plan 第 21 步照此。**
3. **读凭据被拒能不能「在沙箱外重跑」**（owner）：Q8 A 写「保护名单内的拦截不给这个按钮」，T13 把 `.ssh`、`.aws`、`.gnupg` 与凭据清单都写在「保护名单」一题里，而 Q20 B 接受的代价是「gh、npm publish、docker push 拿不到登录态，要你走 Q8 的越出沙箱」，Q8 D 的代价也说裸 ssh 要靠越出。三处只能同时成立一种读法。A（推荐，本稿照此写）：不给任何按钮的保护名单 = 02:2104 的 profile 目录与 shell 配置，加 denyWrite 的全部名字；读 `.ssh`、`.aws`、`.gnupg` 与凭据清单被拒不给「仅此路径」、但给「在沙箱外重跑」（卡一定出，读法 15、36）。B：只有 Q20 B 的凭据清单给重跑，`.ssh` 等三个照保护名单——走 ssh 的 `git push` 与裸 ssh 在 Tenon 的命令里完全用不了。C：所有 denyRead 都不给重跑——Q20 B 的代价改成「gh、npm publish、docker push 在 Tenon 的命令里用不了」，删掉 §已知限制 那一句。什么时候定：spec 改 `ready` 之前。 **已定（owner 2026-10-14）：A，照推荐，正文原已照写（读法 36）。讲解时提过的「对本来就要问的命令，审批卡上直接给在沙箱外运行」没经审查，未采纳。**
4. **Linux 上读被拒没有回执**（owner）：Linux 只报代理的网络拒绝与观测器的写，读 `.ssh`、凭据清单被拒、不经代理的直连都不留违规，这类命令没有回执，也就拿不到「在沙箱外重跑」。A（推荐）接受，写进已知限制，Linux 上要越出就请你自己在终端里跑；B Linux 上退出码非 0 且没有违规的命令也出一个只有「在沙箱外重跑」的回执（每个失败的测试都会出，噪声大）。什么时候定：spec 改 `ready` 之前。 **已定（owner 2026-10-14）：A，照推荐，正文原已照写（§已知限制）。**
5. **「包管理器」预设让 `~/.npm` 可写**（owner）：Q10 A 定的是「加了预设时对应缓存目录可写」。`~/.npm/_npx` 里是 npx 装好、之后直接执行的代码，03 的连接器常用 `npx -y` 起、不进沙箱（Q11 A），你终端里的 npx 也从这里跑；`_cacache` 还能被写进伪造的缓存。沙箱里的命令改了它，就等于在沙箱外执行。A（推荐）沙箱命令改用 Tenon 自有的缓存目录（profile 之外，如 `<userData>/sandbox-cache/npm`），只在受限档的环境里加 `npm_config_cache` 这类变量、只让它可写——要在 T6「只叠 srt 要求的变量」上开一个例外；B `~/.npm` 照样可写，另把 `~/.npm/_npx` 写进 denyWrite——沙箱里的 `npx` 装不了新包；C 照 Q10 A 原文，写进已知限制。在定之前本稿照 C 写（预设默认不勾）。什么时候定：spec 改 `ready` 之前——选 A 时那个变量只能由 `DesktopSandbox.wrap` 加，不变量 3（返回的 env 恒等于 `request.env`）、验收 6 与第一段的第 2、4 步都要跟着改。 **已定（owner 2026-10-14）：A。目录是 `<userData>/sandbox-cache/npm`，变量与 allowWrite 同一个条件（预设打开、你的档位是 workspace-write），每次加它的 wrap 前照 `/tmp/claude` 核对，P4 的别的管理器同理——读法 46–49，owner 同日全收；§档位到 srt 配置、§argv、shell、env 与 id（含 `DesktopSandbox.wrap` 第 2 步）、§网络白名单、§已知限制、不变量 3 与 5、验收 4、5、6、29 与 plan 第 2、4、6、13c 步、P4 已照改。picks.md 原误记为「profile 下的目录」，已于同日更正为本题 A 的原文「profile 之外」（profile 在 denyWrite 里、srt 的 denyWrite 压过 allowWrite，放不进去，读法 46）。沙箱里读不到 `~/.npmrc`、国内镜像不生效：owner 同日定先接受，「镜像地址」设置记进 plan 的 Open。**
6. **凭据清单 2026-10-15 新增的几项收不收**（owner）：整个 `~/.kube`、`~/.config/op`、`~/.vault-token`、`~/.pgpass` 与 Hugging Face 的 `token`、`stored_tokens`（§档位到 srt 配置）是 Tenon 自己加的，与读法 22 同类，不在 owner 2026-10-15 的决定里。A（推荐）收下：都是各工具公开文档写的缺省凭据位置，代价是沙箱里这些 CLI 用文件登录时拿不到登录态、要重跑，而放在环境变量里的同类令牌挡不住（§已知限制）；plan 第 6 步照 P3 的规则实测，不需要登录的命令坏了就收窄。B 不收：从本 spec、plan 第 2、6 步删掉，Q20 一行回到 P3 的定稿。什么时候定：spec 改 `ready` 之前。 **已定（owner 2026-10-15 经问卷确认）：A。这几项收下，规则已在正文；第 6 步照 P3 的规则实测、不需要登录的命令坏了再收窄。**
7. **只带 `observed`、退出码为 0 的调用，回执给不给「允许这条命令下次不受限制地运行一次」**（owner）：53 B 之后，macOS 上一次成功的 `npm install` 只带一条不带地址的出网行，仍出回执、`anyProtected` 为假，还给这个按钮，等于每条成功的包管理命令都在引你到沙箱外运行。A（推荐）这类调用的回执只作提示、不给这个按钮；退出码非 0 或至少一条不带 `observed` 时照现规则（验收 31 加一条，plan 第 18 步加突变）。只动界面上出不出按钮，不动契约。B 照现规则。什么时候定：plan 第 18 步之前；定之前本 spec 照 B 写。 **已定（owner 2026-10-15 经问卷定）：A。违规全带 `observed`、退出码为 0 的调用，回执只作提示、不给这个按钮；退出码非 0 或至少一条不带 `observed` 时照现规则。规则已写进 §回执上有什么（退出码怎么看也在那里），验收 31 加了这一条，plan 第 18 步加了突变；契约与 kernel 的核对不变。**
8. **53 B 的范围收紧**（owner）：owner 选的 53 B 是「没有对象的行一律带 `observed`」。审查后收紧了两处，本稿照收紧后的写：一，读法 44 认不出的行不带 `observed`、照旧计数——进程名由沙箱里的程序定，改个带括号的名字就能让整行认不出，不能借此退出连拦上限；二，认得出格式的无对象操作只有封闭清单（不带地址的出网行、`mach-lookup`、`sysctl-read`、`network-bind`）带 `observed`，`appleevent-send`、`process-exec*`、`signal`、`iokit-open` 这类多是试探能不能出沙箱的照认不出的处理（§afterExit 的表）。A（推荐）照收紧后的写。B 回到选时的字面，两类都带 `observed`、不计数：代价是这类试探不进上限，06 的 Q18 A 让沙箱内命令免问之后只剩步数上限兜底。什么时候定：spec 改 `ready` 之前；选 B 就改 §afterExit 的表、不变量 15、验收 16 与 plan 第 3 步。 **已定（owner 2026-10-15 经问卷确认）：A。照收紧后的写，§afterExit 的表、不变量 15、验收 16 与 plan 第 3 步已是这样；06 的 Q18 A 落地前复核读法 53 的不计数（§主参考与 02 留下的各条的去向 ③）。**

## 被否决的方案

每条「理由；改判」，理由取自裁决卡各选项的代价。

- **Q4 B 接 srt-win alpha / C 命令进 WSL2**：每台机器一次 UAC、跑着的命令会掉授权、代理口令同机可读；C 要求装 WSL2 并做路径映射；改判：Windows 进验收那一阶段再议。
- **Q5 B 只进 Linux CI / C 跑上游 bun 测试**：B 的 macOS 回归 CI 发现不了；C 测的是上游不是 Tenon 的接法（srt-16）；改判：无。
- **Q6 B fail-closed / C fail-open**：B 装好依赖之前任务模式基本不能跑命令；C 让以后的自动档下命令以你的权限不问地跑；改判：无。
- **Q8 B 模型申请在沙箱外运行 / C「高级」三档含完全访问 / D 不给越出的路**：B 推翻 02 E4 的明文排除，须 supersede 02；C 那次 Run 里所有命令不经沙箱；D 让裸 ssh、多数数据库驱动在沙箱里完全用不了（hosts-9）；改判：无。
- **Q9 B 就地问（askCallback）/ C 命令预先声明域名**：B 与 02 的等待模型冲突、连接挂在内存里，0.0.79 还把任何真值当放行（srt-m0）；C 在 0.0.79 没有按命令的白名单；改判：上游发布按命令白名单（srt-m1）后再议，到时只增可选字段（T38）。
- **Q10 B 默认带预设 / C 不给预设**：B 默认就开着经包仓库外带的路；C 每个人自己找域名；改判：无。
- **Q11 B 默认进沙箱 / C 逐台可选 / D 按工作区拆进程**：每台 server 的域名都要进全局白名单、Bash 随之能连；长驻进程的文件规则在 spawn 时定死（security-25）；改判：上游发布按命令网络白名单后另立 spec。
- **Q20 A 只拒三个目录 / C 拒整个主目录**：A 让以后自动档下不经你看的命令读得到 `~/.npmrc` 这类文件；C 每个工具的配置路径都要逐个放开；改判：无。
- **T38 档位与网络合成一个枚举**：0.0.79 做不到按命令关网，还要改 `profile` 的取值、supersede 00；改判：同 Q9 C。
- **平台替代（T30）**：Mac App Store（App Sandbox 下子进程不能另建沙箱，platform-2）、Flatpak（srt 跑不起来，platform-12）、AppImage（Ubuntu 24.04 起要 `--no-sandbox`，platform-m3）交给阶段 7；VM（Cowork 本地会话的做法：循环在设备上、代码在专用 VM 里；Pro / Max 的新任务自 2026-10-06 起在云端，Team / Enterprise 仍有本地会话，§文档同步；不用 VM 的代价见 §已知限制「没有 hypervisor 级的隔离」）与 Landlock（隔离不了 Unix socket）不用。sandbox-exec 标了弃用但仍在、同行都在用（platform-0、platform-4），macOS 27 是否还带没核实（platform-m6）。

## 推出的读法

裁决之外、由裁决或现有契约推出的读法，每条一句。1–45 owner 已于 2026-10-14 全收（含无 Unix socket、不开本机端口绑定、不走上游代理、重跑要点两下这些代价，picks.md）；46–49 是答完开放问题 5 之后推出的，owner 同日过目全收；50–53 是探针跑完之后推出的，owner 2026-10-15 过目定下（50 A、51 A、52 A 连同 C、53 B，都是推荐项），正文已照改、记 Revisions，各条留着没选的选项与代价备查：

1. 宿主报状态用 `HostSandbox` 只增的可选 `posture()`，不进 `SandboxRequest`（T38）；没有它的宿主按 active / workspace-write 读，02 的测试与 `MemoryHost` 不变；这个缺省只管卡面文案，因「沙箱生效」而少问的规则把缺它读作不可用。
2. 违规的对象、能否放行、是否保护名单、是否只作诊断（`observed`：Linux 观测器的行与 §afterExit 表里清单内的无对象行，读法 53）都由 host 判，`SandboxViolation` 只增四个可选成员；kernel 不解析 srt 的行文本。
3. 受限档在沙箱不可用、或初始化 15 s 内没做完时 `wrap` 拒绝、不直通：不经包装只能是请求里写明的 `full-access`，卡上那一句才与实际执行一致。
4. 启动时先 initialize（它自己带配置查依赖），再取依赖检查的 warning，再跑一次 read-only 档的自检：命令真起得来、往外写真被拦下才算生效。macOS 上 srt 不查依赖（srt-11），嵌套沙箱、userns 被限、profile 退化成全可写这类问题只有真跑才看得出。
5. host 把 argv 逐个单引号转义拼成命令串，`binShell` 取 `argv[0]`；受限档要求 `argv[0]` 是 zsh、bash 或 sh 的绝对路径，否则拒绝。
6. srt 用的 id = tool-use id 按 UTF-8 在码点边界上截到 67 字节 + `.` + 32 位十六进制随机数。（2026-10-16 改：原为截到 67 个字符；srt 送 id 时最多 251 字节，67 个汉字的 id 会到 312 字节、违规无主，§argv、shell、env 与 id。）
7. wrap 成功而没起进程（spawn 抛错、wrap 之后被停止）时 kernel 同样调一次 `afterExit`，T9 的「恰好一次」才成立。
8. T11 的「调用结束时连进程组一起杀」= 读完输出就对进程组发 SIGKILL，不先 SIGTERM；沙箱生效与否都这样做。
9. 违规在 `afterExit` 里结算：macOS 先等 `VIOLATION_SETTLE_MS`（探针 P2 在本机与 CI 的 macOS runner 上量，取较大的 p99，初值 200 ms，上限 500 ms），Linux 按 P2 的结果；之后来的只进日志。
10. 违规进模型是输出之后单独一个文本块，不参与落盘判断：块小（至多 20 行），落盘会让模型看不到它。
11. Linux 观测器的列表取自 initialize 时（srt79 README.md:461），所以 host 在事件到达时按这次 wrap 实际的 allowWrite / denyWrite 重判，落在可写范围里的丢掉，其余带 `observed`。（2026-10-16 补，lead 定：「落在」按写真实落到的位置判。观测器报的是写下的路径、不解链接（linux-violation-monitor.js:56-62），allowWrite 却只有真实路径，bwrap 也按落点拒。host 把路径的目录照内核的顺序解开（与拒绝条目同一个解析，悬空链接也跟，§档位到 srt 配置「链接」；每次 wrap 按目录缓存：大项目安装时事件多，又在主进程里同步做；`unlinkat`、`renameat`、`renameat2`、`symlinkat`、`linkat` 与 x64 的 `unlink`、`rmdir`、`rename`、`symlink`、`link` 到达时，写下的那一级与缓存里它下面的都作废、下次重新解，命令删掉或挪走一个目录、在原处放一个链接之后，经它的写照新的落点判），最后一级跟不跟链接看调用：`openat`、`openat2`、`creat`、`truncate`、`fchmodat`、`fchmodat2`、`fchownat`、`utimensat` 与 x64 的老式 `open`、`chmod`、`chown`、`utime`、`utimes` 跟到目标，`unlinkat`、`renameat`、`renameat2`、`mkdirat`、`mknodat`、`symlinkat`、`linkat` 与 x64 的老式 `unlink`、`rmdir`、`rename`、`symlink`、`mkdir`、`mknod`、`link`、`lchown` 不跟（x64 版 apply-seccomp 的调用名表；`link`、`chown` 在字符串表里并进了 `symlink`、`lchown` 的尾部，照 arm64 表里单列的 `linkat` 推出；x64 的 S 在 plan 第 21 步用真抓到的行再核），两张表都没有的（观测器不发这种名字，只可能是伪造的行）跟与不跟两种都算、都落在可写处才丢、留下时 `target` 取不跟的那一种；观测器不报调用参数，`touch -h`、`chown -h`、`O_NOFOLLOW` 这类会被当成跟，只影响诊断。写下的路径与真实位置都不碰 denyWrite、真实位置又在可写处才丢——可写处是这次的 allowWrite，加上 srt 自带的可写处 `/dev/stdout`、`/dev/stderr`、`/dev/null`、`/dev/tty`、`/tmp/claude`、`~/.npm/_logs`、`~/.claude/debug`（srt79 sandbox-utils.js:486-504：bwrap 放行，srt 自己的观测器按写下的拼法丢掉，sandbox-manager.js:518-523），两样任一落在 denyWrite 上就带 `protected`（宿主与沙箱看到的不总一样：Linux 上已存在的禁读目录在沙箱里是空 tmpfs，宿主上 `~/.ssh/config` 指向 dotfiles 的链接在沙箱里不在）；`target` 是真实位置。`/proc`、`/dev` 下的路径不解（宿主上它们指向 Tenon 自己的进程与设备）：写下的就在那里，或解析途中（含链接目标）一到那里，就此停下、其余照写下的接上，所以工作区里指向 `/dev/null` 的链接按 `/dev/null` 算、丢掉，指向 `/proc/self/fd/3` 的按 `/proc/self/fd/3` 留下，不解进宿主上 Tenon 自己的 fd。解不出（lstat 或 readlink 抛错）的照写下的路径留下、不丢。这是把「落在」说清楚，不涉及要 owner 取舍的代价，所以由 lead 定；x64 老式调用归表、`/proc`、`/dev` 经链接也停、srt 自带的可写处与缓存作废是第一段审查后补的，lead 2026-10-16 定。）
12. 档位在判定时定、写进判决：卡上说的就是执行时的；之后改「高级」档位只影响之后判定的调用；执行器按派发所依据的判决取。
13. 回执放行记在新名字 `tool/receipt_override`，不用 `tool/approval_resolved`（一个调用只有一条答复）；载荷带 02 保留的 `receipt-override` 字面量；路由传来 `callKey` 与目标，目标只用来比对；inspector 回执的放行记在哪由 06 定。
14. 一次性放行在下一次「同一会话、原文与 cwd 都相同」的判定时绑定，绑定即用掉；没绑定的到点击之后开始的第一个 Run 结束时作废（点击时有 Run 在跑的，这个与下一个都算），清空会话也作废：几天后模型再发同样的原文不该不包装地跑；一个判定只绑一条、重跑优先；重新判定沿用原绑定；父子会话互不绑定。
15. 绑定了重跑的调用一定出 `elevated` 卡，卡上写命令原文，本会话命令授权免不掉它：那条授权是在「沙箱里跑」的卡上给的（02:2108 范围以卡上写明的为限），而 `protected` 靠不住（macOS 的日志一块只取第一条，Linux 不报读，命令能凭 `SANDBOX_RUNTIME=1` 认出自己在沙箱里），卡是越出沙箱唯一的闸。
16. 只读档下的「仅此路径」= 这一条以 workspace-write 跑、可写范围只有那个路径。
17. 放行说明的时点同 `message/environment`（02:2966），不在工具结果之间插消息：避免 OpenAI 兼容线上「tool 之后接 user」这种没实测过的排法；Run 进行中点的，模型到下一个检查点才看到。
18. 域名放行只给回执里的主机名本身（照 WHATWG URL 规范化后的小写名），不带端口、不加通配；IP 字面量（含数字写法）、`localhost` 与 `*.localhost`、「解析到受限地址」、`malformed host`、命中禁止表的都不给域名按钮（放行了等于让沙箱命令连回环、内网或元数据地址；命令能故意连 `localhost:任意端口` 造一条违规来骗这个按钮），只给「在沙箱外重跑」。
19. 生效白名单在每次 wrap 之前由 kernel 经 `LoopPorts.sandbox.beforeWrap` 交出本会话的域名授权、host 有变化才 `updateConfig`：比 T18 的「每个 Run 开始时重算」细，子会话放行的域名不会在回到父会话后还开着；它同时给出本会话的落盘目录，供 allowRead。
20. 预设的缓存目录（npm 的是 Tenon 自己的目录，读法 46）只在你的档位是 workspace-write 时可写：只读就是只读。
21. 不开 `allowLocalBinding`：开了沙箱命令就能直连本机任何端口；代价是 macOS 上沙箱里起本机端口的测试会失败，要走「在沙箱外重跑」。
22. 凭据清单在 Q20 B 列的之外再加同类的明文凭据文件 `~/.netrc`、`~/.pypirc`、`~/.cargo/credentials.toml`；owner 不接受就删掉这一句。（2026-10-15 补：同类的再加整个 `~/.kube`、`~/.config/op`、`~/.vault-token`、`~/.pgpass` 与 Hugging Face 的令牌文件，各附工具的公开文档，见 §档位到 srt 配置，plan 第 6 步实测；原不在 owner 2026-10-15 的决定里，之后 owner 经问卷确认收下，开放问题 6。只挡缺省位置的文件，放在环境变量里的同类令牌照 02:1930 传给命令，见 §已知限制。）
23. e2e 接缝 `TENON_TEST_SANDBOX=off | fake` 照 03 读法 46 的防护写法，启动器默认 `fake`；`fake` 报的是假违规、命令直通，只用来测回执流程与保持既有 e2e 不变，沙箱本身的效果由黑盒用例测，「不可用」的界面用 `off` 测。
24. 黑盒套件在 `TENON_SANDBOX_TESTS=required` 下沙箱不可用或只是 `degraded` 就失败；不设时跳过并打印原因，所以 agent 沙箱里跑 G 不会红；在 CI 里（`CI` 有值）不设、也没显式写 `skip` 时失败，workflow 里漏了这个变量不会悄悄全绿。
25. 退出时 reset 最多等 2 s。
26. 评测宿主的模型命令用 `DesktopSandbox`、保护名单照真实主目录拼（被注入的任务也碰不到你的机密）；`runNode` 照旧直通；基线必须在沙箱生效的机器上跑，姿态由 runner 写进每条记录。
27. 回执不加「查看这条规则」，随 task-mode-ui。
28. 设置弹窗加两栏：「沙箱」（状态与「高级」档位）、「网络白名单」（列表与预设）；审批档与文件夹访问随 06。（2026-10-15 改：owner 定合成一栏「权限与网络」，白名单是主体，沙箱状态只在部分降级或不可用时显示一行，档位在「高级」里，见 §界面。06 的审批档、文件夹访问与持久授权的撤销（02:2108 写的「设置 › 权限」）预期也并进这一栏，栏名照此取；怎么放由 06 定。）
29. 用户白名单最多 256 条，按小写存、去重；坏条目读入时只丢自己（照 M6）。
30. 提示层三处（违规说明、放行说明连同 system 一句、Bash 描述一句）一起只加一次版本。（2026-10-15 补：Bash 描述另加读法 52 的一句，并进同一次 10 → 11。）
31. 回执的「已放行」不进投影：重开后按钮照常出现，再点回 `already-released` 也显示「已放行」。
32. macOS 的非文件、非网络拒绝（如 mach-lookup）记 `kind: 'fs'`、不带对象、不给路径放行。
33. 上游代理钉成不用（`network.parentProxy = { noProxy: '*' }`）：T42 的解析地址检查对经上游代理的连接不做，而 srt 默认会拿主进程的 `HTTP_PROXY` 当上游，行为随你从 Dock 还是终端启动而变；代价是只能经公司代理出网的机器上，沙箱里的命令连不出去、要走重跑。要支持上游代理时另加设置项。
34. denyWrite 在 T13 之外再加：denyRead 的全部条目（macOS 上 srt 的读禁区不挡写，主目录被选为文件夹时 `~/.ssh/authorized_keys` 这类就可写，macos-sandbox-utils.js:584-689）；主目录下沙箱外会自动执行的位置（`Library/LaunchAgents`、`.config/autostart`、`.config/systemd/user`、`.config/git`、`.gitconfig`、`.zlogin`、`.zlogout`、`.bash_login`、`.bash_aliases`，P3 在两个平台核对后定稿）；`ZDOTDIR` 下的 shell 配置（包装外层的 `<shell> -c` 在沙箱外起、会读它）；srt 包目录（开发构建里 helper 在 node_modules，选 Tenon 自己的检出为文件夹时命令能换掉 apply-seccomp）。都只收紧。
35. 「仅此路径」的目标要同时满足：绝对路径、已规范化、不以 `/` 结尾；上级目录存在且等于它的真实路径；不是已存在的目录，也不是已存在的链接（2026-10-16 补：allowWrite 只传真实路径，放行一个指向目录的链接——`/tmp`、`~/bin`；srt 的存储会去掉 `<>`，`touch '/tmp<'` 就能报出它——等于放开目标的整棵子树）；不等于也不是 `/`、主目录、profile 目录、任何 denyRead / denyWrite 条目的上级。srt 的可写条目在 Seatbelt 里是整棵子树（macos-sandbox-utils.js:56-62），`chmod 700 ~`、`touch /` 或开头带换行的文件名（日志按换行切，目标被截成上级目录）都能让违规落在祖先目录上，点一下就把整个主目录给出去。kernel 核对时查一遍，host 每次 wrap 再对 `workspace` 里不属于会话文件夹的项独立查一遍，不过就抛 `SandboxUnavailableError`、照 wrap 抛错收口。
36. 「保护名单」分两层：不给任何按钮的 = profile 目录（读与写）与 denyWrite 的全部名字（写）；读 `.ssh`、`.aws`、`.gnupg` 与凭据清单被拒的，不给「仅此路径」（那等于放开凭据），但给「在沙箱外重跑」（Q20 B 的代价、Q8 A 的用意，开放问题 3）。`protected` 只是界面提示，越出沙箱的闸是读法 15 的卡。
37. 本会话命令授权只覆盖不比给出它的卡更宽的计划：判定计划为 full-access 时，在沙箱档的卡上给的授权不免卡；`elevated` 卡上的「允许」只这一次。否则下次启动时依赖坏了，旧会话里授权过的命令会不出卡、不带那一句地以你的权限跑（Q6 A）。
38. `pending` 期间的重新判定（含启动恢复）沿用原判决的 `unavailable` 与卡上的 `sandbox` 事实：启动恢复在姿态定下之前就重判待批的卡（recovery.ts:523，desktop 的 index.ts:230-234 在建窗口之前），按「生效」重判会把上次的卡换成没有那一句的。
39. host 自己接住违规：initialize 后订阅 srt 的违规存储，事件一到就按 srt 的 id 分到这次 wrap、当场分类与过滤；每次 wrap 至多留 200 条、保护名单的排前面；kernel 取前 20 条，`anyProtected` 在截断之前算。srt 的存储全进程只留 100 条，等到 `afterExit` 再取会被别的事件挤掉。
40. 用户白名单里回环、链路本地与私网的 IP 字面量，以及 `localhost` 与以 `.localhost` 结尾的名字，必须带端口；`localhost:端口` 照 srt 的意思是经代理放行本机那个端口，只写 `127.0.0.1:端口` 不放行它；本机与私网条目只对走代理的客户端有效，设置页写明。是否在命令前覆盖 srt 的 `NO_PROXY`（要动 T6 的环境）不在 4a 做。
41. `/tmp/claude` 由 host 在每次受限 wrap 前确认（本用户所有、不是链接、0700，不存在就建），预设的缓存目录同样要在（核对照读法 48）；启动时从主进程环境删掉 `CLAUDE_CODE_TMPDIR`、`CLAUDE_TMPDIR`，让沙箱里的 `TMPDIR` 恒为 `/tmp/claude`。
42. Linux 姿态为 `no-seccomp` 时 denyRead 另加 `$XDG_RUNTIME_DIR`、两处 docker.sock、`/tmp/.X11-unix` 与 `SSH_AUTH_SOCK` 所在目录：bwrap 以只读绑进整个 `/`，没有 seccomp 就能连 D-Bus（`systemd-run --user` 起沙箱外的进程、经 Secret Service 读钥匙圈）、docker.sock 与 ssh-agent。不去掉命令环境里的 `SSH_AUTH_SOCK` 等变量（手动档照 02:1930 全传，Q20 B）。
43. 交给 srt 的配置是一个封闭的键集合，不是一张「永不打开」的黑名单；T14 之外多关的 `enableWeakerNestedSandbox`、`allowMachLookup`、`allowPty`、`allowGitConfig`、`filterRequest`、`credentials` 与「一个 Unix socket 都不放」都在此列，后者的代价是 ssh-agent、gpg-agent、docker CLI 在沙箱里用不了（要走重跑）。
44. 违规行的分类只认整行严格匹配的写法：多出一个「Sandbox:」、对不上已知格式的行不给任何放行，只作为 `kind: 'fs'`、无对象的违规回给模型。
45. 评测进程里 `DesktopSandbox` 每个进程 initialize 一次、跑完 dispose；apps/desktop/test/evals-host.test.ts:160 测的是环境不泄漏，经选项照旧用 `PassthroughSandbox`（真包装会加 srt 的变量、把 `TMPDIR` 换成 `/tmp/claude`）。
46. 「包管理器」预设里 npm 的可写缓存是 `<userData>/sandbox-cache/npm`（`<userData>` 即 `app.getPath('userData')`，profile 目录是它下面的 `profiles/<userId>/<tenantId>`，packages/kernel/src/host/profile.ts:23-27），所有会话共用一份，不放进 profile 目录：profile 在 denyRead 与 denyWrite 里，srt 在两个平台上都是 denyWrite 压过 allowWrite（srt79 README.md:119、:741），放进去就得把 profile 从 denyWrite 拿掉、改列它下面的每一项，Tenon 以后往 profile 里加的东西会默认可写。picks.md 记的是「指向 profile 下的目录」，这里照开放问题 5 A 的原文「profile 之外，如 `<userData>/sandbox-cache/npm`」。
47. `npm_config_cache` 只由 `DesktopSandbox.wrap` 在受限档加，条件与这个目录进 allowWrite 相同（预设打开、你的档位是 workspace-write；只读档下的「仅此路径」不算），加之前删掉 env 里不分大小写名为 `npm_config_cache` 的键：变量只是把 npm 的写引到可写的那个目录，目录不可写时加了没用，还让沙箱里的 npm 用不上 `~/.npm` 里已有的缓存；`full-access`（在沙箱外重跑、沙箱不可用）不加，用你自己的 `~/.npm`。这是 T6「只叠 srt 要求的变量」的三类例外之一（另两类是 macOS 的进程标记 `TENON_SANDBOX_MARK`，P6，与 macOS 的 `OS_ACTIVITY_MODE=disable`，owner 2026-10-16）；P4 照读法 49 加进预设的管理器各加它自己的那一组（多为一个；pnpm 是一组六个，都在它的目录之下，2026-10-16；§网络白名单 的预设表，不变量 3 已随 Revisions 改）。
48. 这个目录在每次加它的 wrap 前照 `/tmp/claude` 核对（本用户所有、不是链接、0700，不存在就建），不过就抛 `SandboxUnavailableError`：srt 的可写条目在 macOS 上是 `(subpath …)`，连目录本身一起可写（macos-sandbox-utils.js:59-63、:660-663），沙箱里的命令能把它删掉、换成同名的链接，下一次 wrap 取真实路径时，链接的目标（`~/.npm`、PATH 上的目录）就成了可写。
49. P4 给 npm 之外的管理器定预设时同样不放开你自己的缓存目录：pip、uv、cargo、go 的缓存也会被你在沙箱外的工具取来执行（uvx 从 uv 的缓存起环境，cargo 编译 registry 里包的 build.rs），所以只有能用环境变量把缓存挪到 `<userData>/sandbox-cache/<管理器>` 的才进预设——一个变量，或一组都指向这个目录之下的变量——这些变量照读法 47、48 加与核对、写进 Revisions；挪不了的不进。（2026-10-16 改措辞，意思不变：原写「一个环境变量」，pnpm 要一组才不往你的主目录写。）
50. **主进程的 cwd（owner 2026-10-15 定 A）。** 从 Dock 启动时主进程的 cwd 是 `/`（LaunchServices 起的进程都是），srt 锚在 cwd 上的那份强制禁写（macos-sandbox-utils.js:21-46）在 macOS 上就盖住整个磁盘：沙箱里任何地方 `git init` 都失败（`.git/hooks` 写不进），`.vscode`、`.idea`、`.gitconfig`、`.claude/commands` 这类名字哪里都写不了（P1：`/tmp/claude` 下 `git init`，cwd 为 `/` 时失败、为空目录时成功；Linux 上两种都成功）。从终端启动时又锚在启动目录，行为随启动方式变。定为：`sandbox-posture.ts` 在 initialize 之前把主进程 `process.chdir` 到一个只为此用的空目录 `<userData>/sandbox-cwd`（照 `/tmp/claude` 核对：本用户所有、不是链接、0700，不存在就建；两档都进 denyWrite——工作区是主目录或它的上级时它也落在 allowWrite 里，srt 的 denyWrite 压过 allowWrite——沙箱里的命令改不了它；e2e 接缝下不 chdir），之后不改回；评测进程不做（它们从仓库根起，vitest 依赖 cwd），所以目标目录是启动函数的参数。主进程里读 cwd 的只有 `loadDevEnv`（apps/desktop/src/main/dev-env.ts:13），它在 `app.whenReady()` 之前跑（index.ts:111），早于姿态启动；apps/desktop/src/main 里别处没有 `process.cwd()`，spawn 一律要绝对 cwd（process.ts:48）。正文落在 §启动 第 2 步、§档位到 srt 配置 与验收 2；原来的已知限制「从 Dock 启动时……建不了 git 仓库」随之删掉。代价：以后主进程里用相对路径的代码会悄悄错（plan 第 5 步加单测：initialize 之前 `process.cwd()` 已是那个目录；再加一条 lint，禁止 apps/desktop/src/main 里除 dev-env.ts 之外读 `process.cwd()`）；经你批准的 full-access 命令能删掉这个目录或把它换成链接，所以每次受限 wrap 前照同样的规则复核（2026-10-15 第二次审查补，§包装契约 `DesktopSandbox.wrap` 第 2 步）；Linux 上从主目录启动时 srt 顺带做的四层扫描（把几层内已有的 `.vscode`、`.git/hooks` 这类挂成只读，linux-sandbox-utils.js:265-330）没了，那本来就随启动方式变，Tenon 按根加的名单不受影响；plan 第 13c 步的真进程核对加一次用 `open` 起（经 LaunchServices，cwd 为 `/`）。
    - B（未选）：不改，写进已知限制。代价：从 Dock 起时上面那些失败，在 `/tmp/claude` 或预设的缓存目录里建 git 仓库的步骤都会失败，从终端起又不失败，难查；CI 与 e2e 都从仓库根起，测不到。
    - C（未选）：只在 cwd 为 `/` 时 chdir。代价：比 A 多一个分支，从主目录或别处启动时仍随启动方式变。
51. **macOS 上沙箱里的 TLS 校验（owner 2026-10-15 定 A）。** 经系统信任库（Security.framework）校验证书的客户端要连 `com.apple.trustd.agent`，srt 只在 `enableWeakerNetworkIsolation` 打开时放行它（macos-sandbox-utils.js:739-743），T14 定为永不打开：P4 里 Homebrew 的 pip 26.1 与 go 1.23 在沙箱里校验失败（OSStatus -26276），没有配 MITM 代理；srt 的说明只提到配 MITM 代理时 gh、gcloud、terraform、kubectl 这类 Go 程序要它（README.md:469），Claude Code 的沙箱文档则说 gh、gcloud、terraform 在 Seatbelt 下就可能失败；node、curl、uv、cargo 用自带或文件形式的信任库，P4 里都装上了。定为：照 T14 不开，写进已知限制，这些工具走重跑（回执上的「允许这条命令下次不受限制地运行一次」）。代价：macOS 上 Homebrew 的 pip、go 以及很可能 kubectl、terraform 在 Tenon 的命令里连不了网，每次都要点重跑、过 `elevated` 卡（gh 本来就被凭据清单弄得起不来，P3）。
    - B（未选）：「高级」里加一个默认关、只在 macOS 显示的开关，打开就在会话配置里写 `enableWeakerNetworkIsolation: true`，T14 改为「只由这个用户级开关打开」，读法 43 的键集合多一个键。代价：srt 自己说这会开出一条「经 trustd 服务的潜在数据外带通道」（README.md:469、:899，sandbox-config.js:973-976），没写细节；机制是推断、没实测——trustd 在沙箱外、不经 srt 的代理，替调用方去取证书里写的 OCSP、CRL 与中间证书地址，沙箱里的命令造一张证书就能让它去连任意地址，这些连接不过白名单、不留违规；这个键每次 wrap 从会话配置读（sandbox-manager.js:1456），开着就对之后每一条沙箱命令生效，0.0.79 做不到只对某个工具开；打开后 TLS 是否真能过，P4 没测；多一个设置项、两份文案与测试。
52. **Linux 上挂载点进 `git status`（owner 2026-10-15 定 A 连同 C）。** 命令运行期间，srt 给工作区根下不存在的保护名字造的挂载点，在沙箱里的 `git status` 里是 17 个未跟踪项（`.aws`、`.bash_profile`、`.bashrc`、`.codex`、`.cursor`、`.envrc`、`.gemini`、`.gitconfig`、`.gitmodules`、`.idea`、`.mcp.json`、`.profile`、`.ripgreprc`、`.vscode`、`.zprofile`、`.zshenv`、`.zshrc`；P5，24.04 与 26.04 都是），几乎每个仓库都这样，模型会以为工作区里多了这些文件。`git add -A` / `git add .` 会怎样没测：这些挂载点在沙箱里是 `/dev/null` 这个字符设备（`--ro-bind /dev/null`，linux-sandbox-utils.js:2159-2180），git 只收普通文件、链接与子仓库，推断是整条 `git add` 报错退出，而不是把空文件提交进你的仓库；plan 第 6 步的黑盒实测一次，结果写进实施记录、照它改已知限制那一句的措辞。定为：Bash 描述再加一句英文（§对 02 的修补 9），意思是「Linux 沙箱里工作区根下会出现一些空的占位项（如 `.envrc`、`.bashrc`、`.vscode`），不是用户的文件；不要 stage 或提交它们，用 `git add <路径>` 而不是 `git add -A`」，并进 plan 第 7 步那一次 10 → 11 与第 15a 步的基线、不另加版本；同时照 C 留在已知限制。代价：每个请求多二三十个 token（Bash 描述不分平台，macOS 上也带着）；模型照不照做评测看不到（评测只在 macOS 跑）；第 15a 步之后再改这句，要再加一次版本、重跑基线（02:2956）。
    - B（未选）：命令结束后由 host 检查：kernel 不碰文件，只能是 host 在 `afterExit` 里对每个根看暂存区有没有这些名字，有就在违规块里加一句。代价：多一个在沙箱外对你的仓库跑 `git` 的子进程（要经包装，AGENTS.md:22）、一套文案与测试；只能事后提醒。
    - C（与 A 一起选）：写进已知限制。只选 C 的代价：Linux 上模型常对着 17 个幽灵文件困惑；推断成立的话，`git add -A` 在沙箱里整条失败。
53. **成功的命令也带违规行（owner 2026-10-15 定 B；读探针数据时另发现，不在原定的三条里）。** macOS 上一次成功的 `npm install` 留一条 `node(<pid>) deny(1) network-outbound`（没有地址，P2），`npm view` 另有 `mach-lookup com.apple.SystemConfiguration.DNSConfiguration`（P3），`git ls-remote https://…` 有 `com.apple.authd` 的 mach-lookup 与读 `~/.netrc` 被拒（P3）；Linux 上 GNU `mkdir -p <绝对路径>` 对已存在的祖先目录报 `deny mkdirat`（P1：24.04 上每一级都报，26.04 上报最深一级——2026-10-16 更正，原写 26.04 没有；x64 上 glibc 走老式的 `mkdir`，报 `deny mkdir`）。原来的写法下，前三种里不带 `observed` 的行让这次调用来源记 `sandbox`、出回执、计入 `MACHINE_DENIAL_CAP`：靠本会话命令授权连着三次成功的 `npm install`，Run 以 `blocked-repeatedly` 结束（02:1459）；第四种带 `observed`、不计数，但每个 `mkdir -p` 都出一个回执。定为：没有对象的行（§afterExit 表里清单内的那一行——`mach-lookup`、`sysctl-read`、`network-bind`——与 Seatbelt 出网行；读法 44 认不出的行与清单以外的操作不在内，照旧不带 `observed`、计数——这是 2026-10-15 两次审查后的收紧，owner 2026-10-15 经问卷确认取收紧后的写，开放问题 8；第一次审查时写作「照 B 的原文改回」，但 B 的原文只说「表的最后一行」，字面也装得下认不出的行）一律带 `observed`，照样进模型的违规块与回执，不让来源变 `sandbox`、不计数；Linux 观测器对事件到达时已存在的目录报的 `mkdirat`（x64 上还有老式 `mkdir`，2026-10-16 补，意图与范围不变）当场丢掉（那次调用什么也没做成）；`DNSConfiguration` 那行同 configd 进 `ignoreViolations`。`observed` 从此的意思是「只作诊断」，不再只是「来自 Linux 观测器」。正文落在 §档位到 srt 配置、§afterExit、清理与违规、§执行与收口、§对 00 的修补 2、不变量 15、验收 16、19、20。代价：只留下清单内无对象行的真拒绝（直连被拒、TLS 失败时可能出的 trustd 那行，以及对 launchservicesd 这类服务的 `mach-lookup` 试探）不再计入上限，模型反复重试只靠步数上限收住，06 的 Q18 A 让沙箱内命令免问之后更是如此（§主参考与 02 留下的各条的去向 ③）；有对象的照算，所以 macOS 上 git 走 https 仍每次因 `~/.netrc` 计一次（§已知限制）。
    - A（未选）：照原来的写法。代价如上。
    - C（未选）：只把 `DNSConfiguration` 进 `ignoreViolations`。代价：不带地址的出网行没法按子串忽略（子串 `network-outbound` 会连真的直连拒绝一起吞掉，srt 按子串比，sandbox-violation-store.js:69-87），`npm install` 照样计数。
