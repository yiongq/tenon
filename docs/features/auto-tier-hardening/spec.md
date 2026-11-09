# 开自动档前的加固

Status: implemented
Approved: implemented · 2026-11-09 · 「开自动档前的加固改 implemented」 · 对话
Tier: heavy — 碰权限决策、沙箱档位配置与外带检查这三道安全边界，改了「哪些写入会被拦、哪些调用会出卡」，并为 06 的自动档兜底
Kind: features
Changes: 02 §外带检查（增补）；02 §挂点与会话视图（增补：SessionView 字段只增）；02 §授权、工作区与外带检查的继承（增补）；03 §连接器卡（增补）；04 §档位到 srt 配置（增补）；04 §已知限制（增补）；05 §硬链接、保护名单与选文件夹（增补）；05 §已知限制与代价（增补）
Owner: 起草在 Claude Code（2026-11-08）。范围三项与起草后四个取舍都由 owner 2026-11-08 按推荐定（decisions.md D1–D7，原话在 picks.md）；同日经五轮 Codex 交叉评审（r1–r5）后修订。威胁由仓库里现成的复现用例定义，本 spec 只引用它们，不研究新绕法。

## 给你看的一页

做什么：在开「自动档」（06）之前，给 Tenon 自己的沙箱和权限检查补三道保护，堵住三个会让别人借你的身份执行代码、或把你的数据外带出去的缺口。

你会看到：
- 沙箱里的命令改不了 `.git` 里那几个「会让 git 去别处读配置或钩子」的文件（commondir、config.worktree、子模块与 worktree 的 git 目录里的 config 和 hooks、`.git` 指针文件及它指向的配置和钩子）。工作区根下照常 `git status`、`commit`、`checkout`、`stash`，子模块里照常提交。
- 读进过不可信内容（网页、连接器的结果），又有来自别处的私密数据（你的文件、别的连接器读到的东西）之后，再调任何连接器——哪怕设过「总是允许」——都先出一张只管这一次的卡。数据从同一台连接器读来再写回它，不出卡。
- 改 git 钩子会跑的位置——`core.hooksPath` 指的目录、`.husky/`、lefthook 的配置与脚本目录、`.pre-commit-config.yaml`——文件工具每次都问，卡上写「这个位置的文件会被自动执行」；沙箱里的命令也写不了。

怎么算做完：
- 沙箱里改已有 worktree 的 `.git` 指针及其目标、子模块的 config 或 hooks：两平台都拦住；改 commondir、config.worktree、在子目录新建 `.git`：macOS 拦住（验收 1、2）。
- 加了保护、且发现完整没触发回退时，工作区根的 git 常用操作与子模块内提交照常；Linux 上不冒出 commondir 的占位文件（验收 3）。Linux 拦不住的两种新建有测试记着（验收 4）。发现不完整时从严把该根的 git 元数据整个设为拒写（目录型是整个 `.git`；指针型是指针文件加它指向的 git 目录），有测试核对拒写范围、诊断和 git 写失败（验收 15）。
- 有不可信内容、又有来自别处的私密数据时，调连接器（含「总是允许」）先出外带卡、只放行这一次；不可信只来自目标连接器、私密是本地读也照出（验收 5、13）；没有这两样时直接调；同源读写不出卡；子会话读的连接器来源交接后计入父会话（验收 6、7、8、14）。
- 文件工具写 `.husky/`、lefthook、`.pre-commit-config.yaml` 每次问；`core.hooksPath` 设成某个目录时写其中的钩子也每次问、没设时不问（验收 9、10、11）。沙箱里的命令写各根下的这些位置都被拒，原来有的、新建的都一样，macOS 还拦子目录里的同名位置（验收 12）。

不做：06 的自动档本身；覆盖写类命令（`git reset --hard`、`truncate`、`>` 重定向等）的「撤不回」判定，归 06。不研究新的绕过手法。

代价和已知限制：沙箱里 `git submodule update` 两平台都失败；`git worktree add` 与子目录里新仓库的提交在 macOS 上失败、在 Linux 上照常；Linux 上在子目录新建 `.git`、在普通仓库新建 commondir/config.worktree 拦不住，06 的自动档在 Linux 上对沙箱命令照样出卡（§给 06 的约束）；Linux 上子目录里同名的钩子位置沙箱拦不住；Linux 上命令运行期间，工作区根下还不存在的钩子位置（如 `lefthook.yml`、`.husky`）会冒出空的只读占位，清理时没有别的命令在跑就清掉；Tenon 读不全 git 配置或目录时会从严把该根的 git 元数据整个设为拒写，那一次命令里的 git 写操作会失败；只有指针型 `.git` 连指针都解析不出时，只能拒写指针文件本身，不保证提交失败。

要你定的：没有待定的。7 张卡都标了推荐：D1–D3 是范围三项、D4–D7 是起草后的取舍，owner 都按推荐定了（picks.md）；选错难退 3 张（D1、D4、D6）。

## 外部依据

见 evidence.md：srt 0.0.79 的通配与 Linux 占位文件（E1、E2）；husky、lefthook、pre-commit 的配置与钩子位置（E3）；派发事实与冻结工具表里的工具来源（E4）；spec-check 的 trace、red-on-base 与 CI 各作业怎么跑沙箱用例（E5）；srt 的默认可写目录（E6）；srt 在 Linux 上丢弃通配写规则（E7）；两平台兼容性实测（P1、P2）与 Linux 上钩子位置占位的代价（P4）。

## 接口

对 implemented 的 02、03、04、05 只增，不改已有成员的类型。

```ts
// packages/kernel/src/permission/session-view.ts —— SessionView 只增（E4）
export interface SessionView {
  /* 已有成员一个不动 */
  readonly untrustedSources: readonly string[] // 取值：WebSearch / WebFetch 记工具名（原有），连接器记 `mcp:<serverId>`，认不出来源的派发记 `unresolved:<name>`；去重
  readonly privateSources: readonly string[]   // 新增：'local'（Bash 或落盘目录外的 Read / Grep，任务形态）、`mcp:<serverId>`、`unresolved:<name>`；去重
  readonly touchedPrivateData: boolean         // 保留，= privateSources 非空
}
// 新增内部纯函数 originOf(entries, dispatch) → ToolOrigin | null（§对 02 的增补「来源怎么取」）

// apps/desktop/src/main/host/git-protection.ts —— 新增；desktop 侧唯一一份解析实现
export interface GitDiscoveryPorts {
  readonly lstat: (p: string) => Promise<{ kind: 'file' | 'dir' | 'link' | 'other' } | null>
  readonly readdir: (p: string) => Promise<readonly string[]>                // 不存在 → []；读不了 → 抛
  readonly readText: (p: string, maxBytes: number) => Promise<string | null> // 不存在 → null；读不了/超长 → 抛
  readonly realpath: (p: string) => Promise<string | null>
}
export interface GitProtection {
  readonly redirectExisting: readonly AbsolutePath[] // 发现时已存在的转向文件、指针目标的 config/hooks、子模块/worktree 的 config、config.worktree、commondir、hooks，以及已存在的 include 配置来源
  readonly redirectAbsent: readonly AbsolutePath[]   // 尚不存在、仅 macOS 也拒写的写法（Linux 不用，规矩 3）
  readonly hookDirs: readonly AbsolutePath[]          // core.hooksPath 解出的目录；husky 的 `.husky/_` 另带父目录 `.husky/`
  readonly hookNames: readonly string[]               // 无条件算的钩子名
  readonly fallbackDeny: readonly AbsolutePath[]      // 发现不完整时从严补拒写该根的 git 元数据：目录型是整个 `.git`；指针型是指针文件，加解析出的 gitdir 与 commondir 目录（§对 05 的增补「不完整时」）
  readonly incomplete: boolean
}
export function discoverGitProtection(
  q: { readonly root: AbsolutePath; readonly home: AbsolutePath; readonly xdgConfigHome: string | null; readonly platform: 'darwin' | 'linux' },
  ports: GitDiscoveryPorts,
): Promise<GitProtection>

// apps/desktop/src/main/host/sandbox-config.ts —— WorkspaceRoot 只增可选 git?: GitProtection；SandboxHostPaths 只增必填 xdgConfigHome: string | null（从 startupEnv 的 XDG_CONFIG_HOME 取，未设为 null）
// apps/desktop/src/main/host/sandbox.ts —— SandboxFs 只增 readdir、readText（供 DesktopSandbox.wrap 拼 GitDiscoveryPorts）
// packages/kernel/src/permission/workspace.ts —— PathScope.sensitive 只增 hookDirs?: readonly AbsolutePath[]；autoRunNames 只增钩子名
```

- 迁移与回退：不加 Tape 事实名、不改载荷、不改 IPC 路由与表结构；沙箱配置每次 wrap 现算。来源从已有的 `view/assembled` 与 `view/tool_table` 推出。回退到旧版本只是少了这几道检查。

## 一直要成立的规矩

每条都能落到测试（验收号见 §验收标准）。

1. 沙箱里的命令写下列位置被拒：每个工作区根下的 `.git/commondir`、`.git/config.worktree`；根下是普通文件的 `.git` 指针，及它 `gitdir:` 指向的 git 目录（与其 commondir 指向的公共目录）里的 config、config.worktree、commondir、hooks；已存在的 `.git/modules/<名>/`、`.git/worktrees/<名>/` 下的 `config`、`config.worktree`、`commondir`、`hooks`（D4=只拦这几个文件）。
   已解析出的指针目标不按工作区根过滤，一律按平台的存在性规则（规矩 3）进拒写名单；不去推算「哪里本来就写不了」，因为 srt 另有默认可写目录（`getDefaultWritePaths` 里的 `/tmp/claude` 等），不在 Tenon 的 allowWrite 里也可写（E6）。macOS 另拦这些位置的「尚不存在」写法与子目录里新冒出的 `.git`。
2. 加了规矩 1 的保护、且这次发现完整（没触发 §对 05 的增补「不完整时」的回退）时，沙箱里在工作区根的 `git status`、`git add`、`git commit`、`git checkout`、`git stash`、子模块内提交都不受影响。触发回退时，目录型 `.git`、以及指针解析得出的指针型 `.git`，该根的 git 写操作照预期失败；指针型连指针都解析不出时不作此保证（§对 04 的增补「已知限制」）。
3. Linux 上，规矩 1 的 **git 转向条目**只对「wrap 时已存在」的生效（给不存在的转向叶子加 deny 会让 srt 用 `--ro-bind /dev/null` 占位、破坏正常 git，E2、P2）：绝不给普通仓库里不存在的 commondir、config.worktree、子目录 `.git` 加 deny。这几样在 Linux 上拦不住，是已知限制（D5）。这条例外只限 git 转向条目，不适用于钩子位置（规矩 7）。「已存在」按逐级解开链接后的实际目标判（与 srt 解析后再决定绑定还是占位一致），悬空链接按不存在算。
4. 外带 inspector 的出口工具是 builtin 的 WebFetch，或任一连接器调用（`call.tool.source === 'mcp'`；设其来源 S，WebFetch 记 'builtin'）。当会话里存在不可信内容（任一来源，含 S），且存在来源 ≠ S 的私密数据，且（WebFetch 时）URL 不在豁免里，就出「问人」意见（`category: 'exfiltration'`）；任何审批档、会话授权、「总是允许」都免不掉，放行只管这一次（D6=出口含读类连接器）。
5. 连接器调用的结果按来源 `mcp:<serverId>` 既算不可信内容、也算私密数据，对话与任务两种形态都算（D7）。本地私密读仍只在任务形态记 'local'。来源判定不扫内容，按 §对 02 的增补「来源怎么取」；取不到来源时从严，按连接器算（不可信 + 私密 + 出口）。
6. 文件工具（Write、Edit、Delete）写以下位置时判 `sensitive: 'auto-run'`、每次问、只放行这一次、卡上写「这个位置的文件会被自动执行」：某个工作区 git 仓库 `core.hooksPath` 解出的目录；工作区任意深度的 `.husky/`、lefthook 配置与脚本目录（`lefthook.yml`、`.lefthook.yml`、`lefthook.yaml`、`.lefthook.yaml`、`lefthook.toml`、`lefthook.json`，及逐个把 `lefthook` 换成 `lefthook-local` 的六个本地配置名、`.lefthook/`、`.lefthook-local/`）、`.pre-commit-config.yaml`。读与查找不因此出卡。
   已发现的既有转向条目（`redirectExisting`）也按同一规则纳入 `auto-run`，不覆盖已有凭据类别：包括根下 `.git` 指针本身、其 gitdir 与 commondir（分别为实际 git 目录与公共 git 目录）中的 `config`、`config.worktree`、`commondir`、`hooks`，枚举到的子模块/worktree 同类条目，以及已存在的 include 配置来源（§对 05 的增补「配置来源」）。
7. 沙箱里的命令写钩子位置被拒，已存在与尚不存在的都拦（owner 卡 3）。沙箱兑现的范围：两平台都拦每个工作区根下的钩子名单（规矩 6 的名字）与解析出的 `hookDirs`（精确路径）；macOS 另用 glob 拦子目录里的同名位置。Linux 上 srt 丢弃通配写规则（E7），子目录里同名的钩子位置拦不住，记已知限制（与 D5 同属「Linux 做不到」一类）。Linux 上根下尚不存在的钩子位置由 srt 用空占位挡住（P4）。文件工具一侧照规矩 6 任意深度匹配，不受此限。
8. 规矩 4–7 的改动都不放宽任何已有放行：给 `decide()` 的输入多一条「问人」意见，判决只会从放行变问、从问变拒，不会变宽（02 §Inspector 接口与合议）。

## 对 02 的增补

§外带检查 增补（只增连接器维度；WebFetch 的原规则作为 S='builtin' 的特例原样保留）：

- **来源**：WebSearch、WebFetch 记工具名；连接器记 `mcp:<serverId>`；本地私密读记 'local'（E4）。
- **不可信内容**：WebSearch、WebFetch 的结果（原有），加任一已派发的连接器调用的结果。
- **私密数据**：本地私密读（原有，'local'），加任一已派发的连接器调用的结果（两形态都算，D7）。
- **出口**：builtin WebFetch（原有），加任一连接器调用（D6）。
- **何时出卡**（照 owner 卡 2 字面）：对一次出口调用，设其来源 S，当「存在不可信内容（任一来源）」且「存在来源 ≠ S 的私密数据」且（WebFetch 时）URL 不在豁免里，就出「问人」卡，`category: 'exfiltration'`，只放行这一次，不生成授权；「总是允许」的连接器工具照出（第 5 层的问压得过第 6 层的放行，§权限决策顺序 合并第二步）。只有私密数据限定来自别处，不可信内容不要求跨来源。
- **同源豁免**：数据从连接器 X 读来、再写回 X（S=X），则「来源 ≠ X 的私密数据」为空，不出卡。
- WebFetch 原有的 URL 豁免不变；S='builtin' 时上面的判据与原规则等价。

**来源怎么取**（`execution/dispatch_committed` 只有 name、argsHash、decisionKey，没有来源字段）：派发事实的身份是 (runId, requestSeq, ordinal)。按 (runId, requestSeq) 找同一次请求的 `view/assembled`，取 `tools.tableKey`，再按该键找 `view/tool_table`，在 `tools[]` 里用派发事实的 `name` 对上那一项，得 `ToolOrigin`。关联不上——缺这两条事实、`tools` 为 null、名字对不上——按规矩 5 从严，记 `unresolved:<name>` 当连接器。不改 Tape 事实。

§挂点与会话视图 增补：`SessionView` 增 `privateSources`，`untrustedSources` 的取值扩到 `mcp:<serverId>`、`unresolved:<name>`；`touchedPrivateData` = `privateSources` 非空。字段只增，老读法不变。

§授权、工作区与外带检查的继承 增补：父子会话合并来源集合时，`privateSources` 照 `untrustedSources` 的同一口径合并（父、子、交接回来的子取并集），`touchedPrivateData` 从合并后的 `privateSources` 是否非空算，不再单独用布尔或。合并点在 `batch.ts` 的 `judgeCall`，保留已有的跨会话外带回归测试（`subagent-security.test.ts` 的继承两条）。

实现位置：packages/kernel/src/permission/session-view.ts → buildSessionView；packages/kernel/src/permission/exfiltration.ts → exfiltrationOpinion；packages/kernel/src/loop/batch.ts → judgeCall

## 对 03 的增补

§连接器卡 增补：连接器工具设了「总是允许」时，第 6 层仍放行（§三态、第 3 层与第 6 层 不变）；外带 inspector（第 5 层）在规矩 4 成立时把这次调用改为出卡，与「总是允许」无关。出的是 02 的 `flagged` / `category: exfiltration` 卡，「对象」行显示这次连接器调用（server 显示名取 `mcp.list`）。不新增三态值、不改 launchHash、不改定义钉住。

## 对 04 的增补

§档位到 srt 配置 增补（workspace-write 档，每个是「会话文件夹」的工作区根）：denyWrite 在原有 `.git/hooks`、`.git/config`（ROOT_GIT）之外，另加三组，都来自这次 wrap 现算的 `GitProtection`、不接受模型输入：

- **转向文件组**（规矩 1，D4=只拦文件）：`redirectExisting`；macOS 另加 `redirectAbsent`。
- **钩子位置组**：`hookDirs` 与 `hookNames`（规矩 6、7）。
- **从严补拒写**：`fallbackDeny`（发现不完整时）。
- **平台取舍**（E1、E2、P1、P2）：macOS 用 Seatbelt 按解析后路径比，既拦已存在也拦尚不存在，并照 04 原有做法对子目录同名项加 glob；子目录新冒出的 `.git` 用 `<根>/*/**/.git`（至少隔一层，避开 `<根>/**/.git` 连根下 `.git` 一起拦，E1）。Linux 上转向文件组只拦已存在的条目（规矩 3）；钩子位置组两平台都拦每个根下的 `hookNames` 与精确的 `hookDirs`，不论在不在（规矩 7），尚不存在的由 srt 的空占位挡住（P4）；macOS 另对 `hookNames` 加子目录 glob，Linux 不收 glob（E7）；`fallbackDeny` 的条目本来都已存在。

**链接写法细化**：04 §档位到 srt 配置「链接」里，含 `..` 的条目改交解开 `..` 之前链接后的拼法；适用于 denyRead 与 denyWrite 的全部条目，实际目标及途经链接的保护仍照原规则。

**调用链**：`DesktopSandbox.wrap` 每次包装前，对每个是会话文件夹的根先 `await discoverGitProtection(...)`（端口由 `SandboxFs` 拼出），把结果放进 `WorkspaceRoot.git`，再交给同步的 `wrapFilesystem` 拼配置。每次 wrap 现算，不复用文件工具一侧的结果或缓存。

§已知限制 增补（按平台分，区分实测与推断）：
- Linux 上无法拦「在普通仓库新建 commondir/config.worktree」与「在子目录新建 `.git`」——P2 实测：给不存在的转向叶子加 deny 会用占位破坏所有正常 git。文件工具一侧对任意深度 `.git/**` 仍每次问（05），缺口只在沙箱里的命令（§给 06 的约束）。
- `git submodule update` 两平台都失败（写被保护的子模块 config/config.worktree，P1、P2 实测）。`git worktree add` 在 macOS 失败（子目录 glob 命中新 worktree 的 `.git`，P1），在 Linux 照常（P2 实测）。子目录里新建仓库的提交在 macOS 失败（P1），Linux 不拦。这些要在沙箱外跑。
- 发现不完整时按 `fallbackDeny` 从严：目录型 `.git` 整个拒写；指针型 `.git` 拒写指针文件，并拒写解析出的实际 gitdir 与 commondir 目录（普通指针文件不是符号链接，只拒写它不会连带护住 `gitdir:` 指向的目录）。这两种情况下这次命令里该根的 git 写操作照预期失败，日志写明原因；这些都是已存在的位置，Linux 上是只读绑定、不新增占位（验收 15）。
- 指针型 `.git` 连指针都解析不出时，回退只能拒写指针文件本身，它指向的 git 目录若在可写范围内仍可写，提交失败的保证只对目录型与指针解析得出的指针型成立。
- Linux 上 srt 丢弃通配写规则（`sandbox-manager.js` 的 `stripWriteGlobs`，E7），所以子目录里同名的钩子位置沙箱拦不住；文件工具一侧任意深度仍每次问。它与 D5 同属「Linux 做不到」一类：照 owner 在 OQ2 的选择，06 在 Linux 上对沙箱命令照样出卡（§给 06 的约束）。
- Linux 上命令运行期间，工作区根下尚不存在的钩子位置（`lefthook.yml`、`.pre-commit-config.yaml`、`.husky`、`core.hooksPath` 指向但还没建的目录）在宿主上冒出空的 0444 文件占位——P4 所测的都是根下的直接叶子，其中本该是目录的 `.husky`、hooksPath 目录也是文件，这段时间里宿主上建不了这几个目录（缺失中间目录时 srt 可能改用空目录占位，未测）。沙箱里与宿主上的 `git status` 把它们列成未跟踪项（与 04 已有的 17 个占位同一类），沙箱里 `git add -A` 本来就因 04 的占位失败；`git add <路径>`、`git commit` 两边照常。在清理被调用、且没有别的活动 wrap 时清除；还有并发命令时延后（E2）；被 SIGKILL 留下的残留宿主上照样能提交，按启动恢复处理（04 的占位记录），或由之后一次没有别的活动 wrap 的清理清掉。宿主上用 `.lefthook.yml` 的项目在占位期间提交照常成功，这段时间里 lefthook 是否照常执行其中的命令未核验；pre-commit 未测（两台 VM 都没装）。以上 P4 在两台 Lima 上实测。

实现位置：apps/desktop/src/main/host/sandbox-config.ts → wrapFilesystem；apps/desktop/src/main/host/sandbox.ts → DesktopSandbox

### 给 06 的约束

Linux 上「在子目录新建 `.git`、在普通仓库新建 commondir/config.worktree」与「子目录里同名的钩子位置」沙箱拦不住（规矩 3、7，D5，E7）。06 开自动档时，Linux 上只放宽原本就符合自动档条件的普通文件工具操作；敏感位置（`.git/**`、钩子位置、凭据等 05 名单里的位置）仍每次问；沙箱里的命令仍出卡、卡上说明原因（macOS 不受此限），直到有办法在 Linux 上安全地拦住这类新建。

## 对 05 的增补

§硬链接、保护名单与选文件夹 增补：「会被自动执行的名字」增规矩 6 的钩子位置。解析只有一份实现、两条调用链共用其输出契约，不破坏「kernel 不碰文件系统」：

- **发现**：`discoverGitProtection`（`git-protection.ts`）只读文件、不起 git 子进程，所以本机有没有 git 都一样。
  它读工作区的 `.git/config`、指针目标与公共目录的 config、用户全局 git 配置（`$XDG_CONFIG_HOME/git/config` 或 `~/.config/git/config`、`~/.gitconfig`）取 `core.hooksPath`（相对 worktree 解析；husky 的 `.husky/_` 另带父目录 `.husky/`，E3），`include.path` 与 `includeIf.*.path` 一律跟进（不判条件、取并集，深度与文件数有上限）；枚举已存在的子模块/worktree git 目录与转向文件；解析 `.git` 指针的 `gitdir:` 与 commondir（解出的目标不按工作区根过滤，规矩 1）。每个条目「在不在」都按逐级解开链接后的实际目标判，不以链接本身 `lstat` 成功为准，悬空链接算不存在。`.husky/`、lefthook 一族与脚本目录、`.pre-commit-config.yaml` 按名字无条件进 `hookNames`。
- **配置来源**：发现时已经解析出且存在的 include 目标并入 `redirectExisting`，沙箱拒写；在读正文与真实路径去重之前登记每一种拼法，读取失败或同一目标经另一链接引入也不丢弃。缺失 include 不加入 `redirectAbsent`，Linux 上不为它新增占位。文件工具把已发现的 `redirectExisting` 来源按 `auto-run` 并入敏感表，同时登记末级链接不解开的拼法（供 Delete）与实际目标（供 Write、Edit），发现不完整也保留；不覆盖已有的凭据类别。
- **hooksPath 取值**：空值不生成钩子目录；只有写法规范化后与真实位置都为 `/dev/null` 时，才不登记该设备本身。普通文件、FIFO（命名管道）、socket（套接字）、缺失目标，以及可替换的 `/dev/null` 链接别名都仍保护，防止它们被换成钩子目录。include 精确指向 `/dev/null` 时视为空配置，不读、不拒写、不触发不完整；不扩大到整个 `/dev/`。一条 hooksPath 解不开只记不完整，继续解析后续 hooksPath 与 include。
- **配置读法**：配置节头后的同一行键值照常解析；`config.worktree` 中的 hooksPath 也独立解析。XDG 配置根取启动时环境，不随之后进程环境变化。
- **根下没有 `.git`**：转向文件组为空；`hookNames` 照加；全局配置里的 `core.hooksPath` 照解析（相对路径按根解）。
- **不完整时**（偏严）：任一应读的配置读不出或超长、include 超上限、指针解析不了、目录枚举失败或超预算，置 `incomplete`、记日志，并把该根的 git 元数据整个放进 `fallbackDeny`，不按失败的那一级细分：
  ① 目录型 `.git`：解开链接后实际存在的整个 `.git`。② 指针型 `.git`，`gitdir:`（及其中的 commondir）解析成功：指针文件本身，加解析出的实际 gitdir 目录与 commondir 目录，照平台存在性规则处理（都是已存在的目录，Linux 上是只读绑定、不产生占位）。③ 指针型 `.git`，连指针都解析不出：只拒写指针文件本身，记诊断与已知限制。
  根下没有 `.git`、或 `.git` 是悬空链接时，`fallbackDeny` 为空，只记诊断。
  `hooksPath` 解不出的部分另由 `fallbackDeny` 里的 git 元数据（含其中的 config）兜住配置来源，解不出的目录本身拦不到，记已知限制。
- **两条调用链**：① 文件工具：`sensitive-paths.ts` 在会话开始、工作区变化、每张快照列文件时调同一个函数，把 `hookDirs`（真实路径）与 `hookNames` 并进 `PathScope.sensitive`；不完整时照 05 链接扫描的做法记 `incomplete` 与诊断，名字类保护照常。② 沙箱：见 §对 04 的增补「调用链」。两边共用解析实现与输出契约，不共用跨刷新周期的缓存。
- **匹配在 kernel**（`workspace.ts` 的 `sensitiveName`，纯函数）：只按传入的名单与 `hookDirs` 比对，不读磁盘、不读 git 配置。

§已知限制与代价 增补：05 原有的「`.git` 指针所指、在 `.git/` 以外的 git 目录不在自动执行名单」这一条收窄：根下指针所指 gitdir 与 commondir 中已发现且存在的 `config`、`config.worktree`、`commondir`、`hooks` 已按规矩 6 纳入敏感表；这些 git 目录里的其他文件，以及未另选为会话文件夹根的子目录 `.git` 指针所指的外部 git 目录，仍不在这项发现保护范围内。

`core.hooksPath` 在配置读不出时解不出的目录，文件工具与沙箱都认不到（沙箱侧以 `fallbackDeny` 兜住 git 元数据本身）。一个位置同时属于「会被自动执行」与别的类别时，卡只说第一类（`sensitive-path` 的 facts 只有一个 category，原有限制）。

实现位置：packages/kernel/src/permission/workspace.ts → sensitiveName；apps/desktop/src/main/host/git-protection.ts → discoverGitProtection

## 验收标准

1. 沙箱里改写工作区根下已有 linked worktree 的 `.git` 指针文件或它指向的 config、hooks，或改子模块 `.git/modules/<名>/config`、`hooks`：被拒，宿主随后的 `git status` 不执行 fsmonitor；指针目标在另一个工作区根的普通目录里（如 `根B/git-meta/`，不选旧规则本来就护着的 `根B/.git/`）、或落在 srt 默认可写目录下的普通目录里（如 `/tmp/claude/<x>/git-meta/`）时，交给 srt 的拒写配置里同样有它的 config 与 hooks（平台：macOS、Linux）。
2. 沙箱里写根下 `.git/commondir`、`.git/config.worktree`，或在子目录新建 `.git`：被拒，宿主随后的 `git status` 不执行 fsmonitor（平台：macOS）。
3. 加了规矩 1 的保护、发现完整没触发回退时，沙箱里在工作区根 `git status`、add、commit、checkout、stash 与子模块内提交都成功；Linux 上命令结束后工作区没有多出 `.git/commondir`、`.git/config.worktree` 的空占位文件，命令运行期间宿主 `git status` 正常（平台：macOS、Linux）。
4. Linux 上在子目录新建 `.git`、或在普通仓库新建 `.git/commondir`：不被沙箱拦下（已知限制的表征测试）（平台：Linux）。
5. 会话里先读了连接器 A 的注入文档（既是不可信内容也是私密数据），再调「总是允许」的连接器 B 发送：出一张 `category: exfiltration` 的卡，批准后只派发这一次（kernel 回环测试）。
6. 会话里没有不可信内容与私密数据时，调同一个「总是允许」的连接器写入：直接派发，不出卡（kernel 回环测试，正常行为对照）。
7. 数据从连接器 X 读来、再写回连接器 X：不出外带卡（kernel 单元测试）。
8. `buildSessionView` 从冻结工具表取来源，把连接器结果记进 `untrustedSources` 与 `privateSources`（`mcp:<serverId>`），对话形态也记私密；关联不上来源时记 `unresolved:<name>` 当连接器；WebSearch / WebFetch 记工具名（kernel 单元测试）。
9. 文件工具 Write、Edit 写 `core.hooksPath`（经该仓库 `.git/config` 或全局 git 配置解析）指向的某个自定义目录里的钩子脚本：判 `sensitive: 'auto-run'`、每次问、卡上写「会被自动执行」（sensitive-paths 测试，平台：macOS、Linux）。
10. 文件工具写工作区任意深度的 `.husky/pre-commit`、`lefthook.yml`（及一族）、`.pre-commit-config.yaml`：判 `sensitive: 'auto-run'`、每次问（sensitive-paths 测试，平台：macOS、Linux）。
11. 把 `core.hooksPath` 设成一个自定义目录（如 `my-hooks`）时写其中的脚本判 `auto-run`；未配置 `core.hooksPath` 时写同名普通目录里的脚本不判 `auto-run`、place 为 workspace（sensitive-paths 测试，平台：macOS、Linux）。
12. 沙箱里的命令写工作区根下的 `.husky/pre-commit`、`lefthook.yml`、`.pre-commit-config.yaml` 与 `core.hooksPath` 解出的目录里的文件：原来就有、原来没有要新建两种夹具都被拒；macOS 另拦子目录里的同名位置；Linux 上原来没有的，在没有别的活动 wrap、且 `afterExit` 完成之后检查，宿主上不留占位（平台：macOS、Linux）。
13. 任务形态里，会话只有连接器 S 的结果（不可信来源只有 S）和一次本地私密读（私密来源 'local'），再调 S 发送：照出外带卡（kernel 单元测试；新判据出卡，旧的「不可信也要跨来源」判据不出，二者可区分）。
14. 子会话读了连接器 A 的结果，交接回父会话后，父会话调连接器 B（A ≠ B）发送：合并后的 `untrustedSources` 与 `privateSources` 都含 `mcp:A`，外带卡照出（kernel 回环测试）。
15. 发现不完整（只在 Tenon 的发现端口上注入「`.git/config` 读不出」或「`.git/modules` 枚举失败」，磁盘上的仓库本身完好：同一仓库在宿主上 `git status`、`git commit` 照常，注入关掉后沙箱里 `git commit` 也成功）时，分两种夹具：目录型仓库，交给 srt 的拒写配置含该根整个 `.git`；指针型仓库（linked worktree，注入落在它要读的那份配置上，如 commondir 里的 config），拒写配置含指针文件、解析出的 gitdir 与 commondir 目录。两种都有说明原因的诊断，沙箱里在该根 `git commit` 照预期失败；Linux 上在没有别的活动 wrap、且 `afterExit` 完成之后检查不新增占位（平台：macOS、Linux）。

## 开放问题

（无）

## 修订记录

- 2026-11-08 · 按 owner 定的 D4–D7 与第一轮 Codex 评审（review-codex-r1.md）就地修订（draft，无代码依赖）：清空开放问题；外带判据改为「不可信任一来源、私密要求跨来源」；来源从冻结工具表取、取不到从严；父子 `privateSources` 合并；沙箱发现集中到 `git-protection.ts`；`.husky/` 无条件保护；平台代价按实测分平台；加 §给 06 的约束。
- 2026-11-08 · 按第二轮 Codex 复核（review-codex-r2.md）修订：指针目标恢复成「指针及它指向的配置与钩子」（规矩 1）；写清 `DesktopSandbox.wrap` 的调用链与发现不完整时的从严处理；§给 06 的约束 改为只放宽普通文件工具操作、敏感位置仍每次问；验收 13、14 改成可达且能区分判据的前提；页头补 §授权、工作区与外带检查的继承。
- 2026-11-08 · 按第三轮 Codex 复核（review-codex-r3.md）修订：指针目标不再按工作区根过滤（规矩 1、E6）；Linux「只拦已存在」只限 git 转向条目，钩子位置照卡 3 无条件拦，代价按 P4 实测写进已知限制（规矩 3、7、§对 04、验收 12）；正常 git 保证加「发现完整」前提，新增回退验收 15；「已存在」按解开链接后的实际目标判。
- 2026-11-08 · 按第四轮 Codex 复核（review-codex-r4.md）修订：回退统一为「该根整个 `.git` 拒写」（规矩 2、§对 05、验收 15）；写清沙箱对钩子名的兑现范围，Linux 子目录同名位置拦不住记已知限制（规矩 7、§对 04、§给 06 的约束、验收 12、E7）；占位清理时机加并发与崩溃条件；验收 1 的跨根与默认可写目录夹具改用普通目录。
- 2026-11-08 · 按第五轮 Codex 复核（review-codex-r5.md）修订：回退里「整个 `.git`」按仓库形态分三种——目录型整个 `.git`；指针型且指针解析得出，拒写指针文件加实际 gitdir 与 commondir；指针解析不出，只拒写指针本身、提交失败不作保证并写进已知限制（§接口、规矩 2、§对 04、§对 05、验收 15）。
- 2026-11-09 · 按 owner 2026-11-08「也拦 (Recommended)」（picks.md §C 段安全评审建议 3）与 C 段复核，补明已存在的 include 配置来源在沙箱拒写、文件工具每次问；保留各链接拼法与实际目标、部分发现结果及已有凭据类别，缺失 include 不新增占位（规矩 6、§接口、§对 05 的增补；只收紧与澄清） · PR #86（0729ebb、fa89884）。
- 2026-11-09 · 对齐 C 段固定钩子名单：逐项写清六个 lefthook 本地配置名与 `.lefthook/`、`.lefthook-local/` 脚本目录（规矩 6；实现细化，依据 evidence.md E3） · PR #86（8e9c73f）。
- 2026-11-09 · 按 C-security.md、C-security-r2.md 的最终修法澄清 hooksPath 空值、普通文件/FIFO/socket/缺失目标、精确 `/dev/null` 与可替换别名；include `/dev/null` 视为空配置，单个坏 hooksPath 不阻断后续条目；补同一行键值、config.worktree 与启动 XDG 配置读法；写明 `SandboxHostPaths.xdgConfigHome` 改必填，值取 startupEnv 的 `XDG_CONFIG_HOME`、未设为 null（§对 05 的增补、§接口） · PR #86（8e9c73f、fa89884）。
- 2026-11-09 · 按 A 段安全复核补明含 `..` 的拒绝条目先解开其前面的链接，再把所得拼法交给 srt；适用于 denyRead 与 denyWrite 的全部条目，未放宽实际目标或途经链接的保护（§对 04 的增补「链接写法细化」） · PR #84（2c086f4）。
- 2026-11-09 · 规矩 6、§对 05 的增补「已知限制与代价」 · 按 D-review.md 建议 1 写清文件工具对已发现既有转向条目的收紧，并将 05 的指针目标限制限定为未发现的子目录指针与 git 目录中的其他文件；不改旧 spec 正文或实现 · PR #86（fa89884）、03bd512。
