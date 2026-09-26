# 界面 → 组件映射

把 UX 规格里的每个界面落到具体组件上。规格来源见 [README](README.md)；阶段划分按 [master-reference §8.5](../architecture/master-reference.md)；阶段 0 的最小集见 [00-foundation/spec.md「UI 最小集」](../architecture/00-foundation/spec.md)。

## 约定

- **底座**：shadcn/ui 的 Base UI flavour + Tailwind 4，组件源码进仓库。「shadcn/ui 映射」列写的是**组件角色**，不是导出符号名——子菜单 / 单选项 / 勾选项这些在 Base UI flavour 里怎么导出，落地时按当时的 registry 复核，本表不当契约。角色层面已知的两处差异：`Sheet` 是 `Dialog` 的侧边变体；没有 cmdk 那个 `Command`，命令面板与 `/` 菜单用 `Dialog` / `Popover` + `Combobox` 组。
- **消息流用 assistant-ui 原语**：`ThreadPrimitive` / `ComposerPrimitive` / `MessagePrimitive` / `ActionBarPrimitive` / `BranchPickerPrimitive` / `AttachmentPrimitive`，正文交给 Streamdown。
- **「自建」** = 没有合适的现成组件，用 Base UI 的底层原语或纯元素自己写；样式仍然只走 `tokens.md` 的令牌，不引第三方 class 串、令牌值、字体名或图标包。图标用 lucide。
- **组件标识只是本表的指代**，不是 class 名——实现时的 class 串由 Tailwind 工具类生成，不要把这些名字拼成选择器。
- **数值只写令牌键名**：控件高、圆角、间距、层级、时长一律引 `tokens.md` 的键，本表和组件里都不写字面量。唯一的例外是侧栏宽 264px——它是 master-reference §8.5 与 spec「UI 最小集」已经公开写出的 IA 数值。
- **阶段列**：`0 / 2 / 3 / 5 / 6` 按 §8.5 的 UX 阶段映射；跟随后端能力才出现的页面写「随能力」。**加粗的 `0` 是阶段 0 要做的行**，实现 plan step 10 时只看这些，其余行是排期依据，现在不写代码。
- 表里的中文名是指代，不是最终文案；所有用户可见文字走 `t()`，界面文本引号用「」。
- 「规格」列只给指针，不摘抄；fixtures 只用来看结构。

## §0 全局约定与基础控件

对应 `interactions.md §0`。这一组就是阶段 0 的「基础组件」清单，后面所有表都建立在它上面。

| Tenon 名称 | 组件标识 | shadcn/ui 映射 | 阶段 | 行为要点 | 规格 |
|---|---|---|---|---|---|
| 主题提供器 | `ThemeProvider` | 自建 | **0** | 亮 / 暗两套令牌挂在 `<html data-theme>`，默认跟随系统；壳层背景是独立一层，切主题两层一起走；`<html lang>` 跟界面语言 | interactions.md §0 |
| 按钮 | `Button` | Button | **0** | 高度只引 `--t-h-control`，控件内再嵌的引 `--t-h-control-nested`；变体 primary / secondary / ghost / danger；`:focus-visible` 焦点环走 `--t-border-focus` | interactions.md §0；tokens.md「h-control」 |
| 图标按钮 | `IconButton` | Button（icon 尺寸）+ Tooltip | **0** | 正方形、必带无障碍名；纯图标控件必须配 Tooltip | interactions.md §0、§1.1 |
| 标记块 | `Chip` | Badge（静态）/ Button（可点）/ ToggleGroup（多选一） | **0** | 静态标记用 Badge，能点的一律是真按钮，不用带 onClick 的 `<span>`；高度走 `--t-h-control-compact`。承载来源跳转的锚点形态见 §3 的 `ObjectChip` | interactions.md §0 |
| 开关 | `Switch` | Switch | **0** | 受控；标签可点；状态变化向同容器的 `role="status"` 播报 | interactions.md §0 |
| 浮层 | `Popover` | Popover | **0** | 默认向上开，贴边时翻转；`Esc` 关并把焦点还给触发钮 | interactions.md §0、§2.3 |
| 菜单 | `Menu` | DropdownMenu | **0** | 上下键循环、首字母跳转、`Esc` 逐级关；子菜单走底座自带的子菜单原语，不自己做悬停延时 | interactions.md §0 |
| 模态 | `Modal` | Dialog（内容）/ AlertDialog（确认） | **0** | 焦点陷阱 + 归还；`Esc` 关；破坏性确认统一「取消 + 危险色主操作」两钮 | interactions.md §0、§6 |
| 气泡提示 | `Tooltip` | Tooltip | **0** | 悬停延时进入、即时退出；键盘聚焦同样触发；内容不可交互 | interactions.md §0 |
| 层级 | `zLayer` | 自建（令牌） | **0** | 五档按 tokens.md 的 z 层：`--t-z-sticky` < `--t-z-popover` < `--t-z-modal` < `--t-z-tooltip` < `--t-z-toast`；Tooltip 要能压在 Modal 上，所以排在它之上。组件只引键名，不写字面量 | interactions.md §0；tokens.md「z」 |
| 动效降级 | `MotionGuard` | 自建 | **0** | 所有动画包在 `prefers-reduced-motion` 与显式开关下有无动画降级，缓动与时长只取令牌 | interactions.md §0、§5 |
| 快捷键层 | `Hotkeys` | 自建 | **0** | 全局键在一处注册并暴露给 `aria-keyshortcuts`；输入焦点内不抢单键；键位是 Tenon 自己的表 | interactions.md §0 |

## §1 壳层

对应 `interactions.md §1`。阶段 0 只做「侧栏（264px、可折叠）+ 顶栏 + 内容列 + 空的右面板」。

| Tenon 名称 | 组件标识 | shadcn/ui 映射 | 阶段 | 行为要点 | 规格 |
|---|---|---|---|---|---|
| 侧栏 | `Sidebar` | Sidebar（只取结构与折叠状态）+ ScrollArea + Separator | **0** | 阶段 0 固定 264px（§8.5 的 IA 数值）；折叠 = 整条撤出、内容列居中补位；状态持久化 | interactions.md §1.1 |
| 品牌行 | `BrandRow` | 自建 | **0** | 只有标识与产品名；对话 / 任务的模式切换不在这里，在首页输入框内（见 §2） | interactions.md §1.1；parity-audit 2026-09-16 |
| 导航项 | `NavItem` | Button（ghost）+ Tooltip（折叠态） | **0** | 行高走 `--t-h-control-compact`（tokens.md 把侧栏行、Menu item、Chip 定在同一档）；当前项 `aria-current`；上下键 roving tabindex；hover 才浮出行尾 `⋮` | interactions.md §1.1；tokens.md「h-control」 |
| 新建行 | `NewChatRow` | Button + Button（icon，hover 出）+ Tooltip | **0** | 侧栏顶部的新建会话主行（带快捷键角标）；行尾 hover 才出的「快速任务」钮直接开一条任务模式会话，跟随模式切换（3）出现 | interactions.md §1.1；parity-audit §2 |
| 侧栏底部动作组 | `SidebarFooterActions` | Button（icon）+ Tooltip | **0** | 折叠 / 搜索 / 设置三个图标钮；每个都有 Tooltip 与快捷键提示 | interactions.md §1.1 |
| 账号行与菜单 | `AccountMenu` | DropdownMenu（含子菜单） | **0** | 整行是单一菜单触发器，不另挂齿轮。阶段 0 只有「语言」（跟随系统 / 中文 / English，当前项打勾），切换即时生效并写盘；「设置」与 `SettingsModal` 同批出现，别先放一个点不开的入口；「用量」「配置档案」随各自后端能力再排 | interactions.md §1.1；spec.md「国际化」；parity-audit §2 |
| 侧栏宽度拖拽条 | `SidebarResizer` | 自建（`separator` + 指针拖拽） | 6 | 侧栏首个子元素，有无障碍名与键盘调宽；宽度记住。阶段 0 不做，固定 264px | interactions.md §1.1；parity-audit §2 |
| 折叠态悬停浮层 | `SidebarFlyout` | Popover（悬停触发） | 6 | 左上角悬停区浮出临时侧栏，移开即收，点击则恢复占位展开 | interactions.md §1.1 |
| 分组标题行 | `NavGroupHeader` | Collapsible + Button + Tooltip | 随能力 | hover 追加「去列表页 ↗」与筛选两个图标钮，标题本身可折叠分组 | interactions.md §1.1；parity-audit §2 |
| 置顶分组 | `PinnedGroup` | Collapsible + 自建拖拽落点 | 随能力 | 分组常驻（没有置顶项也渲染），空态是可见的拖拽落点与一句说明 | interactions.md §1.1；parity-audit §2 |
| 项目两级树 | `ProjectTree` | Collapsible + Button（icon）+ `SessionStatusDot` | 随能力 | 项目行内嵌「展开该项目会话」钮（自己的无障碍名），钮上叠未读标；展开后在项目下缩进渲染该项目的会话行 | interactions.md §1.1；parity-audit §2 |
| 会话行状态点 | `SessionStatusDot` | 自建（`role="status"`） | 3 | 四态：有新内容 / 普通 / 已读 / 等你定夺；点本身可点（即标为已读）；只靠颜色不够，形状也要区分 | interactions.md §1.1；parity-audit 2026-09-16 |
| 会话行行尾标记 | `NavItemTrailing` | Badge + 自建 | 随能力 | 行尾的计数与频率位：定时任务行显「N 条新」或频率文字，会话行显相对时间；与 `⋮` 互斥，hover 时让位 | interactions.md §1.1；parity-audit §3 |
| 会话行菜单 | `SessionRowMenu` | DropdownMenu（含子菜单） | 随能力 | 置顶 / 重命名 / 加入项目 › / 移动到分组 ›（含「新建分组…」）/ 归档 / 删除；单键快捷键只在行悬停时生效 | interactions.md §1.1；parity-audit §2 |
| 定时任务行菜单 | `ScheduleRowMenu` | DropdownMenu（含子菜单） | 随能力 | 另一套项集：立即运行 / 暂停（已暂停显「恢复」）/ 全部标已读 / 编辑 / 删除；与会话行菜单不共用 | interactions.md §1.1；parity-audit §3 |
| 项目行菜单 | `ProjectRowMenu` | DropdownMenu | 随能力 | 取消置顶 / 编辑详情 / 分隔线 / 归档 / 删除；**不给快捷键角标**（会由项目菜单与全局快捷键表撞车），角标只有会话行菜单有 | parity-audit §2 |
| 列表筛选菜单 | `ListFilterMenu` | DropdownMenu（含单选项与子菜单） | 随能力 | 五段（类型 / 状态 / 最近活动 / 分组 / 排序），每行右侧显当前值；补「显示空分组」与「恢复默认」；最近活动 1 / 3 / 7 / 30 天 | interactions.md §1.1；parity-audit 2026-09-16 |
| 批量选择与操作条 | `ListSelectionBar` | Checkbox + 自建浮条 + Button | 随能力 | 行 hover 出多选框，选中后底部浮出操作条（计数 + 归档 / 删除 / 取消）；归档动作与单行菜单的项集必须一致，不能一边有一边没有 | parity-audit §2 |
| 顶栏 | `TopBar` | 自建 + Separator | **0** | 无背景；左标题右操作；标题过长省略但保留完整无障碍名 | interactions.md §1.2 |
| 会话标题菜单 | `ThreadTitleMenu` | DropdownMenu | 2 | 标题旁 `⌄` 打开；「查看本次记录」按需打开过程记录，不做标签页、不进侧栏 | interactions.md §1.2；parity-audit 2026-09-13 |
| 顶栏操作区 | `TopBarActions` | Button + Button（icon）+ Tooltip | 5 | 右面板开关与产物入口（`aria-pressed` 与面板显隐同步）；生成中相关按钮置灰而不是消失 | interactions.md §1.2 |
| 右面板容器 | `SidePanel` | 自建分栏 + ScrollArea | **0** | 阶段 0 只留空壳与宽度、折叠状态（spec「UI 最小集」明写的例外）；打开时主列压窄左移，不覆盖 | interactions.md §1.3；spec.md「UI 最小集」 |
| 右面板分段 | `PanelSection` | Collapsible + Separator + Badge | 5 | 四段各自可折叠、折叠状态记住、**收起时段头下仍留一句说明**：进度 / 产物 / 上下文 / 建议连接器。上下文段内部再分三块：文件夹 chip + 本次用过的技能 + 连接器子段。建议连接器段可 ✕ 关闭 | interactions.md §1.3；parity-audit §8、2026-09-16 |
| 产物分栏 | `ArtifactSplit` | 自建（复用 `SidePanel`） | 5 | 文件与文档产物触发右半屏通栏；内联产物不开分栏。分栏里按产物类型分流到下面两种渲染器 | interactions.md §1.3 |
| 表格类产物查看器 | `ArtifactViewerPanel` | 自建头 + Select + ToggleGroup + 自建 iframe + Skeleton | 5 | 产物段内的第一种渲染器：头部为产物名 + 类型后缀 + 版本选择器 +「预览 / 代码」分段 + 复制 / 下载 / 在系统默认应用中打开 / Expand（撑到全宽，`aria-expanded` 翻转）/ Close（回产物列表，不是折叠整段）；内容是无网络沙箱 iframe，底部常驻一行元信息；左边缘可拖拽调宽并记住 | interactions.md §3.6；parity-audit 块词汇 |
| 文档阅读面板 | `DocReaderPanel` | 自建头 + Button（分裂钮）+ ScrollArea | 5 | 第二种渲染器：头部为文档标题 + 复制分裂钮（主键复制全文，副键给 Markdown / 纯文本）+ 导出 + Expand + Close；正文用衬线正文体，独立滚动，左侧可选 h2 章节导航；与主栏文档卡的按下态双向同步；没有对应能力的动作直接省掉，不放空按钮 | interactions.md §3.6；parity-audit 块词汇 |
| 内容列 | `ContentColumn` | 自建 | **0** | 定宽居中、滚动容器在这一层；消息列永不横滚，横向溢出由块内部自己处理 | interactions.md §1.1、§3.2 |
| 设置模态 | `SettingsModal` | Dialog + Tabs（垂直）+ ScrollArea | 3 | 哈希路由，从任何页打开不丢上下文；`Esc` 关；阶段 3 只两样：文件夹访问 / 网络白名单，沙箱档位收在「高级」折叠区；审批模式三档（默认手动）挪到阶段 4。「以后都允许」过的规则在这里可逐条撤销 | interactions.md §1.4；parity-audit 2026-09-13；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 设置后续分页 | `SettingsTabs` | Tabs + Switch + Select + Table | 随能力 | 审计 §7 的 A 类五项，各随自己的后端能力上线：通用与全局指令（全局指令与项目指令分层，项目指令注明叠加关系）/ 通知（回答完成、需要批准、定时任务失败）/ 隐私与数据（导出 + 逐类清理，本地版不放训练开关）/ 用量（单栏无左导航）/ 能力（工具加载方式、产物与内联可视化开关）。左栏分两组，第二组是定制页的整页跳转 | parity-audit §7、§6 |
| 记忆页 | `MemoryPage` | 自建整页 + Switch + Table + `Composer`（精简） | 随能力 | 三个独立开关（检索并引用历史 / 从对话生成记忆 / 敏感话题）+ 四段分组（你 / 话题 / 领域 / 项目）+ 条目表格（名 / 摘要 / 更新时间 / 编辑 · 删除）+ 贴底的「告诉它要改什么」输入行；入口在设置左栏 | parity-audit §7 |
| 命令面板 | `CommandPalette` | Dialog + Combobox | 随能力 | 全局唤起，搜会话与项目；无结果时保留「用这个词新建」的动作项 | interactions.md §1.1；parity-audit §2 |

## §2 输入框

对应 `interactions.md §2`。阶段 0 只做「文本、发送、生成中停止」——工具行、模式切换、`+` 菜单都不在阶段 0。

| Tenon 名称 | 组件标识 | shadcn/ui 映射 | 阶段 | 行为要点 | 规格 |
|---|---|---|---|---|---|
| 输入框 | `Composer` | ComposerPrimitive.Root + Textarea（自增高） | **0** | 空态与会话内两种宽度；`Enter` 发送、`⇧Enter` 换行；输入法组合中的 `Enter` 不发送 | interactions.md §2.1、§2.2；spec.md「国际化」 |
| 占位文案 | `ComposerPlaceholder` | 自建 | **0** | 随上下文切换（空态问候 / 会话内 / 有技能时 / 输入 `/` 后 / 提问 widget 在场时），全部走目录 | interactions.md §2.1 |
| 发送钮 | `SendButton` | ComposerPrimitive.Send + Button（icon） | **0** | 有正文或有附件即激活；禁用态也要能聚焦并说明原因；阶段 2 起生成中与停止钮并存，发送 = 入队，`Cmd/Ctrl+Enter` = 立即发送 | interactions.md §2.2；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 停止钮 | `StopButton` | ComposerPrimitive.Cancel + Button（icon） | **0** | 阶段 2 起与发送钮并存（阶段 0 生成中原地替换发送钮）；`Esc` 等效；阶段 2 起「停止」即杀，杀整棵进程树，结果写在失败卡的副作用行 | interactions.md §2.2；parity-audit 2026-09-16；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 免责行 | `ComposerDisclaimer` | 自建（静态文案） | **0** | 输入框下方常驻一行 `t()` 文案，不是控件；窄屏缩短为短句（§7 的响应式在阶段 6 统一过） | interactions.md §2.1、§7 |
| 输入框上方槽位 | `ComposerSlots` | 自建（槽位容器） | 2 | 输入框上方只有这一个宿主，优先级写死：审批席 > 提问 widget > 到量条；**最多同时显示一条**，其余折叠成一行「还有 N 条 ›」。槽位本身不渲染内容，只排序与折叠。阶段 2 只放提问 widget，审批卡内联在消息流里、不进槽位 | parity-audit 块词汇「到量提示条」；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 工具行 | `ComposerToolbar` | 自建（Base UI Toolbar）+ Button | 2 | 阶段 0 没有工具行（spec 的 Composer 最小态只有文本 / 发送 / 停止）；它随第一个占位者（模型菜单）出现。左键组右键组，左右箭头在组内移动；有内容时只有语音那一组会被发送钮替换，模型标记常驻 | interactions.md §2.1；parity-audit §1 |
| 模式切换 | `ModeSwitch` | Tabs（或 ToggleGroup） | 2 | 对话 / 任务两档，位置在首页输入框内而不是侧栏品牌行；新会话发出第一条消息之前可切，建立后只显示形态、不能改 | parity-audit 2026-09-16；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 文件夹 chip | `FolderChip` | Button（chip 变体）+ 系统目录对话框 | 2 | 只在任务形态出现，位于输入框下方：列出本会话的文件夹，第一个标为 cwd，没选时显示「专用文件夹」；点开由主进程弹系统目录选择框，可多选，点确认才生效，每一项都能移除；行为照 02 §工作区（只在任务形态）。授权弹窗、「以后都允许」、撤销在阶段 3 | [02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 无痕入口 | `IncognitoToggle` | Button（`aria-pressed`）+ Tooltip | 随能力 | 首页头部的常驻入口：本次对话不入记忆、不入过程记录；开启态在输入框上有可见标记，不是只改一个开关 | parity-audit §1、§2 |
| 附加菜单 | `AttachMenu` | DropdownMenu（含子菜单与勾选项） | 3 | `+` 打开；对话与任务两套菜单项，不共用一套（任务模式去掉加入项目 / 从 GitHub 添加 / 网络搜索，能力组末尾多一项运行位置）；默认向上开，贴顶时向下开 | interactions.md §2.3；parity-audit §1 |
| 菜单开关组 | `AttachToggles` | DropdownMenu（勾选项） | 随能力 | `+` 菜单末段的开关组：网络搜索 / 记忆（各自随后端能力出现），打勾即开；开启后在工具行留一枚对应 chip。网络搜索开关随阶段 3 的 `AttachMenu` 做，关掉即「本会话不提供搜索」，按工具表冻结规则从新会话起生效 | interactions.md §2.3；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 技能子菜单 | `SkillsSubmenu` | DropdownMenu 子菜单 + ScrollArea | 随能力 | 已装技能列表 + 管理 / 浏览两个动作项 | interactions.md §2.3 |
| 连接器子菜单 | `ConnectorsSubmenu` | DropdownMenu 子菜单 + Switch | 随能力 | 每个连接器一行开关；末尾「工具加载方式 ›」二级单选 | interactions.md §2.3 |
| 插件子菜单 | `PluginsSubmenu` | DropdownMenu 子菜单 | 随能力 | Tenon 特有且保留：「插件 ›」下是按角色的工具包 + 管理 / 浏览插件；入口位置与对照对象的单行动作项相同，不下沉 | interactions.md §2.3；parity-audit §1 |
| 运行位置子菜单 | `RunLocationSubmenu` | DropdownMenu 子菜单（单选项） | 随能力 | 取代规格里的设备列表，值只有「本机」，默认项打勾；会话顶栏的同名指示与它一致 | interactions.md §2.3；parity-audit 处理规则 C、§8 |
| 模型菜单 | `ModelMenu` | DropdownMenu（含单选项与子菜单） | 2 | 按厂商分组，只列已配置厂商的模型行，未配置的厂商只留一行置灰组头「去设置填 key」；每行双行：模型名 + 用途句或行标记（`<主机> · 仅文字对话`，回环时为「本机」/ 未验证 · 仅文字对话）与目标主机，当前项打勾；「思考强度 ›」子菜单；「更多模型 ›」收 Legacy 行与各厂商的手填模型 ID 输入框；末尾「管理模型…」打开设置。生成中或有待批时标「下一条消息起生效」；有历史的会话从本机或私网切到公网时，菜单原地确认并给「用新模型开新会话」 | interactions.md §2.4；parity-audit §1；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 思考强度子菜单 | `EffortSubmenu` | DropdownMenu 子菜单（单选项） | 2 | 逐档说明，默认档标「默认」，最高档标注用量代价；没有思考描述的模型不显示（不做退化开关）；档位随会话记，换模型回到新模型的默认档 | interactions.md §2.4；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 斜杠菜单 | `SlashMenu` | Popover + Combobox | 随能力 | 输入 `/` 在框上方弹紧凑列表，首项高亮，上下键选择，`Esc` 关并保留已输入文本 | interactions.md §2.4 |
| 类别入口标记 | `PromptCategoryChips` | Button（chip 变体） | 6 | 空态才出现，点开是原地展开的建议面板而不是直接填词；有内容后收起 | interactions.md §2.5；parity-audit §1 |
| 建议面板 | `SuggestionPanel` | Collapsible + ThreadPrimitive.Suggestion | 6 | 在标记下方原地展开，`role="option"` 列表 + 关闭钮；点某条 = 直接发送展开后的长指令，不预填 | interactions.md §2.5 |
| 深度检索前置确认 | `ResearchConfirmDialog` | AlertDialog | 6 | 开启深度检索后**首次发送**弹一次前置确认（讲清耗时与用量），确认过不再弹 | interactions.md §2.3；parity-audit 2026-09-17 |
| 附件缩略卡 | `AttachmentChip` | ComposerPrimitive.Attachments + AttachmentPrimitive + Button | 3 | 插在编辑区上方，正文为空也激活发送；hover 出圆形移除钮，移除钮有完整无障碍名 | interactions.md §2.6 |
| 附件灯箱 | `AttachmentLightbox` | Dialog（全屏无边框） | 3 | 点缩略图打开，遮罩 + 原图 + 文件名，`Esc` 关并把焦点还给缩略图 | interactions.md §2.6 |
| 审批模式菜单 | `ApprovalModeMenu` | DropdownMenu（含单选项） | 4 | 三档各带一句后果说明，默认手动；手动档说明：在连接器页设为总是允许的连接器工具不再问；server 声明必须亲自确认的、组织要求每次都问的除外。会话内从左下角向上弹。阶段 2、3 只有手动档，不显示本菜单 | interactions.md §2.7；parity-audit §1；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 项目选择器 | `ProjectPicker` | Popover + Combobox | 随能力 | 搜索 + 置顶分组 + 全部 + 「新建项目」；每行可设为默认。定时任务表单里的项目选择器用同一份 | interactions.md §2.7；parity-audit §3 |
| 输入框上方浮条 | `ComposerBanner` | Alert + Button | 4 / 6 | `ComposerSlots` 的占位者之一，框外与输入框同宽：自动确认横幅常驻可见且点它能降回手动（4）；长任务提醒（6）。到量提示归 `QuotaBanner`，不在这一行重复 | interactions.md §2.2；parity-audit 2026-09-16；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |

## §3 消息流

对应 `interactions.md §3`，落地规格见 parity-audit「块词汇」。阶段 0 只做用户消息、助手消息（Streamdown）、错误态，块渲染器注册表里只注册 `text`。

| Tenon 名称 | 组件标识 | shadcn/ui 映射 | 阶段 | 行为要点 | 规格 |
|---|---|---|---|---|---|
| 会话流 | `Thread` | ThreadPrimitive.Root / Viewport / Messages + ScrollArea | **0** | 跟随到底、用户上滚即脱离；脱离时出「回到最新」按钮 | interactions.md §3 |
| 块渲染器注册表 | `BlockRegistry` | MessagePrimitive.Parts 的 components 映射 | **0** | 按块类型查表渲染，阶段 0 只注册 `text`；未知类型渲染成可见的占位而不是静默丢弃；不写 markdown 特例分支 | spec.md「UI 最小集」 |
| 用户消息 | `UserMessage` | MessagePrimitive.Root + Parts | **0** | 右对齐气泡、限宽；气泡前有仅供屏读的标题，气泡后留空的 `role="status"` 发送状态区 | interactions.md §3.1；parity-audit 块词汇 |
| 助手消息 | `AssistantMessage` | MessagePrimitive.Root + Parts | **0** | 左对齐；一轮内块序固定：屏读隐藏标题 → 状态行 → 工具回执行与回执卡 → 正文 → 产物块 → 来源脚注行 → 动作条。动作条永远收尾，后面不排任何块；一轮里「正文 → 又调工具 → 再正文」时工具行按时间插在两段正文之间，动作条仍只出现一次 | interactions.md §3.1；parity-audit 块词汇 |
| 正文排版 | `Markdown` | Streamdown + 自建令牌样式 | **0** | 流式安全（未闭合的标记不闪烁）；阶段 0 直接用 Streamdown 的默认渲染，不挂自建钩子；标题、列表、表格、引用、公式各自的边距规则在阶段 6 统一过一遍 | interactions.md §3.2 |
| 错误态 | `MessageError` | Alert + Button | **0** | 阶段 0 的基础错误态：失败原因用人话 + 重试；错误文案由界面按代码查目录，内核只给代码与事实。带副作用与恢复路径的失败走 `FailureCard`，不要把两者合成一个 | interactions.md §6；spec.md「国际化」 |
| 代码块 | `CodeBlock` | 自建（Streamdown 渲染钩子）+ Button + ScrollArea | 2 | 自建的 markdown 特例渲染器，阶段 0 不做（spec 明写不做 markdown 特例分支）。顶栏语言标签 + 复制钮，复制结果向块内 `role="status"` 播报；块内自己横滚；命令执行类在主体之后再挂一段「输出」区 | interactions.md §3.3；parity-audit 块词汇 |
| 用户消息动作条 | `UserActionBar` | ActionBarPrimitive + Button（icon） | 2 | hover 或键盘聚焦时在气泡正下方右对齐出现，收回成等高的隐藏触发钮、不留高度跳动。顺序固定：**从这里重来（以同一条用户消息重新发起一轮，会产生版本）→ 编辑（原地换成输入框）→ 复制 → 相对时间**；复制向同条内的 `role="status"` 播报 | interactions.md §3.1；parity-audit 块词汇 |
| 助手消息动作条 | `AssistantActionBar` | ActionBarPrimitive + `BranchPicker` | 2 | 顺序固定：复制 → 朗读 → 有用 → 没用 → 重试 → [版本分页，仅多版本时] → 相对时间；复制钮后紧跟播报区。末尾消息与多版本消息常驻，其余历史折叠成等高触发钮；生成中不渲染，本轮结束整条淡入。**中断态隐藏「重试」**（那一轮没跑完），此时重跑入口只在用户消息的「从这里重来」。不做语音输出就省掉「朗读」，不留空钮 | interactions.md §3.1；parity-audit 块词汇、§8 |
| 来源脚注行 | `SourceFootnote` | 自建 + `Chip` | 随能力 | 独占动作条**上面**一行、与正文左边界对齐：技能 · 项目知识 N 份 · 连接器 · 引用 N 处，各自可点跳到对应落点。与工具子行并存不冲突——子行说在第几步用的，这一行说这一轮一共用了什么 | parity-audit 块词汇 |
| 对象锚点标记 | `ObjectChip` | Button（chip 变体）+ Tooltip | 3 | 回执行与正文里指向来源的 chip：支持两段式面包屑（`记忆 › 沟通偏好`），hover 出细下划线与绝对路径 tooltip，点击按来源类型路由（本地文件 / 项目知识 / 记忆 / 连接器 / 外呼对象）。来源不可用时置灰并在 tooltip 里说明原因，不静默失效 | parity-audit 块词汇 |
| 版本分页器 | `BranchPicker` | BranchPickerPrimitive + Button | 2 | 多版本时才出现，位置在重试之后、时间之前；左右箭头切换，首末版禁用态保留占位 | interactions.md §3.7 |
| 思考块 | `ThinkingBlock` | Collapsible | 2 | 收起显用时 + 首句，点开展开厂商返回的思考文本（Anthropic 为摘要，智谱为 reasoning_content；拿不到原始思维链）；首句同时从状态行收起；展开状态按消息记住；重放的历史消息不显示用时 | interactions.md §3.4；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 会话状态行 | `StatusLine` | 自建（`role="status"`） | 2 | 词汇固定：思考中 / 正在干活 / 正在你的电脑上操作 / 撰写中 / 正在问你 / 等你定夺 · 已等 N；本轮结束整行移除，不是改文案 | interactions.md §3.8；parity-audit 2026-09-16 |
| 流式光标 | `StreamCursor` | 自建 | 2 | 光标闪烁与逐段进入，减动效下只留最终态 | interactions.md §3.8、§5 |
| 单工具回执行 | `ToolRow` | Collapsible + 自建行 | 2 | 一行一句人话，可展开看输入 / 输出 / 副作用；默认视图里不出现 JSON。阶段 2 展开只有输入和输出（纯文本），副作用段与写操作行的可逆性标记在阶段 3 加 | interactions.md §3.5；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 轮级折叠头 | `ToolGroupHeader` | Collapsible | 3 | 一轮多工具时折叠成一句「用了 N 个工具」，展开是子行列表；**写入 / 外呼 / 被拦 / 失败的回执行不进折叠头**，固定展示在头下方 | interactions.md §3.5；parity-audit 2026-09-16 |
| 命令子行 | `CommandSubRow` | Collapsible + `CodeBlock` | 3 | 展开 = 命令原文代码块 +「输出」段，两段同构；超长命令折叠给「展开全部（N 行）」——多行脚本必须能在展开体里看到全文 | interactions.md §3.5；parity-audit 块词汇 |
| 技能读取子行 | `SkillReadSubRow` | Collapsible + `ObjectChip` | 3 | 与写入行语义不同，不要合并：动宾「读取技能」，对象 chip 两段（技能名 + 技能文件名，tooltip 给绝对路径），右侧放来源（内置 / 项目 / 个人）而不是耗时，可逆性固定「只读」；展开是被注入的片段摘要 +「打开技能文件」 | parity-audit 块词汇 |
| 产物交付子行 | `ArtifactDeliverySubRow` | Collapsible + `ObjectChip` | 5 | 与写入行语义不同，不要合并：写入讲磁盘动作，交付讲交给你的东西。动宾「交付」，右侧给类型与体积，展开显示落盘路径与版本号 +「在右栏打开」「下载」；与正文尾部的产物卡指向同一个产物 | parity-audit 块词汇 |
| 连续只读折叠行 | `ReadOnlyFoldRow` | Collapsible | 3 | Tenon 特有：同一轮内连续 ≥2 次同类只读调用折成一行（「读取 N 个文件」+ 合计耗时），中间一出现写入 / 外呼 / 被拦 / 失败就断开分组。折叠行的雪佛龙必须真的可点，否则去掉 | parity-audit 块词汇 |
| 子任务行 | `SubtaskRow` | Collapsible + 自建步流 | 3 | Tenon 特有：形态同回执行，右侧状态位显「第 M 步 / 共 N 步 · 剩余 mm:ss」；展开是内嵌步流（每步一行 + 状态圆点）。步内触发审批时该步变「等你定夺」；与右面板「进度」互不复制——右栏只收任务级里程碑 | parity-audit 块词汇 |
| 任务活动时间线 | `ActivityTimeline` | 自建 + Separator | 3 | 任务主栏的竖向活动行；与对话的卡片式回执是两套渲染，不要合并 | interactions.md §3.5；parity-audit 2026-09-16 |
| 内联审批卡（最小态 · 阶段 2） | `ApprovalCard` | Card + Button + Badge | 2 | 照 02 §最小审批卡：接在发起请求那一行下面，不钉在输入框上方；问题式标题 / 对象一行（完整显示，控制字符显示为可见转义）/ 为什么停 / 撤不回时单独一句 / 改动默认收起、按纯文本展开 / 拒绝与允许，期限写在允许旁。一般的卡与连接器卡拒绝 `Esc`、允许 `⏎`；不可逆卡默认焦点在「拒绝」、`⏎` = 拒绝，放行只能点「允许」或焦点在「允许」上按 Space。同批后面的调用以「排队中」叠在卡下 | interactions.md §3.8；parity-audit 2026-09-16；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 内联审批卡（完整 · 阶段 3） | `ApprovalCard` | Card + Button + Badge | 3 | 在最小态之上加可逆性刻度与带样式的改动预览；「能否还原」一句随阶段 4 的快照 | interactions.md §3.8；parity-audit 2026-09-16；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 授权弹窗 | `GrantDialog` | AlertDialog | 3 | 只有文件夹与连接器授权才有「以后都允许」，三钮：取消 / 以后都允许 / 允许。文件夹弹窗写「允许访问这个文件夹」，只给访问权、不放行写入；连接器弹窗授权「使用这个连接器」，不给任何工具设总是允许；允许过的规则在设置里可撤销 | parity-audit 2026-09-16、2026-09-13；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 提问块 | `AskWidget` | Card + RadioGroup + Button | 2 | 与输入框共用外框、走 `ComposerSlots`；选项 + 跳过 + 「直接回复」；可最小化（塌成一行进度，不等于跳过），切走再回来恢复；中断时显示「未作答」。阶段 2 不做最小化 | interactions.md §3.8；parity-audit 块词汇；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 提问汇总卡 | `AskSummaryCard` | Card | 2 | 答完后在消息流留一张问题 / 所选答案的汇总，跳过项标为无偏好 | parity-audit 2026-09-16；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 轮次结算行 | `TurnSummaryLine` | 自建 | 2 | 一轮结束一行人话：读了 N 个、改了 M 个、有没有对外发送、能不能还原。阶段 2 不写「能不能还原」 | parity-audit 2026-09-13；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 失败卡 | `FailureCard` | Card + Button | 2 | Tenon 特有，固定三行且**每行都不能空**：①发生了什么（带步骤号与对象名）②已造成的副作用（哪些已完成并留了快照号、哪些确定没发生）③一行可点动作（去重新授权 / 按原样重跑第 N 步 / 改权限后重跑），没有恢复路径时也要给「复制诊断信息」。四类失败视觉可区分：你停下的＝中性、模型失败＝红、工具失败＝红且指名步骤与对象、被拦截＝琥珀。阶段 2 只做基础三行，各结束码的动作与视觉类见 02 §失败卡与结束原因 | parity-audit 块词汇；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 拦截回执 | `BlockedNotice` | Alert | 2 | Tenon 特有：被策略拦下的动作也要有可见回执，写清拦了什么、拒绝原因已回传模型、怎么放行（永不放行的只给「查看保护名单」）。阶段 2 没有「从回执放行」 | parity-audit 块词汇；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |
| 产物卡 | `ArtifactCard` | Card + Button + DropdownMenu（分裂钮） | 5 | 整卡是 toggle（`aria-pressed` = 右栏已打开该产物，同时只允许一张按下）；主区点开右分栏，`⌄` 打开下载子菜单（本机应用打开 / 在访达中显示 / 复制落盘路径 / 历史版本 ›）。文档卡是同结构但没有分裂钮组 | interactions.md §3.6；parity-audit 2026-09-16、块词汇 |
| 内联图像 | `InlineImage` | 自建 + Dialog（灯箱） | 5 | 图像与矢量图直接内联渲染，不做卡片也不开右分栏；右上角悬浮全屏查看与「查看请求 / 响应」 | interactions.md §3.6 |
| 内联产物 | `InlineArtifact` | 自建 iframe | 5 | 内联沙箱 iframe，不开右分栏；壳层不访问其内部 | interactions.md §3.6 |
| 引用角标 | `Citation` | 自建 `sup` + Tooltip | 6 | 句末上标，悬停出来源，点开右面板来源列表；键盘可达 | interactions.md §3.8 |

## §4 页面

对应 `interactions.md §4`。这些页面跟随各自后端能力出现，阶段 0 一行都不做。

| Tenon 名称 | 组件标识 | shadcn/ui 映射 | 阶段 | 行为要点 | 规格 |
|---|---|---|---|---|---|
| 面包屑 | `Breadcrumb` | Breadcrumb | 随能力 | 详情页用面包屑代替标题，末段是当前项且不可点 | interactions.md §1.2、§4.1 |
| 任务模式首页 | `TaskHome` | 自建两段 + `SessionStatusDot` + Button | 随能力 | 两段：进行中（行 = 标题 +「需要你批准 · 刚刚」+ 查看钮，带未读点，点未读点即标已读）与定时任务（行 = 任务名 + 下次运行时间）。段头带「清空活动」，段尾「显示更多」 | interactions.md §4.1；parity-audit §1、2026-09-16 |
| 列表页骨架 | `ListPage` | 自建 + Button + DropdownMenu（分裂钮）+ Input | 随能力 | 大标题 + 副标题 + 右上（搜索 / 排序 ⌄ / 新建 ⌄）；搜索展开为输入框；「新建 ⌄」是分裂钮，菜单两项：对话式创建 / 手动设置 | interactions.md §4.1、§4.2；parity-audit §3 |
| 定时任务列表 | `ScheduleList` | Card 网格 + Badge + DropdownMenu | 随能力 | 卡片：标题 + 指令截断 + 状态标记 + 来源；hover 出 `⋮`（复用 `ScheduleRowMenu`，已暂停显「恢复」）；页脚一行本机执行说明（应用关闭期间不跑，错过的时间点下次启动补跑一次并标注） | interactions.md §4.1；parity-audit §3 |
| 定时任务表单 | `ScheduleFormDialog` | Dialog + Input + Textarea + Select + DropdownMenu（含单选项） | 随能力 | 创建与编辑同一表单；频率六档默认「手动」，联动出时间 / 星期 / 起始日期；必填标星、必填齐才激活保存；有改动关闭 → 放弃确认；标题行有关闭位。项目内新建时项目锁定为当前项目、不可改 | interactions.md §4.1；parity-audit §3、§4 |
| 定时任务详情 | `ScheduleDetail` | 自建两栏 + Switch + Badge + Button | 随能力 | 左列：启用开关 + 状态 chip + 下次运行时间 + 立即运行 + 运行历史（点历史行进那次运行的会话）。右列三块按序：指令（可展开）/ 频率（整句）/ 一直允许（本任务收拢的常驻规则，逐条可撤销，空态说明运行中授予的批准会出现在这里） | interactions.md §4.1；parity-audit §3 |
| 项目列表 / 详情 | `ProjectList` / `ProjectDetail` | Card 网格 / 自建两栏 + `SidePanel` | 随能力 | 详情页头标题可点即改名 + 描述行；页内输入框带「对话 / 任务」分段（项目页是新起一轮的入口，不属于会话内豁免，选任务时框下显示已锁定的当前项目）；右面板四段：说明 / 记忆 / 上下文 / 定时任务，每段自己的新增入口与空态 | interactions.md §4.2；parity-audit §4 |
| 新建项目模态 | `ProjectCreateDialog` | Dialog + Input + Textarea | 随能力 | 两问句（你在做什么 = 名字 / 你想达成什么 = 描述）+ 创建；卡片描述位显示项目描述 | parity-audit §4 |
| 项目最近行 | `ProjectRecentsRow` | 自建行 + Badge + DropdownMenu | 随能力 | 行上两态标记：未读 / 等你定夺（与侧栏同一套语义）；定时任务派生的会话标来源并链到该任务；hover 出行级 `⋮`，菜单复用 `SessionRowMenu` | parity-audit §4 |
| 项目文本模态 | `ProjectTextDialog` | Dialog + Textarea | 随能力 | 项目说明、项目指令与文本上下文共用一个模态；项目指令要写明叠加在全局指令之上并给跳设置的链接；保存前离开要确认 | interactions.md §4.2；parity-audit §4 |
| 产物列表 | `ArtifactList` | Tabs + Card 网格 + DropdownMenu | 5 | 缩略图卡 + 标题 + 编辑时间，hover 出 `⋮` 与可按图钉；标题是产物标题（可重命名），不是文件名；共享相关的分段本地版不做 | interactions.md §4.3；parity-audit §5 |
| 产物查看器 | `ArtifactViewer` | 自建全屏 + 自建 iframe + Button | 5 | 无侧栏；点标题 = 原地重命名（不是菜单）；内容是跨域 iframe | interactions.md §4.3 |
| 首次引导气泡 | `Coachmark` | Popover（受控） | 5 | 与它要引导的界面同批上线（首个宿主是 `ArtifactViewer`）；只在首次出现，层级低于模态；关掉后不再来 | interactions.md §4.3 |
| 技能 / 连接器 / 插件页 | `CustomizePage` | Tabs + ToggleGroup + DropdownMenu + Table + Card | 随能力 | 一层分段（我的 / 发现）+ 筛选 / 排序 / 添加，工具条随分段变化；我的是单列行列表（名 + 来源 · 描述 + 行菜单），发现页是卡片网格；未连接行给「连接」主按钮 | interactions.md §4.4；parity-audit §6 |
| 详情多页签 | `DetailTabs` | Tabs + ScrollArea | 随能力 | 先进整页详情（面包屑 + 标题 + 元数据行 + 页签），编辑表单收在页签或「编辑」之后；内容页签是文件树 + 说明渲染。连接器页签按工具给「总是允许 / 每次问 / 永不」三态菜单，「永不」旁写「本会话里再调用会被拦下，新会话起不再提供」；声明 requiresUserInteraction 的工具不给「总是允许」，组织要求每次问时总是允许不生效 | interactions.md §4.4；parity-audit §6；[02 §界面范围（2026-09-25）](../architecture/02-agent-loop/spec.md) |

## §5–7 状态、动效、响应式

对应 `interactions.md §5`、`§6`、`§7`。

| Tenon 名称 | 组件标识 | shadcn/ui 映射 | 阶段 | 行为要点 | 规格 |
|---|---|---|---|---|---|
| 动效令牌 | `motion` 令牌组 | 自建（令牌） | **0** | 五档时长（`--t-dur-fast / snap / base / sheet / slow`）与四条缓动写进令牌，组件只引用不写字面量；减动效下把五档统一重写成 `1ms`，不逐个组件写降级分支 | interactions.md §5；tokens.md「dur / ease」 |
| 展开 / 折叠过渡 | `CollapseMotion` | 自建（`Collapsible` 的过渡） | 6 | 列表行与分段展开走 `grid-template-rows` 过渡（不是 max-height 猜值），依赖状态驱动而不是 `transitionend`；减动效下直接切换 | interactions.md §5 |
| 滚动边缘遮罩 | `ScrollEdgeFade` | 自建（滚动容器装饰） | 6 | 长列表与消息流的上下边缘按滚动位置淡入淡出，纯装饰不挡命中区；减动效下保留静态边缘或直接去掉 | interactions.md §5 |
| 原地播报区 | `LiveRegion` | 自建（`role="status"`） | **0** | 复制成功、发送失败、开关变化都在就近的播报区出；阶段 0 只有就近播报，不引入全局通知 | parity-audit 块词汇 |
| 全局通知 | `Toast` | 自建（或底座当时提供的通知组件） | 6 | `--t-z-toast` 的宿主——阶段 0 只立键不做组件。用于离开当前上下文也要知道的事（后台任务完成、定时任务失败）；就近能说清的一律留给 `LiveRegion`，不要两头出 | tokens.md「z」；parity-audit §7 |
| 空态 | `EmptyState` | 自建 + Button | 随宿主 | 插画 + 一句说明 + 一个主动作。**跟着它所属的页面 / 分区同批上线**（页面不能先于自己的空态发布）；阶段 6 再统一过一遍文案与插画 | interactions.md §6 |
| 骨架屏 | `Skeleton` | Skeleton | 6 | 结构与真实内容同形，减动效下不呼吸 | interactions.md §5、§6 |
| 到量提示条 | `QuotaBanner` | Alert + Button | 6 | `ComposerSlots` 里优先级最低的占位者，框外与输入框同宽、紧贴输入框：警示图标 +「接近本周用量上限」+ 文字钮 + ✕（只对本会话生效）；用琥珀不用红，不阻塞输入。同一套槽位复用给连接器未就绪等通知 | interactions.md §6；parity-audit 块词汇、2026-09-16 |
| 破坏性确认 | `DestructiveConfirm` | AlertDialog | 3 | 统一两钮，危险色只给主操作；说明后果（如相关会话会被归档、已写成的常驻规则去向） | interactions.md §6；parity-audit §3 |
| 兜底页 | `FallbackPage` | 自建（无壳层） | 6 | 路由未命中时的居中兜底页：一句说明 + 回首页；不套侧栏与顶栏 | interactions.md §6 |
| 断点与响应式 | `breakpoints` | 自建（Tailwind 断点） | 6 | 窄屏依次：内容列变窄 → 分段收成图标 → 侧栏撤出、输入框铺满；会话内窄屏把模型与强度移到框下、免责行缩短 | interactions.md §7 |
| 侧栏抽屉 | `SidebarDrawer` | Sheet（Dialog 侧边变体） | 6 | 窄屏点 ☰ 全宽覆盖，比桌面版多一个搜索框；`Esc` 或 ✕ 关 | interactions.md §7 |
| 双语回归基线 | — | 自建（Playwright） | **0** | 中英各截一张壳层截图 + DOM 断言：侧栏导航项与输入框文字不换行、不截断 | spec.md 验收 12 |

## 不映射的部分

- **规格 §8 的开发壳与 §4.5 的设计壳**：按 master-reference §8.5「不做」行，两个壳都不做，这里不给组件。
- **审计里的 C 类**：语音听写与语音模式（工具行不出现麦克风与语音组，画板上写明「不做」而不是静默留空）、套餐购买与「下载应用与扩展」、第三方云盘打开；规格里的设备列表一律换成 `RunLocationSubmenu`，值只有「本机」。
- **云端分享**：分享按钮、协作者头像、公开链接、共享版本这一族，本地版没有对应后端，未排期。
- **2026-09-13 简化作废的界面**：内核机制的可视化（层号、判决顺序、效力矩阵、独立的记录标签页与侧栏入口）不做；过程记录只从会话标题菜单按需打开；沙箱档位不在输入框上暴露，收进设置的「高级」折叠区。
- **深度检索**：按 2026-09-17 补记排在阶段 6，卡片、右面板时间线与来源下钻的组件等画板补齐后再进本表（`ResearchConfirmDialog` 先占位）。
