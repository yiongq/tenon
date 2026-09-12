# Claude Desktop 功能全景

> 复刻前的功能勘测 · 调研于 2026-09-11
> 来源：support.claude.com · claude.com/docs · platform.claude.com · academy.claude.com · modelcontextprotocol.io
> MCP 规范版本：2026-07-28
>
> 每个功能按「是什么 / 何时用 / 复刻要点」三段组织。查不到官方说明的一律标注为未确认，不做推测式补齐。

---
## 00 · 架构底座：一个内核，三套 profile

这是复刻时最容易做错的一步。Chat / Cowork / Code 不是三个产品，是同一个 agent runtime 的三种前端封装 + 三套工具与权限预设。官方原话：Cowork「uses the same agentic architecture that powers Claude Code」；遥测流按 `service.name` 分成 `claude-desktop` / `cowork` / `claude-code-desktop` 三路。

*\[架构图：三个 tab（Chat / Cowork / Code）共享同一 agent 内核；内核之下是工具集 profile、权限策略引擎、上下文容器、扩展注册表；最底层是配置三来源——文件系统(CLI) / 账号同步(Desktop) / MDM 组策略(企业)\]*

复刻时不要写三套 agent loop。差异只落在四个地方：可用工具集、权限默认值、上下文容器、UI 呈现。

### Chat 会话的能力边界（官方最精确的一次描述）

**是什么 ·** 第三方部署版的 Chat tab 规格文档逐条列出了 Chat 会话**能做什么**：web search、web fetch、只读附件、每会话一个 scratch 目录、托管 MCP、`AskUserQuestion`、可选的离线沙箱代码执行。

**不能做 ·** 不能访问连接的文件夹、不能起 shell、**不能创建或运行定时任务**、不能读其他会话、不读写 memory（此条与消费者版的 memory 行为有出入，见 [未确认项](#gaps)）。

**复刻要点 ·** 把这份能力矩阵直接当成你的 `ToolProfile` schema。Chat 与 Cowork 的分水岭就一条：**会话是否服务端常驻**。Chat 会话跟着客户端走，Cowork 会话必须能脱离任何客户端独立存活，客户端只是 attach/detach 的 viewer。

## 01 · 对话层

最熟悉的一层，但有几处行为和直觉相反 —— 会话搜索是 RAG 工具而非字符串匹配；长会话自动压缩挂在一个看起来无关的开关上；模型 / effort / thinking 是三个独立维度。

### 会话管理

**是什么 ·** 侧边栏 `⋮` 管单条（Rename / Delete），「Chats and tasks」页有 Select 批量删。删除语义是**立刻从历史消失、后端 30 天内彻底删除**。

**何时用 ·** 批量清理只在 Web / Android 有；iOS 只能逐条长按。

**复刻要点 ·** soft delete 与 hard delete 要分开建模，删除时间戳 + 后台清理作业。**会话级的收藏 / 归档在官方没有** —— star 和 archive 只存在于项目上，别照着别的产品加。

### 会话搜索

**是什么 ·** 不是搜索页，是**对话里的一次可见工具调用**。你直接问「我们之前聊过 X 吗」，Claude 发起检索，结果以工具卡片形式渲染在消息流里。

**何时用 ·** 它有**两个互斥的检索域**：projects 之外的所有会话 / 当前 project 内的会话。在项目里问只搜这个项目。仅付费计划。

**复刻要点 ·** 消息流要支持「工具调用 block」这种消息类型。检索域由会话所属容器决定，是查询的硬过滤条件不是排序权重。设置里 search 和 memory 必须是两个独立开关。

### 隐身会话 Incognito

**是什么 ·** 不进历史、不进 memory、不进 monthly recap、不用于训练，保留 30 天。入口是新会话右上角的幽灵图标，**只在 projects 之外可用**。

**何时用 ·** 注意它仍然读你的 profile preferences —— 「隐身」≠ 无个性化。Team/Enterprise 下仍进组织数据导出和 Compliance API。

**复刻要点 ·** 整个会话加黑色边框 + 标签做视觉隔离，这个视觉承诺很重要。**不可逆**：不能转普通会话，关掉就再也打不开 —— 关闭前必须强确认。

### 分享

**是什么 ·** 三种模式：公开链接（Free/Pro/Max）、分享给指定的人、Team/Enterprise 仅组织内且**不能公开**。管理入口 `Settings > Privacy > Shared chats`，可逐条取消。

**何时用 ·** 分享的是**快照**，之后新增的消息不在链接里。上传的文件不会被分享；MCP 工具调用的原始数据访客看不到，只看最终输出。

**复刻要点 ·** 快照语义意味着分享时要冻结一份 message 列表引用，不能直接指向活会话。附件和工具调用明细需要独立的可见性字段。

### 长会话自动压缩

**是什么 ·** 会话逼近上下文窗口时自动摘要早期消息腾空间，**前端仍保留完整聊天记录**。上下文窗口：Fable 5.1 / Opus 5 / Sonnet 5 = 1M；Opus 4.8/4.7/4.6、Sonnet 4.6 = 500K；其余 200K。

**何时用 ·** **这个能力要求用户开了 code execution**（Settings \> Capabilities）。没开就是硬上限，只能开新会话。这是最反直觉的一条隐藏依赖。

**复刻要点 ·** 「展示的 transcript」与「送给模型的 context」必须是两个数据结构。压缩是对后者做的，前者永远完整。

### 模型 / Effort / Thinking

**是什么 ·** 三个**独立**维度。Effort 五档：low / medium / high（推荐默认）/ xhigh（仅 Opus 4.7+）/ max。Thinking 是单独开关，可与任意 effort 组合。

**何时用 ·** 会话中途随时可改，**改动从下一条回复开始生效**，已有消息不重算。Fable 5.1 和 Opus 5 的 thinking 无法关闭，UI 上应置灰。

**复刻要点 ·** 不要把 effort 和 thinking 做成一个滑块 —— 这是最常见的错误。模型名和 effort 都显示在**发送按钮旁边**。还要给「模型被自动切换」准备一张说明卡片，官方为此写了专门的帮助文章。

### 文件上传

**是什么 ·** 单次对话 **500MB/文件、20 文件**；项目知识库 30MB/文件、数量不限。文档支持 PDF / DOCX / CSV / TXT / HTML / ODT / RTF / EPUB / JSON，XLSX 需开 code execution。图片 JPEG / PNG / GIF / WebP，最大 8000×8000。

**何时用 ·** PDF 有一条**按页数自动降级**的策略：≤100 页同时分析文本和视觉元素；101–1000 页只处理文本；\>1000 页不支持。图片官方建议 ≥1000×1000。

**复刻要点 ·** 那条降级策略要在 UI 上明示当前 PDF 走哪条路径，否则用户会以为 Claude「看不懂图表」。上传方式要三条都有：+ 菜单、拖拽、**剪贴板粘贴图片**。

### 文件创建（xlsx / pptx / docx / pdf）

**是什么 ·** Claude 在私有计算沙箱里写代码并执行来生成文档，产出真·可用公式的 Excel、格式化 PPT。上传下载均 30MB 上限。可直接下载或存到 Google Drive。

**何时用 ·** 官方明示**创建文件比普通对话更费额度**。

**复刻要点 ·** 关键的连锁依赖：`Code execution and file creation` **这一个开关**同时控制文件创建、Skills、长会话自动压缩、以及 artifact 可用性。复刻时要么保留这种捆绑并解释清楚，要么拆开 —— 但不能不知道它捆着。**Office 文件不是 artifact**，走的是完全不同的渲染 / 存储管线。

### Web search / Research / Extended thinking 的三分法

**是什么 ·** 官方给的分界线：**Web search** = 1–2 次工具调用的事实查询；**Extended thinking** = 复杂推理但不需要联网；**Research** = 需要 5 次以上调用、耗时数分钟的深度搜集。两者可叠加。

**何时用 ·** **Research 硬依赖 web search 已开启**。Research 的数据源不止网页 —— 接了 connector 会一并检索 Gmail、Calendar、Docs。开启后有蓝色指示器。

**复刻要点 ·** 这三者在你的实现里是「工具可用性 + 规划深度 + 推理预算」三个正交配置，UI 上却挤在同一个 `+` 菜单里。入口设计要能表达「这是能力开关，不是模式切换」。

### 内联富组件

**是什么 ·** 消息流里除了 artifact 还有一类内联组件：**Custom visuals**（现场生成布局与交互的图表，beta，仅 web/desktop）、天气 / 菜谱卡片、体育比分（纯文本）、以及 `AskUserQuestion` 生成的**可点击单选 / 多选 / 排序**。

**何时用 ·** 可点选项是最容易被忽略的一种消息类型 —— 它让 agent 能在不打断流程的前提下收敛需求。

**复刻要点 ·** 消息渲染器要做成「block 类型注册表」而不是 markdown 渲染器 + 特例。至少要有：text / tool_call / artifact_ref / question_choice / rich_widget 五类。移动端要有降级路径（菜谱卡降级为纯文本）。

### Voice mode 与 Dictation

**是什么 ·** Voice mode 是**双向语音对话**（Claude 用合成语音回答），Dictation 只是语音转文字。Voice 有 hands-free（默认）和 push-to-talk 两种交互模式，多个预设音色。

**何时用 ·** 可以在对话中途**在文字和语音之间来回切换**；语音会话中仍可调用已连接的工具。Fable 在语音模式下不可用。

**复刻要点 ·** 转录像普通消息一样进聊天历史 —— 语音会话和文本会话是**同一种数据结构**，不要建两套。

### Quick Entry \[macOS\]

**是什么 ·** 全局快捷唤起。**双击 Option**（可改 Option+Space 或自定义）调出输入框；**Caps Lock 语音输入**（需 macOS 14+，默认关闭）。能新建对话、**拖选屏幕区域截图**、**把某个应用窗口作为附件**。

**何时用 ·** 桌面端相对 Web 最有说服力的差异化功能。App 只需后台运行，窗口不必可见。

**复刻要点 ·** 需要三种系统权限：屏幕录制、辅助功能、语音识别。Linux 上全局热键在 X11 可用，Wayland 取决于桌面的 GlobalShortcuts portal。

## 02 · Projects

注意这里有两种 project，同名但不是一回事：claude.ai 的 Chat project 存在账号里、可分享、不能持有本地文件夹；Cowork project 只存本机、不同步、不能分享、但能挂载文件夹和持久 memory。两者可以「链接」但不合并。

### 项目本体

**是什么 ·** 自带独立聊天历史 + 知识库 + 自定义指令的工作区。Star 固定到侧边栏；Archive / Unarchive；**删除前必须先 unarchive**。列表有三个 tab：Your / Organization / Shared with you。Free 上限 5 个。

**何时用 ·** 被忽略的用法：可以把**已有会话搬进项目**（会话名旁的下拉，或在 chat history 页批量搬）。

**复刻要点 ·** archive 与 delete 是两个状态而非一个；archive 保留数据与共享设置。会话的 project 归属要可变更。

### Instructions

**是什么 ·** 对该项目内所有会话生效的行为准则 —— 语气、专业程度、回答格式。

**何时用 ·** 官方明确建议「keep project instructions concise」，因为**它占用上下文窗口**。

**复刻要点 ·** 在编辑框里实时显示 token 占用和剩余预算。这是个几乎零成本、但用户感知极强的细节。

### Knowledge：全量上下文 → 自动切 RAG

**是什么 ·** 默认把项目知识**全量塞进上下文窗口**；当知识量接近或超过窗口上限，**自动切换到 RAG 模式**，改用 `project knowledge search` 工具按需检索，容量扩大最多 10 倍。

**何时用 ·** 完全自动、无需配置，界面上有**可见的状态指示器**告诉你当前处于哪种模式，且**可逆** —— 知识量降回阈值以下会切回全量。RAG 模式下你会看到 Claude 调用搜索工具。

**复刻要点 ·** 这是整份文档里最值得抄的一个设计。两条路径的切换要有明确阈值、状态可见、且双向可逆。官方给的使用建议直接影响检索质量：文件名要有描述性（`Q4-2024-Brand-Guidelines.pdf` 优于 `document1.pdf`）、相关文档归组、提问时点名具体文件 —— 这些应该做成上传时的 UI 提示。

### Project Memory

**是什么 ·** **每个项目有独立 memory，与全局隔离**。官方给的动机是防串味：产品发布的规划不要混进客户工作，机密讨论不要混进日常运营。

**何时用 ·** Cowork project 的 memory 是跨会话持久的 —— 这是 Cowork 相对 Chat 最被低估的能力。

**复刻要点 ·** memory 存储必须带 scope 字段（global / per-project）。项目内会话读写项目 memory，项目外读写全局 memory，这个路由要在会话初始化时就确定。

### 共享与可见性

**是什么 ·** Public（组织内可搜到并使用）/ Private（仅受邀）。权限三档：Can view / Can edit / Owner。Enterprise beta 支持按 group 共享。

**何时用 ·** 最关键的一条：**项目公开 ≠ 你的会话公开**。官方原话「your chats within that project will be private and inaccessible to other members unless you manually share them」。

**复刻要点 ·** 可见性必须是**两级独立**的：容器可见性 + 会话可见性。很多人会把它做成继承，那是隐私事故。

### Cowork Project \[Cowork\]

**是什么 ·** 打包五件事：Description（给 Dispatch 读，用来选 project）、Folders、Instructions、Links、可链接的 claude.ai 知识、以及 project 级 memory store。

**何时用 ·** 拖文件夹进去 = 挂载为额外 project folder；拖单个文件 = 复制进第一个 folder。归档 project 只删元数据和 memory，**不动磁盘上的文件**。

**复刻要点 ·** Description 字段是**给机器看的元数据** —— 路由器靠它选容器。这个设计值得抄：凡是 agent 要自主选择的对象，都给它一个 description 字段而不是靠名字猜。

## 03 · Artifacts

两套 artifact 并存：Chat 的静态 artifact 和 Cowork 的 live artifact。后者能回连数据源，复杂度高一个量级。

### 触发判据与类型

**是什么 ·** 官方判据：有实质内容且自包含（通常 \>15 行）、用户会在对话之外编辑迭代复用、复杂且独立、之后很可能回头引用。六类：Markdown 文档 / 代码 / 单文件 HTML / SVG / Mermaid / React 组件。

**何时用 ·** 没自动触发时可以显式要求「做成 artifact」。**Word / Excel / PPT / PDF 不是 artifact**，走文件创建通道。

**复刻要点 ·** 这四条判据可以直接写进 system prompt 当启发式规则。两条管线（artifact 渲染 vs 文件下载）从存储到 UI 都要分开。

### 版本与原地编辑

**是什么 ·** version selector 浏览历次版本。Markdown 支持选中文字后「Edit with Claude」。更关键的是 **in-place draft editing**：高亮要改的部分、直接打字说明改动，Claude 就在你标记的位置原地改。

**何时用 ·** Cowork 新版 artifacts 可对比任意历史版本与当前版本并回滚。注意：**对 artifact 的编辑不回写对话上下文**。

**复刻要点 ·** 原地编辑是体验差距最大的交互点之一。实现上需要：选区 → 稳定锚点（不能用字符偏移，文本会变）→ 局部 diff 应用。别一上来就做全文重写。

### 发布、分享、嵌入

**是什么 ·** Free/Pro/Max 是 Publish（公开链接），Team/Enterprise 是 Share（仅组织内）。非 Claude 用户可查看并交互无需注册；Claude 用户可复制代码并**在自己的额度内**使用 AI 能力。嵌入要在 Allowed domains 里列白名单。

**何时用 ·** 侧边栏的 Artifacts 画廊**只收录点过 Publish 的**，对话里生成的不会自动进去。

**复刻要点 ·** 不可逆陷阱：**一旦 unpublish，同一个 artifact 无法再重新发布**，只能新建。取消发布的确认弹窗必须写清楚这点。另外「shared artifacts use the viewer's access, not yours」—— 分享后的数据可见性按**查看者**权限解析，这是个非平凡的授权设计。

### AI-powered artifacts

**是什么 ·** artifact 内嵌 Claude 能力，创建者不需要 API key、不需要部署、**不承担调用费用**。访客用自己的 Claude 账号认证，用量记在**访客自己的订阅**上。Pro 及以上还支持 MCP 集成和持久化存储（每 artifact 上限 20MB，可选私有或共享）。

**何时用 ·** 适合原型和 demo。上生产要导出代码走 Claude Code + 自己的 API key。

**复刻要点 ·** 这是一个**身份透传 + 配额归属**的设计：页面运行在创建者的代码里，但调用挂在查看者的账号上。需要在 artifact runtime 里注入一个受限的、按查看者身份签发的调用凭证。

### Live artifacts \[Cowork\]

**是什么 ·** 持久的交互式 HTML 面板。三点区别于 Chat artifact：独立存在于「Live artifacts」标签页不用回原对话找；**能从连接的 app 和本地文件拉数据，看到的是今天的状态而不是创建当天的快照**；每次修改存一版可回滚。

**何时用 ·** live artifact **存在本机，不跨设备同步**。2026-08-19 之前创建的只在桌面可用。用了 connected apps 的只能限组织内分享。

**复刻要点 ·** 需要一个能在渲染时回调宿主取数据的 artifact runtime + 版本存储 + 按查看者身份解析数据权限。比静态 artifact 复杂一个量级，排在路线图后段。

## 04 · Memory

2026-07-10 重做过一次。如果你按「每天一条对话摘要」的旧模型去实现，方向就错了。

### 条目式记忆

**是什么 ·** **按 topic 拆成一条条独立、可分类的条目**，Claude 在对话过程中**边聊边实时读写**，不是事后总结。记的是角色、项目、专业背景、沟通偏好、工作方式。chat 和 Cowork 共用同一份。

**何时用 ·** Free/Pro/Max 默认开启；Team/Enterprise 默认关闭，由 owner 组织级开启。

**复刻要点 ·** 存储是一个带路径和描述的文件树，不是一张 append-only 的日志表。写入发生在 agent loop 内部（作为工具调用），不是回合结束后的批处理。

### 查看 / 编辑 / 暂停 / 重置

**是什么 ·** `Settings > Memory > Topics`，每条可读、改、删，改动**立即对所有后续对话生效**。Pause 保留已有条目但停止写入；**Reset 永久删除全部、不可恢复**。

**何时用 ·** 另有独立开关 `Generate memory from chat history` 控制 monthly recap 的生成。

**复刻要点 ·** 「用户可读可改」是 memory 产品化的底线要求 —— 一个用户看不见的记忆系统在合规上站不住。Reset 要强确认。

### 敏感信息策略

**是什么 ·** 两层：**默认不存**健康、族裔、宗教、政治观点等敏感话题（用户可通过 `Include sensitive topics in memory` 主动加入）；**永不存储**（即使开了上面的开关）政府身份证号、社保号、犯罪记录、金融账号、移民身份。

**何时用 ·** Incognito 会话在所有计划下都完全不进 memory。

**复刻要点 ·** 这是复刻时的合规红线，必须在**写入侧**拦截而不是读取侧过滤。两层的区别是：一层是用户可撤销的默认，一层是产品硬约束。

### 导入 / 导出与 Monthly Recap

**是什么 ·** 导入：`Settings > Memory > Start import`，粘贴从其他助手导出的文本，Claude 抽取要点存成条目（实验性）。导出：设置里看，或直接在对话里让 Claude 逐字写出。Monthly Recap 在 `Settings > Reflect`，含活跃统计、话题占比、AI 熟练度四维观察。

**何时用 ·** Recap 依赖 memory 开启，且排除 incognito、健康数据集成、Cowork 和 Claude Code 的活动。

**复刻要点 ·** 「让模型自己把 memory 写出来」是个很省事的导出实现 —— 不需要专门做导出格式。

## 05 · Agent 层（Cowork）

从「一问一答」到「描述一个结果、走开、回来拿成品」。这一层的每一项都需要 Chat 层不存在的基础设施。

### Cowork 与三档审批 \[Cowork\]

**是什么 ·** 审批三档：**Manual**（每步问）/ **Auto**（Claude 先对每个动作做安全评估，判定不安全直接阻止）/ **Skip**（不检查）。**删除文件在任何模式下都会问。**

**何时用 ·** Cowork **比 Chat 更耗额度**（官方明说）。拿它问简单问题是纯浪费。会话本身不能分享，但产出的 artifact 可以。

**复刻要点 ·** Auto 档不是规则白名单，是**跑一个模型判断的动作安全分类器**在工具调用前拦截。这意味着你的策略引擎要能同步调用一次模型。另外要从第一天就把保留期 / 法务保全（retention days、legal hold）放进 schema。

### 连接本地文件夹 \[Cowork\]

**是什么 ·** 用户显式授权若干文件夹，桌面 App 作为守门人 —— 每个本地文件或工具运行前都对照权限检查一次。在 VM 内挂载为 `$HOME/mnt/<folder>`。单文件读取上限 50MB。组织可把文件夹设为只读。

**何时用 ·** 连接文件夹内部，系统 / 凭据目录和 Claude 自己的数据目录**不可访问**（Permission denied）。

**复刻要点 ·** 三件事：① 路径归属校验要做符号链接和 `..` 归一化（官方对授权请求明确拒绝经过 symlink 或含 `.`/`..` 的路径）；② 保留**宿主路径 ↔ 沙箱路径的双向映射**，否则产物回写做不了；③ 把「读 / 写 / 删 / 执行」拆成**独立可授予单位** —— 删除权限是运行期单独申请的，不是开局全给。

### 沙箱与两道网络边界 \[Cowork\]

**是什么 ·** 两道**独立**的网络边界：① 周边防火墙（设备能到哪）；② agent egress allowlist（`coworkEgressAllowedHosts`，控制 agent 的 web-fetch 和 shell 工具能到哪，「独立于周边防火墙，且更严格」）。

**何时用 ·** 反直觉的口子：**egress 限制不适用于 web fetch / web search 工具和 MCP**。沙箱保护的是网络边界，**不是你授权的文件夹** —— 官方特意说明这点。

**复刻要点 ·** 双层网络策略 + 工具粒度豁免。市场抓取这类需要凭据的操作要放在**宿主 OS 上、沙箱之外**完成，凭据不进 VM、不暴露给模型。

### 产物交付与 mtime 守卫 \[Cowork\]

**是什么 ·** 产物直接写回连接的文件夹。跨沙箱传输时有 **mtime 守卫**：设备上的文件在 stage 之后被用户改过，写回就拒绝。

**何时用 ·** 这是最容易出「覆盖用户的新编辑」事故的地方。

**复刻要点 ·** 双向文件同步必须带**乐观并发控制**，不是简单 copy。拒绝时要把设备端当前的 mtime 和 size 一并返回，调用方才能判断该重新拉取还是强制覆盖。

### Dispatch：并行子任务 \[Cowork\]

**是什么 ·** 侧边栏一个**常驻的、只有一个对话**的长跑 agent。你描述一个结果，它拆任务，**每个子任务作为独立的 Cowork 或 Code 会话运行**。路由规则：编码类 → Code 会话；知识工作类 → Cowork 会话。

**何时用 ·** 三个易错点：① 它是**持续对话**，可以说「基于上次那个结果再做 X」；② **权限转发 10 分钟无响应自动拒绝**，任务带着缺口继续跑完 —— 派完活去开会，那一步会被默默跳过；③ Dispatch 依赖桌面在线，和「云端 Cowork 会话关掉笔记本继续跑」不是一回事。

**复刻要点 ·** 父子编排层 + **显式深度限制（=1，child 不能再生 child）**防无限递归。异步权限提升协议要有超时默认拒绝 —— 这是很聪明的死锁规避。还需要设备注册表：桌面 App 在线时注册为可调度 host，支持从手机派活。

### 定时任务 \[Cowork\]

**是什么 ·** 频率：hourly / daily / weekly / weekdays / 手动。**每次运行 = 一个全新的独立 Cowork 会话**。远程执行，电脑睡眠或 App 关闭照常跑。可暂停 / 恢复 / 立即运行。

**何时用 ·** 两个坑：① **任务需要本地文件或 app 就只能在本地跑**，于是电脑睡着任务就不跑了 —— 要真正 24/7 就只能依赖 connector 和云端文件；② **每次都是全新会话、没有上次的记忆**，要跨次连续得靠 project memory 或把状态写进文件 / connector。

**复刻要点 ·** 服务端 cron，每次 fire 起全新会话 —— **prompt 必须是自包含的完整指令**。需要「任务是否依赖本地资源」的判定 + 宿主在线心跳 + 失败重试（官方是 5/15/30 分钟退避）+ 睡眠唤醒边界处理（这是官方 changelog 里反复出现的 bug 源）。还要把「定时任务」和「会话内自我提醒」做成两个不同原语。

### 两种浏览器 \[Cowork\]

**是什么 ·** **内置浏览器**：Claude Desktop 里的侧边面板，独立 profile，只有你导入的登录态，Claude 看不到你的标签页 / 书签 / 密码。**Claude in Chrome**：扩展，跑在你自己的 Chrome 里，能用你现有的所有登录。

**何时用 ·** 选择依据就一条：**你要不要你的登录态**。要复用现有会话 → Chrome 扩展；要一个干净的 Claude 专属身份 → 内置。另外很多人还在为了自动化装扩展，其实桌面版已自带。

**复刻要点 ·** 内置浏览器 = 内嵌受控 Chromium + 独立 cookie jar + **逐站点的凭据导入器**（读 Chrome/Edge/Firefox 的密码库，银行和 SSO 站点默认不勾选）。还要处理**渲染与交互解耦** —— 面板隐藏或窗口最小化时点击 / 滚动 / 截图仍要能工作，这正是官方踩了很久的坑。

### Computer use \[Cowork\]

**是什么 ·** 截屏看屏幕、操作鼠标键盘。三档应用权限**按应用类别固定、不可改**：View only（浏览器、交易平台）/ Click only（终端、IDE，能点不能输入）/ Full control（其他）。macOS 15+ 默认在后台窗口工作，不抢你的鼠标。

**何时用 ·** 官方自己把它排在**第三优先级**：connector 优先 → 浏览器导航 → computer use 兜底。**能用 connector 就绝不要用它**。只适合没有 connector 的东西：内部 dashboard、专有工具、手机模拟器。

**复刻要点 ·** 这是沙箱最薄的一层 —— 授权后的后续动作不再逐次检查，且截屏能看到屏幕上任何可见信息。工程难度最高（OS accessibility 权限、向非前台窗口投递事件不抢焦点），收益最低。**排在路线图最后。**

## 06 · 扩展层

Skills / Plugins / Connectors / MCP 四件事的关系：Connector 是 UI 概念，MCP 是协议，Plugin 是打包格式，Skill 是提示词工程的模块化。

### Skills 与三级渐进加载

**是什么 ·** 指令 + 元数据 + 可选资源打包成文件夹。核心机制是 progressive disclosure：

**何时用 ·** 任何你已经解释过两遍以上的工作流；任何有固定输出格式的产物。内置的 pptx / xlsx / docx / pdf 在 claude.ai 和 Cowork 自动生效。

**复刻要点 ·** 三点：① **description 就是路由表**，触发是纯语义匹配、没有意图分类器 —— 不触发 99% 是因为 description 没写「什么时候用」；② **重逻辑放脚本不放 Markdown**，脚本代码不进 context 只有 stdout 进，这是控制 token 成本的主要杠杆；③ skill 机制成立的前提是**你的 agent 有文件系统和 bash**（官方就是让模型 `cat SKILL.md`，不是特殊加载 API）。

| 级别           | 何时加载                       | token 成本   | 内容                                            |
|----------------|--------------------------------|--------------|-------------------------------------------------|
| L1 元数据      | 永远（启动时进 system prompt） | ≈100 / skill | `name` + `description`                          |
| L2 指令        | description 命中请求时         | \< 5k        | SKILL.md 正文                                   |
| L3 资源 / 脚本 | 被引用时才读                   | 访问前为 0   | 参考文档进 context；**脚本走 bash，只有输出进** |

    ---
    name: your-skill-name      # ≤64 字符，小写字母/数字/连字符，不能含 claude 或 anthropic
    description: 做什么 + 什么时候用   # 必须同时写清 what 和 when，这决定是否触发
    ---
    # 正文：Instructions / Examples

> **⚠ 安全** — 恶意 skill 能指使 Claude 调用与其声称用途相反的工具。官方要求「像在生产系统上装软件一样对待」，尤其警惕会去外部 URL 拉东西的 skill。复刻时需要沙箱执行 + 内容扫描 + 组织级禁用开关。

> **⚠ Record a skill** — 2026 年新增的交互创新：**录屏 + 口述讲解，Claude 把这段过程转成可复跑的 skill**。入口在桌面 App 的 `+` 菜单。实现上需要屏幕录制 + 音频转写 + 「demo 转结构化指令」的合成管线。

### Plugins 与 marketplace

**是什么 ·** 一个包同时带 Skills + Connectors（MCP）+ Agents（子 agent）+ Hooks + Commands。清单 `.claude-plugin/plugin.json`，MCP 定义在 `.mcp.json`。**Plugins 只在 Cowork 和 Code 生效，Chat 不用**（但组织插件的 hooks 会在 Chat 里跑）。

**何时用 ·** **任何含插件包的 Git 仓库都能当 marketplace** —— 填 `owner/repo` 即可。这是团队内部分发的标准姿势。

**复刻要点 ·** 需要包格式 + 清单 schema + 市场协议 + **sha256 完整性校验**。三层优先级模型：managed MCP \> 组织插件 \> 用户扩展，且用户层可整体关闭。还要有组件级开关（装了插件后仍能单独禁用其中某个 skill / hook）。Hooks 风险最高 —— 它要求你定义会话生命周期事件点并允许挂脚本。

| 限额项           | 值     | 限额项                  | 值   |
|------------------|--------|-------------------------|------|
| 插件包（解压后） | 200 MB | 单市场插件数            | 500  |
| 单包文件数       | 5,000  | 可添加市场数            | 25   |
| 市场仓库归档     | 512 MB | App 内 skill 预览单文件 | 1 MB |

### Connectors 与三档验证标签

**是什么 ·** Connector 是 UI 概念，底层就是 MCP。目录今天有约 796 个。五类：Anthropic 第一方（Drive / Gmail / Calendar / GitHub / Slack / Microsoft 365）、远程 MCP、MCP Apps（在对话里渲染交互 UI）、MCPB 桌面扩展、自托管本地 MCP。

**何时用 ·** 访问云端 SaaS → remote；访问本机文件 / 剪贴板 / 本地数据库 / OS 权限 → 桌面扩展（仅 Desktop + Code 可用）。

**复刻要点 ·** 三档标签（Verified / Community / Custom）**只影响展示与发现，不影响运行时能力** —— 但连接前必须把差异说清楚，这是合规要点。另一个必踩的坑：**连接器身份要绑定目录 ID 而不是 URL**，否则服务商把 `/sse` 换成 `/mcp` 后，用户的具名连接器会掉成「Custom」、目录里显示未安装、重复添加得到两份连接。

### OAuth 与自定义连接器

**是什么 ·** 填完 URL 会**探测该 URL 并预填检测到的认证设置**（标注 Detected）。认证三选一：Always required / Required when the server asks / None。OAuth client 三选一：**CIMD**（Client ID Metadata Document，推荐）/ DCR 动态注册 / 自带 client。另有 Request headers（beta，最多 4 个，头名需白名单）。

**何时用 ·** 认证设置**添加后不可修改**，只能删了重加，成员需重新连接。URL 以 `/sse` 结尾会自动选旧版 SSE transport。

**复刻要点 ·** 优先 CIMD、DCR 兜底 —— DCR 在新规范里已 deprecated，且会导致 N 个 server × M 个用户的注册爆炸。必须**校验授权响应里的 `iss`**（RFC 9207）与记录的 issuer 一致后才兑换 code；凭证**按 issuer 分键持久化**，不得跨授权服务器复用。凭证进 OS keychain。

### MCPB 桌面扩展（.mcpb）

**是什么 ·** 本质是一个 ZIP，把 MCP server 和全部依赖打包，双击安装。唯一必需文件是 `manifest.json`。`.dxt` 是旧扩展名，仍兼容但新扩展一律用 `.mcpb`。

**何时用 ·** **Claude Desktop 自带 Node.js runtime**，所以 node 类型扩展不需要用户装 Node —— 这是「双击即装」能成立的关键。

**复刻要点 ·** 核心链路：`user_config` → 生成配置表单 → 校验 → `sensitive: true` 的值写 keychain → spawn 时做 `${...}` 模板插值。模板变量有 `${__dirname}` / `${user_config.*}` / `${HOME}` / `${TEMP}`。扩展目录（gallery）和 sideload（拖拽安装）要**分开做开关**，企业策略会分别禁用它们。

    {
      "mcpb_version": "0.1",
      "name": "my-extension",
      "version": "1.0.0",
      "server": {
        "type": "node",                       // node | python | binary
        "entry_point": "server/index.js",
        "mcp_config": {
          "command": "node",
          "args": ["${__dirname}/server/index.js"],
          "env": { "API_KEY": "${user_config.api_key}" }
        }
      },
      "user_config": {
        "api_key":   { "type": "string",    "title": "API Key", "sensitive": true, "required": true },
        "workspace": { "type": "directory", "title": "Workspace folder" }
      },
      "compatibility": { "claude_desktop": ">=0.10.0", "platforms": ["darwin","win32","linux"] }
    }

### 本地 MCP server（stdio）

**是什么 ·** 配置写在 `claude_desktop_config.json`，Claude Desktop **启动时自动拉起**这些子进程，**以当前用户权限运行**。改完配置必须**完全退出并重启**（Quit，不是关窗口）。

**何时用 ·** 本地进程、无网络依赖、低延迟、需要 OS 权限时。查看已连接的 server：聊天框 `+` → Connectors → Manage connectors；或 Settings → Developer。

**复刻要点 ·** 子进程管理要做全：spawn → 握手超时 → 崩溃自动重连（退避）→ stderr 持久化到 per-server 日志 → **进程树清理**（Windows 上要杀整个 job object，否则 npx 拉起的 node 会泄漏）。`npx` 首次运行要下包，冷启动可能 10s+，要给启动超时和 connecting 状态。

|      | macOS                                                             | Windows                                       |
|------|-------------------------------------------------------------------|-----------------------------------------------|
| 配置 | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` |
| 日志 | `~/Library/Logs/Claude`                                           | `%APPDATA%\Claude\logs`                       |

    {
      "mcpServers": {
        "filesystem": {
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem",
                   "/Users/username/Desktop"]          // 必须绝对路径
        },
        "brave-search": {
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-brave-search"],
          "env": {
            "APPDATA": "C:\\Users\\user\\AppData\\Roaming\\",   // Windows ENOENT 的解药
            "BRAVE_API_KEY": "..."
          }
        }
      }
    }

> **⚠ GUI 进程的环境变量坑** — Windows 日志里出现 `${APPDATA}` 未展开、或 `npx` 找不到，根因都是 **GUI 应用 spawn 出来的子进程继承的 env 和登录 shell 不一样**，常拿不到用户 shell 的 PATH。复刻时务必显式注入一个合理环境（macOS 上考虑读 login shell 的 env）。

> **⚠ 你可以做得比官方好** — 官方的模型是「改配置 → 重启应用」，没有热重载。做一个文件 watch + 单 server 热重载，是成本很低的差异化点。

### MCP 协议 2026-07-28：一次破坏性重构

**是什么 ·** 当前规范版本，**不是小版本升级**。删掉了 `initialize` 握手、删掉了会话（`Mcp-Session-Id`）、删掉了 SSE 断流续传和 HTTP GET 端点、删掉了 `ping`；`roots` / `sampling` / `logging` 全部标记为 Deprecated；服务端发起的请求被 **MRTR** 取代。

**何时用 ·** Deprecated 特性至少保留 12 个月。旧 server 不带 `resultType` 时，客户端 MUST 当成 `"complete"`。

**复刻要点 ·** 把 client 实现成**无状态请求 + 可选 discover 缓存**，不要按老 SDK 的「connect → initialize → 持久 session」建模。因为 session 没了，**不能假设连接有状态**：重连廉价，但 in-flight 请求会丢，重试**必须换新 request ID**。`tools/list` 结果带 `ttlMs` 和 `cacheScope` —— 照它缓存，直接省 token。

| 能力                        | 2026-07-28 状态                       | 迁移路径                                    |
|-----------------------------|---------------------------------------|---------------------------------------------|
| Tools / Resources / Prompts | 正常                                  | —                                           |
| Elicitation                 | 唯一还活着的客户端 primitive          | 必须通过 MRTR 投递                          |
| Sampling                    | Deprecated                            | 直接集成 LLM provider API                   |
| Roots                       | Deprecated                            | 改用 tool 参数 / resource URI / server 配置 |
| Logging                     | Deprecated，`logging/setLevel` 已删   | stdio 打 stderr，或 OpenTelemetry           |
| 订阅                        | GET 端点与 `resources/subscribe` 已删 | `subscriptions/listen` 长活 POST 流         |
| Tasks                       | 移出核心，成为官方扩展                | `io.modelcontextprotocol/tasks`             |

**MRTR（Multi Round-Trip Requests）**是最大的架构变化 —— 服务端不能再主动向客户端发请求。流程：client 发 `tools/call`(id:1) → server 缺信息，返回 `InputRequiredResult`(id:1) 带 `inputRequests` + `requestState`，**原请求到此终止** → client 向用户收集输入 → client **用新 id 重发原请求**，带上 `inputResponses` 和**原样回传**的 `requestState` → server 重建状态返回结果。

> **⚠ MRTR 的硬规则** — 客户端 **MUST NOT** 检查、解析或修改 `requestState`，必须原样回传，也不能凭空加。重试的 JSON-RPC id **MUST** 与原请求不同。只有 `prompts/get` / `resources/read` / `tools/call` 可以返回 `InputRequiredResult`。服务端侧：`requestState` 是攻击者可控输入，MUST 做完整性保护（HMAC/AEAD），SHOULD 放认证主体 + 短 TTL + 原请求摘要防重放。

> **⚠ UI 含义** — Elicitation 的 `requestedSchema` 是 JSON Schema —— 你需要一个**能从 JSON Schema 动态生成表单**的组件。这是 Desktop 交互体验的核心组件之一，也是 MRTR 落地到 UI 的唯一接口。

## 07 · 权限与设置

### 审批状态机

**是什么 ·** 已确认存在的：执行前单次审批、**Always allow**（官方提示「只对可信 server 点」）、per-tool 设为 **Blocked**（`Customize > Connectors` 里逐个 tool 设）、per-conversation 的连接器开关。组织级两档：`ask`（每次都提示，**即使在 auto 模式下也生效**）/ `blocked`（该 tool 被过滤掉、根本不出现在工具列表里）。

**何时用 ·** 外部站点操作另有一套：Allow once / Always allow / Deny，按站点保存。localhost 和项目文件不需审批。

**复刻要点 ·** 建议做成：五档状态（`ask` / `allow_once` / `allow_session` / `always` / `blocked`）× 三层作用域（**全局 \> 连接器 \> 单个 tool**），组织策略可锁死任一层。注意 `blocked` 与 `ask` 的本质差别：前者是**从工具列表里过滤掉**，模型根本不知道它存在；后者只是拦在调用前。

### 权限模式（Code tab）

**是什么 ·** 五档：Manual（都问）/ Accept edits（自动批准文件编辑和 `mkdir`/`touch`/`mv`，其他终端命令仍问）/ Plan（只读探索 + 出方案）/ Auto（全执行，后台安全检查校验是否偏离你的请求）/ Bypass。

**何时用 ·** 模式选择器在发送按钮旁，可中途切换，**按文件夹记住偏好**（Plan 除外，仅 per-session）。快捷键 Cmd/Ctrl+Shift+M。Cloud session 支持 Accept edits / Plan / Auto，**不支持** Manual 和 Bypass。

**复刻要点 ·** 「按文件夹记住权限偏好」是个很好的细节 —— 权限的自然作用域是工作目录，不是会话。

### 工具超时与输出落盘

**是什么 ·** 完整的超时体系（以 Claude Code 为准，Desktop Chat 侧未公开）：`MCP_TIMEOUT`（启动 + 首连）、`MCP_TOOL_TIMEOUT`（执行默认）、每 server 的 `timeout`（**硬 wall-clock，progress 通知不会延长它**）、`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`（remote 5 分钟 / stdio 30 分钟）、`MAX_MCP_OUTPUT_TOKENS`（默认 25,000，10,000 时告警）。

**何时用 ·** 超出输出上限的结果**存到文件，Claude 按需读**。

**复刻要点 ·** 「输出过大 → 落盘 + 让模型按需读」直接抄。这比截断优雅得多，也比无脑塞进上下文便宜得多。

### 设置面板的一分为二

**是什么 ·** **本机应用设置**（macOS 走系统菜单栏的 Claude → Settings…）：Developer（MCP 配置、Edit Config、连接状态、日志）、Extensions、General（Computer use、Denied apps、Quick entry、听写）。**账号设置**（Customize）：Connectors、Skills、Plugins —— 跟账号走、跨设备同步。

**何时用 ·** 这个切分决定了你的设置存储架构：本机设置走 MDM / 注册表策略，账号设置走云端同步。

**复刻要点 ·** 从第一天就分清楚，后期再拆代价很大。**Memory / Privacy 分区在 Desktop 上的具体位置未从官方文档确认。**

### 企业策略键

**是什么 ·** macOS 走 MDM，domain `com.anthropic.claudefordesktop`；Windows 走组策略 / 注册表 `HKLM:\SOFTWARE\Policies\Claude`（机器级）与 `HKCU`（用户级），**机器级覆盖用户级**。

**何时用 ·** 优先级陷阱：已配置 MDM / 组策略时，**它覆盖应用内 allowlist**。要让应用内桌面扩展 allowlist 生效，`isDesktopExtensionEnabled` 和 `isDesktopExtensionDirectoryEnabled` 都不能设为 false。

**复刻要点 ·** allowlist 的匹配键要分清：`serverUrl` 支持通配（hostname 大小写不敏感、path 敏感）、`serverCommand` 必须精确匹配命令和每个参数、`serverName` **不是安全控制**（用户可以把任何 server 叫 `github`）。评估顺序：先查 denylist（**没有任何东西能覆盖 denylist**），再查 allowlist。`allowedMcpServers` 未设 = 全允许，设为 `[]` = 全不允许。

| Key                                  | 默认  | 作用                                       |
|--------------------------------------|-------|--------------------------------------------|
| `isLocalDevMcpEnabled`               | true  | 启用本地 MCP server                        |
| `isDesktopExtensionEnabled`          | true  | 启用扩展                                   |
| `isDesktopExtensionDirectoryEnabled` | true  | 启用扩展目录访问                           |
| `secureVmFeaturesEnabled`            | true  | Cowork 功能                                |
| `allowedWorkspaceFolders`            | 不限  | 可挂载到 Cowork 的文件夹（支持 `ro` 只读） |
| `disableAutoUpdates`                 | false | 关闭自动更新                               |
| `autoUpdaterEnforcementHours`        | 72    | 待更新多久后强制重启（1–72）               |
| `forceLoginOrgUUID`                  | null  | 限制只能登录指定组织                       |

## 08 · 你可能没用过的十二件事

从上面的调研里挑出的、重度用户也常年不碰但对「其他用户会怎么用」最有参考价值的功能。

1.  **Quick Entry 把应用窗口当附件**双击 Option 唤起后，点某个 app 窗口就能把它的内容附进消息，也能拖选屏幕区域截图。不用先截图再拖文件。
2.  **Project knowledge 的 RAG 自动切换指示器**项目知识超过上下文窗口时界面会明确告诉你已切到检索模式。知道这个，你就会去改文件名和分组来提升检索质量。
3.  **把已有会话搬进项目**会话名旁的下拉，或在 chat history 页批量搬。不用重开一个会话再复述一遍。
4.  **Artifact 的高亮原地改**选中要改的那一段，直接打字说明改动，Claude 就在你标记的位置改，不重写全文。
5.  **Memory 的导入**`Settings > Memory > Start import`，把别的 AI 助手导出的记忆粘进来，Claude 抽成条目。
6.  **Monthly Recap**`Settings > Reflect`，看你自己的使用回顾和 AI 熟练度四维观察。对做产品的人来说，这是一份现成的用户行为画像范本。
7.  **Record a skill**录屏 + 口述讲解，Claude 把这段过程转成可复跑的 skill。比手写 SKILL.md 门槛低得多。
8.  **Cowork 内置浏览器**不用装 Chrome 扩展就能做浏览器自动化，而且用的是干净的独立身份。很多人还在为此装扩展。
9.  **Dispatch 从手机派活**桌面 App 开着时电脑注册为 Dispatch host，你在手机上开对话、活跑在桌面上。
10. **任何 Git 仓库当 plugin marketplace**填 `owner/repo` 就行。团队内部分发插件不需要任何基础设施。
11. **Custom visuals**Claude 现场生成布局和交互的图表，不是套模板。beta，仅 web/desktop。
12. **Incognito 的黑边框**整个会话加视觉隔离标识。这是个很小但很值得抄的信任设计 —— 敏感模式必须看得见。

## 09 · 复刻路线

顺序不是按功能重要性排的，是按**依赖关系**排的 —— 前面的缺了，后面的整个模型就不成立。这是我的判断，不是官方建议。

1.  #### 沙箱 + 文件系统 + bash

    地基。Skills 的三级加载、脚本执行、文件创建、artifact 生成全都建在它上面 —— 官方的 skill 加载就是让模型 `cat SKILL.md`，没有文件系统这个机制根本不成立。先把这层做对，后面一半功能是自然长出来的。

2.  #### 会话对象服务端化

    会话必须能脱离任何客户端独立存活，客户端只是 attach/detach 的 viewer。这是 Chat 与 Cowork 的架构分水岭，也是「关掉笔记本任务继续跑」的唯一前提。改造成本随时间指数上升，越早越好。

3.  #### capability 授权链

    三种 grant（文件夹 / 应用 / 站点）× 四种动作（读 / 写 / 删 / 执行），加上工具调用前的策略检查点。注意删除权限是**运行期单独申请**的，不是开局全给 —— 这个分级从一开始就要有。

4.  #### 双向文件同步 + mtime 守卫

    宿主路径 ↔ 沙箱路径的双向映射，加乐观并发控制。没有守卫，「覆盖用户新编辑」是迟早会发生的事故。

5.  #### MCP client（按 2026-07-28 写）

    无状态请求 + `server/discover` 缓存 + `resultType` + MRTR + `subscriptions/listen`，带一层向后兼容（对 2025-11-25 及更早的 server 走 initialize 握手）。别用老 SDK 的心智模型开工。

6.  #### stdio 子进程管理

    配置读写 + spawn + **显式环境注入** + per-server stderr 日志 + 崩溃重连 + 进程树清理。这是桌面端相对 Web 的唯一硬护城河，也是官方 troubleshooting 文章篇幅最长的地方。

7.  #### Skills 三级懒加载

    元数据常驻 system prompt → 正文按需 → 资源按需。触发是纯语义匹配，**不要去写 intent classifier**。配一个 description 质量校验 / eval 工具，否则用户写的 skill 全都不触发。

8.  #### OAuth（CIMD 优先）+ MCPB 装载器

    CIMD 主路径、DCR 兜底、凭证按 issuer 分键进 keychain、校验 `iss`。MCPB 需要内置 Node runtime + manifest 解析 + user_config 表单 + 模板插值。做完这个才有「双击即装」。

9.  #### 调度器 / Dispatch / live artifact

    三个都依赖前面全部到位。调度器要能起全新自包含会话；Dispatch 要父子编排 + 深度限制 + 超时默认拒绝；live artifact 要能在渲染时回调宿主取数据。

10. #### Computer use

    放最后。OS 权限最难、工程量最大、收益最低 —— 官方自己把它排在 connector 和浏览器之后当兜底，90% 的场景 connector 就够了。

## 10 · 未确认项与文档冲突

这些是调研中查不到官方说明、或两处官方文档互相矛盾的地方。复刻时这些点要么自己做决定，要么实测，**不要当成已知事实写进设计文档**。

| 条目                                         | 状况                                                                                                                                                       |
|----------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 会话级 star / favorite / archive             | 官方只有项目级。别照别的产品加。                                                                                                                           |
| 消息编辑后的分支（fork）导航                 | 只确认「铅笔图标编辑并重新提交」，没有分支切换器的描述。Artifact 有明确的 version selector，消息级没有。                                                   |
| 单条会话导出 / 导出文件格式                  | 官方只有账号级全量导出；格式、是否含 artifacts / memory 均未说明。                                                                                         |
| Styles 是否已下线                            | 帮助中心的个性化文档已不再列它，Academy 课程仍在教，release notes 无下线记录。风格定制的官方主路径已迁到 Skills / output-style plugins。**建议两条都做。** |
| Chat 是否读写 memory                         | 第三方 Desktop 规格写 Chat「不读写 memory」，但消费者版文档明确 Chat 有 memory。口径冲突。                                                                 |
| 桌面 Cowork VM 与云端沙箱的关系              | 两套官方文档口径不一，没有一页讲清共存或迁移关系。**本次调研最大的文档空白。**                                                                             |
| 定时任务是否暴露原始 cron                    | 帮助中心只列 hourly/daily/weekly/weekdays/manual；changelog 的 bug 描述暗示底层是 cron，UI 是否可填未确认。                                                |
| 定时任务的通知渠道                           | 未提及 push / email。                                                                                                                                      |
| skill `description` 字符上限                 | 平台文档写 1024，帮助中心写 200。冲突未解。                                                                                                                |
| `claude_desktop_config.json` 路径            | MCP 官方文档写 `~/Library/Application Support/Claude/`，Claude Code 文档写 `~/.claude/`。**建议两个位置都探测。**                                          |
| Desktop 的 `managedMcpServers` 结构          | 官方警告它与 Claude Code 同名设置**形状不同**（数组 vs 对象），但数组 entry 的具体结构未公开。                                                             |
| Desktop Chat 的工具超时                      | 未公开。只有 Claude Code 侧的完整体系可参考。                                                                                                              |
| Desktop 是否 Electron / 版本号               | 官方安装文档完全没提 Electron。**不要在设计文档里断言。**                                                                                                  |
| 聊天历史等本地数据的存储路径与格式           | 未公开。只有配置和日志路径是确定的。                                                                                                                       |
| 离线行为                                     | 未公开。只确认本地 MCP server 本身不依赖网络，模型推理仍需联网。                                                                                           |
| Settings 完整分区树                          | 官方没有一篇「设置面板总览」，Memory / Privacy 在 Desktop 上的位置未确认。                                                                                 |
| Desktop Extensions 是否 Team/Enterprise 限定 | docs 页标注仅 Team/Enterprise，工程博客与 support 文章对所有用户开放。合理解读：企业级**分发管理**是 Team/Enterprise，个人安装 `.mcpb` 所有人可用。        |
| Computer use 的 Team/Enterprise 可用性       | 帮助文档写 Pro/Max only，但有第三方报道称已扩大。未交叉确认。                                                                                              |

调研于 2026-09-11，基于 support.claude.com、claude.com/docs、platform.claude.com、academy.claude.com、modelcontextprotocol.io 的当日内容。产品迭代很快，标注为「未确认」的条目请以实测为准。
