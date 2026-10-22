# Tenon · 架构总览

## 给你看的一页

**Tenon 是什么。** 一个装在你电脑上的 AI 助手桌面应用（macOS、Linux）。你可以跟它聊天；也可以交给它一个文件夹和一件事，让它自己读文件、改文件、跑命令，把事做完。它能接几家模型：Anthropic 的 Claude、智谱、在本机跑的 Ollama，以及你在设置里填了地址的兼容厂商；还能接「连接器」，也就是别人写好的外部工具服务，比如查日历、读网盘。

**它由五块组成。**

1. **窗口**：你看到的界面。它被关在和网页一样的隔离环境里，自己碰不到文件、密码和网络，什么事都要请后台去办。
2. **后台**：应用里唯一有权读写文件、从系统钥匙串取密码、联网、启动程序的部分。窗口发来的每个请求，它先按事先登记的格式检查一遍，不合格的直接退回。
3. **核心**：负责一圈事：把对话发给模型 → 模型说要用某个工具 → 判断能不能做、要不要先问你 → 去做 → 记下来。核心自己什么都碰不了，要读文件、联网、跑命令，都通过后台给它的一组固定接口去要；这样同一份核心以后能原样搬到服务器上跑。
4. **记录本**：一次对话里的每件事（你说的话、模型的回答、每次审批、每个工具的结果）按先后写进你电脑上的一个数据库文件，只往后加，从不改旧的。应用崩了或被关掉，重开后从记录本接上。
5. **沙箱**：模型要跑的命令，放进操作系统强制的隔离环境里跑：只能写你选的文件夹（外加几个临时目录），默认连不了网，碰不到存密码和登录凭据的地方。

会话分两种：「对话」只能搜网页、读网页、向你提问，不能改文件也不能跑命令；「任务」才带文件夹，能改文件、跑命令。

**一次典型的使用，从头到尾。**

1. 你新建一个任务，点文件夹按钮，在系统的选文件夹对话框里选中项目目录（窗口自己塞不进路径，只能经这个对话框），写下「跑一遍测试，修掉失败的」，点发送。
2. 窗口把这句话交给后台，后台检查格式后交给核心。核心先把你的话写进记录本，再通过后台从钥匙串取出模型的密钥，把对话发给你选的模型。
3. 回答一边生成一边显示。模型说「我要读 package.json」：这是你选的文件夹里的文件，只读不改，核心直接放行。
4. 模型说「我要运行 npm test」。跑命令可能改东西，核心判定要先问你：这一轮停下，记录本记下「在等你答复」，窗口弹出审批卡，写清要跑的命令和在哪个文件夹跑。
5. 你点「允许」。答复写进记录本；这个任务里同一条命令在同一个文件夹再跑，就不再问。核心接着往下走。
6. 后台把命令放进沙箱里跑。它要是想连网或往文件夹外写，会被系统拦下；拦下的事显示在那一行下面，叫「拦截回执」，附几个范围很小的放行按钮，比如「只在这个任务里允许连这个网站」。
7. 命令的输出交回核心、写进记录本、再发给模型。模型看了结果决定下一步：改文件（同样先问你，同一个文件允许过一次就不再问）、再跑测试……直到给出最后的回答。结束时记录本写下「结束」和原因。
8. 下次打开应用，这段对话从记录本里原样读出来；上次停在等你审批的，审批卡还在。

## 模块和边界

边界出自 AGENTS.md「Hard rules」：kernel 不 import electron，不直接碰文件系统、钥匙串、网络和子进程，一切经 `HostAdapter`；特权全在主进程；IPC 只走 `packages/contracts`；每个子进程经沙箱包装、只传绝对路径；Tape 只追加。依赖方向：`apps/desktop` → contracts → kernel（contracts 只取 kernel 的类型和少数常量），kernel 不 import contracts（由 lint 守）。

| 模块 | 管什么 | 不管什么 | 代码在哪 |
|---|---|---|---|
| kernel · host | `HostAdapter` 九个成员的接口（identity、fs、secrets、process、sandbox、confirm、clock、network、policy）、`keyFor` 存储键、路径工具、测试用的内存宿主 | 任何真实实现 | `packages/kernel/src/host` |
| kernel · session/loop | 会话服务（建、清空、删、读投影）；每个根会话一个 mailbox，判定发送、停止、继续、答复、恢复；Run 的每一轮、一批工具的执行、上限与守卫、上下文压缩、子 agent、启动恢复 | 窗口、IPC、正在跑的 Run 登记（宿主经端口给）；id 和时间由宿主给，自己不取 | `packages/kernel/src/session`、`packages/kernel/src/loop` |
| kernel · provider | 厂商定义（Anthropic、智谱、Ollama、自定义厂商）、两条线协议（anthropic-messages、openai-chat）、归一化流事件、错误分类、思考档位 | 密钥在哪、选哪家（宿主的 RunConnector 定）；出网只经 `HostAdapter.network` | `packages/kernel/src/provider` |
| kernel · tools | 十个内置工具（Read、Write、Edit、Glob、Grep、Bash、WebFetch、WebSearch、AskUserQuestion、Agent）、工具表（候选、命名、冻结）、参数校验、执行器、MCP 工具作候选 | 能不能执行（permission 判）；Bash 的 shell 与基础环境（宿主算好给） | `packages/kernel/src/tools` |
| kernel · permission | 纯函数 `decide()` 的八层决策表、判决记录与摘要、会话授权、Inspector 接口与外带检查、WebFetch 地址黑名单、工作区内外判定 | 卡片投递（经 `HostAdapter.confirm`）；租户策略从哪来（经 `HostAdapter.policy` 只读） | `packages/kernel/src/permission` |
| kernel · mcp | 连接池与状态机、stdio 与 Streamable HTTP 两种传输、OAuth 登录、令牌经 `HostAdapter.secrets` 存取 | 连接器配置读写与启动确认（main · MCP 管） | `packages/kernel/src/mcp` |
| kernel · tape | Tape 条目模型、规范 JSON 与哈希链、命名空间与写入授权、`TapeStore` 端口、内存实现、投影与重放 | 落盘与 SQL（main · Tape 存储管）；`apps/*` 不直接调 `TapeStore.append`，只经 kernel 门面 | `packages/kernel/src/tape` |
| kernel · prompts | 系统提示、语言提示、模型备注、工具描述等发给模型的全部固定文本，及覆盖它们的版本哈希 | 界面文案（走 i18n） | `packages/kernel/src/prompts` |
| contracts | IPC 全部通道：zod 定义的请求、响应、事件，`registerRoute` / `invokeRoute` 两端校验，通道登记表；桌面与服务端之间的桥帧骨架（纯函数，还没有使用方） | 业务逻辑；不 import electron | `packages/contracts/src` |
| main · 装配与路由 | 启动、单实例、窗口与导航加固、注册全部 IPC 路由、RunConnector（选 provider 与模型、读密钥、构造 provider）、RunRegistry、发送队列、工作区文件夹、自定义厂商、启动恢复、退出 | 判定与循环（都在 kernel） | `apps/desktop/src/main` 顶层文件与 `custom-vendors/` |
| main · 宿主实现 | `HostAdapter` 的桌面实现：文件、钥匙串、进程树、srt 沙箱与姿态自检、出网与不可信抓取、审批投递、命令 shell 的环境 | 判定（只执行 kernel 判过的调用） | `apps/desktop/src/main/host` |
| main · Tape 存储 | SQLite 版 `TapeStore` 与 DDL，和内存实现跑同一套一致性测试 | 写入规则（来自 kernel） | `apps/desktop/src/main/tape` |
| main · MCP | 连接器配置读写、server 的启动确认、工具 schema 在 worker 线程里校验、日志、OAuth 回调与打开浏览器、MCP 路由 | 连接与调用（kernel · mcp） | `apps/desktop/src/main/mcp` |
| preload | 给窗口一个 `window.tenon`：`invoke` / `on` 只放行 contracts 登记的通道，外加启动语言与平台 | 载荷校验（main、renderer 两端做） | `apps/desktop/src/preload` |
| renderer | React 界面：对话流、工具行与拦截回执、审批卡、输入框与文件夹、设置（模型、连接器、沙箱）；中英两种语言 | Node、electron 与钥匙串（由 lint 禁）；任何特权操作 | `apps/desktop/src/renderer` |
| server（占位） | 只放 Tape 的 Postgres 版表结构，供 `tape:check` 与 SQLite 版逐项对照，从不执行 | 任何运行代码 | `apps/server/sql` |

## 数据流

### 一次 Run

1. renderer 用 `invokeRoute` 发 `chat.send`；preload 只放行登记的通道；main 的 `registerRoute` 先用 zod 校验，再交给 kernel 的 `SessionService.send`。
2. 根会话的 mailbox 判定后开 Run：用户消息、`execution/run_started`、`session/model_selected` 在同一事务里写进 Tape，然后才发请求。
3. RunConnector 选定 provider 与模型，经 `HostAdapter.secrets` 读 key、构造 provider；provider 经 `HostAdapter.network.fetch` 流式请求。每个流事件在它对应的事实提交后，经 `chat.event` 广播给窗口。
4. 回复以 `message/assistant` 加 `provider/attempt_completed` 落 Tape。带工具调用就进入一批：查冻结的工具表 → 校验参数 → 跑 inspectors → `decide()` → 写 `tool/permission_decided`。
5. 拒绝：kernel 自己写收口。要问：Run 以暂停结束，`HostConfirm.request` 经 `confirm.request` 事件把卡送到窗口；`approval.respond` 写 `tool/approval_resolved`，Run 接着跑。允许：先写 `execution/dispatch_committed`，落盘后才执行。
6. 执行：文件工具经 `HostAdapter.fs`，判定用解过链接的真实路径；Bash 经 `HostSandbox.wrap`（srt 按档位包好 argv）→ `HostProcess.spawn` → `afterExit` → `violations`，违规变成拦截回执；WebFetch 经 `network.fetchUntrusted`；连接器工具经连接池调 `tools/call`。
7. 结果写 `tool/result` 与 `execution/tool_outcome`（超过 3 万字符的先落盘到 `<profileDir>/tool-output/<sessionId>/`），再发下一轮。Run 结束写 `execution/run_terminal`，窗口收到结束事件。

### MCP（连接器）

1. 你在设置「连接器」里添加 server：`mcp.save` → main 把配置写进 `config.json` 的 `mcpServers`，环境变量和请求头里的机密进钥匙串。每个 server 先经你确认才连：「允许」只管本次运行，「以后都允许」记进配置；命令、参数、环境或地址一变，就要重新确认。
2. kernel 的连接池去连：本地 server 经 `HostSandbox.wrap`（`full-access`，不进 srt）与 `HostProcess.spawn` 起进程，cwd 是主目录；远程 server 经 `HostAdapter.network`，OAuth 令牌存钥匙串。
3. `tools/list` 拿到的输入 schema 先在 worker 线程里校验，通过的按命名规则映射成工具表候选。注解只读 `_meta["anthropic/requiresUserInteraction"]` 一个，且只会让判定更严。每个工具的「总是允许 / 询问 / 从不」存在 `config.json`，工具定义一变，「总是允许」就失效。
4. 调用照「一次 Run」第 4–7 步走；结果当不可信内容写进 Tape、发给模型。

### 配置与密钥

- 非机密配置在 `<userData>/profiles/local/personal/config.json`（本机只有一个 profile，用户 `local`、租户 `personal`）：界面语言、选中的 provider 及其非机密设置、每种会话形态的默认模型、自定义厂商、连接器、沙箱档位与网络白名单、上次的工作区文件夹。只有 main 读写（持锁写入）；renderer 经 `config.*`、`provider.*`、`mcp.*`、`sandbox.*` 等路由读写，两端过 zod。
- 机密在 OS 钥匙串：服务名 `com.yiongspace.tenon`，账户名由 `keyFor` 生成、以 `<tenantId>:` 开头。只有 main 经 `HostAdapter.secrets` 读；provider 路由对每个键只回 `configured: boolean`，值从不回到 renderer。
- 开发构建可读 `.env.local` 与几个环境变量作回落，e2e 可让开发构建把机密放在进程内存；打包后的应用两者都拒绝。
- 会话数据在 `<profileDir>/sessions.db`（SQLite，WAL），文件里记着 tenantId，每次打开都核对；任务会话没选文件夹时，用专用文件夹 `<home>/Tenon/workspaces/<userId>/<tenantId>/<sessionId>/`。

## 结构图

```
[renderer] React 界面 ................................................ 不可信
    |  window.tenon.invoke / on：只放行 contracts 登记的通道
[preload]
====|========== 信任边界：IPC，registerRoute 两端用 contracts 的 zod 校验 ==========
    v                                   主进程（可信，持有全部特权）
[main · 装配与路由] --send/stop/answer--> [kernel · session/loop] <-- [kernel · prompts]
    |  RunConnector：选 provider、读 key          |
    +-----------------------------------------> +--请求--> [kernel · provider] --network.fetch--> 模型 API（输出不可信）
                                                +--每次调用--> [kernel · permission] decide() + inspectors
                                                |                 +--问--> HostAdapter.confirm --> 审批卡（回到 renderer）
                                                |                 +--允许--> [kernel · tools] 执行
                                                +--每条事实--> [kernel · tape] 门面 --> TapeStore 端口
                                                +--连接器工具--> [kernel · mcp] 连接池
- - - - - - HostAdapter（接口在 kernel · host）：kernel 通往外部的唯一出口 - - - - - -
[main · 宿主实现]  fs | secrets -> 钥匙串 | process | sandbox -> srt | network -> undici | confirm
[main · Tape 存储] --> sessions.db              [main · MCP] 配置、启动确认、schema worker
          |                                                 |
========= 信任边界：srt 沙箱 =========        ========= 信任边界：MCP =========
  Bash 起的命令（不可信）                       本地 server 进程 / 远程 server（不可信，不进沙箱）
```

## 技术栈

| 技术 | 版本 | 为什么选 | 在哪定的 |
|---|---|---|---|
| Node（开发、测试、CI） | ≥ 22.12；CI 用 `.nvmrc` 的 22.22.0 | 下限取依赖 engines 的最高值：vitest 5、Electron 44、commitlint 21、sandbox-runtime 0.0.79 都要求 ≥ 22.12，加依赖或升级前先看它的 engines。产品跑在 Electron 自带的 Node 24.21 上，不受这条管 | 04 §依赖、§文档同步 |
| pnpm | 10.30.2 | workspace 加 `catalog:` 统一共享版本；`strictDepBuilds` 让带安装脚本的新依赖审过才能装 | 00 §技术选型 |
| Electron | 44.4.1（内嵌 Node 24.21、Chrome 152） | MCP SDK、stdio server 和 srt 都要真正的 Node 运行时，Tauri 的 WebView 里没有 Node | ADR-001 |
| electron-vite + Vite | 5.0.0 + 7.3.6 | electron-vite 5 只接受 Vite ≤ 7（`@vitejs/plugin-react` 因此钉 5.2.0），升 Vite 8 要一起升 electron-vite；它的版本表止于 Electron 39，构建目标显式写 `node24` / `chrome152` | 00 §技术选型 |
| TypeScript | 7.0.2 | 原生编译器，`tsc -b` 就是整仓类型检查（引用列表漏一项会静默变绿）；没有 tsserver，编辑器要走 TS 7 的语言服务，否则「编辑器绿、CI 红」 | 00 §技术选型 |
| React | 19.3.0 | 窗口界面 | 00 §技术选型 |
| assistant-ui | 0.15.20 | 消息流骨架，接 Tenon 自己的会话存储 | 00 §技术选型 |
| Streamdown | 2.6.0 | 助手回答的 markdown 流式渲染 | 00 §技术选型 |
| Base UI + Tailwind | 1.8.0 + 4.3.3 | 组件底座（shadcn 生成）；颜色只走设计令牌（由 `colors:check` 守） | 00 §技术选型 |
| i18next（ICU 格式） | 26.4.2 | 界面文案 zh-CN、en 两套，缺键由 `i18n:check` 拦 | 00 §国际化 |
| zod | 4.6.5 | 一份 schema 同时定义 IPC 的请求、响应和事件，两端都校验 | 00 §契约层 |
| `@anthropic-ai/sdk`、`openai` | 0.128.0、7.23.0 | 官方 SDK：出网能整个交给注入的 `fetch`，自带 SSE 分帧、类型化错误和逐请求取消；线协议适配器自己写，不以 AI SDK 为运行时依赖 | 01 §选型：官方 SDK，不用 Vercel AI SDK，不手写 SSE；ADR-003 |
| `@modelcontextprotocol/client` | 2.3.1 | MCP 官方 SDK v2 的客户端 | 03 §SDK 升级 |
| `@anthropic-ai/sandbox-runtime`（srt） | 0.0.79 | macOS（Seatbelt）与 Linux（bubblewrap）上的命令沙箱和出网白名单代理；精确钉住，之后的版本改了 askCallback 的语义，升级要重跑 04 的沙箱验收 | 04 §依赖 |
| better-sqlite3 | 13.0.3（SQLite 3.53.4） | 包里带预编译件，一次安装同时服务 vitest 的 Node 22 与 Electron 44，两边是同一个 SQLite 引擎；版本号连引擎一起钉，改它按改 schema 对待 | 01 §SQLite 实现约束 |
| `@napi-rs/keyring` | 2.1.0 | OS 钥匙串；只用异步接口，同步的在 macOS 弹授权框时会卡住主进程几秒 | 00 §本地持久化布局 |
| undici | 7.29.1 | 桌面出网；关掉它自带的两个 300 秒超时，只留 kernel 的首字节超时和空闲看门狗；版本与 Electron 44 内置的一致 | 02 §对 01-provider-and-tape 的修补「4 出网接缝」 |
| `@noble/hashes` | 2.4.0 | Tape 哈希链的 SHA-256，同步、纯 JS；kernel 里禁用 `node:crypto` | 01 §哈希链 |
| Vitest | 5.0.1 | kernel、contracts、desktop 的单元与集成测试；一律 `--maxWorkers=2` | 00 §技术选型 |
| Playwright | 1.63.0 | 驱动真实 Electron 的 e2e；在 CI 里跑，不在 owner 正在用的 Mac 上跑 | 00 §技术选型 |
| oxlint / oxfmt | 1.83.0 / 0.68.0 | lint 守边界（kernel 的 import 禁令、renderer 不碰 Node）；只用根配置并带 `--disable-nested-config`，嵌套配置会整段替换根配置 | 00 §技术选型 |
| lefthook + commitlint | 2.1.14 + 21.2.2 | 提交前跑 spec-check 与格式、lint、类型检查；提交说明守 Conventional Commits | 00 §技术选型 |

「在哪定的」写 00 §技术选型 的，那一节只定了用哪个工具；具体版本最早钉在 00 plan 的「交接」里，之后的升级记在各自 PR 的说明里。

## 信任边界

主进程（main 和跑在里面的 kernel）可信、持有全部特权；下面这些都不可信，检查都放在主进程一侧。

- **渲染进程**：按「可能被攻破」设计。每个窗口 `contextIsolation` 开、`nodeIntegration` 关、`sandbox` 开，导航钉在应用自己的页面，网页权限只放剪贴板写；preload 只放行登记的通道，`registerRoute` 两端 zod 校验；渲染端传不进路径，工作区文件夹只能经主进程自己的对话框或它读出的预填加入。
- **模型输出**（含工具调用的参数）：每次调用都过 kernel 的 `decide()`，deny > 必须问 > 允许；策略和用户可以放宽，Inspector 只能收紧；工作区内外按解过链接的真实路径判；会改动的调用先出审批卡。
- **MCP 工具的描述、注解与结果**：`readOnlyHint`、`destructiveHint` 永不放宽判定，只读 `requiresUserInteraction`（只会更严）；结果当不可信内容；输入 schema 在 worker 线程里校验。
- **抓回来的网页和搜索结果**：WebFetch 经 `fetchUntrusted` 在主进程查 DNS 结果，拒回环、私网、链路本地与 CGNAT，并钉住查过的地址；会话碰过私有数据又读过不可信内容后，模型自己写出的网址要先问（外带检查）。
- **沙箱里的命令**：Bash 经 srt 包装（只读、工作区可写两档），网络只放白名单（默认为空），profile 目录、`.ssh` 与凭据位置拒读拒写；沙箱起不来时以你的权限运行、每条都问，卡上写明。
- **MCP server 进程**：不进沙箱、以你的权限运行；每个 server 先经你确认，启动命令、参数、环境或地址一变就要重新确认。
- **密钥**：只在主进程经 `HostAdapter.secrets` 读，不进日志，IPC 只回「是否已配置」。

## 术语

| 词 | 意思 |
|---|---|
| Tape | 一个会话的全部事实，按顺序只往后写（SQLite 里一行一条，带哈希链）；更正、压缩、交接都写成新条目 |
| 事实 / 投影 | Tape 里的一条记录叫事实；窗口看到的消息列表这类，是从事实算出来的投影 |
| Run | 一次触发（发送、继续、恢复、子 agent）引起的一串模型请求和工具执行，到结束原因写进 Tape 为止 |
| mailbox | 每个根会话一个的串行点：发送、停止、答复等命令按到达顺序在这里判定，Run 的事实也经它写入 |
| 批 | 模型一次回复里的全部工具调用，按顺序判定和执行；工作区内连续的只读调用可以并行 |
| 收口 | 每次工具调用恰好有一个结果；被拒、停止、崩溃时由 kernel 补写 |
| HostAdapter | kernel 通往外部的唯一接口，九个成员；桌面由主进程实现，测试用内存实现 |
| RunConnector | 宿主交给 kernel 的端口：决定 Run 用哪个 provider 和模型，并构造它 |
| 会话形态 | 「对话」（`chat`）只有搜索、抓取、提问和读本会话落盘的输出；「任务」（`cowork`）有工作区，能改文件、跑命令 |
| 工作区 | 任务会话的文件夹列表；只经系统对话框或预填加入，没选时用专用文件夹 |
| Inspector（检查器） | 判定前对每次调用发表意见的规则，只能说「无意见 / 要问 / 拒绝」，不能放行；现在只注册了外带检查 |
| 会话授权 | 你在审批卡上点「允许」得到的授权：只对本会话、只对卡上那一个对象（这个文件、这条命令加目录、这个网站） |
| srt | Anthropic 开源的 `@anthropic-ai/sandbox-runtime`；Tenon 用它把 Bash 起的命令包进系统沙箱并代理出网 |
| 档位 / 姿态 | 档位是命令能写多大范围：只读或工作区可写；姿态是沙箱此刻的状态：启动中、生效、降级、不可用 |
| 回执（拦截回执） | 沙箱拦下操作后显示在工具行下的说明，带三种小范围放行：本任务内允许一个域名、允许写一个位置一次、不受限制地重跑一次（重跑前再问） |
| 连接器 | 界面上对 MCP server 的叫法 |
| tenantId | 租户 id，每个存储键都带它；本机固定是 `personal` |

## 修订

- 2026-10-22 · 建立 · sdd 接入 A11
