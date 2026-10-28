# 05 · 文件桥：改动前留底与一键还原（阶段 4b）

Status: ready
Approved: ready · 2026-10-24 · 「05 改 ready」 · 对话
Tier: heavy — 碰 Tape、权限判定（可逆性、保护名单、会话授权）、提示层，并且会删、会还原用户的文件
Phase: 4（4b）
Changes: 00 §HostAdapter（增补）；00 §本地持久化布局（增补）；01 §保留命名空间（增补：只声明 fs slice 的写入方与身份）；02 §可逆性（增补：点名，见 §点名）；02 §内置工具的默认档位（增补：点名，见 §点名）；02 §「在不在工作区里」（增补：点名，见 §点名）；02 §内置工具与参数（增补：点名，见 §点名）；02 §决策表与各层输入（增补：点名，见 §点名）；02 §载荷（增补）；02 §作用域与授权键（增补）；02 §工作区（增补：点名，见 §点名）；02 §点停止时各状态怎么收（增补：点名，见 §点名）；presentation-r1 §审批卡（增补）；presentation-r1 §结算行（增补）；presentation-r1 §工具行（增补）；presentation-r1 §工具行（替换：收起时的标记）

## 给你看的一页

做什么：agent 改你的文件之前自动留底，一轮任务做完能一键还原；同时补上改文件时的几道保护。

你会看到：
- 审批卡上写清「有快照，这一轮可以一键还原」，或者「Tenon 没法替你撤回」。
- 每轮结束那一行多一个「可还原」；点它先逐个列出要放回、要删除、要跳过的文件，确认后才动手。
- 你读过之后被别人改了的文件，agent 不会盖掉，会先重读。
- 读私钥、改会被自动执行的文件、改还连着别处的文件，每次都问，卡上说清是什么。
- 新工具「删除」：只删一个文件，删之前留底；结算行里算「删了 N 个文件」。
- 做了但出错的工具行，收起时也看得出来；会话标题旁的菜单里有「查看本次记录」。

```
你发消息 ─► 每次改文件或跑命令之前拍一张，之后再记一次（存在 Tenon 自己的目录里）
            拍不了整个文件夹 ─► 只留这一个文件的副本
小结「可还原」─► 清单 ─► 只把 agent 这一轮改过的放回去；命令跑完之后、等审批时你改的不动
```

不做：删除先进回收站（以后加）；对话一起回退或分叉（阶段 6）；「撤销还原」的入口（以后加，05 先把还原前的状态拍下）；自动档（06）；时间线与带样式的改动预览（4d）；Windows 上的整个文件夹快照。

代价和已知限制：命令的改动只在整个文件夹的快照可用时才能还原；被 `.gitignore` 排除的、你自己的 `.git` 里的、发到网上的都还原不了；选定文件夹后就在后台把它复制一份进 Tenon 的目录，只读的任务也复制，最多占 3 GB；第一张要拍几秒到半分钟以上；快照清掉之后，删掉的文件就找不回了；还原过的文件修改时间是还原那一刻，按时间排序会排在前面；命令运行的那段时间里你在同一文件夹改的文件，分不出是谁改的，会随命令的改动一起还原；文件夹里早就有的、连到外面的硬链接，读它不出卡；跑一次基线评测约 45 元，上限 75 元（照 04 那次的记录）。

要你定的：63 张卡都标了推荐。D1–D28、D32、D33、D37–D46、D48、D52、D55–D63 是你定的或已告知你；D54 由 lead 定、已告知你；其余是实现取舍、lead 定，没有待定的。难退 4 张（D8、D12、D13、D48），你已逐张回了一行；中等 6 张。

怎么算做完：
- 改文件前留底，拍不成就不写，卡上照实说（验收 1、2、4）。
- 一个会写文件的任务做完、点还原，文件回到任务前，git 状态干净（验收 15）。
- 还原先给清单，只动 agent 改过的；之后又被改过的逐个问；删掉的文件夹能回来，绝不写到文件夹外面（验收 16、18、19、39、49）。
- 你读过之后被改的文件不会被盖掉（验收 23）。
- 凭据、会被自动执行的位置、有两个名字的文件每次都问，之前点过「允许」也照问（验收 25、26、27）。
- 删除工具删之前留底，能还原（验收 29）。
- 小结有「可还原」，出错的工具行看得出来，菜单里能看本次记录（验收 33、34、47）。

## 外部依据

- Codex 拿掉了基于 git 的撤销：命令在 2026-01 中旬之前已被拿掉，代码在 2026-04-28 整体删除；它把提交写在用户自己的仓库里，和这里的影子仓库不是同一设计（E1）。
- Claude Code 的检查点按回合、只管文件编辑工具，保留最近 100 个、每个文件第一张不删、约 30 天清，链接与硬链接跳过并报个数（E2）。
- VS Code 还原前写明外部副作用还原不了；Cline 用影子 git，文档说大仓库会变慢（E3）。
- WorkBuddy 所有会话共用 3000 MB 备份上限、满了先清最旧（E4）。
- 本机 git 的快照、隔离、嵌套仓库、链接、还原、mtime 精度、硬链接、大文件，在 macOS 与两台 Ubuntu 上实测过（P1–P10）；还原的几种失手在两轮挑刺评审的复现程序上实测过（P12–P16、P21–P26）；`.gitattributes`、首张前列文件、回退到旧版本都已实测（P11、P17、P19）；git 最低版本未核实（P18）；Windows 未测（P20）。

## 接口

```ts
// packages/kernel/src/host/adapter.ts —— 对 00 只增（D12；不加 utimes，D56）
export interface HostAdapter { /* 已有九个成员不动 */ readonly snapshots: HostSnapshots }

export interface HostFs {
  /* 已有成员一个不动；writeFile 打开叶子时加 O_NOFOLLOW（D18） */
  readonly guarded: { // D58 A（owner 已定）：只给 mtime 守卫用
    read(path: AbsolutePath, opts?: { encoding?: 'utf8' }): Promise<{ data: Uint8Array | string; stamp: FileIdentity | null }> // 印记取同一次打开的 fstat；读的前后句柄上的 fstat 不同时 stamp 为 null
    create(path: AbsolutePath, data: Uint8Array | string): Promise<void> // 排他新建，已存在就抛
  }
  remove(path: AbsolutePath): Promise<void> // 只删一个普通文件或链接本身；不跟随叶子；目录与不存在都抛
  identity(path: AbsolutePath): Promise<FileIdentity | null> // lstat 语义，不跟随叶子；不存在为 null
}
export interface FileIdentity {
  readonly kind: 'file' | 'dir' | 'link' | 'other'
  readonly size: number
  readonly nlink: number
  readonly mtimeNs: bigint
  readonly mode: number // & 0o7777
  readonly dev: bigint // 所在设备号，认卷根用（D55）
}
export type SnapshotCoverage = 'tree' | 'file' | 'none'
export type SnapshotStatus = 'tree' | 'warming' | 'file-only' | 'unavailable'

export interface HostSnapshots {
  coverage(q: { sessionId: string; path: AbsolutePath }): Promise<SnapshotCoverage> // 只读、不抛；1 秒内答不出按 none（D1、D53）
  status(sessionId: string): SnapshotStatus // 同步、不抛（D23）
  take(q: SnapshotRequest, signal: AbortSignal): Promise<SnapshotTaken> // 拍不成、超时、中止、超预算都 resolve 成 ok: false
  preview(q: RestoreQuery): Promise<RestorePreview> // 只读
  prepare(q: RestoreQuery & { previewKey: string }): Promise<RestorePrepared> // 拿租约、拍还原前那张、重算清单；不动工作区
  apply(q: { sessionId: string; undoSnapshotId: string; overwrite: readonly AbsolutePath[] }): Promise<RestoreDone> // fs/restore_started 写成之后才调
  cancel(q: { sessionId: string; undoSnapshotId: string }): Promise<void> // 写事实失败时放掉租约
  alive(sessionId: string, ids: readonly string[]): Promise<ReadonlySet<string>>
}
export interface SnapshotRequest {
  sessionId: string // 根会话（D39）
  call: { sessionId: string; roundRunId: string; runId: string; requestSeq: number; ordinal: number } // kernel 从 Tape 算好传入
  folders: readonly AbsolutePath[]
  moment: 'before-call' | 'after-call' | 'before-restore'
  path?: AbsolutePath // 只给文件工具：判定用的对象路径
}
export type SnapshotTaken =
  | { ok: true; snapshotId: string; scope: 'tree' | 'file'; target?: FileIdentity | null; skipped: number }
  | { ok: false; reason: 'over-budget' | 'not-covered' | 'no-git' | 'disk' | 'aborted' | 'error' }
export interface RestoreQuery {
  sessionId: string
  roundRunId: string
  calls: readonly { callKey: string; before?: string; after?: string; path?: AbsolutePath }[] // kernel 从根与子会话的 fs/snapshot_created 收齐，按调用顺序
}
export interface RestorePreview {
  previewKey: string
  restore: readonly AbsolutePath[] // 内容或权限位放回，含恢复被删的
  remove: readonly AbsolutePath[] // 这一轮新建的
  conflicts: readonly AbsolutePath[]
  skipped: readonly { path: AbsolutePath; reason: 'excluded' | 'not-covered' | 'hardlink' | 'outside-folders'; promised?: true }[] // promised：卡上标过有快照
}
export type RestorePrepared =
  | { ok: true; undoSnapshotId: string }
  | { ok: false; reason: 'stale' | 'busy' | 'undo-unavailable' | 'over-budget' | 'gone' }
export interface RestoreDone { restored: number; removed: number; kept: number; failed: readonly AbsolutePath[] }
// ConfirmReason 只增 'sensitive-path'，必填 facts：path、category（'credential' | 'auto-run' | 'hardlink'）（D33）

// packages/kernel/src/permission/reversibility.ts —— 多一个可选入参（D1）
export function reversibilityOf(
  tool: Pick<ToolOrigin, 'source' | 'originalName'>,
  args: Readonly<Record<string, unknown>>,
  coverage?: SnapshotCoverage,
): Reversibility

// packages/kernel/src/permission/workspace.ts —— 只增（D20、D33）
export interface PathScope {
  /* 已有四项不动 */
  readonly sensitive?: {
    readonly credential: readonly AbsolutePath[]
    readonly autoRunNames: readonly string[]
    readonly linkTargets: readonly { real: AbsolutePath; category: 'credential' | 'auto-run' }[] // 名单项逐级解开链接后的最终位置（D51）
  }
}
export interface PathVerdict { real: AbsolutePath; place: PathPlace; sensitive?: 'credential' | 'auto-run' | 'hardlink' }
// packages/kernel/src/permission/decide.ts —— LayerInputs 只增可选的 sensitive（D52）

// packages/kernel/src/tape/entry.ts —— 只增（D13、D31）
export type SnapshotCreatedPayload = {
  snapshotId: string; runId: string; requestSeq: number; ordinal: number
  moment: 'before-call' | 'after-call'; scope: 'tree' | 'file'; path?: AbsolutePath
  commits?: Record<string, string> // 文件夹 → 提交号
  files?: Record<string, string> // 路径 → 内容哈希
  roundRunId: string; skipped: number; writer: FactWriter
}
export type RestoreStartedPayload = { roundRunId: string; undoSnapshotId: string; previewKey: string }
export type RestoredPayload = { roundRunId: string; undoSnapshotId: string; restored: number; removed: number; kept: number; skipped: number; failed: number }
// ToolOutcomePayload 只增：snapshotId?: string；file?: { mtimeNs: string; size: number }
// PermissionDecidedPayload 只增：coverage?: SnapshotCoverage；fileTarget?: { kind; nlink } | null
```

- Tape 名字（`fs/` 前缀 01 已整个保留，现行 `names.ts` 也已声明 `fs/snapshot_created`、只是没有身份列；05 只补写入方与身份）：`fs/snapshot_created`，event，slice `fs`，身份 `runtime_event`、runId、requestSeq，键 `fs:v1:snapshot:<runId>:<requestSeq>:<i>:<moment>`，一次调用的每个时刻只出一个 `snapshotId`；`fs/restore_started` 与 `fs/restored` 是新名，event，slice `fs`，身份 `session`、sessionId、`<n>`，键 `fs:v1:restore_started:<incarnationId>:<n>` 与 `fs:v1:restored:<incarnationId>:<n>`。都登记进 `DECLARED_TAPE_NAMES`、投影、重放与 SQLite、Postgres 一致性测试（D13、D48）。
- contracts 只增三条路由：`snapshot.rounds`（只读：每轮能不能还原、是否覆盖不全、有没有命令没保底、这一轮在根会话里的各个 Run、这一轮已结束时结束在哪条消息，以及根会话每次改动调用的 `callKey` 与快照号，加本会话 `status`；界面按 `runId` 与 `callKey` 对上结算行与工具行，按结束的那条消息在历史里画结算行）；`snapshot.preview` 与 `snapshot.restore` 经根会话的 mailbox 串行，拒绝码 `busy`、`gone`、`stale`、`undo-unavailable`、`over-budget`、`not-cowork`。还原的交接分两段：kernel 调 `prepare`，拿到 `undoSnapshotId` 后先写 `fs/restore_started` 并等它落盘，再调 `apply`，做完写 `fs/restored`；写不成就调 `cancel`，工作区一个字节都不动。轮与调用的身份、`sessionId` 是不是已有的根会话，都由 kernel 一侧按 Tape 算好、验证过再传；`HostSnapshots` 不读 Tape，只确认拼出的目录在 `snapshots/` 之下（D48、D49）。`workspace.pick` 与 `workspace.usePrefill` 的拒绝码只增 `root-folder`，成功响应只增可选的 `warning: 'home'`。
- 本地持久化布局只加一行：`<profileDir>/snapshots/<sessionId>/`，宿主删会话、清空会话时连它一起删（D30）。
- 迁移与回退：只增，不改表结构；05 之前的版本能照常打开写过新事实与新键的会话（P19）；快照目录留在原处，不影响旧版本。

## 一直要成立的规矩

1. 卡上标了「有快照」的调用，派发时拍不成、或拍完之后目标变了，就一个字节都不动，结果 is_error、completed。
2. `before-call` 的 `fs/snapshot_created` 写在动文件之前；`tool_outcome` 的 `snapshotId` 指向它。
3. 只有 Write、Edit、Delete 产出 `snapshotted`；Bash 的可逆性只看模式表；`revertible` 不产出。
4. `reversibilityOf` 是纯函数：工具、参数与 `coverage` 相同，结果相同；`coverage` 记进判决事实。
5. 影子仓库与单文件副本只在 profile 目录里；工作区里不出现 Tenon 的任何文件，用户的 `.git` 不被写。
6. 影子仓库的 git 子进程只用宿主拼的参数与环境，不读用户的系统与全局配置，不运行钩子与 fsmonitor。
7. 还原只动 agent 在这一轮里改过、且起点、最后一次记录、还原前三张都收了的路径；还原前已是起点状态的路径不动；其余文件的内容与 mtime 不变。
8. 还原写的每个路径、要建的每一级父目录，真实路径都在那个工作区文件夹的真实根之下、中间没有链接；不满足就不写、不建。
9. 还原不出审批卡、不经判定；同一个或相互包含的真实文件夹上，有任何会话的进行中 Run、或还没真正结束的宿主写入与命令进程时拒绝；还原拿着租约期间，这些文件夹上新的写入与命令排在它后面。
10. Write、Edit 在本会话对这个真实路径有过读写印记时，大小或纳秒 mtime 与印记不同就不写；目标已不存在时不挡，但用排他新建，期间文件冒出来就不写（D58）。
11. 带 `sensitive` 的调用每次问、只放行这一次，已有的会话授权与继承授权都不算数，任何档位都问；写法与解开链接后的真实路径任一命中都算；Glob、Grep 对凭据是遍历时跳过，不发出要问的调用。
12. Delete 只删一个文件或链接本身，不递归，不跟随叶子链接。
13. 回收之后，一个 profile 的快照实占不超过 3 GB：预算不够、又没有可清的轮时，新快照拒收、按拍不了处理，不删受保护的起点；单个文件超过 100 MB 不进快照。
14. 快照被清掉的轮，界面不再说它「可还原」；拍快照、还原都写新事实，不改旧条目。
15. 卡上标「有快照」的文件工具目标，还原时在「放回 / 删除」之列；成了冲突的进冲突、默认保留，你选了「覆盖」就照常还原；只有之后它多了名字、文件夹移出了工作区、被这一轮后面的整树快照排除时承诺失效，照安全规则进「跳过」并在清单里写明。

## 点名（T36 附表中 4b 承担的行）

对 implemented 的 00、01、02 只增；下列碰到旧文字的条目单列，理由只有两种：(i) 被改的 spec 自己把这件事交给阶段 4；(ii) 收紧原本没限定的选型。没有要整份取代的。

| | 02 的旧句（节名） | 改成 | 归类 | 依据 |
|---|---|---|---|---|
| (a) | §可逆性「可信来源只有两个」里「不经 `HostAdapter`、不为它加成员」 | 判定前问一次 `snapshots.coverage`，答案作纯函数的第三个入参 | (i) | 02「可撤销与有快照……随沙箱和快照重议」；`snapshotted` 行写「阶段 4」；D1 |
| (b) | §可逆性「只看工具和参数，与保护名单、工作区判定无关」 | 文件工具的可逆性另看 `coverage`，而 `coverage` 看在不在工作区、在不在排除里 | (i) | 同上；D1 |
| (c) | §可逆性 表「删除已有文件 = 不可逆」与「阶段 2 只产出三个值」 | 拍得了的 Delete 判 `snapshotted` | (i) | 主参考 §13 阶段 4 ④ 交给阶段 4；D11 |
| (d) | §内置工具与参数「没有删除工具，删除只能经 Bash」 | 删单个文件用 Delete，删目录仍经 Bash；工具表十一个 | (i) | 同上；D11 |
| (e) | §内置工具与参数「执行期失败」清单 | 加四种：读过之后被改、留底之后被改、拍不成、写前名字数变成大于 1；Delete 另有父目录或目标被换 | (ii) | D9、D10、D50 |
| (f) | §「在不在工作区里」第 3 步「取第一个成立的」与「文件工具」所指 | 凭据、会被自动执行的名字、名字数大于 1 的文件判 `outside` 带 `sensitive`；Delete 进文件工具 | (i)+(ii) | 02 第 2 层保护名单「阶段 4 由沙箱补齐」；新名字是收紧；D20、D10、D51 |
| (g) | §内置工具的默认档位「Glob、Grep 的遍历跳过判为 `protected` 的子树和文件」 | 另跳过凭据的子树 | (ii) | D20、D46 |
| (h) | §决策表与各层输入 第 6 层「用户授权……放行」 | 带 `sensitive` 时第 6 层的会话授权与继承授权不认，写法同提权命令清空会话授权；文件工具的可逆性弱于授权时也不认 | (ii) | D52、D61 |
| (i) | §工作区「文件夹进列表只有两条路」 | 两条路都拒根目录与卷根，主目录提醒 | (ii) | D2、D55 |
| (j) | §点停止时各状态怎么收「进程内写操作……等它做完」 | 写类文件工具动文件前查中止，已停不写、记 `aborted` | (ii) | 规矩 1 |

## 快照怎么拍

- 放哪：每个根会话、每个工作区文件夹一个影子仓库，放 `<profileDir>/snapshots/<sessionId>/`，`core.worktree` 指那个文件夹；单文件副本存在同一目录的 `files/` 下，不用 git，每份记清单：存不存在、类型、链接文本、权限位、大小、纳秒 mtime、名字数、内容哈希（D8、D30、D50）。
- `status`：`tree` 整树可用；`warming` 首张还在拍；`file-only` 只留单文件副本；`unavailable` 两样都不行（profile 目录写不进、磁盘满过一次）（D2、D4、D5、D53）。
- 只留单文件副本：工作区真实路径等于主目录、桌面、文稿、下载，或主目录的上级；找不到可用的 git；超过预算；Windows（D2、D4、D5、D54）。
- 可用的 git：绝对路径，`--version` 不低于实测过的 2.43，能在空目录 `init`；macOS 上先跑 `/usr/bin/xcode-select -p`，失败就不碰 `/usr/bin/git`。`xcode-select` 与 git 都经 `HostAdapter.process` 加 `sandbox.wrap` 的 `full-access` 起，只传绝对路径（D4、D12、D54，P8、P18）。
- 首张：任务会话的工作区定下时在后台开始（D37）。先按影子仓库的忽略规则列出要进快照的文件（P17），超过 10 万个、或合计大小超过 3 GB 的余量，就不拍；拍了超过 2 分钟就停。之后每张超过 5 秒同样停。停了这个会话就改为 `file-only`，消息流里提示一次（D5、D53）。
- 什么时候拍：Write、Edit、Delete 在你批准之后、动文件之前拍，`tree` 时拍整树，否则只拍目标；Bash 在 `tree` 时派发前拍整树，派发与停止竞速，停止先到命令就不跑；拍不成或超时命令照跑。每次调用做完再记一次：文件工具记目标的新内容，Bash 再拍一张整树。连接器工具不拍（D8、D29、D32）。
- 拍成的意思（文件工具）：目标的写前状态已收进；整树没收进目标时在同一次 `take` 里补单文件副本，补不了才 `ok: false`；`take` 回传它记下的目标 `identity`（D50）。
- 排除：照工作区的 `.gitignore`，再加一份默认排除（依赖目录、构建产物、系统杂项文件）；子目录里有 `.git` 目录或 `.git` 文件的，整个嵌套根排除；单个文件超过 100 MB 排除；读不了的文件排除并计入 `skipped`；工作区自己的 `.git` 不进。每张之前写进影子仓库的排除表，每张记下自己收了哪些路径，以及这些文件与所在目录的权限位（列文件时那次 lstat 顺带取；git 只存 644 与 755）（D6、D19、D26、D28、D50，P3、P10、P15、P22）。
- 文件工具的目标被 `.gitignore`、默认排除或嵌套仓库挡在整树之外时，单独留一份副本，照标「有快照」；超过 100 MB、在工作区自己的 `.git` 下、不在任何工作区文件夹里、或是有不止一个名字的普通文件（还原会跳过它），`coverage` 答 `none`、不标（D10、D19、D43）。
- 起 git：环境只留固定的 `PATH`，`HOME` 指影子目录，不读系统与全局配置；钩子目录指空目录，关 fsmonitor、换行转换与自动回收，排除与属性文件指空文件；`info/attributes` 关掉换行、ident、过滤与编码转换；文件属主不同时在命令行传 `safe.directory`；`core.ignorecase`、`core.symlinks`、`core.filemode` 在工作区文件夹里探测后显式写入；提交身份固定、不签名；默认索引配置（D12、D35、D36、D54，P2、P11、P15）。
- 存法：整树快照是不带父提交的提交，每张一个引用；还原不写回旧的修改时间，所以不另记 mtime 表（D30、D45）。
- 并发：每个影子仓库一把互斥锁，拍、还原、清理、回收都在锁内；`take` 收中止信号，停止时杀掉 git、丢半截索引；执行器在拍完、写 Tape 之前、动文件之前各查一次中止，已中止就什么都不写。启动时先结束上次记下的 git 进程组，再丢弃影子索引、按最近一张重建（D49、D53）。
- 保留按轮算（一轮即 D6 说的一次任务，D40）：每会话只留最近 20 轮；会话最后一次快照 30 天后全清，这一条覆盖一切。空间不够时先清最旧的轮，删引用后在锁内立即回收，按回收后的实占再判；只有这种空间清理才保护「有进行中 Run 的会话的当前轮」与「每个会话最近一轮」。每次拍（整树或副本）之前按估算大小预留预算，并发的预留一起算；清完可清的仍不够，就返回 `over-budget`，按拍不了处理（卡上标了有快照的就不写），不为兑现新承诺去删受保护的起点。一轮里只要各路径的起点、各次调用前后的记录与还原前那张（D6、D14、D49、D53）。

## 判定时怎么知道拍不拍得了

- 判定 Write、Edit、Delete 之前，kernel 问一次 `coverage`，答案作 `reversibilityOf` 的第三个入参并记进 `tool/permission_decided`（点名 (a)(b)，D1）。
- 取值：`tree`、`file` 为 `snapshotted`；`none` 时 Write、Edit 为 `unknown`，Delete 为 `irreversible`。别的工具不问，对话形态不问。`unavailable`、出错、1 秒内答不出都按 `none`（D1、D53）。
- 派发以卡上的可逆性为准：判定之后会话降级，承诺由单文件副本兑现；兑现不了就按规矩 1 不写。

## 一键还原

- 单位是一轮：从你发一条消息到这一轮结束，中间因审批暂停又续上的 Run 都算，以第一个 Run 的 runId（`roundRunId`）标识；子 agent 在这一轮里改的一并算进来（D39、D40）。
- agent 改过的路径：文件工具是目标；Bash 是它调用前与调用后两张之差，内容或权限位变了都算。每个路径的起点是这一轮第一次改它之前的那张，「最后一次记录」是这一轮最后一次改它之后记下的。两次调用之间、等审批时被别人改的不算 agent 的，不动；命令运行期间别人改的分不出来，算进命令的改动（已知限制）（D29，P14、P23）。
- 只有起点、最后一次记录、还原前三张都收了这个路径，它才进「放回」或「删除」；任一张排除了它、它在当前工作区文件夹之外、它在起点或现在有不止一个名字，都进「跳过」并写原因（D50，P13）。同一路径被这一轮的几次调用改过时，逐对比较：前一次调用之后的记录与后一次调用之前的状态不同，说明中间有别人改过，这个路径算冲突、默认保留（D29，P27）。
- 点「可还原」：宿主拍还原前那张、算清单，逐个列出路径：将还原 n 个、删除 m 个新建、跳过 k 个，不分路径是哪次调用改的；写明命令的副作用、联网请求、被排除的文件还原不了。还原前已是起点状态的路径（例如上次还原做到一半已放回的）什么都不做、不算冲突。冲突是「还原前」与「最后一次记录」不同的路径，逐个问「覆盖 / 保留」，默认保留；调用后那次没记成（停止、崩溃、拍不成）的，它的路径都算冲突（D3、D9、D29）。
- 确认后 `prepare` 先拿这些文件夹的租约、重拍还原前那张、重算清单，与你看过的不符就返回 `stale` 重出清单；还原前那张拍不成或没收全清单里的路径就拒绝（`undo-unavailable`）。租约：宿主给每次工作区里的文件写入与删除、每个命令进程（直到进程真正退出、收尾做完，已中止的也算）记一份共享租约，还原要的是独占租约，同一个或相互包含的真实文件夹上有共享租约就返回 `busy`；还原拿着独占租约时，新的写入与命令等它放掉（P28）。然后照接口一节的两段交接写事实、动文件（D49、D34）。
- 动文件的先后：先删（新建的文件、类型变了的项，深的先删），再放回（浅的先放）；大小写不敏感的卷上，折叠后同名的一删一放当作一项改名。每个路径动手前：比一次 `identity`，与还原前那张不同就跳过；父目录按规矩 8 查：从文件夹真实根往下逐级看，已在的那一级必须是目录、不是链接、真实路径等于根加相对路径，缺的那一级用排他方式、以属主可写的权限新建，任一级不满足这个路径就不写；叶子 `O_NOFOLLOW`；新建用 `O_CREAT|O_EXCL` 加起点的权限位；替换用同目录的临时文件加改名，权限位照起点；只有权限位变了的，只把权限位改回起点、不重写内容。目录里的内容都放回之后，再从深往浅把重建或放回的目录的权限位设成起点值（起点是 0555 这类属主不可写的也一样）（P25）。放回的文件修改时间就是还原那一刻，不写回旧值，好让按修改时间判断的构建工具重新生成产物（D45，P16）。不满足或写不进的列进 `failed`，接着做其余的（D49，P12、P21）。
- 还原较早的一轮只撤那一轮的改动，之后几轮又改过同一文件的按冲突问。启动时见到有 `fs/restore_started` 没有 `fs/restored` 的，消息流里提示「上次还原没做完」，还原前那张随这一轮保留（D49）。

## mtime 守卫

- Read、Write、Edit 成功后，`tool_outcome` 记下文件印记：纳秒 mtime 与大小。Read 用 `guarded.read`，印记取同一次打开的 fstat，读的过程中句柄上的 fstat 变了就不记（D31、D58）。
- Write、Edit 动文件之前，取本会话同一真实路径最近一条印记；`identity` 读到的大小或纳秒 mtime 不同，就不写，固定英文说文件在上次读过之后被改了、先 Read 再改。没有印记的照写，这是已接受的代价（D9）。`identity` 为 null（目标已不在）时不挡：没有可盖的内容，按新建处理，免得「删了再建」被挡死；这时用 `guarded.create` 排他新建，守卫与打开之间文件冒出来就报已存在、不写，回给模型「先重读」那句（D31、D58，P24、P26）。
- 拍完之后、打开文件之前再读一次 `identity`，与 `take` 回传的不同也不写（D50）。

## 硬链接、保护名单与选文件夹

- `locatePath` 的范围只增：凭据（主目录下的 `.ssh`、`.aws`、`.gnupg` 与凭据清单，工作区根下的 `.aws`）；会被自动执行的名字（主目录下自动运行的那组，工作区里任意深度的拒写名字，如 `.vscode`、`.envrc`、`.claude/settings.json`，以及任意深度的 `.git/**` 与叶子段名为 `.git` 的路径，不论是否已存在；git worktree 与 submodule 的指针文件就是这种）。`$ZDOTDIR` 下的 shell 配置并进保护名单。按路径段比较，比较前用与保护名单相同的大小写折叠。desktop 从沙箱配置的同一份名单取（D20、D33、D51）。
- 名单比两种写法：规范化之后、解开链接之前的写法，与解开链接之后的真实路径，任一命中都算。名单里每一项照沙箱配置 `walkLinks` 的口径逐级解开链接（中间任一级是链接都算，如 `.claude` 指向别处、`~/.config` 是链接），解到底的最终位置及其子树同样算（`linkTargets`）；desktop 在会话开始、工作区变化、每张快照列文件时刷新这份目标表（D51，P29）。
- 哪些调用带 `sensitive`：凭据对所有文件工具都带；会被自动执行的名字与 `kind === 'file'` 且名字数大于 1 的文件，只对 Write、Edit、Delete 带，Read、Glob、Grep 照常（工作区内不问）。带 `sensitive` 的 `place` 为 `outside`：每次问、只放行这一次，已有会话授权也照问（点名 (f)(h)，D10、D46、D52）。判定后、写之前名字数变成大于 1 的，不写。
- Glob、Grep 的遍历跳过凭据的子树，不问、不报错；会被自动执行的位置与有多个名字的文件照常搜（点名 (g)，D46）。
- 卡的原因码是 `sensitive-path`，③ 按 `category` 一句（对 presentation-r1 §审批卡 的增补，D33）：「这是登录凭据，读到的内容会发给模型。」「这个位置的文件会被自动执行。」「这个文件还有别的名字，改它会连带改到别处。」
- 选文件夹：kernel 设工作区的唯一入口拒绝真实路径是 `/` 或卷根（`identity` 的 `dev` 与上级的不同；Windows 上是盘符根），`identity` 读不出或抛错按拒绝，选和预填都经它；拒绝码 `root-folder`。主目录与主目录的上级照收，chip 旁提醒一句。05 之前已建、工作区是根或卷根的会话，快照按 `file-only`（点名 (i)，D2、D55）。

## Delete 工具

- 参数只有 `file_path`*；effect `write`；只在任务形态；子会话的工具表照 02 的规则带上它。进 `FILE_TOOL_NAMES` 与 `FILE_TOOLS`，卡的种类 `file`（D11、D51）。
- 路径：父目录取真实路径，叶子照写、不解开（lstat 语义）。位置、保护名单、`sensitive`、`coverage`、卡上对象、授权键、快照对象都按这个路径算；执行前复查父目录没变。保护名单与 profile 目录里的直接拦下、不出卡（D51）。
- 表里加 Delete 四行（问不问、原因码、可逆性）：工作区内拍得了，问、`default`、`snapshotted`；工作区内拍不了，问、`irreversible`、`irreversible`；带 `sensitive` 的问、`sensitive-path`、按 `coverage`；其余工作区外的问、`outside-workspace`、`irreversible`。「允许」都只管这一次：02 §作用域与授权键 的答复作用域表在「其余内置工具」之前加一行「Delete → `once`」（D42）。
- 执行：拍快照；`HostFs.remove`。目标是目录、不存在或父目录变了，都按执行期失败，什么都不删。命令里的 `rm` 不变，照模式表判撤不回、每次问（D11）。

## 审批卡、工具行、结算行与「查看本次记录」

- 审批卡 ④（对 presentation-r1 §审批卡 的增补）：`snapshotted` 中文「有快照，这一轮可以一键还原。」，英文「Snapshot taken first; you can undo this round.」；`revertible` 仍不出现。快照号显示在工具行展开处与「查看本次记录」，不在卡上（D32）。
- 工具行（对 presentation-r1 §工具行 的增补）：Delete 展开后一行「删了这个文件 · ④」/「Deleted this file · ④」，只在成功完成时出。
- 结算行（对 presentation-r1 §结算行 的增补）：加一类「删了 N 个文件」/「Deleted N files」（Delete，成功完成的，按不同路径数）。这一轮有还在的快照时，末尾加「 · 可还原」，点它打开清单；跑过命令或有改动没进快照，写成「可还原（不含被排除的文件）」；有 Bash 调用在派发前没有成功的整树快照（从 Tape 投影），再加「 · 命令的改动可能无法还原」（D5、D17、D19、D47）。任务会话里，重启或切换会话后的历史也画结算行（连同「可还原」与附注），画在 `snapshot.rounds` 报的这一轮结束的那条消息下面；对话会话照旧（D63）。
- `ThreadTitleMenu` 里只有「查看本次记录」：只读列表，本轮每次调用的工具、对象、判决摘要、可逆性、快照号、还能不能还原，从 `session.messages` 与 `snapshot.rounds` 现算（D17、D27）。

## 对 presentation-r1 §工具行「收起时的标记」的替换

替换后的全文：「收起时的标记：可逆性为 `irreversible` 且没出错的行，图标旁有悬停提示「撤不回」；完成但出错（`state === 'completed'` 且 `isError === true`）的行，标记换成失败图标，悬停提示与屏读文字是「没做成」/ "Didn't go through"，不再出「撤不回」；带沙箱回执的行照 04，不叠这个标记。」（D38）

## 给 06 的接口

- `snapshots.status(sessionId)`：06 用它判断「本会话快照可用」；`file-only` 算不算可用由 06 定（D23）。
- 快照载荷不含分支指针；06 要做「还原时拨回分支」时只增一个可选键。

## 提示层与评测

- Delete 的工具描述与结果模板，与四句固定英文（读过之后被改、留底之后被改、拍不成、名字数变了）进提示层；`PROMPT_LAYER_VERSION` 从 11 升到 12，更新哈希（D22）。
- 合并前在基线列上跑全集、每题 3 次，记录与改动同一 PR；lead 逐题对照第 11 版基线，有题从过变不过就停下交 owner（D41）。

## 文档同步

- 起草时：00、01、02、presentation-r1 页头各加 `Changed by: 05（§…）`，与本页头的 `Changes` 成对；总参考阶段表 4b 一行链到本 spec；「以后再说」里「文件工具不认沙箱的凭据清单」「执行失败的工具调用收起后和成功的长得一样」两行换成指向本 spec 的链接，加删除进回收站、「撤销还原」入口两行，Windows 一行补上 05 的几项；入口页重新生成。
- 实现时：overview 的模块表、`HostAdapter` 成员数、术语与信任边界（还原与 Delete 是主进程里不进沙箱的写和删）；`docs/ux/components.md` 的审批卡、结算行、会话标题菜单、工具行四行补记；总参考 §13 阶段 4「快照与一键还原」「任务小结」两条带日期补记；SECURITY.md 已知限制加下一节各条。

## 已知限制与代价

- 命令的改动只在 `tree` 时进快照；被排除的文件、你自己的 `.git`（命令里的 `git commit`、`reset` 改的就是它）、联网发出的、连接器做的事，都还原不了；快照清掉之后，删掉的文件找不回。
- 只在你全局忽略表里挡掉的文件（常见 `.env`）会被复制进快照留到清理。
- 影子仓库的 git 以你的权限运行、不进沙箱：参数只由 Tenon 拼、不读你的 git 全局配置、不跑钩子，但 git 本身若有解析漏洞，后果按你的权限算（D12、D57）。
- 命令运行期间你在同一文件夹改的文件，git 快照分不出是谁改的，会算进命令的改动、还原时不问就撤；只有命令跑完之后、等审批时的改动受保护（P23）。
- `.git` 指针文件指向的、在 `.git/` 以外的 git 目录，不在会被自动执行的名单里。
- 名单路径上的链接若在两次刷新之间才建，直接写它解到底的位置要到下一次刷新才认得；逃出进程组的后台进程（04 §已知限制）不在租约里。
- 工作区里链接目标的扫描不进默认排除目录（如 `node_modules`）、不跟进目录链接；工作区大到扫不完时，本会话只按名字与真实路径认，经链接改到会被自动执行的位置不额外问，下次刷新再扫（D59）。
- 判定与写之间换链接的竞态；命令一侧运行前就有的硬链接；守卫只认大小与纳秒 mtime，同大小、同纳秒 mtime 的不同文件认不出，粒度粗的文件系统上更容易碰到；有多个名字的文件不还原。
- 读与查找不问会被自动执行的位置与有多个名字的文件：工作区里运行前就有的、指向工作区外的硬链接，读它不出卡（D46）。
- 还原过的文件修改时间是还原那一刻，不是任务前的时间；按修改时间排序时排在前面（D45）。
- 没装命令行工具的 macOS（P8）、git 2.43 以下（P18）、Windows（P20）上的行为都没测；Windows 上一律只留单文件副本、叶子不防换链接。
- 每次会改动的调用前后多一次快照：5 万文件约 0.1 秒，加一次列文件（P1、P17）。
- 基线评测用 glm-5.3-flash，一次约 4 元（ADR-005）。

## 验收标准

1. 任务会话里 Write 改工作区内一个已有文件：卡上 ④ 是「有快照」那句；批准后 Tape 里依次有 `before-call` 的 `fs/snapshot_created`、`tool/result`、`execution/tool_outcome`，后者的 `snapshotId` 指向前者。
2. 卡上标了「有快照」的 Write、Edit、Delete，派发时宿主报拍不成：文件一个字节都不动，结果 is_error、completed，回给模型的固定英文写明什么都没写。
3. Bash 的卡在任何情形下都不出「有快照」，可逆性仍照模式表；`tree` 时命令前后各拍一张。
4. 判定前宿主答 `none`（单个文件超过 100 MB、工作区自己的 `.git` 下、工作区外、有两个名字的普通文件、`coverage` 出错或超时）：Write、Edit 的卡写「Tenon 没法替你撤回这次改动」，Delete 的卡写「撤不回」、只放行这一次；判决事实记下 `coverage`。
5. 快照在 profile 目录下；拍快照前后工作区里不多一个文件，用户仓库的 `git status` 输出不变（平台：macOS、Linux）。
6. 用户全局 git 配置里放了排除表、钩子与 fsmonitor 时，快照照收被那份排除表排除的文件，钩子不运行（平台：macOS、Linux）。
7. 嵌套仓库与 submodule 整根不进整树快照；文件工具改嵌套仓库里的文件时单独留一份副本、卡上标「有快照」、能还原；工作区本身是 git worktree 时照常拍（平台：macOS、Linux）。
8. 单个文件超过 100 MB 不进快照，上一张里有、这次超过的从这一张起移出；工作区里有一个读不了的文件时照常拍，它计入跳过。
9. 工作区定下时首张在后台开始；拍完之前文件工具照标「有快照」（单文件副本），命令照跑，这一轮小结带「命令的改动可能无法还原」。
10. 首张要进快照的文件超过 10 万个、或首张超过 2 分钟、或之后某张超过 5 秒：这个会话改为只留单文件副本，消息流里提示一次，之后不再整树拍。
11. 注入失败的 `xcode-select`、低于 2.43 的 git、`init` 失败的 git：都只留单文件副本；`xcode-select` 失败时从不启动 `/usr/bin/git`。
12. 工作区是主目录、桌面、文稿、下载或主目录的上级时不建影子仓库；Write、Edit、Delete 照样留单文件副本、标「有快照」，命令前不拍。
13. 经选文件夹或预填，工作区是 `/` 或一个卷的根（设备号与上级不同）都被拒并说明原因，读不出设备号的也拒；选主目录照收，chip 旁出一句提醒。
14. 每会话只留最近 20 轮；会话最后一次快照 30 天后全清，只有一轮的会话也清；实占超过 3 GB 时先清最旧的轮，回收后实占不超过 3 GB；首张估算会超过余量时不拍；空间清理不清进行中的轮与每个会话最近一轮；受保护的轮已占满预算时新快照返回 `over-budget`、标了有快照的写入不做、受保护的起点不删，两个同时的预留不会一起超；被清的轮不再显示「可还原」；删会话、清空会话时快照一起删。
15. 端到端：选文件夹，发一个会写文件的任务，批准一次写入，完成并看到小结「可还原」，点还原并确认，文件内容回到任务前、用户仓库 `git status` 干净（平台：macOS、Linux）。
16. 点「可还原」先出清单，逐个列出将还原、删除、跳过的路径与跳过原因，写明命令的副作用与联网请求还原不了；点取消一个文件都不动。
17. 还原删掉这一轮新建的文件，恢复这一轮删掉的文件（含 Delete 删的），链接还原成原来的链接；整树快照里一个权限位是 600 的文件，被删、被原地改过、或只被 chmod 成 644，还原后都是 600；放回的文件修改时间不早于点确认的那一刻，按修改时间判断的 make 会重新生成产物。
18. 这一轮之后又被改过的文件逐个问；没选「覆盖」的一个字节都不动；请求里列了不在冲突里的路径，宿主不认。
19. 2 000 个文件的工作区里任务改了 3 个，还原后其余文件的内容与 mtime 不变；被 `.gitignore` 排除的文件、两次调用之间与等审批时你改的文件，也不变。
20. 还原较早的一轮只撤那一轮的改动；之后几轮又改过同一文件的，按冲突问。
21. 还原前先拍一张，`fs/restored` 带它的编号；按这个编号能把文件回到还原前。
22. 还原不出审批卡、不写判决事实；同一个或相互包含的真实文件夹上任何会话有进行中的 Run 时拒绝；`fs/restore_started` 写不成时工作区不动；看清单之后文件又变了，返回 `stale`、什么都不动；还原做到一半退出，下次启动提示「上次还原没做完」。
23. 本会话读过或写过的文件在外面被改了（大小或纳秒 mtime 变了），Write、Edit 不写，回给模型「先重读」那句；重读后再改照常；没读过就整篇 Write 的照写；句柄实际读到的是 B、写之前路径已回到 A，且 A、B 的大小或纳秒 mtime 不同时，不写、要求重读。
24. 重启 Tenon 后续跑的会话，守卫仍按 Tape 里记下的读写印记判。
25. 工作区里有两个名字的文件：Write、Edit、Delete 每次问、只放行这一次、卡上写它还有别的名字、不写「有快照」，之前对它有过会话授权也照问；Read 与 Grep 照常、不出卡；判定后、写之前被加了第二个名字的，不写；目录不算有多个名字（平台：macOS、Linux）。
26. 家目录当工作区时，Read `~/.ssh` 下的私钥出卡，卡上写这是登录凭据，只放行这一次；拒绝后什么都没读；Grep 遍历工作区时跳过 `~/.ssh`。
27. 改任意深度的 `.git/hooks/` 里的文件、`.git` 指针文件、`.vscode/tasks.json`、`.ENVRC`（大小写不同），以及新建一个原来没有的 `.git` 指针文件：每次问，卡上写会被自动执行；之前有过会话授权、父会话有授权、注入自动档，都照问；Read `.vscode/settings.json` 照常、不出卡。
28. 对沙箱拒读、拒写名单里与文件工具共用的每一项（参数化）：Write、Edit、Delete 出 `sensitive-path` 卡，凭据项 Read 也出卡，或照旧直接拦下（shell 配置、profile 目录）。
29. Delete 删工作区里一个文件：卡上是「有快照」那句，批准后文件不在，点还原回来。
30. Delete 目录：执行期失败，什么都不删；Delete 指向保护文件的链接：只删链接、目标不动、卡上对象是链接本身；Delete 保护文件或 profile 目录里的文件：直接拦下、没有卡；命令里的 `rm` 照旧判撤不回、每次问（平台：macOS、Linux）。
31. `snapshots.status` 在四种情形下各答其值；profile 所在的卷写满一次之后答 `unavailable`，消息流提示一次。
32. Write、Edit、Delete 的目标在判定之后被换成链接：不写不删，is_error、completed（平台：macOS、Linux）。
33. 结算行：有快照的轮末尾有「可还原」；覆盖不全时写「可还原（不含被排除的文件）」；有命令没保底时加「命令的改动可能无法还原」；快照被清后不再显示。
34. 「查看本次记录」从会话标题菜单打开，列出本轮每次调用的工具、对象、判决摘要、可逆性、快照号、还能不能还原。
35. 两份 locale 有 `snapshotted` 那句、`sensitive-path` 三句、失败标记与 Delete 两句，文案覆盖测试穷举；`revertible` 仍不出现。
36. `PROMPT_LAYER_VERSION` 为 12、哈希闸通过；基线列全集每题 3 次的记录与改动在同一 PR，逐题对照第 11 版没有从过变不过的题，有就停下交 owner（live）。
37. 子任务里 Write 改的文件，随根会话那一轮一起还原。
38. 文档同步一节列的每一处都改了，`python3 .sdd/spec-check.py` 的 `pairs` 不拦（人工）。
39. 获批的命令把工作区里一个目录换成指向外面的链接：还原先删掉这个链接、再按起点重建目录、把文件放回原处，工作区外的文件不变；还原时那个位置又被换成链接的，那些路径进 `failed`、不往外面写（平台：macOS、Linux）。
40. 大小写不敏感的卷上，任务把 `A.txt` 改名成 `a.txt` 并改了内容：还原后只剩 `A.txt`、内容是任务前的（平台：macOS）。
41. 一轮里 `.gitignore` 变了、出现或去掉了嵌套仓库的 `.git`、文件长过 100 MB：这些路径进「跳过」并写原因，不被删、不被盖。
42. 拍完之后、写之前目标被改：不写，is_error、completed。
43. 在拍快照时点停止：什么都不写，`fs/snapshot_created` 也不写；Bash 派发前那张还没拍完就点停止，命令不跑。
44. profile 与工作区在大小写规则不同的卷上：`Makefile` 与 `makefile` 在快照里不塌成一个（平台：macOS）。
45. 拍快照、还原、清理与回收同时发生时快照不坏；上次留下的 `index.lock` 在启动时被清掉、索引按最近一张重建。
46. 被嵌套仓库、`.gitignore` 挡在整树之外的文件工具目标，还原前后字节一致（单文件副本）。
47. 收起的工具行：完成但出错的有失败标记、不再出「撤不回」；带沙箱回执的行不叠这个标记。
48. 结算行有「删了 N 个文件」；Delete 展开后有「删了这个文件」那一行。
49. 任务删掉工作区里一个带子目录的文件夹（其中一个子目录的起点权限是 0555）：还原后文件夹、子目录与其下文件按起点回来、权限位照起点，`failed` 为空（平台：macOS、Linux）。
50. Read 一个文件、删掉它、再 Write 同一路径：照写，不被守卫挡；守卫判了不在之后、打开之前文件又冒出来：不写，回给模型「先重读」那句，冒出来的文件不变。
51. 还原做到一半退出后再点「可还原」：已放回起点的路径不算冲突、不再动，其余照常还原。
52. 对每一种答 `tree` 或 `file` 的情形（参数化）：卡上标「有快照」的 Write、Edit、Delete 做完后点还原，那个路径都在「放回 / 删除」之列并真的回到起点；成了冲突的进冲突、默认保留，选「覆盖」后照常回到起点；之后又多了名字、移出工作区、或被这一轮后面的整树快照排除的，进「跳过」，清单写明「卡上标过有快照，因为……跳过」；答 `none` 的情形卡上都不标。
53. 停止一个正在宿主里写文件的调用后立刻点还原：在那次写入真正结束之前返回 `busy`；结束后再还原，结果不被晚到的写入盖掉；另一个会话的工作区是这个文件夹的上级时也 `busy`。
54. agent 把一个文件从 A 改成 B，你接着改成 C，agent 读了 C 再改成 D：还原时这个文件算冲突、默认保留 D，你的改动不丢。
55. 工作区里 `.vscode` 指向 `editor-config/`、`.claude` 指向 `agent-conf/` 时：写 `.vscode/tasks.json`、直接写 `editor-config/tasks.json`、直接写 `agent-conf/settings.json` 都每次问；`~/.config` 是链接时，Read 它解到底的 `gh` 目录里的文件也出凭据卡；之前对这些真实路径有会话授权、父会话有授权，也照问。

## 开放问题

（无。D58 已由 owner 2026-10-24 定 A。）

## 修订记录

- 2026-10-28 · §审批卡、工具行、结算行与「查看本次记录」、§接口 `snapshot.rounds` 一句：任务会话的历史也画结算行 · 第三段第 15 步发现历史消息不画结算行、重启后没有还原入口；owner 定历史也画（D63），是收紧，经 owner 点名批准
- 2026-10-28 · §接口 `snapshot.rounds` 一句：补上每轮的 Run 与每次调用的快照号 · 第三段第 15 步发现 §审批卡、工具行、结算行与「查看本次记录」要的快照号与轮的归属，`session.messages` 与原列的几项都给不出；只在这一段新增、未合入的路由里补，是澄清
- 2026-10-28 · §一键还原、§验收标准 第 16 条：清单不再把命令改的路径单独标出 · 第三段第 15 步发现 `RestorePreview` 没有路径来源；owner 定不标（D62），是放宽，经 owner 点名批准
- 2026-10-25 · §给你看的一页、§接口、§已知限制与代价、§点名 (e)(h)(j)、§提示层与评测 · D60、D61；ADR-005；收紧 · PR #74
- 2026-10-24 · §已知限制与代价 加链接目标扫描一条 · 第一段评审发现扫描走遍工作区、超时后工具全部失败；owner 定扫不完时照名字查（D59），是放宽，经 owner 点名批准 · 5bf0cae
