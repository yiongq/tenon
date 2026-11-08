# 06 · 审批档位：自动档（阶段 4c）

Status: draft
Tier: heavy — 改权限决策表的第 4、5、7 层与回执放行、Tape（会话档位与 inspector 放行两个新事实）与提示层，并让命令不问就在你的电脑上运行
Phase: 4（4c）
Related: auto-tier-hardening（开自动档前的加固：`.git` 元数据、连接器外带、`core.hooksPath`；本 spec 不写这三件；它挡第三段：第三段开工前它要已 implemented，D22）
Changes: 01 §desktop 接线（增补：config.json 只增三个键）；02 §会话形态（增补）；02 §会话事实（增补）；02 §主进程与 kernel 的循环接口（增补）；02 §名字总表（增补）；02 §载荷（增补）；02 §内置工具与参数（增补：点名，见 §点名）；02 §决策表与各层输入（增补：点名，见 §点名）；02 §合并：两步（增补：点名，见 §点名）；02 §可逆性（增补：点名，见 §点名）；02 §Inspector 接口与合议（增补：点名，见 §点名）；02 §挂点与会话视图（增补）；02 §外带检查（增补：点名，见 §点名）；02 §railguard 映射（增补）；02 §判决记录与摘要（增补：点名，见 §点名）；02 §主循环与 Run 的结束（增补：点名，见 §点名）；02 §权限（增补：点名，见 §点名）；04 §档位计划写进判决（增补：点名，见 §点名）；04 §告诉模型（增补）；05 §给 06 的接口（增补）；presentation-r1 §审批卡（增补）；presentation-r1 §审批卡（替换：Delete 卡的标题）；presentation-r1 §拦截回执（增补）；presentation-r1 §工具行（增补）

## 给你看的一页

做什么：加一个自动档：工作区里能还原的改动、关在沙箱里的命令不再问你；撤不回的、越出文件夹的、按规则拦下的照样问。

你会看到：
- 任务会话的输入框下多一个档位菜单：手动、自动。新任务默认手动，设置里能改默认；发第一条消息之前就能选；切档只管这个会话，清空会话后照旧。
- 自动档时输入框上方常驻一行「自动档：能还原的改动不再问你 · 切回手动」，点它回到手动；第一次切到自动档时另出一条说明，点「知道了」以后不再出。
- 自动档里改工作区里的文件、在沙箱里跑命令不出卡（macOS）。Linux 上命令照问；照问的卡都写一句为什么。
- 两档都要问、答复只管这一次：撤不回的命令，新加 `git reset --hard`、`git checkout -- …` 这类会丢掉已有内容的；读过网页、碰过你的文件之后能联网的命令；路径或命令里有看不见字符的（卡上把它们画出来）。
- 自动档里带 `>` 的命令问一次，点「允许」后这条命令本会话不再问。
- 被规则拦下的调用，回执上可以「允许这一次」。一轮里被拦 20 次就停下，自动档同时切回手动。
- 展开工具行能看到为什么没问你。选新文件夹时问「允许访问这个文件夹」，可以「以后都允许」，设置里能撤销。

```
一次调用 ─► 拒（组织策略、保护名单、你关掉的、规则拦下）──► 回执；规则拦下的可「允许这一次」
        ─► 必须问（撤不回、凭据与自动执行的位置、读过网页后能联网的命令……）──► 卡
        ─► 自动档：工作区里的文件工具，本会话能留底 ──► 不问
                  沙箱里的命令，macOS、沙箱生效、本会话能留底、不带 > ──► 不问，去掉令牌变量
        ─► 其余照手动档问，卡上说为什么自动档没放
```

不做：`.git` 元数据、连接器外带、`core.hooksPath`（见 auto-tier-hardening）；LLM 判官（06 之后另立）；跳过档；按任务授权（阶段 6）；连接器卡的「本会话允许」；批量删除的闸；按文件夹记住档位。

代价和已知限制：命令的改动只在整个文件夹的快照可用时能还原，「文稿」「桌面」这类文件夹里、首张快照没拍完时，自动档里命令改坏的文件救不回（结算行写「命令的改动可能无法还原」）；拍不了快照的单个文件（超过 100 MB）改动自动档也不问；命令里别的覆盖写法（`sed -i`、`cp` 盖文件、脚本写文件）认不出；读过网页之后每条能联网的命令都问一次，手动档也是；令牌变量按名字认，会误伤也会漏；装了 06、出现过「看不见的字符」那类判决的会话，退回 06 之前的版本后打不开消息列表；第二段要跑一次基线评测，约 5 元。

要你定的：32 张卡都标了推荐。D1–D14、D23–D26、D32 是你定的（D1 你选的不是推荐项；D32 是对改 02 已合入接口校验的点名批准）；D22 是 lead 按推荐定的；D15–D21、D27–D31 是实现取舍、lead 定。难退 0 张，中等 1 张（D2）。没有开放问题。

怎么算做完：
- 自动档里能还原的文件改动、沙箱里的命令不出卡，照问的几种照问并说原因（验收 1、2、4、5）。
- 发第一条消息之前切到自动档，第一条调用就按自动档判（验收 13）。
- 覆盖写类命令两档都每次问、⏎ 是拒绝（验收 7）。
- 自动档免问的命令拿不到令牌变量（验收 17）。
- 读过网页之后能联网的命令再问一次；看不见的字符问、控制字符拦（验收 18、19）。
- 规则拦下的调用能从回执允许一次，端到端走通（验收 21、27）。
- 一轮拦到 20 次停下并降回手动（验收 24）。
- 菜单、横幅、说明条、设置与文件夹授权都能用，端到端走一遍（验收 31、32、33、34、35、36、40）。

## 外部依据

- railguard 0.7.0 的 `inputHygiene`：裸控制字符（不含制表、换行、回车）判 `blocked`；零宽字符与 Unicode 标签块判 `modified` 并给出剥掉后的文字（E1）。钉的 `939027d` 与 `v0.7.0` 标签之间这条规则一字没改（E2）；npm 上发布的 0.7.0 包内 `src/rules/hygiene.ts` 与 `939027d` 逐字相同，`939027d` 编出的 `dist/rules/hygiene.js` 与发布包的也逐字相同（P1）。
- Claude Code 自动模式：连续 3 次或累计 20 次被拒就交给人；20 取它的数（E3）。
- 现有代码的每条断言逐条核在 evidence.md（E4–E37）；回退到 06 之前的版本实测过，结果见 §接口「迁移与回退」（P2）。

## 接口

```ts
// packages/kernel/src/permission/decide.ts —— LayerInputs 只增第 7 层的三项（D1、D3、D14、D29）
readonly snapshotStatus?: SnapshotStatus  // 根会话 snapshots.status 的判定时取值；只给任务形态的文件工具与 Bash
readonly commandSandboxed?: true          // Bash：posture() 存在且 state === 'active'、计划不是 full-access、autoCommands() 为 'yes'
readonly autoAsk?: 'no-snapshot' | 'linux' | 'platform' | 'sandbox' | 'redirect' // 自动档里本来会免问、因此照问的原因（§自动档的范围）
// DecisionStep.basis.modeRule 只增 'auto-sandboxed-command'；basis 只增 override?: string（绑定的 inspector 放行键）

// packages/kernel/src/permission/reversibility.ts —— 只增
export function autoStillAsk(command: string): 'redirect' | null // D3；commandReversibility 签名不变，COMMAND_PATTERNS 只增七行（D2）

// packages/kernel/src/permission/inspector.ts —— 只增
export type InspectorCategory = 'exfiltration' | 'hidden-characters' | 'control-characters'

// packages/kernel/src/permission/session-view.ts —— InspectedCall 只增；SessionView 不动（D28）
readonly canReachNetwork?: boolean // 只在 Bash：计划为 full-access，或 SandboxPorts.canReach 答真；检查前采样、检查后复核（§两条新的机器检查）

// packages/kernel/src/loop/ports.ts —— SandboxPorts 只增两个同步、不抛的可选查询（D28、D29）
canReach?(q: { sessionId: string; hosts: readonly string[] }): boolean // 照命令网络白名单的实际合并规则答；缺省读作 true
autoCommands?(): 'yes' | 'linux' | 'no' // desktop：macOS 'yes'，Linux 'linux'，其余 'no'；缺省读作 'no'

// packages/kernel/src/session/draft.ts —— SessionDraft 的 cowork 一支只增（D27）
approvalMode?: 'manual' | 'auto' // 建会话之前你在菜单里选的

// packages/kernel/src/session/service.ts —— 只增
approvalModeDefault?: () => 'manual' | 'auto' // SessionServiceOptions：新任务的默认档，desktop 读 config.json；缺省 'manual'
setApprovalMode(q: { sessionId: string; mode: 'manual' | 'auto' }): Promise<{ status: 'set' | 'not-cowork' | 'unknown-session' | 'policy' | 'refused' }>
releaseInspector(q: { sessionId: string; callKey: string }): Promise<ReleaseResult> // 04 的五种状态

// packages/kernel/src/loop/limits.ts —— 只增
export const MACHINE_DENIAL_ROUND_CAP = 20 // D5

// packages/kernel/src/tape/entry.ts —— 只增；04 的 ReceiptOverridePayload 与 tool/receipt_override 一字不改（D16）
export type ApprovalModeSetPayload = { mode: 'manual' | 'auto'; by: 'default' | 'user' | 'downgrade' | 'policy'; writer: FactWriter }
export type InspectorOverridePayload = CallRef & { // 写进 tool/inspector_override
  toolName: string; argsHash: string; inspectorIds: readonly string[] // 回执上那几个说拒的检查
  via: 'receipt-override'; writer: FactWriter
}
// PermissionDecidedPayload 只增 inspectorOverride?: { key: string }
// RunEndReason 的 blocked-repeatedly 只增 scope?: 'round'（累计到上限；连续的不带）
// SandboxReleasePayload.overrides 可以含 tool/inspector_override 的键（类型不变）
```

- Tape 两个新名字，登记进 `DECLARED_TAPE_NAMES`、投影、重放与 SQLite、Postgres 一致性测试：`session/approval_mode_set`，event，slice `session`，身份 `session`、sessionId、`<n>`，键 `session:v1:approval_mode:<incarnationId>:<n>`；`tool/inspector_override`，event，slice `tool`，身份 `runtime_event`、runId、requestSeq，键 `tool:v1:inspector_override:<runId>:<requestSeq>:<i>`。
- contracts 只增：`session.setApprovalMode`（`{ sessionId, mode }` → `{ ok: true, mode } | { ok: false, code: 'not-cowork' | 'unknown-session' | 'policy' }`，经根会话 mailbox，关机中拒）；`session.facts` 响应只增 `approvalMode`（会话建立前取草稿里的选择，没有就取默认）；`inspector.release`（`{ sessionId, callKey }` → 04 的五种状态）。
- contracts 的文件夹授权只增：`workspace.pick`、`workspace.usePrefill` 成功响应只增可选的 `pendingGrant: { token, folders }`，有它时这几个文件夹还没加进会话；新路由 `workspace.grant`（`{ sessionId, token, choice: 'session' | 'always' }`）、`workspace.access`（列表）、`workspace.revokeAccess`（`{ folder }`）。
- contracts 的卡与摘要只增：确认卡的 `category` 枚举只增两个值；判决摘要码只增 `inspector-flagged`；卡的 facts 只增可选的 `category`、`autoAsk`。`sandbox.release` 不动。
- config.json 只增（对 01 §desktop 接线 的增补）：`approvalMode`（`'manual' | 'auto'`，缺省 `'manual'`，只由设置写）、`autoModeNoticeSeen`（布尔，缺省 false）、`folderAccess`（真实路径的数组，缺省空，只由主进程写，`config.set` 不收）。config.json 在每个 tenant 的 profile 目录里，所以键就是 tenantId 加真实路径。
- 迁移：只增，不改表结构，04 的载荷与动作不变。没有档位事实的会话读作手动。
- 回退（P2 实测）：06 之前的版本照常打开写过两个新事实与新键的会话：全部读回、哈希链、attempt 复核、投影重建、恢复续跑、重放都通过；它按手动档运行，`tool/inspector_override` 在它那里不授予任何放行、不生成告知。
- 回不去的点（P2 实测）：会话里只要有判决摘要码 `inspector-flagged`，06 之前的版本加载这个会话的消息列表失败（`session.messages`、`session.latest` 回 `invalid-response`）：摘要在判定时就存进判决、读取时不重算，旧版的摘要码是封闭的枚举。
- 回退时正有一张看不见字符的卡在等（按代码与源码探针，未整套实测），旧版启动时重判分三种：① 重判仍放行（如工作区里的 Read）：读作没变、留着旧的 `flagged` 卡，`checkFlaggedCategory` 认不出 `hidden-characters`，卡投递不出、调用一直等着；② 重判是问、卡不同（如普通 Write、Bash）：写新判决、投递新卡；③ 命令卡原因是 `command`，`checkFlaggedCategory` 只管 `flagged` 卡，照常投递。新卡投递得出，不等于消息列表恢复：有 `inspector-flagged` 时照旧加载失败。
- 以上进 owner 验收清单（plan 第 24 步）。从 06 起读取端容忍以后新加的摘要码（规矩 14，D32），07 以后再加码、回退到 06 不再重演；06 自己的这一点照旧回不去。

## 一直要成立的规矩

1. 自动档只在第 7 层放宽：同样的调用，档位由手动换成自动，判决只可能从「手动档的问」变成「放行」；第 1–5 层的拒与必须问、`sensitive` 一样不少。
2. 免问恰为 §自动档的范围 写的两类；WebSearch、WebFetch、连接器工具、工作区外的读写照手动档（D13）。
3. 免问不写答复，不生成会话授权；手动档给过的本会话授权在自动档照样生效。
4. 对话会话恒为手动；子会话没有自己的档位，用根会话判定时的档位。
5. 命令免问要同时满足：快照状态不是 `unavailable`、宿主报 `posture` 且为 `active`、计划不是 `full-access`、`autoCommands()` 为 `'yes'`、不命中 D3 名单；缺一样就照手动档问。
6. 覆盖写七类两档都是 `irreversible`；D3 名单只在自动档、只把放行改成问。
7. 两条新机器检查两档都跑，只会把放行改成问、把问改成拒；它们读的联网能力是这一次调用的输入，会话视图只放 Tape 推得出的历史。联网能力与 `commandSandboxed` 检查前采样、检查后复核，有变就重跑检查，检查最多跑三次、第三次取偏严的值；判决用的计划永远是最后一次检查之后算的那份。
8. 只有第 5 层的拒能从回执放行：只放行一次，只放工具名与参数一字不差的下一次调用，绑定即用掉，只跳过原回执里说拒的那几个检查。第一个会拒的检查与回执放行（kernel、路由、按钮、说明）同一段上线。
9. 只有依据 `modeRule: 'auto-sandboxed-command'` 派发的命令去掉令牌变量；`SandboxRequest` 与 04 不变量 3 不变。
10. 档位与两种机器拦截计数都从 Tape 现算，重启照旧。
11. 切档只影响之后的判定；已在等你的卡不因切到自动档放行，重新判定只能收紧。
12. 新的卡与回执文案不写「模型」「inspector」「沙箱」（04 的「沙箱不可用，将以你的权限运行」除外）。
13. 读取端遇到不认识的 `autoAsk` 值，或命令卡上不认识的 `category`，卡照常投递、按通用的一句显示，不让卡片或响应校验失败；`reason` 为 `flagged` 的卡的 `category` 照旧只由 `checkFlaggedCategory` 封闭校验，认不出就不投递（偏严，不放行任何调用）；06 不给别的卡加新的类别校验（D31）。
14. 读取端遇到不认识的判决摘要码，读作 `unknown`，保留原 `verdict`，按 verdict 出一句中性说明，响应照常返回；只放宽显示，不碰判定、kernel 的码表与写进 Tape 的摘要（D32）。

## 点名

碰到 implemented 的 02、04 旧文字的条目单列。理由有三种：(i) 被改的 spec 自己把这件事交给阶段 4；(ii) 收紧；(iii) owner 点名批准的放宽。

| | 旧句（节名） | 改成 | 归类 | 依据 |
|---|---|---|---|---|
| (a) | 02 §决策表与各层输入 第 7 层「自动：只在写明的范围内（工作区内的文件读写）放宽」与「02 不加这个键……恒为 `'manual'`」 | 范围照 §自动档的范围；档位存 config.json、草稿与 Tape | (i) | 02 写「随阶段 4 的档位菜单一起加」；D1 |
| (b) | 02 §决策表与各层输入「自动档的范围 = 文件工具且 `place === 'workspace'`」 | 文件工具另要快照状态不是 `unavailable`；加沙箱里的命令一类 | (i) | 02 §内置工具的默认档位「阶段 4 解除」；D1 |
| (c) | 02 §可逆性 `irreversible` 一行「删除已有文件；带内容的对外发送」 | 加「丢掉已有内容」 | (ii) | 02 自己写「只许加往 irreversible 判的模式」；D2 |
| (d) | 02 §外带检查「只管 WebFetch（……命令……都不触发）」 | 能联网的命令也触发 | (ii) | D4 |
| (e) | 02 §Inspector 接口与合议「阶段 2 的产品只注册外带检查」与 §权限 不变量 17 | 另注册 railguard 适配器，`ceiling: 'deny'`，与回执放行同一段交付 | (i) | 02 F1、F9 推迟到阶段 4；D4 |
| (f) | 02 §合并：两步「02 只保留答复来源字面量……没有写入方」 | `tool/inspector_override` 是 inspector 回执的写入方 | (i) | 02 F9；04 读法 13 |
| (g) | 02 §上限、守卫与用量「连续 `MACHINE_DENIAL_CAP` 次」 | 另加一轮累计 20 次 | (i)+(ii) | 02 F2 推迟「自动档下连拦到上限」；D5 |
| (h) | 02 §内置工具与参数「Bash」的基础环境不按名字过滤 | 自动档免问的命令去掉令牌变量 | (ii) | D7 |
| (i) | 04 §档位计划写进判决「手动档照……每条都问或按本会话命令授权放行」 | 自动档里满足规矩 5 的命令放行 | (i) | 04 §留给 05、06 与 task-mode-ui 的；D1 |
| (j) | 02 §判决记录与摘要「contracts 在 `ipc/approval.ts` 用 zod 重述并配类型级互赋断言」 | 读取端认不出的码读作 `unknown`、保留 verdict；类型断言改为单向：kernel 的码 contracts 都认得，读取类型另多一个 `unknown` | (iii) | owner 2026-11-08 选「容忍，按通用说法显示」，题面写明要改 02 已合入的接口校验；D32 |

## 自动档的范围

- **快照可用**：快照状态为 `tree`、`warming`、`file-only` 都算可用，`unavailable` 不算；不看这一次拍没拍成。这是 owner 2026-11-08 对 05 D23「前提是本会话快照可用」的读法：`warming` 照 `file-only` 读，`file-only` 也算可用（D1；对 05 §给 06 的接口 的增补）。
- **文件工具**：Read、Glob、Grep、Write、Edit、Delete，路径在工作区内，快照可用，就由第 7 层放行，`modeRule: 'auto-range'`。判定时答 `tree`、`file` 的照 05 规矩 1：派发时拍不成就不写。拍不了的照 05 判可逆性：Write、Edit 是 `unknown`，自动档照样免问；Delete 是 `irreversible`，第 4 层每次问。带 `sensitive` 的照 05 每次问。
- **命令**：Bash 满足规矩 5 就由第 7 层放行，`modeRule: 'auto-sandboxed-command'`，摘要码 `auto-mode`。命中模式表的照第 4 层每次问。快照照 05：只在 `tree` 时命令前后各拍一张；派发前整树没拍成（超时、出错）照跑，结算行照 05 写「命令的改动可能无法还原」；会话因此改成 `file-only` 后，命令照样免问（D1、D13）。
- **沙箱生效**只认判定时 `posture()` 存在且为 `active`：`pending`、`degraded`、`unavailable`、宿主没有 `posture` 都照问（04 读法 1）。快照不可用只挡文件与命令的免问，沙箱不可用只挡命令的免问（D13）。
- **平台**：`autoCommands()` 只有答 `'yes'` 时命令才可能免问。答 `'linux'` 时命令照问，原因写 Linux 那一句：Linux 的沙箱只护得住命令开始时已经存在的几个 git 文件（auto-tier-hardening 的已知限制）；答 `'no'` 或宿主没有这个查询时照问，原因写通用的那一句，不说 Linux。文件工具不受平台影响（D14、D29）。
- 绑定了「仅此路径」的命令在自动档照样免问；绑定了「在沙箱外重跑」的照 04 一定出卡（D13）。
- **照问的原因**：自动档里本来会免问、因上面某一条照问的卡，facts 带 `autoAsk`，卡上说一句为什么（D24）。几条同时成立取第一条：`no-snapshot`（快照不可用，文件卡与命令卡都有）→ `linux` → `platform` → `sandbox`（姿态不是 `active` 或没有 `posture`）→ `redirect`（D3 名单）。计划因沙箱不可用而为 `full-access` 的卡已有 04 那一句，不另带；绑定重跑的卡不带。命令卡的原因仍是 `command`，第 5 层说问时另带 `category`（D15）。

## 档位怎么存、怎么切

- 新任务的默认档存 config.json 的 `approvalMode`，只在设置里改，经 `approvalModeDefault` 交给 kernel（D8）。
- 会话建立之前（首页、发第一条消息之前），菜单里的选择写进 kernel 的草稿 `SessionDraft.approvalMode`，你的选择优先于默认；草稿改成对话形态时丢掉这一项。首条消息开 Run、建会话时，`session/approval_mode_set` 与 `session/profile_set`、`session/workspace_set` 同一批写：草稿里有你的选择就写它、`by: 'user'`；没有而默认为自动就写自动、`by: 'default'`；默认为手动不写（D17、D27）。
- 会话建立之后切档写 `by: 'user'`。会话的档位取当前 incarnation 最后一条，没有就是手动；重启照旧。清空会话时，最后一条照抄进新 incarnation，与 profile、workspace 同一批（D26）。
- `judgeCall`（`packages/kernel/src/loop/batch.ts`）每次判定读根会话当前档位，交给 `LayerInputs.approvalMode`；对话形态恒为手动。
- 策略的 `disableAutoMode` 照 02 由 `decide` 折回手动；在自动档的会话，kernel 在下一次判定时写一条 `by: 'policy'` 的手动；切到自动回 `policy`（D13）。
- 生效时点：从下一次判定起。切回手动时正在跑的调用照跑完。

## 撤不回：丢掉已有内容

- 02 §可逆性 的 `irreversible` 加一类「丢掉已有内容」：盖掉或清空已有文件、丢掉没提交的改动（D2）。
- 模式表加七行，照现有写法按原文找、不拆段，两档都每次问、⏎ 是拒绝、答复只管这一次：`git reset --hard`；`git checkout` 带单独的 `--`、单独的 `.`、`-f` 或 `--force`；`git restore`，带 `--staged`（或 `-S`）而不带 `--worktree`（或 `-W`）的除外；`git switch` 带 `--discard-changes`、`-f` 或 `--force`；`truncate`；`dd` 带 `of=`（D2、D18）。
- 每行配命中与不命中的样例，模块加载时自测：`git restore --staged x`、`git checkout main`、`git checkout -b x`、`git switch main` 都不命中（D13）。

## 自动档仍问的写法

- `autoStillAsk` 认 `>` 重定向：去掉 `>>`、`>&`（含 `2>&1`）、`=>`、`->`、`>=` 与 `>` 后面（可隔空白）紧跟 `/dev/null` 的写法后，还剩一个 `>` 就命中（D3）。
- 只在自动档、只对本来会免问的命令起作用：出命令卡，`autoAsk: 'redirect'`，⏎ 是允许，答复照 02 是本会话这一条命令。手动档不变；不算撤不回。

## 两条新的机器检查

- 两条两档都跑，会话视图不加档位（D12）。
- **检查的联网输入先采样、再复核**：`posture()` 与沙箱设置是实时的，检查是异步等的，跑检查期间它们可能变（E25）。Bash 的判定照现有顺序、多两步：
  1. 检查前按此刻的状态采样：算一份计划，由它和 `canReach` 得出 `canReachNetwork`、由姿态与 `autoCommands()` 得出 `commandSandboxed`；前者放进 `InspectedCall` 交给检查。
  2. 检查跑完，照现有顺序再算最终计划（`sandboxPlanOf`），按最终计划与此刻的状态复核这两项。
  3. 两项都没变，就用这次检查的结果与最终计划形成判决；有一项变了，按复核时的值重跑检查，再回到第 2 步。
  4. 检查最多跑三次：第三次的输入取偏严的值（`canReachNetwork: true`），判决里不给 `commandSandboxed`（照手动档判：本会话授权照常有效，没有就问，原因照 §自动档的范围 取，没有别的就是 `sandbox`），跑完不再复核。判决用的计划永远是最后一次检查之后算的那份，与 06 之前相同；会话视图只放 Tape 推得出的历史（D28、D30）。
- **外带检查扩到命令**：碰过私有数据、读进过不可信内容、`call.canReachNetwork` 为真，三样都成立就问，`category: 'exfiltration'`，只这一次，会话授权免不掉；规则仍是 `packages/kernel/src/permission/exfiltration.ts` 的 `exfiltrationOpinion`（D4、D13）。
- **`canReach` 照命令网络白名单的实际合并规则答**：用户白名单 ∪ 勾上的「包管理器」预设的域名 ∪ 传入的本会话域名授权，不空为真。预设的域名只看勾没勾、不看档位；预设的可写目录与环境变量照 04「预设生效」（勾上且档位为 workspace-write）才有，两件分开（D28）。
- **input-hygiene**：适配器 `apps/desktop/src/main/inspectors/railguard.ts`，只用 `inputHygiene`，`ceiling: 'deny'`、`kind: 'local-rule'`，依赖写 npm 精确版本 `@yiong/railguard` 0.7.0（与 `939027d` 那份规则相同，P1）。检查 Bash 的 `command`，Read、Write、Edit、Delete 的 `file_path`，Glob、Grep 的 `path`。`blocked` → 拒，`category: 'control-characters'`；`modified` → 问，`category: 'hidden-characters'`，丢掉改写；规则出错照 02 §railguard 映射 按拒处理（D4、D21）。
- **判决摘要**：`packages/kernel/src/permission/record.ts` 的 `summarize` 照旧先认检查失败：类别是 `inspector-failed` 的问与拒都给 `check-incomplete`；正常检查说问、类别是 `hidden-characters` 的给新码 `inspector-flagged`；`exfiltration` 的问照旧 `exfiltration-recheck`，说拒的照旧 `inspector-blocked`。

## 从回执允许一次

- 这一节整个与 input-hygiene 在第二段一起上线：kernel、`inspector.release` 路由与主进程接线、回执按钮与说明文案、端到端放行（规矩 8，02 §权限 不变量 17）。
- 第 5 层的拒（含 `inspector-failed`）的回执多一个按钮「允许这一次」；第 1–3 层的拒没有。
- 点它 → `inspector.release` → `releaseInspector` 在根会话 mailbox 里核对：调用在本会话当前 incarnation 里、判决是第 5 层拒；写一条 `tool/inspector_override`，同键已在回 `already-released`，不成立回 `stale`，调用不在回 `not-found`，没绑循环回 `refused`（D16）。
- 绑定：同一会话里下一次工具名与 `argsHash` 都相等的首次判定绑上它（重新判定沿用已绑的，同 04），写进那条判决的 `inspectorOverride`，绑定即用掉；那几个检查的拒按没意见记，`basis.override` 指它；其余各层照判：在自动档范围内不出卡，手动档照问。没绑定的到点击之后开始的下一轮回复结束作废，清空会话也作废，子会话与父会话互不绑定；作废与绑定的算法与 04 §放行怎么生效 的一次性放行共用一份（D13、D16）。
- 告诉模型：照 04 §告诉模型 的检查点，`message/sandbox_release` 多一种行：这个工具、这组参数的下一次调用可以运行一次；`overrides` 记 `tool/inspector_override` 的键。

## 熔断

- 一轮（02 的计数链：从一条消息或「继续」开的 Run 起，含审批暂停后续跑的）里机器拦截累计 `MACHINE_DENIAL_ROUND_CAP` 次，写完第 20 条就结束本轮，同批其余记 not-run / `blocked-repeatedly`，结束原因带 `scope: 'round'` 与次数；连续 3 次照旧（D5）。
- 自动档到上限（连续的或累计的）同时降回手动，写 `by: 'downgrade'`；手动档只结束本轮。
- 只带 `observed` 的违规不计（04 读法 53 复核结论：维持）。

## 免问命令的环境

- kernel 按这次派发所依据的判决过滤：只有 `modeRule: 'auto-sandboxed-command'` 的，交给执行器的 `CommandRun.env` 去掉下列名字，再照 04 交给 `wrap`；名单与规则是 kernel 常量（D7、D13）。
- 名单：`GH_TOKEN`、`GITHUB_TOKEN`、`NPM_TOKEN`、`HF_TOKEN`、`VAULT_TOKEN`、`PGPASSWORD`、`OP_SERVICE_ACCOUNT_TOKEN`、以 `OP_SESSION_` 开头的、`AWS_SECRET_ACCESS_KEY`、`AWS_SESSION_TOKEN`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`OPENAI_API_KEY`、`ZHIPU_API_KEY`、`DEEPSEEK_API_KEY`、`GEMINI_API_KEY`、`GOOGLE_API_KEY`。
- 规则：名字不分大小写以 `_TOKEN`、`_SECRET`、`_PASSWORD`、`_API_KEY`、`_ACCESS_KEY` 结尾的也去掉。
- 按本会话授权放行的命令（手动档批过、自动档里照问的卡上批过的）不算免问，照传。

## 界面

第二段（随第一个会拒的检查上线，手动档里就会出现）：
- **审批卡**（对 presentation-r1 §审批卡 的增补）：③ 加两句：`flagged`、`hidden-characters`「路径或命令里有看不见的字符，已经标出来，先给你看一眼。」；命令卡带 `category` 时出那个类别的 `flagged` 句。所有卡的对象行把零宽字符与 Unicode 标签块字符画成「⟨U+200B⟩」这样的可见记号，原文照存、照原样执行（D25）。
- **拦截回执**（对 presentation-r1 §拦截回执 的增补）：`inspector`、`control-characters`「路径或命令里有控制字符，已拦下。」；第 5 层拒的回执有「允许这一次」，下面一行「在这个任务里再发出完全相同的这一步时生效一次；到下一轮回复结束还没用上就作废」；点过的变成「已放行」。
- **结束文案**：`blocked-repeatedly` 带 `scope: 'round'` 时写「这一轮被拦了 {count} 次，任务已结束。」。

第三段（开放自动档）：
- **档位菜单** `ApprovalModeMenu`：只在任务会话（含发第一条消息之前）、输入框下方左侧，向上弹；两项，当前项打勾。手动「会改动的都先问你。」；自动「工作区里能还原的改动和沙箱里的命令不再问你；撤不回的、越出文件夹的、按规则拦下的照样问。」快照状态为 `unavailable` 时自动项照常可选，下面加一句「这个任务没法留底，改动照样问你」（D23）。策略关掉自动档时没有自动项（D13）。
- **横幅** `ComposerBanner`：自动档时常驻、不能关：「自动档：能还原的改动不再问你 · 切回手动」，点它写 `by: 'user'` 的手动（D9）。
- **说明条**：第一次切到自动档时出一次：放行什么、仍问什么、出错怎么一键还原，「设置」链到「权限与网络」，「知道了」写 `autoModeNoticeSeen`，之后不再出（D9、D13）。
- **降档提示**：输入框上方一行，可关：连续的「连着被拦了 N 次，已停下并切回手动档」，累计的「这一轮被拦了 N 次，已停下并切回手动档」；这时横幅已消失（D13）。
- **设置「权限与网络」**从上到下：审批档（新任务默认，两档各一句）→ 文件夹访问（「以后都允许」过的列表，逐条撤销）→ 网络白名单（04）→「高级」（04）（D13）。
- **文件夹授权**：在系统目录框里选了、或确认预填的、一个没「以后都允许」过的文件夹时，弹 `GrantDialog` 的文件夹版「允许访问这个文件夹」：「取消」不加；「允许」只加进这个会话；「以后都允许」另存进 `folderAccess`，以后再选不弹，不自动加进新会话。专用文件夹不弹。撤销只删那一条，正在用的会话照用。授权只给访问，手动档写入照问（D13）。
- **照问的原因**（对 presentation-r1 §审批卡 的增补，③ 按 `autoAsk` 一句）：`no-snapshot`「这个任务没法留底，自动档里也先问你。」`linux`「在 Linux 上，自动档里的命令照样先问你：这里护不住命令新建的仓库文件。」`platform`「在这台电脑上，自动档里的命令照样先问你。」`sandbox`「命令的隔离还没准备好或只部分生效，自动档里先问你。」`redirect`「这条命令会把输出写进文件、盖掉原来的内容，自动档里也先问你。」（D24）。
- 不认识的 `autoAsk` 值（以后的版本加的）出通用的一句「这一步在自动档里也先问你。」；命令卡上不认识的 `category` 出「Tenon 的检查要你再看一眼这一步。」（规矩 13）。
- 不认识的判决摘要码（以后的版本加的）在「查看本次记录」里，与展开的工具行本来就出原因一行的调用上（显示条件照下面「工具行」一条，不扩大），按 verdict 出一句中性说明：放行「这一步已放行。」/ "This step was allowed."；问「这一步要你确认。」/ "This step needs your OK."；拒「这一步已被拦下。」/ "This step was stopped."（规矩 14）。
- **工具行**（对 presentation-r1 §工具行 的增补）：判决为放行、没出过卡的调用，展开后加一行「为什么没问」，文案按判决摘要码取，与「查看本次记录」同一份（`auto-mode` 改成「自动档放行」）；收起时不变（D10）。
- 两段的文案定稿都在 plan 那一段的步骤里。

## 对 presentation-r1 §审批卡「问题式标题」的替换

替换后的全文：「① 问题式标题（不变；Delete 的卡写「删除这个文件？」/ "Delete this file?"）」（D13）。

## 提示层与评测

- 进提示层：`message/sandbox_release` 的 inspector 放行一行；Bash 描述加一句「自动档里不问就运行的命令拿不到令牌类环境变量」；累计到上限时同批其余调用的固定英文（不写 in a row）。`PROMPT_LAYER_VERSION` 12 → 13，更新哈希（D13）。
- 合并前在基线列（glm-5.3-flash）上跑全集、每题 3 次，约 5 元；改到了被拦之后怎么说的文本，ADR-005 另要在 glm-5.3 上单跑 02 题 3 次，约 2 元。真跑前先问 owner；逐题对照第 12 版，有题从过变不过就停下交 owner。

## 文档同步

- 起草时（放进仓库的同一 PR）：01、02、04、05、presentation-r1 页头加 `Changed by: 06（§…）`；总参考阶段表 4c 一行、§13 阶段 4 一句带日期补记、§以后再说 两行，改法见 plan 第 1.5 步。
- 实现时：`SECURITY.md` 那句「Environment filtering for automatically approved commands belongs to a later phase」改写成 06 的名单与规则；`docs/ux/components.md` 的 `ApprovalModeMenu`、`ComposerBanner`、`GrantDialog`、`FolderChip`、`SettingsModal` 五行与 `docs/ux/parity-audit-2026-09-12.md` 的审批模式三档、默认值、浮层条、档位说明条四处带日期补记：跳过档删去，自动档文案改成「按规则拦」，链接改指「权限与网络」；`docs/ux/tokens.md` 的 warning 色不删；overview 的模块表与信任边界补自动档（D13）。

## 已知限制与代价

- 命令的改动只在 `tree` 时进快照：`file-only`、`warming` 的会话里自动档照样免问命令，它改坏的文件还原不了（D1）。拍不了快照的 Write、Edit（单个文件超过 100 MB 这类）自动档也不问，写坏了救不回。
- 被 `.gitignore` 排除的文件、嵌套仓库、发到网上的，快照本来就救不回（05）；D2 只认七类具名命令，D3 只认 `>`：`sed -i`、`cp`/`mv` 盖掉文件、脚本里写文件、不带 `--` 的 `git checkout <路径>` 都认不出，自动档照样免问。引号里的 `>`（`node -e "a > b"`）也会问。
- Linux 上自动档只免问文件工具，命令照问，直到 auto-tier-hardening 的那条限制有办法补上（D14）。
- 外带检查只看来源不看内容：读过网页之后，每条能联网的命令问一次；勾了预设就是每条都问，只读档也一样；手动档里本会话允许过的也再问（D4、D12）。不可信来源只算网页与搜索：工作区里的文件自己带着指令时，这条检查不认，没读过网页的会话里，免问的命令照样能连白名单里的网站。
- input-hygiene 只看命令原文与路径，不看写入的内容和脚本文件；它出错时两档的命令与文件工具都被拦，要从回执放行。
- 检查跑的时候沙箱的状态或设置变了，而且这变化影响到 `canReachNetwork` 或 `commandSandboxed` 时，这次 Bash 的判定才会多跑一到两次检查（每次至多 2 秒）；每次检查期间都这样变，就照手动档判（D30）。
- 一轮里正常但不顺的长任务（装依赖反复被拦）到 20 次也会停（D5）。
- 有快照的 Delete 不设闸：误删一批要事后还原，快照清掉之后找不回（D6）。
- 令牌变量按名字认：碰巧这样结尾的普通变量会被去掉，靠环境变量登录的工具在免问的命令里登不上；不按这些规则起名的令牌照传；按本会话授权放行的命令也照传（D7）。
- 基线评测约 5 元，必要时另加约 2 元（ADR-005）。

## 验收标准

1. 自动档、快照状态为 `tree`、`warming`、`file-only`（参数化）：工作区内 Write、Edit、有快照的 Delete 不出卡，判决 `decidedBy: 'approval-mode'`、`modeRule: 'auto-range'`、摘要 `auto-mode`；`unavailable` 时同样的调用出卡、facts 带 `autoAsk: 'no-snapshot'`。
2. 自动档、`tree` 与 `file-only`：`coverage` 答 `none` 的 Write 不出卡；`coverage` 答 `none` 的 Delete 每次问、卡上「撤不回」、⏎ 是拒绝。
3. 自动档里一轮连着 25 次有快照的 Delete 都不出卡，结算行写「删了 25 个文件 · 可还原」。
4. 自动档、`autoCommands` 答 `'yes'`、`posture` 为 `active`、快照可用（参数化三种）：普通 Bash 不出卡，`modeRule: 'auto-sandboxed-command'`、摘要 `auto-mode`；`file-only` 时、以及 `tree` 下这一次派发前整树没拍成时，命令照跑、不出卡，这一轮结算行带「命令的改动可能无法还原」。
5. 自动档里下列命令出卡，facts 的 `autoAsk` 如括号（参数化）：快照 `unavailable`（`no-snapshot`）；`autoCommands` 答 `'linux'`（`linux`）；答 `'no'` 或宿主没有这个查询（`platform`，不是 `linux`）；`posture` 为 `pending`、`degraded` 或宿主没有 `posture`（`sandbox`）；`posture` 为 `unavailable`（不带 `autoAsk`，带 04 的 `sandbox: 'unavailable'`）；绑定了「在沙箱外重跑」（不带）；几条同时成立时取 §自动档的范围 写的第一条。
6. 绑定了「仅此路径」的命令自动档不出卡、手动档出卡。
7. 七类覆盖写命令（参数化）两档都出卡：可逆性 `irreversible`、默认焦点在拒绝、答复 `once`；06 之前留下的同一条命令的本会话授权不再免卡；不命中的样例（`git restore --staged x`、`git checkout main`、`git checkout -b x`、`git switch main`）可逆性仍是 `unknown`；加载时自测通过。
8. 自动档里 `npm test > out.log` 出命令卡、facts 带 `autoAsk: 'redirect'`，允许后同一条本会话不再问；`>>`、`2>&1`、`>&2`、`> /dev/null`、`=>`、`->`、`>=` 的样例不出卡；手动档的同一条照旧（会话授权放行）。
9. 手动档的行为不变：同一批 Write、Edit、Bash、Delete 的判决与 06 之前逐项相同（只有覆盖写七类与两条新检查的情形例外）。
10. 自动档免问之后切回手动，同一 Write 出卡；手动档给的会话授权在自动档照样放行（摘要仍是 `session-allowed`）。
11. 子会话里的调用按根会话当前档位判；根会话切回手动后，子会话下一次判定起出卡。
12. 已建立的会话切到自动档写 `session/approval_mode_set`（`by: 'user'`），重启后仍是自动；`approvalModeDefault` 答自动时，没选过档位的新任务建会话同批写 `by: 'default'`，答手动时不写；对话会话切档回 `not-cowork`。
13. 发第一条消息之前在任务草稿里切到自动档（默认是手动）：建会话那一批写 `by: 'user'` 的自动，第一条调用就按自动档判、不出卡；草稿改成对话形态再改回任务，档位回到默认。
14. 卡正在等你时切到自动档，卡不放行，重启后重新判定也不放行；切回手动时正在跑的命令照跑完。
15. 策略 `disableAutoMode`：自动档的会话下一次判定按手动并写一条 `by: 'policy'`；`setApprovalMode` 切到自动回 `policy`。
16. 自动档的会话清空后，新 incarnation 里仍是自动，档位事实与 profile、workspace 同一批写。
17. 自动档免问的命令拿到的环境里没有名单与规则里的每一个名字（测试逐个写字面量），`PATH`、`HOME`、`JAVA_HOME`、`NODE_OPTIONS` 还在；手动档批过的、自动档里因撤不回批过的命令照传；`wrap` 收到的就是过滤后的环境。
18. 本会话 Read 过一个文件、WebFetch 过一个网页之后（参数化）：用户白名单不空、只勾了预设且档位为只读、有本会话域名授权、计划为 `full-access` 的 Bash 两档都出卡、`category: 'exfiltration'`、答复 `once`，本会话授权免不掉；三样都空、在沙箱里的不出这张卡；缺一个条件也不出；检查拿到的 `InspectedCall` 带 `canReachNetwork`，会话视图里没有这一项。
19. 命令或文件路径里有裸控制字符：两档都拦下、出回执；有零宽字符或 Unicode 标签：两档都出卡、`category: 'hidden-characters'`、答复 `once`；只有制表、换行、回车的照常。
20. 让适配器抛错或超时：调用被拦下、`category: 'inspector-failed'`，回执上有「允许这一次」。
21. 回执放行：`releaseInspector` 写一条 `tool/inspector_override`，不写 `tool/receipt_override`；下一次工具名与参数一字不差的调用绑上它，在自动档范围内不出卡、手动档出卡；参数差一个字不绑；到下一轮回复结束没用上就作废；再点回 `already-released`；第 1–3 层的拒回 `stale`；绑上之后再来一次照拦；04 的三种沙箱放行照旧。
22. 有没宣告的 inspector 放行时，下一个检查点写一条 `message/sandbox_release`，含那一行，`overrides` 有它的键。
23. desktop 注册的检查恰为外带检查（`ask`）与 railguard 适配器（`deny`），都没有结果后挂点；参数里只有提示注入关键词、或超长时，适配器没意见。
24. 一轮里放行与机器拦截交替，累计到 20 次时本轮结束，`blocked-repeatedly` 带 `scope: 'round'`、次数 20；自动档同时写 `by: 'downgrade'`，手动档只结束本轮；只带 `observed` 的不计；连续 3 次照旧；「继续」重新计数。
25. `summarize` 对每个可达组合都给码：`hidden-characters` 的问给 `inspector-flagged`；`ask` 型与 `deny` 型检查失败（`inspector-failed`）的问与拒都给 `check-incomplete`；`exfiltration` 的问给 `exfiltration-recheck`；`auto-sandboxed-command` 给 `auto-mode`。
26. 第二段的卡与回执：`hidden-characters` 一句、命令卡的 `category` 句、对象行里看不见的字符画成可见记号（执行的仍是原文）、`control-characters` 一句与「允许这一次」及其说明、点过后「已放行」、`policy`、`protected`、`user-disabled` 的回执没有按钮、累计结束的那句结束文案；两份 locale 都有这些键，文案覆盖测试穷举，中英文不含「模型」「沙箱」「inspector」/ model、sandbox、inspector。
27. 端到端：手动档里一条含控制字符的命令被拦，回执上点「允许这一次」，再发同一条命令照常出命令卡、批准后运行；按钮变成「已放行」（平台：macOS、Linux）。
28. `PROMPT_LAYER_VERSION` 为 13、哈希闸通过；基线列全集每题 3 次的记录与改动在同一 PR，逐题对照第 12 版没有从过变不过的题，有就停下交 owner（live）。
29. 测试用一个可以手动放开的 Promise 暂停检查器、改完 fake host 的状态再放开，不靠真实延时。检查暂停时命令档位从「工作区可写」改成「只读」：最终计划是 `read-only`，与 06 之前在检查之后算的相同；`canReachNetwork` 与 `commandSandboxed` 都没变，检查只跑一次。
30. 夹具同验收 29，白名单、预设与本会话域名授权都设成空。检查暂停时姿态从 `pending` 变成 `unavailable`：最终计划是带 `unavailable` 的 `full-access`；`canReachNetwork` 由假变真，检查按真重跑一次，外带三个条件成立时出 `exfiltration` 卡，命令不按自动档免问。每次检查期间姿态都在变时，检查跑满三次，第三次按 `canReachNetwork: true` 跑、命令照手动档判（本会话授权照常有效），之后不再重跑；中途点停止，调用照 02 记 not-run、不写判决。
31. 档位菜单只在任务会话出现（发第一条消息之前也有），两项文案如上，当前项打勾，默认手动；快照 `unavailable` 时自动项可选、带那句说明；策略关掉自动档时没有自动项。
32. 自动档时横幅常驻、没有关闭钮；点它回到手动、横幅消失，下一次 Write 出卡。
33. 第一次切到自动档出说明条，「设置」打开「权限与网络」，「知道了」之后再切换（含重启后）不再出。
34. 降档后输入框上方出那一行（连续与累计两种说法），可关，横幅不在。
35. 设置「权限与网络」从上到下是审批档、文件夹访问、网络白名单、高级；改审批档只改新任务的默认，正在用的会话不变。
36. 选一个没「以后都允许」过的文件夹弹文件夹授权框：「取消」不加；「允许」只加进这个会话；「以后都允许」之后再选不弹、新会话不自动带上；设置里撤销后再选又弹，正在用的会话照用；专用文件夹不弹。
37. 手动档里授权过的文件夹，读与查找不问，Write 照问。
38. 展开的工具行：放行的调用多一行原因（自动档放行、本会话允许过等），出过卡的与收起的不变。
39. 第三段的卡：五种 `autoAsk` 各出各的句子，`platform` 不出 Linux 那句；Delete 的卡标题是「删除这个文件？」；两份 locale 都有这些键，文案覆盖测试穷举，不含机制词。
40. 端到端：任务会话切到自动档，横幅出现；写一个文件不出卡，结算行「可还原」，还原回来；点横幅回到手动，再写出卡。macOS 上跑一条命令不出卡，Linux 上出卡并带 Linux 那句（平台：macOS、Linux）。
41. 文档同步一节列的每一处都改了，`python3 .sdd/spec-check.py` 的 `pairs` 不拦（人工）。
42. 菜单、说明条与设置里的自动档说明只说「按规则拦」，不出现「看起来不安全才停下来问」这类说法（人工）。
43. 卡的 facts 带一个本版不认识的 `autoAsk` 值，或命令卡带一个不认识的 `category`：卡照常投递、③ 出通用的那一句；`reason` 为 `flagged`、带不认识 `category` 的卡照旧不投递、那次调用不执行。
44. 判决为 allow、ask、deny（参数化）各带一个本版不认识的摘要码：`session.messages`、`session.latest` 与工具结果事件都照常返回，码读作 `unknown`、verdict 照原样；「查看本次记录」里各出那个 verdict 的中性说明；展开的工具行照验收 38 的条件，只在本来就出原因一行的调用（放行、没出过卡）上换成中性说明，出过卡的不加；kernel 的码表与写进 Tape 的摘要不变。

## 开放问题

（无）

## 修订记录

（draft 期间直接改原文，不记）
